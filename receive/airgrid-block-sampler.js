import { AIRGRID_BLOCK_SYNC, decodeAirGridBlockBits } from '../shared/airgrid-block.js';
import { quadHomography, projectAirGridPoint } from './airgrid-sampler.js';

const now = () => globalThis.performance?.now?.() ?? Date.now();
const LOCAL_OFFSETS = [-2, -1, 0, 1, 2];

function bilinearY(y8, width, height, x, y) {
  if (x < 0) x = 0; else if (x > width - 1) x = width - 1;
  if (y < 0) y = 0; else if (y > height - 1) y = height - 1;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
  const tx = x - x0, ty = y - y0;
  const a = y8[y0 * width + x0] * (1 - tx) + y8[y0 * width + x1] * tx;
  const b = y8[y1 * width + x0] * (1 - tx) + y8[y1 * width + x1] * tx;
  return a * (1 - ty) + b * ty;
}

function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function projectedSize(quad) {
  return {
    width:(distance(quad.topLeft, quad.topRight) + distance(quad.bottomLeft, quad.bottomRight)) * 0.5,
    height:(distance(quad.topLeft, quad.bottomLeft) + distance(quad.topRight, quad.bottomRight)) * 0.5
  };
}
function quantile(values, q) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const p = (sorted.length - 1) * q;
  const lo = Math.floor(p), hi = Math.ceil(p), t = p - lo;
  return sorted[lo] * (1 - t) + sorted[hi] * t;
}

function pointForCell(h, profile, laneIndex, column, phaseX = 0, phaseY = 0) {
  const p = projectAirGridPoint(h, (column + 0.5) / profile.columns, (laneIndex + 0.5) / profile.lanes);
  p.x += phaseX;
  p.y += phaseY;
  return p;
}

function syncMetrics(y8, width, height, h, profile, laneIndex, block, phaseX, phaseY) {
  const values = new Float32Array(AIRGRID_BLOCK_SYNC.length);
  let black = 0, white = 0, blackN = 0, whiteN = 0;
  for (let i = 0; i < AIRGRID_BLOCK_SYNC.length; i++) {
    const p = pointForCell(h, profile, laneIndex, block.start + i, phaseX, phaseY);
    const value = bilinearY(y8, width, height, p.x, p.y);
    values[i] = value;
    if (AIRGRID_BLOCK_SYNC[i]) { black += value; blackN++; }
    else { white += value; whiteN++; }
  }
  black /= Math.max(1, blackN);
  white /= Math.max(1, whiteN);
  const separation = white - black;
  const threshold = (white + black) * 0.5;
  let errors = 0;
  for (let i = 0; i < values.length; i++) {
    const bit = values[i] < threshold ? 1 : 0;
    errors += Number(bit !== AIRGRID_BLOCK_SYNC[i]);
  }
  return { black, white, separation, threshold, errors };
}

function findLocalPhase(y8, width, height, h, profile, laneIndex, block, minSeparation) {
  let best = null;
  for (const dy of LOCAL_OFFSETS) for (const dx of LOCAL_OFFSETS) {
    const m = syncMetrics(y8, width, height, h, profile, laneIndex, block, dx, dy);
    const lowContrastPenalty = m.separation >= minSeparation ? 0 : (minSeparation - m.separation) / Math.max(1, minSeparation) * 20;
    const score = m.errors * 20 + lowContrastPenalty - Math.max(0, m.separation) * 0.03 + (Math.abs(dx) + Math.abs(dy)) * 0.03;
    if (!best || score < best.score) best = { ...m, dx, dy, score };
  }
  return best;
}

function sampleBlock(y8, width, height, h, profile, laneIndex, block, minSeparation) {
  const phase = findLocalPhase(y8, width, height, h, profile, laneIndex, block, minSeparation);
  if (!phase || phase.separation < minSeparation) return { ok:false, reason:'lowContrast', phase };
  if (phase.errors > 2) return { ok:false, reason:'sync', phase };
  const bits = new Uint8Array(block.cells);
  for (let i = 0; i < block.cells; i++) {
    const p = pointForCell(h, profile, laneIndex, block.start + i, phase.dx, phase.dy);
    bits[i] = bilinearY(y8, width, height, p.x, p.y) < phase.threshold ? 1 : 0;
  }
  const decoded = decodeAirGridBlockBits(bits, { codewords:block.codewords, laneIndex, blockIndex:block.blockIndex });
  if (!decoded.ok) return { ok:false, reason:decoded.reason, phase, decoded };
  return { ok:true, phase, decoded };
}

function decodeAirGridBlockY8Detailed({ y8, width, height, quad, profile, minSeparation = 18, includeLaneDiagnostics = false }) {
  if (!(y8 instanceof Uint8Array) || y8.length < width * height) throw new Error('AirGrid block Y8 frame is incomplete');
  const started = now();
  const h = quadHomography(quad);
  const projected = projectedSize(quad);
  const units = [];
  const failures = { lowContrast:0, sync:0, hamming:0, crc:0, length:0, other:0 };
  const separations = [], phaseXs = [], phaseYs = [], corrections = [], syncErrors = [];
  const laneDiagnostics = includeLaneDiagnostics ? [] : null;
  let sampleDecodeMs = 0;
  for (let laneIndex = 0; laneIndex < profile.lanes; laneIndex++) {
    for (const block of profile.layout) {
      const t0 = now();
      const sampled = sampleBlock(y8, width, height, h, profile, laneIndex, block, minSeparation);
      sampleDecodeMs += now() - t0;
      if (sampled.phase) {
        separations.push(sampled.phase.separation);
        phaseXs.push(sampled.phase.dx);
        phaseYs.push(sampled.phase.dy);
        syncErrors.push(sampled.phase.errors);
      }
      if (!sampled.ok) {
        if (Object.hasOwn(failures, sampled.reason)) failures[sampled.reason]++;
        else failures.other++;
        if (laneDiagnostics) laneDiagnostics.push({ laneIndex, blockIndex:block.blockIndex, ok:false, reason:sampled.reason, phaseX:sampled.phase?.dx, phaseY:sampled.phase?.dy, separation:sampled.phase?.separation, syncErrors:sampled.phase?.errors });
        continue;
      }
      corrections.push(sampled.decoded.corrected || 0);
      const unit = {
        ...sampled.decoded.block,
        modulation:'binary-block',
        payloadBytes:sampled.decoded.block.payload.length,
        separation:sampled.phase.separation,
        phaseX:sampled.phase.dx,
        phaseY:sampled.phase.dy,
        corrected:sampled.decoded.corrected || 0,
        syncErrors:sampled.decoded.syncErrors || 0
      };
      units.push(unit);
      if (laneDiagnostics) laneDiagnostics.push({ laneIndex, blockIndex:block.blockIndex, ok:true, sequence:unit.sequence, phaseX:unit.phaseX, phaseY:unit.phaseY, separation:unit.separation, corrected:unit.corrected, syncErrors:unit.syncErrors });
    }
  }
  const totalMs = now() - started;
  const totalBlocks = profile.lanes * profile.layout.length;
  const capacityBytes = profile.capacityBytes;
  const bytesDecoded = units.reduce((sum, unit) => sum + unit.payload.length, 0);
  const sequences = [...new Set(units.map(unit => unit.sequence))].sort((a, b) => a - b);
  const diagnostics = {
    frame:{
      width,
      height,
      projectedWidthPx:projected.width,
      projectedHeightPx:projected.height,
      projectedCoverage:projected.width * projected.height / Math.max(1, width * height),
      pxPerCellX:projected.width / profile.columns,
      pxPerCellY:projected.height / profile.lanes,
      phaseX:quantile(phaseXs, 0.5),
      phaseY:quantile(phaseYs, 0.5),
      phasePreambleErrors:quantile(syncErrors, 0.5)
    },
    profile:{ ...profile, layout:undefined, minSeparation },
    optics:{
      separationP10:quantile(separations, 0.1),
      separationP50:quantile(separations, 0.5),
      localPhaseXP10:quantile(phaseXs, 0.1),
      localPhaseXP90:quantile(phaseXs, 0.9),
      localPhaseYP10:quantile(phaseYs, 0.1),
      localPhaseYP90:quantile(phaseYs, 0.9),
      correctedBitsP50:quantile(corrections, 0.5),
      syncErrorsP90:quantile(syncErrors, 0.9)
    },
    decode:{
      totalLanes:totalBlocks,
      validLanes:units.length,
      validLaneRate:units.length / Math.max(1, totalBlocks),
      bytesDecoded,
      capacityBytes,
      utilization:bytesDecoded / Math.max(1, capacityBytes),
      failures
    },
    rollingShutter:{ sequences, sequenceCount:sequences.length, transitions:Math.max(0, sequences.length - 1), runs:[] },
    timing:{ totalMs, sampleMs:sampleDecodeMs, decodeMs:0, cellsSampled:profile.columns * profile.lanes, millionCellsPerSecond:totalMs > 0 ? profile.columns * profile.lanes / totalMs / 1000 : 0 }
  };
  if (laneDiagnostics) diagnostics.lanes = laneDiagnostics;
  return { lanes:units, diagnostics };
}

export { decodeAirGridBlockY8Detailed };
