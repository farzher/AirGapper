import { codingMode, RAPTOR_PACKET_ID_BYTES } from "../shared/coding-mode.js";
import { crc32 } from "../shared/protocol.js";

const SAMPLE_RATE = 48000;
const FFT_SIZE = 512;
const CYCLIC_PREFIX = 96;
const SYMBOL_SAMPLES = FFT_SIZE + CYCLIC_PREFIX;
const ACTIVE_FIRST = 16;
const ACTIVE_LAST = 176;
const CARRIER_COUNT = ACTIVE_LAST - ACTIVE_FIRST + 1;
const PILOT_EVERY = 16;
const PILOT_COUNT = Math.floor((CARRIER_COUNT - 1) / PILOT_EVERY) + 1;
const DATA_CARRIERS = CARRIER_COUNT - PILOT_COUNT;
const BITS_PER_SYMBOL = DATA_CARRIERS * 2;
const SYNC_SAMPLES = 768;
const SYNC_GAP = 256;
const PRE_GUARD = 96;
const TAIL_GUARD = 96;
const FFT_WINDOW_EARLY = 12;
const SYNC_THRESHOLD = 0.32;
const AUDIO_BLOCK_SIZE = 260;
const AUDIO_HEADER_BYTES = 16;
const AUDIO_CRC_BYTES = 4;
const AUDIO_PACKET_BYTES = AUDIO_HEADER_BYTES + AUDIO_BLOCK_SIZE + AUDIO_CRC_BYTES;
const MAX_AUDIO_BYTES = 1024 * 1024;
const MAGIC = new Uint8Array([0x41, 0x47, 0x41, 0x33]); // AGA3
const MODE_NAMES = ["direct", "mds", "raptorq"];
const MODE_CODES = new Map(MODE_NAMES.map((mode, index) => [mode, index]));
const PUNCTURE = new Uint8Array([1, 1, 1, 0]);
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
  const out = new Uint8Array(Math.ceil(steps * 3 / 2));
  let state = 0;
  let write = 0;
  let puncture = 0;
  for (let step = 0; step < steps; step++) {
    const input = step < payloadBits.length ? payloadBits[step] : 0;
    const register = (state << 1 | input) & 0x7f;
    const a = parity(register & 0x79);
    const b = parity(register & 0x5b);
    if (PUNCTURE[puncture++ & 3]) out[write++] = a;
    if (PUNCTURE[puncture++ & 3]) out[write++] = b;
    state = register & 0x3f;
  }
  return write === out.length ? out : out.subarray(0, write);
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
    const p = step * 2;
    const hasA = PUNCTURE[p & 3] !== 0;
    const hasB = PUNCTURE[p + 1 & 3] !== 0;
    const receivedA = hasA ? codedSoft[read++] : 0;
    const receivedB = hasB ? codedSoft[read++] : 0;
    next.fill(infinity);
    for (let state = 0; state < stateCount; state++) {
      const baseMetric = metrics[state];
      if (baseMetric >= infinity) continue;
      for (let input = 0; input < 2; input++) {
        const register = (state << 1 | input) & 0x7f;
        const target = register & 0x3f;
        let metric = baseMetric;
        if (hasA) metric += softBitCost(parity(register & 0x79), receivedA);
        if (hasB) metric += softBitCost(parity(register & 0x5b), receivedB);
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
const FRAME_FROM_SYNC_SAMPLES = SYNC_SAMPLES + SYNC_GAP + SYMBOL_SAMPLES * (DATA_SYMBOLS + 1) + TAIL_GUARD;
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
function makeSync() {
  const out = new Float32Array(SYNC_SAMPLES);
  const duration = SYNC_SAMPLES / SAMPLE_RATE;
  const startHz = 1500;
  const endHz = 16500;
  const sweep = (endHz - startHz) / duration;
  for (let i = 0; i < out.length; i++) {
    const time = i / SAMPLE_RATE;
    const edge = Math.min(1, i / 40, (out.length - 1 - i) / 40);
    const window = Math.sin(Math.max(0, edge) * Math.PI / 2) ** 2;
    out[i] = 0.62 * window * Math.sin(2 * Math.PI * (startHz * time + sweep * time * time / 2));
  }
  return out;
}
const SYNC = makeSync();
let syncEnergy = 0;
for (const sample of SYNC) syncEnergy += sample * sample;

const REFERENCE_REAL = new Float64Array(CARRIER_COUNT);
const REFERENCE_IMAG = new Float64Array(CARRIER_COUNT);
{
  let seed = 0x6d2b79f5;
  for (let i = 0; i < CARRIER_COUNT; i++) {
    seed = Math.imul(seed ^ seed >>> 15, 1 | seed);
    seed ^= seed + Math.imul(seed ^ seed >>> 7, 61 | seed);
    const quadrant = (seed ^ seed >>> 14) & 3;
    REFERENCE_REAL[i] = quadrant === 0 ? 1 : quadrant === 2 ? -1 : 0;
    REFERENCE_IMAG[i] = quadrant === 1 ? 1 : quadrant === 3 ? -1 : 0;
  }
}
function ofdmSymbol(carrierReal, carrierImag) {
  const real = new Float64Array(FFT_SIZE);
  const imag = new Float64Array(FFT_SIZE);
  for (let i = 0; i < CARRIER_COUNT; i++) {
    const bin = ACTIVE_FIRST + i;
    real[bin] = carrierReal[i];
    imag[bin] = carrierImag[i];
    real[FFT_SIZE - bin] = carrierReal[i];
    imag[FFT_SIZE - bin] = -carrierImag[i];
  }
  fft(real, imag, true);
  let energy = 0;
  let peak = 0;
  for (const sample of real) {
    energy += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }
  const rms = Math.sqrt(energy / FFT_SIZE) || 1;
  const scale = Math.min(0.18 / rms, 0.78 / Math.max(peak, 1e-9));
  const out = new Float32Array(SYMBOL_SAMPLES);
  for (let i = 0; i < CYCLIC_PREFIX; i++) out[i] = real[FFT_SIZE - CYCLIC_PREFIX + i] * scale;
  for (let i = 0; i < FFT_SIZE; i++) out[CYCLIC_PREFIX + i] = real[i] * scale;
  return out;
}
const REFERENCE_SYMBOL = ofdmSymbol(REFERENCE_REAL, REFERENCE_IMAG);

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
function modulateAudioPacket(payloadId, totalLen, mode, encodingId, block) {
  const raw = packetBytes(payloadId, totalLen, mode, encodingId, block);
  const coded = convolutionalEncode(bytesToBits(raw));
  const slots = interleave(coded);
  const waveform = new Float32Array(FRAME_TOTAL_SAMPLES);
  let offset = PRE_GUARD;
  waveform.set(SYNC, offset);
  offset += SYNC_SAMPLES + SYNC_GAP;
  waveform.set(REFERENCE_SYMBOL, offset);
  offset += SYMBOL_SAMPLES;
  const carrierReal = REFERENCE_REAL.slice();
  const carrierImag = REFERENCE_IMAG.slice();
  const a = new Uint8Array(CARRIER_COUNT);
  const b = new Uint8Array(CARRIER_COUNT);
  for (let symbol = 0; symbol < DATA_SYMBOLS; symbol++) {
    let read = symbol * BITS_PER_SYMBOL;
    for (let carrier = 0; carrier < CARRIER_COUNT; carrier++) {
      if (carrier % PILOT_EVERY === 0) {
        a[carrier] = 0;
        b[carrier] = 0;
      } else {
        a[carrier] = slots[read++];
        b[carrier] = slots[read++];
      }
    }
    applyDqpsk(carrierReal, carrierImag, a, b);
    waveform.set(ofdmSymbol(carrierReal, carrierImag), offset);
    offset += SYMBOL_SAMPLES;
  }
  return waveform;
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
    block: raw.slice(AUDIO_HEADER_BYTES, AUDIO_HEADER_BYTES + AUDIO_BLOCK_SIZE)
  };
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
  for (let i = 0; i < count; i++) {
    const cr = Math.cos(-cpe);
    const ci = Math.sin(-cpe);
    const nr = pr[i] * cr - pi[i] * ci;
    const ni = pr[i] * ci + pi[i] * cr;
    residual += (nr - 1) * (nr - 1) + ni * ni;
  }
  const evm2 = residual / Math.max(1, count);
  const reliability = clamp(1 / (1 + 8 * evm2), 0.08, 1);
  return { slope: slopeTotal, cpe, reliability };
}
function decodeFrame(samples, syncOffset, windowShift = 0) {
  const slots = new Float32Array(SLOT_BITS);
  let body = syncOffset + SYNC_SAMPLES + SYNC_GAP + CYCLIC_PREFIX - FFT_WINDOW_EARLY + windowShift;
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
function syncCorrelation(samples, offset) {
  let dot = 0;
  let energy = 0;
  for (let i = 0; i < SYNC_SAMPLES; i++) {
    const value = samples[offset + i];
    dot += value * SYNC[i];
    energy += value * value;
  }
  if (energy < 0.004 * 0.004 * SYNC_SAMPLES) return 0;
  return Math.abs(dot) / Math.sqrt(energy * syncEnergy);
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
    this.samples = new Float32Array(32768);
    this.length = 0;
    this.scan = 0;
    this.running = false;
  }
  async start() {
    if (this.running) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone access is not available in this browser.");
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
          sampleRate: SAMPLE_RATE
        },
        video: false
      });
    } catch (error) {
      if (error?.name === "NotAllowedError" || error?.name === "SecurityError") throw error;
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
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
    await context.resume();
    this.stream = stream;
    this.context = context;
    this.resampler = new StreamingResampler(context.sampleRate);
    this.source = context.createMediaStreamSource(stream);
    this.processor = context.createScriptProcessor(2048, 1, 1);
    this.silent = context.createGain();
    this.silent.gain.value = 0;
    this.processor.onaudioprocess = (event) => {
      if (!this.running) return;
      this.append(this.resampler.push(event.inputBuffer.getChannelData(0)));
    };
    this.source.connect(this.processor);
    this.processor.connect(this.silent);
    this.silent.connect(context.destination);
    this.running = true;
  }
  append(chunk) {
    if (!chunk.length) return;
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
    while (this.running) {
      const maxCandidate = this.length - FRAME_FROM_SYNC_SAMPLES;
      if (maxCandidate < this.scan) break;
      let bestOffset = -1;
      let bestScore = 0;
      for (let offset = this.scan; offset <= maxCandidate; offset += 4) {
        const score = syncCorrelation(this.samples, offset);
        if (score > bestScore) {
          bestScore = score;
          bestOffset = offset;
        }
      }
      if (bestScore < SYNC_THRESHOLD) {
        this.scan = Math.max(this.scan, maxCandidate - SYNC_SAMPLES);
        break;
      }
      let refinedOffset = bestOffset;
      let refinedScore = bestScore;
      const start = Math.max(this.scan, bestOffset - 6);
      const end = Math.min(maxCandidate, bestOffset + 6);
      for (let offset = start; offset <= end; offset++) {
        const score = syncCorrelation(this.samples, offset);
        if (score > refinedScore) {
          refinedScore = score;
          refinedOffset = offset;
        }
      }
      this.onSignal(refinedScore);
      let packet = decodeFrame(this.samples, refinedOffset, 0);
      if (!packet) {
        for (const shift of [-8, 8, -16, 16]) {
          packet = decodeFrame(this.samples, refinedOffset, shift);
          if (packet) break;
        }
      }
      if (packet) {
        this.onPacket(packet);
        this.scan = refinedOffset + FRAME_FROM_SYNC_SAMPLES;
      } else {
        this.scan = refinedOffset + 96;
      }
      this.compact();
    }
  }
  compact() {
    if (this.scan < 16384) return;
    const keepFrom = Math.max(0, this.scan - SYNC_SAMPLES);
    this.samples.copyWithin(0, keepFrom, this.length);
    this.length -= keepFrom;
    this.scan -= keepFrom;
  }
  async stop() {
    if (!this.running && !this.stream && !this.context) return;
    this.running = false;
    if (this.processor) this.processor.onaudioprocess = null;
    try { this.source?.disconnect(); } catch {}
    try { this.processor?.disconnect(); } catch {}
    try { this.silent?.disconnect(); } catch {}
    for (const track of this.stream?.getTracks?.() ?? []) track.stop();
    const context = this.context;
    this.stream = this.context = this.source = this.processor = this.silent = this.resampler = null;
    this.length = 0;
    this.scan = 0;
    if (context && context.state !== "closed") await context.close().catch(() => void 0);
  }
}

export {
  AUDIO_BLOCK_SIZE,
  AUDIO_ESTIMATED_KBPS,
  AcousticReceiver,
  MAX_AUDIO_BYTES,
  SAMPLE_RATE,
  modulateAudioPacket
};