import { QuietScanner } from "./quiet-stream.js";

const SAMPLE_RATE = 48000;
const FREQUENCIES = new Int32Array([14000, 15000, 16000, 17000, 18000]);
const WINDOW_SAMPLES = 512;
const WINDOW_STEP = 128;
const DIAGNOSTIC_SAMPLES = 2048;
const REPORT_SAMPLES = 8192;
const COEFF = new Float64Array(FREQUENCIES.length);
for (let i = 0; i < FREQUENCIES.length; i++) COEFF[i] = 2 * Math.cos(2 * Math.PI * FREQUENCIES[i] / SAMPLE_RATE);

let diagnostic = new Float32Array(0);
let samplesSinceReport = 0;

function sendPacket(packet) {
  const block = packet.block.slice();
  postMessage({ type: "packet", packet: { ...packet, block: block.buffer } }, [block.buffer]);
}
function toneDb(samples, offset, index) {
  const coeff = COEFF[index];
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < WINDOW_SAMPLES; i++) {
    const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (WINDOW_SAMPLES - 1));
    const s0 = samples[offset + i] * window + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2);
  const amplitude = 2 * Math.sqrt(power) / WINDOW_SAMPLES;
  return 20 * Math.log10(Math.max(1e-8, amplitude));
}
function peakDb(samples, index) {
  let best = -160;
  for (let offset = 0; offset + WINDOW_SAMPLES <= samples.length; offset += WINDOW_STEP) {
    best = Math.max(best, toneDb(samples, offset, index));
  }
  return best;
}
function appendDiagnostic(chunk) {
  const keep = Math.min(DIAGNOSTIC_SAMPLES, diagnostic.length + chunk.length);
  const joined = new Float32Array(keep);
  const fromOld = Math.max(0, keep - chunk.length);
  if (fromOld) joined.set(diagnostic.subarray(diagnostic.length - fromOld), 0);
  joined.set(chunk.subarray(Math.max(0, chunk.length - keep)), fromOld);
  diagnostic = joined;
  samplesSinceReport += chunk.length;
  if (samplesSinceReport < REPORT_SAMPLES || diagnostic.length < DIAGNOSTIC_SAMPLES) return;
  samplesSinceReport = 0;
  postMessage({ type: "spectrum", levels: Array.from(FREQUENCIES, (_, i) => peakDb(diagnostic, i)) });
}

const quiet = new QuietScanner(sendPacket);
self.onmessage = (event) => {
  const message = event.data;
  if (message?.type === "samples" && message.samples instanceof ArrayBuffer) {
    const samples = new Float32Array(message.samples);
    appendDiagnostic(samples);
    quiet.append(samples);
  } else if (message?.type === "reset") {
    diagnostic = new Float32Array(0);
    samplesSinceReport = 0;
    quiet.reset();
  }
};
