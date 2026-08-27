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
const GUARD_SAMPLES = Math.round(SAMPLE_RATE * 0.24);
const ggwave = await ggwaveFactory();
ggwave.disableLog?.();
const parameters = ggwave.getDefaultParameters();
parameters.payloadLength = ULTRA_MESSAGE_LENGTH;
parameters.sampleRateInp = SAMPLE_RATE;
parameters.sampleRateOut = SAMPLE_RATE;
parameters.operatingMode = GGWAVE_TX | GGWAVE_DSS;
const instance = ggwave.init(parameters);
const protocol = ggwave.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_NORMAL;

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
const probe = encodeMessage(buildUltraMessage(1, 1, "direct", 0, [probeBlock]));
const ULTRA_FRAME_MS = probe.length / SAMPLE_RATE * 1000;
const ULTRA_ESTIMATED_KBPS = ULTRA_AUDIO_BLOCK_SIZE / (probe.length / SAMPLE_RATE) / 1024;

function modulateUltraFrame(payloadId, totalLen, mode, startOrdinal, blocks) {
  return encodeMessage(buildUltraMessage(payloadId, totalLen, mode, startOrdinal, blocks));
}

export {
  ULTRA_AUDIO_BLOCK_SIZE,
  ULTRA_ESTIMATED_KBPS,
  ULTRA_FRAME_MS,
  ULTRA_PACKETS_PER_FRAME,
  modulateUltraFrame
};
