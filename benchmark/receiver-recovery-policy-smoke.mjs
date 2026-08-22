import assert from "node:assert/strict";
import { applyAdvancedConstraint } from "../shared/platform.js";
import { FocusController } from "../receive/focus-controller.js";
import { DecodeWorkerPool } from "../shared/worker-pool.js";
import {
  armWarmWorkerRestartSuppression,
  beginPoseRecovery,
  consumeExposureRescue,
  endPoseRecovery,
  latchVerifiedExposure,
  noteExposureMotion,
  recoveryDiagnostics,
  verifiedExposureLatchDecision
} from "../shared/receiver-recovery-state.js";

const settings = {
  exposureMode: "continuous",
  exposureTime: 120,
  iso: 100,
  exposureCompensation: 0,
  frameRate: 30
};
let cameraWrites = 0;
const track = {
  readyState: "live",
  getCapabilities() {
    return {
      exposureMode: ["continuous", "manual"],
      exposureTime: { min: 10, max: 400, step: 1 },
      iso: { min: 50, max: 1600, step: 1 },
      exposureCompensation: { min: -2, max: 2, step: 0.1 }
    };
  },
  getSettings() {
    return { ...settings };
  },
  async applyConstraints({ advanced }) {
    cameraWrites++;
    Object.assign(settings, advanced[0]);
  }
};

// Establish a manual candidate. 50 units == 5 ms.
const provenSetting = {
  exposureMode: "manual",
  exposureTime: 50,
  iso: 166
};
await applyAdvancedConstraint(track, provenSetting);
assert.equal(cameraWrites, 1);
assert.equal(settings.exposureMode, "manual");

// Reasserting exactly the same exposure state must not touch the camera HAL.
await applyAdvancedConstraint(track, provenSetting);
assert.equal(cameraWrites, 1, "identical exposure/ISO writes should be deduplicated");
assert.equal(recoveryDiagnostics().suppressedExposureWrites, 1);

// Only a verified QR promotes the current manual state to the recovery prior
// and verified-exposure latch.
const controller = new FocusController(async () => true, () => {});
controller.track = track;
controller.noteValidDecode(0);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(recoveryDiagnostics().verifiedExposure.exposure, 50);
assert.equal(recoveryDiagnostics().verifiedExposure.iso, 166);

beginPoseRecovery("whole lattice stale; bounded QR re-anchor window");
await applyAdvancedConstraint(track, {
  exposureMode: "continuous",
  exposureCompensation: 0
});
assert.equal(cameraWrites, 1, "pose recovery must not surrender a QR-proven manual exposure to AE");
assert.equal(settings.exposureMode, "manual");
assert.equal(settings.exposureTime, 50);
assert.equal(settings.iso, 166);
assert.equal(recoveryDiagnostics().suppressedExposureWrites, 1);

class FakeWorker {
  terminateCount = 0;
  postMessage() {}
  terminate() { this.terminateCount++; }
}
const created = [];
const pool = new DecodeWorkerPool(
  () => {
    const worker = new FakeWorker();
    created.push(worker);
    return worker;
  },
  () => {}, () => {}, () => {}, () => {}, () => {}, () => {}
);
pool.resize(2);
assert.equal(pool.size, 2);

// Soft pose loss protects exposure only. Worker teardown is suppressed exactly
// once when the lattice escalates to hard REACQUIRE.
assert.equal(armWarmWorkerRestartSuppression(), true);
pool.resize(0);
assert.equal(pool.size, 2, "geometry-only hard reacquire must keep warm workers alive");
pool.resize(2);
assert.equal(pool.size, 2);
assert.equal(created.reduce((sum, worker) => sum + worker.terminateCount, 0), 0);
assert.equal(recoveryDiagnostics().suppressedWorkerRestarts, 1);

// The budget was consumed; an unrelated explicit resize(0) is not hidden.
pool.resize(0);
assert.equal(pool.size, 0, "only the geometry-reacquire restart is suppressed");
assert.equal(created.reduce((sum, worker) => sum + worker.terminateCount, 0), 2);
endPoseRecovery();

// Reproduce the phone log: photographic AE drifts to 40 ms / ISO 166 after a
// verified 5 ms / ISO 166 state. The next verified QR restores that proven state.
Object.assign(settings, {
  exposureMode: "continuous",
  exposureTime: 400,
  iso: 166
});
controller.noteValidDecode(1);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(settings.exposureMode, "manual");
assert.equal(settings.exposureTime, 50, "verified QR should restore the prior 5 ms exposure");
assert.equal(settings.iso, 166, "verified QR should restore the prior QR-proven ISO");
assert.equal(cameraWrites, 2, "long-AE escape should require exactly one sensor write");

// A QR that succeeds at a long *manual* shutter is still temporally risky.
// Clamp it once to 5 ms while preserving the proven exposure product with ISO.
const ceilingSettings = {
  exposureMode: "manual",
  exposureTime: 83.1,
  iso: 100,
  exposureCompensation: 0,
  frameRate: 30
};
let ceilingWrites = 0;
const ceilingTrack = {
  readyState: "live",
  getCapabilities: track.getCapabilities,
  getSettings() { return { ...ceilingSettings }; },
  async applyConstraints({ advanced }) {
    ceilingWrites++;
    Object.assign(ceilingSettings, advanced[0]);
  }
};
const ceilingController = new FocusController(async () => true, () => {});
ceilingController.track = ceilingTrack;
ceilingController.noteValidDecode(2);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(ceilingSettings.exposureMode, "manual");
assert.equal(ceilingSettings.exposureTime, 50, "verified QR shutter must be capped at 5 ms");
assert.equal(ceilingSettings.iso, 166, "shorter shutter should preserve the QR-proven light product with ISO");
assert.equal(ceilingWrites, 1, "QR shutter ceiling should require one deterministic sensor write");

// v0.5.370 regression: a QR that succeeds under short hardware AE freezes that
// actual exposure into manual once. The fake camera has a 0.1 ms shutter step,
// so 3.33 ms correctly quantizes to 3.30 ms. Subsequent AE/EV churn is suppressed,
// but focus fields in a mixed request still pass through independently.
const shortSettings = {
  focusMode: "continuous",
  exposureMode: "continuous",
  exposureTime: 33.3,
  iso: 148,
  exposureCompensation: -0.8,
  frameRate: 30
};
let shortWrites = 0;
const shortTrack = {
  readyState: "live",
  getCapabilities: track.getCapabilities,
  getSettings() { return { ...shortSettings }; },
  async applyConstraints({ advanced }) {
    shortWrites++;
    Object.assign(shortSettings, advanced[0]);
  }
};
const shortController = new FocusController(async () => true, () => {});
shortController.track = shortTrack;
shortController.noteValidDecode(3);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(shortWrites, 1, "short hardware AE should freeze into manual exactly once");
assert.equal(shortSettings.exposureMode, "manual");
assert.equal(shortSettings.exposureTime, 33);
assert.equal(shortSettings.iso, 148);
assert.equal(shortController.committedExposureTime, 33, "controller must adopt the physical QR-proven shutter");
assert.equal(shortController.committedIso, 148, "controller must adopt the physical QR-proven ISO");

await applyAdvancedConstraint(shortTrack, {
  exposureMode: "continuous",
  exposureCompensation: 0
});
assert.equal(shortWrites, 1, "fresh QR latch must suppress AE/EV reconsideration");
assert.equal(shortSettings.exposureMode, "manual");
assert.equal(shortSettings.exposureCompensation, -0.8);

await applyAdvancedConstraint(shortTrack, {
  focusMode: "continuous",
  exposureMode: "continuous",
  exposureCompensation: 0,
  pointsOfInterest: [{ x: 0.5, y: 0.5 }]
});
assert.equal(shortWrites, 2, "mixed AF+AE request should still deliver its focus half");
assert.equal(shortSettings.exposureMode, "manual", "mixed AF+AE request must not release the exposure latch");
assert.deepEqual(shortSettings.pointsOfInterest, [{ x: 0.5, y: 0.5 }]);

// The latch is deliberately simple: two seconds of QR silence is not enough if
// geometry is still moving. Once stable, exactly one exposure rescue is admitted,
// then further mutations are held for a bounded settle interval.
const syntheticAt = 10_000;
assert.equal(latchVerifiedExposure(shortTrack, {
  exposureMode: "manual",
  exposureTime: 33,
  iso: 148
}, syntheticAt), true);
assert.equal(verifiedExposureLatchDecision(shortTrack, syntheticAt + 1_999).hold, true);
noteExposureMotion(shortTrack, syntheticAt + 1_900);
assert.equal(verifiedExposureLatchDecision(shortTrack, syntheticAt + 2_500).hold, true, "moving geometry must extend the hold");
assert.equal(verifiedExposureLatchDecision(shortTrack, syntheticAt + 2_801).rescue, true, "stable long silence should admit one rescue");
assert.equal(consumeExposureRescue(shortTrack, syntheticAt + 2_801), true);
assert.equal(verifiedExposureLatchDecision(shortTrack, syntheticAt + 2_802).hold, true, "rescue must immediately re-arm bounded hold");
assert.equal(recoveryDiagnostics().exposureRescueCount, 1);

console.log("receiver recovery policy smoke: ok");
