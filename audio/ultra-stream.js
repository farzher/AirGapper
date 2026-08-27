import { codingMode, RAPTOR_PACKET_ID_BYTES } from "../shared/coding-mode.js";
import { crc32 } from "../shared/protocol.js";

const SAMPLE_RATE = 48000;
const SYMBOL_SAMPLES = 384; // 8 ms
const TONE_COUNT = 32;
const BITS_PER_SYMBOL = 5;
const BASE_HZ = 1500;
const TONE_SPACING_HZ = SAMPLE_RATE / SYMBOL_SAMPLES; // orthogonal tone spacing
const TONE_FADE_SAMPLES = 16;
const SYNC_SAMPLES = 1024; // 21.3 ms each, up + down chirp
const SYNC_START_HZ = 1350;
const SYNC_END_HZ = 4300;
const SYNC_FADE_SAMPLES = 48;
const AMPLITUDE = 0.92;
const ACQUIRE_STEP = 16;
const ACQUIRE_THRESHOLD = 0.085;
const SYNC2_THRESHOLD = 0.070;
const SYNC_SEARCH = 32;
const DATA_TIMING_SEARCH = 8;
const DATA_TIMING_STEP = 8;
const ULTRA_AUDIO_BLOCK_SIZE = 24;
const ULTRA_PACKETS_PER_FRAME = 1;
const MAGIC0 = 0xa7;
const MAGIC1 = 0x5d;
const FRAME_HEADER_BYTES = 13;
const FRAME_CRC_BYTES = 4;
const MAX_AUDIO_BYTES = 1024 * 1024;
const MODE_NAMES = ["direct", "mds", "raptorq"];
const MODE_CODES = new Map(MODE_NAMES.map((mode, index) => [mode, index]));
const TAIL_BITS = 6;
const FRAME_BYTES = FRAME_HEADER_BYTES + ULTRA_AUDIO_BLOCK_SIZE + FRAME_CRC_BYTES;
const INFO_BITS = FRAME_BYTES * 8;
const CODED_BITS = (INFO_BITS + TAIL_BITS) * 2;
const DATA_SYMBOLS = Math.ceil(CODED_BITS / BITS_PER_SYMBOL);
const SLOT_BITS = DATA_SYMBOLS * BITS_PER_SYMBOL;
const FRAME_SAMPLES = SYNC_SAMPLES * 2 + DATA_SYMBOLS * SYMBOL_SAMPLES;
const ULTRA_FRAME_MS = FRAME_SAMPLES / SAMPLE_RATE * 1000;
const ULTRA_ESTIMATED_KBPS = (ULTRA_AUDIO_BLOCK_SIZE - RAPTOR_PACKET_ID_BYTES) /
  (FRAME_SAMPLES / SAMPLE_RATE) / 1024;

function clamp(value, low, high) { return Math.max(low, Math.min(high, value)); }
function parity(value) { value ^= value >>> 4; value ^= value >>> 2; value ^= value >>> 1; return value & 1; }
function nextRandom(state) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; }
function randomBits(count, seed) { const out = new Uint8Array(count); let state = (seed >>> 0) || 0x9e3779b9; for (let i = 0; i < count; i++) { state = nextRandom(state); out[i] = state >>> 31; } return out; }
function bytesToBits(bytes) { const out = new Uint8Array(bytes.length * 8); let write = 0; for (const value of bytes) for (let bit = 7; bit >= 0; bit--) out[write++] = value >>> bit & 1; return out; }
function bitsToBytes(bits, byteLength) { const out = new Uint8Array(byteLength); for (let i = 0; i < byteLength * 8; i++) out[i >>> 3] |= (bits[i] > 0 ? 1 : 0) << (7 - (i & 7)); return out; }
function convolutionalEncode(info) { const out = new Uint8Array((info.length + TAIL_BITS) * 2); let state = 0, write = 0; for (let step = 0; step < info.length + TAIL_BITS; step++) { const input = step < info.length ? info[step] : 0; const register = input << 6 | state; out[write++] = parity(register & 0x79); out[write++] = parity(register & 0x5b); state = register >> 1; } return out; }
function softBitCost(expected, observation) { const soft = clamp(Number(observation) || 0, -1, 1); return expected ? (1 - soft) * 0.5 : (1 + soft) * 0.5; }
function convolutionalDecode(codedSoft) { const steps = INFO_BITS + TAIL_BITS; const infinity = 1e30; let metrics = new Float64Array(64), next = new Float64Array(64); metrics.fill(infinity); metrics[0] = 0; const previousState = new Uint8Array(steps * 64); const previousBit = new Uint8Array(steps * 64); let read = 0; for (let step = 0; step < steps; step++) { const a = codedSoft[read++], b = codedSoft[read++]; next.fill(infinity); for (let state = 0; state < 64; state++) { const base = metrics[state]; if (base >= infinity) continue; for (let input = 0; input < 2; input++) { const register = input << 6 | state; const target = register >> 1; const metric = base + softBitCost(parity(register & 0x79), a) + softBitCost(parity(register & 0x5b), b); if (metric >= next[target]) continue; next[target] = metric; const index = step * 64 + target; previousState[index] = state; previousBit[index] = input; } } [metrics, next] = [next, metrics]; } const decoded = new Uint8Array(INFO_BITS); let state = 0; for (let step = steps - 1; step >= 0; step--) { const index = step * 64 + state; if (step < INFO_BITS) decoded[step] = previousBit[index]; state = previousState[index]; } return decoded; }
function gcd(a, b) { while (b) [a, b] = [b, a % b]; return Math.abs(a) || 1; }
function interleaveStep(capacity) { let step = 257; while (gcd(step, capacity) !== 1) step += 2; return step; }
const INTERLEAVE_STEP = interleaveStep(SLOT_BITS);
const CODED_SLOTS = new Uint16Array(CODED_BITS);
for (let i = 0; i < CODED_BITS; i++) CODED_SLOTS[i] = i * INTERLEAVE_STEP % SLOT_BITS;
const SCRAMBLE = randomBits(INFO_BITS, 0x6d2b79f5);
const HOPS = new Uint8Array(DATA_SYMBOLS);
{
  let state = 0x243f6a88;
  for (let i = 0; i < HOPS.length; i++) { state = nextRandom(state); HOPS[i] = state & 31; }
}
function modeSourceSize(mode) { return mode === "raptorq" ? ULTRA_AUDIO_BLOCK_SIZE - RAPTOR_PACKET_ID_BYTES : ULTRA_AUDIO_BLOCK_SIZE; }
function sourceCount(totalLen, mode) { return Math.max(1, Math.ceil(totalLen / modeSourceSize(mode))); }
function scheduledId(mode, ordinal) { if (mode === "direct") return 0; if (mode === "mds") return ordinal % 256; return ordinal % 0xff0000; }
function writeUint24(bytes, offset, value) { bytes[offset] = value & 255; bytes[offset + 1] = value >>> 8 & 255; bytes[offset + 2] = value >>> 16 & 255; }
function readUint24(bytes, offset) { return bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16; }
function buildFrameBytes(payloadId, totalLen, mode, ordinal, block) { const modeCode = MODE_CODES.get(mode); if (modeCode === undefined || totalLen < 1 || totalLen > MAX_AUDIO_BYTES) throw new Error("Invalid Reliable transport metadata."); if (!(block instanceof Uint8Array) || block.length !== ULTRA_AUDIO_BLOCK_SIZE) throw new Error("Unexpected Reliable transport block size."); const encodingId = scheduledId(mode, Number(ordinal) >>> 0); const out = new Uint8Array(FRAME_BYTES); out[0] = MAGIC0; out[1] = MAGIC1; const view = new DataView(out.buffer); view.setUint32(2, payloadId >>> 0, true); writeUint24(out, 6, totalLen); out[9] = modeCode; writeUint24(out, 10, encodingId); out.set(block, FRAME_HEADER_BYTES); view.setUint32(FRAME_BYTES - FRAME_CRC_BYTES, crc32(out.subarray(0, FRAME_BYTES - FRAME_CRC_BYTES)), true); return out; }
function parseFrame(info) { const descrambled = new Uint8Array(INFO_BITS); for (let i = 0; i < INFO_BITS; i++) descrambled[i] = (info[i] > 0 ? 1 : 0) ^ SCRAMBLE[i]; const raw = bitsToBytes(descrambled, FRAME_BYTES); if (raw[0] !== MAGIC0 || raw[1] !== MAGIC1) return null; const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength); if (view.getUint32(FRAME_BYTES - FRAME_CRC_BYTES, true) !== crc32(raw.subarray(0, FRAME_BYTES - FRAME_CRC_BYTES))) return null; const payloadId = view.getUint32(2, true) >>> 0; const totalLen = readUint24(raw, 6); const mode = MODE_NAMES[raw[9]]; const encodingId = readUint24(raw, 10); if (!mode || totalLen < 1 || totalLen > MAX_AUDIO_BYTES) return null; const k = sourceCount(totalLen, mode); if (codingMode(k) !== mode) return null; if (mode === "direct" && encodingId !== 0) return null; if (mode === "mds" && encodingId >= 256) return null; if (mode === "raptorq" && encodingId >= 0xff0000) return null; return { payloadId, totalLen, mode, encodingId, blockSize: ULTRA_AUDIO_BLOCK_SIZE, block: raw.slice(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + ULTRA_AUDIO_BLOCK_SIZE), profile: "ultra" }; }
function makeSlots(coded, seed) { const slots = randomBits(SLOT_BITS, seed); for (let i = 0; i < CODED_BITS; i++) slots[CODED_SLOTS[i]] = coded[i]; return slots; }
function recoverCoded(slots) { const coded = new Float32Array(CODED_BITS); for (let i = 0; i < CODED_BITS; i++) coded[i] = slots[CODED_SLOTS[i]]; return coded; }

function fadeEnvelope(i, n, fade) { if (i < fade) return Math.sin(Math.PI * 0.5 * i / fade) ** 2; if (i >= n - fade) return Math.sin(Math.PI * 0.5 * (n - 1 - i) / fade) ** 2; return 1; }
const TONE_COS = Array.from({ length: TONE_COUNT }, () => new Float32Array(SYMBOL_SAMPLES));
const TONE_SIN = Array.from({ length: TONE_COUNT }, () => new Float32Array(SYMBOL_SAMPLES));
const TONE_ENERGY = new Float64Array(TONE_COUNT);
for (let tone = 0; tone < TONE_COUNT; tone++) { const frequency = BASE_HZ + tone * TONE_SPACING_HZ; let energy = 0; for (let i = 0; i < SYMBOL_SAMPLES; i++) { const env = fadeEnvelope(i, SYMBOL_SAMPLES, TONE_FADE_SAMPLES); const phase = 2 * Math.PI * frequency * i / SAMPLE_RATE; const c = Math.cos(phase) * env; const s = Math.sin(phase) * env; TONE_COS[tone][i] = c; TONE_SIN[tone][i] = s; energy += c * c; } TONE_ENERGY[tone] = energy; }
function makeChirp(direction) { const c = new Float32Array(SYNC_SAMPLES), s = new Float32Array(SYNC_SAMPLES); const duration = SYNC_SAMPLES / SAMPLE_RATE; const f0 = direction > 0 ? SYNC_START_HZ : SYNC_END_HZ; const f1 = direction > 0 ? SYNC_END_HZ : SYNC_START_HZ; const rate = (f1 - f0) / duration; let energy = 0; for (let i = 0; i < SYNC_SAMPLES; i++) { const t = i / SAMPLE_RATE; const env = fadeEnvelope(i, SYNC_SAMPLES, SYNC_FADE_SAMPLES); const phase = 2 * Math.PI * (f0 * t + 0.5 * rate * t * t); c[i] = Math.cos(phase) * env; s[i] = Math.sin(phase) * env; energy += c[i] * c[i]; } return { c, s, energy }; }
const SYNC_UP = makeChirp(1), SYNC_DOWN = makeChirp(-1);
function writeTemplate(waveform, offset, template) { for (let i = 0; i < template.length; i++) waveform[offset + i] = template[i] * AMPLITUDE; }
function modulateUltraFrame(payloadId, totalLen, mode, ordinal, blocks) { if (!Array.isArray(blocks) || blocks.length !== 1) throw new Error("Reliable frame packet count mismatch."); const rawBits = bytesToBits(buildFrameBytes(payloadId, totalLen, mode, ordinal, blocks[0])); for (let i = 0; i < INFO_BITS; i++) rawBits[i] ^= SCRAMBLE[i]; const coded = convolutionalEncode(rawBits); const slots = makeSlots(coded, payloadId ^ Math.imul((ordinal >>> 0) + 1, 0x85ebca6b)); const waveform = new Float32Array(FRAME_SAMPLES); writeTemplate(waveform, 0, SYNC_UP.c); writeTemplate(waveform, SYNC_SAMPLES, SYNC_DOWN.c); let read = 0, offset = SYNC_SAMPLES * 2; for (let symbol = 0; symbol < DATA_SYMBOLS; symbol++) { let logical = 0; for (let bit = 0; bit < BITS_PER_SYMBOL; bit++) logical = (logical << 1) | (slots[read++] || 0); const physical = (logical + HOPS[symbol]) & 31; writeTemplate(waveform, offset, TONE_COS[physical]); offset += SYMBOL_SAMPLES; } return waveform; }
function windowEnergy(samples, offset, length) { let energy = 0; for (let i = 0; i < length; i++) { const v = samples[offset + i]; energy += v * v; } return energy; }
function matchedScore(samples, offset, templateCos, templateSin, templateEnergy) { if (offset < 0 || offset + templateCos.length > samples.length) return 0; const energy = windowEnergy(samples, offset, templateCos.length); if (energy < 1e-12) return 0; let iSum = 0, qSum = 0; for (let i = 0; i < templateCos.length; i++) { const sample = samples[offset + i]; iSum += sample * templateCos[i]; qSum += sample * templateSin[i]; } return clamp(Math.hypot(iSum, qSum) / Math.sqrt(energy * templateEnergy), 0, 1); }
function syncScore(samples, offset, sync) { return matchedScore(samples, offset, sync.c, sync.s, sync.energy); }
function toneScoresAt(samples, offset, symbolIndex) { if (offset < 0 || offset + SYMBOL_SAMPLES > samples.length) return null; const energy = windowEnergy(samples, offset, SYMBOL_SAMPLES); if (energy < 1e-12) return null; const physical = new Float32Array(TONE_COUNT); let bestScore = -1, second = -1; for (let tone = 0; tone < TONE_COUNT; tone++) { const tc = TONE_COS[tone], ts = TONE_SIN[tone]; let iSum = 0, qSum = 0; for (let i = 0; i < SYMBOL_SAMPLES; i++) { const sample = samples[offset + i]; iSum += sample * tc[i]; qSum += sample * ts[i]; } const score = clamp(Math.hypot(iSum, qSum) / Math.sqrt(energy * TONE_ENERGY[tone]), 0, 1); physical[tone] = score; if (score > bestScore) { second = bestScore; bestScore = score; } else if (score > second) second = score; } const logical = new Float32Array(TONE_COUNT); const hop = HOPS[symbolIndex]; for (let value = 0; value < TONE_COUNT; value++) logical[value] = physical[(value + hop) & 31]; return { scores: logical, bestScore, secondScore: Math.max(0, second) }; }
function softBitsFromScores(scores, bestScore, secondScore) { const out = new Float32Array(BITS_PER_SYMBOL); const margin = Math.max(0, bestScore - secondScore); const quality = clamp((bestScore + margin * 2 - 0.06) / 0.30, 0.04, 1); for (let bit = 0; bit < BITS_PER_SYMBOL; bit++) { let zero = 0, one = 0; const shift = BITS_PER_SYMBOL - 1 - bit; for (let value = 0; value < TONE_COUNT; value++) { if (value >> shift & 1) one = Math.max(one, scores[value]); else zero = Math.max(zero, scores[value]); } const scale = Math.max(0.03, Math.max(zero, one)); out[bit] = clamp((one - zero) / scale * 2, -1, 1) * quality; } return out; }

class UltraScanner {
  constructor(onPacket, onSignal = () => void 0) {
    this.onPacket = onPacket;
    this.onSignal = onSignal;
    this.samples = new Float32Array(524288);
    this.length = 0;
    this.scan = 0;
    this.dataStart = -1;
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
  acquire() {
    const needed = SYNC_SAMPLES * 2 + SYNC_SEARCH;
    const maxCandidate = this.length - needed;
    if (maxCandidate < this.scan) return false;
    let bestStart = -1, bestScore = 0;
    for (let start = this.scan; start <= maxCandidate; start += ACQUIRE_STEP) {
      const score = syncScore(this.samples, start, SYNC_UP);
      if (score > bestScore) { bestScore = score; bestStart = start; }
    }
    if (bestStart < 0 || bestScore < ACQUIRE_THRESHOLD) {
      this.scan = Math.max(this.scan, maxCandidate - ACQUIRE_STEP);
      this.compact();
      return false;
    }
    const coarse = bestStart;
    for (let start = Math.max(this.scan, coarse - ACQUIRE_STEP); start <= Math.min(maxCandidate, coarse + ACQUIRE_STEP); start += 2) {
      const score = syncScore(this.samples, start, SYNC_UP);
      if (score > bestScore) { bestScore = score; bestStart = start; }
    }
    const downPredicted = bestStart + SYNC_SAMPLES;
    let downBest = -1, downScore = 0;
    for (let start = downPredicted - SYNC_SEARCH; start <= downPredicted + SYNC_SEARCH; start += 2) {
      const score = syncScore(this.samples, start, SYNC_DOWN);
      if (score > downScore) { downScore = score; downBest = start; }
    }
    if (downBest < 0 || downScore < SYNC2_THRESHOLD) {
      this.scan = bestStart + ACQUIRE_STEP;
      return false;
    }
    this.dataStart = downBest + SYNC_SAMPLES;
    this.scan = bestStart;
    this.onSignal(clamp((bestScore + downScore) * 0.75, 0, 1));
    return true;
  }
  decodeFrame() {
    const required = this.dataStart + DATA_SYMBOLS * SYMBOL_SAMPLES + DATA_TIMING_SEARCH;
    if (required > this.length) return false;
    const slots = new Float32Array(SLOT_BITS);
    let write = 0, predicted = this.dataStart, qualityTotal = 0;
    for (let symbol = 0; symbol < DATA_SYMBOLS; symbol++) {
      let best = null;
      for (let delta = -DATA_TIMING_SEARCH; delta <= DATA_TIMING_SEARCH; delta += DATA_TIMING_STEP) {
        const start = predicted + delta;
        const decoded = toneScoresAt(this.samples, start, symbol);
        if (!decoded) continue;
        const margin = Math.max(0, decoded.bestScore - decoded.secondScore);
        const metric = decoded.bestScore + margin * 0.75;
        if (!best || metric > best.metric) best = { ...decoded, start, metric };
      }
      if (!best) {
        for (let bit = 0; bit < BITS_PER_SYMBOL; bit++) slots[write++] = 0;
        predicted += SYMBOL_SAMPLES;
        continue;
      }
      const soft = softBitsFromScores(best.scores, best.bestScore, best.secondScore);
      for (let bit = 0; bit < BITS_PER_SYMBOL; bit++) slots[write++] = soft[bit];
      qualityTotal += best.bestScore;
      predicted = best.start + SYMBOL_SAMPLES;
    }
    const packet = parseFrame(convolutionalDecode(recoverCoded(slots)));
    if (packet) this.onPacket(packet);
    this.onSignal(clamp(qualityTotal / Math.max(1, DATA_SYMBOLS) * 2, 0, 1));
    this.scan = Math.max(this.scan, predicted - SYMBOL_SAMPLES);
    this.dataStart = -1;
    this.compact();
    return true;
  }
  process() {
    while (true) {
      if (this.dataStart < 0 && !this.acquire()) return;
      if (!this.decodeFrame()) return;
    }
  }
  compact() {
    if (this.dataStart >= 0 || this.scan < 262144) return;
    const keepFrom = Math.max(0, this.scan - SYNC_SAMPLES * 2);
    this.samples.copyWithin(0, keepFrom, this.length);
    this.length -= keepFrom;
    this.scan = Math.max(0, this.scan - keepFrom);
  }
  reset() {
    this.length = 0;
    this.scan = 0;
    this.dataStart = -1;
  }
}

export {
  SAMPLE_RATE,
  ULTRA_AUDIO_BLOCK_SIZE,
  ULTRA_ESTIMATED_KBPS,
  ULTRA_FRAME_MS,
  ULTRA_PACKETS_PER_FRAME,
  UltraScanner,
  modulateUltraFrame
};
