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
const temporalStitcher = new TemporalQrStitcher();
const scalarCodec = new URL(import.meta.url).searchParams.has("scalar");
let codecPromise;
let syntheticPtr = 0;
let syntheticCapacity = 0;
let workQueue = Promise.resolve();

function temporalCodec() {
  if (!codecPromise) {
    codecPromise = import(scalarCodec ? "../codec/scalar/airgapper_codec.js" : "../codec/airgapper_codec.js")
      .then(({ default: AirGapperCodec }) => AirGapperCodec());
  }
  return codecPromise;
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

async function copyTemporalY(frame, data) {
  const width = Math.max(1, Number(data.w) || 0);
  const height = Math.max(1, Number(data.h) || 0);
  if (frame instanceof ArrayBuffer) {
    const stride = Number(data.yStride) || width;
    const offset = Number(data.yOffset) || 0;
    const required = offset + Math.max(0, height - 1) * stride + width;
    if (stride < width || required > frame.byteLength) return null;
    return { buffer: new Uint8Array(frame), yPtr: offset, stride, width, height };
  }
  if (!frame || typeof frame.allocationSize !== "function" || typeof frame.copyTo !== "function") return null;
  const rect = {
    x: Math.max(0, Number(data.cropX) || 0),
    y: Math.max(0, Number(data.cropY) || 0),
    width,
    height
  };
  const options = { rect };
  const bytes = frame.allocationSize(options);
  const buffer = new Uint8Array(bytes);
  const planes = await frame.copyTo(buffer, options);
  const y = planes?.[0];
  if (!y || y.stride < width) return null;
  return { buffer, yPtr: y.offset, stride: y.stride, width, height };
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

function ensureSyntheticBuffer(zx, bytes) {
  if (syntheticPtr && bytes <= syntheticCapacity) return syntheticPtr;
  const next = zx._malloc(bytes);
  if (!next) return 0;
  if (syntheticPtr) zx._free(syntheticPtr);
  syntheticPtr = next;
  syntheticCapacity = bytes;
  return syntheticPtr;
}

function decodeSyntheticGrid(zx, grid, dim, expectedSlot) {
  const scale = 3;
  const quietModules = 4;
  const quiet = quietModules * scale;
  const size = (dim + quietModules * 2) * scale;
  const bytes = size * size;
  const ptr = ensureSyntheticBuffer(zx, bytes);
  if (!ptr) return null;
  zx.HEAPU8.fill(255, ptr, ptr + bytes);
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

  const decoded = zx.readDenseY(ptr, size, size, size, 1);
  try {
    for (let i = 0; i < decoded.size(); i++) {
      const result = decoded.get(i);
      if (!result.valid || !result.bytes?.length) continue;
      const output = Uint8Array.from(result.bytes);
      const packet = parseFrame(output);
      if (!packet || Number(packet.header.slotIndex) !== expectedSlot) continue;
      return { bytes: output, header: packet.header, modules: result.modules || dim };
    }
  } finally {
    decoded.delete();
  }
  return null;
}

async function processFrame(data) {
  if (data?.reset) {
    temporalStitcher.reset();
    return;
  }
  const tracks = Array.isArray(data?.tracks) ? data.tracks : [];
  if (!temporalEnabledForCount(tracks.length) || data.full || data.pixelFormat !== "y8") {
    temporalStitcher.reset();
    data?.videoFrame?.close?.();
    return;
  }

  let copied = null;
  try {
    copied = await copyTemporalY(data.videoFrame, data);
  } finally {
    data.videoFrame?.close?.();
  }

  const metrics = {
    temporalStitchAttempts: 0,
    temporalStitchHits: 0,
    temporalStitchSampled: 0,
    temporalStitchSkipped: 0,
    temporalStitchSeam: void 0,
    temporalStitchOrientation: void 0,
    temporalStitchSourceDelta: void 0
  };
  const symbols = [];
  const currentSequence = Number(data.sourceSequence);
  if (!copied || !Number.isInteger(currentSequence)) {
    metrics.temporalStitchSkipped++;
    scope.postMessage({ id: data.id, sourceSequence: data.sourceSequence, temporal: true, symbols, guidedMetrics: metrics });
    return;
  }

  let hasAdjacentHistory = false;
  const sampled = [];
  for (const track of tracks) {
    const slot = Number(track?.slot ?? track?.id);
    if (!Number.isInteger(slot)) continue;
    const current = sampleModuleGrid(
      copied.buffer,
      copied.yPtr,
      copied.width,
      copied.height,
      copied.stride,
      Number(data.ox) || 0,
      Number(data.oy) || 0,
      track,
      currentSequence
    );
    if (!current) {
      metrics.temporalStitchSkipped++;
      continue;
    }
    metrics.temporalStitchSampled++;
    const prior = temporalStitcher.history.get(slot) ?? [];
    if (prior.some((previous) => {
      const delta = currentSequence - Number(previous.sourceSequence);
      return previous.dim === current.dim && delta >= 1 && delta <= 2 &&
        quadDistanceFraction(previous.quad, current.quad) <= 0.08;
    })) hasAdjacentHistory = true;
    sampled.push({ slot, track, current, prior });
  }

  // Frame one can be returned immediately; begin compiling the repair codec in
  // the companion without blocking the normal receiver path or this response.
  if (!hasAdjacentHistory) {
    for (const { slot, current, prior } of sampled) {
      temporalStitcher.history.set(slot,
        [current, ...prior.filter((item) => item.sourceSequence < currentSequence)].slice(0, 2));
    }
    scope.postMessage({ id: data.id, sourceSequence: data.sourceSequence, temporal: true, symbols, guidedMetrics: metrics });
    if (sampled.length) temporalCodec().catch(() => {});
    return;
  }

  let zx = null;
  try { zx = await temporalCodec(); } catch {}
  if (zx) {
    for (const { slot, track, current, prior } of sampled) {
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
            metrics.temporalStitchAttempts++;
            const decoded = decodeSyntheticGrid(zx, grid, current.dim, slot);
            if (!decoded) continue;
            metrics.temporalStitchHits++;
            metrics.temporalStitchSeam = seam;
            metrics.temporalStitchOrientation = orientation;
            metrics.temporalStitchSourceDelta = delta;
            symbols.push({
              ...decoded,
              box: boundsOf(track.quad),
              quad: track.quad,
              tracked: true,
              geometryMeasured: false,
              decodePath: "temporal-stitch",
              crc32: true,
              verifiedPayload: true,
              temporalSeam: seam,
              temporalOrientation: orientation
            });
            break pairLoop;
          }
        }
      }
      temporalStitcher.history.set(slot,
        [current, ...prior.filter((item) => item.sourceSequence < currentSequence)].slice(0, 2));
    }
  } else {
    metrics.temporalStitchSkipped += sampled.length;
    for (const { slot, current, prior } of sampled) {
      temporalStitcher.history.set(slot,
        [current, ...prior.filter((item) => item.sourceSequence < currentSequence)].slice(0, 2));
    }
  }

  scope.postMessage({
    id: data.id,
    sourceSequence: data.sourceSequence,
    temporal: true,
    symbols,
    guidedMetrics: metrics
  }, symbols.flatMap((symbol) => symbol.bytes?.buffer ? [symbol.bytes.buffer] : []));
}

scope.onmessage = (event) => {
  const data = event.data ?? {};
  workQueue = workQueue.then(() => processFrame(data)).catch(() => {
    data.videoFrame?.close?.();
    scope.postMessage({
      id: data.id,
      sourceSequence: data.sourceSequence,
      temporal: true,
      symbols: [],
      guidedMetrics: { temporalStitchAttempts: 0, temporalStitchHits: 0, temporalStitchSampled: 0, temporalStitchSkipped: 1 }
    });
  });
};
