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
  return error?.name === "OverconstrainedError" ||
    error?.name === "ConstraintNotSatisfiedError" ||
    /invalid constraint/i.test(String(error?.message || ""));
}

function relaxedFacingMode(video) {
  return video?.facingMode ?? { ideal: "environment" };
}

function rememberStartError(error) {
  if (!isIOS || isConstraintFailure(error)) return;
  recentStartError = error;
  recentStartErrorUntil = performance.now() + 1200;
}

async function requestIOSCamera(nativeGetUserMedia, constraints) {
  const softened = softenIOSCameraConstraints(constraints);
  try {
    return await nativeGetUserMedia(softened);
  } catch (error) {
    const video = softened?.video;
    if (!isConstraintFailure(error) || !video || typeof video !== "object" || Array.isArray(video)) throw error;
    const facingMode = relaxedFacingMode(video);
    try {
      return await nativeGetUserMedia({
        audio: softened?.audio ?? false,
        video: {
          facingMode,
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 }
        }
      });
    } catch (relaxedError) {
      if (!isConstraintFailure(relaxedError)) throw relaxedError;
      return nativeGetUserMedia({ audio: softened?.audio ?? false, video: { facingMode } });
    }
  }
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
    // One logical camera request owns the complete iOS fallback ladder. A prior
    // permission/lifecycle/device error must surface once instead of immediately
    // producing another system sheet from the caller's ideal-mode retry.
    if (isIOS && recentStartError && now < recentStartErrorUntil) throw recentStartError;

    pendingRequests++;
    try {
      return isIOS
        ? await requestIOSCamera(nativeGetUserMedia, constraints)
        : await nativeGetUserMedia(constraints);
    } catch (error) {
      rememberStartError(error);
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
