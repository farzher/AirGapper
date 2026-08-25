import { compactRgbaGreenInPlace } from "./rgba-luma.js";

// Worker wrapper for live camera decode jobs.
//
// rVFC/canvas capture arrives as a transferred RGBA ArrayBuffer. Compact the
// achromatic green channel into the beginning of that same owned buffer instead
// of allocating another full Y8 frame. TrackProcessor jobs also arrive here so
// the hot path can unpack its compact track descriptor without structured-clone
// churn from dozens of nested quad objects per camera frame.

const query = self.location.search || "";
await import(`./worker-core.js${query}`);

const baseOnMessage = self.onmessage;
const nativePostMessage = self.postMessage.bind(self);
const PACKED_TRACK_BYTES = 56;
const PACKED_TRACK_WORDS = PACKED_TRACK_BYTES >> 2;
const PACKED_SYMBOL_BYTES = 88;
const PACKED_SYMBOL_WORDS = PACKED_SYMBOL_BYTES >> 2;
const GEOMETRY_REPORTS_PER_FRAME = 4;
const MAX_GEOMETRY_SYMBOLS = 128;
const trackPool = [];
const activeTracks = [];
let activeSourceSequence = -1;
let activeLiveTracked = false;
let activePackedResultEligible = false;
let activePackedTrackBuffer = null;
let activePackedSymbolScratch = null;

// Geometry thinning runs on every successful dense worker result. Keep its
// scratch storage worker-local and reusable instead of building filter/map/
// group/Set object graphs at camera cadence.
const measuredSymbols = new Array(MAX_GEOMETRY_SYMBOLS);
const measuredX = new Float64Array(MAX_GEOMETRY_SYMBOLS);
const measuredY = new Float64Array(MAX_GEOMETRY_SYMBOLS);
const quadrantCounts = new Uint16Array(4);
const quadrantSeen = new Uint16Array(4);
const selectedSymbols = new Array(GEOMETRY_REPORTS_PER_FRAME);

function validQuad(quad) {
  if (!quad) return false;
  const a = quad.topLeft, b = quad.topRight, c = quad.bottomRight, d = quad.bottomLeft;
  return Boolean(a && b && c && d &&
    Number.isFinite(a.x) && Number.isFinite(a.y) &&
    Number.isFinite(b.x) && Number.isFinite(b.y) &&
    Number.isFinite(c.x) && Number.isFinite(c.y) &&
    Number.isFinite(d.x) && Number.isFinite(d.y));
}

function alreadySelected(symbol, count) {
  for (let index = 0; index < count; index++) {
    if (selectedSymbols[index] === symbol) return true;
  }
  return false;
}

function thinGeometryReports(symbols) {
  if (!activeLiveTracked || !Array.isArray(symbols)) return;

  let measuredCount = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let index = 0; index < symbols.length && measuredCount < MAX_GEOMETRY_SYMBOLS; index++) {
    const symbol = symbols[index];
    if (!symbol || symbol.geometryMeasured === false || !validQuad(symbol.quad)) continue;
    const q = symbol.quad;
    const x = (q.topLeft.x + q.topRight.x + q.bottomRight.x + q.bottomLeft.x) * 0.25;
    const y = (q.topLeft.y + q.topRight.y + q.bottomRight.y + q.bottomLeft.y) * 0.25;
    measuredSymbols[measuredCount] = symbol;
    measuredX[measuredCount] = x;
    measuredY[measuredCount] = y;
    measuredCount++;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (measuredCount <= GEOMETRY_REPORTS_PER_FRAME) return;

  const midX = (minX + maxX) * 0.5;
  const midY = (minY + maxY) * 0.5;
  quadrantCounts.fill(0);
  for (let index = 0; index < measuredCount; index++) {
    const quadrant = (measuredY[index] >= midY ? 2 : 0) + Number(measuredX[index] >= midX);
    quadrantCounts[quadrant]++;
  }

  // Rotate within each quadrant so persistent lens-residual learning eventually
  // samples every slot instead of only the four corners, while every individual
  // frame still reports geometry distributed across the wall.
  const sequence = Math.max(0, Math.trunc(Number(activeSourceSequence) || 0));
  quadrantSeen.fill(0);
  let selectedCount = 0;
  for (let index = 0; index < measuredCount; index++) {
    const quadrant = (measuredY[index] >= midY ? 2 : 0) + Number(measuredX[index] >= midX);
    const target = (sequence + quadrant) % quadrantCounts[quadrant];
    if (quadrantSeen[quadrant]++ === target) {
      selectedSymbols[selectedCount++] = measuredSymbols[index];
      if (selectedCount === GEOMETRY_REPORTS_PER_FRAME) break;
    }
  }

  if (selectedCount < GEOMETRY_REPORTS_PER_FRAME) {
    const offset = sequence % measuredCount;
    for (let step = 0; step < measuredCount && selectedCount < GEOMETRY_REPORTS_PER_FRAME; step++) {
      const symbol = measuredSymbols[(offset + step) % measuredCount];
      if (!alreadySelected(symbol, selectedCount)) selectedSymbols[selectedCount++] = symbol;
    }
  }

  for (let index = 0; index < measuredCount; index++) {
    const symbol = measuredSymbols[index];
    if (!alreadySelected(symbol, selectedCount)) symbol.geometryMeasured = false;
    measuredSymbols[index] = undefined;
  }
  for (let index = 0; index < selectedCount; index++) selectedSymbols[index] = undefined;
}

function decodePathCode(path) {
  return path === "fallback" ? 3 : path === "sparse" ? 2 : path === "robust" ? 4 : 1;
}

function modeCode(mode) {
  return mode === "direct" ? 0 : mode === "mds" ? 1 : mode === "raptorq" ? 2 : 255;
}

function addTransfer(transfer, value) {
  const list = Array.isArray(transfer) ? transfer : [];
  if (value && !list.includes(value)) list.push(value);
  return list;
}

function packLiveGuidedSymbols(message, transfer) {
  const symbols = message?.symbols;
  if (!activePackedResultEligible || !message?.guidedMetrics || !Array.isArray(symbols) || !symbols.length) return transfer;

  const firstBytes = symbols[0]?.bytes;
  const payload = firstBytes instanceof Uint8Array ? firstBytes.buffer : null;
  if (!(payload instanceof ArrayBuffer)) return transfer;
  for (let index = 0; index < symbols.length; index++) {
    const bytes = symbols[index]?.bytes;
    const header = symbols[index]?.header;
    if (!(bytes instanceof Uint8Array) || bytes.buffer !== payload || !header) return transfer;
  }

  const requiredBytes = symbols.length * PACKED_SYMBOL_BYTES;
  const meta = activePackedSymbolScratch instanceof ArrayBuffer &&
      activePackedSymbolScratch.byteLength >= requiredBytes
    ? activePackedSymbolScratch
    : new ArrayBuffer(requiredBytes);
  if (meta === activePackedSymbolScratch) activePackedSymbolScratch = null;
  // 88 bytes is exactly 22 aligned 32-bit words. Keep the same wire size while
  // replacing dozens of DataView getter/setter calls per QR with direct typed
  // array indexing. Words 0-9 are integer metadata; 10-21 are optional geometry.
  const u32 = new Uint32Array(meta);
  const f32 = new Float32Array(meta);
  let wallMotion;
  for (let index = 0; index < symbols.length; index++) {
    const symbol = symbols[index];
    const header = symbol.header;
    const base = index * PACKED_SYMBOL_WORDS;
    const measured = symbol.geometryMeasured !== false && validQuad(symbol.quad);
    let flags = Number(Boolean(symbol.tracked));
    flags |= Number(measured) << 1;
    flags |= Number(Boolean(symbol.crc32)) << 2;
    flags |= Number(Boolean(symbol.verifiedPayload)) << 3;
    flags |= Number(Boolean(header.extendedGrid)) << 4;
    const path = decodePathCode(symbol.decodePath) & 255;
    const mode = modeCode(header.mode) & 255;
    const layout = Math.max(0, Math.trunc(Number(header.layoutId) || 0)) & 255;
    const gridCols = Math.max(0, Math.trunc(Number(header.gridCols) || 0)) & 255;
    const gridRows = Math.max(0, Math.trunc(Number(header.gridRows) || 0)) & 255;
    const slot = Math.max(0, Math.trunc(Number(header.slotIndex) || 0)) & 0xffff;

    u32[base] = symbol.bytes.byteOffset >>> 0;
    u32[base + 1] = symbol.bytes.byteLength >>> 0;
    u32[base + 2] = Math.max(0, Math.trunc(Number(symbol.modules) || 0)) >>> 0;
    u32[base + 3] = (flags | (path << 8) | (mode << 16) | (layout << 24)) >>> 0;
    u32[base + 4] = (gridCols | (gridRows << 8) | (slot << 16)) >>> 0;
    u32[base + 5] = Number(header.seq) >>> 0;
    u32[base + 6] = Number(header.k) >>> 0;
    u32[base + 7] = Number(header.blockLen) >>> 0;
    u32[base + 8] = Number(header.totalLen) >>> 0;
    u32[base + 9] = Number(header.payloadId) >>> 0;

    if (measured) {
      const box = symbol.box;
      const quad = symbol.quad;
      f32[base + 10] = Number(box?.x) || 0;
      f32[base + 11] = Number(box?.y) || 0;
      f32[base + 12] = Number(box?.w) || 0;
      f32[base + 13] = Number(box?.h) || 0;
      f32[base + 14] = quad.topLeft.x;
      f32[base + 15] = quad.topLeft.y;
      f32[base + 16] = quad.topRight.x;
      f32[base + 17] = quad.topRight.y;
      f32[base + 18] = quad.bottomRight.x;
      f32[base + 19] = quad.bottomRight.y;
      f32[base + 20] = quad.bottomLeft.x;
      f32[base + 21] = quad.bottomLeft.y;
    }
    if (!wallMotion && symbol.wallMotion) wallMotion = symbol.wallMotion;
  }

  // Replace dozens of nested structured-clone records with one tiny fixed
  // metadata buffer plus the payload buffer Guided was already transferring.
  // The main thread reconstructs full geometry only for the <=4 authoritative
  // measurements; ordinary payload hits need only a header and byte view.
  message.symbols = undefined;
  message.__airgapperPackedSymbolMeta = meta;
  message.__airgapperPackedSymbolPayload = payload;
  message.__airgapperPackedSymbolCount = symbols.length;
  if (wallMotion) message.__airgapperPackedWallMotion = wallMotion;
  transfer = addTransfer(transfer, payload);
  transfer = addTransfer(transfer, meta);
  return transfer;
}

// worker-core.js posts through ctx === self, so this interception applies to its
// final result without changing the codec. Preflight/signature messages have no
// symbols and pass straight through. Input and result metadata buffers are
// returned to the page on the final result so both directions can ping-pong the
// same small allocations indefinitely after warm-up.
self.postMessage = (message, transfer) => {
  thinGeometryReports(message?.symbols);
  transfer = packLiveGuidedSymbols(message, transfer);
  if (!message?.preflight && activePackedTrackBuffer instanceof ArrayBuffer) {
    message.__airgapperPackedTrackRecycle = activePackedTrackBuffer;
    transfer = addTransfer(transfer, activePackedTrackBuffer);
    activePackedTrackBuffer = null;
  }
  if (!message?.preflight && activePackedSymbolScratch instanceof ArrayBuffer) {
    message.__airgapperPackedSymbolScratchRecycle = activePackedSymbolScratch;
    transfer = addTransfer(transfer, activePackedSymbolScratch);
    activePackedSymbolScratch = null;
  }
  return nativePostMessage(message, transfer);
};

function pooledTrack(index) {
  let track = trackPool[index];
  if (!track) {
    track = {
      id: 0,
      slot: undefined,
      misses: 0,
      dim: 0,
      crc32: false,
      temporalProbe: false,
      temporalRisk: 0,
      quad: {
        topLeft: { x: 0, y: 0 },
        topRight: { x: 0, y: 0 },
        bottomRight: { x: 0, y: 0 },
        bottomLeft: { x: 0, y: 0 }
      }
    };
    trackPool[index] = track;
  }
  return track;
}

function unpackTracks(message) {
  const buffer = message?.__airgapperPackedTracks;
  const count = Math.trunc(Number(message?.__airgapperPackedTrackCount) || 0);
  if (!(buffer instanceof ArrayBuffer) || count <= 0 || buffer.byteLength < count * PACKED_TRACK_BYTES) return;
  const i32 = new Int32Array(buffer);
  const f32 = new Float32Array(buffer);
  activeTracks.length = count;
  activePackedTrackBuffer = buffer;
  for (let index = 0; index < count; index++) {
    const base = index * PACKED_TRACK_WORDS;
    const track = pooledTrack(index);
    const slot = i32[base + 1];
    const flags = i32[base + 4] >>> 0;
    track.id = i32[base];
    track.slot = slot >= 0 ? slot : undefined;
    track.misses = i32[base + 2];
    track.dim = i32[base + 3];
    track.crc32 = Boolean(flags & 1);
    track.temporalProbe = Boolean(flags & 2);
    track.temporalRisk = f32[base + 5];
    const q = track.quad;
    q.topLeft.x = f32[base + 6];
    q.topLeft.y = f32[base + 7];
    q.topRight.x = f32[base + 8];
    q.topRight.y = f32[base + 9];
    q.bottomRight.x = f32[base + 10];
    q.bottomRight.y = f32[base + 11];
    q.bottomLeft.x = f32[base + 12];
    q.bottomLeft.y = f32[base + 13];
    activeTracks[index] = track;
  }
  message.tracks = activeTracks;
  delete message.__airgapperPackedTracks;
  delete message.__airgapperPackedTrackCount;
}

self.onmessage = (event) => {
  const message = event?.data;
  if (!message) return baseOnMessage?.call(self, event);

  activeSourceSequence = Number(message.sourceSequence);
  activeLiveTracked = Boolean(message.__airgapperLiveTracked);
  activePackedTrackBuffer = null;
  activePackedSymbolScratch = message.__airgapperPackedSymbolScratch instanceof ArrayBuffer
    ? message.__airgapperPackedSymbolScratch
    : null;
  // Normal repeat-filter-eligible live traffic excludes replay, explicit scan
  // capture and optics tournaments. Keep those diagnostic paths object-rich;
  // pack only the steady production hot path.
  activePackedResultEligible = activeLiveTracked && Boolean(message.repeatFilter);
  delete message.__airgapperLiveTracked;
  delete message.__airgapperPackedSymbolScratch;
  unpackTracks(message);

  if (!message.__airgapperWorkerLumaFromRgba) {
    return baseOnMessage?.call(self, event);
  }

  const rgbaBuffer = message.videoFrame;
  const width = Math.trunc(Number(message.w) || 0);
  const height = Math.trunc(Number(message.h) || 0);
  const pixelCount = width * height;

  if (!(rgbaBuffer instanceof ArrayBuffer) || width <= 0 || height <= 0 ||
      pixelCount <= 0 || rgbaBuffer.byteLength < pixelCount * 4) {
    message.buf = rgbaBuffer;
    message.videoFrame = undefined;
    delete message.__airgapperWorkerLumaFromRgba;
    // event.data is the same mutable message object; forwarding the original
    // MessageEvent avoids allocating a synthetic {data: message} wrapper.
    return baseOnMessage?.call(self, event);
  }

  if (!compactRgbaGreenInPlace(rgbaBuffer, pixelCount)) {
    throw new Error("Could not compact worker RGBA frame to Y8");
  }

  message.buf = undefined;
  message.videoFrame = rgbaBuffer;
  message.pixelFormat = "y8";
  message.yOffset = 0;
  message.yStride = width;
  message.payloadBytes = pixelCount;
  message.guidedDecode = true;
  delete message.__airgapperWorkerLumaFromRgba;
  return baseOnMessage?.call(self, event);
};
