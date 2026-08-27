import { codingMode, RAPTOR_PACKET_ID_BYTES, raptorPacketEsi } from "../shared/coding-mode.js";

const ULTRA_AUDIO_BLOCK_SIZE = 24;
const ULTRA_PACKETS_PER_FRAME = 1;
const MAX_AUDIO_BYTES = 1024 * 1024;
const MAGIC0 = 0x41; // A
const MAGIC1 = 0x52; // R
const BASE_HEADER_BYTES = 9; // magic(2) + payload id(4) + total length(3)
const RAPTOR_ESI_SPACE = 0xff0000;

function writeUint24(bytes, offset, value) {
  bytes[offset] = value & 255;
  bytes[offset + 1] = value >>> 8 & 255;
  bytes[offset + 2] = value >>> 16 & 255;
}

function readUint24(bytes, offset) {
  return bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16;
}

function modeForTotalLen(totalLen) {
  return codingMode(Math.max(1, Math.ceil(totalLen / ULTRA_AUDIO_BLOCK_SIZE)));
}

function scheduledId(mode, ordinal) {
  if (mode === "direct") return 0;
  if (mode === "mds") return ordinal % 256;
  return ordinal % RAPTOR_ESI_SPACE;
}

function idBytes(mode) {
  return mode === "direct" ? 0 : mode === "mds" ? 1 : 3;
}

function buildUltraMessage(payloadId, totalLen, mode, startOrdinal, blocks) {
  if (!Array.isArray(blocks) || blocks.length !== ULTRA_PACKETS_PER_FRAME) {
    throw new Error("Reliable frame packet count mismatch.");
  }
  const block = blocks[0];
  if (!(block instanceof Uint8Array) || block.length !== ULTRA_AUDIO_BLOCK_SIZE) {
    throw new Error("Unexpected Reliable transport block size.");
  }
  if (!Number.isInteger(totalLen) || totalLen < 1 || totalLen > MAX_AUDIO_BYTES || modeForTotalLen(totalLen) !== mode) {
    throw new Error("Invalid Reliable transport metadata.");
  }

  const encodingId = scheduledId(mode, Number(startOrdinal) >>> 0);
  if (mode === "raptorq" && raptorPacketEsi(block) !== encodingId) {
    throw new Error("Reliable RaptorQ packet id mismatch.");
  }

  const idLength = idBytes(mode);
  const out = new Uint8Array(BASE_HEADER_BYTES + idLength + ULTRA_AUDIO_BLOCK_SIZE);
  out[0] = MAGIC0;
  out[1] = MAGIC1;
  const view = new DataView(out.buffer);
  view.setUint32(2, payloadId >>> 0, true);
  writeUint24(out, 6, totalLen);
  let offset = BASE_HEADER_BYTES;
  if (idLength === 1) out[offset++] = encodingId;
  else if (idLength === 3) {
    writeUint24(out, offset, encodingId);
    offset += 3;
  }
  out.set(block, offset);
  return out;
}

function parseUltraMessage(message) {
  if (!(message instanceof Uint8Array)) return null;
  if (message.length < BASE_HEADER_BYTES + ULTRA_AUDIO_BLOCK_SIZE || message[0] !== MAGIC0 || message[1] !== MAGIC1) return null;

  const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
  const payloadId = view.getUint32(2, true) >>> 0;
  const totalLen = readUint24(message, 6);
  if (totalLen < 1 || totalLen > MAX_AUDIO_BYTES) return null;
  const mode = modeForTotalLen(totalLen);
  const idLength = idBytes(mode);
  if (message.length !== BASE_HEADER_BYTES + idLength + ULTRA_AUDIO_BLOCK_SIZE) return null;

  let offset = BASE_HEADER_BYTES;
  let encodingId = 0;
  if (idLength === 1) encodingId = message[offset++];
  else if (idLength === 3) {
    encodingId = readUint24(message, offset);
    offset += 3;
  }
  if (mode === "mds" && encodingId >= 256) return null;
  if (mode === "raptorq" && encodingId >= RAPTOR_ESI_SPACE) return null;

  const block = message.slice(offset, offset + ULTRA_AUDIO_BLOCK_SIZE);
  if (mode === "raptorq" && raptorPacketEsi(block) !== encodingId) return null;
  return {
    payloadId,
    totalLen,
    mode,
    encodingId,
    blockSize: ULTRA_AUDIO_BLOCK_SIZE,
    block,
    profile: "ultra"
  };
}

export {
  ULTRA_AUDIO_BLOCK_SIZE,
  ULTRA_PACKETS_PER_FRAME,
  buildUltraMessage,
  parseUltraMessage
};
