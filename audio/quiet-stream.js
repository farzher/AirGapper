import { codingMode, RAPTOR_PACKET_ID_BYTES } from "../shared/coding-mode.js";
import { crc32 } from "../shared/protocol.js";

const SAMPLE_RATE = 48000;
const AUDIO_BLOCK_SIZE = 24;
const AUDIO_HEADER_BYTES = 16;
const AUDIO_CRC_BYTES = 4;
const AUDIO_PACKET_BYTES = AUDIO_HEADER_BYTES + AUDIO_BLOCK_SIZE + AUDIO_CRC_BYTES;
const MAX_AUDIO_BYTES = 1024 * 1024;
const MAGIC = new Uint8Array([0x41, 0x47, 0x51, 0x37]); // AGQ7
const MODE_NAMES = ["direct", "mds", "raptorq"];
const MODE_CODES = new Map(MODE_NAMES.map((mode, index) => [mode, index]));
const TAIL_BITS = 6;

const TONE_COUNT = 4;
const BITS_PER_TONE = 2;
const ACTIVE_SAMPLES = 384; // 8 ms tone integration
const GUARD_SAMPLES = 192; // 4 ms for room/speaker decay
const SYMBOL_SAMPLES = ACTIVE_SAMPLES + GUARD_SAMPLES;
const TONE_BASE_HZ = 17000;
const TONE_SPACING_HZ = 1000;
const PREAMBLE = new Uint8Array([0, 3, 1, 2, 3, 0, 2, 1, 0, 2, 3, 1, 3, 2, 0, 1]);
const PREAMBLE_SAMPLES = PREAMBLE.length * SYMBOL_SAMPLES;
const SYNC_THRESHOLD = 0.13;
const TRACK_WINDOW = 192;
const DATA_TRACK_WINDOW = 20;
const DECODE_MARGIN = SYMBOL_SAMPLES;
const FREQ_OFFSETS = new Int16Array([-100, -50, 0, 50, 100]);
const CENTER_FREQ_INDEX = 2;

function parity(value) {
  value ^= value >>> 4;
  value ^= value >>> 2;
  value ^= value >>> 1;
  return value & 1;
}
function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
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
function convolutionalEncode(payloadBits) {
  const out = new Uint8Array((payloadBits.length + TAIL_BITS) * 2);
  let state = 0;
  let write = 0;
  for (let step = 0; step < payloadBits.length + TAIL_BITS; step++) {
    const input = step < payloadBits.length ? payloadBits[step] : 0;
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
function convolutionalDecode(codedSoft, payloadBitLength) {
  const steps = payloadBitLength + TAIL_BITS;
  const infinity = 1e30;
  let metrics = new Float64Array(64);
  let next = new Float64Array(64);
  metrics.fill(infinity);
  metrics[0] = 0;
  const previousState = new Uint8Array(steps * 64);
  const previousBit = new Uint8Array(steps * 64);
  let read = 0;
  for (let step = 0; step < steps; step++) {
    const receivedA = codedSoft[read++];
    const receivedB = codedSoft[read++];
    next.fill(infinity);
    for (let state = 0; state < 64; state++) {
      const baseMetric = metrics[state];
      if (baseMetric >= infinity) continue;
      for (let input = 0; input < 2; input++) {
        const register = input << 6 | state;
        const target = register >> 1;
        const metric = baseMetric
          + softBitCost(parity(register & 0x79), receivedA)
          + softBitCost(parity(register & 0x5b), receivedB);
        if (metric >= next[target]) continue;
        next[target] = metric;
        const index = step * 64 + target;
        previousState[index] = state;
        previousBit[index] = input;
      }
    }
    [metrics, next] = [next, metrics];
  }
  const decoded = new Uint8Array(steps);
  let state = 0;
  for (let step = steps - 1; step >= 0; step--) {
    const index = step * 64 + state;
    decoded[step] = previousBit[index];
    state = previousState[index];
  }
  return decoded.subarray(0, payloadBitLength);
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

const RAW_PACKET_BITS = AUDIO_PACKET_BYTES * 8;
const CODED_BITS = convolutionalEncode(new Uint8Array(RAW_PACKET_BITS)).length;
const DATA_SYMBOLS = Math.ceil(CODED_BITS / BITS_PER_TONE);
const SLOT_BITS = DATA_SYMBOLS * BITS_PER_TONE;
const INTERLEAVE_STEP = interleaveStep(SLOT_BITS);
const FRAME_SAMPLES = PREAMBLE_SAMPLES + DATA_SYMBOLS * SYMBOL_SAMPLES;
const QUIET_ESTIMATED_KBPS =
  (AUDIO_BLOCK_SIZE - RAPTOR_PACKET_ID_BYTES) / (FRAME_SAMPLES / SAMPLE_RATE) / 1024;

const TONE_OMEGA = new Float64Array(TONE_COUNT);
const TONE_COEFF = Array.from({ length: FREQ_OFFSETS.length }, () => new Float64Array(TONE_COUNT));
for (let tone = 0; tone < TONE_COUNT; tone++) {
  const frequency = TONE_BASE_HZ + tone * TONE_SPACING_HZ;
  TONE_OMEGA[tone] = 2 * Math.PI * frequency / SAMPLE_RATE;
  for (let index = 0; index < FREQ_OFFSETS.length; index++) {
    TONE_COEFF[index][tone] = 2 * Math.cos(2 * Math.PI * (frequency + FREQ_OFFSETS[index]) / SAMPLE_RATE);
  }
}

function packetBytes(payloadId, totalLen, mode, encodingId, block) {
  if (!(block instanceof Uint8Array) || block.length !== AUDIO_BLOCK_SIZE) throw new Error("Unexpected Quiet transport block size.");
  if (!Number.isInteger(totalLen) || totalLen < 1 || totalLen > MAX_AUDIO_BYTES) throw new Error("Audio payload is too large.");
  const modeCode = MODE_CODES.get(mode);
  if (modeCode === undefined) throw new Error("Unknown audio transport mode.");
  const id = Number(encodingId) >>> 0;
  if (id > 0xffffff) throw new Error("Audio encoding ID is out of range.");
  const out = new Uint8Array(AUDIO_PACKET_BYTES);
  out.set(MAGIC, 0);
  const view = new DataView(out.buffer);
  view.setUint32(4, payloadId >>> 0, true);
  view.setUint32(8, totalLen >>> 0, true);
  out[12] = modeCode;
  out[13] = id >>> 16 & 255;
  out[14] = id >>> 8 & 255;
  out[15] = id & 255;
  out.set(block, AUDIO_HEADER_BYTES);
  view.setUint32(AUDIO_PACKET_BYTES - AUDIO_CRC_BYTES, crc32(out.subarray(0, AUDIO_PACKET_BYTES - AUDIO_CRC_BYTES)), true);
  return out;
}
function parsePacket(raw) {
  if (!(raw instanceof Uint8Array) || raw.length !== AUDIO_PACKET_BYTES) return null;
  for (let i = 0; i < MAGIC.length; i++) if (raw[i] !== MAGIC[i]) return null;
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (view.getUint32(AUDIO_PACKET_BYTES - AUDIO_CRC_BYTES, true) !==
      crc32(raw.subarray(0, AUDIO_PACKET_BYTES - AUDIO_CRC_BYTES))) return null;
  const totalLen = view.getUint32(8, true);
  const mode = MODE_NAMES[raw[12]];
  if (totalLen < 1 || totalLen > MAX_AUDIO_BYTES || !mode) return null;
  const encodingId = raw[13] * 65536 + raw[14] * 256 + raw[15];
  const sourceSize = mode === "raptorq" ? AUDIO_BLOCK_SIZE - RAPTOR_PACKET_ID_BYTES : AUDIO_BLOCK_SIZE;
  const k = Math.max(1, Math.ceil(totalLen / sourceSize));
  if (codingMode(k) !== mode) return null;
  if (mode === "direct" && encodingId !== 0) return null;
  if (mode === "mds" && encodingId >= 256) return null;
  if (mode === "raptorq" && encodingId >= 0xff0000) return null;
  return {
    payloadId: view.getUint32(4, true) >>> 0,
    totalLen,
    mode,
    encodingId,
    blockSize: AUDIO_BLOCK_SIZE,
    block: raw.slice(AUDIO_HEADER_BYTES, AUDIO_HEADER_BYTES + AUDIO_BLOCK_SIZE),
    profile: "quiet"
  };
}
function interleave(coded) {
  const slots = new Uint8Array(SLOT_BITS);
  for (let i = 0; i < coded.length; i++) slots[i * INTERLEAVE_STEP % SLOT_BITS] = coded[i];
  return slots;
}
function deinterleaveSoft(slots) {
  const coded = new Float32Array(CODED_BITS);
  for (let i = 0; i < coded.length; i++) coded[i] = slots[i * INTERLEAVE_STEP % SLOT_BITS];
  return coded;
}
function toneEnergy(samples, offset, tone, frequencyIndex) {
  const coeff = TONE_COEFF[frequencyIndex][tone];
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < ACTIVE_SAMPLES; i++) {
    const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (ACTIVE_SAMPLES - 1));
    const s0 = samples[offset + i] * window + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2);
}
function allToneEnergies(samples, offset, frequencyIndex) {
  const energies = new Float64Array(TONE_COUNT);
  for (let tone = 0; tone < TONE_COUNT; tone++) energies[tone] = toneEnergy(samples, offset, tone, frequencyIndex);
  return energies;
}
function normalizeEnergies(energies, gains) {
  const out = new Float64Array(TONE_COUNT);
  for (let tone = 0; tone < TONE_COUNT; tone++) out[tone] = energies[tone] / Math.max(1e-12, gains[tone]);
  return out;
}
function toneConfidence(energies) {
  let first = 0;
  let second = 0;
  for (const energy of energies) {
    if (energy > first) {
      second = first;
      first = energy;
    } else if (energy > second) {
      second = energy;
    }
  }
  return (first - second) / Math.max(1e-12, first + second);
}
function preambleMetrics(samples, offset, frequencyIndex) {
  const raw = new Array(PREAMBLE.length);
  const sums = new Float64Array(TONE_COUNT);
  const counts = new Uint8Array(TONE_COUNT);
  for (let i = 0; i < PREAMBLE.length; i++) {
    const energies = allToneEnergies(samples, offset + i * SYMBOL_SAMPLES, frequencyIndex);
    raw[i] = energies;
    sums[PREAMBLE[i]] += energies[PREAMBLE[i]];
    counts[PREAMBLE[i]]++;
  }
  const gains = new Float64Array(TONE_COUNT);
  let maxGain = 0;
  for (let tone = 0; tone < TONE_COUNT; tone++) {
    gains[tone] = sums[tone] / Math.max(1, counts[tone]);
    maxGain = Math.max(maxGain, gains[tone]);
  }
  if (maxGain < 1e-8) return { score: -1, gains };
  const floor = maxGain * 0.04;
  for (let tone = 0; tone < TONE_COUNT; tone++) gains[tone] = Math.max(gains[tone], floor);

  let score = 0;
  for (let i = 0; i < PREAMBLE.length; i++) {
    const energies = normalizeEnergies(raw[i], gains);
    const expected = energies[PREAMBLE[i]];
    let alternate = 0;
    for (let tone = 0; tone < TONE_COUNT; tone++) {
      if (tone !== PREAMBLE[i]) alternate = Math.max(alternate, energies[tone]);
    }
    score += (expected - alternate) / Math.max(1e-12, expected + alternate);
  }
  return { score: score / PREAMBLE.length, gains };
}
function softFromEnergies(energies, confidence) {
  const soft = new Float32Array(BITS_PER_TONE);
  for (let bit = BITS_PER_TONE - 1, write = 0; bit >= 0; bit--, write++) {
    let best0 = 0;
    let best1 = 0;
    for (let tone = 0; tone < TONE_COUNT; tone++) {
      if (tone >> bit & 1) best1 = Math.max(best1, energies[tone]);
      else best0 = Math.max(best0, energies[tone]);
    }
    soft[write] = clamp((best1 - best0) / Math.max(1e-12, best1 + best0), -1, 1)
      * clamp(0.3 + confidence, 0.15, 1);
  }
  return soft;
}
function decodeFrame(samples, offset, frequencyIndex, gains) {
  let cursor = offset + PREAMBLE_SAMPLES;
  const slots = new Float32Array(SLOT_BITS);
  let write = 0;
  let preferredFrequency = frequencyIndex;
  for (let symbol = 0; symbol < DATA_SYMBOLS; symbol++) {
    let best = null;
    for (let delta = -DATA_TRACK_WINDOW; delta <= DATA_TRACK_WINDOW; delta += 4) {
      const start = Math.round(cursor + delta);
      if (start < 0 || start + ACTIVE_SAMPLES > samples.length) continue;
      for (let fi = Math.max(0, preferredFrequency - 1); fi <= Math.min(FREQ_OFFSETS.length - 1, preferredFrequency + 1); fi++) {
        const normalized = normalizeEnergies(allToneEnergies(samples, start, fi), gains);
        const confidence = toneConfidence(normalized);
        if (!best || confidence > best.confidence) best = { start, normalized, confidence, frequencyIndex: fi };
      }
    }
    if (!best) return null;
    preferredFrequency = best.frequencyIndex;
    const soft = softFromEnergies(best.normalized, best.confidence);
    for (let bit = 0; bit < BITS_PER_TONE; bit++) slots[write++] = soft[bit];
    cursor = best.start + SYMBOL_SAMPLES;
  }
  const coded = deinterleaveSoft(slots);
  const decoded = convolutionalDecode(coded, RAW_PACKET_BITS);
  return parsePacket(bitsToBytes(decoded, AUDIO_PACKET_BYTES));
}

function modulateQuietPacket(payloadId, totalLen, mode, encodingId, block) {
  const raw = packetBytes(payloadId, totalLen, mode, encodingId, block);
  const coded = convolutionalEncode(bytesToBits(raw));
  const slots = interleave(coded);
  const tones = new Uint8Array(PREAMBLE.length + DATA_SYMBOLS);
  tones.set(PREAMBLE, 0);
  let read = 0;
  for (let symbol = 0; symbol < DATA_SYMBOLS; symbol++) {
    let tone = 0;
    for (let bit = 0; bit < BITS_PER_TONE; bit++) tone = tone << 1 | (slots[read++] || 0);
    tones[PREAMBLE.length + symbol] = tone;
  }
  const waveform = new Float32Array(FRAME_SAMPLES);
  let out = 0;
  const fadeSamples = 48;
  for (const tone of tones) {
    const omega = TONE_OMEGA[tone];
    for (let i = 0; i < ACTIVE_SAMPLES; i++) {
      let envelope = 1;
      if (i < fadeSamples) envelope = Math.sin((i + 1) / fadeSamples * Math.PI / 2) ** 2;
      else if (i >= ACTIVE_SAMPLES - fadeSamples) envelope = Math.sin((ACTIVE_SAMPLES - i) / fadeSamples * Math.PI / 2) ** 2;
      waveform[out + i] = 0.76 * Math.sin(omega * i) * envelope;
    }
    out += SYMBOL_SAMPLES;
  }
  return waveform;
}

class QuietScanner {
  constructor(onPacket) {
    this.onPacket = onPacket;
    this.samples = new Float32Array(524288);
    this.length = 0;
    this.scan = 0;
    this.expected = -1;
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
  tryAt(offset, maxCandidate) {
    let best = null;
    for (let candidate = Math.max(0, offset - TRACK_WINDOW); candidate <= Math.min(maxCandidate, offset + TRACK_WINDOW); candidate += 8) {
      for (let fi = 0; fi < FREQ_OFFSETS.length; fi++) {
        const metrics = preambleMetrics(this.samples, candidate, fi);
        if (!best || metrics.score > best.score) best = { offset: candidate, frequencyIndex: fi, ...metrics };
      }
    }
    if (!best || best.score < SYNC_THRESHOLD) return null;
    const packet = decodeFrame(this.samples, best.offset, best.frequencyIndex, best.gains);
    return { packet, offset: best.offset };
  }
  process() {
    while (true) {
      const maxCandidate = this.length - FRAME_SAMPLES - DECODE_MARGIN;
      if (maxCandidate < this.scan) return;

      if (this.expected >= 0 && this.expected <= maxCandidate) {
        const tracked = this.tryAt(this.expected, maxCandidate);
        if (tracked?.packet) {
          this.onPacket(tracked.packet);
          this.expected = tracked.offset + FRAME_SAMPLES;
          this.scan = Math.max(this.scan, tracked.offset + PREAMBLE_SAMPLES);
          this.compact();
          continue;
        }
        this.expected = -1;
      }

      let bestOffset = -1;
      let bestScore = -1;
      for (let offset = this.scan; offset <= maxCandidate; offset += 96) {
        const score = preambleMetrics(this.samples, offset, CENTER_FREQ_INDEX).score;
        if (score > bestScore) {
          bestScore = score;
          bestOffset = offset;
        }
      }
      if (bestScore < SYNC_THRESHOLD) {
        this.scan = maxCandidate + 1;
        this.compact();
        return;
      }
      const decoded = this.tryAt(bestOffset, maxCandidate);
      if (decoded?.packet) {
        this.onPacket(decoded.packet);
        this.expected = decoded.offset + FRAME_SAMPLES;
        this.scan = Math.max(this.scan, decoded.offset + PREAMBLE_SAMPLES);
      } else {
        this.scan = bestOffset + PREAMBLE_SAMPLES;
      }
      this.compact();
    }
  }
  compact() {
    const cursor = this.expected >= 0 ? Math.min(this.scan, this.expected) : this.scan;
    if (cursor < 131072) return;
    const keepFrom = Math.max(0, cursor - PREAMBLE_SAMPLES);
    this.samples.copyWithin(0, keepFrom, this.length);
    this.length -= keepFrom;
    this.scan = Math.max(0, this.scan - keepFrom);
    if (this.expected >= 0) this.expected -= keepFrom;
  }
  reset() {
    this.length = 0;
    this.scan = 0;
    this.expected = -1;
  }
}

export {
  QUIET_ESTIMATED_KBPS,
  QuietScanner,
  TONE_BASE_HZ as QUIET_TONE_BASE_HZ,
  TONE_COUNT as QUIET_TONE_COUNT,
  TONE_SPACING_HZ as QUIET_TONE_SPACING_HZ,
  modulateQuietPacket
};
