import { GridLattice } from "./grid-lattice.js";

const SOFT_LOSS_MS = 450;
const DORMANT_MS = 900;
const FULL_FIT_REFRESH_MS = 160;
const FRESH_PAYLOAD_HOLD_MS = 550;
window.airgapperFreshPayloadUntil = 0;

function noteFreshPayload(at) {
  const now = performance.now();
  const packetAt = Number(at);
  const base = Number.isFinite(packetAt) && Math.abs(now - packetAt) < 5000
    ? Math.max(now, packetAt)
    : now;
  window.airgapperFreshPayloadUntil = Math.max(
    Number(window.airgapperFreshPayloadUntil) || 0,
    base + FRESH_PAYLOAD_HOLD_MS
  );
}

function remember(lattice, snapshot) {
  if (snapshot) {
    lattice.__airgapperFrameSnapshot = snapshot;
    lattice.__airgapperFrameAt = undefined;
  }
  return snapshot;
}

const coalescedAccept = GridLattice.prototype.accept;
GridLattice.prototype.accept = function(detection, frameWidth, frameHeight) {
  const at = Number(detection?.at);

  // A CRC-valid packet proves the retained wall is still present even when its
  // new quad is too noisy/stale to refit. Refresh liveness before geometry work.
  if (this.candidate && Number.isFinite(at)) this.noteValidPacket(at);

  const priorFrameAt = this.__airgapperFrameAt;
  const sameFrame = Number.isFinite(at) && priorFrameAt === at;
  const lastFullFit = Number(this.__airgapperLastFullFitAt);
  const refreshDue = sameFrame && this.candidate && this.locked &&
    this.__airgapperFullFitAttemptAt !== at &&
    (!Number.isFinite(lastFullFit) || at - lastFullFit >= FULL_FIT_REFRESH_MS);

  if (refreshDue) {
    this.__airgapperFullFitAttemptAt = at;
    const cached = this.__airgapperFrameSnapshot;
    this.__airgapperFrameSnapshot = undefined;
    const result = coalescedAccept.call(this, detection, frameWidth, frameHeight);
    if (result) {
      this.__airgapperLastFullFitAt = at;
      if (Number.isFinite(at)) this.noteValidPacket(at);
      return result;
    }
    this.__airgapperFrameSnapshot = cached;
    return cached ?? result;
  }

  const result = coalescedAccept.call(this, detection, frameWidth, frameHeight);
  if (result && Number.isFinite(at)) {
    if (priorFrameAt !== at) {
      this.__airgapperLastFullFitAt = at;
      this.__airgapperFullFitAttemptAt = at;
    }
    this.noteValidPacket(at);
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

const baseNoteValidPacket = GridLattice.prototype.noteValidPacket;
GridLattice.prototype.noteValidPacket = function(at = this.lastHitAt) {
  const result = baseNoteValidPacket.call(this, at);
  const packetAt = Number(at);
  const now = performance.now();
  if (this.candidate && Number.isFinite(packetAt) && packetAt <= now + 50 && now - packetAt <= DORMANT_MS) {
    this.pendingInvalidationReason = "";
    this.lastHitAt = Math.max(this.lastHitAt, packetAt);
    if (this.state === "DORMANT" || this.state === "PARTIAL_LOSS" || this.state === "GRID_LOCK") {
      this.transition("TRACK", "fresh CRC payload kept retained lattice live", packetAt);
    }
    noteFreshPayload(packetAt);
    if (this.__airgapperFrameSnapshot) {
      this.__airgapperFrameSnapshot.state = this.state;
      this.__airgapperFrameSnapshot.provisional = !this.active;
    }
  }
  return result;
};

const baseTick = GridLattice.prototype.tick;
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