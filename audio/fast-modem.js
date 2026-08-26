/*
 * Cyrinx-derived wideband Fast PHY for AirGapper.
 * Physical-layer design follows Cyrinx 2.0 (Primatech Paper Co LLC,
 * David E. Weekly and contributors), Apache-2.0.
 */
import { codingMode, RAPTOR_PACKET_ID_BYTES } from "../shared/coding-mode.js";
import { crc32 } from "../shared/protocol.js";

const SAMPLE_RATE = 48000;
const NFFT = 2048;
const CP = 96;
const SYMBOL_SAMPLES = NFFT + CP;
const CHIRP_SAMPLES = 4096;
const GUARD_SAMPLES = 2048;
const INTER_FRAME_GAP = 12000;
const F_LO = 1100;
const F_HI = 18000;
const BIN_HZ = SAMPLE_RATE / NFFT;
const BIN_LO = Math.ceil(F_LO / BIN_HZ);
const BIN_HI = Math.floor(F_HI / BIN_HZ);
const USED_COUNT = BIN_HI - BIN_LO + 1;
const PILOT_EVERY = 16;
const PILOT_COUNT = Math.floor((USED_COUNT - 1) / PILOT_EVERY) + 1;
const DATA_COUNT = USED_COUNT - PILOT_COUNT;
const BITS_PER_BIN = 6;
const BITS_PER_SYMBOL = DATA_COUNT * BITS_PER_BIN;
const DATA_SYMBOLS = 64;
const CAP_BITS = BITS_PER_SYMBOL * DATA_SYMBOLS;
const INFO_BITS = Math.floor(CAP_BITS * 2 / 3) - 6;
const PHY_PAYLOAD_BYTES = 256;
const PHY_CRC_BYTES = 4;
const PHY_BLOCK_BYTES = PHY_PAYLOAD_BYTES + PHY_CRC_BYTES;
const PHY_BLOCKS = Math.floor(INFO_BITS / (PHY_BLOCK_BYTES * 8));
const FRAME_SAMPLES = CHIRP_SAMPLES + GUARD_SAMPLES + (2 + DATA_SYMBOLS) * SYMBOL_SAMPLES;
const TX_FRAME_SAMPLES = FRAME_SAMPLES + INTER_FRAME_GAP;
const AUDIO_BLOCK_SIZE = 260;
const MAX_AUDIO_BYTES = 1024 * 1024;
const FAST_HEADER_BLOCKS = new Set([0, Math.floor(PHY_BLOCKS / 2)]);
const DATA_SLOT_INDEXES = Array.from({ length: PHY_BLOCKS }, (_, i) => i).filter((i) => !FAST_HEADER_BLOCKS.has(i));
const FAST_PACKETS_PER_FRAME = Math.floor(DATA_SLOT_INDEXES.length * PHY_PAYLOAD_BYTES / AUDIO_BLOCK_SIZE);
const FAST_ESTIMATED_KBPS = FAST_PACKETS_PER_FRAME * (AUDIO_BLOCK_SIZE - RAPTOR_PACKET_ID_BYTES) /
  (TX_FRAME_SAMPLES / SAMPLE_RATE) / 1024;
const MAGIC = new Uint8Array([0x41, 0x47, 0x46, 0x32]); // AGF2
const MODE_NAMES = ["direct", "mds", "raptorq"];
const MODE_CODES = new Map(MODE_NAMES.map((mode, i) => [mode, i]));
const PUNCTURE = new Uint8Array([1, 1, 0, 1]);
const G0 = 0x79;
const G1 = 0x5b;
const MASK64 = (1n << 64n) - 1n;
const SQRT42 = Math.sqrt(42);
const QAM_LEVELS = new Float64Array([-7, -5, -3, -1, 1, 3, 5, 7].map((v) => v / SQRT42));
const QAM_GRAY = new Uint8Array([0, 1, 3, 2, 6, 7, 5, 4]);
const QAM_ORDER = new Uint8Array([0, 1, 3, 2, 7, 6, 4, 5]);
const CHIRP_SYNC_THRESHOLD = 0.24;

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}
function parity(value) {
  value ^= value >>> 4;
  value ^= value >>> 2;
  value ^= value >>> 1;
  return value & 1;
}
function modeSourceSize(mode) {
  return mode === "raptorq" ? AUDIO_BLOCK_SIZE - RAPTOR_PACKET_ID_BYTES : AUDIO_BLOCK_SIZE;
}
function sourceCount(totalLen, mode) {
  return Math.max(1, Math.ceil(totalLen / modeSourceSize(mode)));
}
function scheduledId(mode, ordinal) {
  if (mode === "direct") return 0;
  if (mode === "mds") return ordinal % 256;
  return ordinal % 0xff0000;
}

class DetRng {
  constructor(seed) {
    this.s = BigInt(seed) & MASK64;
  }
  u64() {
    this.s = (this.s + 0x9e3779b97f4a7c15n) & MASK64;
    let z = this.s;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
    return (z ^ (z >> 31n)) & MASK64;
  }
  mod(value) {
    return Number(this.u64() % BigInt(value));
  }
  bit() {
    return Number(this.u64() >> 63n);
  }
}
function prbsBits(count, seed) {
  const rng = new DetRng(seed);
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) out[i] = rng.bit();
  return out;
}
let interleavePermutation = null;
function getInterleavePermutation() {
  if (interleavePermutation) return interleavePermutation;
  const out = new Int32Array(CAP_BITS);
  for (let i = 0; i < out.length; i++) out[i] = i;
  const rng = new DetRng(0x1eaf);
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.mod(i + 1);
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  interleavePermutation = out;
  return out;
}

function bytesToBits(bytes) {
  const out = new Uint8Array(bytes.length * 8);
  let write = 0;
  for (const value of bytes) {
    for (let bit = 7; bit >= 0; bit--) out[write++] = value >>> bit & 1;
  }
  return out;
}
function bitsToBytes(bits, byteLength) {
  const out = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength * 8; i++) out[i >>> 3] |= bits[i] << (7 - (i & 7));
  return out;
}
function convolutionalEncode(info) {
  const out = new Uint8Array((info.length + 6) * 2);
  let state = 0;
  let write = 0;
  for (let i = 0; i < info.length + 6; i++) {
    const bit = i < info.length ? info[i] : 0;
    const reg = bit << 6 | state;
    out[write++] = parity(reg & G0);
    out[write++] = parity(reg & G1);
    state = reg >> 1;
  }
  return out;
}
function puncture(coded) {
  const out = new Uint8Array(CAP_BITS);
  let write = 0;
  for (let i = 0; i < coded.length && write < out.length; i++) {
    if (PUNCTURE[i & 3]) out[write++] = coded[i];
  }
  return out;
}
function depuncture(llr) {
  const fullLength = (INFO_BITS + 6) * 2;
  const out = new Float32Array(fullLength);
  let read = 0;
  for (let i = 0; i < fullLength; i++) {
    if (PUNCTURE[i & 3]) out[i] = llr[read++] || 0;
  }
  return out;
}

function fft(real, imag, inverse = false) {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
  }
  for (let length = 2; length <= n; length <<= 1) {
    const angle = (inverse ? 2 : -2) * Math.PI / length;
    const wr0 = Math.cos(angle);
    const wi0 = Math.sin(angle);
    for (let base = 0; base < n; base += length) {
      let wr = 1;
      let wi = 0;
      for (let j = 0; j < length / 2; j++) {
        const even = base + j;
        const odd = even + length / 2;
        const tr = real[odd] * wr - imag[odd] * wi;
        const ti = real[odd] * wi + imag[odd] * wr;
        const er = real[even];
        const ei = imag[even];
        real[even] = er + tr;
        imag[even] = ei + ti;
        real[odd] = er - tr;
        imag[odd] = ei - ti;
        const nextWr = wr * wr0 - wi * wi0;
        wi = wr * wi0 + wi * wr0;
        wr = nextWr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      real[i] /= n;
      imag[i] /= n;
    }
  }
}

const PILOT_POSITIONS = [];
const DATA_POSITIONS = [];
for (let pos = 0; pos < USED_COUNT; pos++) {
  if (pos % PILOT_EVERY === 0) PILOT_POSITIONS.push(pos);
  else DATA_POSITIONS.push(pos);
}
function deterministicSymbols(seed, count) {
  const rng = new DetRng(seed);
  const re = new Float64Array(count);
  const im = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const phase = Math.PI / 4 + Math.PI / 2 * rng.mod(4);
    re[i] = Math.cos(phase);
    im[i] = Math.sin(phase);
  }
  return { re, im };
}
const PILOTS = deterministicSymbols(0xbeef, PILOT_COUNT);
const SYNC0 = deterministicSymbols(0x5eed, USED_COUNT);
const SYNC1 = deterministicSymbols(0x5eee, USED_COUNT);

function ofdmSymbolFromUsed(usedRe, usedIm) {
  const real = new Float64Array(NFFT);
  const imag = new Float64Array(NFFT);
  for (let i = 0; i < USED_COUNT; i++) {
    const bin = BIN_LO + i;
    real[bin] = usedRe[i];
    imag[bin] = usedIm[i];
    real[NFFT - bin] = usedRe[i];
    imag[NFFT - bin] = -usedIm[i];
  }
  fft(real, imag, true);
  const out = new Float64Array(SYMBOL_SAMPLES);
  for (let i = 0; i < CP; i++) out[i] = real[NFFT - CP + i];
  out.set(real, CP);
  return out;
}
const SYNC0_TIME = ofdmSymbolFromUsed(SYNC0.re, SYNC0.im);

function qam64(bits, offset) {
  const gi = bits[offset] << 2 | bits[offset + 1] << 1 | bits[offset + 2];
  const gq = bits[offset + 3] << 2 | bits[offset + 4] << 1 | bits[offset + 5];
  return [QAM_LEVELS[QAM_ORDER[gi]], QAM_LEVELS[QAM_ORDER[gq]]];
}
function makeChirp() {
  const out = new Float64Array(CHIRP_SAMPLES);
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

function makeHeader(payloadId, totalLen, mode, startOrdinal, packetCount) {
  const modeCode = MODE_CODES.get(mode);
  if (modeCode === undefined) throw new Error("Unknown Fast transport mode.");
  const out = new Uint8Array(PHY_PAYLOAD_BYTES);
  out.set(MAGIC, 0);
  const view = new DataView(out.buffer);
  out[4] = modeCode;
  out[5] = packetCount;
  view.setUint16(6, AUDIO_BLOCK_SIZE, true);
  view.setUint32(8, payloadId >>> 0, true);
  view.setUint32(12, totalLen >>> 0, true);
  view.setUint32(16, startOrdinal >>> 0, true);
  return out;
}
function buildFastPayload(payloadId, totalLen, mode, startOrdinal, blocks) {
  if (!Number.isInteger(totalLen) || totalLen < 1 || totalLen > MAX_AUDIO_BYTES) throw new Error("Audio payload is too large.");
  if (!Array.isArray(blocks) || !blocks.length || blocks.length > FAST_PACKETS_PER_FRAME) throw new Error("Invalid Fast frame packet count.");
  for (const block of blocks) {
    if (!(block instanceof Uint8Array) || block.length !== AUDIO_BLOCK_SIZE) throw new Error("Unexpected Fast transport block size.");
  }
  const payload = new Uint8Array(PHY_BLOCKS * PHY_PAYLOAD_BYTES);
  const header = makeHeader(payloadId, totalLen, mode, startOrdinal, blocks.length);
  for (const index of FAST_HEADER_BLOCKS) payload.set(header, index * PHY_PAYLOAD_BYTES);
  const flat = new Uint8Array(blocks.length * AUDIO_BLOCK_SIZE);
  for (let i = 0; i < blocks.length; i++) flat.set(blocks[i], i * AUDIO_BLOCK_SIZE);
  let read = 0;
  for (const slot of DATA_SLOT_INDEXES) {
    if (read >= flat.length) break;
    const count = Math.min(PHY_PAYLOAD_BYTES, flat.length - read);
    payload.set(flat.subarray(read, read + count), slot * PHY_PAYLOAD_BYTES);
    read += count;
  }
  return payload;
}
function addPhysicalCrc(payload) {
  const stream = new Uint8Array(PHY_BLOCKS * PHY_BLOCK_BYTES);
  for (let block = 0; block < PHY_BLOCKS; block++) {
    const source = payload.subarray(block * PHY_PAYLOAD_BYTES, (block + 1) * PHY_PAYLOAD_BYTES);
    const offset = block * PHY_BLOCK_BYTES;
    stream.set(source, offset);
    new DataView(stream.buffer).setUint32(offset + PHY_PAYLOAD_BYTES, crc32(source), false);
  }
  return stream;
}

function modulateFastFrame(payloadId, totalLen, mode, startOrdinal, blocks) {
  const payload = buildFastPayload(payloadId, totalLen, mode, startOrdinal, blocks);
  const stream = addPhysicalCrc(payload);
  const streamBits = bytesToBits(stream);
  const info = new Uint8Array(INFO_BITS);
  info.set(streamBits);
  if (streamBits.length < info.length) info.set(prbsBits(info.length - streamBits.length, 7), streamBits.length);
  const punctured = puncture(convolutionalEncode(info));
  const perm = getInterleavePermutation();
  const interleaved = new Uint8Array(CAP_BITS);
  for (let i = 0; i < CAP_BITS; i++) interleaved[perm[i]] = punctured[i];

  const raw = new Float64Array((2 + DATA_SYMBOLS) * SYMBOL_SAMPLES);
  raw.set(ofdmSymbolFromUsed(SYNC0.re, SYNC0.im), 0);
  raw.set(ofdmSymbolFromUsed(SYNC1.re, SYNC1.im), SYMBOL_SAMPLES);
  let bitOffset = 0;
  for (let symbol = 0; symbol < DATA_SYMBOLS; symbol++) {
    const usedRe = new Float64Array(USED_COUNT);
    const usedIm = new Float64Array(USED_COUNT);
    for (let p = 0; p < PILOT_COUNT; p++) {
      const pos = PILOT_POSITIONS[p];
      usedRe[pos] = PILOTS.re[p];
      usedIm[pos] = PILOTS.im[p];
    }
    for (const pos of DATA_POSITIONS) {
      const [re, im] = qam64(interleaved, bitOffset);
      bitOffset += 6;
      usedRe[pos] = re;
      usedIm[pos] = im;
    }
    raw.set(ofdmSymbolFromUsed(usedRe, usedIm), (2 + symbol) * SYMBOL_SAMPLES);
  }

  let sum = 0;
  let sum2 = 0;
  for (const value of raw) {
    sum += value;
    sum2 += value * value;
  }
  const mean = sum / raw.length;
  const sigma = Math.sqrt(Math.max(1e-20, sum2 / raw.length - mean * mean));
  const clip = 3.3 * sigma;
  let peak = 0;
  for (let i = 0; i < raw.length; i++) {
    raw[i] = clamp(raw[i], -clip, clip);
    peak = Math.max(peak, Math.abs(raw[i]));
  }
  const scale = 0.18 / Math.max(peak, 1e-12);
  const waveform = new Float32Array(TX_FRAME_SAMPLES);
  for (let i = 0; i < CHIRP.length; i++) waveform[i] = CHIRP[i] * 0.18;
  const body = CHIRP_SAMPLES + GUARD_SAMPLES;
  for (let i = 0; i < raw.length; i++) waveform[body + i] = raw[i] * scale;
  return waveform;
}

function spectrumAt(samples, bodyOffset) {
  const real = new Float64Array(NFFT);
  const imag = new Float64Array(NFFT);
  for (let i = 0; i < NFFT; i++) real[i] = samples[bodyOffset + i];
  fft(real, imag, false);
  return { real, imag };
}
function chirpScore(samples, offset, stride) {
  let dot = 0;
  let signal = 0;
  let ref = 0;
  for (let i = 0; i < CHIRP_SAMPLES; i += stride) {
    const value = samples[offset + i];
    const expected = CHIRP[i];
    dot += value * expected;
    signal += value * value;
    ref += expected * expected;
  }
  if (signal < 1e-9) return 0;
  return Math.abs(dot) / Math.sqrt(signal * ref);
}
function fineSyncOffset(samples, expected) {
  let best = expected;
  let bestScore = -1;
  const lo = Math.max(0, expected - 400);
  const hi = Math.min(samples.length - SYMBOL_SAMPLES, expected + 400);
  for (let pos = lo; pos <= hi; pos += 2) {
    let dot = 0;
    let energy = 0;
    for (let i = 0; i < SYMBOL_SAMPLES; i += 2) {
      const value = samples[pos + i];
      dot += value * SYNC0_TIME[i];
      energy += value * value;
    }
    const score = Math.abs(dot) / Math.sqrt(Math.max(1e-20, energy));
    if (score > bestScore) {
      bestScore = score;
      best = pos;
    }
  }
  const coarse = best;
  for (let pos = Math.max(lo, coarse - 2); pos <= Math.min(hi, coarse + 2); pos++) {
    let dot = 0;
    let energy = 0;
    for (let i = 0; i < SYMBOL_SAMPLES; i++) {
      const value = samples[pos + i];
      dot += value * SYNC0_TIME[i];
      energy += value * value;
    }
    const score = Math.abs(dot) / Math.sqrt(Math.max(1e-20, energy));
    if (score > bestScore) {
      bestScore = score;
      best = pos;
    }
  }
  return best;
}
function smoothNoise(values) {
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let sum = 0;
    for (let j = -4; j <= 4; j++) {
      const at = i + j;
      if (at >= 0 && at < values.length) sum += values[at];
    }
    out[i] = sum / 9 + 1e-12;
  }
  return out;
}
function percentile90(values) {
  const ordered = Array.from(values, (v) => Number.isFinite(v) && v > 0 ? v : 0).sort((a, b) => a - b);
  const index = (ordered.length - 1) * 0.9;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  const fraction = index - lo;
  return ordered[lo] * (1 - fraction) + ordered[hi] * fraction;
}
function pilotWeights(snr, pilotPositions) {
  const selected = new Float64Array(pilotPositions.length);
  for (let i = 0; i < selected.length; i++) selected[i] = snr[pilotPositions[i]];
  const cap = Math.max(0.1, percentile90(selected));
  let mean = 0;
  for (let i = 0; i < selected.length; i++) {
    selected[i] = clamp(Number.isFinite(selected[i]) && selected[i] > 0 ? selected[i] : 0, 0.1, cap);
    mean += selected[i];
  }
  mean /= selected.length;
  for (let i = 0; i < selected.length; i++) selected[i] /= Math.max(mean, 1e-12);
  return selected;
}
function fitPilotPhase(er, ei, weights) {
  const count = er.length;
  const wr = new Float64Array(count);
  const wi = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const mag = Math.hypot(er[i], ei[i]);
    if (Number.isFinite(mag) && mag > 1e-12) {
      wr[i] = er[i] / mag;
      wi[i] = ei[i] / mag;
    }
  }
  let slopeTotal = 0;
  for (let pass = 0; pass < 3; pass++) {
    let sr = 0;
    let si = 0;
    for (let i = 1; i < count; i++) {
      const pairWeight = weights[i] * weights[i - 1] / Math.max(weights[i] + weights[i - 1], 1e-12);
      sr += pairWeight * (wr[i] * wr[i - 1] + wi[i] * wi[i - 1]);
      si += pairWeight * (wi[i] * wr[i - 1] - wr[i] * wi[i - 1]);
    }
    const slope = Math.atan2(si, sr) / PILOT_EVERY;
    slopeTotal += slope;
    for (let i = 0; i < count; i++) {
      const angle = -slope * i * PILOT_EVERY;
      const cr = Math.cos(angle);
      const ci = Math.sin(angle);
      const nr = wr[i] * cr - wi[i] * ci;
      const ni = wr[i] * ci + wi[i] * cr;
      wr[i] = nr;
      wi[i] = ni;
    }
  }
  let sr = 0;
  let si = 0;
  for (let i = 0; i < count; i++) {
    sr += weights[i] * wr[i];
    si += weights[i] * wi[i];
  }
  return { slope: slopeTotal, cpe: Math.atan2(si, sr) };
}
function smoothPilotResidual(values) {
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let sum = 0;
    for (let j = -5; j <= 5; j++) sum += values[clamp(i + j, 0, values.length - 1)];
    out[i] = sum / 11;
  }
  return out;
}
function localPilotResidual(smoothed, usedPosition) {
  const left = Math.floor(usedPosition / PILOT_EVERY);
  if (left >= smoothed.length - 1) return smoothed[smoothed.length - 1];
  const fraction = (usedPosition - left * PILOT_EVERY) / PILOT_EVERY;
  return smoothed[left] * (1 - fraction) + smoothed[left + 1] * fraction;
}
function qamAxisLlrs(value, n0, out, offset) {
  for (let bit = 0; bit < 3; bit++) {
    let d0 = Infinity;
    let d1 = Infinity;
    for (let level = 0; level < 8; level++) {
      const d = value - QAM_LEVELS[level];
      const d2 = d * d;
      const one = QAM_GRAY[level] >> (2 - bit) & 1;
      if (one) d1 = Math.min(d1, d2);
      else d0 = Math.min(d0, d2);
    }
    out[offset + bit] = clamp((d1 - d0) / Math.max(n0, 1e-9), -32, 32);
  }
}
function viterbiDecode(llrFull) {
  const steps = INFO_BITS + 6;
  const back = new Uint8Array(steps * 64);
  let metrics = new Float64Array(64);
  let next = new Float64Array(64);
  metrics.fill(-1e30);
  metrics[0] = 0;
  for (let step = 0; step < steps; step++) {
    const l0 = llrFull[step * 2];
    const l1 = llrFull[step * 2 + 1];
    for (let target = 0; target < 64; target++) {
      const input = target >>> 5;
      const source0 = (target & 31) << 1;
      const source1 = source0 | 1;
      const reg0 = input << 6 | source0;
      const reg1 = input << 6 | source1;
      const branch0 = (parity(reg0 & G0) ? -l0 : l0) * 0.5 + (parity(reg0 & G1) ? -l1 : l1) * 0.5;
      const branch1 = (parity(reg1 & G0) ? -l0 : l0) * 0.5 + (parity(reg1 & G1) ? -l1 : l1) * 0.5;
      const m0 = metrics[source0] + branch0;
      const m1 = metrics[source1] + branch1;
      if (m1 > m0) {
        next[target] = m1;
        back[step * 64 + target] = 1;
      } else {
        next[target] = m0;
        back[step * 64 + target] = 0;
      }
    }
    [metrics, next] = [next, metrics];
  }
  const decoded = new Uint8Array(INFO_BITS);
  let state = 0;
  for (let step = steps - 1; step >= 0; step--) {
    if (step < INFO_BITS) decoded[step] = state >>> 5;
    const low = back[step * 64 + state];
    state = (state & 31) << 1 | low;
  }
  return decoded;
}

function parseHeader(payload, valid, index) {
  if (!valid[index]) return null;
  const offset = index * PHY_PAYLOAD_BYTES;
  for (let i = 0; i < MAGIC.length; i++) if (payload[offset + i] !== MAGIC[i]) return null;
  const view = new DataView(payload.buffer, payload.byteOffset + offset, PHY_PAYLOAD_BYTES);
  const mode = MODE_NAMES[payload[offset + 4]];
  const packetCount = payload[offset + 5];
  const blockSize = view.getUint16(6, true);
  const payloadId = view.getUint32(8, true) >>> 0;
  const totalLen = view.getUint32(12, true);
  const startOrdinal = view.getUint32(16, true) >>> 0;
  if (!mode || blockSize !== AUDIO_BLOCK_SIZE || packetCount < 1 || packetCount > FAST_PACKETS_PER_FRAME) return null;
  if (totalLen < 1 || totalLen > MAX_AUDIO_BYTES) return null;
  const k = sourceCount(totalLen, mode);
  if (codingMode(k) !== mode) return null;
  return { mode, packetCount, payloadId, totalLen, startOrdinal };
}
function unpackTransportPackets(payload, valid) {
  let header = null;
  for (const index of FAST_HEADER_BLOCKS) {
    header = parseHeader(payload, valid, index);
    if (header) break;
  }
  if (!header) return [];
  const flatLength = DATA_SLOT_INDEXES.length * PHY_PAYLOAD_BYTES;
  const flat = new Uint8Array(flatLength);
  const present = new Uint8Array(flatLength);
  let cursor = 0;
  for (const slot of DATA_SLOT_INDEXES) {
    if (valid[slot]) {
      flat.set(payload.subarray(slot * PHY_PAYLOAD_BYTES, (slot + 1) * PHY_PAYLOAD_BYTES), cursor);
      present.fill(1, cursor, cursor + PHY_PAYLOAD_BYTES);
    }
    cursor += PHY_PAYLOAD_BYTES;
  }
  const packets = [];
  for (let i = 0; i < header.packetCount; i++) {
    const start = i * AUDIO_BLOCK_SIZE;
    const end = start + AUDIO_BLOCK_SIZE;
    let complete = true;
    for (let p = start; p < end; p++) {
      if (!present[p]) {
        complete = false;
        break;
      }
    }
    if (!complete) continue;
    packets.push({
      payloadId: header.payloadId,
      totalLen: header.totalLen,
      mode: header.mode,
      encodingId: scheduledId(header.mode, header.startOrdinal + i),
      blockSize: AUDIO_BLOCK_SIZE,
      block: flat.slice(start, end),
      profile: "fast"
    });
  }
  return packets;
}

function decodeFastFrame(samples, chirpOffset) {
  const expectedSync = chirpOffset + CHIRP_SAMPLES + GUARD_SAMPLES;
  let base = fineSyncOffset(samples, expectedSync) - 24;
  if (base < 0 || base + (2 + DATA_SYMBOLS) * SYMBOL_SAMPLES > samples.length) return [];

  const syncSpectra = [spectrumAt(samples, base + CP), spectrumAt(samples, base + SYMBOL_SAMPLES + CP)];
  const hRe = new Float64Array(USED_COUNT);
  const hIm = new Float64Array(USED_COUNT);
  const nvRaw = new Float64Array(USED_COUNT);
  for (let pos = 0; pos < USED_COUNT; pos++) {
    const bin = BIN_LO + pos;
    const x0r = SYNC0.re[pos], x0i = SYNC0.im[pos];
    const x1r = SYNC1.re[pos], x1i = SYNC1.im[pos];
    const y0r = syncSpectra[0].real[bin], y0i = syncSpectra[0].imag[bin];
    const y1r = syncSpectra[1].real[bin], y1i = syncSpectra[1].imag[bin];
    const h0r = y0r * x0r + y0i * x0i;
    const h0i = y0i * x0r - y0r * x0i;
    const h1r = y1r * x1r + y1i * x1i;
    const h1i = y1i * x1r - y1r * x1i;
    hRe[pos] = (h0r + h1r) * 0.5;
    hIm[pos] = (h0i + h1i) * 0.5;
    const dr = h0r - h1r;
    const di = h0i - h1i;
    nvRaw[pos] = (dr * dr + di * di) * 0.5;
  }
  const nv = smoothNoise(nvRaw);
  const snr = new Float64Array(USED_COUNT);
  for (let pos = 0; pos < USED_COUNT; pos++) snr[pos] = (hRe[pos] * hRe[pos] + hIm[pos] * hIm[pos]) / nv[pos];
  const weights = pilotWeights(snr, PILOT_POSITIONS);
  const llrStream = new Float32Array(CAP_BITS);
  let llrWrite = 0;

  for (let symbol = 0; symbol < DATA_SYMBOLS; symbol++) {
    const spectrum = spectrumAt(samples, base + (2 + symbol) * SYMBOL_SAMPLES + CP);
    const zRe = new Float64Array(USED_COUNT);
    const zIm = new Float64Array(USED_COUNT);
    for (let pos = 0; pos < USED_COUNT; pos++) {
      const bin = BIN_LO + pos;
      const yr = spectrum.real[bin];
      const yi = spectrum.imag[bin];
      const hr = hRe[pos];
      const hi = hIm[pos];
      const den = hr * hr + hi * hi + 1e-20;
      zRe[pos] = (yr * hr + yi * hi) / den;
      zIm[pos] = (yi * hr - yr * hi) / den;
    }
    const er = new Float64Array(PILOT_COUNT);
    const ei = new Float64Array(PILOT_COUNT);
    for (let p = 0; p < PILOT_COUNT; p++) {
      const pos = PILOT_POSITIONS[p];
      er[p] = zRe[pos] * PILOTS.re[p] + zIm[pos] * PILOTS.im[p];
      ei[p] = zIm[pos] * PILOTS.re[p] - zRe[pos] * PILOTS.im[p];
    }
    const phase = fitPilotPhase(er, ei, weights);
    for (let pos = 0; pos < USED_COUNT; pos++) {
      const angle = -(phase.cpe + phase.slope * pos);
      const cr = Math.cos(angle);
      const ci = Math.sin(angle);
      const nr = zRe[pos] * cr - zIm[pos] * ci;
      const ni = zRe[pos] * ci + zIm[pos] * cr;
      zRe[pos] = nr;
      zIm[pos] = ni;
    }
    const residual = new Float64Array(PILOT_COUNT);
    let global = 0;
    for (let p = 0; p < PILOT_COUNT; p++) {
      const pos = PILOT_POSITIONS[p];
      const rr = zRe[pos] * PILOTS.re[p] + zIm[pos] * PILOTS.im[p] - 1;
      const ri = zIm[pos] * PILOTS.re[p] - zRe[pos] * PILOTS.im[p];
      residual[p] = Number.isFinite(rr) && Number.isFinite(ri) ? rr * rr + ri * ri : 1e9;
      global += residual[p];
    }
    global /= PILOT_COUNT;
    const local = smoothPilotResidual(residual);
    for (const pos of DATA_POSITIONS) {
      const n0 = 1 / Math.max(snr[pos], 0.1) + 0.25 * global + 0.75 * localPilotResidual(local, pos);
      qamAxisLlrs(zRe[pos], n0, llrStream, llrWrite);
      qamAxisLlrs(zIm[pos], n0, llrStream, llrWrite + 3);
      llrWrite += 6;
    }
  }

  const perm = getInterleavePermutation();
  const deinterleaved = new Float32Array(CAP_BITS);
  for (let i = 0; i < CAP_BITS; i++) deinterleaved[i] = llrStream[perm[i]];
  const decoded = viterbiDecode(depuncture(deinterleaved));
  const raw = bitsToBytes(decoded, PHY_BLOCKS * PHY_BLOCK_BYTES);
  const payload = new Uint8Array(PHY_BLOCKS * PHY_PAYLOAD_BYTES);
  const valid = new Uint8Array(PHY_BLOCKS);
  for (let block = 0; block < PHY_BLOCKS; block++) {
    const sourceOffset = block * PHY_BLOCK_BYTES;
    const blockPayload = raw.subarray(sourceOffset, sourceOffset + PHY_PAYLOAD_BYTES);
    const stored = new DataView(raw.buffer, raw.byteOffset + sourceOffset + PHY_PAYLOAD_BYTES, 4).getUint32(0, false);
    if (stored === crc32(blockPayload)) valid[block] = 1;
    payload.set(blockPayload, block * PHY_PAYLOAD_BYTES);
  }
  return unpackTransportPackets(payload, valid);
}

class FastScanner {
  constructor(onPackets) {
    this.onPackets = onPackets;
    this.samples = new Float32Array(524288);
    this.length = 0;
    this.scan = 0;
  }
  append(chunk) {
    if (!chunk?.length) return;
    if (this.length + chunk.length > this.samples.length) {
      const grown = new Float32Array(Math.max(this.samples.length * 2, this.length + chunk.length));
      grown.set(this.samples.subarray(0, this.length));
      this.samples = grown;
    }
    this.samples.set(chunk, this.length);
    this.length += chunk.length;
    this.process();
  }
  process() {
    while (true) {
      const maxCandidate = this.length - FRAME_SAMPLES;
      if (maxCandidate < this.scan) return;
      let bestOffset = -1;
      let bestScore = 0;
      for (let offset = this.scan; offset <= maxCandidate; offset += 32) {
        const score = chirpScore(this.samples, offset, 16);
        if (score > bestScore) {
          bestScore = score;
          bestOffset = offset;
        }
      }
      if (bestScore < CHIRP_SYNC_THRESHOLD) {
        this.scan = Math.max(this.scan, maxCandidate - CHIRP_SAMPLES);
        this.compact();
        return;
      }
      let refined = bestOffset;
      let refinedScore = bestScore;
      for (let offset = Math.max(this.scan, bestOffset - 64); offset <= Math.min(maxCandidate, bestOffset + 64); offset += 2) {
        const score = chirpScore(this.samples, offset, 4);
        if (score > refinedScore) {
          refinedScore = score;
          refined = offset;
        }
      }
      const packets = decodeFastFrame(this.samples, refined);
      if (packets.length) this.onPackets(packets);
      this.scan = refined + FRAME_SAMPLES;
      this.compact();
    }
  }
  compact() {
    if (this.scan < 262144) return;
    const keepFrom = Math.max(0, this.scan - CHIRP_SAMPLES);
    this.samples.copyWithin(0, keepFrom, this.length);
    this.length -= keepFrom;
    this.scan -= keepFrom;
  }
  reset() {
    this.length = 0;
    this.scan = 0;
  }
}

export {
  FAST_ESTIMATED_KBPS,
  FAST_PACKETS_PER_FRAME,
  FastScanner,
  modulateFastFrame
};
