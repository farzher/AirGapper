import { AirGridQrAcquisitionRenderer } from './send/airgrid-qr-acquisition-renderer.js';
import {
  AIRGRID_QR_CENTERS,
  AIRGRID_QR_ORDER,
  airGridQrConfigKey,
  parseAirGridQrAcquisition
} from './shared/airgrid-qr-acquisition.js';
import { homographyFromCorrespondences, projectAirGridAcquisition } from './shared/airgrid-acquisition.js';

const BUILD = 'AGRS-20260823-1410';
const $ = id => document.getElementById(id);
const decoder = new TextDecoder();

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
// Sender: one static frame. No animation/render loop exists in this build.
// ---------------------------------------------------------------------------
const sender = $('sender');
const senderCanvas = $('sender-canvas');
const acquisitionRenderer = new AirGridQrAcquisitionRenderer();

function renderStaticAcquisition() {
  const dpr = devicePixelRatio || 1;
  const width = Math.max(1, Math.round(innerWidth * dpr));
  const height = Math.max(1, Math.round(innerHeight * dpr));
  senderCanvas.width = width;
  senderCanvas.height = height;
  const ctx = senderCanvas.getContext('2d', { alpha:false });
  const config = {
    modulation: 'binary',
    columns: Math.max(64, Math.floor(width / 3)),
    lanes: Math.max(8, Math.floor(height / 3)),
    senderHz: 60,
    payloadId: 0x51a7c0de
  };
  acquisitionRenderer.render(ctx, width, height, config, BUILD);
}

$('start-sender').onclick = async () => {
  sender.classList.add('active');
  try { await sender.requestFullscreen?.({ navigationUI:'hide' }); } catch {}
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  renderStaticAcquisition();
};
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) sender.classList.remove('active');
});

// ---------------------------------------------------------------------------
// Receiver: one proven AirGapper WASM QR worker, off the UI thread.
// ---------------------------------------------------------------------------
const video = $('video');
const overlay = $('overlay');
const overlayCtx = overlay.getContext('2d');
const qrWorker = new Worker(new URL('./receive/worker.js?airgrid-acq=1410', import.meta.url), { type:'module' });
let workerReady = false;
let workerBusy = false;
let receiverRunning = false;
let mediaStream = null;
let scanId = 0;
let scans = 0;
let totalSymbols = 0;
let lastScanMs = 0;
let lastScanAt = 0;
let seen = new Map();
let lockedQuad = null;
let lockedConfig = null;

function setStatus(text) { $('status').textContent = text; }
function setDetails(extra = '') {
  const corners = AIRGRID_QR_ORDER.filter(c => seen.has(c));
  $('details').textContent = [
    BUILD,
    `worker: ${workerReady ? 'ready' : 'warming'}`,
    `scans: ${scans} · decoded QR symbols: ${totalSymbols} · last scan: ${lastScanMs.toFixed(0)} ms`,
    `beacons: ${corners.length}/4 [${corners.join(', ') || 'none'}]`,
    extra
  ].filter(Boolean).join('\n');
}

function quadCenter(q) {
  const points = [q?.topLeft,q?.topRight,q?.bottomRight,q?.bottomLeft].filter(Boolean);
  if (points.length !== 4) return null;
  return {
    x: points.reduce((s,p)=>s+p.x,0)/4,
    y: points.reduce((s,p)=>s+p.y,0)/4
  };
}
function sameConfig(observations) {
  if (observations.length !== 4) return null;
  const key = airGridQrConfigKey(observations[0].config);
  return observations.every(o => airGridQrConfigKey(o.config) === key) ? observations[0].config : null;
}
function tryLock() {
  const now = performance.now();
  for (const [corner, obs] of seen) if (now - obs.at > 3000) seen.delete(corner);
  const observations = AIRGRID_QR_ORDER.map(c => seen.get(c)).filter(Boolean);
  const config = sameConfig(observations);
  if (!config) return false;
  const source = AIRGRID_QR_ORDER.map(c => AIRGRID_QR_CENTERS[c]);
  const target = AIRGRID_QR_ORDER.map(c => seen.get(c).center);
  const h = homographyFromCorrespondences(source, target);
  if (!h) return false;
  lockedQuad = {
    topLeft: projectAirGridAcquisition(h,0,0),
    topRight: projectAirGridAcquisition(h,1,0),
    bottomRight: projectAirGridAcquisition(h,1,1),
    bottomLeft: projectAirGridAcquisition(h,0,1)
  };
  lockedConfig = config;
  setStatus(`LOCKED · 4/4 QR beacons · ${BUILD}`);
  drawOverlay();
  setDetails(`profile: ${config.modulation} ${config.columns}×${config.lanes} @ ${config.senderHz} Hz`);
  return true;
}

function drawOverlay() {
  const rect = overlay.getBoundingClientRect();
  const dpr = devicePixelRatio || 1;
  const w = Math.max(1, Math.round(rect.width*dpr));
  const h = Math.max(1, Math.round(rect.height*dpr));
  if (overlay.width !== w || overlay.height !== h) { overlay.width=w; overlay.height=h; }
  overlayCtx.clearRect(0,0,w,h);
  if (!video.videoWidth || !video.videoHeight) return;
  const vr = video.getBoundingClientRect(), or = overlay.getBoundingClientRect();
  const map = p => ({
    x:(vr.left-or.left + p.x/video.videoWidth*vr.width)*dpr,
    y:(vr.top-or.top + p.y/video.videoHeight*vr.height)*dpr
  });
  overlayCtx.font = `${14*dpr}px ui-monospace,monospace`;
  if (lockedQuad) {
    const pts = [lockedQuad.topLeft,lockedQuad.topRight,lockedQuad.bottomRight,lockedQuad.bottomLeft].map(map);
    overlayCtx.strokeStyle='#72ff91'; overlayCtx.fillStyle='#72ff91'; overlayCtx.lineWidth=2*dpr;
    overlayCtx.beginPath(); overlayCtx.moveTo(pts[0].x,pts[0].y); for(let i=1;i<4;i++)overlayCtx.lineTo(pts[i].x,pts[i].y); overlayCtx.closePath(); overlayCtx.stroke();
    for(const p of pts){overlayCtx.beginPath();overlayCtx.arc(p.x,p.y,5*dpr,0,Math.PI*2);overlayCtx.fill();}
  } else {
    overlayCtx.fillStyle='#ffd66b';
    for (const [corner,obs] of seen) {
      const p=map(obs.center); overlayCtx.beginPath();overlayCtx.arc(p.x,p.y,7*dpr,0,Math.PI*2);overlayCtx.fill();overlayCtx.fillText(corner,p.x+10*dpr,p.y-8*dpr);
    }
  }
}
window.addEventListener('resize', drawOverlay);

qrWorker.onmessage = event => {
  const data = event.data ?? {};
  if (data.id === -1) {
    workerReady = true;
    setDetails();
    return;
  }
  if (data.id !== scanId) return;
  workerBusy = false;
  lastScanMs = Number(data.latencyMs || 0);
  const symbols = Array.isArray(data.symbols) ? data.symbols : [];
  totalSymbols += symbols.length;
  let valid = 0;
  for (const symbol of symbols) {
    if (!symbol?.bytes || !symbol?.quad) continue;
    let raw = '';
    try {
      const bytes = symbol.bytes instanceof Uint8Array ? symbol.bytes : Uint8Array.from(symbol.bytes);
      raw = decoder.decode(bytes);
    } catch {}
    const parsed = parseAirGridQrAcquisition(raw);
    const center = parsed ? quadCenter(symbol.quad) : null;
    if (!parsed || !center) continue;
    valid++;
    seen.set(parsed.corner, { config:parsed, center, at:performance.now() });
  }
  if (!tryLock()) {
    const corners = AIRGRID_QR_ORDER.filter(c => seen.has(c));
    setStatus(`SEARCHING · ${BUILD} · QR ${corners.length}/4 · last worker hits ${symbols.length}, valid AG2 ${valid}`);
    setDetails();
    drawOverlay();
  }
};
qrWorker.onerror = event => {
  workerBusy = false;
  setStatus(`WORKER ERROR · ${BUILD} · ${event.message}`);
  setDetails('WASM worker crashed');
};

function scanLoop(now) {
  if (!receiverRunning) return;
  video.requestVideoFrameCallback?.(scanLoop);
  if (!workerReady || workerBusy || lockedQuad || now-lastScanAt < 180 || !video.videoWidth) return;
  lastScanAt = now;
  let frame;
  try { frame = new VideoFrame(video, { timestamp:Math.round(performance.now()*1000) }); }
  catch (error) { setStatus(`VideoFrame error · ${error.message}`); return; }
  const w = frame.codedWidth || frame.displayWidth || video.videoWidth;
  const h = frame.codedHeight || frame.displayHeight || video.videoHeight;
  workerBusy = true;
  scans++;
  scanId++;
  qrWorker.postMessage({
    id:scanId,
    videoFrame:frame,
    cropX:0,cropY:0,w,h,
    full:true,
    pixelFormat:'y8',
    acquisitionMode:'hunt',
    sentAt:performance.now()
  }, [frame]);
  setStatus(`SEARCHING · ${BUILD} · WASM scan ${scans} running off-thread…`);
}

async function startCamera() {
  await stopCamera();
  setStatus(`Starting camera · ${BUILD}`);
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio:false,
    video:{ facingMode:{ideal:'environment'}, width:{ideal:1280}, height:{ideal:720}, frameRate:{ideal:30,max:30} }
  });
  video.srcObject = mediaStream;
  await video.play();
  receiverRunning = true;
  seen.clear(); lockedQuad=null; lockedConfig=null; scans=0; totalSymbols=0; lastScanMs=0; lastScanAt=0;
  $('start-camera').disabled=true; $('stop-camera').disabled=false;
  setStatus(`SEARCHING · ${BUILD} · camera ${video.videoWidth}×${video.videoHeight}`);
  setDetails();
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(scanLoop);
  else setStatus(`ERROR · ${BUILD} · requestVideoFrameCallback unavailable`);
}
async function stopCamera() {
  receiverRunning=false; workerBusy=false;
  for(const track of mediaStream?.getTracks?.() ?? []) track.stop();
  mediaStream=null; video.srcObject=null;
  $('start-camera').disabled=false; $('stop-camera').disabled=true;
  drawOverlay();
}
$('start-camera').onclick=()=>startCamera().catch(error=>setStatus(`CAMERA ERROR · ${BUILD} · ${error.message}`));
$('stop-camera').onclick=()=>stopCamera();
window.addEventListener('beforeunload',()=>{try{qrWorker.terminate();}catch{} stopCamera();});
