import { codingMode, RAPTOR_PACKET_ID_BYTES } from "../shared/coding-mode.js";
import { crc32 } from "../shared/protocol.js";

const SAMPLE_RATE = 48000;
const AUDIO_BLOCK_SIZE = 32;
const AUDIO_HEADER_BYTES = 16;
const AUDIO_CRC_BYTES = 4;
const AUDIO_PACKET_BYTES = AUDIO_HEADER_BYTES + AUDIO_BLOCK_SIZE + AUDIO_CRC_BYTES;
const MAX_AUDIO_BYTES = 1024 * 1024;
const MAGIC = new Uint8Array([0x41, 0x47, 0x52, 0x31]); // AGR1
const MODE_NAMES = ["direct", "mds", "raptorq"];
const MODE_CODES = new Map(MODE_NAMES.map((mode, index) => [mode, index]));
const TAIL_BITS = 6;

// Room-range DSSS. A 63-chip m-sequence repeats every symbol. The code
// pedestal gives immediate timing acquisition; orthogonal low-rate amplitude
// waves carry four coded bits per symbol while keeping the transmitted signal
// noise-like and concentrated in the strong phone speaker/mic band.
const CODE_CHIPS = 63;
const SAMPLES_PER_CHIP = 16;
const SYMBOL_SAMPLES = CODE_CHIPS * SAMPLES_PER_CHIP; // 21 ms, 3 kchip/s
const CARRIER_CYCLES = 84; // exactly 4 kHz over one symbol
const DATA_VALUES = 16;
const SYNC_VALUES = new Uint8Array([16, 17, 18, 19]);
const VALUE_COUNT = DATA_VALUES + SYNC_VALUES.length;
const DATA_CYCLE_FIRST = 4;
const PEDESTAL = 1.0;
const DATA_DEPTH = 0.85;
const AMPLITUDE = 0.46;
const ACQUIRE_THRESHOLD = 0.12;
const TRACK_THRESHOLD = 0.065;
const TRACK_WINDOW = 12;

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
const DATA_SYMBOLS = Math.ceil(CODED_BITS / 4);
const SLOT_BITS = DATA_SYMBOLS * 4;
const INTERLEAVE_STEP = interleaveStep(SLOT_BITS);
const FRAME_SYMBOLS = SYNC_VALUES.length + DATA_SYMBOLS;
const FRAME_SAMPLES = FRAME_SYMBOLS * SYMBOL_SAMPLES;
const AUDIO_ESTIMATED_KBPS =
  (AUDIO_BLOCK_SIZE - RAPTOR_PACKET_ID_BYTES) / (FRAME_SAMPLES / SAMPLE_RATE) / 1024;

function makeCode() {
  const chips = new Int8Array(CODE_CHIPS);
  let state = 0x3f;
  for (let i = 0; i < CODE_CHIPS; i++) {
    chips[i] = state & 1 ? 1 : -1;
    const feedback = ((state >> 0) ^ (state >> 5)) & 1;
    state = (state >> 1) | (feedback << 5);
  }
  return chips;
}
const CODE_CHIP_VALUES = makeCode();
const CODE_SAMPLES = new Int8Array(SYMBOL_SAMPLES);
for (let chip = 0; chip < CODE_CHIPS; chip++) {
  CODE_SAMPLES.fill(CODE_CHIP_VALUES[chip], chip * SAMPLES_PER_CHIP, (chip + 1) * SAMPLES_PER_CHIP);
}
const CARRIER_SIN = new Float64Array(SYMBOL_SAMPLES);
const CARRIER_COS = new Float64Array(SYMBOL_SAMPLES);
for (let i = 0; i < SYMBOL_SAMPLES; i++) {
  const phase = 2 * Math.PI * CARRIER_CYCLES * i / SYMBOL_SAMPLES;
  CARRIER_SIN[i] = Math.sin(phase);
  CARRIER_COS[i] = Math.cos(phase);
}
const VALUE_WAVES = Array.from({ length: VALUE_COUNT }, (_, value) => {
  const wave = new Float64Array(SYMBOL_SAMPLES);
  const cycles = DATA_CYCLE_FIRST + value;
  for (let i = 0; i < SYMBOL_SAMPLES; i++) wave[i] = Math.sin(2 * Math.PI * cycles * i / SYMBOL_SAMPLES);
  return wave;
});
const PEDESTAL_REFERENCE_ENERGY = SYMBOL_SAMPLES * 0.5;

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

function writeSymbol(waveform, offset, value) {
  const dataWave = VALUE_WAVES[value];
  for (let i = 0; i < SYMBOL_SAMPLES; i++) {
    waveform[offset + i] = AMPLITUDE * CODE_SAMPLES[i] * CARRIER_SIN[i]
      * (PEDESTAL + DATA_DEPTH * dataWave[i]);
  }
}
function modulateReliablePacket(payloadId, totalLen, mode, encodingId, block) {
  const raw = packetBytes(payloadId, totalLen, mode, encodingId, block);
  const coded = convolutionalEncode(bytesToBits(raw));
  const slots = interleave(coded);
  const waveform = new Float32Array(FRAME_SAMPLES);
  let out = 0;
  for (const value of SYNC_VALUES) {
    writeSymbol(waveform, out, value);
    out += SYMBOL_SAMPLES;
  }
  let read = 0;
  for (let symbol = 0; symbol < DATA_SYMBOLS; symbol++) {
    let value = 0;
    for (let bit = 0; bit < 4; bit++) value = value << 1 | (slots[read++] || 0);
    writeSymbol(waveform, out, value);
    out += SYMBOL_SAMPLES;
  }
  return waveform;
}

function pedestalCorrelation(samples, offset, stride = 1) {
  let inPhase = 0;
  let quadrature = 0;
  let energy = 0;
  let count = 0;
  for (let i = 0; i < SYMBOL_SAMPLES; i += stride) {
    const sample = samples[offset + i];
    const spread = sample * CODE_SAMPLES[i];
    inPhase += spread * CARRIER_SIN[i];
    quadrature += spread * CARRIER_COS[i];
    energy += sample * sample;
    count++;
  }
  if (energy < 1e-10) return 0;
  const referenceEnergy = PEDESTAL_REFERENCE_ENERGY / stride;
  return Math.hypot(inPhase, quadrature) / Math.sqrt(energy * referenceEnergy);
}
function symbolMetrics(samples, offset, quality = 1) {
  let carrierI = 0;
  let carrierQ = 0;
  for (let i = 0; i < SYMBOL_SAMPLES; i++) {
    const spread = samples[offset + i] * CODE_SAMPLES[i];
    carrierI += spread * CARRIER_SIN[i];
    carrierQ += spread * CARRIER_COS[i];
  }
  const carrierMagnitude = Math.hypot(carrierI, carrierQ);
  if (!Number.isFinite(carrierMagnitude) || carrierMagnitude < 1e-8) return null;

  const scores = new Float64Array(VALUE_COUNT);
  for (let value = 0; value < VALUE_COUNT; value++) {
    const dataWave = VALUE_WAVES[value];
    let dataI = 0;
    let dataQ = 0;
    for (let i = 0; i < SYMBOL_SAMPLES; i++) {
      const spread = samples[offset + i] * CODE_SAMPLES[i] * dataWave[i];
      dataI += spread * CARRIER_SIN[i];
      dataQ += spread * CARRIER_COS[i];
    }
    scores[value] = (dataI * carrierI + dataQ * carrierQ) /
      Math.max(1e-9, carrierMagnitude * SYMBOL_SAMPLES * 0.25);
  }

  let bestValue = 0;
  let bestScore = scores[0];
  let secondScore = -Infinity;
  for (let value = 1; value < VALUE_COUNT; value++) {
    const score = scores[value];
    if (score > bestScore) {
      secondScore = bestScore;
      bestScore = score;
      bestValue = value;
    } else if (score > secondScore) {
      secondScore = score;
    }
  }

  const soft = new Float32Array(4);
  for (let bit = 3, write = 0; bit >= 0; bit--, write++) {
    let best0 = -Infinity;
    let best1 = -Infinity;
    for (let value = 0; value < DATA_VALUES; value++) {
      if (value >> bit & 1) best1 = Math.max(best1, scores[value]);
      else best0 = Math.max(best0, scores[value]);
    }
    const scale = Math.max(0.08, Math.abs(best0) + Math.abs(best1));
    soft[write] = clamp((best1 - best0) / scale, -1, 1) * clamp(quality, 0.08, 1);
  }
  return { scores, bestValue, bestScore, secondScore, soft };
}
function decodeSlots(slots) {
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
    this.syncIndex = 0;
    this.frameSlots = null;
    this.frameWrite = 0;
    this.failures = 0;
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
      const score = pedestalCorrelation(this.samples, offset, 2);
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
      const score = pedestalCorrelation(this.samples, offset, 1);
      if (score > bestScore) {
        bestScore = score;
        bestOffset = offset;
      }
    }
    this.nextSymbolStart = bestOffset;
    this.syncIndex = 0;
    this.frameSlots = null;
    this.frameWrite = 0;
    this.failures = 0;
    return true;
  }
  loseLock(start) {
    this.nextSymbolStart = -1;
    this.syncIndex = 0;
    this.frameSlots = null;
    this.frameWrite = 0;
    this.failures = 0;
    this.scan = Math.max(this.scan, start + Math.floor(SYMBOL_SAMPLES / 3));
  }
  consumeSymbol(metrics) {
    const value = metrics.bestValue;
    if (!this.frameSlots) {
      const expected = SYNC_VALUES[this.syncIndex];
      if (value === expected) {
        this.syncIndex++;
        if (this.syncIndex === SYNC_VALUES.length) {
          this.frameSlots = new Float32Array(SLOT_BITS);
          this.frameWrite = 0;
          this.syncIndex = 0;
        }
      } else {
        this.syncIndex = value === SYNC_VALUES[0] ? 1 : 0;
      }
      return;
    }

    for (let i = 0; i < 4 && this.frameWrite < SLOT_BITS; i++) {
      this.frameSlots[this.frameWrite++] = metrics.soft[i];
    }
    if (this.frameWrite < SLOT_BITS) return;
    const packet = decodeSlots(this.frameSlots);
    if (packet) this.onPacket(packet);
    this.frameSlots = null;
    this.frameWrite = 0;
    this.syncIndex = 0;
  }
  process() {
    while (true) {
      if (this.nextSymbolStart < 0 && !this.acquire()) return;
      if (this.nextSymbolStart + SYMBOL_SAMPLES > this.length) return;

      const predicted = this.nextSymbolStart;
      let start = predicted;
      let score = pedestalCorrelation(this.samples, start, 2);
      for (let candidate = Math.max(0, predicted - TRACK_WINDOW);
           candidate <= predicted + TRACK_WINDOW && candidate + SYMBOL_SAMPLES <= this.length;
           candidate += 2) {
        const candidateScore = pedestalCorrelation(this.samples, candidate, 2);
        if (candidateScore > score) {
          score = candidateScore;
          start = candidate;
        }
      }
      if (score < TRACK_THRESHOLD) {
        this.loseLock(start);
        continue;
      }
      const quality = clamp((score - TRACK_THRESHOLD) / 0.55, 0, 1);
      this.onSignal(quality);
      const metrics = symbolMetrics(this.samples, start, quality);
      if (!metrics) {
        this.failures++;
      } else {
        this.failures = 0;
        this.consumeSymbol(metrics);
      }
      this.nextSymbolStart = start + SYMBOL_SAMPLES;
      this.scan = this.nextSymbolStart;
      if (this.failures >= 3) {
        this.loseLock(start);
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
    this.syncIndex = 0;
    this.frameSlots = null;
    this.frameWrite = 0;
    this.failures = 0;
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
