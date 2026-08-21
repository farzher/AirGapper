const manualExposureByTrack = new WeakMap();
let poseRecoveryActive = false;
let poseRecoveryReason = "";
let poseRecoveryGeneration = 0;
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

function endPoseRecovery() {
  poseRecoveryActive = false;
  poseRecoveryReason = "";
}

function rememberManualExposure(track, settings = track?.getSettings?.()) {
  if (!track || !settings) return false;
  const exposure = Number(settings.exposureTime);
  const iso = Number(settings.iso);
  const mode = settings.exposureMode;
  if (mode !== "manual" || !(exposure > 0) || !(iso > 0)) return false;
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
    suppressedExposureWrites,
    suppressedWorkerRestarts
  };
}

export {
  beginPoseRecovery,
  endPoseRecovery,
  noteSuppressedExposureWrite,
  noteSuppressedWorkerRestart,
  poseRecoveryReasonEligible,
  recoveryDiagnostics,
  rememberManualExposure,
  rememberedManualExposure,
  shouldPreserveManualExposure
};
