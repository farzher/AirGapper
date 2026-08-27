import { getAndroidMediaOutputLevel } from "../shared/android.js";
import { TransportDecoder } from "../shared/transport.js";

const POLL_MS = 100;
let canvas = null;
let diagnosticsNode = null;

const reliableDiagnostics = {
  workerCreatedAt: 0,
  firstSampleAt: 0,
  samples: 0,
  rms: 0,
  peak: 0,
  ready: false,
  frameSamples: 0,
  frames: 0,
  sync: 0,
  raw: 0,
  bad: 0,
  packets: 0,
  lastLength: 0,
  transport: 0,
  useful: 0
};

function audioReceiveActive() {
  const view = document.getElementById("audioView");
  const pane = document.getElementById("audio-receive-pane");
  return Boolean(view?.classList.contains("active") && pane && !pane.hidden);
}

function resetReliableDiagnostics() {
  reliableDiagnostics.workerCreatedAt = performance.now();
  reliableDiagnostics.firstSampleAt = 0;
  reliableDiagnostics.samples = 0;
  reliableDiagnostics.rms = 0;
  reliableDiagnostics.peak = 0;
  reliableDiagnostics.ready = false;
  reliableDiagnostics.frameSamples = 0;
  reliableDiagnostics.frames = 0;
  reliableDiagnostics.sync = 0;
  reliableDiagnostics.raw = 0;
  reliableDiagnostics.bad = 0;
  reliableDiagnostics.packets = 0;
  reliableDiagnostics.lastLength = 0;
  reliableDiagnostics.transport = 0;
  reliableDiagnostics.useful = 0;
}

function recordSamples(buffer) {
  const samples = new Float32Array(buffer);
  if (!samples.length) return;
  if (!reliableDiagnostics.firstSampleAt) reliableDiagnostics.firstSampleAt = performance.now();
  reliableDiagnostics.samples += samples.length;
  let sumSquares = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i];
    sumSquares += value * value;
    peak = Math.max(peak, Math.abs(value));
  }
  const rms = Math.sqrt(sumSquares / samples.length);
  reliableDiagnostics.rms = reliableDiagnostics.rms * 0.8 + rms * 0.2;
  reliableDiagnostics.peak = Math.max(peak, reliableDiagnostics.peak * 0.92);
}

function installReliableWorkerTap() {
  if (typeof window === "undefined" || typeof window.Worker !== "function" || window.__airgapperReliableWorkerTap) return;
  const NativeWorker = window.Worker;
  function DiagnosticWorker(url, options) {
    const worker = new NativeWorker(url, options);
    const href = String(url?.href ?? url ?? "");
    if (!/\/audio\/ultra-worker\.js(?:[?#]|$)/.test(href)) return worker;
    resetReliableDiagnostics();
    const nativePostMessage = worker.postMessage.bind(worker);
    worker.postMessage = (message, transfer) => {
      if (message?.type === "samples" && message.samples instanceof ArrayBuffer) recordSamples(message.samples);
      return transfer === undefined ? nativePostMessage(message) : nativePostMessage(message, transfer);
    };
    worker.addEventListener("message", (event) => {
      if (event.data?.type === "ready") {
        reliableDiagnostics.ready = true;
        reliableDiagnostics.frameSamples = Number(event.data.frameSamples) || 0;
        return;
      }
      if (event.data?.type === "stats") {
        const stats = event.data.stats ?? {};
        reliableDiagnostics.frames = Number(stats.frames) || 0;
        reliableDiagnostics.sync = Number(stats.sync) || 0;
        reliableDiagnostics.raw = Number(stats.raw) || 0;
        reliableDiagnostics.bad = Number(stats.bad) || 0;
        reliableDiagnostics.packets = Number(stats.packets) || 0;
        reliableDiagnostics.lastLength = Number(stats.lastLength) || 0;
        return;
      }
      if (event.data?.packet) reliableDiagnostics.packets = Math.max(reliableDiagnostics.packets, reliableDiagnostics.packets + 1);
    });
    return worker;
  }
  DiagnosticWorker.prototype = NativeWorker.prototype;
  try { Object.setPrototypeOf(DiagnosticWorker, NativeWorker); } catch {}
  window.Worker = DiagnosticWorker;
  window.__airgapperReliableWorkerTap = true;
}

function installTransportTap() {
  const prototype = TransportDecoder?.prototype;
  if (!prototype || prototype.__airgapperReliableDiagnostics) return;
  const addFrame = prototype.addFrame;
  prototype.addFrame = function(...args) {
    const before = Number(this.usefulSymbols) || 0;
    const result = addFrame.apply(this, args);
    if (typeof document !== "undefined" && audioReceiveActive()) {
      reliableDiagnostics.transport++;
      const after = Number(this.usefulSymbols) || 0;
      if (after > before) reliableDiagnostics.useful += after - before;
    }
    return result;
  };
  prototype.__airgapperReliableDiagnostics = true;
}

function updateReliableDiagnostics() {
  if (typeof document === "undefined") return;
  const pane = document.getElementById("audio-receive-pane");
  if (!pane || !audioReceiveActive()) return;
  if (!diagnosticsNode?.isConnected) {
    diagnosticsNode = document.createElement("div");
    diagnosticsNode.dataset.reliableDiagnostics = "";
    diagnosticsNode.style.cssText = "font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere;user-select:text;opacity:.8;margin:8px 2px 0;text-align:left";
    pane.append(diagnosticsNode);
  }
  const now = performance.now();
  const sampleSeconds = reliableDiagnostics.firstSampleAt ? Math.max(0.001, (now - reliableDiagnostics.firstSampleAt) / 1000) : 0;
  const sampleRate = sampleSeconds ? reliableDiagnostics.samples / sampleSeconds / 1000 : 0;
  const workerSeconds = reliableDiagnostics.workerCreatedAt ? Math.max(0.001, (now - reliableDiagnostics.workerCreatedAt) / 1000) : 0;
  const frameRate = workerSeconds ? reliableDiagnostics.frames / workerSeconds : 0;
  diagnosticsNode.textContent = `Reliable diag · mic ${sampleRate.toFixed(1)}k/s rms ${reliableDiagnostics.rms.toFixed(3)} peak ${reliableDiagnostics.peak.toFixed(2)} · worker ${reliableDiagnostics.ready ? "ready" : "loading"} ${frameRate.toFixed(1)}f/s · sync ${reliableDiagnostics.sync} · raw ${reliableDiagnostics.raw}${reliableDiagnostics.lastLength ? `(${reliableDiagnostics.lastLength}B)` : ""} · bad ${reliableDiagnostics.bad} · pkt ${reliableDiagnostics.packets} · transport ${reliableDiagnostics.transport} · useful ${reliableDiagnostics.useful}`;
}

function knownOutputLevel() {
  const androidLevel = getAndroidMediaOutputLevel();
  if (androidLevel !== null) return androidLevel;
  if (typeof navigator !== "undefined" && navigator.audioSession?.state === "interrupted") return 0;
  return 1;
}

function resetCanvas(target) {
  if (!target) return;
  target.style.removeProperty("transform");
  target.style.removeProperty("transform-origin");
  target.style.removeProperty("transition");
}

function update() {
  const active = document.getElementById("audio-send-active");
  const nextCanvas = active?.querySelector("canvas") ?? null;
  if (nextCanvas !== canvas) {
    resetCanvas(canvas);
    canvas = nextCanvas;
    if (canvas) {
      canvas.style.transformOrigin = "50% 50%";
      canvas.style.transition = "transform 80ms linear";
      active.querySelector(".send-toolbar")?.style.setProperty("grid-template-columns", "repeat(2, minmax(0, 1fr))");
    }
  }
  if (canvas) {
    const level = active && !active.hidden ? knownOutputLevel() : 1;
    const amplitude = level <= 0.001 ? 0 : Math.sqrt(level);
    canvas.style.transform = `scaleY(${amplitude})`;
  }
  updateReliableDiagnostics();
  setTimeout(update, POLL_MS);
}

if (typeof window !== "undefined") {
  installReliableWorkerTap();
  installTransportTap();
}
if (typeof document !== "undefined") update();
