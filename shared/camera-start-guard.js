import { isIOS } from "./platform.js";

let installed = false;
let pendingRequests = 0;
let recentStartError;
let recentStartErrorUntil = 0;

export function cameraRequestPending() {
  return pendingRequests > 0;
}

function softenNumericExact(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const exact = Number(value.exact);
  if (!Number.isFinite(exact)) return value;
  const next = { ...value };
  delete next.exact;
  if (!Number.isFinite(Number(next.ideal))) next.ideal = exact;
  return next;
}

export function softenIOSCameraConstraints(constraints) {
  if (!isIOS || !constraints || typeof constraints !== "object") return constraints;
  const video = constraints.video;
  if (!video || typeof video !== "object" || Array.isArray(video)) return constraints;
  return {
    ...constraints,
    video: {
      ...video,
      width: softenNumericExact(video.width),
      height: softenNumericExact(video.height),
      frameRate: softenNumericExact(video.frameRate)
    }
  };
}

function isConstraintFailure(error) {
  return error?.name === "OverconstrainedError" || error?.name === "ConstraintNotSatisfiedError";
}

export function installCameraStartGuard() {
  if (installed) return;
  installed = true;
  const mediaDevices = navigator.mediaDevices;
  const getUserMedia = mediaDevices?.getUserMedia;
  if (typeof getUserMedia !== "function") return;

  const nativeGetUserMedia = getUserMedia.bind(mediaDevices);
  const guardedGetUserMedia = async (constraints) => {
    const now = performance.now();
    // receive/main.js intentionally retries exact camera constraints with ideal
    // constraints. On iOS, only a genuine constraint failure should be allowed
    // to open that fallback request. Permission/lifecycle/device errors must
    // surface once instead of immediately producing another system sheet.
    if (isIOS && recentStartError && now < recentStartErrorUntil) {
      throw recentStartError;
    }

    pendingRequests++;
    try {
      return await nativeGetUserMedia(softenIOSCameraConstraints(constraints));
    } catch (error) {
      if (isIOS && !isConstraintFailure(error)) {
        recentStartError = error;
        recentStartErrorUntil = performance.now() + 1200;
      }
      throw error;
    } finally {
      pendingRequests = Math.max(0, pendingRequests - 1);
    }
  };

  try {
    Object.defineProperty(mediaDevices, "getUserMedia", {
      configurable: true,
      writable: true,
      value: guardedGetUserMedia
    });
  } catch {
    try { mediaDevices.getUserMedia = guardedGetUserMedia; } catch {}
  }
}
