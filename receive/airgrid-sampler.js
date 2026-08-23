import { AIRGRID_PREAMBLE, decodeAirGridLane } from '../shared/airgrid-phy.js';

function quadHomography(quad) {
  const p0 = quad.topLeft, p1 = quad.topRight, p2 = quad.bottomRight, p3 = quad.bottomLeft;
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, dy3 = p0.y - p1.y + p2.y - p3.y;
  let g = 0, h = 0;
  const denominator = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(dx3) > 1e-9 || Math.abs(dy3) > 1e-9) {
    if (Math.abs(denominator) < 1e-9) throw new Error('Degenerate AirGrid quad');
    g = (dx3 * dy2 - dx2 * dy3) / denominator;
    h = (dx1 * dy3 - dx3 * dy1) / denominator;
  }
  return {
    a: p1.x - p0.x + g * p1.x,
    b: p3.x - p0.x + h * p3.x,
    c: p0.x,
    d: p1.y - p0.y + g * p1.y,
    e: p3.y - p0.y + h * p3.y,
    f: p0.y,
    g,
    h
  };
}
function project(h, u, v) {
  const z = h.g * u + h.h * v + 1;
  return { x: (h.a * u + h.b * v + h.c) / z, y: (h.d * u + h.e * v + h.f) / z };
}
function sampleNearest(y8, width, height, x, y) {
  const ix = Math.max(0, Math.min(width - 1, Math.round(x)));
  const iy = Math.max(0, Math.min(height - 1, Math.round(y)));
  return y8[iy * width + ix];
}
function sampleAirGridLane(y8, width, height, homography, profile, laneIndex) {
  const values = new Uint8Array(profile.columns);
  const v = (laneIndex + 0.5) / profile.lanes;
  for (let column = 0; column < profile.columns; column++) {
    const u = (column + 0.5) / profile.columns;
    const point = project(homography, u, v);
    values[column] = sampleNearest(y8, width, height, point.x, point.y);
  }
  // Preamble is known, so it doubles as a per-lane black/white calibration and
  // requires no dedicated optical training rail.
  let black = 0, white = 0, blackCount = 0, whiteCount = 0;
  for (let i = 0; i < AIRGRID_PREAMBLE.length; i++) {
    if (AIRGRID_PREAMBLE[i]) { black += values[i]; blackCount++; }
    else { white += values[i]; whiteCount++; }
  }
  black /= blackCount;
  white /= whiteCount;
  const separation = white - black;
  if (separation < 18) return { bits: null, separation, threshold: (white + black) * 0.5 };
  const threshold = (white + black) * 0.5;
  const bits = new Uint8Array(profile.columns);
  for (let i = 0; i < values.length; i++) bits[i] = values[i] < threshold ? 1 : 0;
  return { bits, separation, threshold };
}
function decodeAirGridY8({ y8, width, height, quad, profile, minSeparation = 18 }) {
  if (!(y8 instanceof Uint8Array) || y8.length < width * height) throw new Error('AirGrid Y8 frame is incomplete');
  const homography = quadHomography(quad);
  const lanes = [];
  for (let laneIndex = 0; laneIndex < profile.lanes; laneIndex++) {
    const sampled = sampleAirGridLane(y8, width, height, homography, profile, laneIndex);
    if (!sampled.bits || sampled.separation < minSeparation) continue;
    const decoded = decodeAirGridLane(sampled.bits, { laneIndex });
    if (decoded) lanes.push({ ...decoded, separation: sampled.separation });
  }
  return lanes;
}

export { decodeAirGridY8, project as projectAirGridPoint, quadHomography, sampleAirGridLane };
