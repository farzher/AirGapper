from pathlib import Path


def replace(path, old, new):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f'missing target in {path}: {old[:100]!r}')
    p.write_text(s.replace(old, new, 1))

replace('index.html', 'v0.5.141', 'v0.5.142')
replace('main.js', 'const APP_BUILD = "v0.5.141";', 'const APP_BUILD = "v0.5.142";')
replace('receive/main.js', 'const RECEIVER_RUNTIME_BUILD = "v0.5.141";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.142";')
replace('sw.js', 'airgapper-static-js-v104', 'airgapper-static-js-v105')

replace('receive/main.js', '''const AUTO_OPTICS_LOCK_SETTLE_MS = 650;
const AUTO_OPTICS_RELEASE_SILENCE_MS = 2400;
const AUTO_OPTICS_RECENT_DECODE_MS = 700;
const AUTO_OPTICS_MIN_RECENT_DECODES = 4;
const AUTO_OPTICS_SHUTTER_FRAME_FRACTION = 0.30;
let autoOpticsRuntimeState = "ae";
let autoOpticsMutationRunning = false;
let autoOpticsLockSince = 0;
let autoOpticsRetryAt = 0;''', '''const AUTO_OPTICS_LOCK_SETTLE_MS = 1800;
const AUTO_OPTICS_RELEASE_SILENCE_MS = 2400;
const AUTO_OPTICS_RECENT_DECODE_MS = 900;
const AUTO_OPTICS_MIN_STRUGGLING_QR_PER_SECOND = 5;
const AUTO_OPTICS_MAX_STRUGGLING_QR_PER_SECOND = 45;
const AUTO_OPTICS_SHUTTER_FRAME_FRACTION = 0.30;
const AUTO_OPTICS_VALIDATE_MS = 900;
let autoOpticsRuntimeState = "ae";
let autoOpticsMutationRunning = false;
let autoOpticsLockSince = 0;
let autoOpticsRetryAt = 0;
let autoOpticsValidationAt = 0;
let autoOpticsBaselineQrRate = 0;''')

replace('receive/main.js', '''function resetAutomaticOpticsRuntime() {
  autoOpticsRuntimeState = "ae";
  autoOpticsMutationRunning = false;
  autoOpticsLockSince = 0;
  autoOpticsRetryAt = 0;
}''', '''function resetAutomaticOpticsRuntime() {
  autoOpticsRuntimeState = "ae";
  autoOpticsMutationRunning = false;
  autoOpticsLockSince = 0;
  autoOpticsRetryAt = 0;
  autoOpticsValidationAt = 0;
  autoOpticsBaselineQrRate = 0;
}''')

replace('receive/main.js', '''    autoOpticsRuntimeState = "manual";
    autoOpticsRetryAt = receiverNow() + 1500;
    preferredExposureTime = track.getSettings().exposureTime ?? exposure;
    preferredIso = track.getSettings().iso ?? iso;''', '''    autoOpticsRuntimeState = "manual";
    autoOpticsRetryAt = receiverNow() + 1500;
    autoOpticsValidationAt = receiverNow() + AUTO_OPTICS_VALIDATE_MS;
    preferredExposureTime = track.getSettings().exposureTime ?? exposure;
    preferredIso = track.getSettings().iso ?? iso;''')

replace('receive/main.js', '''    autoOpticsRuntimeState = "ae";
    autoOpticsLockSince = 0;
    autoOpticsRetryAt = receiverNow() + 900;''', '''    autoOpticsRuntimeState = "ae";
    autoOpticsLockSince = 0;
    autoOpticsValidationAt = 0;
    autoOpticsBaselineQrRate = 0;
    autoOpticsRetryAt = receiverNow() + 900;''')

old = '''function maintainAutomaticQrOptics(now) {
  if (!automaticOptics || replayRunning || optimizerPipelineActive || optimizeRunning || autoOpticsMutationRunning) return;
  const track = stream?.getVideoTracks()[0];
  if (!track || track.readyState !== "live") return;
  if (gridLattice.locked) {
    if (!autoOpticsLockSince) autoOpticsLockSince = now;
    const recentDecodes = qrReadTimes.reduce((count, at) => count + Number(at > now - AUTO_OPTICS_RECENT_DECODE_MS), 0);
    const decodeFresh = Boolean(lastStreamDecodeAt && now - lastStreamDecodeAt < AUTO_OPTICS_RECENT_DECODE_MS);
    if (autoOpticsRuntimeState === "ae" && decodeFresh && recentDecodes >= AUTO_OPTICS_MIN_RECENT_DECODES &&
        now - autoOpticsLockSince >= AUTO_OPTICS_LOCK_SETTLE_MS && now >= autoOpticsRetryAt) {
      void settleAutomaticQrOptics(track, now);
    }
    return;
  }
  autoOpticsLockSince = 0;
  if (autoOpticsRuntimeState === "manual" &&
      (!lastStreamDecodeAt || now - lastStreamDecodeAt >= AUTO_OPTICS_RELEASE_SILENCE_MS) &&
      now >= autoOpticsRetryAt) {
    void releaseAutomaticQrOptics(track, now);
  }
}'''
new = '''function maintainAutomaticQrOptics(now) {
  if (!automaticOptics || replayRunning || optimizerPipelineActive || optimizeRunning || autoOpticsMutationRunning) return;
  const track = stream?.getVideoTracks()[0];
  if (!track || track.readyState !== "live") return;
  const settings = track.getSettings();
  const recentDecodes = qrReadTimes.reduce((count, at) => count + Number(at > now - AUTO_OPTICS_RECENT_DECODE_MS), 0);
  const recentQrRate = recentDecodes / (AUTO_OPTICS_RECENT_DECODE_MS / 1e3);
  const captureWindowMs = 800;
  const recentCaptureRate = captureTimes.reduce((count, at) => count + Number(at > now - captureWindowMs), 0) / (captureWindowMs / 1e3);
  const nominalFps = Math.max(12, Math.min(120, Number(settings.frameRate) || 30));

  if (gridLattice.locked) {
    if (!autoOpticsLockSince) autoOpticsLockSince = now;
    const decodeFresh = Boolean(lastStreamDecodeAt && now - lastStreamDecodeAt < AUTO_OPTICS_RECENT_DECODE_MS);

    // A healthy QR stream is stronger evidence than any static optics score.
    // Do not disturb hardware AE just because a theoretically shorter shutter
    // is available: several Android HALs stall frame delivery when entering
    // manual sensor mode, which is much worse than a little extra blur.
    if (autoOpticsRuntimeState === "ae" && decodeFresh &&
        now - autoOpticsLockSince >= AUTO_OPTICS_LOCK_SETTLE_MS && now >= autoOpticsRetryAt) {
      const motionSafeExposure = 1e4 / nominalFps * AUTO_OPTICS_SHUTTER_FRAME_FRACTION;
      const longAeShutter = Number.isFinite(settings.exposureTime) && settings.exposureTime > motionSafeExposure * 1.35;
      const struggling = recentQrRate >= AUTO_OPTICS_MIN_STRUGGLING_QR_PER_SECOND &&
        recentQrRate <= AUTO_OPTICS_MAX_STRUGGLING_QR_PER_SECOND;
      if (longAeShutter && struggling && recentCaptureRate >= nominalFps * 0.82) {
        autoOpticsBaselineQrRate = recentQrRate;
        void settleAutomaticQrOptics(track, now);
      }
    } else if (autoOpticsRuntimeState === "manual" && autoOpticsValidationAt && now >= autoOpticsValidationAt) {
      autoOpticsValidationAt = 0;
      const fpsCollapsed = recentCaptureRate < nominalFps * 0.72;
      const yieldCollapsed = autoOpticsBaselineQrRate > 0 && recentQrRate < Math.max(3, autoOpticsBaselineQrRate * 0.58);
      if (fpsCollapsed || yieldCollapsed) {
        autoOpticsRetryAt = 0;
        void releaseAutomaticQrOptics(track, now);
      } else {
        autoOpticsBaselineQrRate = 0;
      }
    }
    return;
  }
  autoOpticsLockSince = 0;
  if (autoOpticsRuntimeState === "manual" &&
      (!lastStreamDecodeAt || now - lastStreamDecodeAt >= AUTO_OPTICS_RELEASE_SILENCE_MS) &&
      now >= autoOpticsRetryAt) {
    void releaseAutomaticQrOptics(track, now);
  }
}'''
replace('receive/main.js', old, new)
