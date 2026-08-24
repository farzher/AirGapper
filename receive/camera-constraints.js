import { installReceiverRecoveryPolicy } from "./recovery-policy.js";
import {
  consumeExposureRescue,
  noteSuppressedExposureWrite,
  shouldPreserveManualExposure,
  verifiedExposureLatchDecision
} from "./recovery-state.js";

installReceiverRecoveryPolicy();

// WebKit can reject otherwise-valid getUserMedia constraint bundles with an
// OverconstrainedError whose message is only "Invalid constraint". Keep the
// preferred AirGapper request untouched, but on iPhone/iPad recover locally
// instead of leaving the receiver unable to start. The first retry preserves a
// useful 1080p/30 target while dropping deviceId/exact constraints; the final
// retry asks only for the rear camera and lets Safari choose its safest mode.
const nav = typeof navigator === "undefined" ? void 0 : navigator;
const iosSafariCamera = !!nav && (/iPad|iPhone|iPod/.test(nav.userAgent) || nav.platform === "MacIntel" && nav.maxTouchPoints > 1);
function cameraConstraintFailure(error) {
  return error?.name === "OverconstrainedError" || /invalid constraint/i.test(String(error?.message || ""));
}
function relaxedFacingMode(video) {
  return video?.facingMode ?? { ideal: "environment" };
}
function installIOSCameraConstraintFallback() {
  const media = nav?.mediaDevices;
  if (!iosSafariCamera || !media?.getUserMedia || media.getUserMedia.__airgapperIOSFallback) return;
  const original = media.getUserMedia.bind(media);
  const wrapped = async (constraints) => {
    try {
      return await original(constraints);
    } catch (error) {
      const video = constraints?.video;
      if (!cameraConstraintFailure(error) || !video || typeof video !== "object") throw error;
      const facingMode = relaxedFacingMode(video);
      try {
        return await original({
          audio: constraints?.audio ?? false,
          video: {
            facingMode,
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            frameRate: { ideal: 30 }
          }
        });
      } catch (relaxedError) {
        if (!cameraConstraintFailure(relaxedError)) throw relaxedError;
        return original({
          audio: constraints?.audio ?? false,
          video: { facingMode }
        });
      }
    }
  };
  Object.defineProperty(wrapped, "__airgapperIOSFallback", { value: true });
  try {
    media.getUserMedia = wrapped;
  } catch {
    // Some WebKit host objects may reject method replacement. In that rare
    // case startup retains the native behavior rather than risking camera API
    // corruption.
  }
}
installIOSCameraConstraintFallback();

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
