import assert from "node:assert/strict";
import {
  PRIMARY_SEAMS,
  stitchModuleRows,
  temporalEnabledForCount,
  tryTemporalPair
} from "../receive/temporal-qr-stitch.js";

assert.equal(temporalEnabledForCount(1), true);
assert.equal(temporalEnabledForCount(2), true);
assert.equal(temporalEnabledForCount(3), false, "dense walls must never pay temporal repair CPU");

const dim = 21;
const total = dim * dim;
const makeGrid = (seed) => Uint8Array.from({ length: total }, (_, index) =>
  ((Math.imul(index + 17, 1103515245) + seed * 12345) >>> ((index + seed) & 7)) & 1 ? 255 : 0
);
const a = makeGrid(1);
const b = makeGrid(2);
const c = makeGrid(3);
const seam = Math.round(dim * PRIMARY_SEAMS[0]);
const split = (top, bottom) => {
  const out = new Uint8Array(total);
  const at = seam * dim;
  out.set(top.subarray(0, at));
  out.set(bottom.subarray(at), at);
  return out;
};
const quad = {
  topLeft: { x: 10, y: 10 },
  topRight: { x: 220, y: 10 },
  bottomRight: { x: 220, y: 220 },
  bottomLeft: { x: 10, y: 220 }
};
const previous = { slot: 0, dim, modules: split(a, b), quad, sourceSequence: 100 };
const current = { slot: 0, dim, modules: split(b, c), quad, sourceSequence: 101 };
const equals = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
const result = tryTemporalPair(previous, current, (grid) =>
  equals(grid, b) ? { bytes: new Uint8Array([1, 2, 3]), header: { slotIndex: 0 }, modules: dim } : null
);
assert.ok(result.hit, "adjacent rolling-shutter halves should reconstruct the shared sender QR");
assert.equal(result.attempts, 1, "normal top-to-bottom scan orientation should win first");
assert.equal(result.hit.orientation, "current-top/previous-bottom");
assert.equal(result.hit.seam, seam);
assert.equal(result.hit.sourceDelta, 1);

const direct = stitchModuleRows(previous, current, seam, "current-top/previous-bottom");
assert.ok(equals(direct, b));

const moved = {
  ...current,
  quad: {
    topLeft: { x: 80, y: 80 },
    topRight: { x: 290, y: 80 },
    bottomRight: { x: 290, y: 290 },
    bottomLeft: { x: 80, y: 290 }
  }
};
const movedResult = tryTemporalPair(previous, moved, () => ({ bytes: new Uint8Array([9]) }));
assert.equal(movedResult.hit, null);
assert.equal(movedResult.attempts, 0, "large camera motion must skip temporal stitching rather than burn CPU");

console.log("low-count temporal QR stitch smoke: ok");
