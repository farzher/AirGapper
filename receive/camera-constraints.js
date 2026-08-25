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
        return original({ audio: constraints?.audio ?? false, video: { facingMode } });
      }
    }
  };
  Object.defineProperty(wrapped, "__airgapperIOSFallback", { value: true });
  try { media.getUserMedia = wrapped; } catch {}
}
installIOSCameraConstraintFallback();

const blockedForReopen = new WeakSet();
let reopenScheduled = false;
let reopenGeneration = 0;

function activeCameraTrack() {
  const source = document.getElementById("video")?.srcObject;
  return source?.getVideoTracks?.()[0];
}

function cameraReleaseBarrier(ms = 120) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scheduleAutoCameraReopen(track) {
  if (!track || blockedForReopen.has(track)) return;
  blockedForReopen.add(track);
  if (reopenScheduled) return;
  reopenScheduled = true;
  const generation = ++reopenGeneration;

  setTimeout(async () => {
    try {
      const receiveView = document.getElementById("receiveView");
      if (!receiveView?.classList.contains("active")) return;

      window.dispatchEvent(new Event("airgapper:pause-mode"));
      await cameraReleaseBarrier();

      if (generation !== reopenGeneration) return;
      if (!receiveView.classList.contains("active")) return;
      window.dispatchEvent(new Event("airgapper:resume-mode"));
    } finally {
      if (generation === reopenGeneration) reopenScheduled = false;
    }
  }, 0);
}

function installManualToAutoReopenGuard() {
  document.addEventListener("change", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.id !== "camera-exposure-auto" || !input.checked) return;
    const track = activeCameraTrack();
    if (!track || track.readyState !== "live") return;
    const actual = track.getSettings?.() ?? {};
    const manualPanel = document.getElementById("camera-optics-manual");
    if (actual.exposureMode === "manual" || manualPanel && !manualPanel.hidden) scheduleAutoCameraReopen(track);
  }, true);

  const proto = globalThis.MediaStreamTrack?.prototype;
  const nativeApply = proto?.applyConstraints;
  if (typeof nativeApply !== "function" || nativeApply.__airgapperManualToAutoGuard) return;

  const guardedApply = function(constraints) {
    if (blockedForReopen.has(this)) return Promise.resolve();
    return nativeApply.call(this, constraints);
  };
  Object.defineProperty(guardedApply, "__airgapperManualToAutoGuard", { value: true });
  try { proto.applyConstraints = guardedApply; } catch {}
}

function closeNumber(a, b, ratio = 0.02) {
  a = Number(a);
  b = Number(b);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * ratio);
}

function syncManualAxis(id, autoId, actual) {
  const input = document.getElementById(id);
  const automatic = document.getElementById(autoId);
  const value = Number(actual);
  if (!(input instanceof HTMLInputElement) || automatic?.checked || !Number.isFinite(value)) return false;
  if (closeNumber(input.value, value)) return false;
  const min = Number(input.min);
  const max = Number(input.max);
  const clamped = Math.max(Number.isFinite(min) ? min : -Infinity, Math.min(Number.isFinite(max) ? max : Infinity, value));
  input.value = String(clamped);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

function installSettledExposureSync() {
  window.addEventListener("airgapper:exposure-settled", (event) => {
    const detail = event?.detail;
    const track = activeCameraTrack();
    if (!track || detail?.track !== track || track.readyState !== "live") return;
    if (document.getElementById("camera-exposure-auto")?.checked) return;
    const requested = detail.requested ?? {};
    const actual = detail.actual ?? {};

    if (requested.exposureTime !== undefined)
      syncManualAxis("camera-exposure", "exposure-axis-auto", actual.exposureTime);
    if (requested.iso !== undefined)
      syncManualAxis("camera-iso", "iso-axis-auto", actual.iso);
  });
}

const EXPOSURE_KEYS = ["exposureMode", "exposureTime", "iso", "exposureCompensation"];
const CAMERA_CONSTRAINT_TIMEOUT_MS = 900;
const CAMERA_CONSTRAINT_TIMEOUT_BACKOFF_MS = 3000;
const SETTLED_EXPOSURE_CONFIRMATIONS = 2;
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

function exposureTargetDiffers(set, actual, caps) {
  return !closeSetting(actual.exposureTime, set.exposureTime, caps.exposureTime) ||
    !closeSetting(actual.iso, set.iso, caps.iso) ||
    !closeSetting(actual.exposureCompensation, set.exposureCompensation, caps.exposureCompensation);
}

function reportStableSettledExposure(track, settled, set, actual, caps) {
  if (settled.reported || !exposureTargetDiffers(set, actual, caps)) return;
  settled.reported = true;
  if (typeof window !== "object" || typeof CustomEvent !== "function") return;
  const detail = {
    track,
    requested: {
      exposureMode: set.exposureMode,
      exposureTime: set.exposureTime,
      iso: set.iso,
      exposureCompensation: set.exposureCompensation
    },
    actual: {
      exposureMode: actual.exposureMode,
      exposureTime: actual.exposureTime,
      iso: actual.iso,
      exposureCompensation: actual.exposureCompensation
    }
  };
  queueMicrotask(() => window.dispatchEvent(new CustomEvent("airgapper:exposure-settled", { detail })));
}

function stableSettledExposure(track, set) {
  if (!track || !EXPOSURE_KEYS.some((key) => set[key] !== void 0)) return false;
  const settled = settledExposure.get(track);
  if (!settled || settled.key !== exposureRequestKey(set)) return false;
  const actual = track.getSettings?.() ?? {};
  const caps = track.getCapabilities?.() ?? {};
  const stable = (settled.actual.exposureMode === void 0 || actual.exposureMode === settled.actual.exposureMode) &&
    closeSetting(actual.exposureTime, settled.actual.exposureTime, caps.exposureTime) &&
    closeSetting(actual.iso, settled.actual.iso, caps.iso) &&
    closeSetting(actual.exposureCompensation, settled.actual.exposureCompensation, caps.exposureCompensation);
  if (stable) {
    settled.stableChecks++;
    if (settled.stableChecks >= SETTLED_EXPOSURE_CONFIRMATIONS)
      reportStableSettledExposure(track, settled, set, actual, caps);
  } else {
    settled.stableChecks = 0;
  }
  return stable;
}

function rememberSettledExposure(track, set) {
  if (!track || !EXPOSURE_KEYS.some((key) => set[key] !== void 0)) return;
  const actual = track.getSettings?.() ?? {};
  settledExposure.set(track, {
    key: exposureRequestKey(set),
    reported: false,
    stableChecks: 0,
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

installManualToAutoReopenGuard();
installSettledExposureSync();

export { applyAdvancedConstraint }; 
