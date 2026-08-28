import ggwaveFactory from "../vendor/ggwave.mjs";
import { RAPTOR_PACKET_ID_BYTES } from "../shared/coding-mode.js";
import {
  ULTRA_AUDIO_BLOCK_SIZE,
  ULTRA_MESSAGE_LENGTH,
  ULTRA_PACKETS_PER_FRAME,
  buildUltraMessage
} from "./ultra-format.js";

const SAMPLE_RATE = 48000;
const MODEM_RATE = 36000;
const GGWAVE_VOLUME = 100;
const GUARD_SAMPLES = Math.round(SAMPLE_RATE * 0.18);
const GGWAVE_DSS = 1 << 4;
const GGWAVE_TX = 1 << 2;
const ggwave = await ggwaveFactory();
ggwave.disableLog?.();

// Use the faster six-tone modem, but resample its internal clock and move its
// carriers down to about 1.125-4.5 kHz. The short fixed frame makes Reliable
// react in roughly 1.5 seconds instead of waiting almost six seconds per block.
const protocol = ggwave.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FASTEST;
ggwave.txProtocolSetFreqStart(protocol, 32);
const parameters = ggwave.getDefaultParameters();
parameters.payloadLength = ULTRA_MESSAGE_LENGTH;
parameters.sampleRateInp = SAMPLE_RATE;
parameters.sampleRateOut = SAMPLE_RATE;
parameters.sampleRate = MODEM_RATE;
parameters.sampleFormatInp = ggwave.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32;
parameters.sampleFormatOut = ggwave.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32;
parameters.operatingMode = GGWAVE_TX | GGWAVE_DSS;
const instance = ggwave.init(parameters);

function encodeMessage(message) {
  if (!(message instanceof Uint8Array) || message.length !== ULTRA_MESSAGE_LENGTH) {
    throw new Error("Unexpected Reliable acoustic frame size.");
  }
  const encoded = ggwave.encode(instance, message, protocol, GGWAVE_VOLUME);
  if (!encoded?.byteLength || encoded.byteLength % 4 !== 0) {
    throw new Error("Reliable audio encoding failed.");
  }
  const bytes = new Uint8Array(encoded.byteLength);
  bytes.set(new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength));
  const signal = new Float32Array(bytes.buffer);
  const waveform = new Float32Array(signal.length + GUARD_SAMPLES);
  waveform.set(signal);
  return waveform;
}

const probeBlock = new Uint8Array(ULTRA_AUDIO_BLOCK_SIZE);
const probe = encodeMessage(buildUltraMessage(1, 1, "direct", 0, [probeBlock]));
const ULTRA_FRAME_MS = probe.length / SAMPLE_RATE * 1000;
const ULTRA_ESTIMATED_KBPS = (ULTRA_AUDIO_BLOCK_SIZE - RAPTOR_PACKET_ID_BYTES) /
  (probe.length / SAMPLE_RATE) / 1024;

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
