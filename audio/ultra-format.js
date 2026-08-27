import { codingMode, RAPTOR_PACKET_ID_BYTES } from "../shared/coding-mode.js";

const ULTRA_AUDIO_BLOCK_SIZE = 24;
const ULTRA_PACKETS_PER_FRAME = 1;
const MAX_AUDIO_BYTES = 1024 * 1024;
const MAGIC = "A1";
const MESSAGE_LENGTH = 55;
const MODE_TO_CODE = new Map([
  ["direct", "d"],
  ["mds", "m"],
  ["raptorq", "r"]
]);
const CODE_TO_MODE = new Map(Array.from(MODE_TO_CODE, ([mode, code]) => [code, mode]));

function crc16(text) {
  let crc = 0xffff;
  for (let i = 0; i < text.length; i++) {
    crc ^= text.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x8000 ? (crc << 1 ^ 0x1021) & 0xffff : crc << 1 & 0xffff;
  }
  return crc;
}
function encodeBase36(value, width) {
  if (!Number.isInteger(value) || value < 0 || value >= 36 ** width) throw new Error("Reliable audio metadata is out of range.");
  return value.toString(36).padStart(width, "0");
}
function decodeBase36(text) {
  if (!/^[0-9a-z]+$/.test(text)) return -1;
  const value = Number.parseInt(text, 36);
  return Number.isSafeInteger(value) ? value : -1;
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
function buildUltraMessage(payloadId, totalLen, mode, startOrdinal, blocks) {
  if (!Array.isArray(blocks) || blocks.length !== ULTRA_PACKETS_PER_FRAME) throw new Error("Reliable frame packet count mismatch.");
  const block = blocks[0];
  if (!(block instanceof Uint8Array) || block.length !== ULTRA_AUDIO_BLOCK_SIZE) throw new Error("Unexpected Reliable transport block size.");
  const modeCode = MODE_TO_CODE.get(mode);
  if (!modeCode || !Number.isInteger(totalLen) || totalLen < 1 || totalLen > MAX_AUDIO_BYTES) throw new Error("Invalid Reliable transport metadata.");
  const encodingId = scheduledId(mode, Number(startOrdinal) >>> 0);
  const body = MAGIC
    + encodeBase36(payloadId >>> 0, 7)
    + encodeBase36(totalLen, 4)
    + modeCode
    + encodeBase36(encodingId, 5)
    + bytesToBase64Url(block);
  return body + encodeBase36(crc16(body), 4);
}
function parseUltraMessage(text) {
  if (typeof text !== "string" || text.length !== MESSAGE_LENGTH || !text.startsWith(MAGIC)) return null;
  const body = text.slice(0, -4);
  if (decodeBase36(text.slice(-4)) !== crc16(body)) return null;
  const payloadId = decodeBase36(text.slice(2, 9));
  const totalLen = decodeBase36(text.slice(9, 13));
  const mode = CODE_TO_MODE.get(text[13]);
  const encodingId = decodeBase36(text.slice(14, 19));
  const block = base64UrlToBytes(text.slice(19, 51));
  if (payloadId < 0 || payloadId > 0xffffffff || totalLen < 1 || totalLen > MAX_AUDIO_BYTES || !mode || encodingId < 0 || !block || block.length !== ULTRA_AUDIO_BLOCK_SIZE) return null;
  if (codingMode(sourceCount(totalLen, mode)) !== mode) return null;
  if (mode === "direct" && encodingId !== 0) return null;
  if (mode === "mds" && encodingId >= 256) return null;
  if (mode === "raptorq" && encodingId >= 0xff0000) return null;
  return {
    payloadId: payloadId >>> 0,
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
