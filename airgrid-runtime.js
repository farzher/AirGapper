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
import {
  applyAirGridManualOptics,
  applyAirGridShortExposure,
  exposureMs,
  formatAirGridOpticsSettings,
  probeAirGridCameraOptics,
  restoreAirGridAutoExposure
} from './shared/airgrid-camera-optics.js';
import { AirGridRasterRenderer } from './send/airgrid-renderer.js';

const BUILD = 'AGRS-20260823-1440';
const PAYLOAD_ID = 0x51a7c0de;
const QR_BURST_EVERY_MS = 3000;
const QR_BURST_MS = 650;
const SHORT_EXPOSURE_TARGET = 25; // exposureTime is 0.1 ms units => 2.5 ms
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

// Sender --------------------------------------------------------------------
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
  return { width:Math.max(1,Math.round(innerWidth*dpr)), height:Math.max(1,Math.round(innerHeight*dpr)), dpr };
}
function selectedPitch() { return Math.max(1.5, Number($('pitch').value) || 3); }
function selectedSenderHz() { return Math.max(1, Math.round(Number($('sender-hz').value) || 30)); }
function qrSvg(text) {
  const qr = QRCode.create(text, { errorCorrectionLevel:'M' });
  const n = qr.modules.size, quiet = 4, logical = n + quiet * 2;
  let path = '';
  for (let y=0;y<n;y++) for (let x=0;x<n;x++) if (qr.modules.data[y*n+x]) path += `M${x+quiet} ${y+quiet}h1v1h-1z`;
  return `<svg viewBox="0 0 ${logical} ${logical}" xmlns="http://www.w3.org/2000/svg"><rect width="${logical}" height="${logical}" fill="white"/><path d="${path}" fill="black"/></svg>`;
}
function configureSender() {
  const { width,height,dpr } = displayPixels();
  const profile = airGridBlockProfile({ projectedWidth:width, projectedHeight:height, cellPx:selectedPitch() });
  if (!profile) throw new Error('AirGrid block profile is invalid');
  senderProfile = profile;
  senderConfig = { modulation:'binary', columns:profile.columns, lanes:profile.lanes, senderHz:selectedSenderHz(), payloadId:PAYLOAD_ID };
  for (const corner of AIRGRID_QR_ORDER) $(`qr-${corner}`).innerHTML = qrSvg(encodeAirGridQrAcquisition(senderConfig,corner));
  if (!AIRGRID_QR_ORDER.every(c=>$(`qr-${c}`).querySelector('svg'))) throw new Error('QR render failed');
  dataCanvas.width = width; dataCanvas.height = height;
  const ceiling = profile.capacityBytes * 30;
  $('sender-center-info').innerHTML = [BUILD,`DISPLAY ${width}×${height} px · DPR ${dpr}`,`BLOCK PHY ${profile.columns}×${profile.lanes} · ${profile.blocksPerLane} blocks/row`,`${profile.payloadBytesPerLane} payload B/row`,`30 FPS CEILING ${mbps(ceiling)}`,'WAIT FOR PHONE: LOCKED','THEN CLICK OR PRESS SPACE'].join('<br>');
  $('sender-status').textContent = `READY · ${BUILD} · ${profile.columns}×${profile.lanes} · ${profile.blocksPerLane} blocks/row · ${mbps(ceiling)} ceiling @ 30 fps`;
}
function renderData(sequence) {
  const state = buildAirGridBlockState({ profile:senderProfile, payloadId:PAYLOAD_ID, sequence });
  rasterRenderer.render(dataCtx,state,dataCanvas.width,dataCanvas.height);
}
function showLayer(qr) { showingQr=qr; acqLayer.classList.toggle('hidden',!qr); dataLayer.classList.toggle('hidden',qr); }
function qrBurstDue(now) { return senderDataMode && now-dataStartedAt>=1200 && ((now-dataStartedAt)%QR_BURST_EVERY_MS)<QR_BURST_MS; }
function senderTick(now) {
  if (!senderRunning||!senderDataMode) return;
  senderRaf=requestAnimationFrame(senderTick);
  const burst=qrBurstDue(now); if (burst!==showingQr) showLayer(burst); if (burst) return;
  const hz=selectedSenderHz(), period=1000/hz; if (now+0.2<nextDataDue) return;
  const skipped=Math.max(1,Math.floor((now-nextDataDue)/period)+1); nextDataDue+=skipped*period; senderSequence=(senderSequence+skipped)&0x0fff;
  try { renderData(senderSequence); } catch(error) { showAcquisition(`DATA ERROR: ${error.message||error}`); }
}
function showAcquisition(message='') { senderDataMode=false; cancelAnimationFrame(senderRaf); showLayer(true); configureSender(); if(message)$('sender-center-info').innerHTML+=`<br><br>${message}`; }
function startData() {
  if (!senderRunning||senderDataMode||!senderProfile) return;
  try {
    const {width,height}=displayPixels(); const next=airGridBlockProfile({projectedWidth:width,projectedHeight:height,cellPx:selectedPitch()});
    if(!next||next.columns!==senderProfile.columns||next.lanes!==senderProfile.lanes){configureSender();$('sender-center-info').innerHTML+='<br><br>DISPLAY CHANGED · RE-LOCK · CLICK AGAIN';return;}
    senderSequence=0; renderData(0); senderDataMode=true; dataStartedAt=performance.now(); nextDataDue=dataStartedAt+1000/selectedSenderHz(); showLayer(false); senderRaf=requestAnimationFrame(senderTick);
  } catch(error) { showAcquisition(`DATA START ERROR: ${error.message||error}`); }
}
$('start-sender').onclick=async()=>{
  try { sender.classList.add('active'); senderRunning=true; senderDataMode=false; showLayer(true); configureSender(); void sender.offsetWidth; try{await sender.requestFullscreen?.({navigationUI:'hide'});}catch{} await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))); configureSender(); }
  catch(error){senderRunning=false;sender.classList.remove('active');$('sender-status').textContent=`SENDER ERROR · ${BUILD} · ${error.message||error}`;}
};
sender.addEventListener('click',e=>{if(!senderRunning||senderDataMode)return;e.preventDefault();startData();});
document.addEventListener('keydown',e=>{if(!senderRunning)return;if(e.code==='Space'||e.key==='Enter'){e.preventDefault();startData();}else if(e.key.toLowerCase()==='r'){e.preventDefault();showAcquisition();}});
document.addEventListener('fullscreenchange',()=>{if(!document.fullscreenElement&&senderRunning){senderRunning=false;senderDataMode=false;cancelAnimationFrame(senderRaf);sender.classList.remove('active');}});

// Receiver: one proven VideoFrame path for BOTH QR and DATA -----------------
const video=$('video');
const overlay=$('overlay');
const overlayCtx=overlay.getContext('2d');
const qrWorker=new Worker(new URL('./receive/worker.js?airgrid-acq=1440',import.meta.url),{type:'module'});
const dataWorker=new Worker(new URL('./receive/airgrid-worker.js?build=1440',import.meta.url),{type:'module'});
let mediaStream=null,cameraTrack=null,receiverRunning=false,workerReady=false,qrBusy=false,dataBusy=false;
let scanId=0,lastQrScanAt=0,lastQrFrameWidth=0,lastQrFrameHeight=0;
let seen=new Map(),lockedQuad=null,lockedConfig=null,lockedProfile=null,lockFrameWidth=0,lockFrameHeight=0;
let generation=1,frameId=0,lastLockAt=0,lastGoodDataAt=0,firstDataResultAt=0,lastUiAt=0,lastDiagnostics=null,lastDataError='';
let staleCount=0,geometryRefreshes=0,cameraCallbacks=0,qrFramesSent=0,qrResults=0,qrSymbols=0,dataFramesSent=0,dataResults=0,dataWorkerErrors=0,droppedBusy=0;
let captureTimes=[];
let opticsProbe=null,opticsBusy=false,opticsMessage='';
const goodEvents=[],seenUnits=new Map();

function setStatus(text,cls=''){$('status').textContent=text;$('status').className=`status ${cls}`;}
function centerOfQuad(q){const p=[q?.topLeft,q?.topRight,q?.bottomRight,q?.bottomLeft].filter(Boolean);return p.length===4?{x:p.reduce((s,v)=>s+v.x,0)/4,y:p.reduce((s,v)=>s+v.y,0)/4}:null;}
function smoothPoint(a,b,t=.55){return a?{x:a.x*(1-t)+b.x*t,y:a.y*(1-t)+b.y*t}:b;}
function smoothQuad(a,b,t=.55){return a?{topLeft:smoothPoint(a.topLeft,b.topLeft,t),topRight:smoothPoint(a.topRight,b.topRight,t),bottomRight:smoothPoint(a.bottomRight,b.bottomRight,t),bottomLeft:smoothPoint(a.bottomLeft,b.bottomLeft,t)}:b;}
function sameConfig(o){if(o.length!==4)return null;const k=airGridQrConfigKey(o[0].config);return o.every(v=>airGridQrConfigKey(v.config)===k)?o[0].config:null;}
function scaleQuad(q,sx,sy){const p=v=>({x:v.x*sx,y:v.y*sy});return{topLeft:p(q.topLeft),topRight:p(q.topRight),bottomRight:p(q.bottomRight),bottomLeft:p(q.bottomLeft)};}
function resetMetrics(){lastGoodDataAt=0;firstDataResultAt=0;lastDiagnostics=null;lastDataError='';goodEvents.length=0;seenUnits.clear();captureTimes=[];droppedBusy=0;}
function noteVerifiedUnits(units,now){let bytes=0;for(const u of units??[]){if(!u.verified)continue;const k=`${u.sequence}:${u.laneIndex}:${u.blockIndex??0}`;if(seenUnits.has(k))continue;seenUnits.set(k,now);bytes+=Number(u.payloadBytes)||0;}if(bytes){lastGoodDataAt=now;goodEvents.push({t:now,bytes});}for(const[k,t]of seenUnits)if(now-t>5000)seenUnits.delete(k);while(goodEvents.length&&now-goodEvents[0].t>1000)goodEvents.shift();}
function currentGoodput(now=performance.now()){while(goodEvents.length&&now-goodEvents[0].t>1000)goodEvents.shift();return goodEvents.reduce((s,e)=>s+e.bytes,0);}
function currentCaptureFps(now=performance.now()){captureTimes=captureTimes.filter(t=>now-t<1000);return captureTimes.length<2?0:(captureTimes.length-1)*1000/Math.max(1,captureTimes.at(-1)-captureTimes[0]);}
function markStale(reason){if(!lockedQuad)return;lockedQuad=null;lastLockAt=0;seen.clear();staleCount++;generation++;firstDataResultAt=0;setStatus(`REACQUIRING · ${BUILD} · ${reason}`,'warn');drawOverlay();updateUi(true);}
function tryLock(){
  const now=performance.now();for(const[c,o]of seen)if(now-o.at>1500)seen.delete(c);const obs=AIRGRID_QR_ORDER.map(c=>seen.get(c)).filter(Boolean);const config=sameConfig(obs);if(!config)return false;
  const h=homographyFromCorrespondences(AIRGRID_QR_ORDER.map(c=>AIRGRID_QR_CENTERS[c]),AIRGRID_QR_ORDER.map(c=>seen.get(c).center));if(!h)return false;
  const profile=airGridBlockProfileFromGrid(config.columns,config.lanes);if(!profile)return false;
  const q={topLeft:projectAirGridAcquisition(h,0,0),topRight:projectAirGridAcquisition(h,1,0),bottomRight:projectAirGridAcquisition(h,1,1),bottomLeft:projectAirGridAcquisition(h,0,1)};
  const changed=!lockedConfig||airGridQrConfigKey(config)!==airGridQrConfigKey(lockedConfig);lockedQuad=changed?q:smoothQuad(lockedQuad,q);lockedConfig=config;lockedProfile=profile;lockFrameWidth=obs[0].frameWidth;lockFrameHeight=obs[0].frameHeight;lastLockAt=now;geometryRefreshes++;
  if(changed){generation++;resetMetrics();}setStatus(`LOCKED · ${BUILD} · geometry ${geometryRefreshes}`,'good');drawOverlay();updateUi(true);return true;
}
function drawOverlay(){const r=overlay.getBoundingClientRect(),dpr=devicePixelRatio||1,w=Math.max(1,Math.round(r.width*dpr)),h=Math.max(1,Math.round(r.height*dpr));if(overlay.width!==w||overlay.height!==h){overlay.width=w;overlay.height=h;}overlayCtx.clearRect(0,0,w,h);if(!lockedQuad||!lockFrameWidth||!lockFrameHeight||!video.videoWidth)return;const vr=video.getBoundingClientRect(),or=overlay.getBoundingClientRect(),map=p=>({x:(vr.left-or.left+p.x/lockFrameWidth*vr.width)*dpr,y:(vr.top-or.top+p.y/lockFrameHeight*vr.height)*dpr}),pts=[lockedQuad.topLeft,lockedQuad.topRight,lockedQuad.bottomRight,lockedQuad.bottomLeft].map(map);overlayCtx.strokeStyle='#72ff91';overlayCtx.lineWidth=2*dpr;overlayCtx.beginPath();overlayCtx.moveTo(pts[0].x,pts[0].y);for(let i=1;i<4;i++)overlayCtx.lineTo(pts[i].x,pts[i].y);overlayCtx.closePath();overlayCtx.stroke();}
window.addEventListener('resize',drawOverlay);

function rangeSetup(input,range,value){if(!input||!range)return;input.min=String(range.min);input.max=String(range.max);input.step=String(Number.isFinite(Number(range.step))&&Number(range.step)>0?range.step:1);input.value=String(Math.max(range.min,Math.min(range.max,Number(value) || range.min)));}
function updateOpticsLabels(){const exp=Number($('exposure')?.value),iso=Number($('iso')?.value);if($('exposure-value'))$('exposure-value').textContent=Number.isFinite(exp)?`${exposureMs(exp).toFixed(1)} ms`:'—';if($('iso-value'))$('iso-value').textContent=Number.isFinite(iso)?String(Math.round(iso)):'—';}
function actualOpticsText(){return cameraTrack?formatAirGridOpticsSettings(cameraTrack.getSettings?.()??{}):'camera stopped';}
function setOpticsMessage(message,cls='') { opticsMessage=message; const el=$('optics-status'); if(el){el.textContent=message;el.className=`status ${cls}`;} }
function configureOpticsUi(){
  if(!cameraTrack)return;
  opticsProbe=probeAirGridCameraOptics(cameraTrack);$('optics').classList.remove('hidden');
  const settings=cameraTrack.getSettings?.()??{};
  $('exposure-control').classList.toggle('hidden',!opticsProbe.exposureTime);
  $('iso-control').classList.toggle('hidden',!opticsProbe.iso);
  if(opticsProbe.exposureTime)rangeSetup($('exposure'),opticsProbe.exposureTime,settings.exposureTime??SHORT_EXPOSURE_TARGET);
  if(opticsProbe.iso)rangeSetup($('iso'),opticsProbe.iso,settings.iso??opticsProbe.iso.min);
  $('optics-short').disabled=!opticsProbe.manualExposure;
  updateOpticsLabels();
  if(opticsProbe.manualExposure)setOpticsMessage(`Manual sensor available · actual ${actualOpticsText()}`,'good');
  else setOpticsMessage(`Manual exposure is NOT exposed by this browser/camera · actual ${actualOpticsText()}`,'bad');
}
async function applyOpticsResult(promise,label){
  if(!cameraTrack||opticsBusy)return;
  opticsBusy=true;$('optics-short').disabled=true;$('optics-auto').disabled=true;
  try{
    setOpticsMessage(`${label}…`,'warn');
    const result=await promise;
    configureOpticsUi();
    const actual=formatAirGridOpticsSettings(result?.settings??cameraTrack.getSettings?.()??{});
    setOpticsMessage(result?.ok?`${label} accepted · ${actual}`:`${label} FAILED · ${result?.reason||'rejected'} · actual ${actual}`,result?.ok?'good':'bad');
  }catch(error){setOpticsMessage(`${label} ERROR · ${error.message||error}`,'bad');}
  finally{opticsBusy=false;$('optics-auto').disabled=false;$('optics-short').disabled=!opticsProbe?.manualExposure;updateUi(true);}
}
async function autoShortExposure(){if(!cameraTrack)return;await applyOpticsResult(applyAirGridShortExposure(cameraTrack,SHORT_EXPOSURE_TARGET),'Short exposure');}
async function manualOpticsFromUi(){if(!cameraTrack||!opticsProbe?.manualExposure)return;await applyOpticsResult(applyAirGridManualOptics(cameraTrack,{exposureTime:Number($('exposure').value),iso:opticsProbe.iso?Number($('iso').value):undefined}),'Manual optics');}
$('optics-short').onclick=()=>autoShortExposure();
$('optics-auto').onclick=()=>cameraTrack&&applyOpticsResult(restoreAirGridAutoExposure(cameraTrack),'Camera auto');
$('exposure').addEventListener('input',updateOpticsLabels);$('iso').addEventListener('input',updateOpticsLabels);
$('exposure').addEventListener('change',()=>manualOpticsFromUi());$('iso').addEventListener('change',()=>manualOpticsFromUi());

qrWorker.onmessage=e=>{const d=e.data??{};if(d.id===-1){workerReady=true;updateUi(true);return;}if(d.id!==scanId)return;qrBusy=false;qrResults++;const symbols=Array.isArray(d.symbols)?d.symbols:[];qrSymbols+=symbols.length;const now=performance.now();for(const s of symbols){if(!s?.bytes||!s?.quad)continue;let raw='';try{raw=decoder.decode(s.bytes instanceof Uint8Array?s.bytes:Uint8Array.from(s.bytes));}catch{}const parsed=parseAirGridQrAcquisition(raw),center=parsed?centerOfQuad(s.quad):null;if(parsed&&center)seen.set(parsed.corner,{config:parsed,center,at:now,frameWidth:lastQrFrameWidth||video.videoWidth,frameHeight:lastQrFrameHeight||video.videoHeight});}if(!tryLock()&&!lockedQuad){const corners=AIRGRID_QR_ORDER.filter(c=>seen.has(c));setStatus(`SEARCHING · ${BUILD} · QR ${corners.length}/4`,'warn');}updateUi();};
qrWorker.onerror=e=>{qrBusy=false;setStatus(`QR WORKER ERROR · ${e.message}`,'bad');};
dataWorker.onmessage=e=>{const d=e.data??{};dataBusy=false;if(d.generation!==generation)return;dataResults++;if(d.type==='error'){dataWorkerErrors++;lastDataError=d.error||'decode error';updateUi(true);return;}const now=performance.now();if(!firstDataResultAt)firstDataResultAt=now;lastDiagnostics=d;noteVerifiedUnits(d.lanes,now);const valid=Number(d.diagnostics?.decode?.validLanes||0);if(!valid&&now-firstDataResultAt>1800&&(!lastGoodDataAt||now-lastGoodDataAt>1800))markStale('DATA reaches worker; 0 verified blocks');updateUi();};
dataWorker.onerror=e=>{dataBusy=false;dataWorkerErrors++;lastDataError=`worker crash: ${e.message}`;updateUi(true);};

function sendQrFrame(now){let f;try{f=new VideoFrame(video,{timestamp:Math.round(now*1000)});}catch(error){lastDataError=`VideoFrame QR: ${error.message}`;return false;}const w=f.codedWidth||f.displayWidth||video.videoWidth,h=f.codedHeight||f.displayHeight||video.videoHeight;lastQrFrameWidth=w;lastQrFrameHeight=h;qrBusy=true;qrFramesSent++;scanId++;lastQrScanAt=now;qrWorker.postMessage({id:scanId,videoFrame:f,cropX:0,cropY:0,w,h,full:true,pixelFormat:'y8',acquisitionMode:'hunt',sentAt:now},[f]);return true;}
function sendDataFrame(now){if(!lockedQuad||!lockedProfile||dataBusy)return false;let f;try{f=new VideoFrame(video,{timestamp:Math.round(now*1000)});}catch(error){lastDataError=`VideoFrame DATA: ${error.message}`;return false;}const w=f.codedWidth||f.displayWidth||video.videoWidth,h=f.codedHeight||f.displayHeight||video.videoHeight,q=(lockFrameWidth&&lockFrameHeight&&(w!==lockFrameWidth||h!==lockFrameHeight))?scaleQuad(lockedQuad,w/lockFrameWidth,h/lockFrameHeight):lockedQuad;dataBusy=true;dataFramesSent++;captureTimes.push(now);dataWorker.postMessage({action:'decode',frame:f,frameId:++frameId,generation,sentAtMs:now,captureTimestampMs:Number.isFinite(Number(f.timestamp))?Number(f.timestamp)/1000:now,modulation:'binary',quad:q,profile:lockedProfile,payloadId:lockedConfig?.payloadId??PAYLOAD_ID,minSeparation:12},[f]);return true;}
function cameraLoop(now){if(!receiverRunning)return;video.requestVideoFrameCallback(cameraLoop);cameraCallbacks++;if(!video.videoWidth)return;const healthy=lastGoodDataAt&&now-lastGoodDataAt<1000,qrInterval=!lockedQuad?120:healthy?300:120;if(workerReady&&!qrBusy&&now-lastQrScanAt>=qrInterval)sendQrFrame(now);else if(lockedQuad){if(!sendDataFrame(now)&&dataBusy)droppedBusy++;}updateUi();}
function updateUi(force=false){const now=performance.now();if(!force&&now-lastUiAt<180)return;lastUiAt=now;const locked=Boolean(lockedQuad&&lockedProfile);$('m-lock').textContent=locked?'LOCKED':'SEARCHING';$('m-lock').className=locked?'good':'warn';const good=currentGoodput(now);$('m-goodput').textContent=mbps(good);$('m-goodput').className=good>=2500000?'good':good>=2000000?'warn':'';const ceiling=lockedProfile?lockedProfile.capacityBytes*30:0;$('m-ceiling').textContent=lockedProfile?mbps(ceiling):'—';const d=lastDiagnostics?.diagnostics;$('m-valid').textContent=d?`${(d.decode.validLaneRate*100).toFixed(1)}%`:'0%';$('m-fps').textContent=`${currentCaptureFps(now).toFixed(1)} fps`;$('m-pxcell').textContent=d?`${d.frame.pxPerCellX.toFixed(2)}×${d.frame.pxPerCellY.toFixed(2)}`:'—';$('m-decode').textContent=lastDiagnostics?`${Number(lastDiagnostics.decodeWallMs||0).toFixed(1)} ms`:'— ms';$('m-drop').textContent=String(droppedBusy);const failures=d?.decode?.failures??{};$('details').textContent=[BUILD,`optics ${actualOpticsText()}${opticsMessage?` · ${opticsMessage}`:''}`,`pipeline camera=${cameraCallbacks} · QR sent=${qrFramesSent} results=${qrResults} symbols=${qrSymbols} · DATA sent=${dataFramesSent} results=${dataResults} errors=${dataWorkerErrors}`,`geometry refreshes=${geometryRefreshes} · stale/reacquire=${staleCount} · lock age=${lastLockAt?(now-lastLockAt).toFixed(0):'—'} ms`,lockedConfig?`profile ${lockedConfig.columns}×${lockedConfig.lanes} · ${lockedProfile.blocksPerLane} blocks/row · ${lockedProfile.payloadBytesPerLane} B/row`:'',d?`local phase ${Number(d.frame.phaseX||0).toFixed(1)},${Number(d.frame.phaseY||0).toFixed(1)} px · camera ${d.frame.pxPerCellX.toFixed(2)}×${d.frame.pxPerCellY.toFixed(2)} px/cell`:'',d?`CRC-valid ${d.decode.crcValidLanes}/${d.decode.totalLanes} · byte-exact ${d.decode.validLanes}/${d.decode.totalLanes}`:'waiting for DATA worker result',d?`failures ${Object.entries(failures).map(([k,v])=>`${k}=${v}`).join(' ')}`:'',lastDataError?`DATA ERROR ${lastDataError}`:''].filter(Boolean).join('\n');}

async function stopCamera(){receiverRunning=false;generation++;qrBusy=false;dataBusy=false;for(const t of mediaStream?.getTracks?.()??[])t.stop();mediaStream=null;cameraTrack=null;video.srcObject=null;$('start-camera').disabled=false;$('stop-camera').disabled=true;$('optics').classList.add('hidden');drawOverlay();}
async function startCamera(){await stopCamera();setStatus(`Starting camera · ${BUILD}`,'warn');mediaStream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:2560},height:{ideal:1440},frameRate:{ideal:30,max:30}}});cameraTrack=mediaStream.getVideoTracks()[0]??null;video.srcObject=mediaStream;await video.play();receiverRunning=true;qrBusy=false;dataBusy=false;seen.clear();lockedQuad=lockedConfig=lockedProfile=null;lockFrameWidth=lockFrameHeight=lastQrFrameWidth=lastQrFrameHeight=0;lastLockAt=lastGoodDataAt=firstDataResultAt=0;cameraCallbacks=qrFramesSent=qrResults=qrSymbols=dataFramesSent=dataResults=dataWorkerErrors=droppedBusy=0;geometryRefreshes=staleCount=0;lastQrScanAt=0;resetMetrics();$('start-camera').disabled=true;$('stop-camera').disabled=false;setStatus(`SEARCHING · ${BUILD} · camera ${video.videoWidth}×${video.videoHeight}`,'warn');configureOpticsUi();if(opticsProbe?.manualExposure)await autoShortExposure();updateUi(true);if(video.requestVideoFrameCallback)video.requestVideoFrameCallback(cameraLoop);else setStatus(`ERROR · ${BUILD} · requestVideoFrameCallback unavailable`,'bad');}
$('start-camera').onclick=()=>startCamera().catch(error=>setStatus(`CAMERA ERROR · ${BUILD} · ${error.message}`,'bad'));
$('stop-camera').onclick=()=>stopCamera();
window.addEventListener('beforeunload',()=>{try{qrWorker.terminate();dataWorker.terminate();}catch{}stopCamera();});