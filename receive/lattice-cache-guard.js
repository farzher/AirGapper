import { GridLattice } from "./grid-lattice.js";

const SOFT_LOSS_MS = 450;
const DORMANT_MS = 900;
const OBSERVATION_HISTORY_MS = 2500;
const CORRECTION_REFRESH_MS = 180;
const FULL_FIT_REFRESH_MS = 160;

const activeDescriptor = Object.getOwnPropertyDescriptor(GridLattice.prototype, "active");
if (activeDescriptor?.configurable) {
  Object.defineProperty(GridLattice.prototype, "active", {
    configurable: true,
    get() {
      return this.state !== "SEARCH" && this.state !== "REACQUIRE" && this.state !== "DORMANT";
    }
  });
}

function clearCache(lattice) {
  lattice.__airgapperFrameAt = undefined;
  lattice.__airgapperFrameSnapshot = undefined;
  lattice.__airgapperCorrectionAt = undefined;
  lattice.__airgapperLastFullFitAt = undefined;
  lattice.__airgapperFullFitAttemptAt = undefined;
  lattice.__airgapperPayloadAt = undefined;
}

function cacheFrameSnapshot(lattice, at, snapshot) {
  const frameAt = Number(at);
  if (snapshot && Number.isFinite(frameAt)) {
    lattice.__airgapperFrameAt = frameAt;
    lattice.__airgapperFrameSnapshot = snapshot;
  }
  return snapshot;
}

function cacheOutOfBandSnapshot(lattice, snapshot) {
  if (snapshot) {
    lattice.__airgapperFrameSnapshot = snapshot;
    lattice.__airgapperFrameAt = undefined;
  }
  return snapshot;
}

function notePayloadAlive(lattice) {
  if (!lattice.candidate || lattice.pendingInvalidationReason) return false;
  const now = performance.now();
  lattice.__airgapperPayloadAt = now;
  const geometryAge = now - lattice.lastHitAt;
  lattice.transition(
    geometryAge > SOFT_LOSS_MS ? "PARTIAL_LOSS" : "TRACK",
    geometryAge > SOFT_LOSS_MS
      ? "valid payload kept wall alive; geometry awaiting refresh"
      : "valid payload kept lattice alive",
    now
  );
  return true;
}

const baseReset = GridLattice.prototype.reset;
GridLattice.prototype.reset = function() {
  clearCache(this);
  return baseReset.call(this);
};

const baseReacquire = GridLattice.prototype.reacquire;
GridLattice.prototype.reacquire = function(at, reason) {
  clearCache(this);
  return baseReacquire.call(this, at, reason);
};

const baseNoteValidPacket = GridLattice.prototype.noteValidPacket;
GridLattice.prototype.noteValidPacket = function() {
  if (!this.candidate) return baseNoteValidPacket.call(this);
  return notePayloadAlive(this);
};

const baseNudgeMotion = GridLattice.prototype.nudgeMotion;
GridLattice.prototype.nudgeMotion = function(motion, at = this.lastHitAt) {
  return cacheFrameSnapshot(this, at, baseNudgeMotion.call(this, motion, at));
};

function sameFrameCompatible(lattice, detection) {
  const at = Number(detection?.at);
  const candidate = lattice.candidate;
  if (!candidate || !lattice.locked || lattice.pendingInvalidationReason ||
      !lattice.__airgapperFrameSnapshot || at !== lattice.__airgapperFrameAt ||
      detection?.identity !== lattice.identity || !Number.isInteger(detection?.slotIndex) ||
      detection.slotIndex < 0 || detection.slotIndex >= candidate.layout.cols * candidate.layout.rows ||
      !Number.isFinite(Number(detection?.modules)) ||
      Number(detection.modules) !== Number(candidate.observations?.[0]?.modules)) return false;
  if (detection.extendedGrid) {
    return Boolean(candidate.layout.extendedGrid) && Number(detection.gridCols) === candidate.layout.cols &&
      Number(detection.gridRows) === candidate.layout.rows;
  }
  return !candidate.layout.extendedGrid && Number(detection.layoutId) === Number(candidate.layout.id);
}

function recordSameFrameObservation(lattice, detection, frameWidth, frameHeight) {
  const at = Number(detection.at);
  lattice.lastHitAt = Math.max(lattice.lastHitAt, at);
  lattice.frameWidth = Math.max(1, frameWidth);
  lattice.frameHeight = Math.max(1, frameHeight);

  let existing = -1;
  for (let index = lattice.observations.length - 1; index >= 0; index--) {
    const item = lattice.observations[index];
    if (lattice.lastHitAt - item.at >= OBSERVATION_HISTORY_MS || item.modules !== detection.modules) {
      lattice.observations.splice(index, 1);
      continue;
    }
    if (item.slotIndex === detection.slotIndex) existing = index;
  }

  let geometryFresh = true;
  if (existing >= 0) {
    const prior = lattice.observations[existing];
    geometryFresh = at > prior.at || at === prior.at && Number(detection.scanId) >= Number(prior.scanId);
    if (geometryFresh) lattice.observations[existing] = detection;
  } else {
    lattice.observations.push(detection);
  }

  if (geometryFresh) {
    let correctionAt = lattice.__airgapperCorrectionAt;
    if (!correctionAt) correctionAt = lattice.__airgapperCorrectionAt = new Float64Array(128);
    const slot = detection.slotIndex;
    if (!lattice.slotCorrections.has(slot) || at - correctionAt[slot] >= CORRECTION_REFRESH_MS) {
      lattice.learnSlotCorrection(detection);
      correctionAt[slot] = at;
    }
  }

  notePayloadAlive(lattice);
  const snapshot = lattice.__airgapperFrameSnapshot;
  snapshot.state = lattice.state;
  snapshot.provisional = !lattice.active;
  return snapshot;
}

const baseAccept = GridLattice.prototype.accept;
GridLattice.prototype.accept = function(detection, frameWidth, frameHeight) {
  const at = Number(detection?.at);

  if (sameFrameCompatible(this, detection)) {
    const lastFullFit = Number(this.__airgapperLastFullFitAt);
    const refreshDue = this.__airgapperFullFitAttemptAt !== at &&
      (!Number.isFinite(lastFullFit) || at - lastFullFit >= FULL_FIT_REFRESH_MS);
    if (!refreshDue) return recordSameFrameObservation(this, detection, frameWidth, frameHeight);

    this.__airgapperFullFitAttemptAt = at;
    const cached = this.__airgapperFrameSnapshot;
    this.__airgapperFrameSnapshot = undefined;
    const result = baseAccept.call(this, detection, frameWidth, frameHeight);
    if (result) {
      notePayloadAlive(this);
      this.__airgapperLastFullFitAt = at;
      return cacheFrameSnapshot(this, at, result);
    }
    this.__airgapperFrameSnapshot = cached;
    return cached ?? result;
  }

  const priorAt = this.__airgapperFrameAt;
  const result = baseAccept.call(this, detection, frameWidth, frameHeight);
  if (result) {
    notePayloadAlive(this);
    if (Number.isFinite(at) && priorAt !== at) {
      this.__airgapperLastFullFitAt = at;
      this.__airgapperFullFitAttemptAt = at;
    }
  }
  return cacheFrameSnapshot(this, at, result);
};

// Slot-repair policy belongs to GridLattice; this layer only invalidates the
// same-frame cache after geometry changes outside normal accept/nudge flow.
const baseDropSlotCorrection = GridLattice.prototype.dropSlotCorrection;
GridLattice.prototype.dropSlotCorrection = function(slot, at) {
  return cacheOutOfBandSnapshot(this, baseDropSlotCorrection.call(this, slot, at));
};

const baseNudgeFromSightings = GridLattice.prototype.nudgeFromSightings;
GridLattice.prototype.nudgeFromSightings = function(sightings, at) {
  return cacheOutOfBandSnapshot(this, baseNudgeFromSightings.call(this, sightings, at));
};

const baseTick = GridLattice.prototype.tick;
GridLattice.prototype.tick = function(now) {
  if (!this.candidate || this.pendingInvalidationReason) {
    return cacheOutOfBandSnapshot(this, baseTick.call(this, now));
  }

  // Geometry and stream liveness are different clocks. Measured corners use
  // source-frame time; any CRC-valid packet proves the known wall is still
  // present at completion time. Stale geometry may request local repair, but
  // only payload silence may make the wall dormant and wake cold acquisition.
  const geometryAge = now - this.lastHitAt;
  const payloadAt = Number(this.__airgapperPayloadAt);
  const payloadAge = Number.isFinite(payloadAt) ? now - payloadAt : Infinity;
  if (payloadAge > DORMANT_MS && geometryAge > DORMANT_MS) {
    this.transition("DORMANT", "payload silent and whole lattice geometry stale", now);
  } else if (geometryAge > SOFT_LOSS_MS) {
    this.transition("PARTIAL_LOSS", "wall alive; geometry awaiting bounded refresh", now);
  }

  const snapshot = this.__airgapperFrameSnapshot ?? this.snapshot();
  if (!snapshot) return null;
  this.__airgapperFrameSnapshot = snapshot;
  snapshot.state = this.state;
  snapshot.provisional = !this.active;
  return snapshot;
};