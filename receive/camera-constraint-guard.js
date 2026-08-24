const MODE_KEYS = ["width", "height", "frameRate", "aspectRatio", "resizeMode", "deviceId", "groupId", "facingMode"];
const FOCUS_KEYS = ["focusMode", "focusDistance", "pointsOfInterest"];
const EXPOSURE_KEYS = ["exposureMode", "exposureTime", "iso", "exposureCompensation"];

function keysInConstraints(constraints) {
  const keys = new Set();
  if (!constraints || typeof constraints !== "object") return keys;
  for (const key of Object.keys(constraints)) if (key !== "advanced") keys.add(key);
  if (Array.isArray(constraints.advanced)) {
    for (const advanced of constraints.advanced) {
      if (!advanced || typeof advanced !== "object") continue;
      for (const key of Object.keys(advanced)) keys.add(key);
    }
  }
  return keys;
}

function stripDomains(set, touchesFocus, touchesExposure) {
  if (!set || typeof set !== "object") return null;
  const next = { ...set };
  if (touchesFocus) for (const key of FOCUS_KEYS) delete next[key];
  if (touchesExposure) for (const key of EXPOSURE_KEYS) delete next[key];
  return Object.keys(next).length ? next : null;
}

function preserveCurrentMode(track, constraints) {
  const settings = track.getSettings?.() ?? {};
  // getConstraints() normally retains the original exact/ideal camera mode.
  // Some implementations return only a partial set, so use the already-active
  // settings as non-destructive ideals rather than allowing an optics write to
  // fall all the way back to the camera's default mode.
  if (constraints.width === void 0 && Number.isFinite(settings.width))
    constraints.width = { ideal: settings.width };
  if (constraints.height === void 0 && Number.isFinite(settings.height))
    constraints.height = { ideal: settings.height };
  if (constraints.frameRate === void 0 && Number.isFinite(settings.frameRate))
    constraints.frameRate = { ideal: settings.frameRate };
  return constraints;
}

function mergeOpticsConstraints(track, incoming) {
  if (!incoming || typeof incoming !== "object") return incoming;
  const keys = keysInConstraints(incoming);
  const touchesMode = MODE_KEYS.some((key) => keys.has(key));
  const touchesFocus = FOCUS_KEYS.some((key) => keys.has(key));
  const touchesExposure = EXPOSURE_KEYS.some((key) => keys.has(key));
  if (touchesMode || !touchesFocus && !touchesExposure) return incoming;

  const current = track.getConstraints?.() ?? {};
  const merged = { ...current };
  const currentAdvanced = Array.isArray(current.advanced) ? current.advanced : [];
  delete merged.advanced;

  // Replacing one optics domain must also remove that domain's previous basic
  // constraints. Otherwise e.g. old basic exposureMode=manual conflicts with a
  // new advanced exposureMode=continuous request.
  if (touchesFocus) for (const key of FOCUS_KEYS) delete merged[key];
  if (touchesExposure) for (const key of EXPOSURE_KEYS) delete merged[key];

  for (const [key, value] of Object.entries(incoming)) {
    if (key !== "advanced") merged[key] = value;
  }

  const advanced = currentAdvanced
    .map((set) => stripDomains(set, touchesFocus, touchesExposure))
    .filter(Boolean);
  if (Array.isArray(incoming.advanced)) advanced.push(...incoming.advanced);
  if (advanced.length) merged.advanced = advanced;

  return preserveCurrentMode(track, merged);
}

function installCameraConstraintGuard() {
  const proto = globalThis.MediaStreamTrack?.prototype;
  const nativeApply = proto?.applyConstraints;
  if (typeof nativeApply !== "function" || nativeApply.__airgapperPreservesCameraMode) return;

  const guardedApply = function(constraints) {
    return nativeApply.call(this, mergeOpticsConstraints(this, constraints));
  };
  Object.defineProperty(guardedApply, "__airgapperPreservesCameraMode", { value: true });
  try { proto.applyConstraints = guardedApply; } catch {}
}

installCameraConstraintGuard();
