import assert from "node:assert/strict";
import { GridLattice } from "../receive/grid-lattice.js";

const layoutId = 10; // 4x7
const cols = 4;
const modules = 177;
const stride = modules + 1;
const frameWidth = 1440;
const frameHeight = 2560;

function quadFor(slot, { dx = 0, dy = 0, scale = 1.18 } = {}) {
  const col = slot % cols;
  const row = Math.floor(slot / cols);
  const x = 105 + col * stride * scale + dx;
  const y = 180 + row * stride * scale + dy;
  const edge = modules * scale;
  const quad = {
    topLeft: { x, y },
    topRight: { x: x + edge, y },
    bottomRight: { x: x + edge, y: y + edge },
    bottomLeft: { x, y: y + edge }
  };
  return {
    quad,
    box: { x, y, w: edge, h: edge }
  };
}

let scanId = 0;
function detection(slot, at, pose = {}) {
  return {
    identity: "grid-lattice-regression",
    layoutId,
    slotIndex: slot,
    modules,
    at,
    scanId: scanId++,
    ...quadFor(slot, pose)
  };
}

const lattice = new GridLattice();

// One verified QR must still activate the wall immediately.
let snapshot = lattice.accept(detection(0, 0), frameWidth, frameHeight);
assert(snapshot, "first QR should create a grid snapshot");
assert.equal(lattice.active, true, "one QR should immediately activate tracked decoding");
assert.equal(snapshot.distributedFit, false, "one QR is a local geometric seed, not a distributed fit");
assert.equal(snapshot.fitSlots, 1);

// A diagonally separated QR constrains both wall axes.
snapshot = lattice.accept(detection(27, 100), frameWidth, frameHeight);
assert.equal(snapshot.distributedFit, true, "cross-axis observations should establish a distributed fit");
assert.ok(snapshot.fitSlots >= 2);

// Regression for the v271-v274 half-grid trap: once the newest 420 ms contains
// only the easy local QR, it must NOT discard the still-compatible distributed
// anchor and refit the entire wall from one QR.
snapshot = lattice.accept(detection(0, 700, { dx: 5, dy: 3 }), frameWidth, frameHeight);
assert.equal(snapshot.distributedFit, true, "one newer easy QR must not collapse a compatible distributed wall fit");
assert.ok(snapshot.fitSlots >= 2, "distributed anchors must survive a local-only fresh window");

// A genuine large pose jump should reject stale old-pose anchors. Immediate
// one-QR tracking remains available, but the fit must advertise itself as local
// so acquisition bootstrap can actively search for fresh cross-axis evidence.
snapshot = lattice.accept(detection(0, 1300, { dx: 150, dy: 95 }), frameWidth, frameHeight);
assert.equal(lattice.active, true, "large movement must not block provisional tracked decoding");
assert.equal(snapshot.distributedFit, false, "after stale anchors are rejected, the new pose must re-enter local bootstrap");
assert.equal(snapshot.fitSlots, 1);

// A second QR from only the same row is still not enough for a 2D wall.
snapshot = lattice.accept(detection(1, 1340, { dx: 150, dy: 95 }), frameWidth, frameHeight);
assert.equal(snapshot.distributedFit, false, "same-row observations must remain a local 2D fit");

// Fresh diagonal evidence completes bootstrap again.
snapshot = lattice.accept(detection(27, 1380, { dx: 150, dy: 95 }), frameWidth, frameHeight);
assert.equal(snapshot.distributedFit, true, "fresh cross-axis evidence should re-establish distributed geometry");
assert.ok(snapshot.fitSlots >= 2);

console.log("grid-lattice regression: ok");
