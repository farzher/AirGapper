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
    this.posts = [];
  }
  postMessage(message) { this.posts.push(message); }
  terminate() { this.terminated = true; }
}
const createdKinds = [];
const pool = new DecodeWorkerPool((kind = "normal") => {
  createdKinds.push(kind ?? "normal");
  return new FakeWorker(kind ?? "normal");
}, () => {}, () => {}, () => {}, () => {}, () => {}, () => {});
pool.resize(3);
assert.deepEqual(pool.workers.map((worker) => worker.kind), ["normal", "normal", "normal"],
  "search/acquisition must start with production workers only");

const low = (id, sourceSequence) => ({
  id,
  full: false,
  pixelFormat: "y8",
  sourceSequence,
  w: 800,
  h: 800,
  yStride: 800,
  yOffset: 0,
  videoFrame: new ArrayBuffer(800 * 800),
  tracks: [{ slot: 0, dim: 177, quad: detection().quad }]
});
assert.equal(pool.submitTo(2, low(1, 1), []), true);
assert.equal(pool.busy[2], true, "ordinary low-count decode must still use the requested normal worker");
assert.equal(pool.workers[2].kind, "normal", "temporal recovery must never replace a production worker slot");
assert.equal(pool.workers.every((worker) => worker.kind === "normal"), true);
const companion = pool.__airgapperTemporalV2?.worker;
assert.equal(companion?.kind, "temporal-v2", "low-count should create the bounded out-of-pool companion");
assert.equal(companion.posts.length, 1, "first low-count frame should create exactly one sample command");

// While that sample is in flight, another low-count decode still uses a normal
// worker but must not queue another camera frame into the companion.
pool.busy[2] = false;
pool.activeIds[2] = undefined;
clearTimeout(pool.jobTimers[2]);
pool.jobTimers[2] = undefined;
assert.equal(pool.submitTo(0, low(2, 2), []), true);
assert.equal(pool.busy[0], true);
assert.equal(companion.posts.length, 1, "busy companion must apply hard backpressure");
assert.equal(pool.workers.every((worker) => worker.kind === "normal"), true);
assert.ok(createdKinds.includes("temporal-v2"));
assert.equal(createdKinds.filter((kind) => kind === "temporal-v2").length, 1);

endPoseRecovery();
pool.resize(0);
console.log("low-count receiver recovery smoke: ok");
