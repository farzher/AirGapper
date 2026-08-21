const manualExposureByTrack = new WeakMap();
let diagnosticTrack;
let poseRecoveryActive = false;
let poseRecoveryReason = "";
let poseRecoveryGeneration = 0;
let warmWorkerRestartBudget = 0;
let suppressedExposureWrites = 0;
let suppressedWorkerRestarts = 0;

function poseRecoveryReasonEligible(reason = "") {
  return /whole lattice stale|screen orientation changed|repeated slot geometry self-heals|tracked geometry collapsed/i.test(String(reason));
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

function shouldPreserveManualExposure(track) {
  return poseRecoveryActive && Boolean(rememberedManualExposure(track));
}

function noteSuppressedExposureWrite() {
  suppressedExposureWrites++;
}

function noteSuppressedWorkerRestart() {
  suppressedWorkerRestarts++;
}

function recoveryDiagnostics() {
  return {
    active: poseRecoveryActive,
    reason: poseRecoveryReason,
    generation: poseRecoveryGeneration,
    warmWorkerRestartBudget,
    suppressedExposureWrites,
    suppressedWorkerRestarts
  };
}

export {
  armWarmWorkerRestartSuppression,
  beginPoseRecovery,
  beginTrackDiagnostics,
  consumeWarmWorkerRestartSuppression,
  endPoseRecovery,
  noteSuppressedExposureWrite,
  noteSuppressedWorkerRestart,
  poseRecoveryReasonEligible,
  recoveryDiagnostics,
  rememberManualExposure,
  rememberedManualExposure,
  shouldPreserveManualExposure
};
