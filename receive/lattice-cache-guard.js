import { GridLattice } from "./grid-lattice.js";

const SOFT_LOSS_MS = 450;
const DORMANT_MS = 900;
const baseTick = GridLattice.prototype.tick;

// A lattice snapshot contains the projected quad/box object graph for every QR
// slot. It depends on candidate geometry and slot corrections, not on wall-clock
// time. runtime-guards refreshes __airgapperFrameSnapshot whenever geometry is
// actually changed. Reuse that object graph between geometry updates instead of
// allocating/projecting the complete wall again on every camera tick.
GridLattice.prototype.tick = function(now) {
  if (!this.candidate || this.pendingInvalidationReason || !this.__airgapperFrameSnapshot) {
    return baseTick.call(this, now);
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
