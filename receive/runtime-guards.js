import { GridLattice } from "./grid-lattice.js";

const LATTICE_SOFT_LOSS_MS = 450;
const LATTICE_DORMANT_MS = 900;
const LATTICE_OBSERVATION_HISTORY_MS = 2500;
const LATTICE_CORRECTION_REFRESH_MS = 180;

// Keep stale geometry as a fallback, but do not let it own scheduling forever.
const activeDescriptor = Object.getOwnPropertyDescriptor(GridLattice.prototype, "active");
if (activeDescriptor?.configurable) {
  Object.defineProperty(GridLattice.prototype, "active", {
    configurable: true,
    get() {
      return this.state !== "SEARCH" && this.state !== "REACQUIRE" && this.state !== "DORMANT";
    }
  });
}

function clearLatticeFrameCache(lattice) {
  lattice.__airgapperFrameAt = undefined;
  lattice.__airgapperFrameSnapshot = undefined;
  lattice.__airgapperCorrectionAt = undefined;
}

const baseGridReset = GridLattice.prototype.reset;
GridLattice.prototype.reset = function() {
  clearLatticeFrameCache(this);
  return baseGridReset.call(this);
};

const baseGridReacquire = GridLattice.prototype.reacquire;
GridLattice.prototype.reacquire = function(at, reason) {
  clearLatticeFrameCache(this);
  return baseGridReacquire.call(this, at, reason);
};

function cacheFrameSnapshot(lattice, at, snapshot) {
  const frameAt = Number(at);
  if (snapshot && Number.isFinite(frameAt)) {
    lattice.__airgapperFrameAt = frameAt;
    lattice.__airgapperFrameSnapshot = snapshot;
  }
  return snapshot;
}

const baseGridNudgeMotion = GridLattice.prototype.nudgeMotion;
GridLattice.prototype.nudgeMotion = function(motion, at = this.lastHitAt) {
  return cacheFrameSnapshot(this, at, baseGridNudgeMotion.call(this, motion, at));
};

const baseGridTick = GridLattice.prototype.tick;
GridLattice.prototype.tick = function(now) {
  if (!this.candidate || this.pendingInvalidationReason) return baseGridTick.call(this, now);
  const staleMs = now - this.lastHitAt;
  if (staleMs > LATTICE_DORMANT_MS) {
    this.transition("DORMANT", "whole lattice stale; dormant geometry retained while fresh acquisition owns scanner", now);
    return this.snapshot();
  }
  if (staleMs > LATTICE_SOFT_LOSS_MS) {
    this.transition("PARTIAL_LOSS", "whole lattice stale; bounded recovery with proven geometry retained", now);
  }
  return this.snapshot();
};

function sameFrameCandidateCompatible(lattice, detection) {
  const frameAt = Number(detection?.at);
  const candidate = lattice.candidate;
  if (!candidate || !lattice.locked || lattice.pendingInvalidationReason ||
      !lattice.__airgapperFrameSnapshot || frameAt !== lattice.__airgapperFrameAt ||
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
    if (lattice.lastHitAt - item.at >= LATTICE_OBSERVATION_HISTORY_MS || item.modules !== detection.modules) {
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
    if (!lattice.slotCorrections.has(slot) || at - correctionAt[slot] >= LATTICE_CORRECTION_REFRESH_MS) {
      lattice.learnSlotCorrection(detection);
      correctionAt[slot] = at;
    }
  }

  const snapshot = lattice.__airgapperFrameSnapshot;
  snapshot.state = lattice.state;
  snapshot.provisional = !lattice.active;
  return snapshot;
}

const baseGridAccept = GridLattice.prototype.accept;
GridLattice.prototype.accept = function(detection, frameWidth, frameHeight) {
  if (sameFrameCandidateCompatible(this, detection)) {
    return recordSameFrameObservation(this, detection, frameWidth, frameHeight);
  }
  return cacheFrameSnapshot(this, detection?.at, baseGridAccept.call(this, detection, frameWidth, frameHeight));
};

// Decode misses are not geometry measurements. Rolling shutter, blur, and QR
// payload damage can make a correctly aimed slot fail for many consecutive
// frames. Preserve CRC-learned local calibration until new CRC-backed geometry
// replaces it or the whole wall genuinely reacquires.
GridLattice.prototype.dropSlotCorrection = function() {
  return null;
};
