import QRCode from './vendor/qrcode.js';
import {
  AIRGRID_QR_CENTERS,
  AIRGRID_QR_ORDER,
  airGridQrConfigKey,
  encodeAirGridQrAcquisition,
  parseAirGridQrAcquisition
} from './shared/airgrid-qr-acquisition.js';
import { homographyFromCorrespondences, projectAirGridAcquisition } from './shared/airgrid-acquisition.js';
import { airGridPayloadBytes, airGridProfile, makeAirGridPayload } from './shared/airgrid-phy.js';
import { AirGridRasterRenderer, buildAirGridState } from './send/airgrid-renderer.js';

const BUILD = 'AGRS-20260823-1430';
const PAYLOAD_ID = 0x51a7c0de;
const $ = id => document.getElementById(id);
const decoder = new TextDecoder();
const mbps = bps => `${(bps / 1e6).toFixed(2)} MB/s`;

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
// Sender: proven 1420 DOM acquisition stays intact. Space switches to data.
// ---------------------------------------------------------------------------
const sender = $('sender');
const acqLayer = $('acq-layer');
const dataLayer = $('data-layer');
const dataCanvas = $('data-canvas');
const dataCtx = dataCanvas.getContext('2d', { alpha:false });
const rasterRenderer = new AirGridRasterRenderer();
let senderConfig = null;
let senderProfile = null;
let senderDataMode = false;
let senderRunning = false;
let senderRaf = 0;
let senderSequence = 0;
let nextDataDue = 0;
let senderTimes = [];
let lastHudAt = 0;

function plannedDisplay() {
  const dpr = devicePixelRatio || 1;
  return {
    width: Math.max(1, Math.round(screen.width * dpr)),
    height: Math.max(1, Math.round(screen.height * dpr)),
    dpr
  };
}
function selectedPitch() { return Math.max(1.5, Number($('pitch').value) || 2.25); }
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

function makeSenderConfig() {
  const { width, height } = plannedDisplay();
  const profile = airGridProfile({ projectedWidth:width, projectedHeight:height, cellPx:selectedPitch() });
  if (!profile) throw new Error('Selected AirGrid profile is invalid');
  return {
    config: {
      modulation:'binary',
      columns:profile.columns,
      lanes:profile.lanes,
      senderHz:selectedSenderHz(),
      payloadId:PAYLOAD_ID
    },
    profile,
    width,
    height
  };
}

function renderAcquisitionDom() {
  const plan = makeSenderConfig();
  senderConfig = plan.config;
  senderProfile = plan.profile;
  for (const corner of AIRGRID_QR_ORDER) {
    const text = encodeAirGridQrAcquisition(senderConfig, corner);
    $(`qr-${corner}`).innerHTML = qrSvg(text);
  }
  if (!AIRGRID_QR_ORDER.every(c => $(`qr-${c}`).querySelector('svg'))) throw new Error('Acquisition QR DOM render failed');
  dataCanvas.width = plan.width;
  dataCanvas.height = plan.height;
  const ceiling = senderProfile.lanes * senderProfile.payloadBytes * 30;
  $('sender-center-info').innerHTML = `${BUILD}<br>BINARY ${senderProfile.columns}×${senderProfile.lanes} · ${senderProfile.payloadBytes} B/lane<br>30 FPS CEILING ${mbps(ceiling)}<br>WAIT FOR PHONE: LOCKED<br>THEN PRESS SPACE FOR DATA`;
  $('sender-status').textContent = `READY · ${BUILD} · ${senderProfile.columns}×${senderProfile.lanes} · ${senderProfile.payloadBytes} B/lane · ${mbps(ceiling)} ceiling @ 30 camera fps`;
}

function buildAndRenderData(sequence) {
  if (!senderProfile) throw new Error('Sender profile missing');
  const started = performance.now();
  const state = buildAirGridState({
    profile:senderProfile,
    payloadId:PAYLOAD_ID,
    sequence:sequence & 0xffffff,
    modulation:'binary',
    payloadForLane:laneIndex => makeAirGridPayload(senderProfile.payloadBytes, PAYLOAD_ID, sequence & 0xffffff, laneIndex)
  });
  rasterRenderer.render(dataCtx, state, dataCanvas.width, dataCanvas.height);
  return performance.now() - started;
}

function updateSenderHud(renderMs = 0) {
  const now = performance.now();
  senderTimes = senderTimes.filter(t => now - t < 1000);
  const actualHz = senderTimes.length > 1 ? (senderTimes.length - 1) * 1000 / Math.max(1, senderTimes.at(-1) - senderTimes[0]) : 0;
  const ceiling = senderProfile ? senderProfile.lanes * senderProfile.payloadBytes * 30 : 0;
  $('sender-hud').textContent = [
    BUILD,
    senderDataMode ? `DATA seq ${senderSequence}` : 'ACQUISITION',
    senderProfile ? `${senderProfile.columns}×${senderProfile.lanes} · ${senderProfile.payloadBytes} B/lane` : '',
    `state rate ${actualHz.toFixed(1)} / ${selectedSenderHz()} Hz`,
    `last render ${renderMs.toFixed(1)} ms`,
    `${mbps(ceiling)} ceiling @ 30 camera fps`,
    'Space=data · R=reacquire'
  ].filter(Boolean).join('\n');
}

function dataTick(now) {
  if (!senderRunning || !senderDataMode) return;
  senderRaf = requestAnimationFrame(dataTick);
  const hz = selectedSenderHz();
  const period = 1000 / hz;
  if (now + 0.2 < nextDataDue) return;
  const skipped = Math.max(1, Math.floor((now - nextDataDue) / period) + 1);
  nextDataDue += skipped * period;
  senderSequence = (senderSequence + skipped) & 0xffffff;
  let renderMs = 0;
  try {
    renderMs = buildAndRenderData(senderSequence);
  } catch (error) {
    senderDataMode = false;
    dataLayer.classList.add('hidden');
    acqLayer.classList.remove('hidden');
    $('sender-center-info').innerHTML = `${BUILD}<br>DATA RENDER ERROR<br>${String(error.message || error)}`;
    return;
  }
  senderTimes.push(now);
  if (now - lastHudAt > 300) { lastHudAt = now; updateSenderHud(renderMs); }
}

function showAcquisition() {
  senderDataMode = false;
  cancelAnimationFrame(senderRaf);
  dataLayer.classList.add('hidden');
  acqLayer.classList.remove('hidden');
  updateSenderHud();
}
function startData() {
  if (!senderRunning || senderDataMode || !senderProfile) return;
  try {
    senderSequence = 0;
    const renderMs = buildAndRenderData(senderSequence);
    acqLayer.classList.add('hidden');
    dataLayer.classList.remove('hidden');
    senderDataMode = true;
    senderTimes = [performance.now()];
    nextDataDue = performance.now() + 1000 / selectedSenderHz();
    updateSenderHud(renderMs);
    senderRaf = requestAnimationFrame(dataTick);
  } catch (error) {
    $('sender-status').textContent = `DATA RENDER ERROR · ${BUILD} · ${error.message}`;
    showAcquisition();
  }
}

$('start-sender').onclick = async () => {
  try {
    renderAcquisitionDom();
    sender.classList.add('active');
    acqLayer.classList.remove('hidden');
    dataLayer.classList.add('hidden');
    senderRunning = true;
    senderDataMode = false;
    updateSenderHud();
    void sender.offsetWidth;
    try { await sender.requestFullscreen?.({ navigationUI:'hide' }); }
    catch (error) { $('sender-status').textContent = `Rendered; fullscreen request failed: ${error.message}`; }
  } catch (error) {
    senderRunning = false;
    sender.classList.remove('active');
    $('sender-status').textContent = `SENDER ERROR · ${BUILD} · ${error.message}`;
  }
};
document.addEventListener('keydown', event => {
  if (!senderRunning) return;
  if (event.code === 'Space') { event.preventDefault(); startData(); }
  else if (event.key.toLowerCase() === 'r') showAcquisition();
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
// Receiver acquisition: exactly the working 1420 WASM QR path.
// ---------------------------------------------------------------------------
const video = $('video');
const overlay = $('overlay');
const overlayCtx = overlay.getContext('2d');
const qrWorker = new Worker(new URL('./receive/worker.js?airgrid-acq=1430', import.meta.url), { type:'module' });
const dataWorker = new Worker(new URL('./receive/airgrid-worker.js?build=1430', import.meta.url), { type:'module' });
let workerReady = false;
let qrBusy = false;
let dataBusy = false;
let receiverRunning = false;
let mediaStream = null;
let mediaTrack = null;
let processorReader = null;
let scanId = 0;
let scans = 0;
let totalSymbols = 0;
let lastScanMs = 0;
let lastScanAt = 0;
let seen = new Map();
let lockedQuad = null;
let lockedConfig = null;
let lockedProfile = null;
let generation = 1;
let frameId = 0;
let droppedBusy = 0;
let captureTimes = [];
let lastDiagnostics = null;
let lastDataError = '';
let lastUiAt = 0;
const goodEvents = [];
const seenBySequence = new Map();
let firstGoodAt = 0;

function setStatus(text, cls='') { $('status').textContent = text; $('status').className = `status ${cls}`; }
function quadCenter(q) {
  const points=[q?.topLeft,q?.topRight,q?.bottomRight,q?.bottomLeft].filter(Boolean);
  if(points.length!==4)return null;
  return {x:points.reduce((s,p)=>s+p.x,0)/4,y:points.reduce((s,p)=>s+p.y,0)/4};
}
function sameConfig(observations) {
  if(observations.length!==4)return null;
  const key=airGridQrConfigKey(observations[0].config);
  return observations.every(o=>airGridQrConfigKey(o.config)===key)?observations[0].config:null;
}
function profileFromConfig(config) {
  if (!config || config.modulation !== 'binary') return null;
  const payloadBytes = airGridPayloadBytes(config.columns);
  if (payloadBytes < 8 || config.lanes < 8) return null;
  return { modulation:'binary', bitsPerCell:1, columns:config.columns, lanes:config.lanes, payloadBytes };
}

function resetGoodput() {
  goodEvents.length = 0;
  seenBySequence.clear();
  firstGoodAt = 0;
  droppedBusy = 0;
  captureTimes = [];
  lastDiagnostics = null;
  lastDataError = '';
}
function noteVerifiedLanes(lanes, now) {
  let bytes = 0;
  for (const lane of lanes ?? []) {
    if (!lane.verified) continue;
    let entry = seenBySequence.get(lane.sequence);
    if (!entry) {
      entry = { at:now, lanes:new Set() };
      seenBySequence.set(lane.sequence, entry);
    }
    entry.at = now;
    if (entry.lanes.has(lane.laneIndex)) continue;
    entry.lanes.add(lane.laneIndex);
    bytes += Number(lane.payloadBytes) || 0;
  }
  if (bytes) {
    if (!firstGoodAt) firstGoodAt = now;
    goodEvents.push({ t:now, bytes });
  }
  for (const [seq,entry] of seenBySequence) if (now-entry.at > 5000) seenBySequence.delete(seq);
  while (goodEvents.length && now-goodEvents[0].t > 1000) goodEvents.shift();
}
function currentGoodput(now=performance.now()) {
  while (goodEvents.length && now-goodEvents[0].t > 1000) goodEvents.shift();
  const bytes = goodEvents.reduce((sum,e)=>sum+e.bytes,0);
  if (!firstGoodAt || !bytes) return 0;
  const windowMs = Math.min(1000, Math.max(100, now-firstGoodAt));
  return bytes * 1000 / windowMs;
}
function currentCaptureFps(now=performance.now()) {
  captureTimes = captureTimes.filter(t=>now-t<1000);
  if (captureTimes.length < 2) return 0;
  return (captureTimes.length-1)*1000/Math.max(1,captureTimes.at(-1)-captureTimes[0]);
}

function tryLock() {
  const now=performance.now();
  for(const [corner,obs] of seen)if(now-obs.at>3000)seen.delete(corner);
  const observations=AIRGRID_QR_ORDER.map(c=>seen.get(c)).filter(Boolean);
  const config=sameConfig(observations);
  if(!config)return false;
  const h=homographyFromCorrespondences(
    AIRGRID_QR_ORDER.map(c=>AIRGRID_QR_CENTERS[c]),
    AIRGRID_QR_ORDER.map(c=>seen.get(c).center)
  );
  if(!h)return false;
  const profile=profileFromConfig(config);
  if(!profile)return false;
  lockedQuad={
    topLeft:projectAirGridAcquisition(h,0,0),
    topRight:projectAirGridAcquisition(h,1,0),
    bottomRight:projectAirGridAcquisition(h,1,1),
    bottomLeft:projectAirGridAcquisition(h,0,1)
  };
  lockedConfig=config;
  lockedProfile=profile;
  generation++;
  resetGoodput();
  setStatus(`LOCKED · 4/4 QR beacons · ${BUILD} · PRESS SPACE ON SENDER`, 'good');
  drawOverlay();
  updateReceiverUi(true);
  return true;
}

function drawOverlay() {
  const rect=overlay.getBoundingClientRect();
  const dpr=devicePixelRatio||1;
  const w=Math.max(1,Math.round(rect.width*dpr)),h=Math.max(1,Math.round(rect.height*dpr));
  if(overlay.width!==w||overlay.height!==h){overlay.width=w;overlay.height=h;}
  overlayCtx.clearRect(0,0,w,h);
  if(!video.videoWidth||!video.videoHeight)return;
  const vr=video.getBoundingClientRect(),or=overlay.getBoundingClientRect();
  const map=p=>({x:(vr.left-or.left+p.x/video.videoWidth*vr.width)*dpr,y:(vr.top-or.top+p.y/video.videoHeight*vr.height)*dpr});
  overlayCtx.font=`${14*dpr}px ui-monospace,monospace`;
  if(lockedQuad){
    const pts=[lockedQuad.topLeft,lockedQuad.topRight,lockedQuad.bottomRight,lockedQuad.bottomLeft].map(map);
    overlayCtx.strokeStyle='#72ff91';overlayCtx.fillStyle='#72ff91';overlayCtx.lineWidth=2*dpr;
    overlayCtx.beginPath();overlayCtx.moveTo(pts[0].x,pts[0].y);for(let i=1;i<4;i++)overlayCtx.lineTo(pts[i].x,pts[i].y);overlayCtx.closePath();overlayCtx.stroke();
    for(const p of pts){overlayCtx.beginPath();overlayCtx.arc(p.x,p.y,5*dpr,0,Math.PI*2);overlayCtx.fill();}
  } else {
    overlayCtx.fillStyle='#ffd66b';
    for(const [corner,obs] of seen){const p=map(obs.center);overlayCtx.beginPath();overlayCtx.arc(p.x,p.y,7*dpr,0,Math.PI*2);overlayCtx.fill();overlayCtx.fillText(corner,p.x+10*dpr,p.y-8*dpr);}
  }
}
window.addEventListener('resize',drawOverlay);

qrWorker.onmessage=event=>{
  const data=event.data??{};
  if(data.id===-1){workerReady=true;updateReceiverUi(true);return;}
  if(data.id!==scanId)return;
  qrBusy=false;
  lastScanMs=Number(data.latencyMs||0);
  const symbols=Array.isArray(data.symbols)?data.symbols:[];
  totalSymbols+=symbols.length;
  let valid=0;
  for(const symbol of symbols){
    if(!symbol?.bytes||!symbol?.quad)continue;
    let raw='';
    try{raw=decoder.decode(symbol.bytes instanceof Uint8Array?symbol.bytes:Uint8Array.from(symbol.bytes));}catch{}
    const parsed=parseAirGridQrAcquisition(raw);
    const center=parsed?quadCenter(symbol.quad):null;
    if(!parsed||!center)continue;
    valid++;
    seen.set(parsed.corner,{config:parsed,center,at:performance.now()});
  }
  if(!tryLock()){
    const corners=AIRGRID_QR_ORDER.filter(c=>seen.has(c));
    setStatus(`SEARCHING · ${BUILD} · QR ${corners.length}/4 · worker hits ${symbols.length}, valid AG2 ${valid}`, 'warn');
    updateReceiverUi(true);drawOverlay();
  }
};
qrWorker.onerror=event=>{qrBusy=false;setStatus(`QR WORKER ERROR · ${BUILD} · ${event.message}`, 'bad');};

function scanLoop(now){
  if(!receiverRunning)return;
  video.requestVideoFrameCallback?.(scanLoop);
  if(!workerReady||qrBusy||lockedQuad||now-lastScanAt<220||!video.videoWidth)return;
  lastScanAt=now;
  let frame;
  try{frame=new VideoFrame(video,{timestamp:Math.round(performance.now()*1000)});}catch(error){setStatus(`VideoFrame error · ${error.message}`, 'bad');return;}
  const w=frame.codedWidth||frame.displayWidth||video.videoWidth;
  const h=frame.codedHeight||frame.displayHeight||video.videoHeight;
  qrBusy=true;scans++;scanId++;
  qrWorker.postMessage({id:scanId,videoFrame:frame,cropX:0,cropY:0,w,h,full:true,pixelFormat:'y8',acquisitionMode:'hunt',sentAt:performance.now()},[frame]);
}

function postDataFrame(frame) {
  if (!lockedQuad || !lockedProfile) { frame.close(); return; }
  const now=performance.now();
  captureTimes.push(now);
  if (dataBusy) { droppedBusy++; frame.close(); updateReceiverUi(); return; }
  dataBusy=true;
  dataWorker.postMessage({
    action:'decode',
    frame,
    frameId:++frameId,
    generation,
    sentAtMs:now,
    captureTimestampMs:Number.isFinite(Number(frame.timestamp))?Number(frame.timestamp)/1000:now,
    modulation:'binary',
    quad:lockedQuad,
    profile:lockedProfile,
    minSeparation:18
  },[frame]);
}
async function processorLoop() {
  while(receiverRunning && processorReader){
    const {value:frame,done}=await processorReader.read();
    if(done||!frame)break;
    postDataFrame(frame);
  }
}

dataWorker.onmessage=event=>{
  const data=event.data??{};
  dataBusy=false;
  if(data.generation!==generation)return;
  if(data.type==='error'){
    lastDataError=data.error||'decode error';
    updateReceiverUi(true);
    return;
  }
  lastDiagnostics=data;
  noteVerifiedLanes(data.lanes,performance.now());
  updateReceiverUi();
};
dataWorker.onerror=event=>{dataBusy=false;lastDataError=`worker crash: ${event.message}`;updateReceiverUi(true);};

function updateReceiverUi(force=false){
  const now=performance.now();
  if(!force && now-lastUiAt<180)return;
  lastUiAt=now;
  const locked=Boolean(lockedQuad&&lockedProfile);
  $('m-lock').textContent=locked?'LOCKED':'SEARCHING';
  $('m-lock').className=locked?'good':'warn';
  const good=currentGoodput(now);
  $('m-goodput').textContent=mbps(good);
  $('m-goodput').className=good>=2_500_000?'good':good>=2_000_000?'warn':'';
  const ceiling=lockedProfile?lockedProfile.lanes*lockedProfile.payloadBytes*30:0;
  $('m-ceiling').textContent=lockedProfile?mbps(ceiling):'—';
  const d=lastDiagnostics?.diagnostics;
  $('m-valid').textContent=d?`${(d.decode.validLaneRate*100).toFixed(1)}%`:'0%';
  $('m-fps').textContent=`${currentCaptureFps(now).toFixed(1)} fps`;
  $('m-pxcell').textContent=d?`${d.frame.pxPerCellX.toFixed(2)}×${d.frame.pxPerCellY.toFixed(2)}`:'—';
  $('m-decode').textContent=lastDiagnostics?`${Number(lastDiagnostics.decodeWallMs||0).toFixed(1)} ms`:'— ms';
  $('m-drop').textContent=String(droppedBusy);
  const corners=AIRGRID_QR_ORDER.filter(c=>seen.has(c));
  const failures=d?.decode?.failures??{};
  $('details').textContent=[
    BUILD,
    `QR worker: ${workerReady?'ready':'warming'} · scans ${scans} · symbols ${totalSymbols} · last ${lastScanMs.toFixed(0)} ms`,
    `beacons ${corners.length}/4 [${corners.join(', ')||'none'}]`,
    lockedConfig?`profile binary ${lockedConfig.columns}×${lockedConfig.lanes} · ${lockedProfile.payloadBytes} B/lane · sender ${lockedConfig.senderHz} Hz`:'',
    d?`CRC-valid ${d.decode.crcValidLanes}/${d.decode.totalLanes} · byte-exact ${d.decode.validLanes}/${d.decode.totalLanes}`:'waiting for data raster',
    d?`failures ${Object.entries(failures).map(([k,v])=>`${k}=${v}`).join(' ')}`:'',
    lastDataError?`DATA ERROR ${lastDataError}`:''
  ].filter(Boolean).join('\n');
}

async function startCamera(){
  await stopCamera();
  setStatus(`Starting camera · ${BUILD}`,'warn');
  mediaStream=await navigator.mediaDevices.getUserMedia({
    audio:false,
    video:{facingMode:{ideal:'environment'},width:{ideal:2560},height:{ideal:1440},frameRate:{ideal:30,max:30}}
  });
  mediaTrack=mediaStream.getVideoTracks()[0];
  video.srcObject=mediaStream;await video.play();
  receiverRunning=true;qrBusy=false;dataBusy=false;seen.clear();lockedQuad=null;lockedConfig=null;lockedProfile=null;scans=0;totalSymbols=0;lastScanMs=0;lastScanAt=0;generation++;resetGoodput();
  $('start-camera').disabled=true;$('stop-camera').disabled=false;
  setStatus(`SEARCHING · ${BUILD} · camera ${video.videoWidth}×${video.videoHeight}`,'warn');updateReceiverUi(true);
  if(video.requestVideoFrameCallback)video.requestVideoFrameCallback(scanLoop);
  else setStatus(`ERROR · ${BUILD} · requestVideoFrameCallback unavailable`,'bad');
  if(globalThis.MediaStreamTrackProcessor){
    const processor=new MediaStreamTrackProcessor({track:mediaTrack});
    processorReader=processor.readable.getReader();
    processorLoop().catch(error=>{lastDataError=`processor: ${error.message}`;updateReceiverUi(true);});
  } else {
    lastDataError='MediaStreamTrackProcessor unavailable';
    updateReceiverUi(true);
  }
}
async function stopCamera(){
  receiverRunning=false;generation++;qrBusy=false;dataBusy=false;
  try{await processorReader?.cancel();}catch{}
  processorReader=null;
  for(const track of mediaStream?.getTracks?.()??[])track.stop();
  mediaStream=null;mediaTrack=null;video.srcObject=null;
  $('start-camera').disabled=false;$('stop-camera').disabled=true;
  setStatus(`Camera stopped · ${BUILD}`);drawOverlay();updateReceiverUi(true);
}
$('start-camera').onclick=()=>startCamera().catch(error=>setStatus(`CAMERA ERROR · ${BUILD} · ${error.message}`,'bad'));
$('stop-camera').onclick=()=>stopCamera();
window.addEventListener('beforeunload',()=>{try{qrWorker.terminate();dataWorker.terminate();}catch{}stopCamera();});
