import { installReceiverRecoveryPolicy } from "./recovery-policy.js";
import {
  consumeExposureRescue,
  noteSuppressedExposureWrite,
  shouldPreserveManualExposure,
  verifiedExposureLatchDecision
} from "./recovery-state.js";

installReceiverRecoveryPolicy();

const nav = typeof navigator === "undefined" ? void 0 : navigator;
const iosSafariCamera = !!nav && (/iPad|iPhone|iPod/.test(nav.userAgent) || nav.platform === "MacIntel" && nav.maxTouchPoints > 1);

// Modern WebKit exposes MediaStreamTrackProcessor in Dedicated Workers rather
// than necessarily on Window. AirGapper's receiver already knows how to consume
// a processor.readable stream of transferable VideoFrames, so provide that same
// interface on iOS using a tiny worker-backed adapter. This avoids the slow
// <video> -> canvas -> RGBA fallback whenever WebKit supports raw camera frames.
function installIOSWorkerTrackProcessor() {
  if (!iosSafariCamera || typeof globalThis.MediaStreamTrackProcessor === "function" ||
      typeof Worker !== "function" || typeof ReadableStream !== "function") return;

  class WorkerTrackProcessor {
    constructor(options = {}) {
      const track = options.track;
      if (!track?.clone) throw new TypeError("MediaStreamTrackProcessor requires a video track");
      const maxBufferSize = Math.max(1, Math.trunc(Number(options.maxBufferSize) || 1));
      const worker = new Worker(new URL("./track-processor-worker.js", import.meta.url), { type: "module" });
      let controller;
      let closed = false;
      this.totalFrames = 0;
      this.discardedFrames = 0;

      const closeWorker = () => {
        if (closed) return;
        closed = true;
        try { worker.postMessage({ type: "stop" }); } catch {}
        worker.terminate();
      };
      const fail = (message) => {
        if (closed) return;
        const error = new Error(message || "Worker camera processor unavailable");
        closeWorker();
        try { controller?.error(error); } catch {}
      };

      worker.onmessage = (event) => {
        const message = event.data ?? {};
        if (message.type === "frame") {
          this.totalFrames = Number(message.totalFrames) || this.totalFrames + 1;
          this.discardedFrames = Number(message.discardedFrames) || 0;
          if (closed) {
            message.frame?.close?.();
            return;
          }
          try { controller.enqueue(message.frame); }
          catch {
            message.frame?.close?.();
            closeWorker();
          }
          return;
        }
        if (message.type === "unsupported") fail("MediaStreamTrackProcessor is unavailable in this WebKit worker");
        else if (message.type === "error") fail(message.message);
      };
      worker.onerror = (event) => {
        event.preventDefault?.();
        fail(event.message || "Camera frame worker failed");
      };

      this.readable = new ReadableStream({
        start(value) { controller = value; },
        pull() {
          if (!closed) worker.postMessage({ type: "pull" });
        },
        cancel() { closeWorker(); }
      }, { highWaterMark: maxBufferSize });

      const workerTrack = track.clone();
      try {
        worker.postMessage({ type: "start", track: workerTrack, maxBufferSize }, [workerTrack]);
      } catch (error) {
        workerTrack.stop?.();
        fail(error instanceof Error ? error.message : String(error));
      }
    }
  }

  try {
    Object.defineProperty(globalThis, "MediaStreamTrackProcessor", {
      configurable: true,
      writable: true,
      value: WorkerTrackProcessor
    });
  } catch {}
}
installIOSWorkerTrackProcessor();

// WebKit can reject otherwise-valid getUserMedia constraint bundles with an
// OverconstrainedError whose message is only "Invalid constraint". Keep the
// preferred AirGapper request untouched, but on iPhone/iPad recover locally
// instead of leaving the receiver unable to start.
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
        return original({ audio: constraints?.audio ?? false, video: { facingMode } });
      }
    }
  };
  Object.defineProperty(wrapped, "__airgapperIOSFallback", { value: true });
  try { media.getUserMedia = wrapped; } catch {}
}
installIOSCameraConstraintFallback();

const EXPOSURE_KEYS = ["exposureMode", "exposureTime", "iso", "exposureCompensation"];
const CAMERA_CONSTRAINT_TIMEOUT_MS = 900;
const CAMERA_CONSTRAINT_TIMEOUT_BACKOFF_MS = 3000;
const constraintBlockedUntil = new WeakMap();

function supportedExposureSet(track, set) {
  const out = { ...set };
  const caps = track?.getCapabilities?.() ?? {};
  if (out.exposureMode !== void 0) {
    const modes = Array.isArray(caps.exposureMode) ? caps.exposureMode : [];
    if (!modes.includes(out.exposureMode)) delete out.exposureMode;
  }
  if (out.exposureTime !== void 0 && !caps.exposureTime) delete out.exposureTime;
  if (out.iso !== void 0 && !caps.iso) delete out.iso;
  if (out.exposureCompensation !== void 0 && !caps.exposureCompensation) delete out.exposureCompensation;
  return out;
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

async function awaitConstraint(promise) {
  let timer;
  let timedOut = false;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error("Camera constraint write timed out"));
      }, CAMERA_CONSTRAINT_TIMEOUT_MS);
    });
    await Promise.race([promise, timeout]);
    return { ok: true, timedOut: false };
  } catch {
    return { ok: false, timedOut };
  } finally { clearTimeout(timer); }
}

function exactExposureConstraints(set) {
  const exact = {};
  for (const key of EXPOSURE_KEYS) if (set[key] !== void 0) exact[key] = { exact: set[key] };
  return exact;
}
function noteConstraintTimeout(track) {
  constraintBlockedUntil.set(track, performance.now() + CAMERA_CONSTRAINT_TIMEOUT_BACKOFF_MS);
}
async function applyConstraint(track, set) {
  if (!Object.keys(set).length) return false;
  if ((constraintBlockedUntil.get(track) ?? 0) > performance.now()) return false;
  const exposureOnly = Object.keys(set).every((key) => EXPOSURE_KEYS.includes(key));
  if (exposureOnly) {
    const strict = await awaitConstraint(track.applyConstraints(exactExposureConstraints(set)));
    if (strict.ok) return true;
    if (strict.timedOut) {
      noteConstraintTimeout(track);
      return false;
    }
  }
  const fallback = await awaitConstraint(track.applyConstraints({ advanced: [set] }));
  if (fallback.timedOut) noteConstraintTimeout(track);
  return fallback.ok;
}

async function applyAdvancedConstraint(track, set) {
  const requestedExposure = Boolean(set) && EXPOSURE_KEYS.some((key) => set[key] !== void 0);
  const supported = supportedExposureSet(track, set ?? {});
  const touchesExposure = EXPOSURE_KEYS.some((key) => supported[key] !== void 0);
  if (requestedExposure && !touchesExposure && Object.keys(withoutExposure(supported)).length === 0) return false;
  if (exposureConstraintAlreadySatisfied(track, supported)) {
    noteSuppressedExposureWrite();
    return true;
  }
  if (touchesExposure) {
    if (supported.exposureMode === "continuous" && shouldPreserveManualExposure(track)) {
      noteSuppressedExposureWrite();
      return applyConstraint(track, withoutExposure(supported));
    }
    const latch = verifiedExposureLatchDecision(track);
    if (latch.hold) {
      noteSuppressedExposureWrite();
      return applyConstraint(track, withoutExposure(supported));
    }
    if (latch.rescue) consumeExposureRescue(track);
  }
  return applyConstraint(track, supported);
}

export { applyAdvancedConstraint };
