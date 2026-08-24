import { FocusController } from "./focus-controller.js";

// Native continuous AF is already optimized by the camera HAL for live video.
// Repeated POI writes and forced single-shot escalation can keep some phones
// hunting or make them settle on the wrong plane. When continuous AF exists,
// leave it running untouched; only devices without continuous AF may use the
// controller's single-shot acquisition fallback.
const baseAttach = FocusController.prototype.attach;
FocusController.prototype.attach = function(track) {
  const result = baseAttach.call(this, track);
  if (this.focusModes().includes("continuous")) this.singleShotAfRejected = true;
  return result;
};

const baseSetStrategy = FocusController.prototype.setStrategy;
FocusController.prototype.setStrategy = function(strategy) {
  const result = baseSetStrategy.call(this, strategy);
  if (strategy === "auto" && this.focusModes().includes("continuous")) this.singleShotAfRejected = true;
  return result;
};

// POI writes are not a reliable, passive AF hint across camera HALs. Some
// devices interpret each write as a new metering/focus request and visibly
// restart lens motion. Keep the QR receiver centered by framing, not by
// repeatedly moving the hardware AF metering point.
FocusController.prototype.pointsOfInterestSupported = function() {
  return false;
};
