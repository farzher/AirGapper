import { codingMode, RAPTOR_PACKET_ID_BYTES } from "../shared/coding-mode.js";
import { crc32 } from "../shared/protocol.js";
import { isQuietProfile, modulateQuietPacket } from "./quiet-modem.js";

const SAMPLE_RATE = 48000;
const FFT_SIZE = 512;
const CYCLIC_PREFIX = 128;
const SYMBOL_SAMPLES = FFT_SIZE + CYCLIC_PREFIX;
const ACTIVE_FIRST = 12;
const ACTIVE_LAST = 176;
const CARRIER_COUNT = ACTIVE_LAST - ACTIVE_FIRST + 1;
const PILOT_EVERY = 12;
const PILOT_COUNT = Math.floor((CARRIER_COUNT - 1) / PILOT_EVERY) + 1;
const DATA_CARRIERS = CARRIER_COUNT - PILOT_COUNT;
const BITS_PER_SYMBOL = DATA_CARRIERS * 2;
const SYNC_SYMBOL_COUNT = 2;
const SYNC_SAMPLES = SYMBOL_SAMPLES * SYNC_SYMBOL_COUNT;
const PRE_GUARD = 0;
const TAIL_GUARD = 0;
const FFT_WINDOW_EARLY = 16;
const SYNC_THRESHOLD = 0.11;
const SYMBOL_RMS = 0.19;
const SYNC_TX_GAIN = 1;
const REFERENCE_TX_GAIN = 1;
const PINK_TILT = 0.12;
const HIGH_BAND_FLOOR = 0.85;
const TRACK_WINDOW = 1024;
const AUDIO_BLOCK_SIZE = 260;
const AUDIO_HEADER_BYTES = 16;
const AUDIO_CRC_BYTES = 4;
const AUDIO_PACKET_BYTES = AUDIO_HEADER_BYTES + AUDIO_BLOCK_SIZE + AUDIO_CRC_BYTES;
const MAX_AUDIO_BYTES = 1024 * 1024;
const MAGIC = new Uint8Array([0x41, 0x47, 0x41, 0x34]); // AGA4
const MODE_NAMES = ["direct", "mds", "raptorq"];
const MODE_CODES = new Map(MODE_NAMES.map((mode, index) => [mode, index]));
const TAIL_BITS = 6;

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
const DATA_SYMBOLS = Math.ceil(CODED_BITS / BITS_PER_SYMBOL);
const SLOT_BITS = DATA_SYMBOLS * BITS_PER_SYMBOL;
const INTERLEAVE_STEP = interleaveStep(SLOT_BITS);
const FRAME_FROM_SYNC_SAMPLES = SYNC_SAMPLES + SYMBOL_SAMPLES * (DATA_SYMBOLS + 1) + TAIL_GUARD;
const FRAME_TOTAL_SAMPLES = PRE_GUARD + FRAME_FROM_SYNC_SAMPLES;
const AUDIO_ESTIMATED_KBPS =
  (AUDIO_BLOCK_SIZE - RAPTOR_PACKET_ID_BYTES) / (FRAME_TOTAL_SAMPLES / SAMPLE_RATE) / 1024;

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
    const wLengthReal = Math.cos(angle);
    const wLengthImag = Math.sin(angle);
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
        const nextWr = wr * wLengthReal - wi * wLengthImag;
        wi = wr * wLengthImag + wi * wLengthReal;
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

const CARRIER_WEIGHT = new Float64Array(CARRIER_COUNT);
for (let carrier = 0; carrier < CARRIER_COUNT; carrier++) {
  const ratio = (ACTIVE_FIRST + carrier) / ACTIVE_FIRST;
  const pink = Math.pow(ratio, -PINK_TILT);
  CARRIER_WEIGHT[carrier] = HIGH_BAND_FLOOR + (1 - HIGH_BAND_FLOOR) * pink;
}
function phaseVector(seed) {
  const real = new Float64Array(CARRIER_COUNT);
  const imag = new Float64Array(CARRIER_COUNT);
  let state = seed >>> 0;
  for (let carrier = 0; carrier < CARRIER_COUNT; carrier++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const phase = (state >>> 0) / 4294967296 * Math.PI * 2;
    real[carrier] = Math.cos(phase);
    imag[carrier] = Math.sin(phase);
  }
  return { real, imag };
}
function ofdmSymbol(carrierReal, carrierImag) {
  const real = new Float64Array(FFT_SIZE);
  const imag = new Float64Array(FFT_SIZE);
  for (let carrier = 0; carrier < CARRIER_COUNT; carrier++) {
    const bin = ACTIVE_FIRST + carrier;
    const weight = CARRIER_WEIGHT[carrier];
    const r = carrierReal[carrier] * weight;
    const q = carrierImag[carrier] * weight;
    real[bin] = r;
    imag[bin] = q;
    real[FFT_SIZE - bin] = r;
    imag[FFT_SIZE - bin] = -q;
  }
  fft(real, imag, true);
  let energy = 0;
  let peak = 0;
  for (const sample of real) {
    energy += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }
  const rms = Math.sqrt(energy / FFT_SIZE) || 1;
  const scale = Math.min(SYMBOL_RMS / rms, 0.72 / Math.max(peak, 1e-9));
  const out = new Float32Array(SYMBOL_SAMPLES);
  for (let i = 0; i < CYCLIC_PREFIX; i++) out[i] = real[FFT_SIZE - CYCLIC_PREFIX + i] * scale;
  for (let i = 0; i < FFT_SIZE; i++) out[CYCLIC_PREFIX + i] = real[i] * scale;
  return out;
}

const SYNC_A = phaseVector(0x2a68d53b);
const SYNC_B = phaseVector(0x91e10da5);
const REFERENCE = phaseVector(0x6d2b79f5);
const SYNC_A_SYMBOL = ofdmSymbol(SYNC_A.real, SYNC_A.imag);
const SYNC_B_SYMBOL = ofdmSymbol(SYNC_B.real, SYNC_B.imag);
const REFERENCE_SYMBOL = ofdmSymbol(REFERENCE.real, REFERENCE.imag);
const SYNC = new Float32Array(SYNC_SAMPLES);
SYNC.set(SYNC_A_SYMBOL, 0);
SYNC.set(SYNC_B_SYMBOL, SYMBOL_SAMPLES);
let syncEnergy = 0;
let syncEnergyCoarse = 0;
for (let i = 0; i < SYNC.length; i++) {
  syncEnergy += SYNC[i] * SYNC[i];
  if ((i & 3) === 0) syncEnergyCoarse += SYNC[i] * SYNC[i];
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
function parseAudioPacket(raw) {
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
function applyDqpsk(real, imag, a, b) {
  for (let i = 0; i < real.length; i++) {
    const r = real[i];
    const q = imag[i];
    if (a[i] === 0 && b[i] === 0) continue;
    if (a[i] === 0 && b[i] === 1) {
      real[i] = -q;
      imag[i] = r;
    } else if (a[i] === 1 && b[i] === 1) {
      real[i] = -r;
      imag[i] = -q;
    } else {
      real[i] = q;
      imag[i] = -r;
    }
  }
}
function modulateReliablePacket(payloadId, totalLen, mode, encodingId, block) {
  const raw = packetBytes(payloadId, totalLen, mode, encodingId, block);
  const coded = convolutionalEncode(bytesToBits(raw));
  const slots = interleave(coded);
  const waveform = new Float32Array(FRAME_TOTAL_SAMPLES);
  let offset = PRE_GUARD;
  for (let i = 0; i < SYNC_SAMPLES; i++) waveform[offset + i] = clamp(SYNC[i] * SYNC_TX_GAIN, -0.95, 0.95);
  offset += SYNC_SAMPLES;
  for (let i = 0; i < SYMBOL_SAMPLES; i++) waveform[offset + i] = clamp(REFERENCE_SYMBOL[i] * REFERENCE_TX_GAIN, -0.95, 0.95);
  offset += SYMBOL_SAMPLES;
  const carrierReal = REFERENCE.real.slice();
  const carrierImag = REFERENCE.imag.slice();
  const a = new Uint8Array(CARRIER_COUNT);
  const b = new Uint8Array(CARRIER_COUNT);
  for (let symbol = 0; symbol < DATA_SYMBOLS; symbol++) {
    let read = symbol * BITS_PER_SYMBOL;
    for (let carrier = 0; carrier < CARRIER_COUNT; carrier++) {
      if (carrier % PILOT_EVERY === 0) {
        a[carrier] = 0;
        b[carrier] = 0;
      } else {
        a[carrier] = slots[read++] || 0;
        b[carrier] = slots[read++] || 0;
      }
    }
    applyDqpsk(carrierReal, carrierImag, a, b);
    waveform.set(ofdmSymbol(carrierReal, carrierImag), offset);
    offset += SYMBOL_SAMPLES;
  }
  return waveform;
}
function modulateAudioPacket(payloadId, totalLen, mode, encodingId, block) {
  if (isQuietProfile()) return modulateQuietPacket(payloadId, totalLen, mode, encodingId, block);
  return modulateReliablePacket(payloadId, totalLen, mode, encodingId, block);
}

function spectrumAt(samples, bodyOffset) {
  const real = new Float64Array(FFT_SIZE);
  const imag = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) real[i] = samples[bodyOffset + i];
  fft(real, imag, false);
  return { real, imag };
}
function fitPilotCorrection(diffReal, diffImag) {
  const pr = new Float64Array(PILOT_COUNT);
  const pi = new Float64Array(PILOT_COUNT);
  const positions = new Int32Array(PILOT_COUNT);
  let count = 0;
  for (let carrier = 0; carrier < CARRIER_COUNT; carrier += PILOT_EVERY) {
    const magnitude = Math.hypot(diffReal[carrier], diffImag[carrier]);
    if (!Number.isFinite(magnitude) || magnitude < 1e-12) {
      pr[count] = 0;
      pi[count] = 0;
    } else {
      pr[count] = diffReal[carrier] / magnitude;
      pi[count] = diffImag[carrier] / magnitude;
    }
    positions[count] = carrier;
    count++;
  }
  let slopeTotal = 0;
  for (let pass = 0; pass < 3; pass++) {
    let sr = 0;
    let si = 0;
    for (let i = 1; i < count; i++) {
      sr += pr[i] * pr[i - 1] + pi[i] * pi[i - 1];
      si += pi[i] * pr[i - 1] - pr[i] * pi[i - 1];
    }
    const slope = Math.atan2(si, sr) / PILOT_EVERY;
    if (!Number.isFinite(slope)) break;
    slopeTotal += slope;
    for (let i = 0; i < count; i++) {
      const angle = -slope * positions[i];
      const cr = Math.cos(angle);
      const ci = Math.sin(angle);
      const nr = pr[i] * cr - pi[i] * ci;
      const ni = pr[i] * ci + pi[i] * cr;
      pr[i] = nr;
      pi[i] = ni;
    }
  }
  let sr = 0;
  let si = 0;
  for (let i = 0; i < count; i++) {
    sr += pr[i];
    si += pi[i];
  }
  const cpe = Math.atan2(si, sr);
  let residual = 0;
  const cr = Math.cos(-cpe);
  const ci = Math.sin(-cpe);
  for (let i = 0; i < count; i++) {
    const nr = pr[i] * cr - pi[i] * ci;
    const ni = pr[i] * ci + pi[i] * cr;
    residual += (nr - 1) * (nr - 1) + ni * ni;
  }
  const evm2 = residual / Math.max(1, count);
  const reliability = clamp(1 / (1 + 8 * evm2), 0.06, 1);
  return { slope: slopeTotal, cpe, reliability };
}
function decodeFrame(samples, syncOffset, windowShift = 0) {
  const slots = new Float32Array(SLOT_BITS);
  let body = syncOffset + SYNC_SAMPLES + CYCLIC_PREFIX - FFT_WINDOW_EARLY + windowShift;
  if (body < 0 || body + FFT_SIZE > samples.length) return null;
  let previous = spectrumAt(samples, body);
  body += SYMBOL_SAMPLES;
  let write = 0;
  const diffReal = new Float64Array(CARRIER_COUNT);
  const diffImag = new Float64Array(CARRIER_COUNT);
  for (let symbol = 0; symbol < DATA_SYMBOLS; symbol++, body += SYMBOL_SAMPLES) {
    if (body < 0 || body + FFT_SIZE > samples.length) return null;
    const current = spectrumAt(samples, body);
    for (let carrier = 0; carrier < CARRIER_COUNT; carrier++) {
      const bin = ACTIVE_FIRST + carrier;
      const pr = previous.real[bin];
      const pi = previous.imag[bin];
      const cr = current.real[bin];
      const ci = current.imag[bin];
      diffReal[carrier] = cr * pr + ci * pi;
      diffImag[carrier] = ci * pr - cr * pi;
    }
    const correction = fitPilotCorrection(diffReal, diffImag);
    for (let carrier = 0; carrier < CARRIER_COUNT; carrier++) {
      if (carrier % PILOT_EVERY === 0) continue;
      const angle = -(correction.cpe + correction.slope * carrier);
      const cr = Math.cos(angle);
      const ci = Math.sin(angle);
      const r = diffReal[carrier] * cr - diffImag[carrier] * ci;
      const q = diffReal[carrier] * ci + diffImag[carrier] * cr;
      const magnitude = Math.hypot(r, q);
      if (!Number.isFinite(magnitude) || magnitude < 1e-12) {
        slots[write++] = 0;
        slots[write++] = 0;
        continue;
      }
      const nr = r / magnitude;
      const nq = q / magnitude;
      slots[write++] = clamp(-(nr + nq), -1, 1) * correction.reliability;
      slots[write++] = clamp(nq - nr, -1, 1) * correction.reliability;
    }
    previous = current;
  }
  const coded = deinterleaveSoft(slots);
  const decoded = convolutionalDecode(coded, RAW_PACKET_BITS);
  return parseAudioPacket(bitsToBytes(decoded, AUDIO_PACKET_BYTES));
}
function syncCorrelation(samples, offset, stride = 1) {
  let dot = 0;
  let energy = 0;
  for (let i = 0; i < SYNC_SAMPLES; i += stride) {
    const value = samples[offset + i];
    dot += value * SYNC[i];
    energy += value * value;
  }
  const count = Math.ceil(SYNC_SAMPLES / stride);
  if (energy < 0.002 * 0.002 * count) return 0;
  const referenceEnergy = stride === 4 ? syncEnergyCoarse : syncEnergy;
  return Math.abs(dot) / Math.sqrt(Math.max(1e-20, energy * referenceEnergy));
}
function decodeAt(samples, offset, maxCandidate) {
  let refinedOffset = offset;
  let refinedScore = syncCorrelation(samples, offset, 4);
  for (let candidate = Math.max(0, offset - 8); candidate <= Math.min(maxCandidate, offset + 8); candidate++) {
    const score = syncCorrelation(samples, candidate, 1);
    if (score > refinedScore) {
      refinedScore = score;
      refinedOffset = candidate;
    }
  }
  if (refinedScore < SYNC_THRESHOLD) return null;
  let packet = decodeFrame(samples, refinedOffset, 0);
  if (!packet) {
    for (const shift of [-8, 8, -16, 16, -24, 24]) {
      packet = decodeFrame(samples, refinedOffset, shift);
      if (packet) break;
    }
  }
  return { packet, offset: refinedOffset, score: refinedScore };
}

class ReliableScanner {
  constructor(onPacket, onSignal = () => void 0) {
    this.onPacket = onPacket;
    this.onSignal = onSignal;
    this.samples = new Float32Array(65536);
    this.length = 0;
    this.scan = 0;
    this.expectedSync = -1;
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
      const maxCandidate = this.length - FRAME_FROM_SYNC_SAMPLES;
      if (maxCandidate < 0) return;

      if (this.expectedSync >= 0) {
        if (this.expectedSync - TRACK_WINDOW > maxCandidate) return;
        const start = Math.max(this.scan, this.expectedSync - TRACK_WINDOW, 0);
        const end = Math.min(maxCandidate, this.expectedSync + TRACK_WINDOW);
        let bestOffset = -1;
        let bestScore = 0;
        for (let offset = start; offset <= end; offset += 4) {
          const score = syncCorrelation(this.samples, offset, 4);
          if (score > bestScore) {
            bestScore = score;
            bestOffset = offset;
          }
        }
        if (bestOffset >= 0 && bestScore >= SYNC_THRESHOLD * 0.72) {
          const decoded = decodeAt(this.samples, bestOffset, maxCandidate);
          if (decoded?.packet) {
            this.onSignal(decoded.score);
            this.onPacket(decoded.packet);
            this.expectedSync = decoded.offset + FRAME_TOTAL_SAMPLES;
            this.scan = Math.max(this.scan, decoded.offset + FRAME_FROM_SYNC_SAMPLES);
            this.compact();
            continue;
          }
        }
        if (end < this.expectedSync + TRACK_WINDOW) return;
        this.expectedSync = -1;
        this.scan = Math.max(this.scan, start);
      }

      if (maxCandidate < this.scan) return;
      let bestOffset = -1;
      let bestScore = 0;
      for (let offset = this.scan; offset <= maxCandidate; offset += 8) {
        const score = syncCorrelation(this.samples, offset, 4);
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
      const decoded = decodeAt(this.samples, bestOffset, maxCandidate);
      if (decoded?.packet) {
        this.onSignal(decoded.score);
        this.onPacket(decoded.packet);
        this.expectedSync = decoded.offset + FRAME_TOTAL_SAMPLES;
        this.scan = decoded.offset + FRAME_FROM_SYNC_SAMPLES;
      } else {
        this.scan = bestOffset + Math.max(CYCLIC_PREFIX * 2, 256);
      }
      this.compact();
    }
  }
  compact() {
    if (this.scan < 32768) return;
    const keepFrom = Math.max(0, this.scan - SYNC_SAMPLES);
    this.samples.copyWithin(0, keepFrom, this.length);
    this.length -= keepFrom;
    this.scan -= keepFrom;
    if (this.expectedSync >= 0) this.expectedSync -= keepFrom;
  }
  reset() {
    this.length = 0;
    this.scan = 0;
    this.expectedSync = -1;
  }
}

class StreamingResampler {
  constructor(inputRate) {
    this.ratio = inputRate / SAMPLE_RATE;
    this.position = 0;
    this.last = 0;
    this.started = false;
  }
  push(chunk) {
    if (this.ratio === 1) return new Float32Array(chunk);
    const source = new Float32Array(chunk.length + 1);
    source[0] = this.started ? this.last : chunk[0] || 0;
    source.set(chunk, 1);
    this.started = true;
    this.last = source[source.length - 1];
    const values = [];
    let position = this.position;
    while (position < source.length - 1) {
      const index = Math.floor(position);
      const fraction = position - index;
      values.push(source[index] + (source[index + 1] - source[index]) * fraction);
      position += this.ratio;
    }
    this.position = position - (source.length - 1);
    return Float32Array.from(values);
  }
}

class AcousticReceiver {
  constructor(onPacket, onSignal = () => void 0) {
    this.onPacket = onPacket;
    this.onSignal = onSignal;
    this.stream = null;
    this.context = null;
    this.source = null;
    this.processor = null;
    this.silent = null;
    this.resampler = null;
    this.worker = null;
    this.quietWorker = null;
    this.running = false;
  }
  async start() {
    if (this.running) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone access is not available in this browser.");
    const audio = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
      sampleRate: SAMPLE_RATE
    };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    } catch (error) {
      if (error?.name === "NotAllowedError" || error?.name === "SecurityError") throw error;
      const { sampleRate, ...withoutRate } = audio;
      stream = await navigator.mediaDevices.getUserMedia({ audio: withoutRate, video: false });
    }
    const AudioContextType = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextType) {
      for (const track of stream.getTracks()) track.stop();
      throw new Error("Web Audio is not available in this browser.");
    }
    const context = new AudioContextType({ latencyHint: "interactive", sampleRate: SAMPLE_RATE });
    if (!context.createScriptProcessor) {
      for (const track of stream.getTracks()) track.stop();
      await context.close();
      throw new Error("Audio receive is not supported in this browser.");
    }
    const workerUrl = new URL("./reliable-worker.js", import.meta.url);
    workerUrl.search = new URL(import.meta.url).search;
    const quietWorkerUrl = new URL("./quiet-worker.js", import.meta.url);
    quietWorkerUrl.search = new URL(import.meta.url).search;
    const worker = new Worker(workerUrl, { type: "module" });
    const quietWorker = new Worker(quietWorkerUrl, { type: "module" });
    const handlePacket = (event) => {
      if (!this.running) return;
      const packet = event.data?.packet;
      if (!packet || !(packet.block instanceof ArrayBuffer)) return;
      this.onPacket({ ...packet, block: new Uint8Array(packet.block) });
    };
    worker.onmessage = (event) => {
      if (!this.running) return;
      if (event.data?.type === "signal") {
        this.onSignal(Number(event.data.quality) || 0);
        return;
      }
      handlePacket(event);
    };
    quietWorker.onmessage = handlePacket;
    await context.resume();
    this.stream = stream;
    this.context = context;
    this.worker = worker;
    this.quietWorker = quietWorker;
    this.resampler = new StreamingResampler(context.sampleRate);
    this.source = context.createMediaStreamSource(stream);
    this.processor = context.createScriptProcessor(1024, 1, 1);
    this.silent = context.createGain();
    this.silent.gain.value = 0;
    this.running = true;
    this.processor.onaudioprocess = (event) => {
      if (!this.running) return;
      this.append(this.resampler.push(event.inputBuffer.getChannelData(0)));
    };
    this.source.connect(this.processor);
    this.processor.connect(this.silent);
    this.silent.connect(context.destination);
  }
  append(chunk) {
    if (!chunk?.length) return;
    if (this.worker) {
      const copy = new Float32Array(chunk);
      this.worker.postMessage({ type: "samples", samples: copy.buffer }, [copy.buffer]);
    }
    if (this.quietWorker) {
      const copy = new Float32Array(chunk);
      this.quietWorker.postMessage({ type: "samples", samples: copy.buffer }, [copy.buffer]);
    }
  }
  async stop() {
    if (!this.running && !this.stream && !this.context && !this.worker && !this.quietWorker) return;
    this.running = false;
    if (this.processor) this.processor.onaudioprocess = null;
    try { this.source?.disconnect(); } catch {}
    try { this.processor?.disconnect(); } catch {}
    try { this.silent?.disconnect(); } catch {}
    for (const track of this.stream?.getTracks?.() ?? []) track.stop();
    this.worker?.terminate();
    this.quietWorker?.terminate();
    const context = this.context;
    this.stream = this.context = this.source = this.processor = this.silent = this.resampler = this.worker = this.quietWorker = null;
    if (context && context.state !== "closed") await context.close().catch(() => void 0);
  }
}

export {
  AUDIO_BLOCK_SIZE,
  AUDIO_ESTIMATED_KBPS,
  AcousticReceiver,
  MAX_AUDIO_BYTES,
  ReliableScanner,
  SAMPLE_RATE,
  modulateAudioPacket
};
