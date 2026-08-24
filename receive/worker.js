import { parseFrame, parseVerifiedFrame } from "../shared/protocol.js";
import { gridLayoutById } from "../shared/grid-layout.js";
const scalarCodec = new URL(import.meta.url).searchParams.has("scalar");
const ready = import(scalarCodec ? "../codec/scalar/airgapper_codec.js" : "../codec/airgapper_codec.js").then(({ default: AirGapperCodec }) => AirGapperCodec());
const ctx = self;
function validPoint(point) {
  return Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y));
}
function validQuad(p) {
  return Boolean(p && validPoint(p.topLeft) && validPoint(p.topRight) &&
    validPoint(p.bottomRight) && validPoint(p.bottomLeft));
}
function boundsOf(p, ox, oy) {
  if (!validQuad(p)) return null;
  const minX = Math.min(p.topLeft.x, p.topRight.x, p.bottomRight.x, p.bottomLeft.x);
  const minY = Math.min(p.topLeft.y, p.topRight.y, p.bottomRight.y, p.bottomLeft.y);
  const maxX = Math.max(p.topLeft.x, p.topRight.x, p.bottomRight.x, p.bottomLeft.x);
  const maxY = Math.max(p.topLeft.y, p.topRight.y, p.bottomRight.y, p.bottomLeft.y);
  return { x: ox + minX, y: oy + minY, w: maxX - minX, h: maxY - minY };
}
function shifted(p, ox, oy) {
  if (!validQuad(p)) return null;
  return {
    topLeft: { x: p.topLeft.x + ox, y: p.topLeft.y + oy },
    topRight: { x: p.topRight.x + ox, y: p.topRight.y + oy },
    bottomRight: { x: p.bottomRight.x + ox, y: p.bottomRight.y + oy },
    bottomLeft: { x: p.bottomLeft.x + ox, y: p.bottomLeft.y + oy }
  };
}
let inputPtr = 0;
let inputCapacity = 0;
function inputBuffer(zx, bytes) {
  if (inputPtr && bytes <= inputCapacity) return inputPtr;
  const next = zx._malloc(bytes);
  if (!next) return 0;
  if (inputPtr) zx._free(inputPtr);
  inputPtr = next;
  inputCapacity = bytes;
  return inputPtr;
}
const DIRECT_BATCH_MAX_TRACKS = 32;
const GUIDED_BATCH_MAX_TRACKS = 128;
const ROBUST_BATCH_MAX_RESULTS = 8;
const DIRECT_TRACK_RESULT_BYTES = 32;
const DIRECT_BATCH_METRICS_BYTES = 128;
const DIRECT_BATCH_OUTPUT_BYTES = 128 * 1024;
const DIRECT_TRACK_OK = 1;
const GUIDED_TRACK_PREDICTED = 3;
const GUIDED_TRACK_BYTES = 40;
const GUIDED_RESULT_BYTES = 52;
const GUIDED_METRICS_BYTES = 216;
const GUIDED_OUTPUT_BYTES = 512 * 1024;
let guidedTracksPtr = 0;
let guidedResultsPtr = 0;
let guidedMetricsPtr = 0;
let guidedOutputPtr = 0;
let directBatchHandle = 0;
let directResultsPtr = 0;
let directOutputPtr = 0;
let directMetricsPtr = 0;
let directConfigured = [];
let directCropX = NaN;
let directCropY = NaN;
const directRefresh = /* @__PURE__ */ new Set();
function ensureGuidedBatch(zx) {
  if (!guidedTracksPtr) guidedTracksPtr = zx._malloc(GUIDED_BATCH_MAX_TRACKS * GUIDED_TRACK_BYTES);
  if (!guidedResultsPtr) guidedResultsPtr = zx._malloc(GUIDED_BATCH_MAX_TRACKS * GUIDED_RESULT_BYTES);
  if (!guidedMetricsPtr) guidedMetricsPtr = zx._malloc(GUIDED_METRICS_BYTES);
  if (!guidedOutputPtr) guidedOutputPtr = zx._malloc(GUIDED_OUTPUT_BYTES);
  return Boolean(guidedTracksPtr && guidedResultsPtr && guidedMetricsPtr && guidedOutputPtr);
}
function decodeGuidedBatch(zx, yPtr, width, height, stride, ox, oy, tracks, fallbackAllowedMask = 0xffffffff, repairAllowedMask = 0xffffffff) {
  if (!ensureGuidedBatch(zx) || !tracks.length || tracks.length > GUIDED_BATCH_MAX_TRACKS) return null;
  let view = new DataView(zx.HEAPU8.buffer, guidedTracksPtr, tracks.length * GUIDED_TRACK_BYTES);
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    if (!validQuad(track.quad) || !track.dim) return null;
    const base = i * GUIDED_TRACK_BYTES;
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
    view.setFloat32(base + 36, q.bottomLeft.y - oy, true);
  }
  const count = zx._decodeGuidedBatchY(
    yPtr, width, height, stride,
    guidedTracksPtr, tracks.length,
    guidedResultsPtr, GUIDED_BATCH_MAX_TRACKS,
    guidedOutputPtr, GUIDED_OUTPUT_BYTES,
    tracks.length, fallbackAllowedMask >>> 0, repairAllowedMask >>> 0, guidedMetricsPtr
  );
  const metricsView = new DataView(zx.HEAPU8.buffer, guidedMetricsPtr, GUIDED_METRICS_BYTES);
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
  };
  if (metrics.finderLevelTracks) {
    const finderConfidence = Math.max(0, Math.min(1,
      metrics.finderLevelMatches / (metrics.finderLevelTracks * 147)));
    const separation = metrics.finderLevelSeparation / metrics.finderLevelTracks;
    const correctionBurden = Math.min(1, (
      metrics.sparseRsFallbacks + metrics.erasureRsAttempts + metrics.erasureRepairCodewords / 256
    ) / Math.max(1, metrics.tracks));
    metrics.optical = {
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
    };
  }
  let moduleSizeMin = Infinity, moduleSizeMax = 0, moduleSizeSum = 0, moduleSizeCount = 0;
  for (const track of tracks) {
    const value = quadModuleSize(track.quad, track.dim);
    if (!(value > 0) || !Number.isFinite(value)) continue;
    moduleSizeMin = Math.min(moduleSizeMin, value);
    moduleSizeMax = Math.max(moduleSizeMax, value);
    moduleSizeSum += value;
    moduleSizeCount++;
  }
  metrics.moduleSizeMin = moduleSizeCount ? moduleSizeMin : 0;
  metrics.moduleSizeMax = moduleSizeCount ? moduleSizeMax : 0;
  metrics.moduleSizeAvg = moduleSizeCount ? moduleSizeSum / moduleSizeCount : 0;
  if (count < 0) return { symbols: [], metrics, error: "guided decode failed" };
  view = new DataView(zx.HEAPU8.buffer, guidedResultsPtr, count * GUIDED_RESULT_BYTES);
  const symbols = [];
  const trackIndexBySlot = new Map();
  for (let index = 0; index < tracks.length; index++) {
    const slot = Number(tracks[index].slot ?? tracks[index].id);
    if (Number.isInteger(slot) && slot >= 0) trackIndexBySlot.set(slot, index);
  }
  const decodedSlots = new Set();
  const wallMotionSamples = [];
  const pendingSymbols = [];
  let outputEnd = 0;
  for (let i = 0; i < count; i++) {
    const base = i * GUIDED_RESULT_BYTES;
    const status = view.getInt32(base + 4, true);
    if (status !== DIRECT_TRACK_OK && status !== GUIDED_TRACK_PREDICTED) continue;
    const outputOffset = view.getInt32(base + 8, true);
    const outputLength = view.getInt32(base + 12, true);
    const modules = view.getInt32(base + 16, true);
    if (outputOffset < 0 || outputLength <= 0 || outputOffset + outputLength > GUIDED_OUTPUT_BYTES) continue;
    const bytes = zx.HEAPU8.subarray(guidedOutputPtr + outputOffset, guidedOutputPtr + outputOffset + outputLength);
    // Guided accepts only after C++ has checked the AirGapper CRC. Parse the
    // verified payload without hashing it again in JavaScript.
    const packet = parseVerifiedFrame(bytes);
    const slot = packet?.header.slotIndex;
    if (!packet || !Number.isInteger(slot) || slot < 0) continue;
    if (trackIndexBySlot.size && !trackIndexBySlot.has(slot) || decodedSlots.has(slot)) continue;
    decodedSlots.add(slot);
    const trackIndex = trackIndexBySlot.get(slot);
    const slotBit = Number.isInteger(trackIndex) && trackIndex >= 0 && trackIndex < 32
      ? (1 << trackIndex) >>> 0
      : 0;
    const decodePath = slotBit && (metrics.fallbackSuccessMask & slotBit)
      ? "fallback"
      : slotBit && (metrics.sparseSuccessMask & slotBit)
        ? "sparse"
        : "hot";
    const quad = {
      topLeft: { x: view.getFloat32(base + 20, true), y: view.getFloat32(base + 24, true) },
      topRight: { x: view.getFloat32(base + 28, true), y: view.getFloat32(base + 32, true) },
      bottomRight: { x: view.getFloat32(base + 36, true), y: view.getFloat32(base + 40, true) },
      bottomLeft: { x: view.getFloat32(base + 44, true), y: view.getFloat32(base + 48, true) }
    };
    if (!validQuad(quad)) continue;
    const outputQuad = shifted(quad, ox, oy);
    const geometryMeasured = status === DIRECT_TRACK_OK;
    const input = Number.isInteger(trackIndex) ? tracks[trackIndex] : void 0;
    if (input?.quad && validQuad(input.quad)) {
      const iq = input.quad, oq = outputQuad;
      const dx = ((oq.topLeft.x - iq.topLeft.x) + (oq.topRight.x - iq.topRight.x) +
        (oq.bottomRight.x - iq.bottomRight.x) + (oq.bottomLeft.x - iq.bottomLeft.x)) * 0.25;
      const dy = ((oq.topLeft.y - iq.topLeft.y) + (oq.topRight.y - iq.topRight.y) +
        (oq.bottomRight.y - iq.bottomRight.y) + (oq.bottomLeft.y - iq.bottomLeft.y)) * 0.25;
      if (Number.isFinite(dx) && Number.isFinite(dy) && Math.hypot(dx, dy) <= 5.1) {
        const x = (iq.topLeft.x + iq.topRight.x + iq.bottomRight.x + iq.bottomLeft.x) * 0.25;
        const y = (iq.topLeft.y + iq.topRight.y + iq.bottomRight.y + iq.bottomLeft.y) * 0.25;
        const edge = (Math.hypot(iq.topRight.x - iq.topLeft.x, iq.topRight.y - iq.topLeft.y) +
          Math.hypot(iq.bottomRight.x - iq.topRight.x, iq.bottomRight.y - iq.topRight.y) +
          Math.hypot(iq.bottomLeft.x - iq.bottomRight.x, iq.bottomLeft.y - iq.bottomRight.y) +
          Math.hypot(iq.topLeft.x - iq.bottomLeft.x, iq.topLeft.y - iq.bottomLeft.y)) * 0.25;
        wallMotionSamples.push({ dx, dy, x, y, edge, slot, measured: geometryMeasured });
      }
    }
    outputEnd = Math.max(outputEnd, outputOffset + outputLength);
    pendingSymbols.push({
      outputOffset,
      outputLength,
      box: boundsOf(quad, ox, oy),
      quad: outputQuad,
      modules,
      tracked: true,
      geometryMeasured,
      decodePath,
      crc32: true,
      verifiedPayload: true,
      header: packet.header
    });
  }
  const output = outputEnd ? zx.HEAPU8.slice(guidedOutputPtr, guidedOutputPtr + outputEnd) : new Uint8Array(0);
  for (const pending of pendingSymbols) symbols.push({
    bytes: output.subarray(pending.outputOffset, pending.outputOffset + pending.outputLength),
    box: pending.box,
    quad: pending.quad,
    modules: pending.modules,
    tracked: pending.tracked,
    geometryMeasured: pending.geometryMeasured,
    decodePath: pending.decodePath,
    crc32: pending.crc32,
    verifiedPayload: pending.verifiedPayload,
    header: pending.header
  });
  // Full independently measured finder geometry remains absolute authority.
  // Otherwise the Turbo/Stable-RS CRC oracle gives us something almost as
  // valuable every frame: each successful predicted QR says "the wall is this
  // many pixels away HERE". Pure camera translation makes those residuals equal;
  // rotation/scale makes them vary smoothly with position. Fit that residual
  // field as a tiny similarity transform instead of rejecting it as incoherent.
  if (wallMotionSamples.length === 1) {
    const item = wallMotionSamples[0];
    const shift = Math.hypot(item.dx, item.dy);
    if (shift >= 0.08 && shift <= 4.5) {
      const wallMotion = {
        kind: "translation",
        a: 1, b: 0, tx: item.dx, ty: item.dy,
        dx: item.dx, dy: item.dy,
        samples: 1,
        residual: 0,
        maxShift: shift
      };
      for (const symbol of symbols) symbol.wallMotion = wallMotion;
    }
  }
  if (wallMotionSamples.length >= 2) {
    const median = (values) => {
      const sorted = [...values].sort((a, b) => a - b);
      const mid = sorted.length >> 1;
      return sorted.length & 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };
    const residualFor = (motion, item) => {
      const px = motion.a * item.x - motion.b * item.y + motion.tx;
      const py = motion.b * item.x + motion.a * item.y + motion.ty;
      return Math.hypot(px - (item.x + item.dx), py - (item.y + item.dy));
    };
    const refit = (items) => {
      const meanX = items.reduce((sum, item) => sum + item.x, 0) / items.length;
      const meanY = items.reduce((sum, item) => sum + item.y, 0) / items.length;
      const meanQx = items.reduce((sum, item) => sum + item.x + item.dx, 0) / items.length;
      const meanQy = items.reduce((sum, item) => sum + item.y + item.dy, 0) / items.length;
      let denom = 0, real = 0, imag = 0;
      for (const item of items) {
        const px = item.x - meanX, py = item.y - meanY;
        const qx = item.x + item.dx - meanQx, qy = item.y + item.dy - meanQy;
        denom += px * px + py * py;
        real += px * qx + py * qy;
        imag += px * qy - py * qx;
      }
      const a = denom > 1 ? real / denom : 1;
      const b = denom > 1 ? imag / denom : 0;
      return {
        a, b,
        tx: meanQx - a * meanX + b * meanY,
        ty: meanQy - b * meanX - a * meanY
      };
    };
    const edgeValues = wallMotionSamples.map((item) => item.edge).filter((value) => Number.isFinite(value) && value > 0);
    const medianEdge = edgeValues.length ? median(edgeValues) : 64;
    const minSpan = Math.max(80, medianEdge * 1.25);
    const need = Math.max(2, Math.ceil(wallMotionSamples.length * 0.6));
    let best = null;
    // Healthy dense pages are overwhelmingly coherent. Accept their single
    // all-sample fit in O(n); reserve pair-seeded RANSAC for actual outliers.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const item of wallMotionSamples) {
      minX = Math.min(minX, item.x);
      minY = Math.min(minY, item.y);
      maxX = Math.max(maxX, item.x);
      maxY = Math.max(maxY, item.y);
    }
    if (Math.max(maxX - minX, maxY - minY) >= minSpan) {
      const allMotion = refit(wallMotionSamples);
      const allScale = Math.hypot(allMotion.a, allMotion.b);
      const allRotation = Math.abs(Math.atan2(allMotion.b, allMotion.a));
      let allSquared = 0, allMaxResidual = 0, allMaxShift = 0;
      for (const item of wallMotionSamples) {
        const residual = residualFor(allMotion, item);
        const px = allMotion.a * item.x - allMotion.b * item.y + allMotion.tx;
        const py = allMotion.b * item.x + allMotion.a * item.y + allMotion.ty;
        allSquared += residual * residual;
        allMaxResidual = Math.max(allMaxResidual, residual);
        allMaxShift = Math.max(allMaxShift, Math.hypot(px - item.x, py - item.y));
      }
      if (allScale >= 0.975 && allScale <= 1.025 && allRotation <= 0.035 &&
          allMaxResidual <= 1.05 && allMaxShift <= 5.1) {
        best = {
          inliers: wallMotionSamples,
          rms: Math.sqrt(allSquared / wallMotionSamples.length)
        };
      }
    }
    // Pair-seeded RANSAC prevents one local fallback residual from rotating the
    // whole lattice when the linear fast path found a real outlier.
    for (let i = 0; !best && i < wallMotionSamples.length; i++) {
      for (let j = i + 1; j < wallMotionSamples.length; j++) {
        const p = wallMotionSamples[i], q = wallMotionSamples[j];
        const ux = q.x - p.x, uy = q.y - p.y;
        const denom = ux * ux + uy * uy;
        if (denom < minSpan * minSpan) continue;
        const vx = q.x + q.dx - (p.x + p.dx);
        const vy = q.y + q.dy - (p.y + p.dy);
        const a = (ux * vx + uy * vy) / denom;
        const b = (ux * vy - uy * vx) / denom;
        const scale = Math.hypot(a, b);
        const rotation = Math.atan2(b, a);
        if (scale < 0.975 || scale > 1.025 || Math.abs(rotation) > 0.035) continue;
        const motion = {
          a, b,
          tx: p.x + p.dx - a * p.x + b * p.y,
          ty: p.y + p.dy - b * p.x - a * p.y
        };
        const inliers = wallMotionSamples.filter((item) => residualFor(motion, item) <= 1.05);
        if (inliers.length < need) continue;
        const rms = Math.sqrt(inliers.reduce((sum, item) => {
          const r = residualFor(motion, item);
          return sum + r * r;
        }, 0) / inliers.length);
        if (!best || inliers.length > best.inliers.length ||
            inliers.length === best.inliers.length && rms < best.rms)
          best = { inliers, rms };
      }
    }

    let wallMotion = null;
    if (best) {
      const motion = refit(best.inliers);
      const scale = Math.hypot(motion.a, motion.b);
      const rotation = Math.atan2(motion.b, motion.a);
      const residuals = best.inliers.map((item) => residualFor(motion, item));
      const maxResidual = Math.max(...residuals);
      const shifts = best.inliers.map((item) => {
        const px = motion.a * item.x - motion.b * item.y + motion.tx;
        const py = motion.b * item.x + motion.a * item.y + motion.ty;
        return { dx: px - item.x, dy: py - item.y };
      });
      const maxShift = Math.max(...shifts.map((item) => Math.hypot(item.dx, item.dy)));
      const dx = shifts.reduce((sum, item) => sum + item.dx, 0) / shifts.length;
      const dy = shifts.reduce((sum, item) => sum + item.dy, 0) / shifts.length;
      if (scale >= 0.975 && scale <= 1.025 && Math.abs(rotation) <= 0.035 &&
          maxResidual <= 1.15 && maxShift <= 5.1) {
        wallMotion = {
          kind: "similarity",
          ...motion,
          dx, dy,
          samples: best.inliers.length,
          residual: Math.sqrt(residuals.reduce((sum, value) => sum + value * value, 0) / residuals.length),
          maxShift
        };
      }
    }

    // Keep v279's extremely conservative translation consensus as the fallback
    // for clustered successes that do not provide a safe rotation/scale baseline.
    if (!wallMotion) {
      const dx = median(wallMotionSamples.map((item) => item.dx));
      const dy = median(wallMotionSamples.map((item) => item.dy));
      const coherent = wallMotionSamples.filter((item) => Math.hypot(item.dx - dx, item.dy - dy) <= 0.75);
      if (coherent.length >= need && Math.hypot(dx, dy) <= 4.5) {
        wallMotion = {
          kind: "translation",
          a: 1, b: 0, tx: dx, ty: dy,
          dx, dy,
          samples: coherent.length,
          residual: Math.max(...coherent.map((item) => Math.hypot(item.dx - dx, item.dy - dy))),
          maxShift: Math.hypot(dx, dy)
        };
      }
    }
    if (wallMotion)
      for (const symbol of symbols) symbol.wallMotion = wallMotion;
  }
  return { symbols, metrics, outputBuffer: output.buffer };
}
function ensureDirectBatch(zx) {
  if (!directBatchHandle) directBatchHandle = zx._createTrackedDecoder(DIRECT_BATCH_MAX_TRACKS, 177);
  if (!directBatchHandle) return false;
  if (!directResultsPtr) directResultsPtr = zx._malloc(DIRECT_BATCH_MAX_TRACKS * DIRECT_TRACK_RESULT_BYTES);
  if (!directOutputPtr) directOutputPtr = zx._malloc(DIRECT_BATCH_OUTPUT_BYTES);
  if (!directMetricsPtr) directMetricsPtr = zx._malloc(DIRECT_BATCH_METRICS_BYTES);
  if (!directResultsPtr || !directOutputPtr || !directMetricsPtr) return false;
  zx._setTrackedDecoderFallbackBudget(directBatchHandle, 0);
  return true;
}
function translatedQuad(q, dx, dy) {
  if (!validQuad(q)) return null;
  return {
    topLeft: { x: q.topLeft.x + dx, y: q.topLeft.y + dy },
    topRight: { x: q.topRight.x + dx, y: q.topRight.y + dy },
    bottomRight: { x: q.bottomRight.x + dx, y: q.bottomRight.y + dy },
    bottomLeft: { x: q.bottomLeft.x + dx, y: q.bottomLeft.y + dy }
  };
}
function quadShapeResidual(a, b) {
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
}
function configureDirectBatch(zx, tracks, ox, oy) {
  var _a;
  if (!ensureDirectBatch(zx) || tracks.length > DIRECT_BATCH_MAX_TRACKS) return void 0;
  const originChanged = ox !== directCropX || oy !== directCropY;
  const byId = /* @__PURE__ */ new Map();
  for (let slot = 0; slot < tracks.length; slot++) {
    const track = tracks[slot];
    const id = (_a = track.slot) != null ? _a : track.id;
    const previous = directConfigured[slot];
    const mustConfigure = originChanged || directRefresh.has(slot) || !previous || previous.id !== id || previous.dim !== track.dim || previous.crc32 !== track.crc32;
    if (mustConfigure) {
      const q = track.quad;
      if (!validQuad(q)) return void 0;
      const accepted = zx._setTrackedDecoderTrack(
        directBatchHandle,
        slot,
        id,
        track.dim,
        q.topLeft.x - ox,
        q.topLeft.y - oy,
        q.topRight.x - ox,
        q.topRight.y - oy,
        q.bottomRight.x - ox,
        q.bottomRight.y - oy,
        q.bottomLeft.x - ox,
        q.bottomLeft.y - oy
      );
      if (!accepted) return void 0;
      zx._setTrackedDecoderTrackCRC32(directBatchHandle, slot, track.crc32 ? 1 : 0);
      directConfigured[slot] = { id, dim: track.dim, crc32: track.crc32, baseQuad: track.quad };
      directRefresh.delete(slot);
    }
    byId.set(id, { input: track, configured: directConfigured[slot], directSlot: slot });
  }
  for (let slot = tracks.length; slot < directConfigured.length; slot++) {
    if (directConfigured[slot]) zx._clearTrackedDecoderTrack(directBatchHandle, slot);
  }
  directConfigured.length = tracks.length;
  directCropX = ox;
  directCropY = oy;
  return byId;
}
function decodeDirectBatch(zx, ptr, width, height, ox, oy, tracks, pixelFormat = "rgba", stride = width * 4) {
  const byId = configureDirectBatch(zx, tracks, ox, oy);
  if (!byId) return void 0;
  const decode = pixelFormat === "y8" ? zx._decodeTrackedBatchY : zx._decodeTrackedBatchRGBA;
  zx._setTrackedDecoderFallbackBudget(directBatchHandle, 0);
  const count = decode(
    directBatchHandle,
    ptr,
    width,
    height,
    stride,
    directResultsPtr,
    tracks.length,
    directOutputPtr,
    DIRECT_BATCH_OUTPUT_BYTES,
    directMetricsPtr
  );
  if (count < 0) return void 0;
  const view = new DataView(zx.HEAPU8.buffer);
  const metrics = {
    anchorMs: view.getFloat64(directMetricsPtr, true),
    samplingMs: view.getFloat64(directMetricsPtr + 8, true),
    bitExtractionMs: view.getFloat64(directMetricsPtr + 16, true),
    crcMs: view.getFloat64(directMetricsPtr + 24, true),
    rsFallbackMs: view.getFloat64(directMetricsPtr + 32, true),
    totalMs: view.getFloat64(directMetricsPtr + 40, true),
    tracks: view.getUint32(directMetricsPtr + 48, true),
    samples: view.getUint32(directMetricsPtr + 52, true),
    successful: view.getUint32(directMetricsPtr + 56, true),
    misses: view.getUint32(directMetricsPtr + 60, true),
    crcFastSuccesses: view.getUint32(directMetricsPtr + 64, true),
    rsFallbacks: view.getUint32(directMetricsPtr + 68, true),
    anchorSuccesses: view.getUint32(directMetricsPtr + 72, true),
    anchorMisses: view.getUint32(directMetricsPtr + 76, true),
    fastSamplerAttempts: view.getUint32(directMetricsPtr + 80, true),
    outOfFrameMisses: view.getUint32(directMetricsPtr + 84, true),
    bitstreamFailures: view.getUint32(directMetricsPtr + 88, true),
    crcFailures: view.getUint32(directMetricsPtr + 92, true),
    fastSamplerSuccesses: view.getUint32(directMetricsPtr + 96, true),
    anchorBypassAttempts: view.getUint32(directMetricsPtr + 100, true),
    anchorBypassSuccesses: view.getUint32(directMetricsPtr + 104, true),
    translationAttempts: view.getUint32(directMetricsPtr + 108, true),
    translationSuccesses: view.getUint32(directMetricsPtr + 112, true),
    calibrationAttempts: view.getUint32(directMetricsPtr + 116, true),
    calibrationSuccesses: view.getUint32(directMetricsPtr + 120, true)
  };
  const pending = [];
  const decodedSlots = new Set();
  let outputEnd = 0;
  for (let index = 0; index < count; index++) {
    const at = directResultsPtr + index * DIRECT_TRACK_RESULT_BYTES;
    const id = view.getInt32(at, true);
    const status = view.getInt32(at + 4, true);
    const bytesOffset = view.getInt32(at + 8, true);
    const bytesLength = view.getInt32(at + 12, true);
    const dx = view.getFloat32(at + 24, true);
    const dy = view.getFloat32(at + 28, true);
    const mapped = byId.get(id);
    if (!mapped) continue;
    const slot = mapped.directSlot;
    if (status !== DIRECT_TRACK_OK || bytesOffset < 0 || bytesLength <= 0) continue;
    const rawView = zx.HEAPU8.subarray(directOutputPtr + bytesOffset, directOutputPtr + bytesOffset + bytesLength);
    const packet = mapped.input.crc32 ? parseVerifiedFrame(rawView, false) : parseFrame(rawView);
    if (!packet) {
      if (slot >= 0) directRefresh.add(slot);
      continue;
    }
    const packetSlot = Number(packet.header.slotIndex);
    let outputMapped = mapped;
    let geometryMeasured = true;
    if (mapped.input.slot !== void 0 && packetSlot !== Number(mapped.input.slot)) {
      // CRC-valid AirGapper bytes are stronger identity evidence than the direct
      // track result id. A stale direct sample map can land on a neighboring QR
      // and still decode it perfectly. Keep the bytes, but never attach the
      // stale track geometry to that packet: remap to the packet's scheduled
      // physical slot and reuse only that slot's already-trusted lattice quad.
      if (slot >= 0) directRefresh.add(slot);
      if (!mapped.input.crc32) continue;
      outputMapped = void 0;
      for (const candidate of byId.values()) {
        if (Number(candidate.input.slot) === packetSlot) {
          outputMapped = candidate;
          break;
        }
      }
      if (!outputMapped) continue;
      geometryMeasured = false;
    }
    if (Number.isInteger(packetSlot)) {
      if (decodedSlots.has(packetSlot)) continue;
      decodedSlots.add(packetSlot);
    }
    outputEnd = Math.max(outputEnd, bytesOffset + bytesLength);
    pending.push({ mapped: outputMapped, bytesOffset, bytesLength, dx, dy, header: packet.header, geometryMeasured });
  }
  const output = outputEnd ? zx.HEAPU8.slice(directOutputPtr, directOutputPtr + outputEnd) : new Uint8Array(0);
  const symbols = pending.map(({ mapped, bytesOffset, bytesLength, dx, dy, header, geometryMeasured }) => {
    const quad = geometryMeasured
      ? translatedQuad(mapped.configured.baseQuad, dx, dy)
      : mapped.configured.baseQuad;
    return {
      bytes: output.subarray(bytesOffset, bytesOffset + bytesLength),
      box: boundsOf(quad, 0, 0),
      quad,
      modules: mapped.input.dim,
      tracked: true,
      geometryMeasured,
      decodePath: geometryMeasured ? "direct" : "direct-remap",
      crc32: mapped.input.crc32,
      verifiedPayload: mapped.input.crc32,
      header
    };
  });
  return { symbols, attempted: true, metrics, outputBuffer: output.buffer };
}
function localQuad(q, ox, oy) {
  if (!validQuad(q)) return null;
  const move = (point) => ({ x: point.x - ox, y: point.y - oy });
  return {
    topLeft: move(q.topLeft),
    topRight: move(q.topRight),
    bottomRight: move(q.bottomRight),
    bottomLeft: move(q.bottomLeft)
  };
}
function projectedNeighbor(q, dx, dy, stride) {
  if (!validQuad(q)) return null;
  const p0 = q.topLeft, p1 = q.topRight, p2 = q.bottomRight, p3 = q.bottomLeft;
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;
  const dx1x = p1.x - p2.x, dx1y = p1.y - p2.y;
  const dx2x = p3.x - p2.x, dx2y = p3.y - p2.y;
  const denominator = dx1x * dx2y - dx2x * dx1y;
  const g = Math.abs(denominator) < 1e-8 ? 0 : (sx * dx2y - dx2x * sy) / denominator;
  const h = Math.abs(denominator) < 1e-8 ? 0 : (dx1x * sy - sx * dx1y) / denominator;
  const a = p1.x - p0.x + g * p1.x;
  const b = p3.x - p0.x + h * p3.x;
  const c = p0.x;
  const d = p1.y - p0.y + g * p1.y;
  const e = p3.y - p0.y + h * p3.y;
  const f = p0.y;
  const project = (x2, y2) => {
    const z = g * x2 + h * y2 + 1;
    return { x: (a * x2 + b * y2 + c) / z, y: (d * x2 + e * y2 + f) / z };
  };
  const x = dx * stride, y = dy * stride;
  return { topLeft: project(x, y), topRight: project(x + 1, y), bottomRight: project(x + 1, y + 1), bottomLeft: project(x, y + 1) };
}

const REPEAT_SIGNATURE_X = 8;
const REPEAT_SIGNATURE_Y = 6;
const REPEAT_SIGNATURE_INTERIOR_TRACKS = 3;
const REPEAT_SIGNATURE_MAX_BITS = 6;

function repeatPageSignature(heap, yPtr, width, height, stride, ox, oy, tracks) {
  if (!Array.isArray(tracks) || tracks.length < 2 || stride < width) return null;
  const ordered = tracks
    .filter((track) => validQuad(track.quad) && Number.isFinite(track.dim) && track.dim >= 21)
    .sort((a, b) => (a.slot ?? a.id ?? 0) - (b.slot ?? b.id ?? 0));
  if (ordered.length < 2) return null;
  // Include both spatial extremes as well as interior quantiles. On a 7x4 wall
  // the former three quantiles all missed at least one edge row, allowing a
  // rolling transition there to masquerade as a whole-page duplicate.
  const pickIndices = [0, ordered.length - 1];
  for (let i = 1; i <= REPEAT_SIGNATURE_INTERIOR_TRACKS; i++) {
    const index = Math.round((ordered.length - 1) * i / (REPEAT_SIGNATURE_INTERIOR_TRACKS + 1));
    if (!pickIndices.includes(index)) pickIndices.push(index);
  }
  pickIndices.sort((a, b) => a - b);
  const selected = pickIndices.map((index) => ordered[index]).filter(Boolean);
  if (selected.length < 2) return null;

  const bits = new Uint8Array(Math.ceil(selected.length * REPEAT_SIGNATURE_X * REPEAT_SIGNATURE_Y / 8));
  let bitIndex = 0;
  const keys = [];
  const project = (q, u, v) => ({
    x: (1 - u) * (1 - v) * q.topLeft.x + u * (1 - v) * q.topRight.x + u * v * q.bottomRight.x + (1 - u) * v * q.bottomLeft.x - ox,
    y: (1 - u) * (1 - v) * q.topLeft.y + u * (1 - v) * q.topRight.y + u * v * q.bottomRight.y + (1 - u) * v * q.bottomLeft.y - oy
  });

  for (const track of selected) {
    const values = [];
    const dim = Math.round(track.dim);
    keys.push(`${track.slot ?? track.id ?? 0}:${dim}`);
    for (let gy = 0; gy < REPEAT_SIGNATURE_Y; gy++) {
      for (let gx = 0; gx < REPEAT_SIGNATURE_X; gx++) {
        // Interior module centers avoid the three fixed finder patterns. The
        // exact samples need not decode QR; they only need to change strongly
        // when the sender paints a different random-looking data matrix.
        const mx = Math.max(0, Math.min(dim - 1, Math.round(dim * (0.20 + (gx + 0.5) / REPEAT_SIGNATURE_X * 0.60))));
        const my = Math.max(0, Math.min(dim - 1, Math.round(dim * (0.20 + (gy + 0.5) / REPEAT_SIGNATURE_Y * 0.60))));
        const p = project(track.quad, (mx + 0.5) / dim, (my + 0.5) / dim);
        const x = Math.round(p.x), y = Math.round(p.y);
        if (x < 0 || y < 0 || x >= width || y >= height) return null;
        values.push(heap[yPtr + y * stride + x]);
      }
    }
    const ranked = [...values].sort((a, b) => a - b);
    const lo = ranked[Math.floor(ranked.length * 0.12)];
    const hi = ranked[Math.floor(ranked.length * 0.88)];
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi - lo < 36) return null;
    const threshold = (lo + hi) * 0.5;
    for (const value of values) {
      if (value < threshold) bits[bitIndex >> 3] |= 1 << (bitIndex & 7);
      bitIndex++;
    }
  }
  return { key: keys.join('|'), bits: Array.from(bits), bitCount: bitIndex };
}

function repeatSignatureDistance(current, previous) {
  if (!current || !previous || current.key !== previous.key || current.bitCount !== previous.bitCount ||
      !Array.isArray(current.bits) || !Array.isArray(previous.bits) || current.bits.length !== previous.bits.length) return null;
  let different = 0;
  for (let i = 0; i < current.bits.length; i++) {
    let value = (current.bits[i] ^ previous.bits[i]) & 255;
    while (value) {
      value &= value - 1;
      different++;
    }
  }
  return { different, fraction: different / Math.max(1, current.bitCount) };
}

ctx.onmessage = async (e) => {
  const startedAt = performance.now();
  const { id, buf, videoFrame, cropX = 0, cropY = 0, w = 0, h = 0, ox = 0, oy = 0, full = true, quad, dim, tracks, isolated = false, oracle = false, oracleSeeds = [], sentAt, pixelFormat = "rgba", yOffset: messageYOffset = 0, yStride: messageYStride = 0, payloadBytes = 0, strictHotPath = false, outputMap, thorough = false, acquisitionMode, guidedDecode = false, guidedFallbackMask = 0xffffffff, guidedRepairMask = 0xffffffff, sourceSequence, repeatFilter = false, previousFrameSignature } = e.data;
  const workerWaitMs = sentAt === void 0 ? 0 : Math.max(0, startedAt - sentAt);
  let readFullAttempts = 0;
  let targetedAttempts = 0;
  let targetedPixels = 0;
  let targetedSuccesses = 0;
  let ownedVideoFrame = videoFrame;
  try {
    const usedDirectFrame = Boolean(ownedVideoFrame);
    const usedDirectYBuffer = ownedVideoFrame instanceof ArrayBuffer;
    // Direct camera frames use the Y8 Guided lane first. Buffered RGBA frames
    // (corpus replay, benchmark images, legacy/canvas inputs) already have
    // trusted lattice geometry, so do not throw that information away by
    // running the generic finder before the persistent tracked decoder. Try
    // direct tracked sampling first; the existing cold-track recovery below
    // still wakes robust detection when geometry genuinely stops working.
    const robustLaneFirst = !strictHotPath && !full && Array.isArray(tracks) && tracks.length > 0 && usedDirectFrame;
    let coldTrackCount = 0;
    if (!strictHotPath && !full && Array.isArray(tracks)) {
      for (const track of tracks) coldTrackCount += Number((track.misses ?? 0) >= 4);
    }
    const robustTrackThreshold = Array.isArray(tracks) && tracks.length === 1
      ? 1
      : Math.max(2, Math.ceil((tracks?.length ?? 0) * 0.6));
    const robustTrackedRecovery = !strictHotPath && !full && Array.isArray(tracks)
      && coldTrackCount >= robustTrackThreshold;
    let frameCopyMs = 0;
    let inputOffset = pixelFormat === "y8" ? messageYOffset : 0;
    let inputStride = pixelFormat === "y8" ? messageYStride || w : w * 4;
    let decodePixelFormat = pixelFormat;
    let pixels;
    const zx = await ready;
    let ptr;
    if (usedDirectYBuffer) {
      if (inputStride < w) throw new Error("Direct camera Y stride is invalid");
      const available = Math.min(ownedVideoFrame.byteLength, payloadBytes || ownedVideoFrame.byteLength);
      const requiredEnd = inputOffset + Math.max(0, h - 1) * inputStride + w;
      if (inputOffset < 0 || requiredEnd > available) throw new Error("Direct camera Y crop is out of range");
      const packedBytes = w * h;
      const packCrop = h > 0 && packedBytes < available * 0.72;
      const copyStarted = performance.now();
      if (packCrop) {
        ptr = inputBuffer(zx, packedBytes);
        if (!ptr) throw new Error("Could not allocate WASM direct Y crop");
        const source = new Uint8Array(ownedVideoFrame);
        for (let row = 0; row < h; row++) {
          const start = inputOffset + row * inputStride;
          zx.HEAPU8.set(source.subarray(start, start + w), ptr + row * w);
        }
        inputOffset = 0;
        inputStride = w;
      } else {
        pixels = new Uint8Array(ownedVideoFrame, 0, requiredEnd);
        ptr = inputBuffer(zx, pixels.byteLength);
        if (!ptr) throw new Error("Could not allocate WASM direct Y input buffer");
        zx.HEAPU8.set(pixels, ptr);
      }
      frameCopyMs = performance.now() - copyStarted;
      decodePixelFormat = "y8";
      ownedVideoFrame = null;
    } else if (ownedVideoFrame) {
      const rect = { x: cropX, y: cropY, width: w, height: h };
      const copyAsRgba = pixelFormat !== "y8";
      const copyOptions = copyAsRgba ? { rect, format: "RGBA" } : { rect };
      const allocationBytes = ownedVideoFrame.allocationSize(copyOptions);
      ptr = inputBuffer(zx, allocationBytes);
      if (!ptr) throw new Error("Could not allocate WASM camera input buffer");
      const copyStarted = performance.now();
      const planes = await ownedVideoFrame.copyTo(zx.HEAPU8.subarray(ptr, ptr + allocationBytes), copyOptions);
      frameCopyMs = performance.now() - copyStarted;
      const plane = planes[0];
      if (!plane) throw new Error("Camera frame has no usable pixel plane");
      inputOffset = plane.offset;
      inputStride = plane.stride;
      decodePixelFormat = copyAsRgba ? "rgba" : "y8";
      if (decodePixelFormat === "y8" && inputStride < w) throw new Error("Camera Y stride is invalid");
      if (decodePixelFormat === "rgba" && inputStride < w * 4) throw new Error("Camera RGBA stride is invalid");
      // The camera frame is only a transport into WASM memory. Never retain a
      // TrackProcessor VideoFrame while QR decoding runs: when several workers
      // pin camera buffers during target loss, Chromium can stop delivering new
      // processor frames even though the <video> preview itself is still live.
      // Robust recovery must operate on the copied Y plane below.
      ownedVideoFrame.close();
      ownedVideoFrame = null;
    } else {
      const byteLength = pixelFormat === "y8" ? Math.min(buf.byteLength, payloadBytes || inputOffset + Math.max(0, h - 1) * inputStride + w) : buf.byteLength;
      pixels = new Uint8Array(buf, 0, byteLength);
      ptr = inputBuffer(zx, pixels.byteLength);
      if (!ptr) throw new Error("Could not allocate WASM pixel input buffer");
      zx.HEAPU8.set(pixels, ptr);
    }
    const pw = w;
    const ph = h;
    // Adjacent-camera duplicates are expensive because the 30 fps receiver can
    // photograph one 20-ish fps sender page twice. After the Y plane copy, a
    // 240-bit signature costs only a handful of reads from known QR interiors.
    // Publish it immediately so the next worker can compare against it. Only a
    // near-identical whole-page match exits early; rolling transitions keep
    // decoding because their signature changes substantially.
    if (repeatFilter && decodePixelFormat === "y8" && !full && guidedDecode && tracks?.length >= 2) {
      const frameSignature = repeatPageSignature(zx.HEAPU8, ptr + inputOffset, pw, ph, inputStride, ox, oy, tracks);
      if (frameSignature) {
        ctx.postMessage({ id, preflight: true, sourceSequence, frameSignature });
        const distance = repeatSignatureDistance(frameSignature, previousFrameSignature);
        if (distance && distance.different <= REPEAT_SIGNATURE_MAX_BITS) {
          ctx.postMessage({
            id,
            sourceSequence,
            symbols: [],
            sightings: [],
            full: false,
            trackedAttempted: false,
            trackedHit: false,
            fallbackAttempted: false,
            fallbackSucceeded: false,
            readFullAttempts: 0,
            workerWaitMs,
            frameCopyMs,
            repeatSkipped: true,
            repeatDistance: distance.fraction,
            pixelPath: "y8-repeat",
            latencyMs: performance.now() - startedAt
          });
          return;
        }
      }
    }
    const symbols = [];
    const sightings = [];
    const mapOutputToDisplay = (decodedSymbols = symbols, decodedSightings = sightings) => {
      if (!outputMap || !Number.isFinite(outputMap.scaleX) || outputMap.scaleX <= 0 || !Number.isFinite(outputMap.scaleY) || outputMap.scaleY <= 0) return;
      const mapPoint = (point) => ({
        x: (point.x - outputMap.offsetX) / outputMap.scaleX,
        y: (point.y - outputMap.offsetY) / outputMap.scaleY
      });
      for (const symbol of decodedSymbols) {
        if (!validQuad(symbol.quad)) continue;
        symbol.quad = {
          topLeft: mapPoint(symbol.quad.topLeft),
          topRight: mapPoint(symbol.quad.topRight),
          bottomRight: mapPoint(symbol.quad.bottomRight),
          bottomLeft: mapPoint(symbol.quad.bottomLeft)
        };
        symbol.box = boundsOf(symbol.quad, 0, 0);
      }
      for (const box of decodedSightings) {
        box.x = (box.x - outputMap.offsetX) / outputMap.scaleX;
        box.y = (box.y - outputMap.offsetY) / outputMap.scaleY;
        box.w /= outputMap.scaleX;
        box.h /= outputMap.scaleY;
      }
    };
    if (oracle) {
      const seen = /* @__PURE__ */ new Set();
      const valid = [];
      const appendValid = (vec) => {
        readFullAttempts++;
        try {
          for (let i = 0; i < vec.size(); i++) {
            const result = vec.get(i);
            if (!result.valid || !result.bytes.length || !parseFrame(result.bytes)) continue;
            const key = Array.from(result.bytes).join(",");
            if (seen.has(key)) continue;
            seen.add(key);
            valid.push({
              bytes: result.bytes,
              box: boundsOf(result.position, 0, 0),
              quad: shifted(result.position, 0, 0),
              modules: result.modules,
              tracked: false
            });
          }
        } finally {
          vec.delete();
        }
      };
      appendValid(zx.readFull(ptr, pw, ph, true, 128, false));
      appendValid(zx.readFull(ptr, pw, ph, true, 128, true));
      const seeds = [...valid].flatMap((seed) => {
        const parsed = parseFrame(seed.bytes);
        return parsed ? [{
          quad: seed.quad,
          modules: seed.modules,
          layoutId: parsed.header.layoutId,
          extendedGrid: parsed.header.extendedGrid,
          gridCols: parsed.header.gridCols,
          gridRows: parsed.header.gridRows,
          slot: parsed.header.slotIndex
        }] : [];
      });
      seeds.push(...oracleSeeds);
      for (const seed of seeds) {
        const layout = seed.extendedGrid
          ? { cols: Number(seed.gridCols), rows: Number(seed.gridRows) }
          : gridLayoutById(seed.layoutId);
        if (!layout || !Number.isInteger(layout.cols) || !Number.isInteger(layout.rows) ||
            layout.cols < 1 || layout.rows < 1 || layout.cols * layout.rows > 128)
          continue;
        const sx = seed.slot % layout.cols;
        const sy = Math.floor(seed.slot / layout.cols);
        const ratio = (seed.modules + 1) / seed.modules;
        for (let slot = 0; slot < layout.cols * layout.rows; slot++) {
          const dx = slot % layout.cols - sx;
          const dy = Math.floor(slot / layout.cols) - sy;
          const predicted = projectedNeighbor(seed.quad, dx, dy, ratio);
          if (!predicted) continue;
          const result = zx.readTracked(
            ptr,
            pw,
            ph,
            seed.modules,
            predicted.topLeft.x,
            predicted.topLeft.y,
            predicted.topRight.x,
            predicted.topRight.y,
            predicted.bottomRight.x,
            predicted.bottomRight.y,
            predicted.bottomLeft.x,
            predicted.bottomLeft.y
          );
          const packet = result.valid && result.bytes.length ? parseFrame(result.bytes) : null;
          if ((packet == null ? void 0 : packet.header.layoutId) === layout.id && packet.header.slotIndex === slot) {
            const key = Array.from(result.bytes).join(",");
            if (!seen.has(key)) {
              seen.add(key);
              valid.push({ bytes: result.bytes, box: boundsOf(result.position, 0, 0), quad: shifted(result.position, 0, 0), modules: result.modules, tracked: true });
            }
            continue;
          }
          const expected = boundsOf(predicted, 0, 0);
          const moduleSize = Math.max(expected.w, expected.h) / seed.modules;
          const sourcePad = Math.max(2, Math.round(moduleSize));
          const quiet = Math.max(8, Math.round(moduleSize * 5));
          const cx = Math.max(0, Math.floor(expected.x - sourcePad));
          const cy = Math.max(0, Math.floor(expected.y - sourcePad));
          const cr = Math.min(pw, Math.ceil(expected.x + expected.w + sourcePad));
          const cb = Math.min(ph, Math.ceil(expected.y + expected.h + sourcePad));
          const sw = cr - cx, sh = cb - cy;
          const cw = sw + quiet * 2, ch = sh + quiet * 2;
          if (sw < 24 || sh < 24) continue;
          const crop = new Uint8Array(cw * ch * 4);
          crop.fill(255);
          for (let row = 0; row < sh; row++) {
            crop.set(
              pixels.subarray(((cy + row) * pw + cx) * 4, ((cy + row) * pw + cr) * 4),
              ((row + quiet) * cw + quiet) * 4
            );
          }
          const cropPtr = zx._malloc(crop.length);
          zx.HEAPU8.set(crop, cropPtr);
          readFullAttempts++;
          const fallback = zx.readFull(cropPtr, cw, ch, true, 4, false);
          try {
            for (let i = 0; i < fallback.size(); i++) {
              const candidate = fallback.get(i);
              if (!candidate.valid || !candidate.bytes.length) continue;
              const candidatePacket = parseFrame(candidate.bytes);
              if ((candidatePacket == null ? void 0 : candidatePacket.header.layoutId) !== layout.id || candidatePacket.header.slotIndex !== slot) continue;
              const key = Array.from(candidate.bytes).join(",");
              if (seen.has(key)) continue;
              seen.add(key);
              const shiftX = cx - quiet, shiftY = cy - quiet;
              valid.push({ bytes: candidate.bytes, box: boundsOf(candidate.position, shiftX, shiftY), quad: shifted(candidate.position, shiftX, shiftY), modules: candidate.modules, tracked: false });
            }
          } finally {
            fallback.delete();
            zx._free(cropPtr);
          }
        }
      }
      ctx.postMessage({
        id,
        symbols: valid,
        sightings: [],
        full: true,
        oracle: true,
        trackedAttempted: true,
        trackedHit: valid.some((symbol) => symbol.tracked),
        fallbackAttempted: true,
        readFullAttempts,
        workerWaitMs,
        latencyMs: performance.now() - startedAt
      });
      return;
    }
    if (!full && tracks?.length && robustLaneFirst) {
      if (guidedDecode && decodePixelFormat === "y8" && tracks.length >= 2) {
        // Guided remains the production tracked decoder. v194 proved cached
        // module maps can work on the better camera, but calibrating a second
        // direct tracker before Guided added ~105 ms/job and reduced scheduled
        // camera frames. The next cache path must reuse Guided's successful
        // geometry instead of duplicating localization work.
        const guided = decodeGuidedBatch(
          zx, ptr + inputOffset, pw, ph, inputStride, ox, oy, tracks, guidedFallbackMask, guidedRepairMask
        );
        if (guided) symbols.push(...guided.symbols);
        mapOutputToDisplay();
        const reply = {
          id,
          symbols,
          sightings,
          full: false,
          trackedAttempted: true,
          trackedHit: symbols.length > 0,
          fallbackAttempted: false,
          fallbackSucceeded: false,
          readFullAttempts: 0,
          workerWaitMs,
          frameCopyMs,
          guidedMetrics: guided?.metrics,
          directAssistTracks: 0,
          directAssistHits: 0,
          guidedAssistTracks: Math.max(0, tracks.length - (guided?.metrics?.turboSuccesses ?? 0)),
          pixelPath: guided?.metrics?.turboSuccesses === tracks.length
            ? "y8-turbo"
            : guided?.metrics?.turboSuccesses
              ? "y8-turbo+guided"
              : "y8-guided",
          guidedError: guided?.error,
          latencyMs: performance.now() - startedAt
        };
        const transfer = guided?.outputBuffer && symbols.length ? [guided.outputBuffer] : [];
        ctx.postMessage(reply, transfer);
        return;
      }
      readFullAttempts++;
      const robustMax = Math.min(ROBUST_BATCH_MAX_RESULTS, Math.max(1, tracks.length));
      const singleLocalQr = tracks.length === 1;
      const decoded = decodePixelFormat === "y8"
        ? singleLocalQr
          ? zx.readFullY(ptr + inputOffset, pw, ph, inputStride, false, 1, false)
          : zx.readDenseY(ptr + inputOffset, pw, ph, inputStride, robustMax)
        : zx.readFull(ptr + inputOffset, pw, ph, !singleLocalQr, robustMax, false);
      try {
        const expectedSlots = new Set(tracks.flatMap((track) => track.slot === void 0 ? [] : [track.slot]));
        for (let i = 0; i < decoded.size(); i++) {
          const result = decoded.get(i);
          if (!result.valid || !result.bytes.length || !validQuad(result.position)) continue;
          const packet = parseFrame(result.bytes);
          const slot = packet?.header.slotIndex;
          if (!packet || slot !== void 0 && expectedSlots.size && !expectedSlots.has(slot)) continue;
          symbols.push({
            bytes: result.bytes,
            box: boundsOf(result.position, ox, oy),
            quad: shifted(result.position, ox, oy),
            modules: result.modules,
            tracked: false,
            decodePath: "robust",
            header: packet.header
          });
        }
      } finally {
        decoded.delete();
      }
      mapOutputToDisplay();
      ctx.postMessage({
        id,
        symbols,
        sightings,
        full: false,
        trackedAttempted: false,
        trackedHit: false,
        fallbackAttempted: true,
        fallbackSucceeded: symbols.length > 0,
        readFullAttempts,
        workerWaitMs,
        frameCopyMs,
        pixelPath: decodePixelFormat,
        robustFirst: true,
        latencyMs: performance.now() - startedAt
      });
      return;
    }
    if (!full && tracks?.length) {
      const direct = decodeDirectBatch(
        zx,
        ptr + inputOffset,
        pw,
        ph,
        ox,
        oy,
        tracks,
        decodePixelFormat,
        inputStride
      );
      const directSymbols = direct?.symbols ?? [];
      const robustFallback = robustTrackedRecovery && directSymbols.length < tracks.length;
      if (!robustFallback && (direct || usedDirectFrame)) {
        ownedVideoFrame?.close();
        ownedVideoFrame = null;
        const directFrameFailed = usedDirectFrame && !direct;
        mapOutputToDisplay(directSymbols);
        const reply = {
          id,
          symbols: directSymbols,
          sightings,
          full: false,
          trackedAttempted: direct?.attempted ?? true,
          trackedHit: directSymbols.length > 0,
          fallbackAttempted: false,
          fallbackSucceeded: false,
          readFullAttempts: 0,
          workerWaitMs,
          targetedAttempts: 0,
          targetedPixels: 0,
          targetedSuccesses: 0,
          frameCopyMs,
          directMetrics: direct?.metrics,
          pixelPath: decodePixelFormat,
          directFrameFailed,
          latencyMs: performance.now() - startedAt
        };
        const transfer = direct?.outputBuffer && directSymbols.length ? [direct.outputBuffer] : [];
        ctx.postMessage(reply, transfer);
        return;
      }
      symbols.push(...directSymbols);
      // Recovery uses the pixels already copied out of the camera frame. For
      // direct camera input this is Y8, so keep recovery luminance-only instead
      // of retaining/re-reading the live VideoFrame as RGBA.
      readFullAttempts++;
      const recoveryMax = Math.min(ROBUST_BATCH_MAX_RESULTS, Math.max(1, tracks.length));
      const decoded = decodePixelFormat === "y8"
        ? zx.readFullY(ptr + inputOffset, pw, ph, inputStride, true, recoveryMax, false)
        : zx.readFull(ptr + inputOffset, pw, ph, true, recoveryMax, false);
      try {
        const expectedSlots = new Set(tracks.flatMap((track) => track.slot === void 0 ? [] : [track.slot]));
        const decodedSlots = /* @__PURE__ */ new Set(directSymbols.flatMap((symbol) => symbol.header?.slotIndex === void 0 ? [] : [symbol.header.slotIndex]));
        for (let i = 0; i < decoded.size(); i++) {
          const result = decoded.get(i);
          if (!result.valid || !result.bytes.length) continue;
          const packet = parseFrame(result.bytes);
          const slot = packet == null ? void 0 : packet.header.slotIndex;
          if (!packet || slot !== void 0 && expectedSlots.size && !expectedSlots.has(slot) || slot !== void 0 && decodedSlots.has(slot)) continue;
          if (slot !== void 0) decodedSlots.add(slot);
          const trackIndex = tracks.findIndex((track) => track.slot === slot);
          const recoveredPosition = validQuad(result.position)
            ? result.position
            : trackIndex >= 0 ? localQuad(tracks[trackIndex].quad, ox, oy) : null;
          if (!recoveredPosition) continue;
          if (trackIndex >= 0 && validQuad(result.position)) {
            const currentLocal = localQuad(tracks[trackIndex].quad, ox, oy);
            const moduleSize = quadModuleSize(currentLocal, tracks[trackIndex].dim);
            const refreshThreshold = Math.max(0.75, moduleSize * 0.45);
            if (quadShapeResidual(currentLocal, result.position) > refreshThreshold)
              directRefresh.add(trackIndex);
          }
          symbols.push({
            bytes: result.bytes,
            box: boundsOf(recoveredPosition, ox, oy),
            quad: shifted(recoveredPosition, ox, oy),
            modules: result.modules,
            tracked: false,
            decodePath: "fallback",
            header: packet.header
          });
        }
      } finally {
        decoded.delete();
      }
      mapOutputToDisplay();
      ctx.postMessage({
        id,
        symbols,
        sightings,
        full: false,
        trackedAttempted: true,
        trackedHit: directSymbols.length > 0,
        fallbackAttempted: true,
        fallbackSucceeded: symbols.length > directSymbols.length,
        readFullAttempts,
        workerWaitMs,
        frameCopyMs,
        directMetrics: direct?.metrics,
        pixelPath: decodePixelFormat,
        latencyMs: performance.now() - startedAt
      });
      return;
    }
    let trackedHit = false;
    let trackedAttempted = false;
    let fallbackAttempted = false;
    if (!full && validQuad(quad) && dim) {
      trackedAttempted = true;
      const r = zx.readTracked(
        ptr,
        pw,
        ph,
        dim,
        quad.topLeft.x - ox,
        quad.topLeft.y - oy,
        quad.topRight.x - ox,
        quad.topRight.y - oy,
        quad.bottomRight.x - ox,
        quad.bottomRight.y - oy,
        quad.bottomLeft.x - ox,
        quad.bottomLeft.y - oy
      );
      if (r.valid && r.bytes.length > 0) {
        const trackedPosition = validQuad(r.position) ? r.position : localQuad(quad, ox, oy);
        if (trackedPosition) {
          symbols.push({
            bytes: r.bytes,
            box: boundsOf(trackedPosition, ox, oy),
            quad: shifted(trackedPosition, ox, oy),
            modules: r.modules,
            tracked: true,
            decodePath: "direct"
          });
          trackedHit = true;
        }
      }
    }
    if ((full || !strictHotPath) && (full || !trackedAttempted || !trackedHit)) {
      fallbackAttempted = !full;
      const appendResults = (vec, includeErrors, resultOx = ox, resultOy = oy, expectedSlot) => {
        try {
          for (let i = 0; i < vec.size(); i++) {
            const r = vec.get(i);
            if (r.valid && r.bytes.length > 0 && validQuad(r.position)) {
              const packet = expectedSlot === void 0 ? null : parseFrame(r.bytes);
              if (expectedSlot !== void 0 && packet?.header.slotIndex !== expectedSlot) continue;
              symbols.push({
                bytes: r.bytes,
                box: boundsOf(r.position, resultOx, resultOy),
                quad: shifted(r.position, resultOx, resultOy),
                modules: r.modules,
                tracked: false,
                decodePath: full ? "acquire" : "fallback",
                header: packet?.header
              });
            } else if (includeErrors) {
              const box = boundsOf(r.position, resultOx, resultOy);
              if (box && box.w > 0 && box.h > 0) sightings.push(box);
            }
          }
        } finally {
          vec.delete();
        }
      };
      if (full) {
        // One CRC-valid AirGapper QR now seeds the complete declared wall. At
        // dense v40 scale, use the codec's dedicated full-resolution finder:
        // it keeps tryHarder's 3-row scan stride but deliberately skips the
        // useless 1/3 and 1/9 image pyramids. Return after the first QR so the
        // main thread can lock/predict all slots immediately. An occasional
        // deep scan retains generic downscale coverage for a distant wall.
        const fullMode = acquisitionMode ?? (thorough ? "thorough" : "fast");
        const readFull = (tryHarder, maxSymbols, returnErrors) => decodePixelFormat === "y8"
          ? zx.readFullY(ptr + inputOffset, pw, ph, inputStride, tryHarder, maxSymbols, returnErrors)
          : zx.readFull(ptr, pw, ph, tryHarder, maxSymbols, returnErrors);
        const readDenseSeed = (maxSymbols = 1) => decodePixelFormat === "y8"
          ? zx.readDenseY(ptr + inputOffset, pw, ph, inputStride, maxSymbols)
          : zx.readFull(ptr, pw, ph, true, maxSymbols, false);
        const acquireWithScaleFallback = (maxSymbols = 1) => {
          readFullAttempts++;
          appendResults(readDenseSeed(maxSymbols), false);
          if (symbols.length === 0 && decodePixelFormat === "y8" && Math.max(pw, ph) >= 900) {
            readFullAttempts++;
            appendResults(readFull(true, maxSymbols, false), false);
          }
        };
        if (fullMode === "hunt") {
          readFullAttempts++;
          appendResults(readFull(true, 8, true), true);
        } else if (fullMode === "sighting") {
          readFullAttempts++;
          appendResults(readFull(true, 1, true), true);
        } else if (fullMode === "thorough") {
          readFullAttempts++;
          appendResults(readFull(true, 16, false), false);
          if (symbols.length === 0) {
            readFullAttempts++;
            appendResults(readFull(true, 24, true), true);
          }
        } else if (fullMode === "deep") {
          readFullAttempts++;
          appendResults(readFull(true, 1, false), false);
        } else if (fullMode === "recovery") {
          if (decodePixelFormat === "y8" && Array.isArray(tracks) && tracks.length) {
            for (const target of tracks.slice(0, 3)) {
              const local = localQuad(target.quad, ox, oy);
              const box = local && boundsOf(local, 0, 0);
              const expectedSlot = Number(target.slot);
              if (!box || !Number.isInteger(expectedSlot)) continue;
              const edge = Math.max(box.w, box.h);
              const pad = Math.max(20, edge * 0.45);
              const rx = Math.max(0, Math.floor(box.x - pad));
              const ry = Math.max(0, Math.floor(box.y - pad));
              const rr = Math.min(pw, Math.ceil(box.x + box.w + pad));
              const rb = Math.min(ph, Math.ceil(box.y + box.h + pad));
              const rw = rr - rx, rh = rb - ry;
              if (rw < 32 || rh < 32) continue;
              targetedAttempts++;
              targetedPixels += rw * rh;
              readFullAttempts++;
              const before = symbols.length;
              appendResults(
                zx.readDenseY(ptr + inputOffset + ry * inputStride + rx, rw, rh, inputStride, 4),
                false, ox + rx, oy + ry, expectedSlot
              );
              if (symbols.length > before) targetedSuccesses++;
            }
          }
          if (symbols.length === 0) acquireWithScaleFallback(1);
        } else if (fullMode === "seed") {
          readFullAttempts++;
          appendResults(readDenseSeed(1), false);
        } else {
          acquireWithScaleFallback(1);
        }
      } else {
        readFullAttempts++;
        appendResults(zx.readFull(ptr, pw, ph, true, isolated ? 1 : 2, false), false);
      }
    }
    ownedVideoFrame?.close();
    ownedVideoFrame = null;
    mapOutputToDisplay();
    ctx.postMessage({
      id,
      symbols,
      sightings,
      full,
      trackedAttempted,
      trackedHit,
      fallbackAttempted,
      fallbackSucceeded: fallbackAttempted && symbols.some((symbol) => !symbol.tracked),
      readFullAttempts,
      workerWaitMs,
      targetedAttempts,
      targetedPixels,
      targetedSuccesses,
      latencyMs: performance.now() - startedAt
    });
  } catch (error) {
    ownedVideoFrame?.close();
    ownedVideoFrame = null;
    const directFrameFailed = Boolean(videoFrame);
    ctx.postMessage({
      id,
      symbols: [],
      sightings: [],
      full,
      trackedAttempted: directFrameFailed,
      trackedHit: false,
      workerWaitMs,
      readFullAttempts,
      directFrameFailed,
      latencyMs: performance.now() - startedAt,
      error: directFrameFailed ? void 0 : error instanceof Error ? error.message : String(error)
    });
  }
};
void (async () => {
  try {
    const zx = await ready;
    const ptr = zx._malloc(8 * 8 * 4);
    zx.HEAPU8.set(new Uint8Array(8 * 8 * 4).fill(255), ptr);
    zx.readFull(ptr, 8, 8, false, 1, false).delete();
    zx._free(ptr);
  } catch {
  }
  ctx.postMessage({ id: -1, bytes: null });
})();
