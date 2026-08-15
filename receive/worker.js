import { shouldRunFullDecode } from "../shared/decode-policy.js";
import { parseFrame, parseVerifiedFramePayload } from "../shared/protocol.js";
import { gridLayoutById } from "../shared/grid-layout.js";
const scalarCodec = new URL(import.meta.url).searchParams.has("scalar");
const ready = import(scalarCodec ? "../vendor/decimen-codec-android/decimen_codec.js" : "../vendor/decimen-codec/decimen_codec.js").then(({ default: DecimenCodec }) => DecimenCodec());
const ctx = self;
function boundsOf(p, ox, oy) {
  const xs = [p.topLeft.x, p.topRight.x, p.bottomRight.x, p.bottomLeft.x];
  const ys = [p.topLeft.y, p.topRight.y, p.bottomRight.y, p.bottomLeft.y];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x: ox + x, y: oy + y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
function shifted(p, ox, oy) {
  const s = (pt) => ({ x: pt.x + ox, y: pt.y + oy });
  return {
    topLeft: s(p.topLeft),
    topRight: s(p.topRight),
    bottomRight: s(p.bottomRight),
    bottomLeft: s(p.bottomLeft)
  };
}
let inputPtr = 0;
let inputCapacity = 0;
function inputBuffer(zx, bytes) {
  if (bytes <= inputCapacity) return inputPtr;
  if (inputPtr) zx._free(inputPtr);
  inputPtr = zx._malloc(bytes);
  inputCapacity = bytes;
  return inputPtr;
}
const NATIVE_BATCH_MAX_TRACKS = 16;
const NATIVE_TRACK_RESULT_BYTES = 32;
const NATIVE_BATCH_METRICS_BYTES = 72;
const NATIVE_BATCH_OUTPUT_BYTES = 128 * 1024;
const NATIVE_TRACK_OK = 1;
let nativeBatchHandle = 0;
let nativeResultsPtr = 0;
let nativeOutputPtr = 0;
let nativeMetricsPtr = 0;
let nativeConfigured = [];
let nativeCropOrigin = "";
let nativeFallbackBudget = 1;
const nativeRefresh = /* @__PURE__ */ new Set();
function ensureNativeBatch(zx) {
  if (nativeBatchHandle) return true;
  nativeBatchHandle = zx._createTrackedDecoder(NATIVE_BATCH_MAX_TRACKS, 177);
  if (!nativeBatchHandle) return false;
  nativeResultsPtr = zx._malloc(NATIVE_BATCH_MAX_TRACKS * NATIVE_TRACK_RESULT_BYTES);
  nativeOutputPtr = zx._malloc(NATIVE_BATCH_OUTPUT_BYTES);
  nativeMetricsPtr = zx._malloc(NATIVE_BATCH_METRICS_BYTES);
  zx._setTrackedDecoderFallbackBudget(nativeBatchHandle, nativeFallbackBudget);
  return Boolean(nativeResultsPtr && nativeOutputPtr && nativeMetricsPtr);
}
function translatedQuad(q, dx, dy) {
  const move = (p) => ({ x: p.x + dx, y: p.y + dy });
  return {
    topLeft: move(q.topLeft),
    topRight: move(q.topRight),
    bottomRight: move(q.bottomRight),
    bottomLeft: move(q.bottomLeft)
  };
}
function configureNativeBatch(zx, tracks, ox, oy) {
  var _a;
  if (!ensureNativeBatch(zx) || tracks.length > NATIVE_BATCH_MAX_TRACKS) return void 0;
  const origin = `${ox},${oy}`;
  const originChanged = origin !== nativeCropOrigin;
  const byId = /* @__PURE__ */ new Map();
  for (let slot = 0; slot < tracks.length; slot++) {
    const track = tracks[slot];
    const id = (_a = track.slot) != null ? _a : track.id;
    const previous = nativeConfigured[slot];
    const mustConfigure = originChanged || nativeRefresh.has(slot) || !previous || previous.id !== id || previous.dim !== track.dim || previous.crc32 !== track.crc32;
    if (mustConfigure) {
      const q = track.quad;
      const accepted = zx._setTrackedDecoderTrack(
        nativeBatchHandle,
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
      zx._setTrackedDecoderTrackCRC32(nativeBatchHandle, slot, track.crc32 ? 1 : 0);
      nativeConfigured[slot] = { id, dim: track.dim, crc32: track.crc32, baseQuad: track.quad };
      nativeRefresh.delete(slot);
    }
    byId.set(id, { input: track, configured: nativeConfigured[slot], nativeSlot: slot });
  }
  for (let slot = tracks.length; slot < nativeConfigured.length; slot++) {
    if (nativeConfigured[slot]) zx._clearTrackedDecoderTrack(nativeBatchHandle, slot);
  }
  nativeConfigured.length = tracks.length;
  nativeCropOrigin = origin;
  return byId;
}
function decodeNativeBatch(zx, ptr, width, height, ox, oy, tracks, pixelFormat = "rgba", stride = width * 4, strictTracked = false) {
  const byId = configureNativeBatch(zx, tracks, ox, oy);
  if (!byId) return void 0;
  const decode = pixelFormat === "y8" ? zx._decodeTrackedBatchY : zx._decodeTrackedBatchRGBA;
  const appliedFallbackBudget = strictTracked ? tracks.length : nativeFallbackBudget;
  zx._setTrackedDecoderFallbackBudget(nativeBatchHandle, appliedFallbackBudget);
  const count = decode(
    nativeBatchHandle,
    ptr,
    width,
    height,
    stride,
    nativeResultsPtr,
    tracks.length,
    nativeOutputPtr,
    NATIVE_BATCH_OUTPUT_BYTES,
    nativeMetricsPtr
  );
  if (count < 0) return void 0;
  const view = new DataView(zx.HEAPU8.buffer);
  const metrics = {
    anchorMs: view.getFloat64(nativeMetricsPtr, true),
    samplingMs: view.getFloat64(nativeMetricsPtr + 8, true),
    bitExtractionMs: view.getFloat64(nativeMetricsPtr + 16, true),
    crcMs: view.getFloat64(nativeMetricsPtr + 24, true),
    rsFallbackMs: view.getFloat64(nativeMetricsPtr + 32, true),
    totalMs: view.getFloat64(nativeMetricsPtr + 40, true),
    tracks: view.getUint32(nativeMetricsPtr + 48, true),
    samples: view.getUint32(nativeMetricsPtr + 52, true),
    successful: view.getUint32(nativeMetricsPtr + 56, true),
    misses: view.getUint32(nativeMetricsPtr + 60, true),
    crcFastSuccesses: view.getUint32(nativeMetricsPtr + 64, true),
    rsFallbacks: view.getUint32(nativeMetricsPtr + 68, true)
  };
  if (!strictTracked) {
  const crcTracks = tracks.reduce((count2, track) => count2 + Number(Boolean(track.crc32)), 0);
  const fastEnough = crcTracks > 0 && metrics.crcFastSuccesses >= Math.ceil(crcTracks * 0.8);
  nativeFallbackBudget = fastEnough ? 0 : 1;
}
  const pending = [];
  let outputEnd = 0;
  for (let index = 0; index < count; index++) {
    const at = nativeResultsPtr + index * NATIVE_TRACK_RESULT_BYTES;
    const id = view.getInt32(at, true);
    const status = view.getInt32(at + 4, true);
    const bytesOffset = view.getInt32(at + 8, true);
    const bytesLength = view.getInt32(at + 12, true);
    const misses = view.getInt32(at + 16, true);
    const dx = view.getFloat32(at + 24, true);
    const dy = view.getFloat32(at + 28, true);
    const mapped = byId.get(id);
    if (!mapped) continue;
    const slot = mapped.nativeSlot;
    if (misses >= 3 && slot >= 0) nativeRefresh.add(slot);
    if (status !== NATIVE_TRACK_OK || bytesOffset < 0 || bytesLength <= 0) continue;
    const rawView = zx.HEAPU8.subarray(nativeOutputPtr + bytesOffset, nativeOutputPtr + bytesOffset + bytesLength);
    const packet = mapped.input.crc32 ? parseVerifiedFramePayload(rawView) : parseFrame(rawView);
    if (!packet || mapped.input.slot !== void 0 && packet.header.slotIndex !== mapped.input.slot) {
      if (slot >= 0) nativeRefresh.add(slot);
      continue;
    }
    outputEnd = Math.max(outputEnd, bytesOffset + bytesLength);
    pending.push({ mapped, bytesOffset, bytesLength, dx, dy, header: packet.header });
  }
  const output = outputEnd ? zx.HEAPU8.slice(nativeOutputPtr, nativeOutputPtr + outputEnd) : new Uint8Array(0);
  const symbols = pending.map(({ mapped, bytesOffset, bytesLength, dx, dy, header }) => {
    const quad = translatedQuad(mapped.configured.baseQuad, dx, dy);
    return {
      bytes: output.subarray(bytesOffset, bytesOffset + bytesLength),
      box: boundsOf(quad, 0, 0),
      quad,
      modules: mapped.input.dim,
      tracked: true,
      crc32: mapped.input.crc32,
      verifiedPayload: mapped.input.crc32,
      header
    };
  });
  return { symbols, attempted: true, metrics, outputBuffer: output.buffer };
}
let qrGeneratorPromise;
function localQuad(q, ox, oy) {
  const move = (point) => ({ x: point.x - ox, y: point.y - oy });
  return {
    topLeft: move(q.topLeft),
    topRight: move(q.topRight),
    bottomRight: move(q.bottomRight),
    bottomLeft: move(q.bottomLeft)
  };
}
function globalQuad(q, ox, oy) {
  return shifted(q, ox, oy);
}
function quadMaxDelta(a, b) {
  if (!a || !b) return null;
  return Math.max(...["topLeft", "topRight", "bottomRight", "bottomLeft"].map((name) =>
    Math.hypot(a[name].x - b[name].x, a[name].y - b[name].y)
  ));
}
function sampledMatrixStats(sampled, expected, dim) {
  if (!sampled || sampled.length !== expected.length) {
    return { valid: false, mismatches: expected.length, total: expected.length, percent: 100, bounds: null };
  }
  let mismatches = 0;
  let minX = dim, minY = dim, maxX = -1, maxY = -1;
  for (let index = 0; index < expected.length; index++) {
    if (Number(Boolean(sampled[index])) === expected[index]) continue;
    mismatches++;
    const x = index % dim;
    const y = Math.floor(index / dim);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return {
    valid: true,
    mismatches,
    total: expected.length,
    percent: mismatches / Math.max(1, expected.length) * 100,
    bounds: mismatches ? [minX, minY, maxX, maxY] : null
  };
}
async function diagnoseTrackedSampler(zx, ptr, width, height, ox, oy, track, nativeSlot, result) {
  try {
    const version = (result.modules - 17) / 4;
    if (!Number.isInteger(version) || version < 1 || version > 40 || typeof zx.trackedMatrix !== "function") return null;
    qrGeneratorPromise ??= import("../vendor/qrcode.js");
    const { default: QRCode } = await qrGeneratorPromise;
    const bytes = Uint8Array.from(result.bytes);
    const expectedQr = QRCode.create([{ data: bytes, mode: "byte" }], {
      errorCorrectionLevel: "L",
      version,
      maskPattern: 4
    });
    const dim = expectedQr.modules.size;
    if (dim !== result.modules) return { slot: track.slot, dim: result.modules, error: `regenerated dimension ${dim}` };
    const expected = Uint8Array.from(expectedQr.modules.data, (value) => value ? 1 : 0);
    const freshGlobal = globalQuad(result.position, ox, oy);
    const cachedGlobal = nativeConfigured[nativeSlot]?.baseQuad ?? track.quad;
    const currentGlobal = track.quad;
    const sample = (quad) => sampledMatrixStats(
      zx.trackedMatrix(
        ptr,
        width,
        height,
        dim,
        quad.topLeft.x,
        quad.topLeft.y,
        quad.topRight.x,
        quad.topRight.y,
        quad.bottomRight.x,
        quad.bottomRight.y,
        quad.bottomLeft.x,
        quad.bottomLeft.y
      ),
      expected,
      dim
    );
    const cached = sample(localQuad(cachedGlobal, ox, oy));
    const current = sample(localQuad(currentGlobal, ox, oy));
    const fresh = sample(result.position);
    let classification = "frame/sampler mismatch";
    if (fresh.mismatches === 0 && current.mismatches === 0 && cached.mismatches > 0) classification = "stale native geometry";
    else if (fresh.mismatches === 0 && current.mismatches > 0) classification = "lattice geometry mismatch";
    else if (fresh.mismatches === 0 && current.mismatches === 0 && cached.mismatches === 0) classification = "native fast-path mismatch";
    return {
      slot: track.slot,
      dim,
      classification,
      cached,
      current,
      fresh,
      cachedDeltaPx: quadMaxDelta(cachedGlobal, freshGlobal),
      currentDeltaPx: quadMaxDelta(currentGlobal, freshGlobal)
    };
  } catch (error) {
    return { slot: track.slot, dim: result.modules, error: error instanceof Error ? error.message : String(error) };
  }
}
function projectedNeighbor(q, dx, dy, stride) {
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
ctx.onmessage = async (e) => {
  const startedAt = performance.now();
  const { id, buf, videoFrame, cropX = 0, cropY = 0, w = 0, h = 0, ox = 0, oy = 0, full = true, quad, dim, tracks, isolated = false, oracle = false, oracleSeeds = [], sentAt, pixelFormat = "rgba", yOffset: messageYOffset = 0, yStride: messageYStride = 0, payloadBytes = 0, strictTracked = false, diagnoseSampler = false } = e.data;
  const workerWaitMs = sentAt === void 0 ? 0 : Math.max(0, startedAt - sentAt);
  let readFullAttempts = 0;
  let ownedVideoFrame = videoFrame;
  try {
    const usedDirectFrame = Boolean(ownedVideoFrame);
    // A persistent native miss is a local decoder problem, not a reason to
    // wait for a whole-grid recovery scan. After two misses, copy this same
    // bounded crop as RGBA so the robust stock decoder can rescue/re-anchor it.
    const robustTrackedRecovery = !full && Array.isArray(tracks) && tracks.some((track) => (track.misses ?? 0) >= 2);
    let frameCopyMs = 0;
    let inputOffset = pixelFormat === "y8" ? messageYOffset : 0;
    let inputStride = pixelFormat === "y8" ? messageYStride || w : w * 4;
    let decodePixelFormat = pixelFormat;
    let pixels;
    const zx = await ready;
    let ptr;
    if (ownedVideoFrame) {
      const rect = { x: cropX, y: cropY, width: w, height: h };
      const copyAsRgba = pixelFormat !== "y8" || robustTrackedRecovery;
      const copyOptions = copyAsRgba ? { rect, format: "RGBA" } : { rect };
      const allocationBytes = ownedVideoFrame.allocationSize(copyOptions);
      ptr = inputBuffer(zx, allocationBytes);
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
      ownedVideoFrame.close();
      ownedVideoFrame = null;
    } else {
      const byteLength = pixelFormat === "y8" ? Math.min(buf.byteLength, payloadBytes || inputOffset + Math.max(0, h - 1) * inputStride + w) : buf.byteLength;
      pixels = new Uint8Array(buf, 0, byteLength);
      ptr = inputBuffer(zx, pixels.byteLength);
      zx.HEAPU8.set(pixels, ptr);
    }
    const pw = w;
    const ph = h;
    const symbols = [];
    const sightings = [];
    const samplerDiagnostics = [];
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
        return parsed ? [{ quad: seed.quad, modules: seed.modules, layoutId: parsed.header.layoutId, slot: parsed.header.slotIndex }] : [];
      });
      seeds.push(...oracleSeeds);
      for (const seed of seeds) {
        const layout = gridLayoutById(seed.layoutId);
        if (!layout) continue;
        const sx = seed.slot % layout.cols;
        const sy = Math.floor(seed.slot / layout.cols);
        const ratio = (seed.modules + 1) / seed.modules;
        for (let slot = 0; slot < layout.cols * layout.rows; slot++) {
          const dx = slot % layout.cols - sx;
          const dy = Math.floor(slot / layout.cols) - sy;
          const predicted = projectedNeighbor(seed.quad, dx, dy, ratio);
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
    if (!full && (tracks == null ? void 0 : tracks.length)) {
      const native = decodeNativeBatch(
        zx,
        ptr + inputOffset,
        pw,
        ph,
        ox,
        oy,
        tracks,
        decodePixelFormat,
        inputStride,
        strictTracked
      );
      const nativeSymbols = native?.symbols ?? [];
      const robustFallback = robustTrackedRecovery && decodePixelFormat === "rgba" && nativeSymbols.length === 0;
      if (!robustFallback && (native || usedDirectFrame)) {
        const directFrameFailed = usedDirectFrame && !native;
        const reply = {
          id,
          symbols: nativeSymbols,
          sightings,
          full: false,
          trackedAttempted: native?.attempted ?? true,
          trackedHit: nativeSymbols.length > 0,
          fallbackAttempted: false,
          fallbackSucceeded: false,
          readFullAttempts: 0,
          workerWaitMs,
          targetedAttempts: 0,
          targetedPixels: 0,
          targetedSuccesses: 0,
          frameCopyMs,
          nativeMetrics: native?.metrics,
          directFrameFailed,
          latencyMs: performance.now() - startedAt
        };
        const transfer = native?.outputBuffer && nativeSymbols.length ? [native.outputBuffer] : [];
        ctx.postMessage(reply, transfer);
        return;
      }
      // Native tracking has repeatedly missed this known crop. Run the robust
      // QR detector only inside the bounded lane crop, then feed its fresh quad
      // back through the normal lattice update. This is deliberately local.
      readFullAttempts++;
      const decoded = zx.readFull(ptr, pw, ph, true, Math.min(16, Math.max(1, tracks.length)), false);
      try {
        const expectedSlots = new Set(tracks.flatMap((track) => track.slot === void 0 ? [] : [track.slot]));
        const decodedSlots = /* @__PURE__ */ new Set();
        for (let i = 0; i < decoded.size(); i++) {
          const result = decoded.get(i);
          if (!result.valid || !result.bytes.length) continue;
          const packet = parseFrame(result.bytes);
          const slot = packet == null ? void 0 : packet.header.slotIndex;
          if (!packet || slot !== void 0 && expectedSlots.size && !expectedSlots.has(slot) || slot !== void 0 && decodedSlots.has(slot)) continue;
          if (slot !== void 0) decodedSlots.add(slot);
          const trackIndex = tracks.findIndex((track) => track.slot === slot);
          if (trackIndex >= 0) {
            // The robust decoder just gave us a fresh quad. Never keep using a
            // native sample map built from the geometry that needed recovery.
            nativeRefresh.add(trackIndex);
            if (diagnoseSampler) {
              const diagnostic = await diagnoseTrackedSampler(zx, ptr, pw, ph, ox, oy, tracks[trackIndex], trackIndex, result);
              if (diagnostic) samplerDiagnostics.push(diagnostic);
            }
          }
          symbols.push({
            bytes: result.bytes,
            box: boundsOf(result.position, ox, oy),
            quad: shifted(result.position, ox, oy),
            modules: result.modules,
            tracked: false
          });
        }
      } finally {
        decoded.delete();
      }
      ctx.postMessage({
        id,
        symbols,
        sightings,
        full: false,
        trackedAttempted: true,
        trackedHit: false,
        fallbackAttempted: true,
        fallbackSucceeded: symbols.length > 0,
        readFullAttempts,
        workerWaitMs,
        frameCopyMs,
        nativeMetrics: native?.metrics,
        samplerDiagnostics,
        latencyMs: performance.now() - startedAt
      });
      return;
    }
    let trackedHit = false;
    let trackedAttempted = false;
    let fallbackAttempted = false;
    if (!full && quad && dim) {
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
        symbols.push({
          bytes: r.bytes,
          box: boundsOf(r.position, ox, oy),
          quad: shifted(r.position, ox, oy),
          modules: r.modules,
          tracked: true
        });
        trackedHit = true;
      }
    }
    if (shouldRunFullDecode(full, trackedAttempted, trackedHit)) {
      fallbackAttempted = !full;
      const appendResults = (vec, includeErrors) => {
        try {
          for (let i = 0; i < vec.size(); i++) {
            const r = vec.get(i);
            if (r.valid && r.bytes.length > 0) {
              symbols.push({
                bytes: r.bytes,
                box: boundsOf(r.position, ox, oy),
                quad: shifted(r.position, ox, oy),
                modules: r.modules,
                tracked: false
              });
            } else if (includeErrors) {
              const box = boundsOf(r.position, ox, oy);
              if (box.w > 0 && box.h > 0) sightings.push(box);
            }
          }
        } finally {
          vec.delete();
        }
      };
      if (full) {
        readFullAttempts++;
        appendResults(zx.readFull(ptr, pw, ph, true, 16, false), false);
        if (symbols.length === 0) {
          readFullAttempts++;
          appendResults(zx.readFull(ptr, pw, ph, true, 24, true), true);
        }
      } else {
        readFullAttempts++;
        appendResults(zx.readFull(ptr, pw, ph, true, isolated ? 1 : 2, false), false);
      }
    }
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