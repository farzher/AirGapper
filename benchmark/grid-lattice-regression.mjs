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

// Short camera/display miss bursts keep the proven wall alive.
snapshot = lattice.tick(1750);
assert(snapshot, "a short miss should preserve the tracked wall");
assert.equal(lattice.locked, true);
assert.notEqual(lattice.state, "REACQUIRE");

// Once silence exceeds the soft timeout, keep only a bounded re-anchor window.
snapshot = lattice.tick(1960);
assert(snapshot, "soft loss should retain geometry briefly for QR re-anchor");
assert.equal(lattice.locked, true);
assert.equal(lattice.active, true);
assert.equal(lattice.state, "PARTIAL_LOSS");

// A stale pose must never stay on the hot path. After whole-wall payload and
// geometry silence, retain it only as an inactive acquisition prior.
snapshot = lattice.tick(2361);
assert(snapshot, "dormant loss should retain a cheap re-anchor prior");
assert.equal(lattice.state, "DORMANT");
assert.equal(lattice.locked, false);
assert.equal(lattice.active, false);
assert.equal(snapshot.provisional, true);

// The first fresh CRC-valid QR owns the new pose. Even a radically different
// camera position must re-seed from that packet instead of mixing stale anchors.
snapshot = lattice.accept(detection(10, 2380, { dx: -260, dy: 310, scale: 1.75 }), frameWidth, frameHeight);
assert(snapshot, "one verified QR must relock after hard geometry reacquire");
assert.equal(lattice.locked, true);
assert.equal(lattice.state, "TRACK", "fresh CRC payload should immediately promote the re-seeded wall to TRACK");
assert.equal(snapshot.distributedFit, false, "one-QR re-anchor is local until cross-axis evidence returns");
assert.equal(snapshot.fitSlots, 1);

// Explicit pose invalidation (used by orientation changes) must be consumed by
// tick so the receiver's existing REACQUIRE branch observes the locked->reacquire edge.
assert.equal(lattice.invalidatePose("screen orientation changed"), true);
snapshot = lattice.tick(2390);
assert.equal(snapshot, null);
assert.equal(lattice.state, "REACQUIRE");

// Repeated per-slot self-heals are local failures. They must not destroy a wall
// that still has a valid global pose. Whole-wall silence moves the prior off the
// hot path into DORMANT; explicit pose invalidation is the immediate hard reset.
const healing = new GridLattice();
for (const [slot, at] of [[0, 0], [1, 20], [4, 40], [5, 60]]) {
  assert(healing.accept(detection(slot, at), frameWidth, frameHeight));
}
for (const [slot, at] of [[0, 300], [1, 320], [4, 340], [5, 360]]) {
  healing.dropSlotCorrection(slot, at);
}
assert(healing.tick(370), "local self-heals must keep the global wall alive");
assert.equal(healing.locked, true);
assert.notEqual(healing.state, "REACQUIRE");
const dormantHealing = healing.tick(2000);
assert(dormantHealing, "whole-wall silence should retain only an inactive re-anchor prior");
assert.equal(healing.state, "DORMANT");
assert.equal(healing.locked, false);
assert.equal(healing.active, false);
assert.equal(dormantHealing.provisional, true);

// Extended-grid regression: Auto can declare a wall above the old 32-slot
// ceiling and the lattice must expose every physical slot.
const extended = new GridLattice();
const extCols = 8;
const extRows = 12;
const extModules = 77;
const extStride = extModules + 1;
const extSlot = 95;
const extCol = extSlot % extCols;
const extRow = Math.floor(extSlot / extCols);
const extScale = 1.3;
const extX = 80 + extCol * extStride * extScale;
const extY = 120 + extRow * extStride * extScale;
const extEdge = extModules * extScale;
const extSnapshot = extended.accept({
  identity: "extended-grid-regression",
  layoutId: 0,
  extendedGrid: true,
  gridCols: extCols,
  gridRows: extRows,
  slotIndex: extSlot,
  modules: extModules,
  at: 1,
  scanId: 1,
  quad: {
    topLeft: { x: extX, y: extY },
    topRight: { x: extX + extEdge, y: extY },
    bottomRight: { x: extX + extEdge, y: extY + extEdge },
    bottomLeft: { x: extX, y: extY + extEdge }
  },
  box: { x: extX, y: extY, w: extEdge, h: extEdge }
}, 1600, 2600);
assert(extSnapshot, "extended grid should lock from one verified QR");
assert.equal(extSnapshot.layout.cols, extCols);
assert.equal(extSnapshot.layout.rows, extRows);
assert.equal(extSnapshot.slots.length, 96, "extended grid must expose slots above 31");
assert.equal(extSnapshot.slots[95].index, 95);

console.log("grid-lattice regression: ok");
