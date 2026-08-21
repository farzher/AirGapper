import { installReceiverRecoveryPolicy } from "./receiver-recovery-policy.js";
import {
  noteSuppressedExposureWrite,
  shouldPreserveManualExposure
} from "./receiver-recovery-state.js";

installReceiverRecoveryPolicy();

const nav = typeof navigator === "undefined" ? void 0 : navigator;
const isIOS = !!nav && (/iPad|iPhone|iPod/.test(nav.userAgent) || nav.platform === "MacIntel" && nav.maxTouchPoints > 1);
const isAndroid = !!nav && /Android/.test(nav.userAgent);
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
  const touchesExposure = set.exposureMode !== void 0 || set.exposureTime !== void 0 || set.iso !== void 0 || set.exposureCompensation !== void 0;
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
async function applyAdvancedConstraint(track, set) {
  // Camera movement invalidates coordinates, not a QR-proven sensor setting.
  // During a lattice pose recovery, ignore attempts to surrender a verified
  // manual exposure back to photographic AE. Autofocus remains untouched.
  if (set?.exposureMode === "continuous" && shouldPreserveManualExposure(track)) {
    noteSuppressedExposureWrite();
    return true;
  }
  // Reapplying an identical sensor state can wake/reconfigure Android 3A even
  // though no value changed. Treat exposure-only repeats as successful no-ops.
  if (exposureConstraintAlreadySatisfied(track, set)) {
    noteSuppressedExposureWrite();
    return true;
  }
  try {
    await track.applyConstraints({ advanced: [set] });
    return true;
  } catch {
    return false;
  }
}
export {
  applyAdvancedConstraint,
  isAndroid,
  isIOS,
  probeCameraCapabilities
};
