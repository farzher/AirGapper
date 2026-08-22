import assert from "node:assert/strict";
import { applyAdvancedConstraint } from "../shared/platform.js";
import { FocusController } from "../receive/focus-controller.js";
import { DecodeWorkerPool } from "../shared/worker-pool.js";
import {
  armWarmWorkerRestartSuppression,
  beginPoseRecovery,
  endPoseRecovery,
  recoveryDiagnostics
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

// Only a verified QR promotes the current manual state to the recovery prior.
const controller = new FocusController(async () => true, () => {});
controller.track = track;
controller.noteValidDecode(0);
await new Promise((resolve) => setTimeout(resolve, 0));

beginPoseRecovery("whole lattice stale; bounded QR re-anchor window");
await applyAdvancedConstraint(track, {
  exposureMode: "continuous",
  exposureCompensation: 0
});
assert.equal(cameraWrites, 1, "pose recovery must not surrender a QR-proven manual exposure to AE");
assert.equal(settings.exposureMode, "manual");
assert.equal(settings.exposureTime, 50);
assert.equal(settings.iso, 166);
// Promoting a new verified track state intentionally starts a fresh diagnostic
// counter epoch, so only the pose-recovery suppression is counted here.
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

console.log("receiver recovery policy smoke: ok");
