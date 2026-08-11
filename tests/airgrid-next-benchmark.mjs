import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir=dirname(fileURLToPath(import.meta.url));
const root=resolve(testsDir,'..');
const files=new Map([
  ['/',{type:'text/html; charset=utf-8',body:await readFile(join(root,'index.html'))}],
  ['/index.html',{type:'text/html; charset=utf-8',body:await readFile(join(root,'index.html'))}],
  ['/airgrid-x1.js',{type:'text/javascript; charset=utf-8',body:await readFile(join(root,'airgrid-x1.js'))}],
]);
const server=createServer((req,res)=>{const item=files.get((req.url||'').split('?')[0]);if(!item){res.writeHead(404);res.end('not found');return;}res.writeHead(200,{'content-type':item.type,'cache-control':'no-store'});res.end(item.body);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const httpPort=server.address().port;
const debugPort=9800+Math.floor(Math.random()*500);
const profile=await mkdtemp(join(tmpdir(),'airgapper-x1-benchmark-'));
const chrome=process.env.CHROME_PATH||[
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome','/usr/bin/chromium','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].find(path=>existsSync(path));
if(!chrome)throw new Error('Chrome not found. Set CHROME_PATH.');
const child=spawn(chrome,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',`--remote-debugging-port=${debugPort}`,`--user-data-dir=${profile}`,'--window-size=1280,900','about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitForChrome(){for(let i=0;i<100;i++){try{const r=await fetch(`http://127.0.0.1:${debugPort}/json/version`);if(r.ok)return;}catch{}await sleep(100);}throw new Error('Chrome DevTools endpoint did not start');}
class Cdp{
  constructor(ws){this.ws=ws;this.seq=0;this.pending=new Map();ws.onmessage=event=>{const m=JSON.parse(event.data);if(!m.id)return;const p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);};}
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
  await sleep(500);
  const expression=String.raw`(async()=>{
    const wait=ms=>new Promise(r=>setTimeout(r,ms));
    for(let i=0;i<100&&!window.AirGridX1;i++)await wait(50);
    if(!window.AirGridX1)throw new Error('AirGridX1 did not load');
    const A=AirGridX1,renderer=A.createWorker(),workers=[];
    const worker=()=>{const w=A.createWorker();workers.push(w);return w;};
    async function render({profile='M1',pitch=3,cols=3,rows=2,frame=77,pageFps=0}={}){const r=await A.request(renderer,'render',{config:{profile,pitch,cols,rows,frame,pageFps,session:0x13579bdf}}),c=document.createElement('canvas');c.width=r.width;c.height=r.height;c.getContext('2d',{alpha:false}).drawImage(r.bitmap,0,0);r.bitmap.close();return{canvas:c,meta:r};}
    async function decode(canvas,w=worker(),options={track:false}){const bitmap=await createImageBitmap(canvas),r=await A.request(w,'decode',{bitmap,options},[bitmap]);return r.result;}
    function clone(source){const c=document.createElement('canvas');c.width=source.width;c.height=source.height;c.getContext('2d',{alpha:false}).drawImage(source,0,0);return c;}
    function transformed(source,{mirror=false,rotate=0,blur=0,moire=0}={}){const c=document.createElement('canvas'),swap=Math.abs(rotate)%180===90;c.width=swap?source.height:source.width;c.height=swap?source.width:source.height;const x=c.getContext('2d',{alpha:false});x.fillStyle='#000';x.fillRect(0,0,c.width,c.height);x.translate(c.width/2,c.height/2);x.rotate(rotate*Math.PI/180);x.scale(mirror?-1:1,1);x.filter=blur?'blur('+blur+'px)':'none';x.drawImage(source,-source.width/2,-source.height/2);x.setTransform(1,0,0,1,0,0);x.filter='none';if(moire){x.globalAlpha=moire;x.fillStyle='#fff';for(let xx=1;xx<c.width;xx+=4)x.fillRect(xx,0,1,c.height);x.globalAlpha=moire*.7;for(let yy=2;yy<c.height;yy+=7)x.fillRect(0,yy,c.width,1);x.globalAlpha=1;}return c;}
    function perspective(source){const pad=28,c=document.createElement('canvas');c.width=source.width+pad*2;c.height=source.height+pad*2;const out=c.getContext('2d',{willReadFrequently:true}),src=source.getContext('2d').getImageData(0,0,source.width,source.height),dst=out.createImageData(c.width,c.height),q=[[20,12],[c.width-34,25],[c.width-8,c.height-18],[38,c.height-5]];for(let y=0;y<c.height;y++){const v=Math.max(0,Math.min(1,(y-12)/(c.height-24))),lx=q[0][0]+(q[3][0]-q[0][0])*v,rx=q[1][0]+(q[2][0]-q[1][0])*v;for(let x=Math.ceil(lx);x<=Math.floor(rx);x++){const u=(x-lx)/(rx-lx),sx=Math.max(0,Math.min(source.width-1,Math.round(u*(source.width-1)))),sy=Math.max(0,Math.min(source.height-1,Math.round(v*(source.height-1)))),si=(sy*source.width+sx)*4,di=(y*c.width+x)*4;dst.data[di]=src.data[si];dst.data[di+1]=src.data[si+1];dst.data[di+2]=src.data[si+2];dst.data[di+3]=255;}}out.putImageData(dst,0,0);return c;}
    function channelShift(source,{exposure=.82,mix=.12}={}){const c=clone(source),x=c.getContext('2d',{willReadFrequently:true}),d=x.getImageData(0,0,c.width,c.height),a=d.data;for(let i=0;i<a.length;i+=4){const r=a[i],g=a[i+1],b=a[i+2];a[i]=Math.max(0,Math.min(255,(r*(1-mix)+g*mix)*exposure+9));a[i+1]=Math.max(0,Math.min(255,(g*(1-mix)+b*mix)*exposure+5));a[i+2]=Math.max(0,Math.min(255,(b*(1-mix)+r*mix)*exposure+13));}x.putImageData(d,0,0);return c;}
    function compact(name,r){return{name,detector:r.detectorSize,fiducials:r.fiducials,candidates:r.candidates,tracked:r.tracked,complete:r.completeTiles,headers:r.headerOk,payloads:r.payloadOk,frames:r.frames,ber:r.metrics.rawBer,miChip:r.metrics.mutualInformationPerChip,verified:r.metrics.verifiedUniqueBytes,projected:r.metrics.projectedFullGridValidatedBytes,timings:r.timings,tiles:r.tiles.map(t=>({x:t.header.tileX,y:t.header.tileY,frame:t.header.frame,flags:t.header.flags,ok:t.payloadOk,rawErrors:t.rawErrors,eccIterations:t.eccIterations}))};}
    const base=await render(),results=[];
    results.push(compact('clean-full',await decode(base.canvas)));
    const p=3,m=4*p,crop=document.createElement('canvas');crop.width=(64+8)*p;crop.height=(64+8)*p;crop.getContext('2d').drawImage(base.canvas,-(m+64*p-4*p),-(m-4*p));results.push(compact('arbitrary-one-tile-crop',await decode(crop)));
    const crop2=document.createElement('canvas');crop2.width=(128+8)*p;crop2.height=(64+8)*p;crop2.getContext('2d').drawImage(base.canvas,-(m-4*p),-(m-4*p));results.push(compact('multiple-tile-crop',await decode(crop2)));
    results.push(compact('perspective',await decode(perspective(base.canvas))));
    results.push(compact('rotation-90',await decode(transformed(base.canvas,{rotate:90}))));
    results.push(compact('mirrored',await decode(transformed(base.canvas,{mirror:true}))));
    results.push(compact('blur',await decode(transformed(base.canvas,{blur:.55}))));
    results.push(compact('moire',await decode(transformed(base.canvas,{moire:.10}))));
    results.push(compact('exposure-white-balance-channel-mix',await decode(channelShift(base.canvas))));
    const frameB=await render({frame:78}),rolling=clone(base.canvas),rx=rolling.getContext('2d'),split=Math.floor(rolling.height/2);rx.drawImage(frameB.canvas,0,split,frameB.canvas.width,frameB.canvas.height-split,0,split,rolling.width,rolling.height-split);results.push(compact('rolling-shutter-composite',await decode(rolling)));
    const badHeader=clone(base.canvas),bh=badHeader.getContext('2d');for(let ty=0;ty<2;ty++)for(let tx=0;tx<3;tx++){bh.fillStyle='#000';bh.fillRect(m+(tx*64+8)*p,m+(ty*64+7)*p,48*p,8*p);}results.push(compact('corrupted-headers',await decode(badHeader)));
    const badPayload=clone(base.canvas),bp=badPayload.getContext('2d');bp.fillStyle='#fff';for(let ty=0;ty<2;ty++)for(let tx=0;tx<3;tx++)bp.fillRect(m+(tx*64+8)*p,m+(ty*64+23)*p,48*p,40*p);results.push(compact('corrupted-payloads',await decode(badPayload)));
    const noise=document.createElement('canvas');noise.width=base.canvas.width;noise.height=base.canvas.height;const nx=noise.getContext('2d'),nd=nx.createImageData(noise.width,noise.height);let seed=0x6d2b79f5;for(let i=0;i<nd.data.length;i+=4){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;const v=seed&127;nd.data[i]=v;nd.data[i+1]=v;nd.data[i+2]=v;nd.data[i+3]=255;}nx.putImageData(nd,0,0);results.push(compact('false-positive-noise',await decode(noise)));
    const profileResults=[];for(const profile of['binary','M2','M3']){const r=await render({profile,cols:1,rows:1});profileResults.push(compact('clean-'+profile,await decode(r.canvas)));}
    const dense=await render({profile:'M1',pitch:2,cols:10,rows:5,frame:88,pageFps:5});results.push(compact('dense-hardware-grid',await decode(dense.canvas)));
    const tw=worker(),trackA=await decode(base.canvas,tw,{track:true}),trackBFrame=await render({frame:79}),trackB=await decode(trackBFrame.canvas,tw,{track:true});
    const taggedFrame=await render({profile:'M2',pitch:4,cols:1,rows:1,frame:91,pageFps:15}),hardwareTag=compact('hardware-tag',await decode(taggedFrame.canvas));
    const st=await A.request(worker(),'selftest');
    history.replaceState(null,'','/?airgridLab=1');await A.startLab();const labSmoke={autoSender:!!document.querySelector('#x1Auto'),autoReceiver:!!document.querySelector('#x1Camera'),exportJson:!!document.querySelector('#x1Export'),exportCsv:!!document.querySelector('#x1Csv'),canvas:[document.querySelector('#x1Canvas')?.width||0,document.querySelector('#x1Canvas')?.height||0]};
    for(const w of workers)w.terminate();renderer.terminate();
    return{format:A.format,seed:'0x6d2b79f5',results,profileResults,hardwareTag,labSmoke,tracking:{first:compact('tracking-acquire',trackA),second:compact('tracking-follow',trackB)},selftest:st.result};
  })()`;
  const evaluated=await cdp.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
  if(evaluated.exceptionDetails)throw new Error(evaluated.exceptionDetails.exception?.description||evaluated.exceptionDetails.text);
  const report=evaluated.result.value,byName=Object.fromEntries(report.results.map(x=>[x.name,x])),failures=[];
  const need=(name,minComplete,minPayload=minComplete)=>{const r=byName[name];if(!r)failures.push(`${name}: missing result`);else{if(r.complete<minComplete)failures.push(`${name}: ${r.complete} complete tiles, expected ${minComplete}`);if(r.payloads<minPayload)failures.push(`${name}: ${r.payloads} payloads, expected ${minPayload}`);}};
  need('clean-full',6,6);
  need('arbitrary-one-tile-crop',1,1);
  need('multiple-tile-crop',2,2);
  need('dense-hardware-grid',1,1);if((byName['dense-hardware-grid']?.projected||0)<=byName['dense-hardware-grid']?.verified)failures.push('dense-grid full-screen capacity projection was not reported');
  for(const name of['perspective','rotation-90','mirrored','blur','moire','exposure-white-balance-channel-mix'])need(name,1,1);
  const rolling=byName['rolling-shutter-composite'];if(!rolling||rolling.frames.length<2||rolling.payloads<2)failures.push('rolling-shutter composite did not accept independent frame IDs');
  if(byName['corrupted-headers']?.complete!==0)failures.push('corrupted headers were accepted');
  const badPayload=byName['corrupted-payloads'];if(!badPayload||badPayload.complete<1||badPayload.payloads!==0)failures.push('corrupted payloads were not independently CRC-rejected');
  if(byName['false-positive-noise']?.complete!==0)failures.push('false-positive noise was accepted');
  for(const r of report.profileResults)if(r.complete!==1||r.payloads!==1)failures.push(`${r.name}: clean profile did not round-trip`);
  if(!report.tracking.second.tracked||report.tracking.second.payloads<1)failures.push('persistent marker tracking did not decode the following frame');
  const tagged=report.hardwareTag?.tiles?.[0],expectedFlags=0x80|(2<<4)|(5<<1)|1;if(!tagged||tagged.flags!==expectedFlags||report.hardwareTag.payloads!==1)failures.push('hardware condition flags did not round-trip');
  if(!report.labSmoke?.autoSender||!report.labSmoke?.autoReceiver||!report.labSmoke?.exportJson||!report.labSmoke?.exportCsv||!report.labSmoke.canvas[0])failures.push('automated hardware lab UI did not initialize');
  if(!report.selftest?.headerRecovered)failures.push('protected header reconstruction failed');
  if(!report.selftest?.eccRecovered)failures.push('LDPC soft reconstruction failed');
  if(!report.selftest?.fountainRecovered)failures.push('fountain reconstruction failed');
  console.log(JSON.stringify(report,null,2));
  if(failures.length){console.error('\nFAILED\n- '+failures.join('\n- '));process.exitCode=1;}else console.log('\nPASS: AirGrid X1 crop-local production-worker benchmark');
  await cdp.send('Page.close');
}finally{
  cdp?.close();server.close();
  if(process.platform==='win32')spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore'});else child.kill('SIGKILL');
  await rm(profile,{recursive:true,force:true}).catch(()=>{});
}
