import { codingMode, RAPTOR_MAX_K, RAPTOR_PACKET_ID_BYTES, type CodingMode } from "./coding-mode";
import { gridLayoutById } from "./grid-layout";

// Regime-specific frame protocol. The format byte identifies both AirGapper
// and the coding mode; exact-width fields follow, then one coded block and the
// trailing CRC32 consumed by both JavaScript and the native tracked decoder.

const DIRECT_MAGIC = 0xd3;
const MDS_MAGIC = 0xd4;
const RAPTORQ_MAGIC = 0xd5;
const DIRECT_HEADER_LEN = 7;
const MDS_HEADER_LEN = 11;
const RAPTORQ_HEADER_LEN = 14;
export const FRAME_CRC_LEN = 4;

export function frameHeaderLength(mode: CodingMode): number {
  return mode === "direct" ? DIRECT_HEADER_LEN : mode === "mds" ? MDS_HEADER_LEN : RAPTORQ_HEADER_LEN;
}

export function frameOverhead(mode: CodingMode): number {
  return frameHeaderLength(mode) + FRAME_CRC_LEN;
}
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
/**
 * One place for the number, so the picker label, the rejection message and
 * packFile()'s own error can't drift apart. The HTML pulls it in as the
 * `%MAX_FILE_LABEL%` token (see htmlTokens() in vite.config.ts).
 *
 * README.md still spells it out in prose — nothing templates a markdown file,
 * so that one is on you if this ever changes.
 */
export const MAX_FILE_LABEL = `${MAX_FILE_BYTES / 1024 / 1024} MB`;
// flags + name length + media-type length + original length + SHA-256.
// The transmitted length is everything after the metadata and therefore does
// not need to be stored. The outer framed stream already authenticates this
// container, so it also needs no magic or version bytes of its own.
const FILE_HEADER_LEN = 41;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type CompressionMode = "none" | "gzip";

export interface PackedOpticalFile {
  container: Uint8Array;
  compression: CompressionMode;
  originalSize: number;
  transmittedSize: number;
}

export interface OpticalFile {
  name: string;
  type: string;
  bytes: Uint8Array;
  sha256: Uint8Array;
  compression: CompressionMode;
  transmittedSize: number;
}

async function digest(bytes: Uint8Array): Promise<Uint8Array> {
  const stableBytes = Uint8Array.from(bytes);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", stableBytes));
}

async function gzipAsync(bytes: Uint8Array): Promise<Uint8Array> {
  const compressed = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(compressed).arrayBuffer());
}

/**
 * Inflate with a hard output ceiling.
 *
 * The gzip trailer's declared size is attacker-controlled — it arrives over the
 * optical channel like everything else — so it is a hint, never a bound. This
 * counts bytes as they come off the stream and aborts the moment they exceed
 * `maxBytes`, which the caller has already clamped to MAX_FILE_BYTES. Without
 * this an 80 KB stream could claim to be small and inflate to gigabytes.
 */
async function gunzipAsync(bytes: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  const inflated = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  const reader = inflated.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("The recovered file expands past its declared length.");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Reduce a name to a bare basename.
 *
 * Applied on BOTH ends. The sender doing it is a convenience; the receiver
 * doing it is the part that matters, because the name it unpacks arrived over
 * the optical channel and is whatever the other screen chose to display. The
 * `download` attribute is the only consumer and browsers sanitise it too, but
 * the receiver has no reason to take the sender's word for it.
 */
function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  // Strip control characters (NUL and newlines in particular) and the
  // relative-path names that survive a basename split.
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "transfer.bin" : cleaned;
}

/** Media types whose bytes are already entropy-coded, keyed by exact subtype. */
const PRECOMPRESSED_TYPES = new Set([
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
  "application/zstd",
]);

/** Image and audio subtypes that are NOT already compressed — the exceptions
 *  to the otherwise-safe "all image/*, all audio/*" rule. */
const COMPRESSIBLE_IMAGES = /^image\/(bmp|x-ms-bmp|svg\+xml|tiff|x-icon|vnd\.microsoft\.icon)$/;
const COMPRESSIBLE_AUDIO = /^audio\/(wav|x-wav|wave|vnd\.wave|aiff|x-aiff|basic|l16)$/;

/**
 * Would gzip be a waste of time on this?
 *
 * Trying costs a full-size allocation and a pass over every byte to discover
 * the answer. On a 64 MB pick that is one of the five simultaneous copies the
 * sender holds, and JPEGs, MP4s and zips — the files people actually send —
 * never win the trade.
 *
 * Deliberately a list rather than a heuristic, and deliberately conservative:
 * a wrong "skip" costs a few percent of transfer size, a wrong "try" costs a
 * whole buffer. Formats that genuinely do compress (bmp, svg, tiff, wav) are
 * excluded on purpose, and PDF is left off the list entirely — its streams are
 * usually deflated already, but text-heavy ones still gain enough to matter.
 */
export function isPrecompressedType(type: string): boolean {
  const media = type.split(";")[0]!.trim().toLowerCase();
  if (media.startsWith("video/")) return true;
  if (media.startsWith("image/")) return !COMPRESSIBLE_IMAGES.test(media);
  if (media.startsWith("audio/")) return !COMPRESSIBLE_AUDIO.test(media);
  // The OOXML and OpenDocument families are zip containers.
  if (media.startsWith("application/vnd.openxmlformats-officedocument.")) return true;
  if (media.startsWith("application/vnd.oasis.opendocument.")) return true;
  if (media.endsWith("+zip")) return true;
  return PRECOMPRESSED_TYPES.has(media);
}

export async function packFile(
  name: string,
  type: string,
  bytes: Uint8Array,
  tryCompression = false,
): Promise<PackedOpticalFile> {
  if (bytes.length === 0) throw new Error("Choose a non-empty file.");
  if (bytes.length > MAX_FILE_BYTES) {
    throw new Error(`Files are limited to ${MAX_FILE_LABEL} in this browser build.`);
  }

  const nameBytes = textEncoder.encode(safeFileName(name));
  const typeBytes = textEncoder.encode(type || "application/octet-stream");
  if (nameBytes.length > 0xffff || typeBytes.length > 0xffff) {
    throw new Error("The file name or media type is too long.");
  }

  // Too small to be worth a gzip header, or a format gzip cannot help with.
  const tryGzip = typeof CompressionStream !== "undefined" &&
    bytes.length >= 768 && (tryCompression || !isPrecompressedType(type));
  const [sha256, compressed] = await Promise.all([
    digest(bytes),
    tryGzip ? gzipAsync(bytes) : Promise.resolve(undefined),
  ]);
  const useGzip = compressed !== undefined && compressed.length + 64 < bytes.length;
  const transmitted = useGzip ? compressed : bytes;
  const compression: CompressionMode = useGzip ? "gzip" : "none";
  const out = new Uint8Array(
    FILE_HEADER_LEN + nameBytes.length + typeBytes.length + transmitted.length,
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
    transmittedSize: transmitted.length,
  };
}

export async function unpackFile(container: Uint8Array): Promise<OpticalFile> {
  if (container.length < FILE_HEADER_LEN) throw new Error("The recovered file header is incomplete.");

  const view = new DataView(container.buffer, container.byteOffset, container.byteLength);
  const compressionByte = view.getUint8(0);
  if (compressionByte > 1) throw new Error("The recovered file uses unsupported compression.");
  const compression: CompressionMode = compressionByte === 1 ? "gzip" : "none";
  const nameLength = view.getUint16(1, true);
  const typeLength = view.getUint16(3, true);
  const fileLength = view.getUint32(5, true);
  const dataOffset = FILE_HEADER_LEN + nameLength + typeLength;
  const transmittedLength = container.length - dataOffset;
  if (
    fileLength === 0 ||
    fileLength > MAX_FILE_BYTES ||
    transmittedLength <= 0 ||
    transmittedLength > MAX_FILE_BYTES ||
    dataOffset > container.length
  ) {
    throw new Error("The recovered file length does not match its header.");
  }

  const transmitted = container.slice(dataOffset);
  if (compression === "gzip") {
    if (transmitted.length < 18) throw new Error("The recovered gzip payload is incomplete.");
    const trailer = new DataView(
      transmitted.buffer,
      transmitted.byteOffset + transmitted.byteLength - 4,
      4,
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
      textDecoder.decode(container.subarray(FILE_HEADER_LEN, FILE_HEADER_LEN + nameLength)),
    ),
    type:
      textDecoder.decode(container.subarray(FILE_HEADER_LEN + nameLength, dataOffset)) ||
      "application/octet-stream",
    sha256: container.slice(9, 41),
    bytes,
    compression,
    transmittedSize: transmittedLength,
  };
}

export async function verifyFile(file: OpticalFile): Promise<boolean> {
  const actual = await digest(file.bytes);
  return actual.every((value, index) => value === file.sha256[index]);
}

export interface FrameHeader {
  mode: CodingMode;
  /** Encoding symbol ID; identical IDs always describe the same equation. */
  seq: number;
  layoutId: number;
  slotIndex: number;
  k: number;
  blockLen: number;
  totalLen: number;
  payloadId: number;
}

const BLOCK_LEN_BITS = 12;
const DIRECT_TOTAL_BITS = 12;
const MDS_TOTAL_BITS = 17;
const RAPTORQ_TOTAL_BITS = 27;

function magicForMode(mode: CodingMode): number {
  return mode === "direct" ? DIRECT_MAGIC : mode === "mds" ? MDS_MAGIC : RAPTORQ_MAGIC;
}

function modeForMagic(magic: number): CodingMode | null {
  return magic === DIRECT_MAGIC ? "direct" : magic === MDS_MAGIC ? "mds" : magic === RAPTORQ_MAGIC ? "raptorq" : null;
}

function writeBits(out: Uint8Array, bitOffset: number, value: number, width: number): number {
  for (let bit = 0; bit < width; bit++) {
    if ((value >>> bit) & 1) out[(bitOffset + bit) >>> 3] = out[(bitOffset + bit) >>> 3]! | 1 << ((bitOffset + bit) & 7);
  }
  return bitOffset + width;
}

function readBits(bytes: Uint8Array, bitOffset: number, width: number): { value: number; next: number } {
  let value = 0;
  for (let bit = 0; bit < width; bit++) {
    value += ((bytes[(bitOffset + bit) >>> 3]! >>> ((bitOffset + bit) & 7)) & 1) * 2 ** bit;
  }
  return { value, next: bitOffset + width };
}

function fitsBits(value: number, width: number): boolean {
  return Number.isInteger(value) && value >= 0 && value < 2 ** width;
}

export function packFrame(h: FrameHeader, block: Uint8Array): Uint8Array {
  const headerLen = frameHeaderLength(h.mode);
  if (
    codingMode(h.k) !== h.mode || (h.mode === "raptorq" && h.k > RAPTOR_MAX_K) || block.length !== h.blockLen ||
    h.blockLen <= (h.mode === "raptorq" ? RAPTOR_PACKET_ID_BYTES : 0) ||
    Math.ceil(h.totalLen / (h.blockLen - (h.mode === "raptorq" ? RAPTOR_PACKET_ID_BYTES : 0))) !== h.k ||
    !fitsBits(h.payloadId, 32) || !fitsBits(h.blockLen - 1, BLOCK_LEN_BITS) ||
    !fitsBits(h.totalLen - 1, h.mode === "direct" ? DIRECT_TOTAL_BITS : h.mode === "mds" ? MDS_TOTAL_BITS : RAPTORQ_TOTAL_BITS) ||
    (h.mode === "direct" && (h.seq !== 0 || h.layoutId !== 0 || h.slotIndex !== 0 || h.blockLen !== h.totalLen)) ||
    (h.mode === "mds" && !fitsBits(h.seq, 8)) ||
    (h.mode === "raptorq" && !fitsBits(h.seq, 24)) ||
    (h.mode !== "direct" && (!fitsBits(h.layoutId, 3) || !fitsBits(h.slotIndex, 4)))
  ) throw new Error("Frame metadata exceeds its packed field.");

  const out = new Uint8Array(headerLen + block.length + FRAME_CRC_LEN);
  out[0] = magicForMode(h.mode);
  let bit = 8;
  if (h.mode === "direct") {
    bit = writeBits(out, bit, h.totalLen - 1, DIRECT_TOTAL_BITS);
  } else {
    bit = writeBits(out, bit, h.seq, h.mode === "mds" ? 8 : 24);
    bit = writeBits(out, bit, h.layoutId, 3);
    bit = writeBits(out, bit, h.slotIndex, 4);
    bit = writeBits(out, bit, h.blockLen - 1, BLOCK_LEN_BITS);
    bit = writeBits(out, bit, h.totalLen - 1, h.mode === "mds" ? MDS_TOTAL_BITS : RAPTORQ_TOTAL_BITS);
  }
  writeBits(out, bit, h.payloadId >>> 0, 32);
  out.set(block, headerLen);
  new DataView(out.buffer).setUint32(
    headerLen + block.length,
    crc32(out.subarray(0, headerLen + block.length)),
    true,
  );
  return out;
}

export function parseFrame(
  bytes: Uint8Array,
): { header: FrameHeader; block: Uint8Array } | null {
  const mode = modeForMagic(bytes[0] ?? -1);
  if (!mode) return null;
  const headerLen = frameHeaderLength(mode);
  if (bytes.length < headerLen + FRAME_CRC_LEN + 1) return null;

  let bit = 8;
  let seq = 0;
  let layoutId = 0;
  let slotIndex = 0;
  let blockLen: number;
  let totalLen: number;
  if (mode === "direct") {
    const total = readBits(bytes, bit, DIRECT_TOTAL_BITS);
    bit = total.next;
    totalLen = total.value + 1;
    blockLen = totalLen;
  } else {
    const sequence = readBits(bytes, bit, mode === "mds" ? 8 : 24);
    seq = sequence.value;
    const layout = readBits(bytes, sequence.next, 3);
    layoutId = layout.value;
    const slot = readBits(bytes, layout.next, 4);
    slotIndex = slot.value;
    const block = readBits(bytes, slot.next, BLOCK_LEN_BITS);
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
    const layout = gridLayoutById(layoutId);
    if (!layout || slotIndex >= layout.cols * layout.rows) return null;
  }
  const packetLength = headerLen + blockLen;
  if (bytes.length !== packetLength + FRAME_CRC_LEN) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(packetLength, true) !== crc32(bytes.subarray(0, packetLength))) return null;
  const header: FrameHeader = {
    mode, seq, layoutId, slotIndex, k, blockLen, totalLen,
    payloadId: identity.value >>> 0,
  };
  return { header, block: bytes.subarray(headerLen, packetLength) };
}

/** Stable stream identity. Restarting the same payload with the same transport
 * plan produces identical equations and safely continues receiver progress. */
export function streamIdentity(h: FrameHeader): string {
  return `${h.payloadId}:${h.mode}:${h.k}:${h.blockLen}:${h.totalLen}:${h.layoutId}`;
}

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (~crc) >>> 0;
}

export function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** splitmix32 — deterministic across JS engines (integer ops only). */
export function splitmix32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x9e3779b9) | 0;
    let t = s ^ (s >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    t ^= t >>> 15;
    return t >>> 0;
  };
}
