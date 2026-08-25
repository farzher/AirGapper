export const ACQUISITION_ESCALATE_MS = 180;
export const ACQUISITION_HUNT_AFTER_MS = 900;
export const ACQUISITION_HUNT_EVERY_SCANS = 12;
export const TEMPORAL_HARD_SKIP_CONFIDENCE = 0.62;
export const TEMPORAL_HARD_SKIP_RISK = 0.48;

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
  // timeout) on older phones, which used to block the single acquisition lane
  // every other full scan. Keep dense full-frame seeds flowing and use actual
  // finder sightings for targeted retries; the expensive generic finder is only
  // a sparse escape hatch after a sustained blind stall.
  const fullEvery = stalled ? 2 : 4;
  const fullFrame = (index - 1) % fullEvery === 0;

  if (!fullFrame && hasSighting)
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
