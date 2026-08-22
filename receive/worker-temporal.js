import { parseFrame } from "../shared/protocol.js";
import { TemporalQrStitcher, temporalEnabledForCount } from "./temporal-qr-stitch.js";

const scope = self;
const nativePostMessage = scope.postMessage.bind(scope);
const temporalStitcher = new TemporalQrStitcher();
const scalarCodec = new URL(import.meta.url).searchParams.has("scalar");
let activeCapture = null;
let temporalQueue = Promise.resolve();
let temporalCodecPromise;
let syntheticPtr = 0;
let syntheticCapacity = 0;

function postNative(message, transfer) {
  if (transfer?.length) nativePostMessage(message, transfer);
  else nativePostMessage(message);
}

// Production completion is never gated by temporal work. Tap the final reply,
// send it to the main thread immediately, then queue low-count sampling/repair
// as a sidecar. Late CRC-valid salvage is delivered in a separate message that
// WorkerPool understands without reopening or extending the original job.
scope.postMessage = (message, transfer) => {
  const capture = activeCapture;
  if (capture && message?.id === capture.id && !message.preflight) {
    postNative(message, transfer);
    if (capture.retainedFrame) enqueueTemporal(capture, message);
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
    return { buffer: new Uint8Array(frame), yPtr: offset, stride, width: w, height: h };
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

async function processTemporalFrame(capture, productionReply) {
  const { data, tracks, retainedFrame } = capture;
  try {
    const copied = await copyTemporalY(retainedFrame, data);
    if (!copied) return;
    const already = decodedSlots(productionReply, tracks);
    const needsRecovery = already.size < tracks.length;
    const zx = needsRecovery ? await temporalCodec() : null;
    const recovered = temporalStitcher.recover({
      heap: copied.buffer,
      yPtr: copied.yPtr,
      width: copied.width,
      height: copied.height,
      stride: copied.stride,
      ox: Number(data.ox) || 0,
      oy: Number(data.oy) || 0,
      tracks,
      sourceSequence: data.sourceSequence,
      decodedSlots: already,
      decodeGrid: zx ? (grid, dim, slot) => decodeSyntheticGrid(zx, grid, dim, slot) : void 0
    });
    const symbols = recovered.symbols.map((symbol) => {
      const quad = symbol.track.quad;
      return {
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
      };
    });
    const metrics = {
      temporalStitchAttempts: recovered.metrics.attempts,
      temporalStitchHits: recovered.metrics.hits,
      temporalStitchSampled: recovered.metrics.sampled,
      temporalStitchSkipped: recovered.metrics.skipped,
      temporalStitchSeam: recovered.metrics.seam,
      temporalStitchOrientation: recovered.metrics.orientation,
      temporalStitchSourceDelta: recovered.metrics.sourceDelta
    };
    if (symbols.length || recovered.metrics.attempts || recovered.metrics.sampled || recovered.metrics.skipped) {
      postNative({
        id: data.id,
        temporalLate: true,
        sourceSequence: data.sourceSequence,
        opticsEpoch: data.opticsEpoch,
        symbols,
        guidedMetrics: metrics
      });
    }
  } catch {
    // Temporal salvage is opportunistic. It can never suppress or replace the
    // already-delivered production decode result.
  } finally {
    retainedFrame?.close?.();
  }
}

function enqueueTemporal(capture, productionReply) {
  temporalQueue = temporalQueue
    .catch(() => {})
    .then(() => processTemporalFrame(capture, productionReply));
}

scope.onmessage = async (event) => {
  const data = event.data ?? {};
  const tracks = Array.isArray(data.tracks) ? data.tracks : [];
  const lowCount = temporalEnabledForCount(tracks.length) && !data.full && data.pixelFormat === "y8" && !data.repeatFilter;
  let retainedFrame = null;
  if (lowCount && data.videoFrame instanceof ArrayBuffer) {
    try { retainedFrame = data.videoFrame.slice(0); } catch {}
  } else if (lowCount && data.videoFrame && typeof data.videoFrame.clone === "function") {
    try { retainedFrame = data.videoFrame.clone(); } catch {}
  }
  if (!lowCount && tracks.length > 2) temporalStitcher.reset();
  const capture = { id: data.id, data, tracks, retainedFrame };
  activeCapture = capture;
  try {
    await productionOnMessage.call(scope, event);
  } finally {
    if (activeCapture === capture) activeCapture = null;
    // If production threw before posting a final reply, do not leak the clone.
    if (retainedFrame && !capture.queued) retainedFrame.close?.();
  }
};

// Mark capture ownership when its final production reply is observed. This is
// separate from enqueueTemporal so the handler's finally block never closes a
// frame that the sidecar queue still owns.
const originalEnqueueTemporal = enqueueTemporal;
enqueueTemporal = function(capture, productionReply) {
  capture.queued = true;
  return originalEnqueueTemporal(capture, productionReply);
};
