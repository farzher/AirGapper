import { installReceiverRecoveryPolicy } from "./receiver-recovery-policy.js";
import { DecodeWorkerPool } from "./worker-pool.js";
import {
  consumeExposureRescue,
  noteSuppressedExposureWrite,
  shouldPreserveManualExposure,
  verifiedExposureLatchDecision
} from "./receiver-recovery-state.js";

installReceiverRecoveryPolicy();

const nav = typeof navigator === "undefined" ? void 0 : navigator;
const isIOS = !!nav && (/iPad|iPhone|iPod/.test(nav.userAgent) || nav.platform === "MacIntel" && nav.maxTouchPoints > 1);
const isAndroid = !!nav && /Android/.test(nav.userAgent);

// The production receiver still asks for receive/worker.js. Redirect only that
// worker to a thin wrapper which observes the SAME Y plane after the normal
// worker has copied the camera frame into WASM. The wrapper never clones or
// retains a VideoFrame. ?raw=1 is an explicit benchmark escape hatch for tests
// that need the unwrapped baseline worker.
function installDecodeWorkerRedirect() {
  const NativeWorker = globalThis.Worker;
  if (typeof NativeWorker !== "function" || globalThis.__airgapperWorkerRedirectInstalled) return;
  const redirect = (input) => {
    try {
      const base = globalThis.location?.href || import.meta.url;
      const url = input instanceof URL ? new URL(input.href) : new URL(String(input), base);
      if (url.pathname.endsWith("/receive/worker.js") && !url.searchParams.has("raw"))
        url.pathname = url.pathname.slice(0, -"worker.js".length) + "worker-reconstruct.js";
      return url;
    } catch {
      return input;
    }
  };
  function AirGapperWorker(url, options) {
    return new NativeWorker(redirect(url), options);
  }
  try { Object.setPrototypeOf(AirGapperWorker, NativeWorker); } catch {}
  AirGapperWorker.prototype = NativeWorker.prototype;
  globalThis.Worker = AirGapperWorker;
  globalThis.__airgapperWorkerRedirectInstalled = true;
}
installDecodeWorkerRedirect();

// Low-count temporal history is most valuable when adjacent camera frames land
// on the same normal decode worker. At 1-2 QRs the measured robust path is well
// below one frame period, so prefer worker 0 while it is free. Never drop a real
// camera frame merely to preserve affinity: if worker 0 is busy, fall back to
// the pool's normal free-worker scheduler.
const poolSubmit = DecodeWorkerPool.prototype.submit;
const poolSubmitTo = DecodeWorkerPool.prototype.submitTo;
const lowCountTracked = (message) => Boolean(message && !message.full && message.pixelFormat === "y8" &&
  Array.isArray(message.tracks) && message.tracks.length >= 1 && message.tracks.length <= 2);
DecodeWorkerPool.prototype.submit = function(message, transfer) {
  if (lowCountTracked(message) && this.workers.length && !this.busy[0])
    return this.submitAtSlot(0, message, transfer);
  return poolSubmit.call(this, message, transfer);
};
DecodeWorkerPool.prototype.submitTo = function(slot, message, transfer) {
  if (lowCountTracked(message) && this.workers.length && !this.busy[0])
    return this.submitAtSlot(0, message, transfer);
  return poolSubmitTo.call(this, slot, message, transfer);
};

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
export {
  applyAdvancedConstraint,
  isAndroid,
  isIOS,
  probeCameraCapabilities
};
