import { FastScanner } from "./fast-modem.js";

const SAMPLE_RATE = 48000;
const CHIRP_SAMPLES = 4096;
const GUARD_SAMPLES = 2048;
const SYMBOL_SAMPLES = 2048 + 96;
const DATA_SYMBOLS = 64;
const FRAME_SAMPLES = CHIRP_SAMPLES + GUARD_SAMPLES + (2 + DATA_SYMBOLS) * SYMBOL_SAMPLES;
const DECODE_MARGIN = 2048;
const ACQUIRE_THRESHOLD = 0.08;

function makeChirp() {
  const out = new Float32Array(CHIRP_SAMPLES);
  const duration = CHIRP_SAMPLES / SAMPLE_RATE;
  const f0 = 2000;
  const f1 = 16000;
  for (let i = 0; i < out.length; i++) {
    const t = i / SAMPLE_RATE;
    const phase = 2 * Math.PI * (f0 * t + 0.5 * (f1 - f0) * t * t / duration);
    const edge = 128;
    let env = 1;
    if (i < edge) env = 0.5 - 0.5 * Math.cos(Math.PI * i / edge);
    else if (i >= out.length - edge) env = 0.5 - 0.5 * Math.cos(Math.PI * (out.length - 1 - i) / edge);
    out[i] = Math.sin(phase) * env;
  }
  return out;
}
const CHIRP = makeChirp();
let chirpEnergy = 0;
let chirpEnergyCoarse = 0;
for (let i = 0; i < CHIRP.length; i++) {
  chirpEnergy += CHIRP[i] * CHIRP[i];
  if ((i & 3) === 0) chirpEnergyCoarse += CHIRP[i] * CHIRP[i];
}
function chirpScore(samples, offset, stride = 1) {
  let dot = 0;
  let energy = 0;
  for (let i = 0; i < CHIRP_SAMPLES; i += stride) {
    const value = samples[offset + i];
    dot += value * CHIRP[i];
    energy += value * value;
  }
  if (energy < 1e-8) return 0;
  const reference = stride === 4 ? chirpEnergyCoarse : chirpEnergy;
  return Math.abs(dot) / Math.sqrt(Math.max(1e-20, energy * reference));
}

let pending = new Float32Array(0);
let scan = 0;
let decodedAttempt = false;
const scanner = new FastScanner((packets) => {
  decodedAttempt = true;
  const transfers = [];
  const serialized = packets.map((packet) => {
    const block = packet.block.slice();
    transfers.push(block.buffer);
    return { ...packet, block: block.buffer };
  });
  postMessage({ type: "packets", packets: serialized }, transfers);
});

function appendPending(chunk) {
  const joined = new Float32Array(pending.length + chunk.length);
  joined.set(pending, 0);
  joined.set(chunk, pending.length);
  pending = joined;
  processPending();
}
function trimPrefix(count) {
  if (count <= 0) return;
  pending = pending.slice(count);
  scan = Math.max(0, scan - count);
}
function processPending() {
  while (pending.length - scan >= FRAME_SAMPLES + DECODE_MARGIN) {
    const maxCandidate = pending.length - FRAME_SAMPLES - DECODE_MARGIN;
    let bestOffset = -1;
    let bestScore = 0;
    for (let offset = scan; offset <= maxCandidate; offset += 16) {
      const score = chirpScore(pending, offset, 4);
      if (score > bestScore) {
        bestScore = score;
        bestOffset = offset;
      }
    }
    if (bestScore < ACQUIRE_THRESHOLD) {
      const keepFrom = Math.max(0, maxCandidate - CHIRP_SAMPLES);
      trimPrefix(keepFrom);
      return;
    }
    let refined = bestOffset;
    let refinedScore = bestScore;
    for (let offset = Math.max(scan, bestOffset - 32); offset <= Math.min(maxCandidate, bestOffset + 32); offset++) {
      const score = chirpScore(pending, offset, 1);
      if (score > refinedScore) {
        refinedScore = score;
        refined = offset;
      }
    }

    // FastScanner's original streaming gate is intentionally conservative.
    // Once this lower-cost front end has found the chirp, replace only the
    // captured chirp in the private decode copy with the exact reference. The
    // OFDM body remains untouched; CRC-valid Cyrinx blocks are still the only
    // data that can leave the worker.
    const segment = pending.slice(refined, refined + FRAME_SAMPLES + DECODE_MARGIN);
    for (let i = 0; i < CHIRP_SAMPLES; i++) segment[i] = CHIRP[i] * 0.18;
    decodedAttempt = false;
    scanner.reset();
    scanner.append(segment);
    if (decodedAttempt) {
      trimPrefix(refined + FRAME_SAMPLES);
      scan = 0;
      continue;
    }
    scan = refined + 512;
    if (scan > FRAME_SAMPLES) trimPrefix(scan - CHIRP_SAMPLES);
  }
}

self.onmessage = (event) => {
  const message = event.data;
  if (message?.type === "samples" && message.samples instanceof ArrayBuffer) {
    appendPending(new Float32Array(message.samples));
  } else if (message?.type === "reset") {
    pending = new Float32Array(0);
    scan = 0;
    scanner.reset();
  }
};
