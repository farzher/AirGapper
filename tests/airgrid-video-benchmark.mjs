import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args=process.argv.slice(2),videoArg=args.find(x=>!x.startsWith('--'));
if(!videoArg){
  console.error('Usage: node tests/airgrid-video-benchmark.mjs <phone-video.webm> [--sample-fps=5] [--pipeline=i420|canvas] [--detector=768] [--output=dir]');
  process.exit(2);
}
const option=(name,fallback)=>args.find(x=>x.startsWith(`--${name}=`))?.slice(name.length+3)??fallback;
const videoPath=resolve(videoArg),sampleFps=Math.max(.5,Math.min(30,+option('sample-fps',5)||5)),pipeline=option('pipeline','i420'),detector=Math.max(480,Math.min(900,+option('detector',768)||768));
if(!existsSync(videoPath))throw new Error(`Video not found: ${videoPath}`);
if(!['i420','canvas'].includes(pipeline))throw new Error(`Unsupported pipeline: ${pipeline}`);
const testsDir=dirname(fileURLToPath(import.meta.url)),root=resolve(testsDir,'..'),stem=basename(videoPath,extname(videoPath));
const outputDir=resolve(option('output',join(dirname(videoPath),`${stem}-airgrid-analysis`)));
await mkdir(outputDir,{recursive:true});
const videoStat=await stat(videoPath),html=Buffer.from('<!doctype html><meta charset="utf-8"><title>AirGrid video replay</title><script src="/airgrid-x1.js"></script>');

function sendVideo(req,res){
  const size=videoStat.size,range=req.headers.range;
  res.setHeader('accept-ranges','bytes');
  res.setHeader('content-type',extname(videoPath).toLowerCase()==='.mp4'?'video/mp4':'video/webm');
  res.setHeader('cache-control','no-store');
  if(range){
    const match=/bytes=(\d*)-(\d*)/.exec(range);
    if(!match){res.writeHead(416,{'content-range':`bytes */${size}`});res.end();return;}
    const start=match[1]?+match[1]:0,end=Math.min(size-1,match[2]?+match[2]:size-1);
    if(start>end||start>=size){res.writeHead(416,{'content-range':`bytes */${size}`});res.end();return;}
    res.writeHead(206,{'content-range':`bytes ${start}-${end}/${size}`,'content-length':end-start+1});
    if(req.method==='HEAD')res.end();else createReadStream(videoPath,{start,end}).pipe(res);
  }else{
    res.writeHead(200,{'content-length':size});
    if(req.method==='HEAD')res.end();else createReadStream(videoPath).pipe(res);
  }
}
const server=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url||'/','http://localhost');
    if(url.pathname==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});res.end(html);return;}
    if(url.pathname==='/airgrid-x1.js'){const body=await readFile(join(root,'airgrid-x1.js'));res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store','content-length':body.length});res.end(body);return;}
    if(url.pathname==='/video'){sendVideo(req,res);return;}
    if(url.pathname.startsWith('/capture/')&&req.method==='POST'){
      const name=basename(decodeURIComponent(url.pathname.slice('/capture/'.length))).replace(/[^a-zA-Z0-9_.-]/g,'_'),chunks=[];
      for await(const chunk of req)chunks.push(chunk);
      await writeFile(join(outputDir,name),Buffer.concat(chunks));
      res.writeHead(204);res.end();return;
    }
    res.writeHead(404);res.end('not found');
  }catch(error){res.writeHead(500);res.end(String(error));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const httpPort=server.address().port,debugPort=10300+Math.floor(Math.random()*500),profile=await mkdtemp(join(tmpdir(),'airgapper-video-benchmark-'));
const chrome=process.env.CHROME_PATH||[
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome','/usr/bin/chromium','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].find(path=>existsSync(path));
if(!chrome)throw new Error('Chrome not found. Set CHROME_PATH.');
const child=spawn(chrome,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--autoplay-policy=no-user-gesture-required',`--remote-debugging-port=${debugPort}`,`--user-data-dir=${profile}`,'--window-size=1280,900','about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitForChrome(){for(let i=0;i<120;i++){try{const response=await fetch(`http://127.0.0.1:${debugPort}/json/version`);if(response.ok)return;}catch{}await sleep(100);}throw new Error('Chrome DevTools endpoint did not start');}
class Cdp{
  constructor(ws){this.ws=ws;this.seq=0;this.pending=new Map();ws.onmessage=event=>{const message=JSON.parse(event.data);if(!message.id)return;const pending=this.pending.get(message.id);if(!pending)return;this.pending.delete(message.id);message.error?pending.reject(new Error(message.error.message)):pending.resolve(message.result);};}
  static async connect(url){const ws=new WebSocket(url);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});return new Cdp(ws);}
  send(method,params={}){return new Promise((resolve,reject)=>{const id=++this.seq;this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}));});}
  close(){this.ws.close();}
}

let cdp;
try{
  await waitForChrome();
  const target=await (await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(`http://127.0.0.1:${httpPort}/`)}`,{method:'PUT'})).json();
  cdp=await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await sleep(750);
  const config=JSON.stringify({sampleFps,pipeline,detector});
  const expression=String.raw`(async()=>{
    const config=${config},wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    for(let i=0;i<100&&!window.AirGridX1;i++)await wait(50);
    if(!window.AirGridX1)throw new Error('AirGridX1 did not load');
    const video=document.createElement('video');video.muted=true;video.playsInline=true;video.preload='auto';video.src='/video';document.body.append(video);
    await new Promise((resolve,reject)=>{video.onloadedmetadata=resolve;video.onerror=()=>reject(new Error('Video metadata failed to load'));});
    const seek=async time=>{const target=Math.max(0,Math.min(video.duration-.001,time));if(video.readyState>=2&&Math.abs(video.currentTime-target)<.0005)return;await new Promise((resolve,reject)=>{const done=()=>{cleanup();resolve();},fail=()=>{cleanup();reject(new Error('Video seek failed at '+target));},cleanup=()=>{video.removeEventListener('seeked',done);video.removeEventListener('error',fail);};video.addEventListener('seeked',done);video.addEventListener('error',fail);video.currentTime=target;});};
    const worker=AirGridX1.createWorker(),PITCHES=[2,3,4,5,6,8],FPS=[0,1,2,5,10,15,30],PROFILES=['binary','M1','M2','M3'];
    const conditionFor=result=>{const h=result.tiles?.[0]?.header;if(!h||(h.flags&0x80)===0)return null;const profile=PROFILES[h.modulation],pitch=PITCHES[(h.flags>>>4)&7],fps=FPS[(h.flags>>>1)&7];return profile&&pitch&&fps!==undefined?{key:profile+'-p'+pitch+'-f'+fps,profile,pitch,fps}:null;};
    const conditions={},frames=[],saved=new Set(),timingSums={capture:0,detectorRaster:0,fiducialDetection:0,roiRaster:0,header:0,modulation:0,ecc:0,total:0};let latched='',unattributed=0,totalComplete=0,totalPayload=0,totalErrors=0,totalBits=0;
    const saveStill=async(label,time)=>{if(saved.has(label)||saved.size>=18)return;saved.add(label);const canvas=new OffscreenCanvas(video.videoWidth,video.videoHeight),ctx=canvas.getContext('2d',{alpha:false});ctx.drawImage(video,0,0);const blob=await canvas.convertToBlob({type:'image/png'}),name=String(saved.size).padStart(2,'0')+'-'+label.replace(/[^a-zA-Z0-9_.-]/g,'_')+'-'+time.toFixed(3).replace('.','_')+'s.png';await fetch('/capture/'+encodeURIComponent(name),{method:'POST',body:blob});};
    const count=Math.max(1,Math.floor((video.duration-.001)*config.sampleFps)+1),wallStart=performance.now();
    for(let i=0;i<count;i++){
      const time=Math.min(video.duration-.001,i/config.sampleFps);await seek(time);if(i===0)await saveStill('first-frame',time);
      let source,sourceKind='ImageBitmap',captureStart=performance.now();
      if(typeof VideoFrame==='function')try{source=new VideoFrame(video,{timestamp:Math.round(time*1000000)});sourceKind='VideoFrame';}catch{}
      if(!source)source=await createImageBitmap(video);
      const captureMs=performance.now()-captureStart,decodeStart=performance.now();let result;
      try{const response=await AirGridX1.request(worker,'decode',{bitmap:source,options:{captureMs,detectorLongSide:config.detector,detectorPipeline:config.pipeline,track:true}},[source]);result=response.result;}catch(error){frames.push({index:i,time,error:String(error)});continue;}
      const condition=conditionFor(result);if(condition){latched=condition.key;if(!saved.has('acquired-'+condition.key))await saveStill('acquired-'+condition.key,time);}const key=condition?.key||latched;
      if(!key){unattributed++;if(result.completeTiles===0&&i===Math.floor(count/4))await saveStill('unattributed-miss',time);}else{
        const a=conditions[key]||(conditions[key]={key,profile:condition?.profile||key.split('-')[0],pitch:condition?.pitch||0,pageFps:condition?.fps??0,scanFrames:0,acquiredFrames:0,completeTiles:0,payloadOkTiles:0,rawErrors:0,rawBits:0,validatedBytes:0,timingSums:{capture:0,detectorRaster:0,fiducialDetection:0,roiRaster:0,header:0,modulation:0,ecc:0,total:0}});a.scanFrames++;if(result.completeTiles)a.acquiredFrames++;a.completeTiles+=result.completeTiles;a.payloadOkTiles+=result.payloadOk;a.rawErrors+=result.metrics.rawErrors;a.rawBits+=result.metrics.rawBits;a.validatedBytes+=result.metrics.verifiedUniqueBytes;for(const k of Object.keys(a.timingSums))a.timingSums[k]+=result.timings[k]||0;
      }
      if(result.completeTiles&&!result.payloadOk)await saveStill('first-payload-failure',time);if(result.payloadOk)await saveStill('first-payload-success',time);
      totalComplete+=result.completeTiles;totalPayload+=result.payloadOk;totalErrors+=result.metrics.rawErrors;totalBits+=result.metrics.rawBits;for(const k of Object.keys(timingSums))timingSums[k]+=result.timings[k]||0;
      frames.push({index:i,time,sourceKind,condition:condition?.key||null,attributedCondition:key||null,detectorPipeline:result.detectorPipeline,detectorFallback:result.detectorFallback,sourceFormat:result.sourceFormat,detectorSize:result.detectorSize,fiducials:result.fiducials,candidates:result.candidates,roiCandidates:result.roiCandidates,completeTiles:result.completeTiles,payloadOk:result.payloadOk,rawBer:result.metrics.rawBer,validatedBytes:result.metrics.verifiedUniqueBytes,timings:result.timings,wallDecodeMs:performance.now()-decodeStart,tiles:result.tiles.map(tile=>({x:tile.header.tileX,y:tile.header.tileY,frame:tile.header.frame,flags:tile.header.flags,profile:tile.profile,payloadOk:tile.payloadOk,rawErrors:tile.rawErrors,rawBits:tile.rawBits}))});
    }
    worker.terminate();
    for(const a of Object.values(conditions)){const n=Math.max(1,a.scanFrames);a.metrics={acquisitionRate:a.acquiredFrames/n,completeTilesPerFrame:a.completeTiles/n,payloadOkTilesPerFrame:a.payloadOkTiles/n,rawBer:a.rawBits?a.rawErrors/a.rawBits:0,validatedBytesPerFrame:a.validatedBytes/n,averageTimings:Object.fromEntries(Object.entries(a.timingSums).map(([k,v])=>[k,v/n]))};}
    return{format:'AirGrid X1 recorded camera replay',schema:1,workerBuild:AirGridX1.build,video:{duration:video.duration,width:video.videoWidth,height:video.videoHeight},config,sampledFrames:frames.length,unattributedFrames:unattributed,totalCompleteTiles:totalComplete,totalPayloadOkTiles:totalPayload,rawBer:totalBits?totalErrors/totalBits:0,averageTimings:Object.fromEntries(Object.entries(timingSums).map(([k,v])=>[k,v/Math.max(1,frames.length)])),wallMs:performance.now()-wallStart,conditions,frames,stills:[...saved]};
  })()`;
  const evaluated=await cdp.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
  if(evaluated.exceptionDetails)throw new Error(evaluated.exceptionDetails.exception?.description||evaluated.exceptionDetails.text);
  const report=evaluated.result.value;
  report.input={path:videoPath,bytes:videoStat.size};
  report.completedAt=new Date().toISOString();
  const reportPath=join(outputDir,'report.json');
  await writeFile(reportPath,JSON.stringify(report,null,2));
  console.log(JSON.stringify({workerBuild:report.workerBuild,video:report.video,config:report.config,sampledFrames:report.sampledFrames,conditions:Object.keys(report.conditions),completeTiles:report.totalCompleteTiles,payloadOkTiles:report.totalPayloadOkTiles,rawBer:report.rawBer,averageWorkerMs:report.averageTimings.total,wallSeconds:report.wallMs/1000,output:reportPath},null,2));
  await cdp.send('Page.close');
}finally{
  cdp?.close();server.close();
  if(process.platform==='win32')spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore'});else child.kill('SIGKILL');
  await rm(profile,{recursive:true,force:true}).catch(()=>{});
}
