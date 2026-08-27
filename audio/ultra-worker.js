import ggwaveFactory from "../vendor/ggwave.mjs";
import {
  GGWAVE_DSS,
  GGWAVE_RX,
  ULTRA_MESSAGE_LENGTH
} from "./ultra-config.js";
import { parseUltraMessage } from "./ultra-format.js";

const SAMPLE_RATE = 48000;
const textDecoder = new TextDecoder();
const ggwave = await ggwaveFactory();
ggwave.disableLog?.();

const protocol = ggwave.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_NORMAL;
for (const name of [
  "GGWAVE_PROTOCOL_AUDIBLE_NORMAL",
  "GGWAVE_PROTOCOL_AUDIBLE_FAST",
  "GGWAVE_PROTOCOL_AUDIBLE_FASTEST",
  "GGWAVE_PROTOCOL_ULTRASOUND_NORMAL",
  "GGWAVE_PROTOCOL_ULTRASOUND_FAST",
  "GGWAVE_PROTOCOL_ULTRASOUND_FASTEST",
  "GGWAVE_PROTOCOL_DT_NORMAL",
  "GGWAVE_PROTOCOL_DT_FAST",
  "GGWAVE_PROTOCOL_DT_FASTEST",
  "GGWAVE_PROTOCOL_MT_NORMAL",
  "GGWAVE_PROTOCOL_MT_FAST",
  "GGWAVE_PROTOCOL_MT_FASTEST",
  "GGWAVE_PROTOCOL_CUSTOM_0",
  "GGWAVE_PROTOCOL_CUSTOM_1",
  "GGWAVE_PROTOCOL_CUSTOM_2",
  "GGWAVE_PROTOCOL_CUSTOM_3",
  "GGWAVE_PROTOCOL_CUSTOM_4",
  "GGWAVE_PROTOCOL_CUSTOM_5",
  "GGWAVE_PROTOCOL_CUSTOM_6",
  "GGWAVE_PROTOCOL_CUSTOM_7",
  "GGWAVE_PROTOCOL_CUSTOM_8",
  "GGWAVE_PROTOCOL_CUSTOM_9"
]) {
  ggwave.rxToggleProtocol(ggwave.ProtocolId[name], name === "GGWAVE_PROTOCOL_AUDIBLE_NORMAL" ? 1 : 0);
}

function createInstance() {
  const parameters = ggwave.getDefaultParameters();
  parameters.payloadLength = ULTRA_MESSAGE_LENGTH;
  parameters.sampleRateInp = SAMPLE_RATE;
  parameters.sampleRateOut = SAMPLE_RATE;
  parameters.operatingMode = GGWAVE_RX | GGWAVE_DSS;
  return ggwave.init(parameters);
}
let instance = createInstance();

function sendPacket(packet) {
  const block = packet.block.slice();
  postMessage({ type: "packet", packet: { ...packet, block: block.buffer } }, [block.buffer]);
}
function append(samples) {
  const input = new Int8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  const decoded = ggwave.decode(instance, input);
  if (!decoded?.length) return;
  const packet = parseUltraMessage(textDecoder.decode(decoded));
  if (packet) sendPacket(packet);
}
function reset() {
  try { ggwave.free(instance); } catch {}
  instance = createInstance();
}

self.onmessage = (event) => {
  const message = event.data;
  if (message?.type === "samples" && message.samples instanceof ArrayBuffer) {
    append(new Float32Array(message.samples));
  } else if (message?.type === "reset") {
    reset();
  }
};
