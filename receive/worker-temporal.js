import { parseFrame } from "../shared/protocol.js";
import { TemporalQrStitcher, temporalEnabledForCount } from "./temporal-qr-stitch.js";

const scope = self;
const nativePostMessage = scope.postMessage.bind(scope);
const temporalStitcher = new TemporalQrStitcher();
const scalarCodec = new URL(import.meta.url).searchParams.has("scalar");
let activeCapture = null;
let temporalCodecPromise;
let syntheticPtr = 0;
let syntheticCapacity = 0;

function postNative(message, transfer) {
  if (transfer?.length) nativePostMessage(message, transfer);
  else nativePostMessage(message);
}

// Only low-count jobs with a successfully snapshotted Y plane are intercepted.
// Search/acquisition and dense workers never instantiate this module at all, and
// a low-count snapshot failure falls straight through to the production reply.
scope.postMessage = (message, transfer) => {
  const capture = activeCapture;
  if (capture?.retainedY && message?.id === capture.id && !message.preflight) {
    capture.final = { message, transfer };
    return;
  }
  postNative(message, transfer);
};

const productionWorkerUrl = scalarCodec ? "./worker.js?scalar=1" : "./worker.js";
await import(productionWorkerUrl);
const productionOnMessage = scope.onmessage;

function temporalCodec() {
  if (!temporalCodecPromise) {
    temporalCodecPromise = import(scalarCodec ? "../codec/scalar/airgapper_codec.js" : "../codec/airgapper_codec.js")
      .then(({ default: AirGapperCodec }) => AirGapperCodec());
  }
  return temporalCodecPromise;
}

function ensureSyntheticBuffer(zx, bytes) {
  if (syntheticPtr && bytes <= syntheticCapacity) return syntheticPtr;
  const next = zx._malloc(bytes);
  if (!next) return 0;
  if (syntheticPtr) zx._free(syntheticPtr);
  syntheticPtr = next;
  syntheticCapacity = bytes;
  return syntheticPtr;
}

function renderSyntheticGrid(zx, grid, dim) {
  const scale = 3;
  const quietModules = 4;
  const size = (dim + quietModules * 2) * scale;
  const bytes = size * size;
  const ptr = ensureSyntheticBuffer(zx, bytes);
  if (!ptr) return null;
  zx.HEAPU8.fill(255, ptr, ptr + bytes);
  const quiet = quietModules * scale;
  for (let my = 0; my < dim; my++) {
    const sourceRow = my * dim;
    const targetY = quiet + my * scale;
    for (let mx = 0; mx < dim; mx++) {
      const value = grid[sourceRow + mx];
      const targetX = quiet + mx * scale;
      for (let sy = 0; sy < scale; sy++) {
        const row = ptr + (targetY + sy) * size + targetX;
        zx.HEAPU8.fill(value, row, row + scale);
      }
    }
  }
  return { ptr, size };
}

function decodeSyntheticGrid(zx, grid, dim, expectedSlot) {
  const synthetic = renderSyntheticGrid(zx, grid, dim);
  if (!synthetic) return null;
  const decoded = zx.readDenseY(synthetic.ptr, synthetic.size, synthetic.size, synthetic.size, 1);
  try {
    for (let i = 0; i < decoded.size(); i++) {
      const result = decoded.get(i);
      if (!result.valid || !result.bytes?.length) continue;
      const bytes = Uint8Array.from(result.bytes);
      const packet = parseFrame(bytes);
      if (!packet || packet.header.slotIndex !== expectedSlot) continue;
      return { bytes, header: packet.header, modules: result.modules || dim };
    }
  } finally {
    decoded.delete();
  }
  return null;
}

function boundsOf(quad) {
  if (!quad) return null;
  const points = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];
  if (!points.every((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y))) return null;
  const left = Math.min(...points.map((point) => point.x));
  const top = Math.min(...points.map((point) => point.y));
  const right = Math.max(...points.map((point) => point.x));
  const bottom = Math.max(...points.map((point) => point.y));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

function decodedSlots(message, tracks) {
  const slots = new Set();
  for (const symbol of message?.symbols ?? []) {
    let slot = Number(symbol?.header?.slotIndex);
    if (!Number.isInteger(slot) && symbol?.bytes?.length) {
      try { slot = Number(parseFrame(symbol.bytes)?.header?.slotIndex); } catch {}
    }
    if (Number.isInteger(slot)) slots.add(slot);
  }
  if (tracks.length === 1 && (message?.symbols?.length ?? 0) > 0 && !slots.size) {
    const slot = Number(tracks[0]?.slot ?? tracks[0]?.id);
    if (Number.isInteger(slot)) slots.add(slot);
  }
  return slots;
}

async function copyTemporalY(frame, data) {
  const w = Math.max(1, Number(data.w) || 0);
  const h = Math.max(1, Number(data.h) || 0);
  if (frame instanceof ArrayBuffer) {
    const stride = Number(data.yStride) || w;
    const offset = Number(data.yOffset) || 0;
    const required = offset + Math.max(0, h - 1) * stride + w;
    if (stride < w || required > frame.byteLength) return null;
    return { buffer: new Uint8Array(frame.slice(0)), yPtr: offset, stride, width: w, height: h };
  }
  if (!frame || typeof frame.allocationSize !== "function" || typeof frame.copyTo !== "function") return null;
  const rect = {
    x: Math.max(0, Number(data.cropX) || 0),
    y: Math.max(0, Number(data.cropY) || 0),
    width: w,
    height: h
  };
  const options = { rect };
  const bytes = frame.allocationSize(options);
  const buffer = new Uint8Array(bytes);
  const planes = await frame.copyTo(buffer, options);
  const y = planes?.[0];
  if (!y || y.stride < w) return null;
  return { buffer, yPtr: y.offset, stride: y.stride, width: w, height: h };
}

function hasUsefulTemporalHistory(tracks, sourceSequence) {
  const currentSequence = Number(sourceSequence);
  if (!Number.isInteger(currentSequence)) return false;
  return tracks.some((track) => {
    const slot = Number(track?.slot ?? track?.id);
    const dim = Math.round(Number(track?.dim));
    if (!Number.isInteger(slot) || !Number.isInteger(dim)) return false;
    return (temporalStitcher.history.get(slot) ?? []).some((previous) => {
      const delta = currentSequence - Number(previous?.sourceSequence);
      return previous?.dim === dim && delta >= 1 && delta <= 2;
    });
  });
}

async function augmentLowCountResult(capture) {
  const { data, tracks, retainedY, final } = capture;
  if (!final || !retainedY) return final;
  const already = decodedSlots(final.message, tracks);
  const needsRecovery = already.size < tracks.length;
  // Always record the current physical module sample. The second codec is only
  // loaded when an adjacent historical sample exists and ordinary QR decoding
  // actually missed a low-count slot.
  const canStitch = needsRecovery && hasUsefulTemporalHistory(tracks, data.sourceSequence);
  const zx = canStitch ? await temporalCodec() : null;
  const recovered = temporalStitcher.recover({
    heap: retainedY.buffer,
    yPtr: retainedY.yPtr,
    width: retainedY.width,
    height: retainedY.height,
    stride: retainedY.stride,
    ox: Number(data.ox) || 0,
    oy: Number(data.oy) || 0,
    tracks,
    sourceSequence: data.sourceSequence,
    decodedSlots: already,
    decodeGrid: zx ? (grid, dim, slot) => decodeSyntheticGrid(zx, grid, dim, slot) : void 0
  });
  for (const symbol of recovered.symbols) {
    const quad = symbol.track.quad;
    final.message.symbols ??= [];
    final.message.symbols.push({
      bytes: symbol.bytes,
      box: boundsOf(quad),
      quad,
      modules: symbol.modules || symbol.track.dim,
      tracked: true,
      geometryMeasured: false,
      decodePath: "temporal-stitch",
      crc32: true,
      verifiedPayload: true,
      header: symbol.header,
      temporalSeam: symbol.seam,
      temporalOrientation: symbol.orientation
    });
  }
  if (recovered.metrics.attempts || recovered.metrics.hits || recovered.metrics.sampled || recovered.metrics.skipped) {
    final.message.guidedMetrics = {
      ...(final.message.guidedMetrics ?? {}),
      temporalStitchAttempts: recovered.metrics.attempts,
      temporalStitchHits: recovered.metrics.hits,
      temporalStitchSampled: recovered.metrics.sampled,
      temporalStitchSkipped: recovered.metrics.skipped,
      temporalStitchSeam: recovered.metrics.seam,
      temporalStitchOrientation: recovered.metrics.orientation,
      temporalStitchSourceDelta: recovered.metrics.sourceDelta
    };
  }
  if (recovered.metrics.hits) {
    final.message.trackedAttempted = true;
    final.message.trackedHit = true;
    final.message.fallbackAttempted = true;
    final.message.fallbackSucceeded = true;
    final.message.pixelPath = "y8-temporal-stitch";
  }
  return final;
}

scope.onmessage = async (event) => {
  const data = event.data ?? {};
  const tracks = Array.isArray(data.tracks) ? data.tracks : [];
  const lowCount = temporalEnabledForCount(tracks.length) && !data.full && data.pixelFormat === "y8";
  if (!lowCount && tracks.length > 2) temporalStitcher.reset();

  // Snapshot low-count luminance immediately while the transferred VideoFrame
  // is unquestionably live. copyTo is non-destructive, so production worker.js
  // still receives and owns the original frame. Keeping only plain bytes avoids
  // holding a cloned VideoFrame across WASM decode and eliminates camera-frame
  // lifetime/GC stalls.
  let retainedY = null;
  if (lowCount) {
    try { retainedY = await copyTemporalY(data.videoFrame, data); } catch {}
  }

  const capture = { id: data.id, data, tracks, retainedY, final: null };
  activeCapture = capture;
  try {
    await productionOnMessage.call(scope, event);
  } finally {
    if (activeCapture === capture) activeCapture = null;
  }

  // If the Y snapshot failed, the production final was never intercepted and
  // has already gone to the main thread. Otherwise augment exactly that final.
  if (!retainedY) return;
  try {
    const final = await augmentLowCountResult(capture);
    if (final) postNative(final.message, final.transfer);
  } catch {
    if (capture.final) postNative(capture.final.message, capture.final.transfer);
  }
};
