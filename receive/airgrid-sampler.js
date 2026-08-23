import { AIRGRID_PREAMBLE, inspectAirGridLane } from '../shared/airgrid-phy.js';

const now = () => globalThis.performance?.now?.() ?? Date.now();
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
function quantile(values, q) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * q, lo = Math.floor(index), hi = Math.ceil(index), t = index - lo;
  return sorted[lo] * (1 - t) + sorted[hi] * t;
}
function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function projectedSize(quad) {
  return {
    width: (distance(quad.topLeft, quad.topRight) + distance(quad.bottomLeft, quad.bottomRight)) * 0.5,
    height: (distance(quad.topLeft, quad.bottomLeft) + distance(quad.topRight, quad.bottomRight)) * 0.5
  };
}

// The QR acquisition quad is excellent for coarse geometry, but dense AirGrid
// cells can be <2 camera pixels wide. A sub-pixel translation error then turns
// into a large BER. Refine only the global X/Y sampling phase using the known
// 16-bit lane preamble before spending time decoding the full frame.
function refineSamplingPhase(y8, width, height, homography, profile) {
  const projectedWidth = Math.hypot(homography.a, homography.d);
  const projectedHeight = Math.hypot(homography.b, homography.e);
  const pxCellX = projectedWidth / Math.max(1, profile.columns);
  const pxCellY = projectedHeight / Math.max(1, profile.lanes);
  const stepX = Math.max(0.18, Math.min(0.45, pxCellX * 0.18));
  const stepY = Math.max(0.18, Math.min(0.45, pxCellY * 0.18));
  const offsetsX = [-2, -1, 0, 1, 2].map(v => v * stepX);
  const offsetsY = [-2, -1, 0, 1, 2].map(v => v * stepY);
  const laneSamples = Math.min(28, profile.lanes);
  const laneStep = Math.max(1, Math.floor(profile.lanes / laneSamples));
  const columns = AIRGRID_PREAMBLE.length;
  const du = 1 / profile.columns;
  const u0 = du * 0.5;
  let best = { score:-Infinity, dx:0, dy:0, separation:0, errors:Infinity };

  for (const dy of offsetsY) for (const dx of offsetsX) {
    let score = 0;
    let totalErrors = 0;
    let totalSeparation = 0;
    let used = 0;
    for (let laneIndex = Math.floor(laneStep * 0.5); laneIndex < profile.lanes && used < laneSamples; laneIndex += laneStep) {
      const v = (laneIndex + 0.5) / profile.lanes;
      const values = new Uint8Array(columns);
      let black = 0, white = 0, blackCount = 0, whiteCount = 0;
      for (let i = 0; i < columns; i++) {
        const p = project(homography, u0 + i * du, v);
        let ix = Math.round(p.x + dx), iy = Math.round(p.y + dy);
        if (ix < 0 || iy < 0 || ix >= width || iy >= height) continue;
        const value = y8[iy * width + ix];
        values[i] = value;
        if (AIRGRID_PREAMBLE[i]) { black += value; blackCount++; }
        else { white += value; whiteCount++; }
      }
      if (!blackCount || !whiteCount) continue;
      black /= blackCount;
      white /= whiteCount;
      const separation = white - black;
      if (separation <= 0) continue;
      const threshold = (white + black) * 0.5;
      let errors = 0;
      for (let i = 0; i < columns; i++) {
        const bit = values[i] < threshold ? 1 : 0;
        errors += Number(bit !== AIRGRID_PREAMBLE[i]);
      }
      totalErrors += errors;
      totalSeparation += separation;
      // Preamble correctness dominates; separation breaks close ties.
      score += (AIRGRID_PREAMBLE.length - errors) * 24 + Math.min(255, separation);
      used++;
    }
    if (!used) continue;
    score /= used;
    const avgErrors = totalErrors / used;
    const avgSeparation = totalSeparation / used;
    if (score > best.score) best = { score, dx, dy, separation:avgSeparation, errors:avgErrors };
  }
  return best;
}

function sampleAirGridLane(y8, width, height, homography, profile, laneIndex, minSeparation = 18, scratchValues, scratchBits) {
  const columns = profile.columns;
  const values = scratchValues?.length === columns ? scratchValues : new Uint8Array(columns);
  const bits = scratchBits?.length === columns ? scratchBits : new Uint8Array(columns);
  const v = (laneIndex + 0.5) / profile.lanes;
  const du = 1 / columns;
  const u0 = du * 0.5;
  let nx = homography.a * u0 + homography.b * v + homography.c;
  let ny = homography.d * u0 + homography.e * v + homography.f;
  let nz = homography.g * u0 + homography.h * v + 1;
  const dx = homography.a * du, dy = homography.d * du, dz = homography.g * du;
  const affine = Math.abs(dz) < 1e-12 && Math.abs(nz - 1) < 1e-9;
  for (let column = 0; column < columns; column++) {
    const x = affine ? nx : nx / nz;
    const y = affine ? ny : ny / nz;
    let ix = Math.round(x), iy = Math.round(y);
    if (ix < 0) ix = 0; else if (ix >= width) ix = width - 1;
    if (iy < 0) iy = 0; else if (iy >= height) iy = height - 1;
    values[column] = y8[iy * width + ix];
    nx += dx; ny += dy; nz += dz;
  }
  let black = 0, white = 0, blackCount = 0, whiteCount = 0;
  for (let i = 0; i < AIRGRID_PREAMBLE.length; i++) {
    if (AIRGRID_PREAMBLE[i]) { black += values[i]; blackCount++; }
    else { white += values[i]; whiteCount++; }
  }
  black /= blackCount;
  white /= whiteCount;
  let variance = 0;
  for (let i = 0; i < AIRGRID_PREAMBLE.length; i++) {
    const expected = AIRGRID_PREAMBLE[i] ? black : white;
    variance += (values[i] - expected) ** 2;
  }
  const noise = Math.sqrt(variance / AIRGRID_PREAMBLE.length);
  const separation = white - black;
  const threshold = (white + black) * 0.5;
  const contrast = Math.max(1, Math.abs(separation) * 0.5);
  let confidence = 0;
  for (let i = 0; i < columns; i++) confidence += Math.min(1, Math.abs(values[i] - threshold) / contrast);
  confidence /= columns;
  const base = { values, black, white, noise, snr: separation / Math.max(1, noise), separation, threshold, confidence };
  if (separation < minSeparation) return { ...base, bits: null };
  for (let i = 0; i < columns; i++) bits[i] = values[i] < threshold ? 1 : 0;
  return { ...base, bits };
}
function makeRuns(states) {
  const runs = [];
  for (let lane = 0; lane < states.length; lane++) {
    const state = states[lane];
    const key = state.ok ? `s:${state.sequence}` : `f:${state.reason}`;
    const last = runs[runs.length - 1];
    if (last?.key === key) { last.endLane = lane; last.count++; continue; }
    runs.push({ key, startLane: lane, endLane: lane, count: 1, ...(state.ok ? { sequence: state.sequence } : { reason: state.reason }) });
  }
  for (const run of runs) delete run.key;
  return runs;
}
function decodeAirGridY8Detailed({ y8, width, height, quad, profile, minSeparation = 18, includeLaneDiagnostics = false }) {
  if (!(y8 instanceof Uint8Array) || y8.length < width * height) throw new Error('AirGrid Y8 frame is incomplete');
  const started = now();
  const homography = quadHomography(quad);
  const projected = projectedSize(quad);
  const phaseStarted = now();
  const phase = refineSamplingPhase(y8, width, height, homography, profile);
  homography.c += phase.dx;
  homography.f += phase.dy;
  const phaseMs = now() - phaseStarted;
  const lanes = [];
  const states = new Array(profile.lanes);
  const separations = [], noises = [], snrs = [], confidences = [], preambleErrors = [];
  const failures = { lowContrast: 0, preamble: 0, magic: 0, version: 0, crc: 0, short: 0, other: 0 };
  const laneDiagnostics = includeLaneDiagnostics ? [] : null;
  const scratchValues = new Uint8Array(profile.columns);
  const scratchBits = new Uint8Array(profile.columns);
  let sampleMs = 0, decodeMs = 0;
  for (let laneIndex = 0; laneIndex < profile.lanes; laneIndex++) {
    const sampleStarted = now();
    const sampled = sampleAirGridLane(y8, width, height, homography, profile, laneIndex, minSeparation, scratchValues, scratchBits);
    sampleMs += now() - sampleStarted;
    separations.push(sampled.separation);
    noises.push(sampled.noise);
    snrs.push(sampled.snr);
    confidences.push(sampled.confidence);
    if (!sampled.bits) {
      failures.lowContrast++;
      states[laneIndex] = { ok: false, reason: 'lowContrast' };
      if (laneDiagnostics) laneDiagnostics.push({ laneIndex, ok: false, reason: 'lowContrast', separation: sampled.separation, noise: sampled.noise, snr: sampled.snr, confidence: sampled.confidence });
      continue;
    }
    const decodeStarted = now();
    const inspected = inspectAirGridLane(sampled.bits, { laneIndex });
    decodeMs += now() - decodeStarted;
    preambleErrors.push(inspected.preambleErrors ?? AIRGRID_PREAMBLE.length);
    if (!inspected.ok) {
      if (Object.hasOwn(failures, inspected.reason)) failures[inspected.reason]++;
      else failures.other++;
      states[laneIndex] = { ok: false, reason: inspected.reason };
      if (laneDiagnostics) laneDiagnostics.push({ laneIndex, ok: false, reason: inspected.reason, preambleErrors: inspected.preambleErrors, separation: sampled.separation, noise: sampled.noise, snr: sampled.snr, confidence: sampled.confidence });
      continue;
    }
    const lane = { ...inspected.lane, separation: sampled.separation, snr: sampled.snr, confidence: sampled.confidence, preambleErrors: inspected.preambleErrors };
    lanes.push(lane);
    states[laneIndex] = { ok: true, sequence: lane.sequence };
    if (laneDiagnostics) laneDiagnostics.push({ laneIndex, ok: true, sequence: lane.sequence, preambleErrors: inspected.preambleErrors, separation: sampled.separation, noise: sampled.noise, snr: sampled.snr, confidence: sampled.confidence });
  }
  const totalMs = now() - started;
  const capacityBytes = profile.lanes * profile.payloadBytes;
  const bytesDecoded = lanes.length * profile.payloadBytes;
  const sequences = [...new Set(lanes.map(lane => lane.sequence))].sort((a, b) => a - b);
  const diagnostics = {
    frame: {
      width,
      height,
      projectedWidthPx: projected.width,
      projectedHeightPx: projected.height,
      projectedCoverage: projected.width * projected.height / Math.max(1, width * height),
      pxPerCellX: projected.width / profile.columns,
      pxPerCellY: projected.height / profile.lanes,
      phaseX: phase.dx,
      phaseY: phase.dy,
      phasePreambleErrors: phase.errors,
      phaseSeparation: phase.separation
    },
    profile: { ...profile, minSeparation },
    optics: {
      separationMin: Math.min(...separations),
      separationP10: quantile(separations, 0.1),
      separationP50: quantile(separations, 0.5),
      separationP90: quantile(separations, 0.9),
      noiseP50: quantile(noises, 0.5),
      noiseP90: quantile(noises, 0.9),
      snrP10: quantile(snrs, 0.1),
      snrP50: quantile(snrs, 0.5),
      confidenceP10: quantile(confidences, 0.1),
      confidenceP50: quantile(confidences, 0.5),
      preambleErrorsP90: quantile(preambleErrors, 0.9)
    },
    decode: {
      totalLanes: profile.lanes,
      validLanes: lanes.length,
      validLaneRate: lanes.length / profile.lanes,
      payloadBytesPerLane: profile.payloadBytes,
      bytesDecoded,
      capacityBytes,
      utilization: bytesDecoded / Math.max(1, capacityBytes),
      failures
    },
    rollingShutter: {
      sequences,
      sequenceCount: sequences.length,
      transitions: Math.max(0, sequences.length - 1),
      runs: makeRuns(states)
    },
    timing: {
      phaseMs,
      sampleMs,
      decodeMs,
      totalMs,
      cellsSampled: profile.columns * profile.lanes,
      millionCellsPerSecond: totalMs > 0 ? profile.columns * profile.lanes / totalMs / 1000 : 0
    }
  };
  if (laneDiagnostics) diagnostics.lanes = laneDiagnostics;
  return { lanes, diagnostics };
}
function decodeAirGridY8(options) { return decodeAirGridY8Detailed(options).lanes; }

export { decodeAirGridY8, decodeAirGridY8Detailed, project as projectAirGridPoint, quadHomography, sampleAirGridLane };
