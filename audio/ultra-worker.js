import ggwaveFactory from "../vendor/ggwave.mjs";
import {
  GGWAVE_DSS,
  GGWAVE_RX,
  ULTRA_MESSAGE_LENGTH
} from "./ultra-config.js";
import {
  ULTRA_AUDIO_BLOCK_SIZE,
  ULTRA_CHUNK_SIZE,
  parseUltraMessage
} from "./ultra-format.js";

const SAMPLE_RATE = 48000;
const GGWAVE_FREQ_START = 24;
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
ggwave.rxProtocolSetFreqStart(protocol, GGWAVE_FREQ_START);

function createInstance() {
  const parameters = ggwave.getDefaultParameters();
  parameters.payloadLength = ULTRA_MESSAGE_LENGTH;
  parameters.sampleRateInp = SAMPLE_RATE;
  parameters.sampleRateOut = SAMPLE_RATE;
  parameters.sampleFormatInp = ggwave.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32;
  parameters.sampleFormatOut = ggwave.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32;
  parameters.operatingMode = GGWAVE_RX | GGWAVE_DSS;
  return ggwave.init(parameters);
}
let instance = createInstance();
const partials = new Map();
const completed = new Set();

function packetKey(shard) {
  return `${shard.payloadId}:${shard.totalLen}:${shard.mode}:${shard.encodingId}`;
}
function trimState() {
  while (partials.size > 64) partials.delete(partials.keys().next().value);
  while (completed.size > 128) completed.delete(completed.values().next().value);
}
function sendPacket(packet) {
  const block = packet.block.slice();
  postMessage({ type: "packet", packet: { ...packet, block: block.buffer } }, [block.buffer]);
}
function acceptShard(shard) {
  const key = packetKey(shard);
  if (completed.has(key)) return;
  let state = partials.get(key);
  if (!state) {
    state = { shard, chunks: [null, null] };
    partials.set(key, state);
  }
  if (!state.chunks[shard.chunkIndex]) state.chunks[shard.chunkIndex] = shard.chunk.slice();
  if (!state.chunks[0] || !state.chunks[1]) {
    trimState();
    return;
  }
  const block = new Uint8Array(ULTRA_AUDIO_BLOCK_SIZE);
  block.set(state.chunks[0], 0);
  block.set(state.chunks[1], ULTRA_CHUNK_SIZE);
  partials.delete(key);
  completed.add(key);
  trimState();
  sendPacket({
    payloadId: shard.payloadId,
    totalLen: shard.totalLen,
    mode: shard.mode,
    encodingId: shard.encodingId,
    blockSize: ULTRA_AUDIO_BLOCK_SIZE,
    block,
    profile: "ultra"
  });
}
function append(samples) {
  const input = new Int8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  const decoded = ggwave.decode(instance, input);
  if (!decoded?.length) return;
  const shard = parseUltraMessage(textDecoder.decode(decoded));
  if (shard) acceptShard(shard);
}
function reset() {
  try { ggwave.free(instance); } catch {}
  instance = createInstance();
  partials.clear();
  completed.clear();
}

self.onmessage = (event) => {
  const message = event.data;
  if (message?.type === "samples" && message.samples instanceof ArrayBuffer) {
    append(new Float32Array(message.samples));
  } else if (message?.type === "reset") {
    reset();
  }
};
