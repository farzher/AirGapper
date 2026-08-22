const manualExposureByTrack = new WeakMap();
const verifiedExposureByTrack = new WeakMap();
const VERIFIED_QR_HOLD_MS = 2000;
const VERIFIED_QR_MOTION_HOLD_MS = 900;
const VERIFIED_QR_RESCUE_INTERVAL_MS = 2500;
const VERIFIED_QR_MAX_EXPOSURE = 50; // 5.0 ms; browser exposureTime units are 0.1 ms.
let diagnosticTrack;
let exposureProtectionEnabled = true;
let poseRecoveryActive = false;
let poseRecoveryReason = "";
let poseRecoveryGeneration = 0;
let warmWorkerRestartBudget = 0;
let suppressedExposureWrites = 0;
let suppressedWorkerRestarts = 0;
let exposureRescueCount = 0;

function poseRecoveryReasonEligible(reason = "") {
  // Slot-level self-heals are deliberately excluded: a bad local residual is
  // never enough evidence to discard the whole wall. Hard recovery belongs to
  // actual whole-wall silence, explicit orientation changes, or a true global
  // tracked-geometry collapse.
  return /whole lattice stale|screen orientation changed|tracked geometry collapsed/i.test(String(reason));
}

function setExposureProtectionEnabled(enabled) {
  exposureProtectionEnabled = Boolean(enabled);
}

function beginPoseRecovery(reason = "camera pose recovery") {
  if (!poseRecoveryReasonEligible(reason)) return false;
  poseRecoveryActive = true;
  poseRecoveryReason = String(reason);
  poseRecoveryGeneration++;
  return true;
}

function armWarmWorkerRestartSuppression() {
  if (!poseRecoveryActive) return false;
  warmWorkerRestartBudget = Math.max(warmWorkerRestartBudget, 1);
  return true;
}

function consumeWarmWorkerRestartSuppression() {
  if (!poseRecoveryActive || warmWorkerRestartBudget <= 0) return false;
  warmWorkerRestartBudget--;
  return true;
}

function endPoseRecovery() {
  poseRecoveryActive = false;
  poseRecoveryReason = "";
  warmWorkerRestartBudget = 0;
}

function beginTrackDiagnostics(track) {
  if (!track || diagnosticTrack === track) return;
  diagnosticTrack = track;
  suppressedExposureWrites = 0;
  suppressedWorkerRestarts = 0;
  exposureRescueCount = 0;
}

function rememberManualExposure(track, settings = track?.getSettings?.()) {
  if (!track || !settings) return false;
  const exposure = Number(settings.exposureTime);
  const iso = Number(settings.iso);
  const mode = settings.exposureMode;
  if (mode !== "manual" || !(exposure > 0) || !(iso > 0)) return false;
  beginTrackDiagnostics(track);
  manualExposureByTrack.set(track, { exposure, iso, at: performance.now() });
  return true;
}

function rememberedManualExposure(track) {
  return track ? manualExposureByTrack.get(track) : void 0;
}

function latchVerifiedExposure(track, settings = track?.getSettings?.(), at = performance.now()) {
  if (!exposureProtectionEnabled || !track || !settings) return false;
  const exposure = Number(settings.exposureTime);
  const iso = Number(settings.iso);
  if (settings.exposureMode !== "manual" || !(exposure > 0) || exposure > VERIFIED_QR_MAX_EXPOSURE || !(iso > 0)) return false;
  beginTrackDiagnostics(track);
  const prior = verifiedExposureByTrack.get(track);
  verifiedExposureByTrack.set(track, {
    exposure,
    iso,
    verifiedAt: at,
    motionAt: prior?.motionAt ?? -Infinity,
    nextRescueAt: at + VERIFIED_QR_HOLD_MS
  });
  return true;
}

function noteExposureMotion(track, at = performance.now()) {
  const state = track ? verifiedExposureByTrack.get(track) : void 0;
  if (!state) return false;
  state.motionAt = Math.max(state.motionAt ?? -Infinity, at);
  return true;
}

function verifiedExposureLatchDecision(track, now = performance.now()) {
  const state = exposureProtectionEnabled && track ? verifiedExposureByTrack.get(track) : void 0;
  if (!state) return { hold: false, rescue: false, reason: "unlatched" };
  const qrAge = Math.max(0, now - state.verifiedAt);
  const motionAge = Math.max(0, now - state.motionAt);
  if (qrAge <= VERIFIED_QR_HOLD_MS) {
    return { hold: true, rescue: false, reason: "verified QR recent", qrAge, motionAge, ...state };
  }
  if (motionAge <= VERIFIED_QR_MOTION_HOLD_MS) {
    return { hold: true, rescue: false, reason: "geometry moving", qrAge, motionAge, ...state };
  }
  if (now < state.nextRescueAt) {
    return { hold: true, rescue: false, reason: "rescue settling", qrAge, motionAge, ...state };
  }
  return { hold: false, rescue: true, reason: "stable decode outage", qrAge, motionAge, ...state };
}

function consumeExposureRescue(track, now = performance.now()) {
  const decision = verifiedExposureLatchDecision(track, now);
  if (!decision.rescue) return false;
  const state = verifiedExposureByTrack.get(track);
  state.nextRescueAt = now + VERIFIED_QR_RESCUE_INTERVAL_MS;
  exposureRescueCount++;
  return true;
}

function shouldPreserveManualExposure(track) {
  return exposureProtectionEnabled && poseRecoveryActive && Boolean(rememberedManualExposure(track));
}

function noteSuppressedExposureWrite() {
  suppressedExposureWrites++;
}

function noteSuppressedWorkerRestart() {
  suppressedWorkerRestarts++;
}

function recoveryDiagnostics() {
  const verified = diagnosticTrack ? verifiedExposureByTrack.get(diagnosticTrack) : void 0;
  return {
    active: poseRecoveryActive,
    exposureProtectionEnabled,
    reason: poseRecoveryReason,
    generation: poseRecoveryGeneration,
    warmWorkerRestartBudget,
    suppressedExposureWrites,
    suppressedWorkerRestarts,
    exposureRescueCount,
    verifiedExposure: verified ? { exposure: verified.exposure, iso: verified.iso, verifiedAt: verified.verifiedAt } : void 0
  };
}

export {
  VERIFIED_QR_HOLD_MS,
  VERIFIED_QR_MAX_EXPOSURE,
  VERIFIED_QR_MOTION_HOLD_MS,
  VERIFIED_QR_RESCUE_INTERVAL_MS,
  armWarmWorkerRestartSuppression,
  beginPoseRecovery,
  beginTrackDiagnostics,
  consumeExposureRescue,
  consumeWarmWorkerRestartSuppression,
  endPoseRecovery,
  latchVerifiedExposure,
  noteExposureMotion,
  noteSuppressedExposureWrite,
  noteSuppressedWorkerRestart,
  poseRecoveryReasonEligible,
  recoveryDiagnostics,
  rememberManualExposure,
  rememberedManualExposure,
  setExposureProtectionEnabled,
  shouldPreserveManualExposure,
  verifiedExposureLatchDecision
};
