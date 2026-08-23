import { airGridProfile, makeAirGridPayload } from './shared/airgrid-phy.js';
import { AirGridDiagnostics, formatAirGridDiagnostics } from './shared/airgrid-diagnostics.js';
import { AirGridPresentationDiagnostics } from './send/airgrid-present-diagnostics.js';
import { AirGridRasterRenderer, buildAirGridState } from './send/airgrid-renderer.js';

const $ = id => document.getElementById(id);
const QR_FLOOR_BPS = 2_000_000;
const AIRGRID_TARGET_BPS = 2_500_000;
const pitchValue = element => Number(element.value);
const intValue = element => Math.max(1, Math.round(Number(element.value) || 1));

function profileFor(width, height, pitch) {
  return airGridProfile({ projectedWidth: width, projectedHeight: height, cellPx: pitch });
}
function mbps(bytesPerSecond) { return `${(bytesPerSecond / 1e6).toFixed(2)} MB/s`; }
function percent(value) { return `${(value * 100).toFixed(1)}%`; }
function parsePayloadId(value) {
  const clean = String(value || '').trim().replace(/^0x/i, '');
  const parsed = Number.parseInt(clean, 16);
  return Number.isFinite(parsed) ? parsed >>> 0 : 0x51a7c0de;
}

const sendPanel = $('send-panel'), receivePanel = $('receive-panel');
function setMode(mode) {
  const send = mode === 'send';
  sendPanel.classList.toggle('hidden', !send);
  receivePanel.classList.toggle('hidden', send);
  $('mode-send').classList.toggle('active', send);
  $('mode-receive').classList.toggle('active', !send);
  const url = new URL(location.href);
  url.search = send ? '?send' : '?receive';
  history.replaceState(null, '', url);
}
$('mode-send').onclick = () => setMode('send');
$('mode-receive').onclick = () => setMode('receive');
setMode(location.search.includes('receive') ? 'receive' : 'send');

// ---------------- Sender ----------------
const senderCanvas = $('sender-canvas');
const senderStage = $('sender-stage');
const senderHud = $('sender-hud');
const rasterRenderer = new AirGridRasterRenderer();
const presentation = new AirGridPresentationDiagnostics();
let senderRunning = false;
let senderSequence = 0;
let senderRaf = 0;
let senderNextDue = 0;
let senderProfile = null;
let senderPayloadId = 0;

function plannedDisplayPixels() {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(screen.width * dpr));
  const height = Math.max(1, Math.round(screen.height * dpr));
  return { width, height, dpr };
}
function updateSendPlan() {
  const { width, height, dpr } = plannedDisplayPixels();
  const pitch = pitchValue($('send-pitch'));
  const hz = intValue($('send-hz'));
  const profile = profileFor(width, height, pitch);
  if (!profile) { $('send-plan').textContent = 'Selected grid is too small.'; return; }
  const perState = profile.lanes * profile.payloadBytes;
  $('send-plan').textContent = [
    `planned fullscreen raster: ${width}×${height} device px (DPR ${dpr})`,
    `grid: ${profile.columns} columns × ${profile.lanes} lanes @ ${pitch} display px/cell`,
    `payload: ${profile.payloadBytes} B/lane · ${(perState / 1024).toFixed(1)} KiB/state · ${mbps(perState * hz)} sender payload at ${hz} Hz`,
    `receiver must use the same sender width/height/pitch; its diagnostics will report actual camera px/cell.`
  ].join('\n');
}
for (const id of ['send-hz','send-pitch','send-payload-id']) $(id).addEventListener('input', updateSendPlan);
updateSendPlan();

function resizeSenderCanvas() {
  const dpr = window.devicePixelRatio || 1;
  senderCanvas.width = Math.max(1, Math.round(innerWidth * dpr));
  senderCanvas.height = Math.max(1, Math.round(innerHeight * dpr));
  const pitch = pitchValue($('send-pitch'));
  senderProfile = profileFor(senderCanvas.width, senderCanvas.height, pitch);
  if (!senderProfile) throw new Error('Fullscreen AirGrid profile is too small');
}
function updateSenderHud() {
  if (!senderProfile) return;
  const snap = presentation.snapshot();
  const perState = senderProfile.lanes * senderProfile.payloadBytes;
  senderHud.textContent = [
    `seq ${senderSequence} · ${senderCanvas.width}×${senderCanvas.height}`,
    `${senderProfile.columns}×${senderProfile.lanes} · ${senderProfile.payloadBytes} B/lane`,
    `${snap.actualHz.toFixed(1)} / ${snap.requestedHz.toFixed(0)} Hz`,
    `render p95 ${snap.renderP95Ms.toFixed(2)} ms · missed ${snap.missedIntervals}`,
    `${mbps(perState * snap.actualHz)} presentation payload`
  ].join('\n');
}
function senderTick(now) {
  if (!senderRunning) return;
  senderRaf = requestAnimationFrame(senderTick);
  const hz = intValue($('send-hz'));
  const period = 1000 / hz;
  if (now + 0.2 < senderNextDue) return;
  const skipped = Math.max(1, Math.floor((now - senderNextDue) / period) + 1);
  senderNextDue += skipped * period;
  senderSequence = (senderSequence + skipped) & 0xffffff;
  const started = performance.now();
  const state = buildAirGridState({
    profile: senderProfile,
    payloadId: senderPayloadId,
    sequence: senderSequence,
    profileId: 0,
    payloadForLane: laneIndex => makeAirGridPayload(senderProfile.payloadBytes, senderPayloadId, senderSequence, laneIndex)
  });
  const ctx = senderCanvas.getContext('2d', { alpha: false });
  rasterRenderer.render(ctx, state, senderCanvas.width, senderCanvas.height);
  const renderMs = performance.now() - started;
  presentation.noteFrame({ sequence: senderSequence, requestedHz: hz, presentedAtMs: now, renderMs });
  if (senderHud.classList.contains('show')) updateSenderHud();
}
async function startSender() {
  senderPayloadId = parsePayloadId($('send-payload-id').value);
  presentation.clear();
  senderSequence = 0;
  senderStage.classList.add('active');
  try { await senderStage.requestFullscreen?.({ navigationUI: 'hide' }); } catch {}
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  resizeSenderCanvas();
  senderRunning = true;
  senderNextDue = performance.now();
  senderRaf = requestAnimationFrame(senderTick);
}
function stopSender() {
  senderRunning = false;
  cancelAnimationFrame(senderRaf);
  senderStage.classList.remove('active');
  senderHud.classList.remove('show');
}
$('send-start').onclick = () => startSender().catch(error => alert(error.message));
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && senderRunning) stopSender(); });
document.addEventListener('keydown', event => {
  if (!senderRunning) return;
  if (event.key.toLowerCase() === 'd') { senderHud.classList.toggle('show'); updateSenderHud(); }
});
window.addEventListener('resize', () => { if (senderRunning) resizeSenderCanvas(); });

// ---------------- Receiver ----------------
const video = $('camera-video');
const overlay = $('camera-overlay');
const overlayCtx = overlay.getContext('2d');
const decodeWorker = new Worker(new URL('./receive/airgrid-worker.js', import.meta.url), { type: 'module' });
let mediaStream = null;
let mediaTrack = null;
let processorReader = null;
let receiverRunning = false;
let workerBusy = false;
let frameId = 0;
let generation = 1;
let droppedBusy = 0;
let decodedFrames = 0;
let calibrationPoints = [];
let calibrating = false;
let receiverQuad = null;
let receiverProfile = null;
let receiverSettings = {};
let settingsReadAt = 0;
let lastFrameDiagnostics = null;
let lastSnapshot = null;
let runFrames = [];
let runStartedAt = 0;
const monitor = new AirGridDiagnostics({ windowFrames: 180, targetBytesPerSecond: AIRGRID_TARGET_BPS });

function receiverPlan() {
  const senderW = intValue($('recv-sender-w'));
  const senderH = intValue($('recv-sender-h'));
  const pitch = pitchValue($('recv-pitch'));
  const cameraFps = intValue($('cam-fps'));
  receiverProfile = profileFor(senderW, senderH, pitch);
  if (!receiverProfile) return null;
  const perCapture = receiverProfile.lanes * receiverProfile.payloadBytes;
  const ceiling = perCapture * cameraFps;
  const floorEfficiency = QR_FLOOR_BPS / Math.max(1, ceiling);
  const targetEfficiency = AIRGRID_TARGET_BPS / Math.max(1, ceiling);
  $('recv-plan').textContent = [
    `logical sender grid: ${receiverProfile.columns} × ${receiverProfile.lanes} · ${receiverProfile.payloadBytes} B/lane`,
    `camera-FPS ceiling: ${mbps(ceiling)} at ${cameraFps} fps if every lane decodes`,
    `required valid-lane efficiency: ${(floorEfficiency * 100).toFixed(1)}% to beat QR · ${(targetEfficiency * 100).toFixed(1)}% to hit 2.5 MB/s`,
    ceiling <= QR_FLOOR_BPS ? '⚠ This profile cannot beat the 2.0 MB/s QR benchmark at the selected camera FPS.' : 'Profile has enough theoretical camera bandwidth to beat QR.'
  ].join('\n');
  return receiverProfile;
}
for (const id of ['cam-res','cam-fps','recv-sender-w','recv-sender-h','recv-pitch','recv-sender-hz']) $(id).addEventListener('input', receiverPlan);
receiverPlan();

function setReceiverStatus(text, cls = '') {
  const el = $('receiver-status');
  el.textContent = text;
  el.className = `status-line ${cls}`;
}
function enableReceiverButtons(enabled) {
  $('calibrate').disabled = !enabled;
  $('reset-stats').disabled = !enabled;
  $('export-run').disabled = !enabled;
  $('camera-stop').disabled = !enabled;
}
function resetRun() {
  monitor.clear();
  droppedBusy = 0;
  decodedFrames = 0;
  runFrames = [];
  runStartedAt = performance.now();
  lastSnapshot = null;
  updateReceiverMetrics();
}
$('reset-stats').onclick = resetRun;

function drawCalibrationOverlay() {
  const rect = overlay.getBoundingClientRect();
  const dpr = devicePixelRatio || 1;
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (overlay.width !== w || overlay.height !== h) { overlay.width = w; overlay.height = h; }
  overlayCtx.clearRect(0, 0, w, h);
  if (!video.videoWidth || !video.videoHeight) return;
  const vr = video.getBoundingClientRect(), or = overlay.getBoundingClientRect();
  const map = p => ({
    x: (vr.left - or.left + p.x / video.videoWidth * vr.width) * dpr,
    y: (vr.top - or.top + p.y / video.videoHeight * vr.height) * dpr
  });
  const points = receiverQuad ? [receiverQuad.topLeft, receiverQuad.topRight, receiverQuad.bottomRight, receiverQuad.bottomLeft] : calibrationPoints;
  overlayCtx.lineWidth = 2 * dpr;
  overlayCtx.strokeStyle = receiverQuad ? '#72ff91' : '#ffd35c';
  overlayCtx.fillStyle = overlayCtx.strokeStyle;
  overlayCtx.font = `${14 * dpr}px system-ui`;
  if (points.length > 1) {
    overlayCtx.beginPath();
    const first = map(points[0]); overlayCtx.moveTo(first.x, first.y);
    for (let i = 1; i < points.length; i++) { const p = map(points[i]); overlayCtx.lineTo(p.x, p.y); }
    if (receiverQuad) overlayCtx.closePath();
    overlayCtx.stroke();
  }
  points.forEach((point, index) => {
    const p = map(point);
    overlayCtx.beginPath(); overlayCtx.arc(p.x, p.y, 8 * dpr, 0, Math.PI * 2); overlayCtx.fill();
    overlayCtx.fillText(String(index + 1), p.x + 11 * dpr, p.y - 7 * dpr);
  });
}
function clientToVideoPoint(clientX, clientY) {
  const r = video.getBoundingClientRect();
  if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return null;
  return {
    x: Math.max(0, Math.min(video.videoWidth - 1, (clientX - r.left) / r.width * video.videoWidth)),
    y: Math.max(0, Math.min(video.videoHeight - 1, (clientY - r.top) / r.height * video.videoHeight))
  };
}
$('calibrate').onclick = () => {
  calibrating = true;
  receiverQuad = null;
  calibrationPoints = [];
  generation++;
  setReceiverStatus('Tap screen corners in order: TOP-LEFT → TOP-RIGHT → BOTTOM-RIGHT → BOTTOM-LEFT', 'warn');
  drawCalibrationOverlay();
};
overlay.addEventListener('pointerdown', event => {
  if (!calibrating) return;
  const point = clientToVideoPoint(event.clientX, event.clientY);
  if (!point) return;
  calibrationPoints.push(point);
  drawCalibrationOverlay();
  if (calibrationPoints.length === 4) {
    receiverQuad = {
      topLeft: calibrationPoints[0], topRight: calibrationPoints[1],
      bottomRight: calibrationPoints[2], bottomLeft: calibrationPoints[3]
    };
    calibrating = false;
    generation++;
    resetRun();
    setReceiverStatus('Calibrated. Keep the sender stationary; decoding is live.', 'good');
    drawCalibrationOverlay();
  }
});
window.addEventListener('resize', drawCalibrationOverlay);

function cachedTrackSettings() {
  const t = performance.now();
  if (t - settingsReadAt > 500) {
    settingsReadAt = t;
    try { receiverSettings = mediaTrack?.getSettings?.() ?? {}; } catch {}
  }
  return receiverSettings;
}
function postVideoFrame(frame) {
  if (!receiverQuad || !receiverProfile) { frame.close(); return; }
  if (workerBusy) { droppedBusy++; frame.close(); return; }
  workerBusy = true;
  const settings = cachedTrackSettings();
  const captureTimestampMs = Number.isFinite(Number(frame.timestamp)) ? Number(frame.timestamp) / 1000 : performance.now();
  decodeWorker.postMessage({
    action: 'decode', frame, frameId: ++frameId, generation, sentAtMs: performance.now(), captureTimestampMs,
    quad: receiverQuad, profile: receiverProfile, minSeparation: intValue($('recv-separation')),
    cameraSettings: settings
  }, [frame]);
}
async function processorLoop() {
  while (receiverRunning && processorReader) {
    const { value: frame, done } = await processorReader.read();
    if (done || !frame) break;
    postVideoFrame(frame);
  }
}

let fallbackCanvas, fallbackCtx;
function rgbaToY8(data, width, height) {
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) out[i] = Math.round(data[p] * 0.2126 + data[p + 1] * 0.7152 + data[p + 2] * 0.0722);
  return out;
}
function fallbackLoop(now, metadata) {
  if (!receiverRunning) return;
  video.requestVideoFrameCallback(fallbackLoop);
  if (!receiverQuad || !receiverProfile) return;
  if (workerBusy) { droppedBusy++; return; }
  const width = video.videoWidth, height = video.videoHeight;
  if (!width || !height) return;
  if (!fallbackCanvas) { fallbackCanvas = document.createElement('canvas'); fallbackCtx = fallbackCanvas.getContext('2d', { willReadFrequently: true }); }
  if (fallbackCanvas.width !== width || fallbackCanvas.height !== height) { fallbackCanvas.width = width; fallbackCanvas.height = height; }
  const started = performance.now();
  fallbackCtx.drawImage(video, 0, 0, width, height);
  const rgba = fallbackCtx.getImageData(0, 0, width, height).data;
  const y8 = rgbaToY8(rgba, width, height);
  const copyMs = performance.now() - started;
  workerBusy = true;
  decodeWorker.postMessage({
    action: 'decode', y8: y8.buffer, width, height, copyMs, copyPath: 'canvas-rgba',
    frameId: ++frameId, generation, sentAtMs: performance.now(),
    captureTimestampMs: Number.isFinite(metadata?.mediaTime) ? metadata.mediaTime * 1000 : performance.now(),
    quad: receiverQuad, profile: receiverProfile, minSeparation: intValue($('recv-separation'))
  }, [y8.buffer]);
}

async function startCamera() {
  await stopCamera();
  receiverProfile = receiverPlan();
  if (!receiverProfile) throw new Error('Invalid receiver profile');
  const [width, height] = $('cam-res').value.split('x').map(Number);
  const fps = intValue($('cam-fps'));
  setReceiverStatus('Starting camera…');
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: fps, max: fps } }
  });
  mediaTrack = mediaStream.getVideoTracks()[0];
  video.srcObject = mediaStream;
  await video.play();
  receiverRunning = true;
  workerBusy = false;
  generation++;
  receiverQuad = null;
  calibrationPoints = [];
  resetRun();
  enableReceiverButtons(true);
  $('camera-start').disabled = true;
  const settings = cachedTrackSettings();
  const actual = `${video.videoWidth}×${video.videoHeight} @ ${Number(settings.frameRate || 0).toFixed(1)} fps`;
  if (globalThis.MediaStreamTrackProcessor) {
    const processor = new MediaStreamTrackProcessor({ track: mediaTrack });
    processorReader = processor.readable.getReader();
    processorLoop().catch(error => setReceiverStatus(`Processor failed: ${error.message}`, 'bad'));
    setReceiverStatus(`Camera ${actual}. Click Calibrate 4 corners. Path: VideoFrame → worker → Y8.`, 'good');
  } else if (video.requestVideoFrameCallback) {
    video.requestVideoFrameCallback(fallbackLoop);
    setReceiverStatus(`Camera ${actual}. Click Calibrate 4 corners. Path: canvas RGBA fallback (slower).`, 'warn');
  } else throw new Error('Browser has neither MediaStreamTrackProcessor nor requestVideoFrameCallback');
  drawCalibrationOverlay();
}
async function stopCamera() {
  receiverRunning = false;
  generation++;
  try { await processorReader?.cancel(); } catch {}
  processorReader = null;
  for (const track of mediaStream?.getTracks?.() ?? []) track.stop();
  mediaStream = null; mediaTrack = null;
  video.srcObject = null;
  workerBusy = false;
  enableReceiverButtons(false);
  $('camera-start').disabled = false;
}
$('camera-start').onclick = () => startCamera().catch(error => { setReceiverStatus(error.message, 'bad'); stopCamera(); });
$('camera-stop').onclick = () => stopCamera();

function setMetric(id, text, className = '') { const el = $(id); el.textContent = text; el.className = className; }
function updateReceiverMetrics() {
  const s = lastSnapshot;
  if (!s) {
    for (const [id,text] of [['m-goodput','0.00 MB/s'],['m-floor','0%'],['m-target','0%'],['m-camfps','0 fps'],['m-valid','0%'],['m-pxcell','—'],['m-snr','—'],['m-sep','—'],['m-readout','— ms'],['m-cpu','—%'],['m-copy','— ms']]) setMetric(id,text);
    setMetric('m-drop', String(droppedBusy)); $('receiver-details').textContent = ''; return;
  }
  const good = s.goodput.bytesPerSecond;
  setMetric('m-goodput', mbps(good), good > AIRGRID_TARGET_BPS ? 'good' : good > QR_FLOOR_BPS ? 'warn' : 'bad');
  setMetric('m-floor', `${(good / QR_FLOOR_BPS * 100).toFixed(0)}%`, good > QR_FLOOR_BPS ? 'good' : 'bad');
  setMetric('m-target', `${(good / AIRGRID_TARGET_BPS * 100).toFixed(0)}%`, good > AIRGRID_TARGET_BPS ? 'good' : 'warn');
  setMetric('m-camfps', `${s.capture.fps.toFixed(1)} fps`);
  setMetric('m-valid', percent(s.channel.validLaneRate), s.channel.validLaneRate > .85 ? 'good' : s.channel.validLaneRate > .5 ? 'warn' : 'bad');
  const frame = lastFrameDiagnostics?.frame;
  setMetric('m-pxcell', frame ? `${frame.pxPerCellX.toFixed(2)}×${frame.pxPerCellY.toFixed(2)}` : '—');
  setMetric('m-snr', s.channel.snrP10.toFixed(1));
  setMetric('m-sep', s.channel.separationP10.toFixed(1));
  const readout = s.rollingShutter.sensorReadoutMs || s.rollingShutter.inferredReadoutMs;
  setMetric('m-readout', `${readout.toFixed(2)} ms`);
  setMetric('m-cpu', `${(s.cpu.frameBudgetUsedP95 * 100).toFixed(0)}%`, s.cpu.frameBudgetUsedP95 > .8 ? 'bad' : 'good');
  setMetric('m-copy', `${s.cpu.copyP50Ms.toFixed(2)} ms`);
  setMetric('m-drop', String(droppedBusy), droppedBusy ? 'warn' : 'good');
  const failures = lastFrameDiagnostics?.decode?.failures ?? {};
  const settings = receiverSettings;
  $('receiver-details').textContent = [
    formatAirGridDiagnostics(s),
    `bottleneck: ${s.bottleneck}`,
    `failures/frame: ${Object.entries(failures).map(([k,v]) => `${k}=${v}`).join(' ')}`,
    `sequences in latest capture: ${(lastFrameDiagnostics?.rollingShutter?.sequences ?? []).join(', ') || 'none'}`,
    `camera settings: ${JSON.stringify({width:settings.width,height:settings.height,frameRate:settings.frameRate,exposureTime:settings.exposureTime,iso:settings.iso,focusDistance:settings.focusDistance})}`,
    `worker drops: ${droppedBusy} · decoded frames: ${decodedFrames}`
  ].join('\n');
}

decodeWorker.onmessage = event => {
  const data = event.data;
  if (data.generation !== generation) return;
  workerBusy = false;
  if (data.type === 'error') { setReceiverStatus(`Decode worker: ${data.error}`, 'bad'); return; }
  decodedFrames++;
  lastFrameDiagnostics = data.diagnostics;
  const settings = cachedTrackSettings();
  lastSnapshot = monitor.observe({
    diagnostics: data.diagnostics,
    captureTimestampMs: data.captureTimestampMs,
    copyMs: data.copyMs,
    queueMs: data.queueMs,
    exposureUs: Number(settings.exposureTime),
    iso: Number(settings.iso),
    frameDurationUs: Number(settings.frameRate) > 0 ? 1e6 / Number(settings.frameRate) : undefined,
    senderHz: intValue($('recv-sender-hz'))
  });
  if (runFrames.length < 1800) runFrames.push({
    tMs: performance.now() - runStartedAt,
    goodputBps: lastSnapshot.goodput.bytesPerSecond,
    validLaneRate: data.diagnostics.decode.validLaneRate,
    bytesDecoded: data.diagnostics.decode.bytesDecoded,
    failures: data.diagnostics.decode.failures,
    separationP10: data.diagnostics.optics.separationP10,
    snrP10: data.diagnostics.optics.snrP10,
    pxPerCellX: data.diagnostics.frame.pxPerCellX,
    pxPerCellY: data.diagnostics.frame.pxPerCellY,
    sequences: data.diagnostics.rollingShutter.sequences,
    copyMs: data.copyMs,
    decodeMs: data.decodeWallMs,
    copyPath: data.copyPath
  });
  updateReceiverMetrics();
};
decodeWorker.onerror = event => { workerBusy = false; setReceiverStatus(`Worker crashed: ${event.message}`, 'bad'); };

$('export-run').onclick = () => {
  const exportData = {
    exportedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    qrBaselineBytesPerSecond: QR_FLOOR_BPS,
    airGridTargetBytesPerSecond: AIRGRID_TARGET_BPS,
    senderProfile: {
      width: intValue($('recv-sender-w')), height: intValue($('recv-sender-h')),
      displayCellPx: pitchValue($('recv-pitch')), senderHz: intValue($('recv-sender-hz')),
      ...receiverProfile
    },
    cameraRequested: { resolution: $('cam-res').value, fps: intValue($('cam-fps')) },
    cameraSettings: receiverSettings,
    quad: receiverQuad,
    workerBusyDrops: droppedBusy,
    decodedFrames,
    summary: lastSnapshot,
    frames: runFrames
  };
  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `airgrid-hardware-${Date.now()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

window.addEventListener('beforeunload', () => { try { decodeWorker.terminate(); } catch {} stopCamera(); });
