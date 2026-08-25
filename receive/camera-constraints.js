import { decodeExposureHealthy, decodeExposureRecovering } from "./decode-health.js";

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
  if (!track || blockedForReopen.has(track) || reopenScheduled) return;
  const receiveView = document.getElementById("receiveView");
  if (!receiveView?.classList.contains("active")) return;

  blockedForReopen.add(track);
  reopenScheduled = true;
  const generation = ++reopenGeneration;

  // Capture-phase ownership is deliberate: pauseReceiver() stops the old manual
  // track synchronously before the EV/runtime checkbox handlers can enqueue any
  // focus or exposure mutation. Runtime's camera mutation queue accepts writes
  // only for the current live track, so a dead old HAL needs no global
  // MediaStreamTrack.applyConstraints interception.
  window.dispatchEvent(new Event("airgapper:pause-mode"));
  if (track.readyState === "live") {
    try { track.stop(); } catch {}
  }

  void (async () => {
    try {
      await cameraReleaseBarrier();
      if (generation !== reopenGeneration) return;
      if (!receiveView.classList.contains("active")) return;
      window.dispatchEvent(new Event("airgapper:resume-mode"));
    } finally {
      if (generation === reopenGeneration) reopenScheduled = false;
    }
  })();
}

function installManualToAutoReopen() {
  document.addEventListener("change", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.id !== "camera-exposure-auto" || !input.checked) return;
    const track = activeCameraTrack();
    if (!track || track.readyState !== "live") return;
    const actual = track.getSettings?.() ?? {};
    const manualPanel = document.getElementById("camera-optics-manual");
    if (actual.exposureMode === "manual" || manualPanel && !manualPanel.hidden) scheduleAutoCameraReopen(track);
  }, true);
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
const pendingConstraint = new WeakMap();

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

// Auto Optics may continue gathering evidence after the decoder has started
// proving the current sensor state. Broad health is enough to protect a known
// winner, but even the first fresh CRC-valid QR on a locked/seeded lattice gets
// a short provisional lease: a rescue transaction can have been queued while
// the preceding exposure was still blind and otherwise execute after that
// exposure starts working. If the packet was luck and progress stops, the short
// recovering lease expires and exploration resumes. The one exception is the
// no-change continuous->manual transition that freezes current exposure/ISO.
function healthyAutomaticExposureWouldPerturb(track, set) {
  if (!decodeExposureHealthy() && !decodeExposureRecovering()) return false;
  if (document.getElementById("camera-exposure-auto")?.checked !== true) return false;
  if (!EXPOSURE_KEYS.some((key) => set[key] !== void 0)) return false;

  const actual = track?.getSettings?.() ?? {};
  const caps = track?.getCapabilities?.() ?? {};
  const freezeCurrentIntoManual = set.exposureMode === "manual" &&
    actual.exposureMode !== "manual" &&
    set.exposureCompensation === void 0 &&
    closeSetting(actual.exposureTime, set.exposureTime, caps.exposureTime) &&
    closeSetting(actual.iso, set.iso, caps.iso);
  if (freezeCurrentIntoManual) return false;

  if (set.exposureMode !== void 0 && set.exposureMode !== actual.exposureMode) return true;
  if (!closeSetting(actual.exposureTime, set.exposureTime, caps.exposureTime)) return true;
  if (!closeSetting(actual.iso, set.iso, caps.iso)) return true;
  if (!closeSetting(actual.exposureCompensation, set.exposureCompensation, caps.exposureCompensation)) return true;
  return false;
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
  // A camera that resolved applyConstraints() but ignored the requested mode is
  // not settled. Remembering that false success makes every later request a
  // no-op and can leave Auto Optics believing it owns manual exposure forever.
  const requestedModeHeld = set.exposureMode === void 0 || actual.exposureMode === set.exposureMode;
  const stable = requestedModeHeld &&
    (settled.actual.exposureMode === void 0 || actual.exposureMode === settled.actual.exposureMode) &&
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

async function awaitConstraint(track, run) {
  // A timeout does not cancel MediaStreamTrack.applyConstraints(). Keep the
  // underlying HAL operation leased until it truly settles so an old timed-out
  // write cannot overlap and later overwrite a newer camera command.
  if (pendingConstraint.has(track)) return { ok: false, timedOut: false, busy: true };
  let timer;
  let timedOut = false;
  const operation = Promise.resolve().then(run);
  pendingConstraint.set(track, operation);
  const release = () => {
    if (pendingConstraint.get(track) === operation) pendingConstraint.delete(track);
  };
  void operation.then(release, release);
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error("Camera constraint write timed out"));
      }, CAMERA_CONSTRAINT_TIMEOUT_MS);
    });
    await Promise.race([operation, timeout]);
    return { ok: true, timedOut: false, busy: false };
  } catch {
    return { ok: false, timedOut, busy: false };
  } finally {
    clearTimeout(timer);
    // Rejected/successful operations are already done and can be released now.
    // Timed-out operations stay leased until their real promise settles.
    if (!timedOut) release();
  }
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
  if (!Object.keys(set).length || !track || track.readyState !== "live") return false;
  if ((constraintBlockedUntil.get(track) ?? 0) > performance.now() || pendingConstraint.has(track)) return false;
  const exposureOnly = Object.keys(set).every((key) => EXPOSURE_KEYS.includes(key));
  if (exposureOnly) {
    const strict = await awaitConstraint(track, () => track.applyConstraints(exactExposureConstraints(set)));
    if (strict.ok) return true;
    if (strict.busy) return false;
    if (strict.timedOut) {
      noteConstraintTimeout(track);
      return false;
    }
  }
  const fallback = await awaitConstraint(track, () => track.applyConstraints({ advanced: [set] }));
  if (fallback.timedOut) noteConstraintTimeout(track);
  return fallback.ok;
}

async function applyAdvancedConstraint(track, set, { allowHealthyPerturbation = false } = {}) {
  const requestedExposure = Boolean(set) && EXPOSURE_KEYS.some((key) => set[key] !== void 0);
  const supported = supportedExposureSet(track, set ?? {});
  const touchesExposure = EXPOSURE_KEYS.some((key) => supported[key] !== void 0);
  if (requestedExposure && !touchesExposure && Object.keys(withoutExposure(supported)).length === 0) return false;
  if (exposureConstraintAlreadySatisfied(track, supported) || stableSettledExposure(track, supported)) return true;
  if (!allowHealthyPerturbation && healthyAutomaticExposureWouldPerturb(track, supported)) {
    const remainder = withoutExposure(supported);
    // A protected sensor write is a veto, not a successful mutation. Apply any
    // unrelated focus/POI remainder, but report false for the requested compound
    // operation so Auto Optics cannot advance its state machine on settings that
    // never reached the camera.
    if (Object.keys(remainder).length) await applyConstraint(track, remainder);
    return false;
  }
  const applied = await applyConstraint(track, supported);
  if (applied && touchesExposure) rememberSettledExposure(track, supported);
  return applied;
}

installManualToAutoReopen();
installSettledExposureSync();

export { applyAdvancedConstraint };