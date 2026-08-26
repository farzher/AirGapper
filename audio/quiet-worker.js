import {
  QUIET_TONE_BASE_HZ,
  QUIET_TONE_COUNT,
  QUIET_TONE_SPACING_HZ,
  QuietScanner
} from "./quiet-stream.js";

const SAMPLE_RATE = 48000;
const WINDOW_SAMPLES = 192;
const WINDOW_STEP = 48;
const DIAGNOSTIC_SAMPLES = 1536;
const REPORT_SAMPLES = 8192;
const TONE_COEFF = new Float64Array(QUIET_TONE_COUNT);
for (let tone = 0; tone < QUIET_TONE_COUNT; tone++) {
  const frequency = QUIET_TONE_BASE_HZ + tone * QUIET_TONE_SPACING_HZ;
  TONE_COEFF[tone] = 2 * Math.cos(2 * Math.PI * frequency / SAMPLE_RATE);
}

let diagnostic = new Float32Array(0);
let samplesSinceReport = 0;

function sendPacket(packet) {
  const block = packet.block.slice();
  postMessage({ type: "packet", packet: { ...packet, block: block.buffer } }, [block.buffer]);
}

function toneDb(samples, offset, tone) {
  const coeff = TONE_COEFF[tone];
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < WINDOW_SAMPLES; i++) {
    const s0 = samples[offset + i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2);
  const amplitude = 2 * Math.sqrt(power) / WINDOW_SAMPLES;
  return 20 * Math.log10(Math.max(1e-8, amplitude));
}
function bandMaxDb(samples, firstTone, lastTone) {
  let best = -160;
  for (let offset = 0; offset + WINDOW_SAMPLES <= samples.length; offset += WINDOW_STEP) {
    for (let tone = firstTone; tone <= lastTone; tone++) {
      best = Math.max(best, toneDb(samples, offset, tone));
    }
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
  postMessage({
    type: "spectrum",
    levels: [
      bandMaxDb(diagnostic, 0, 1),
      bandMaxDb(diagnostic, 2, 3),
      bandMaxDb(diagnostic, 4, 7)
    ]
  });
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
