import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../receive/performance-policy.js", import.meta.url), "utf8");
const policy = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

assert.deepEqual(policy.acquisitionRacePolicy({ scanIndex: 1, ageMs: 0 }),
  { mode: "fast", fullFrame: true, targetSighting: false, stalled: false });
assert.equal(policy.acquisitionRacePolicy({ scanIndex: 2, ageMs: 50 }).mode, "seed");
assert.equal(policy.acquisitionRacePolicy({ scanIndex: 4, ageMs: 250, hasSighting: true }).mode, "sighting");
// A short acquisition miss must not immediately trigger the expensive generic finder.
assert.equal(policy.acquisitionRacePolicy({ scanIndex: 5, ageMs: 250 }).mode, "fast");
// Finder-only evidence gets bounded retries; intervening scans continue spatial search.
assert.equal(policy.acquisitionRacePolicy({ scanIndex: 6, ageMs: 1000, hasSighting: true }).mode, "seed");
assert.equal(policy.acquisitionRacePolicy({ scanIndex: 8, ageMs: 1000, hasSighting: true }).mode, "sighting");
// Generic robust hunt is a sparse escape hatch after sustained blind acquisition.
assert.equal(policy.acquisitionRacePolicy({ scanIndex: 13, ageMs: 1000 }).mode, "hunt");

// Cold predicted slots do not justify global reacquisition while payload is still
// alive. Local known-grid recovery gets first refusal; whole-frame recovery is
// reserved for sustained decoder silence.
assert.deepEqual(policy.lockedRecoveryPolicy({
  geometryProbeDue: false,
  allCandidatesCold: true,
  decodeSilenceMs: 120,
  globalSilenceMs: 500,
  hasCandidates: true
}), { needsRecovery: true, globalRecovery: false, localRecovery: true });
assert.deepEqual(policy.lockedRecoveryPolicy({
  geometryProbeDue: true,
  allCandidatesCold: true,
  decodeSilenceMs: 650,
  globalSilenceMs: 500,
  hasCandidates: true
}), { needsRecovery: true, globalRecovery: true, localRecovery: false });
assert.deepEqual(policy.lockedRecoveryPolicy({
  geometryProbeDue: false,
  allCandidatesCold: false,
  decodeSilenceMs: 100,
  globalSilenceMs: 500,
  hasCandidates: true
}), { needsRecovery: false, globalRecovery: false, localRecovery: false });

// Auto Optics gets a bounded QR-specific ladder before photographic AE fallback.
const seed0 = policy.automaticOpticsAcquisitionSeed(0);
const seed1 = policy.automaticOpticsAcquisitionSeed(1);
const seed2 = policy.automaticOpticsAcquisitionSeed(2);
assert(seed0.lightScale < seed1.lightScale && seed1.lightScale < seed2.lightScale);
assert(seed0.maxExposure < seed1.maxExposure && seed1.maxExposure < seed2.maxExposure);
assert.equal(policy.automaticOpticsHasAnotherAcquisitionSeed(0), true);
assert.equal(policy.automaticOpticsHasAnotherAcquisitionSeed(1), true);
assert.equal(policy.automaticOpticsHasAnotherAcquisitionSeed(2), false);

assert.equal(policy.temporalHardSkip({ risk: 0.8, confidence: 0.8 }), true);
assert.equal(policy.temporalHardSkip({ risk: 0.8, confidence: 0.4 }), false);
assert.equal(policy.temporalHardSkip({ risk: 0.8, confidence: 0.8, measurement: true }), false);
assert.equal(policy.temporalHardSkip({ explicitSkip: true }), true);
assert(policy.automaticOpticsHoldThreshold(0.8) > 0.5);
assert(policy.legacyTemporalRiskWeight(0.9) < 0.1);
console.log("AIRGAPPER_BROWSER_POLICY_PASS");