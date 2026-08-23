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

const BUILD = 'AGRS-20260823-1433';
const PAYLOAD_ID = 0x51a7c0de;
const QR_BURST_EVERY_MS = 3000;
const QR_BURST_MS = 320;
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
// Sender: proven QR bootstrap + local-block data + periodic reacquisition.
// ---------------------------------------------------------------------------
const sender = $('sender');
const acqLayer = $('acq-layer');
const dataLayer = $('data-layer');
const dataCanvas = $('data-canvas');
const dataCtx = dataCanvas.getContext('2d', { alpha:false });
const rasterRenderer = new AirGridRasterRenderer();
let senderConfig = null;
let senderProfile = null;
let senderRunning = false;
let senderDataMode = false;
let senderRaf = 0;
let senderSequence = 0;
let nextDataDue = 0;
let dataStartedAt = 0;
let showingQrBurst = false;

function currentDisplayPixels() {
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
  const n = qr.modules.size, quiet = 4, logical = n + quiet * 2;
  let path = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.modules.data[y * n + x]) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  return `<svg viewBox="0 0 ${logical} ${logical}" xmlns="http://www.w3.org/2000/svg"><rect width="${logical}" height="${logical}" fill="white"/><path d="${path}" fill="black"/></svg>`;
}

function configureSender() {
  const { width, height, dpr } = currentDisplayPixels();
  const profile = airGridBlockProfile({ projectedWidth:width, projectedHeight:height, cellPx:selectedPitch() });
  if (!profile) throw new Error('Selected AirGrid block profile is invalid');
  senderProfile = profile;
  senderConfig = {
    modulation:'binary',
    columns:profile.columns,
    lanes:profile.lanes,
    senderHz:selectedSenderHz(),
    payloadId:PAYLOAD_ID
  };
  for (const corner of AIRGRID_QR_ORDER) $(`qr-${corner}`).innerHTML = qrSvg(encodeAirGridQrAcquisition(senderConfig, corner));
  if (!AIRGRID_QR_ORDER.every(c => $(`qr-${c}`).querySelector('svg'))) throw new Error('QR acquisition render failed');
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
  $('sender-status').textContent = `READY · ${BUILD} · ${profile.columns}×${profile.lanes} · ${profile.blocksPerLane} local blocks/row · ${mbps(ceiling)} ceiling @ 30 fps`;
}

function renderData(sequence) {
  const state = buildAirGridBlockState({ profile:senderProfile, payloadId:PAYLOAD_ID, sequence });
  rasterRenderer.render(dataCtx, state, dataCanvas.width, dataCanvas.height);
}
function showLayer(acquisition) {
  showingQrBurst = acquisition;
  acqLayer.classList.toggle('hidden', !acquisition);
  dataLayer.classList.toggle('hidden', acquisition);
}
function qrBurstDue(now) {
  if (!senderDataMode || now - dataStartedAt < 1200) return false;
  return ((now - dataStartedAt) % QR_BURST_EVERY_MS) < QR_BURST_MS;
}
function senderTick(now) {
  if (!senderRunning || !senderDataMode) return;
  senderRaf = requestAnimationFrame(senderTick);
  const burst = qrBurstDue(now);
  if (burst !== showingQrBurst) showLayer(burst);
  if (burst) return;
  const hz = selectedSenderHz(), period = 1000 / hz;
  if (now + 0.2 < nextDataDue) return;
  const skipped = Math.max(1, Math.floor((now - nextDataDue) / period) + 1);
  nextDataDue += skipped * period;
  senderSequence = (senderSequence + skipped) & 0x0fff;
  try { renderData(senderSequence); }
  catch (error) { showAcquisition(`DATA ERROR: ${error.message || error}`); }
}
function showAcquisition(message = '') {
  senderDataMode = false;
  cancelAnimationFrame(senderRaf);
  showLayer(true);
  configureSender();
  if (message) $('sender-center-info').innerHTML += `<br><br>${message}`;
}
function startData() {
  if (!senderRunning || senderDataMode || !senderProfile) return;
  try {
    const { width, height } = currentDisplayPixels();
    const next = airGridBlockProfile({ projectedWidth:width, projectedHeight:height, cellPx:selectedPitch() });
    if (!next || next.columns !== senderProfile.columns || next.lanes !== senderProfile.lanes) {
      configureSender();
      $('sender-center-info').innerHTML += '<br><br>DISPLAY CHANGED · RE-LOCK · CLICK AGAIN';
      return;
    }
    senderSequence = 0;
    renderData(senderSequence);
    senderDataMode = true;
    dataStartedAt = performance.now();
    nextDataDue = dataStartedAt + 1000 / selectedSenderHz();
    showLayer(false);
    senderRaf = requestAnimationFrame(senderTick);
  } catch (error) { showAcquisition(`DATA START ERROR: ${error.message || error}`); }
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
    senderRunning = senderDataMode = false;
    cancelAnimationFrame(senderRaf);
    sender.classList.remove('active');
  }
});

// ---------------------------------------------------------------------------
// Receiver: QR geometry is refreshed forever; block decoder is local/FEC.
// ---------------------------------------------------------------------------
const video = $('video');
const overlay = $('overlay');
const overlayCtx = overlay.getContext('2d');
const qrWorker = new Worker(new URL('./receive/worker.js?airgrid-acq=1433', import.meta.url), { type:'module' });
const dataWorker = new Worker(new URL('./receive/airgrid-worker.js?build=1433', import.meta.url), { type:'module' });
let workerReady = false, qrBusy = false, dataBusy = false, receiverRunning = false;
let mediaStream = null, mediaTrack = null, processorReader = null;
let scanId = 0, scans = 0, totalSymbols = 0, lastScanMs = 0, lastScanAt = 0;
let seen = new Map();
let lockedQuad = null, lockedConfig = null, lockedProfile = null;
let lockFrameWidth = 0, lockFrameHeight = 0, lastQrFrameWidth = 0, lastQrFrameHeight = 0;
let generation = 1, frameId = 0, droppedBusy = 0;
let captureTimes = [], lastDiagnostics = null, lastDataError = '', lastUiAt = 0;
let lastLockAt = 0, lastGoodDataAt = 0, firstDataResultAt = 0, staleCount = 0;
const goodEvents = [], seenUnits = new Map();

function setStatus(text, cls = '') { $('status').textContent = text; $('status').className = `status ${cls}`; }
function quadCenter(q) {
  const points = [q?.topLeft,q?.topRight,q?.bottomRight,q?.bottomLeft].filter(Boolean);
  if (points.length !== 4) return null;
  return { x:points.reduce((s,p)=>s+p.x,0)/4, y:points.reduce((s,p)=>s+p.y,0)/4 };
}
function sameConfig(obs) {
  if (obs.length !== 4) return null;
  const key = airGridQrConfigKey(obs[0].config);
  return obs.every(o => airGridQrConfigKey(o.config) === key) ? obs[0].config : null;
}
function scaleQuad(quad, sx, sy) {
  const p = q => ({ x:q.x*sx, y:q.y*sy });
  return { topLeft:p(quad.topLeft), topRight:p(quad.topRight), bottomRight:p(quad.bottomRight), bottomLeft:p(quad.bottomLeft) };
}
function resetGoodput() {
  goodEvents.length = 0;
  seenUnits.clear();
  droppedBusy = 0;
  captureTimes = [];
  lastDiagnostics = null;
  lastDataError = '';
  lastGoodDataAt = 0;
  firstDataResultAt = 0;
  staleCount = 0;
}
function noteVerifiedUnits(units, now) {
  let bytes = 0;
  for (const unit of units ?? []) {
    if (!unit.verified) continue;
    const key = `${unit.sequence}:${unit.laneIndex}:${unit.blockIndex ?? 0}`;
    if (seenUnits.has(key)) continue;
    seenUnits.set(key, now);
    bytes += Number(unit.payloadBytes) || 0;
  }
  if (bytes) {
    lastGoodDataAt = now;
    goodEvents.push({ t:now, bytes });
  }
  for (const [key, at] of seenUnits) if (now - at > 5000) seenUnits.delete(key);
  while (goodEvents.length && now - goodEvents[0].t > 1000) goodEvents.shift();
}
function currentGoodput(now = performance.now()) {
  while (goodEvents.length && now - goodEvents[0].t > 1000) goodEvents.shift();
  return goodEvents.reduce((s,e)=>s+e.bytes,0);
}
function currentCaptureFps(now = performance.now()) {
  captureTimes = captureTimes.filter(t => now - t < 1000);
  if (captureTimes.length < 2) return 0;
  return (captureTimes.length - 1) * 1000 / Math.max(1, captureTimes.at(-1) - captureTimes[0]);
}

function markStale(reason) {
  if (!lockedQuad) return;
  lockedQuad = null;
  lastLockAt = 0;
  seen.clear();
  staleCount++;
  setStatus(`REACQUIRING · ${BUILD} · ${reason}`, 'warn');
  drawOverlay();
  updateReceiverUi(true);
}
function tryLock() {
  const now = performance.now();
  for (const [corner, obs] of seen) if (now - obs.at > 900) seen.delete(corner);
  const observations = AIRGRID_QR_ORDER.map(c => seen.get(c)).filter(Boolean);
  const config = sameConfig(observations);
  if (!config) return false;
  const h = homographyFromCorrespondences(
    AIRGRID_QR_ORDER.map(c => AIRGRID_QR_CENTERS[c]),
    AIRGRID_QR_ORDER.map(c => seen.get(c).center)
  );
  if (!h) return false;
  const profile = airGridBlockProfileFromGrid(config.columns, config.lanes);
  if (!profile) return false;
  const nextQuad = {
    topLeft:projectAirGridAcquisition(h,0,0), topRight:projectAirGridAcquisition(h,1,0),
    bottomRight:projectAirGridAcquisition(h,1,1), bottomLeft:projectAirGridAcquisition(h,0,1)
  };
  const changed = !lockedConfig || airGridQrConfigKey(config) !== airGridQrConfigKey(lockedConfig);
  lockedQuad = nextQuad;
  lockedConfig = config;
  lockedProfile = profile;
  lockFrameWidth = lastQrFrameWidth || video.videoWidth;
  lockFrameHeight = lastQrFrameHeight || video.videoHeight;
  lastLockAt = now;
  if (changed) { generation++; resetGoodput(); }
  setStatus(`LOCKED · ${BUILD} · geometry refreshed`, 'good');
  drawOverlay();
  updateReceiverUi(true);
  return true;
}

function drawOverlay() {
  const rect = overlay.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  const w = Math.max(1,Math.round(rect.width*dpr)), h = Math.max(1,Math.round(rect.height*dpr));
  if (overlay.width !== w || overlay.height !== h) { overlay.width=w; overlay.height=h; }
  overlayCtx.clearRect(0,0,w,h);
  if (!video.videoWidth || !video.videoHeight || !lockedQuad) return;
  const vr=video.getBoundingClientRect(), or=overlay.getBoundingClientRect();
  const map=p=>({ x:(vr.left-or.left+p.x/Math.max(1,lockFrameWidth)*vr.width)*dpr, y:(vr.top-or.top+p.y/Math.max(1,lockFrameHeight)*vr.height)*dpr });
  const pts=[lockedQuad.topLeft,lockedQuad.topRight,lockedQuad.bottomRight,lockedQuad.bottomLeft].map(map);
  overlayCtx.strokeStyle='#72ff91'; overlayCtx.lineWidth=2*dpr;
  overlayCtx.beginPath(); overlayCtx.moveTo(pts[0].x,pts[0].y); for(let i=1;i<4;i++) overlayCtx.lineTo(pts[i].x,pts[i].y); overlayCtx.closePath(); overlayCtx.stroke();
}
window.addEventListener('resize',drawOverlay);

qrWorker.onmessage = event => {
  const data = event.data ?? {};
  if (data.id === -1) { workerReady=true; updateReceiverUi(true); return; }
  if (data.id !== scanId) return;
  qrBusy=false;
  lastScanMs=Number(data.latencyMs||0);
  const symbols=Array.isArray(data.symbols)?data.symbols:[];
  totalSymbols += symbols.length;
  for (const symbol of symbols) {
    if (!symbol?.bytes || !symbol?.quad) continue;
    let raw='';
    try { raw=decoder.decode(symbol.bytes instanceof Uint8Array?symbol.bytes:Uint8Array.from(symbol.bytes)); } catch {}
    const parsed=parseAirGridQrAcquisition(raw), center=parsed?quadCenter(symbol.quad):null;
    if (parsed && center) seen.set(parsed.corner,{config:parsed,center,at:performance.now()});
  }
  const refreshed = tryLock();
  if (!refreshed && !lockedQuad) {
    const corners=AIRGRID_QR_ORDER.filter(c=>seen.has(c));
    setStatus(`SEARCHING · ${BUILD} · QR ${corners.length}/4`, 'warn');
  }
  updateReceiverUi();
};
qrWorker.onerror = event => { qrBusy=false; setStatus(`QR WORKER ERROR · ${event.message}`, 'bad'); };

function scanLoop(now) {
  if (!receiverRunning) return;
  video.requestVideoFrameCallback?.(scanLoop);
  const healthy = lastGoodDataAt && now - lastGoodDataAt < 1000;
  const interval = !lockedQuad ? 120 : healthy ? 450 : 120;
  if (!workerReady || qrBusy || now-lastScanAt<interval || !video.videoWidth) return;
  lastScanAt=now;
  let frame;
  try { frame=new VideoFrame(video,{timestamp:Math.round(performance.now()*1000)}); } catch { return; }
  const w=frame.codedWidth||frame.displayWidth||video.videoWidth, h=frame.codedHeight||frame.displayHeight||video.videoHeight;
  lastQrFrameWidth=w; lastQrFrameHeight=h; qrBusy=true; scans++; scanId++;
  qrWorker.postMessage({ id:scanId,videoFrame:frame,cropX:0,cropY:0,w,h,full:true,pixelFormat:'y8',acquisitionMode:'hunt',sentAt:performance.now() },[frame]);
}

function postDataFrame(frame) {
  if (!lockedQuad || !lockedProfile) { frame.close(); return; }
  const now=performance.now(); captureTimes.push(now);
  if (dataBusy) { droppedBusy++; frame.close(); updateReceiverUi(); return; }
  const w=frame.codedWidth||frame.displayWidth||video.videoWidth, h=frame.codedHeight||frame.displayHeight||video.videoHeight;
  const quad=(lockFrameWidth&&lockFrameHeight&&(w!==lockFrameWidth||h!==lockFrameHeight))?scaleQuad(lockedQuad,w/lockFrameWidth,h/lockFrameHeight):lockedQuad;
  dataBusy=true;
  dataWorker.postMessage({
    action:'decode', frame, frameId:++frameId, generation, sentAtMs:now,
    captureTimestampMs:Number.isFinite(Number(frame.timestamp))?Number(frame.timestamp)/1000:now,
    modulation:'binary', quad, profile:lockedProfile, payloadId:lockedConfig?.payloadId??PAYLOAD_ID, minSeparation:14
  },[frame]);
}
async function processorLoop() {
  while(receiverRunning&&processorReader){ const {value:frame,done}=await processorReader.read(); if(done||!frame)break; postDataFrame(frame); }
}

dataWorker.onmessage = event => {
  const data=event.data??{}; dataBusy=false;
  if(data.generation!==generation)return;
  if(data.type==='error'){ lastDataError=data.error||'decode error'; updateReceiverUi(true); return; }
  const now=performance.now();
  if(!firstDataResultAt)firstDataResultAt=now;
  lastDiagnostics=data;
  noteVerifiedUnits(data.lanes,now);
  const valid=Number(data.diagnostics?.decode?.validLanes||0);
  if(!valid && firstDataResultAt && now-firstDataResultAt>1400 && (!lastGoodDataAt || now-lastGoodDataAt>1400)) markStale('no verified blocks for 1.4 s');
  updateReceiverUi();
};
dataWorker.onerror = event => { dataBusy=false; lastDataError=`worker crash: ${event.message}`; updateReceiverUi(true); };

function updateReceiverUi(force=false) {
  const now=performance.now(); if(!force&&now-lastUiAt<180)return; lastUiAt=now;
  const locked=Boolean(lockedQuad&&lockedProfile);
  $('m-lock').textContent=locked?'LOCKED':'SEARCHING'; $('m-lock').className=locked?'good':'warn';
  const good=currentGoodput(now); $('m-goodput').textContent=mbps(good); $('m-goodput').className=good>=2_500_000?'good':good>=2_000_000?'warn':'';
  const ceiling=lockedProfile?lockedProfile.capacityBytes*30:0; $('m-ceiling').textContent=lockedProfile?mbps(ceiling):'—';
  const d=lastDiagnostics?.diagnostics;
  $('m-valid').textContent=d?`${(d.decode.validLaneRate*100).toFixed(1)}%`:'0%';
  $('m-fps').textContent=`${currentCaptureFps(now).toFixed(1)} fps`;
  $('m-pxcell').textContent=d?`${d.frame.pxPerCellX.toFixed(2)}×${d.frame.pxPerCellY.toFixed(2)}`:'—';
  $('m-decode').textContent=lastDiagnostics?`${Number(lastDiagnostics.decodeWallMs||0).toFixed(1)} ms`:'— ms';
  $('m-drop').textContent=String(droppedBusy);
  const failures=d?.decode?.failures??{};
  $('details').textContent=[
    BUILD,
    `QR scans ${scans} · symbols ${totalSymbols} · last ${lastScanMs.toFixed(0)} ms · lock age ${lastLockAt?(now-lastLockAt).toFixed(0):'—'} ms`,
    lockedConfig?`profile ${lockedConfig.columns}×${lockedConfig.lanes} · ${lockedProfile.blocksPerLane} blocks/row · ${lockedProfile.payloadBytesPerLane} B/row`:'',
    d?`local phase ${Number(d.frame.phaseX||0).toFixed(1)},${Number(d.frame.phaseY||0).toFixed(1)} px · camera ${d.frame.pxPerCellX.toFixed(2)}×${d.frame.pxPerCellY.toFixed(2)} px/cell`:'',
    d?`CRC-valid ${d.decode.crcValidLanes}/${d.decode.totalLanes} · byte-exact ${d.decode.validLanes}/${d.decode.totalLanes}`:'waiting for data',
    d?`failures ${Object.entries(failures).map(([k,v])=>`${k}=${v}`).join(' ')}`:'',
    `reacquisitions ${staleCount}`,
    lastDataError?`DATA ERROR ${lastDataError}`:''
  ].filter(Boolean).join('\n');
}

async function startCamera() {
  await stopCamera();
  setStatus(`Starting camera · ${BUILD}`,'warn');
  mediaStream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:2560},height:{ideal:1440},frameRate:{ideal:30,max:30}}});
  mediaTrack=mediaStream.getVideoTracks()[0]; video.srcObject=mediaStream; await video.play();
  receiverRunning=true; qrBusy=dataBusy=false; seen.clear(); lockedQuad=lockedConfig=lockedProfile=null;
  lockFrameWidth=lockFrameHeight=lastQrFrameWidth=lastQrFrameHeight=0; scans=totalSymbols=lastScanMs=lastScanAt=0; lastLockAt=0; generation++; resetGoodput();
  $('start-camera').disabled=true; $('stop-camera').disabled=false;
  setStatus(`SEARCHING · ${BUILD} · camera ${video.videoWidth}×${video.videoHeight}`,'warn'); updateReceiverUi(true);
  if(video.requestVideoFrameCallback)video.requestVideoFrameCallback(scanLoop); else setStatus('requestVideoFrameCallback unavailable','bad');
  if(globalThis.MediaStreamTrackProcessor){ const processor=new MediaStreamTrackProcessor({track:mediaTrack}); processorReader=processor.readable.getReader(); processorLoop().catch(error=>{lastDataError=`processor: ${error.message}`;updateReceiverUi(true);}); }
  else { lastDataError='MediaStreamTrackProcessor unavailable'; updateReceiverUi(true); }
}
async function stopCamera() {
  receiverRunning=false; generation++; qrBusy=dataBusy=false;
  try{await processorReader?.cancel();}catch{} processorReader=null;
  for(const track of mediaStream?.getTracks?.()??[])track.stop();
  mediaStream=mediaTrack=null; video.srcObject=null; $('start-camera').disabled=false; $('stop-camera').disabled=true;
  setStatus(`Camera stopped · ${BUILD}`); drawOverlay(); updateReceiverUi(true);
}
$('start-camera').onclick=()=>startCamera().catch(error=>setStatus(`CAMERA ERROR · ${error.message}`,'bad'));
$('stop-camera').onclick=()=>stopCamera();
window.addEventListener('beforeunload',()=>{try{qrWorker.terminate();dataWorker.terminate();}catch{}stopCamera();});
