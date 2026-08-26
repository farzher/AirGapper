import { codingMode, RAPTOR_PACKET_ID_BYTES } from "../shared/coding-mode.js";
import { crc32 } from "../shared/protocol.js";

const SAMPLE_RATE = 48000;
const AUDIO_BLOCK_SIZE = 24;
const AUDIO_HEADER_BYTES = 16;
const AUDIO_CRC_BYTES = 4;
const AUDIO_PACKET_BYTES = AUDIO_HEADER_BYTES + AUDIO_BLOCK_SIZE + AUDIO_CRC_BYTES;
const MAX_AUDIO_BYTES = 1024 * 1024;
const MAGIC = new Uint8Array([0x41, 0x47, 0x52, 0x32]); // AGR2
const MODE_NAMES = ["direct", "mds", "raptorq"];
const MODE_CODES = new Map(MODE_NAMES.map((mode, index) => [mode, index]));
const TAIL_BITS = 6;

// Room-range Reliable PHY: noncoherent 16-FSK plus a low-band repeated
// multitone pilot. The pilot provides phase-independent symbol timing on every
// symbol; CRC finds frame boundaries from a rolling window, so there is no
// special sync burst to acquire or periodically hear.
const TONE_COUNT = 16;
const BITS_PER_TONE = 4;
const SYMBOL_SAMPLES = 480; // 10 ms
const TONE_BASE_HZ = 2500;
const TONE_SPACING_HZ = 300;
const DATA_AMPLITUDE = 0.62;
const PILOT_AMPLITUDE = 0.20;
const ACQUIRE_THRESHOLD = 0.085;
const TRACK_THRESHOLD = 0.045;
const TRACK_WINDOW = 20;
const FREQ_OFFSETS = new Int16Array([-50, 0, 50]);
const PILOT_CYCLES = new Uint8Array([5, 7, 10, 13, 17, 19]);
const PILOT_PHASES = new Float64Array([0.23, 1.31, 2.47, 0.82, 2.91, 1.77]);

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}
function parity(value) {
  value ^= value >>> 4;
  value ^= value >>> 2;
  value ^= value >>> 1;
  return value & 1;
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
const FRAME_SYMBOLS = Math.ceil(CODED_BITS / BITS_PER_TONE);
const SLOT_BITS = FRAME_SYMBOLS * BITS_PER_TONE;
const INTERLEAVE_STEP = interleaveStep(SLOT_BITS);
const FRAME_SAMPLES = FRAME_SYMBOLS * SYMBOL_SAMPLES;
const AUDIO_ESTIMATED_KBPS =
  (AUDIO_BLOCK_SIZE - RAPTOR_PACKET_ID_BYTES) / (FRAME_SAMPLES / SAMPLE_RATE) / 1024;

const PILOT_TEMPLATE = new Float64Array(SYMBOL_SAMPLES);
for (let i = 0; i < SYMBOL_SAMPLES; i++) {
  let sample = 0;
  for (let tone = 0; tone < PILOT_CYCLES.length; tone++) {
    sample += Math.sin(2 * Math.PI * PILOT_CYCLES[tone] * i / SYMBOL_SAMPLES + PILOT_PHASES[tone]);
  }
  PILOT_TEMPLATE[i] = sample;
}
let pilotEnergy = 0;
for (const sample of PILOT_TEMPLATE) pilotEnergy += sample * sample;
const PILOT_SCALE = 1 / Math.sqrt(pilotEnergy / SYMBOL_SAMPLES);
for (let i = 0; i < PILOT_TEMPLATE.length; i++) PILOT_TEMPLATE[i] *= PILOT_SCALE;
pilotEnergy = SYMBOL_SAMPLES;

const TONE_COEFF = Array.from({ length: FREQ_OFFSETS.length }, () => new Float64Array(TONE_COUNT));
const TONE_OMEGA = new Float64Array(TONE_COUNT);
for (let tone = 0; tone < TONE_COUNT; tone++) {
  const frequency = TONE_BASE_HZ + tone * TONE_SPACING_HZ;
  TONE_OMEGA[tone] = 2 * Math.PI * frequency / SAMPLE_RATE;
  for (let offset = 0; offset < FREQ_OFFSETS.length; offset++) {
    TONE_COEFF[offset][tone] = 2 * Math.cos(2 * Math.PI * (frequency + FREQ_OFFSETS[offset]) / SAMPLE_RATE);
  }
}

function packetBytes(payloadId, totalLen, mode, encodingId, block) {
  if (!(block instanceof Uint8Array) || block.length !== AUDIO_BLOCK_SIZE) throw new Error("Unexpected Reliable transport block size.");
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
    profile: "reliable"
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

function writeSymbol(waveform, offset, tone) {
  const omega = TONE_OMEGA[tone];
  for (let i = 0; i < SYMBOL_SAMPLES; i++) {
    const sample = DATA_AMPLITUDE * Math.sin(omega * i) + PILOT_AMPLITUDE * PILOT_TEMPLATE[i];
    waveform[offset + i] = clamp(sample, -0.92, 0.92);
  }
}
function modulateReliablePacket(payloadId, totalLen, mode, encodingId, block) {
  const raw = packetBytes(payloadId, totalLen, mode, encodingId, block);
  const coded = convolutionalEncode(bytesToBits(raw));
  const slots = interleave(coded);
  const waveform = new Float32Array(FRAME_SAMPLES);
  let read = 0;
  for (let symbol = 0; symbol < FRAME_SYMBOLS; symbol++) {
    let tone = 0;
    for (let bit = 0; bit < BITS_PER_TONE; bit++) tone = tone << 1 | (slots[read++] || 0);
    writeSymbol(waveform, symbol * SYMBOL_SAMPLES, tone);
  }
  return waveform;
}

function pilotCorrelation(samples, offset, stride = 2) {
  let dot = 0;
  let energy = 0;
  let referenceEnergy = 0;
  for (let i = 0; i < SYMBOL_SAMPLES; i += stride) {
    const sample = samples[offset + i];
    const reference = PILOT_TEMPLATE[i];
    dot += sample * reference;
    energy += sample * sample;
    referenceEnergy += reference * reference;
  }
  if (energy < 1e-9) return 0;
  return Math.abs(dot) / Math.sqrt(energy * referenceEnergy);
}
function toneEnergy(samples, offset, tone, frequencyIndex) {
  const coeff = TONE_COEFF[frequencyIndex][tone];
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < SYMBOL_SAMPLES; i++) {
    const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (SYMBOL_SAMPLES - 1));
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
function bestFrequencyEnergies(samples, offset, preferredIndex) {
  let best = null;
  for (let index = 0; index < FREQ_OFFSETS.length; index++) {
    if (preferredIndex >= 0 && Math.abs(index - preferredIndex) > 1) continue;
    const energies = allToneEnergies(samples, offset, index);
    const confidence = toneConfidence(energies);
    if (!best || confidence > best.confidence) best = { energies, confidence, frequencyIndex: index };
  }
  return best;
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
function decodeSymbolQueue(queue) {
  if (queue.length !== FRAME_SYMBOLS) return null;
  const slots = new Float32Array(SLOT_BITS);
  let write = 0;
  for (const soft of queue) {
    for (let bit = 0; bit < BITS_PER_TONE; bit++) slots[write++] = soft[bit];
  }
  const coded = deinterleaveSoft(slots);
  const decoded = convolutionalDecode(coded, RAW_PACKET_BITS);
  return parsePacket(bitsToBytes(decoded, AUDIO_PACKET_BYTES));
}

class ReliableScanner {
  constructor(onPacket, onSignal = () => void 0) {
    this.onPacket = onPacket;
    this.onSignal = onSignal;
    this.samples = new Float32Array(131072);
    this.length = 0;
    this.scan = 0;
    this.nextSymbolStart = -1;
    this.frequencyIndex = 1;
    this.failures = 0;
    this.symbolQueue = [];
    this.frameLocked = false;
    this.lockedSymbols = 0;
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
    const maxCandidate = this.length - SYMBOL_SAMPLES;
    if (maxCandidate < this.scan) return false;
    let bestOffset = -1;
    let bestScore = 0;
    for (let offset = this.scan; offset <= maxCandidate; offset += 8) {
      const score = pilotCorrelation(this.samples, offset, 4);
      if (score > bestScore) {
        bestScore = score;
        bestOffset = offset;
      }
    }
    if (bestScore < ACQUIRE_THRESHOLD) {
      this.scan = maxCandidate + 1;
      this.compact();
      return false;
    }
    const coarse = bestOffset;
    for (let offset = Math.max(this.scan, coarse - 8); offset <= Math.min(maxCandidate, coarse + 8); offset++) {
      const score = pilotCorrelation(this.samples, offset, 1);
      if (score > bestScore) {
        bestScore = score;
        bestOffset = offset;
      }
    }
    this.nextSymbolStart = bestOffset;
    this.failures = 0;
    this.symbolQueue.length = 0;
    this.frameLocked = false;
    this.lockedSymbols = 0;
    return true;
  }
  loseSymbolLock(start) {
    this.nextSymbolStart = -1;
    this.failures = 0;
    this.symbolQueue.length = 0;
    this.frameLocked = false;
    this.lockedSymbols = 0;
    this.scan = Math.max(this.scan, start + Math.floor(SYMBOL_SAMPLES / 2));
  }
  consumeSoft(soft) {
    this.symbolQueue.push(soft);
    if (this.symbolQueue.length > FRAME_SYMBOLS) this.symbolQueue.shift();
    if (this.symbolQueue.length < FRAME_SYMBOLS) return;

    if (this.frameLocked) {
      this.lockedSymbols++;
      if (this.lockedSymbols < FRAME_SYMBOLS) return;
      this.lockedSymbols = 0;
      const packet = decodeSymbolQueue(this.symbolQueue);
      if (packet) {
        this.onPacket(packet);
      } else {
        this.frameLocked = false;
      }
      return;
    }

    const packet = decodeSymbolQueue(this.symbolQueue);
    if (!packet) return;
    this.onPacket(packet);
    this.frameLocked = true;
    this.lockedSymbols = 0;
  }
  process() {
    while (true) {
      if (this.nextSymbolStart < 0 && !this.acquire()) return;
      if (this.nextSymbolStart + SYMBOL_SAMPLES > this.length) return;

      const predicted = this.nextSymbolStart;
      let start = predicted;
      let pilotScore = pilotCorrelation(this.samples, start, 2);
      for (let candidate = Math.max(0, predicted - TRACK_WINDOW);
           candidate <= predicted + TRACK_WINDOW && candidate + SYMBOL_SAMPLES <= this.length;
           candidate += 2) {
        const score = pilotCorrelation(this.samples, candidate, 2);
        if (score > pilotScore) {
          pilotScore = score;
          start = candidate;
        }
      }
      if (pilotScore < TRACK_THRESHOLD) {
        this.loseSymbolLock(start);
        continue;
      }

      const decision = bestFrequencyEnergies(this.samples, start, this.frequencyIndex);
      if (!decision || decision.confidence < 0.015) {
        this.failures++;
      } else {
        this.failures = 0;
        this.frequencyIndex = decision.frequencyIndex;
        const quality = clamp(0.55 * pilotScore / 0.25 + 0.45 * decision.confidence / 0.65, 0, 1);
        this.onSignal(quality);
        this.consumeSoft(softFromEnergies(decision.energies, decision.confidence));
      }

      this.nextSymbolStart = start + SYMBOL_SAMPLES;
      this.scan = this.nextSymbolStart;
      if (this.failures >= 4) {
        this.loseSymbolLock(start);
        continue;
      }
      this.compact();
    }
  }
  compact() {
    const cursor = this.nextSymbolStart >= 0 ? this.nextSymbolStart : this.scan;
    if (cursor < 65536) return;
    const keepFrom = Math.max(0, cursor - SYMBOL_SAMPLES * 2);
    this.samples.copyWithin(0, keepFrom, this.length);
    this.length -= keepFrom;
    this.scan = Math.max(0, this.scan - keepFrom);
    if (this.nextSymbolStart >= 0) this.nextSymbolStart -= keepFrom;
  }
  reset() {
    this.length = 0;
    this.scan = 0;
    this.nextSymbolStart = -1;
    this.frequencyIndex = 1;
    this.failures = 0;
    this.symbolQueue.length = 0;
    this.frameLocked = false;
    this.lockedSymbols = 0;
  }
}

export {
  AUDIO_BLOCK_SIZE,
  AUDIO_ESTIMATED_KBPS,
  FRAME_SAMPLES,
  MAX_AUDIO_BYTES,
  ReliableScanner,
  SAMPLE_RATE,
  modulateReliablePacket
};
