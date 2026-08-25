export const ACQUISITION_ESCALATE_MS = 180;
export const ACQUISITION_HUNT_AFTER_MS = 900;
export const ACQUISITION_HUNT_EVERY_SCANS = 12;
export const ACQUISITION_SIGHTING_EVERY_SCANS = 4;
export const TEMPORAL_HARD_SKIP_CONFIDENCE = 0.62;
export const TEMPORAL_HARD_SKIP_RISK = 0.48;

const AUTO_OPTICS_ACQUISITION_SEEDS = Object.freeze([
  // Fast/default: deliberately dark and very short for rolling-shutter safety.
  Object.freeze({ lightScale: Math.pow(2, -0.75), maxExposure: 35, frameFraction: 0.10, label: "fast-dark" }),
  // If the first QR-specific seed is too dark, spend ISO/light before giving
  // photographic AE control back. Shutter remains tightly bounded.
  Object.freeze({ lightScale: 1, maxExposure: 45, frameFraction: 0.14, label: "neutral-short" }),
  // Last QR-specific rescue: modestly brighter with a still motion-safe ceiling.
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