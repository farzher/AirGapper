import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../receive/performance-policy.js", import.meta.url), "utf8");
const policy = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

assert.deepEqual(policy.acquisitionRacePolicy({ scanIndex: 1, ageMs: 0 }),
  { mode: "fast", fullFrame: true, targetSighting: false, stalled: false });
assert.equal(policy.acquisitionRacePolicy({ scanIndex: 2, ageMs: 50 }).mode, "seed");
assert.equal(policy.acquisitionRacePolicy({ scanIndex: 4, ageMs: 250, hasSighting: true }).mode, "sighting");
assert.equal(policy.acquisitionRacePolicy({ scanIndex: 5, ageMs: 250 }).mode, "hunt");
assert.equal(policy.temporalHardSkip({ risk: 0.8, confidence: 0.8 }), true);
assert.equal(policy.temporalHardSkip({ risk: 0.8, confidence: 0.4 }), false);
assert.equal(policy.temporalHardSkip({ risk: 0.8, confidence: 0.8, measurement: true }), false);
assert.equal(policy.temporalHardSkip({ explicitSkip: true }), true);
assert(policy.automaticOpticsHoldThreshold(0.8) > 0.5);
assert(policy.legacyTemporalRiskWeight(0.9) < 0.1);
console.log("AIRGAPPER_BROWSER_POLICY_PASS");
