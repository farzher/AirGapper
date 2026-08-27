import ggwaveFactory from "../vendor/ggwave.mjs";
import { parseUltraMessage } from "./ultra-format.js";

const SAMPLE_RATE = 48000;
const textDecoder = new TextDecoder();
const ggwave = await ggwaveFactory();
ggwave.disableLog?.();

function createInstance() {
  const parameters = ggwave.getDefaultParameters();
  parameters.sampleRateInp = SAMPLE_RATE;
  parameters.sampleRateOut = SAMPLE_RATE;
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
