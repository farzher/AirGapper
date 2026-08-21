import assert from "node:assert/strict";
import { applyAdvancedConstraint } from "../shared/platform.js";
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
  exposureCompensation: 0
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

await applyAdvancedConstraint(track, {
  exposureMode: "manual",
  exposureTime: 50,
  iso: 166
});
assert.equal(cameraWrites, 1);
assert.equal(settings.exposureMode, "manual");

beginPoseRecovery("whole lattice stale; bounded QR re-anchor window");
await applyAdvancedConstraint(track, {
  exposureMode: "continuous",
  exposureCompensation: 0
});
assert.equal(cameraWrites, 1, "pose recovery must not surrender a known manual exposure to AE");
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
console.log("receiver recovery policy smoke: ok");
