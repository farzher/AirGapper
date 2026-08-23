import { installReceiverRecoveryPolicy } from "../shared/receiver-recovery-policy.js";
import {
  consumeExposureRescue,
  noteSuppressedExposureWrite,
  shouldPreserveManualExposure,
  verifiedExposureLatchDecision
} from "../shared/receiver-recovery-state.js";

installReceiverRecoveryPolicy();

const EXPOSURE_KEYS = ["exposureMode", "exposureTime", "iso", "exposureCompensation"];

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

  if (exposureConstraintAlreadySatisfied(track, set)) {
    noteSuppressedExposureWrite();
    return true;
  }

  if (touchesExposure) {
    if (set?.exposureMode === "continuous" && shouldPreserveManualExposure(track)) {
      noteSuppressedExposureWrite();
      return applyConstraint(track, withoutExposure(set));
    }

    const latch = verifiedExposureLatchDecision(track);
    if (latch.hold) {
      noteSuppressedExposureWrite();
      return applyConstraint(track, withoutExposure(set));
    }
    if (latch.rescue) consumeExposureRescue(track);
  }

  return applyConstraint(track, set);
}

export { applyAdvancedConstraint };
