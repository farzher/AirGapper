import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { exposurePatchFromConstraints, opticsGuardDecision } from "../receive/optics-guard.js";

function guardState(overrides = {}) {
  return {
    firstExposureAt: 100,
    trustedUntil: 0,
    trustedReason: "",
    burstUntil: 0,
    nextBurstAt: 0,
    finderHoldUntil: 0,
    lastFinderHints: 0,
    qrProven: false,
    protected: null,
    experiment: null,
    experimentGoodSince: 0,
    manualFreezeUntil: 0,
    restoring: false,
    lastDecision: "idle",
    ...overrides
  };
}

const ae = { exposureMode: "continuous", exposureTime: 33.3, iso: 148, exposureCompensation: 0 };
const manual = { exposureMode: "manual", exposureTime: 33.3, iso: 148, exposureCompensation: 0 };
const implicitManual = { exposureMode: "", exposureTime: 33.3, iso: 148, exposureCompensation: 0 };

assert.deepEqual(
  exposurePatchFromConstraints({ advanced: [{ exposureMode: "manual", exposureTime: 40, iso: 200 }] }),
  { exposureMode: "manual", exposureTime: 40, iso: 200 }
);
assert.deepEqual(
  exposurePatchFromConstraints({ exposureMode: { exact: "continuous" }, advanced: [{ exposureCompensation: 0 }] }),
  { exposureMode: "continuous", exposureCompensation: 0 }
);

// Startup: keep neutral hardware AE quiet long enough to get a fair decode.
{
  const state = guardState();
  assert.deepEqual(
    opticsGuardDecision({ state, patch: { exposureMode: "continuous", exposureCompensation: 0 }, current: ae, now: 400, auto: true }),
    { allow: true, reason: "AE grace" }
  );
  assert.deepEqual(
    opticsGuardDecision({ state, patch: { exposureMode: "manual", exposureTime: 20, iso: 180 }, current: ae, now: 450, auto: true }),
    { allow: false, reason: "AE grace" }
  );
}

// Finder structure is promising evidence: stop changing brightness briefly.
{
  const state = guardState({ finderHoldUntil: 1900 });
  assert.deepEqual(
    opticsGuardDecision({ state, patch: { exposureMode: "manual", exposureTime: 20, iso: 200 }, current: ae, now: 1200, auto: true }),
    { allow: false, reason: "finder hold" }
  );
}

// The first QR-proven state may be frozen in two stages: manual mode first,
// then exposure/ISO without repeating exposureMode. Chromium may still report
// exposureMode as blank/none during that second stage, so the explicit arm is
// the authority rather than getSettings().exposureMode.
{
  const state = guardState({ qrProven: true });
  assert.deepEqual(
    opticsGuardDecision({ state, patch: { exposureMode: "manual" }, current: ae, now: 1200, auto: true }),
    { allow: true, reason: "freeze first QR" }
  );
  assert.ok(state.manualFreezeUntil > 1250);
  assert.deepEqual(
    opticsGuardDecision({ state, patch: { exposureTime: 34, iso: 150 }, current: implicitManual, now: 1250, auto: true }),
    { allow: true, reason: "freeze first QR" }
  );
  assert.deepEqual(
    opticsGuardDecision({ state, patch: { exposureTime: 15, iso: 300 }, current: implicitManual, now: 1250, auto: true }),
    { allow: false, reason: "protect first QR" }
  );
}

// Once a QR-proven manual setting exists, speculative AutoOptics changes are
// rejected. Re-applying the same state is harmless and allowed.
{
  const protectedState = { exposureMode: "manual", exposureTime: 33.3, iso: 148, exposureCompensation: 0 };
  const state = guardState({ qrProven: true, protected: protectedState });
  assert.deepEqual(
    opticsGuardDecision({ state, patch: { exposureMode: "continuous" }, current: manual, now: 1600, auto: true }),
    { allow: false, reason: "QR-proven lock" }
  );
  assert.deepEqual(
    opticsGuardDecision({ state, patch: { exposureTime: 33.5, iso: 150 }, current: manual, now: 1600, auto: true }),
    { allow: true, reason: "protected no-op" }
  );
}

// Explicit recovery/user ownership temporarily opens the transaction gate.
{
  const state = guardState({
    qrProven: true,
    protected: { exposureMode: "manual", exposureTime: 33.3, iso: 148, exposureCompensation: 0 },
    trustedUntil: 2500,
    trustedReason: "recovery experiment"
  });
  assert.deepEqual(
    opticsGuardDecision({ state, patch: { exposureMode: "continuous", exposureCompensation: -1 }, current: manual, now: 1800, auto: true }),
    { allow: true, reason: "recovery experiment" }
  );
  assert.equal(
    opticsGuardDecision({ state: guardState(), patch: { exposureMode: "manual", exposureTime: 15, iso: 300 }, current: ae, now: 300, auto: false }).allow,
    true
  );
}

const autoRecoverySource = await readFile(new URL("../receive/auto-phase.js", import.meta.url), "utf8");
assert.match(autoRecoverySource, /from "\.\/optics-guard\.js"/);
assert.match(autoRecoverySource, /allowPhasePulse\(650\)/);
assert.match(autoRecoverySource, /beginOpticsExperiment\(8000\)/);
const swSource = await readFile(new URL("../sw.js", import.meta.url), "utf8");
assert.match(swSource, /\.\/receive\/optics-guard\.js/);

console.log("transactional optics guard smoke passed");
