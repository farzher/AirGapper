function validPoint(point) {
  return Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y));
}

function validQuad(quad) {
  return Boolean(quad && validPoint(quad.topLeft) && validPoint(quad.topRight) &&
    validPoint(quad.bottomRight) && validPoint(quad.bottomLeft));
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
  for (let value = 0; value < 256; value++) {
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

/**
 * Low-count hot sampler. One luma read per QR module, with the projective
 * transform advanced incrementally across each row. The old five-tap sampler
 * performed ~156k projections for a v40 QR; this performs 31,329 and avoids
 * retaining/copying any additional camera frame.
 */
function sampleModuleGridFast(heap, yPtr, width, height, stride, ox, oy, track, sourceSequence) {
  const dim = Math.round(Number(track?.dim));
  if (!validQuad(track?.quad) || !Number.isInteger(dim) || dim < 21 || dim > 177 || dim % 4 !== 1) return null;
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
      if (x >= 0 && y >= 0 && x < width && y < height) value = heap[yPtr + y * stride + x];
      else outside++;
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

export { sampleModuleGridFast };
