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

// Stock GridLattice hard-reacquires after 900 ms. The receiver policy should
// retain a proven one-QR quad for several seconds because a single rolling seam
// makes 100% of the wall disappear even when the camera never moved.
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

// Conservative finder evidence may extend that lifetime without pretending a
// CRC packet was decoded. The sighting is shifted only two pixels, well inside
// the existing rescue-nudge guard.
const sighted = new GridLattice();
assert.ok(sighted.accept(detection(), 800, 800));
const sighting = [{ x: 102, y: 101, w: 400, h: 400 }];
assert.ok(sighted.nudgeFromSightings(sighting, 1000));
assert.ok(sighted.tick(4000), "recent matching finder evidence should keep low-count geometry alive");
assert.equal(sighted.state, "PARTIAL_LOSS");
endPoseRecovery();

class FakeWorker {
  postMessage() {}
  terminate() {}
}
const pool = new DecodeWorkerPool(() => new FakeWorker(), () => {}, () => {}, () => {}, () => {}, () => {}, () => {});
pool.resize(3);
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
const affinity = pool.__airgapperLowCountWorker;
assert.equal(affinity, 2);
// Simulate completion without invoking the fake worker callback; the next job
// asks for a different slot but must remain on the temporal-affinity worker.
pool.busy[2] = false;
pool.activeIds[2] = undefined;
clearTimeout(pool.jobTimers[2]);
pool.jobTimers[2] = undefined;
assert.equal(pool.submitTo(0, low(2, 2), []), true);
assert.equal(pool.busy[2], true, "1-2 QR jobs must stay on one worker so cached frames are adjacent");
assert.equal(pool.busy[0], false);

pool.busy[2] = false;
pool.activeIds[2] = undefined;
clearTimeout(pool.jobTimers[2]);
pool.jobTimers[2] = undefined;
assert.equal(pool.submit({ id: 3, full: true, w: 800, h: 800 }, []), true);
assert.equal(pool.busy[2], false, "full recovery should use another free worker and preserve temporal cache affinity");
assert.equal(pool.busy[0] || pool.busy[1], true);
endPoseRecovery();
pool.resize(0);

console.log("low-count receiver recovery smoke: ok");
