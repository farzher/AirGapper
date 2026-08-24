import { GuidedMotionAccumulator } from "../receive/guided-motion.js";

function referenceFit(samples) {
  if (!samples.length) return null;
  if (samples.length === 1) {
    const item = samples[0];
    const shift = Math.hypot(item.dx, item.dy);
    if (shift >= 0.08 && shift <= 4.5) {
      return {
        kind: "translation",
        a: 1, b: 0, tx: item.dx, ty: item.dy,
        dx: item.dx, dy: item.dy,
        samples: 1,
        residual: 0,
        maxShift: shift
      };
    }
    return null;
  }

  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length & 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  const residualFor = (motion, item) => {
    const px = motion.a * item.x - motion.b * item.y + motion.tx;
    const py = motion.b * item.x + motion.a * item.y + motion.ty;
    return Math.hypot(px - (item.x + item.dx), py - (item.y + item.dy));
  };
  const refit = (items) => {
    const meanX = items.reduce((sum, item) => sum + item.x, 0) / items.length;
    const meanY = items.reduce((sum, item) => sum + item.y, 0) / items.length;
    const meanQx = items.reduce((sum, item) => sum + item.x + item.dx, 0) / items.length;
    const meanQy = items.reduce((sum, item) => sum + item.y + item.dy, 0) / items.length;
    let denom = 0, real = 0, imag = 0;
    for (const item of items) {
      const px = item.x - meanX, py = item.y - meanY;
      const qx = item.x + item.dx - meanQx, qy = item.y + item.dy - meanQy;
      denom += px * px + py * py;
      real += px * qx + py * qy;
      imag += px * qy - py * qx;
    }
    const a = denom > 1 ? real / denom : 1;
    const b = denom > 1 ? imag / denom : 0;
    return {
      a, b,
      tx: meanQx - a * meanX + b * meanY,
      ty: meanQy - b * meanX - a * meanY
    };
  };

  const edgeValues = samples.map((item) => item.edge).filter((value) => Number.isFinite(value) && value > 0);
  const medianEdge = edgeValues.length ? median(edgeValues) : 64;
  const minSpan = Math.max(80, medianEdge * 1.25);
  const need = Math.max(2, Math.ceil(samples.length * 0.6));
  let best = null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const item of samples) {
    minX = Math.min(minX, item.x);
    minY = Math.min(minY, item.y);
    maxX = Math.max(maxX, item.x);
    maxY = Math.max(maxY, item.y);
  }
  if (Math.max(maxX - minX, maxY - minY) >= minSpan) {
    const allMotion = refit(samples);
    const allScale = Math.hypot(allMotion.a, allMotion.b);
    const allRotation = Math.abs(Math.atan2(allMotion.b, allMotion.a));
    let allSquared = 0, allMaxResidual = 0, allMaxShift = 0;
    for (const item of samples) {
      const residual = residualFor(allMotion, item);
      const px = allMotion.a * item.x - allMotion.b * item.y + allMotion.tx;
      const py = allMotion.b * item.x + allMotion.a * item.y + allMotion.ty;
      allSquared += residual * residual;
      allMaxResidual = Math.max(allMaxResidual, residual);
      allMaxShift = Math.max(allMaxShift, Math.hypot(px - item.x, py - item.y));
    }
    if (allScale >= 0.975 && allScale <= 1.025 && allRotation <= 0.035 &&
        allMaxResidual <= 1.05 && allMaxShift <= 5.1) {
      best = {
        inliers: samples,
        rms: Math.sqrt(allSquared / samples.length)
      };
    }
  }

  for (let i = 0; !best && i < samples.length; i++) {
    for (let j = i + 1; j < samples.length; j++) {
      const p = samples[i], q = samples[j];
      const ux = q.x - p.x, uy = q.y - p.y;
      const denom = ux * ux + uy * uy;
      if (denom < minSpan * minSpan) continue;
      const vx = q.x + q.dx - (p.x + p.dx);
      const vy = q.y + q.dy - (p.y + p.dy);
      const a = (ux * vx + uy * vy) / denom;
      const b = (ux * vy - uy * vx) / denom;
      const scale = Math.hypot(a, b);
      const rotation = Math.atan2(b, a);
      if (scale < 0.975 || scale > 1.025 || Math.abs(rotation) > 0.035) continue;
      const motion = {
        a, b,
        tx: p.x + p.dx - a * p.x + b * p.y,
        ty: p.y + p.dy - b * p.x - a * p.y
      };
      const inliers = samples.filter((item) => residualFor(motion, item) <= 1.05);
      if (inliers.length < need) continue;
      const rms = Math.sqrt(inliers.reduce((sum, item) => {
        const r = residualFor(motion, item);
        return sum + r * r;
      }, 0) / inliers.length);
      if (!best || inliers.length > best.inliers.length ||
          inliers.length === best.inliers.length && rms < best.rms)
        best = { inliers, rms };
    }
  }

  let wallMotion = null;
  if (best) {
    const motion = refit(best.inliers);
    const scale = Math.hypot(motion.a, motion.b);
    const rotation = Math.atan2(motion.b, motion.a);
    const residuals = best.inliers.map((item) => residualFor(motion, item));
    const maxResidual = Math.max(...residuals);
    const shifts = best.inliers.map((item) => {
      const px = motion.a * item.x - motion.b * item.y + motion.tx;
      const py = motion.b * item.x + motion.a * item.y + motion.ty;
      return { dx: px - item.x, dy: py - item.y };
    });
    const maxShift = Math.max(...shifts.map((item) => Math.hypot(item.dx, item.dy)));
    const dx = shifts.reduce((sum, item) => sum + item.dx, 0) / shifts.length;
    const dy = shifts.reduce((sum, item) => sum + item.dy, 0) / shifts.length;
    if (scale >= 0.975 && scale <= 1.025 && Math.abs(rotation) <= 0.035 &&
        maxResidual <= 1.15 && maxShift <= 5.1) {
      wallMotion = {
        kind: "similarity",
        ...motion,
        dx, dy,
        samples: best.inliers.length,
        residual: Math.sqrt(residuals.reduce((sum, value) => sum + value * value, 0) / residuals.length),
        maxShift
      };
    }
  }

  if (!wallMotion) {
    const dx = median(samples.map((item) => item.dx));
    const dy = median(samples.map((item) => item.dy));
    const coherent = samples.filter((item) => Math.hypot(item.dx - dx, item.dy - dy) <= 0.75);
    if (coherent.length >= need && Math.hypot(dx, dy) <= 4.5) {
      wallMotion = {
        kind: "translation",
        a: 1, b: 0, tx: dx, ty: dy,
        dx, dy,
        samples: coherent.length,
        residual: Math.max(...coherent.map((item) => Math.hypot(item.dx - dx, item.dy - dy))),
        maxShift: Math.hypot(dx, dy)
      };
    }
  }
  return wallMotion;
}

const accumulator = new GuidedMotionAccumulator(128);

function optimizedFit(samples) {
  accumulator.reset();
  for (const sample of samples) accumulator.add(sample.dx, sample.dy, sample.x, sample.y, sample.edge);
  const result = accumulator.fit();
  return result ? { ...result } : null;
}

function assertEquivalent(name, samples) {
  const expected = referenceFit(samples);
  const actual = optimizedFit(samples);
  if (Boolean(expected) !== Boolean(actual)) {
    throw new Error(`${name}: acceptance mismatch\nexpected=${JSON.stringify(expected)}\nactual=${JSON.stringify(actual)}`);
  }
  if (!expected) return;
  if (expected.kind !== actual.kind || expected.samples !== actual.samples) {
    throw new Error(`${name}: categorical mismatch\nexpected=${JSON.stringify(expected)}\nactual=${JSON.stringify(actual)}`);
  }
  for (const field of ["a", "b", "tx", "ty", "dx", "dy", "residual", "maxShift"]) {
    const delta = Math.abs(expected[field] - actual[field]);
    if (!(delta <= 1e-9 || delta <= Math.max(1, Math.abs(expected[field])) * 1e-11)) {
      throw new Error(`${name}: ${field} differs by ${delta}\nexpected=${JSON.stringify(expected)}\nactual=${JSON.stringify(actual)}`);
    }
  }
}

function transformedSamples({ a = 1, b = 0, tx = 0, ty = 0, noise = 0, outliers = [] } = {}) {
  const points = [
    [-220, -130], [0, -140], [230, -125],
    [-240, 0], [0, 0], [250, 10],
    [-215, 145], [5, 150], [225, 135]
  ];
  return points.map(([x, y], index) => {
    const qx = a * x - b * y + tx;
    const qy = b * x + a * y + ty;
    const jitter = noise ? ((index * 37 % 11) - 5) / 5 * noise : 0;
    const outlier = outliers.includes(index);
    return {
      x,
      y,
      dx: qx - x + jitter + (outlier ? 3.7 : 0),
      dy: qy - y - jitter * 0.7 + (outlier ? -3.2 : 0),
      edge: 72 + index % 3
    };
  });
}

assertEquivalent("single-good", [{ x: 0, y: 0, dx: 0.4, dy: -0.25, edge: 70 }]);
assertEquivalent("single-too-small", [{ x: 0, y: 0, dx: 0.01, dy: 0.01, edge: 70 }]);
assertEquivalent("translation", transformedSamples({ tx: 1.7, ty: -1.1, noise: 0.12 }));
assertEquivalent("similarity", transformedSamples({ a: 1.006, b: 0.011, tx: 0.8, ty: -0.5, noise: 0.08 }));
assertEquivalent("ransac-outliers", transformedSamples({ a: 0.997, b: -0.009, tx: -0.9, ty: 1.2, noise: 0.12, outliers: [2, 7] }));
assertEquivalent("too-much-motion", transformedSamples({ tx: 7.5, ty: -2 }));
assertEquivalent("clustered-translation", [
  { x: 0, y: 0, dx: 1.1, dy: -0.4, edge: 80 },
  { x: 15, y: 3, dx: 1.0, dy: -0.45, edge: 80 },
  { x: 28, y: -2, dx: 1.2, dy: -0.35, edge: 80 },
  { x: 40, y: 5, dx: 1.05, dy: -0.5, edge: 80 }
]);

let seed = 0x51f15e;
function random() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 0x100000000;
}

for (let trial = 0; trial < 250; trial++) {
  const count = 2 + Math.floor(random() * 27);
  const angle = (random() - 0.5) * 0.055;
  const scale = 0.982 + random() * 0.036;
  const a = scale * Math.cos(angle);
  const b = scale * Math.sin(angle);
  const tx = (random() - 0.5) * 7.5;
  const ty = (random() - 0.5) * 7.5;
  const samples = [];
  for (let index = 0; index < count; index++) {
    const x = (random() - 0.5) * 700;
    const y = (random() - 0.5) * 500;
    const qx = a * x - b * y + tx;
    const qy = b * x + a * y + ty;
    const noiseX = (random() - 0.5) * 0.55;
    const noiseY = (random() - 0.5) * 0.55;
    const outlier = random() < 0.10;
    samples.push({
      x,
      y,
      dx: qx - x + noiseX + (outlier ? (random() - 0.5) * 7 : 0),
      dy: qy - y + noiseY + (outlier ? (random() - 0.5) * 7 : 0),
      edge: 50 + random() * 55
    });
  }
  assertEquivalent(`random-${trial}`, samples);
}

console.log("AIRGAPPER_GUIDED_MOTION_PASS", JSON.stringify({ trials: 257 }));
