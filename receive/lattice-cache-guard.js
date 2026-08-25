import { GridLattice } from "./grid-lattice.js";

const SOFT_LOSS_MS = 450;
const DORMANT_MS = 900;
const FULL_FIT_REFRESH_MS = 160;
const FRESH_PAYLOAD_HOLD_MS = 550;
window.airgapperFreshPayloadUntil = 0;

function noteFreshPayload() {
  const now = performance.now();
  window.airgapperFreshPayloadUntil = Math.max(
    Number(window.airgapperFreshPayloadUntil) || 0,
    now + FRESH_PAYLOAD_HOLD_MS
  );
  return now;
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

  // Geometry remains ordered by the source-frame timestamp. Payload liveness is
  // deliberately a separate completion-time clock below: a slow but valid decode
  // must not make the wall look absent merely because its source frame is old.
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
  if (!this.candidate) return result;

  // A CRC-valid packet is current wall-presence evidence at the moment it is
  // decoded, regardless of how old its camera frame is. Keep that receipt clock
  // independent from lastHitAt, which remains the geometry/source-frame clock.
  const payloadAt = noteFreshPayload();
  this.__airgapperLastPayloadAt = payloadAt;
  this.pendingInvalidationReason = "";
  if (this.state === "DORMANT" || this.state === "PARTIAL_LOSS" || this.state === "GRID_LOCK") {
    this.transition("TRACK", "fresh CRC payload kept retained lattice live", payloadAt);
  }
  if (this.__airgapperFrameSnapshot) {
    this.__airgapperFrameSnapshot.state = this.state;
    this.__airgapperFrameSnapshot.provisional = !this.active;
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

  // Presence is based on successful packet completion; geometry freshness is a
  // separate concern. This prevents slow guided jobs from aging a live wall into
  // global recovery while still allowing old quads to be repaired locally.
  const lastPayloadAt = Number(this.__airgapperLastPayloadAt) || 0;
  const staleMs = lastPayloadAt > 0 ? now - lastPayloadAt : now - this.lastHitAt;
  if (staleMs > DORMANT_MS) {
    this.transition("DORMANT", "whole lattice payload stale; dormant geometry retained while acquisition owns scanner", now);
  } else if (staleMs > SOFT_LOSS_MS) {
    this.transition("PARTIAL_LOSS", "whole lattice payload stale; bounded recovery with proven geometry retained", now);
  } else if (this.state === "DORMANT" || this.state === "PARTIAL_LOSS" || this.state === "GRID_LOCK") {
    this.transition("TRACK", "recent CRC payload keeps lattice live", now);
  }

  const snapshot = this.__airgapperFrameSnapshot;
  snapshot.state = this.state;
  snapshot.provisional = !this.active;
  return snapshot;
};