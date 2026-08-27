import ggwaveFactory from "../vendor/ggwave.mjs";
import { parseUltraMessage } from "./ultra-format.js";

const SAMPLE_RATE = 48000;
const GGWAVE_RX = 1 << 1;
const ggwave = await ggwaveFactory();
ggwave.disableLog?.();
const protocol = ggwave.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_NORMAL;

// Reliable listens to one deliberately conservative protocol only. This cuts
// false acquisitions and avoids spending receiver work on unrelated profiles.
for (const [name, id] of Object.entries(ggwave.ProtocolId)) {
  if (!name.startsWith("GGWAVE_PROTOCOL_") || name === "GGWAVE_PROTOCOL_COUNT" || !Number.isInteger(id)) continue;
  ggwave.rxToggleProtocol(id, id === protocol ? 1 : 0);
}

function createInstance() {
  const parameters = ggwave.getDefaultParameters();
  // Keep marker-based variable-length decoding. Fixed-length ggwave explicitly
  // removes the start/end markers and uses a different acquisition path.
  parameters.payloadLength = -1;
  parameters.sampleRateInp = SAMPLE_RATE;
  parameters.sampleRateOut = SAMPLE_RATE;
  parameters.sampleRate = SAMPLE_RATE;
  parameters.sampleFormatInp = ggwave.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32;
  parameters.sampleFormatOut = ggwave.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32;
  parameters.operatingMode = GGWAVE_RX;
  return ggwave.init(parameters);
}

let instance = createInstance();

function sendPacket(packet) {
  const block = packet.block.slice();
  postMessage({ type: "packet", packet: { ...packet, block: block.buffer } }, [block.buffer]);
  postMessage({ type: "signal", quality: 1 });
}

function append(samples) {
  const input = new Int8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  const decoded = ggwave.decode(instance, input);
  if (!decoded?.length) return;
  const bytes = new Uint8Array(decoded.length);
  bytes.set(new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength));
  const packet = parseUltraMessage(bytes);
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
