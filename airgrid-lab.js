import { airGridPayloadBytes, airGridProfile, makeAirGridPayload } from './shared/airgrid-phy.js';
import { airGridPam4PayloadBytes, airGridPam4Profile } from './shared/airgrid-pam4.js';
import { findAirGridAcquisition } from './shared/airgrid-acquisition.js';
import { AirGridDiagnostics, formatAirGridDiagnostics } from './shared/airgrid-diagnostics.js';
import { AirGridPresentationDiagnostics } from './send/airgrid-present-diagnostics.js';
import { renderAirGridAcquisition } from './send/airgrid-acquisition-renderer.js';
import { AirGridRasterRenderer, buildAirGridState } from './send/airgrid-renderer.js';

const $ = id => document.getElementById(id);
const QR_FLOOR_BPS = 2_000_000;
const AIRGRID_TARGET_BPS = 2_500_000;
const DEFAULT_PAYLOAD_ID = 0x51a7c0de;
const intValue = element => Math.max(1, Math.round(Number(element?.value) || 1));
const numberValue = element => Number(element?.value);
const mbps = bytesPerSecond => `${(bytesPerSecond / 1e6).toFixed(2)} MB/s`;
const percent = value => `${(value * 100).toFixed(1)}%`;

function parsePayloadId(value) {
  const clean = String(value || '').trim().replace(/^0x/i, '');
  const parsed = Number.parseInt(clean, 16);
  return Number.isFinite(parsed) ? parsed >>> 0 : DEFAULT_PAYLOAD_ID;
}
function senderModulation() { return $('send-modulation').value === 'pam4' ? 'pam4' : 'binary'; }
function senderProfileFor(width, height, pitch, modulation) {
  return modulation === 'pam4'
    ? airGridPam4Profile({ projectedWidth: width, projectedHeight: height, cellPx: pitch })
    : airGridProfile({ projectedWidth: width, projectedHeight: height, cellPx: pitch });
}
function profileFromAcquisition(config) {
  const payloadBytes = config.modulation === 'pam4'
    ? airGridPam4PayloadBytes(config.columns)
    : airGridPayloadBytes(config.columns);
  if (payloadBytes < 8 || config.lanes < 8) return null;
  return {
    modulation: config.modulation,
    bitsPerCell: config.modulation === 'pam4' ? 2 : 1,
    columns: config.columns,
    lanes: config.lanes,
    payloadBytes
  };
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

// ---------------------------------------------------------------------------
// Sender
// ---------------------------------------------------------------------------
const senderCanvas = $('sender-canvas');
const senderStage = $('sender-stage');
const senderHud = $('sender-hud');
const rasterRenderer = new AirGridRasterRenderer();
const presentation = new AirGridPresentationDiagnostics();
let senderRunning = false;
let senderSequence = 0;
let senderRaf = 0;
let senderNextDue = 0;
let senderStartedAt = 0;
let senderProfile = null;
let senderPayloadId = DEFAULT_PAYLOAD_ID;
let activeSenderModulation = 'pam4';
let senderWasAcquiring = false;

function plannedDisplayPixels() {
  const dpr = window.devicePixelRatio || 1;
  return { width: Math.max(1, Math.round(screen.width * dpr)), height: Math.max(1, Math.round(screen.height * dpr)), dpr };
}
function updateSendPlan() {
  const { width, height, dpr } = plannedDisplayPixels();
  const pitch = numberValue($('send-pitch'));
  const hz = intValue($('send-hz'));
  const modulation = senderModulation();
  const profile = senderProfileFor(width, height, pitch, modulation);
  if (!profile) { $('send-plan').textContent = 'Selected grid is too small.'; return; }
  const perState = profile.lanes * profile.payloadBytes;
  $('send-plan').textContent = [
    `fullscreen target: ${width}×${height} device px (DPR ${dpr})`,
    `${modulation.toUpperCase()} · ${profile.columns} columns × ${profile.lanes} lanes · ${profile.payloadBytes} B/lane`,
    `${(perState / 1024).toFixed(1)} KiB/data state · ${mbps(perState * 30)} theoretical at a 30 fps camera`,
    `automatic acquisition is self-describing; receiver settings do not need to match manually.`
  ].join('\n');
}
for (const id of ['send-modulation','send-hz','send-pitch','send-payload-id']) $(id).addEventListener('input', updateSendPlan);
updateSendPlan();

function resizeSenderCanvas() {
  const dpr = window.devicePixelRatio || 1;
  senderCanvas.width = Math.max(1, Math.round(innerWidth * dpr));
  senderCanvas.height = Math.max(1, Math.round(innerHeight * dpr));
  activeSenderModulation = senderModulation();
  senderProfile = senderProfileFor(senderCanvas.width, senderCanvas.height, numberValue($('send-pitch')), activeSenderModulation);
  if (!senderProfile) throw new Error('Fullscreen AirGrid profile is too small');
}
function senderAcquisitionDue(now) {
  const elapsed = now - senderStartedAt;
  if (elapsed < 1200) return true;
  // 180 ms every 3.5 s gives a 30 fps camera several chances to observe the
  // self-describing frame while keeping steady temporal overhead near 5%.
  return ((elapsed - 1200) % 3500) < 180;
}
function currentAcquisitionConfig() {
  return {
    columns: senderProfile.columns,
    lanes: senderProfile.lanes,
    modulation: activeSenderModulation,
    senderHz: intValue($('send-hz')),
    payloadId: senderPayloadId
  };
}
function updateSenderHud(acquiring = false) {
  if (!senderProfile) return;
  const snap = presentation.snapshot();
  const perState = senderProfile.lanes * senderProfile.payloadBytes;
  senderHud.textContent = [
    acquiring ? 'AUTO ACQUISITION BURST' : `seq ${senderSequence}`,
    `${senderCanvas.width}×${senderCanvas.height} · ${activeSenderModulation.toUpperCase()}`,
    `${senderProfile.columns}×${senderProfile.lanes} · ${senderProfile.payloadBytes} B/lane`,
    `${snap.actualHz.toFixed(1)} / ${snap.requestedHz.toFixed(0)} Hz · render p95 ${snap.renderP95Ms.toFixed(2)} ms`,
    `${mbps(perState * 30)} theoretical @ 30 camera fps`
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
  const ctx = senderCanvas.getContext('2d', { alpha:false });
  const started = performance.now();
  const acquiring = senderAcquisitionDue(now);
  if (acquiring) {
    renderAirGridAcquisition(ctx, senderCanvas.width, senderCanvas.height, currentAcquisitionConfig());
  } else {
    senderSequence = (senderSequence + skipped) & 0xffffff;
    const state = buildAirGridState({
      profile: senderProfile,
      modulation: activeSenderModulation,
      payloadId: senderPayloadId,
      sequence: senderSequence,
      profileId: activeSenderModulation === 'pam4' ? 1 : 0,
      payloadForLane: laneIndex => makeAirGridPayload(senderProfile.payloadBytes, senderPayloadId, senderSequence, laneIndex)
    });
    rasterRenderer.render(ctx, state, senderCanvas.width, senderCanvas.height);
  }
  const renderMs = performance.now() - started;
  presentation.noteFrame({ sequence:senderSequence, requestedHz:hz, presentedAtMs:now, renderMs });
  if (acquiring !== senderWasAcquiring || senderHud.classList.contains('show')) updateSenderHud(acquiring);
  senderWasAcquiring = acquiring;
}
async function startSender() {
  senderPayloadId = parsePayloadId($('send-payload-id').value);
  presentation.clear();
  senderSequence = 0;
  senderStage.classList.add('active');
  try { await senderStage.requestFullscreen?.({ navigationUI:'hide' }); } catch {}
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  resizeSenderCanvas();
  senderRunning = true;
  senderStartedAt = performance.now();
  senderNextDue = senderStartedAt;
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
  if (senderRunning && event.key.toLowerCase() === 'd') { senderHud.classList.toggle('show'); updateSenderHud(senderWasAcquiring); }
});
window.addEventListener('resize', () => { if (senderRunning) resizeSenderCanvas(); });

// ---------------------------------------------------------------------------
// Receiver: automatic acquisition + data decoder
// ---------------------------------------------------------------------------
const video = $('camera-video');
const overlay = $('camera-overlay');
const overlayCtx = overlay.getContext('2d');
const decodeWorker = new Worker(new URL('./receive/airgrid-worker.js', import.meta.url), { type:'module' });
const monitor = new AirGridDiagnostics({ windowFrames:180, targetBytesPerSecond:AIRGRID_TARGET_BPS });
const acquisitionCanvas = document.createElement('canvas');
const acquisitionCtx = acquisitionCanvas.getContext('2d', { willReadFrequently:true });
let mediaStream = null;
let mediaTrack = null;
let processorReader = null;
let receiverRunning = false;
let workerBusy = false;
let frameId = 0;
let generation = 1;
let droppedBusy = 0;
let decodedFrames = 0;
let receiverQuad = null;
let receiverProfile = null;
let acquiredConfig = null;
let activeReceiverModulation = 'binary';
let receiverSettings = {};
let settingsReadAt = 0;
let lastFrameDiagnostics = null;
let lastSnapshot = null;
let runFrames = [];
let runStartedAt = 0;
let acquisitionBusy = false;
let acquisitionScans = 0;
let acquisitionHits = 0;
let lastAcquisitionScanAt = 0;
let lastLockAt = 0;
let acquisitionTimer = 0;

function setReceiverStatus(text, cls='') {
  const el = $('receiver-status');
  el.textContent = text;
  el.className = `status-line ${cls}`;
}
function enableReceiverButtons(enabled) {
  $('reacquire').disabled = !enabled;
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
  lastFrameDiagnostics = null;
  updateReceiverMetrics();
}
$('reset-stats').onclick = resetRun;

function clearLock(reason = 'Searching for AirGrid acquisition frame…') {
  receiverQuad = null;
  receiverProfile = null;
  acquiredConfig = null;
  lastLockAt = 0;
  generation++;
  $('recv-plan').textContent = '';
  setReceiverStatus(`${reason} Keep all four sender-screen corners visible.`, 'warn');
  drawReceiverOverlay();
  updateReceiverMetrics();
}
$('reacquire').onclick = () => clearLock('Reacquiring…');

function scaleQuad(quad, sx, sy) {
  const p = value => ({ x:value.x*sx, y:value.y*sy });
  return { topLeft:p(quad.topLeft), topRight:p(quad.topRight), bottomRight:p(quad.bottomRight), bottomLeft:p(quad.bottomLeft) };
}
function smoothPoint(a,b,t) { return { x:a.x*(1-t)+b.x*t, y:a.y*(1-t)+b.y*t }; }
function smoothQuad(a,b,t=0.35) {
  if (!a) return b;
  return {
    topLeft:smoothPoint(a.topLeft,b.topLeft,t), topRight:smoothPoint(a.topRight,b.topRight,t),
    bottomRight:smoothPoint(a.bottomRight,b.bottomRight,t), bottomLeft:smoothPoint(a.bottomLeft,b.bottomLeft,t)
  };
}
function configKey(config) { return config ? `${config.modulation}:${config.columns}:${config.lanes}:${config.senderHz}:${config.payloadId}` : ''; }
function applyAcquisition(found, scanWidth, scanHeight) {
  const profile = profileFromAcquisition(found.config);
  if (!profile || !video.videoWidth || !video.videoHeight) return false;
  const newQuad = scaleQuad(found.quad, video.videoWidth/scanWidth, video.videoHeight/scanHeight);
  const changed = configKey(found.config) !== configKey(acquiredConfig);
  const first = !receiverProfile;
  receiverQuad = changed || !receiverQuad ? newQuad : smoothQuad(receiverQuad,newQuad);
  receiverProfile = profile;
  acquiredConfig = found.config;
  activeReceiverModulation = found.config.modulation;
  lastLockAt = performance.now();
  acquisitionHits++;
  $('recv-separation').value = activeReceiverModulation === 'pam4' ? '10' : '18';
  if (changed || first) {
    generation++;
    resetRun();
  }
  const requestedFps = intValue($('cam-fps'));
  const perCapture = profile.lanes * profile.payloadBytes;
  const ceiling = perCapture * requestedFps;
  $('recv-plan').textContent = [
    `AUTO PROFILE: ${activeReceiverModulation.toUpperCase()} · ${profile.columns} columns × ${profile.lanes} lanes · ${profile.payloadBytes} B/lane`,
    `sender ${found.config.senderHz} Hz · payload ID ${found.config.payloadId.toString(16).padStart(8,'0')}`,
    `${mbps(ceiling)} byte payload ceiling at ${requestedFps} camera fps before optical/CPU losses`,
    `${(QR_FLOOR_BPS/Math.max(1,ceiling)*100).toFixed(1)}% byte-exact lane efficiency required to beat 2.0 MB/s`
  ].join('\n');
  setReceiverStatus(`LOCKED automatically: ${activeReceiverModulation.toUpperCase()} ${profile.columns}×${profile.lanes}. Data decode is live.`, 'good');
  drawReceiverOverlay();
  updateReceiverMetrics();
  return true;
}

function rgbaToY8(data, width, height) {
  const out = new Uint8Array(width*height);
  for (let i=0,p=0;i<out.length;i++,p+=4) out[i] = Math.round(data[p]*0.2126 + data[p+1]*0.7152 + data[p+2]*0.0722);
  return out;
}
function scanForAcquisition() {
  if (!receiverRunning || acquisitionBusy || !video.videoWidth || !video.videoHeight) return;
  const now = performance.now();
  const interval = receiverProfile ? 140 : 65;
  if (now - lastAcquisitionScanAt < interval) return;
  lastAcquisitionScanAt = now;
  acquisitionBusy = true;
  try {
    const width = 360;
    const height = Math.max(120, Math.min(300, Math.round(width * video.videoHeight / video.videoWidth)));
    if (acquisitionCanvas.width !== width || acquisitionCanvas.height !== height) { acquisitionCanvas.width=width; acquisitionCanvas.height=height; }
    acquisitionCtx.drawImage(video,0,0,width,height);
    const rgba = acquisitionCtx.getImageData(0,0,width,height).data;
    const y8 = rgbaToY8(rgba,width,height);
    acquisitionScans++;
    const found = findAirGridAcquisition(y8,width,height);
    if (found) applyAcquisition(found,width,height);
    else if (!receiverProfile && acquisitionScans % 12 === 0) setReceiverStatus('Searching… point at the whole sender screen. The white finder frame reappears automatically.', 'warn');
  } catch (error) {
    if (!receiverProfile) setReceiverStatus(`Acquisition scan error: ${error.message}`, 'bad');
  } finally {
    acquisitionBusy = false;
  }
}
function acquisitionVideoLoop() {
  if (!receiverRunning) return;
  scanForAcquisition();
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(acquisitionVideoLoop);
}

function drawReceiverOverlay() {
  const rect = overlay.getBoundingClientRect();
  const dpr = devicePixelRatio || 1;
  const w = Math.max(1,Math.round(rect.width*dpr)), h = Math.max(1,Math.round(rect.height*dpr));
  if (overlay.width!==w || overlay.height!==h) { overlay.width=w; overlay.height=h; }
  overlayCtx.clearRect(0,0,w,h);
  if (!receiverQuad || !video.videoWidth || !video.videoHeight) return;
  const vr = video.getBoundingClientRect(), or = overlay.getBoundingClientRect();
  const map = p => ({ x:(vr.left-or.left + p.x/video.videoWidth*vr.width)*dpr, y:(vr.top-or.top + p.y/video.videoHeight*vr.height)*dpr });
  const points = [receiverQuad.topLeft,receiverQuad.topRight,receiverQuad.bottomRight,receiverQuad.bottomLeft].map(map);
  overlayCtx.strokeStyle='#72ff91'; overlayCtx.lineWidth=2*dpr; overlayCtx.fillStyle='#72ff91';
  overlayCtx.beginPath(); overlayCtx.moveTo(points[0].x,points[0].y); for(let i=1;i<4;i++) overlayCtx.lineTo(points[i].x,points[i].y); overlayCtx.closePath(); overlayCtx.stroke();
  for (const p of points) { overlayCtx.beginPath(); overlayCtx.arc(p.x,p.y,5*dpr,0,Math.PI*2); overlayCtx.fill(); }
  overlayCtx.font=`${13*dpr}px ui-monospace,monospace`; overlayCtx.fillText(`AUTO ${activeReceiverModulation.toUpperCase()} ${receiverProfile.columns}×${receiverProfile.lanes}`,points[0].x+8*dpr,points[0].y+18*dpr);
}
window.addEventListener('resize',drawReceiverOverlay);

function cachedTrackSettings() {
  const t=performance.now();
  if (t-settingsReadAt>500) {
    settingsReadAt=t;
    try { receiverSettings=mediaTrack?.getSettings?.()??{}; } catch {}
  }
  return receiverSettings;
}
function postVideoFrame(frame) {
  if (!receiverQuad || !receiverProfile) { frame.close(); return; }
  if (workerBusy) { droppedBusy++; frame.close(); return; }
  workerBusy=true;
  const settings=cachedTrackSettings();
  const captureTimestampMs=Number.isFinite(Number(frame.timestamp))?Number(frame.timestamp)/1000:performance.now();
  decodeWorker.postMessage({
    action:'decode', frame, frameId:++frameId, generation, sentAtMs:performance.now(), captureTimestampMs,
    modulation:activeReceiverModulation, quad:receiverQuad, profile:receiverProfile,
    minSeparation:intValue($('recv-separation')), cameraSettings:settings
  },[frame]);
}
async function processorLoop() {
  while (receiverRunning && processorReader) {
    const {value:frame,done}=await processorReader.read();
    if(done||!frame) break;
    postVideoFrame(frame);
  }
}

let fallbackCanvas, fallbackCtx;
function fallbackDecodeLoop(now,metadata) {
  if(!receiverRunning) return;
  video.requestVideoFrameCallback(fallbackDecodeLoop);
  if(!receiverQuad||!receiverProfile||workerBusy) { if(workerBusy&&receiverProfile)droppedBusy++; return; }
  const width=video.videoWidth,height=video.videoHeight;
  if(!width||!height)return;
  if(!fallbackCanvas){fallbackCanvas=document.createElement('canvas');fallbackCtx=fallbackCanvas.getContext('2d',{willReadFrequently:true});}
  if(fallbackCanvas.width!==width||fallbackCanvas.height!==height){fallbackCanvas.width=width;fallbackCanvas.height=height;}
  const started=performance.now();
  fallbackCtx.drawImage(video,0,0,width,height);
  const y8=rgbaToY8(fallbackCtx.getImageData(0,0,width,height).data,width,height);
  const copyMs=performance.now()-started;
  workerBusy=true;
  decodeWorker.postMessage({
    action:'decode',y8:y8.buffer,width,height,copyMs,copyPath:'canvas-rgba',frameId:++frameId,generation,sentAtMs:performance.now(),
    captureTimestampMs:Number.isFinite(metadata?.mediaTime)?metadata.mediaTime*1000:performance.now(),modulation:activeReceiverModulation,
    quad:receiverQuad,profile:receiverProfile,minSeparation:intValue($('recv-separation'))
  },[y8.buffer]);
}

async function startCamera() {
  await stopCamera();
  const [width,height]=$('cam-res').value.split('x').map(Number);
  const fps=intValue($('cam-fps'));
  setReceiverStatus('Starting camera…','warn');
  mediaStream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:width},height:{ideal:height},frameRate:{ideal:fps,max:fps}}});
  mediaTrack=mediaStream.getVideoTracks()[0];
  video.srcObject=mediaStream;
  await video.play();
  receiverRunning=true; workerBusy=false; generation++;
  acquisitionScans=0; acquisitionHits=0; lastAcquisitionScanAt=0;
  receiverQuad=null;receiverProfile=null;acquiredConfig=null;lastLockAt=0;
  resetRun();enableReceiverButtons(true);$('camera-start').disabled=true;
  const settings=cachedTrackSettings();
  const actual=`${video.videoWidth}×${video.videoHeight} @ ${Number(settings.frameRate||0).toFixed(1)} fps`;
  setReceiverStatus(`Camera ${actual}. Searching automatically—keep the whole sender screen visible.`,'warn');
  if(video.requestVideoFrameCallback) video.requestVideoFrameCallback(acquisitionVideoLoop);
  else acquisitionTimer=setInterval(scanForAcquisition,80);
  if(globalThis.MediaStreamTrackProcessor){
    const processor=new MediaStreamTrackProcessor({track:mediaTrack});
    processorReader=processor.readable.getReader();
    processorLoop().catch(error=>setReceiverStatus(`Processor failed: ${error.message}`,'bad'));
  } else if(video.requestVideoFrameCallback) {
    video.requestVideoFrameCallback(fallbackDecodeLoop);
  } else throw new Error('Browser has neither MediaStreamTrackProcessor nor requestVideoFrameCallback');
}
async function stopCamera() {
  receiverRunning=false;generation++;
  clearInterval(acquisitionTimer);acquisitionTimer=0;
  try{await processorReader?.cancel();}catch{}
  processorReader=null;
  for(const track of mediaStream?.getTracks?.()??[])track.stop();
  mediaStream=null;mediaTrack=null;video.srcObject=null;workerBusy=false;
  receiverQuad=null;receiverProfile=null;acquiredConfig=null;
  enableReceiverButtons(false);$('camera-start').disabled=false;
  setReceiverStatus('Camera stopped.');drawReceiverOverlay();updateReceiverMetrics();
}
$('camera-start').onclick=()=>startCamera().catch(error=>{setReceiverStatus(error.message,'bad');stopCamera();});
$('camera-stop').onclick=()=>stopCamera();

function setMetric(id,text,className=''){const el=$(id);el.textContent=text;el.className=className;}
function updateReceiverMetrics(){
  const locked=Boolean(receiverProfile&&receiverQuad);
  setMetric('m-lock',locked?'LOCKED':'SEARCHING',locked?'good':'warn');
  const s=lastSnapshot;
  if(!s){
    for(const [id,text] of [['m-goodput','0.00 MB/s'],['m-floor','0%'],['m-target','0%'],['m-camfps','0 fps'],['m-valid','0%'],['m-pxcell','—'],['m-snr','—'],['m-sep','—'],['m-readout','— ms'],['m-cpu','—%'],['m-copy','— ms']])setMetric(id,text);
    setMetric('m-drop',String(droppedBusy));
    $('receiver-details').textContent=locked?`profile acquired; waiting for decoded data\nacquisition scans ${acquisitionScans} · hits ${acquisitionHits}`:'';
    return;
  }
  const good=s.goodput.bytesPerSecond;
  setMetric('m-goodput',mbps(good),good>AIRGRID_TARGET_BPS?'good':good>QR_FLOOR_BPS?'warn':'bad');
  setMetric('m-floor',`${(good/QR_FLOOR_BPS*100).toFixed(0)}%`,good>QR_FLOOR_BPS?'good':'bad');
  setMetric('m-target',`${(good/AIRGRID_TARGET_BPS*100).toFixed(0)}%`,good>AIRGRID_TARGET_BPS?'good':'warn');
  setMetric('m-camfps',`${s.capture.fps.toFixed(1)} fps`);
  setMetric('m-valid',percent(s.channel.validLaneRate),s.channel.validLaneRate>.85?'good':s.channel.validLaneRate>.5?'warn':'bad');
  const frame=lastFrameDiagnostics?.frame;
  setMetric('m-pxcell',frame?`${frame.pxPerCellX.toFixed(2)}×${frame.pxPerCellY.toFixed(2)}`:'—');
  setMetric('m-snr',s.channel.snrP10.toFixed(1));setMetric('m-sep',s.channel.separationP10.toFixed(1));
  const readout=s.rollingShutter.sensorReadoutMs||s.rollingShutter.inferredReadoutMs;
  setMetric('m-readout',`${readout.toFixed(2)} ms`);
  setMetric('m-cpu',`${(s.cpu.frameBudgetUsedP95*100).toFixed(0)}%`,s.cpu.frameBudgetUsedP95>.8?'bad':'good');
  setMetric('m-copy',`${s.cpu.copyP50Ms.toFixed(2)} ms`);setMetric('m-drop',String(droppedBusy),droppedBusy?'warn':'good');
  const failures=lastFrameDiagnostics?.decode?.failures??{};const optics=lastFrameDiagnostics?.optics??{};const settings=receiverSettings;
  const pam4=activeReceiverModulation==='pam4'?`PAM4 centers p50: ${(optics.clusterCentersP50??[]).map(v=>Number(v).toFixed(1)).join(' / ')} · EVM p90 ${Number(optics.evmP90??0).toFixed(3)}`:'';
  $('receiver-details').textContent=[
    formatAirGridDiagnostics(s),
    `auto profile: ${activeReceiverModulation} ${receiverProfile.columns}×${receiverProfile.lanes} · sender ${acquiredConfig?.senderHz??0} Hz`,
    pam4,
    `failures/frame: ${Object.entries(failures).map(([k,v])=>`${k}=${v}`).join(' ')}`,
    `sequences latest capture: ${(lastFrameDiagnostics?.rollingShutter?.sequences??[]).join(', ')||'none'}`,
    `camera: ${JSON.stringify({width:settings.width,height:settings.height,frameRate:settings.frameRate,exposureTime:settings.exposureTime,iso:settings.iso,focusDistance:settings.focusDistance})}`,
    `acquisition scans ${acquisitionScans} · hits ${acquisitionHits} · worker drops ${droppedBusy} · decoded frames ${decodedFrames}`
  ].filter(Boolean).join('\n');
}

decodeWorker.onmessage=event=>{
  const data=event.data;
  workerBusy=false;
  if(data.generation!==generation)return;
  if(data.type==='error'){setReceiverStatus(`Decode worker: ${data.error}`,'bad');return;}
  decodedFrames++;lastFrameDiagnostics=data.diagnostics;
  const settings=cachedTrackSettings();
  lastSnapshot=monitor.observe({
    diagnostics:data.diagnostics,captureTimestampMs:data.captureTimestampMs,copyMs:data.copyMs,queueMs:data.queueMs,
    exposureUs:Number(settings.exposureTime),iso:Number(settings.iso),frameDurationUs:Number(settings.frameRate)>0?1e6/Number(settings.frameRate):undefined,
    senderHz:acquiredConfig?.senderHz
  });
  if(runFrames.length<1800)runFrames.push({
    tMs:performance.now()-runStartedAt,modulation:data.modulation,goodputBps:lastSnapshot.goodput.bytesPerSecond,
    validLaneRate:data.diagnostics.decode.validLaneRate,crcValidLanes:data.diagnostics.decode.crcValidLanes,patternMismatches:data.diagnostics.decode.patternMismatches,
    bytesDecoded:data.diagnostics.decode.bytesDecoded,failures:data.diagnostics.decode.failures,separationP10:data.diagnostics.optics.separationP10,
    snrP10:data.diagnostics.optics.snrP10,evmP90:data.diagnostics.optics.evmP90,clusterCentersP50:data.diagnostics.optics.clusterCentersP50,
    pxPerCellX:data.diagnostics.frame.pxPerCellX,pxPerCellY:data.diagnostics.frame.pxPerCellY,sequences:data.diagnostics.rollingShutter.sequences,
    copyMs:data.copyMs,decodeMs:data.decodeWallMs,copyPath:data.copyPath
  });
  updateReceiverMetrics();
};
decodeWorker.onerror=event=>{workerBusy=false;setReceiverStatus(`Worker crashed: ${event.message}`,'bad');};

$('export-run').onclick=()=>{
  const exportData={
    exportedAt:new Date().toISOString(),userAgent:navigator.userAgent,qrBaselineBytesPerSecond:QR_FLOOR_BPS,airGridTargetBytesPerSecond:AIRGRID_TARGET_BPS,
    acquisition:{config:acquiredConfig,scans:acquisitionScans,hits:acquisitionHits,lastLockAtMs:lastLockAt,quad:receiverQuad},
    senderProfile:receiverProfile,cameraRequested:{resolution:$('cam-res').value,fps:intValue($('cam-fps'))},cameraSettings:receiverSettings,
    workerBusyDrops:droppedBusy,decodedFrames,summary:lastSnapshot,frames:runFrames
  };
  const blob=new Blob([JSON.stringify(exportData,null,2)],{type:'application/json'});const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);a.download=`airgrid-hardware-${Date.now()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
};

window.addEventListener('beforeunload',()=>{try{decodeWorker.terminate();}catch{} stopCamera();});
