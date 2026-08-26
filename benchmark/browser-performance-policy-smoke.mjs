import assert from "node:assert/strict";
import fs from "node:fs";

// performance-policy now imports decode-health. Inline that dependency too so
// this smoke remains a standalone Node test without changing package module mode.
const decodeHealthSource = fs.readFileSync(new URL("../receive/decode-health.js", import.meta.url), "utf8");
const decodeHealthUrl = `data:text/javascript;base64,${Buffer.from(decodeHealthSource).toString("base64")}`;
const source = fs.readFileSync(new URL("../receive/performance-policy.js", import.meta.url), "utf8")
  .replace('from "./decode-health.js";', `from "${decodeHealthUrl}";`);
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

// Every QR-specific acquisition candidate must remain below photographic neutral.
const seeds = [0, 1, 2, 3].map((index) => policy.automaticOpticsAcquisitionSeed(index));
assert.deepEqual(seeds.map((seed) => seed.label), ["fast-dark", "extra-dark", "less-dark-short", "least-dark-short"]);
assert(seeds.every((seed) => seed.lightScale < 1));
assert(seeds[1].lightScale < seeds[0].lightScale);
assert(seeds[2].lightScale > seeds[0].lightScale);
assert(seeds[3].lightScale > seeds[2].lightScale);
assert.equal(policy.automaticOpticsHasAnotherAcquisitionSeed(0), true);
assert.equal(policy.automaticOpticsHasAnotherAcquisitionSeed(2), true);
assert.equal(policy.automaticOpticsHasAnotherAcquisitionSeed(3), false);

// Production must bias exposure before playback/frame capture. Cameras without
// an EV axis must use a dark manual seed when shutter+ISO are available.
const runtimeSource = fs.readFileSync(new URL("../receive/runtime.js", import.meta.url), "utf8");
assert(runtimeSource.includes('const AUTO_OPTICS_MEMORY_KEY = "airgapper:auto-optics-memory:v6";'));
assert(runtimeSource.includes('if (automaticOptics) await primeAutomaticQrOpticsBeforePlayback(startupOpticsTrack);'));
assert(runtimeSource.includes('async function primeAutomaticQrOpticsBeforePlayback(track)'));
assert(runtimeSource.includes('const evRange = caps.exposureCompensation;'));
assert(runtimeSource.includes('const seed = automaticShortShutterSeed(baseline, exposureRange, isoRange, fps, 0);'));
assert(runtimeSource.includes('Math.min(0, AUTO_QR_EV_BIAS)'));
assert(!runtimeSource.includes('"bright rescue"'));
assert(!runtimeSource.includes('"neutral retry"'));

// HOLD requires real spatial QR evidence, not aggregate yield alone.
const cohort = { cohortSize: 4, cohortCoverage: 4, tailYield: 0.30 };
assert.equal(policy.automaticOpticsHoldEligible({
  ...cohort, valid: true, unstable: false, attempts: 20, outputs: 3, yieldRate: 0.15, breadth: 0.75
}), false);
assert.equal(policy.automaticOpticsHoldEligible({
  ...cohort, valid: true, unstable: false, attempts: 24, outputs: 12, yieldRate: 0.50, breadth: 0.25
}), false);
assert.equal(policy.automaticOpticsHoldEligible({
  ...cohort, valid: true, unstable: false, attempts: 24, outputs: 15, yieldRate: 0.625, breadth: 0.75
}), true);
assert.equal(policy.automaticOpticsHoldEligible({
  ...cohort, valid: false, unstable: false, attempts: 40, outputs: 30, yieldRate: 0.75, breadth: 1
}), false);
// Aggregate success without a measured cohort must never manufacture HOLD.
assert.equal(policy.automaticOpticsHoldEligible({
  valid: true, unstable: false, attempts: 40, outputs: 30, yieldRate: 0.75, breadth: 1, tailYield: 0.75
}), false);

assert(policy.automaticOpticsHoldThreshold(0.8) > 0.5);
assert(policy.legacyTemporalRiskWeight(0.9) < 0.1);
console.log("AIRGAPPER_BROWSER_POLICY_PASS");
