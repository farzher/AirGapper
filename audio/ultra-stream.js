import { codingMode, RAPTOR_PACKET_ID_BYTES } from "../shared/coding-mode.js";
import { crc32 } from "../shared/protocol.js";

const SAMPLE_RATE = 48000;
const CHIRP_SAMPLES = 1024;
const GUARD_SAMPLES = 384;
const SYMBOL_SAMPLES = CHIRP_SAMPLES + GUARD_SAMPLES;
const SYMBOL_COUNT = 8;
const BITS_PER_SYMBOL = 3;
const SHIFT_SAMPLES = CHIRP_SAMPLES / SYMBOL_COUNT;
const START_HZ = 1500;
const END_HZ = 7500;
const AMPLITUDE = 0.78;
const FADE_SAMPLES = 64;
const PREAMBLE = new Uint8Array([0, 4, 1, 5, 2, 6]);
const ACQUIRE_STEP = 4;
const ACQUIRE_THRESHOLD = 0.085;
const PREAMBLE_THRESHOLD = 0.055;
const DATA_THRESHOLD = 0.025;
const TIMING_SEARCH = 64;
const TIMING_STEP = 2;
const ULTRA_AUDIO_BLOCK_SIZE = 24;
const ULTRA_PACKETS_PER_FRAME = 1;
const FRAME_HEADER_BYTES = 16;
const FRAME_CRC_BYTES = 4;
const MAX_AUDIO_BYTES = 1024 * 1024;
const MAGIC = new Uint8Array([0x41, 0x47, 0x55, 0x31]); // AGU1
const MODE_NAMES = ["direct", "mds", "raptorq"];
const MODE_CODES = new Map(MODE_NAMES.map((mode, index) => [mode, index]));
const TAIL_BITS = 6;
const FRAME_BYTES = FRAME_HEADER_BYTES + ULTRA_AUDIO_BLOCK_SIZE + FRAME_CRC_BYTES;
const INFO_BITS = FRAME_BYTES * 8;
const CODED_BITS = (INFO_BITS + TAIL_BITS) * 2;
const DATA_SYMBOLS = Math.ceil(CODED_BITS / BITS_PER_SYMBOL);
const SLOT_BITS = DATA_SYMBOLS * BITS_PER_SYMBOL;
const FRAME_SAMPLES = (PREAMBLE.length + DATA_SYMBOLS) * SYMBOL_SAMPLES;
const ULTRA_FRAME_MS = FRAME_SAMPLES / SAMPLE_RATE * 1000;
const ULTRA_ESTIMATED_KBPS = (ULTRA_AUDIO_BLOCK_SIZE - RAPTOR_PACKET_ID_BYTES) /
  (FRAME_SAMPLES / SAMPLE_RATE) / 1024;

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}
function parity(value) {
  value ^= value >>> 4;
  value ^= value >>> 2;
  value ^= value >>> 1;
  return value & 1;
}
function nextRandom(state) {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return state >>> 0;
}
function randomBits(count, seed) {
  const out = new Uint8Array(count);
  let state = (seed >>> 0) || 0x9e3779b9;
  for (let i = 0; i < count; i++) {
    state = nextRandom(state);
    out[i] = state >>> 31;
  }
  return out;
}
function bytesToBits(bytes) {
  const out = new Uint8Array(bytes.length * 8);
  let write = 0;
  for (const value of bytes) for (let bit = 7; bit >= 0; bit--) out[write++] = value >>> bit & 1;
  return out;
}
function bitsToBytes(bits, byteLength) {
  const out = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength * 8; i++) out[i >>> 3] |= bits[i] << (7 - (i & 7));
  return out;
}
function convolutionalEncode(info) {
  const out = new Uint8Array((info.length + TAIL_BITS) * 2);
  let state = 0;
  let write = 0;
  for (let step = 0; step < info.length + TAIL_BITS; step++) {
    const input = step < info.length ? info[step] : 0;
    const register = input << 6 | state;
    out[write++] = parity(register & 0x79);
    out[write++] = parity(register & 0x5b);
    state = register >> 1;
  }
  return out;
}
function softBitCost(expected, observation) {
  const soft = clamp(Number(observation) || 0, -1, 1);
  return expected ? (1 - soft) * 0.5 : (1 + soft) * 0.5;
}
function convolutionalDecode(codedSoft) {
  const steps = INFO_BITS + TAIL_BITS;
  const infinity = 1e30;
  let metrics = new Float64Array(64);
  let next = new Float64Array(64);
  metrics.fill(infinity);
  metrics[0] = 0;
  const previousState = new Uint8Array(steps * 64);
  const previousBit = new Uint8Array(steps * 64);
  let read = 0;
  for (let step = 0; step < steps; step++) {
    const a = codedSoft[read++];
    const b = codedSoft[read++];
    next.fill(infinity);
    for (let state = 0; state < 64; state++) {
      const baseMetric = metrics[state];
      if (baseMetric >= infinity) continue;
      for (let input = 0; input < 2; input++) {
        const register = input << 6 | state;
        const target = register >> 1;
        const metric = baseMetric
          + softBitCost(parity(register & 0x79), a)
          + softBitCost(parity(register & 0x5b), b);
        if (metric >= next[target]) continue;
        next[target] = metric;
        const index = step * 64 + target;
        previousState[index] = state;
        previousBit[index] = input;
      }
    }
    [metrics, next] = [next, metrics];
  }
  const decoded = new Uint8Array(INFO_BITS);
  let state = 0;
  for (let step = steps - 1; step >= 0; step--) {
    const index = step * 64 + state;
    if (step < INFO_BITS) decoded[step] = previousBit[index];
    state = previousState[index];
  }
  return decoded;
}
function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return Math.abs(a) || 1;
}
function interleaveStep(capacity) {
  let step = 257;
  while (gcd(step, capacity) !== 1) step += 2;
  return step;
}
const INTERLEAVE_STEP = interleaveStep(SLOT_BITS);
const CODED_SLOTS = new Uint16Array(CODED_BITS);
for (let i = 0; i < CODED_BITS; i++) CODED_SLOTS[i] = i * INTERLEAVE_STEP % SLOT_BITS;
const SCRAMBLE = randomBits(INFO_BITS, 0x6d2b79f5);

function modeSourceSize(mode) {
  return mode === "raptorq" ? ULTRA_AUDIO_BLOCK_SIZE - RAPTOR_PACKET_ID_BYTES : ULTRA_AUDIO_BLOCK_SIZE;
}
function sourceCount(totalLen, mode) {
  return Math.max(1, Math.ceil(totalLen / modeSourceSize(mode)));
}
function scheduledId(mode, ordinal) {
  if (mode === "direct") return 0;
  if (mode === "mds") return ordinal % 256;
  return ordinal % 0xff0000;
}
function buildFrameBytes(payloadId, totalLen, mode, ordinal, block) {
  const modeCode = MODE_CODES.get(mode);
  if (modeCode === undefined || totalLen < 1 || totalLen > MAX_AUDIO_BYTES) throw new Error("Invalid Reliable transport metadata.");
  if (!(block instanceof Uint8Array) || block.length !== ULTRA_AUDIO_BLOCK_SIZE) throw new Error("Unexpected Reliable transport block size.");
  const out = new Uint8Array(FRAME_BYTES);
  out.set(MAGIC, 0);
  const view = new DataView(out.buffer);
  view.setUint32(4, payloadId >>> 0, true);
  view.setUint32(8, totalLen >>> 0, true);
  out[12] = modeCode;
  const id = Number(ordinal) >>> 0;
  out[13] = id >>> 16 & 255;
  out[14] = id >>> 8 & 255;
  out[15] = id & 255;
  out.set(block, FRAME_HEADER_BYTES);
  view.setUint32(FRAME_BYTES - FRAME_CRC_BYTES, crc32(out.subarray(0, FRAME_BYTES - FRAME_CRC_BYTES)), true);
  return out;
}
function parseFrame(info) {
  const descrambled = new Uint8Array(INFO_BITS);
  for (let i = 0; i < INFO_BITS; i++) descrambled[i] = info[i] ^ SCRAMBLE[i];
  const raw = bitsToBytes(descrambled, FRAME_BYTES);
  for (let i = 0; i < MAGIC.length; i++) if (raw[i] !== MAGIC[i]) return null;
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (view.getUint32(FRAME_BYTES - FRAME_CRC_BYTES, true) !== crc32(raw.subarray(0, FRAME_BYTES - FRAME_CRC_BYTES))) return null;
  const totalLen = view.getUint32(8, true);
  const mode = MODE_NAMES[raw[12]];
  if (!mode || totalLen < 1 || totalLen > MAX_AUDIO_BYTES) return null;
  const k = sourceCount(totalLen, mode);
  if (codingMode(k) !== mode) return null;
  const ordinal = raw[13] * 65536 + raw[14] * 256 + raw[15];
  return {
    payloadId: view.getUint32(4, true) >>> 0,
    totalLen,
    mode,
    encodingId: scheduledId(mode, ordinal),
    blockSize: ULTRA_AUDIO_BLOCK_SIZE,
    block: raw.slice(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + ULTRA_AUDIO_BLOCK_SIZE),
    profile: "ultra"
  };
}
function makeSlots(coded, seed) {
  const slots = randomBits(SLOT_BITS, seed);
  for (let i = 0; i < CODED_BITS; i++) slots[CODED_SLOTS[i]] = coded[i];
  return slots;
}
function recoverCoded(slots) {
  const coded = new Float32Array(CODED_BITS);
  for (let i = 0; i < CODED_BITS; i++) coded[i] = slots[CODED_SLOTS[i]];
  return coded;
}

const TEMPLATE_COS = Array.from({ length: SYMBOL_COUNT }, () => new Float32Array(CHIRP_SAMPLES));
const TEMPLATE_SIN = Array.from({ length: SYMBOL_COUNT }, () => new Float32Array(CHIRP_SAMPLES));
const TEMPLATE_ENERGY = new Float64Array(SYMBOL_COUNT);
const baseCos = new Float64Array(CHIRP_SAMPLES);
const baseSin = new Float64Array(CHIRP_SAMPLES);
const chirpSeconds = CHIRP_SAMPLES / SAMPLE_RATE;
const chirpRate = (END_HZ - START_HZ) / chirpSeconds;
for (let i = 0; i < CHIRP_SAMPLES; i++) {
  const t = i / SAMPLE_RATE;
  const phase = 2 * Math.PI * (START_HZ * t + 0.5 * chirpRate * t * t);
  baseCos[i] = Math.cos(phase);
  baseSin[i] = Math.sin(phase);
}
for (let symbol = 0; symbol < SYMBOL_COUNT; symbol++) {
  const shift = symbol * SHIFT_SAMPLES;
  let energy = 0;
  for (let i = 0; i < CHIRP_SAMPLES; i++) {
    const source = (i + shift) % CHIRP_SAMPLES;
    const fadeIn = Math.min(1, i / FADE_SAMPLES);
    const fadeOut = Math.min(1, (CHIRP_SAMPLES - 1 - i) / FADE_SAMPLES);
    const envelope = Math.sin(Math.PI * 0.5 * Math.max(0, Math.min(fadeIn, fadeOut))) ** 2;
    const c = baseCos[source] * envelope;
    const s = baseSin[source] * envelope;
    TEMPLATE_COS[symbol][i] = c;
    TEMPLATE_SIN[symbol][i] = s;
    energy += c * c;
  }
  TEMPLATE_ENERGY[symbol] = Math.max(1e-9, energy);
}
function writeSymbol(waveform, offset, value) {
  const template = TEMPLATE_COS[value & 7];
  for (let i = 0; i < CHIRP_SAMPLES; i++) waveform[offset + i] = template[i] * AMPLITUDE;
}
function modulateUltraFrame(payloadId, totalLen, mode, ordinal, blocks) {
  if (!Array.isArray(blocks) || blocks.length !== ULTRA_PACKETS_PER_FRAME) throw new Error("Reliable frame packet count mismatch.");
  const rawBits = bytesToBits(buildFrameBytes(payloadId, totalLen, mode, ordinal, blocks[0]));
  for (let i = 0; i < INFO_BITS; i++) rawBits[i] ^= SCRAMBLE[i];
  const coded = convolutionalEncode(rawBits);
  const slots = makeSlots(coded, payloadId ^ Math.imul((ordinal >>> 0) + 1, 0x85ebca6b));
  const waveform = new Float32Array(FRAME_SAMPLES);
  let offset = 0;
  for (const value of PREAMBLE) {
    writeSymbol(waveform, offset, value);
    offset += SYMBOL_SAMPLES;
  }
  let read = 0;
  for (let symbol = 0; symbol < DATA_SYMBOLS; symbol++) {
    const value = (slots[read++] || 0) << 2 | (slots[read++] || 0) << 1 | (slots[read++] || 0);
    writeSymbol(waveform, offset, value);
    offset += SYMBOL_SAMPLES;
  }
  return waveform;
}

function sampleEnergy(samples, offset) {
  let energy = 0;
  for (let i = 0; i < CHIRP_SAMPLES; i++) {
    const sample = samples[offset + i];
    energy += sample * sample;
  }
  return energy;
}
function symbolScore(samples, offset, value, energy = sampleEnergy(samples, offset)) {
  if (offset < 0 || offset + CHIRP_SAMPLES > samples.length || energy < 1e-10) return 0;
  const tc = TEMPLATE_COS[value];
  const ts = TEMPLATE_SIN[value];
  let iSum = 0;
  let qSum = 0;
  for (let i = 0; i < CHIRP_SAMPLES; i++) {
    const sample = samples[offset + i];
    iSum += sample * tc[i];
    qSum += sample * ts[i];
  }
  return clamp(Math.hypot(iSum, qSum) / Math.sqrt(energy * TEMPLATE_ENERGY[value]), 0, 1);
}
function scoresAt(samples, offset) {
  if (offset < 0 || offset + CHIRP_SAMPLES > samples.length) return null;
  const energy = sampleEnergy(samples, offset);
  if (energy < 1e-10) return null;
  const scores = new Float32Array(SYMBOL_COUNT);
  let bestValue = 0;
  let bestScore = -1;
  let secondScore = -1;
  for (let value = 0; value < SYMBOL_COUNT; value++) {
    const score = symbolScore(samples, offset, value, energy);
    scores[value] = score;
    if (score > bestScore) {
      secondScore = bestScore;
      bestScore = score;
      bestValue = value;
    } else if (score > secondScore) {
      secondScore = score;
    }
  }
  return { scores, bestValue, bestScore, secondScore: Math.max(0, secondScore) };
}
function trackExpected(samples, predicted, expected) {
  let bestStart = -1;
  let bestScore = -1;
  const low = Math.max(0, predicted - TIMING_SEARCH);
  const high = Math.min(samples.length - CHIRP_SAMPLES, predicted + TIMING_SEARCH);
  for (let start = low; start <= high; start += TIMING_STEP) {
    const score = symbolScore(samples, start, expected);
    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }
  return bestStart >= 0 ? { start: bestStart, score: bestScore } : null;
}
function trackAny(samples, predicted) {
  let best = null;
  const low = Math.max(0, predicted - TIMING_SEARCH);
  const high = Math.min(samples.length - CHIRP_SAMPLES, predicted + TIMING_SEARCH);
  for (let start = low; start <= high; start += TIMING_STEP) {
    const decoded = scoresAt(samples, start);
    if (!decoded) continue;
    const quality = decoded.bestScore + 0.35 * Math.max(0, decoded.bestScore - decoded.secondScore);
    if (!best || quality > best.quality) best = { start, quality, ...decoded };
  }
  return best;
}
function softBitsFromScores(scores, quality) {
  const out = new Float32Array(BITS_PER_SYMBOL);
  for (let bit = 0; bit < BITS_PER_SYMBOL; bit++) {
    let zero = 0;
    let one = 0;
    const shift = BITS_PER_SYMBOL - 1 - bit;
    for (let value = 0; value < SYMBOL_COUNT; value++) {
      if (value >> shift & 1) one = Math.max(one, scores[value]);
      else zero = Math.max(zero, scores[value]);
    }
    const scale = Math.max(0.035, Math.max(zero, one));
    out[bit] = clamp((one - zero) / scale * 2.2, -1, 1) * quality;
  }
  return out;
}

class UltraScanner {
  constructor(onPacket) {
    this.onPacket = onPacket;
    this.samples = new Float32Array(524288);
    this.length = 0;
    this.scan = 0;
    this.frameStart = -1;
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
  validatePreamble(start) {
    let current = start;
    let correct = 0;
    let quality = 0;
    for (let index = 0; index < PREAMBLE.length; index++) {
      const expected = PREAMBLE[index];
      const tracked = trackExpected(this.samples, current, expected);
      if (!tracked || tracked.score < PREAMBLE_THRESHOLD * 0.65) return null;
      const decoded = scoresAt(this.samples, tracked.start);
      if (!decoded) return null;
      quality += tracked.score;
      if (decoded.bestValue === expected && tracked.score >= PREAMBLE_THRESHOLD) correct++;
      current = tracked.start + SYMBOL_SAMPLES;
    }
    quality /= PREAMBLE.length;
    if (correct < PREAMBLE.length - 1 || quality < PREAMBLE_THRESHOLD) return null;
    return { frameStart: current };
  }
  acquire() {
    const needed = PREAMBLE.length * SYMBOL_SAMPLES + TIMING_SEARCH;
    const maxCandidate = this.length - needed;
    if (maxCandidate < this.scan) return false;
    let start = this.scan;
    while (start <= maxCandidate) {
      const coarseScore = symbolScore(this.samples, start, PREAMBLE[0]);
      if (coarseScore >= ACQUIRE_THRESHOLD * 0.75) {
        let bestStart = start;
        let bestScore = coarseScore;
        const low = Math.max(this.scan, start - ACQUIRE_STEP);
        const high = Math.min(maxCandidate, start + ACQUIRE_STEP);
        for (let refined = low; refined <= high; refined++) {
          const score = symbolScore(this.samples, refined, PREAMBLE[0]);
          if (score > bestScore) {
            bestScore = score;
            bestStart = refined;
          }
        }
        if (bestScore >= ACQUIRE_THRESHOLD) {
          const locked = this.validatePreamble(bestStart);
          if (locked) {
            this.frameStart = locked.frameStart;
            this.scan = bestStart;
            return true;
          }
          start = Math.max(start + ACQUIRE_STEP, bestStart + ACQUIRE_STEP);
          continue;
        }
      }
      start += ACQUIRE_STEP;
    }
    this.scan = Math.max(this.scan, maxCandidate + ACQUIRE_STEP);
    this.compact();
    return false;
  }
  decodeFrame() {
    const required = this.frameStart + (DATA_SYMBOLS - 1) * SYMBOL_SAMPLES + TIMING_SEARCH + CHIRP_SAMPLES;
    if (required > this.length) return false;
    const slots = new Float32Array(SLOT_BITS);
    let write = 0;
    let predicted = this.frameStart;
    for (let symbol = 0; symbol < DATA_SYMBOLS; symbol++) {
      const tracked = trackAny(this.samples, predicted);
      if (!tracked || tracked.bestScore < DATA_THRESHOLD) {
        slots[write++] = 0;
        slots[write++] = 0;
        slots[write++] = 0;
        predicted += SYMBOL_SAMPLES;
        continue;
      }
      const margin = Math.max(0, tracked.bestScore - tracked.secondScore);
      const quality = clamp((tracked.bestScore + margin * 2) / 0.35, 0.08, 1);
      const soft = softBitsFromScores(tracked.scores, quality);
      slots[write++] = soft[0];
      slots[write++] = soft[1];
      slots[write++] = soft[2];
      predicted = tracked.start + SYMBOL_SAMPLES;
    }
    const packet = parseFrame(convolutionalDecode(recoverCoded(slots)));
    if (packet) this.onPacket(packet);
    this.scan = Math.max(this.scan, predicted - TIMING_SEARCH);
    this.frameStart = -1;
    this.compact();
    return true;
  }
  process() {
    while (true) {
      if (this.frameStart < 0 && !this.acquire()) return;
      if (!this.decodeFrame()) return;
    }
  }
  compact() {
    if (this.frameStart >= 0 || this.scan < 262144) return;
    const keepFrom = Math.max(0, this.scan - SYMBOL_SAMPLES * 2);
    this.samples.copyWithin(0, keepFrom, this.length);
    this.length -= keepFrom;
    this.scan = Math.max(0, this.scan - keepFrom);
  }
  reset() {
    this.length = 0;
    this.scan = 0;
    this.frameStart = -1;
  }
}

export {
  ULTRA_AUDIO_BLOCK_SIZE,
  ULTRA_ESTIMATED_KBPS,
  ULTRA_FRAME_MS,
  ULTRA_PACKETS_PER_FRAME,
  UltraScanner,
  modulateUltraFrame
};
