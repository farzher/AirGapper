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

// Auto Optics explores both sides of the initial QR exposure before AE fallback.
const seeds = [0, 1, 2, 3].map((index) => policy.automaticOpticsAcquisitionSeed(index));
assert.deepEqual(seeds.map((seed) => seed.label), ["fast-dark", "extra-dark", "neutral-short", "bright-short"]);
assert(seeds[1].lightScale < seeds[0].lightScale);
assert(seeds[2].lightScale > seeds[0].lightScale);
assert(seeds[3].lightScale > seeds[2].lightScale);
assert.equal(policy.automaticOpticsHasAnotherAcquisitionSeed(0), true);
assert.equal(policy.automaticOpticsHasAnotherAcquisitionSeed(2), true);
assert.equal(policy.automaticOpticsHasAnotherAcquisitionSeed(3), false);

// HOLD must be earned by real decoder evidence. The v0.5.453 failure mode
// (3/20-ish or even 0/20 becoming a synthetic 50% HOLD) must never return.
assert.equal(policy.automaticOpticsHoldEligible({
  valid: true, unstable: false, attempts: 20, outputs: 3, yieldRate: 0.15, breadth: 0.75
}), false);
assert.equal(policy.automaticOpticsHoldEligible({
  valid: true, unstable: false, attempts: 24, outputs: 12, yieldRate: 0.50, breadth: 0.25
}), false);
assert.equal(policy.automaticOpticsHoldEligible({
  valid: true, unstable: false, attempts: 24, outputs: 12, yieldRate: 0.50, breadth: 0.75
}), true);
assert.equal(policy.automaticOpticsHoldEligible({
  valid: false, unstable: false, attempts: 40, outputs: 30, yieldRate: 0.75, breadth: 1
}), false);

assert.equal(policy.temporalHardSkip({ risk: 0.8, confidence: 0.8 }), true);
assert.equal(policy.temporalHardSkip({ risk: 0.8, confidence: 0.4 }), false);
assert.equal(policy.temporalHardSkip({ risk: 0.8, confidence: 0.8, measurement: true }), false);
assert.equal(policy.temporalHardSkip({ explicitSkip: true }), true);
assert(policy.automaticOpticsHoldThreshold(0.8) > 0.5);
assert(policy.legacyTemporalRiskWeight(0.9) < 0.1);
console.log("AIRGAPPER_BROWSER_POLICY_PASS");
