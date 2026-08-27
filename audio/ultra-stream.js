import ggwaveFactory from "../vendor/ggwave.mjs";
import {
  GGWAVE_DSS,
  GGWAVE_TX,
  ULTRA_MESSAGE_LENGTH
} from "./ultra-config.js";
import {
  ULTRA_AUDIO_BLOCK_SIZE,
  ULTRA_PACKETS_PER_FRAME,
  buildUltraMessage
} from "./ultra-format.js";

const SAMPLE_RATE = 48000;
const GGWAVE_VOLUME = 20;
const GGWAVE_FREQ_START = 24; // 1.125 kHz, shifted down for phone speakers/mics
const GUARD_SAMPLES = Math.round(SAMPLE_RATE * 0.24);
const TRANSMISSIONS_PER_BLOCK = 4; // A B A B
const ggwave = await ggwaveFactory();
ggwave.disableLog?.();
const protocol = ggwave.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_NORMAL;
ggwave.txProtocolSetFreqStart(protocol, GGWAVE_FREQ_START);
const parameters = ggwave.getDefaultParameters();
parameters.payloadLength = ULTRA_MESSAGE_LENGTH;
parameters.sampleRateInp = SAMPLE_RATE;
parameters.sampleRateOut = SAMPLE_RATE;
parameters.sampleFormatInp = ggwave.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32;
parameters.sampleFormatOut = ggwave.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32;
parameters.operatingMode = GGWAVE_TX | GGWAVE_DSS;
const instance = ggwave.init(parameters);

function encodeMessage(message) {
  if (message.length !== ULTRA_MESSAGE_LENGTH) throw new Error("Reliable audio message length mismatch.");
  const encoded = ggwave.encode(instance, message, protocol, GGWAVE_VOLUME);
  if (!encoded?.byteLength || encoded.byteLength % 4 !== 0) throw new Error("Reliable audio encoding failed.");
  const copy = new ArrayBuffer(encoded.byteLength);
  new encoded.constructor(copy).set(encoded);
  const signal = new Float32Array(copy);
  const waveform = new Float32Array(signal.length + GUARD_SAMPLES);
  waveform.set(signal);
  return waveform;
}

const probeBlock = new Uint8Array(ULTRA_AUDIO_BLOCK_SIZE);
const probe = encodeMessage(buildUltraMessage(1, 1, "direct", 0, [probeBlock], 0));
const MICRO_FRAME_MS = probe.length / SAMPLE_RATE * 1000;
const ULTRA_FRAME_MS = MICRO_FRAME_MS * 2;
const ULTRA_ESTIMATED_KBPS = ULTRA_AUDIO_BLOCK_SIZE /
  (probe.length / SAMPLE_RATE * TRANSMISSIONS_PER_BLOCK) / 1024;

let pending = null;
function preparePending(payloadId, totalLen, mode, startOrdinal, blocks) {
  if (!Array.isArray(blocks) || blocks.length !== ULTRA_PACKETS_PER_FRAME) throw new Error("Reliable frame packet count mismatch.");
  const block = blocks[0];
  if (!(block instanceof Uint8Array) || block.length !== ULTRA_AUDIO_BLOCK_SIZE) throw new Error("Unexpected Reliable transport block size.");
  pending = {
    identity: `${payloadId >>> 0}:${totalLen}:${mode}`,
    payloadId: payloadId >>> 0,
    totalLen,
    mode,
    startOrdinal: Number(startOrdinal) >>> 0,
    block: block.slice(),
    transmission: 0
  };
}
function modulateUltraFrame(payloadId, totalLen, mode, startOrdinal, blocks) {
  const identity = `${payloadId >>> 0}:${totalLen}:${mode}`;
  if (!pending || pending.identity !== identity || pending.transmission >= TRANSMISSIONS_PER_BLOCK) {
    preparePending(payloadId, totalLen, mode, startOrdinal, blocks);
  }
  const chunkIndex = pending.transmission & 1;
  const message = buildUltraMessage(
    pending.payloadId,
    pending.totalLen,
    pending.mode,
    pending.startOrdinal,
    [pending.block],
    chunkIndex
  );
  pending.transmission++;
  if (pending.transmission >= TRANSMISSIONS_PER_BLOCK) pending = null;
  return encodeMessage(message);
}

export {
  ULTRA_AUDIO_BLOCK_SIZE,
  ULTRA_ESTIMATED_KBPS,
  ULTRA_FRAME_MS,
  ULTRA_PACKETS_PER_FRAME,
  modulateUltraFrame
};
