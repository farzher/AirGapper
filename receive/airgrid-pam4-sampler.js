import { AIRGRID_PAM4_PREAMBLE, inspectAirGridPam4Lane } from '../shared/airgrid-pam4.js';
import { quadHomography } from './airgrid-sampler.js';

const now = () => globalThis.performance?.now?.() ?? Date.now();
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
function samplePam4Lane(y8, width, height, homography, profile, laneIndex, minLevelGap, values, symbols) {
  const columns = profile.columns;
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

  const sums = [0, 0, 0, 0], counts = [0, 0, 0, 0];
  for (let i = 0; i < AIRGRID_PAM4_PREAMBLE.length; i++) {
    const level = AIRGRID_PAM4_PREAMBLE[i];
    sums[level] += values[i]; counts[level]++;
  }
  const centers = sums.map((sum, level) => sum / Math.max(1, counts[level]));
  const gaps = [centers[1] - centers[0], centers[2] - centers[1], centers[3] - centers[2]];
  const minGap = Math.min(...gaps);
  let calibrationVariance = 0;
  for (let i = 0; i < AIRGRID_PAM4_PREAMBLE.length; i++) {
    const expected = centers[AIRGRID_PAM4_PREAMBLE[i]];
    calibrationVariance += (values[i] - expected) ** 2;
  }
  const noise = Math.sqrt(calibrationVariance / AIRGRID_PAM4_PREAMBLE.length);
  if (!(minGap >= minLevelGap)) return { symbols: null, centers, gaps, minGap, noise, snr: minGap / Math.max(1, noise), confidence: 0, evm: Infinity };

  let confidence = 0, error2 = 0;
  for (let i = 0; i < columns; i++) {
    const value = values[i];
    let best = 0, bestDistance = Math.abs(value - centers[0]), secondDistance = Infinity;
    for (let level = 1; level < 4; level++) {
      const d = Math.abs(value - centers[level]);
      if (d < bestDistance) { secondDistance = bestDistance; bestDistance = d; best = level; }
      else if (d < secondDistance) secondDistance = d;
    }
    symbols[i] = best;
    confidence += Math.max(0, Math.min(1, (secondDistance - bestDistance) / Math.max(1, minGap)));
    error2 += bestDistance * bestDistance;
  }
  confidence /= columns;
  const rmsError = Math.sqrt(error2 / columns);
  return { symbols, centers, gaps, minGap, noise, snr: minGap / Math.max(1, noise), confidence, evm: rmsError / Math.max(1, minGap) };
}
function decodeAirGridPam4Y8Detailed({ y8, width, height, quad, profile, minSeparation = 10, includeLaneDiagnostics = false }) {
  if (!(y8 instanceof Uint8Array) || y8.length < width * height) throw new Error('AirGrid PAM4 Y8 frame is incomplete');
  const started = now();
  const homography = quadHomography(quad);
  const projected = projectedSize(quad);
  const lanes = [];
  const states = new Array(profile.lanes);
  const separations = [], noises = [], snrs = [], confidences = [], evms = [], preambleErrors = [];
  const centerSeries = [[], [], [], []];
  const failures = { lowContrast: 0, preamble: 0, magic: 0, version: 0, crc: 0, short: 0, other: 0 };
  const laneDiagnostics = includeLaneDiagnostics ? [] : null;
  const scratchValues = new Uint8Array(profile.columns);
  const scratchSymbols = new Uint8Array(profile.columns);
  let sampleMs = 0, decodeMs = 0;

  for (let laneIndex = 0; laneIndex < profile.lanes; laneIndex++) {
    const sampleStarted = now();
    const sampled = samplePam4Lane(y8, width, height, homography, profile, laneIndex, minSeparation, scratchValues, scratchSymbols);
    sampleMs += now() - sampleStarted;
    separations.push(sampled.minGap);
    noises.push(sampled.noise);
    snrs.push(sampled.snr);
    confidences.push(sampled.confidence);
    evms.push(sampled.evm);
    for (let level = 0; level < 4; level++) centerSeries[level].push(sampled.centers[level]);
    if (!sampled.symbols) {
      failures.lowContrast++;
      states[laneIndex] = { ok: false, reason: 'lowContrast' };
      if (laneDiagnostics) laneDiagnostics.push({ laneIndex, ok: false, reason: 'lowContrast', centers: sampled.centers, minGap: sampled.minGap, noise: sampled.noise, snr: sampled.snr });
      continue;
    }
    const decodeStarted = now();
    const inspected = inspectAirGridPam4Lane(sampled.symbols, { laneIndex });
    decodeMs += now() - decodeStarted;
    preambleErrors.push(inspected.preambleErrors ?? AIRGRID_PAM4_PREAMBLE.length);
    if (!inspected.ok) {
      if (Object.hasOwn(failures, inspected.reason)) failures[inspected.reason]++;
      else failures.other++;
      states[laneIndex] = { ok: false, reason: inspected.reason };
      if (laneDiagnostics) laneDiagnostics.push({ laneIndex, ok: false, reason: inspected.reason, centers: sampled.centers, minGap: sampled.minGap, noise: sampled.noise, snr: sampled.snr, confidence: sampled.confidence, evm: sampled.evm });
      continue;
    }
    const lane = { ...inspected.lane, separation: sampled.minGap, snr: sampled.snr, confidence: sampled.confidence, evm: sampled.evm, centers: sampled.centers, preambleErrors: inspected.preambleErrors };
    lanes.push(lane);
    states[laneIndex] = { ok: true, sequence: lane.sequence };
    if (laneDiagnostics) laneDiagnostics.push({ laneIndex, ok: true, sequence: lane.sequence, centers: sampled.centers, minGap: sampled.minGap, noise: sampled.noise, snr: sampled.snr, confidence: sampled.confidence, evm: sampled.evm });
  }

  const totalMs = now() - started;
  const capacityBytes = profile.lanes * profile.payloadBytes;
  const bytesDecoded = lanes.length * profile.payloadBytes;
  const sequences = [...new Set(lanes.map(lane => lane.sequence))].sort((a, b) => a - b);
  const diagnostics = {
    frame: {
      width, height,
      projectedWidthPx: projected.width,
      projectedHeightPx: projected.height,
      projectedCoverage: projected.width * projected.height / Math.max(1, width * height),
      pxPerCellX: projected.width / profile.columns,
      pxPerCellY: projected.height / profile.lanes
    },
    profile: { ...profile, modulation: 'pam4', minSeparation },
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
      evmP50: quantile(evms.filter(Number.isFinite), 0.5),
      evmP90: quantile(evms.filter(Number.isFinite), 0.9),
      clusterCentersP50: centerSeries.map(values => quantile(values, 0.5)),
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
      sampleMs, decodeMs, totalMs,
      cellsSampled: profile.columns * profile.lanes,
      millionCellsPerSecond: totalMs > 0 ? profile.columns * profile.lanes / totalMs / 1000 : 0
    }
  };
  if (laneDiagnostics) diagnostics.lanes = laneDiagnostics;
  return { lanes, diagnostics };
}
function decodeAirGridPam4Y8(options) { return decodeAirGridPam4Y8Detailed(options).lanes; }

export { decodeAirGridPam4Y8, decodeAirGridPam4Y8Detailed, samplePam4Lane };
