import { AirGridQrAcquisitionRenderer } from './send/airgrid-qr-acquisition-renderer.js';

const BUILD = 'AGRS-20260823-1400';
const OLD_BUILD = 'AGRS-20260823-1356';
const decoder = new TextDecoder();

// Keep the acquisition renderer from advertising the core module's older
// bring-up build. The core remains reusable; this wrapper owns the hardware
// acquisition implementation and visible build identity.
const originalAcquireRender = AirGridQrAcquisitionRenderer.prototype.render;
AirGridQrAcquisitionRenderer.prototype.render = function(ctx, width, height, config) {
  return originalAcquireRender.call(this, ctx, width, height, config, BUILD);
};

const statusBadge = document.createElement('div');
statusBadge.id = 'wasm-qr-status';
Object.assign(statusBadge.style, {
  position: 'fixed',
  right: '8px',
  bottom: '8px',
  zIndex: '10000',
  maxWidth: 'min(92vw, 520px)',
  padding: '6px 9px',
  border: '1px solid #315c39',
  borderRadius: '7px',
  background: '#0b160dee',
  color: '#83ef9b',
  font: '11px ui-monospace, SFMono-Regular, Menlo, monospace',
  pointerEvents: 'none'
});
statusBadge.textContent = `${BUILD} · WASM QR worker warming…`;
document.body.append(statusBadge);

function setWorkerStatus(text, bad = false) {
  statusBadge.textContent = `${BUILD} · ${text}`;
  statusBadge.style.color = bad ? '#ff8383' : '#83ef9b';
  statusBadge.style.borderColor = bad ? '#753b3b' : '#315c39';
}

const qrWorker = new Worker(new URL('./receive/worker.js?airgrid-acq=1400', import.meta.url), { type:'module' });
const pending = new Map();
let requestId = 1;
let workerReady = false;
let workerFailed = false;
let gateCanvas = null;
let gateCtx = null;
let lastGate = { mean:0, bright:0, acquisition:false };

function quadBox(q) {
  const pts = [q?.topLeft,q?.topRight,q?.bottomRight,q?.bottomLeft].filter(Boolean);
  if (pts.length !== 4) return null;
  const xs = pts.map(p=>p.x), ys = pts.map(p=>p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  const width = Math.max(...xs)-x, height = Math.max(...ys)-y;
  return { x,y,width,height };
}

qrWorker.onmessage = event => {
  const data = event.data ?? {};
  if (data.id === -1) {
    workerReady = true;
    setWorkerStatus('WASM QR worker ready');
    return;
  }
  const job = pending.get(data.id);
  if (!job) return;
  pending.delete(data.id);
  const symbols = Array.isArray(data.symbols) ? data.symbols : [];
  const results = symbols.flatMap(symbol => {
    const q = symbol?.quad;
    if (!q?.topLeft || !q?.topRight || !q?.bottomRight || !q?.bottomLeft || !symbol.bytes) return [];
    let rawValue = '';
    try {
      const bytes = symbol.bytes instanceof Uint8Array ? symbol.bytes : Uint8Array.from(symbol.bytes);
      rawValue = decoder.decode(bytes);
    } catch {}
    if (!rawValue) return [];
    return [{
      rawValue,
      cornerPoints: [q.topLeft,q.topRight,q.bottomRight,q.bottomLeft],
      boundingBox: quadBox(q)
    }];
  });
  const ms = Number(data.latencyMs ?? performance.now()-job.startedAt);
  setWorkerStatus(`WASM QR scan ${results.length} hit${results.length===1?'':'s'} · ${ms.toFixed(0)} ms · gate ${(lastGate.bright*100).toFixed(0)}% bright`);
  job.resolve(results);
};
qrWorker.onerror = event => {
  workerFailed = true;
  setWorkerStatus(`WASM QR worker failed: ${event.message}`, true);
  for (const job of pending.values()) job.resolve([]);
  pending.clear();
};

function acquisitionGate(video) {
  const vw = Math.max(1, video.videoWidth || 1);
  const vh = Math.max(1, video.videoHeight || 1);
  const maxSide = 64;
  const w = vw >= vh ? maxSide : Math.max(16, Math.round(maxSide*vw/vh));
  const h = vw >= vh ? Math.max(16, Math.round(maxSide*vh/vw)) : maxSide;
  if (!gateCanvas) {
    gateCanvas = document.createElement('canvas');
    gateCtx = gateCanvas.getContext('2d', { willReadFrequently:true });
  }
  if (gateCanvas.width !== w || gateCanvas.height !== h) {
    gateCanvas.width = w;
    gateCanvas.height = h;
  }
  gateCtx.drawImage(video,0,0,w,h);
  const rgba = gateCtx.getImageData(0,0,w,h).data;
  let sum = 0, bright = 0;
  const count = w*h;
  for (let p=0; p<rgba.length; p+=4) {
    const y = rgba[p]*0.2126 + rgba[p+1]*0.7152 + rgba[p+2]*0.0722;
    sum += y;
    if (y >= 155) bright++;
  }
  const mean = sum/Math.max(1,count);
  const brightFraction = bright/Math.max(1,count);
  // Acquisition is a mostly-white page with four large QRs. The binary data
  // raster is roughly 50/50. This tiny 64px gate prevents the expensive robust
  // QR finder from ever running on random AirGrid data.
  const acquisition = mean >= 140 && brightFraction >= 0.60;
  lastGate = { mean, bright:brightFraction, acquisition };
  return acquisition;
}

class WasmBarcodeDetector {
  static async getSupportedFormats() { return ['qr_code']; }
  constructor(options={}) {
    if (options.formats && !options.formats.includes('qr_code')) throw new Error('Only qr_code is supported');
  }
  async detect(source) {
    if (workerFailed || !source?.videoWidth || !source?.videoHeight) return [];
    if (!workerReady) {
      setWorkerStatus('WASM QR worker warming…');
      return [];
    }
    let shouldScan = false;
    try { shouldScan = acquisitionGate(source); }
    catch (error) {
      setWorkerStatus(`acquisition gate error: ${error.message}`, true);
      return [];
    }
    if (!shouldScan) {
      setWorkerStatus(`data gate · no QR scan · mean ${lastGate.mean.toFixed(0)} · ${(lastGate.bright*100).toFixed(0)}% bright`);
      return [];
    }
    if (!globalThis.VideoFrame) {
      setWorkerStatus('VideoFrame unavailable', true);
      return [];
    }
    let frame;
    try {
      frame = new VideoFrame(source, { timestamp:Math.round(performance.now()*1000) });
    } catch (error) {
      setWorkerStatus(`VideoFrame capture failed: ${error.message}`, true);
      return [];
    }
    const id = requestId++;
    const w = frame.codedWidth || frame.displayWidth || source.videoWidth;
    const h = frame.codedHeight || frame.displayHeight || source.videoHeight;
    const promise = new Promise(resolve => pending.set(id, { resolve, startedAt:performance.now() }));
    try {
      qrWorker.postMessage({
        id,
        videoFrame:frame,
        cropX:0,
        cropY:0,
        w,
        h,
        full:true,
        pixelFormat:'y8',
        acquisitionMode:'hunt',
        sentAt:performance.now()
      }, [frame]);
      setWorkerStatus(`WASM QR scanning ${w}×${h} off-thread…`);
    } catch (error) {
      pending.delete(id);
      try { frame.close(); } catch {}
      setWorkerStatus(`QR worker post failed: ${error.message}`, true);
      return [];
    }
    return promise;
  }
}

// The existing bring-up core is intentionally left alone except for replacing
// the browser BarcodeDetector implementation. Its acquisition logic now calls
// the same interface, but all expensive QR work happens in AirGapper's proven
// WASM worker instead of Chromium's main-thread detector.
globalThis.BarcodeDetector = WasmBarcodeDetector;

await import('./airgrid-lab-1356.js?acq=wasm-1400');

const visibleIds = ['build-id','receiver-status','send-plan','recv-plan','receiver-details','sender-hud'];
function rewriteVisibleBuild() {
  for (const id of visibleIds) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (el.textContent.includes(OLD_BUILD)) el.textContent = el.textContent.replaceAll(OLD_BUILD, BUILD);
  }
  const badge = document.getElementById('build-id');
  if (badge) badge.textContent = BUILD;
}
rewriteVisibleBuild();
const observer = new MutationObserver(rewriteVisibleBuild);
observer.observe(document.body, { subtree:true, childList:true, characterData:true });
window.addEventListener('beforeunload', () => {
  observer.disconnect();
  try { qrWorker.terminate(); } catch {}
});
