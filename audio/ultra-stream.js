import {
  AUDIO_BLOCK_SIZE,
  AUDIO_ESTIMATED_KBPS,
  FRAME_SAMPLES,
  RELIABLE_PACKETS_PER_FRAME,
  SAMPLE_RATE,
  modulateReliableFrame
} from "./reliable-stream.js";

// The UI calls this profile "Reliable". Use the Normal PHY that already works
// on real phones, but repeat the exact same coded frame so the existing
// ReliableScanner can retry and soft-combine consecutive failed copies.
const RELIABLE_REPEATS = 3;
const ULTRA_AUDIO_BLOCK_SIZE = AUDIO_BLOCK_SIZE;
const ULTRA_PACKETS_PER_FRAME = RELIABLE_PACKETS_PER_FRAME;
const ULTRA_FRAME_MS = FRAME_SAMPLES / SAMPLE_RATE * 1000 * RELIABLE_REPEATS;
const ULTRA_ESTIMATED_KBPS = AUDIO_ESTIMATED_KBPS / RELIABLE_REPEATS;

function modulateUltraFrame(payloadId, totalLen, mode, startOrdinal, blocks) {
  const frame = modulateReliableFrame(payloadId, totalLen, mode, startOrdinal, blocks);
  const waveform = new Float32Array(frame.length * RELIABLE_REPEATS);
  for (let repeat = 0; repeat < RELIABLE_REPEATS; repeat++) {
    waveform.set(frame, repeat * frame.length);
  }
  return waveform;
}

export {
  RELIABLE_REPEATS,
  ULTRA_AUDIO_BLOCK_SIZE,
  ULTRA_ESTIMATED_KBPS,
  ULTRA_FRAME_MS,
  ULTRA_PACKETS_PER_FRAME,
  modulateUltraFrame
};
