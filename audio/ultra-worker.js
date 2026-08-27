import ggwaveFactory from "../vendor/ggwave.mjs";
import { ULTRA_MESSAGE_LENGTH, parseUltraMessage } from "./ultra-format.js";

const SAMPLE_RATE = 48000;
const GGWAVE_DSS = 1 << 4;
const GGWAVE_RX = 1 << 1;
const ggwave = await ggwaveFactory();
ggwave.disableLog?.();
const protocol = ggwave.ProtocolId.GGWAVE_PROTOCOL_DT_FASTEST;
const protocolValue = Number(protocol?.value ?? protocol);
const FRAME_SAMPLES = Math.max(1, Math.round(ggwave.getDefaultParameters().samplesPerFrame || 1024));

for (const [name, id] of Object.entries(ggwave.ProtocolId)) {
  if (!name.startsWith("GGWAVE_PROTOCOL_")) continue;
  ggwave.rxToggleProtocol(id, Number(id?.value ?? id) === protocolValue ? 1 : 0);
}

function createInstance() {
  const parameters = ggwave.getDefaultParameters();
  parameters.payloadLength = ULTRA_MESSAGE_LENGTH;
  parameters.sampleRateInp = SAMPLE_RATE;
  parameters.sampleRateOut = SAMPLE_RATE;
  parameters.sampleRate = SAMPLE_RATE;
  parameters.sampleFormatInp = ggwave.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32;
  parameters.sampleFormatOut = ggwave.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32;
  parameters.operatingMode = GGWAVE_RX | GGWAVE_DSS;
  return ggwave.init(parameters);
}

let instance = createInstance();
const frame = new Float32Array(FRAME_SAMPLES);
let frameLength = 0;
let frames = 0;
let raw = 0;
let bad = 0;
let packets = 0;
let lastLength = 0;
let lastPacketKey = "";

function reportStats(force = false) {
  if (!force && frames % 12 !== 0) return;
  postMessage({
    type: "stats",
    stats: {
      frames,
      sync: Number(ggwave.rxDurationFrames?.(instance)) || 0,
      raw,
      bad,
      packets,
      lastLength
    }
  });
}

function sendPacket(packet) {
  const key = `${packet.payloadId}:${packet.totalLen}:${packet.mode}:${packet.encodingId}`;
  // ggwave fixed-length DT decoding reports the same completed payload on
  // several consecutive analysis frames. Only forward the first copy.
  if (key === lastPacketKey) return;
  lastPacketKey = key;
  packets++;
  const block = packet.block.slice();
  postMessage({ type: "packet", packet: { ...packet, block: block.buffer } }, [block.buffer]);
  postMessage({ type: "signal", quality: 1 });
}

function decodeFrame(samples) {
  frames++;
  const input = new Int8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  const decoded = ggwave.decode(instance, input);
  if (decoded?.length) {
    raw++;
    lastLength = decoded.length;
    const bytes = new Uint8Array(decoded.length);
    bytes.set(new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength));
    const packet = parseUltraMessage(bytes);
    if (packet) sendPacket(packet);
    else bad++;
  }
  reportStats();
}

function append(samples) {
  if (!samples?.length) return;
  let read = 0;
  while (read < samples.length) {
    const count = Math.min(FRAME_SAMPLES - frameLength, samples.length - read);
    frame.set(samples.subarray(read, read + count), frameLength);
    frameLength += count;
    read += count;
    if (frameLength !== FRAME_SAMPLES) continue;
    decodeFrame(frame);
    frameLength = 0;
  }
}

function reset() {
  try { ggwave.free(instance); } catch {}
  instance = createInstance();
  frameLength = 0;
  frames = 0;
  raw = 0;
  bad = 0;
  packets = 0;
  lastLength = 0;
  lastPacketKey = "";
  reportStats(true);
}

self.onmessage = (event) => {
  const message = event.data;
  if (message?.type === "samples" && message.samples instanceof ArrayBuffer) {
    append(new Float32Array(message.samples));
  } else if (message?.type === "reset") {
    reset();
  }
};

postMessage({ type: "ready", frameSamples: FRAME_SAMPLES });
reportStats(true);
