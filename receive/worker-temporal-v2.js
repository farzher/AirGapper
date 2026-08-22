import { parseFrame } from "../shared/protocol.js";
import {
  PRIMARY_SEAMS,
  SECONDARY_SEAMS,
  TemporalQrStitcher,
  stitchModuleRows,
  temporalEnabledForCount
} from "./temporal-qr-stitch.js";
import { sampleModuleGridFast } from "./temporal-fast-sampler.js";

const scope = self;
const temporalStitcher = new TemporalQrStitcher();
const scalarCodec = new URL(import.meta.url).searchParams.has("scalar");
let codecPromise;
let syntheticPtr = 0;
let syntheticCapacity = 0;
let processing = false;

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

function postReply(data, phase, symbols, metrics) {
  scope.postMessage({
    temporalV2: true,
    phase,
    token: data.token,
    generation: data.generation,
    id: data.id,
    sourceSequence: data.sourceSequence,
    symbols,
    guidedMetrics: metrics
  }, symbols.flatMap((symbol) => symbol.bytes?.buffer ? [symbol.bytes.buffer] : []));
}

async function sampleFrame(data) {
  const started = performance.now();
  const metrics = {
    temporalStitchAttempts: 0,
    temporalStitchHits: 0,
    temporalStitchSampled: 0,
    temporalStitchSkipped: 0,
    temporalSampleMs: 0,
    temporalCopyMs: 0
  };
  const tracks = Array.isArray(data?.tracks) ? data.tracks : [];
  if (!temporalEnabledForCount(tracks.length) || data.full || data.pixelFormat !== "y8") {
    metrics.temporalStitchSkipped++;
    data?.videoFrame?.close?.();
    postReply(data, "sample", [], metrics);
    return;
  }

  let copied = null;
  const copyStarted = performance.now();
  try {
    copied = await copyTemporalY(data.videoFrame, data);
  } finally {
    data.videoFrame?.close?.();
  }
  metrics.temporalCopyMs = performance.now() - copyStarted;
  const currentSequence = Number(data.sourceSequence);
  if (!copied || !Number.isInteger(currentSequence)) {
    metrics.temporalStitchSkipped++;
    metrics.temporalSampleMs = performance.now() - started;
    postReply(data, "sample", [], metrics);
    return;
  }

  let sampledAny = false;
  for (const track of tracks) {
    const slot = Number(track?.slot ?? track?.id);
    if (!Number.isInteger(slot)) continue;
    const current = sampleModuleGridFast(
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
    sampledAny = true;
    metrics.temporalStitchSampled++;
    const prior = temporalStitcher.history.get(slot) ?? [];
    temporalStitcher.history.set(slot,
      [current, ...prior.filter((item) => item.sourceSequence < currentSequence)].slice(0, 4));
  }

  metrics.temporalSampleMs = performance.now() - started;
  // Sampling must return before the next camera frame. Compile the seam decoder
  // in the background after the first usable sample, but never await it here.
  postReply(data, "sample", [], metrics);
  if (sampledAny) temporalCodec().catch(() => {});
}

async function recoverFrame(data) {
  const started = performance.now();
  const metrics = {
    temporalStitchAttempts: 0,
    temporalStitchHits: 0,
    temporalStitchSampled: 0,
    temporalStitchSkipped: 0,
    temporalStitchSeam: void 0,
    temporalStitchOrientation: void 0,
    temporalStitchSourceDelta: void 0,
    temporalRecoverMs: 0
  };
  const symbols = [];
  const currentSequence = Number(data.sourceSequence);
  const missingSlots = new Set((data.missingSlots ?? []).map(Number).filter(Number.isInteger));
  if (!Number.isInteger(currentSequence) || !missingSlots.size) {
    metrics.temporalRecoverMs = performance.now() - started;
    postReply(data, "recover", symbols, metrics);
    return;
  }

  let zx = null;
  try { zx = await temporalCodec(); } catch {}
  if (!zx) {
    metrics.temporalStitchSkipped += missingSlots.size;
    metrics.temporalRecoverMs = performance.now() - started;
    postReply(data, "recover", symbols, metrics);
    return;
  }

  for (const slot of missingSlots) {
    const history = temporalStitcher.history.get(slot) ?? [];
    const current = history.find((item) => Number(item.sourceSequence) === currentSequence);
    if (!current) {
      metrics.temporalStitchSkipped++;
      continue;
    }
    const previousSamples = history.filter((item) => {
      const delta = currentSequence - Number(item.sourceSequence);
      return delta >= 1 && delta <= 2 && item.dim === current.dim &&
        quadDistanceFraction(item.quad, current.quad) <= 0.08;
    });

    let recovered = null;
    pairLoop:
    for (const previous of previousSamples) {
      const delta = currentSequence - Number(previous.sourceSequence);
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
          recovered = {
            ...decoded,
            box: boundsOf(current.quad),
            quad: current.quad,
            tracked: true,
            geometryMeasured: false,
            decodePath: "temporal-stitch",
            crc32: true,
            verifiedPayload: true,
            temporalSeam: seam,
            temporalOrientation: orientation
          };
          break pairLoop;
        }
      }
    }
    if (recovered) symbols.push(recovered);
  }

  metrics.temporalRecoverMs = performance.now() - started;
  postReply(data, "recover", symbols, metrics);
}

async function resetState(data) {
  temporalStitcher.reset();
  postReply(data, "reset", [], {
    temporalStitchAttempts: 0,
    temporalStitchHits: 0,
    temporalStitchSampled: 0,
    temporalStitchSkipped: 0
  });
}

async function processMessage(data) {
  if (data.action === "reset") return resetState(data);
  if (data.action === "recover") return recoverFrame(data);
  return sampleFrame(data);
}

scope.onmessage = (event) => {
  const data = event.data ?? {};
  if (processing) {
    data.videoFrame?.close?.();
    postReply(data, data.action === "recover" ? "recover" : data.action === "reset" ? "reset" : "sample", [], {
      temporalStitchAttempts: 0,
      temporalStitchHits: 0,
      temporalStitchSampled: 0,
      temporalStitchSkipped: 1
    });
    return;
  }
  processing = true;
  Promise.resolve(processMessage(data)).catch(() => {
    data.videoFrame?.close?.();
    postReply(data, data.action === "recover" ? "recover" : data.action === "reset" ? "reset" : "sample", [], {
      temporalStitchAttempts: 0,
      temporalStitchHits: 0,
      temporalStitchSampled: 0,
      temporalStitchSkipped: 1
    });
  }).finally(() => {
    processing = false;
  });
};
