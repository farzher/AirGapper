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
  localProbeSilenceMs = 180,
  globalSilenceMs = 500,
  hasCandidates = true
}) {
  const silence = Math.max(0, Number(decodeSilenceMs) || 0);
  const globalThreshold = Math.max(0, Number(globalSilenceMs) || 0);
  const localThreshold = Math.min(globalThreshold, Math.max(0, Number(localProbeSilenceMs) || 0));
  const globalRecovery = silence >= globalThreshold;
  // Periodic stale-geometry maintenance must not steal a robust worker from a
  // wall that is still delivering payload every frame. The runtime's fast probe
  // threshold is 180 ms; keep the policy default aligned so maintenance cannot
  // fire earlier merely because the caller omitted the optional override.
  const localProbe = Boolean(geometryProbeDue) && silence >= localThreshold;
  const localRecovery = Boolean(hasCandidates) && !globalRecovery &&
    (localProbe || Boolean(allCandidatesCold));
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
  minTailYield = 0.20,
  broadMinYield = 0.40,
  broadMinBreadth = 0.90,
  broadMinTailYield = 0.35,
  movingMinYield = 0.55,
  movingMinBreadth = 0.90,
  movingMinTailYield = 0.45
} = {}) {
  if (!sample) return false;
  const poseUnstable = sample.unstable === true;
  // A sample can be marked invalid solely because the phone moved during the
  // measurement window. That must not force more exposure experiments when the
  // decoder simultaneously proves broad, strong payload progress. Other invalid
  // samples (insufficient jobs/evidence, missing cohort, etc.) remain ineligible.
  if (sample.valid !== true && !poseUnstable) return false;
  const cohortSize = Number(sample.cohortSize);
  const cohortCoverage = Number(sample.cohortCoverage);
  const reportedBreadth = Number(sample.breadth);
  const reportedTail = Number(sample.tailYield);
  // HOLD must be backed by an actual spatial QR cohort. Aggregate yield with no
  // cohort used to synthesize 100% breadth and reuse mean yield as the weak tail,
  // which could promote a lucky/local decode into a long-lived camera setting.
  if (!Number.isFinite(cohortSize) || cohortSize < 1 ||
      !Number.isFinite(cohortCoverage) || cohortCoverage < 1 ||
      !Number.isFinite(reportedBreadth) || !Number.isFinite(reportedTail)) return false;
  const attempts = Math.max(0, Number(sample.attempts) || 0);
  const outputs = Math.max(0, Math.min(attempts, Number(sample.outputs) || 0));
  const reportedYield = Number(sample.yieldRate);
  const yieldRate = Number.isFinite(reportedYield)
    ? Math.max(0, Math.min(1, reportedYield))
    : attempts ? outputs / attempts : 0;
  const breadth = Math.max(0, Math.min(1, reportedBreadth));
  const tailYield = Math.max(0, Math.min(1, reportedTail));
  const standardProof = yieldRate >= Math.max(0, Number(minYield) || 0) &&
    breadth >= Math.max(0, Number(minBreadth) || 0) &&
    tailYield >= Math.max(0, Number(minTailYield) || 0);
  // A uniformly productive wall is also safe to hold even when its aggregate
  // sample yield sits below the old 55% cutoff. This is the important distinction
  // between a broad 46% wall and a lucky 46% cluster in one easy corner.
  const broadProof = yieldRate >= Math.max(0, Number(broadMinYield) || 0) &&
    breadth >= Math.max(0, Number(broadMinBreadth) || 0) &&
    tailYield >= Math.max(0, Number(broadMinTailYield) || 0);
  // Camera motion makes exposure comparisons noisier, but it also makes camera
  // mutation more dangerous. If a moving wall is already broadly productive,
  // use a stricter decoder proof and HOLD the current sensor state instead of
  // waiting for a perfectly still pose while continuing to poke exposure.
  const movingProof = yieldRate >= Math.max(0, Number(movingMinYield) || 0) &&
    breadth >= Math.max(0, Number(movingMinBreadth) || 0) &&
    tailYield >= Math.max(0, Number(movingMinTailYield) || 0);
  const enoughEvidence = attempts >= Math.max(1, Number(minAttempts) || 1) &&
    outputs >= Math.max(1, Number(minOutputs) || 1);
  return enoughEvidence && (poseUnstable ? movingProof : (standardProof || broadProof));
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
