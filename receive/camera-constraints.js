const nav = typeof navigator === "undefined" ? void 0 : navigator;
const iosSafariCamera = !!nav && (/iPad|iPhone|iPod/.test(nav.userAgent) || nav.platform === "MacIntel" && nav.maxTouchPoints > 1);

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
const settledExposure = new WeakMap();

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

function closeSetting(value, target, range) {
  if (target === void 0) return true;
  if (!Number.isFinite(Number(value)) || !Number.isFinite(Number(target))) return value === target;
  const tolerance = Math.max(Number(range?.step) * 0.75 || 0, Math.abs(Number(target)) * 0.02, 1e-6);
  return Math.abs(Number(value) - Number(target)) <= tolerance;
}

function exposureConstraintAlreadySatisfied(track, set) {
  if (!track || !set) return false;
  const touchesFocus = set.focusMode !== void 0 || set.focusDistance !== void 0 || set.pointsOfInterest !== void 0;
  const touchesExposure = EXPOSURE_KEYS.some((key) => set[key] !== void 0);
  if (touchesFocus || !touchesExposure) return false;
  const actual = track.getSettings?.() ?? {};
  const caps = track.getCapabilities?.() ?? {};
  return (set.exposureMode === void 0 || actual.exposureMode === set.exposureMode) &&
    closeSetting(actual.exposureTime, set.exposureTime, caps.exposureTime) &&
    closeSetting(actual.iso, set.iso, caps.iso) &&
    closeSetting(actual.exposureCompensation, set.exposureCompensation, caps.exposureCompensation);
}

function exposureRequestKey(set) {
  return EXPOSURE_KEYS.map((key) => `${key}:${set[key] === void 0 ? "" : set[key]}`).join("|");
}

function stableSettledExposure(track, set) {
  if (!track || !EXPOSURE_KEYS.some((key) => set[key] !== void 0)) return false;
  const settled = settledExposure.get(track);
  if (!settled || settled.key !== exposureRequestKey(set)) return false;
  const actual = track.getSettings?.() ?? {};
  const caps = track.getCapabilities?.() ?? {};
  return (settled.actual.exposureMode === void 0 || actual.exposureMode === settled.actual.exposureMode) &&
    closeSetting(actual.exposureTime, settled.actual.exposureTime, caps.exposureTime) &&
    closeSetting(actual.iso, settled.actual.iso, caps.iso) &&
    closeSetting(actual.exposureCompensation, settled.actual.exposureCompensation, caps.exposureCompensation);
}

function rememberSettledExposure(track, set) {
  if (!track || !EXPOSURE_KEYS.some((key) => set[key] !== void 0)) return;
  const actual = track.getSettings?.() ?? {};
  settledExposure.set(track, {
    key: exposureRequestKey(set),
    actual: {
      exposureMode: actual.exposureMode,
      exposureTime: actual.exposureTime,
      iso: actual.iso,
      exposureCompensation: actual.exposureCompensation
    }
  });
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
  if (exposureConstraintAlreadySatisfied(track, supported) || stableSettledExposure(track, supported)) return true;
  const applied = await applyConstraint(track, supported);
  if (applied && touchesExposure) rememberSettledExposure(track, supported);
  return applied;
}

export { applyAdvancedConstraint };