import { codingMode, RAPTOR_PACKET_ID_BYTES } from "../shared/coding-mode.js";
import { crc32 } from "../shared/protocol.js";

const SAMPLE_RATE = 48000;
const AUDIO_BLOCK_SIZE = 260;
const AUDIO_HEADER_BYTES = 16;
const AUDIO_CRC_BYTES = 4;
const AUDIO_PACKET_BYTES = AUDIO_HEADER_BYTES + AUDIO_BLOCK_SIZE + AUDIO_CRC_BYTES;
const MAX_AUDIO_BYTES = 1024 * 1024;
const MAGIC = new Uint8Array([0x41, 0x47, 0x51, 0x32]); // AGQ2
const MODE_NAMES = ["direct", "mds", "raptorq"];
const MODE_CODES = new Map(MODE_NAMES.map((mode, index) => [mode, index]));
const PUNCTURE = new Uint8Array([1, 1]);
const TAIL_BITS = 6;

// Non-coherent near-ultrasonic FSK. 19.1-21.75 kHz stays much farther from
// Nyquist than the old 20.1-22.75 kHz band, where phone audio paths commonly
// roll off sharply, while remaining effectively inaudible for normal use.
const TONE_COUNT = 8;
const BITS_PER_TONE = 3;
const SYMBOL_SAMPLES = 128;
const TONE_BASE_HZ = 19125;
const TONE_SPACING_HZ = 375;
const PREAMBLE = new Uint8Array([0, 7, 1, 6, 2, 5, 3, 4, 7, 0, 6, 1]);
const PREAMBLE_SAMPLES = PREAMBLE.length * SYMBOL_SAMPLES;
const TAIL_SAMPLES = SYMBOL_SAMPLES * 2;
const SYNC_THRESHOLD = 0.28;
const PROFILE_KEY = "airgapper:audio-sound:v1";

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
  let offset = 0;
  for (const value of bytes) {
    for (let bit = 7; bit >= 0; bit--) out[offset++] = value >>> bit & 1;
  }
  return out;
}
function bitsToBytes(bits, byteLength) {
  const out = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength * 8; i++) out[i >>> 3] |= bits[i] << (7 - (i & 7));
  return out;
}
function convolutionalEncode(payloadBits) {
  const steps = payloadBits.length + TAIL_BITS;
  const out = new Uint8Array(steps * 2);
  let state = 0;
  let write = 0;
  for (let step = 0; step < steps; step++) {
    const input = step < payloadBits.length ? payloadBits[step] : 0;
    const register = (state << 1 | input) & 0x7f;
    out[write++] = parity(register & 0x79);
    out[write++] = parity(register & 0x5b);
    state = register & 0x3f;
  }
  return out;
}
function softBitCost(expected, observation) {
  const soft = clamp(Number(observation) || 0, -1, 1);
  return expected ? (1 - soft) * 0.5 : (1 + soft) * 0.5;
}
function convolutionalDecode(codedSoft, payloadBitLength) {
  const steps = payloadBitLength + TAIL_BITS;
  const stateCount = 64;
  const infinity = 1e30;
  let metrics = new Float64Array(stateCount);
  let next = new Float64Array(stateCount);
  metrics.fill(infinity);
  metrics[0] = 0;
  const previousState = new Uint8Array(steps * stateCount);
  const previousBit = new Uint8Array(steps * stateCount);
  let read = 0;
  for (let step = 0; step < steps; step++) {
    const receivedA = codedSoft[read++];
    const receivedB = codedSoft[read++];
    next.fill(infinity);
    for (let state = 0; state < stateCount; state++) {
      const baseMetric = metrics[state];
      if (baseMetric >= infinity) continue;
      for (let input = 0; input < 2; input++) {
        const register = (state << 1 | input) & 0x7f;
        const target = register & 0x3f;
        const metric = baseMetric
          + softBitCost(parity(register & 0x79), receivedA)
          + softBitCost(parity(register & 0x5b), receivedB);
        if (metric >= next[target]) continue;
        next[target] = metric;
        const index = step * stateCount + target;
        previousState[index] = state;
        previousBit[index] = input;
      }
    }
    [metrics, next] = [next, metrics];
  }
  const decoded = new Uint8Array(steps);
  let state = 0;
  for (let step = steps - 1; step >= 0; step--) {
    const index = step * stateCount + state;
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
  let step = 521;
  while (gcd(step, capacity) !== 1) step += 2;
  return step;
}

const RAW_PACKET_BITS = AUDIO_PACKET_BYTES * 8;
const CODED_BITS = convolutionalEncode(new Uint8Array(RAW_PACKET_BITS)).length;
const DATA_SYMBOLS = Math.ceil(CODED_BITS / BITS_PER_TONE);
const SLOT_BITS = DATA_SYMBOLS * BITS_PER_TONE;
const INTERLEAVE_STEP = interleaveStep(SLOT_BITS);
const FRAME_SAMPLES = PREAMBLE_SAMPLES + DATA_SYMBOLS * SYMBOL_SAMPLES + TAIL_SAMPLES;
const QUIET_ESTIMATED_KBPS =
  (AUDIO_BLOCK_SIZE - RAPTOR_PACKET_ID_BYTES) / (FRAME_SAMPLES / SAMPLE_RATE) / 1024;

const TONE_COEFF = new Float64Array(TONE_COUNT);
const TONE_OMEGA = new Float64Array(TONE_COUNT);
for (let tone = 0; tone < TONE_COUNT; tone++) {
  const omega = 2 * Math.PI * (TONE_BASE_HZ + tone * TONE_SPACING_HZ) / SAMPLE_RATE;
  TONE_OMEGA[tone] = omega;
  TONE_COEFF[tone] = 2 * Math.cos(omega);
}

function packetBytes(payloadId, totalLen, mode, encodingId, block) {
  if (!(block instanceof Uint8Array) || block.length !== AUDIO_BLOCK_SIZE) throw new Error("Unexpected audio transport block size.");
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
  const storedCrc = view.getUint32(AUDIO_PACKET_BYTES - AUDIO_CRC_BYTES, true);
  if (storedCrc !== crc32(raw.subarray(0, AUDIO_PACKET_BYTES - AUDIO_CRC_BYTES))) return null;
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
function toneEnergy(samples, offset, tone) {
  const coeff = TONE_COEFF[tone];
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < SYMBOL_SAMPLES; i++) {
    const s0 = samples[offset + i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2);
}
function allToneEnergies(samples, offset) {
  const energies = new Float64Array(TONE_COUNT);
  for (let tone = 0; tone < TONE_COUNT; tone++) energies[tone] = toneEnergy(samples, offset, tone);
  return energies;
}
function syncScore(samples, offset) {
  let score = 0;
  let power = 0;
  for (let i = 0; i < PREAMBLE.length; i++) {
    const expected = PREAMBLE[i];
    const alternate = (expected + 4) & 7;
    const e = toneEnergy(samples, offset + i * SYMBOL_SAMPLES, expected);
    const a = toneEnergy(samples, offset + i * SYMBOL_SAMPLES, alternate);
    power += e + a;
    score += (e - a) / Math.max(1e-12, e + a);
  }
  if (power < 1e-6) return -1;
  return score / PREAMBLE.length;
}
function decodeFrame(samples, offset, shift = 0) {
  const start = offset + PREAMBLE_SAMPLES + shift;
  if (start < 0 || start + DATA_SYMBOLS * SYMBOL_SAMPLES > samples.length) return null;
  const slots = new Float32Array(SLOT_BITS);
  let write = 0;
  for (let symbol = 0; symbol < DATA_SYMBOLS; symbol++) {
    const energies = allToneEnergies(samples, start + symbol * SYMBOL_SAMPLES);
    for (let bit = BITS_PER_TONE - 1; bit >= 0; bit--) {
      let e0 = 0;
      let e1 = 0;
      for (let tone = 0; tone < TONE_COUNT; tone++) {
        if (tone >>> bit & 1) e1 += energies[tone];
        else e0 += energies[tone];
      }
      slots[write++] = clamp((e1 - e0) / Math.max(1e-12, e1 + e0), -1, 1);
    }
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
  let phase = 0;
  let out = 0;
  for (const tone of tones) {
    const omega = TONE_OMEGA[tone];
    for (let i = 0; i < SYMBOL_SAMPLES; i++) {
      waveform[out++] = 0.68 * Math.sin(phase);
      phase += omega;
      if (phase > Math.PI * 2) phase -= Math.PI * 2;
    }
  }
  const fade = Math.min(64, out);
  for (let i = 0; i < fade; i++) {
    const gain = Math.sin((i + 1) / fade * Math.PI / 2) ** 2;
    waveform[i] *= gain;
    waveform[out - 1 - i] *= gain;
  }
  return waveform;
}

class QuietScanner {
  constructor(onPacket) {
    this.onPacket = onPacket;
    this.samples = new Float32Array(262144);
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
    const maxCandidate = this.length - FRAME_SAMPLES;
    if (maxCandidate < this.scan) return;
    let bestOffset = -1;
    let bestScore = -1;
    for (let offset = this.scan; offset <= maxCandidate; offset += 16) {
      const score = syncScore(this.samples, offset);
      if (score > bestScore) {
        bestScore = score;
        bestOffset = offset;
      }
    }
    if (bestScore < SYNC_THRESHOLD) {
      this.scan = Math.max(this.scan, maxCandidate - PREAMBLE_SAMPLES);
      this.compact();
      return;
    }
    let refinedOffset = bestOffset;
    let refinedScore = bestScore;
    for (let offset = Math.max(this.scan, bestOffset - 16); offset <= Math.min(maxCandidate, bestOffset + 16); offset += 2) {
      const score = syncScore(this.samples, offset);
      if (score > refinedScore) {
        refinedScore = score;
        refinedOffset = offset;
      }
    }
    let packet = decodeFrame(this.samples, refinedOffset, 0);
    if (!packet) {
      for (const shift of [-4, 4, -8, 8, -12, 12, -16, 16]) {
        packet = decodeFrame(this.samples, refinedOffset, shift);
        if (packet) break;
      }
    }
    if (packet) {
      this.onPacket(packet);
      this.scan = refinedOffset + FRAME_SAMPLES;
    } else {
      this.scan = refinedOffset + SYMBOL_SAMPLES;
    }
    this.compact();
  }
  compact() {
    if (this.scan < 65536) return;
    const keepFrom = Math.max(0, this.scan - PREAMBLE_SAMPLES);
    this.samples.copyWithin(0, keepFrom, this.length);
    this.length -= keepFrom;
    this.scan -= keepFrom;
  }
  reset() {
    this.length = 0;
    this.scan = 0;
  }
}

function isQuietProfile() {
  try { return localStorage.getItem(PROFILE_KEY) === "quiet"; } catch { return false; }
}

export { QUIET_ESTIMATED_KBPS, QuietScanner, isQuietProfile, modulateQuietPacket };
