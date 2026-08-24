import { CAMERA_TUNING, FocusController } from "./focus-controller.js";
import { GridLattice } from "./grid-lattice.js";

const LATTICE_SOFT_LOSS_MS = 450;
const LATTICE_DORMANT_MS = 900;
const LATTICE_OBSERVATION_HISTORY_MS = 2500;
const LATTICE_CORRECTION_REFRESH_MS = 180;
const AUTO_FOCUS_HOLD_DECODE_COUNT = 3;

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

function packetIsStillLive(at) {
  const packetAt = Number(at);
  if (!Number.isFinite(packetAt)) return false;
  return performance.now() - packetAt <= LATTICE_DORMANT_MS;
}

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
  const packetIsCurrent = at >= lattice.lastHitAt;
  lattice.lastHitAt = Math.max(lattice.lastHitAt, at);
  lattice.frameWidth = Math.max(1, frameWidth);
  lattice.frameHeight = Math.max(1, frameHeight);

  // Keep every CRC-backed slot observation, but do not refit the same rigid wall
  // once per QR. One worker completion can contain 20+ symbols from one camera
  // frame; the first fit (or the worker's coherent wall-motion nudge) already
  // published the pose for that frame. These observations feed the next frame's
  // fit without allocating another homography and 28-slot snapshot right now.
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

  // Persistent lens residuals change slowly. Learn a newly seen slot
  // immediately, then cap updates so hundreds of QR results/sec do not allocate
  // four residual point objects for the same slot over and over.
  if (geometryFresh) {
    let correctionAt = lattice.__airgapperCorrectionAt;
    if (!correctionAt) correctionAt = lattice.__airgapperCorrectionAt = new Float64Array(128);
    const slot = detection.slotIndex;
    if (!lattice.slotCorrections.has(slot) || at - correctionAt[slot] >= LATTICE_CORRECTION_REFRESH_MS) {
      lattice.learnSlotCorrection(detection);
      correctionAt[slot] = at;
    }
  }

  if (packetIsCurrent && lattice.locked)
    lattice.transition("TRACK", "valid packet refreshed locked lattice", at);

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

  const wasDormant = this.state === "DORMANT";
  let result = baseGridAccept.call(this, detection, frameWidth, frameHeight);
  // A measured Guided result can finish out of order. The base lattice rejects
  // stale geometry for fitting (correctly), but a fresh CRC-valid packet is still
  // direct liveness evidence.
  if (result && wasDormant && this.state === "DORMANT" && packetIsStillLive(detection?.at)) {
    this.transition("GRID_LOCK", "fresh measured packet reactivated dormant lattice", detection.at);
    result = this.snapshot();
  }
  return cacheFrameSnapshot(this, detection?.at, result);
};

const baseNoteValidPacket = GridLattice.prototype.noteValidPacket;
GridLattice.prototype.noteValidPacket = function(at = this.lastHitAt) {
  const accepted = baseNoteValidPacket.call(this, at);
  if (accepted && this.state === "DORMANT" && packetIsStillLive(at)) {
    this.transition("GRID_LOCK", "valid packet reactivated dormant lattice", at);
  }
  return accepted;
};

function resetAutomaticFocusHold(controller) {
  controller.__airgapperFocusHoldPending = false;
  controller.__airgapperFocusHeld = false;
  controller.__airgapperFocusHoldRejected = false;
}

const baseAttach = FocusController.prototype.attach;
FocusController.prototype.attach = function(track) {
  resetAutomaticFocusHold(this);
  return baseAttach.call(this, track);
};

const baseDetach = FocusController.prototype.detach;
FocusController.prototype.detach = function() {
  resetAutomaticFocusHold(this);
  return baseDetach.call(this);
};

const baseSetStrategy = FocusController.prototype.setStrategy;
FocusController.prototype.setStrategy = function(strategy) {
  resetAutomaticFocusHold(this);
  return baseSetStrategy.call(this, strategy);
};

async function holdQrProvenFocus(controller) {
  if (controller.__airgapperFocusHoldPending || controller.__airgapperFocusHoldRejected ||
      controller.strategy !== "auto" || controller.state !== "LOCKED" || controller.isOptimizing() ||
      controller.validDecodesInGeneration < AUTO_FOCUS_HOLD_DECODE_COUNT || !controller.manualFocus()) return;
  const track = controller.track;
  if (!track || track.readyState !== "live") return;
  const settings = controller.settings();
  if (controller.__airgapperFocusHeld && settings.focusMode === "manual") return;
  if (settings.focusMode === "manual" || !Number.isFinite(settings.focusDistance)) return;
  const range = controller.caps.focusDistance;
  if (!range) return;
  const distance = controller.quantize(settings.focusDistance, range);
  controller.__airgapperFocusHoldPending = true;
  try {
    const accepted = await controller.apply(track, { focusMode: "manual", focusDistance: distance });
    if (!accepted || controller.track !== track || controller.strategy !== "auto" || track.readyState !== "live") return;
    const actual = controller.settings();
    if (actual.focusMode === "manual") {
      controller.__airgapperFocusHeld = true;
      controller.commitSettings(actual);
      controller.lastReason = "QR-proven focus held; autofocus breathing disabled";
      controller.changed();
    } else {
      controller.__airgapperFocusHoldRejected = true;
    }
  } catch {
    controller.__airgapperFocusHoldRejected = true;
  } finally {
    controller.__airgapperFocusHoldPending = false;
  }
}

function releaseQrProvenFocus(controller) {
  if (!controller.__airgapperFocusHeld) return;
  controller.__airgapperFocusHeld = false;
  controller.__airgapperFocusHoldRejected = false;
  const track = controller.track;
  if (!track || track.readyState !== "live") return;
  const modes = controller.focusModes();
  const mode = modes.includes("continuous") ? "continuous" : modes.includes("single-shot") ? "single-shot" : undefined;
  if (!mode) return;
  void controller.apply(track, { focusMode: mode }).catch(() => void 0);
}

const baseNoteValidDecode = FocusController.prototype.noteValidDecode;
FocusController.prototype.noteValidDecode = function(scanId, now = performance.now()) {
  const result = baseNoteValidDecode.call(this, scanId, now);
  if (scanId === void 0 || scanId < this.decodeBoundary) return result;
  this.targetMissingSince = 0;
  if (this.strategy === "auto" && this.state === "LOCKED" && !this.isOptimizing()) {
    void holdQrProvenFocus(this);
  }
  return result;
};

FocusController.prototype.noteTargetAbsent = function(now = performance.now()) {
  if (this.strategy !== "auto" || this.state === "UNAVAILABLE" || this.state === "OVERRIDE") return;

  if (this.decodeIsFresh(now)) {
    this.targetMissingSince = 0;
    if (!this.isOptimizing() && this.state !== "LOCKED") {
      this.transition("LOCKED", "verified QR decode overrides static-target miss");
    } else {
      this.lastReason = "verified QR decode overrides static-target miss";
    }
    this.changed();
    return;
  }

  if (!this.targetMissingSince) this.targetMissingSince = now;
  if (this.isOptimizing()) {
    this.lastReason = "QR absent; explicit exposure tournament continues";
    this.changed();
    return;
  }

  if (this.state === "LOCKED") {
    this.transition("TARGET_LOST_GRACE", "static target missing; decoder-silence confirmation required");
  } else if (this.state === "STABILIZING" || this.state === "TARGET_LOST_GRACE") {
    const targetMissingMs = now - this.targetMissingSince;
    const requiredSilenceMs = Math.max(CAMERA_TUNING.targetLostGraceMs, this.silenceThreshold());
    if (targetMissingMs >= CAMERA_TUNING.targetLostGraceMs && this.decodeSilence(now) >= requiredSilenceMs) {
      this.stableGeometry = void 0;
      this.stableSince = 0;
      releaseQrProvenFocus(this);
      this.transition("SEEKING", "decoder silence confirmed target loss; autofocus recovery armed");
    }
  }

  if (this.isAcquiring()) void this.maybeRetrySeekingAutofocus(now);
  this.changed();
};
