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

// Predicted CRC-valid QRs can now carry a tiny current-frame similarity update.
// It must move every distributed anchor together, not merely the easy QR that
// produced the residual.
const beforeMotion = snapshot.slots[27].quad.topLeft;
const motion = { a: 1.004, b: 0.003, tx: -3, ty: 2, dx: 1.5, dy: 1.2, maxShift: 4.2, samples: 4 };
snapshot = lattice.nudgeMotion(motion, 1420);
assert(snapshot, "safe similarity motion should update a locked lattice");
const afterMotion = snapshot.slots[27].quad.topLeft;
assert.ok(Math.abs(afterMotion.x - (motion.a * beforeMotion.x - motion.b * beforeMotion.y + motion.tx)) < 1e-5);
assert.ok(Math.abs(afterMotion.y - (motion.b * beforeMotion.x + motion.a * beforeMotion.y + motion.ty)) < 1e-5);
assert.equal(snapshot.distributedFit, true, "motion feedback must preserve trusted distributed geometry");
assert.equal(lattice.nudgeMotion({ a: 1.2, b: 0, tx: 0, ty: 0, dx: 1, dy: 1, maxShift: 2, samples: 4 }, 1440), null,
  "unsafe scale jumps must be rejected");

snapshot = lattice.accept(detection(0, 1460, { dx: 154, dy: 98 }), frameWidth, frameHeight);
assert(snapshot, "measured geometry after a coherent frame nudge must remain usable");
assert.equal(lattice.locked, true);
assert.equal(snapshot.distributedFit, true);

// Close-up regression: decode silence must never erase a CRC-proven wall. The
// old 3200 ms tick timeout forced REACQUIRE, which in turn woke expensive cold
// acquisition and Auto Optics races. Retain the stale wall as PARTIAL_LOSS.
snapshot = lattice.tick(12000);
assert(snapshot, "a proven wall must survive long decoder silence");
assert.equal(lattice.locked, true, "silence must keep the lattice locked for bounded recovery");
assert.equal(lattice.active, true, "silence must not fall back to cold acquisition");
assert.equal(lattice.state, "PARTIAL_LOSS");

// One CRC-valid QR at a radically different camera pose has four measured
// corners, enough to rebuild the full projective wall transform immediately.
snapshot = lattice.accept(detection(10, 12020, { dx: -260, dy: 310, scale: 1.75 }), frameWidth, frameHeight);
assert(snapshot, "one verified QR must re-anchor a stale wall");
assert.equal(lattice.locked, true);
assert.equal(lattice.state, "TRACK");
assert.equal(snapshot.distributedFit, false, "one-QR re-anchor is local until cross-axis evidence returns");
assert.equal(snapshot.fitSlots, 1, "stale old-pose anchors must be discarded on the new pose");

console.log("grid-lattice regression: ok");
