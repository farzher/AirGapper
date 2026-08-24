import { FocusController } from "./focus-controller.js";

// Native continuous AF is already optimized by the camera HAL for live video.
// Repeated POI writes, forced single-shot escalation, or switching a QR-proven
// continuous lens into manual hold can all leave some phones hunting or stuck
// on the wrong plane after distance changes. When continuous AF exists, leave
// it running untouched; only devices without continuous AF may use the bounded
// single-shot acquisition fallback.
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

// POI writes are not a reliable, passive AF hint across camera HALs. Some
// devices interpret each write as a new metering/focus request and visibly
// restart lens motion. Keep the QR receiver centered by framing, not by
// repeatedly moving the hardware AF metering point.
FocusController.prototype.pointsOfInterestSupported = function() {
  return false;
};
