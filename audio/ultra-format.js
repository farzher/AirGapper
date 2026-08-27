import { codingMode, RAPTOR_PACKET_ID_BYTES } from "../shared/coding-mode.js";
import { ULTRA_MESSAGE_LENGTH } from "./ultra-config.js";

const ULTRA_AUDIO_BLOCK_SIZE = 24;
const ULTRA_CHUNK_SIZE = 12;
const ULTRA_PACKETS_PER_FRAME = 1;
const MAX_AUDIO_BYTES = 1024 * 1024;
const RAW_MESSAGE_BYTES = 26;
const HEADER_BYTES = 12;
const CRC_OFFSET = 24;
const MAGIC_MASK = 0xfc;
const MAGIC = 0xa4;
const MODE_NAMES = ["direct", "mds", "raptorq"];

function crc16(bytes) {
  let crc = 0xffff;
  for (const value of bytes) {
    crc ^= value << 8;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x8000 ? (crc << 1 ^ 0x1021) & 0xffff : crc << 1 & 0xffff;
  }
  return crc;
}
function writeUint24(bytes, offset, value) {
  bytes[offset] = value & 255;
  bytes[offset + 1] = value >>> 8 & 255;
  bytes[offset + 2] = value >>> 16 & 255;
}
function readUint24(bytes, offset) {
  return bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16;
}
function bytesToBase64Url(bytes) {
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function base64UrlToBytes(text) {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - text.length % 4) % 4);
  let binary;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
function scheduledId(mode, ordinal) {
  if (mode === "direct") return 0;
  if (mode === "mds") return ordinal % 256;
  return ordinal % 0xff0000;
}
function sourceCount(totalLen, mode) {
  const sourceSize = mode === "raptorq" ? ULTRA_AUDIO_BLOCK_SIZE - RAPTOR_PACKET_ID_BYTES : ULTRA_AUDIO_BLOCK_SIZE;
  return Math.max(1, Math.ceil(totalLen / sourceSize));
}
function validateMetadata(payloadId, totalLen, mode, encodingId) {
  if (!Number.isInteger(payloadId) || payloadId < 0 || payloadId > 0xffffffff) return false;
  if (!Number.isInteger(totalLen) || totalLen < 1 || totalLen > MAX_AUDIO_BYTES) return false;
  if (!MODE_NAMES.includes(mode) || !Number.isInteger(encodingId) || encodingId < 0 || encodingId >= 0x1000000) return false;
  if (codingMode(sourceCount(totalLen, mode)) !== mode) return false;
  if (mode === "direct" && encodingId !== 0) return false;
  if (mode === "mds" && encodingId >= 256) return false;
  if (mode === "raptorq" && encodingId >= 0xff0000) return false;
  return true;
}
function buildUltraMessage(payloadId, totalLen, mode, startOrdinal, blocks, chunkIndex) {
  if (!Array.isArray(blocks) || blocks.length !== ULTRA_PACKETS_PER_FRAME) throw new Error("Reliable frame packet count mismatch.");
  const block = blocks[0];
  if (!(block instanceof Uint8Array) || block.length !== ULTRA_AUDIO_BLOCK_SIZE) throw new Error("Unexpected Reliable transport block size.");
  if (chunkIndex !== 0 && chunkIndex !== 1) throw new Error("Reliable chunk index mismatch.");
  const modeCode = MODE_NAMES.indexOf(mode);
  const encodingId = scheduledId(mode, Number(startOrdinal) >>> 0);
  if (modeCode < 0 || !validateMetadata(payloadId >>> 0, totalLen, mode, encodingId)) throw new Error("Invalid Reliable transport metadata.");

  const raw = new Uint8Array(RAW_MESSAGE_BYTES);
  raw[0] = MAGIC | modeCode;
  new DataView(raw.buffer).setUint32(1, payloadId >>> 0, true);
  writeUint24(raw, 5, totalLen);
  writeUint24(raw, 8, encodingId);
  raw[11] = chunkIndex;
  const chunkStart = chunkIndex * ULTRA_CHUNK_SIZE;
  raw.set(block.subarray(chunkStart, chunkStart + ULTRA_CHUNK_SIZE), HEADER_BYTES);
  new DataView(raw.buffer).setUint16(CRC_OFFSET, crc16(raw.subarray(0, CRC_OFFSET)), true);
  const encoded = bytesToBase64Url(raw);
  if (encoded.length !== ULTRA_MESSAGE_LENGTH) throw new Error("Reliable frame length mismatch.");
  return encoded;
}
function parseUltraMessage(text) {
  if (typeof text !== "string" || text.length !== ULTRA_MESSAGE_LENGTH) return null;
  const raw = base64UrlToBytes(text);
  if (!raw || raw.length !== RAW_MESSAGE_BYTES || (raw[0] & MAGIC_MASK) !== MAGIC) return null;
  const modeCode = raw[0] & 3;
  const mode = MODE_NAMES[modeCode];
  const chunkIndex = raw[11];
  if (!mode || (chunkIndex !== 0 && chunkIndex !== 1)) return null;
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (view.getUint16(CRC_OFFSET, true) !== crc16(raw.subarray(0, CRC_OFFSET))) return null;
  const payloadId = view.getUint32(1, true) >>> 0;
  const totalLen = readUint24(raw, 5);
  const encodingId = readUint24(raw, 8);
  if (!validateMetadata(payloadId, totalLen, mode, encodingId)) return null;
  return {
    payloadId,
    totalLen,
    mode,
    encodingId,
    chunkIndex,
    chunk: raw.slice(HEADER_BYTES, HEADER_BYTES + ULTRA_CHUNK_SIZE)
  };
}

export {
  ULTRA_AUDIO_BLOCK_SIZE,
  ULTRA_CHUNK_SIZE,
  ULTRA_PACKETS_PER_FRAME,
  buildUltraMessage,
  parseUltraMessage
};
