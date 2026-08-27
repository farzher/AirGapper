import {
  AUDIO_BLOCK_SIZE as ULTRA_AUDIO_BLOCK_SIZE,
  AUDIO_ESTIMATED_KBPS as ULTRA_ESTIMATED_KBPS,
  FRAME_SAMPLES,
  ReliableScanner,
  SAMPLE_RATE,
  modulateReliablePacket
} from "./ultra-phy.js";

const ULTRA_PACKETS_PER_FRAME = 1;
const ULTRA_FRAME_MS = FRAME_SAMPLES / SAMPLE_RATE * 1000;

function scheduledId(mode, ordinal) {
  if (mode === "direct") return 0;
  if (mode === "mds") return ordinal % 256;
  return ordinal % 0xff0000;
}

function modulateUltraFrame(payloadId, totalLen, mode, startOrdinal, blocks) {
  if (!Array.isArray(blocks) || blocks.length !== ULTRA_PACKETS_PER_FRAME) {
    throw new Error("Reliable frame packet count mismatch.");
  }
  return modulateReliablePacket(
    payloadId,
    totalLen,
    mode,
    scheduledId(mode, startOrdinal),
    blocks[0]
  );
}

class UltraScanner {
  constructor(onPacket) {
    this.scanner = new ReliableScanner((packet) => onPacket({ ...packet, profile: "ultra" }));
  }
  append(chunk) {
    this.scanner.append(chunk);
  }
  reset() {
    this.scanner.reset();
  }
}

export {
  ULTRA_AUDIO_BLOCK_SIZE,
  ULTRA_ESTIMATED_KBPS,
  ULTRA_FRAME_MS,
  ULTRA_PACKETS_PER_FRAME,
  UltraScanner,
  modulateUltraFrame
};
