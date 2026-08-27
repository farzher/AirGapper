import { codingMode, raptorPacketEsi } from "../shared/coding-mode.js";

const ULTRA_AUDIO_BLOCK_SIZE = 24;
const ULTRA_PACKETS_PER_FRAME = 1;
const ULTRA_MESSAGE_LENGTH = 34;
const MAX_AUDIO_BYTES = 1024 * 1024;
const MAGIC0 = 0x41; // A
const MAGIC1 = 0x52; // R
const BASE_HEADER_BYTES = 9; // magic(2) + payload id(4) + total length(3)
const WIRE_ID_OFFSET = BASE_HEADER_BYTES;
const BLOCK_OFFSET = WIRE_ID_OFFSET + 1;
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
  return -1;
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

  const encodingId = mode === "raptorq"
    ? raptorPacketEsi(block)
    : scheduledId(mode, Number(startOrdinal) >>> 0);
  if (encodingId < 0 || encodingId >= (mode === "raptorq" ? RAPTOR_ESI_SPACE : 256)) {
    throw new Error("Invalid Reliable packet id.");
  }

  // ggwave's low-band DT protocol is used in fixed-length mode. Keep one
  // transport-id byte in every frame so direct, MDS, and RaptorQ are all 34
  // bytes. RaptorQ already carries its ESI inside the 24-byte packet, so its
  // wire id stays zero instead of redundantly transmitting a second ESI.
  const out = new Uint8Array(ULTRA_MESSAGE_LENGTH);
  out[0] = MAGIC0;
  out[1] = MAGIC1;
  const view = new DataView(out.buffer);
  view.setUint32(2, payloadId >>> 0, true);
  writeUint24(out, 6, totalLen);
  out[WIRE_ID_OFFSET] = mode === "mds" ? encodingId : 0;
  out.set(block, BLOCK_OFFSET);
  return out;
}

function parseUltraMessage(message) {
  if (!(message instanceof Uint8Array) || message.length !== ULTRA_MESSAGE_LENGTH) return null;
  if (message[0] !== MAGIC0 || message[1] !== MAGIC1) return null;

  const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
  const payloadId = view.getUint32(2, true) >>> 0;
  const totalLen = readUint24(message, 6);
  if (totalLen < 1 || totalLen > MAX_AUDIO_BYTES) return null;
  const mode = modeForTotalLen(totalLen);
  const wireId = message[WIRE_ID_OFFSET];
  const block = message.slice(BLOCK_OFFSET, BLOCK_OFFSET + ULTRA_AUDIO_BLOCK_SIZE);

  let encodingId = 0;
  if (mode === "direct") {
    if (wireId !== 0) return null;
  } else if (mode === "mds") {
    encodingId = wireId;
  } else {
    if (wireId !== 0) return null;
    encodingId = raptorPacketEsi(block);
    if (encodingId < 0 || encodingId >= RAPTOR_ESI_SPACE) return null;
  }

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
  ULTRA_MESSAGE_LENGTH,
  ULTRA_PACKETS_PER_FRAME,
  buildUltraMessage,
  parseUltraMessage
};
