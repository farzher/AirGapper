import { parseFrame } from "../shared/protocol.js";
import {
  PRIMARY_SEAMS,
  SECONDARY_SEAMS,
  TemporalQrStitcher,
  sampleModuleGrid,
  stitchModuleRows,
  temporalEnabledForCount
} from "./temporal-qr-stitch.js";

const scope = self;
const nativePostMessage = scope.postMessage.bind(scope);
const temporalStitcher = new TemporalQrStitcher();
const scalarCodec = new URL(import.meta.url).searchParams.has("scalar");
let activeCapture = null;
let internalDecodeId = -1000000;

function postNative(message, transfer) {
  if (transfer?.length) nativePostMessage(message, transfer);
  else nativePostMessage(message);
}

// Only the explicitly specialized 1-2 QR worker uses this wrapper. Search,
// acquisition and dense workers stay on the untouched production worker.js.
scope.postMessage = (message, transfer) => {
  const capture = activeCapture;
  if (capture?.holdFinal && message?.id === capture.id && !message.preflight) {
    capture.final = { message, transfer };
    return;
  }
  postNative(message, transfer);
};

const productionWorkerUrl = scalarCodec ? "./worker.js?scalar=1" : "./worker.js";
await import(productionWorkerUrl);
const productionOnMessage = scope.onmessage;

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

function quadDistanceFraction(a, b) {
  if (!a || !b) return Infinity;
  const names = ["topLeft", "topRight", "bottomRight", "bottomLeft"];
  if (!names.every((name) => Number.isFinite(a[name]?.x) && Number.isFinite(a[name]?.y) &&
      Number.isFinite(b[name]?.x) && Number.isFinite(b[name]?.y))) return Infinity;
  const edge = (q, p, r) => Math.hypot(q[p].x - q[r].x, q[p].y - q[r].y);
  const scale = Math.max(1, Math.min(
    edge(a, "topLeft", "topRight"),
    edge(a, "topRight", "bottomRight"),
    edge(a, "bottomRight", "bottomLeft"),
    edge(a, "bottomLeft", "topLeft")
  ));
  const mean = names.reduce((sum, name) =>
    sum + Math.hypot(a[name].x - b[name].x, a[name].y - b[name].y), 0) / names.length;
  return mean / scale;
}

function renderSyntheticGrid(grid, dim) {
  const scale = 3;
  const quietModules = 4;
  const quiet = quietModules * scale;
  const qrPixels = dim * scale;
  const size = qrPixels + quiet * 2;
  const y = new Uint8Array(size * size);
  y.fill(255);
  for (let my = 0; my < dim; my++) {
    const sourceRow = my * dim;
    const targetY = quiet + my * scale;
    for (let mx = 0; mx < dim; mx++) {
      const value = grid[sourceRow + mx];
      const targetX = quiet + mx * scale;
      for (let sy = 0; sy < scale; sy++) {
        y.fill(value, (targetY + sy) * size + targetX, (targetY + sy) * size + targetX + scale);
      }
    }
  }
  return {
    buffer: y.buffer,
    size,
    quad: {
      topLeft: { x: quiet, y: quiet },
      topRight: { x: quiet + qrPixels, y: quiet },
      bottomRight: { x: quiet + qrPixels, y: quiet + qrPixels },
      bottomLeft: { x: quiet, y: quiet + qrPixels }
    }
  };
}

// Reuse worker.js's already-loaded production codec. Calling its handler on a
// tiny synthetic Y8 QR avoids a second WASM instance entirely, and the normal
// guided decoder + AirGapper CRC remain the acceptance oracle.
async function decodeSyntheticGrid(grid, dim, expectedSlot) {
  const synthetic = renderSyntheticGrid(grid, dim);
  const id = internalDecodeId--;
  const capture = { id, holdFinal: true, final: null };
  const previousCapture = activeCapture;
  activeCapture = capture;
  try {
    await productionOnMessage.call(scope, { data: {
      id,
      videoFrame: synthetic.buffer,
      cropX: 0,
      cropY: 0,
      w: synthetic.size,
      h: synthetic.size,
      ox: 0,
      oy: 0,
      full: false,
      tracks: [{ slot: expectedSlot, dim, quad: synthetic.quad }],
      pixelFormat: "y8",
      yOffset: 0,
      yStride: synthetic.size,
      payloadBytes: synthetic.buffer.byteLength,
      sourceSequence: 0,
      strictHotPath: true,
      guidedDecode: true,
      guidedFallbackMask: 0xffffffff,
      guidedRepairMask: 0xffffffff,
      repeatFilter: false,
      isolated: true
    } });
  } catch {
    return null;
  } finally {
    activeCapture = previousCapture;
  }
  const reply = capture.final?.message;
  for (const symbol of reply?.symbols ?? []) {
    const bytes = symbol?.bytes ? Uint8Array.from(symbol.bytes) : null;
    if (!bytes?.length) continue;
    let header = symbol.header;
    if (!header) {
      try { header = parseFrame(bytes)?.header; } catch {}
    }
    if (Number(header?.slotIndex) !== expectedSlot) continue;
    return { bytes, header, modules: symbol.modules || dim };
  }
  return null;
}

async function recoverTemporal({ retainedY, data, tracks, already }) {
  const metrics = {
    attempts: 0,
    hits: 0,
    sampled: 0,
    skipped: 0,
    seam: void 0,
    orientation: void 0,
    sourceDelta: void 0
  };
  const symbols = [];
  const currentSequence = Number(data.sourceSequence);
  if (!Number.isInteger(currentSequence)) return { symbols, metrics };

  for (const track of tracks) {
    const slot = Number(track?.slot ?? track?.id);
    if (!Number.isInteger(slot)) continue;
    const current = sampleModuleGrid(
      retainedY.buffer,
      retainedY.yPtr,
      retainedY.width,
      retainedY.height,
      retainedY.stride,
      Number(data.ox) || 0,
      Number(data.oy) || 0,
      track,
      currentSequence
    );
    if (!current) {
      metrics.skipped++;
      continue;
    }
    metrics.sampled++;
    const prior = temporalStitcher.history.get(slot) ?? [];

    if (!already.has(slot)) {
      pairLoop:
      for (const previous of prior) {
        const delta = currentSequence - Number(previous.sourceSequence);
        if (delta < 1 || delta > 2 || previous.dim !== current.dim) continue;
        if (quadDistanceFraction(previous.quad, current.quad) > 0.08) continue;
        const seams = delta === 1 ? PRIMARY_SEAMS : SECONDARY_SEAMS;
        for (const fraction of seams) {
          const seam = Math.max(1, Math.min(current.dim - 1, Math.round(current.dim * fraction)));
          for (const orientation of ["current-top/previous-bottom", "previous-top/current-bottom"]) {
            const grid = stitchModuleRows(previous, current, seam, orientation);
            if (!grid) continue;
            metrics.attempts++;
            const decoded = await decodeSyntheticGrid(grid, current.dim, slot);
            if (!decoded) continue;
            metrics.hits++;
            metrics.seam = seam;
            metrics.orientation = orientation;
            metrics.sourceDelta = delta;
            symbols.push({ ...decoded, seam, orientation, sourceDelta: delta, slot, track });
            break pairLoop;
          }
        }
      }
    }

    const next = [current, ...prior.filter((item) => item.sourceSequence < currentSequence)].slice(0, 2);
    temporalStitcher.history.set(slot, next);
  }
  return { symbols, metrics };
}

async function augmentLowCountResult(capture) {
  const { data, tracks, retainedY, final } = capture;
  if (!final || !retainedY) return final;
  const already = decodedSlots(final.message, tracks);
  const recovered = await recoverTemporal({ retainedY, data, tracks, already });

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

  // Snapshot luminance before production owns/closes the transferred frame.
  let retainedY = null;
  if (lowCount) {
    try { retainedY = await copyTemporalY(data.videoFrame, data); } catch {}
  }

  const capture = {
    id: data.id,
    data,
    tracks,
    retainedY,
    holdFinal: Boolean(retainedY),
    final: null
  };
  activeCapture = capture;
  try {
    await productionOnMessage.call(scope, event);
  } finally {
    if (activeCapture === capture) activeCapture = null;
  }

  // Snapshot failure means the ordinary production final already went out.
  if (!retainedY) return;
  try {
    const final = await augmentLowCountResult(capture);
    if (final) postNative(final.message, final.transfer);
  } catch {
    if (capture.final) postNative(capture.final.message, capture.final.transfer);
  }
};
