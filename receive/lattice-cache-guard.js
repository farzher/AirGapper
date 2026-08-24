import { GridLattice } from "./grid-lattice.js";

const SOFT_LOSS_MS = 450;
const DORMANT_MS = 900;

function remember(lattice, snapshot) {
  if (snapshot) {
    lattice.__airgapperFrameSnapshot = snapshot;
    // Geometry changed outside a camera-frame accept/nudge. Do not let a later
    // packet with an unrelated timestamp qualify for same-frame coalescing.
    lattice.__airgapperFrameAt = undefined;
  }
  return snapshot;
}

const baseDropSlotCorrection = GridLattice.prototype.dropSlotCorrection;
GridLattice.prototype.dropSlotCorrection = function(slot, at) {
  return remember(this, baseDropSlotCorrection.call(this, slot, at));
};

const baseNudgeFromSightings = GridLattice.prototype.nudgeFromSightings;
GridLattice.prototype.nudgeFromSightings = function(sightings, at) {
  return remember(this, baseNudgeFromSightings.call(this, sightings, at));
};

const baseTick = GridLattice.prototype.tick;

// A lattice snapshot contains the projected quad/box object graph for every QR
// slot. It depends on candidate geometry and slot corrections, not on wall-clock
// time. runtime-guards refreshes __airgapperFrameSnapshot whenever geometry is
// actually changed. Reuse that object graph between geometry updates instead of
// allocating/projecting the complete wall again on every camera tick.
GridLattice.prototype.tick = function(now) {
  if (!this.candidate || this.pendingInvalidationReason) {
    return remember(this, baseTick.call(this, now));
  }
  if (!this.__airgapperFrameSnapshot) {
    return remember(this, baseTick.call(this, now));
  }

  const staleMs = now - this.lastHitAt;
  if (staleMs > DORMANT_MS) {
    this.transition("DORMANT", "whole lattice stale; dormant geometry retained while fresh acquisition owns scanner", now);
  } else if (staleMs > SOFT_LOSS_MS) {
    this.transition("PARTIAL_LOSS", "whole lattice stale; bounded recovery with proven geometry retained", now);
  }

  const snapshot = this.__airgapperFrameSnapshot;
  snapshot.state = this.state;
  snapshot.provisional = !this.active;
  return snapshot;
};
