import { parseAutoPhaseDiagnostics, recoveryHealth } from "./auto-phase-policy.js";

const hasDocument = typeof document !== "undefined";
const diagnostics = hasDocument ? document.getElementById("focus-diagnostics") : null;
const opticsAuto = hasDocument ? document.getElementById("camera-exposure-auto") : null;
const video = hasDocument ? document.getElementById("video") : null;
const phaseRoot = hasDocument ? document.getElementById("camera-phase-nudge") : null;

const CONFIG = Object.freeze({
  aeGraceMs: 900,
  finderHoldMs: 700,
  unprovenBurstMs: 260,
  unprovenCooldownMs: 950,
  trustedMs: 650,
  experimentMs: 8000,
  experimentGoodMs: 350,
  closeRatio: 0.14
});

const EXPOSURE_KEYS = ["exposureMode", "exposureTime", "iso", "exposureCompensation"];
const states = new WeakMap();
let lastTrack = null;
let lastSample = null;
let statusEl = null;
let originalApplyConstraints = null;
let bypassDepth = 0;

function nowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function scalar(value) {
  if (value && typeof value === "object") {
    if ("exact" in value) return value.exact;
    if ("ideal" in value) return value.ideal;
  }
  return value;
}

export function exposurePatchFromConstraints(constraints) {
  if (!constraints || typeof constraints !== "object") return null;
  const patch = {};
  const sources = [constraints, ...(Array.isArray(constraints.advanced) ? constraints.advanced : [])];
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    for (const key of EXPOSURE_KEYS) {
      if (source[key] !== undefined) patch[key] = scalar(source[key]);
    }
  }
  return Object.keys(patch).length ? patch : null;
}

function stateFor(track) {
  let state = states.get(track);
  if (!state) {
    state = {
      firstExposureAt: 0,
      trustedUntil: 0,
      trustedReason: "",
      burstUntil: 0,
      nextBurstAt: 0,
      finderHoldUntil: 0,
      lastFinderHints: 0,
      qrProven: false,
      protected: null,
      experiment: null,
      experimentGoodSince: 0,
      restoring: false,
      lastDecision: "idle"
    };
    states.set(track, state);
  }
  return state;
}

function activeTrack() {
  const source = video?.srcObject;
  const track = source && typeof source.getVideoTracks === "function"
    ? source.getVideoTracks().find((item) => item.readyState === "live")
    : null;
  if (track) lastTrack = track;
  return track || (lastTrack?.readyState === "live" ? lastTrack : null);
}

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function sensorSnapshot(track) {
  const settings = track?.getSettings?.() || {};
  const exposureTime = finitePositive(settings.exposureTime);
  const iso = finitePositive(settings.iso);
  return {
    exposureMode: settings.exposureMode || "",
    exposureTime,
    iso,
    exposureCompensation: Number.isFinite(Number(settings.exposureCompensation)) ? Number(settings.exposureCompensation) : null
  };
}

function closeNumber(a, b, ratio = CONFIG.closeRatio) {
  a = Number(a);
  b = Number(b);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
  return Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * ratio);
}

function requestNearSnapshot(patch, snapshot) {
  if (!patch || !snapshot) return false;
  if (patch.exposureMode !== undefined && snapshot.exposureMode && patch.exposureMode !== snapshot.exposureMode) return false;
  if (patch.exposureTime !== undefined && !closeNumber(patch.exposureTime, snapshot.exposureTime)) return false;
  if (patch.iso !== undefined && !closeNumber(patch.iso, snapshot.iso)) return false;
  if (patch.exposureCompensation !== undefined) {
    if (snapshot.exposureCompensation === null) {
      if (Math.abs(Number(patch.exposureCompensation) || 0) > 0.05) return false;
    } else if (Math.abs(Number(patch.exposureCompensation) - snapshot.exposureCompensation) > 0.15) return false;
  }
  return true;
}

function neutralAe(patch) {
  if (!patch) return false;
  if (patch.exposureTime !== undefined || patch.iso !== undefined) return false;
  if (patch.exposureMode !== undefined && patch.exposureMode !== "continuous") return false;
  if (patch.exposureCompensation !== undefined && Math.abs(Number(patch.exposureCompensation) || 0) > 0.05) return false;
  return patch.exposureMode === "continuous" || patch.exposureCompensation !== undefined;
}

function manualModeOnly(patch) {
  return patch?.exposureMode === "manual" && patch.exposureTime === undefined &&
    patch.iso === undefined && patch.exposureCompensation === undefined;
}

function manualFreezeNearCurrent(patch, current) {
  return patch?.exposureMode === "manual" &&
    (patch.exposureTime !== undefined || patch.iso !== undefined) &&
    requestNearSnapshot(patch, { ...current, exposureMode: "manual" });
}

function autoOpticsEnabled() {
  return Boolean(opticsAuto?.checked);
}

function healthGood(sample) {
  if (!sample) return false;
  if (sample.acquiring) return sample.validRate >= 0.5 && sample.decodeSilenceMs < 550;
  return recoveryHealth(sample, false).healthy;
}

function describeSnapshot(snapshot) {
  if (!snapshot?.exposureTime || !snapshot?.iso) return "";
  return `${Number((snapshot.exposureTime * 0.1).toPrecision(3))} ms · ISO ${Math.round(snapshot.iso)}`;
}

function updateStatus(state, detail = "") {
  if (!statusEl) return;
  const protectedLabel = state?.protected ? describeSnapshot(state.protected) : "";
  const suffix = detail ? ` · ${detail}` : protectedLabel ? ` · ${protectedLabel}` : "";
  statusEl.textContent = `Optics guard · ${state?.lastDecision || "idle"}${suffix}`;
}

function closeTrust(state) {
  state.trustedUntil = 0;
  state.trustedReason = "";
}

function protectCurrent(track, state, reason = "QR-proven lock") {
  const snapshot = sensorSnapshot(track);
  if (snapshot.exposureMode !== "manual" || !snapshot.exposureTime || !snapshot.iso) return false;
  state.protected = snapshot;
  state.qrProven = true;
  state.experiment = null;
  state.experimentGoodSince = 0;
  closeTrust(state);
  state.lastDecision = reason;
  updateStatus(state);
  return true;
}

function noteDiagnostics() {
  const sample = parseAutoPhaseDiagnostics(diagnostics?.textContent || "");
  if (!sample) return;
  sample.now = nowMs();
  lastSample = sample;
  const track = activeTrack();
  if (!track) return;
  const state = stateFor(track);

  if (sample.finderHints > state.lastFinderHints) {
    state.finderHoldUntil = sample.now + CONFIG.finderHoldMs;
    state.lastFinderHints = sample.finderHints;
    if (!state.qrProven && !state.experiment) {
      state.lastDecision = "finder hold";
      updateStatus(state, `${CONFIG.finderHoldMs} ms`);
    }
  } else if (sample.finderHints < state.lastFinderHints) {
    state.lastFinderHints = sample.finderHints;
    state.finderHoldUntil = 0;
  }

  const good = healthGood(sample);
  if (good) {
    state.qrProven = true;
    if (state.experiment) {
      if (!state.experimentGoodSince) state.experimentGoodSince = sample.now;
      if (sample.now - state.experimentGoodSince >= CONFIG.experimentGoodMs && protectCurrent(track, state, "recovery winner locked")) return;
    } else if (!state.protected) {
      protectCurrent(track, state);
    }
  } else {
    state.experimentGoodSince = 0;
  }

  if (state.experiment && sample.now >= state.experiment.deadline) void finishExperiment(track, state, good);
  else if (state.protected) updateStatus(state);
  else if (sample.now < state.finderHoldUntil) updateStatus(state, "QR structure visible");
  else if (state.firstExposureAt && sample.now - state.firstExposureAt < CONFIG.aeGraceMs)
    updateStatus(state, "hardware AE settling");
}

export function opticsGuardDecision({ state, patch, current, now, auto = true }) {
  if (!patch || !auto) return { allow: true, reason: !patch ? "not exposure" : "manual optics" };
  if (state.trustedUntil > now || state.experiment) return { allow: true, reason: state.experiment ? "recovery experiment" : state.trustedReason || "trusted" };
  if (!state.firstExposureAt) state.firstExposureAt = now;

  if (state.protected) {
    if (requestNearSnapshot(patch, state.protected)) return { allow: true, reason: "protected no-op" };
    return { allow: false, reason: "QR-proven lock" };
  }

  if (state.qrProven) {
    if (manualModeOnly(patch) || manualFreezeNearCurrent(patch, current) || neutralAe(patch))
      return { allow: true, reason: "freeze first QR" };
    return { allow: false, reason: "protect first QR" };
  }

  const age = now - state.firstExposureAt;
  if (age < CONFIG.aeGraceMs) {
    if (neutralAe(patch)) return { allow: true, reason: "AE grace" };
    return { allow: false, reason: "AE grace" };
  }

  if (now < state.finderHoldUntil) {
    if (neutralAe(patch)) return { allow: true, reason: "finder hold" };
    return { allow: false, reason: "finder hold" };
  }

  if (now < state.burstUntil) return { allow: true, reason: "acquisition optics burst" };
  if (now >= state.nextBurstAt) {
    state.burstUntil = now + CONFIG.unprovenBurstMs;
    state.nextBurstAt = now + CONFIG.unprovenCooldownMs;
    return { allow: true, reason: "acquisition optics burst" };
  }
  return { allow: false, reason: "acquisition optics cooldown" };
}

async function restoreProtected(track, state) {
  if (!state.protected || state.restoring || !originalApplyConstraints || track.readyState !== "live") return false;
  state.restoring = true;
  closeTrust(state);
  const snapshot = state.protected;
  try {
    bypassDepth++;
    await originalApplyConstraints.call(track, {
      advanced: [{
        exposureMode: "manual",
        exposureTime: snapshot.exposureTime,
        iso: snapshot.iso
      }]
    });
    state.lastDecision = "rollback to QR-proven";
    updateStatus(state);
    return true;
  } catch {
    state.lastDecision = "rollback failed";
    updateStatus(state);
    return false;
  } finally {
    bypassDepth--;
    state.restoring = false;
  }
}

async function finishExperiment(track, state, good = healthGood(lastSample)) {
  const experiment = state.experiment;
  if (!experiment) return;
  state.experiment = null;
  state.experimentGoodSince = 0;
  closeTrust(state);
  if (good && protectCurrent(track, state, "recovery winner locked")) return;
  if (experiment.rollback) {
    state.protected = experiment.rollback;
    await restoreProtected(track, state);
  } else {
    state.lastDecision = "recovery experiment ended";
    updateStatus(state);
  }
}

export function allowPhasePulse(ms = CONFIG.trustedMs) {
  const track = activeTrack();
  if (!track) return;
  const state = stateFor(track);
  state.trustedUntil = Math.max(state.trustedUntil, nowMs() + ms);
  state.trustedReason = "phase pulse";
  state.lastDecision = "phase pulse allowed";
  updateStatus(state);
}

export function allowUserOptics(ms = 1800) {
  const track = activeTrack();
  if (!track) return;
  const state = stateFor(track);
  state.trustedUntil = Math.max(state.trustedUntil, nowMs() + ms);
  state.trustedReason = "user optics";
  state.lastDecision = "user optics allowed";
  updateStatus(state);
}

export function beginOpticsExperiment(ms = CONFIG.experimentMs) {
  const track = activeTrack();
  if (!track) return false;
  const state = stateFor(track);
  const now = nowMs();
  state.experiment = {
    startedAt: now,
    deadline: now + Math.max(1200, ms),
    rollback: state.protected ? { ...state.protected } : null
  };
  state.experimentGoodSince = 0;
  state.trustedUntil = state.experiment.deadline;
  state.trustedReason = "recovery experiment";
  state.lastDecision = "recovery experiment";
  updateStatus(state, state.protected ? "rollback armed" : "no proven rollback yet");
  return true;
}

export function opticsGuardSummary() {
  const track = activeTrack();
  if (!track) return "optics guard waiting";
  const state = stateFor(track);
  return state.lastDecision || "optics guard idle";
}

function installApplyConstraintsGuard() {
  if (typeof MediaStreamTrack === "undefined") return;
  const proto = MediaStreamTrack.prototype;
  const marker = Symbol.for("airgapper.opticsGuardInstalled");
  if (proto[marker]) return;
  const native = proto.applyConstraints;
  if (typeof native !== "function") return;
  originalApplyConstraints = native;

  const wrapped = async function(constraints) {
    if (bypassDepth > 0) return native.call(this, constraints);
    lastTrack = this;
    const patch = exposurePatchFromConstraints(constraints);
    if (!patch) return native.call(this, constraints);
    const state = stateFor(this);
    const now = nowMs();
    const current = sensorSnapshot(this);
    const decision = opticsGuardDecision({ state, patch, current, now, auto: autoOpticsEnabled() });
    state.lastDecision = decision.reason;
    updateStatus(state);
    if (!decision.allow) {
      const error = typeof DOMException === "function"
        ? new DOMException(`AirGapper held exposure mutation: ${decision.reason}`, "AbortError")
        : Object.assign(new Error(`AirGapper held exposure mutation: ${decision.reason}`), { name: "AbortError" });
      throw error;
    }

    const result = await native.call(this, constraints);
    if (state.qrProven && !state.protected && (manualModeOnly(patch) || manualFreezeNearCurrent(patch, current)))
      protectCurrent(this, state);
    return result;
  };

  try {
    Object.defineProperty(proto, "applyConstraints", { configurable: true, writable: true, value: wrapped });
    Object.defineProperty(proto, marker, { configurable: true, value: true });
  } catch {
    originalApplyConstraints = null;
  }
}

function resetForFreshAutoRequest() {
  const track = activeTrack();
  if (!track) return;
  const state = stateFor(track);
  state.protected = null;
  state.qrProven = false;
  state.experiment = null;
  state.experimentGoodSince = 0;
  state.firstExposureAt = nowMs();
  state.finderHoldUntil = 0;
  state.burstUntil = 0;
  state.nextBurstAt = state.firstExposureAt + CONFIG.aeGraceMs;
  state.lastDecision = "fresh auto optics";
  updateStatus(state, "hardware AE grace restarted");
}

function installTrustedUiHooks() {
  if (!hasDocument) return;
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("#camera-exposure-pulse, #optics-optimize") : null;
    if (!target || !event.isTrusted) return;
    if (target.id === "camera-exposure-pulse") allowPhasePulse();
    else beginOpticsExperiment();
  }, true);

  document.addEventListener("input", (event) => {
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    if (event.target.matches("#camera-exposure, #camera-iso, #exposure-axis-toggle, #iso-axis-toggle")) allowUserOptics();
  }, true);
  document.addEventListener("change", (event) => {
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    if (event.target.matches("#camera-exposure-auto")) {
      allowUserOptics(2400);
      if (event.target.checked) resetForFreshAutoRequest();
      return;
    }
    if (event.target.matches("#camera-exposure, #camera-iso, #exposure-axis-toggle, #iso-axis-toggle")) allowUserOptics(2400);
  }, true);
}

function installStatus() {
  if (!phaseRoot || document.getElementById("camera-optics-guard-status")) return;
  statusEl = document.createElement("span");
  statusEl.id = "camera-optics-guard-status";
  statusEl.setAttribute("role", "status");
  statusEl.textContent = "Optics guard · waiting";
  phaseRoot.append(statusEl);
}

installApplyConstraintsGuard();
installTrustedUiHooks();
installStatus();

if (diagnostics) {
  const observer = new MutationObserver(() => queueMicrotask(noteDiagnostics));
  observer.observe(diagnostics, { childList: true, characterData: true, subtree: true });
  setInterval(noteDiagnostics, 220);
}
