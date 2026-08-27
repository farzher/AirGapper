import {
  AUDIO_BLOCK_SIZE,
  AUDIO_ESTIMATED_KBPS,
  FRAME_SAMPLES,
  RELIABLE_PACKETS_PER_FRAME,
  SAMPLE_RATE,
  modulateReliableFrame
} from "./reliable-stream.js";

const RELIABLE_REPEAT = 8;
const ULTRA_AUDIO_BLOCK_SIZE = AUDIO_BLOCK_SIZE;
const ULTRA_PACKETS_PER_FRAME = RELIABLE_PACKETS_PER_FRAME;
const ULTRA_FRAME_MS = FRAME_SAMPLES * RELIABLE_REPEAT / SAMPLE_RATE * 1000;
const ULTRA_ESTIMATED_KBPS = AUDIO_ESTIMATED_KBPS / RELIABLE_REPEAT;

function modulateUltraFrame(payloadId, totalLen, mode, startOrdinal, blocks) {
  const frame = modulateReliableFrame(payloadId, totalLen, mode, startOrdinal, blocks);
  const out = new Float32Array(frame.length * RELIABLE_REPEAT);
  for (let repeat = 0; repeat < RELIABLE_REPEAT; repeat++) out.set(frame, repeat * frame.length);
  return out;
}

class UltraScanner {
  append() {}
  reset() {}
}

export {
  ULTRA_AUDIO_BLOCK_SIZE,
  ULTRA_ESTIMATED_KBPS,
  ULTRA_FRAME_MS,
  ULTRA_PACKETS_PER_FRAME,
  UltraScanner,
  modulateUltraFrame
};
