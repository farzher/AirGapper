import { CAMERA_TUNING, FocusController } from "./focus-controller.js";
import { GridLattice } from "./grid-lattice.js";

const LATTICE_SOFT_LOSS_MS = 450;
const LATTICE_DORMANT_MS = 900;
const TRACK_PROCESSOR_STALL_MS = 900;
const AUTO_FOCUS_HOLD_DECODE_COUNT = 3;

// Keep stale geometry as a fallback, but do not let it own scheduling forever.
// After a short miss window, recovery probes run beside the hot path. After a
// true ~1 s decode drought, the old lattice becomes DORMANT: its transform is
// retained for cheap fallback/re-anchoring, while fresh acquisition becomes the
// primary scheduler again. Explicit pose invalidations still use the original
// destructive reacquire path.
const activeDescriptor = Object.getOwnPropertyDescriptor(GridLattice.prototype, "active");
if (activeDescriptor?.configurable) {
  Object.defineProperty(GridLattice.prototype, "active", {
    configurable: true,
    get() {
      return this.state !== "SEARCH" && this.state !== "REACQUIRE" && this.state !== "DORMANT";
    }
  });
}

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

const baseGridAccept = GridLattice.prototype.accept;
GridLattice.prototype.accept = function(detection, frameWidth, frameHeight) {
  const wasDormant = this.state === "DORMANT";
  const result = baseGridAccept.call(this, detection, frameWidth, frameHeight);
  // A measured Guided result can finish out of order. The base lattice rejects
  // stale geometry for fitting (correctly), but that CRC-valid packet is still
  // direct liveness evidence. Do not leave fresh decoder progress in DORMANT,
  // where expensive full acquisition would run beside a working tracked path.
  if (result && wasDormant && this.state === "DORMANT" && packetIsStillLive(detection?.at)) {
    this.transition("GRID_LOCK", "fresh measured packet reactivated dormant lattice", detection.at);
    return this.snapshot();
  }
  return result;
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
  // A CRC-valid packet is direct proof that the target is present. Do not leave
  // a stale static-analyzer miss armed after real decoder evidence arrives.
  this.targetMissingSince = 0;
  if (this.strategy === "auto" && this.state === "LOCKED" && !this.isOptimizing()) {
    void holdQrProvenFocus(this);
  }
  return result;
};

FocusController.prototype.noteTargetAbsent = function(now = performance.now()) {
  if (this.strategy !== "auto" || this.state === "UNAVAILABLE" || this.state === "OVERRIDE") return;

  // Animated QR content can defeat the static analyzer while cached geometry is
  // decoding perfectly. Decoder evidence always wins that disagreement.
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

// Chromium can keep <video> advancing while MediaStreamTrackProcessor.read()
// hangs after an optics constraint transition. Runtime already knows how to
// fall back to rVFC when read() rejects; make that same recovery available for
// post-start stalls instead of only the 250 ms startup watchdog.
function installTrackProcessorStallGuard() {
  const NativeTrackProcessor = globalThis.MediaStreamTrackProcessor;
  if (typeof NativeTrackProcessor !== "function" || NativeTrackProcessor.__airgapperStallGuard) return;

  const guardedReader = (nativeReader) => ({
    read() {
      return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          const error = typeof DOMException === "function"
            ? new DOMException("MediaStreamTrackProcessor stalled", "AbortError")
            : new Error("MediaStreamTrackProcessor stalled");
          reject(error);
        }, TRACK_PROCESSOR_STALL_MS);
        nativeReader.read().then((value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }, (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        });
      });
    },
    cancel(reason) {
      return nativeReader.cancel(reason);
    },
    releaseLock() {
      nativeReader.releaseLock();
    }
  });

  class GuardedTrackProcessor {
    constructor(options) {
      const processor = new NativeTrackProcessor(options);
      this.readable = {
        getReader() {
          return guardedReader(processor.readable.getReader());
        }
      };
    }
  }
  Object.defineProperty(GuardedTrackProcessor, "__airgapperStallGuard", { value: true });

  try {
    globalThis.MediaStreamTrackProcessor = GuardedTrackProcessor;
  } catch {
    try {
      Object.defineProperty(globalThis, "MediaStreamTrackProcessor", {
        configurable: true,
        writable: true,
        value: GuardedTrackProcessor
      });
    } catch {
    }
  }
}

installTrackProcessorStallGuard();
