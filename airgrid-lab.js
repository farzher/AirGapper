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

const BUILD = 'AGRS-20260823-1431';
const PAYLOAD_ID = 0x51a7c0de;
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
let senderConfig = null;
let senderProfile = null;
let senderDataMode = false;
let senderRunning = false;
let senderRaf = 0;
let senderSequence = 0;
let nextDataDue = 0;
let senderTimes = [];
let lastHudAt = 0;

function currentDisplayPixels() {
  const dpr = devicePixelRatio || 1;
  return {
    width: Math.max(1, Math.round(innerWidth * dpr)),
    height: Math.max(1, Math.round(innerHeight * dpr)),
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
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (qr.modules.data[y * n + x]) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  }
  return `<svg viewBox="0 0 ${logical} ${logical}" xmlns="http://www.w3.org/2000/svg"><rect width="${logical}" height="${logical}" fill="white"/><path d="${path}" fill="black"/></svg>`;
}

function configureSenderForCurrentViewport() {
  const { width, height, dpr } = currentDisplayPixels();
  const profile = airGridProfile({ projectedWidth:width, projectedHeight:height, cellPx:selectedPitch() });
  if (!profile) throw new Error('Selected AirGrid profile is invalid');
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
  if (!AIRGRID_QR_ORDER.every(c => $(`qr-${c}`).querySelector('svg'))) throw new Error('Acquisition QR DOM render failed');
  dataCanvas.width = width;
  dataCanvas.height = height;
  const ceiling = profile.lanes * profile.payloadBytes * 30;
  $('sender-center-info').innerHTML = [
    BUILD,
    `DISPLAY ${width}×${height} px · DPR ${dpr}`,
    `BINARY ${profile.columns}×${profile.lanes} · ${profile.payloadBytes} B/lane`,
    `30 FPS CEILING ${mbps(ceiling)}`,
    'WAIT FOR PHONE: LOCKED',
    'THEN CLICK ANYWHERE OR PRESS SPACE'
  ].join('<br>');
  $('sender-status').textContent = `READY · ${BUILD} · display ${width}×${height} · grid ${profile.columns}×${profile.lanes} · ${profile.payloadBytes} B/lane · ${mbps(ceiling)} ceiling @ 30 camera fps`;
  return profile;
}

function buildAndRenderData(sequence) {
  if (!senderProfile) throw new Error('Sender profile missing');
  const started = performance.now();
  const seq = sequence & 0xffffff;
  const state = buildAirGridState({
    profile:senderProfile,
    payloadId:PAYLOAD_ID,
    sequence:seq,
    modulation:'binary',
    payloadForLane:laneIndex => makeAirGridPayload(senderProfile.payloadBytes, PAYLOAD_ID, seq, laneIndex)
  });
  rasterRenderer.render(dataCtx, state, dataCanvas.width, dataCanvas.height);
  return performance.now() - started;
}

function updateSenderHud(renderMs = 0) {
  const hud = $('sender-hud');
  // Never cover the acquisition QRs. The center acquisition text already has
  // all information needed before data starts.
  hud.style.display = senderDataMode ? 'block' : 'none';
  if (!senderDataMode || !senderProfile) return;
  const now = performance.now();
  senderTimes = senderTimes.filter(t => now - t < 1000);
  const actualHz = senderTimes.length > 1
    ? (senderTimes.length - 1) * 1000 / Math.max(1, senderTimes.at(-1) - senderTimes[0])
    : 0;
  const ceiling = senderProfile.lanes * senderProfile.payloadBytes * 30;
  hud.textContent = [
    BUILD,
    `DATA seq ${senderSequence}`,
    `${dataCanvas.width}×${dataCanvas.height} px`,
    `${senderProfile.columns}×${senderProfile.lanes} · ${senderProfile.payloadBytes} B/lane`,
    `state rate ${actualHz.toFixed(1)} / ${selectedSenderHz()} Hz`,
    `last render ${renderMs.toFixed(1)} ms`,
    `${mbps(ceiling)} ceiling @ 30 camera fps`,
    'R = reacquire'
  ].join('\n');
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
  try {
    const renderMs = buildAndRenderData(senderSequence);
    senderTimes.push(now);
    if (now - lastHudAt > 250) {
      lastHudAt = now;
      updateSenderHud(renderMs);
    }
  } catch (error) {
    showAcquisition(`DATA RENDER ERROR: ${error.message || error}`);
  }
}

function showAcquisition(message = '') {
  senderDataMode = false;
  cancelAnimationFrame(senderRaf);
  dataLayer.classList.add('hidden');
  acqLayer.classList.remove('hidden');
  $('sender-hud').style.display = 'none';
  try { configureSenderForCurrentViewport(); }
  catch (error) { message = `ACQUISITION ERROR: ${error.message || error}`; }
  if (message) $('sender-center-info').innerHTML += `<br><br>${message}`;
}

function startData() {
  if (!senderRunning || senderDataMode || !senderProfile) return;
  try {
    // Re-read the actual fullscreen viewport immediately before data begins.
    // If the browser changed physical dimensions on entering fullscreen, the
    // data canvas and QR-advertised profile stay identical.
    const before = `${senderProfile.columns}x${senderProfile.lanes}`;
    const next = airGridProfile({
      projectedWidth:currentDisplayPixels().width,
      projectedHeight:currentDisplayPixels().height,
      cellPx:selectedPitch()
    });
    if (!next) throw new Error('Fullscreen data profile is invalid');
    if (`${next.columns}x${next.lanes}` !== before) {
      configureSenderForCurrentViewport();
      // Profile changed after lock. Stay on acquisition so the receiver does
      // not decode against stale geometry/profile metadata.
      $('sender-center-info').innerHTML += '<br><br>DISPLAY SIZE CHANGED · RE-LOCK PHONE · CLICK AGAIN';
      return;
    }
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
    showAcquisition(`DATA START ERROR: ${error.message || error}`);
  }
}

$('start-sender').onclick = async () => {
  try {
    sender.classList.add('active');
    senderRunning = true;
    senderDataMode = false;
    acqLayer.classList.remove('hidden');
    dataLayer.classList.add('hidden');
    $('sender-hud').style.display = 'none';
    // Render a valid white acquisition page before fullscreen, so fullscreen
    // can never expose an unpainted/black canvas if the request fails.
    configureSenderForCurrentViewport();
    void sender.offsetWidth;
    try { await sender.requestFullscreen?.({ navigationUI:'hide' }); }
    catch (error) { $('sender-status').textContent = `Rendered; fullscreen request failed: ${error.message}`; }
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    // This is the authoritative profile: actual post-fullscreen viewport.
    configureSenderForCurrentViewport();
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
  if (event.code === 'Space' || event.key === 'Enter') {
    event.preventDefault();
    startData();
  } else if (event.key.toLowerCase() === 'r') {
    event.preventDefault();
    showAcquisition();
  }
});
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && senderRunning) {
    senderRunning = false;
    senderDataMode = false;
    cancelAnimationFrame(senderRaf);
    sender.classList.remove('active');
    $('sender-hud').style.display = 'none';
  }
});

// ---------------------------------------------------------------------------
// Receiver: proven QR acquisition + binary AirGrid data decoder
// ---------------------------------------------------------------------------
const video = $('video');
const overlay = $('overlay');
const overlayCtx = overlay.getContext('2d');
const qrWorker = new Worker(new URL('./receive/worker.js?airgrid-acq=1431', import.meta.url), { type:'module' });
const dataWorker = new Worker(new URL('./receive/airgrid-worker.js?build=1431', import.meta.url), { type:'module' });
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
let lockFrameWidth = 0;
let lockFrameHeight = 0;
let lastQrFrameWidth = 0;
let lastQrFrameHeight = 0;
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

function setStatus(text, cls = '') {
  $('status').textContent = text;
  $('status').className = `status ${cls}`;
}
function quadCenter(q) {
  const points = [q?.topLeft, q?.topRight, q?.bottomRight, q?.bottomLeft].filter(Boolean);
  if (points.length !== 4) return null;
  return {
    x:points.reduce((sum, p) => sum + p.x, 0) / 4,
    y:points.reduce((sum, p) => sum + p.y, 0) / 4
  };
}
function sameConfig(observations) {
  if (observations.length !== 4) return null;
  const key = airGridQrConfigKey(observations[0].config);
  return observations.every(o => airGridQrConfigKey(o.config) === key) ? observations[0].config : null;
}
function profileFromConfig(config) {
  if (!config || config.modulation !== 'binary') return null;
  const payloadBytes = airGridPayloadBytes(config.columns);
  if (payloadBytes < 8 || config.lanes < 8) return null;
  return { modulation:'binary', bitsPerCell:1, columns:config.columns, lanes:config.lanes, payloadBytes };
}
function scaleQuad(quad, sx, sy) {
  const p = q => ({ x:q.x * sx, y:q.y * sy });
  return {
    topLeft:p(quad.topLeft),
    topRight:p(quad.topRight),
    bottomRight:p(quad.bottomRight),
    bottomLeft:p(quad.bottomLeft)
  };
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
  for (const [sequence, entry] of seenBySequence) if (now - entry.at > 5000) seenBySequence.delete(sequence);
  while (goodEvents.length && now - goodEvents[0].t > 1000) goodEvents.shift();
}
function currentGoodput(now = performance.now()) {
  while (goodEvents.length && now - goodEvents[0].t > 1000) goodEvents.shift();
  const bytes = goodEvents.reduce((sum, event) => sum + event.bytes, 0);
  if (!firstGoodAt || !bytes) return 0;
  const windowMs = Math.min(1000, Math.max(100, now - firstGoodAt));
  return bytes * 1000 / windowMs;
}
function currentCaptureFps(now = performance.now()) {
  captureTimes = captureTimes.filter(t => now - t < 1000);
  if (captureTimes.length < 2) return 0;
  return (captureTimes.length - 1) * 1000 / Math.max(1, captureTimes.at(-1) - captureTimes[0]);
}

function tryLock() {
  const now = performance.now();
  for (const [corner, obs] of seen) if (now - obs.at > 3000) seen.delete(corner);
  const observations = AIRGRID_QR_ORDER.map(c => seen.get(c)).filter(Boolean);
  const config = sameConfig(observations);
  if (!config) return false;
  const h = homographyFromCorrespondences(
    AIRGRID_QR_ORDER.map(c => AIRGRID_QR_CENTERS[c]),
    AIRGRID_QR_ORDER.map(c => seen.get(c).center)
  );
  if (!h) return false;
  const profile = profileFromConfig(config);
  if (!profile) return false;
  lockedQuad = {
    topLeft:projectAirGridAcquisition(h, 0, 0),
    topRight:projectAirGridAcquisition(h, 1, 0),
    bottomRight:projectAirGridAcquisition(h, 1, 1),
    bottomLeft:projectAirGridAcquisition(h, 0, 1)
  };
  lockedConfig = config;
  lockedProfile = profile;
  lockFrameWidth = lastQrFrameWidth || video.videoWidth;
  lockFrameHeight = lastQrFrameHeight || video.videoHeight;
  generation++;
  resetGoodput();
  setStatus(`LOCKED · 4/4 QR beacons · ${BUILD} · CLICK OR SPACE ON SENDER`, 'good');
  drawOverlay();
  updateReceiverUi(true);
  return true;
}

function drawOverlay() {
  const rect = overlay.getBoundingClientRect();
  const dpr = devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (overlay.width !== width || overlay.height !== height) {
    overlay.width = width;
    overlay.height = height;
  }
  overlayCtx.clearRect(0, 0, width, height);
  if (!video.videoWidth || !video.videoHeight) return;
  const vr = video.getBoundingClientRect();
  const or = overlay.getBoundingClientRect();
  const map = p => ({
    x:(vr.left - or.left + p.x / Math.max(1, lockFrameWidth || video.videoWidth) * vr.width) * dpr,
    y:(vr.top - or.top + p.y / Math.max(1, lockFrameHeight || video.videoHeight) * vr.height) * dpr
  });
  overlayCtx.font = `${14 * dpr}px ui-monospace,monospace`;
  if (lockedQuad) {
    const pts = [lockedQuad.topLeft, lockedQuad.topRight, lockedQuad.bottomRight, lockedQuad.bottomLeft].map(map);
    overlayCtx.strokeStyle = '#72ff91';
    overlayCtx.fillStyle = '#72ff91';
    overlayCtx.lineWidth = 2 * dpr;
    overlayCtx.beginPath();
    overlayCtx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i++) overlayCtx.lineTo(pts[i].x, pts[i].y);
    overlayCtx.closePath();
    overlayCtx.stroke();
  } else {
    overlayCtx.fillStyle = '#ffd66b';
    for (const [corner, obs] of seen) {
      const p = map(obs.center);
      overlayCtx.beginPath();
      overlayCtx.arc(p.x, p.y, 7 * dpr, 0, Math.PI * 2);
      overlayCtx.fill();
      overlayCtx.fillText(corner, p.x + 10 * dpr, p.y - 8 * dpr);
    }
  }
}
window.addEventListener('resize', drawOverlay);

qrWorker.onmessage = event => {
  const data = event.data ?? {};
  if (data.id === -1) {
    workerReady = true;
    updateReceiverUi(true);
    return;
  }
  if (data.id !== scanId) return;
  qrBusy = false;
  lastScanMs = Number(data.latencyMs || 0);
  const symbols = Array.isArray(data.symbols) ? data.symbols : [];
  totalSymbols += symbols.length;
  let valid = 0;
  for (const symbol of symbols) {
    if (!symbol?.bytes || !symbol?.quad) continue;
    let raw = '';
    try {
      raw = decoder.decode(symbol.bytes instanceof Uint8Array ? symbol.bytes : Uint8Array.from(symbol.bytes));
    } catch {}
    const parsed = parseAirGridQrAcquisition(raw);
    const center = parsed ? quadCenter(symbol.quad) : null;
    if (!parsed || !center) continue;
    valid++;
    seen.set(parsed.corner, { config:parsed, center, at:performance.now() });
  }
  if (!tryLock()) {
    const corners = AIRGRID_QR_ORDER.filter(c => seen.has(c));
    setStatus(`SEARCHING · ${BUILD} · QR ${corners.length}/4 · worker hits ${symbols.length}, valid AG2 ${valid}`, 'warn');
    updateReceiverUi(true);
    drawOverlay();
  }
};
qrWorker.onerror = event => {
  qrBusy = false;
  setStatus(`QR WORKER ERROR · ${BUILD} · ${event.message}`, 'bad');
};

function scanLoop(now) {
  if (!receiverRunning) return;
  video.requestVideoFrameCallback?.(scanLoop);
  if (!workerReady || qrBusy || lockedQuad || now - lastScanAt < 220 || !video.videoWidth) return;
  lastScanAt = now;
  let frame;
  try { frame = new VideoFrame(video, { timestamp:Math.round(performance.now() * 1000) }); }
  catch (error) {
    setStatus(`VideoFrame error · ${error.message}`, 'bad');
    return;
  }
  const width = frame.codedWidth || frame.displayWidth || video.videoWidth;
  const height = frame.codedHeight || frame.displayHeight || video.videoHeight;
  lastQrFrameWidth = width;
  lastQrFrameHeight = height;
  qrBusy = true;
  scans++;
  scanId++;
  qrWorker.postMessage({
    id:scanId,
    videoFrame:frame,
    cropX:0,
    cropY:0,
    w:width,
    h:height,
    full:true,
    pixelFormat:'y8',
    acquisitionMode:'hunt',
    sentAt:performance.now()
  }, [frame]);
}

function postDataFrame(frame) {
  if (!lockedQuad || !lockedProfile) {
    frame.close();
    return;
  }
  const now = performance.now();
  captureTimes.push(now);
  if (dataBusy) {
    droppedBusy++;
    frame.close();
    updateReceiverUi();
    return;
  }
  const width = frame.codedWidth || frame.displayWidth || video.videoWidth;
  const height = frame.codedHeight || frame.displayHeight || video.videoHeight;
  const quad = lockFrameWidth && lockFrameHeight && (width !== lockFrameWidth || height !== lockFrameHeight)
    ? scaleQuad(lockedQuad, width / lockFrameWidth, height / lockFrameHeight)
    : lockedQuad;
  dataBusy = true;
  dataWorker.postMessage({
    action:'decode',
    frame,
    frameId:++frameId,
    generation,
    sentAtMs:now,
    captureTimestampMs:Number.isFinite(Number(frame.timestamp)) ? Number(frame.timestamp) / 1000 : now,
    modulation:'binary',
    quad,
    profile:lockedProfile,
    minSeparation:18
  }, [frame]);
}
async function processorLoop() {
  while (receiverRunning && processorReader) {
    const { value:frame, done } = await processorReader.read();
    if (done || !frame) break;
    postDataFrame(frame);
  }
}

dataWorker.onmessage = event => {
  const data = event.data ?? {};
  dataBusy = false;
  if (data.generation !== generation) return;
  if (data.type === 'error') {
    lastDataError = data.error || 'decode error';
    updateReceiverUi(true);
    return;
  }
  lastDiagnostics = data;
  noteVerifiedLanes(data.lanes, performance.now());
  updateReceiverUi();
};
dataWorker.onerror = event => {
  dataBusy = false;
  lastDataError = `worker crash: ${event.message}`;
  updateReceiverUi(true);
};

function updateReceiverUi(force = false) {
  const now = performance.now();
  if (!force && now - lastUiAt < 180) return;
  lastUiAt = now;
  const locked = Boolean(lockedQuad && lockedProfile);
  $('m-lock').textContent = locked ? 'LOCKED' : 'SEARCHING';
  $('m-lock').className = locked ? 'good' : 'warn';
  const good = currentGoodput(now);
  $('m-goodput').textContent = mbps(good);
  $('m-goodput').className = good >= 2_500_000 ? 'good' : good >= 2_000_000 ? 'warn' : '';
  const ceiling = lockedProfile ? lockedProfile.lanes * lockedProfile.payloadBytes * 30 : 0;
  $('m-ceiling').textContent = lockedProfile ? mbps(ceiling) : '—';
  const diagnostics = lastDiagnostics?.diagnostics;
  $('m-valid').textContent = diagnostics ? `${(diagnostics.decode.validLaneRate * 100).toFixed(1)}%` : '0%';
  $('m-fps').textContent = `${currentCaptureFps(now).toFixed(1)} fps`;
  $('m-pxcell').textContent = diagnostics ? `${diagnostics.frame.pxPerCellX.toFixed(2)}×${diagnostics.frame.pxPerCellY.toFixed(2)}` : '—';
  $('m-decode').textContent = lastDiagnostics ? `${Number(lastDiagnostics.decodeWallMs || 0).toFixed(1)} ms` : '— ms';
  $('m-drop').textContent = String(droppedBusy);
  const corners = AIRGRID_QR_ORDER.filter(c => seen.has(c));
  const failures = diagnostics?.decode?.failures ?? {};
  $('details').textContent = [
    BUILD,
    `QR worker: ${workerReady ? 'ready' : 'warming'} · scans ${scans} · symbols ${totalSymbols} · last ${lastScanMs.toFixed(0)} ms`,
    `beacons ${corners.length}/4 [${corners.join(', ') || 'none'}]`,
    lockedConfig ? `profile binary ${lockedConfig.columns}×${lockedConfig.lanes} · ${lockedProfile.payloadBytes} B/lane · sender ${lockedConfig.senderHz} Hz` : '',
    lockFrameWidth ? `lock frame ${lockFrameWidth}×${lockFrameHeight}` : '',
    diagnostics ? `CRC-valid ${diagnostics.decode.crcValidLanes}/${diagnostics.decode.totalLanes} · byte-exact ${diagnostics.decode.validLanes}/${diagnostics.decode.totalLanes}` : 'waiting for data raster',
    diagnostics ? `failures ${Object.entries(failures).map(([key, value]) => `${key}=${value}`).join(' ')}` : '',
    lastDataError ? `DATA ERROR ${lastDataError}` : ''
  ].filter(Boolean).join('\n');
}

async function startCamera() {
  await stopCamera();
  setStatus(`Starting camera · ${BUILD}`, 'warn');
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio:false,
    video:{
      facingMode:{ ideal:'environment' },
      width:{ ideal:2560 },
      height:{ ideal:1440 },
      frameRate:{ ideal:30, max:30 }
    }
  });
  mediaTrack = mediaStream.getVideoTracks()[0];
  video.srcObject = mediaStream;
  await video.play();
  receiverRunning = true;
  qrBusy = false;
  dataBusy = false;
  seen.clear();
  lockedQuad = null;
  lockedConfig = null;
  lockedProfile = null;
  lockFrameWidth = lockFrameHeight = 0;
  lastQrFrameWidth = lastQrFrameHeight = 0;
  scans = 0;
  totalSymbols = 0;
  lastScanMs = 0;
  lastScanAt = 0;
  generation++;
  resetGoodput();
  $('start-camera').disabled = true;
  $('stop-camera').disabled = false;
  setStatus(`SEARCHING · ${BUILD} · camera ${video.videoWidth}×${video.videoHeight}`, 'warn');
  updateReceiverUi(true);
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(scanLoop);
  else setStatus(`ERROR · ${BUILD} · requestVideoFrameCallback unavailable`, 'bad');
  if (globalThis.MediaStreamTrackProcessor) {
    const processor = new MediaStreamTrackProcessor({ track:mediaTrack });
    processorReader = processor.readable.getReader();
    processorLoop().catch(error => {
      lastDataError = `processor: ${error.message}`;
      updateReceiverUi(true);
    });
  } else {
    lastDataError = 'MediaStreamTrackProcessor unavailable';
    updateReceiverUi(true);
  }
}
async function stopCamera() {
  receiverRunning = false;
  generation++;
  qrBusy = false;
  dataBusy = false;
  try { await processorReader?.cancel(); } catch {}
  processorReader = null;
  for (const track of mediaStream?.getTracks?.() ?? []) track.stop();
  mediaStream = null;
  mediaTrack = null;
  video.srcObject = null;
  $('start-camera').disabled = false;
  $('stop-camera').disabled = true;
  setStatus(`Camera stopped · ${BUILD}`);
  drawOverlay();
  updateReceiverUi(true);
}
$('start-camera').onclick = () => startCamera().catch(error => setStatus(`CAMERA ERROR · ${BUILD} · ${error.message}`, 'bad'));
$('stop-camera').onclick = () => stopCamera();
window.addEventListener('beforeunload', () => {
  try { qrWorker.terminate(); dataWorker.terminate(); } catch {}
  stopCamera();
});
