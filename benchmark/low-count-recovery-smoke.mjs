import assert from "node:assert/strict";
import "../shared/platform.js";
import { GridLattice } from "../receive/grid-lattice.js";
import { DecodeWorkerPool } from "../shared/worker-pool.js";
import { endPoseRecovery } from "../shared/receiver-recovery-state.js";

function detection(at = 100) {
  const quad = {
    topLeft: { x: 100, y: 100 },
    topRight: { x: 500, y: 100 },
    bottomRight: { x: 500, y: 500 },
    bottomLeft: { x: 100, y: 500 }
  };
  return {
    identity: "low-count-test",
    layoutId: 0,
    slotIndex: 0,
    modules: 177,
    quad,
    box: { x: 100, y: 100, w: 400, h: 400 },
    at,
    scanId: 1
  };
}

const lattice = new GridLattice();
assert.ok(lattice.accept(detection(), 800, 800));
assert.equal(lattice.locked, true);
assert.ok(lattice.tick(1200), "one-QR geometry should survive a 1.1 s decode outage");
assert.equal(lattice.state, "PARTIAL_LOSS");
assert.ok(lattice.candidate);
lattice.tick(3601);
assert.equal(lattice.state, "REACQUIRE", "one-QR pose must still expire after a bounded outage without finder evidence");
assert.equal(lattice.candidate, undefined);
endPoseRecovery();

const sighted = new GridLattice();
assert.ok(sighted.accept(detection(), 800, 800));
const sighting = [{ x: 102, y: 101, w: 400, h: 400 }];
assert.ok(sighted.nudgeFromSightings(sighting, 1000));
assert.ok(sighted.tick(4000), "recent matching finder evidence should keep low-count geometry alive");
assert.equal(sighted.state, "PARTIAL_LOSS");
endPoseRecovery();

class FakeWorker {
  constructor(kind = "normal") {
    this.kind = kind;
    this.terminated = false;
  }
  postMessage() {}
  terminate() { this.terminated = true; }
}
const createdKinds = [];
const pool = new DecodeWorkerPool((kind = "normal") => {
  createdKinds.push(kind ?? "normal");
  return new FakeWorker(kind ?? "normal");
}, () => {}, () => {}, () => {}, () => {}, () => {}, () => {});
pool.resize(3);
assert.deepEqual(pool.workers.map((worker) => worker.kind), ["normal", "normal", "normal"],
  "search/acquisition must start with untouched production workers only");

const low = (id, sourceSequence) => ({
  id,
  full: false,
  pixelFormat: "y8",
  sourceSequence,
  w: 800,
  h: 800,
  tracks: [{ slot: 0, dim: 177, quad: detection().quad }]
});
assert.equal(pool.submitTo(2, low(1, 1), []), true);
assert.equal(pool.busy[2], true);
assert.equal(pool.__airgapperLowCountWorker, 2);
assert.equal(pool.workers[2].kind, "temporal", "first 1-2 QR tracked job should specialize exactly one idle slot");
assert.deepEqual(pool.workers.slice(0, 2).map((worker) => worker.kind), ["normal", "normal"]);

pool.busy[2] = false;
pool.activeIds[2] = undefined;
clearTimeout(pool.jobTimers[2]);
pool.jobTimers[2] = undefined;
const sameTemporalWorker = pool.workers[2];
assert.equal(pool.submitTo(0, low(2, 2), []), true);
assert.equal(pool.busy[2], true, "1-2 QR jobs must stay on one worker so cached frames are adjacent");
assert.equal(pool.workers[2], sameTemporalWorker, "temporal history worker must not migrate between adjacent frames");
assert.equal(pool.busy[0], false);

pool.busy[2] = false;
pool.activeIds[2] = undefined;
clearTimeout(pool.jobTimers[2]);
pool.jobTimers[2] = undefined;
assert.equal(pool.submit({ id: 3, full: true, w: 800, h: 800 }, []), true);
assert.equal(pool.__airgapperLowCountWorker, undefined, "full acquisition must release temporal affinity");
assert.equal(pool.workers[2].kind, "normal", "full acquisition must restore the specialized slot to production worker.js");
assert.equal(pool.workers.every((worker) => worker.kind === "normal"), true,
  "dense/acquisition mode must recover the complete production worker pool");
assert.ok(createdKinds.includes("temporal"), "test factory should have created one temporal specialization");
assert.equal(createdKinds.at(-1), "normal", "restoring acquisition should instantiate a normal worker");

endPoseRecovery();
pool.resize(0);
console.log("low-count receiver recovery smoke: ok");
