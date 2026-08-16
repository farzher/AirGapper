import { shouldRunFullDecode } from "../shared/decode-policy.js";
import { parseFrame, parseVerifiedFramePayload } from "../shared/protocol.js";
import { gridLayoutById } from "../shared/grid-layout.js";
const scalarCodec = new URL(import.meta.url).searchParams.has("scalar");
const ready = import(scalarCodec ? "../vendor/decimen-codec-android/decimen_codec.js" : "../vendor/decimen-codec/decimen_codec.js").then(({ default: DecimenCodec }) => DecimenCodec());
const ctx = self;
function validQuad(p) {
  if (!p) return false;
  return [p.topLeft, p.topRight, p.bottomRight, p.bottomLeft].every((point) =>
    point && Number.isFinite(point.x) && Number.isFinite(point.y)
  );
}
function boundsOf(p, ox, oy) {
  if (!validQuad(p)) return null;
  const xs = [p.topLeft.x, p.topRight.x, p.bottomRight.x, p.bottomLeft.x];
  const ys = [p.topLeft.y, p.topRight.y, p.bottomRight.y, p.bottomLeft.y];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x: ox + x, y: oy + y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
function shifted(p, ox, oy) {
  if (!validQuad(p)) return null;
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
const NATIVE_BATCH_MAX_TRACKS = 18;
const NATIVE_TRACK_RESULT_BYTES = 32;
const NATIVE_BATCH_METRICS_BYTES = 128;
const NATIVE_BATCH_OUTPUT_BYTES = 128 * 1024;
const NATIVE_TRACK_OK = 1;
let nativeBatchHandle = 0;
let nativeResultsPtr = 0;
let nativeOutputPtr = 0;
let nativeMetricsPtr = 0;
let nativeConfigured = [];
let nativeCropOrigin = "";
const nativeRefresh = /* @__PURE__ */ new Set();
function ensureNativeBatch(zx) {
  if (nativeBatchHandle) return true;
  nativeBatchHandle = zx._createTrackedDecoder(NATIVE_BATCH_MAX_TRACKS, 177);
  if (!nativeBatchHandle) return false;
  nativeResultsPtr = zx._malloc(NATIVE_BATCH_MAX_TRACKS * NATIVE_TRACK_RESULT_BYTES);
  nativeOutputPtr = zx._malloc(NATIVE_BATCH_OUTPUT_BYTES);
  nativeMetricsPtr = zx._malloc(NATIVE_BATCH_METRICS_BYTES);
  zx._setTrackedDecoderFallbackBudget(nativeBatchHandle, 0);
  return Boolean(nativeResultsPtr && nativeOutputPtr && nativeMetricsPtr);
}
function translatedQuad(q, dx, dy) {
  if (!validQuad(q)) return null;
  const move = (p) => ({ x: p.x + dx, y: p.y + dy });
  return {
    topLeft: move(q.topLeft),
    topRight: move(q.topRight),
    bottomRight: move(q.bottomRight),
    bottomLeft: move(q.bottomLeft)
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
      if (!validQuad(q)) return void 0;
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
function decodeNativeBatch(zx, ptr, width, height, ox, oy, tracks, pixelFormat = "rgba", stride = width * 4) {
  const byId = configureNativeBatch(zx, tracks, ox, oy);
  if (!byId) return void 0;
  const decode = pixelFormat === "y8" ? zx._decodeTrackedBatchY : zx._decodeTrackedBatchRGBA;
  zx._setTrackedDecoderFallbackBudget(nativeBatchHandle, 0);
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
    rsFallbacks: view.getUint32(nativeMetricsPtr + 68, true),
    anchorSuccesses: view.getUint32(nativeMetricsPtr + 72, true),
    anchorMisses: view.getUint32(nativeMetricsPtr + 76, true),
    fastSamplerAttempts: view.getUint32(nativeMetricsPtr + 80, true),
    outOfFrameMisses: view.getUint32(nativeMetricsPtr + 84, true),
    bitstreamFailures: view.getUint32(nativeMetricsPtr + 88, true),
    crcFailures: view.getUint32(nativeMetricsPtr + 92, true),
    fastSamplerSuccesses: view.getUint32(nativeMetricsPtr + 96, true),
    anchorBypassAttempts: view.getUint32(nativeMetricsPtr + 100, true),
    anchorBypassSuccesses: view.getUint32(nativeMetricsPtr + 104, true),
    translationAttempts: view.getUint32(nativeMetricsPtr + 108, true),
    translationSuccesses: view.getUint32(nativeMetricsPtr + 112, true),
    calibrationAttempts: view.getUint32(nativeMetricsPtr + 116, true),
    calibrationSuccesses: view.getUint32(nativeMetricsPtr + 120, true)
  };
  const pending = [];
  let outputEnd = 0;
  for (let index = 0; index < count; index++) {
    const at = nativeResultsPtr + index * NATIVE_TRACK_RESULT_BYTES;
    const id = view.getInt32(at, true);
    const status = view.getInt32(at + 4, true);
    const bytesOffset = view.getInt32(at + 8, true);
    const bytesLength = view.getInt32(at + 12, true);
    const dx = view.getFloat32(at + 24, true);
    const dy = view.getFloat32(at + 28, true);
    const mapped = byId.get(id);
    if (!mapped) continue;
    const slot = mapped.nativeSlot;
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
ctx.onmessage = async (e) => {
  const startedAt = performance.now();
  const { id, buf, videoFrame, cropX = 0, cropY = 0, w = 0, h = 0, ox = 0, oy = 0, full = true, quad, dim, tracks, isolated = false, oracle = false, oracleSeeds = [], sentAt, pixelFormat = "rgba", yOffset: messageYOffset = 0, yStride: messageYStride = 0, payloadBytes = 0, strictHotPath = false, outputMap, thorough = false, acquisitionMode } = e.data;
  const workerWaitMs = sentAt === void 0 ? 0 : Math.max(0, startedAt - sentAt);
  let readFullAttempts = 0;
  let ownedVideoFrame = videoFrame;
  try {
    const usedDirectFrame = Boolean(ownedVideoFrame);
    const robustLaneFirst = !strictHotPath && !full && Array.isArray(tracks) && tracks.length > 0 && (usedDirectFrame || pixelFormat === "rgba");
    const coldTrackCount = !strictHotPath && !full && Array.isArray(tracks)
      ? tracks.filter((track) => (track.misses ?? 0) >= 4).length
      : 0;
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
    if (ownedVideoFrame) {
      const rect = { x: cropX, y: cropY, width: w, height: h };
      const copyAsRgba = pixelFormat !== "y8";
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
      zx.HEAPU8.set(pixels, ptr);
    }
    const pw = w;
    const ph = h;
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
      readFullAttempts++;
      const robustMax = Math.min(NATIVE_BATCH_MAX_TRACKS, Math.max(1, tracks.length));
      const decoded = decodePixelFormat === "y8"
        ? zx.readDenseY(ptr + inputOffset, pw, ph, inputStride, robustMax)
        : zx.readFull(ptr + inputOffset, pw, ph, true, robustMax, false);
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
      const native = decodeNativeBatch(
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
      const nativeSymbols = native?.symbols ?? [];
      const robustFallback = robustTrackedRecovery && nativeSymbols.length < tracks.length;
      if (!robustFallback && (native || usedDirectFrame)) {
        ownedVideoFrame?.close();
        ownedVideoFrame = null;
        const directFrameFailed = usedDirectFrame && !native;
        mapOutputToDisplay(nativeSymbols);
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
          pixelPath: decodePixelFormat,
          directFrameFailed,
          latencyMs: performance.now() - startedAt
        };
        const transfer = native?.outputBuffer && nativeSymbols.length ? [native.outputBuffer] : [];
        ctx.postMessage(reply, transfer);
        return;
      }
      symbols.push(...nativeSymbols);
      // Recovery uses the pixels already copied out of the camera frame. For
      // direct camera input this is Y8, so keep recovery luminance-only instead
      // of retaining/re-reading the live VideoFrame as RGBA.
      readFullAttempts++;
      const recoveryMax = Math.min(NATIVE_BATCH_MAX_TRACKS, Math.max(1, tracks.length));
      const decoded = decodePixelFormat === "y8"
        ? zx.readFullY(ptr + inputOffset, pw, ph, inputStride, true, recoveryMax, false)
        : zx.readFull(ptr + inputOffset, pw, ph, true, recoveryMax, false);
      try {
        const expectedSlots = new Set(tracks.flatMap((track) => track.slot === void 0 ? [] : [track.slot]));
        const decodedSlots = /* @__PURE__ */ new Set(nativeSymbols.flatMap((symbol) => symbol.header?.slotIndex === void 0 ? [] : [symbol.header.slotIndex]));
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
              nativeRefresh.add(trackIndex);
          }
          symbols.push({
            bytes: result.bytes,
            box: boundsOf(recoveredPosition, ox, oy),
            quad: shifted(recoveredPosition, ox, oy),
            modules: result.modules,
            tracked: false,
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
        trackedHit: nativeSymbols.length > 0,
        fallbackAttempted: true,
        fallbackSucceeded: symbols.length > nativeSymbols.length,
        readFullAttempts,
        workerWaitMs,
        frameCopyMs,
        nativeMetrics: native?.metrics,
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
            tracked: true
          });
          trackedHit = true;
        }
      }
    }
    if ((full || !strictHotPath) && shouldRunFullDecode(full, trackedAttempted, trackedHit)) {
      fallbackAttempted = !full;
      const appendResults = (vec, includeErrors) => {
        try {
          for (let i = 0; i < vec.size(); i++) {
            const r = vec.get(i);
            if (r.valid && r.bytes.length > 0 && validQuad(r.position)) {
              symbols.push({
                bytes: r.bytes,
                box: boundsOf(r.position, ox, oy),
                quad: shifted(r.position, ox, oy),
                modules: r.modules,
                tracked: false
              });
            } else if (includeErrors) {
              const box = boundsOf(r.position, ox, oy);
              if (box && box.w > 0 && box.h > 0) sightings.push(box);
            }
          }
        } finally {
          vec.delete();
        }
      };
      if (full) {
        // Acquisition only needs one valid AirGapper packet to learn the
        // layout/slot and seed the lattice. Do not ask ZXing to rediscover an
        // entire 18-QR wall before tracking can begin. Normal seed scans use
        // the cheap finder pass; occasional deep scans enable tryHarder's
        // downscale sweep. The expensive multi-symbol scan is developer-only.
        const fullMode = acquisitionMode ?? (thorough ? "thorough" : "fast");
        const readFull = (tryHarder, maxSymbols, returnErrors) => decodePixelFormat === "y8"
          ? zx.readFullY(ptr + inputOffset, pw, ph, inputStride, tryHarder, maxSymbols, returnErrors)
          : zx.readFull(ptr, pw, ph, tryHarder, maxSymbols, returnErrors);
        if (fullMode === "thorough") {
          readFullAttempts++;
          appendResults(readFull(true, 16, false), false);
          if (symbols.length === 0) {
            readFullAttempts++;
            appendResults(readFull(true, 24, true), true);
          }
        } else {
          readFullAttempts++;
          appendResults(readFull(fullMode === "deep", 1, false), false);
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
