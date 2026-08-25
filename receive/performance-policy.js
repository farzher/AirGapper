export const ACQUISITION_ESCALATE_MS = 180;
export const ACQUISITION_HUNT_AFTER_MS = 900;
export const ACQUISITION_HUNT_EVERY_SCANS = 12;
export const ACQUISITION_SIGHTING_EVERY_SCANS = 4;
export const TEMPORAL_HARD_SKIP_CONFIDENCE = 0.62;
export const TEMPORAL_HARD_SKIP_RISK = 0.48;

const AUTO_OPTICS_ACQUISITION_SEEDS = Object.freeze([
  // Default QR seed: short enough to avoid rolling-shutter smear and darker
  // than photographic AE so white modules do not bloom into their neighbors.
  Object.freeze({ lightScale: Math.pow(2, -0.75), maxExposure: 35, frameFraction: 0.10, label: "fast-dark" }),
  // A noisy/max-ISO camera can still be much too bright for a binary modem.
  // Explore the darker direction before assuming the first miss meant "more light".
  Object.freeze({ lightScale: Math.pow(2, -1.5), maxExposure: 35, frameFraction: 0.10, label: "extra-dark" }),
  // Then try neutral short-shutter exposure if the darker seeds were starved.
  Object.freeze({ lightScale: 1, maxExposure: 45, frameFraction: 0.14, label: "neutral-short" }),
  // Last QR-specific rescue before handing control back to hardware AE.
  Object.freeze({ lightScale: Math.pow(2, 0.5), maxExposure: 55, frameFraction: 0.18, label: "bright-short" })
]);

export function acquisitionRacePolicy({
  scanIndex,
  ageMs,
  captureNextScan = false,
  localRecovery = false,
  hasSighting = false
}) {
  if (captureNextScan) return { mode: "thorough", fullFrame: true, targetSighting: false, stalled: false };
  if (localRecovery) return { mode: "recovery", fullFrame: false, targetSighting: false, stalled: false };

  const index = Math.max(1, Math.trunc(Number(scanIndex) || 1));
  const age = Math.max(0, Number(ageMs) || 0);
  const stalled = age >= ACQUISITION_ESCALATE_MS;

  // Acquisition should spend almost all of its time on the cheap dense finder.
  // A generic robust hunt can take hundreds of milliseconds (or hit the worker
  // timeout) on older phones, which used to block acquisition every other scan.
  // Keep dense full-frame seeds flowing; robust search is a sparse escape hatch
  // after a sustained blind stall.
  const fullEvery = stalled ? 2 : 4;
  const fullFrame = (index - 1) % fullEvery === 0;

  // Finder-only sightings are useful evidence, but the runtime keeps them alive
  // for several seconds. Retrying the same sighting on every intervening scan
  // can turn one bad finder into dozens of identical crops. Give a sighting one
  // bounded retry per small acquisition cycle, then resume spatial seed search.
  const sightingDue = hasSighting && !fullFrame && index % ACQUISITION_SIGHTING_EVERY_SCANS === 0;
  if (sightingDue)
    return { mode: "sighting", fullFrame: false, targetSighting: true, stalled };

  if (fullFrame) {
    const huntDue = age >= ACQUISITION_HUNT_AFTER_MS &&
      (index - 1) % ACQUISITION_HUNT_EVERY_SCANS === 0;
    return {
      mode: huntDue ? "hunt" : "fast",
      fullFrame: true,
      targetSighting: false,
      stalled
    };
  }

  return { mode: "seed", fullFrame: false, targetSighting: false, stalled };
}

// Recovery has two different jobs. A cold/missing predicted slot is a local
// geometry problem while the stream is still producing packets; only sustained
// payload silence is evidence that the whole wall needs a global finder again.
// Keeping this split explicit prevents healthy locked scans from competing with
// full-frame reacquisition work.
export function lockedRecoveryPolicy({
  geometryProbeDue = false,
  allCandidatesCold = false,
  decodeSilenceMs = 0,
  globalSilenceMs = 500,
  hasCandidates = true
}) {
  const globalRecovery = Number(decodeSilenceMs) >= Math.max(0, Number(globalSilenceMs) || 0);
  const localRecovery = Boolean(hasCandidates) && !globalRecovery &&
    (Boolean(geometryProbeDue) || Boolean(allCandidatesCold));
  return {
    needsRecovery: globalRecovery || localRecovery,
    globalRecovery,
    localRecovery
  };
}

// Auto Optics acquisition is allowed to explore, but it should explore settings
// designed for animated QR capture rather than immediately handing control back
// to photographic AE. The ladder is intentionally tiny and bounded; once all
// entries fail, hardware AE remains the universal fallback.
export function automaticOpticsAcquisitionSeed(attempt = 0) {
  const index = Math.max(0, Math.min(AUTO_OPTICS_ACQUISITION_SEEDS.length - 1,
    Math.trunc(Number(attempt) || 0)));
  return { ...AUTO_OPTICS_ACQUISITION_SEEDS[index], index, count: AUTO_OPTICS_ACQUISITION_SEEDS.length };
}

export function automaticOpticsHasAnotherAcquisitionSeed(attempt = 0) {
  return Math.trunc(Number(attempt) || 0) + 1 < AUTO_OPTICS_ACQUISITION_SEEDS.length;
}

// HOLD is a production state, not a guess. A setting must prove that it can
// repeatedly decode a meaningful fraction of the measured physical cohort.
// Mean yield alone is insufficient: an exposure that makes half the wall great
// and the other half nearly blind is a poor long-lived operating point.
export function automaticOpticsHoldEligible(sample, {
  minAttempts = 20,
  minOutputs = 5,
  minYield = 0.55,
  minBreadth = 0.65,
  minTailYield = 0.20
} = {}) {
  if (!sample || sample.valid !== true || sample.unstable) return false;
  const attempts = Math.max(0, Number(sample.attempts) || 0);
  const outputs = Math.max(0, Math.min(attempts, Number(sample.outputs) || 0));
  const reportedYield = Number(sample.yieldRate);
  const yieldRate = Number.isFinite(reportedYield)
    ? Math.max(0, Math.min(1, reportedYield))
    : attempts ? outputs / attempts : 0;
  const reportedBreadth = Number(sample.breadth);
  const breadth = Number.isFinite(reportedBreadth)
    ? Math.max(0, Math.min(1, reportedBreadth))
    : outputs > 0 ? 1 : 0;
  const reportedTail = Number(sample.tailYield);
  const tailYield = Number.isFinite(reportedTail)
    ? Math.max(0, Math.min(1, reportedTail))
    : yieldRate;
  return attempts >= Math.max(1, Number(minAttempts) || 1) &&
    outputs >= Math.max(1, Number(minOutputs) || 1) &&
    yieldRate >= Math.max(0, Number(minYield) || 0) &&
    breadth >= Math.max(0, Number(minBreadth) || 0) &&
    tailYield >= Math.max(0, Number(minTailYield) || 0);
}

export function temporalHardSkip({ explicitSkip = false, risk = 0, confidence = 0, measurement = false }) {
  if (measurement) return false;
  if (explicitSkip) return true;
  return Number(confidence) >= TEMPORAL_HARD_SKIP_CONFIDENCE && Number(risk) >= TEMPORAL_HARD_SKIP_RISK;
}

export function legacyTemporalRiskWeight(confidence) {
  return Math.max(0, Math.min(1, 1 - Math.max(0, Number(confidence) || 0) * 1.45));
}

export function automaticOpticsHoldThreshold(heldYield, collapseYield = 0.12) {
  const held = Math.max(0, Math.min(1, Number(heldYield) || 0));
  // A winner should not be abandoned for normal frame noise, but losing roughly
  // 30% of its proven QR yield is meaningful. Keep a modest absolute floor so
  // a mediocre startup winner does not make "bad forever" the new normal.
  return Math.max(Number(collapseYield) || 0, 0.38, Math.min(0.72, held * 0.70));
}
