import { codingMode, RAPTOR_MAX_K, RAPTOR_PACKET_ID_BYTES, raptorPacketEsi } from "./coding-mode.js";
import { gridLayoutById } from "./grid-layout.js";
const DIRECT_MAGIC = 211;
const MDS_MAGIC = 212;
const RAPTORQ_MAGIC = 213;
const EXT_MDS_MAGIC = 214;
const EXT_RAPTORQ_MAGIC = 215;
const DIRECT_HEADER_LEN = 7;
const MDS_HEADER_LEN = 11;
// RaptorQ already serializes SBN + 24-bit ESI in every encoding packet.
// Do not repeat the same 24-bit sequence in the AirGapper envelope.
const RAPTORQ_HEADER_LEN = 11;
const EXT_MDS_HEADER_LEN = 12;
const EXT_RAPTORQ_HEADER_LEN = 12;
const FRAME_CRC_LEN = 4;
const EXT_GRID_DIM_BITS = 5;
const EXT_GRID_SLOT_BITS = 7;
const EXT_GRID_MAX_SLOTS = 128;
function frameHeaderLength(mode, extendedGrid = false) {
  if (mode === "direct") return DIRECT_HEADER_LEN;
  if (extendedGrid) return mode === "mds" ? EXT_MDS_HEADER_LEN : EXT_RAPTORQ_HEADER_LEN;
  return mode === "mds" ? MDS_HEADER_LEN : RAPTORQ_HEADER_LEN;
}
function frameOverhead(mode, extendedGrid = false) {
  return frameHeaderLength(mode, extendedGrid) + FRAME_CRC_LEN;
}
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_FILE_LABEL = `${MAX_FILE_BYTES / 1024 / 1024} MB`;
const FILE_HEADER_LEN = 41;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
async function digest(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}
async function gzipAsync(bytes) {
  const compressed = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(compressed).arrayBuffer());
}
async function gunzipAsync(bytes, maxBytes) {
  const inflated = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  const reader = inflated.getReader();
  const out = new Uint8Array(maxBytes);
  let total = 0;
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.length > maxBytes) {
      await reader.cancel();
      throw new Error("The recovered file expands past its declared length.");
    }
    out.set(value, total);
    total += value.length;
  }
  if (total !== maxBytes) throw new Error("The decompressed file length does not match its header.");
  return out;
}
function safeFileName(name) {
  var _a;
  const base = (_a = name.split(/[\\/]/).pop()) != null ? _a : "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "transfer.bin" : cleaned;
}
const PRECOMPRESSED_TYPES = /* @__PURE__ */ new Set([
  "application/gzip",
  "application/java-archive",
  "application/vnd.rar",
  "application/x-7z-compressed",
  "application/x-brotli",
  "application/x-bzip",
  "application/x-bzip2",
  "application/x-gzip",
  "application/x-lzma",
  "application/x-rar-compressed",
  "application/x-xz",
  "application/x-zip-compressed",
  "application/zip",
  "application/zstd"
]);
const COMPRESSIBLE_IMAGES = /^image\/(bmp|x-ms-bmp|svg\+xml|tiff|x-icon|vnd\.microsoft\.icon)$/;
const COMPRESSIBLE_AUDIO = /^audio\/(wav|x-wav|wave|vnd\.wave|aiff|x-aiff|basic|l16)$/;
function isPrecompressedType(type) {
  const media = type.split(";")[0].trim().toLowerCase();
  if (media.startsWith("video/")) return true;
  if (media.startsWith("image/")) return !COMPRESSIBLE_IMAGES.test(media);
  if (media.startsWith("audio/")) return !COMPRESSIBLE_AUDIO.test(media);
  if (media.startsWith("application/vnd.openxmlformats-officedocument.")) return true;
  if (media.startsWith("application/vnd.oasis.opendocument.")) return true;
  if (media.endsWith("+zip")) return true;
  return PRECOMPRESSED_TYPES.has(media);
}
async function packFile(name, type, bytes, tryCompression = false) {
  if (bytes.length === 0) throw new Error("Choose a non-empty file.");
  if (bytes.length > MAX_FILE_BYTES) {
    throw new Error(`Files are limited to ${MAX_FILE_LABEL} in this browser build.`);
  }
  const nameBytes = textEncoder.encode(safeFileName(name));
  const typeBytes = textEncoder.encode(type || "application/octet-stream");
  if (nameBytes.length > 65535 || typeBytes.length > 65535) {
    throw new Error("The file name or media type is too long.");
  }
  const tryGzip = typeof CompressionStream !== "undefined" && bytes.length >= 768 && (tryCompression || !isPrecompressedType(type));
  const [sha256, compressed] = await Promise.all([
    digest(bytes),
    tryGzip ? gzipAsync(bytes) : Promise.resolve(void 0)
  ]);
  const useGzip = compressed !== void 0 && compressed.length + 64 < bytes.length;
  const transmitted = useGzip ? compressed : bytes;
  const compression = useGzip ? "gzip" : "none";
  const out = new Uint8Array(
    FILE_HEADER_LEN + nameBytes.length + typeBytes.length + transmitted.length
  );
  const view = new DataView(out.buffer);
  view.setUint8(0, useGzip ? 1 : 0);
  view.setUint16(1, nameBytes.length, true);
  view.setUint16(3, typeBytes.length, true);
  view.setUint32(5, bytes.length, true);
  out.set(sha256, 9);
  out.set(nameBytes, FILE_HEADER_LEN);
  out.set(typeBytes, FILE_HEADER_LEN + nameBytes.length);
  out.set(transmitted, FILE_HEADER_LEN + nameBytes.length + typeBytes.length);
  return {
    container: out,
    compression,
    originalSize: bytes.length,
    transmittedSize: transmitted.length
  };
}
async function unpackFile(container) {
  if (container.length < FILE_HEADER_LEN) throw new Error("The recovered file header is incomplete.");
  const view = new DataView(container.buffer, container.byteOffset, container.byteLength);
  const compressionByte = view.getUint8(0);
  if (compressionByte > 1) throw new Error("The recovered file uses unsupported compression.");
  const compression = compressionByte === 1 ? "gzip" : "none";
  const nameLength = view.getUint16(1, true);
  const typeLength = view.getUint16(3, true);
  const fileLength = view.getUint32(5, true);
  const dataOffset = FILE_HEADER_LEN + nameLength + typeLength;
  const transmittedLength = container.length - dataOffset;
  if (fileLength === 0 || fileLength > MAX_FILE_BYTES || transmittedLength <= 0 || transmittedLength > MAX_FILE_BYTES || dataOffset > container.length) {
    throw new Error("The recovered file length does not match its header.");
  }
  const transmitted = container.subarray(dataOffset);
  if (compression === "gzip") {
    if (transmitted.length < 18) throw new Error("The recovered gzip payload is incomplete.");
    const trailer = new DataView(
      transmitted.buffer,
      transmitted.byteOffset + transmitted.byteLength - 4,
      4
    );
    if (trailer.getUint32(0, true) !== fileLength) {
      throw new Error("The gzip payload length does not match its file header.");
    }
  }
  const bytes = compression === "gzip" ? await gunzipAsync(transmitted, fileLength) : transmitted;
  if (bytes.length !== fileLength) {
    throw new Error("The decompressed file length does not match its header.");
  }
  return {
    name: safeFileName(
      textDecoder.decode(container.subarray(FILE_HEADER_LEN, FILE_HEADER_LEN + nameLength))
    ),
    type: textDecoder.decode(container.subarray(FILE_HEADER_LEN + nameLength, dataOffset)) || "application/octet-stream",
    sha256: container.slice(9, 41),
    bytes,
    compression,
    transmittedSize: transmittedLength
  };
}
async function verifyFile(file) {
  const actual = await digest(file.bytes);
  return actual.every((value, index) => value === file.sha256[index]);
}
const BLOCK_LEN_BITS = 12;
const DIRECT_TOTAL_BITS = 12;
const MDS_TOTAL_BITS = 17;
const RAPTORQ_TOTAL_BITS = 27;
function magicForMode(mode, extendedGrid = false) {
  if (mode === "direct") return DIRECT_MAGIC;
  if (extendedGrid) return mode === "mds" ? EXT_MDS_MAGIC : EXT_RAPTORQ_MAGIC;
  return mode === "mds" ? MDS_MAGIC : RAPTORQ_MAGIC;
}
function modeForMagic(magic) {
  if (magic === DIRECT_MAGIC) return "direct";
  if (magic === MDS_MAGIC || magic === EXT_MDS_MAGIC) return "mds";
  if (magic === RAPTORQ_MAGIC || magic === EXT_RAPTORQ_MAGIC) return "raptorq";
  return null;
}
function extendedGridForMagic(magic) {
  return magic === EXT_MDS_MAGIC || magic === EXT_RAPTORQ_MAGIC;
}
function writeBits(out, bitOffset, value, width) {
  for (let bit = 0; bit < width; bit++) {
    if (value >>> bit & 1) out[bitOffset + bit >>> 3] = out[bitOffset + bit >>> 3] | 1 << (bitOffset + bit & 7);
  }
  return bitOffset + width;
}
function readBits(bytes, bitOffset, width) {
  let value = 0;
  for (let bit = 0; bit < width; bit++) {
    value += (bytes[bitOffset + bit >>> 3] >>> (bitOffset + bit & 7) & 1) * 2 ** bit;
  }
  return { value, next: bitOffset + width };
}
function fitsBits(value, width) {
  return Number.isInteger(value) && value >= 0 && value < 2 ** width;
}
function packFrame(h, block) {
  const extendedGrid = h.mode !== "direct" && Boolean(h.extendedGrid);
  const headerLen = frameHeaderLength(h.mode, extendedGrid);
  const gridCols = Number(h.gridCols);
  const gridRows = Number(h.gridRows);
  const gridCount = gridCols * gridRows;
  const validExtendedGrid = !extendedGrid || (
    Number.isInteger(gridCols) && gridCols >= 1 && fitsBits(gridCols - 1, EXT_GRID_DIM_BITS) &&
    Number.isInteger(gridRows) && gridRows >= 1 && fitsBits(gridRows - 1, EXT_GRID_DIM_BITS) &&
    Number.isInteger(gridCount) && gridCount >= 2 && gridCount <= EXT_GRID_MAX_SLOTS &&
    fitsBits(h.slotIndex, EXT_GRID_SLOT_BITS) && h.slotIndex < gridCount
  );
  const validLegacyGrid = extendedGrid || h.mode === "direct" ||
    (fitsBits(h.layoutId, 4) && fitsBits(h.slotIndex, 5));
  if (codingMode(h.k) !== h.mode ||
      h.mode === "raptorq" && h.k > RAPTOR_MAX_K ||
      block.length !== h.blockLen ||
      h.blockLen <= (h.mode === "raptorq" ? RAPTOR_PACKET_ID_BYTES : 0) ||
      Math.ceil(h.totalLen / (h.blockLen - (h.mode === "raptorq" ? RAPTOR_PACKET_ID_BYTES : 0))) !== h.k ||
      !fitsBits(h.payloadId, 32) ||
      !fitsBits(h.blockLen - 1, BLOCK_LEN_BITS) ||
      !fitsBits(h.totalLen - 1, h.mode === "direct" ? DIRECT_TOTAL_BITS : h.mode === "mds" ? MDS_TOTAL_BITS : RAPTORQ_TOTAL_BITS) ||
      h.mode === "direct" && (h.seq !== 0 || h.layoutId !== 0 || h.slotIndex !== 0 || h.blockLen !== h.totalLen) ||
      h.mode === "mds" && !fitsBits(h.seq, 8) ||
      h.mode === "raptorq" && (!fitsBits(h.seq, 24) || raptorPacketEsi(block) !== h.seq) ||
      !validExtendedGrid || !validLegacyGrid)
    throw new Error("Frame metadata exceeds its packed field.");

  const out = new Uint8Array(headerLen + block.length + FRAME_CRC_LEN);
  out[0] = magicForMode(h.mode, extendedGrid);
  let bit = 8;
  if (h.mode === "direct") {
    bit = writeBits(out, bit, h.totalLen - 1, DIRECT_TOTAL_BITS);
  } else {
    if (h.mode === "mds") bit = writeBits(out, bit, h.seq, 8);
    if (extendedGrid) {
      bit = writeBits(out, bit, gridCols - 1, EXT_GRID_DIM_BITS);
      bit = writeBits(out, bit, gridRows - 1, EXT_GRID_DIM_BITS);
      bit = writeBits(out, bit, h.slotIndex, EXT_GRID_SLOT_BITS);
    } else {
      bit = writeBits(out, bit, h.layoutId, 4);
      bit = writeBits(out, bit, h.slotIndex, 5);
    }
    bit = writeBits(out, bit, h.blockLen - 1, BLOCK_LEN_BITS);
    bit = writeBits(out, bit, h.totalLen - 1, h.mode === "mds" ? MDS_TOTAL_BITS : RAPTORQ_TOTAL_BITS);
  }
  writeBits(out, bit, h.payloadId >>> 0, 32);
  out.set(block, headerLen);
  new DataView(out.buffer).setUint32(
    headerLen + block.length,
    crc32(out.subarray(0, headerLen + block.length)),
    true
  );
  return out;
}
function parseFrameBody(bytes, hasCrc) {
  const crcBytes = hasCrc === false ? 0 : FRAME_CRC_LEN;
  const magic = bytes[0] ?? -1;
  const mode = modeForMagic(magic);
  if (!mode) return null;
  const extendedGrid = extendedGridForMagic(magic);
  const headerLen = frameHeaderLength(mode, extendedGrid);
  if (bytes.length < headerLen + 1 + crcBytes) return null;
  let bit = 8;
  let seq = 0;
  let layoutId = 0;
  let gridCols = 1;
  let gridRows = 1;
  let slotIndex = 0;
  let blockLen;
  let totalLen;
  if (mode === "direct") {
    const total = readBits(bytes, bit, DIRECT_TOTAL_BITS);
    bit = total.next;
    totalLen = total.value + 1;
    blockLen = totalLen;
  } else {
    if (mode === "mds") {
      const sequence = readBits(bytes, bit, 8);
      seq = sequence.value;
      bit = sequence.next;
    }
    if (extendedGrid) {
      const cols = readBits(bytes, bit, EXT_GRID_DIM_BITS);
      gridCols = cols.value + 1;
      const rows = readBits(bytes, cols.next, EXT_GRID_DIM_BITS);
      gridRows = rows.value + 1;
      const slot = readBits(bytes, rows.next, EXT_GRID_SLOT_BITS);
      slotIndex = slot.value;
      bit = slot.next;
    } else {
      const layout = readBits(bytes, bit, 4);
      layoutId = layout.value;
      const slot = readBits(bytes, layout.next, 5);
      slotIndex = slot.value;
      bit = slot.next;
    }
    const block = readBits(bytes, bit, BLOCK_LEN_BITS);
    blockLen = block.value + 1;
    const total = readBits(bytes, block.next, mode === "mds" ? MDS_TOTAL_BITS : RAPTORQ_TOTAL_BITS);
    totalLen = total.value + 1;
    bit = total.next;
  }
  const identity = readBits(bytes, bit, 32);
  bit = identity.next;
  while (bit < headerLen * 8) {
    const reserved = readBits(bytes, bit, 1);
    if (reserved.value !== 0) return null;
    bit = reserved.next;
  }
  const sourceBlockLen = mode === "raptorq" ? blockLen - RAPTOR_PACKET_ID_BYTES : blockLen;
  if (sourceBlockLen < 1) return null;
  const k = Math.ceil(totalLen / sourceBlockLen);
  if (k === 0 || k > RAPTOR_MAX_K || codingMode(k) !== mode) return null;
  if (mode !== "direct") {
    if (extendedGrid) {
      const count = gridCols * gridRows;
      if (gridCols < 1 || gridCols > 32 || gridRows < 1 || gridRows > 32 ||
          count < 2 || count > EXT_GRID_MAX_SLOTS || slotIndex >= count)
        return null;
    } else {
      const layout = gridLayoutById(layoutId);
      if (!layout || slotIndex >= layout.cols * layout.rows) return null;
      gridCols = layout.cols;
      gridRows = layout.rows;
    }
  }
  const packetLength = headerLen + blockLen;
  if (bytes.length !== packetLength + crcBytes) return null;
  if (hasCrc === true) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(packetLength, true) !== crc32(bytes.subarray(0, packetLength))) return null;
  }
  const block = bytes.subarray(headerLen, packetLength);
  if (mode === "raptorq") {
    seq = raptorPacketEsi(block);
    if (seq < 0) return null;
  }
  const header = {
    mode,
    seq,
    layoutId,
    extendedGrid,
    gridCols,
    gridRows,
    slotIndex,
    k,
    blockLen,
    totalLen,
    payloadId: identity.value >>> 0
  };
  return { header, block };
}
function parseFrame(bytes) {
  return parseFrameBody(bytes, true);
}
function parseVerifiedFrame(bytes, hasCrc = true) {
  return parseFrameBody(bytes, hasCrc ? "verified" : false);
}
function streamIdentity(h) {
  return `${h.payloadId}:${h.mode}:${h.k}:${h.blockLen}:${h.totalLen}`;
}
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < 256; value++) {
    let crc = value;
    for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 3988292384 : 0);
    table[value] = crc >>> 0;
  }
  return table;
})();
function crc32(bytes) {
  let crc = 4294967295;
  for (const value of bytes) crc = CRC32_TABLE[(crc ^ value) & 255] ^ crc >>> 8;
  return ~crc >>> 0;
}
function fnv1a(bytes) {
  let h = 2166136261;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function splitmix32(seed) {
  let s = seed | 0;
  return () => {
    s = s + 2654435769 | 0;
    let t = s ^ s >>> 16;
    t = Math.imul(t, 569420461);
    t ^= t >>> 15;
    t = Math.imul(t, 1935289751);
    t ^= t >>> 15;
    return t >>> 0;
  };
}
export {
  FRAME_CRC_LEN,
  MAX_FILE_BYTES,
  MAX_FILE_LABEL,
  crc32,
  fnv1a,
  frameHeaderLength,
  frameOverhead,
  isPrecompressedType,
  packFile,
  packFrame,
  parseFrame,
  parseVerifiedFrame,
  splitmix32,
  streamIdentity,
  unpackFile,
  verifyFile
};
