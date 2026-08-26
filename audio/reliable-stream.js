import { codingMode, RAPTOR_PACKET_ID_BYTES } from "../shared/coding-mode.js";
import { crc32 } from "../shared/protocol.js";

const SAMPLE_RATE = 48000;
const FFT_SIZE = 1024;
const CYCLIC_PREFIX = 256;
const SYMBOL_SAMPLES = FFT_SIZE + CYCLIC_PREFIX;
const FFT_WINDOW_EARLY = 48;
const ACTIVE_FIRST = 32; // 1.50 kHz
const ACTIVE_LAST = 266; // 12.47 kHz
const CARRIER_COUNT = ACTIVE_LAST - ACTIVE_FIRST + 1;
const PILOT_EVERY = 8;
const FRAME_SYMBOLS = 12;
const DATA_SYMBOLS = FRAME_SYMBOLS - 1;
const BITS_PER_CARRIER = 2;
const SPREAD_COPIES = 2;
const SYMBOL_RMS = 0.21;
const PEAK_LIMIT = 0.90;
const ACQUIRE_SYMBOLS = 3;
const ACQUIRE_THRESHOLD = 0.085;
const TRACK_THRESHOLD = 0.03;
const MARKER_MAX_RESIDUAL = 1.05;
const AUDIO_BLOCK_SIZE = 24;
const FRAME_HEADER_BYTES = 16;
const FRAME_CRC_BYTES = 4;
const MAX_AUDIO_BYTES = 1024 * 1024;
const MAGIC = new Uint8Array([0x41, 0x47, 0x52, 0x35]); // AGR5
const MODE_NAMES = ["direct", "mds", "raptorq"];
const MODE_CODES = new Map(MODE_NAMES.map((mode, index) => [mode, index]));
const TAIL_BITS = 6;

const PILOT_POSITIONS = [];
const DATA_POSITIONS = [];
for (let carrier = 0; carrier < CARRIER_COUNT; carrier++) {
  if (carrier % PILOT_EVERY === 0) PILOT_POSITIONS.push(carrier);
  else DATA_POSITIONS.push(carrier);
}
const PILOT_COUNT = PILOT_POSITIONS.length;
const DATA_CARRIERS = DATA_POSITIONS.length;
const SLOT_BITS = DATA_SYMBOLS * DATA_CARRIERS * BITS_PER_CARRIER;
const MAX_CODED_BITS = Math.floor(SLOT_BITS / SPREAD_COPIES);
const MAX_INFO_BITS = Math.floor(MAX_CODED_BITS / 2) - TAIL_BITS;
const MAX_INFO_BYTES = Math.floor(MAX_INFO_BITS / 8);
const RELIABLE_PACKETS_PER_FRAME = Math.max(1, Math.floor((MAX_INFO_BYTES - FRAME_HEADER_BYTES - FRAME_CRC_BYTES) / AUDIO_BLOCK_SIZE));
const FRAME_BYTES = FRAME_HEADER_BYTES + RELIABLE_PACKETS_PER_FRAME * AUDIO_BLOCK_SIZE + FRAME_CRC_BYTES;
const INFO_BITS = FRAME_BYTES * 8;
const CODED_BITS = (INFO_BITS + TAIL_BITS) * 2;
const FRAME_SAMPLES = FRAME_SYMBOLS * SYMBOL_SAMPLES;
const AUDIO_ESTIMATED_KBPS = RELIABLE_PACKETS_PER_FRAME * (AUDIO_BLOCK_SIZE - RAPTOR_PACKET_ID_BYTES) /
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
function randomPhaseVector(seed, count) {
  const real = new Float64Array(count);
  const imag = new Float64Array(count);
  let state = (seed >>> 0) || 0x85ebca6b;
  for (let i = 0; i < count; i++) {
    state = nextRandom(state);
    const phase = state / 4294967296 * Math.PI * 2;
    real[i] = Math.cos(phase);
    imag[i] = Math.sin(phase);
  }
  return { real, imag };
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
  let step = 521;
  while (gcd(step, capacity) !== 1) step += 2;
  return step;
}
const INTERLEAVE_STEP = interleaveStep(SLOT_BITS);
const SPREAD_SLOTS = new Uint16Array(CODED_BITS * SPREAD_COPIES);
for (let i = 0; i < SPREAD_SLOTS.length; i++) SPREAD_SLOTS[i] = i * INTERLEAVE_STEP % SLOT_BITS;

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
function buildFrameBytes(payloadId, totalLen, mode, startOrdinal, blocks) {
  if (!Array.isArray(blocks) || blocks.length !== RELIABLE_PACKETS_PER_FRAME) throw new Error("Reliable frame packet count mismatch.");
  const modeCode = MODE_CODES.get(mode);
  if (modeCode === undefined || totalLen < 1 || totalLen > MAX_AUDIO_BYTES) throw new Error("Invalid Reliable transport metadata.");
  const out = new Uint8Array(FRAME_BYTES);
  out.set(MAGIC, 0);
  const view = new DataView(out.buffer);
  view.setUint32(4, payloadId >>> 0, true);
  view.setUint32(8, totalLen >>> 0, true);
  out[12] = modeCode;
  const ordinal = Number(startOrdinal) >>> 0;
  out[13] = ordinal >>> 16 & 255;
  out[14] = ordinal >>> 8 & 255;
  out[15] = ordinal & 255;
  let write = FRAME_HEADER_BYTES;
  for (const block of blocks) {
    if (!(block instanceof Uint8Array) || block.length !== AUDIO_BLOCK_SIZE) throw new Error("Unexpected Reliable transport block size.");
    out.set(block, write);
    write += AUDIO_BLOCK_SIZE;
  }
  view.setUint32(FRAME_BYTES - FRAME_CRC_BYTES, crc32(out.subarray(0, FRAME_BYTES - FRAME_CRC_BYTES)), true);
  return out;
}
function parseFrame(info) {
  const raw = bitsToBytes(info, FRAME_BYTES);
  for (let i = 0; i < MAGIC.length; i++) if (raw[i] !== MAGIC[i]) return [];
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (view.getUint32(FRAME_BYTES - FRAME_CRC_BYTES, true) !== crc32(raw.subarray(0, FRAME_BYTES - FRAME_CRC_BYTES))) return [];
  const totalLen = view.getUint32(8, true);
  const mode = MODE_NAMES[raw[12]];
  if (!mode || totalLen < 1 || totalLen > MAX_AUDIO_BYTES) return [];
  const k = sourceCount(totalLen, mode);
  if (codingMode(k) !== mode) return [];
  const payloadId = view.getUint32(4, true) >>> 0;
  const startOrdinal = raw[13] * 65536 + raw[14] * 256 + raw[15];
  const packets = [];
  let offset = FRAME_HEADER_BYTES;
  for (let i = 0; i < RELIABLE_PACKETS_PER_FRAME; i++) {
    packets.push({
      payloadId,
      totalLen,
      mode,
      encodingId: scheduledId(mode, startOrdinal + i),
      blockSize: AUDIO_BLOCK_SIZE,
      block: raw.slice(offset, offset + AUDIO_BLOCK_SIZE),
      profile: "reliable"
    });
    offset += AUDIO_BLOCK_SIZE;
  }
  return packets;
}
function makeSlots(coded, seed) {
  const slots = randomBits(SLOT_BITS, seed);
  let write = 0;
  for (let bit = 0; bit < coded.length; bit++) {
    for (let copy = 0; copy < SPREAD_COPIES; copy++) slots[SPREAD_SLOTS[write++]] = coded[bit];
  }
  return slots;
}
function combineSpreadSoft(slots) {
  const coded = new Float32Array(CODED_BITS);
  let read = 0;
  for (let bit = 0; bit < CODED_BITS; bit++) {
    const a = slots[SPREAD_SLOTS[read++]];
    const b = slots[SPREAD_SLOTS[read++]];
    coded[bit] = clamp((a + b) * 0.5, -1, 1);
  }
  return coded;
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

const PILOT_REAL = Array.from({ length: FRAME_SYMBOLS }, () => new Float64Array(PILOT_COUNT));
const PILOT_IMAG = Array.from({ length: FRAME_SYMBOLS }, () => new Float64Array(PILOT_COUNT));
for (let symbol = 0; symbol < FRAME_SYMBOLS; symbol++) {
  const vector = randomPhaseVector(0x5f356495 ^ Math.imul(symbol + 1, 0x45d9f3b), PILOT_COUNT);
  PILOT_REAL[symbol].set(vector.real);
  PILOT_IMAG[symbol].set(vector.imag);
}
function ofdmSymbol(carrierReal, carrierImag) {
  const real = new Float64Array(FFT_SIZE);
  const imag = new Float64Array(FFT_SIZE);
  for (let carrier = 0; carrier < CARRIER_COUNT; carrier++) {
    const bin = ACTIVE_FIRST + carrier;
    real[bin] = carrierReal[carrier];
    imag[bin] = carrierImag[carrier];
    real[FFT_SIZE - bin] = carrierReal[carrier];
    imag[FFT_SIZE - bin] = -carrierImag[carrier];
  }
  fft(real, imag, true);
  let energy = 0;
  for (const sample of real) energy += sample * sample;
  const scale = SYMBOL_RMS / (Math.sqrt(energy / FFT_SIZE) || 1);
  const body = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) body[i] = clamp(real[i] * scale, -PEAK_LIMIT, PEAK_LIMIT);
  const out = new Float32Array(SYMBOL_SAMPLES);
  out.set(body.subarray(FFT_SIZE - CYCLIC_PREFIX), 0);
  out.set(body, CYCLIC_PREFIX);
  return out;
}
function applyDqpsk(real, imag, slots, read) {
  for (const carrier of DATA_POSITIONS) {
    const a = slots[read++] || 0;
    const b = slots[read++] || 0;
    const r = real[carrier];
    const q = imag[carrier];
    if (a === 0 && b === 0) continue;
    if (a === 0 && b === 1) {
      real[carrier] = -q;
      imag[carrier] = r;
    } else if (a === 1 && b === 1) {
      real[carrier] = -r;
      imag[carrier] = -q;
    } else {
      real[carrier] = q;
      imag[carrier] = -r;
    }
  }
  return read;
}
function modulateReliableFrame(payloadId, totalLen, mode, startOrdinal, blocks) {
  const info = bytesToBits(buildFrameBytes(payloadId, totalLen, mode, startOrdinal, blocks));
  const coded = convolutionalEncode(info);
  const slots = makeSlots(coded, payloadId ^ Math.imul((startOrdinal >>> 0) + 1, 0x7f4a7c15));
  const waveform = new Float32Array(FRAME_SAMPLES);
  const anchor = randomPhaseVector((payloadId ^ Math.imul((startOrdinal >>> 0) + 1, 0x85ebca6b)) >>> 0, CARRIER_COUNT);
  const carrierReal = anchor.real;
  const carrierImag = anchor.imag;
  for (let p = 0; p < PILOT_COUNT; p++) {
    const carrier = PILOT_POSITIONS[p];
    carrierReal[carrier] = PILOT_REAL[0][p];
    carrierImag[carrier] = PILOT_IMAG[0][p];
  }
  waveform.set(ofdmSymbol(carrierReal, carrierImag), 0);
  let read = 0;
  for (let symbol = 1; symbol < FRAME_SYMBOLS; symbol++) {
    read = applyDqpsk(carrierReal, carrierImag, slots, read);
    for (let p = 0; p < PILOT_COUNT; p++) {
      const carrier = PILOT_POSITIONS[p];
      carrierReal[carrier] = PILOT_REAL[symbol][p];
      carrierImag[carrier] = PILOT_IMAG[symbol][p];
    }
    waveform.set(ofdmSymbol(carrierReal, carrierImag), symbol * SYMBOL_SAMPLES);
  }
  return waveform;
}

function spectrumAt(samples, symbolStart) {
  const body = symbolStart + CYCLIC_PREFIX - FFT_WINDOW_EARLY;
  if (body < 0 || body + FFT_SIZE > samples.length) return null;
  const real = new Float64Array(FFT_SIZE);
  const imag = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) real[i] = samples[body + i];
  fft(real, imag, false);
  return { real, imag };
}
function cpCorrelation(samples, offset, stride = 2) {
  let dot = 0;
  let leftEnergy = 0;
  let rightEnergy = 0;
  for (let i = 0; i < CYCLIC_PREFIX; i += stride) {
    const left = samples[offset + i];
    const right = samples[offset + FFT_SIZE + i];
    dot += left * right;
    leftEnergy += left * left;
    rightEnergy += right * right;
  }
  if (leftEnergy < 1e-8 || rightEnergy < 1e-8) return 0;
  return dot / Math.sqrt(leftEnergy * rightEnergy);
}
function acquisitionScore(samples, offset) {
  let score = 0;
  for (let symbol = 0; symbol < ACQUIRE_SYMBOLS; symbol++) {
    score += Math.max(0, cpCorrelation(samples, offset + symbol * SYMBOL_SAMPLES, 4));
  }
  return score / ACQUIRE_SYMBOLS;
}
function fitPhaseCorrection(errorReal, errorImag) {
  const real = new Float64Array(PILOT_COUNT);
  const imag = new Float64Array(PILOT_COUNT);
  const strengths = new Float64Array(PILOT_COUNT);
  for (let p = 0; p < PILOT_COUNT; p++) {
    const magnitude = Math.hypot(errorReal[p], errorImag[p]);
    strengths[p] = magnitude;
    if (Number.isFinite(magnitude) && magnitude > 1e-12) {
      real[p] = errorReal[p] / magnitude;
      imag[p] = errorImag[p] / magnitude;
    }
  }
  let slopeTotal = 0;
  for (let pass = 0; pass < 2; pass++) {
    let sr = 0;
    let si = 0;
    for (let p = 1; p < PILOT_COUNT; p++) {
      sr += real[p] * real[p - 1] + imag[p] * imag[p - 1];
      si += imag[p] * real[p - 1] - real[p] * imag[p - 1];
    }
    const slope = Math.atan2(si, sr) / PILOT_EVERY;
    if (!Number.isFinite(slope)) break;
    slopeTotal += slope;
    for (let p = 0; p < PILOT_COUNT; p++) {
      const angle = -slope * PILOT_POSITIONS[p];
      const cr = Math.cos(angle);
      const ci = Math.sin(angle);
      const nr = real[p] * cr - imag[p] * ci;
      const ni = real[p] * ci + imag[p] * cr;
      real[p] = nr;
      imag[p] = ni;
    }
  }
  let sr = 0;
  let si = 0;
  for (let p = 0; p < PILOT_COUNT; p++) {
    sr += real[p];
    si += imag[p];
  }
  const cpe = Math.atan2(si, sr);
  let residual = 0;
  for (let p = 0; p < PILOT_COUNT; p++) {
    const angle = -(cpe + slopeTotal * PILOT_POSITIONS[p]);
    const cr = Math.cos(angle);
    const ci = Math.sin(angle);
    const nr = errorReal[p] * cr - errorImag[p] * ci;
    const ni = errorReal[p] * ci + errorImag[p] * cr;
    const magnitude = Math.hypot(nr, ni);
    if (!Number.isFinite(magnitude) || magnitude < 1e-12) {
      residual += 4;
      continue;
    }
    const ur = nr / magnitude;
    const ui = ni / magnitude;
    residual += (ur - 1) * (ur - 1) + ui * ui;
  }
  residual /= PILOT_COUNT;
  return { slope: slopeTotal, cpe, residual, strengths, reliability: clamp(1 / (1 + 5 * residual), 0.04, 1) };
}
function classifyMarker(previous, current) {
  let best = null;
  for (let symbol = 0; symbol < FRAME_SYMBOLS; symbol++) {
    const previousSymbol = (symbol + FRAME_SYMBOLS - 1) % FRAME_SYMBOLS;
    const errorReal = new Float64Array(PILOT_COUNT);
    const errorImag = new Float64Array(PILOT_COUNT);
    for (let p = 0; p < PILOT_COUNT; p++) {
      const carrier = PILOT_POSITIONS[p];
      const bin = ACTIVE_FIRST + carrier;
      const pr = previous.real[bin];
      const pi = previous.imag[bin];
      const cr = current.real[bin];
      const ci = current.imag[bin];
      const dr = cr * pr + ci * pi;
      const di = ci * pr - cr * pi;
      const er = PILOT_REAL[symbol][p] * PILOT_REAL[previousSymbol][p]
        + PILOT_IMAG[symbol][p] * PILOT_IMAG[previousSymbol][p];
      const ei = PILOT_IMAG[symbol][p] * PILOT_REAL[previousSymbol][p]
        - PILOT_REAL[symbol][p] * PILOT_IMAG[previousSymbol][p];
      errorReal[p] = dr * er + di * ei;
      errorImag[p] = di * er - dr * ei;
    }
    const correction = fitPhaseCorrection(errorReal, errorImag);
    if (!best || correction.residual < best.residual) best = { symbol, ...correction };
  }
  return best && best.residual <= MARKER_MAX_RESIDUAL ? best : null;
}
function nearbyPilotStrength(correction, carrier) {
  const index = clamp(Math.round(carrier / PILOT_EVERY), 0, PILOT_COUNT - 1);
  return Math.max(1e-9, correction.strengths[index]);
}
function decodeTransition(previous, current, correction, slots, write) {
  for (const carrier of DATA_POSITIONS) {
    const bin = ACTIVE_FIRST + carrier;
    const pr = previous.real[bin];
    const pi = previous.imag[bin];
    const cr = current.real[bin];
    const ci = current.imag[bin];
    const dr = cr * pr + ci * pi;
    const di = ci * pr - cr * pi;
    const angle = -(correction.cpe + correction.slope * carrier);
    const ar = Math.cos(angle);
    const ai = Math.sin(angle);
    const nr = dr * ar - di * ai;
    const nq = dr * ai + di * ar;
    const magnitude = Math.hypot(nr, nq);
    if (!Number.isFinite(magnitude) || magnitude < 1e-12) {
      slots[write++] = 0;
      slots[write++] = 0;
      continue;
    }
    const r = nr / magnitude;
    const q = nq / magnitude;
    const strength = clamp(magnitude / (nearbyPilotStrength(correction, carrier) * 0.65), 0.03, 1);
    const weight = correction.reliability * strength;
    slots[write++] = clamp(-(r + q), -1, 1) * weight;
    slots[write++] = clamp(q - r, -1, 1) * weight;
  }
  return write;
}
function decodeSlots(slots) {
  return parseFrame(convolutionalDecode(combineSpreadSoft(slots)));
}

class ReliableScanner {
  constructor(onPacket, onSignal = () => void 0) {
    this.onPacket = onPacket;
    this.onSignal = onSignal;
    this.samples = new Float32Array(131072);
    this.length = 0;
    this.scan = 0;
    this.nextSymbolStart = -1;
    this.previousSpectrum = null;
    this.frameSlots = null;
    this.frameWrite = 0;
    this.frameNextSymbol = -1;
    this.markerFailures = 0;
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
    const needed = ACQUIRE_SYMBOLS * SYMBOL_SAMPLES;
    const maxCandidate = this.length - needed;
    if (maxCandidate < this.scan) return false;
    let bestOffset = -1;
    let bestScore = 0;
    for (let offset = this.scan; offset <= maxCandidate; offset += 12) {
      const score = acquisitionScore(this.samples, offset);
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
    for (let offset = Math.max(this.scan, coarse - 12); offset <= Math.min(maxCandidate, coarse + 12); offset++) {
      const score = acquisitionScore(this.samples, offset);
      if (score > bestScore) {
        bestScore = score;
        bestOffset = offset;
      }
    }
    this.nextSymbolStart = bestOffset;
    this.previousSpectrum = null;
    this.frameSlots = null;
    this.frameWrite = 0;
    this.frameNextSymbol = -1;
    this.markerFailures = 0;
    return true;
  }
  loseLock(start) {
    this.nextSymbolStart = -1;
    this.previousSpectrum = null;
    this.frameSlots = null;
    this.frameWrite = 0;
    this.frameNextSymbol = -1;
    this.markerFailures = 0;
    this.scan = Math.max(this.scan, start + Math.floor(SYMBOL_SAMPLES / 2));
  }
  beginFrame() {
    this.frameSlots = new Float32Array(SLOT_BITS);
    this.frameWrite = 0;
    this.frameNextSymbol = 1;
  }
  process() {
    while (true) {
      if (this.nextSymbolStart < 0 && !this.acquire()) return;
      if (this.nextSymbolStart + SYMBOL_SAMPLES > this.length) return;
      const predicted = this.nextSymbolStart;
      let start = predicted;
      let cpScore = cpCorrelation(this.samples, start, 2);
      for (let candidate = Math.max(0, predicted - 14); candidate <= predicted + 14; candidate++) {
        if (candidate + SYMBOL_SAMPLES > this.length) break;
        const score = cpCorrelation(this.samples, candidate, 2);
        if (score > cpScore) {
          cpScore = score;
          start = candidate;
        }
      }
      if (cpScore < TRACK_THRESHOLD) {
        this.loseLock(start);
        continue;
      }
      const current = spectrumAt(this.samples, start);
      if (!current) return;
      if (this.previousSpectrum) {
        const marker = classifyMarker(this.previousSpectrum, current);
        if (!marker) {
          this.markerFailures++;
          this.frameSlots = null;
          this.frameNextSymbol = -1;
        } else {
          this.markerFailures = 0;
          this.onSignal(clamp(1 - marker.residual / MARKER_MAX_RESIDUAL, 0, 1));
          const symbol = marker.symbol;
          if (symbol === 0) {
            this.beginFrame();
          } else {
            if (!this.frameSlots && symbol === 1) this.beginFrame();
            if (this.frameSlots && symbol === this.frameNextSymbol) {
              this.frameWrite = decodeTransition(this.previousSpectrum, current, marker, this.frameSlots, this.frameWrite);
              if (symbol === FRAME_SYMBOLS - 1) {
                const packets = decodeSlots(this.frameSlots);
                for (const packet of packets) this.onPacket(packet);
                this.frameSlots = null;
                this.frameWrite = 0;
                this.frameNextSymbol = -1;
              } else {
                this.frameNextSymbol++;
              }
            } else {
              this.frameSlots = null;
              this.frameWrite = 0;
              this.frameNextSymbol = -1;
            }
          }
        }
      }
      this.previousSpectrum = current;
      this.nextSymbolStart = start + SYMBOL_SAMPLES;
      this.scan = this.nextSymbolStart;
      if (this.markerFailures >= 4) {
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
    this.previousSpectrum = null;
    this.frameSlots = null;
    this.frameWrite = 0;
    this.frameNextSymbol = -1;
    this.markerFailures = 0;
  }
}

export {
  AUDIO_BLOCK_SIZE,
  AUDIO_ESTIMATED_KBPS,
  FRAME_SAMPLES,
  MAX_AUDIO_BYTES,
  RELIABLE_PACKETS_PER_FRAME,
  ReliableScanner,
  SAMPLE_RATE,
  modulateReliableFrame
};
