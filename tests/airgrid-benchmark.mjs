import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir=dirname(fileURLToPath(import.meta.url));
const root=resolve(testsDir,'..');
const source=await readFile(join(root,'index.html'),'utf8');
const exportNeedle='window.AirGapperDiagnostics={build:BUILD,air:AIR,glyphMasks:GLYPH_MASKS,runSelfTests,parseBootstrap,inspectBootstrap};';
if(!source.includes(exportNeedle))throw new Error('AirGapper diagnostics export changed; update benchmark instrumentation');
const instrumented=source.replace(exportNeedle,'window.AirGapperDiagnostics={build:BUILD,air:AIR,glyphMasks:GLYPH_MASKS,runSelfTests,parseBootstrap,inspectBootstrap,state,showView,prepareTransfer,packText,stopSender,renderAirFrame,initAirWorker};');

const fixtures=['phone-profile2-a.webp','phone-profile2-b.webp','phone-profile3-camera-a.png','phone-profile3-camera-b.png','phone-profile3-frozen-c.jpg'];
const server=createServer(async(req,res)=>{
  try{
    if(req.url==='/'||req.url==='/index.html'){
      res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
      res.end(instrumented);return;
    }
    const name=decodeURIComponent((req.url||'').replace(/^\/fixtures\//,''));
    if(fixtures.includes(name)){
      const body=await readFile(join(testsDir,'fixtures',name));
      res.writeHead(200,{'content-type':'image/webp','cache-control':'no-store'});
      res.end(body);return;
    }
    res.writeHead(404);res.end('not found');
  }catch(error){res.writeHead(500);res.end(String(error));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const httpPort=server.address().port;
const debugPort=9300+Math.floor(Math.random()*500);
const profile=await mkdtemp(join(tmpdir(),'airgapper-benchmark-'));
const chrome=process.env.CHROME_PATH||[
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome','/usr/bin/chromium','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].find(path=>existsSync(path));
if(!chrome)throw new Error('Chrome not found. Set CHROME_PATH.');
const child=spawn(chrome,[
  '--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
  `--remote-debugging-port=${debugPort}`,`--user-data-dir=${profile}`,'--window-size=1280,900','about:blank'
],{stdio:'ignore'});

function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
async function waitForChrome(){for(let i=0;i<100;i++){try{const r=await fetch(`http://127.0.0.1:${debugPort}/json/version`);if(r.ok)return;}catch{}await sleep(100);}throw new Error('Chrome DevTools endpoint did not start');}
class Cdp{
  constructor(ws){this.ws=ws;this.seq=0;this.pending=new Map();ws.onmessage=event=>{const msg=JSON.parse(event.data);if(!msg.id)return;const pending=this.pending.get(msg.id);if(!pending)return;this.pending.delete(msg.id);msg.error?pending.reject(new Error(msg.error.message)):pending.resolve(msg.result);};}
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
  await sleep(2500);
  const expression=String.raw`(async()=>{
    const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    for(let i=0;i<200&&(!window.qrcode||!window.fflate||!window.ZXingWASM);i++)await sleep(50);
    if(!window.qrcode||!window.fflate||!window.ZXingWASM)throw new Error('Vendor libraries did not load');
    const d=AirGapperDiagnostics;
    d.showView('send');
    await d.prepareTransfer(d.packText('AirGrid optical benchmark '.repeat(300)),'benchmark.txt');
    await sleep(100);
    const rate=document.querySelector('#fpsRange');
    rate.value='0';rate.dispatchEvent(new Event('input'));
    const frozenSeq=d.state.displaySeq,frozenPage=d.state.displayedPage;
    await sleep(300);
    const senderModes={frozenDelta:d.state.displaySeq-frozenSeq,frozenPageStable:d.state.displayedPage===frozenPage};
    rate.value='1';rate.dispatchEvent(new Event('input'));
    const oneFpsSeq=d.state.displaySeq;
    await sleep(1150);
    senderModes.oneFpsDelta=d.state.displaySeq-oneFpsSeq;
    rate.value='15';rate.dispatchEvent(new Event('input'));d.stopSender();d.state.displaySeq=1234;d.renderAirFrame();d.stopSender();
    const source=document.querySelector('#qrCanvas');
    if(!await d.initAirWorker(1))throw new Error('AirGrid worker unavailable');
    async function decode(bitmap){return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('decode timeout')),15000),worker=d.state.scanWorker;
      worker.onmessage=event=>{clearTimeout(timer);const x=event.data;resolve({groups:x.groups,visible:x.visibleTiles,ok:x.okTiles,known:x.known?x.knownOk/x.known:0,knownShape:x.known?x.knownShapeOk/x.known:0,knownColor:x.known?x.knownColorOk/x.known:0,shape:x.visibleTiles?x.shapeConf/x.visibleTiles:0,color:x.visibleTiles?x.colorConf/x.visibleTiles:0,qrCandidates:x.qrCandidates,bootstrapQrs:x.bootstrapQrs,pages:x.pages,crcFailures:x.crcFailures,corrections:x.corrections,transition:x.transition,groupDiagnostics:x.groupDiagnostics,tileDiagnostics:x.tileDiagnostics,ms:x.ms,error:x.error||''});};
      worker.onerror=event=>{clearTimeout(timer);reject(new Error(event.message));};
      worker.postMessage({id:1,bitmap,target:1920},[bitmap]);
    });}
    async function synthetic(name,{scale=1,blur=0,rotation=0,moire=0,margin=0}={}){
      const opticalScale=d.air.senderScale||1,width=Math.ceil(source.width*opticalScale*scale+margin*2),height=Math.ceil(source.height*opticalScale*scale+margin*2),canvas=document.createElement('canvas');
      canvas.width=width;canvas.height=height;const ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=false;ctx.fillStyle='#fff';ctx.fillRect(0,0,width,height);ctx.translate(width/2,height/2);ctx.rotate(rotation*Math.PI/180);ctx.filter=blur?'blur('+blur+'px) saturate(.94) contrast(.97)':'none';ctx.drawImage(source,-source.width*opticalScale*scale/2,-source.height*opticalScale*scale/2,source.width*opticalScale*scale,source.height*opticalScale*scale);ctx.setTransform(1,0,0,1,0,0);ctx.filter='none';
      if(moire){ctx.globalCompositeOperation='multiply';ctx.fillStyle='#777';ctx.globalAlpha=moire;for(let x=1;x<width;x+=3)ctx.fillRect(x,0,1,height);ctx.globalAlpha=moire*.45;for(let y=2;y<height;y+=5)ctx.fillRect(0,y,width,1);ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';}
      return{name,size:[width,height],...await decode(await createImageBitmap(canvas))};
    }
    async function inspectFixture(name){
      const image=new Image();image.src='/fixtures/'+name;await image.decode();const canvas=new OffscreenCanvas(image.width,image.height),ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0);const data=ctx.getImageData(0,0,image.width,image.height),results=await ZXingWASM.readBarcodes(data,{formats:['QRCode'],maxNumberOfSymbols:16,tryHarder:false,tryRotate:true,tryInvert:false,tryDownscale:false,tryDenoise:false}),boots=results.map(result=>d.inspectBootstrap(result.text)).filter(Boolean),current=boots.some(x=>x.profile===d.air.profile)?await decode(await createImageBitmap(image)):null;
      return{name,size:[image.width,image.height],qrCandidates:results.length,bootstraps:boots.map(x=>({profile:x.profile,gx:x.gx,gy:x.gy,symbolBytes:x.symbolBytes,fps:x.fps})),production:current};
    }
    return{build:d.build,profile:d.air.profile,senderModes,synthetic:[
      await synthetic('clean',{margin:20}),
      await synthetic('phone-a',{scale:.8,blur:.5,rotation:3,moire:.035,margin:60}),
      await synthetic('phone-b',{scale:.7,blur:.65,rotation:-3,moire:.05,margin:60})
    ],fixtures:[${fixtures.map(name=>`await inspectFixture('${name}')`).join(',')}],selfTests:d.runSelfTests()};
  })()`;
  const result=await cdp.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
  if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
  const report=result.result.value;
  const failures=[];
  if(!report.selfTests?.ok)failures.push('in-page self-tests failed');
  if(report.senderModes?.frozenDelta!==0||!report.senderModes?.frozenPageStable)failures.push('frozen sender advanced its page');
  if(report.senderModes?.oneFpsDelta<1||report.senderModes?.oneFpsDelta>2)failures.push(`1 fps sender advanced ${report.senderModes?.oneFpsDelta} pages`);
  for(const item of report.synthetic){
    if(item.error)failures.push(`${item.name}: ${item.error}`);
    if(item.visible<1)failures.push(`${item.name}: no payload tiles visible`);
    const minimum=item.name==='clean'?item.visible:Math.max(1,item.visible-1);
    if(item.ok<minimum)failures.push(`${item.name}: decoded ${item.ok}/${item.visible}, expected at least ${minimum}`);
  }
  for(const item of report.fixtures){
    if(item.name.includes('profile2')){
      if(item.qrCandidates<4)failures.push(`${item.name}: only ${item.qrCandidates}/4 legacy anchors detected`);
      if(item.bootstraps.some(x=>x.profile!==2))failures.push(`${item.name}: expected legacy profile 2 capture`);
    }else{
      if(!item.bootstraps.some(x=>x.profile===report.profile))failures.push(`${item.name}: no current-profile bootstrap detected`);
      if(!item.production||item.production.error)failures.push(`${item.name}: production worker did not run`);
      else if(!item.production.groups||!item.production.visible)failures.push(`${item.name}: production worker did not acquire payload geometry`);
      if(item.name.includes('frozen')&&!item.bootstraps.some(x=>x.fps===0))failures.push(`${item.name}: expected a frozen-page bootstrap`);
    }
  }
  console.log(JSON.stringify(report,null,2));
  if(failures.length){console.error('\nFAILED\n- '+failures.join('\n- '));process.exitCode=1;}else console.log('\nPASS: AirGrid synthetic channel and hardware-capture baselines');
  await cdp.send('Page.close');
}finally{
  cdp?.close();server.close();
  if(process.platform==='win32')spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore'});else child.kill('SIGKILL');
  await rm(profile,{recursive:true,force:true}).catch(()=>{});
}
