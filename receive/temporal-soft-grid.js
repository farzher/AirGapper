const LOW_COUNT_TEMPORAL_MAX_QR = 2;
const MIN_DIMENSION = 21;
const MAX_DIMENSION = 177;

function validPoint(point) {
  return Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y));
}

function validQuad(quad) {
  return Boolean(quad && validPoint(quad.topLeft) && validPoint(quad.topRight) &&
    validPoint(quad.bottomRight) && validPoint(quad.bottomLeft));
}

function temporalEnabledForTracks(tracks) {
  return Array.isArray(tracks) && tracks.length >= 1 && tracks.length <= LOW_COUNT_TEMPORAL_MAX_QR;
}

function homography(quad, ox = 0, oy = 0) {
  if (!validQuad(quad)) return null;
  const p0x = quad.topLeft.x - ox, p0y = quad.topLeft.y - oy;
  const p1x = quad.topRight.x - ox, p1y = quad.topRight.y - oy;
  const p2x = quad.bottomRight.x - ox, p2y = quad.bottomRight.y - oy;
  const p3x = quad.bottomLeft.x - ox, p3y = quad.bottomLeft.y - oy;
  const sx = p0x - p1x + p2x - p3x;
  const sy = p0y - p1y + p2y - p3y;
  const dx1x = p1x - p2x, dx1y = p1y - p2y;
  const dx2x = p3x - p2x, dx2y = p3y - p2y;
  const denominator = dx1x * dx2y - dx2x * dx1y;
  const g = Math.abs(denominator) < 1e-8 ? 0 : (sx * dx2y - dx2x * sy) / denominator;
  const h = Math.abs(denominator) < 1e-8 ? 0 : (dx1x * sy - sx * dx1y) / denominator;
  return {
    a: p1x - p0x + g * p1x,
    b: p3x - p0x + h * p3x,
    c: p0x,
    d: p1y - p0y + g * p1y,
    e: p3y - p0y + h * p3y,
    f: p0y,
    g,
    h
  };
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

function localQuad(quad, ox = 0, oy = 0) {
  if (!validQuad(quad)) return null;
  const move = (point) => ({ x: point.x - ox, y: point.y - oy });
  return {
    topLeft: move(quad.topLeft),
    topRight: move(quad.topRight),
    bottomRight: move(quad.bottomRight),
    bottomLeft: move(quad.bottomLeft)
  };
}

/**
 * Sample exactly one luminance value at each predicted QR module center.
 *
 * The caller passes the Y plane it already owns. No VideoFrame is retained and
 * no second camera-plane copy is made. Keeping the soft 8-bit luma, rather than
 * immediately collapsing to black/white, lets the temporal decoder use
 * confidence near a rolling-shutter seam without touching source pixels again.
 */
function sampleSoftModuleGrid(heap, yPtr, width, height, stride, ox, oy, track, sourceSequence) {
  const dim = Math.round(Number(track?.dim));
  if (!validQuad(track?.quad) || !Number.isInteger(dim) || dim < MIN_DIMENSION ||
      dim > MAX_DIMENSION || dim % 4 !== 1) return null;
  if (!heap || !Number.isInteger(stride) || stride < width || width < 1 || height < 1) return null;
  const H = homography(track.quad, ox, oy);
  if (!H) return null;

  const total = dim * dim;
  const luma = new Uint8Array(total);
  const histogram = new Uint32Array(256);
  const invDim = 1 / dim;
  const u0 = 0.5 * invDim;
  const du = invDim;
  const nxStep = H.a * du;
  const nyStep = H.d * du;
  const zStep = H.g * du;
  let outside = 0;
  let index = 0;

  for (let my = 0; my < dim; my++) {
    const v = (my + 0.5) * invDim;
    let nx = H.a * u0 + H.b * v + H.c;
    let ny = H.d * u0 + H.e * v + H.f;
    let z = H.g * u0 + H.h * v + 1;
    for (let mx = 0; mx < dim; mx++, index++) {
      const invZ = 1 / z;
      const x = Math.round(nx * invZ);
      const y = Math.round(ny * invZ);
      let value = 255;
      if (x >= 0 && y >= 0 && x < width && y < height)
        value = heap[yPtr + y * stride + x];
      else
        outside++;
      luma[index] = value;
      histogram[value]++;
      nx += nxStep;
      ny += nyStep;
      z += zStep;
    }
  }

  if (outside > total * 0.015) return null;
  const low = histogramQuantile(histogram, total, 0.14);
  const high = histogramQuantile(histogram, total, 0.86);
  const separation = high - low;
  if (separation < 18) return null;
  const threshold = otsuThreshold(histogram, total);
  return {
    slot: Number(track.slot ?? track.id),
    dim,
    luma,
    threshold,
    low,
    high,
    separation,
    quad: localQuad(track.quad, ox, oy),
    sourceSequence: Number(sourceSequence)
  };
}

function hardModules(sample) {
  if (!sample?.luma || !Number.isFinite(Number(sample.threshold))) return null;
  const modules = new Uint8Array(sample.luma.length);
  const threshold = Number(sample.threshold);
  for (let i = 0; i < modules.length; i++) modules[i] = sample.luma[i] <= threshold ? 0 : 255;
  return modules;
}

function moduleConfidence(sample, index) {
  const separation = Math.max(1, Number(sample?.separation) || 1);
  return Math.min(1, Math.abs(Number(sample.luma[index]) - Number(sample.threshold)) / separation * 2);
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
  const mean = names.reduce((sum, name) =>
    sum + Math.hypot(a[name].x - b[name].x, a[name].y - b[name].y), 0) / names.length;
  return mean / scale;
}

function composeTemporalLine(previous, current, centerRow, tiltRows, orientation) {
  if (!previous?.luma || !current?.luma || previous.dim !== current.dim ||
      previous.luma.length !== current.luma.length) return null;
  const dim = current.dim;
  const output = new Uint8Array(dim * dim);
  const prevThreshold = Number(previous.threshold);
  const currThreshold = Number(current.threshold);
  const currentAbove = orientation !== "previous-top/current-bottom";
  let index = 0;
  for (let my = 0; my < dim; my++) {
    for (let mx = 0; mx < dim; mx++, index++) {
      const xNorm = (mx + 0.5) / dim - 0.5;
      const cut = centerRow + tiltRows * xNorm;
      const above = my + 0.5 < cut;
      const useCurrent = currentAbove ? above : !above;
      const sample = useCurrent ? current : previous;
      const threshold = useCurrent ? currThreshold : prevThreshold;
      output[index] = sample.luma[index] <= threshold ? 0 : 255;
    }
  }
  return output;
}

function isLikelyDataModule(dim, x, y) {
  // Exclude the three finder/format corners and timing axes. The remaining
  // interior is dominated by payload/ECC bits, which makes adjacent-frame
  // agreement useful evidence for the shared latent sender page.
  const corner = 12;
  if (x < corner && y < corner) return false;
  if (x >= dim - corner && y < corner) return false;
  if (x < corner && y >= dim - corner) return false;
  if (x === 6 || y === 6) return false;
  return true;
}

function agreementCandidates(previous, current, tiltRows, maxCandidates = 4) {
  if (!previous?.luma || !current?.luma || previous.dim !== current.dim) return [];
  const dim = current.dim;
  const bins = Array.from({ length: dim }, () => ({ same: 0, total: 0 }));
  const pThreshold = Number(previous.threshold);
  const cThreshold = Number(current.threshold);
  for (let y = 0; y < dim; y++) {
    for (let x = 0; x < dim; x++) {
      if (!isLikelyDataModule(dim, x, y)) continue;
      const index = y * dim + x;
      if (moduleConfidence(previous, index) < 0.18 || moduleConfidence(current, index) < 0.18) continue;
      const adjusted = y + 0.5 - tiltRows * ((x + 0.5) / dim - 0.5);
      const bin = Math.max(0, Math.min(dim - 1, Math.floor(adjusted)));
      const p = previous.luma[index] <= pThreshold;
      const c = current.luma[index] <= cThreshold;
      bins[bin].total++;
      bins[bin].same += Number(p === c);
    }
  }

  const scored = [];
  for (let row = 1; row < dim - 1; row++) {
    let same = 0, total = 0;
    for (let d = -1; d <= 1; d++) {
      same += bins[row + d].same;
      total += bins[row + d].total;
    }
    if (total < Math.max(24, dim / 2)) continue;
    const ratio = same / total;
    // Unrelated random payload regions agree ~50%. A real B/B overlap band is
    // dramatically higher, even with optical noise.
    if (ratio >= 0.64) scored.push({ row: row + 0.5, ratio, total });
  }
  scored.sort((a, b) => b.ratio - a.ratio || b.total - a.total);
  const out = [];
  for (const item of scored) {
    if (out.some((row) => Math.abs(row - item.row) < Math.max(3, dim * 0.035))) continue;
    out.push(item.row);
    if (out.length >= maxCandidates) break;
  }
  return out;
}

function pushUniqueCandidate(out, seen, center, tilt, orientation, source) {
  if (!Number.isFinite(center) || !Number.isFinite(tilt)) return;
  const key = `${Math.round(center * 4)}/${Math.round(tilt * 4)}/${orientation}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ centerRow: center, tiltRows: tilt, orientation, source });
}

/**
 * Candidate order is deliberately front-loaded for the steady state:
 * learned line first, then tiny perturbations, then overlap evidence, then a
 * deterministic coarse-to-fine scan. Recovery can stop at a time budget
 * without ever creating an unbounded search queue.
 */
function temporalLineCandidates(previous, current, hint = null, limit = 96) {
  const dim = Number(current?.dim) || 0;
  if (!dim || previous?.dim !== dim) return [];
  const out = [];
  const seen = new Set();
  const orientations = hint?.orientation
    ? [hint.orientation, hint.orientation === "current-top/previous-bottom"
      ? "previous-top/current-bottom" : "current-top/previous-bottom"]
    : ["current-top/previous-bottom", "previous-top/current-bottom"];

  const addFor = (center, tilt, source) => {
    for (const orientation of orientations) {
      pushUniqueCandidate(out, seen, center, tilt, orientation, source);
      if (out.length >= limit) return;
    }
  };

  if (Number.isFinite(Number(hint?.centerRow)) && Number.isFinite(Number(hint?.tiltRows))) {
    const c = Number(hint.centerRow), t = Number(hint.tiltRows);
    addFor(c, t, "learned");
    for (const dc of [1, -1, 2, -2, 4, -4]) {
      addFor(c + dc, t, "learned-near");
      if (out.length >= limit) return out;
    }
    for (const dt of [2, -2, 4, -4, 8, -8]) {
      addFor(c, t + dt, "learned-tilt");
      if (out.length >= limit) return out;
    }
  }

  const tiltSeeds = [];
  const addTilt = (value) => {
    const v = Math.max(-dim * 0.35, Math.min(dim * 0.35, Number(value)));
    if (Number.isFinite(v) && !tiltSeeds.some((item) => Math.abs(item - v) < 0.5)) tiltSeeds.push(v);
  };
  addTilt(hint?.tiltRows ?? 0);
  for (const fraction of [0, 0.045, -0.045, 0.09, -0.09, 0.14, -0.14]) addTilt(dim * fraction);

  for (const tilt of tiltSeeds) {
    for (const center of agreementCandidates(previous, current, tilt, 3)) {
      addFor(center, tilt, "agreement");
      if (out.length >= limit) return out;
    }
  }

  // Van-der-Corput-like center order: middle, quarters, eighths... It gives a
  // useful seam quickly but eventually covers the whole QR rather than the old
  // nine hard-coded fractions.
  const centers = [];
  const levels = Math.ceil(Math.log2(dim));
  for (let level = 0; level <= levels; level++) {
    const parts = 1 << (level + 1);
    for (let odd = 1; odd < parts; odd += 2) {
      const row = dim * odd / parts;
      if (row > 0.5 && row < dim - 0.5) centers.push(row);
    }
  }
  for (const center of centers) {
    for (const tilt of tiltSeeds) {
      addFor(center, tilt, "scan");
      if (out.length >= limit) return out;
    }
  }
  return out;
}

export {
  LOW_COUNT_TEMPORAL_MAX_QR,
  agreementCandidates,
  composeTemporalLine,
  hardModules,
  quadDistanceFraction,
  sampleSoftModuleGrid,
  temporalEnabledForTracks,
  temporalLineCandidates,
  validQuad
};
