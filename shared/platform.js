const nav = typeof navigator === "undefined" ? void 0 : navigator;
const isIOS = !!nav && (/iPad|iPhone|iPod/.test(nav.userAgent) || nav.platform === "MacIntel" && nav.maxTouchPoints > 1);
const isAndroid = !!nav && /Android/.test(nav.userAgent);

function probeCameraCapabilities(track) {
  const caps = track?.getCapabilities?.() ?? {};
  const focusDistance = caps.focusDistance &&
    Number.isFinite(caps.focusDistance.min) &&
    Number.isFinite(caps.focusDistance.max) &&
    caps.focusDistance.min >= 0 &&
    caps.focusDistance.max >= caps.focusDistance.min &&
    caps.focusDistance.max <= 1e3
      ? caps.focusDistance
      : void 0;
  return {
    torch: caps.torch === true,
    continuousFocus: Array.isArray(caps.focusMode) && caps.focusMode.includes("continuous"),
    focusModes: Array.isArray(caps.focusMode) ? caps.focusMode : [],
    focusDistance,
    pointsOfInterest: Boolean(caps.pointsOfInterest),
    maxFrameRate: caps.frameRate?.max,
    maxWidth: caps.width?.max,
    exposureTime: caps.exposureMode?.includes("manual") ? caps.exposureTime : void 0,
    iso: caps.iso,
    exposureCompensation: caps.exposureCompensation
  };
}

let cameraConstraintApply;
async function applyAdvancedConstraint(track, set) {
  if (!cameraConstraintApply) {
    cameraConstraintApply = (await import("../receive/camera-constraints.js")).applyAdvancedConstraint;
  }
  return cameraConstraintApply(track, set);
}

export {
  applyAdvancedConstraint,
  isAndroid,
  isIOS,
  probeCameraCapabilities
};
