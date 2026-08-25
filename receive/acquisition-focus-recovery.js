import { CAMERA_TUNING, FocusController } from "./focus-controller.js";

// Native continuous AF is already optimized by the camera HAL for live video.
// Repeated POI writes, forced single-shot escalation, switching a QR-proven
// continuous lens into manual hold, or simply re-applying the same continuous
// mode can all restart lens work on some phones. Once continuous AF is active,
// AirGapper leaves focus ownership entirely to the camera HAL.
function preserveNativeContinuousAf(controller) {
  if (!controller.focusModes().includes("continuous")) return;
  controller.singleShotAfRejected = true;
  controller.__airgapperFocusHoldRejected = true;
  controller.__airgapperFocusHeld = false;
}

const baseAttach = FocusController.prototype.attach;
FocusController.prototype.attach = function(track) {
  const result = baseAttach.call(this, track);
  preserveNativeContinuousAf(this);
  return result;
};

const baseSetStrategy = FocusController.prototype.setStrategy;
FocusController.prototype.setStrategy = function(strategy) {
  const result = baseSetStrategy.call(this, strategy);
  if (strategy === "auto") preserveNativeContinuousAf(this);
  return result;
};

const baseMaybeRetrySeekingAutofocus = FocusController.prototype.maybeRetrySeekingAutofocus;
FocusController.prototype.maybeRetrySeekingAutofocus = function(...args) {
  if (this.strategy === "auto" && this.focusModes().includes("continuous") &&
      this.settings().focusMode === "continuous") {
    this.singleShotAfRejected = true;
    this.__airgapperFocusHoldRejected = true;
    this.__airgapperFocusHeld = false;
    this.lastReason = "native continuous autofocus owns focus; no camera focus write needed";
    this.changed();
    return Promise.resolve();
  }
  return baseMaybeRetrySeekingAutofocus.apply(this, args);
};

// A static optical analyzer may temporarily lose its target while the real QR
// decoder is still succeeding. Decoder success is authoritative target presence;
// only sustained decoder silence is allowed to re-arm focus acquisition.
FocusController.prototype.noteTargetAbsent = function(now = performance.now()) {
  if (this.strategy !== "auto" || this.state === "UNAVAILABLE" || this.state === "OVERRIDE") return;

  if (this.decodeIsFresh(now)) {
    this.targetMissingSince = 0;
    if (!this.isOptimizing() && this.state !== "LOCKED") {
      this.transition("LOCKED", "verified QR decode overrides static-target miss");
    } else {
      this.lastReason = "verified QR decode overrides static-target miss";
      this.changed();
    }
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
      this.stableGeometry = undefined;
      this.stableSince = 0;
      this.transition("SEEKING", "decoder silence confirmed target loss; autofocus recovery armed");
    }
  }

  if (this.isAcquiring()) void this.maybeRetrySeekingAutofocus(now);
  this.changed();
};

// POI writes are not a reliable, passive AF hint across camera HALs. Some
// devices interpret each write as a new metering/focus request and visibly
// restart lens motion. Keep the QR receiver centered by framing, not by
// repeatedly moving the hardware AF metering point.
FocusController.prototype.pointsOfInterestSupported = function() {
  return false;
};
