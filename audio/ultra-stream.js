import ggwaveFactory from "../vendor/ggwave.mjs";
import {
  ULTRA_AUDIO_BLOCK_SIZE,
  ULTRA_PACKETS_PER_FRAME,
  buildUltraMessage
} from "./ultra-format.js";

const SAMPLE_RATE = 48000;
const GGWAVE_VOLUME = 20;
const ggwave = await ggwaveFactory();
ggwave.disableLog?.();
const parameters = ggwave.getDefaultParameters();
parameters.sampleRateInp = SAMPLE_RATE;
parameters.sampleRateOut = SAMPLE_RATE;
const instance = ggwave.init(parameters);
const protocol = ggwave.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_NORMAL;

function encodeMessage(message) {
  const encoded = ggwave.encode(instance, message, protocol, GGWAVE_VOLUME);
  if (!encoded?.byteLength || encoded.byteLength % 4 !== 0) throw new Error("Reliable audio encoding failed.");
  const copy = new ArrayBuffer(encoded.byteLength);
  new encoded.constructor(copy).set(encoded);
  return new Float32Array(copy);
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
