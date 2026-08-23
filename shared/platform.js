import { installReceiverRecoveryPolicy } from "./receiver-recovery-policy.js";
import { installTemporalBackpressure } from "./temporal-backpressure.js";
import { DecodeWorkerPool } from "./worker-pool.js";
import {
  consumeExposureRescue,
  noteSuppressedExposureWrite,
  shouldPreserveManualExposure,
  verifiedExposureLatchDecision
} from "./receiver-recovery-state.js";

installReceiverRecoveryPolicy();
installTemporalBackpressure();

const nav = typeof navigator === "undefined" ? void 0 : navigator;
const isIOS = !!nav && (/iPad|iPhone|iPod/.test(nav.userAgent) || nav.platform === "MacIntel" && nav.maxTouchPoints > 1);
const isAndroid = !!nav && /Android/.test(nav.userAgent);

// v0.5.373 proved cross-frame reconstruction, but its out-of-pool sampler
// reaches full camera rate and copies a second large Y/I420 frame on Android.
// At 1440x2560 this creates enough memory-bandwidth/allocation pressure to stall
// the receive UI while the compositor-owned video preview keeps moving. Keep the
// proven temporal code available off Android, but make Android scheduling exactly
// the bounded production worker-pool path until temporal module snapshots are
// emitted by the already-running decode worker with no second camera-frame copy.
if (isAndroid) {
  DecodeWorkerPool.prototype.submit = function(message, transfer) {
    const slot = this.busy.indexOf(false);
    return slot !== -1 && this.submitAtSlot(slot, message, transfer);
  };
  DecodeWorkerPool.prototype.submitTo = function(slot, message, transfer) {
    return Number.isInteger(slot) && this.submitAtSlot(slot, message, transfer);
  };
}

const EXPOSURE_KEYS = ["exposureMode", "exposureTime", "iso", "exposureCompensation"];
function probeCameraCapabilities(track) {
  var _a, _b, _c, _d, _e;
  const caps = (_b = (_a = track.getCapabilities) == null ? void 0 : _a.call(track)) != null ? _b : {};
  const focusDistance = caps.focusDistance && Number.isFinite(caps.focusDistance.min) && Number.isFinite(caps.focusDistance.max) && caps.focusDistance.min >= 0 && caps.focusDistance.max >= caps.focusDistance.min && caps.focusDistance.max <= 1e3 ? caps.focusDistance : void 0;
  return {
    torch: caps.torch === true,
    continuousFocus: Array.isArray(caps.focusMode) && caps.focusMode.includes("continuous"),
    focusModes: Array.isArray(caps.focusMode) ? caps.focusMode : [],
    focusDistance,
    pointsOfInterest: Boolean(caps.pointsOfInterest),
    maxFrameRate: (_c = caps.frameRate) == null ? void 0 : _c.max,
    maxWidth: (_d = caps.width) == null ? void 0 : _d.max,
    exposureTime: ((_e = caps.exposureMode) == null ? void 0 : _e.includes("manual")) ? caps.exposureTime : void 0,
    iso: caps.iso,
    exposureCompensation: caps.exposureCompensation
  };
}
function exposureConstraintAlreadySatisfied(track, set) {
  if (!track || !set) return false;
  const touchesFocus = set.focusMode !== void 0 || set.focusDistance !== void 0 || set.pointsOfInterest !== void 0;
  const touchesExposure = EXPOSURE_KEYS.some((key) => set[key] !== void 0);
  if (touchesFocus || !touchesExposure) return false;
  const actual = track.getSettings?.() ?? {};
  const caps = track.getCapabilities?.() ?? {};
  const close = (value, requested, range) => {
    if (requested === void 0) return true;
    if (!Number.isFinite(Number(value)) || !Number.isFinite(Number(requested))) return value === requested;
    const tolerance = Math.max(Number(range?.step) * 0.75 || 0, Math.abs(Number(requested)) * 0.02, 1e-6);
    return Math.abs(Number(value) - Number(requested)) <= tolerance;
  };
  return (set.exposureMode === void 0 || actual.exposureMode === set.exposureMode) &&
    close(actual.exposureTime, set.exposureTime, caps.exposureTime) &&
    close(actual.iso, set.iso, caps.iso) &&
    close(actual.exposureCompensation, set.exposureCompensation, caps.exposureCompensation);
}
function withoutExposure(set) {
  const remainder = { ...set };
  for (const key of EXPOSURE_KEYS) delete remainder[key];
  return remainder;
}
async function applyConstraint(track, set) {
  if (!Object.keys(set).length) return true;
  try {
    await track.applyConstraints({ advanced: [set] });
    return true;
  } catch {
    return false;
  }
}
async function applyAdvancedConstraint(track, set) {
  const touchesExposure = Boolean(set) && EXPOSURE_KEYS.some((key) => set[key] !== void 0);

  // Reapplying an identical sensor state can wake/reconfigure Android 3A even
  // though no value changed. Treat exposure-only repeats as successful no-ops.
  if (exposureConstraintAlreadySatisfied(track, set)) {
    noteSuppressedExposureWrite();
    return true;
  }

  if (touchesExposure) {
    // Camera movement invalidates coordinates, not a QR-proven sensor setting.
    // During a lattice pose recovery, never surrender a verified manual exposure
    // back to photographic AE. If a mixed AF+AE request arrives, strip only the
    // exposure fields so autofocus remains independent and automatic.
    if (set?.exposureMode === "continuous" && shouldPreserveManualExposure(track)) {
      noteSuppressedExposureWrite();
      return applyConstraint(track, withoutExposure(set));
    }

    // A CRC-valid QR proves the current short exposure works. Temporary decoder
    // failures are weak evidence about brightness, so suppress exposure/ISO/EV
    // mutations while QR evidence is fresh or geometry is still moving. After a
    // stable decode outage, permit exactly one rescue mutation per bounded window.
    const latch = verifiedExposureLatchDecision(track);
    if (latch.hold) {
      noteSuppressedExposureWrite();
      return applyConstraint(track, withoutExposure(set));
    }
    if (latch.rescue) consumeExposureRescue(track);
  }

  return applyConstraint(track, set);
}
export {
  applyAdvancedConstraint,
  isAndroid,
  isIOS,
  probeCameraCapabilities
};
