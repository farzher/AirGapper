import { CAMERA_TUNING, FocusController } from "./focus-controller.js";

const ACQUIRE_BLUR_FOCUS_MAX = 0.34;
const ACQUIRE_BLUR_RECOVER_FOCUS = 0.44;
const ACQUIRE_BLUR_CONFIRM_MS = 420;
const ACQUIRE_BLUR_RETRY_MS = 900;

function resetAcquireBlur(controller) {
  controller.__airgapperAcquireBlurSince = 0;
  controller.__airgapperAcquireBlurRetryAt = -Infinity;
}

const baseAttach = FocusController.prototype.attach;
FocusController.prototype.attach = function(track) {
  resetAcquireBlur(this);
  return baseAttach.call(this, track);
};

const baseSetStrategy = FocusController.prototype.setStrategy;
FocusController.prototype.setStrategy = function(strategy) {
  resetAcquireBlur(this);
  return baseSetStrategy.call(this, strategy);
};

const baseNoteValidDecode = FocusController.prototype.noteValidDecode;
FocusController.prototype.noteValidDecode = function(scanId, now = performance.now()) {
  const result = baseNoteValidDecode.call(this, scanId, now);
  if (scanId !== void 0 && scanId >= this.decodeBoundary) this.__airgapperAcquireBlurSince = 0;
  return result;
};

const baseObserve = FocusController.prototype.observe;
FocusController.prototype.observe = function(id, geometry, metrics, totalTiles = 1, now = performance.now(), captureFps = 0) {
  const result = baseObserve.call(this, id, geometry, metrics, totalTiles, now, captureFps);

  if (this.strategy !== "auto" || !this.isAcquiring() || this.isOptimizing() || this.decodeIsFresh(now)) {
    this.__airgapperAcquireBlurSince = 0;
    return result;
  }

  const confidence = Number(metrics?.confidence) || 0;
  const focusScore = Number(metrics?.focusScore);
  if (!Number.isFinite(focusScore) || confidence < 0.58) return result;

  if (focusScore >= ACQUIRE_BLUR_RECOVER_FOCUS) {
    this.__airgapperAcquireBlurSince = 0;
    return result;
  }
  if (focusScore > ACQUIRE_BLUR_FOCUS_MAX) return result;

  if (!this.__airgapperAcquireBlurSince) this.__airgapperAcquireBlurSince = now;
  if (now - this.__airgapperAcquireBlurSince < ACQUIRE_BLUR_CONFIRM_MS ||
      now - this.__airgapperAcquireBlurRetryAt < ACQUIRE_BLUR_RETRY_MS) return result;

  this.__airgapperAcquireBlurRetryAt = now;
  this.__airgapperAcquireBlurSince = now;

  // Hunting is useful; the failure mode is a lens that remains demonstrably
  // soft. Escalate the existing acquisition controller to its bounded
  // single-shot/continuous recovery immediately instead of waiting through
  // several more blurry QR-evidence windows. If single-shot is unavailable or
  // rejected, maybeRetrySeekingAutofocus() naturally falls back to continuous.
  this.seekingAfRetries = Math.max(this.seekingAfRetries, CAMERA_TUNING.seekingAfFastRetries);
  void this.maybeRetrySeekingAutofocus(now, metrics, true);
  this.lastReason = "sustained acquisition blur; autofocus recovery forced";
  this.changed();
  return result;
};
