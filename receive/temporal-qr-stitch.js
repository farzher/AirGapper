const LOW_COUNT_TEMPORAL_MAX_QR = 2;
const TEMPORAL_HISTORY = 2;
const PRIMARY_SEAMS = [0.5, 0.3, 0.7, 0.2, 0.8, 0.4, 0.6, 0.1, 0.9];
const SECONDARY_SEAMS = [0.5, 0.33, 0.67];
const MODULE_SAMPLE_OFFSETS = [
  [0, 0],
  [-0.18, 0],
  [0.18, 0],
  [0, -0.18],
  [0, 0.18]
];

function validPoint(point) {
  return Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y));
}

function validQuad(quad) {
  return Boolean(quad && validPoint(quad.topLeft) && validPoint(quad.topRight) &&
    validPoint(quad.bottomRight) && validPoint(quad.bottomLeft));
}

function temporalEnabledForCount(count) {
  return Number.isInteger(count) && count >= 1 && count <= LOW_COUNT_TEMPORAL_MAX_QR;
}

function quadProjector(quad, ox = 0, oy = 0) {
  if (!validQuad(quad)) return null;
  const p0 = { x: quad.topLeft.x - ox, y: quad.topLeft.y - oy };
  const p1 = { x: quad.topRight.x - ox, y: quad.topRight.y - oy };
  const p2 = { x: quad.bottomRight.x - ox, y: quad.bottomRight.y - oy };
  const p3 = { x: quad.bottomLeft.x - ox, y: quad.bottomLeft.y - oy };
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;
  const dx1x = p1.x - p2.x;
  const dx1y = p1.y - p2.y;
  const dx2x = p3.x - p2.x;
  const dx2y = p3.y - p2.y;
  const denominator = dx1x * dx2y - dx2x * dx1y;
  const g = Math.abs(denominator) < 1e-8 ? 0 : (sx * dx2y - dx2x * sy) / denominator;
  const h = Math.abs(denominator) < 1e-8 ? 0 : (dx1x * sy - sx * dx1y) / denominator;
  const a = p1.x - p0.x + g * p1.x;
  const b = p3.x - p0.x + h * p3.x;
  const c = p0.x;
  const d = p1.y - p0.y + g * p1.y;
  const e = p3.y - p0.y + h * p3.y;
  const f = p0.y;
  return (u, v) => {
    const z = g * u + h * v + 1;
    return { x: (a * u + b * v + c) / z, y: (d * u + e * v + f) / z };
  };
}

function median5(a, b, c, d, e) {
  const values = [a, b, c, d, e];
  values.sort((x, y) => x - y);
  return values[2];
}

function histogramQuantile(histogram, total, fraction) {
  const target = Math.max(0, Math.min(total - 1, Math.floor(total * fraction)));
  let seen = 0;
  for (let value = 0; value < histogram.length; value++) {
    seen += histogram[value];
    if (seen > target) return value;
  }
  return 255;
}

function otsuThreshold(histogram, total) {
  let sum = 0;
  for (let value = 0; value < 256; value++) sum += value * histogram[value];
  let backgroundWeight = 0;
  let backgroundSum = 0;
  let bestVariance = -1;
  let best = 127;
  for (let threshold = 0; threshold < 255; threshold++) {
    backgroundWeight += histogram[threshold];
    if (!backgroundWeight) continue;
    const foregroundWeight = total - backgroundWeight;
    if (!foregroundWeight) break;
    backgroundSum += threshold * histogram[threshold];
    const backgroundMean = backgroundSum / backgroundWeight;
    const foregroundMean = (sum - backgroundSum) / foregroundWeight;
    const between = backgroundWeight * foregroundWeight * (backgroundMean - foregroundMean) ** 2;
    if (between > bestVariance) {
      bestVariance = between;
      best = threshold;
    }
  }
  return best;
}

function sampleModuleGrid(heap, yPtr, width, height, stride, ox, oy, track, sourceSequence) {
  const dim = Math.round(Number(track?.dim));
  if (!validQuad(track?.quad) || !Number.isInteger(dim) || dim < 21 || dim > 177 || dim % 4 !== 1) return null;
  if (!heap || !Number.isInteger(stride) || stride < width || width < 1 || height < 1) return null;
  const project = quadProjector(track.quad, ox, oy);
  if (!project) return null;
  const luma = new Uint8Array(dim * dim);
  const histogram = new Uint32Array(256);
  let outside = 0;
  for (let my = 0; my < dim; my++) {
    for (let mx = 0; mx < dim; mx++) {
      const samples = [];
      for (const [dx, dy] of MODULE_SAMPLE_OFFSETS) {
        const p = project((mx + 0.5 + dx) / dim, (my + 0.5 + dy) / dim);
        const x = Math.round(p.x);
        const y = Math.round(p.y);
        if (x < 0 || y < 0 || x >= width || y >= height) {
          outside++;
          samples.push(255);
          continue;
        }
        samples.push(heap[yPtr + y * stride + x]);
      }
      const value = median5(samples[0], samples[1], samples[2], samples[3], samples[4]);
      luma[my * dim + mx] = value;
      histogram[value]++;
    }
  }
  if (outside > dim * dim * MODULE_SAMPLE_OFFSETS.length * 0.015) return null;
  const total = dim * dim;
  const low = histogramQuantile(histogram, total, 0.14);
  const high = histogramQuantile(histogram, total, 0.86);
  if (high - low < 22) return null;
  const threshold = otsuThreshold(histogram, total);
  const modules = new Uint8Array(total);
  for (let i = 0; i < total; i++) modules[i] = luma[i] <= threshold ? 0 : 255;
  return {
    slot: Number(track.slot ?? track.id),
    dim,
    modules,
    quad: track.quad,
    sourceSequence: Number(sourceSequence),
    separation: high - low
  };
}

function quadDistanceFraction(a, b) {
  if (!validQuad(a) || !validQuad(b)) return Infinity;
  const names = ["topLeft", "topRight", "bottomRight", "bottomLeft"];
  const edge = (q, p, r) => Math.hypot(q[p].x - q[r].x, q[p].y - q[r].y);
  const scale = Math.max(1, Math.min(
    edge(a, "topLeft", "topRight"),
    edge(a, "topRight", "bottomRight"),
    edge(a, "bottomRight", "bottomLeft"),
    edge(a, "bottomLeft", "topLeft")
  ));
  const mean = names.reduce((sum, name) => sum + Math.hypot(a[name].x - b[name].x, a[name].y - b[name].y), 0) / names.length;
  return mean / scale;
}

function stitchModuleRows(previous, current, seamRow, orientation) {
  if (!previous || !current || previous.dim !== current.dim || previous.modules.length !== current.modules.length) return null;
  const dim = current.dim;
  const seam = Math.max(1, Math.min(dim - 1, Math.round(seamRow)));
  const output = new Uint8Array(current.modules.length);
  const rowBytes = dim;
  const split = seam * rowBytes;
  if (orientation === "current-top/previous-bottom") {
    output.set(current.modules.subarray(0, split), 0);
    output.set(previous.modules.subarray(split), split);
  } else if (orientation === "previous-top/current-bottom") {
    output.set(previous.modules.subarray(0, split), 0);
    output.set(current.modules.subarray(split), split);
  } else return null;
  return output;
}

function tryTemporalPair(previous, current, decodeGrid, seamFractions = PRIMARY_SEAMS) {
  if (!previous || !current || previous.dim !== current.dim || previous.slot !== current.slot) return { hit: null, attempts: 0 };
  if (quadDistanceFraction(previous.quad, current.quad) > 0.08) return { hit: null, attempts: 0, skipped: "geometry moved" };
  const orientations = ["current-top/previous-bottom", "previous-top/current-bottom"];
  let attempts = 0;
  for (const fraction of seamFractions) {
    const seam = Math.max(1, Math.min(current.dim - 1, Math.round(current.dim * fraction)));
    for (const orientation of orientations) {
      const grid = stitchModuleRows(previous, current, seam, orientation);
      if (!grid) continue;
      attempts++;
      const decoded = decodeGrid(grid, current.dim, current.slot);
      if (decoded) {
        return {
          attempts,
          hit: {
            ...decoded,
            seam,
            seamFraction: seam / current.dim,
            orientation,
            sourceDelta: current.sourceSequence - previous.sourceSequence
          }
        };
      }
    }
  }
  return { hit: null, attempts };
}

class TemporalQrStitcher {
  constructor() {
    this.history = new Map();
  }

  reset() {
    this.history.clear();
  }

  clearSlots(slots) {
    for (const slot of slots) this.history.delete(Number(slot));
  }

  recover({ heap, yPtr, width, height, stride, ox = 0, oy = 0, tracks, sourceSequence, decodedSlots = new Set(), decodeGrid }) {
    const metrics = { attempts: 0, hits: 0, sampled: 0, skipped: 0, seam: void 0, orientation: void 0, sourceDelta: void 0 };
    if (!temporalEnabledForCount(tracks?.length) || typeof decodeGrid !== "function") {
      if ((tracks?.length ?? 0) > LOW_COUNT_TEMPORAL_MAX_QR) this.reset();
      return { symbols: [], metrics };
    }
    this.clearSlots(decodedSlots);
    const symbols = [];
    const currentSequence = Number(sourceSequence);
    if (!Number.isInteger(currentSequence)) return { symbols, metrics };
    for (const track of tracks) {
      const slot = Number(track?.slot ?? track?.id);
      if (!Number.isInteger(slot) || decodedSlots.has(slot)) continue;
      const current = sampleModuleGrid(heap, yPtr, width, height, stride, ox, oy, track, currentSequence);
      if (!current) {
        metrics.skipped++;
        continue;
      }
      metrics.sampled++;
      const prior = this.history.get(slot) ?? [];
      for (const previous of prior) {
        const delta = currentSequence - previous.sourceSequence;
        if (delta < 1 || delta > 2) continue;
        const seams = delta === 1 ? PRIMARY_SEAMS : SECONDARY_SEAMS;
        const result = tryTemporalPair(previous, current, decodeGrid, seams);
        metrics.attempts += result.attempts;
        if (!result.hit) continue;
        metrics.hits++;
        metrics.seam = result.hit.seam;
        metrics.orientation = result.hit.orientation;
        metrics.sourceDelta = result.hit.sourceDelta;
        symbols.push({ ...result.hit, slot, track });
        break;
      }
      const next = [current, ...prior.filter((item) => item.sourceSequence < currentSequence)].slice(0, TEMPORAL_HISTORY);
      this.history.set(slot, next);
    }
    return { symbols, metrics };
  }
}

export {
  LOW_COUNT_TEMPORAL_MAX_QR,
  PRIMARY_SEAMS,
  SECONDARY_SEAMS,
  TemporalQrStitcher,
  sampleModuleGrid,
  stitchModuleRows,
  temporalEnabledForCount,
  tryTemporalPair
};
