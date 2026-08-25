import { GridLattice } from "./grid-lattice.js";

const SOFT_LOSS_MS = 450;
const DORMANT_MS = 900;
const OBSERVATION_HISTORY_MS = 2500;
const CORRECTION_REFRESH_MS = 180;
const FULL_FIT_REFRESH_MS = 160;
const FRESH_PAYLOAD_HOLD_MS = 550;
window.airgapperFreshPayloadUntil = 0;

const activeDescriptor = Object.getOwnPropertyDescriptor(GridLattice.prototype, "active");
if (activeDescriptor?.configurable) {
  Object.defineProperty(GridLattice.prototype, "active", {
    configurable: true,
    get() {
      return this.state !== "SEARCH" && this.state !== "REACQUIRE" && this.state !== "DORMANT";
    }
  });
}

function noteFreshPayload() {
  const now = performance.now();
  window.airgapperFreshPayloadUntil = Math.max(
    Number(window.airgapperFreshPayloadUntil) || 0,
    now + FRESH_PAYLOAD_HOLD_MS
  );
  return now;
}

function clearCache(lattice) {
  lattice.__airgapperFrameAt = undefined;
  lattice.__airgapperFrameSnapshot = undefined;
  lattice.__airgapperCorrectionAt = undefined;
  lattice.__airgapperLastFullFitAt = undefined;
  lattice.__airgapperFullFitAttemptAt = undefined;
  lattice.__airgapperLastPayloadAt = undefined;
}

function remember(lattice, snapshot, at) {
  if (snapshot) {
    lattice.__airgapperFrameSnapshot = snapshot;
    if (Number.isFinite(Number(at))) lattice.__airgapperFrameAt = Number(at);
  }
  return snapshot;
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

const baseNudgeMotion = GridLattice.prototype.nudgeMotion;
GridLattice.prototype.nudgeMotion = function(motion, at = this.lastHitAt) {
  return remember(this, baseNudgeMotion.call(this, motion, at), at);
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

  const snapshot = lattice.__airgapperFrameSnapshot;
  snapshot.state = lattice.state;
  snapshot.provisional = !lattice.active;
  return snapshot;
}

const baseAccept = GridLattice.prototype.accept;
GridLattice.prototype.accept = function(detection, frameWidth, frameHeight) {
  const at = Number(detection?.at);

  if (this.candidate && Number.isFinite(at)) this.noteValidPacket(at);

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
      this.__airgapperLastFullFitAt = at;
      this.noteValidPacket(at);
      return remember(this, result, at);
    }
    this.__airgapperFrameSnapshot = cached;
    return cached ?? result;
  }

  const priorAt = this.__airgapperFrameAt;
  const result = baseAccept.call(this, detection, frameWidth, frameHeight);
  if (result && Number.isFinite(at)) {
    if (priorAt !== at) {
      this.__airgapperLastFullFitAt = at;
      this.__airgapperFullFitAttemptAt = at;
    }
    this.noteValidPacket(at);
  }
  return remember(this, result, at);
};

// Decode misses are not geometry measurements. Rolling shutter, blur, and QR
// payload damage can make correctly aimed slots miss repeatedly. Local geometry
// is replaced only by new CRC-backed measurements or by a genuine whole-wall
// reacquire.
GridLattice.prototype.dropSlotCorrection = function() {
  return null;
};

const baseNudgeFromSightings = GridLattice.prototype.nudgeFromSightings;
GridLattice.prototype.nudgeFromSightings = function(sightings, at) {
  return remember(this, baseNudgeFromSightings.call(this, sightings, at), at);
};

const baseNoteValidPacket = GridLattice.prototype.noteValidPacket;
GridLattice.prototype.noteValidPacket = function(at = this.lastHitAt) {
  const result = baseNoteValidPacket.call(this, at);
  if (!this.candidate) return result;

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
  if (!this.candidate || this.pendingInvalidationReason || !this.__airgapperFrameSnapshot) {
    return remember(this, baseTick.call(this, now), now);
  }

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
