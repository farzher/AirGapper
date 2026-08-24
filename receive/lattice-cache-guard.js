import { GridLattice } from "./grid-lattice.js";

const SOFT_LOSS_MS = 450;
const DORMANT_MS = 900;
const FULL_FIT_REFRESH_MS = 160;

function remember(lattice, snapshot) {
  if (snapshot) {
    lattice.__airgapperFrameSnapshot = snapshot;
    // Geometry changed outside a camera-frame accept/nudge. Do not let a later
    // packet with an unrelated timestamp qualify for same-frame coalescing.
    lattice.__airgapperFrameAt = undefined;
  }
  return snapshot;
}

const coalescedAccept = GridLattice.prototype.accept;
GridLattice.prototype.accept = function(detection, frameWidth, frameHeight) {
  const at = Number(detection?.at);
  const priorFrameAt = this.__airgapperFrameAt;
  const sameFrame = Number.isFinite(at) && priorFrameAt === at;
  const lastFullFit = Number(this.__airgapperLastFullFitAt);
  const refreshDue = sameFrame && this.candidate && this.locked &&
    this.__airgapperFullFitAttemptAt !== at &&
    (!Number.isFinite(lastFullFit) || at - lastFullFit >= FULL_FIT_REFRESH_MS);

  if (refreshDue) {
    // runtime-guards interprets a same-frame cached snapshot as permission to
    // record the QR without another homography. Temporarily withdraw that cache
    // for the first QR of this refresh frame so the original GridLattice.accept
    // performs one real projective fit from the accumulated CRC observations.
    // Record the attempt even when the fit rejects noisy geometry so the other
    // 20+ QR results from this same camera frame do not all retry the 8x8 solve.
    this.__airgapperFullFitAttemptAt = at;
    const cached = this.__airgapperFrameSnapshot;
    this.__airgapperFrameSnapshot = undefined;
    const result = coalescedAccept.call(this, detection, frameWidth, frameHeight);
    if (result) {
      this.__airgapperLastFullFitAt = at;
      return result;
    }
    this.__airgapperFrameSnapshot = cached;
    return cached ?? result;
  }

  const result = coalescedAccept.call(this, detection, frameWidth, frameHeight);
  if (result && Number.isFinite(at) && priorFrameAt !== at) {
    this.__airgapperLastFullFitAt = at;
    this.__airgapperFullFitAttemptAt = at;
  }
  return result;
};

const baseDropSlotCorrection = GridLattice.prototype.dropSlotCorrection;
GridLattice.prototype.dropSlotCorrection = function(slot, at) {
  return remember(this, baseDropSlotCorrection.call(this, slot, at));
};

const baseNudgeFromSightings = GridLattice.prototype.nudgeFromSightings;
GridLattice.prototype.nudgeFromSightings = function(sightings, at) {
  return remember(this, baseNudgeFromSightings.call(this, sightings, at));
};

// A recent CRC-valid payload is direct evidence that the same optical wall is
// still present even when the worker intentionally thinned geometry reports or
// a projective refit rejected noisy coordinates. Let that payload refresh only
// liveness; geometry itself still changes only through measured accept/nudge.
const baseNoteValidPacket = GridLattice.prototype.noteValidPacket;
GridLattice.prototype.noteValidPacket = function(at = this.lastHitAt) {
  const result = baseNoteValidPacket.call(this, at);
  const packetAt = Number(at);
  const now = performance.now();
  if (this.candidate && !this.pendingInvalidationReason && Number.isFinite(packetAt) &&
      packetAt <= now + 50 && now - packetAt <= DORMANT_MS) {
    this.lastHitAt = Math.max(this.lastHitAt, packetAt);
    if (this.state === "DORMANT") {
      this.transition("GRID_LOCK", "fresh CRC payload reactivated retained lattice", packetAt);
      if (this.__airgapperFrameSnapshot) {
        this.__airgapperFrameSnapshot.state = this.state;
        this.__airgapperFrameSnapshot.provisional = !this.active;
      }
    }
  }
  return result;
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
