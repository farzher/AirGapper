import { GridLattice as GeometryGridLattice } from "./grid-lattice-geometry.js";
import {
  decodeWallBroadlyHealthy,
  noteDecodeGeometry,
  noteDecodeLatticeState,
  noteDecodeSuccess,
  resetDecodeHealth
} from "./decode-health.js";

const SOFT_LOSS_MS = 450;
const DORMANT_MS = 900;
const OBSERVATION_HISTORY_MS = 2500;
const CORRECTION_REFRESH_MS = 180;
const FULL_FIT_REFRESH_MS = 160;

function monotonicNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

class GridLattice extends GeometryGridLattice {
  constructor(onTransition) {
    super((from, to, reason, at) => {
      noteDecodeLatticeState(to);
      onTransition?.(from, to, reason, at);
    });
    noteDecodeLatticeState(this.state);
    this.frameAt = undefined;
    this.frameSnapshot = undefined;
    this.correctionAt = undefined;
    this.lastFullFitAt = undefined;
    this.fullFitAttemptAt = undefined;
    this.lastPayloadAt = undefined;
  }

  get active() {
    return this.state !== "SEARCH" && this.state !== "REACQUIRE" && this.state !== "DORMANT";
  }

  clearRuntimeCache() {
    this.frameAt = undefined;
    this.frameSnapshot = undefined;
    this.correctionAt = undefined;
    this.lastFullFitAt = undefined;
    this.fullFitAttemptAt = undefined;
    this.lastPayloadAt = undefined;
  }

  observeSnapshot(snapshot) {
    if (snapshot) noteDecodeGeometry(snapshot, this.frameWidth, this.frameHeight);
    return snapshot;
  }

  cacheFrameSnapshot(at, snapshot) {
    const frameAt = Number(at);
    if (snapshot && Number.isFinite(frameAt)) {
      this.frameAt = frameAt;
      this.frameSnapshot = snapshot;
    }
    return this.observeSnapshot(snapshot);
  }

  cacheOutOfBandSnapshot(snapshot) {
    if (snapshot) {
      this.frameSnapshot = snapshot;
      this.frameAt = undefined;
    }
    return this.observeSnapshot(snapshot);
  }

  notePayloadAlive() {
    if (!this.candidate || this.pendingInvalidationReason) return false;
    const now = monotonicNow();
    this.lastPayloadAt = now;
    const geometryAge = now - this.lastHitAt;
    this.transition(
      geometryAge > SOFT_LOSS_MS ? "PARTIAL_LOSS" : "TRACK",
      geometryAge > SOFT_LOSS_MS
        ? "valid payload kept wall alive; geometry awaiting refresh"
        : "valid payload kept lattice alive",
      now
    );
    return true;
  }

  noteAcceptedDecode(detection) {
    const at = Number(detection?.at);
    const slot = Number(detection?.slotIndex);
    if (!Number.isInteger(slot) || slot < 0 || slot >= 128) return false;
    const observedAt = monotonicNow();
    return noteDecodeSuccess(slot, Number.isFinite(at) ? at : observedAt, observedAt);
  }

  reset() {
    resetDecodeHealth();
    this.clearRuntimeCache();
    return super.reset();
  }

  reacquire(at, reason) {
    resetDecodeHealth();
    this.clearRuntimeCache();
    return super.reacquire(at, reason);
  }

  noteValidPacket() {
    if (!this.candidate) return super.noteValidPacket();
    return this.notePayloadAlive();
  }

  nudgeMotion(motion, at = this.lastHitAt) {
    return this.cacheFrameSnapshot(at, super.nudgeMotion(motion, at));
  }

  sameFrameCompatible(detection) {
    const at = Number(detection?.at);
    const candidate = this.candidate;
    if (!candidate || !this.locked || this.pendingInvalidationReason ||
        !this.frameSnapshot || at !== this.frameAt ||
        detection?.identity !== this.identity || !Number.isInteger(detection?.slotIndex) ||
        detection.slotIndex < 0 || detection.slotIndex >= candidate.layout.cols * candidate.layout.rows ||
        !Number.isFinite(Number(detection?.modules)) ||
        Number(detection.modules) !== Number(candidate.observations?.[0]?.modules)) return false;
    if (detection.extendedGrid) {
      return Boolean(candidate.layout.extendedGrid) && Number(detection.gridCols) === candidate.layout.cols &&
        Number(detection.gridRows) === candidate.layout.rows;
    }
    return !candidate.layout.extendedGrid && Number(detection.layoutId) === Number(candidate.layout.id);
  }

  recordSameFrameObservation(detection, frameWidth, frameHeight) {
    const at = Number(detection.at);
    this.lastHitAt = Math.max(this.lastHitAt, at);
    this.frameWidth = Math.max(1, frameWidth);
    this.frameHeight = Math.max(1, frameHeight);

    let existing = -1;
    for (let index = this.observations.length - 1; index >= 0; index--) {
      const item = this.observations[index];
      if (this.lastHitAt - item.at >= OBSERVATION_HISTORY_MS || item.modules !== detection.modules) {
        this.observations.splice(index, 1);
        continue;
      }
      if (item.slotIndex === detection.slotIndex) existing = index;
    }

    let geometryFresh = true;
    if (existing >= 0) {
      const prior = this.observations[existing];
      geometryFresh = at > prior.at || at === prior.at && Number(detection.scanId) >= Number(prior.scanId);
      if (geometryFresh) this.observations[existing] = detection;
    } else {
      this.observations.push(detection);
    }

    if (geometryFresh) {
      if (!this.correctionAt) this.correctionAt = new Float64Array(128);
      const slot = detection.slotIndex;
      if (!this.slotCorrections.has(slot) || at - this.correctionAt[slot] >= CORRECTION_REFRESH_MS) {
        this.learnSlotCorrection(detection);
        this.correctionAt[slot] = at;
      }
    }

    this.notePayloadAlive();
    const snapshot = this.frameSnapshot;
    snapshot.state = this.state;
    snapshot.provisional = !this.active;
    return this.observeSnapshot(snapshot);
  }

  accept(detection, frameWidth, frameHeight) {
    const at = Number(detection?.at);

    if (this.sameFrameCompatible(detection)) {
      // Same-frame cache reuse is already fenced by current identity, declared
      // layout, slot range and module count. Attribute this CRC-valid packet to
      // decode health before the cheap observation update; no full fit is needed.
      this.noteAcceptedDecode(detection);
      const lastFullFit = Number(this.lastFullFitAt);
      const refreshDue = this.fullFitAttemptAt !== at &&
        (!Number.isFinite(lastFullFit) || at - lastFullFit >= FULL_FIT_REFRESH_MS);
      if (!refreshDue) return this.recordSameFrameObservation(detection, frameWidth, frameHeight);

      this.fullFitAttemptAt = at;
      const cached = this.frameSnapshot;
      this.frameSnapshot = undefined;
      const result = super.accept(detection, frameWidth, frameHeight);
      if (result) {
        this.notePayloadAlive();
        this.lastFullFitAt = at;
        return this.cacheFrameSnapshot(at, result);
      }
      this.frameSnapshot = cached;
      return this.observeSnapshot(cached ?? result);
    }

    const priorAt = this.frameAt;
    const result = super.accept(detection, frameWidth, frameHeight);
    if (result) {
      // Full-path packets become exposure/decoder-health evidence only after the
      // geometry owner has accepted their identity/layout/slot/quad. Previously
      // this happened before validation, so a valid packet from a layout change
      // could briefly protect the stale wall/optics state.
      this.noteAcceptedDecode(detection);
      this.notePayloadAlive();
      if (Number.isFinite(at) && priorAt !== at) {
        this.lastFullFitAt = at;
        this.fullFitAttemptAt = at;
      }
    }
    return this.cacheFrameSnapshot(at, result);
  }

  dropSlotCorrection(slot, at) {
    // Five misses on one QR are not enough reason to perturb a wall that is
    // broadly producing CRC-valid packets. Rolling-shutter stripes and display
    // transitions can create short local miss streaks even at >90% wall yield.
    // Preserve the learned residual while the majority of visible slots remain
    // healthy; local self-heal automatically becomes available again once broad
    // coverage genuinely degrades.
    if (decodeWallBroadlyHealthy()) return null;
    return this.cacheOutOfBandSnapshot(super.dropSlotCorrection(slot, at));
  }

  nudgeFromSightings(sightings, at) {
    return this.cacheOutOfBandSnapshot(super.nudgeFromSightings(sightings, at));
  }

  tick(now) {
    if (!this.candidate || this.pendingInvalidationReason) {
      return this.cacheOutOfBandSnapshot(super.tick(now));
    }

    const geometryAge = now - this.lastHitAt;
    const payloadAt = Number(this.lastPayloadAt);
    const payloadAge = Number.isFinite(payloadAt) ? now - payloadAt : Infinity;
    if (payloadAge > DORMANT_MS && geometryAge > DORMANT_MS) {
      this.transition("DORMANT", "payload silent and whole lattice geometry stale", now);
    } else if (geometryAge > SOFT_LOSS_MS) {
      this.transition("PARTIAL_LOSS", "wall alive; geometry awaiting bounded refresh", now);
    }

    const snapshot = this.frameSnapshot ?? this.snapshot();
    if (!snapshot) return null;
    this.frameSnapshot = snapshot;
    snapshot.state = this.state;
    snapshot.provisional = !this.active;
    return this.observeSnapshot(snapshot);
  }
}

export { GridLattice };
