import fs from "node:fs";

function read(path) {
  return fs.readFileSync(path, "utf8");
}
function write(path, content) {
  fs.writeFileSync(path, content);
}
function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`${label}: source marker not found`);
  if (source.indexOf(before, first + before.length) >= 0)
    throw new Error(`${label}: source marker is not unique`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}
function replaceBetween(source, start, end, replacement, label) {
  const at = source.indexOf(start);
  if (at < 0) throw new Error(`${label}: start marker not found`);
  const stop = source.indexOf(end, at + start.length);
  if (stop < 0) throw new Error(`${label}: end marker not found`);
  if (source.indexOf(start, at + start.length) >= 0)
    throw new Error(`${label}: start marker is not unique`);
  return source.slice(0, at) + replacement + source.slice(stop);
}

// ---------------------------------------------------------------------------
// shared/protocol.js — caller-owned verified parser records.
// ---------------------------------------------------------------------------
let protocol = read("shared/protocol.js");
protocol = replaceOnce(
  protocol,
  "function parseFrameBody(bytes, hasCrc) {",
  "function parseFrameBody(bytes, hasCrc, packetTarget, headerTarget, includeBlock = true) {",
  "protocol parse target parameters"
);
protocol = replaceOnce(
  protocol,
`  const block = bytes.subarray(headerLen, packetLength);
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
  return { header, block };`,
`  let block;
  if (includeBlock) block = bytes.subarray(headerLen, packetLength);
  if (mode === "raptorq") {
    if (includeBlock) {
      seq = raptorPacketEsi(block);
    } else {
      // The live Guided worker needs metadata only. Read the four-byte RaptorQ
      // packet id directly instead of allocating a block subarray solely to
      // discover ESI.
      if (blockLen < RAPTOR_PACKET_ID_BYTES || bytes[headerLen] !== 0) return null;
      seq = bytes[headerLen + 1] * 65536 + bytes[headerLen + 2] * 256 + bytes[headerLen + 3];
    }
    if (seq < 0) return null;
  }
  const header = headerTarget ?? {};
  header.mode = mode;
  header.seq = seq;
  header.layoutId = layoutId;
  header.extendedGrid = extendedGrid;
  header.gridCols = gridCols;
  header.gridRows = gridRows;
  header.slotIndex = slotIndex;
  header.k = k;
  header.blockLen = blockLen;
  header.totalLen = totalLen;
  header.payloadId = identity.value >>> 0;
  const packet = packetTarget ?? {};
  packet.header = header;
  packet.block = includeBlock ? block : undefined;
  return packet;`,
  "protocol caller-owned return"
);
protocol = replaceOnce(
  protocol,
`function parseVerifiedFrame(bytes, hasCrc = true) {
  return parseFrameBody(bytes, hasCrc ? "verified" : false);
}
function streamIdentity(h) {`,
`function parseVerifiedFrame(bytes, hasCrc = true) {
  return parseFrameBody(bytes, hasCrc ? "verified" : false);
}
// Allocation-free metadata parser for bytes whose CRC was already established
// by the native Guided decoder. packet/header are caller-owned and overwritten
// completely; block payload views are intentionally omitted.
function parseVerifiedFrameInto(bytes, packet, header, hasCrc = true) {
  if (!packet || !header) return null;
  return parseFrameBody(bytes, hasCrc ? "verified" : false, packet, header, false);
}
function streamIdentity(h) {`,
  "protocol parseVerifiedFrameInto"
);
protocol = replaceOnce(
  protocol,
`  parseFrame,
  parseVerifiedFrame,
  splitmix32,`,
`  parseFrame,
  parseVerifiedFrame,
  parseVerifiedFrameInto,
  splitmix32,`,
  "protocol export"
);
write("shared/protocol.js", protocol);

// ---------------------------------------------------------------------------
// receive/worker.js — reusable Guided hot-path storage and measured-only quads.
// ---------------------------------------------------------------------------
let worker = read("receive/worker.js");
worker = replaceOnce(
  worker,
`import { parseFrame, parseVerifiedFrame } from "../shared/protocol.js";
import { gridLayoutById } from "../shared/grid-layout.js";`,
`import { parseFrame, parseVerifiedFrame, parseVerifiedFrameInto } from "../shared/protocol.js";
import { gridLayoutById } from "../shared/grid-layout.js";
import { GuidedMotionAccumulator } from "./guided-motion.js";`,
  "worker imports"
);
worker = replaceOnce(
  worker,
`const GUIDED_TRACK_BYTES = 40;
const GUIDED_RESULT_BYTES = 52;`,
`const GUIDED_TRACK_BYTES = 40;
const GUIDED_TRACK_WORDS = GUIDED_TRACK_BYTES >> 2;
const GUIDED_RESULT_BYTES = 52;
const GUIDED_RESULT_WORDS = GUIDED_RESULT_BYTES >> 2;`,
  "worker record words"
);
worker = replaceOnce(
  worker,
`const guidedSymbolsScratch = [];
const guidedWallMotionScratch = [];
const guidedSeenSlots = new Int32Array(GUIDED_BATCH_MAX_TRACKS);`,
`const guidedSymbolsScratch = [];
const guidedSymbolPool = [];
const guidedPacketPool = [];
const guidedMotion = new GuidedMotionAccumulator(GUIDED_BATCH_MAX_TRACKS);
const guidedMetricsScratch = {};
const guidedOpticalScratch = {};
const guidedSeenSlots = new Int32Array(GUIDED_BATCH_MAX_TRACKS);`,
  "worker guided scratch"
);
worker = replaceOnce(
  worker,
`const guidedOutputLengths = new Int32Array(GUIDED_BATCH_MAX_TRACKS);
function guidedTrackIndexForSlot(tracks, slot) {`,
`const guidedOutputLengths = new Int32Array(GUIDED_BATCH_MAX_TRACKS);
let guidedViewsBuffer = null;
let guidedTracksI32;
let guidedTracksF32;
let guidedResultsI32;
let guidedResultsF32;
let guidedMetricsView;
const workerSymbolsScratch = [];
const workerSightingsScratch = [];
const videoCopyRect = { x: 0, y: 0, width: 0, height: 0 };
const videoCopyYOptions = { rect: videoCopyRect };
const videoCopyRgbaOptions = { rect: videoCopyRect, format: "RGBA" };
function refreshGuidedViews(zx) {
  const buffer = zx.HEAPU8.buffer;
  if (guidedViewsBuffer === buffer && guidedTracksI32) return;
  guidedViewsBuffer = buffer;
  guidedTracksI32 = new Int32Array(buffer, guidedTracksPtr, GUIDED_BATCH_MAX_TRACKS * GUIDED_TRACK_WORDS);
  guidedTracksF32 = new Float32Array(buffer, guidedTracksPtr, GUIDED_BATCH_MAX_TRACKS * GUIDED_TRACK_WORDS);
  guidedResultsI32 = new Int32Array(buffer, guidedResultsPtr, GUIDED_BATCH_MAX_TRACKS * GUIDED_RESULT_WORDS);
  guidedResultsF32 = new Float32Array(buffer, guidedResultsPtr, GUIDED_BATCH_MAX_TRACKS * GUIDED_RESULT_WORDS);
  guidedMetricsView = new DataView(buffer, guidedMetricsPtr, GUIDED_METRICS_BYTES);
}
function guidedSymbolAt(index) {
  let symbol = guidedSymbolPool[index];
  if (!symbol) symbol = guidedSymbolPool[index] = {};
  return symbol;
}
function guidedPacketAt(index) {
  let packet = guidedPacketPool[index];
  if (!packet) packet = guidedPacketPool[index] = { header: {} };
  return packet;
}
function guidedTrackIndexForSlot(tracks, slot) {`,
  "worker reusable helpers"
);
worker = replaceOnce(
  worker,
`  if (!ensureGuidedBatch(zx) || !tracks.length || tracks.length > GUIDED_BATCH_MAX_TRACKS) return null;
  let view = new DataView(zx.HEAPU8.buffer, guidedTracksPtr, tracks.length * GUIDED_TRACK_BYTES);
  let validTrackSlotCount = 0;`,
`  if (!ensureGuidedBatch(zx) || !tracks.length || tracks.length > GUIDED_BATCH_MAX_TRACKS) return null;
  refreshGuidedViews(zx);
  let validTrackSlotCount = 0;`,
  "worker guided track view"
);
worker = replaceOnce(
  worker,
`    const base = i * GUIDED_TRACK_BYTES;
    const slot = Number(track.slot ?? track.id);
    if (Number.isInteger(slot) && slot >= 0) validTrackSlotCount++;
    view.setInt32(base, track.slot ?? track.id ?? i, true);
    view.setInt32(base + 4, track.dim, true);
    const q = track.quad;
    view.setFloat32(base + 8, q.topLeft.x - ox, true);
    view.setFloat32(base + 12, q.topLeft.y - oy, true);
    view.setFloat32(base + 16, q.topRight.x - ox, true);
    view.setFloat32(base + 20, q.topRight.y - oy, true);
    view.setFloat32(base + 24, q.bottomRight.x - ox, true);
    view.setFloat32(base + 28, q.bottomRight.y - oy, true);
    view.setFloat32(base + 32, q.bottomLeft.x - ox, true);
    view.setFloat32(base + 36, q.bottomLeft.y - oy, true);`,
`    const base = i * GUIDED_TRACK_WORDS;
    const slot = Number(track.slot ?? track.id);
    if (Number.isInteger(slot) && slot >= 0) validTrackSlotCount++;
    guidedTracksI32[base] = track.slot ?? track.id ?? i;
    guidedTracksI32[base + 1] = track.dim;
    const q = track.quad;
    guidedTracksF32[base + 2] = q.topLeft.x - ox;
    guidedTracksF32[base + 3] = q.topLeft.y - oy;
    guidedTracksF32[base + 4] = q.topRight.x - ox;
    guidedTracksF32[base + 5] = q.topRight.y - oy;
    guidedTracksF32[base + 6] = q.bottomRight.x - ox;
    guidedTracksF32[base + 7] = q.bottomRight.y - oy;
    guidedTracksF32[base + 8] = q.bottomLeft.x - ox;
    guidedTracksF32[base + 9] = q.bottomLeft.y - oy;`,
  "worker typed track packing"
);
worker = replaceOnce(
  worker,
`  const metricsView = new DataView(zx.HEAPU8.buffer, guidedMetricsPtr, GUIDED_METRICS_BYTES);
  const metrics = {
    totalMs: metricsView.getFloat64(0, true),
    binarizeMs: metricsView.getFloat64(8, true),
    finderMs: metricsView.getFloat64(16, true),
    sampleMs: metricsView.getFloat64(24, true),
    decodeMs: metricsView.getFloat64(32, true),
    tracks: metricsView.getUint32(40, true),
    finderAttempts: metricsView.getUint32(44, true),
    finderSuccesses: metricsView.getUint32(48, true),
    finderTriplets: metricsView.getUint32(52, true),
    sampleAttempts: metricsView.getUint32(56, true),
    successful: metricsView.getUint32(60, true),
    misses: metricsView.getUint32(64, true),
    fastDecodeAttempts: metricsView.getUint32(68, true),
    fastDecodeSuccesses: metricsView.getUint32(72, true),
    genericDecodeAttempts: metricsView.getUint32(76, true),
    fastDecodeMs: metricsView.getFloat64(80, true),
    genericDecodeMs: metricsView.getFloat64(88, true),
    genericFallbackTracks: metricsView.getUint32(96, true),
    genericFallbackSuccesses: metricsView.getUint32(100, true),
    genericFallbackSkipped: metricsView.getUint32(104, true),
    sparseNoRsAttempts: metricsView.getUint32(108, true),
    sparseNoRsSuccesses: metricsView.getUint32(112, true),
    sparseRsFallbacks: metricsView.getUint32(116, true),
    sparseSkipped: metricsView.getUint32(120, true),
    turboAttempts: metricsView.getUint32(124, true),
    fallbackAttemptMask: metricsView.getUint32(128, true),
    fallbackSuccessMask: metricsView.getUint32(132, true),
    sparseSuccessMask: metricsView.getUint32(136, true),
    turboSuccesses: metricsView.getUint32(140, true),
    stableRsAttempts: metricsView.getUint32(144, true),
    stableRsSuccesses: metricsView.getUint32(148, true),
    stableEligibleTracks: metricsView.getUint32(152, true),
    sparseProfileAttempts: metricsView.getUint32(156, true),
    sparseProfileSuccesses: metricsView.getUint32(160, true),
    translationWarpTracks: metricsView.getUint32(164, true),
    affineWarpTracks: metricsView.getUint32(168, true),
    perspectiveWarpTracks: metricsView.getUint32(172, true),
    perspectiveMeshWarpTracks: metricsView.getUint32(176, true),
    erasureRsAttempts: metricsView.getUint32(180, true),
    erasureRsSuccesses: metricsView.getUint32(184, true),
    erasureRepairCodewords: metricsView.getUint32(188, true),
    erasureRepairAttemptMask: metricsView.getUint32(192, true),
    erasureRepairSuccessMask: metricsView.getUint32(196, true),
    erasureRepairSuppressedMask: metricsView.getUint32(200, true),
    finderLevelTracks: metricsView.getUint32(204, true),
    finderLevelMatches: metricsView.getUint32(208, true),
    finderLevelSeparation: metricsView.getUint32(212, true)
  };`,
`  // Native decode can grow WebAssembly.Memory, invalidating pre-call views.
  refreshGuidedViews(zx);
  const metricsView = guidedMetricsView;
  const metrics = guidedMetricsScratch;
  metrics.totalMs = metricsView.getFloat64(0, true);
  metrics.binarizeMs = metricsView.getFloat64(8, true);
  metrics.finderMs = metricsView.getFloat64(16, true);
  metrics.sampleMs = metricsView.getFloat64(24, true);
  metrics.decodeMs = metricsView.getFloat64(32, true);
  metrics.tracks = metricsView.getUint32(40, true);
  metrics.finderAttempts = metricsView.getUint32(44, true);
  metrics.finderSuccesses = metricsView.getUint32(48, true);
  metrics.finderTriplets = metricsView.getUint32(52, true);
  metrics.sampleAttempts = metricsView.getUint32(56, true);
  metrics.successful = metricsView.getUint32(60, true);
  metrics.misses = metricsView.getUint32(64, true);
  metrics.fastDecodeAttempts = metricsView.getUint32(68, true);
  metrics.fastDecodeSuccesses = metricsView.getUint32(72, true);
  metrics.genericDecodeAttempts = metricsView.getUint32(76, true);
  metrics.fastDecodeMs = metricsView.getFloat64(80, true);
  metrics.genericDecodeMs = metricsView.getFloat64(88, true);
  metrics.genericFallbackTracks = metricsView.getUint32(96, true);
  metrics.genericFallbackSuccesses = metricsView.getUint32(100, true);
  metrics.genericFallbackSkipped = metricsView.getUint32(104, true);
  metrics.sparseNoRsAttempts = metricsView.getUint32(108, true);
  metrics.sparseNoRsSuccesses = metricsView.getUint32(112, true);
  metrics.sparseRsFallbacks = metricsView.getUint32(116, true);
  metrics.sparseSkipped = metricsView.getUint32(120, true);
  metrics.turboAttempts = metricsView.getUint32(124, true);
  metrics.fallbackAttemptMask = metricsView.getUint32(128, true);
  metrics.fallbackSuccessMask = metricsView.getUint32(132, true);
  metrics.sparseSuccessMask = metricsView.getUint32(136, true);
  metrics.turboSuccesses = metricsView.getUint32(140, true);
  metrics.stableRsAttempts = metricsView.getUint32(144, true);
  metrics.stableRsSuccesses = metricsView.getUint32(148, true);
  metrics.stableEligibleTracks = metricsView.getUint32(152, true);
  metrics.sparseProfileAttempts = metricsView.getUint32(156, true);
  metrics.sparseProfileSuccesses = metricsView.getUint32(160, true);
  metrics.translationWarpTracks = metricsView.getUint32(164, true);
  metrics.affineWarpTracks = metricsView.getUint32(168, true);
  metrics.perspectiveWarpTracks = metricsView.getUint32(172, true);
  metrics.perspectiveMeshWarpTracks = metricsView.getUint32(176, true);
  metrics.erasureRsAttempts = metricsView.getUint32(180, true);
  metrics.erasureRsSuccesses = metricsView.getUint32(184, true);
  metrics.erasureRepairCodewords = metricsView.getUint32(188, true);
  metrics.erasureRepairAttemptMask = metricsView.getUint32(192, true);
  metrics.erasureRepairSuccessMask = metricsView.getUint32(196, true);
  metrics.erasureRepairSuppressedMask = metricsView.getUint32(200, true);
  metrics.finderLevelTracks = metricsView.getUint32(204, true);
  metrics.finderLevelMatches = metricsView.getUint32(208, true);
  metrics.finderLevelSeparation = metricsView.getUint32(212, true);
  metrics.optical = undefined;`,
  "worker reusable metrics"
);
worker = replaceOnce(
  worker,
`    metrics.optical = {
      confidence: finderConfidence,
      focusScore: Math.max(0, Math.min(1, (finderConfidence - 0.72) / 0.25)) *
        Math.max(0, Math.min(1, (separation - 20) / 70)) * (1 - correctionBurden * 0.45),
      exposureScore: Math.max(0, Math.min(1, (separation - 24) / 92)) * finderConfidence,
      transitionWidthModules: 1 - finderConfidence,
      blackLevel: 0,
      whiteLevel: separation,
      separation,
      noise: correctionBurden * Math.max(18, separation * 0.3),
      clipping: 0,
      banding: 0,
      temporalContamination: 0,
      tiles: metrics.finderLevelTracks,
      sampledModules: metrics.finderLevelTracks * 147,
      correctionBurden
    };`,
`    const optical = guidedOpticalScratch;
    optical.confidence = finderConfidence;
    optical.focusScore = Math.max(0, Math.min(1, (finderConfidence - 0.72) / 0.25)) *
      Math.max(0, Math.min(1, (separation - 20) / 70)) * (1 - correctionBurden * 0.45);
    optical.exposureScore = Math.max(0, Math.min(1, (separation - 24) / 92)) * finderConfidence;
    optical.transitionWidthModules = 1 - finderConfidence;
    optical.blackLevel = 0;
    optical.whiteLevel = separation;
    optical.separation = separation;
    optical.noise = correctionBurden * Math.max(18, separation * 0.3);
    optical.clipping = 0;
    optical.banding = 0;
    optical.temporalContamination = 0;
    optical.tiles = metrics.finderLevelTracks;
    optical.sampledModules = metrics.finderLevelTracks * 147;
    optical.correctionBurden = correctionBurden;
    metrics.optical = optical;`,
  "worker reusable optical metrics"
);
worker = replaceOnce(
  worker,
`  view = new DataView(zx.HEAPU8.buffer, guidedResultsPtr, count * GUIDED_RESULT_BYTES);
  const symbols = guidedSymbolsScratch;
  const wallMotionSamples = guidedWallMotionScratch;
  symbols.length = 0;
  wallMotionSamples.length = 0;`,
`  const symbols = guidedSymbolsScratch;
  symbols.length = 0;
  guidedMotion.reset();`,
  "worker guided result scratch"
);
worker = replaceOnce(
  worker,
`    const base = i * GUIDED_RESULT_BYTES;
    const status = view.getInt32(base + 4, true);
    if (status !== DIRECT_TRACK_OK && status !== GUIDED_TRACK_PREDICTED) continue;
    const outputOffset = view.getInt32(base + 8, true);
    const outputLength = view.getInt32(base + 12, true);
    const modules = view.getInt32(base + 16, true);`,
`    const base = i * GUIDED_RESULT_WORDS;
    const status = guidedResultsI32[base + 1];
    if (status !== DIRECT_TRACK_OK && status !== GUIDED_TRACK_PREDICTED) continue;
    const outputOffset = guidedResultsI32[base + 2];
    const outputLength = guidedResultsI32[base + 3];
    const modules = guidedResultsI32[base + 4];`,
  "worker typed result header"
);
worker = replaceOnce(
  worker,
`    const packet = parseVerifiedFrame(bytes);`,
`    const packetScratch = guidedPacketAt(i);
    const packet = parseVerifiedFrameInto(bytes, packetScratch, packetScratch.header);`,
  "worker parser reuse"
);
worker = replaceBetween(
  worker,
`    const quad = {
      topLeft: { x: view.getFloat32(base + 20, true), y: view.getFloat32(base + 24, true) },`,
`    const symbolIndex = symbols.length;`,
`    const lx0 = guidedResultsF32[base + 5], ly0 = guidedResultsF32[base + 6];
    const lx1 = guidedResultsF32[base + 7], ly1 = guidedResultsF32[base + 8];
    const lx2 = guidedResultsF32[base + 9], ly2 = guidedResultsF32[base + 10];
    const lx3 = guidedResultsF32[base + 11], ly3 = guidedResultsF32[base + 12];
    if (!Number.isFinite(lx0) || !Number.isFinite(ly0) || !Number.isFinite(lx1) || !Number.isFinite(ly1) ||
        !Number.isFinite(lx2) || !Number.isFinite(ly2) || !Number.isFinite(lx3) || !Number.isFinite(ly3)) continue;
    const ax0 = lx0 + ox, ay0 = ly0 + oy;
    const ax1 = lx1 + ox, ay1 = ly1 + oy;
    const ax2 = lx2 + ox, ay2 = ly2 + oy;
    const ax3 = lx3 + ox, ay3 = ly3 + oy;
    const geometryMeasured = status === DIRECT_TRACK_OK;
    const input = trackIndex >= 0 ? tracks[trackIndex] : void 0;
    if (input?.quad && validQuad(input.quad)) {
      const iq = input.quad;
      const dx = ((ax0 - iq.topLeft.x) + (ax1 - iq.topRight.x) +
        (ax2 - iq.bottomRight.x) + (ax3 - iq.bottomLeft.x)) * 0.25;
      const dy = ((ay0 - iq.topLeft.y) + (ay1 - iq.topRight.y) +
        (ay2 - iq.bottomRight.y) + (ay3 - iq.bottomLeft.y)) * 0.25;
      if (Number.isFinite(dx) && Number.isFinite(dy) && Math.hypot(dx, dy) <= 5.1) {
        const x = (iq.topLeft.x + iq.topRight.x + iq.bottomRight.x + iq.bottomLeft.x) * 0.25;
        const y = (iq.topLeft.y + iq.topRight.y + iq.bottomRight.y + iq.bottomLeft.y) * 0.25;
        const edge = (Math.hypot(iq.topRight.x - iq.topLeft.x, iq.topRight.y - iq.topLeft.y) +
          Math.hypot(iq.bottomRight.x - iq.topRight.x, iq.bottomRight.y - iq.topRight.y) +
          Math.hypot(iq.bottomLeft.x - iq.bottomRight.x, iq.bottomLeft.y - iq.bottomRight.y) +
          Math.hypot(iq.topLeft.x - iq.bottomLeft.x, iq.topLeft.y - iq.bottomLeft.y)) * 0.25;
        guidedMotion.add(dx, dy, x, y, edge);
      }
    }
    // Predicted CRC-valid hits are payload/motion evidence, not independent
    // geometry measurements. Do not build six short-lived geometry objects for
    // every one of them; only authoritative measured results cross that path.
    let outputQuad;
    let box;
    if (geometryMeasured) {
      outputQuad = {
        topLeft: { x: ax0, y: ay0 },
        topRight: { x: ax1, y: ay1 },
        bottomRight: { x: ax2, y: ay2 },
        bottomLeft: { x: ax3, y: ay3 }
      };
      const minX = Math.min(ax0, ax1, ax2, ax3);
      const minY = Math.min(ay0, ay1, ay2, ay3);
      box = {
        x: minX,
        y: minY,
        w: Math.max(ax0, ax1, ax2, ax3) - minX,
        h: Math.max(ay0, ay1, ay2, ay3) - minY
      };
    }
`,
  "worker measured-only geometry"
);
worker = replaceOnce(
  worker,
`    symbols.push({
      bytes: null,
      box: boundsOf(quad, ox, oy),
      quad: outputQuad,
      modules,
      tracked: true,
      geometryMeasured,
      decodePath,
      crc32: true,
      verifiedPayload: true,
      header: packet.header
    });`,
`    const symbol = guidedSymbolAt(symbolIndex);
    symbol.bytes = null;
    symbol.box = box;
    symbol.quad = outputQuad;
    symbol.modules = modules;
    symbol.tracked = true;
    symbol.geometryMeasured = geometryMeasured;
    symbol.decodePath = decodePath;
    symbol.crc32 = true;
    symbol.verifiedPayload = true;
    symbol.header = packet.header;
    symbol.wallMotion = undefined;
    symbols.push(symbol);`,
  "worker symbol pool"
);
worker = replaceBetween(
  worker,
`  // Full independently measured finder geometry remains absolute authority.`,
`  return { symbols, metrics, outputBuffer: output.buffer };`,
`  const wallMotion = guidedMotion.fit();
  if (wallMotion) {
    for (const symbol of symbols) symbol.wallMotion = wallMotion;
  }
`,
  "worker allocation-light motion"
);
worker = replaceOnce(
  worker,
`function quadShapeResidual(a, b) {
  if (!validQuad(a) || !validQuad(b)) return Infinity;
  const names = ["topLeft", "topRight", "bottomRight", "bottomLeft"];
  const deltas = names.map((name) => ({
    x: b[name].x - a[name].x,
    y: b[name].y - a[name].y
  }));
  const meanX = deltas.reduce((sum, p) => sum + p.x, 0) / deltas.length;
  const meanY = deltas.reduce((sum, p) => sum + p.y, 0) / deltas.length;
  return Math.max(...deltas.map((p) => Math.hypot(p.x - meanX, p.y - meanY)));
}
function quadModuleSize(q, dim) {
  if (!validQuad(q) || !dim) return 0;
  const edge = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  return Math.min(
    edge(q.topLeft, q.topRight),
    edge(q.topRight, q.bottomRight),
    edge(q.bottomRight, q.bottomLeft),
    edge(q.bottomLeft, q.topLeft)
  ) / dim;
}`,
`function quadShapeResidual(a, b) {
  if (!validQuad(a) || !validQuad(b)) return Infinity;
  const dx0 = b.topLeft.x - a.topLeft.x, dy0 = b.topLeft.y - a.topLeft.y;
  const dx1 = b.topRight.x - a.topRight.x, dy1 = b.topRight.y - a.topRight.y;
  const dx2 = b.bottomRight.x - a.bottomRight.x, dy2 = b.bottomRight.y - a.bottomRight.y;
  const dx3 = b.bottomLeft.x - a.bottomLeft.x, dy3 = b.bottomLeft.y - a.bottomLeft.y;
  const meanX = (dx0 + dx1 + dx2 + dx3) * 0.25;
  const meanY = (dy0 + dy1 + dy2 + dy3) * 0.25;
  return Math.max(
    Math.hypot(dx0 - meanX, dy0 - meanY),
    Math.hypot(dx1 - meanX, dy1 - meanY),
    Math.hypot(dx2 - meanX, dy2 - meanY),
    Math.hypot(dx3 - meanX, dy3 - meanY)
  );
}
function quadModuleSize(q, dim) {
  if (!validQuad(q) || !dim) return 0;
  return Math.min(
    Math.hypot(q.topLeft.x - q.topRight.x, q.topLeft.y - q.topRight.y),
    Math.hypot(q.topRight.x - q.bottomRight.x, q.topRight.y - q.bottomRight.y),
    Math.hypot(q.bottomRight.x - q.bottomLeft.x, q.bottomRight.y - q.bottomLeft.y),
    Math.hypot(q.bottomLeft.x - q.topLeft.x, q.bottomLeft.y - q.topLeft.y)
  ) / dim;
}`,
  "worker quad scalar math"
);
worker = replaceOnce(
  worker,
`      const rect = { x: cropX, y: cropY, width: w, height: h };
      const copyAsRgba = pixelFormat !== "y8";
      const copyOptions = copyAsRgba ? { rect, format: "RGBA" } : { rect };`,
`      videoCopyRect.x = cropX;
      videoCopyRect.y = cropY;
      videoCopyRect.width = w;
      videoCopyRect.height = h;
      const copyAsRgba = pixelFormat !== "y8";
      const copyOptions = copyAsRgba ? videoCopyRgbaOptions : videoCopyYOptions;`,
  "worker VideoFrame copy options"
);
worker = replaceOnce(
  worker,
`    const symbols = [];
    const sightings = [];`,
`    const symbols = workerSymbolsScratch;
    const sightings = workerSightingsScratch;
    symbols.length = 0;
    sightings.length = 0;`,
  "worker outer result arrays"
);
write("receive/worker.js", worker);

// ---------------------------------------------------------------------------
// receive/runtime.js — allocation-free temporal planner + no per-QR info clone.
// ---------------------------------------------------------------------------
let runtime = read("receive/runtime.js");
runtime = replaceOnce(
  runtime,
`const autoWorkerLatencies = [];`,
`const AUTO_WORKER_LATENCY_SAMPLES = 40;
const autoWorkerLatencies = new Float64Array(AUTO_WORKER_LATENCY_SAMPLES);
const autoWorkerLatencySortScratch = new Float64Array(AUTO_WORKER_LATENCY_SAMPLES);
let autoWorkerLatencyCount = 0;
let autoWorkerLatencyCursor = 0;`,
  "runtime auto-worker latency scratch"
);
runtime = replaceOnce(
  runtime,
`  if (Number.isFinite(latency) && latency > 0 && latency < 10e3) {
    autoWorkerLatencies.push(latency);
    if (autoWorkerLatencies.length > 40) autoWorkerLatencies.shift();
  }
  const now = receiverNow();
  if (now - autoWorkerLastUpdate < 750 || autoWorkerLatencies.length < 5) return;
  autoWorkerLastUpdate = now;
  const sorted = [...autoWorkerLatencies].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];`,
`  if (Number.isFinite(latency) && latency > 0 && latency < 10e3) {
    autoWorkerLatencies[autoWorkerLatencyCursor] = latency;
    autoWorkerLatencyCursor = (autoWorkerLatencyCursor + 1) % AUTO_WORKER_LATENCY_SAMPLES;
    autoWorkerLatencyCount = Math.min(AUTO_WORKER_LATENCY_SAMPLES, autoWorkerLatencyCount + 1);
  }
  const now = receiverNow();
  if (now - autoWorkerLastUpdate < 750 || autoWorkerLatencyCount < 5) return;
  autoWorkerLastUpdate = now;
  for (let index = 0; index < autoWorkerLatencyCount; index++)
    autoWorkerLatencySortScratch[index] = autoWorkerLatencies[index];
  for (let index = 1; index < autoWorkerLatencyCount; index++) {
    const value = autoWorkerLatencySortScratch[index];
    let at = index;
    while (at > 0 && autoWorkerLatencySortScratch[at - 1] > value) {
      autoWorkerLatencySortScratch[at] = autoWorkerLatencySortScratch[at - 1];
      at--;
    }
    autoWorkerLatencySortScratch[at] = value;
  }
  const p50 = autoWorkerLatencySortScratch[Math.floor(autoWorkerLatencyCount * 0.5)];
  const p95 = autoWorkerLatencySortScratch[Math.min(autoWorkerLatencyCount - 1, Math.floor(autoWorkerLatencyCount * 0.95))];`,
  "runtime auto-worker latency ring"
);
runtime = replaceBetween(
  runtime,
`function predictedTemporalBand(sourceSequence, now = receiverNow()) {`,
`function temporalBandRiskForRegion(region, index, sourceSequence, now, model) {`,
`const predictedTemporalBandScratch = {
  axis: "", normalX: 0, normalY: 0, position: 0, velocity: 0,
  width: 0, span: 0, confidence: 0
};
function predictedTemporalBand(sourceSequence, now = receiverNow()) {
  if (!temporalBandModel.axis || !(temporalBandModel.span > 0)) return null;
  const age = Math.max(0, now - temporalBandModel.updatedAt);
  if (age > TEMPORAL_MODEL_FRESH_MS) return null;
  const frames = Number.isFinite(sourceSequence) && temporalBandModel.sourceSequence >= 0
    ? Math.max(0, Math.min(8, sourceSequence - temporalBandModel.sourceSequence))
    : 0;
  const confidence = temporalBandModel.confidence * Math.exp(-age / 700) * Math.exp(-Math.max(0, frames - 2) * 0.16);
  const model = predictedTemporalBandScratch;
  model.axis = temporalBandModel.axis;
  model.normalX = temporalBandModel.normalX;
  model.normalY = temporalBandModel.normalY;
  model.position = temporalBandModel.position + temporalBandModel.velocity * frames;
  model.velocity = temporalBandModel.velocity;
  model.width = temporalBandModel.width + Math.min(temporalBandModel.width, Math.abs(temporalBandModel.velocity) * frames * 0.45);
  model.span = temporalBandModel.span;
  model.confidence = confidence;
  return model;
}
`,
  "runtime temporal model scratch"
);
runtime = replaceBetween(
  runtime,
`function temporalBandRiskForRegion(region, index, sourceSequence, now, model) {`,
`function temporalBandRiskForSlot(slot, sourceSequence, now = receiverNow()) {`,
`function temporalBandRiskForRegion(region, index, sourceSequence, now, model) {
  const sequence = Number(sourceSequence);
  if (Number.isFinite(sequence) && sequence <= temporalCleanThroughSource[index]) return 0;
  const legacyRisk = temporalBandAvoidUntil[index] > now ? 0.98 : 0;
  const quad = region?.quad;
  if (!model || !quad || model.confidence < 0.08) return legacyRisk;
  const centerX = (quad.topLeft.x + quad.topRight.x + quad.bottomRight.x + quad.bottomLeft.x) * 0.25;
  const centerY = (quad.topLeft.y + quad.topRight.y + quad.bottomRight.y + quad.bottomLeft.y) * 0.25;
  const coordinate = centerX * model.normalX + centerY * model.normalY;
  const radius = Math.max(4, model.width * 0.62);
  const modeled = model.confidence * Math.exp(-0.5 * ((coordinate - model.position) / radius) ** 2);
  const fallback = legacyRisk * legacyTemporalRiskWeight(model.confidence);
  return Math.max(fallback, Math.min(1, modeled));
}
`,
  "runtime scalar temporal risk"
);
runtime = replaceOnce(
  runtime,
`  const region = regions.find((item) => Number(item.gridSlot) === index);
  return temporalBandRiskForRegion(region, index, sourceSequence, now, model);`,
`  const region = gridRegionBySlot(index);
  return temporalBandRiskForRegion(region, index, sourceSequence, now, model);`,
  "runtime temporal slot lookup"
);
runtime = replaceBetween(
  runtime,
`function temporalScheduleForSource(sourceSequence, now = receiverNow(), probeCandidates) {`,
`function temporalPredictionSnapshot(tracks, sourceSequence, now = receiverNow()) {`,
`const temporalScheduleRisks = new Float32Array(SLOT_METRIC_COUNT);
const temporalScheduleVisible = [];
const temporalScheduleRisky = [];
const temporalScheduleResult = {
  sequence: -1,
  model: null,
  risks: temporalScheduleRisks,
  cleanCount: 0,
  hardSkipEnabled: false,
  probeSlot: -1
};
function temporalScheduleForSource(sourceSequence, now = receiverNow(), probeCandidates) {
  const sequence = Number(sourceSequence);
  const model = predictedTemporalBand(sequence, now);
  const risks = temporalScheduleRisks;
  const visible = temporalScheduleVisible;
  const risky = temporalScheduleRisky;
  risks.fill(0);
  visible.length = 0;
  risky.length = 0;
  let cleanCount = 0;
  for (const region of regions) {
    const slot = Number(region.gridSlot);
    if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_METRIC_COUNT || region.slotState === "OFFSCREEN") continue;
    const risk = temporalBandRiskForRegion(region, slot, sequence, now, model);
    risks[slot] = risk;
    visible.push(region);
    if (risk < TEMPORAL_MODEL_RISK_THRESHOLD) cleanCount++;
  }
  const riskMissRate = temporalPredictionRiskAttempts
    ? temporalPredictionRiskMisses / temporalPredictionRiskAttempts
    : 0;
  const safeMissRate = temporalPredictionSafeAttempts
    ? temporalPredictionSafeMisses / temporalPredictionSafeAttempts
    : 0;
  const validated = temporalPredictionRiskAttempts >= 12 && temporalPredictionSafeAttempts >= 12 &&
    riskMissRate >= 0.70 && riskMissRate - safeMissRate >= 0.25;
  const riskSource = probeCandidates ?? visible;
  for (let index = 0; index < riskSource.length; index++) {
    const region = riskSource[index];
    if (risks[Number(region.gridSlot)] >= 0.65) risky.push(region);
  }
  if (risky.length > 1) risky.sort((a, b) => Number(a.gridSlot) - Number(b.gridSlot));
  const hardSkipEnabled = Boolean(model && model.confidence >= 0.72 && validated && cleanCount >= 4 && risky.length);
  const probeSlot = hardSkipEnabled
    ? Number(risky[temporalProbeCursor % risky.length].gridSlot)
    : -1;
  const result = temporalScheduleResult;
  result.sequence = sequence;
  result.model = model;
  result.cleanCount = cleanCount;
  result.hardSkipEnabled = hardSkipEnabled;
  result.probeSlot = probeSlot;
  return result;
}
`,
  "runtime temporal scheduler scratch"
);
runtime = replaceOnce(
  runtime,
`function onDecoded(bytes, box, info) {`,
`const VERIFIED_GEOMETRY_INFO = { crc32: true };
function gridRegionBySlot(slot) {
  const target = Number(slot);
  for (let index = 0; index < regions.length; index++) {
    if (Number(regions[index].gridSlot) === target) return regions[index];
  }
  return undefined;
}
function onDecoded(bytes, box, info) {`,
  "runtime verified info helpers"
);
runtime = replaceOnce(
  runtime,
`    const geometryInfo = { ...info, crc32: true };`,
`    const geometryInfo = info ?? VERIFIED_GEOMETRY_INFO;
    geometryInfo.crc32 = true;`,
  "runtime remove per-QR info clone"
);
runtime = replaceOnce(
  runtime,
`        regions.find((region) => region.gridSlot === header.slotIndex),`,
`        gridRegionBySlot(header.slotIndex),`,
  "runtime decoded slot lookup"
);
write("receive/runtime.js", runtime);

// ---------------------------------------------------------------------------
// C++ Guided batch scratch — retain capacities per WASM worker.
// ---------------------------------------------------------------------------
let cpp = read("codec/source/wrapper/airgapper_codec.cpp");
cpp = replaceOnce(
  cpp,
`        std::vector<uint8_t> completed(trackCount, 0);`,
`        thread_local std::vector<uint8_t> completed;
        completed.resize(trackCount);
        std::fill(completed.begin(), completed.end(), uint8_t{0});`,
  "codec completed scratch"
);
cpp = replaceOnce(
  cpp,
`        std::vector<uint8_t> refreshTurboFromSparse(trackCount, 0);
        std::vector<uint8_t> deferredStableGateFailure(trackCount, 0);
        int repairTracksSpent = 0;
        constexpr int GUIDED_MAX_REPAIR_TRACKS_PER_BATCH = 2;
        std::vector<std::optional<TurboFrameTransform>> frameTransforms(trackCount);
        std::vector<std::optional<TurboLevels>> frameLevels(trackCount);`,
`        thread_local std::vector<uint8_t> refreshTurboFromSparse;
        thread_local std::vector<uint8_t> deferredStableGateFailure;
        thread_local std::vector<std::optional<TurboFrameTransform>> frameTransforms;
        thread_local std::vector<std::optional<TurboLevels>> frameLevels;
        refreshTurboFromSparse.resize(trackCount);
        deferredStableGateFailure.resize(trackCount);
        std::fill(refreshTurboFromSparse.begin(), refreshTurboFromSparse.end(), uint8_t{0});
        std::fill(deferredStableGateFailure.begin(), deferredStableGateFailure.end(), uint8_t{0});
        frameTransforms.resize(trackCount);
        frameLevels.resize(trackCount);
        for (auto& item : frameTransforms) item.reset();
        for (auto& item : frameLevels) item.reset();
        int repairTracksSpent = 0;
        constexpr int GUIDED_MAX_REPAIR_TRACKS_PER_BATCH = 2;`,
  "codec guided batch scratch"
);
write("codec/source/wrapper/airgapper_codec.cpp", cpp);

// ---------------------------------------------------------------------------
// Regression: parseVerifiedFrameInto must be field-identical and object-reusing.
// ---------------------------------------------------------------------------
write("benchmark/protocol-parse-reuse-smoke.mjs", `import { packFrame, parseVerifiedFrame, parseVerifiedFrameInto } from "../shared/protocol.js";

function check(name, header, block) {
  const bytes = packFrame(header, block);
  const expected = parseVerifiedFrame(bytes);
  if (!expected) throw new Error(\`${name}: reference parse failed\`);
  const reusable = { header: {} };
  const first = parseVerifiedFrameInto(bytes, reusable, reusable.header);
  if (first !== reusable || first.header !== reusable.header)
    throw new Error(\`${name}: parser did not reuse caller records\`);
  if (first.block !== undefined) throw new Error(\`${name}: metadata-only parser allocated/exposed block\`);
  for (const key of ["mode", "seq", "layoutId", "extendedGrid", "gridCols", "gridRows", "slotIndex", "k", "blockLen", "totalLen", "payloadId"]) {
    if (first.header[key] !== expected.header[key])
      throw new Error(\`${name}: ${key} mismatch ${first.header[key]} != ${expected.header[key]}\`);
  }
  const second = parseVerifiedFrameInto(bytes, reusable, reusable.header);
  if (second !== reusable || second.header !== reusable.header)
    throw new Error(\`${name}: second parse lost object identity\`);
}

const directBlock = new Uint8Array(24).fill(7);
check("direct", {
  mode: "direct", seq: 0, layoutId: 0, slotIndex: 0,
  k: 1, blockLen: 24, totalLen: 24, payloadId: 0x12345678
}, directBlock);

const mdsBlock = new Uint8Array(16).fill(11);
check("mds", {
  mode: "mds", seq: 1, layoutId: 0, extendedGrid: true,
  gridCols: 4, gridRows: 4, slotIndex: 7,
  k: 2, blockLen: 16, totalLen: 32, payloadId: 0x89abcdef
}, mdsBlock);

const raptorBlock = new Uint8Array(14).fill(19);
raptorBlock.set([0, 0, 1, 35], 0);
check("raptorq", {
  mode: "raptorq", seq: 0, layoutId: 0, extendedGrid: true,
  gridCols: 7, gridRows: 4, slotIndex: 17,
  k: 33, blockLen: 14, totalLen: 330, payloadId: 0x13579bdf
}, raptorBlock);

console.log("AIRGAPPER_PROTOCOL_PARSE_REUSE_PASS");
`);

// Keep the final regression permanent; the temporary patcher itself is removed
// after the generated commits land.
let workflow = read(".github/workflows/fast-regression.yml");
if (!workflow.includes("benchmark/protocol-parse-reuse-smoke.mjs")) {
  workflow = replaceOnce(
    workflow,
    "          node --input-type=module --check < benchmark/guided-motion-smoke.mjs\n",
    "          node --input-type=module --check < benchmark/guided-motion-smoke.mjs\n          node --input-type=module --check < benchmark/protocol-parse-reuse-smoke.mjs\n",
    "workflow parser syntax smoke"
  );
  workflow = replaceOnce(
    workflow,
    "          node benchmark/guided-motion-smoke.mjs\n",
    "          node benchmark/guided-motion-smoke.mjs\n          node benchmark/protocol-parse-reuse-smoke.mjs\n",
    "workflow parser runtime smoke"
  );
}
write(".github/workflows/fast-regression.yml", workflow);

console.log("AIRGAPPER_FINAL_HOTPATH_PATCH_APPLIED");
