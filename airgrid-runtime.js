import QRCode from './vendor/qrcode.js';
import {
  AIRGRID_QR_CENTERS,
  AIRGRID_QR_ORDER,
  airGridQrConfigKey,
  encodeAirGridQrAcquisition,
  parseAirGridQrAcquisition
} from './shared/airgrid-qr-acquisition.js';
import { homographyFromCorrespondences, projectAirGridAcquisition } from './shared/airgrid-acquisition.js';
import {
  airGridBlockProfile,
  airGridBlockProfileFromGrid,
  buildAirGridBlockState
} from './shared/airgrid-block.js';
import { AirGridRasterRenderer } from './send/airgrid-renderer.js';

const BUILD = 'AGRS-20260823-1434';
const PAYLOAD_ID = 0x51a7c0de;
const QR_BURST_EVERY_MS = 3000;
const QR_BURST_MS = 650;
const $ = id => document.getElementById(id);
const decoder = new TextDecoder();
const mbps = bytesPerSecond => `${(bytesPerSecond / 1e6).toFixed(2)} MB/s`;

function setMode(mode) {
  const send = mode === 'send';
  $('send-panel').classList.toggle('hidden', !send);
  $('recv-panel').classList.toggle('hidden', send);
  $('send-mode').classList.toggle('active', send);
  $('recv-mode').classList.toggle('active', !send);
  const url = new URL(location.href);
  url.search = send ? '?send' : '?receive';
  history.replaceState(null, '', url);
}
$('send-mode').onclick = () => setMode('send');
$('recv-mode').onclick = () => setMode('receive');
setMode(location.search.includes('receive') ? 'receive' : 'send');

// ---------------------------------------------------------------------------
// Sender
// ---------------------------------------------------------------------------
const sender = $('sender');
const acqLayer = $('acq-layer');
const dataLayer = $('data-layer');
const dataCanvas = $('data-canvas');
const dataCtx = dataCanvas.getContext('2d', { alpha:false });
const rasterRenderer = new AirGridRasterRenderer();
let senderProfile = null;
let senderConfig = null;
let senderRunning = false;
let senderDataMode = false;
let senderRaf = 0;
let senderSequence = 0;
let nextDataDue = 0;
let dataStartedAt = 0;
let showingQr = true;

function displayPixels() {
  const dpr = devicePixelRatio || 1;
  return {
    width:Math.max(1, Math.round(innerWidth * dpr)),
    height:Math.max(1, Math.round(innerHeight * dpr)),
    dpr
  };
}
function selectedPitch() { return Math.max(1.5, Number($('pitch').value) || 3); }
function selectedSenderHz() { return Math.max(1, Math.round(Number($('sender-hz').value) || 30)); }

function qrSvg(text) {
  const qr = QRCode.create(text, { errorCorrectionLevel:'M' });
  const n = qr.modules.size;
  const quiet = 4;
  const logical = n + quiet * 2;
  let path = '';
  for (let y=0; y<n; y++) for (let x=0; x<n; x++) {
    if (qr.modules.data[y*n+x]) path += `M${x+quiet} ${y+quiet}h1v1h-1z`;
  }
  return `<svg viewBox="0 0 ${logical} ${logical}" xmlns="http://www.w3.org/2000/svg"><rect width="${logical}" height="${logical}" fill="white"/><path d="${path}" fill="black"/></svg>`;
}

function configureSender() {
  const { width, height, dpr } = displayPixels();
  const profile = airGridBlockProfile({ projectedWidth:width, projectedHeight:height, cellPx:selectedPitch() });
  if (!profile) throw new Error('AirGrid block profile is invalid');
  senderProfile = profile;
  senderConfig = {
    modulation:'binary',
    columns:profile.columns,
    lanes:profile.lanes,
    senderHz:selectedSenderHz(),
    payloadId:PAYLOAD_ID
  };
  for (const corner of AIRGRID_QR_ORDER) {
    $(`qr-${corner}`).innerHTML = qrSvg(encodeAirGridQrAcquisition(senderConfig, corner));
  }
  if (!AIRGRID_QR_ORDER.every(c => $(`qr-${c}`).querySelector('svg'))) throw new Error('QR render failed');
  dataCanvas.width = width;
  dataCanvas.height = height;
  const ceiling = profile.capacityBytes * 30;
  $('sender-center-info').innerHTML = [
    BUILD,
    `DISPLAY ${width}×${height} px · DPR ${dpr}`,
    `BLOCK PHY ${profile.columns}×${profile.lanes} · ${profile.blocksPerLane} blocks/row`,
    `${profile.payloadBytesPerLane} payload B/row`,
    `30 FPS CEILING ${mbps(ceiling)}`,
    'WAIT FOR PHONE: LOCKED',
    'THEN CLICK OR PRESS SPACE'
  ].join('<br>');
  $('sender-status').textContent = `READY · ${BUILD} · ${profile.columns}×${profile.lanes} · ${profile.blocksPerLane} blocks/row · ${mbps(ceiling)} ceiling @ 30 fps`;
}

function renderData(sequence) {
  const state = buildAirGridBlockState({ profile:senderProfile, payloadId:PAYLOAD_ID, sequence });
  rasterRenderer.render(dataCtx, state, dataCanvas.width, dataCanvas.height);
}
function showLayer(qr) {
  showingQr = qr;
  acqLayer.classList.toggle('hidden', !qr);
  dataLayer.classList.toggle('hidden', qr);
}
function qrBurstDue(now) {
  if (!senderDataMode || now - dataStartedAt < 1200) return false;
  return ((now - dataStartedAt) % QR_BURST_EVERY_MS) < QR_BURST_MS;
}
function senderTick(now) {
  if (!senderRunning || !senderDataMode) return;
  senderRaf = requestAnimationFrame(senderTick);
  const burst = qrBurstDue(now);
  if (burst !== showingQr) showLayer(burst);
  if (burst) return;
  const hz = selectedSenderHz();
  const period = 1000 / hz;
  if (now + 0.2 < nextDataDue) return;
  const skipped = Math.max(1, Math.floor((now - nextDataDue) / period) + 1);
  nextDataDue += skipped * period;
  senderSequence = (senderSequence + skipped) & 0x0fff;
  try { renderData(senderSequence); }
  catch (error) { showAcquisition(`DATA ERROR: ${error.message || error}`); }
}
function showAcquisition(message='') {
  senderDataMode = false;
  cancelAnimationFrame(senderRaf);
  showLayer(true);
  configureSender();
  if (message) $('sender-center-info').innerHTML += `<br><br>${message}`;
}
function startData() {
  if (!senderRunning || senderDataMode || !senderProfile) return;
  try {
    const { width, height } = displayPixels();
    const next = airGridBlockProfile({ projectedWidth:width, projectedHeight:height, cellPx:selectedPitch() });
    if (!next || next.columns !== senderProfile.columns || next.lanes !== senderProfile.lanes) {
      configureSender();
      $('sender-center-info').innerHTML += '<br><br>DISPLAY CHANGED · RE-LOCK · CLICK AGAIN';
      return;
    }
    senderSequence = 0;
    renderData(0);
    senderDataMode = true;
    dataStartedAt = performance.now();
    nextDataDue = dataStartedAt + 1000 / selectedSenderHz();
    showLayer(false);
    senderRaf = requestAnimationFrame(senderTick);
  } catch (error) {
    showAcquisition(`DATA START ERROR: ${error.message || error}`);
  }
}

$('start-sender').onclick = async () => {
  try {
    sender.classList.add('active');
    senderRunning = true;
    senderDataMode = false;
    showLayer(true);
    configureSender();
    void sender.offsetWidth;
    try { await sender.requestFullscreen?.({ navigationUI:'hide' }); } catch {}
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    configureSender();
  } catch (error) {
    senderRunning = false;
    sender.classList.remove('active');
    $('sender-status').textContent = `SENDER ERROR · ${BUILD} · ${error.message || error}`;
  }
};
sender.addEventListener('click', event => {
  if (!senderRunning || senderDataMode) return;
  event.preventDefault();
  startData();
});
document.addEventListener('keydown', event => {
  if (!senderRunning) return;
  if (event.code === 'Space' || event.key === 'Enter') { event.preventDefault(); startData(); }
  else if (event.key.toLowerCase() === 'r') { event.preventDefault(); showAcquisition(); }
});
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && senderRunning) {
    senderRunning = false;
    senderDataMode = false;
    cancelAnimationFrame(senderRaf);
    sender.classList.remove('active');
  }
});

// ---------------------------------------------------------------------------
// Receiver: ONE camera path. requestVideoFrameCallback owns both QR and DATA.
// ---------------------------------------------------------------------------
const video = $('video');
const overlay = $('overlay');
const overlayCtx = overlay.getContext('2d');
const qrWorker = new Worker(new URL('./receive/worker.js?airgrid-acq=1434', import.meta.url), { type:'module' });
const dataWorker = new Worker(new URL('./receive/airgrid-worker.js?build=1434', import.meta.url), { type:'module' });
let mediaStream = null;
let receiverRunning = false;
let workerReady = false;
let qrBusy = false;
let dataBusy = false;
let scanId = 0;
let lastQrScanAt = 0;
let seen = new Map();
let lockedQuad = null;
let lockedConfig = null;
let lockedProfile = null;
let lockFrameWidth = 0;
let lockFrameHeight = 0;
let generation = 1;
let frameId = 0;
let lastLockAt = 0;
let lastGoodDataAt = 0;
let firstDataResultAt = 0;
let lastUiAt = 0;
let lastDiagnostics = null;
let lastDataError = '';
let staleCount = 0;
let geometryRefreshes = 0;
let cameraCallbacks = 0;
let qrFramesSent = 0;
let qrResults = 0;
let qrSymbols = 0;
let dataFramesSent = 0;
let dataResults = 0;
let dataWorkerErrors = 0;
let droppedBusy = 0;
let captureTimes = [];
const goodEvents = [];
const seenUnits = new Map();

function setStatus(text, cls='') {
  $('status').textContent = text;
  $('status').className = `status ${cls}`;
}
function centerOfQuad(q) {
  const points = [q?.topLeft,q?.topRight,q?.bottomRight,q?.bottomLeft].filter(Boolean);
  if (points.length !== 4) return null;
  return {
    x:points.reduce((s,p)=>s+p.x,0)/4,
    y:points.reduce((s,p)=>s+p.y,0)/4
  };
}
function smoothPoint(a,b,t=0.45) { return a ? { x:a.x*(1-t)+b.x*t, y:a.y*(1-t)+b.y*t } : b; }
function smoothQuad(a,b,t=0.45) {
  if (!a) return b;
  return {
    topLeft:smoothPoint(a.topLeft,b.topLeft,t),
    topRight:smoothPoint(a.topRight,b.topRight,t),
    bottomRight:smoothPoint(a.bottomRight,b.bottomRight,t),
    bottomLeft:smoothPoint(a.bottomLeft,b.bottomLeft,t)
  };
}
function sameConfig(observations) {
  if (observations.length !== 4) return null;
  const key = airGridQrConfigKey(observations[0].config);
  return observations.every(o => airGridQrConfigKey(o.config) === key) ? observations[0].config : null;
}
function scaleQuad(quad,sx,sy) {
  const p=q=>({x:q.x*sx,y:q.y*sy});
  return {topLeft:p(quad.topLeft),topRight:p(quad.topRight),bottomRight:p(quad.bottomRight),bottomLeft:p(quad.bottomLeft)};
}
function resetMetrics() {
  lastGoodDataAt = 0;
  firstDataResultAt = 0;
  lastDiagnostics = null;
  lastDataError = '';
  goodEvents.length = 0;
  seenUnits.clear();
  captureTimes = [];
  droppedBusy = 0;
}
function noteVerifiedUnits(units,now) {
  let bytes = 0;
  for (const unit of units ?? []) {
    if (!unit.verified) continue;
    const key = `${unit.sequence}:${unit.laneIndex}:${unit.blockIndex ?? 0}`;
    if (seenUnits.has(key)) continue;
    seenUnits.set(key,now);
    bytes += Number(unit.payloadBytes) || 0;
  }
  if (bytes) {
    lastGoodDataAt = now;
    goodEvents.push({t:now,bytes});
  }
  for (const [key,at] of seenUnits) if (now-at>5000) seenUnits.delete(key);
  while (goodEvents.length && now-goodEvents[0].t>1000) goodEvents.shift();
}
function currentGoodput(now=performance.now()) {
  while (goodEvents.length && now-goodEvents[0].t>1000) goodEvents.shift();
  return goodEvents.reduce((sum,e)=>sum+e.bytes,0);
}
function currentCaptureFps(now=performance.now()) {
  captureTimes = captureTimes.filter(t=>now-t<1000);
  if (captureTimes.length<2) return 0;
  return (captureTimes.length-1)*1000/Math.max(1,captureTimes.at(-1)-captureTimes[0]);
}

function markStale(reason) {
  if (!lockedQuad) return;
  lockedQuad = null;
  lastLockAt = 0;
  seen.clear();
  staleCount++;
  generation++;
  dataBusy = false;
  firstDataResultAt = 0;
  setStatus(`REACQUIRING · ${BUILD} · ${reason}`,'warn');
  drawOverlay();
  updateUi(true);
}
function tryLock() {
  const now = performance.now();
  for (const [corner,obs] of seen) if (now-obs.at>1500) seen.delete(corner);
  const observations = AIRGRID_QR_ORDER.map(c=>seen.get(c)).filter(Boolean);
  const config = sameConfig(observations);
  if (!config) return false;
  const h = homographyFromCorrespondences(
    AIRGRID_QR_ORDER.map(c=>AIRGRID_QR_CENTERS[c]),
    AIRGRID_QR_ORDER.map(c=>seen.get(c).center)
  );
  if (!h) return false;
  const profile = airGridBlockProfileFromGrid(config.columns,config.lanes);
  if (!profile) return false;
  const nextQuad = {
    topLeft:projectAirGridAcquisition(h,0,0),
    topRight:projectAirGridAcquisition(h,1,0),
    bottomRight:projectAirGridAcquisition(h,1,1),
    bottomLeft:projectAirGridAcquisition(h,0,1)
  };
  const changed = !lockedConfig || airGridQrConfigKey(config)!==airGridQrConfigKey(lockedConfig);
  lockedQuad = changed ? nextQuad : smoothQuad(lockedQuad,nextQuad,0.55);
  lockedConfig = config;
  lockedProfile = profile;
  const sample = observations[0];
  lockFrameWidth = sample.frameWidth;
  lockFrameHeight = sample.frameHeight;
  lastLockAt = now;
  geometryRefreshes++;
  if (changed) { generation++; resetMetrics(); }
  setStatus(`LOCKED · ${BUILD} · geometry ${geometryRefreshes}`,'good');
  drawOverlay();
  updateUi(true);
  return true;
}

function drawOverlay() {
  const rect=overlay.getBoundingClientRect();
  const dpr=devicePixelRatio||1;
  const w=Math.max(1,Math.round(rect.width*dpr));
  const h=Math.max(1,Math.round(rect.height*dpr));
  if (overlay.width!==w||overlay.height!==h) { overlay.width=w; overlay.height=h; }
  overlayCtx.clearRect(0,0,w,h);
  if (!lockedQuad||!lockFrameWidth||!lockFrameHeight||!video.videoWidth) return;
  const vr=video.getBoundingClientRect();
  const or=overlay.getBoundingClientRect();
  const map=p=>({
    x:(vr.left-or.left+p.x/lockFrameWidth*vr.width)*dpr,
    y:(vr.top-or.top+p.y/lockFrameHeight*vr.height)*dpr
  });
  const pts=[lockedQuad.topLeft,lockedQuad.topRight,lockedQuad.bottomRight,lockedQuad.bottomLeft].map(map);
  overlayCtx.strokeStyle='#72ff91';
  overlayCtx.lineWidth=2*dpr;
  overlayCtx.beginPath();
  overlayCtx.moveTo(pts[0].x,pts[0].y);
  for(let i=1;i<4;i++) overlayCtx.lineTo(pts[i].x,pts[i].y);
  overlayCtx.closePath();
  overlayCtx.stroke();
}
window.addEventListener('resize',drawOverlay);

qrWorker.onmessage = event => {
  const data=event.data??{};
  if (data.id===-1) { workerReady=true; updateUi(true); return; }
  if (data.id!==scanId) return;
  qrBusy=false;
  qrResults++;
  const symbols=Array.isArray(data.symbols)?data.symbols:[];
  qrSymbols+=symbols.length;
  const now=performance.now();
  for (const symbol of symbols) {
    if (!symbol?.bytes||!symbol?.quad) continue;
    let raw='';
    try { raw=decoder.decode(symbol.bytes instanceof Uint8Array?symbol.bytes:Uint8Array.from(symbol.bytes)); } catch {}
    const parsed=parseAirGridQrAcquisition(raw);
    const center=parsed?centerOfQuad(symbol.quad):null;
    if (!parsed||!center) continue;
    seen.set(parsed.corner,{config:parsed,center,at:now,frameWidth:data.frameWidth||data.width||video.videoWidth,frameHeight:data.frameHeight||data.height||video.videoHeight});
  }
  if (!tryLock()&&!lockedQuad) {
    const corners=AIRGRID_QR_ORDER.filter(c=>seen.has(c));
    setStatus(`SEARCHING · ${BUILD} · QR ${corners.length}/4`,'warn');
  }
  updateUi();
};
qrWorker.onerror = event => {
  qrBusy=false;
  setStatus(`QR WORKER ERROR · ${event.message}`,'bad');
};

dataWorker.onmessage = event => {
  const data=event.data??{};
  dataBusy=false;
  if (data.generation!==generation) return;
  dataResults++;
  if (data.type==='error') {
    dataWorkerErrors++;
    lastDataError=data.error||'decode error';
    updateUi(true);
    return;
  }
  const now=performance.now();
  if (!firstDataResultAt) firstDataResultAt=now;
  lastDiagnostics=data;
  noteVerifiedUnits(data.lanes,now);
  const valid=Number(data.diagnostics?.decode?.validLanes||0);
  if (!valid && now-firstDataResultAt>1800 && (!lastGoodDataAt||now-lastGoodDataAt>1800)) {
    markStale('data reached decoder but no verified blocks');
  }
  updateUi();
};
dataWorker.onerror = event => {
  dataBusy=false;
  dataWorkerErrors++;
  lastDataError=`worker crash: ${event.message}`;
  updateUi(true);
};

function sendQrFrame(now) {
  let frame;
  try { frame=new VideoFrame(video,{timestamp:Math.round(now*1000)}); }
  catch (error) { lastDataError=`VideoFrame QR: ${error.message}`; return false; }
  const w=frame.codedWidth||frame.displayWidth||video.videoWidth;
  const h=frame.codedHeight||frame.displayHeight||video.videoHeight;
  qrBusy=true;
  qrFramesSent++;
  scanId++;
  lastQrScanAt=now;
  qrWorker.postMessage({
    id:scanId,
    videoFrame:frame,
    cropX:0,cropY:0,w,h,
    full:true,
    pixelFormat:'y8',
    acquisitionMode:'hunt',
    sentAt:now,
    frameWidth:w,
    frameHeight:h
  },[frame]);
  return true;
}
function sendDataFrame(now) {
  if (!lockedQuad||!lockedProfile||dataBusy) return false;
  let frame;
  try { frame=new VideoFrame(video,{timestamp:Math.round(now*1000)}); }
  catch (error) { lastDataError=`VideoFrame DATA: ${error.message}`; return false; }
  const w=frame.codedWidth||frame.displayWidth||video.videoWidth;
  const h=frame.codedHeight||frame.displayHeight||video.videoHeight;
  const quad=(lockFrameWidth&&lockFrameHeight&&(w!==lockFrameWidth||h!==lockFrameHeight))
    ? scaleQuad(lockedQuad,w/lockFrameWidth,h/lockFrameHeight)
    : lockedQuad;
  dataBusy=true;
  dataFramesSent++;
  captureTimes.push(now);
  dataWorker.postMessage({
    action:'decode',
    frame,
    frameId:++frameId,
    generation,
    sentAtMs:now,
    captureTimestampMs:Number.isFinite(Number(frame.timestamp))?Number(frame.timestamp)/1000:now,
    modulation:'binary',
    quad,
    profile:lockedProfile,
    payloadId:lockedConfig?.payloadId??PAYLOAD_ID,
    minSeparation:12
  },[frame]);
  return true;
}
function cameraLoop(now) {
  if (!receiverRunning) return;
  video.requestVideoFrameCallback(cameraLoop);
  cameraCallbacks++;
  if (!video.videoWidth) return;
  const healthy=lastGoodDataAt&&now-lastGoodDataAt<1000;
  const qrInterval=!lockedQuad?120:healthy?300:120;
  if (workerReady&&!qrBusy&&now-lastQrScanAt>=qrInterval) {
    sendQrFrame(now);
  } else if (lockedQuad) {
    if (!sendDataFrame(now)&&dataBusy) droppedBusy++;
  }
  updateUi();
}

function updateUi(force=false) {
  const now=performance.now();
  if (!force&&now-lastUiAt<180) return;
  lastUiAt=now;
  const locked=Boolean(lockedQuad&&lockedProfile);
  $('m-lock').textContent=locked?'LOCKED':'SEARCHING';
  $('m-lock').className=locked?'good':'warn';
  const good=currentGoodput(now);
  $('m-goodput').textContent=mbps(good);
  $('m-goodput').className=good>=2_500_000?'good':good>=2_000_000?'warn':'';
  const ceiling=lockedProfile?lockedProfile.capacityBytes*30:0;
  $('m-ceiling').textContent=lockedProfile?mbps(ceiling):'—';
  const d=lastDiagnostics?.diagnostics;
  $('m-valid').textContent=d?`${(d.decode.validLaneRate*100).toFixed(1)}%`:'0%';
  $('m-fps').textContent=`${currentCaptureFps(now).toFixed(1)} fps`;
  $('m-pxcell').textContent=d?`${d.frame.pxPerCellX.toFixed(2)}×${d.frame.pxPerCellY.toFixed(2)}`:'—';
  $('m-decode').textContent=lastDiagnostics?`${Number(lastDiagnostics.decodeWallMs||0).toFixed(1)} ms`:'— ms';
  $('m-drop').textContent=String(droppedBusy);
  const failures=d?.decode?.failures??{};
  $('details').textContent=[
    BUILD,
    `pipeline camera=${cameraCallbacks} · QR sent=${qrFramesSent} results=${qrResults} symbols=${qrSymbols} · DATA sent=${dataFramesSent} results=${dataResults} errors=${dataWorkerErrors}`,
    `geometry refreshes=${geometryRefreshes} · stale/reacquire=${staleCount} · lock age=${lastLockAt?(now-lastLockAt).toFixed(0):'—'} ms`,
    lockedConfig?`profile ${lockedConfig.columns}×${lockedConfig.lanes} · ${lockedProfile.blocksPerLane} blocks/row · ${lockedProfile.payloadBytesPerLane} B/row`:'',
    d?`local phase ${Number(d.frame.phaseX||0).toFixed(1)},${Number(d.frame.phaseY||0).toFixed(1)} px · camera ${d.frame.pxPerCellX.toFixed(2)}×${d.frame.pxPerCellY.toFixed(2)} px/cell`:'',
    d?`CRC-valid ${d.decode.crcValidLanes}/${d.decode.totalLanes} · byte-exact ${d.decode.validLanes}/${d.decode.totalLanes}`:'waiting for DATA worker result',
    d?`failures ${Object.entries(failures).map(([k,v])=>`${k}=${v}`).join(' ')}`:'',
    lastDataError?`DATA ERROR ${lastDataError}`:''
  ].filter(Boolean).join('\n');
}

async function stopCamera() {
  receiverRunning=false;
  generation++;
  qrBusy=false;
  dataBusy=false;
  for (const track of mediaStream?.getTracks?.()??[]) track.stop();
  mediaStream=null;
  video.srcObject=null;
  $('start-camera').disabled=false;
  $('stop-camera').disabled=true;
  drawOverlay();
}
async function startCamera() {
  await stopCamera();
  setStatus(`Starting camera · ${BUILD}`,'warn');
  mediaStream=await navigator.mediaDevices.getUserMedia({
    audio:false,
    video:{
      facingMode:{ideal:'environment'},
      width:{ideal:2560},
      height:{ideal:1440},
      frameRate:{ideal:30,max:30}
    }
  });
  video.srcObject=mediaStream;
  await video.play();
  receiverRunning=true;
  workerReady=false;
  qrBusy=false;
  dataBusy=false;
  seen.clear();
  lockedQuad=lockedConfig=lockedProfile=null;
  lockFrameWidth=lockFrameHeight=0;
  lastLockAt=lastGoodDataAt=firstDataResultAt=0;
  cameraCallbacks=qrFramesSent=qrResults=qrSymbols=dataFramesSent=dataResults=dataWorkerErrors=droppedBusy=0;
  geometryRefreshes=staleCount=0;
  lastQrScanAt=0;
  resetMetrics();
  $('start-camera').disabled=true;
  $('stop-camera').disabled=false;
  setStatus(`SEARCHING · ${BUILD} · camera ${video.videoWidth}×${video.videoHeight}`,'warn');
  updateUi(true);
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(cameraLoop);
  else setStatus(`ERROR · ${BUILD} · requestVideoFrameCallback unavailable`,'bad');
}
$('start-camera').onclick=()=>startCamera().catch(error=>setStatus(`CAMERA ERROR · ${BUILD} · ${error.message}`,'bad'));
$('stop-camera').onclick=()=>stopCamera();
window.addEventListener('beforeunload',()=>{try{qrWorker.terminate();dataWorker.terminate();}catch{}stopCamera();});
