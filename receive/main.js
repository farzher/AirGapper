import { TransportDecoder } from "../shared/transport.js";
import { prepareRaptorQ } from "../shared/raptorq.js";
import { formatBytes } from "../shared/format.js";
import {
  completedGoodputKbs,
  estimateTransferProgress,
  expectedCodingOverhead,
  formatDuration
} from "../shared/progress.js";
import { GridLattice } from "./grid-lattice.js";
import {
  DecodeWorkerPool
} from "../shared/worker-pool.js";
import { PlainQrPolicy } from "../shared/plain-qr-policy.js";
import { isSnippet, snippetText } from "../shared/snippet.js";
import {
  fnv1a,
  frameHeaderLength,
  frameOverhead,
  parseFrame,
  streamIdentity,
  unpackFile,
  verifyFile
} from "../shared/protocol.js";
import { RAPTOR_PACKET_ID_BYTES } from "../shared/coding-mode.js";
import { statusLine } from "../shared/status-line.js";
import { releaseScreenWakeLock, requestScreenWakeLock } from "../shared/wake-lock.js";
import { applyAdvancedConstraint, isAndroid, isIOS } from "../shared/platform.js";
import {
  FocusController,
  CAMERA_TUNING
} from "./focus-controller.js";
import { StaticQrOpticsAnalyzer } from "./qr-optics.js";
import {
  copyTextOnAndroid,
  isAndroidApp,
  isLegacyAndroidApp,
  saveFileOnAndroid,
  showScanCaptureMenuOnAndroid
} from "../shared/android.js";
import { readStoredZip } from "../shared/zip.js";
import { AgcapCorpus, AgcapRecorder } from "./agcap.js";
const RECEIVER_RUNTIME_BUILD = "v0.5.248";
const startBtn = document.getElementById("start");
const cameraDevice = document.getElementById("camera-device");
const cameraDeviceControl = document.getElementById("camera-device-control");
const cameraResolution = document.getElementById("camera-resolution");
const cameraResolutionLabel = document.getElementById("camera-resolution-label");
const decodeWorkers = document.getElementById("decode-workers");
const deviceLabel = document.getElementById("device-label");
const decodeWorkersControl = document.getElementById("decode-workers-control");
const strictHotPathToggle = document.getElementById("strict-hot-path");
const cameraActual = document.getElementById("camera-actual");
const cameraExposureControl = document.getElementById("camera-exposure-control");
const cameraExposureAuto = document.getElementById("camera-exposure-auto");
const cameraOpticsManual = document.getElementById("camera-optics-manual");
const opticsAutoActions = document.getElementById("optics-auto-actions");
const exposureAxisAuto = document.getElementById("exposure-axis-auto");
const isoAxisAuto = document.getElementById("iso-axis-auto");
const exposureAxisToggle = document.getElementById("exposure-axis-toggle");
const isoAxisToggle = document.getElementById("iso-axis-toggle");
const exposureAxisReset = document.getElementById("exposure-axis-reset");
const isoAxisReset = document.getElementById("iso-axis-reset");
const exposureAxisName = document.getElementById("exposure-axis-name");
const isoAxisName = document.getElementById("iso-axis-name");
const cameraExposure = document.getElementById("camera-exposure");
const cameraExposureValue = document.getElementById("camera-exposure-value");
const captureScanBtn = document.getElementById("capture-scan");
const recordCorpusBtn = document.getElementById("record-corpus");
const loadCorpusBtn = document.getElementById("load-corpus");
const receiverSettings = document.querySelector(".receiver-settings");
const receiverDevActions = document.querySelector(".receiver-dev-actions");
const mobileCameraUi = isAndroid || isIOS || navigator.userAgentData?.mobile === true;
if (mobileCameraUi && cameraDeviceControl && receiverDevActions) receiverDevActions.prepend(cameraDeviceControl);
const focusDev = document.getElementById("focus-dev");
const focusMode = document.getElementById("focus-mode");
const focusAxisName = document.getElementById("focus-axis-name");
const focusAxisReset = document.getElementById("focus-axis-reset");
const opticsOptimize = document.getElementById("optics-optimize");
const opticsKeep = document.getElementById("optics-keep");
const opticsOptimizeStatus = document.getElementById("optics-optimize-status");
const focusDistanceControl = document.getElementById("focus-distance-control");
const focusDistance = document.getElementById("focus-distance");
const focusDistanceValue = document.getElementById("focus-distance-value");
const cameraIsoControl = document.getElementById("camera-iso-control");
const cameraIso = document.getElementById("camera-iso");
const cameraIsoValue = document.getElementById("camera-iso-value");
const focusDiagnostics = document.getElementById("focus-diagnostics");
const transportDiagnostics = document.getElementById("transport-diagnostics");
const copyDiagnostics = document.getElementById("copy-diagnostics");
const focusTuningInputs = [...document.querySelectorAll("[data-camera-tuning]")];
const corpusFile = document.getElementById("corpus-file");
const benchmarkDialog = document.getElementById("benchmark-dialog");
const closeBenchmarkBtn = document.getElementById("close-benchmark");
const runBenchmarkBtn = document.getElementById("run-benchmark");
const saveBenchmarkBtn = document.getElementById("save-benchmark");
const replayMode = document.getElementById("replay-mode");
const benchmarkStatus = document.getElementById("benchmark-status");
const benchmarkSummary = document.getElementById("benchmark-summary");
const benchmarkFrame = document.getElementById("benchmark-frame");
const benchmarkFrameStatus = document.getElementById("benchmark-frame-status");
const scanDialog = document.getElementById("scan-dialog");
const closeScanBtn = document.getElementById("close-scan");
const scanDialogStatus = document.getElementById("scan-dialog-status");
const scanSightingLegend = document.getElementById("scan-sighting-legend");
const scanCapture = document.getElementById("scan-capture");
const video = document.getElementById("video");
const preview = document.getElementById("preview");
const cameraBox = document.querySelector(".preview");
const overlay = document.getElementById("detect-overlay");
const stats = document.getElementById("stats");
const progressEl = document.getElementById("progress");
const bar = document.getElementById("bar");
const progressStatus = document.getElementById("progress-status");
const progressLabel = document.getElementById("progress-label");
const transferSizeLabel = document.getElementById("transfer-size-label");
const etaLabel = document.getElementById("eta-label");
const result = document.getElementById("result");
const metricsEl = document.getElementById("metrics");
metricsEl.addEventListener("click", (event) => {
  const target = event.target;
  if (target.closest("summary") || target.closest(".receiver-settings .row")) return;
  receiverSettings.open = !receiverSettings.open;
});
const speedFeedback = document.getElementById("speed-feedback");
const pipelineMetrics = document.getElementById("pipeline-metrics");
const legacyAndroidApp = isLegacyAndroidApp();
function supportsWasmSimd() {
  try {
    return WebAssembly.validate(new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123,
      3, 2, 1, 0, 10, 8, 1, 6, 0, 65, 0, 253, 15, 11
    ]));
  } catch {
    return false;
  }
}
const usesScalarCodec = legacyAndroidApp || !supportsWasmSimd();
function createDecodeWorker() {
  const file = usesScalarCodec ? "./worker.js?scalar=1" : "./worker.js";
  return new Worker(new URL(file, import.meta.url), { type: "module" });
}
document.body.classList.toggle("legacy-android-camera", legacyAndroidApp);
const hardwareThreadCount = Math.max(1, navigator.hardwareConcurrency || 2);
const autoWorkerCount = Math.max(1, Math.min(7, hardwareThreadCount - 1));
const autoWorkerOption = decodeWorkers.querySelector('option[value="auto"]');
autoWorkerOption.textContent = `Auto (${autoWorkerCount})`;
for (let count = 1; count <= hardwareThreadCount; count++) {
  decodeWorkers.add(new Option(String(count), String(count)));
}
function selectedWorkerCount() {
  return decodeWorkers.value === "auto" ? autoWorkerCount : Math.max(1, Math.min(hardwareThreadCount, Number(decodeWorkers.value) || autoWorkerCount));
}
let strictHotPathEnabled = strictHotPathToggle.checked;
let strictHotPathLockSeen = false;
let hotPathAuditGeneration = 0;
const hotPathJobMode = new Map();
strictHotPathToggle.addEventListener("change", () => {
  strictHotPathEnabled = strictHotPathToggle.checked;
  hotPathAuditGeneration++;
  hotPathJobMode.clear();
  resetHotPathAudit();
  lastDirectPixelPath = "—";
  minimumAcceptedScanId = frameId;
  clearPendingGridLanes();
  cropAttempts.clear();
  // Plain/sighting regions are acquisition hints, never persistent Strict tracks.
  for (let i = regions.length - 1; i >= 0; i--) {
    if (regions[i].gridSlot === void 0) regions.splice(i, 1);
  }
  strictHotPathLockSeen = Boolean(gridLattice.locked);
  // Worker-local native geometry and direct pixel-mode adaptation are session state.
  // Recreate workers at this mode boundary so the audit starts from a known state.
  pool.resize(0);
  if (stream && !done) pool.resize(selectedWorkerCount());
});
function strictHotPathActive() {
  return strictHotPathEnabled || replayRunning && replayMode.value === "correctness";
}
const CAMERA_SETTINGS_KEY = "airgapper:camera-settings:v9";
const DEVICE_LABEL_KEY = "airgapper:device-label:v1";
if (deviceLabel) {
  try { deviceLabel.value = localStorage.getItem(DEVICE_LABEL_KEY) ?? ""; } catch {}
  deviceLabel.addEventListener("change", () => {
    try {
      const value = deviceLabel.value.trim().slice(0, 80);
      deviceLabel.value = value;
      if (value) localStorage.setItem(DEVICE_LABEL_KEY, value);
      else localStorage.removeItem(DEVICE_LABEL_KEY);
    } catch {}
  });
}
const BROWSER_MODE_RESULTS_KEY = "airgapper:browser-camera-modes:v1";
const CAMERA_PERFORMANCE_KEY = "airgapper:camera-performance:v1";
const STANDARD_RESOLUTIONS = [
  [640, 480],
  [960, 720],
  [1280, 720],
  [1280, 960],
  [1920, 1080],
  [2560, 1440],
  [3840, 2160]
];
let requestedWidth = 1280;
let requestedHeight = 720;
let requestedFps = 60;
const AUTO_QR_EV_BIAS = -0.7;
const AUTO_QR_LIGHT_SCALE = Math.pow(2, AUTO_QR_EV_BIAS);
let automaticOptics = true;
let automaticExposureAxis = true;
let automaticIsoAxis = true;
const AUTO_OPTICS_LOCK_SETTLE_MS = 1400;
const AUTO_OPTICS_RECENT_DECODE_MS = 900;
const AUTO_OPTICS_MIN_SETTLE_QR_PER_SECOND = 12;
const AUTO_OPTICS_SHUTTER_FRAME_FRACTION = 0.30;
// After the motion-safe shutter handoff, tune gain against the decoder itself.
// Hardware AE is inconsistent on an animated emissive QR wall: the same phone
// has chosen 10 ms / ISO 100 and 10 ms / ISO 200 on adjacent runs, while the
// latter sustained roughly 2-3x more useful throughput. Keep the shutter fixed
// for motion, then spend a short one-time window finding the useful gain.
const AUTO_OPTICS_GAIN_SETTLE_MS = 340;
const AUTO_OPTICS_GAIN_SAMPLE_MS = 520;
const AUTO_OPTICS_GAIN_MIN_ATTEMPTS = 12;
const AUTO_OPTICS_GAIN_IMPROVEMENT = 1.03;
// AirGapper is looking at an emissive black/white modem, not making a pleasing
// photograph. Prefer less light when two candidates decode essentially alike.
const AUTO_OPTICS_DARK_TIE_RATIO = 0.985;
const AUTO_OPTICS_STARTUP_HEALTHY_YIELD = 0.45;
const AUTO_OPTICS_MEMORY_MIN_YIELD = 0.35;
const AUTO_OPTICS_GAIN_MAX_PROBES = 5;
const AUTO_OPTICS_POSE_STABLE_MS = 260;
const AUTO_OPTICS_POSE_WAIT_MS = 1800;
const AUTO_OPTICS_POSE_MAX_CENTER_DRIFT = 0.035;
const AUTO_OPTICS_POSE_MAX_SCALE_LOG2 = 0.10;
// One stable tracked QR is enough to compare exposure candidates. Requiring
// multiple visible slots makes Auto Optics impossible on a true 1x1 sender.
const AUTO_OPTICS_MIN_VISIBLE_SLOTS = 1;
const AUTO_OPTICS_ACQUISITION_RESCUE_MS = 2500;
const AUTO_OPTICS_RESCUE_RETRY_MS = 12000;
const AUTO_OPTICS_ACQUIRE_SCAN_MAX_EXPOSURE = 100; // 10 ms, exposureTime is 100 us units
const AUTO_OPTICS_HISTORY_KEY = "airgapper:auto-optics-learning:v1";
const AUTO_OPTICS_HISTORY_LIMIT = 32;
const AUTO_OPTICS_HISTORY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const AUTO_OPTICS_HISTORY_BAD_COOLDOWN_MS = 5 * 60 * 1000;
const AUTO_OPTICS_MEMORY_KEY = "airgapper:auto-optics-memory:v1";
const AUTO_OPTICS_MEMORY_FRESH_MS = 12 * 60 * 60 * 1000;
const AUTO_OPTICS_MEMORY_MIN_SCALE = 0.25;
const AUTO_OPTICS_MEMORY_MAX_SCALE = 1;
const AUTO_OPTICS_MEMORY_BOOT_MAX_MS = 1600;
// A relative winner is meaningless when the whole local ISO neighborhood is
// unusable. Below this per-QR yield, abandon manual tuning and let hardware AE
// re-establish a sane exposure product before trying the motion-safe handoff.
const AUTO_OPTICS_COLLAPSE_YIELD = 0.12;
const AUTO_OPTICS_COLLAPSE_RETRY_MS = 900;
const AUTO_OPTICS_HOLD_SAMPLE_MS = 700;
const AUTO_OPTICS_HOLD_COLLAPSE_MS = 1400;
const AUTO_OPTICS_HOLD_MIN_ATTEMPTS = 40;
// Once a startup winner is found, never poke the camera periodically. Hold it
// until live per-QR yield falls far enough below that measured winner to prove
// the scene/optics changed, then recalibrate from neutral hardware AE.
const AUTO_OPTICS_HOLD_DEGRADE_RATIO = 0.70;
let autoOpticsTuneSummary = "";
let autoOpticsRuntimeState = "ae";
let autoOpticsMutationRunning = false;
let autoOpticsLockSince = 0;
let autoOpticsRetryAt = 0;
let autoOpticsAcquisitionSince = 0;
let autoOpticsRescueRetryAt = 0;
let autoOpticsHoldSample;
let autoOpticsHoldCollapseSince = 0;
let autoOpticsHeldYield = 0;
let autoOpticsAeBaseline;
let autoOpticsMemoryBootAt = 0;
let autoOpticsMemoryBoot;
// These are the user's persistent MANUAL optics profile. Automatic optics
// may use arbitrary temporary sensor values, but must never overwrite these.
let preferredExposureTime;
let manualFocusMode = "camera-auto";
let preferredFocusDistance;
let preferredIso;
let exposureApplyGeneration = 0;
let manualOpticsReapplyGeneration = 0;
let manualOpticsCheckAt = 0;
let manualOpticsRepairRunning = false;
let cameraMutationQueue = Promise.resolve();
let desiredCamera = {};
let lastCameraMutation;
function mutateCamera(track, mutation) {
  const operation = cameraMutationQueue.catch(() => void 0).then(async () => {
    if (track.readyState === "live" && (stream == null ? void 0 : stream.getVideoTracks()[0]) === track) await mutation();
  });
  cameraMutationQueue = operation.catch(() => void 0);
  return operation;
}
function sanitizedTrackFocusDistance(track, value) {
  var _a, _b;
  const range = (_b = (_a = track.getCapabilities) == null ? void 0 : _a.call(track)) == null ? void 0 : _b.focusDistance;
  return value !== void 0 && Number.isFinite(value) && value >= 0 && value <= 1e3 && Boolean(range && Number.isFinite(range.min) && Number.isFinite(range.max) && value >= range.min && value <= range.max) ? value : void 0;
}
function seedDesiredCamera(track) {
  if (cameraQuirkTrackId !== track.id) {
    cameraQuirkTrackId = track.id;
    manualExposureFocusPolicy = "unknown";
    manualSensorSessionActive = false;
    heldFocusRestoreMode = void 0;
    cameraFocusWritesTotal = 0;
    cameraExposureWritesTotal = 0;
  }
  const settings = track.getSettings();
  desiredCamera = {
    focusMode: settings.focusMode,
    focusDistance: sanitizedTrackFocusDistance(track, settings.focusDistance),
    exposureMode: settings.exposureMode,
    exposureTime: settings.exposureTime,
    iso: settings.iso,
    exposureCompensation: settings.exposureCompensation
  };
}
let manualExposureFocusPolicy = "unknown";
let manualSensorSessionActive = false;
let cameraQuirkTrackId = "";
let heldFocusRestoreMode;
let cameraFocusWritesTotal = 0;
let cameraExposureWritesTotal = 0;
function applyCameraConstraint(track, patch) {
  let accepted = true;
  const touchesFocus = patch.focusMode !== void 0 || patch.focusDistance !== void 0 || patch.pointsOfInterest !== void 0;
  const touchesExposure = patch.exposureMode !== void 0 || patch.exposureTime !== void 0 || patch.iso !== void 0 || patch.exposureCompensation !== void 0;
  if (patch.focusMode !== void 0 && patch.focusMode !== "manual") delete desiredCamera.focusDistance;
  if (patch.exposureMode === "continuous") {
    delete desiredCamera.exposureTime;
    delete desiredCamera.iso;
    if (patch.exposureCompensation === void 0) delete desiredCamera.exposureCompensation;
  }
  if (patch.exposureMode === "manual") delete desiredCamera.exposureCompensation;
  Object.assign(desiredCamera, patch);
  return mutateCamera(track, async () => {
    var _a, _b;
    const before = track.getSettings();
    const caps = (_a = track.getCapabilities) == null ? void 0 : _a.call(track);
    const applyStage = async (stage) => {
      if (!Object.keys(stage).length) return true;
      const focusStage = stage.focusMode !== void 0 || stage.focusDistance !== void 0 || stage.pointsOfInterest !== void 0;
      const exposureStage = stage.exposureMode !== void 0 || stage.exposureTime !== void 0 || stage.iso !== void 0 || stage.exposureCompensation !== void 0;
      if (focusStage) cameraFocusWritesTotal++;
      if (exposureStage) cameraExposureWritesTotal++;
      let ok = false;
      if (focusStage && !exposureStage && stage.focusMode !== void 0) {
        // A bare member inside advanced[] is best-effort and may be ignored while
        // applyConstraints() still resolves. Make focusMode mandatory. Keep POI
        // as the simple Point2D sequence because Chromium supports that form.
        const constraints = { focusMode: { exact: stage.focusMode } };
        if (stage.pointsOfInterest !== void 0) constraints.pointsOfInterest = stage.pointsOfInterest;
        try {
          await track.applyConstraints(constraints);
          ok = true;
        } catch {
          ok = false;
        }
      } else {
        ok = await applyAdvancedConstraint(track, stage);
      }
      accepted && (accepted = ok);
      return ok;
    };
    const numericClose = (actual, requested, step) => {
      if (requested === void 0) return true;
      if (actual === void 0 || !Number.isFinite(actual)) return false;
      const tolerance = Math.max((step != null ? step : 0) * 0.75, Math.abs(requested) * 0.02, 1e-6);
      return Math.abs(actual - requested) <= tolerance;
    };
    const requestedExposureMatches = () => {
      var _a2, _b2;
      const actual = track.getSettings();
      return numericClose(actual.exposureTime, desiredCamera.exposureTime, (_a2 = caps.exposureTime) == null ? void 0 : _a2.step) && numericClose(actual.iso, desiredCamera.iso, (_b2 = caps.iso) == null ? void 0 : _b2.step);
    };
    const numericExposureChangedFrom = (prior) => {
      const actual = track.getSettings();
      const exposureChanged = desiredCamera.exposureTime === void 0 || actual.exposureTime !== void 0 && prior.exposureTime !== actual.exposureTime;
      const isoChanged = desiredCamera.iso === void 0 || actual.iso !== void 0 && prior.iso !== actual.iso;
      return exposureChanged || isoChanged;
    };
    const shortSettle = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));
    if (touchesFocus && !touchesExposure) {
      if (patch.focusMode === "manual") {
        await applyStage({ focusMode: "manual" });
        if (patch.focusDistance !== void 0) await applyStage({ focusDistance: patch.focusDistance });
      } else if (patch.focusMode !== void 0) {
        await applyStage({
          focusMode: patch.focusMode,
          ...(patch.pointsOfInterest !== void 0 ? { pointsOfInterest: patch.pointsOfInterest } : {})
        });
      } else if (patch.pointsOfInterest !== void 0) {
        await applyStage({ pointsOfInterest: patch.pointsOfInterest });
      }
    }
    if (touchesExposure) {
      const requestedMode = (_b = patch.exposureMode) != null ? _b : desiredCamera.exposureMode;
      if (requestedMode === "continuous") {
        manualSensorSessionActive = false;
        const stage = { exposureMode: "continuous" };
        if (patch.exposureCompensation !== void 0) stage.exposureCompensation = patch.exposureCompensation;
        await applyStage(stage);
      } else if (requestedMode === "manual") {
        let current = track.getSettings();
        if (manualExposureFocusPolicy === "requires-hold" && current.focusMode !== "manual") {
          heldFocusRestoreMode = current.focusMode && current.focusMode !== "manual" ? current.focusMode : heldFocusRestoreMode;
          await applyStage({ focusMode: "manual" });
          await shortSettle(80);
          current = track.getSettings();
        }
        if (!manualSensorSessionActive) await applyStage({ exposureMode: "manual" });
        const sensor = {};
        if (desiredCamera.exposureTime !== void 0) sensor.exposureTime = desiredCamera.exposureTime;
        if (desiredCamera.iso !== void 0) sensor.iso = desiredCamera.iso;
        const beforeSensor = track.getSettings();
        await applyStage(sensor);
        if (manualExposureFocusPolicy === "unknown") {
          if (requestedExposureMatches() || numericExposureChangedFrom(beforeSensor)) {
            manualExposureFocusPolicy = "independent";
            manualSensorSessionActive = true;
          } else {
            await shortSettle(180);
            if (!requestedExposureMatches() && !numericExposureChangedFrom(beforeSensor)) {
              await applyStage(sensor);
              await shortSettle(180);
            }
            if (requestedExposureMatches() || numericExposureChangedFrom(beforeSensor)) {
              manualExposureFocusPolicy = "independent";
              manualSensorSessionActive = true;
            } else {
              const beforeHold = track.getSettings();
              const canHold = beforeHold.focusMode !== "manual" && (Array.isArray(caps.focusMode) ? caps.focusMode.includes("manual") : false);
              if (canHold) {
                heldFocusRestoreMode = beforeHold.focusMode && beforeHold.focusMode !== "manual" ? beforeHold.focusMode : void 0;
                await applyStage({ focusMode: "manual" });
                await shortSettle(100);
                const holdSensorBefore = track.getSettings();
                await applyStage(sensor);
                await shortSettle(160);
                if (requestedExposureMatches() || numericExposureChangedFrom(holdSensorBefore)) {
                  manualExposureFocusPolicy = "requires-hold";
                  manualSensorSessionActive = true;
                } else {
                  if (heldFocusRestoreMode) await applyStage({ focusMode: heldFocusRestoreMode });
                  heldFocusRestoreMode = void 0;
                  manualExposureFocusPolicy = "independent";
                  manualSensorSessionActive = true;
                }
              } else {
                manualExposureFocusPolicy = "independent";
                manualSensorSessionActive = true;
              }
            }
          }
        } else {
          manualSensorSessionActive = true;
        }
      } else {
        const stage = {};
        if (patch.exposureCompensation !== void 0) stage.exposureCompensation = patch.exposureCompensation;
        if (patch.exposureTime !== void 0) stage.exposureTime = patch.exposureTime;
        if (patch.iso !== void 0) stage.iso = patch.iso;
        await applyStage(stage);
      }
    }
    if (touchesFocus && touchesExposure && patch.focusMode !== void 0) {
      if (patch.focusMode === "manual") {
        await applyStage({ focusMode: "manual" });
        if (patch.focusDistance !== void 0) await applyStage({ focusDistance: patch.focusDistance });
      } else {
        await applyStage({ focusMode: patch.focusMode });
      }
    }
    const after = track.getSettings();
    const kind = touchesFocus && touchesExposure ? "focus + exposure" : touchesFocus ? "focus" : "exposure";
    const optics = (value) => ({
      focusMode: value.focusMode,
      focusDistance: sanitizedTrackFocusDistance(track, value.focusDistance),
      exposureMode: value.exposureMode,
      exposureTime: value.exposureTime,
      iso: value.iso,
      exposureCompensation: value.exposureCompensation
    });
    lastCameraMutation = { kind, before: optics(before), requested: { ...patch }, after: optics(after) };
  }).then(() => accepted);
}
let exposureApplyTimer;
function formatCameraSize(width, height) {
  return `${Math.max(width, height)}×${Math.min(width, height)}`;
}
function formatCameraMode(width, height, fps) {
  return `${formatCameraSize(width, height)} · ${fps} fps`;
}
const browserModeResults = loadBrowserModeResults();
let browserModes = [];
let automaticBrowserMode;
let preferredCameraDeviceId = "";
let automaticCameraDeviceId = "";
let automaticCameraUpgradeAttempted = false;
let cameraPerformanceSaveAt = 0;
function loadCameraPerformance() {
  try {
    return JSON.parse(localStorage.getItem(CAMERA_PERFORMANCE_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}
const cameraPerformance = loadCameraPerformance();
function saveCameraPerformance() {
  try {
    localStorage.setItem(CAMERA_PERFORMANCE_KEY, JSON.stringify(cameraPerformance));
  } catch {}
}
function learnedAutomaticCameraId() {
  let bestId = "";
  let best = -1;
  for (const [id, record] of Object.entries(cameraPerformance)) {
    const goodput = Math.max(Number(record?.bestGoodputKbs) || 0, Number(record?.lastGoodputKbs) || 0);
    if (goodput > best) {
      best = goodput;
      bestId = id;
    }
  }
  return bestId;
}
function inputDeviceCapabilities(device) {
  try {
    return device?.getCapabilities?.() ?? {};
  } catch {
    return {};
  }
}
function cameraFacingHint(device, caps) {
  const modes = Array.isArray(caps?.facingMode) ? caps.facingMode : caps?.facingMode ? [caps.facingMode] : [];
  const label = String(device?.label ?? "").toLowerCase();
  if (modes.includes("environment") || /back|rear|environment/.test(label)) return "rear";
  if (modes.includes("user") || /front|user|selfie/.test(label)) return "front";
  return "unknown";
}
function automaticCameraScore(device, index) {
  const caps = inputDeviceCapabilities(device);
  const record = cameraPerformance[device.deviceId] ?? {};
  const width = Number(caps?.width?.max) || Number(record.maxWidth) || 0;
  const height = Number(caps?.height?.max) || Number(record.maxHeight) || 0;
  const area = width * height;
  const fps = Number(caps?.frameRate?.max) || Number(record.maxFps) || 0;
  const goodput = Math.max(Number(record.bestGoodputKbs) || 0, Number(record.lastGoodputKbs) || 0);
  const focusModes = Array.isArray(caps?.focusMode) ? caps.focusMode : [];
  const af = focusModes.includes("continuous") ? 1 : 0;
  const mainHint = /camera\s*0(?:\D|$)|main/.test(String(device.label ?? "").toLowerCase()) ? 1 : 0;
  // Sensor/video resolution dominates first-use selection. Measured AirGapper
  // throughput is strong enough to separate cameras exposing similar modes.
  return area + fps * 10000 + goodput * 1000 + af * 50000 + mainHint * 1000 - index;
}
function bestAutomaticCameraDevice(devices) {
  if (!devices.length) return undefined;
  const tagged = devices.map((device, index) => ({ device, index, caps: inputDeviceCapabilities(device) }));
  const rear = tagged.filter(({ device, caps }) => cameraFacingHint(device, caps) === "rear");
  const candidates = rear.length ? rear : tagged.filter(({ device, caps }) => cameraFacingHint(device, caps) !== "front");
  const pool = candidates.length ? candidates : tagged;
  return pool.reduce((best, candidate) =>
    !best || automaticCameraScore(candidate.device, candidate.index) > automaticCameraScore(best.device, best.index)
      ? candidate : best, undefined)?.device;
}
function noteCameraPerformance(goodputKbs, uniqueRate, runSeconds) {
  if (runSeconds < 3 || goodputKbs <= 0 || performance.now() < cameraPerformanceSaveAt) return;
  const track = stream?.getVideoTracks?.()[0];
  const settings = track?.getSettings?.();
  const id = String(settings?.deviceId ?? "");
  if (!id) return;
  cameraPerformanceSaveAt = performance.now() + 2000;
  const record = cameraPerformance[id] ?? {};
  record.bestGoodputKbs = Math.max(Number(record.bestGoodputKbs) || 0, goodputKbs);
  record.lastGoodputKbs = goodputKbs;
  record.bestUniqueQrPerSecond = Math.max(Number(record.bestUniqueQrPerSecond) || 0, uniqueRate);
  record.maxWidth = Math.max(Number(record.maxWidth) || 0, Number(settings.width) || 0);
  record.maxHeight = Math.max(Number(record.maxHeight) || 0, Number(settings.height) || 0);
  record.maxFps = Math.max(Number(record.maxFps) || 0, Number(settings.frameRate) || 0);
  record.updatedAt = Date.now();
  cameraPerformance[id] = record;
  saveCameraPerformance();
}
function loadBrowserModeResults() {
  var _a;
  try {
    return JSON.parse((_a = localStorage.getItem(BROWSER_MODE_RESULTS_KEY)) != null ? _a : "{}");
  } catch {
    return {};
  }
}
function saveBrowserModeResult(key, supported) {
  browserModeResults[key] = supported;
  try {
    localStorage.setItem(BROWSER_MODE_RESULTS_KEY, JSON.stringify(browserModeResults));
  } catch {
  }
}
function standardBrowserModes() {
  return STANDARD_RESOLUTIONS.flatMap(([width, height]) => [30, 60].map((fps) => ({
    key: `${width}x${height}@${fps}`,
    width,
    height,
    fps,
    label: formatCameraMode(width, height, fps)
  }))).sort((a, b) => a.width - b.width || a.height - b.height || a.fps - b.fps);
}
function browserModeSuffix(key) {
  return browserModeResults[key] === true ? "" : browserModeResults[key] === false ? " · Retry" : " · Try";
}
function populateCameraOptions() {
  browserModes = standardBrowserModes();
  cameraResolution.replaceChildren(
    new Option("Auto", "auto"),
    ...browserModes.map((mode) => new Option(`${mode.label}${browserModeSuffix(mode.key)}`, mode.key))
  );
  cameraResolution.value = "auto";
}
function restoreCameraSettings() {
  var _a, _b;
  try {
    const saved = JSON.parse((_a = localStorage.getItem(CAMERA_SETTINGS_KEY)) != null ? _a : "null");
    if (!saved) return;
    if (typeof saved.deviceId === "string") preferredCameraDeviceId = saved.deviceId;
    if (saved.resolution && [...cameraResolution.options].some((option) => option.value === saved.resolution)) {
      cameraResolution.value = saved.resolution;
    }
    if (typeof saved.automaticOptics === "boolean") automaticOptics = saved.automaticOptics;
    if (typeof saved.automaticExposureAxis === "boolean") automaticExposureAxis = saved.automaticExposureAxis;
    if (typeof saved.automaticIsoAxis === "boolean") automaticIsoAxis = saved.automaticIsoAxis;
    if (typeof saved.exposureTime === "number" && Number.isFinite(saved.exposureTime)) preferredExposureTime = saved.exposureTime;
    if (saved.workers && [...decodeWorkers.options].some((option) => option.value === saved.workers)) decodeWorkers.value = saved.workers;
    if (["camera-auto", "single-shot", "manual"].includes((_b = saved.manualFocusMode) != null ? _b : "")) manualFocusMode = saved.manualFocusMode;
    if (typeof saved.focusDistance === "number" && Number.isFinite(saved.focusDistance)) preferredFocusDistance = saved.focusDistance;
    if (typeof saved.iso === "number" && Number.isFinite(saved.iso)) preferredIso = saved.iso;
  } catch {
  }
}
function saveCameraSettings() {
  try {
    localStorage.setItem(CAMERA_SETTINGS_KEY, JSON.stringify({
      deviceId: preferredCameraDeviceId,
      resolution: cameraResolution.value,
      automaticOptics,
      automaticExposureAxis,
      automaticIsoAxis,
      exposureTime: preferredExposureTime,
      workers: decodeWorkers.value,
      manualFocusMode,
      focusDistance: preferredFocusDistance,
      iso: preferredIso
    }));
  } catch {
  }
}
async function refreshCameraDevices(activeTrack) {
  if (!cameraDevice || !navigator.mediaDevices?.enumerateDevices) return;
  let devices = [];
  try {
    devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "videoinput");
  } catch {
    return;
  }
  const activeId = activeTrack?.getSettings?.().deviceId ?? "";
  const options = [new Option(mobileCameraUi ? "Rear camera (auto)" : "Default camera", "")];
  devices.forEach((device, index) => options.push(new Option(device.label || `Camera ${index + 1}`, device.deviceId)));
  cameraDevice.replaceChildren(...options);
  const preferredExists = preferredCameraDeviceId && devices.some((device) => device.deviceId === preferredCameraDeviceId);
  const activeExists = activeId && devices.some((device) => device.deviceId === activeId);
  if (preferredExists) {
    cameraDevice.value = preferredCameraDeviceId;
  } else if (mobileCameraUi) {
    preferredCameraDeviceId = "";
    const best = bestAutomaticCameraDevice(devices);
    automaticCameraDeviceId = best?.deviceId || learnedAutomaticCameraId() || "";
    cameraDevice.value = activeExists ? activeId : "";
    // Permission makes labels/capabilities materially richer than they are on
    // the pre-permission call. If Chrome initially handed us a weaker rear
    // camera, reopen once with the newly-ranked sensor. Never loop/reprobe.
    if (activeId && automaticCameraDeviceId && activeId !== automaticCameraDeviceId &&
        !automaticCameraUpgradeAttempted && stream && !done) {
      automaticCameraUpgradeAttempted = true;
      setTimeout(() => {
        if (!stream || done || preferredCameraDeviceId) return;
        stopReceiver();
        void start();
      }, 0);
    }
  } else if (activeExists) {
    preferredCameraDeviceId = activeId;
    cameraDevice.value = activeId;
    saveCameraSettings();
  } else {
    preferredCameraDeviceId = "";
    cameraDevice.value = "";
  }
  cameraDevice.disabled = devices.length <= 1;
}
function cameraDeviceConstraint() {
  if (preferredCameraDeviceId) return { deviceId: { exact: preferredCameraDeviceId } };
  if (mobileCameraUi) {
    const learned = automaticCameraDeviceId || learnedAutomaticCameraId();
    if (learned) return { deviceId: { ideal: learned }, facingMode: { ideal: "environment" } };
    return { facingMode: "environment" };
  }
  return {};
}
function readRequestedCameraSettings() {
  const browserMode = browserModes.find((mode) => mode.key === cameraResolution.value);
  if (!browserMode) return;
  requestedWidth = browserMode.width;
  requestedHeight = browserMode.height;
  requestedFps = browserMode.fps;
}
function showRequestedCameraSettings() {
  readRequestedCameraSettings();
  cameraActual.textContent = cameraResolution.value === "auto" ? "Auto" : formatCameraMode(requestedWidth, requestedHeight, requestedFps);
  cameraResolutionLabel.textContent = "Mode";
  captureScanBtn.hidden = false;
  decodeWorkersControl.hidden = legacyAndroidApp;
  video.hidden = false;
  cameraBox.style.aspectRatio = `${requestedWidth} / ${requestedHeight}`;
}
populateCameraOptions();
restoreCameraSettings();
showRequestedCameraSettings();
let frameId = 0;
const focusController = new FocusController(
  applyCameraConstraint,
  renderFocusDiagnostics,
  "auto",
  preferredFocusDistance,
  "auto",
  () => frameId
);
const opticsAnalyzer = new StaticQrOpticsAnalyzer();
function attachCameraController(track) {
  focusController.attach(track);
  if (automaticOptics) void primeAutomaticQrOpticsStartup(track);
  // Manual sensor settings are applied explicitly before camera playback and
  // verified after fresh frames arrive. Do not write them again merely because
  // the focus/controller UI attached; duplicate constraint writes can restart
  // Android camera delivery and hold decoding during acquisition.
}
async function reapplyManualOpticsAfterFreshFrames(track, reason) {
  const generation = ++manualOpticsReapplyGeneration;
  if (!track || automaticOptics) return;
  const firstSequence = latestSourceFrameSequence;
  const startedAt = performance.now();
  while (generation === manualOpticsReapplyGeneration && !automaticOptics &&
      stream?.getVideoTracks()[0] === track && track.readyState === "live" &&
      (latestSourceFrameSequence - firstSequence < 1 || frameModeSync) &&
      performance.now() - startedAt < 450) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (generation !== manualOpticsReapplyGeneration || automaticOptics ||
      stream?.getVideoTracks()[0] !== track || track.readyState !== "live") return;

  // Mode/camera renegotiation can silently put the sensor back in continuous
  // exposure after our immediate attach-time write. Force a fresh manual-mode
  // transaction once the new frame stream is real, then verify the axes the
  // user actually pinned.
  manualSensorSessionActive = false;
  await applyExposureSetting(track);
  if (generation !== manualOpticsReapplyGeneration || automaticOptics ||
      stream?.getVideoTracks()[0] !== track || track.readyState !== "live") return;

  const appliedSequence = latestSourceFrameSequence;
  const settleStartedAt = performance.now();
  while (generation === manualOpticsReapplyGeneration &&
      latestSourceFrameSequence - appliedSequence < 2 && performance.now() - settleStartedAt < 400) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (generation !== manualOpticsReapplyGeneration || automaticOptics ||
      stream?.getVideoTracks()[0] !== track || track.readyState !== "live") return;

  const actual = track.getSettings();
  const caps = track.getCapabilities?.();
  const close = (value, target, step) => {
    if (target === undefined) return true;
    if (!Number.isFinite(value)) return false;
    const tolerance = Math.max((step ?? 0) * 0.75, Math.abs(target) * 0.02, 1e-6);
    return Math.abs(value - target) <= tolerance;
  };
  const exposureWrong = !automaticExposureAxis && preferredExposureTime !== undefined &&
    !close(actual.exposureTime, preferredExposureTime, caps?.exposureTime?.step);
  const isoWrong = !automaticIsoAxis && preferredIso !== undefined &&
    !close(actual.iso, preferredIso, caps?.iso?.step);
  if (exposureWrong || isoWrong) {
    manualSensorSessionActive = false;
    await applyExposureSetting(track);
    if (generation !== manualOpticsReapplyGeneration || automaticOptics ||
        stream?.getVideoTracks()[0] !== track || track.readyState !== "live") return;
    notePipelineEvent("manual-optics-reapplied", 2);
  } else {
    notePipelineEvent("manual-optics-reapplied", 1);
  }
  lastRecoveryReason = `${reason}; manual optics restored`;
}
function manualOpticsNeedsRepair(track) {
  if (automaticOptics || automaticExposureAxis && automaticIsoAxis) return false;
  const actual = track.getSettings();
  const caps = track.getCapabilities?.() ?? {};
  const close = (value, target, step) => {
    if (target === undefined) return true;
    if (!Number.isFinite(value)) return false;
    const tolerance = Math.max((step ?? 0) * 0.75, Math.abs(target) * 0.02, 1e-6);
    return Math.abs(value - target) <= tolerance;
  };
  return !automaticExposureAxis && preferredExposureTime !== undefined &&
      !close(actual.exposureTime, preferredExposureTime, caps.exposureTime?.step) ||
    !automaticIsoAxis && preferredIso !== undefined &&
      !close(actual.iso, preferredIso, caps.iso?.step);
}
async function maintainManualOptics(now) {
  if (automaticOptics || replayRunning || optimizerPipelineActive || optimizeRunning ||
      manualOpticsRepairRunning || now < manualOpticsCheckAt) return;
  const track = stream?.getVideoTracks()[0];
  if (!track || track.readyState !== "live") return;
  manualOpticsCheckAt = now + 500;
  if (!manualOpticsNeedsRepair(track)) return;
  manualOpticsRepairRunning = true;
  manualOpticsCheckAt = now + 1200;
  manualSensorSessionActive = false;
  try {
    await applyExposureSetting(track);
    notePipelineEvent("manual-optics-watchdog");
    lastRecoveryReason = "manual optics drift corrected";
  } finally {
    manualOpticsRepairRunning = false;
  }
}
focusMode.value = manualFocusMode;
const DEV_SETTINGS_TOGGLE_WINDOW_MS = 500;
const settingsToggleTimes = [];
let previousSettingsToggleAt = 0;
receiverSettings.addEventListener("toggle", () => {
  const now = performance.now();
  const slowToggle = previousSettingsToggleAt > 0 && now - previousSettingsToggleAt > DEV_SETTINGS_TOGGLE_WINDOW_MS;
  previousSettingsToggleAt = now;
  if (!receiverDevActions.hidden) {
    if (!receiverSettings.open || !slowToggle) return;
    receiverDevActions.hidden = true;
    settingsToggleTimes.length = 0;
  }
  settingsToggleTimes.push(now);
  while (settingsToggleTimes.length && settingsToggleTimes[0] < now - DEV_SETTINGS_TOGGLE_WINDOW_MS) settingsToggleTimes.shift();
  if (receiverSettings.open && settingsToggleTimes.length >= 3) receiverDevActions.hidden = false;
});
const metric = (id) => document.getElementById(id);
let replayClock;
function receiverNow() {
  return replayClock != null ? replayClock : performance.now();
}
let activeBenchmarkFrame;
let benchmarkCorpus;
// Fast regression can optionally supply tightly packed I420 frames so replay
// enters the same VideoFrame -> Y8 receiver path as a TrackProcessor camera.
// Normal recorded .agcap replay remains lossless RGBA and is unchanged.
let fastRegressionCameraFrames;
let benchmarkPendingBlob;
let benchmarkRecorder;
let benchmarkRecordingSequence = 0;
let benchmarkTraces = [];
const benchmarkJobFrames = /* @__PURE__ */ new Map();
let benchmarkResult;
let benchmarkVerifiedBytes = 0;
let benchmarkCompletionChecked = false;
let replayRunning = false;
let receiverFrameWidth = 0;
let receiverFrameHeight = 0;
let lastVideoFrameInfo;
function noteGridTransition(from, to, reason, at) {
  const trace = activeBenchmarkFrame != null ? activeBenchmarkFrame : benchmarkTraces.at(-1);
  trace == null ? void 0 : trace.transitions.push({ from, to, reason, at });
}
const STATS_WINDOW_MS = 1e3;
const STATS_TICK_MS = 250;
let stream = null;
let decoder = null;
function releaseTransportDecoder() {
  decoder == null ? void 0 : decoder.free();
  decoder = null;
}
let streamKey = "";
let startTs = 0;
let captureGen = 0;
let cameraStartGen = 0;
let receiverPaused = false;
let pauseStartedAt = 0;
let done = false;
let transferFinalizing = false;
let statsTimer;
const plainQrDecoder = new TextDecoder("utf-8", { fatal: true });
const plainQrPolicy = new PlainQrPolicy();
const RECEIVED_MEDIA_CACHE = "received-media";
const receivedObjectUrls = /* @__PURE__ */ new Set();
let receivedDataGeneration = 0;
function receivedObjectUrl(blob) {
  const url = URL.createObjectURL(blob);
  receivedObjectUrls.add(url);
  return url;
}
function purgeReceivedData() {
  receivedDataGeneration++;
  for (const url of receivedObjectUrls) URL.revokeObjectURL(url);
  receivedObjectUrls.clear();
  if ("caches" in window) void caches.delete(RECEIVED_MEDIA_CACHE).catch(() => void 0);
}
purgeReceivedData();
const pendingGridLanes = [null, null, null];
const lockedLaneCrops = [null, null, null];
let laneCropRecentersTotal = 0;
function discardPendingGridLane(groupIndex) {
  const pending = pendingGridLanes[groupIndex];
  if (!pending) return;
  pending.direct.frame.close();
  pendingGridLanes[groupIndex] = null;
}
function clearLockedLaneCrops() {
  lockedLaneCrops.fill(null);
  laneCropRecentersTotal = 0;
}
function clearPendingGridLanes() {
  for (let index = 0; index < pendingGridLanes.length; index++) discardPendingGridLane(index);
  clearLockedLaneCrops();
  latestRepeatSignature = undefined;
}
function stableLockedLaneCrop(groupIndex, key, laneCount, vw, vh, minX, minY, maxX, maxY, typicalEdge) {
  const cropQuantum = 16;
  const guard = Math.max(8, Math.round(typicalEdge * 0.06));
  const pad = Math.max(16, Math.round(typicalEdge * 0.24));
  const current = lockedLaneCrops[groupIndex];
  if (current && current.key === key && current.laneCount === laneCount && current.vw === vw && current.vh === vh) {
    const leftGuard = current.x === 0 ? 0 : guard;
    const topGuard = current.y === 0 ? 0 : guard;
    const rightGuard = current.x + current.w === vw ? 0 : guard;
    const bottomGuard = current.y + current.h === vh ? 0 : guard;
    if (
      minX >= current.x + leftGuard && minY >= current.y + topGuard &&
      maxX <= current.x + current.w - rightGuard &&
      maxY <= current.y + current.h - bottomGuard
    ) return current;
  }
  const x = Math.max(0, Math.floor((minX - pad) / cropQuantum) * cropQuantum);
  const y = Math.max(0, Math.floor((minY - pad) / cropQuantum) * cropQuantum);
  const right = Math.min(vw, Math.ceil((maxX + pad) / cropQuantum) * cropQuantum);
  const bottom = Math.min(vh, Math.ceil((maxY + pad) / cropQuantum) * cropQuantum);
  const next = { key, laneCount, vw, vh, x, y, w: right - x, h: bottom - y };
  if (!current || current.x !== next.x || current.y !== next.y || current.w !== next.w || current.h !== next.h || current.key !== key)
    laneCropRecentersTotal++;
  lockedLaneCrops[groupIndex] = next;
  return next;
}
function queuePendingGridLane(groupIndex, source, geometry) {
  const direct = mappedDirectTrackedFrame(source, geometry.x, geometry.y, geometry.w, geometry.h, geometry.tracks);
  if (!direct) return false;
  if (pendingGridLanes[groupIndex]) pendingLaneReplaceTimes.push(receiverNow());
  discardPendingGridLane(groupIndex);
  pendingGridLanes[groupIndex] = { ...geometry, direct };
  return true;
}
function drainPendingGridLane(workerSlot) {
  let groupIndex = -1;
  for (let index = 0; index < pendingGridLanes.length; index++) {
    const candidate = pendingGridLanes[index];
    if (candidate && workerSlot % (candidate.laneCount || pendingGridLanes.length) === index) {
      groupIndex = index;
      break;
    }
  }
  if (groupIndex < 0) return;
  const pending = pendingGridLanes[groupIndex];
  pendingGridLanes[groupIndex] = null;
  const id = frameId++;
  const message = {
    id,
    videoFrame: pending.direct.frame,
    cropX: pending.direct.cropX,
    cropY: pending.direct.cropY,
    w: pending.direct.w,
    h: pending.direct.h,
    ox: pending.direct.ox,
    oy: pending.direct.oy,
    full: false,
    tracks: pending.direct.tracks,
    pixelFormat: pending.direct.pixelFormat,
    outputMap: pending.direct.outputMap,
    strictHotPath: pending.strictHotPath
  };
  const accepted = submitReceiverJob(
    message,
    [pending.direct.frame],
    pending.direct.pixelFormat === "y8" ? "Y8 TRACKED GRID" : "DIRECT TRACKED GRID",
    void 0,
    pending.sourceSequence,
    pending.regions,
    0,
    void 0,
    workerSlot
  );
  if (accepted) cropAttempts.set(id, pending.regions.map((region) => ({ region, quad: region.quad })));
  else pending.direct.frame.close();
}
let latestRepeatSignature;
const repeatSkipTimes = [];
const pool = new DecodeWorkerPool(
  createDecodeWorker,
  (bytes, box, info) => onDecoded(bytes, box, info),
  // A sighting is a detected-but-undecoded code: no bytes, but a position.
  // Heavily gated in noteRegion (refresh-only on matches, size-checked on
  // creation) because failed quads are often junk — but a plausible one lets
  // the crop path go decode what the full frame could not.
  (sighting) => {
    if (!gridLattice.active) noteRegion(sighting, receiverNow(), false);
  },
  () => void 0,
  (id, completion) => noteDecodeCompleted(id, completion),
  (slot) => drainPendingGridLane(slot),
  ({ sourceSequence, signature }) => {
    const sequence = Number(sourceSequence);
    if (!Number.isFinite(sequence) || !signature) return;
    if (!latestRepeatSignature || sequence > latestRepeatSignature.sourceSequence) {
      latestRepeatSignature = { sourceSequence: sequence, signature };
    }
  }
);
const captureTimes = [];
const qrReadTimes = [];
const uniqueQrTimes = [];
const duplicateQrTimes = [];
const sourceSequencesByEsi = new Map();
const duplicateSourceDelta = { same: 0, one: 0, two: 0, later: 0, unknown: 0 };
function resetDuplicateAttribution() {
  sourceSequencesByEsi.clear();
  duplicateSourceDelta.same = 0;
  duplicateSourceDelta.one = 0;
  duplicateSourceDelta.two = 0;
  duplicateSourceDelta.later = 0;
  duplicateSourceDelta.unknown = 0;
}
function noteDuplicateAttribution(esi, sourceSequence, duplicate) {
  const sequence = Number(sourceSequence);
  const prior = sourceSequencesByEsi.get(esi) ?? [];
  if (duplicate) {
    if (!Number.isFinite(sequence) || !prior.length) {
      duplicateSourceDelta.unknown++;
    } else {
      const delta = prior.reduce((best, item) => Math.min(best, Math.abs(sequence - item)), Infinity);
      if (delta === 0) duplicateSourceDelta.same++;
      else if (delta === 1) duplicateSourceDelta.one++;
      else if (delta === 2) duplicateSourceDelta.two++;
      else duplicateSourceDelta.later++;
    }
  }
  if (Number.isFinite(sequence) && !prior.includes(sequence)) {
    prior.push(sequence);
    if (prior.length > 6) prior.shift();
    sourceSequencesByEsi.set(esi, prior);
  }
}
function duplicateSourceDeltaSummary() {
  const d = duplicateSourceDelta;
  return `Duplicate source Δ same ${d.same} · +1 ${d.one} · +2 ${d.two} · 3+ ${d.later} · unknown ${d.unknown}`;
}
const poolBusyTimes = [];
const scanCompletionTimes = [];
const decodeFrameTimes = [];
const hotJobSubmitSamples = [];
const hotJobCompletionSamples = [];
const workerLoadSamples = [];
const pendingLaneReplaceTimes = [];
let lastDecodeSubmittedSourceSequence = -1;
const usefulFrameTimes = [];
const GUIDED_MIN_TRACKS = 2;
const GUIDED_ROBUST_SCOUT_EVERY = 30;
const GUIDED_ROBUST_SCOUT_BAD_EVERY = 4;
const guidedRollout = {
  state: "active",
  inFlight: 0,
  failures: 0,
  badStreak: 0,
  jobsSinceRobust: 0,
  robustLatencies: []
};
function resetGuidedRollout() {
  guidedRollout.state = "active";
  guidedRollout.inFlight = 0;
  guidedRollout.failures = 0;
  guidedRollout.badStreak = 0;
  guidedRollout.jobsSinceRobust = 0;
  guidedRollout.robustLatencies.length = 0;
}
function guidedBaselineP50() {
  return livePercentile(guidedRollout.robustLatencies, 0.5);
}
function chooseGuidedStage(message) {
  if (message.full || message.strictHotPath || message.pixelFormat !== "y8" || !Array.isArray(message.tracks) || message.tracks.length < GUIDED_MIN_TRACKS)
    return "";

  // On the OP12R production trace, guided decoded 326 symbols in 56 jobs while
  // consuming only ~3.3 worker-seconds; dense robust consumed ~100 worker-
  // seconds. Guided is the production decoder now, not a speculative rollout.
  // Keep one occasional dense scout for independent recovery/evidence, and
  // increase that scout cadence only after several zero-output guided frames.
  const robustInFlight = pool.activeJobs.reduce((count, job) => {
    if (job.id === void 0) return count;
    const mode = hotPathJobMode.get(job.id);
    return count + Number(mode && !mode.full && !mode.guided);
  }, 0);
  const scoutEvery = guidedRollout.badStreak >= 3
    ? GUIDED_ROBUST_SCOUT_BAD_EVERY
    : GUIDED_ROBUST_SCOUT_EVERY;
  guidedRollout.jobsSinceRobust++;
  if (guidedRollout.jobsSinceRobust >= scoutEvery && robustInFlight === 0) {
    guidedRollout.jobsSinceRobust = 0;
    return "";
  }

  guidedRollout.state = "active";
  guidedRollout.inFlight++;
  message.guidedDecode = true;
  return "active";
}
function noteGuidedRobustBaseline(latencyMs) {
  guidedRollout.robustLatencies.push(latencyMs);
  if (guidedRollout.robustLatencies.length > 24) guidedRollout.robustLatencies.shift();
}
function noteGuidedCompletion(stage, outputSymbols, tracks, latencyMs) {
  guidedRollout.inFlight = Math.max(0, guidedRollout.inFlight - 1);
  if (!stage) return;
  // Do not demote a low-latency decoder merely because one animated display
  // frame produced few symbols. A zero-output guided frame is cheap (~10-60ms
  // in the measured run); dense robust frames are the expensive 0.2-2s events.
  // Generic lattice recovery plus the single robust scout provide the escape
  // hatch, while normal camera frames stay on the bounded guided path.
  if (outputSymbols > 0) {
    guidedRollout.badStreak = 0;
  } else {
    guidedRollout.badStreak++;
    guidedRollout.failures++;
  }
  guidedRollout.state = "active";
}
const SLOT_METRIC_COUNT = 64;
const SLOT_WEAK_MIN_SAMPLES = 32;
const SLOT_WEAK_ENTER_SCORE = 0.08;
const SLOT_WEAK_RECOVERY_SCORE = 0.25;
const SLOT_WEAK_PROBE_EVERY = 8;
const SLOT_WEAK_MIN_WALL = 6;
const SLOT_WEAK_MIN_HEALTHY = 4;
const slotAttemptCounts = new Uint32Array(SLOT_METRIC_COUNT);
const slotHitCounts = new Uint32Array(SLOT_METRIC_COUNT);
const slotQualitySamples = new Uint16Array(SLOT_METRIC_COUNT);
const slotQualityScores = new Float32Array(SLOT_METRIC_COUNT);
const slotAdaptiveWeak = new Uint8Array(SLOT_METRIC_COUNT);

// Full SampleQR fallback is expensive enough that six independent worker-local
// histories learn far too slowly. Own the policy here, keyed by physical grid
// slot, and send each guided job one allow-mask. The thresholds intentionally
// match v175's conservative policy; only the evidence is now shared globally.
const GUIDED_FALLBACK_SLOT_COUNT = 32;
const guidedFallbackMisses = new Uint8Array(GUIDED_FALLBACK_SLOT_COUNT);
const guidedFallbackCooldown = new Uint8Array(GUIDED_FALLBACK_SLOT_COUNT);
const guidedFallbackBackoff = new Uint8Array(GUIDED_FALLBACK_SLOT_COUNT);
function resetGuidedFallbackSlot(slot) {
  guidedFallbackMisses[slot] = 0;
  guidedFallbackCooldown[slot] = 0;
  guidedFallbackBackoff[slot] = 0;
}
function resetGuidedFallbackPolicy() {
  guidedFallbackMisses.fill(0);
  guidedFallbackCooldown.fill(0);
  guidedFallbackBackoff.fill(0);
}
function guidedFallbackMaskForTracks(tracks) {
  let mask = 0;
  for (const track of tracks ?? []) {
    const slot = Number(track.slot ?? track.id);
    if (!Number.isInteger(slot) || slot < 0 || slot >= GUIDED_FALLBACK_SLOT_COUNT) continue;
    if (guidedFallbackCooldown[slot]) {
      guidedFallbackCooldown[slot]--;
      continue;
    }
    mask = (mask | ((1 << slot) >>> 0)) >>> 0;
  }
  return mask >>> 0;
}
function noteGuidedFallbackMetrics(guided) {
  if (!guided) return;
  const sparseSuccess = Number(guided.sparseSuccessMask) >>> 0;
  const fallbackAttempt = Number(guided.fallbackAttemptMask) >>> 0;
  const fallbackSuccess = Number(guided.fallbackSuccessMask) >>> 0;
  for (let slot = 0; slot < GUIDED_FALLBACK_SLOT_COUNT; slot++) {
    const bit = (1 << slot) >>> 0;
    if (sparseSuccess & bit) {
      resetGuidedFallbackSlot(slot);
      continue;
    }
    if (!(fallbackAttempt & bit)) continue;
    if (fallbackSuccess & bit) {
      resetGuidedFallbackSlot(slot);
      continue;
    }
    if (++guidedFallbackMisses[slot] < 4) continue;
    guidedFallbackMisses[slot] = 0;
    guidedFallbackBackoff[slot] = Math.min(3, guidedFallbackBackoff[slot] + 1);
    guidedFallbackCooldown[slot] = guidedFallbackBackoff[slot];
  }
}
function resetSlotMetrics() {
  slotAttemptCounts.fill(0);
  slotHitCounts.fill(0);
  slotQualitySamples.fill(0);
  slotQualityScores.fill(0.5);
  slotAdaptiveWeak.fill(0);
}
function noteSlotDecoded(slot) {
  const index = Number(slot);
  if (!Number.isInteger(index) || index < 0 || index >= SLOT_METRIC_COUNT || !slotAdaptiveWeak[index]) return;
  slotAdaptiveWeak[index] = 0;
  slotQualityScores[index] = Math.max(slotQualityScores[index], SLOT_WEAK_RECOVERY_SCORE);
}
function noteSlotMetric(slot, hit) {
  const index = Number(slot);
  if (!Number.isInteger(index) || index < 0 || index >= SLOT_METRIC_COUNT) return;
  slotAttemptCounts[index]++;
  if (hit) {
    slotHitCounts[index]++;
    // A weak-slot probe that succeeds is real CRC-backed evidence. Restore it
    // immediately, then let the EWMA decide again only after another sustained
    // miss run instead of making one lucky/failed frame flap the scheduler.
    noteSlotDecoded(index);
  }
  slotQualitySamples[index] = Math.min(65535, slotQualitySamples[index] + 1);
  slotQualityScores[index] = slotQualityScores[index] * 0.9 + Number(hit) * 0.1;
  if (!slotAdaptiveWeak[index] && slotQualitySamples[index] >= SLOT_WEAK_MIN_SAMPLES &&
      slotQualityScores[index] < SLOT_WEAK_ENTER_SCORE) {
    slotAdaptiveWeak[index] = 1;
  }
}
function adaptiveWeakSlotScheduling(candidates) {
  if (strictHotPathActive() || candidates.length < SLOT_WEAK_MIN_WALL) return false;
  let healthy = 0;
  for (const region of candidates) {
    const slot = Number(region.gridSlot);
    if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_METRIC_COUNT) continue;
    if (slotQualitySamples[slot] >= SLOT_WEAK_MIN_SAMPLES / 2 &&
        !slotAdaptiveWeak[slot] && slotQualityScores[slot] >= SLOT_WEAK_RECOVERY_SCORE) healthy++;
  }
  // Only suppress a local outlier. If focus/exposure/motion makes the entire
  // wall bad, there are not enough healthy peers and every slot stays active.
  return healthy >= SLOT_WEAK_MIN_HEALTHY;
}
function shouldScheduleAdaptiveSlot(region, sourceSequence, adaptive) {
  if (!adaptive) return true;
  const slot = Number(region.gridSlot);
  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_METRIC_COUNT || !slotAdaptiveWeak[slot]) return true;
  const sequence = Number(sourceSequence);
  if (!Number.isFinite(sequence)) return true;
  // Stagger weak slots so several bad edge cells do not all consume the same
  // probe frame. They remain geometrically tracked; only payload decode work is
  // thinned out. Acquisition/reacquisition is intentionally unaffected.
  return (Math.trunc(sequence) + slot) % SLOT_WEAK_PROBE_EVERY === 0;
}
function formatSlotMetric(slot) {
  const attempts = slotAttemptCounts[slot] || 0;
  const hits = slotHitCounts[slot] || 0;
  const state = slotAdaptiveWeak[slot] ? " [weak]" : "";
  return `s${slot} ${hits}/${attempts}${attempts ? ` ${(hits / attempts * 100).toFixed(0)}%` : ""}${state}`;
}
function cornerSlotMetrics() {
  const candidates = regions.filter((region) =>
    region.gridSlot !== void 0 && region.slotState !== "OFFSCREEN" &&
    [region.x, region.y, region.w, region.h].every(Number.isFinite)
  );
  if (candidates.length < 2) return "";
  const center = (region) => ({ x: region.x + region.w / 2, y: region.y + region.h / 2 });
  const pick = (score, largest = false) => candidates.reduce((best, region) => {
    const value = score(center(region));
    if (!best || (largest ? value > best.value : value < best.value)) return { region, value };
    return best;
  }, null)?.region;
  const tl = pick((p) => p.x + p.y);
  const tr = pick((p) => p.x - p.y, true);
  const bl = pick((p) => p.y - p.x, true);
  const br = pick((p) => p.x + p.y, true);
  const corner = (label, region) => region ? `${label} ${formatSlotMetric(region.gridSlot)}` : "";
  const measured = candidates
    .map((region) => {
      const slot = region.gridSlot;
      const attempts = slotAttemptCounts[slot] || 0;
      const hits = slotHitCounts[slot] || 0;
      return { slot, attempts, hits, rate: attempts ? hits / attempts : 1 };
    })
    .filter((item, index, array) => item.attempts >= 4 && array.findIndex((other) => other.slot === item.slot) === index)
    .sort((a, b) => a.rate - b.rate || b.attempts - a.attempts)
    .slice(0, 4);
  const weak = measured.length ? ` · weak ${measured.map((item) => formatSlotMetric(item.slot)).join(" · ")}` : "";
  return `Corners  ${[corner("TL", tl), corner("TR", tr), corner("BL", bl), corner("BR", br)].filter(Boolean).join(" · ")}${weak}`;
}

const livePipeline = {
  startedAt: 0,
  captures: 0,
  submittedJobs: 0,
  submittedTracked: 0,
  submittedFull: 0,
  submittedAcquisition: 0,
  submittedReacquire: 0,
  submittedTracks: 0,
  submittedPixels: 0,
  submittedTrackedPixels: 0,
  submittedFullPixels: 0,
  submittedFrames: 0,
  lastSubmittedSourceSequence: -1,
  lastSubmittedAt: 0,
  completedJobs: 0,
  completedTracked: 0,
  completedFull: 0,
  trackedOutputSymbols: 0,
  fullOutputSymbols: 0,
  latencyMs: 0,
  trackedLatencyMs: 0,
  fullLatencyMs: 0,
  copyMs: 0,
  robustMs: 0,
  trackedRobustMs: 0,
  fullRobustMs: 0,
  nativeMs: 0,
  guidedMs: 0,
  guidedBinarizeMs: 0,
  guidedFinderMs: 0,
  guidedSampleMs: 0,
  guidedDecodeMs: 0,
  guidedFastDecodeMs: 0,
  guidedGenericDecodeMs: 0,
  guidedFastDecodeAttempts: 0,
  guidedFastDecodeSuccesses: 0,
  guidedGenericDecodeAttempts: 0,
  guidedGenericFallbackTracks: 0,
  guidedGenericFallbackSuccesses: 0,
  guidedGenericFallbackSkipped: 0,
  guidedSparseNoRsAttempts: 0,
  guidedSparseNoRsSuccesses: 0,
  guidedSparseRsFallbacks: 0,
  guidedSparseSkipped: 0,
  guidedTurboAttempts: 0,
  guidedTurboSuccesses: 0,
  guidedStableRsAttempts: 0,
  guidedStableRsSuccesses: 0,
  guidedStableEligibleTracks: 0,
  guidedTranslationWarpTracks: 0,
  guidedAffineWarpTracks: 0,
  guidedPerspectiveWarpTracks: 0,
  guidedJobs: 0,
  guidedOutputs: 0,
  guidedFinderAttempts: 0,
  guidedFinderSuccesses: 0,
  workerWaitMs: 0,
  otherMs: 0,
  readFullAttempts: 0,
  timeouts: 0,
  errors: 0,
  lastCompletedAt: 0,
  trackedLatencies: [],
  fullLatencies: [],
  droppedBase: 0
};
function resetLivePipeline(now = receiverNow()) {
  Object.assign(livePipeline, {
    startedAt: now, captures: 0, submittedJobs: 0, submittedTracked: 0, submittedFull: 0,
    submittedAcquisition: 0, submittedReacquire: 0, submittedTracks: 0, submittedPixels: 0,
    submittedTrackedPixels: 0, submittedFullPixels: 0, submittedFrames: 0, lastSubmittedSourceSequence: -1,
    lastSubmittedAt: 0, completedJobs: 0, completedTracked: 0, completedFull: 0, trackedOutputSymbols: 0, fullOutputSymbols: 0,
    latencyMs: 0, trackedLatencyMs: 0, fullLatencyMs: 0, copyMs: 0, robustMs: 0, trackedRobustMs: 0, fullRobustMs: 0, nativeMs: 0,
    guidedMs: 0, guidedBinarizeMs: 0, guidedFinderMs: 0, guidedSampleMs: 0, guidedDecodeMs: 0,
    guidedFastDecodeMs: 0, guidedGenericDecodeMs: 0, guidedFastDecodeAttempts: 0, guidedFastDecodeSuccesses: 0, guidedGenericDecodeAttempts: 0,
    guidedGenericFallbackTracks: 0, guidedGenericFallbackSuccesses: 0, guidedGenericFallbackSkipped: 0,
    guidedSparseNoRsAttempts: 0, guidedSparseNoRsSuccesses: 0, guidedSparseRsFallbacks: 0, guidedSparseSkipped: 0,
    guidedTurboAttempts: 0, guidedTurboSuccesses: 0,
    guidedStableRsAttempts: 0, guidedStableRsSuccesses: 0, guidedStableEligibleTracks: 0,
    guidedJobs: 0, guidedOutputs: 0, guidedFinderAttempts: 0, guidedFinderSuccesses: 0,
    workerWaitMs: 0, otherMs: 0, readFullAttempts: 0, timeouts: 0, errors: 0, lastCompletedAt: 0,
    trackedLatencies: [], fullLatencies: [], droppedBase: capturesDropped
  });
  resetSlotMetrics();
  resetGuidedFallbackPolicy();
  resetGuidedRollout();
}
function pushLiveLatency(target, value) {
  if (!Number.isFinite(value)) return;
  target.push(value);
  if (target.length > 4096) target.splice(0, target.length - 4096);
}
function livePercentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}
let totalCaptures = 0;
let totalDecodes = 0;
let fullScans = 0;
let acquisitionTileCursor = 0;
let peakRegions = 0;
let capturesDropped = 0;
const candidateEvidenceWindows = /* @__PURE__ */ new Map();
const scanCandidateEpoch = /* @__PURE__ */ new Map();
const optimizerTrace = [];
const OPTIMIZER_TRACE_LIMIT = 1200;
let optimizerJobsSubmittedTotal = 0;
let optimizerJobsMappedTotal = 0;
let optimizerCompletionsMappedTotal = 0;
let optimizerUnattributedResults = 0;
let optimizerEpochMismatches = 0;
let optimizerDuplicateValidEvents = 0;
let optimizerTransitionFramesDiscarded = 0;
const optimizerJobIds = /* @__PURE__ */ new Set();
const optimizerValidEvents = /* @__PURE__ */ new Set();
const optimizerEpochs = /* @__PURE__ */ new Map();
let optimizerEpochSequence = 0;
let optimizerPipelineActive = false;
let optimizerTransition;
let activeOptimizerEpoch;
let latestSourceFrameSequence = -1;
let optimizeMeasureToken = 0;
let optimizerFixedTargets = [];
let optimizerDiscoveryMode = false;
const optimizerOverlayHits = [];
let optimizerBootstrapDecode;
function traceOptimizer(event) {
  optimizerTrace.push(event);
  if (optimizerTrace.length > OPTIMIZER_TRACE_LIMIT) optimizerTrace.splice(0, optimizerTrace.length - OPTIMIZER_TRACE_LIMIT);
}
function refreshCandidateEvidence(evidence) {
  if (!evidence.closedAt) return evidence.performance;
  const seconds = Math.max(1e-3, (evidence.closedAt - evidence.startedAt) / 1e3);
  const next = {
    validDecodesPerSecond: evidence.validDecodes / seconds,
    usefulSymbolsPerSecond: evidence.usefulSymbols / seconds,
    perQrAttemptSuccessRate: evidence.qrAttempts ? evidence.validDecodes / evidence.qrAttempts : 0,
    captureFps: evidence.sourceFrames.size / seconds,
    submittedJobs: evidence.submittedJobs,
    completedJobs: evidence.completedJobs,
    completionCoverage: evidence.submittedJobs ? evidence.completedJobs / evidence.submittedJobs : 0,
    sourceFrames: evidence.sourceFrames.size,
    successfulSourceFrames: evidence.successfulSourceFrames.size,
    qrAttempts: evidence.qrAttempts,
    validDecodes: evidence.validDecodes,
    measurementMs: seconds * 1e3,
    temporalContamination: evidence.temporalSamples.reduce((sum, value) => sum + value, 0) / Math.max(1, evidence.temporalSamples.length)
  };
  if (evidence.performance) Object.assign(evidence.performance, next);
  else evidence.performance = next;
  return evidence.performance;
}
function aggregateOptimizerOptics(samples) {
  if (!samples.length) return void 0;
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length & 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const value = (read) => median(samples.map(read));
  return {
    confidence: value((m) => m.confidence),
    focusScore: value((m) => m.focusScore),
    exposureScore: value((m) => m.exposureScore),
    transitionWidthModules: value((m) => m.transitionWidthModules),
    blackLevel: value((m) => m.blackLevel),
    whiteLevel: value((m) => m.whiteLevel),
    separation: value((m) => m.separation),
    noise: value((m) => m.noise),
    clipping: value((m) => m.clipping),
    banding: value((m) => m.banding),
    temporalContamination: value((m) => m.temporalContamination),
    tiles: Math.round(value((m) => m.tiles)),
    sampledModules: Math.round(value((m) => m.sampledModules))
  };
}
function newCandidateEvidence(epochId) {
  return {
    epoch: epochId,
    startedAt: receiverNow(),
    closedAt: 0,
    submittedJobs: 0,
    completedJobs: 0,
    sourceFrames: /* @__PURE__ */ new Set(),
    successfulSourceFrames: /* @__PURE__ */ new Set(),
    qrAttempts: 0,
    validDecodes: 0,
    usefulSymbols: 0,
    temporalSamples: [],
    opticalSourceFrames: /* @__PURE__ */ new Set(),
    opticalSamples: [],
    opticalTargetedSamples: 0
  };
}
function optimizerAttributionComplete(scanId) {
  const attribution = scanCandidateEpoch.get(scanId);
  if (!attribution) return;
  scanCandidateEpoch.delete(scanId);
}
function snapshotOptimizerGeometry() {
  optimizerFixedTargets = regions.filter((region) => region.decoded && validQuadObject(region.quad) && region.dim && region.visibleFraction >= 0.85).slice(0, 15).map((region) => ({
    id: region.id,
    slot: region.gridSlot,
    misses: 0,
    quad: {
      topLeft: { ...region.quad.topLeft },
      topRight: { ...region.quad.topRight },
      bottomRight: { ...region.quad.bottomRight },
      bottomLeft: { ...region.quad.bottomLeft }
    },
    dim: region.dim,
    crc32: Boolean(region.crc32)
  }));
  return optimizerFixedTargets.length > 0;
}
const optimizerEpochHooks = {
  transition(request) {
    if (activeOptimizerEpoch) activeOptimizerEpoch.collecting = false;
    activeOptimizerEpoch = void 0;
    optimizerPipelineActive = true;
    optimizerTransition = request;
    traceOptimizer({ time: receiverNow(), event: "APPLY", ...request });
  },
  async open(request) {
    traceOptimizer({ time: receiverNow(), event: "ACTUAL_SETTINGS", ...request });
    const after = latestSourceFrameSequence;
    const token = optimizeMeasureToken;
    const settleStartedAt = receiverNow();
    while (token === optimizeMeasureToken && latestSourceFrameSequence - after < CAMERA_TUNING.exposureDiscardFrames && receiverNow() - settleStartedAt < 2600) {
      await new Promise((resolve) => setTimeout(resolve, 8));
    }
    if (token !== optimizeMeasureToken || latestSourceFrameSequence - after < CAMERA_TUNING.exposureDiscardFrames) return void 0;
    const epoch = {
      id: ++optimizerEpochSequence,
      candidateId: request.candidateId,
      requestedExposure: request.requestedExposure,
      requestedIso: request.requestedIso,
      actualExposure: request.actualExposure,
      actualIso: request.actualIso,
      activationTime: receiverNow(),
      firstValidSourceSequence: latestSourceFrameSequence + 1,
      collecting: false
    };
    optimizerTransition = void 0;
    optimizerEpochs.set(epoch.id, epoch);
    activeOptimizerEpoch = epoch;
    traceOptimizer({ time: receiverNow(), event: "CANDIDATE_OPEN", candidateEpoch: epoch.id, ...request });
    return epoch.id;
  },
  close(epochId) {
    if ((activeOptimizerEpoch == null ? void 0 : activeOptimizerEpoch.id) !== epochId) return;
    activeOptimizerEpoch.collecting = false;
    activeOptimizerEpoch.lastValidSourceSequence = latestSourceFrameSequence;
    traceOptimizer({
      time: receiverNow(),
      event: "CANDIDATE_CLOSE",
      candidateId: activeOptimizerEpoch.candidateId,
      candidateEpoch: epochId,
      sourceSequence: latestSourceFrameSequence,
      requestedExposure: activeOptimizerEpoch.requestedExposure,
      requestedIso: activeOptimizerEpoch.requestedIso,
      actualExposure: activeOptimizerEpoch.actualExposure,
      actualIso: activeOptimizerEpoch.actualIso
    });
    activeOptimizerEpoch = void 0;
  },
  finish() {
    activeOptimizerEpoch = void 0;
    optimizerTransition = void 0;
    optimizerPipelineActive = false;
  }
};
async function measureOptimizerOptics(label, epochId) {
  const token = optimizeMeasureToken;
  const epoch = activeOptimizerEpoch;
  if (!epoch || epoch.id !== epochId) throw new Error("Optimizer candidate epoch is not active");
  const evidence = newCandidateEvidence(epochId);
  candidateEvidenceWindows.set(epochId, evidence);
  const lower = label.toLowerCase();
  const targetFrames = lower.startsWith("baseline") ? 3 : lower.startsWith("boundary") ? 3 : 2;
  const maxBurstMs = targetFrames >= 3 ? 520 : 380;
  epoch.collecting = true;
  while (token === optimizeMeasureToken && (activeOptimizerEpoch == null ? void 0 : activeOptimizerEpoch.id) === epochId) {
    opticsOptimizeStatus.textContent = `${label} · optics ${evidence.opticalSamples.length}/${targetFrames}`;
    if (evidence.opticalSamples.length >= targetFrames || receiverNow() - evidence.startedAt >= maxBurstMs) break;
    await new Promise((resolve) => setTimeout(resolve, 8));
  }
  epoch.collecting = false;
  evidence.closedAt = receiverNow();
  const metrics = aggregateOptimizerOptics(evidence.opticalSamples);
  if (!metrics) throw new Error("camera produced no optical optimizer measurements");
  const targeted = evidence.opticalTargetedSamples >= Math.max(1, Math.ceil(evidence.opticalSamples.length / 2));
  opticsOptimizeStatus.textContent = `${label} · sep ${metrics.separation.toFixed(0)} · noise ${metrics.noise.toFixed(1)}`;
  return { metrics, sourceFrames: evidence.opticalSourceFrames.size, targeted };
}
async function measureReceivePerformance(label, epochId) {
  var _a, _b, _c, _d;
  const token = optimizeMeasureToken;
  const epoch = activeOptimizerEpoch;
  if (!epoch || epoch.id !== epochId) throw new Error("Optimizer candidate epoch is not active");
  const startedAt = receiverNow();
  const discovery = optimizerDiscoveryMode || optimizerFixedTargets.length === 0;
  const multiQr = !discovery && optimizerFixedTargets.length > 1;
  const singleQr = !discovery && !multiQr;
  const phase = label.split("·", 1)[0].trim().toLowerCase();
  const targetFrames = discovery ? phase === "race" ? 2 : phase === "commit" ? 6 : phase === "verify" ? 4 : phase === "finalist" ? 4 : phase === "revisit" ? 3 : 2 : phase === "commit" ? singleQr ? 7 : 6 : phase === "verify" ? singleQr ? 5 : 4 : phase === "finalist" ? singleQr ? 5 : 4 : phase === "revisit" ? singleQr ? 5 : 3 : phase === "refine" ? singleQr ? 4 : 3 : singleQr ? 4 : 3;
  const maxBurstMs = discovery ? phase === "race" ? 420 : phase === "commit" ? 1100 : phase === "verify" ? 800 : phase === "finalist" ? 800 : 650 : phase === "commit" ? 1100 : phase === "verify" ? 800 : phase === "finalist" ? 800 : singleQr ? 750 : 550;
  const evidence = newCandidateEvidence(epochId);
  evidence.startedAt = startedAt;
  evidence.temporalSamples.push((_b = (_a = focusController.diagnostics().optical) == null ? void 0 : _a.temporalContamination) != null ? _b : 0);
  candidateEvidenceWindows.set(epochId, evidence);
  epoch.collecting = true;
  while (token === optimizeMeasureToken && (activeOptimizerEpoch == null ? void 0 : activeOptimizerEpoch.id) === epochId) {
    opticsOptimizeStatus.textContent = `${label} · ${evidence.sourceFrames.size}/${targetFrames}`;
    if (evidence.sourceFrames.size >= targetFrames || receiverNow() - startedAt >= maxBurstMs) break;
    await new Promise((resolve) => setTimeout(resolve, 12));
  }
  epoch.collecting = false;
  evidence.closedAt = receiverNow();
  evidence.temporalSamples.push((_d = (_c = focusController.diagnostics().optical) == null ? void 0 : _c.temporalContamination) != null ? _d : 0);
  refreshCandidateEvidence(evidence);
  const result2 = (async () => {
    const waitStartedAt = receiverNow();
    const drainMs = phase === "race" ? 900 : 6e3;
    while (token === optimizeMeasureToken && evidence.completedJobs < evidence.submittedJobs && receiverNow() - waitStartedAt < drainMs) {
      if (phase === "race" && evidence.validDecodes > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const performanceSample = refreshCandidateEvidence(evidence);
    traceOptimizer({
      time: receiverNow(),
      event: "CANDIDATE_SCORE",
      candidateId: epoch.candidateId,
      candidateEpoch: epochId,
      requestedExposure: epoch.requestedExposure,
      requestedIso: epoch.requestedIso,
      actualExposure: epoch.actualExposure,
      actualIso: epoch.actualIso,
      validDecode: performanceSample.validDecodes > 0
    });
    if (token === optimizeMeasureToken) {
      opticsOptimizeStatus.textContent = `${label} · ${(performanceSample.perQrAttemptSuccessRate * 100).toFixed(0)}%`;
    }
    return performanceSample;
  })();
  return { result: result2 };
}
let optimizeEnabled = false;
let optimizeRunning = false;
let optimizeConverged = false;
let optimizeRecheckAt = 0;
let optimizePassBaseline;
let manualValidationToken = 0;
let manualOptimizerValidation;
function setOptimizeEnabled(enabled) {
  optimizeEnabled = enabled;
  if (enabled) {
    optimizeConverged = false;
    optimizeRecheckAt = 0;
    optimizePassBaseline = void 0;
  }
  opticsOptimize.setAttribute("aria-pressed", String(enabled));
  opticsOptimize.textContent = enabled ? "Stop" : "Optimize";
  if (!enabled) {
    optimizeRecheckAt = 0;
    optimizePassBaseline = void 0;
    optimizeMeasureToken++;
    if (optimizeRunning) focusController.cancelOptimize("Optimize stopped");
    if (focusController.diagnostics().optimizeState !== "complete") opticsOptimizeStatus.textContent = "";
  } else {
    opticsOptimizeStatus.textContent = "Starting…";
    beginOptimizeWhenReady();
  }
}
function beginOptimizeWhenReady() {
  var _a;
  if (!optimizeEnabled || optimizeRunning) return;
  const now = performance.now();
  if (optimizeConverged) {
    if (now < optimizeRecheckAt) return;
    optimizeConverged = false;
    opticsOptimizeStatus.textContent = "Refining optimum…";
  }
  if (now < optimizeRecheckAt) return;
  if (!focusController.optimizeEligible()) {
    const diagnostic = focusController.diagnostics();
    opticsOptimizeStatus.textContent = diagnostic.state === "UNAVAILABLE" ? "Camera unavailable" : diagnostic.optimizeState === "paused" ? (_a = diagnostic.optimizeReason) != null ? _a : "Optimize paused" : "Starting…";
    return;
  }
  optimizerDiscoveryMode = !snapshotOptimizerGeometry();
  const passDiagnostic = focusController.diagnostics();
  optimizePassBaseline = { exposure: passDiagnostic.committedExposureTime, iso: passDiagnostic.committedIso };
  optimizeRunning = true;
  optimizeMeasureToken++;
  optimizerTrace.length = 0;
  optimizerJobsSubmittedTotal = 0;
  optimizerJobsMappedTotal = 0;
  optimizerCompletionsMappedTotal = 0;
  optimizerUnattributedResults = 0;
  optimizerEpochMismatches = 0;
  optimizerDuplicateValidEvents = 0;
  optimizerTransitionFramesDiscarded = 0;
  optimizerJobIds.clear();
  optimizerValidEvents.clear();
  optimizerEpochs.clear();
  optimizerOverlayHits.length = 0;
  optimizerBootstrapDecode = void 0;
  manualOptimizerValidation = void 0;
  candidateEvidenceWindows.clear();
  opticsKeep.hidden = true;
  opticsOptimizeStatus.textContent = optimizerDiscoveryMode ? "Exploring from camera…" : "Exploring…";
  void focusController.startOptimizer(measureOptimizerOptics, measureReceivePerformance, optimizerEpochHooks).then(() => {
    var _a2, _b, _c;
    const finished = focusController.diagnostics();
    if (!optimizeEnabled) return;
    const reason = (_a2 = finished.optimizeReason) != null ? _a2 : "";
    if (finished.optimizeState === "complete") {
      optimizeConverged = true;
      const exposureImproved = (optimizePassBaseline == null ? void 0 : optimizePassBaseline.exposure) !== void 0 && finished.committedExposureTime !== void 0 && finished.committedExposureTime < optimizePassBaseline.exposure * 0.97;
      optimizeRecheckAt = performance.now() + (exposureImproved ? 2500 : 12e3);
      if (optimizerBootstrapDecode) {
        noteRegion(optimizerBootstrapDecode.box, receiverNow(), true, optimizerBootstrapDecode.info);
      }
      const bestPerformance = finished.optimizeBestPerformance;
      opticsOptimizeStatus.textContent = bestPerformance ? `Optimizing · best ${bestPerformance.validDecodesPerSecond.toFixed(1)} QR/s · ${formatExposureMs(finished.committedExposureTime)} · ISO ${(_b = finished.committedIso) != null ? _b : "—"}` : "Optimizing · holding best";
      opticsOptimizeStatus.title = (_c = finished.optimizeSummary) != null ? _c : "";
      opticsKeep.hidden = false;
    } else if (reason.includes("current QR-validated setting remains best") || reason.includes("final QR validation failed")) {
      const hadQrOptics = finished.optimizeCandidates.some((candidate) => candidate.opticalTargeted);
      if (hadQrOptics) {
        optimizeConverged = true;
        optimizeRecheckAt = performance.now() + 12e3;
        opticsOptimizeStatus.textContent = "Optimizing · current setting best";
      } else {
        optimizeConverged = false;
        optimizeRecheckAt = performance.now() + 1200;
        opticsOptimizeStatus.textContent = "Optimizing · waiting for QR lock";
      }
      opticsOptimizeStatus.title = reason;
      opticsKeep.hidden = true;
    } else {
      optimizeConverged = false;
      optimizeRecheckAt = performance.now() + 1500;
      opticsOptimizeStatus.textContent = reason ? `Optimizing · ${reason}` : "Optimizing · waiting for clean QR lock";
      opticsKeep.hidden = true;
    }
  }).finally(() => {
    optimizeRunning = false;
    optimizerDiscoveryMode = false;
  });
}
async function applyAndValidateManualExposure(track) {
  var _a, _b;
  const run = ++manualValidationToken;
  const canValidate = !automaticOptics && optimizerFixedTargets.length > 0 && focusController.diagnostics().optimizeCandidates.length > 0;
  if (!canValidate) {
    await applyExposureSetting(track);
    return;
  }
  optimizeMeasureToken++;
  const before = track.getSettings();
  const requestedExposure = (_a = preferredExposureTime != null ? preferredExposureTime : before.exposureTime) != null ? _a : 0;
  const requestedIso = (_b = preferredIso != null ? preferredIso : before.iso) != null ? _b : 0;
  optimizerEpochHooks.transition({ candidateId: "MANUAL", requestedExposure, requestedIso });
  await applyExposureSetting(track);
  const actual = track.getSettings();
  if (run !== manualValidationToken || actual.exposureTime === void 0 || actual.iso === void 0) {
    optimizerEpochHooks.finish();
    return;
  }
  const epoch = await optimizerEpochHooks.open({
    candidateId: "MANUAL",
    requestedExposure,
    requestedIso,
    actualExposure: actual.exposureTime,
    actualIso: actual.iso
  });
  if (epoch === void 0 || run !== manualValidationToken) {
    optimizerEpochHooks.finish();
    return;
  }
  const sample = await measureReceivePerformance("Manual", epoch);
  optimizerEpochHooks.close(epoch);
  const performance2 = await sample.result;
  if (run === manualValidationToken) {
    manualOptimizerValidation = { exposure: actual.exposureTime, iso: actual.iso, performance: performance2 };
    opticsOptimizeStatus.textContent = `${(performance2.perQrAttemptSuccessRate * 100).toFixed(0)}% · Manual`;
  }
  optimizerEpochHooks.finish();
  renderFocusDiagnostics();
}
opticsOptimize.addEventListener("click", () => {
  if (!automaticOptics) {
    opticsOptimizeStatus.textContent = "Enable Auto";
    return;
  }
  setOptimizeEnabled(!optimizeEnabled);
});
opticsKeep.addEventListener("click", () => {
  var _a;
  const diagnostic = focusController.diagnostics();
  if (diagnostic.optimizeState !== "complete") return;
  const track = stream == null ? void 0 : stream.getVideoTracks()[0];
  if (!track) return;
  const winner = (_a = diagnostic.optimizeCandidates.find((candidate) => candidate.state === "winner")) != null ? _a : diagnostic.optimizeCandidates[0];
  if (!winner) return;
  automaticExposureAxis = false;
  automaticIsoAxis = false;
  preferredExposureTime = winner.exposure;
  preferredIso = winner.iso;
  cameraExposure.value = String(winner.exposure);
  showExposureTime(winner.exposure);
  cameraIso.value = String(winner.iso);
  cameraIsoValue.value = String(Number(winner.iso.toPrecision(4)));
  setOptimizeEnabled(false);
  automaticOptics = false;
  cameraExposureAuto.checked = false;
  syncExposureControls();
  saveCameraSettings();
  void applyExposureSetting(track).then(() => {
    opticsOptimizeStatus.textContent = `Kept · ${formatExposureMs(winner.exposure)} · ISO ${winner.iso}`;
  });
});
let completionDiagnosticsText = "";
function diagnosticsText() {
  return [focusDiagnostics.textContent ?? "", transportDiagnostics?.textContent ?? ""]
    .filter(Boolean).join("\n\n");
}
function legacyClipboardCopy(text) {
  try {
    const input = document.createElement("textarea");
    input.value = text;
    input.readOnly = true;
    input.style.position = "fixed";
    input.style.opacity = "0";
    input.style.pointerEvents = "none";
    document.body.append(input);
    input.select();
    input.setSelectionRange(0, input.value.length);
    const copied = document.execCommand("copy");
    input.remove();
    return copied;
  } catch {
    return false;
  }
}
async function copyDiagnosticsToClipboard(text, automatic = false) {
  if (!text) return false;
  try {
    if (!copyTextOnAndroid(text)) {
      try {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
        await navigator.clipboard.writeText(text);
      } catch (error) {
        if (!legacyClipboardCopy(text)) throw error;
      }
    }
    copyDiagnostics.textContent = automatic ? "Diagnostics copied" : "Copied";
    setTimeout(() => {
      copyDiagnostics.textContent = "Copy diagnostics";
    }, 1500);
    return true;
  } catch {
    if (!automatic) {
      copyDiagnostics.textContent = "Copy failed";
      setTimeout(() => {
        copyDiagnostics.textContent = "Copy diagnostics";
      }, 1500);
    }
    return false;
  }
}
copyDiagnostics.addEventListener("click", () => {
  void copyDiagnosticsToClipboard(completionDiagnosticsText || diagnosticsText());
});
function freezeCompletionDiagnostics() {
  if (completionDiagnosticsText) return;
  // Snapshot the last live transfer instant, before finalization/paint/file
  // verification can drain the camera/worker recent window.
  updateStats(true);
  completionDiagnosticsText = diagnosticsText();
  void copyDiagnosticsToClipboard(completionDiagnosticsText, true);
}
let cameraStartedTs = 0;
const timeline = [];
const TIMELINE_MAX_SAMPLES = 2400;
const regions = [];
const gridLattice = new GridLattice(noteGridTransition);
let gridShape = "";
let lastGridSnapshot;
let activeDecodeBudget = 0;
let nextRegionId = 1;
let lastDecodedRegionSize = 0;
const cropAttempts = /* @__PURE__ */ new Map();
const scanCapturedAt = /* @__PURE__ */ new Map();
const scanOutcomes = /* @__PURE__ */ new Map();
function noteScanOutcome(scanId, kind) {
  var _a;
  if (scanId === void 0) return;
  const outcome = (_a = scanOutcomes.get(scanId)) != null ? _a : { rejected: 0, stale: 0, otherStream: 0, duplicate: 0, redundant: 0, accepted: 0 };
  outcome[kind]++;
  scanOutcomes.set(scanId, outcome);
}
function regionInflightCount(region) {
  let count = 0;
  for (const attempts of cropAttempts.values()) {
    if (attempts.some((attempt) => attempt.region === region)) count++;
  }
  return count;
}
let decodeExceptions = 0;
let lastDecodeError = "";
let lastNativeMetrics;
let lastGuidedMetrics;
let lastDirectPixelPath = "—";
const hotPathAudit = {
  trackedJobs: 0,
  nativeTracks: 0,
  nativeSuccessful: 0,
  crcFastSuccesses: 0,
  nativeMisses: 0,
  rsFallbacks: 0,
  anchorSuccesses: 0,
  anchorMisses: 0,
  fastSamplerAttempts: 0,
  fastSamplerSuccesses: 0,
  outOfFrameMisses: 0,
  bitstreamFailures: 0,
  crcFailures: 0,
  anchorBypassAttempts: 0,
  anchorBypassSuccesses: 0,
  translationAttempts: 0,
  translationSuccesses: 0,
  calibrationAttempts: 0,
  calibrationSuccesses: 0,
  localRecoveryAttempts: 0,
  localRecoverySuccesses: 0,
  fullScanJobs: 0,
  fullScanSuccesses: 0,
  acquisitionFullScans: 0,
  reacquireFullScans: 0,
  readFullAttempts: 0
};
function resetHotPathAudit() {
  for (const key of Object.keys(hotPathAudit)) hotPathAudit[key] = 0;
}
let trackingInvalidations = 0;
let workerLatencyMaxMs = 0;
let lastDistinctArrivalAt = 0;
let lastStreamDecodeAt = 0;
let geometryRecoveryProbes = 0;
let geometryRecoveryResets = 0;
let geometrySightingNudges = 0;
let geometryCoverageHealthy = false;
let geometryCoverageCollapseStreak = 0;
let geometryCoverageCollapseLastAt = 0;
let geometryCoverageCollapseStartedAt = 0;
let geometryCoverageLastScanId = -1;
let recoveryWorkerRestarts = 0;
let recoveryAbortedJobs = 0;
let recoveryAbortedWorkerMs = 0;
let lastRecoveryReason = "—";
let maxSequenceGapMs = 0;
const pipelineEvents = [];
const PIPELINE_EVENT_LIMIT = 80;
function notePipelineEvent(kind, value = 0) {
  if (pipelineEvents.length >= PIPELINE_EVENT_LIMIT) return;
  pipelineEvents.push([
    Number(((receiverNow() - cameraStartedTs) / 1e3).toFixed(2)),
    kind,
    value
  ]);
}
const QUALITY_WINDOW_MS = 3e3;
function pruneSequenceSamples(region, now) {
  while (region.sequenceSamples.length && region.sequenceSamples[0].at < now - QUALITY_WINDOW_MS) {
    region.sequenceSamples.shift();
  }
}
function noteSequence(region, seq, now) {
  pruneSequenceSamples(region, now);
  if (!region.sequenceSamples.some((sample) => sample.seq === seq)) {
    region.sequenceSamples.push({ seq, at: now });
    region.sequenceSamples.sort((a, b) => a.at - b.at);
  }
}
function estimateSenderFrameRate(now = receiverNow()) {
  if (!decoder || decoder.mode === "direct" || !lastGridSnapshot) return void 0;
  const gridCodes = lastGridSnapshot.layout.cols * lastGridSnapshot.layout.rows;
  if (!(gridCodes > 0)) return void 0;
  const modulus = decoder.mode === "mds" ? 256 : 16711680;
  const estimates = [];
  const maxGapMs = decoder.mode === "mds" ? 350 : 1200;
  for (const region of regions) {
    if (region.gridSlot === void 0) continue;
    pruneSequenceSamples(region, now);
    const samples = region.sequenceSamples;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1];
      const b = samples[i];
      const dt = b.at - a.at;
      if (!(dt >= 12 && dt <= maxGapMs)) continue;
      const delta = (b.seq - a.seq + modulus) % modulus;
      if (!delta || delta % gridCodes) continue;
      const senderFrames = delta / gridCodes;
      if (!(senderFrames >= 1 && senderFrames <= 60)) continue;
      const fps = senderFrames * 1e3 / dt;
      if (fps >= 1 && fps <= 500) estimates.push(fps);
    }
  }
  if (estimates.length < 6) return void 0;
  estimates.sort((a, b) => a - b);
  const raw = estimates[estimates.length >> 1];
  const common = [5, 10, 12, 15, 20, 24, 25, 30, 40, 48, 50, 60, 72, 90, 100, 120, 144, 165, 180, 200, 240, 300, 360, 480];
  const nearest = common.reduce((best, fps) => Math.abs(fps - raw) < Math.abs(best - raw) ? fps : best);
  const snapped = Math.abs(nearest - raw) / nearest <= 0.10;
  return { fps: snapped ? nearest : raw, raw, samples: estimates.length, snapped };
}
function noteDecodeCompleted(id, completion) {
  var _a;
  const auditMode = hotPathJobMode.get(id);
  if (!replayRunning && livePipeline.startedAt && auditMode) {
    const latencyMs = Math.max(0, Number(completion.latencyMs) || 0);
    const copyMs = Math.max(0, Number(completion.frameCopyMs) || 0);
    const nativeMs = Math.max(0, Number(completion.nativeMetrics?.totalMs ?? completion.nativeMs) || 0);
    const reportedRobustMs = Math.max(0, Number(completion.robustMs) || 0);
    const robustMs = reportedRobustMs || (completion.readFullAttempts ? Math.max(0, latencyMs - copyMs - nativeMs) : 0);
    const workerWaitMs = Math.max(0, Number(completion.workerWaitMs) || 0);
    const guided = completion.guidedMetrics;
    if (guided) noteGuidedFallbackMetrics(guided);
    const guidedMs = Math.max(0, Number(guided?.totalMs) || 0);
    livePipeline.completedJobs++;
    const outputSymbols = Math.max(0, Number(completion.symbolCount) || 0);
    livePipeline.latencyMs += latencyMs;
    livePipeline.copyMs += copyMs;
    livePipeline.robustMs += robustMs;
    livePipeline.nativeMs += nativeMs;
    livePipeline.guidedMs += guidedMs;
    if (guided) {
      livePipeline.guidedJobs++;
      livePipeline.guidedOutputs += outputSymbols;
      livePipeline.guidedBinarizeMs += Math.max(0, Number(guided.binarizeMs) || 0);
      livePipeline.guidedFinderMs += Math.max(0, Number(guided.finderMs) || 0);
      livePipeline.guidedSampleMs += Math.max(0, Number(guided.sampleMs) || 0);
      livePipeline.guidedDecodeMs += Math.max(0, Number(guided.decodeMs) || 0);
      livePipeline.guidedFastDecodeMs += Math.max(0, Number(guided.fastDecodeMs) || 0);
      livePipeline.guidedGenericDecodeMs += Math.max(0, Number(guided.genericDecodeMs) || 0);
      livePipeline.guidedFastDecodeAttempts += Math.max(0, Number(guided.fastDecodeAttempts) || 0);
      livePipeline.guidedFastDecodeSuccesses += Math.max(0, Number(guided.fastDecodeSuccesses) || 0);
      livePipeline.guidedGenericDecodeAttempts += Math.max(0, Number(guided.genericDecodeAttempts) || 0);
      livePipeline.guidedGenericFallbackTracks += Math.max(0, Number(guided.genericFallbackTracks) || 0);
      livePipeline.guidedGenericFallbackSuccesses += Math.max(0, Number(guided.genericFallbackSuccesses) || 0);
      livePipeline.guidedGenericFallbackSkipped += Math.max(0, Number(guided.genericFallbackSkipped) || 0);
      livePipeline.guidedSparseNoRsAttempts += Math.max(0, Number(guided.sparseNoRsAttempts) || 0);
      livePipeline.guidedSparseNoRsSuccesses += Math.max(0, Number(guided.sparseNoRsSuccesses) || 0);
      livePipeline.guidedSparseRsFallbacks += Math.max(0, Number(guided.sparseRsFallbacks) || 0);
      livePipeline.guidedSparseSkipped += Math.max(0, Number(guided.sparseSkipped) || 0);
      livePipeline.guidedTurboAttempts += Math.max(0, Number(guided.turboAttempts) || 0);
      livePipeline.guidedTurboSuccesses += Math.max(0, Number(guided.turboSuccesses) || 0);
      livePipeline.guidedStableRsAttempts += Math.max(0, Number(guided.stableRsAttempts) || 0);
      livePipeline.guidedStableRsSuccesses += Math.max(0, Number(guided.stableRsSuccesses) || 0);
      livePipeline.guidedStableEligibleTracks += Math.max(0, Number(guided.stableEligibleTracks) || 0);
      livePipeline.guidedTranslationWarpTracks += Math.max(0, Number(guided.translationWarpTracks) || 0);
      livePipeline.guidedAffineWarpTracks += Math.max(0, Number(guided.affineWarpTracks) || 0);
      livePipeline.guidedPerspectiveWarpTracks += Math.max(0, Number(guided.perspectiveWarpTracks) || 0);
      livePipeline.guidedFinderAttempts += Math.max(0, Number(guided.finderAttempts) || 0);
      livePipeline.guidedFinderSuccesses += Math.max(0, Number(guided.finderSuccesses) || 0);
    }
    livePipeline.workerWaitMs += workerWaitMs;
    livePipeline.otherMs += Math.max(0, latencyMs - copyMs - robustMs - nativeMs - guidedMs);
    livePipeline.readFullAttempts += Math.max(0, Number(completion.readFullAttempts) || 0);
    livePipeline.lastCompletedAt = receiverNow();
    if (auditMode.full) {
      livePipeline.completedFull++;
      livePipeline.fullOutputSymbols += outputSymbols;
      livePipeline.fullLatencyMs += latencyMs;
      livePipeline.fullRobustMs += robustMs;
      pushLiveLatency(livePipeline.fullLatencies, latencyMs);
    } else {
      livePipeline.completedTracked++;
      livePipeline.trackedOutputSymbols += outputSymbols;
      livePipeline.trackedLatencyMs += latencyMs;
      livePipeline.trackedRobustMs += robustMs;
      pushLiveLatency(livePipeline.trackedLatencies, latencyMs);
    }
    if (completion.error === "Decode worker timed out") livePipeline.timeouts++;
    else if (completion.error) livePipeline.errors++;
    if (!auditMode.full) {
      if (auditMode.guided) noteGuidedCompletion(auditMode.guidedStage, outputSymbols, auditMode.tracks, latencyMs);
      else if (!completion.error && completion.readFullAttempts) noteGuidedRobustBaseline(latencyMs);
    }
  }
  if (auditMode) {
    hotJobCompletionSamples.push({
      at: receiverNow(),
      tracks: auditMode.tracks || 0,
      full: auditMode.full,
      latencyMs: completion.latencyMs || 0,
      nativeMs: completion.nativeMetrics?.totalMs || 0,
      copyMs: completion.frameCopyMs || 0,
      robustBands: completion.robustBands || (completion.readFullAttempts ? 1 : 0),
      robustSearchMs: completion.robustMs || completion.robustSearchMs || (completion.readFullAttempts ? Math.max(0, (completion.latencyMs || 0) - (completion.frameCopyMs || 0) - (completion.nativeMetrics?.totalMs || 0)) : 0),
      guidedMs: completion.guidedMetrics?.totalMs || 0
    });
  }
  hotPathJobMode.delete(id);
  const auditThisCompletion = Boolean(auditMode && auditMode.generation === hotPathAuditGeneration && auditMode.strict === strictHotPathEnabled);
  if (!replayRunning && auditThisCompletion && !auditMode?.full && gridLattice.locked &&
      auditMode.tracks >= GEOMETRY_COLLAPSE_MIN_TRACKS && id >= geometryCoverageLastScanId) {
    geometryCoverageLastScanId = id;
    const now = receiverNow();
    const trackedOutputs = Math.min(auditMode.tracks, Math.max(0, Number(completion.symbolCount) || 0));
    const coverage = trackedOutputs / auditMode.tracks;
    if (coverage >= GEOMETRY_COLLAPSE_HEALTHY_RATIO) {
      geometryCoverageHealthy = true;
      geometryCoverageCollapseStreak = 0;
      geometryCoverageCollapseLastAt = 0;
      geometryCoverageCollapseStartedAt = 0;
    } else if (geometryCoverageHealthy && coverage <= GEOMETRY_COLLAPSE_BAD_RATIO) {
      if (now - geometryCoverageCollapseLastAt > GEOMETRY_COLLAPSE_MAX_GAP_MS) {
        geometryCoverageCollapseStreak = 0;
        geometryCoverageCollapseStartedAt = now;
      }
      if (!geometryCoverageCollapseStreak) geometryCoverageCollapseStartedAt = now;
      geometryCoverageCollapseLastAt = now;
      geometryCoverageCollapseStreak++;
      if (geometryCoverageCollapseStreak >= GEOMETRY_COLLAPSE_STREAK &&
          now - geometryCoverageCollapseStartedAt >= GEOMETRY_COLLAPSE_MIN_SPAN_MS) {
        notePipelineEvent("geometry-coverage-collapse", trackedOutputs);
        enterGeometryRecovery(`tracked coverage collapsed ${trackedOutputs}/${auditMode.tracks}; fresh acquisition`, now, true);
      }
    } else if (coverage > GEOMETRY_COLLAPSE_BAD_RATIO) {
      geometryCoverageCollapseStreak = 0;
      geometryCoverageCollapseLastAt = 0;
      geometryCoverageCollapseStartedAt = 0;
    }
  }
  const benchmarkTrace = benchmarkJobFrames.get(id);
  const benchmarkJob = benchmarkTrace == null ? void 0 : benchmarkTrace.jobs.find((job) => job.id === id);
  if (benchmarkJob) {
    benchmarkTrace.sightings.push(...completion.sightings);
    benchmarkJob.workerWaitMs = completion.workerWaitMs;
    benchmarkJob.targetedAttempts = completion.targetedAttempts;
    benchmarkJob.targetedPixels = completion.targetedPixels;
    benchmarkJob.targetedSuccesses = completion.targetedSuccesses;
    benchmarkJob.decodeMs = completion.latencyMs;
    benchmarkJob.symbols = completion.symbolCount;
    benchmarkJob.trackedHits = completion.trackedHit ? completion.symbolCount : 0;
    benchmarkJob.trackedMisses = completion.trackedAttempted ? Math.max(0, benchmarkJob.tracks.length - (completion.trackedHit ? completion.symbolCount : 0)) : 0;
    benchmarkJob.readFullAttempts = completion.readFullAttempts;
    benchmarkJob.fallbackAttempts = Number(completion.fallbackAttempted);
    benchmarkJob.fallbackSuccesses = Number(completion.fallbackSucceeded);
    benchmarkJob.nativeMetrics = completion.nativeMetrics ? { ...completion.nativeMetrics } : null;
    benchmarkJob.guidedMetrics = completion.guidedMetrics ? { ...completion.guidedMetrics } : null;
  }
  benchmarkJobFrames.delete(id);
  const fullJob = fullScanJobs.get(id);
  // A recovery finder pass can fail payload/RS decode while still locating
  // several QR bodies accurately. Once a wall has been proven, use that
  // coherent positional evidence to recenter the stored lattice instead of
  // throwing it away and waiting for a lucky full payload decode.
  if (fullJob?.reacquire && completion.symbolCount === 0 && completion.sightings?.length) {
    const nudged = gridLattice.nudgeFromSightings(completion.sightings, receiverNow());
    if (nudged) {
      geometrySightingNudges++;
      syncGrid(nudged, receiverNow());
      notePipelineEvent("sighting-lattice-nudge", geometrySightingNudges);
      lastRecoveryReason = `finder sightings recentered locked lattice (${geometrySightingNudges})`;
    }
  }
  fullScanJobs.delete(id);
  scanCapturedAt.delete(id);
  scanCompletionTimes.push(receiverNow());
  focusController.noteDecoderCompletion(id);
  if (completion.directFrameFailed) {
    notePipelineEvent("direct-frame-drop");
    finishScanCapture(id, completion);
    scanOutcomes.delete(id);
    cropAttempts.delete(id);
    optimizerAttributionComplete(id);
    return;
  }
  const attribution = scanCandidateEpoch.get(id);
  if (optimizerJobIds.has(id)) {
    const complete = (attribution == null ? void 0 : attribution.scanId) === id && attribution.sourceFrameSequence >= attribution.epoch.firstValidSourceSequence && Number.isFinite(attribution.epoch.actualExposure) && Number.isFinite(attribution.epoch.actualIso);
    if (attribution && complete) {
      optimizerCompletionsMappedTotal++;
      attribution.evidence.completedJobs++;
      refreshCandidateEvidence(attribution.evidence);
      traceOptimizer({
        time: receiverNow(),
        event: "JOB_COMPLETE",
        candidateId: attribution.epoch.candidateId,
        candidateEpoch: attribution.epoch.id,
        sourceSequence: attribution.sourceFrameSequence,
        scanId: id,
        requestedExposure: attribution.epoch.requestedExposure,
        requestedIso: attribution.epoch.requestedIso,
        actualExposure: attribution.epoch.actualExposure,
        actualIso: attribution.epoch.actualIso,
        validDecode: attribution.validDecodes > 0,
        usefulSymbol: attribution.usefulSymbols > 0
      });
    } else {
      optimizerUnattributedResults++;
      if (attribution) optimizerEpochMismatches++;
      console.error("OPTIMIZER ATTRIBUTION BUG", { scanId: id, attribution });
      traceOptimizer({ time: receiverNow(), event: "ATTRIBUTION_BUG", scanId: id, candidateEpoch: attribution == null ? void 0 : attribution.epoch.id });
    }
  }
  workerLatencyMaxMs = Math.max(workerLatencyMaxMs, completion.latencyMs);
  if (completion.nativeMetrics) {
    lastNativeMetrics = { ...completion.nativeMetrics, frameCopyMs: completion.frameCopyMs };
  }
  if (completion.guidedMetrics) {
    lastGuidedMetrics = { ...completion.guidedMetrics, frameCopyMs: completion.frameCopyMs };
  }
  if (completion.pixelPath) lastDirectPixelPath = completion.pixelPath;
  if (completion.repeatSkipped) {
    repeatSkipTimes.push(receiverNow());
    notePipelineEvent("repeat-frame-skip", Number.isFinite(completion.repeatDistance) ? completion.repeatDistance : 0);
  }
  if (auditThisCompletion && completion.nativeMetrics) {
    hotPathAudit.trackedJobs++;
    hotPathAudit.nativeTracks += completion.nativeMetrics.tracks ?? 0;
    hotPathAudit.nativeSuccessful += completion.nativeMetrics.successful ?? 0;
    hotPathAudit.crcFastSuccesses += completion.nativeMetrics.crcFastSuccesses ?? 0;
    hotPathAudit.nativeMisses += completion.nativeMetrics.misses ?? 0;
    hotPathAudit.rsFallbacks += completion.nativeMetrics.rsFallbacks ?? 0;
    hotPathAudit.anchorSuccesses += completion.nativeMetrics.anchorSuccesses ?? 0;
    hotPathAudit.anchorMisses += completion.nativeMetrics.anchorMisses ?? 0;
    hotPathAudit.fastSamplerAttempts += completion.nativeMetrics.fastSamplerAttempts ?? 0;
    hotPathAudit.fastSamplerSuccesses += completion.nativeMetrics.fastSamplerSuccesses ?? 0;
    hotPathAudit.outOfFrameMisses += completion.nativeMetrics.outOfFrameMisses ?? 0;
    hotPathAudit.bitstreamFailures += completion.nativeMetrics.bitstreamFailures ?? 0;
    hotPathAudit.crcFailures += completion.nativeMetrics.crcFailures ?? 0;
    hotPathAudit.anchorBypassAttempts += completion.nativeMetrics.anchorBypassAttempts ?? 0;
    hotPathAudit.anchorBypassSuccesses += completion.nativeMetrics.anchorBypassSuccesses ?? 0;
    hotPathAudit.translationAttempts += completion.nativeMetrics.translationAttempts ?? 0;
    hotPathAudit.translationSuccesses += completion.nativeMetrics.translationSuccesses ?? 0;
    hotPathAudit.calibrationAttempts += completion.nativeMetrics.calibrationAttempts ?? 0;
    hotPathAudit.calibrationSuccesses += completion.nativeMetrics.calibrationSuccesses ?? 0;
  }
  if (auditThisCompletion) hotPathAudit.readFullAttempts += completion.readFullAttempts ?? 0;
  if (auditThisCompletion && !auditMode?.full && completion.fallbackAttempted) {
    hotPathAudit.localRecoveryAttempts++;
    if (completion.fallbackSucceeded) hotPathAudit.localRecoverySuccesses++;
  }
  if (auditThisCompletion && auditMode?.full) {
    hotPathAudit.fullScanJobs++;
    if (completion.symbolCount > 0) hotPathAudit.fullScanSuccesses++;
    if (auditMode.reacquire || fullJob?.reacquire) hotPathAudit.reacquireFullScans++;
    else if (auditMode.acquisition || fullJob?.acquisition) hotPathAudit.acquisitionFullScans++;
  }
  if (completion.error) {
    decodeExceptions++;
    lastDecodeError = completion.error;
    notePipelineEvent("decode-exception", decodeExceptions);
  } else if (completion.symbolCount > 0) {
    lastDecodeError = "";
  }
  finishScanCapture(id, completion);
  scanOutcomes.delete(id);
  const attempts = cropAttempts.get(id);
  cropAttempts.delete(id);
  optimizerAttributionComplete(id);
  if (!attempts || completion.repeatSkipped) return;
  for (const attempt of attempts) {
    const region = attempt.region;
    region.decodeAttempts++;
    region.lastAttemptAt = receiverNow();
    region.averageDecodeCostMs = region.averageDecodeCostMs ? region.averageDecodeCostMs * 0.8 + completion.latencyMs * 0.2 : completion.latencyMs;
    const hit = completion.symbols.some((symbol) => symbol.box && regionAt(symbol.box) === region);
    if (region.gridSlot !== void 0) noteSlotMetric(region.gridSlot, hit);
    region.decodeConfidence = region.decodeConfidence * 0.82 + Number(hit) * 0.18;
    if (!hit && ((_a = region.lastHitScanId) != null ? _a : -1) <= id) {
      region.consecutiveMisses++;
      if (region.consecutiveMisses >= 3) region.decoded = false;
    }
  }
}
const REGION_TTL_MS = 5e3;
const SIGHTING_REGION_TTL_MS = 3e3;
const ACQUISITION_SCAN_MS = 45;
const ACQUISITION_FULL_EVERY = 4;
const ACQUISITION_DEEP_EVERY = 13;
const FULL_SCAN_DEGRADED_MS = 250;
const LOCKED_RECOVERY_SCAN_MS = 220;
const GEOMETRY_PROBE_SILENCE_MS = 650;
const GEOMETRY_COLD_MISSES = 3;
// A hard camera bump often leaves a few old slots readable. Waiting for *zero*
// hits lets those survivors pin a badly displaced lattice indefinitely. Once a
// locked wall has demonstrated healthy coverage, treat a short run of severe
// per-job coverage collapse as camera motion and reacquire immediately.
const GEOMETRY_COLLAPSE_MIN_TRACKS = 4;
const GEOMETRY_COLLAPSE_HEALTHY_RATIO = 0.55;
const GEOMETRY_COLLAPSE_BAD_RATIO = 0.28;
const GEOMETRY_COLLAPSE_STREAK = 4;
const GEOMETRY_COLLAPSE_MAX_GAP_MS = 650;
const GEOMETRY_COLLAPSE_MIN_SPAN_MS = 180;
// A short synchronized miss burst is common when a camera exposure crosses a
// display transition. Keep proven geometry alive long enough for tracked
// decoding and occasional generic rescue probes to recover it.
const GEOMETRY_HARD_RESET_MS = 2800;
const CAMERA_MUTATION_SETTLE_MS = 350;
const EXPECTED_REGIONS_DECAY_MS = 1e4;
const MAX_REGIONS = 15;
const REGION_PAD = 0.35;
let cropRotate = 0;
let lastFullScan = 0;
const fullScanJobs = /* @__PURE__ */ new Map();
let expectedRegions = 0;
let expectedRegionsAt = 0;
function decodedCount() {
  let n = 0;
  for (const r of regions) if (r.decoded) n++;
  return n;
}
function regionAt(box) {
  return regions.find((r) => {
    const dx = Math.abs(box.x + box.w / 2 - (r.x + r.w / 2));
    const dy = Math.abs(box.y + box.h / 2 - (r.y + r.h / 2));
    return dx < Math.max(box.w, r.w) / 2 && dy < Math.max(box.h, r.h) / 2;
  });
}
function noteRegion(box, now, decoded = true, info) {
  var _a, _b;
  for (const r of regions) {
    const dx = Math.abs(box.x + box.w / 2 - (r.x + r.w / 2));
    const dy = Math.abs(box.y + box.h / 2 - (r.y + r.h / 2));
    if (dx < Math.max(box.w, r.w) / 2 && dy < Math.max(box.h, r.h) / 2) {
      if (!decoded) {
        r.sightedSeen = now;
        if (!r.decoded) r.seen = now;
        return;
      }
      r.drift = 0.5 * ((_a = r.drift) != null ? _a : 0) + 0.5 * Math.hypot(dx, dy);
      const geometryIsFresh = (info == null ? void 0 : info.scanId) === void 0 || info.scanId >= ((_b = r.lastHitScanId) != null ? _b : -1);
      if (geometryIsFresh) Object.assign(r, box);
      r.seen = now;
      r.decoded = true;
      if (r.gridSlot !== void 0) noteSlotDecoded(r.gridSlot);
      r.decodedSeen = now;
      r.sightedSeen = now;
      lastDecodedRegionSize = Math.max(box.w, box.h);
      if (geometryIsFresh && validQuadObject(info == null ? void 0 : info.quad)) r.quad = info.quad;
      if (geometryIsFresh && (info == null ? void 0 : info.modules)) r.dim = info.modules;
      if (geometryIsFresh && (info == null ? void 0 : info.crc32) !== void 0) r.crc32 = info.crc32;
      r.consecutiveMisses = 0;
      if (geometryIsFresh && (info == null ? void 0 : info.scanId) !== void 0) r.lastHitScanId = info.scanId;
      return;
    }
  }
  if (!decoded) {
    const reference = regions.find((r) => r.decoded);
    const referenceSize = reference ? Math.max(reference.w, reference.h) : lastDecodedRegionSize;
    if (referenceSize) {
      const ratio = Math.max(box.w, box.h) / referenceSize;
      if (ratio < 0.5 || ratio > 2) return;
    } else {
      const coldMinSize = Math.max(24, Math.min(receiverFrameWidth, receiverFrameHeight) * 0.06);
      if (box.w < coldMinSize || box.h < coldMinSize || Math.max(box.w / box.h, box.h / box.w) > 2.25 || box.w * box.h > receiverFrameWidth * receiverFrameHeight * 0.8) return;
      if (regions.some((region) => !region.decoded)) return;
    }
    const missing = Math.max(1, expectedRegions - decodedCount());
    const probationary = regions.filter((r) => !r.decoded);
    if (probationary.length >= missing) {
      const existing = probationary.reduce((a, b) => a.seen > b.seen ? a : b);
      existing.seen = now;
      existing.sightedSeen = now;
      return;
    }
  }
  if (decoded) lastDecodedRegionSize = Math.max(box.w, box.h);
  regions.push({
    ...box,
    id: nextRegionId++,
    seen: now,
    decoded,
    decodedSeen: decoded ? now : void 0,
    sightedSeen: now,
    sequenceSamples: [],
    qualityLevel: 0,
    quad: validQuadObject(info == null ? void 0 : info.quad) ? info.quad : void 0,
    dim: info == null ? void 0 : info.modules,
    crc32: info == null ? void 0 : info.crc32,
    consecutiveMisses: 0,
    detectionConfidence: decoded ? 1 : 0.35,
    decodeConfidence: decoded ? 1 : 0,
    globalGridConfidence: 0,
    visibleFraction: 1,
    pixelsPerModule: 0,
    decodeAttempts: 0,
    decodeSuccesses: 0,
    averageDecodeCostMs: 0,
    lastHitScanId: decoded ? info == null ? void 0 : info.scanId : void 0
  });
  notePipelineEvent(decoded ? "region-decoded-created" : "region-sighting-created", regions.length);
  if (regions.length > MAX_REGIONS) {
    regions.sort((a, b) => Number(b.decoded) - Number(a.decoded) || b.seen - a.seen);
    regions.length = MAX_REGIONS;
  }
}
function markGridRegionDecoded(region, now, info) {
  if (!region) return void 0;
  region.decoded = true;
  region.seen = now;
  region.decodedSeen = now;
  region.sightedSeen = now;
  region.consecutiveMisses = 0;
  region.detectionConfidence = 1;
  region.decodeConfidence = 1;
  region.decodeSuccesses++;
  region.crc32 = info?.crc32 ?? true;
  if (info?.scanId !== void 0)
    region.lastHitScanId = Math.max(region.lastHitScanId ?? -1, info.scanId);
  if (region.gridSlot !== void 0) noteSlotDecoded(region.gridSlot);
  lastDecodedRegionSize = Math.max(lastDecodedRegionSize, region.w || 0, region.h || 0);
  return region;
}
function syncGrid(snapshot, now, decodedSlot, info) {
  lastGridSnapshot = snapshot;
  const shape = `${snapshot.layout.cols}x${snapshot.layout.rows}`;
  if (shape !== gridShape) {
    for (let i = regions.length - 1; i >= 0; i--) if (regions[i].gridSlot !== void 0) regions.splice(i, 1);
    gridShape = shape;
  }
  for (let i = regions.length - 1; i >= 0; i--) if (regions[i].gridSlot === void 0) regions.splice(i, 1);
  let decodedRegion;
  for (const slot of snapshot.slots) {
    if (!slot?.box || !validQuadObject(slot.quad)) continue;
    let region = regions.find((candidate) => candidate.gridSlot === slot.index);
    if (!region) {
      region = {
        ...slot.box,
        id: nextRegionId++,
        seen: now,
        decoded: false,
        sightedSeen: now,
        sequenceSamples: [],
        qualityLevel: 0,
        quad: slot.quad,
        dim: snapshot.modules,
        crc32: true,
        consecutiveMisses: 0,
        gridSlot: slot.index,
        observed: Boolean(slot.observed),
        detectionConfidence: 0,
        decodeConfidence: 0,
        globalGridConfidence: snapshot.confidence,
        visibleFraction: 0,
        pixelsPerModule: 0,
        decodeAttempts: 0,
        decodeSuccesses: 0,
        averageDecodeCostMs: 0
      };
      regions.push(region);
    }
    Object.assign(region, slot.box, {
      quad: slot.quad,
      dim: snapshot.modules,
      observed: Boolean(slot.observed),
      globalGridConfidence: snapshot.confidence
    });
    if (slot.index === decodedSlot)
      decodedRegion = markGridRegionDecoded(region, now, info);
  }
  expectedRegions = snapshot.slots.length;
  expectedRegionsAt = now;
  peakRegions = Math.max(peakRegions, snapshot.slots.length);
  return decodedRegion;
}
function classifyGridSlots(vw, vh) {
  const visible = [];
  for (const region of regions) {
    if (region.gridSlot === void 0 || !region.quad || !region.dim) continue;
    const bounds = trackedQuadBounds(region.quad);
    if (!bounds) {
      region.slotState = "OFFSCREEN";
      region.visibleFraction = 0;
      continue;
    }
    const area = Math.max(1, (bounds.right - bounds.left) * (bounds.bottom - bounds.top));
    const insideWidth = Math.max(0, Math.min(vw, bounds.right) - Math.max(0, bounds.left));
    const insideHeight = Math.max(0, Math.min(vh, bounds.bottom) - Math.max(0, bounds.top));
    region.visibleFraction = insideWidth * insideHeight / area;
    const points = [region.quad.topLeft, region.quad.topRight, region.quad.bottomRight, region.quad.bottomLeft];
    const shortestEdge = Math.min(...points.map((point, index) => {
      const next = points[(index + 1) % 4];
      return Math.hypot(point.x - next.x, point.y - next.y);
    }));
    region.pixelsPerModule = shortestEdge / region.dim;
    if (region.visibleFraction < 0.1) region.slotState = "OFFSCREEN";
    else if (region.visibleFraction < 0.88) region.slotState = "PARTIAL";
    else if (region.consecutiveMisses >= 3) region.slotState = "LOST";
    else if (region.pixelsPerModule < 2) region.slotState = "LOW_QUALITY";
    else region.slotState = "ACTIVE";
    if (region.slotState !== "OFFSCREEN") visible.push(region);
  }
  return visible;
}
function isGridDecodeCandidate(region) {
  return region.slotState === "ACTIVE" || region.slotState === "LOST" || region.slotState === "LOW_QUALITY" || // A narrow clipped edge can remain recoverable through QR error correction
  // and the known transform. Do not spend work on substantially absent codes.
  region.slotState === "PARTIAL" && region.visibleFraction >= 0.85;
}
function slotUsefulness(region) {
  const success = region.decodeAttempts ? region.decodeConfidence : 0.65;
  const quality = Math.min(1.5, region.pixelsPerModule / 4);
  const cost = region.averageDecodeCostMs || 8;
  const stateWeight = region.slotState === "ACTIVE" ? 1 : region.slotState === "LOST" ? 0.35 : region.slotState === "LOW_QUALITY" ? 0.2 : region.slotState === "PARTIAL" ? 0.12 : 0;
  return stateWeight * region.visibleFraction * quality * (0.25 + success) / Math.sqrt(cost);
}
function gridDebugSummary() {
  if (!lastGridSnapshot) return "";
  const slots = regions.filter((region) => region.gridSlot !== void 0);
  const visible = slots.filter((region) => region.slotState !== "OFFSCREEN");
  const active = slots.filter((region) => region.slotState === "ACTIVE");
  const partial = slots.filter((region) => region.slotState === "PARTIAL");
  const offscreen = slots.filter((region) => region.slotState === "OFFSCREEN");
  const best = [...active].sort((a, b) => slotUsefulness(b) - slotUsefulness(a)).slice(0, activeDecodeBudget);
  const avgPpm = best.length ? best.reduce((sum, region) => sum + region.pixelsPerModule, 0) / best.length : 0;
  const successesPerFrame = totalCaptures ? totalDecodes / totalCaptures : 0;
  return `sender ${lastGridSnapshot.layout.cols}×${lastGridSnapshot.layout.rows} · visible ${visible.length}/${slots.length} · active ${active.length} · offscreen ${offscreen.length} · partial ${partial.length} · best ${best.map((region) => region.gridSlot).join(",")} · ${avgPpm.toFixed(1)} px/module · budget ${activeDecodeBudget} · ${successesPerFrame.toFixed(1)} QR/frame · ${liveGoodputKbs(receiverNow()).toFixed(1)} KB/s`;
}
function syncPreviewAspect() {
  if (video.videoWidth && video.videoHeight) cameraBox.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
}
function showNegotiatedWebMode(track, prefix = "") {
  const active = track.getSettings();
  const size = active.width && active.height ? formatCameraSize(active.width, active.height) : "Camera active";
  cameraActual.textContent = `${prefix ? `${prefix} · ` : ""}${size}${active.frameRate ? ` · ${Math.round(active.frameRate)} fps` : ""}`;
}
function sameModeSize(a, b) {
  return a.width === b.width && a.height === b.height || a.width === b.height && a.height === b.width;
}
function formatExposureMs(value) {
  return value === void 0 ? "—" : `${Number((value * 0.1).toPrecision(3))} ms`;
}
function showExposureTime(value) {
  cameraExposureValue.value = formatExposureMs(value);
}
function syncExposureControls() {
  cameraExposureAuto.checked = automaticOptics;
  exposureAxisAuto.checked = automaticExposureAxis;
  isoAxisAuto.checked = automaticIsoAxis;
  cameraOpticsManual.hidden = automaticOptics || cameraExposureControl.hidden;
  opticsAutoActions.hidden = !automaticOptics;
  focusMode.value = manualFocusMode;
  const manualFocus = manualFocusMode === "manual";
  focusDistanceControl.classList.toggle("manual-focus", manualFocus);
  focusMode.hidden = false;
  focusDistance.hidden = !manualFocus;
  focusDistanceValue.hidden = !manualFocus;
  focusAxisReset.hidden = !manualFocus;
  focusAxisName.hidden = manualFocus;
  for (const [automatic, toggle, slider, output, reset, name] of [
    [automaticExposureAxis, exposureAxisToggle, cameraExposure, cameraExposureValue, exposureAxisReset, exposureAxisName],
    [automaticIsoAxis, isoAxisToggle, cameraIso, cameraIsoValue, isoAxisReset, isoAxisName]
  ]) {
    toggle.hidden = !automatic;
    slider.hidden = automatic;
    output.hidden = automatic;
    reset.hidden = automatic;
    name.hidden = !automatic;
  }
}
async function applyExposureSetting(track) {
  var _a, _b;
  const generation = ++exposureApplyGeneration;
  if (automaticOptics || automaticExposureAxis && automaticIsoAxis) {
    delete desiredCamera.exposureTime;
    delete desiredCamera.iso;
    delete desiredCamera.exposureCompensation;
    desiredCamera.exposureMode = "continuous";
    const caps = (_a = track.getCapabilities) == null ? void 0 : _a.call(track);
    const patch = { exposureMode: "continuous" };
    if (caps.exposureCompensation && caps.exposureCompensation.min <= 0 && caps.exposureCompensation.max >= 0) {
      const bias = automaticOptics ? AUTO_QR_EV_BIAS : 0;
      patch.exposureCompensation = quantizeCameraRange(
        Math.max(caps.exposureCompensation.min, Math.min(0, bias)),
        caps.exposureCompensation
      );
    }
    await applyCameraConstraint(track, patch);
    if (generation !== exposureApplyGeneration || track.readyState !== "live") return;
    if (manualExposureFocusPolicy === "requires-hold" && heldFocusRestoreMode) {
      const current = track.getSettings();
      if (current.focusMode === "manual") await applyCameraConstraint(track, { focusMode: heldFocusRestoreMode });
      heldFocusRestoreMode = void 0;
    }
    setTimeout(() => {
      if (generation !== exposureApplyGeneration || track.readyState !== "live") return;
      const actual = track.getSettings();
      if (actual.exposureMode && actual.exposureMode !== "continuous") void applyCameraConstraint(track, patch);
    }, 120);
    return;
  }
  const active = track.getSettings();
  const requestedExposure = automaticExposureAxis ? active.exposureTime : preferredExposureTime;
  const requestedIso = automaticIsoAxis ? active.iso : preferredIso;
  if (requestedExposure === void 0) return;
  // Per-axis Auto borrows the sensor's current value for this transaction only.
  // Do not turn that live AE/ISO reading into the user's saved manual profile.
  if (automaticIsoAxis) delete desiredCamera.iso;
  await applyCameraConstraint(track, {
    exposureMode: "manual",
    exposureTime: requestedExposure,
    ...requestedIso !== void 0 ? { iso: requestedIso } : {}
  });
  if (generation !== exposureApplyGeneration || track.readyState !== "live") return;
  cameraExposure.value = String(requestedExposure);
  showExposureTime(requestedExposure);
  if (requestedIso !== void 0) {
    cameraIso.value = String(requestedIso);
    cameraIsoValue.value = String(Number(requestedIso.toPrecision(4)));
  }
}
function resetAutomaticOpticsRuntime() {
  autoOpticsRuntimeState = "ae";
  autoOpticsMutationRunning = false;
  autoOpticsLockSince = 0;
  autoOpticsRetryAt = 0;
  autoOpticsAcquisitionSince = 0;
  autoOpticsRescueRetryAt = 0;
  autoOpticsHoldSample = void 0;
  autoOpticsHoldCollapseSince = 0;
  autoOpticsHeldYield = 0;
  autoOpticsAeBaseline = void 0;
  autoOpticsMemoryBootAt = 0;
  autoOpticsMemoryBoot = void 0;
  autoOpticsTuneSummary = "";
}
function quantizeCameraRange(value, range) {
  const clamped = Math.max(range.min, Math.min(range.max, value));
  if (!range.step || range.step <= 0) return clamped;
  return Math.max(range.min, Math.min(range.max,
    range.min + Math.round((clamped - range.min) / range.step) * range.step
  ));
}
function automaticOpticsSessionAlive(track) {
  return automaticOptics && !done && track?.readyState === "live" && stream?.getVideoTracks()[0] === track;
}
function autoOpticsVisibleSlots() {
  return regions.reduce((count, region) => count + Number(region.gridSlot !== void 0 && region.slotState !== "OFFSCREEN"), 0);
}
function autoOpticsPoseSnapshot() {
  const geometry = focusGeometry();
  const visible = autoOpticsVisibleSlots();
  const expected = Math.max(visible, Number(expectedRegions) || 0);
  return {
    at: receiverNow(),
    locked: Boolean(gridLattice.locked),
    visible,
    expected,
    x: Number(geometry?.x),
    y: Number(geometry?.y),
    scale: Number(geometry?.scale)
  };
}
function autoOpticsPoseUsable(pose) {
  if (!pose?.locked || !Number.isFinite(pose.x) || !Number.isFinite(pose.y) || !(pose.scale > 0)) return false;
  const expected = Math.max(1, pose.expected || pose.visible || 1);
  return pose.visible >= Math.min(expected, AUTO_OPTICS_MIN_VISIBLE_SLOTS);
}
function autoOpticsPoseDrift(a, b) {
  if (!autoOpticsPoseUsable(a) || !autoOpticsPoseUsable(b)) return { center: Infinity, scale: Infinity };
  return {
    center: Math.hypot(b.x - a.x, b.y - a.y),
    scale: Math.abs(Math.log2(b.scale / a.scale))
  };
}
async function waitForStableAutoOpticsPose(track, timeoutMs = AUTO_OPTICS_POSE_WAIT_MS) {
  const started = performance.now();
  let stableSince = 0;
  let anchorPose;
  while (performance.now() - started < timeoutMs) {
    if (!automaticOpticsSessionAlive(track)) return false;
    const pose = autoOpticsPoseSnapshot();
    if (!autoOpticsPoseUsable(pose)) {
      stableSince = 0;
      anchorPose = void 0;
    } else if (!anchorPose) {
      anchorPose = pose;
      stableSince = performance.now();
    } else {
      const drift = autoOpticsPoseDrift(anchorPose, pose);
      if (drift.center > AUTO_OPTICS_POSE_MAX_CENTER_DRIFT || drift.scale > AUTO_OPTICS_POSE_MAX_SCALE_LOG2) {
        anchorPose = pose;
        stableSince = performance.now();
      } else if (performance.now() - stableSince >= AUTO_OPTICS_POSE_STABLE_MS) {
        return true;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 45));
  }
  return false;
}
function autoOpticsMemoryKey(track) {
  const settings = track?.getSettings?.() ?? {};
  return String(settings.deviceId || track?.label || settings.facingMode || "default");
}
function autoOpticsHistoryConfigKey(exposure, iso) {
  return `${Number(exposure).toFixed(2)}/${Number(iso).toFixed(1)}`;
}
function readAutomaticOpticsHistory(track) {
  try {
    const all = JSON.parse(localStorage.getItem(AUTO_OPTICS_HISTORY_KEY) || "{}");
    const raw = Array.isArray(all[autoOpticsMemoryKey(track)]) ? all[autoOpticsMemoryKey(track)] : [];
    const now = Date.now();
    const groups = new Map();
    for (const item of raw) {
      if (!item || !Number.isFinite(item.exposure) || !Number.isFinite(item.iso) || item.exposure <= 0 || item.iso <= 0) continue;
      if (now - Number(item.at || 0) > AUTO_OPTICS_HISTORY_MAX_AGE_MS) continue;
      const key = autoOpticsHistoryConfigKey(item.exposure, item.iso);
      const group = groups.get(key) || [];
      group.push(item);
      groups.set(key, group);
    }
    const candidates = [];
    for (const group of groups.values()) {
      group.sort((a, b) => Number(b.at || 0) - Number(a.at || 0));
      const latest = group[0];
      if (Number(latest.validDecodes || 0) <= 0 && now - Number(latest.at || 0) < AUTO_OPTICS_HISTORY_BAD_COOLDOWN_MS) continue;
      const good = group.find((item) => Number(item.validDecodes || 0) > 0 || Number(item.rate || 0) > 0);
      if (good) candidates.push(good);
    }
    const priority = (item) => {
      const age = Math.max(0, now - Number(item.at || 0));
      const freshness = Math.exp(-age / (6 * 60 * 60 * 1000));
      return freshness * (1 + Math.min(4, Number(item.rate || 0) / 20) + Math.min(2, Number(item.yieldRate || 0) * 2));
    };
    candidates.sort((a, b) => priority(b) - priority(a));
    return candidates;
  } catch {
    return [];
  }
}
function bestAutomaticOpticsHistory(track) {
  return readAutomaticOpticsHistory(track)[0];
}
function rememberAutomaticOpticsHistory(track, exposure, iso, performance) {
  if (!Number.isFinite(exposure) || !Number.isFinite(iso) || exposure <= 0 || iso <= 0 || !performance) return;
  try {
    const all = JSON.parse(localStorage.getItem(AUTO_OPTICS_HISTORY_KEY) || "{}");
    const key = autoOpticsMemoryKey(track);
    const raw = Array.isArray(all[key]) ? all[key] : [];
    raw.unshift({
      exposure,
      iso,
      rate: Number(performance.validDecodesPerSecond || 0),
      yieldRate: Number(performance.perQrAttemptSuccessRate || 0),
      validDecodes: Number(performance.validDecodes || 0),
      qrAttempts: Number(performance.qrAttempts || 0),
      sourceFrames: Number(performance.sourceFrames || 0),
      at: Date.now()
    });
    all[key] = raw.slice(0, AUTO_OPTICS_HISTORY_LIMIT);
    const deviceEntries = Object.entries(all).slice(-8);
    localStorage.setItem(AUTO_OPTICS_HISTORY_KEY, JSON.stringify(Object.fromEntries(deviceEntries)));
  } catch {
  }
}
function readAutomaticOpticsMemory(track) {
  try {
    const all = JSON.parse(localStorage.getItem(AUTO_OPTICS_MEMORY_KEY) || "{}");
    const saved = all?.[autoOpticsMemoryKey(track)];
    if (!saved || !Number.isFinite(saved.iso) || !Number.isFinite(saved.exposure) || saved.iso <= 0 || saved.exposure <= 0)
      return void 0;
    return saved;
  } catch {
    return void 0;
  }
}
function usableAutomaticOpticsMemory(track) {
  const saved = readAutomaticOpticsMemory(track);
  if (!saved || Date.now() - Number(saved.at || 0) > AUTO_OPTICS_MEMORY_FRESH_MS) return void 0;
  if (saved.invalidatedAt && Date.now() - Number(saved.invalidatedAt) < AUTO_OPTICS_HISTORY_BAD_COOLDOWN_MS) return void 0;
  const scale = Number(saved.lightScale);
  if (Number.isFinite(scale) && scale >= AUTO_OPTICS_MEMORY_MIN_SCALE && scale <= AUTO_OPTICS_MEMORY_MAX_SCALE)
    return saved;
  // Old v1 entries remain useful for post-lock comparison, but never get the
  // high-confidence cold-start treatment because they lack an AE-relative scale.
  return saved;
}
function loadAutomaticOpticsMemory(track, exposure, isoRange, cap, aeProduct) {
  const saved = usableAutomaticOpticsMemory(track);
  if (!saved) return void 0;
  const scale = Number(saved.lightScale);
  const adjusted = Number.isFinite(scale) && Number.isFinite(aeProduct) && aeProduct > 0
    ? aeProduct * scale / Math.max(1e-6, exposure)
    : saved.iso * saved.exposure / Math.max(1e-6, exposure);
  return quantizeCameraRange(Math.min(cap, Math.max(isoRange.min, adjusted)), isoRange);
}
function automaticOpticsMemoryHealthy(saved) {
  return Boolean(saved && Number(saved.yieldRate) >= AUTO_OPTICS_MEMORY_MIN_YIELD &&
    Number.isFinite(saved.exposure) && saved.exposure > 0 && Number.isFinite(saved.iso) && saved.iso > 0);
}
function cameraSettingNear(value, target, range) {
  if (!Number.isFinite(value) || !Number.isFinite(target)) return false;
  const step = Number(range?.step) || 0;
  return Math.abs(value - target) <= Math.max(step * 0.75, Math.abs(target) * 0.02, 1e-6);
}
async function primeAutomaticQrOpticsStartup(track) {
  if (!automaticOpticsSessionAlive(track) || autoOpticsMutationRunning) return;
  const caps = track.getCapabilities?.() ?? {};
  const exposureRange = caps.exposureTime;
  const isoRange = caps.iso;
  const saved = usableAutomaticOpticsMemory(track) ?? bestAutomaticOpticsHistory(track);
  const canRestore = automaticOpticsMemoryHealthy(saved) &&
    Array.isArray(caps.exposureMode) && caps.exposureMode.includes("manual") && exposureRange && isoRange;

  if (!canRestore) {
    autoOpticsRuntimeState = "ae";
    autoOpticsMemoryBootAt = 0;
    autoOpticsMemoryBoot = void 0;
    await applyExposureSetting(track);
    if (automaticOpticsSessionAlive(track)) {
      autoOpticsAcquisitionSince = receiverNow();
      autoOpticsTuneSummary = saved ? "recent winner not proven enough · hardware AE" : "hardware AE";
    }
    return;
  }

  const exposure = quantizeCameraRange(saved.exposure, exposureRange);
  const iso = quantizeCameraRange(saved.iso, isoRange);
  autoOpticsMutationRunning = true;
  try {
    const accepted = await applyCameraConstraint(track, {
      exposureMode: "manual",
      exposureTime: exposure,
      iso
    });
    if (!automaticOpticsSessionAlive(track)) return;
    const actual = track.getSettings();
    const restored = accepted && actual.exposureMode === "manual" &&
      cameraSettingNear(actual.exposureTime, exposure, exposureRange) &&
      cameraSettingNear(actual.iso, iso, isoRange);
    if (!restored) {
      await applyExposureSetting(track);
      if (!automaticOpticsSessionAlive(track)) return;
      autoOpticsRuntimeState = "ae";
      autoOpticsMemoryBootAt = 0;
      autoOpticsMemoryBoot = void 0;
      autoOpticsAcquisitionSince = receiverNow();
      autoOpticsTuneSummary = "recent winner rejected by camera · hardware AE";
      focusController.adoptAutomaticCameraState("recent automatic optics could not be restored; hardware AE");
      return;
    }

    const now = receiverNow();
    autoOpticsRuntimeState = "memory";
    autoOpticsMemoryBootAt = now;
    autoOpticsMemoryBoot = {
      exposure: Number(actual.exposureTime) || exposure,
      iso: Number(actual.iso) || iso,
      yieldRate: Number(saved.yieldRate) || 0
    };
    autoOpticsAcquisitionSince = now;
    autoOpticsRetryAt = Infinity;
    autoOpticsRescueRetryAt = 0;
    autoOpticsHeldYield = autoOpticsMemoryBoot.yieldRate;
    autoOpticsTuneSummary = `startup winner · ${formatExposureMs(autoOpticsMemoryBoot.exposure)} · ISO ${Math.round(autoOpticsMemoryBoot.iso)} · prior ${(autoOpticsHeldYield * 100).toFixed(0)}% · validating`;
    focusController.adoptAutomaticCameraState("restored recent QR-proven automatic optics; validating live decode");
    notePipelineEvent("auto-optics-memory-start");
  } finally {
    autoOpticsMutationRunning = false;
  }
}
async function abandonAutomaticOpticsStartupMemory(track, reason = "startup winner produced no QR") {
  if (autoOpticsMutationRunning || !automaticOpticsSessionAlive(track) || autoOpticsRuntimeState !== "memory") return;
  autoOpticsMutationRunning = true;
  try {
    await applyExposureSetting(track);
    if (!automaticOpticsSessionAlive(track)) return;
    const now = receiverNow();
    autoOpticsRuntimeState = "ae";
    autoOpticsMemoryBootAt = 0;
    autoOpticsMemoryBoot = void 0;
    autoOpticsLockSince = 0;
    autoOpticsAcquisitionSince = now;
    autoOpticsRetryAt = 0;
    autoOpticsRescueRetryAt = now + 900;
    autoOpticsHoldSample = void 0;
    autoOpticsHoldCollapseSince = 0;
    autoOpticsHeldYield = 0;
    autoOpticsTuneSummary = `${reason} · hardware AE fallback`;
    focusController.adoptAutomaticCameraState("recent automatic optics unconfirmed; hardware AE fallback");
    notePipelineEvent("auto-optics-memory-fallback");
  } finally {
    autoOpticsMutationRunning = false;
  }
}
function rememberAutomaticOptics(track, exposure, iso, score = 0, yieldRate = 0, aeProduct = 0) {
  if (!Number.isFinite(exposure) || !Number.isFinite(iso) || exposure <= 0 || iso <= 0) return;
  const lightScale = Number.isFinite(aeProduct) && aeProduct > 0 ? exposure * iso / aeProduct : void 0;
  try {
    const all = JSON.parse(localStorage.getItem(AUTO_OPTICS_MEMORY_KEY) || "{}");
    all[autoOpticsMemoryKey(track)] = {
      exposure,
      iso,
      score: Number.isFinite(score) ? score : 0,
      yieldRate: Number.isFinite(yieldRate) ? yieldRate : 0,
      ...(Number.isFinite(lightScale) ? { lightScale } : {}),
      at: Date.now()
    };
    const entries = Object.entries(all).sort((a, b) => Number(b[1]?.at || 0) - Number(a[1]?.at || 0)).slice(0, 8);
    localStorage.setItem(AUTO_OPTICS_MEMORY_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
  }
}
function forgetAutomaticOptics(track) {
  try {
    const all = JSON.parse(localStorage.getItem(AUTO_OPTICS_MEMORY_KEY) || "{}");
    const key = autoOpticsMemoryKey(track);
    const saved = all[key];
    if (!saved || typeof saved !== "object") return;
    saved.invalidatedAt = Date.now();
    all[key] = saved;
    localStorage.setItem(AUTO_OPTICS_MEMORY_KEY, JSON.stringify(all));
  } catch {
  }
}
function autoOpticsPipelineSnapshot() {
  return {
    at: receiverNow(),
    outputs: Number(livePipeline?.trackedOutputSymbols || 0),
    attempts: Number(livePipeline?.submittedTracks || 0),
    jobs: Number(livePipeline?.submittedTracked || 0)
  };
}
async function recoverCollapsedAutomaticOptics(track, yieldRate, reason = "held optics collapsed") {
  if (autoOpticsMutationRunning || !automaticOptics || !automaticOpticsSessionAlive(track)) return;
  autoOpticsMutationRunning = true;
  try {
    forgetAutomaticOptics(track);
    await applyExposureSetting(track);
    if (!automaticOpticsSessionAlive(track)) return;
    autoOpticsRuntimeState = "ae";
    autoOpticsLockSince = 0;
    autoOpticsAcquisitionSince = receiverNow();
    autoOpticsRetryAt = receiverNow() + AUTO_OPTICS_COLLAPSE_RETRY_MS;
    autoOpticsHoldSample = void 0;
    autoOpticsHoldCollapseSince = 0;
    autoOpticsHeldYield = 0;
    autoOpticsTuneSummary = `${reason} ${(yieldRate * 100).toFixed(0)}% · memory cooled · hardware AE reacquire`;
    focusController.adoptAutomaticCameraState("automatic optics live yield degraded; hardware AE reacquire");
    notePipelineEvent("auto-optics-hold-collapse");
  } finally {
    autoOpticsMutationRunning = false;
  }
}
async function waitForAutoOptics(ms, track) {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    if (!automaticOpticsSessionAlive(track)) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(40, Math.max(1, until - performance.now()))));
  }
  return automaticOpticsSessionAlive(track);
}
function autoOpticsConfidenceScore(outputs, attempts) {
  if (!(attempts > 0)) return 0;
  const p = Math.max(0, Math.min(1, outputs / attempts));
  const z = 1;
  const z2 = z * z;
  const denom = 1 + z2 / attempts;
  const center = p + z2 / (2 * attempts);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * attempts)) / attempts);
  return Math.max(0, (center - margin) / denom);
}
async function sampleAutomaticOpticsQuality(track, iso, sampleMs = AUTO_OPTICS_GAIN_SAMPLE_MS, poseWaitMs = AUTO_OPTICS_POSE_WAIT_MS) {
  if (!await waitForStableAutoOpticsPose(track, poseWaitMs)) {
    return {
      outputs: 0, attempts: 0, jobs: 0, rate: 0, yieldRate: 0, tracksPerJob: 0, score: 0,
      valid: false, unstable: true
    };
  }
  const before = autoOpticsPipelineSnapshot();
  const poseAnchor = autoOpticsPoseSnapshot();
  let minVisible = poseAnchor.visible;
  let maxCenterDrift = 0;
  let maxScaleDrift = 0;
  let poseStable = autoOpticsPoseUsable(poseAnchor);
  const sampleUntil = performance.now() + sampleMs;
  while (performance.now() < sampleUntil) {
    if (!automaticOpticsSessionAlive(track)) return null;
    await new Promise((resolve) => setTimeout(resolve, Math.min(40, Math.max(1, sampleUntil - performance.now()))));
    const pose = autoOpticsPoseSnapshot();
    minVisible = Math.min(minVisible, pose.visible);
    const drift = autoOpticsPoseDrift(poseAnchor, pose);
    maxCenterDrift = Math.max(maxCenterDrift, drift.center);
    maxScaleDrift = Math.max(maxScaleDrift, drift.scale);
    if (!autoOpticsPoseUsable(pose) || drift.center > AUTO_OPTICS_POSE_MAX_CENTER_DRIFT || drift.scale > AUTO_OPTICS_POSE_MAX_SCALE_LOG2)
      poseStable = false;
  }
  const after = autoOpticsPipelineSnapshot();
  const elapsed = Math.max(0.001, (after.at - before.at) / 1e3);
  const outputs = Math.max(0, after.outputs - before.outputs);
  const attempts = Math.max(0, after.attempts - before.attempts);
  const jobs = Math.max(0, after.jobs - before.jobs);
  const rate = outputs / elapsed;
  const yieldRate = attempts ? outputs / attempts : 0;
  const tracksPerJob = jobs ? attempts / jobs : 0;
  // Optics quality must not be confused with CPU scheduling. Screen recording,
  // thermal load, and worker contention can change jobs/s without changing the
  // camera image. Rank candidates by a conservative per-QR success estimate;
  // rate remains diagnostic/tie-break information only.
  const score = autoOpticsConfidenceScore(outputs, attempts);
  return {
    iso, outputs, attempts, jobs, rate, yieldRate, tracksPerJob, score,
    minVisible, maxCenterDrift, maxScaleDrift, unstable: !poseStable,
    valid: poseStable && attempts >= AUTO_OPTICS_GAIN_MIN_ATTEMPTS && jobs >= 2
  };
}
async function measureAutomaticIsoCandidate(track, exposure, requestedIso, isoRange, options = {}) {
  if (!automaticOpticsSessionAlive(track)) return null;
  const iso = quantizeCameraRange(requestedIso, isoRange);
  const accepted = await applyCameraConstraint(track, {
    exposureMode: "manual",
    exposureTime: exposure,
    iso
  });
  if (!accepted || !automaticOpticsSessionAlive(track)) return null;
  const settleMs = options.settleMs ?? AUTO_OPTICS_GAIN_SETTLE_MS;
  const sampleMs = options.sampleMs ?? AUTO_OPTICS_GAIN_SAMPLE_MS;
  const poseWaitMs = options.poseWaitMs ?? AUTO_OPTICS_POSE_WAIT_MS;
  if (!await waitForAutoOptics(settleMs, track)) return null;
  const sample = await sampleAutomaticOpticsQuality(track, iso, sampleMs, poseWaitMs);
  if (!sample) return null;
  const actualIso = Number(track.getSettings().iso);
  return {
    ...sample,
    iso: Number.isFinite(actualIso) ? actualIso : iso,
    requestedIso: iso
  };
}
function describeAutoIsoProbe(probe) {
  if (!probe) return "—";
  if (probe.unstable) return `${Math.round(probe.iso)}:move/reframe`;
  if (!probe.valid) return `${Math.round(probe.iso)}:insufficient`;
  return `${Math.round(probe.iso)}:${probe.rate.toFixed(0)}/s ${(probe.yieldRate * 100).toFixed(0)}%`;
}
async function tuneAutomaticQrIso(track, exposure, aeBaseIso, isoRange, maxAutoIso, rememberedIso) {
  // The per-axis Auto flags belong to manual Optics mode. When the top-level
  // Optics controller is Auto, it owns exposure + gain for its one-time camera
  // calibration. A previously hand-pinned ISO must not silently disable this
  // search while the manual controls are hidden. Preserve the pin for the next
  // time the user explicitly switches Optics off, but ignore it here.
  if (!automaticOpticsSessionAlive(track)) return { iso: aeBaseIso, probes: [] };
  autoOpticsRuntimeState = "tuning";
  autoOpticsTuneSummary = rememberedIso ? `memory ${Math.round(rememberedIso)} · calibrating ISO` : "calibrating ISO";

  const cap = Math.max(isoRange.min, Math.min(isoRange.max, maxAutoIso));
  const aeBase = quantizeCameraRange(Math.min(cap, aeBaseIso), isoRange);
  const remembered = Number.isFinite(rememberedIso)
    ? quantizeCameraRange(Math.min(cap, Math.max(isoRange.min, rememberedIso)), isoRange)
    : void 0;
  // Always establish the fresh AE-derived QR baseline first. Memory is only an
  // additional candidate and never replaces the current scene measurement.
  const base = aeBase;
  const probes = [];
  const measured = new Set();
  const probe = async (candidate) => {
    const requested = quantizeCameraRange(Math.min(cap, Math.max(isoRange.min, candidate)), isoRange);
    const key = String(requested);
    if (measured.has(key)) return probes.find((item) => String(item.requestedIso) === key) || null;
    if (measured.size >= AUTO_OPTICS_GAIN_MAX_PROBES) return null;
    measured.add(key);
    let result = null;
    for (let window = 0; window < 2 && automaticOpticsSessionAlive(track); window++) {
      result = await measureAutomaticIsoCandidate(track, exposure, requested, isoRange);
      if (!result?.unstable) break;
      autoOpticsTuneSummary = `QR ${AUTO_QR_EV_BIAS.toFixed(1)}EV · ${probes.map(describeAutoIsoProbe).join(" · ")}${probes.length ? " · " : ""}${Math.round(requested)}:hold framing`;
    }
    if (result) probes.push(result);
    autoOpticsTuneSummary = `QR ${AUTO_QR_EV_BIAS.toFixed(1)}EV · ${probes.map(describeAutoIsoProbe).join(" · ")}`;
    return result;
  };
  const scoreOf = (item) => item?.valid ? item.score : 0;
  const better = (candidate, incumbent) => scoreOf(candidate) > scoreOf(incumbent) * AUTO_OPTICS_GAIN_IMPROVEMENT;
  const chooseWinner = (items) => {
    const validItems = items.filter((item) => item?.valid);
    if (!validItems.length) return null;
    return validItems.reduce((winner, item) => {
      if (better(item, winner)) return item;
      // Within ~1.5% confidence, lower ISO wins. On an emissive QR wall this
      // reduces clipping/bloom and leaves more motion/noise headroom.
      if (item.score >= winner.score * AUTO_OPTICS_DARK_TIE_RATIO && item.requestedIso < winner.requestedIso) return item;
      return winner;
    });
  };

  const baseline = await probe(base);
  if (!automaticOpticsSessionAlive(track)) return { iso: base, probes };

  // A remembered setting darker than today's baseline is safe to test early. A
  // brighter memory is deferred unless today's darker baseline is struggling.
  if (remembered !== void 0 && remembered < base * 0.96) {
    await probe(remembered);
    if (!automaticOpticsSessionAlive(track)) return { iso: base, probes };
  }

  let incumbent = chooseWinner(probes) || baseline;
  const darkAnchor = Math.min(base, incumbent?.requestedIso || base);
  const darker = await probe(darkAnchor / Math.SQRT2);
  if (!automaticOpticsSessionAlive(track)) return { iso: base, probes };
  const darkHeld = darker?.valid && (better(darker, incumbent) || darker.score >= scoreOf(incumbent) * AUTO_OPTICS_DARK_TIE_RATIO);
  incumbent = chooseWinner(probes) || incumbent;

  if (darkHeld) {
    await probe(darker.requestedIso / Math.SQRT2);
    if (!automaticOpticsSessionAlive(track)) return { iso: base, probes };
  } else {
    const baselineWeak = !baseline?.valid || baseline.yieldRate < AUTO_OPTICS_STARTUP_HEALTHY_YIELD;
    if (remembered !== void 0 && remembered > base * 1.04 && baselineWeak) {
      await probe(remembered);
      if (!automaticOpticsSessionAlive(track)) return { iso: base, probes };
      incumbent = chooseWinner(probes) || incumbent;
    }
    // Do not brighten a healthy darker baseline just because we have probe
    // budget. Brighter settings must be justified by weak decode evidence.
    if (baselineWeak && measured.size < AUTO_OPTICS_GAIN_MAX_PROBES) {
      const brightAnchor = Math.max(base, incumbent?.requestedIso || base);
      const brighter = await probe(brightAnchor * Math.SQRT2);
      if (!automaticOpticsSessionAlive(track)) return { iso: base, probes };
      if (better(brighter, incumbent) && measured.size < AUTO_OPTICS_GAIN_MAX_PROBES)
        await probe(brighter.requestedIso * Math.SQRT2);
    }
  }

  const valid = probes.filter((item) => item.valid);
  if (!valid.length) {
    autoOpticsTuneSummary = `${remembered ? `memory ${Math.round(remembered)} · ` : ""}${probes.map(describeAutoIsoProbe).join(" · ")} · deferred: reframe`;
    return { iso: base, probes, deferred: true };
  }
  const best = chooseWinner(valid);
  if (best.yieldRate < AUTO_OPTICS_COLLAPSE_YIELD) {
    autoOpticsTuneSummary = `${remembered ? `memory ${Math.round(remembered)} · ` : ""}${probes.map(describeAutoIsoProbe).join(" · ")} · collapsed ${(best.yieldRate * 100).toFixed(0)}%`;
    return { iso: base, probes, best, collapsed: true };
  }
  const finalIso = quantizeCameraRange(Math.min(cap, best.iso || best.requestedIso || base), isoRange);
  if (automaticOpticsSessionAlive(track)) {
    const actual = Number(track.getSettings().iso);
    const step = Number(isoRange.step) || 0;
    if (!Number.isFinite(actual) || Math.abs(actual - finalIso) > Math.max(step * 0.75, finalIso * 0.02))
      await applyCameraConstraint(track, { exposureMode: "manual", exposureTime: exposure, iso: finalIso });
  }
  autoOpticsTuneSummary = `${remembered ? `memory ${Math.round(remembered)} · ` : ""}${probes.map(describeAutoIsoProbe).join(" · ")} → ${Math.round(finalIso)}`;
  return { iso: finalIso, probes, best };
}
async function settleAutomaticQrOptics(track, now) {
  if (autoOpticsMutationRunning || !automaticOptics || now < autoOpticsRetryAt) return;
  const caps = track.getCapabilities?.() ?? {};
  const exposureRange = caps.exposureTime;
  const isoRange = caps.iso;
  const settings = track.getSettings();
  if (!Array.isArray(caps.exposureMode) || !caps.exposureMode.includes("manual") ||
      !exposureRange || !isoRange || !Number.isFinite(settings.exposureTime) ||
      !Number.isFinite(settings.iso) || settings.exposureTime <= 0 || settings.iso <= 0) {
    autoOpticsRetryAt = now + 2500;
    return;
  }
  const fps = Math.max(12, Math.min(120, Number(settings.frameRate) || 30));
  // exposureTime is reported in 0.1 ms units on Chromium camera controls.
  // 30% of a frame is 10 ms at 30 fps / 5 ms at 60 fps: short enough to cut
  // handheld/display-transition blur without demanding extreme gain.
  const motionSafeExposure = 1e4 / fps * AUTO_OPTICS_SHUTTER_FRAME_FRACTION;
  const savedAe = autoOpticsAeBaseline && receiverNow() - autoOpticsAeBaseline.at < 9000
    ? autoOpticsAeBaseline
    : void 0;
  const aeExposure = savedAe?.exposure ?? settings.exposureTime;
  const aeIso = savedAe?.iso ?? settings.iso;
  const aeExposureProduct = aeExposure * aeIso;
  const exposureProduct = aeExposureProduct * AUTO_QR_LIGHT_SCALE;
  let exposure = quantizeCameraRange(Math.min(aeExposure, motionSafeExposure), exposureRange);
  const maxAutoIso = Math.min(
    isoRange.max,
    Math.max(isoRange.min, aeExposureProduct / Math.max(exposureRange.min, exposure))
  );
  let iso = quantizeCameraRange(exposureProduct / Math.max(exposureRange.min, exposure), isoRange);
  if (iso > maxAutoIso) {
    iso = quantizeCameraRange(maxAutoIso, isoRange);
    exposure = quantizeCameraRange(exposureProduct / Math.max(isoRange.min, iso), exposureRange);
  }
  // Re-quantize gain after shutter quantization so the final manual state stays
  // at the deliberate QR darkness target rather than drifting back toward AE.
  iso = quantizeCameraRange(exposureProduct / Math.max(exposureRange.min, exposure), isoRange);
  autoOpticsMutationRunning = true;
  autoOpticsRuntimeState = "settling";
  // Exposure changes do not invalidate already captured QR payloads or lattice
  // geometry. Keep decoding through the one-time AE -> manual handoff instead
  // of throwing away work and restarting every worker. The HAL may emit a few
  // transitional frames; those are ordinary erasures and RaptorQ can absorb
  // them without an artificial receiver blackout.
  notePipelineEvent("auto-optics-seamless-handoff");
  try {
    const accepted = await applyCameraConstraint(track, {
      exposureMode: "manual",
      exposureTime: exposure,
      iso
    });
    if (!accepted || track.readyState !== "live") {
      autoOpticsRuntimeState = "ae";
      autoOpticsRetryAt = receiverNow() + 2200;
      return;
    }
    const rememberedIso = loadAutomaticOpticsMemory(track, exposure, isoRange, maxAutoIso, aeExposureProduct);
    const tuned = await tuneAutomaticQrIso(track, exposure, iso, isoRange, maxAutoIso, rememberedIso);
    if (!automaticOpticsSessionAlive(track)) return;
    if (tuned.deferred || tuned.collapsed) {
      // Movement makes samples incomparable; catastrophic yield means the whole
      // local manual neighborhood is wrong. In either case, restore hardware AE
      // instead of preserving a bad relative winner.
      const collapsedYield = tuned.best?.yieldRate ?? 0;
      await applyExposureSetting(track);
      autoOpticsRuntimeState = "ae";
      autoOpticsLockSince = 0;
      autoOpticsAcquisitionSince = receiverNow();
      autoOpticsRetryAt = receiverNow() + (tuned.collapsed ? AUTO_OPTICS_COLLAPSE_RETRY_MS : 800);
      if (tuned.collapsed) {
        forgetAutomaticOptics(track);
        autoOpticsTuneSummary = `collapsed ${(collapsedYield * 100).toFixed(0)}% · memory cooled · hardware AE reacquire`;
        focusController.adoptAutomaticCameraState("automatic optics collapsed; hardware AE reacquire");
      }
      return;
    }
    autoOpticsRuntimeState = "manual";
    autoOpticsHoldSample = autoOpticsPipelineSnapshot();
    autoOpticsHoldCollapseSince = 0;
    autoOpticsHeldYield = tuned.best?.yieldRate ?? 0;
    // A proven winner is held absolutely still. Recalibration is evidence-driven
    // by the live-yield watchdog below, not by periodic brightness probes.
    autoOpticsRetryAt = Infinity;
    const tunedExposure = track.getSettings().exposureTime ?? exposure;
    const tunedIso = track.getSettings().iso ?? tuned.iso ?? iso;
    if (tuned.best?.valid && tuned.best.yieldRate >= AUTO_OPTICS_MEMORY_MIN_YIELD)
      rememberAutomaticOptics(track, tunedExposure, tunedIso, tuned.best.score, tuned.best.yieldRate, aeExposureProduct);
    autoOpticsAeBaseline = void 0;
    focusController.adoptAutomaticCameraState("automatic QR exposure tuned against live tracked decode yield");
  } finally {
    autoOpticsMutationRunning = false;
  }
}
async function releaseAutomaticQrOptics(track, now) {
  // Kept for explicit/session-level resets only. Normal target loss must not
  // bounce the camera back into continuous AE.
  if (autoOpticsMutationRunning || !automaticOptics) return;
  autoOpticsMutationRunning = true;
  autoOpticsRuntimeState = "settling";
  holdDecoderForCameraMutation("automatic optics session reset", 280);
  try {
    autoOpticsRetryAt = 0;
    autoOpticsHeldYield = 0;
    autoOpticsAeBaseline = void 0;
    await applyExposureSetting(track);
    autoOpticsRuntimeState = "ae";
    autoOpticsLockSince = 0;
    focusController.adoptAutomaticCameraState("hardware AE restored for new optics session");
  } finally {
    autoOpticsMutationRunning = false;
  }
}
function shuffleAutomaticOpticsCandidates(items) {
  const result = [...items];
  const random = () => {
    try {
      const value = new Uint32Array(1);
      crypto.getRandomValues(value);
      return value[0] / 4294967296;
    } catch {
      return Math.random();
    }
  };
  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}
function buildAutomaticOpticsAcquisitionCandidates(track, aeBaseline, exposureRange, isoRange, fps) {
  const motionSafeExposure = 1e4 / fps * AUTO_OPTICS_SHUTTER_FRAME_FRACTION;
  const safeExposure = quantizeCameraRange(
    Math.min(exposureRange.max, AUTO_OPTICS_ACQUIRE_SCAN_MAX_EXPOSURE, motionSafeExposure),
    exposureRange
  );
  const minIso = quantizeCameraRange(isoRange.min, isoRange);
  const candidates = [];
  const seen = new Set();
  const add = (exposureRaw, isoRaw, label, priority = false) => {
    const exposure = quantizeCameraRange(exposureRaw, exposureRange);
    const iso = quantizeCameraRange(isoRaw, isoRange);
    const key = autoOpticsHistoryConfigKey(exposure, iso);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ exposure, iso, label, priority });
  };

  for (const item of readAutomaticOpticsHistory(track).slice(0, 3))
    add(item.exposure, item.iso, "learned", true);
  const memory = usableAutomaticOpticsMemory(track);
  if (memory) add(memory.exposure, memory.iso, "recent winner", true);
  // This is the most important general bootstrap on a 30 fps phone: 10 ms at
  // minimum gain. It is frame-safe, low-noise, and unlike the old algorithm it
  // remains reachable even when hardware AE starts at a 1-2 ms shutter.
  add(safeExposure, minIso, "frame-safe", true);

  const explore = [];
  const pushExplore = (exposure, iso, label) => {
    const before = candidates.length;
    add(exposure, iso, label, false);
    if (candidates.length > before) explore.push(candidates.pop());
  };
  pushExplore(safeExposure * 0.72, minIso, "shorter");
  pushExplore(safeExposure * 0.48, minIso, "short");
  pushExplore(safeExposure * 0.32, minIso, "very short");
  pushExplore(safeExposure, minIso * Math.SQRT2, "more gain");
  pushExplore(safeExposure * 0.72, minIso * Math.SQRT2, "balanced");
  pushExplore(safeExposure * 0.48, minIso * 2, "fast gain");
  pushExplore(aeBaseline.exposure, aeBaseline.iso, "hardware AE");
  return [...candidates, ...shuffleAutomaticOpticsCandidates(explore)];
}
async function measureAutomaticAcquisitionCandidate(track, candidate, index, total) {
  const id = `AUTO-RACE-${index + 1}`;
  autoOpticsTuneSummary = `race ${index + 1}/${total} · ${candidate.label} · ${formatExposureMs(candidate.exposure)} · ISO ${Math.round(candidate.iso)}`;
  optimizerEpochHooks.transition({ candidateId: id, requestedExposure: candidate.exposure, requestedIso: candidate.iso });
  const accepted = await applyCameraConstraint(track, {
    exposureMode: "manual",
    exposureTime: candidate.exposure,
    iso: candidate.iso
  });
  if (!accepted || !automaticOpticsSessionAlive(track)) return null;
  const actual = track.getSettings();
  if (!Number.isFinite(actual.exposureTime) || !Number.isFinite(actual.iso)) return null;
  const epoch = await optimizerEpochHooks.open({
    candidateId: id,
    requestedExposure: candidate.exposure,
    requestedIso: candidate.iso,
    actualExposure: actual.exposureTime,
    actualIso: actual.iso
  });
  if (epoch === void 0 || !automaticOpticsSessionAlive(track)) return null;
  const sample = await measureReceivePerformance("race", epoch);
  optimizerEpochHooks.close(epoch);
  const performance = await sample.result;
  rememberAutomaticOpticsHistory(track, actual.exposureTime, actual.iso, performance);
  return { candidate, exposure: actual.exposureTime, iso: actual.iso, performance };
}
async function rescueAutomaticQrAcquisition(track, now) {
  if (autoOpticsMutationRunning || !automaticOptics || gridLattice.locked || now < autoOpticsRescueRetryAt) return;
  const caps = track.getCapabilities?.() ?? {};
  const exposureRange = caps.exposureTime;
  const isoRange = caps.iso;
  const settings = track.getSettings();
  if (!Array.isArray(caps.exposureMode) || !caps.exposureMode.includes("manual") || !exposureRange || !isoRange ||
      !Number.isFinite(settings.exposureTime) || !Number.isFinite(settings.iso) || settings.exposureTime <= 0 || settings.iso <= 0) {
    autoOpticsRescueRetryAt = now + AUTO_OPTICS_RESCUE_RETRY_MS;
    return;
  }

  const fps = Math.max(12, Math.min(120, Number(settings.frameRate) || 30));
  const aeBaseline = { exposure: settings.exposureTime, iso: settings.iso, at: receiverNow() };
  const candidates = buildAutomaticOpticsAcquisitionCandidates(track, aeBaseline, exposureRange, isoRange, fps);
  if (!candidates.length) {
    autoOpticsRescueRetryAt = now + AUTO_OPTICS_RESCUE_RETRY_MS;
    return;
  }

  autoOpticsMutationRunning = true;
  autoOpticsRuntimeState = "rescue";
  autoOpticsAeBaseline = aeBaseline;
  optimizerDiscoveryMode = true;
  optimizeMeasureToken++;
  notePipelineEvent("auto-optics-acquisition-race");
  let winner = null;
  try {
    for (let index = 0; index < candidates.length; index++) {
      if (!automaticOpticsSessionAlive(track) || gridLattice.locked) break;
      const measured = await measureAutomaticAcquisitionCandidate(track, candidates[index], index, candidates.length);
      if (!measured) continue;
      if (measured.performance.validDecodes > 0) {
        winner = measured;
        break;
      }
    }

    if (winner) {
      const p = winner.performance;
      autoOpticsRuntimeState = "ae";
      autoOpticsLockSince = 0;
      autoOpticsAcquisitionSince = receiverNow();
      autoOpticsRescueRetryAt = receiverNow() + AUTO_OPTICS_RESCUE_RETRY_MS;
      autoOpticsTuneSummary = `race hit · ${winner.candidate.label} · ${formatExposureMs(winner.exposure)} · ISO ${Math.round(winner.iso)} · ${p.validDecodes} QR`;
      rememberAutomaticOptics(
        track,
        winner.exposure,
        winner.iso,
        p.perQrAttemptSuccessRate,
        p.perQrAttemptSuccessRate,
        aeBaseline.exposure * aeBaseline.iso
      );
      focusController.adoptAutomaticCameraState("acquisition optics race found a QR-proven setting");
      notePipelineEvent("auto-optics-acquisition-race-hit");
      return;
    }

    // If no exposure decoded, do not keep oscillating brightness. Hold the best
    // prior / frame-safe candidate and hand recovery back to autofocus. A focus
    // failure cannot be repaired by repeatedly making the image darker.
    const hold = candidates[0];
    await applyCameraConstraint(track, {
      exposureMode: "manual",
      exposureTime: hold.exposure,
      iso: hold.iso
    });
    const actual = track.getSettings();
    autoOpticsRuntimeState = "ae";
    autoOpticsLockSince = 0;
    autoOpticsAcquisitionSince = receiverNow();
    autoOpticsRescueRetryAt = receiverNow() + AUTO_OPTICS_RESCUE_RETRY_MS;
    autoOpticsTuneSummary = `race miss · holding ${hold.label} ${formatExposureMs(actual.exposureTime ?? hold.exposure)} · ISO ${Math.round(actual.iso ?? hold.iso)} · AF recovery continues`;
    focusController.adoptAutomaticCameraState("exposure race found no QR; holding frame-safe optics for focus recovery");
    notePipelineEvent("auto-optics-acquisition-race-miss");
  } finally {
    optimizerEpochHooks.finish();
    optimizerDiscoveryMode = false;
    autoOpticsMutationRunning = false;
  }
}

function maintainAcquisitionAutofocus(now) {
  if (replayRunning || optimizerPipelineActive || optimizeRunning || autoOpticsMutationRunning || gridLattice.locked) return;
  const track = stream?.getVideoTracks()[0];
  if (!track || track.readyState !== "live") return;
  void focusController.maybeRetrySeekingAutofocus(now);
}

function maintainAutomaticQrOptics(now) {
  if (!automaticOptics || replayRunning || optimizerPipelineActive || optimizeRunning || autoOpticsMutationRunning) return;
  const track = stream?.getVideoTracks()[0];
  if (!track || track.readyState !== "live") return;
  if (!autoOpticsAcquisitionSince) autoOpticsAcquisitionSince = now;

  if (autoOpticsRuntimeState === "memory") {
    const startedAt = autoOpticsMemoryBootAt || now;
    const liveDecode = Boolean(lastStreamDecodeAt && lastStreamDecodeAt >= startedAt);
    if (liveDecode) {
      if (gridLattice.locked) {
        autoOpticsRuntimeState = "manual";
        autoOpticsHoldSample = autoOpticsPipelineSnapshot();
        autoOpticsHoldCollapseSince = 0;
        autoOpticsRetryAt = Infinity;
        const restored = autoOpticsMemoryBoot;
        autoOpticsTuneSummary = restored
          ? `startup winner validated · ${formatExposureMs(restored.exposure)} · ISO ${Math.round(restored.iso)}`
          : "startup winner validated";
        autoOpticsMemoryBootAt = 0;
        autoOpticsMemoryBoot = void 0;
        focusController.adoptAutomaticCameraState("recent automatic optics validated by live AirGapper QR");
        notePipelineEvent("auto-optics-memory-hit");
      } else {
        autoOpticsTuneSummary = "startup winner decoding · awaiting lattice lock";
      }
      return;
    }
    if (now - startedAt >= AUTO_OPTICS_MEMORY_BOOT_MAX_MS)
      void abandonAutomaticOpticsStartupMemory(track);
    return;
  }

  if (autoOpticsRuntimeState === "manual") {
    const poseUsable = gridLattice.locked && autoOpticsPoseUsable(autoOpticsPoseSnapshot());
    if (!poseUsable) {
      autoOpticsHoldSample = void 0;
      autoOpticsHoldCollapseSince = 0;
    } else if (!autoOpticsHoldSample || now - autoOpticsHoldSample.at >= AUTO_OPTICS_HOLD_SAMPLE_MS) {
      const sample = autoOpticsPipelineSnapshot();
      if (autoOpticsHoldSample) {
        const attempts = Math.max(0, sample.attempts - autoOpticsHoldSample.attempts);
        const outputs = Math.max(0, sample.outputs - autoOpticsHoldSample.outputs);
        if (attempts >= AUTO_OPTICS_HOLD_MIN_ATTEMPTS) {
          const yieldRate = outputs / attempts;
          const degradationThreshold = Math.max(
            AUTO_OPTICS_COLLAPSE_YIELD,
            autoOpticsHeldYield * AUTO_OPTICS_HOLD_DEGRADE_RATIO
          );
          if (yieldRate < degradationThreshold) {
            if (!autoOpticsHoldCollapseSince) autoOpticsHoldCollapseSince = now;
            else if (now - autoOpticsHoldCollapseSince >= AUTO_OPTICS_HOLD_COLLAPSE_MS) {
              const reason = yieldRate < AUTO_OPTICS_COLLAPSE_YIELD
                ? "held optics collapsed"
                : `held optics degraded from ${(autoOpticsHeldYield * 100).toFixed(0)}%`;
              void recoverCollapsedAutomaticOptics(track, yieldRate, reason);
              return;
            }
          } else {
            autoOpticsHoldCollapseSince = 0;
          }
        }
      }
      autoOpticsHoldSample = sample;
    }
    return;
  }
  if (autoOpticsRuntimeState !== "ae") return;

  // Cold acquisition stays on hardware AE. Remembered manual exposure can be
  // badly wrong when ambient/screen brightness changed since the last session;
  // applying it before the first QR used to create multi-second startup stalls.
  // Remembered ISO is deliberately not used before first lock; memory is reused
  // only after acquisition for the normal motion-safe shutter/ISO tuning pass.
  if (!gridLattice.locked) {
    autoOpticsLockSince = 0;
    const liveDecode = Boolean(lastStreamDecodeAt && now - lastStreamDecodeAt < AUTO_OPTICS_RECENT_DECODE_MS);
    if (!liveDecode && now - autoOpticsAcquisitionSince >= AUTO_OPTICS_ACQUISITION_RESCUE_MS && now >= autoOpticsRescueRetryAt)
      void rescueAutomaticQrAcquisition(track, now);
    return;
  }
  if (!autoOpticsPoseUsable(autoOpticsPoseSnapshot())) {
    autoOpticsLockSince = 0;
    return;
  }
  if (!autoOpticsLockSince) autoOpticsLockSince = now;
  if (now - autoOpticsLockSince < AUTO_OPTICS_LOCK_SETTLE_MS || now < autoOpticsRetryAt) return;

  const settings = track.getSettings();
  const recentDecodes = qrReadTimes.reduce((count, at) => count + Number(at > now - AUTO_OPTICS_RECENT_DECODE_MS), 0);
  const recentQrRate = recentDecodes / (AUTO_OPTICS_RECENT_DECODE_MS / 1e3);
  const captureWindowMs = 800;
  const recentCaptureRate = captureTimes.reduce((count, at) => count + Number(at > now - captureWindowMs), 0) / (captureWindowMs / 1e3);
  const nominalFps = Math.max(12, Math.min(120, Number(settings.frameRate) || 30));
  const decodeFresh = Boolean(lastStreamDecodeAt && now - lastStreamDecodeAt < AUTO_OPTICS_RECENT_DECODE_MS);
  if (decodeFresh && recentQrRate >= AUTO_OPTICS_MIN_SETTLE_QR_PER_SECOND && recentCaptureRate >= nominalFps * 0.78)
    void settleAutomaticQrOptics(track, now);
}


function populateBrowserCapabilities(track) {
  var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m;
  resetAutomaticOpticsRuntime();
  seedDesiredCamera(track);
  const caps = (_a = track.getCapabilities) == null ? void 0 : _a.call(track);
  cameraResolutionLabel.textContent = "Mode";
  if (!(caps == null ? void 0 : caps.width) || !caps.height) return;
  const hasExposureModes = ((_b = caps.exposureMode) == null ? void 0 : _b.includes("continuous")) && caps.exposureMode.includes("manual");
  const exposure = hasExposureModes ? caps.exposureTime : void 0;
  const exposureMin = exposure ? Math.max(1, exposure.min) : 1;
  const exposureMax = exposure ? Math.min(300, exposure.max) : 0;
  cameraExposureControl.hidden = !exposure || exposureMin >= exposureMax;
  if (exposure && exposureMin < exposureMax) {
    const current = Math.max(exposureMin, Math.min(exposureMax, preferredExposureTime != null ? preferredExposureTime : 100));
    preferredExposureTime = current;
    cameraExposure.min = String(exposureMin);
    cameraExposure.max = String(exposureMax);
    cameraExposure.step = String(Math.max((_c = exposure.step) != null ? _c : 0, 0.1));
    cameraExposure.value = String(current);
    showExposureTime(current);
    syncExposureControls();
  } else {
    cameraOpticsManual.hidden = true;
  }
  const iso = caps.iso;
  cameraIsoControl.hidden = !iso;
  if (iso) {
    preferredIso = Math.max(iso.min, Math.min(iso.max, preferredIso != null ? preferredIso : Number(track.getSettings().iso) || iso.min));
    cameraIso.min = String(iso.min);
    cameraIso.max = String(iso.max);
    cameraIso.step = String((_d = iso.step) != null ? _d : 1);
    cameraIso.value = String(preferredIso);
    cameraIsoValue.value = String(Number(preferredIso.toPrecision(4)));
  }
  const widthMin = (_e = caps.width.min) != null ? _e : 0;
  const widthMax = (_f = caps.width.max) != null ? _f : Infinity;
  const heightMin = (_g = caps.height.min) != null ? _g : 0;
  const heightMax = (_h = caps.height.max) != null ? _h : Infinity;
  const fpsMin = (_j = (_i = caps.frameRate) == null ? void 0 : _i.min) != null ? _j : 0;
  const fpsMax = (_l = (_k = caps.frameRate) == null ? void 0 : _k.max) != null ? _l : Infinity;
  const active = track.getSettings();
  const activeFps = Math.round((_m = active.frameRate) != null ? _m : 30);
  if (active.width && active.height) {
    const activeStandard = standardBrowserModes().find((mode) => sameModeSize(mode, active) && Math.abs(mode.fps - activeFps) < 1);
    if (activeStandard) saveBrowserModeResult(activeStandard.key, true);
  }
  if (cameraResolution.value === "auto" && active.width && active.height) {
    automaticBrowserMode = {
      key: "auto",
      width: active.width,
      height: active.height,
      fps: activeFps,
      label: formatCameraMode(active.width, active.height, activeFps)
    };
  }
  browserModes = standardBrowserModes().filter((mode) => mode.width >= widthMin && mode.width <= widthMax && mode.height >= heightMin && mode.height <= heightMax && mode.fps >= fpsMin && mode.fps <= fpsMax);
  const prior = cameraResolution.value;
  const options = browserModes.map((mode) => ({
    width: mode.width,
    height: mode.height,
    fps: mode.fps,
    option: new Option(`${mode.label}${browserModeSuffix(mode.key)}`, mode.key)
  }));
  if (automaticBrowserMode) {
    options.push({
      width: automaticBrowserMode.width,
      height: automaticBrowserMode.height,
      fps: automaticBrowserMode.fps,
      option: new Option(`Auto · ${automaticBrowserMode.label}`, "auto")
    });
    options.sort((a, b) => a.width - b.width || a.height - b.height || a.fps - b.fps);
  } else {
    options.unshift({ width: 0, height: 0, fps: 0, option: new Option("Auto", "auto") });
  }
  cameraResolution.replaceChildren(...options.map(({ option }) => option));
  cameraResolution.value = browserModes.some((mode) => mode.key === prior) ? prior : "auto";
  readRequestedCameraSettings();
  saveCameraSettings();
}
video.addEventListener("resize", syncPreviewAspect);
video.addEventListener("loadedmetadata", syncPreviewAspect);
window.addEventListener("resize", syncPreviewAspect);
const INDICATOR_FADE_MS = 700;
const SIGHTING_FADE_MS = 450;
const QUALITY_PROMOTE_MS = 450;
const QUALITY_DEMOTE_MS = 1100;
const QUALITY_COLORS = ["#ff665c", "#ffb23e", "#d5d936", "#35d66f", "#42a5ff", "#00efff"];
const overlayCtx = overlay.getContext("2d");
function captureQualityRate(region, now) {
  pruneSequenceSamples(region, now);
  return region.decodeAttempts ? region.decodeConfidence : region.sequenceSamples.length > 0 ? 0.5 : 0;
}
function qualityLevelForRate(rate) {
  if (rate >= 0.95) return 5;
  if (rate >= 0.8) return 4;
  if (rate >= 0.6) return 3;
  if (rate >= 0.35) return 2;
  if (rate >= 0.12) return 1;
  return 0;
}
function captureQualityColor(region, rate, now) {
  // Decode confidence is intentionally responsive; the display is not. Keep
  // a temporal state so a handful of misses cannot make a dense grid flash
  // through multiple colors. New regions start at their measured level, then
  // move only one color at a time after the new level persists.
  const target = qualityLevelForRate(rate);
  if (!region.qualityDisplayInitialized) {
    region.qualityDisplayInitialized = true;
    region.qualityLevel = target;
    region.qualityPendingLevel = target;
    region.qualityPendingSince = now;
    return QUALITY_COLORS[target];
  }
  const current = Math.max(0, Math.min(QUALITY_COLORS.length - 1, region.qualityLevel ?? target));
  if (target === current) {
    region.qualityPendingLevel = target;
    region.qualityPendingSince = now;
    return QUALITY_COLORS[current];
  }
  if (region.qualityPendingLevel !== target) {
    region.qualityPendingLevel = target;
    region.qualityPendingSince = now;
    return QUALITY_COLORS[current];
  }
  const holdMs = target > current ? QUALITY_PROMOTE_MS : QUALITY_DEMOTE_MS;
  if (now - (region.qualityPendingSince ?? now) >= holdMs) {
    region.qualityLevel = current + Math.sign(target - current);
    region.qualityPendingSince = now;
  }
  return QUALITY_COLORS[region.qualityLevel ?? current];
}
function layoutOrder(a, b) {
  const dy = a.y + a.h / 2 - (b.y + b.h / 2);
  if (Math.abs(dy) > Math.max(a.h, b.h) / 2) return dy;
  return a.x + a.w / 2 - (b.x + b.w / 2);
}
let lastOverlayDrawAt = -Infinity;
function drawOverlay(now) {
  if (now - lastOverlayDrawAt < 50) return;
  lastOverlayDrawAt = now;
  var _a, _b;
  const cw = overlay.clientWidth;
  const ch = overlay.clientHeight;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!cw || !ch || !vw || !vh) return;
  const dpr = window.devicePixelRatio || 1;
  const pw = Math.round(cw * dpr);
  const ph = Math.round(ch * dpr);
  if (overlay.width !== pw || overlay.height !== ph) {
    overlay.width = pw;
    overlay.height = ph;
  }
  overlayCtx.clearRect(0, 0, pw, ph);
  const scale = Math.min(pw / vw, ph / vh);
  const offX = (pw - vw * scale) / 2;
  const offY = (ph - vh * scale) / 2;
  overlayCtx.lineCap = "round";
  overlayCtx.lineJoin = "round";
  const ordered = [...regions].sort(layoutOrder);
  for (const r of ordered) {
    const decodedAge = now - ((_a = r.decodedSeen) != null ? _a : -Infinity);
    const sightingAge = now - ((_b = r.sightedSeen) != null ? _b : r.seen);
    const successful = decodedAge <= INDICATOR_FADE_MS;
    if (!successful && sightingAge > SIGHTING_FADE_MS) continue;
    const quality = captureQualityRate(r, now);
    const color = captureQualityColor(r, quality, now);
    overlayCtx.strokeStyle = color;
    overlayCtx.shadowColor = color;
    overlayCtx.shadowBlur = successful ? 5 * dpr : 0;
    overlayCtx.lineWidth = Math.max(successful ? 2.5 : 1.5, (successful ? 2.5 : 1.5) * dpr);
    overlayCtx.setLineDash(successful ? [] : [5 * dpr, 5 * dpr]);
    const pad = 0.06 * Math.max(r.w, r.h) * scale;
    const x = offX + r.x * scale - pad;
    const y = offY + r.y * scale - pad;
    const w = r.w * scale + 2 * pad;
    const h = r.h * scale + 2 * pad;
    const len = 0.24 * Math.min(w, h);
    const age = successful ? decodedAge : sightingAge;
    const fade = successful ? INDICATOR_FADE_MS : SIGHTING_FADE_MS;
    overlayCtx.globalAlpha = successful ? 1 - 0.65 * age / fade : 0.7 * (1 - age / fade);
    overlayCtx.beginPath();
    overlayCtx.moveTo(x, y + len);
    overlayCtx.lineTo(x, y);
    overlayCtx.lineTo(x + len, y);
    overlayCtx.moveTo(x + w - len, y);
    overlayCtx.lineTo(x + w, y);
    overlayCtx.lineTo(x + w, y + len);
    overlayCtx.moveTo(x + w, y + h - len);
    overlayCtx.lineTo(x + w, y + h);
    overlayCtx.lineTo(x + w - len, y + h);
    overlayCtx.moveTo(x + len, y + h);
    overlayCtx.lineTo(x, y + h);
    overlayCtx.lineTo(x, y + h - len);
    overlayCtx.stroke();
  }
  const optimizerFadeMs = Math.max(INDICATOR_FADE_MS, 650);
  for (let i = optimizerOverlayHits.length - 1; i >= 0; i--) {
    const hit = optimizerOverlayHits[i];
    const age = now - hit.at;
    if (age > optimizerFadeMs) {
      optimizerOverlayHits.splice(i, 1);
      continue;
    }
    const r = hit.box;
    const pad = 0.06 * Math.max(r.w, r.h) * scale;
    const x = offX + r.x * scale - pad;
    const y = offY + r.y * scale - pad;
    const w = r.w * scale + 2 * pad;
    const h = r.h * scale + 2 * pad;
    const len = 0.24 * Math.min(w, h);
    overlayCtx.globalAlpha = 1 - 0.65 * age / optimizerFadeMs;
    overlayCtx.strokeStyle = "#35d66f";
    overlayCtx.shadowColor = "#35d66f";
    overlayCtx.shadowBlur = 5 * dpr;
    overlayCtx.lineWidth = Math.max(2.5, 2.5 * dpr);
    overlayCtx.setLineDash([]);
    overlayCtx.beginPath();
    overlayCtx.moveTo(x, y + len);
    overlayCtx.lineTo(x, y);
    overlayCtx.lineTo(x + len, y);
    overlayCtx.moveTo(x + w - len, y);
    overlayCtx.lineTo(x + w, y);
    overlayCtx.lineTo(x + w, y + len);
    overlayCtx.moveTo(x + w, y + h - len);
    overlayCtx.lineTo(x + w, y + h);
    overlayCtx.lineTo(x + w - len, y + h);
    overlayCtx.moveTo(x + len, y + h);
    overlayCtx.lineTo(x, y + h);
    overlayCtx.lineTo(x, y + h - len);
    overlayCtx.stroke();
  }
  overlayCtx.globalAlpha = 1;
  overlayCtx.shadowBlur = 0;
  overlayCtx.setLineDash([]);
}
function focusGeometry() {
  const snapshot = lastGridSnapshot;
  if (!snapshot || !receiverFrameWidth || !receiverFrameHeight || !snapshot.slots.length) return void 0;
  const validSlots = snapshot.slots.filter((slot) => slot && validQuadObject(slot.quad));
  if (!validSlots.length) return void 0;
  const points = validSlots.flatMap((slot) => [slot.quad.topLeft, slot.quad.topRight, slot.quad.bottomRight, slot.quad.bottomLeft]);
  const left = Math.min(...points.map((point) => point.x));
  const right = Math.max(...points.map((point) => point.x));
  const top = Math.min(...points.map((point) => point.y));
  const bottom = Math.max(...points.map((point) => point.y));
  const tracked = regions.filter((region) => region.gridSlot !== void 0 && validQuadObject(region.quad));
  const quality = tracked.length ? tracked.reduce((sum, region) => sum + region.decodeConfidence, 0) / tracked.length : snapshot.confidence;
  const representative = validSlots[Math.floor(validSlots.length / 2)].quad;
  const topEdge = Math.hypot(representative.topRight.x - representative.topLeft.x, representative.topRight.y - representative.topLeft.y);
  const bottomEdge = Math.hypot(representative.bottomRight.x - representative.bottomLeft.x, representative.bottomRight.y - representative.bottomLeft.y);
  const leftEdge = Math.hypot(representative.bottomLeft.x - representative.topLeft.x, representative.bottomLeft.y - representative.topLeft.y);
  const rightEdge = Math.hypot(representative.bottomRight.x - representative.topRight.x, representative.bottomRight.y - representative.topRight.y);
  return {
    x: Math.max(0, Math.min(1, (left + right) / 2 / receiverFrameWidth)),
    y: Math.max(0, Math.min(1, (top + bottom) / 2 / receiverFrameHeight)),
    scale: Math.sqrt(Math.max(1, (right - left) * (bottom - top)) / (receiverFrameWidth * receiverFrameHeight)),
    perspectiveX: Math.log(Math.max(1e-4, topEdge) / Math.max(1e-4, bottomEdge)),
    perspectiveY: Math.log(Math.max(1e-4, leftEdge) / Math.max(1e-4, rightEdge)),
    quality
  };
}
function renderFocusDiagnostics() {
  var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n, _o, _p, _q, _r, _s, _t, _u, _v;
  const diagnostic = focusController == null ? void 0 : focusController.diagnostics();
  if (!diagnostic) return;
  focusDev.hidden = diagnostic.state === "UNAVAILABLE";
  focusMode.value = manualFocusMode;
  for (const option of focusMode.options) option.disabled = !diagnostic.availableModes.includes(option.value);
  const range = diagnostic.distanceRange;
  focusDistanceControl.hidden = automaticOptics || !range && diagnostic.availableModes.length === 0;
  if (range) {
    focusDistance.min = String(range.min);
    focusDistance.max = String(range.max);
    focusDistance.step = String(range.step || (range.max - range.min) / 100 || 0.01);
    if (document.activeElement !== focusDistance) focusDistance.value = String((_a = preferredFocusDistance != null ? preferredFocusDistance : diagnostic.actualDistance) != null ? _a : range.min);
    focusDistanceValue.value = Number(focusDistance.value).toPrecision(4);
  }
  for (const input of focusTuningInputs) {
    const key = input.dataset.cameraTuning;
    if (document.activeElement !== input) input.value = String(CAMERA_TUNING[key]);
  }
  const optical = diagnostic.optical;
  const optimizing = ["baseline", "exposure", "verification"].includes(diagnostic.optimizeState);
  opticsOptimize.disabled = !automaticOptics && !optimizing;
  if (optimizeEnabled && !optimizeConverged && !optimizing && !focusController.optimizeEligible()) {
    opticsOptimizeStatus.textContent = diagnostic.state === "UNAVAILABLE" ? "Camera unavailable" : diagnostic.optimizeState === "paused" ? (_b = diagnostic.optimizeReason) != null ? _b : "Optimize paused" : "Ready";
  } else if (optimizing && !candidateEvidenceWindows.size) {
    opticsOptimizeStatus.textContent = diagnostic.optimizeRound ? `${diagnostic.optimizeRound[0].toUpperCase()}${diagnostic.optimizeRound.slice(1)} · ${(_d = (_c = diagnostic.optimizeSurvivors) != null ? _c : diagnostic.optimizeVisit) != null ? _d : "Exposure"}` : "Exposure…";
  }
  opticsKeep.hidden = diagnostic.optimizeState !== "complete";
  beginOptimizeWhenReady();
  const mutation = lastCameraMutation;
  const candidateTable = diagnostic.optimizeCandidates.map((candidate) => {
    const marker = candidate.state.includes("winner") ? "*" : " ";
    const opticalMode = candidate.opticalTargeted ? "QR" : "global";
    const opticalState = candidate.opticalTargeted ? candidate.opticalGood ? "GOOD" : "bad" : "bootstrap";
    const qr = candidate.qrAttempts > 0 ? ` · ${candidate.normalizedQrRate.toFixed(1)} QR/s` : "";
    return `${marker} ${formatExposureMs(candidate.exposure)} · ISO ${candidate.iso} · ${opticalMode} ${opticalState} · margin ${candidate.opticalMargin.toFixed(2)} · sep ${candidate.opticalSeparation.toFixed(0)} · noise ${candidate.opticalNoise.toFixed(1)} · clip ${candidate.opticalClipping.toFixed(2)} · band ${candidate.opticalBanding.toFixed(2)} · ${candidate.sourceFrames} optical frames${qr} · ${candidate.state}`;
  }).join("\n");
  const manualCandidate = !automaticOptics && diagnostic.actualExposure && diagnostic.actualIso && diagnostic.optimizeCandidates.length ? diagnostic.optimizeCandidates.reduce((closest, candidate) => {
    const distance = Math.hypot(
      Math.log2(candidate.exposure / diagnostic.actualExposure),
      Math.log2(candidate.iso / diagnostic.actualIso)
    );
    return distance < closest.distance ? { candidate, distance } : closest;
  }, { candidate: diagnostic.optimizeCandidates[0], distance: Infinity }) : void 0;
  const manualQrRate = qrReadTimes.reduce((count, time) => count + Number(time > receiverNow() - STATS_WINDOW_MS), 0);
  const manualMeasured = manualOptimizerValidation && diagnostic.actualExposure && diagnostic.actualIso && Math.abs(Math.log2(manualOptimizerValidation.exposure / diagnostic.actualExposure)) < 0.1 && Math.abs(Math.log2(manualOptimizerValidation.iso / diagnostic.actualIso)) < 0.1 ? manualOptimizerValidation : void 0;
  const manualVerdict = manualCandidate ? manualCandidate.distance > 0.35 ? "manual configuration coarse-search result: NOT TESTED" : manualMeasured && manualMeasured.performance.perQrAttemptSuccessRate > manualCandidate.candidate.successRate + 0.15 ? `TESTED AS ${manualCandidate.candidate.candidateId} · Optimize ${(manualCandidate.candidate.successRate * 100).toFixed(0)}% vs live manual ${(manualMeasured.performance.perQrAttemptSuccessRate * 100).toFixed(0)}% → MEASUREMENT BUG` : `TESTED AS ${manualCandidate.candidate.candidateId}` : "";
  const sourceTrack = stream?.getVideoTracks()[0];
  const sourceSettings = sourceTrack?.getSettings();
  const perfNow = receiverNow();
  const windowStart = perfNow - STATS_WINDOW_MS;
  const sourceCaptureRate = captureTimes.reduce((count, at) => count + Number(at > windowStart), 0) / (STATS_WINDOW_MS / 1e3);
  for (const samples of [hotJobSubmitSamples, hotJobCompletionSamples, workerLoadSamples]) {
    while (samples.length && samples[0].at <= windowStart) samples.shift();
  }
  while (pendingLaneReplaceTimes.length && pendingLaneReplaceTimes[0] <= windowStart) pendingLaneReplaceTimes.shift();
  while (repeatSkipTimes.length && repeatSkipTimes[0] <= windowStart) repeatSkipTimes.shift();
  const repeatSkipRate = repeatSkipTimes.length / (STATS_WINDOW_MS / 1e3);
  const trackedSubmits = hotJobSubmitSamples.filter((sample) => !sample.full);
  const trackedCompletions = hotJobCompletionSamples.filter((sample) => !sample.full);
  const submittedJobsRate = trackedSubmits.length / (STATS_WINDOW_MS / 1e3);
  const completedJobsRate = trackedCompletions.length / (STATS_WINDOW_MS / 1e3);
  const attemptedQrRate = trackedSubmits.reduce((sum, sample) => sum + sample.tracks, 0) / (STATS_WINDOW_MS / 1e3);
  const completedQrRate = trackedCompletions.reduce((sum, sample) => sum + sample.tracks, 0) / (STATS_WINDOW_MS / 1e3);
  const decodeSourceRate = decodeFrameTimes.reduce((count, at) => count + Number(at > windowStart), 0) / (STATS_WINDOW_MS / 1e3);
  const validQrRate = qrReadTimes.reduce((count, at) => count + Number(at > windowStart), 0) / (STATS_WINDOW_MS / 1e3);
  const uniqueQrRate = uniqueQrTimes.reduce((count, at) => count + Number(at > windowStart), 0) / (STATS_WINDOW_MS / 1e3);
  const duplicateQrRate = duplicateQrTimes.reduce((count, at) => count + Number(at > windowStart), 0) / (STATS_WINDOW_MS / 1e3);
  const senderRateEstimate = estimateSenderFrameRate(perfNow);
  const workerBusyEventRate = poolBusyTimes.reduce((count, at) => count + Number(at > windowStart), 0) / (STATS_WINDOW_MS / 1e3);
  const workerUtilization = workerLoadSamples.length
    ? workerLoadSamples.reduce((sum, sample) => sum + (sample.size ? sample.busy / sample.size : 0), 0) / workerLoadSamples.length
    : 0;
  const averageJobMs = trackedCompletions.length ? trackedCompletions.reduce((sum, sample) => sum + sample.latencyMs, 0) / trackedCompletions.length : 0;
  const averageNativeMs = trackedCompletions.length ? trackedCompletions.reduce((sum, sample) => sum + sample.nativeMs, 0) / trackedCompletions.length : 0;
  const averageGuidedMs = trackedCompletions.length ? trackedCompletions.reduce((sum, sample) => sum + (sample.guidedMs || 0), 0) / trackedCompletions.length : 0;
  const averageCopyMs = trackedCompletions.length ? trackedCompletions.reduce((sum, sample) => sum + sample.copyMs, 0) / trackedCompletions.length : 0;
  const averageRobustBands = trackedCompletions.length ? trackedCompletions.reduce((sum, sample) => sum + sample.robustBands, 0) / trackedCompletions.length : 0;
  const averageRobustSearchMs = trackedCompletions.length ? trackedCompletions.reduce((sum, sample) => sum + sample.robustSearchMs, 0) / trackedCompletions.length : 0;
  const visibleSlotCount = regions.reduce((count, region) => count + Number(region.gridSlot !== void 0 && region.slotState !== "OFFSCREEN"), 0);
  const qrOpportunityRate = sourceCaptureRate * visibleSlotCount;
  const attemptCoverage = qrOpportunityRate > 0 ? attemptedQrRate / qrOpportunityRate : 0;
  const packetInternalBytes = decoder?.mode === "raptorq" ? RAPTOR_PACKET_ID_BYTES : 0;
  const transportMetadataBytes = decoder ? frameOverhead(decoder.mode) + packetInternalBytes : 0;
  const transportFrameBytes = decoder ? decoder.blockLen + frameOverhead(decoder.mode) : 0;
  const transportSourceBytes = decoder ? decoder.blockLen - packetInternalBytes : 0;
  const pumpDetail = framePumpMode === "MediaStreamTrackProcessor"
    ? `${framePumpMode}${Number.isFinite(frameTrackProcessor?.discardedFrames) ? ` · source ${frameTrackProcessor.totalFrames} · discarded ${frameTrackProcessor.discardedFrames}` : ""}`
    : `${framePumpMode}${rvfcSkippedFrames ? ` · presented skips ${rvfcSkippedFrames}` : ""}`;
  const sourceLine = sourceSettings ? `${sourceTrack?.label || "camera"} · id ${(sourceSettings.deviceId || "—").slice(0, 8)} · track ${sourceSettings.width ?? "—"}×${sourceSettings.height ?? "—"}@${sourceSettings.frameRate ? Number(sourceSettings.frameRate).toFixed(1) : "—"} · video ${video.videoWidth || "—"}×${video.videoHeight || "—"} · capture ${receiverFrameWidth || "—"}×${receiverFrameHeight || "—"}@${sourceCaptureRate.toFixed(1)} · pump ${pumpDetail} · VideoFrame ${lastVideoFrameInfo ?? "—"}` : "camera inactive";
  const cameraLine = (value) => {
    var _a2, _b2, _c2, _d2, _e2;
    return value ? `${(_a2 = value.focusMode) != null ? _a2 : "—"}/${(_b2 = value.focusDistance) != null ? _b2 : "—"} · ${(_c2 = value.exposureMode) != null ? _c2 : "—"}/${formatExposureMs(value.exposureTime)} · ISO ${(_d2 = value.iso) != null ? _d2 : "—"} · EV ${(_e2 = value.exposureCompensation) != null ? _e2 : "—"}` : "—";
  };
  focusDiagnostics.textContent = [
    diagnostic.invariantWarning ? `!!! ${diagnostic.invariantWarning} — SELF-HEALING TO HARDWARE AF !!!` : "",
    `State    ${diagnostic.state} · ${(diagnostic.stateMs / 1e3).toFixed(1)}s${diagnostic.lockedMs === void 0 ? "" : ` · locked ${(diagnostic.lockedMs / 1e3).toFixed(1)}s`}`,
    `Owner    ${diagnostic.focusOwner}`,
    `3A       manual exposure ${manualExposureFocusPolicy === "requires-hold" ? "requires AF hold on this camera" : manualExposureFocusPolicy}`,
    `Camera   focus writes ${cameraFocusWritesTotal} · exposure writes ${cameraExposureWritesTotal}`,
    `Source   ${sourceLine}`,
    `Hot path codec ${usesScalarCodec ? "scalar" : "SIMD"} · workers ${pool.size} · busy ${(workerUtilization * 100).toFixed(0)}% · scheduled frames ${decodeSourceRate.toFixed(1)}/s · jobs ${submittedJobsRate.toFixed(1)}→${completedJobsRate.toFixed(1)}/s`,
    `Capacity ${visibleSlotCount || "—"} visible slots × ${sourceCaptureRate.toFixed(1)} fps = ${qrOpportunityRate.toFixed(1)} QR/s · submitted ${attemptedQrRate.toFixed(1)} (${qrOpportunityRate ? `${(attemptCoverage * 100).toFixed(0)}%` : "—"}) · completed ${completedQrRate.toFixed(1)}`,
    `Output   valid ${validQrRate.toFixed(1)} · unique ${uniqueQrRate.toFixed(1)} · duplicate ${duplicateQrRate.toFixed(1)} QR/s · useful ${liveGoodputKbs(perfNow).toFixed(1)} KB/s`,
    senderRateEstimate ? `Sender   ~${senderRateEstimate.fps.toFixed(senderRateEstimate.snapped ? 0 : 1)} fps · ${senderRateEstimate.samples} sequence intervals` : "",
    cornerSlotMetrics(),
    `Pressure worker-busy ${workerBusyEventRate.toFixed(1)}/s · latest replacements ${(pendingLaneReplaceTimes.length / (STATS_WINDOW_MS / 1e3)).toFixed(1)}/s · repeat skips ${repeatSkipRate.toFixed(1)}/s · crop recenters ${laneCropRecentersTotal} · avg job ${averageJobMs.toFixed(1)}ms · robust ${averageRobustSearchMs.toFixed(1)}ms/${averageRobustBands.toFixed(1)} bands · guided ${averageGuidedMs.toFixed(1)}ms · native ${averageNativeMs.toFixed(1)}ms · copy ${averageCopyMs.toFixed(1)}ms`,
    decoder ? `Framing  ${transportSourceBytes} source + ${transportMetadataBytes} metadata = ${transportFrameBytes} QR bytes · ${(transportMetadataBytes / Math.max(1, transportFrameBytes) * 100).toFixed(2)}% metadata` : "",
    `Focus    requested ${(_e = diagnostic.requestedMode) != null ? _e : "—"} · actual ${(_f = diagnostic.actualMode) != null ? _f : "—"} · distance ${(_g = diagnostic.actualDistance) != null ? _g : "—"}`,
    `AF       modes ${(diagnostic.hardwareFocusModes ?? []).join(",") || "—"} · POI ${diagnostic.poiSupported ? "yes" : "no"} · single-shot ${diagnostic.singleShotAfRejected ? "rejected" : diagnostic.seekingAfVerified ? "confirmed" : "unproven"} · ROI nudges ${diagnostic.continuousAfNudges}`,
    `Focus    committed ${(_h = diagnostic.committedFocusMode) != null ? _h : "—"}/${(_i = diagnostic.committedFocusDistance) != null ? _i : "—"}`,
    `Exposure committed ${formatExposureMs(diagnostic.committedExposureTime)} · requested ${formatExposureMs(diagnostic.candidateExposureTime)} · actual ${formatExposureMs(diagnostic.actualExposure)} · EV ${(_j = diagnostic.actualExposureCompensation) != null ? _j : "—"}`,
    `ISO      committed ${(_k = diagnostic.committedIso) != null ? _k : "—"} · requested ${(_l = diagnostic.candidateIso) != null ? _l : "—"} · actual ${(_m = diagnostic.actualIso) != null ? _m : "—"}`,
    `AutoOptics ${automaticOptics ? `${autoOpticsRuntimeState}${autoOpticsRuntimeState === "manual" ? ` · hold ${(autoOpticsHeldYield * 100).toFixed(0)}%` : autoOpticsRuntimeState === "memory" ? " · restoring recent winner" : autoOpticsRuntimeState === "ae" ? " · bootstrap AE" : autoOpticsRuntimeState === "tuning" ? " · live ISO search" : ""}${autoOpticsTuneSummary ? ` · ${autoOpticsTuneSummary}` : ""}` : "off"}`,
    optical ? `Static   focus ${optical.focusScore.toFixed(2)} · separation ${optical.separation.toFixed(0)} · noise ${optical.noise.toFixed(1)} · banding ${optical.banding.toFixed(2)} · temporal ${optical.temporalContamination.toFixed(1)} · geometry ${diagnostic.geometryStable ? "stable" : "moving"}` : "Static   waiting for QR",
    `Payload  valid ${diagnostic.validDecodesInGeneration} · completions ${diagnostic.decoderCompletionsInGeneration} · silence ${(diagnostic.decodeSilenceMs / 1e3).toFixed(1)}s · decode gap ${(_o = (_n = diagnostic.recentInterdecodeMs) == null ? void 0 : _n.toFixed(0)) != null ? _o : "—"}ms · completion gap ${(_q = (_p = diagnostic.recentCompletionMs) == null ? void 0 : _p.toFixed(0)) != null ? _q : "—"}ms`,
    `Recovery probes ${geometryRecoveryProbes} · sighting nudges ${geometrySightingNudges} · resets ${geometryRecoveryResets} · worker restarts ${recoveryWorkerRestarts} · aborted ${recoveryAbortedJobs} jobs/${(recoveryAbortedWorkerMs / 1e3).toFixed(1)} worker-s · hold ${decoderFreshnessHoldActive ? `${Math.max(0, decoderFreshnessHoldUntil - perfNow).toFixed(0)}ms` : "no"} · lattice ${gridLattice.state}${gridLattice.active ? "/active" : "/acquiring"} · mode ${frameModeSync ? `syncing ${frameModeSync.width}×${frameModeSync.height}` : "synced"} · mode drops ${frameModeMismatchDrops} · sync timeouts ${frameModeSyncTimeouts} · ${lastRecoveryReason}`,
    `Useful   ${diagnostic.lastUsefulDecodeAt === void 0 ? "none" : `${((performance.now() - diagnostic.lastUsefulDecodeAt) / 1e3).toFixed(1)}s ago`}`,
    `Counts   full AF+AE ${diagnostic.fullResetCount} · focus-only ${diagnostic.focusRefinementCount} · AF pulses ${diagnostic.seekingAfRetries} (${diagnostic.seekingAfVerified} single-shot · ${diagnostic.seekingAfUnconfirmed} rejected/unconfirmed · ${diagnostic.continuousAfNudges} ROI) · exposure-only ${diagnostic.exposureRefinementCount}`,
    `Optimizer ${diagnostic.optimizeState}${diagnostic.optimizeRound ? ` · round ${diagnostic.optimizeRound}` : ""}${diagnostic.optimizeVisit ? ` · visit ${diagnostic.optimizeVisit}` : ""}`,
    `Search   ${(_r = diagnostic.optimizeDecision) != null ? _r : "—"}`,
    diagnostic.optimizeCandidatePerformance ? `Candidate ${diagnostic.optimizeCandidatePerformance.validDecodesPerSecond.toFixed(1)} QR/s · ${(diagnostic.optimizeCandidatePerformance.perQrAttemptSuccessRate * 100).toFixed(0)}%/opportunity` : "",
    diagnostic.optimizeBestPerformance ? `Winner   ${diagnostic.optimizeBestPerformance.validDecodesPerSecond.toFixed(1)} QR/s · ${(diagnostic.optimizeBestPerformance.perQrAttemptSuccessRate * 100).toFixed(0)}%/opportunity · ${formatExposureMs(diagnostic.committedExposureTime)} · ISO ${(_s = diagnostic.committedIso) != null ? _s : "—"}` : "",
    diagnostic.optimizeReason ? `Result   ${diagnostic.optimizeReason}` : "",
    diagnostic.optimizeExposureVisited ? `Visited  ${diagnostic.optimizeCandidates.length} settings · exposure ${formatExposureMs(diagnostic.optimizeExposureVisited.min)}–${formatExposureMs(diagnostic.optimizeExposureVisited.max)} · ISO ${(_t = diagnostic.optimizeIsoVisited) == null ? void 0 : _t.min}–${(_u = diagnostic.optimizeIsoVisited) == null ? void 0 : _u.max}` : "",
    `Attribution submitted ${optimizerJobsSubmittedTotal} · mapped ${optimizerJobsMappedTotal} · completions mapped ${optimizerCompletionsMappedTotal} · unattributed ${optimizerUnattributedResults} · epoch mismatches ${optimizerEpochMismatches} · duplicate valid events ${optimizerDuplicateValidEvents} · transition frames ${optimizerTransitionFramesDiscarded}`,
    candidateTable ? `Candidates
${candidateTable}` : "",
    optimizerTrace.length ? `Optimizer trace
${optimizerTrace.slice(-20).map(
      (event) => {
        var _a2, _b2, _c2, _d2, _e2, _f2, _g2, _h2;
        return `${event.time.toFixed(0)} ${event.event} ${(_a2 = event.candidateId) != null ? _a2 : "—"} ep${(_b2 = event.candidateEpoch) != null ? _b2 : "—"} src${(_c2 = event.sourceSequence) != null ? _c2 : "—"} scan${(_d2 = event.scanId) != null ? _d2 : "—"} E${(_f2 = (_e2 = event.actualExposure) != null ? _e2 : event.requestedExposure) != null ? _f2 : "—"} ISO${(_h2 = (_g2 = event.actualIso) != null ? _g2 : event.requestedIso) != null ? _h2 : "—"} valid:${event.validDecode === void 0 ? "—" : event.validDecode ? "yes" : "no"} useful:${event.usefulSymbol === void 0 ? "—" : event.usefulSymbol ? "yes" : "no"}`;
      }
    ).join("\n")}` : "",
    manualCandidate ? `Current manual ${formatExposureMs(diagnostic.actualExposure)} · ISO ${diagnostic.actualIso} · ${manualMeasured ? `${(manualMeasured.performance.perQrAttemptSuccessRate * 100).toFixed(0)}%/opportunity · ${manualMeasured.performance.validDecodesPerSecond.toFixed(1)} QR/s` : `${manualQrRate.toFixed(1)} live QR/s · controlled measurement pending`}
Closest Optimize ${formatExposureMs(manualCandidate.candidate.exposure)} · ISO ${manualCandidate.candidate.iso} · distance ${manualCandidate.distance.toFixed(2)} EV · ${(manualCandidate.candidate.successRate * 100).toFixed(0)}%/opportunity · ${manualCandidate.candidate.normalizedQrRate.toFixed(1)} QR/s
${manualVerdict}` : "",
    lastNativeMetrics ? `Native   ${lastNativeMetrics.totalMs.toFixed(1)}ms · copy ${(lastNativeMetrics.frameCopyMs ?? 0).toFixed(1)} · anchor ${lastNativeMetrics.anchorMs.toFixed(1)} · sample ${lastNativeMetrics.samplingMs.toFixed(1)} · bits ${lastNativeMetrics.bitExtractionMs.toFixed(1)} · CRC ${lastNativeMetrics.crcMs.toFixed(1)} · RS ${lastNativeMetrics.rsFallbackMs.toFixed(1)} · maps ${lastNativeMetrics.calibratedTracks ?? 0}/${lastNativeMetrics.activeTracks ?? 0} · pose ${lastNativeMetrics.translationSuccesses ?? 0}/${lastNativeMetrics.translationAttempts ?? 0} · ${lastNativeMetrics.samples} samples · ${lastNativeMetrics.successful}/${lastNativeMetrics.tracks} QR` : "",
    lastGuidedMetrics ? `Guided   state ${guidedRollout.state} · ${lastGuidedMetrics.totalMs.toFixed(1)}ms · bin ${lastGuidedMetrics.binarizeMs.toFixed(1)} · finder ${lastGuidedMetrics.finderMs.toFixed(1)} · sample ${lastGuidedMetrics.sampleMs.toFixed(1)} · decode ${lastGuidedMetrics.decodeMs.toFixed(1)} [sparse ${lastGuidedMetrics.fastDecodeMs.toFixed(1)} ${lastGuidedMetrics.fastDecodeSuccesses}/${lastGuidedMetrics.fastDecodeAttempts} · noRS ${lastGuidedMetrics.sparseNoRsSuccesses}/${lastGuidedMetrics.sparseNoRsAttempts} · stableRS ${lastGuidedMetrics.stableRsSuccesses ?? 0}/${lastGuidedMetrics.stableRsAttempts ?? 0} stable ${lastGuidedMetrics.stableEligibleTracks ?? 0} · warp T/A/P ${lastGuidedMetrics.translationWarpTracks ?? 0}/${lastGuidedMetrics.affineWarpTracks ?? 0}/${lastGuidedMetrics.perspectiveWarpTracks ?? 0} · profile ${lastGuidedMetrics.sparseProfileSuccesses ?? 0}/${lastGuidedMetrics.sparseProfileAttempts ?? 0} · module ${(lastGuidedMetrics.moduleSizeAvg ?? 0).toFixed(2)}px [${(lastGuidedMetrics.moduleSizeMin ?? 0).toFixed(2)}–${(lastGuidedMetrics.moduleSizeMax ?? 0).toFixed(2)}] · RS ${lastGuidedMetrics.sparseRsFallbacks} · sparse-skip ${lastGuidedMetrics.sparseSkipped} · fallback ${lastGuidedMetrics.genericDecodeMs.toFixed(1)} ${lastGuidedMetrics.genericDecodeAttempts} · hit ${lastGuidedMetrics.genericFallbackSuccesses}/${lastGuidedMetrics.genericFallbackTracks} skip ${lastGuidedMetrics.genericFallbackSkipped}] · finders ${lastGuidedMetrics.finderSuccesses}/${lastGuidedMetrics.finderAttempts} · triplets ${lastGuidedMetrics.finderTriplets} · ${lastGuidedMetrics.successful}/${lastGuidedMetrics.tracks} QR` : `Guided   state ${guidedRollout.state} · baseline p50 ${guidedBaselineP50().toFixed(1)}ms`,
    `Analyzer ${(opticalAnalyzeCount / Math.max(1e-3, (performance.now() - opticalTimingStartedAt) / 1e3)).toFixed(1)}/s · avg ${(opticalAnalyzeTotalMs / Math.max(1, opticalAnalyzeCount)).toFixed(2)}ms · max ${opticalAnalyzeMaxMs.toFixed(2)}ms`,
    `Reason   ${diagnostic.lastReason}`,
    `Mutation ${(_v = mutation == null ? void 0 : mutation.kind) != null ? _v : "—"}`,
    mutation ? `  before    ${cameraLine(mutation.before)}
  requested ${cameraLine(mutation.requested)}
  after     ${cameraLine(mutation.after)}` : "",
    diagnostic.transitions.length ? `Transitions
${diagnostic.transitions.join("\n")}` : ""
  ].filter(Boolean).join("\n");
}
focusMode.addEventListener("change", () => {
  holdDecoderForCameraMutation("manual focus mode changing", 500);
  manualFocusMode = focusMode.value;
  syncExposureControls();
  saveCameraSettings();
  focusController.setStrategy(manualFocusMode);
});
focusDistance.addEventListener("input", () => {
  holdDecoderForCameraMutation("manual focus changing", 500);
  preferredFocusDistance = Number(focusDistance.value);
  focusDistanceValue.value = Number(focusDistance.value).toPrecision(4);
  saveCameraSettings();
  focusController.setManualDistance(preferredFocusDistance);
});
for (const input of focusTuningInputs) input.addEventListener("change", () => {
  const key = input.dataset.cameraTuning;
  const value = Number(input.value);
  if (Number.isFinite(value)) CAMERA_TUNING[key] = value;
  renderFocusDiagnostics();
});
startBtn.onclick = () => void start();
const changeCameraSettings = async () => {
  var _a, _b;
  showRequestedCameraSettings();
  saveCameraSettings();
  const track = stream == null ? void 0 : stream.getVideoTracks()[0];
  if (!track || done) return;
  if (cameraResolution.value === "auto") {
    await mutateCamera(track, () => track.applyConstraints({
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 60 }
    })).catch(() => void 0);
    populateBrowserCapabilities(track);
    showNegotiatedWebMode(track);
    attachCameraController(track);
    return;
  }
  const attempted = browserModes.find((mode) => mode.key === cameraResolution.value);
  if (!attempted) return;
  const current = track.getSettings();
  const currentExactSize = sameModeSize(current, attempted);
  const currentExact = currentExactSize && Math.abs((current.frameRate ?? attempted.fps) - attempted.fps) < 1;
  if (currentExact) {
    saveBrowserModeResult(attempted.key, true);
    populateBrowserCapabilities(track);
    cameraResolution.value = attempted.key;
    readRequestedCameraSettings();
    showNegotiatedWebMode(track);
    saveCameraSettings();
    attachCameraController(track);
    return;
  }
  try {
    await mutateCamera(track, () => track.applyConstraints({
      width: { exact: attempted.width },
      height: { exact: attempted.height },
      frameRate: { exact: attempted.fps }
    }));
    const active = track.getSettings();
    const exactSize = active.width === attempted.width && active.height === attempted.height || active.width === attempted.height && active.height === attempted.width;
    const exact = exactSize && Math.abs(((_a = active.frameRate) != null ? _a : attempted.fps) - attempted.fps) < 1;
    if (!exact) throw new Error("Browser negotiated a different mode");
    saveBrowserModeResult(attempted.key, true);
    const option = [...cameraResolution.options].find((candidate) => candidate.value === attempted.key);
    if (option) option.textContent = attempted.label;
    populateBrowserCapabilities(track);
    showNegotiatedWebMode(track);
    attachCameraController(track);
  } catch {
    saveBrowserModeResult(attempted.key, false);
    const failedOption = cameraResolution.querySelector(`option[value="${CSS.escape(attempted.key)}"]`);
    if (failedOption) failedOption.textContent = `${attempted.label} · Retry`;
    cameraResolution.value = "auto";
    populateBrowserCapabilities(track);
    showNegotiatedWebMode(track, `${attempted.label} unavailable; kept current mode`);
    saveCameraSettings();
    attachCameraController(track);
  }
};
cameraResolution.addEventListener("change", () => {
  holdDecoderForCameraMutation("camera mode changing", 2500);
  void changeCameraSettings().finally(() => {
    const track = stream?.getVideoTracks()[0];
    if (!track || done) return;
    restartFramePumpForCameraMode(track, "camera mode changed");
    enterGeometryRecovery("camera mode changed", receiverNow(), true);
  });
});
cameraDevice?.addEventListener("change", () => {
  preferredCameraDeviceId = cameraDevice.value;
  automaticCameraUpgradeAttempted = false;
  if (!preferredCameraDeviceId) automaticCameraDeviceId = learnedAutomaticCameraId();
  saveCameraSettings();
  if (!stream || done) return;
  stopReceiver();
  void start();
});
navigator.mediaDevices?.addEventListener?.("devicechange", () => {
  void refreshCameraDevices(stream?.getVideoTracks()[0]);
});
cameraExposureAuto.addEventListener("change", () => {
  automaticOptics = cameraExposureAuto.checked;
  resetAutomaticOpticsRuntime();
  clearTimeout(exposureApplyTimer);
  syncExposureControls();
  saveCameraSettings();
  const track = stream == null ? void 0 : stream.getVideoTracks()[0];
  if (!automaticOptics) {
    setOptimizeEnabled(false);
    manualOpticsCheckAt = 0;
    if (track) void applyAndValidateManualExposure(track);
    return;
  }
  if (track) void applyExposureSetting(track);
});
exposureAxisAuto.addEventListener("change", () => {
  automaticExposureAxis = exposureAxisAuto.checked;
  syncExposureControls();
  saveCameraSettings();
  const track = stream == null ? void 0 : stream.getVideoTracks()[0];
  if (track) void applyExposureSetting(track);
});
isoAxisAuto.addEventListener("change", () => {
  automaticIsoAxis = isoAxisAuto.checked;
  syncExposureControls();
  saveCameraSettings();
  const track = stream == null ? void 0 : stream.getVideoTracks()[0];
  if (track) void applyExposureSetting(track);
});
exposureAxisReset.addEventListener("click", () => {
  automaticExposureAxis = true;
  syncExposureControls();
  saveCameraSettings();
  const track = stream == null ? void 0 : stream.getVideoTracks()[0];
  if (track) void applyExposureSetting(track);
});
isoAxisReset.addEventListener("click", () => {
  automaticIsoAxis = true;
  syncExposureControls();
  saveCameraSettings();
  const track = stream == null ? void 0 : stream.getVideoTracks()[0];
  if (track) void applyExposureSetting(track);
});
function queueExposureChange(immediate = false) {
  holdDecoderForCameraMutation("manual exposure changing");
  resetGuidedRollout();
  preferredExposureTime = Number(cameraExposure.value);
  showExposureTime(preferredExposureTime);
  saveCameraSettings();
  clearTimeout(exposureApplyTimer);
  const apply = () => {
    const track = stream == null ? void 0 : stream.getVideoTracks()[0];
    if (track && !automaticOptics) void applyAndValidateManualExposure(track);
  };
  if (immediate) apply();
  else exposureApplyTimer = setTimeout(apply, 80);
}
cameraExposure.addEventListener("input", () => queueExposureChange());
cameraExposure.addEventListener("change", () => queueExposureChange(true));
function queueIsoChange(immediate = false) {
  holdDecoderForCameraMutation("manual ISO changing");
  resetGuidedRollout();
  preferredIso = Number(cameraIso.value);
  automaticIsoAxis = false;
  isoAxisAuto.checked = false;
  cameraIsoValue.value = String(Number(preferredIso.toPrecision(4)));
  syncExposureControls();
  saveCameraSettings();
  clearTimeout(exposureApplyTimer);
  const apply = () => {
    const track = stream == null ? void 0 : stream.getVideoTracks()[0];
    if (track && !automaticOptics) void applyAndValidateManualExposure(track);
  };
  if (immediate) apply();
  else exposureApplyTimer = setTimeout(apply, 80);
}
cameraIso.addEventListener("input", () => queueIsoChange());
cameraIso.addEventListener("change", () => queueIsoChange(true));
decodeWorkers.addEventListener("change", () => {
  saveCameraSettings();
  if (!stream || done) return;
  minimumAcceptedScanId = frameId;
  cropAttempts.clear();
  fullScanJobs.clear();
  scanCapturedAt.clear();
  clearPendingGridLanes();
  pool.resize(selectedWorkerCount());
});
window.addEventListener("airgapper:enter-receive", () => {
  if (!stream && !startBtn.disabled) void start();
});
const { setStatus, showError } = statusLine(stats);
function restartButton(label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary-button";
  button.textContent = label;
  button.addEventListener("click", () => window.location.reload());
  return button;
}
function offerRetry(message) {
  startBtn.disabled = false;
  startBtn.hidden = false;
  startBtn.style.display = "";
  startBtn.textContent = "Try camera again";
  preview.style.display = "";
  preview.classList.remove("camera-loading");
  metricsEl.style.display = "block";
  progressStatus.style.display = "block";
  progressEl.style.display = "block";
  showError(message);
}
let frameTrackProcessor = null;
let frameTrackReader = null;
let framePumpMode = "—";
let framePumpProcessorTotal = 0;
let framePumpProcessorDiscarded = 0;
let framePumpStartedAt = 0;
let framePumpFirstFrameAt = 0;
let rvfcLastPresentedFrames = 0;
let rvfcSkippedFrames = 0;
let frameModeSync;
let frameModeMismatchDrops = 0;
let frameModeSyncTimeouts = 0;
const FRAME_MODE_SYNC_TIMEOUT_MS = 900;
let overlayDrawQueued = false;
function queueOverlayDraw() {
  if (overlayDrawQueued) return;
  overlayDrawQueued = true;
  requestAnimationFrame(() => {
    overlayDrawQueued = false;
    if (!done && stream) drawOverlay(receiverNow());
  });
}
function stopFramePump() {
  const reader = frameTrackReader;
  frameTrackReader = null;
  frameTrackProcessor = null;
  framePumpMode = "—";
  framePumpProcessorTotal = 0;
  framePumpProcessorDiscarded = 0;
  framePumpStartedAt = 0;
  framePumpFirstFrameAt = 0;
  rvfcLastPresentedFrames = 0;
  rvfcSkippedFrames = 0;
  if (reader) {
    void reader.cancel().catch(() => void 0).finally(() => {
      try { reader.releaseLock(); } catch {}
    });
  }
}
function stopReceiver() {
  cameraStartGen++;
  manualOpticsReapplyGeneration++;
  focusController.detach();
  captureGen++;
  receiverPaused = false;
  pauseStartedAt = 0;
  releaseScreenWakeLock();
  document.body.classList.remove("receive-complete");
  stopFramePump();
  stream == null ? void 0 : stream.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
  clearInterval(statsTimer);
  statsTimer = void 0;
  clearPendingGridLanes();
  pool.resize(0);
  releaseTransportDecoder();
  streamKey = "";
  startTs = 0;
  done = false;
  regions.length = 0;
  gridLattice.reset();
  gridShape = "";
  lastGridSnapshot = void 0;
  activeDecodeBudget = 0;
  lastDecodedRegionSize = 0;
  expectedRegions = 0;
  expectedRegionsAt = 0;
  lastFullScan = 0;
  fullScanJobs.clear();
  scanCapturedAt.clear();
  scanOutcomes.clear();
  hotPathJobMode.clear();
  scanCandidateEpoch.clear();
  optimizerJobIds.clear();
  optimizerValidEvents.clear();
  benchmarkJobFrames.clear();
  captureTimes.length = 0;
  qrReadTimes.length = 0;
  uniqueQrTimes.length = 0;
  duplicateQrTimes.length = 0;
  resetDuplicateAttribution();
  repeatSkipTimes.length = 0;
  latestRepeatSignature = undefined;
  poolBusyTimes.length = 0;
  scanCompletionTimes.length = 0;
  decodeFrameTimes.length = 0;
  lastDecodeSubmittedSourceSequence = -1;
  cropAttempts.clear();
  cropRotate = 0;
  decodeExceptions = 0;
  lastDecodeError = "";
  lastNativeMetrics = void 0;
  lastGuidedMetrics = void 0;
  lastDirectPixelPath = "—";
  resetHotPathAudit();
  strictHotPathLockSeen = false;
  trackingInvalidations = 0;
  workerLatencyMaxMs = 0;
  lastDistinctArrivalAt = 0;
  lastStreamDecodeAt = 0;
  geometryRecoveryProbes = 0;
  geometryRecoveryResets = 0;
  geometryCoverageHealthy = false;
  geometryCoverageCollapseStreak = 0;
  geometryCoverageCollapseLastAt = 0;
  geometryCoverageCollapseStartedAt = 0;
  geometryCoverageLastScanId = -1;
  recoveryWorkerRestarts = 0;
  recoveryAbortedJobs = 0;
  recoveryAbortedWorkerMs = 0;
  lastRecoveryReason = "—";
  decoderFreshnessHoldUntil = 0;
  decoderFreshnessHoldActive = false;
  frameModeSync = void 0;
  frameModeMismatchDrops = 0;
  frameModeSyncTimeouts = 0;
  maxSequenceGapMs = 0;
  pipelineEvents.length = 0;
  usefulFrameTimes.length = 0;
  totalCaptures = 0;
  totalDecodes = 0;
  fullScans = 0;
  acquisitionTileCursor = 0;
  peakRegions = 0;
  capturesDropped = 0;
  cameraStartedTs = 0;
  lastOpticalSampleAt = -Infinity;
  lastOpticalSourceSequence = -1;
  opticalAnalyzeCount = 0;
  opticalAnalyzeTotalMs = 0;
  opticalAnalyzeMaxMs = 0;
  opticalTimingStartedAt = performance.now();
  timeline.length = 0;
  plainQrPolicy.reset();
  result.replaceChildren();
  purgeReceivedData();
  preview.style.display = "none";
  preview.classList.remove("camera-loading");
  cameraActual.textContent = "";
  clearTimeout(scanCaptureTimer);
  scanCaptureTimer = void 0;
  pendingScanCapture = null;
  captureNextScan = false;
  minimumAcceptedScanId = frameId;
  captureScanBtn.textContent = "Capture";
  captureScanBtn.disabled = false;
  if (scanDialog.open) scanDialog.close();
  scanCapture.width = 0;
  scanCapture.height = 0;
  lastRawScanImage = null;
  cancelScanHold();
  progressEl.style.display = "none";
  progressEl.setAttribute("aria-valuenow", "0");
  progressStatus.style.display = "none";
  progressLabel.textContent = "0%";
  transferSizeLabel.textContent = "";
  etaLabel.textContent = "";
  bar.style.width = "0";
  bar.classList.remove("error");
  metricsEl.style.display = "none";
  metric("m-cap").textContent = "— fps";
  metric("m-dec").textContent = "— QR/s";
  metric("m-limit").textContent = "";
  metric("m-rate").textContent = "👀";
  speedFeedback.className = "speed-feedback";
  pipelineMetrics.style.display = "";
  startBtn.disabled = false;
  startBtn.hidden = false;
  startBtn.style.display = "";
  startBtn.textContent = "Enable camera";
  setStatus("");
}
function pauseReceiver() {
  if (receiverPaused || done) return;
  focusController.detach();
  receiverPaused = true;
  pauseStartedAt = receiverNow();
  cameraStartGen++;
  captureGen++;
  releaseScreenWakeLock();
  stopFramePump();
  stream == null ? void 0 : stream.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
  clearInterval(statsTimer);
  statsTimer = void 0;
  clearPendingGridLanes();
  pool.resize(0);
  cropAttempts.clear();
  fullScanJobs.clear();
  scanCapturedAt.clear();
  minimumAcceptedScanId = frameId;
}
function resumeReceiver() {
  if (!receiverPaused || done) return;
  const pausedFor = receiverNow() - pauseStartedAt;
  receiverPaused = false;
  if (startTs) startTs += pausedFor;
  if (cameraStartedTs) cameraStartedTs += pausedFor;
  void start();
}
window.addEventListener("airgapper:leave-mode", () => {
  var _a;
  if ((_a = document.getElementById("receiveView")) == null ? void 0 : _a.classList.contains("active")) stopReceiver();
});
window.addEventListener("pagehide", stopReceiver);
window.addEventListener("airgapper:pause-mode", () => {
  var _a;
  if ((_a = document.getElementById("receiveView")) == null ? void 0 : _a.classList.contains("active")) pauseReceiver();
});
window.addEventListener("airgapper:resume-mode", () => {
  var _a;
  if ((_a = document.getElementById("receiveView")) == null ? void 0 : _a.classList.contains("active")) resumeReceiver();
});
const localCameraMessage = "This browser does not allow camera access from a local file. Use the installed offline PWA for receiving.";
async function start() {
  var _a;
  const startAttempt = cameraStartGen;
  clearPendingGridLanes();
  try {
    await prepareRaptorQ();
  } catch (error) {
    offerRetry(`Transport: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (startAttempt !== cameraStartGen || receiverPaused) return;
  preview.style.display = "";
  preview.classList.add("camera-loading");
  metricsEl.style.display = "block";
  progressStatus.style.display = "block";
  progressEl.style.display = "block";
  showRequestedCameraSettings();
  if (!((_a = navigator.mediaDevices) == null ? void 0 : _a.getUserMedia)) {
    offerRetry(
      location.protocol === "file:" ? localCameraMessage : "Camera access needs HTTPS. Open the hosted app or its installed offline PWA."
    );
    return;
  }
  const captureWidth = requestedWidth;
  const captureHeight = requestedHeight;
  const captureFps = requestedFps;
  startBtn.disabled = true;
  startBtn.style.display = "none";
  const cameraChoice = cameraDeviceConstraint();
  const base = {
    ...cameraChoice,
    width: { exact: captureWidth },
    height: { exact: captureHeight }
  };
  let acquiredStream;
  try {
    if (legacyAndroidApp) {
      acquiredStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          ...cameraChoice,
          width: { ideal: captureWidth },
          height: { ideal: captureHeight }
        }
      });
    } else if (cameraResolution.value === "auto") {
      acquiredStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { ...cameraChoice, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } }
      });
    } else if (isAndroidApp()) {
      try {
        acquiredStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...base, frameRate: { exact: captureFps } } });
      } catch {
        acquiredStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { ...cameraChoice, width: { ideal: captureWidth }, height: { ideal: captureHeight }, frameRate: { ideal: captureFps } }
        });
      }
    } else {
      try {
        acquiredStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { ...base, frameRate: { exact: captureFps } }
        });
      } catch {
        acquiredStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { ...cameraChoice, width: { ideal: captureWidth }, height: { ideal: captureHeight }, frameRate: { ideal: captureFps } }
        });
      }
    }
  } catch (err) {
    if (startAttempt !== cameraStartGen || receiverPaused) return;
    const denied = err instanceof DOMException && err.name === "NotAllowedError";
    offerRetry(
      denied ? location.protocol === "file:" ? localCameraMessage : "Camera permission denied — allow it, then tap Enable camera again." : `Camera: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }
  if (startAttempt !== cameraStartGen || receiverPaused) {
    acquiredStream.getTracks().forEach((track) => track.stop());
    return;
  }
  stream = acquiredStream;
  const startupOpticsTrack = stream.getVideoTracks()[0];
  if (startupOpticsTrack && !automaticOptics) {
    seedDesiredCamera(startupOpticsTrack);
    await applyExposureSetting(startupOpticsTrack);
  }
  startBtn.style.display = "none";
  preview.style.display = "";
  video.srcObject = stream;
  await video.play().catch(() => void 0);
  preview.classList.remove("camera-loading");
  const activeTrack = stream.getVideoTracks()[0];

  // Decoder startup is the critical path. A live <video> must never sit visible
  // while enumerateDevices/capability UI work delays the first camera frame.
  syncPreviewAspect();
  setStatus("");
  pool.resize(selectedWorkerCount());
  cameraStartedTs = receiverNow();
  resetLivePipeline(cameraStartedTs);
  captureGen++;
  startFramePump(captureGen, activeTrack);
  statsTimer = setInterval(updateStats, STATS_TICK_MS);

  if (activeTrack) {
    populateBrowserCapabilities(activeTrack);
    showNegotiatedWebMode(activeTrack);
    if (!legacyAndroidApp) attachCameraController(activeTrack);
    void refreshCameraDevices(activeTrack);
  }
  if (activeTrack && !automaticOptics) void reapplyManualOpticsAfterFreshFrames(activeTrack, "camera started");
  await requestScreenWakeLock();
}
const CORPUS_DEVICE_NAMES = {
  "0dc8b7d5f6e84e81cf126349d821a9d948a6db87ea4a810c04a51aec6999401c": "OP5",
  "5e792630f18c1d6bc5fc26e8ce6d90a27163fd50f32c7631256aa9e7bc7b193e": "OP12R"
};
function compactDeviceName(header) {
  var _a, _b;
  const id = String((_a = header.cameraSettings.deviceId) != null ? _a : "");
  return (_b = CORPUS_DEVICE_NAMES[id]) != null ? _b : `D${id.slice(0, 4) || "unk"}`;
}
function compactVersionName(version) {
  return version.replace(/^v?0\./, "v").replace(/^([^v])/, "v$1");
}
function compactTimeName(value) {
  const date = value instanceof Date ? value : new Date(value);
  const two = (number) => String(number).padStart(2, "0");
  return `${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}-${two(date.getUTCHours())}${two(date.getUTCMinutes())}`;
}
async function finishCorpusRecording(recorder) {
  if (benchmarkRecorder !== recorder) return;
  benchmarkRecorder = void 0;
  recordCorpusBtn.disabled = true;
  recordCorpusBtn.textContent = "Saving…";
  try {
    const { blob, header, corpus } = await recorder.finish();
    benchmarkPendingBlob = void 0;
    benchmarkCorpus = corpus;
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `cap-${compactDeviceName(header)}-${compactVersionName(header.airgapperVersion)}-${compactTimeName(header.startedAt)}.agcap`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 2e3);
    benchmarkStatus.textContent = `Downloaded ${header.framesStored} lossless frames · ${header.recorderDrops} recorder drops · ${header.estimatedCameraDrops} estimated camera drops · ready to run`;
    runBenchmarkBtn.disabled = false;
    benchmarkDialog.showModal();
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  } finally {
    recordCorpusBtn.disabled = false;
    recordCorpusBtn.textContent = "Record";
    setStatus("");
  }
}
function sourceFrameMeta(videoFrame, callbackTime = performance.now()) {
  const timestamp = Number(videoFrame?.timestamp);
  const width = videoFrame
    ? videoFrame.displayWidth || videoFrame.visibleRect?.width || videoFrame.codedWidth || video.videoWidth || 0
    : video.videoWidth || 0;
  const height = videoFrame
    ? videoFrame.displayHeight || videoFrame.visibleRect?.height || videoFrame.codedHeight || video.videoHeight || 0
    : video.videoHeight || 0;
  const sequence = benchmarkRecordingSequence++;
  latestSourceFrameSequence = sequence;
  return {
    sequence,
    opticsEpoch: activeOptimizerEpoch?.collecting ? activeOptimizerEpoch.id : void 0,
    width,
    height,
    callbackTimeMs: callbackTime,
    mediaTimeMs: Number.isFinite(timestamp) ? timestamp / 1e3 : callbackTime,
    presentationTimeMs: callbackTime,
    expectedDisplayTimeMs: callbackTime,
    videoFrame
  };
}
function processSourceFrame(frame, gen) {
  if (done || gen !== captureGen) {
    frame.videoFrame?.close();
    return;
  }
  if (frameModeSync) {
    const matches = sameModeSize(frame, frameModeSync);
    if (!matches && performance.now() - frameModeSync.startedAt < FRAME_MODE_SYNC_TIMEOUT_MS) {
      frameModeMismatchDrops++;
      frame.videoFrame?.close();
      return;
    }
    if (!matches) {
      frameModeSyncTimeouts++;
      notePipelineEvent("frame-mode-sync-timeout", frameModeMismatchDrops);
    } else {
      notePipelineEvent("frame-mode-synced", frameModeMismatchDrops);
    }
    frameModeSync = void 0;
  }
  if (optimizerPipelineActive && !activeOptimizerEpoch) {
    optimizerTransitionFramesDiscarded++;
    traceOptimizer({
      time: receiverNow(),
      event: "TRANSITION_FRAME",
      candidateId: optimizerTransition?.candidateId,
      sourceSequence: frame.sequence,
      requestedExposure: optimizerTransition?.requestedExposure,
      requestedIso: optimizerTransition?.requestedIso
    });
  }
  const recorder = benchmarkRecorder;
  if (recorder && frame.width && frame.height) {
    const orientation = screen.orientation?.type ?? `${window.orientation ?? 0}`;
    recorder.addVideo({
      sequence: frame.sequence,
      mediaTimeMs: frame.mediaTimeMs,
      presentationTimeMs: frame.presentationTimeMs,
      expectedDisplayTimeMs: frame.expectedDisplayTimeMs,
      callbackTimeMs: frame.callbackTimeMs,
      width: frame.width,
      height: frame.height,
      stride: frame.width * 4,
      orientation
    }, video);
    recordCorpusBtn.textContent = recorder.complete ? "Saving…" : `Stop · ${Math.max(1, Math.ceil((recorder.durationMs - recorder.elapsedMs) / 1e3))}s`;
    frame.videoFrame?.close();
    queueOverlayDraw();
    if (recorder.complete) void finishCorpusRecording(recorder);
    return;
  }
  void captureFrame(frame).catch((error) => {
    decodeExceptions++;
    lastDecodeError = `captureFrame: ${error instanceof Error ? error.message : String(error)}`;
    console.error("AirGapper captureFrame failed", error);
  }).finally(() => {
    frame.videoFrame?.close();
    if (done || gen !== captureGen) return;
    queueOverlayDraw();
  });
}
async function pumpTrackFrames(gen, reader, processor) {
  try {
    while (!done && gen === captureGen && frameTrackReader === reader) {
      const { value, done: ended } = await reader.read();
      if (ended) break;
      if (!value) continue;
      if (done || gen !== captureGen || frameTrackReader !== reader) {
        value.close();
        break;
      }
      framePumpProcessorTotal = Number(processor.totalFrames ?? framePumpProcessorTotal + 1);
      framePumpProcessorDiscarded = Number(processor.discardedFrames ?? framePumpProcessorDiscarded);
      if (!framePumpFirstFrameAt) framePumpFirstFrameAt = receiverNow();
      processSourceFrame(sourceFrameMeta(value), gen);
    }
  } catch (error) {
    if (done || gen !== captureGen || frameTrackReader !== reader) return;
    console.warn("MediaStreamTrackProcessor frame pump failed; falling back to requestVideoFrameCallback", error);
    try { reader.releaseLock(); } catch {}
    frameTrackReader = null;
    frameTrackProcessor = null;
    framePumpMode = "rVFC fallback";
    scheduleFrame(gen);
  }
}
function restartFramePumpForCameraMode(track, reason = "camera mode changed") {
  if (!track || done) return;
  const settings = track.getSettings();
  captureGen++;
  frameModeMismatchDrops = 0;
  frameModeSync = settings.width && settings.height ? {
    width: Number(settings.width),
    height: Number(settings.height),
    startedAt: performance.now(),
    reason
  } : void 0;
  startFramePump(captureGen, track);
  if (!automaticOptics) void reapplyManualOpticsAfterFreshFrames(track, reason);
  notePipelineEvent("frame-pump-mode-restart");
}

function startFramePump(gen, track) {
  stopFramePump();
  framePumpStartedAt = receiverNow();
  if (track && typeof MediaStreamTrackProcessor === "function") {
    try {
      const processor = new MediaStreamTrackProcessor({ track, maxBufferSize: 1 });
      const reader = processor.readable.getReader();
      frameTrackProcessor = processor;
      frameTrackReader = reader;
      framePumpMode = "MediaStreamTrackProcessor";

      // Some Android camera stacks can leave TrackProcessor.read() pending even
      // though the <video> preview is already advancing. Do not allow a silent
      // processor stall to leave Receive at 0 fps indefinitely; rVFC can start
      // decoding from the same live stream immediately.
      const startupWatchdog = setTimeout(() => {
        if (done || gen !== captureGen || frameTrackReader !== reader || framePumpProcessorTotal > 0) return;
        console.warn("MediaStreamTrackProcessor produced no startup frame; using requestVideoFrameCallback");
        frameTrackReader = null;
        frameTrackProcessor = null;
        framePumpMode = "rVFC startup fallback";
        notePipelineEvent("frame-pump-startup-fallback");
        void reader.cancel().catch(() => void 0).finally(() => {
          try { reader.releaseLock(); } catch {}
        });
        scheduleFrame(gen);
      }, 800);
      void pumpTrackFrames(gen, reader, processor).finally(() => clearTimeout(startupWatchdog));
      return;
    } catch (error) {
      console.warn("MediaStreamTrackProcessor unavailable; using requestVideoFrameCallback", error);
    }
  }
  framePumpMode = "rVFC fallback";
  scheduleFrame(gen);
}
function scheduleFrame(gen) {
  if (done || gen !== captureGen) return;
  const v = video;
  const next = (callbackTime = performance.now(), metadata = {}) => {
    if (done || gen !== captureGen || framePumpMode === "MediaStreamTrackProcessor") return;
    if (!framePumpFirstFrameAt) framePumpFirstFrameAt = receiverNow();
    scheduleFrame(gen);
    const presented = Number(metadata.presentedFrames);
    if (Number.isFinite(presented) && presented > 0) {
      if (rvfcLastPresentedFrames > 0 && presented > rvfcLastPresentedFrames + 1) rvfcSkippedFrames += presented - rvfcLastPresentedFrames - 1;
      rvfcLastPresentedFrames = presented;
    }
    const frame = sourceFrameMeta(null, callbackTime);
    frame.mediaTimeMs = Number.isFinite(Number(metadata.mediaTime)) ? Number(metadata.mediaTime) * 1e3 : callbackTime;
    frame.presentationTimeMs = Number.isFinite(Number(metadata.presentationTime)) ? Number(metadata.presentationTime) : callbackTime;
    frame.expectedDisplayTimeMs = Number.isFinite(Number(metadata.expectedDisplayTime)) ? Number(metadata.expectedDisplayTime) : callbackTime;
    processSourceFrame(frame, gen);
  };
  if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(next);
  else requestAnimationFrame((now) => next(now));
}
const grab = document.createElement("canvas");
const replaySourceCanvas = document.createElement("canvas");
let minimumAcceptedScanId = 0;
let decoderFreshnessHoldUntil = 0;
let decoderFreshnessHoldActive = false;

function discardInFlightDecodeWork(reason, restartWorkers = true) {
  const active = pool.activeJobs;
  minimumAcceptedScanId = frameId;
  clearPendingGridLanes();
  cropAttempts.clear();
  fullScanJobs.clear();
  scanCapturedAt.clear();
  for (const job of active) {
    if (job.id === void 0) continue;
    hotPathJobMode.delete(job.id);
    scanOutcomes.delete(job.id);
    scanCandidateEpoch.delete(job.id);
    optimizerJobIds.delete(job.id);
  }
  recoveryAbortedJobs += active.length;
  recoveryAbortedWorkerMs += active.reduce((sum, job) => sum + Math.max(0, job.ageMs || 0), 0);
  if (restartWorkers && pool.size) {
    const count = selectedWorkerCount();
    pool.resize(0);
    if (stream && !done) pool.resize(count);
    recoveryWorkerRestarts++;
  }
  lastRecoveryReason = reason;
  notePipelineEvent("decoder-fresh-start", active.length);
}

function holdDecoderForCameraMutation(reason, settleMs = CAMERA_MUTATION_SETTLE_MS) {
  const now = receiverNow();
  decoderFreshnessHoldUntil = Math.max(decoderFreshnessHoldUntil, now + settleMs);
  if (!decoderFreshnessHoldActive) {
    decoderFreshnessHoldActive = true;
    // Geometry remains valid across exposure/focus changes. Only old-image
    // work is stale, so restart workers without throwing away the lattice.
    discardInFlightDecodeWork(reason, true);
    resetGuidedRollout();
  }
}

function enterGeometryRecovery(reason, now = receiverNow(), restartWorkers = true) {
  geometryRecoveryResets++;
  geometryCoverageHealthy = false;
  geometryCoverageCollapseStreak = 0;
  geometryCoverageCollapseLastAt = 0;
  geometryCoverageCollapseStartedAt = 0;
  geometryCoverageLastScanId = -1;
  decoderFreshnessHoldActive = false;
  decoderFreshnessHoldUntil = 0;
  discardInFlightDecodeWork(reason, restartWorkers);
  if (gridLattice.state !== "REACQUIRE") gridLattice.reacquire(now, reason);
  regions.length = 0;
  gridShape = "";
  lastGridSnapshot = void 0;
  activeDecodeBudget = 0;
  expectedRegions = 0;
  expectedRegionsAt = now;
  lastDecodedRegionSize = 0;
  lastFullScan = 0;
  resetGuidedRollout();
  notePipelineEvent("geometry-recovery", geometryRecoveryResets);
}

let captureNextScan = false;
let scanCaptureTimer;
const SCAN_CAPTURE_TIMEOUT_MS = 12e3;
let pendingScanCapture = null;
let lastRawScanImage = null;
const scanSaveCanvas = document.createElement("canvas");
let scanHoldTimer;
let scanHoldStart;
let scanSaveInProgress = false;
async function saveRawScan() {
  const image = lastRawScanImage;
  if (!image || scanSaveInProgress) return;
  scanSaveInProgress = true;
  try {
    scanSaveCanvas.width = image.width;
    scanSaveCanvas.height = image.height;
    scanSaveCanvas.getContext("2d").putImageData(image, 0, 0);
    const blob = await new Promise((resolve) => scanSaveCanvas.toBlob(resolve, "image/png"));
    if (!blob) return;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
    const name = `airgapper-scan-${stamp}.png`;
    if (!saveFileOnAndroid(name, "image/png", bytes)) {
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1e3);
    }
  } finally {
    scanSaveInProgress = false;
  }
}
function cancelScanHold() {
  clearTimeout(scanHoldTimer);
  scanHoldTimer = void 0;
  scanHoldStart = void 0;
}
scanCapture.addEventListener("pointerdown", (event) => {
  if (!lastRawScanImage || event.button !== 0 || !isAndroidApp()) return;
  cancelScanHold();
  scanHoldStart = { x: event.clientX, y: event.clientY };
  scanHoldTimer = setTimeout(() => {
    var _a;
    cancelScanHold();
    (_a = navigator.vibrate) == null ? void 0 : _a.call(navigator, 30);
    showScanCaptureMenuOnAndroid();
  }, 550);
});
scanCapture.addEventListener("pointermove", (event) => {
  if (scanHoldStart && Math.hypot(event.clientX - scanHoldStart.x, event.clientY - scanHoldStart.y) > 12) cancelScanHold();
});
scanCapture.addEventListener("pointerup", cancelScanHold);
scanCapture.addEventListener("pointercancel", cancelScanHold);
scanCapture.addEventListener("contextmenu", (event) => {
  if (!lastRawScanImage || !isAndroidApp()) return;
  event.preventDefault();
  cancelScanHold();
  showScanCaptureMenuOnAndroid();
});
window.airgapperSaveRawScan = () => void saveRawScan();
captureScanBtn.addEventListener("click", () => {
  if (captureNextScan || pendingScanCapture) return;
  captureNextScan = true;
  captureScanBtn.textContent = "Capturing…";
  captureScanBtn.disabled = true;
  scanCapture.width = 0;
  scanCapture.height = 0;
  lastRawScanImage = null;
  scanDialogStatus.textContent = "Capturing the next fresh camera frame…";
  scanSightingLegend.hidden = true;
  if (!scanDialog.open) scanDialog.showModal();
  clearTimeout(scanCaptureTimer);
  scanCaptureTimer = setTimeout(() => {
    scanDialogStatus.textContent = "Capture timed out — try again.";
    cancelScanCapture();
  }, SCAN_CAPTURE_TIMEOUT_MS);
});
closeScanBtn.addEventListener("click", () => scanDialog.close());
scanDialog.addEventListener("click", (event) => {
  if (event.target === scanDialog) scanDialog.close();
});
scanDialog.addEventListener("close", () => {
  if (captureNextScan || pendingScanCapture) cancelScanCapture();
});
function validQuadObject(quad) {
  if (!quad) return false;
  const points = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];
  return points.every((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y));
}
function trackedQuadBounds(quad) {
  if (!validQuadObject(quad)) return null;
  const points = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];
  return {
    left: Math.min(...points.map((point) => point.x)),
    top: Math.min(...points.map((point) => point.y)),
    right: Math.max(...points.map((point) => point.x)),
    bottom: Math.max(...points.map((point) => point.y))
  };
}
function validTrackedQuad(region, vw, vh) {
  if (!region.quad) return false;
  const bounds = trackedQuadBounds(region.quad);
  if (!bounds) return false;
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  const regionSize = Math.max(region.w, region.h);
  const quadSize = Math.max(width, height);
  return width >= 24 && height >= 24 && Math.max(width / height, height / width) <= 2.5 && bounds.right > 0 && bounds.bottom > 0 && bounds.left < vw && bounds.top < vh && quadSize >= regionSize * 0.4 && quadSize <= regionSize * 2.5;
}
function invalidateTrackedQuad(region) {
  region.quad = void 0;
  region.dim = void 0;
  region.consecutiveMisses = 0;
  trackingInvalidations++;
  notePipelineEvent("tracking-invalidated", trackingInvalidations);
}
function captureSubmittedScan(image, ox, oy, full, tracks = [], scaleX = 1, scaleY = 1) {
  if (!captureNextScan) return;
  captureNextScan = false;
  pendingScanCapture = {
    image: new ImageData(new Uint8ClampedArray(image.data), image.width, image.height),
    ox,
    oy,
    full,
    tracks,
    scaleX,
    scaleY
  };
  scanCapture.width = image.width;
  scanCapture.height = image.height;
  scanCapture.getContext("2d").putImageData(pendingScanCapture.image, 0, 0);
  scanDialogStatus.textContent = `${full ? "Full-frame scan" : `${tracks.length || 1} tracked region${tracks.length === 1 ? "" : "s"}`} · ${image.width}×${image.height} · decoding…`;
  scanSightingLegend.hidden = true;
  if (!scanDialog.open) scanDialog.showModal();
}
function cancelScanCapture() {
  clearTimeout(scanCaptureTimer);
  scanCaptureTimer = void 0;
  pendingScanCapture = null;
  captureNextScan = false;
  captureScanBtn.textContent = "Capture";
  captureScanBtn.disabled = false;
}
function finishScanCapture(id, completion) {
  const capture = pendingScanCapture;
  if (!capture || capture.id !== id) return;
  cancelScanCapture();
  lastRawScanImage = capture.image;
  scanCapture.width = capture.image.width;
  scanCapture.height = capture.image.height;
  const ctx = scanCapture.getContext("2d");
  ctx.putImageData(capture.image, 0, 0);
  const drawQuad = (quad, color, width) => {
    if (!validQuadObject(quad)) return;
    const points = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];
    ctx.beginPath();
    points.forEach((point, index) => {
      const x = (point.x - capture.ox) / capture.scaleX;
      const y = (point.y - capture.oy) / capture.scaleY;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  };
  for (const quad of capture.tracks) drawQuad(quad, "#248cff", 3);
  for (const symbol of completion.symbols) if (symbol.quad) drawQuad(symbol.quad, "#20c969", 5);
  ctx.strokeStyle = "#f2a51a";
  ctx.lineWidth = 4;
  for (const box of completion.sightings) ctx.strokeRect(
    (box.x - capture.ox) / capture.scaleX,
    (box.y - capture.oy) / capture.scaleY,
    box.w / capture.scaleX,
    box.h / capture.scaleY
  );
  const tracked = !capture.full;
  const mode = capture.full ? "Full-frame scan" : `${capture.tracks.length || 1} tracked region${capture.tracks.length === 1 ? "" : "s"}`;
  scanDialogStatus.textContent = completion.error ? `${mode} · ${capture.image.width}×${capture.image.height} · ${completion.error}` : tracked ? `${mode} · ${capture.image.width}×${capture.image.height} · ${completion.symbolCount} decoded${completion.fallbackAttempted ? ` · fallback searched${completion.sightingCount ? ` · ${completion.sightingCount} found` : ""}` : ""}` : `${mode} · ${capture.image.width}×${capture.image.height} · ${completion.symbolCount} decoded · ${completion.sightingCount} found`;
  const outcome = scanOutcomes.get(id);
  if (outcome && completion.symbolCount > 0) {
    const details = [
      outcome.accepted && `${outcome.accepted} accepted`,
      outcome.duplicate && `${outcome.duplicate} duplicate`,
      outcome.redundant && `${outcome.redundant} redundant`,
      outcome.rejected && `${outcome.rejected} rejected`,
      outcome.stale && `${outcome.stale} stale`,
      outcome.otherStream && `${outcome.otherStream} other stream`
    ].filter(Boolean).join(" · ");
    if (details) scanDialogStatus.textContent += ` · ${details}`;
  }
  const gridSummary = gridDebugSummary();
  if (gridSummary) scanDialogStatus.textContent += ` · ${gridSummary}`;
  scanSightingLegend.hidden = tracked && !completion.fallbackAttempted;
  if (!scanDialog.open) scanDialog.showModal();
}
function readBoundedVideoCrop(source, x, y, w, h) {
  if (grab.width < w) grab.width = w;
  if (grab.height < h) grab.height = h;
  const ctx = grab.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  const sx = Math.max(0, x);
  const sy = Math.max(0, y);
  const right = Math.min(source.width, x + w);
  const bottom = Math.min(source.height, y + h);
  if (right > sx && bottom > sy) {
    if (source.image) {
      if (replaySourceCanvas.width !== source.width || replaySourceCanvas.height !== source.height) {
        replaySourceCanvas.width = source.width;
        replaySourceCanvas.height = source.height;
      }
      replaySourceCanvas.getContext("2d").putImageData(source.image, 0, 0);
      ctx.drawImage(replaySourceCanvas, sx, sy, right - sx, bottom - sy, sx - x, sy - y, right - sx, bottom - sy);
    } else {
      ctx.drawImage(video, sx, sy, right - sx, bottom - sy, sx - x, sy - y, right - sx, bottom - sy);
    }
  }
  return ctx.getImageData(0, 0, w, h);
}
function submitReceiverJob(message, transfer, kind, trace, sourceSequence, trackedRegions = [], fixedAttempts = 0, sourceOpticsEpoch, preferredWorker) {
  if (message.strictHotPath === void 0) message.strictHotPath = strictHotPathActive();
  if (message.strictHotPath && !gridLattice.locked && !message.full) {
    notePipelineEvent("strict-prelock-job-rejected");
    if (trace) trace.decision = "strict pre-lock: only full acquisition allowed";
    return false;
  }
  const guidedStage = chooseGuidedStage(message);
  if (guidedStage) message.guidedFallbackMask = guidedFallbackMaskForTracks(message.tracks);
  const auditMode = {
    generation: hotPathAuditGeneration,
    strict: Boolean(message.strictHotPath),
    full: Boolean(message.full),
    acquisition: Boolean(message.full && !gridLattice.locked),
    reacquire: Boolean(message.full && gridLattice.locked),
    tracks: Array.isArray(message.tracks) ? message.tracks.length : 0,
    guided: Boolean(guidedStage),
    guidedStage,
    kind
  };
  message.jobKind = kind;
  message.trackCount = auditMode.tracks;
  message.sourceSequence = sourceSequence;
  if (sourceOpticsEpoch !== void 0) message.opticsEpoch = sourceOpticsEpoch;
  const repeatEligible = Boolean(
    guidedStage && !auditMode.full && auditMode.tracks >= 2 && message.pixelFormat === "y8" &&
    !replayRunning && !optimizerPipelineActive && !["tuning", "rescue", "settling"].includes(autoOpticsRuntimeState) && !captureNextScan
  );
  message.repeatFilter = repeatEligible;
  if (repeatEligible && latestRepeatSignature?.sourceSequence === sourceSequence - 1) {
    message.previousFrameSignature = latestRepeatSignature.signature;
  }
  const accepted = preferredWorker === void 0 ? pool.submit(message, transfer) : pool.submitTo(preferredWorker, message, transfer);
  if (!accepted && guidedStage) guidedRollout.inFlight = Math.max(0, guidedRollout.inFlight - 1);
  if (accepted) {
    hotPathJobMode.set(message.id, auditMode);
    const submittedAt = receiverNow();
    if (!replayRunning && livePipeline.startedAt) {
      livePipeline.submittedJobs++;
      const submittedPixels = Math.max(0, Number(message.w) || 0) * Math.max(0, Number(message.h) || 0);
      if (auditMode.full) {
        livePipeline.submittedFull++;
        livePipeline.submittedFullPixels += submittedPixels;
        if (auditMode.reacquire) livePipeline.submittedReacquire++;
        else livePipeline.submittedAcquisition++;
      } else {
        livePipeline.submittedTracked++;
        livePipeline.submittedTracks += auditMode.tracks;
        livePipeline.submittedTrackedPixels += submittedPixels;
      }
      livePipeline.submittedPixels += submittedPixels;
      if (sourceSequence !== livePipeline.lastSubmittedSourceSequence) {
        livePipeline.lastSubmittedSourceSequence = sourceSequence;
        livePipeline.submittedFrames++;
      }
      livePipeline.lastSubmittedAt = submittedAt;
    }
    hotJobSubmitSamples.push({
      at: submittedAt,
      tracks: auditMode.tracks,
      full: auditMode.full,
      pixels: Math.max(0, Number(message.w) || 0) * Math.max(0, Number(message.h) || 0)
    });
    scanCapturedAt.set(message.id, submittedAt);
    if (sourceSequence !== lastDecodeSubmittedSourceSequence) {
      lastDecodeSubmittedSourceSequence = sourceSequence;
      decodeFrameTimes.push(submittedAt);
    }
    if (sourceOpticsEpoch !== void 0) {
      optimizerJobsSubmittedTotal++;
      optimizerJobIds.add(message.id);
      const epoch = optimizerEpochs.get(sourceOpticsEpoch);
      const evidence = candidateEvidenceWindows.get(sourceOpticsEpoch);
      if (epoch && evidence && epoch.id === sourceOpticsEpoch) {
        const attribution = {
          scanId: message.id,
          sourceFrameSequence: sourceSequence,
          epoch: { ...epoch },
          evidence,
          fixedAttempts,
          validDecodes: 0,
          usefulSymbols: 0
        };
        scanCandidateEpoch.set(message.id, attribution);
        optimizerJobsMappedTotal++;
        evidence.submittedJobs++;
        evidence.sourceFrames.add(sourceSequence);
        evidence.qrAttempts += fixedAttempts;
        traceOptimizer({
          time: receiverNow(),
          event: "JOB_SUBMIT",
          candidateId: epoch.candidateId,
          candidateEpoch: epoch.id,
          sourceSequence,
          scanId: message.id,
          requestedExposure: epoch.requestedExposure,
          requestedIso: epoch.requestedIso,
          actualExposure: epoch.actualExposure,
          actualIso: epoch.actualIso
        });
      } else {
        console.error("OPTIMIZER ATTRIBUTION BUG", { scanId: message.id, sourceSequence, sourceOpticsEpoch });
        traceOptimizer({ time: receiverNow(), event: "ATTRIBUTION_BUG", sourceSequence, scanId: message.id, candidateEpoch: sourceOpticsEpoch });
      }
    }
    if (message.full) {
      fullScanJobs.set(message.id, {
        thorough: Boolean(message.thorough),
        native: true,
        reacquire: gridLattice.locked,
        acquisition: !gridLattice.locked
      });
    }
  }
  if (trace) {
    trace.decision = accepted ? kind : "worker busy";
    const job = {
      id: message.id,
      kind,
      pixels: message.w * message.h,
      bytes: message.payloadBytes ?? message.buf?.byteLength ?? message.w * message.h * 4,
      width: message.w,
      height: message.h,
      x: Number(message.ox) || 0,
      y: Number(message.oy) || 0,
      tracks: trackedRegions.map((region) => {
        var _a;
        return (_a = region.gridSlot) != null ? _a : region.id;
      }),
      full: Boolean(message.full),
      submittedAt: receiverNow()
    };
    trace.jobs.push(job);
    if (accepted) {
      benchmarkJobFrames.set(message.id, trace);
      for (const predicted of trace.predicted) if (job.tracks.includes(predicted.slot)) predicted.submitted = true;
    }
  }
  return accepted;
}
const opticalTargets = [];
let lastOpticalSampleAt = -Infinity;
let lastOpticalSourceSequence = -1;
let opticalAnalyzeCount = 0;
let opticalAnalyzeTotalMs = 0;
let opticalAnalyzeMaxMs = 0;
let opticalTimingStartedAt = performance.now();
function inspectStaticQrOptics(source, image, ox = 0, oy = 0) {
  if (replayRunning || source.sequence === lastOpticalSourceSequence) return;
  const now = receiverNow();
  const interval = focusController.opticalIntervalMs;
  if (!Number.isFinite(interval) || now - lastOpticalSampleAt < interval) return;
  opticalTargets.length = 0;
  let eligibleTargetExists = false;
  for (const region of regions) {
    if (!validQuadObject(region.quad) || !region.dim || region.visibleFraction < 0.85) continue;
    eligibleTargetExists = true;
    const q = region.quad;
    const inside = (point) => point.x >= ox + 2 && point.y >= oy + 2 && point.x < ox + image.width - 2 && point.y < oy + image.height - 2;
    if (inside(q.topLeft) && inside(q.topRight) && inside(q.bottomRight) && inside(q.bottomLeft)) {
      opticalTargets.push({ quad: q, modules: region.dim });
    }
  }
  if (!opticalTargets.length) {
    if (!eligibleTargetExists) focusController.noteTargetAbsent(now);
    return;
  }
  lastOpticalSourceSequence = source.sequence;
  lastOpticalSampleAt = now;
  const analyzeStarted = performance.now();
  const metrics = opticsAnalyzer.analyze(image, opticalTargets, ox, oy);
  const analyzeMs = performance.now() - analyzeStarted;
  opticalAnalyzeCount++;
  opticalAnalyzeTotalMs += analyzeMs;
  opticalAnalyzeMaxMs = Math.max(opticalAnalyzeMaxMs, analyzeMs);
  if (!metrics || metrics.confidence < 0.55 && !focusController.expectsProbeFrame) {
    focusController.noteTargetAbsent(now);
    return;
  }
  const geometry = focusGeometry();
  if (!geometry) return;
  const captureFps = captureTimes.reduce((count, at) => count + Number(at > now - STATS_WINDOW_MS), 0);
  focusController.observe(source.sequence, geometry, metrics, Math.max(1, expectedRegions), now, captureFps);
}

const DIRECT_LUMA_FORMATS = new Set(["I420", "I420A", "I422", "I422A", "I444", "I444A", "NV12"]);
function opticalSampleDue(source) {
  if (replayRunning || source.sequence === lastOpticalSourceSequence) return false;
  const interval = focusController.opticalIntervalMs;
  return Number.isFinite(interval) && receiverNow() - lastOpticalSampleAt >= interval;
}
function cloneVideoFrame(source, forceRgba = false) {
  const frame = source.videoFrame;
  // Never construct a VideoFrame from the live <video>. This exact operation
  // was previously observed to wedge the Android Chrome/PWA camera compositor.
  // MediaStreamTrackProcessor frames remain the fast I420/Y8 path; if a source
  // frame is unavailable, decline direct capture and let the existing bounded
  // readback path handle that frame instead of touching the live compositor.
  if (!frame) return null;
  const visible = frame.visibleRect;
  const rotation = Number(frame.rotation ?? 0) % 360;
  const scaleX = visible && source.width ? visible.width / source.width : 0;
  const scaleY = visible && source.height ? visible.height / source.height : 0;
  const coordinateMapSafe = Boolean(
    visible && source.width > 0 && source.height > 0 &&
    frame.displayWidth === source.width && frame.displayHeight === source.height &&
    Number.isFinite(scaleX) && scaleX > 0 && Number.isFinite(scaleY) && scaleY > 0 &&
    rotation === 0 && !frame.flip
  );
  const sameGrid = coordinateMapSafe && visible.x === 0 && visible.y === 0 && scaleX === 1 && scaleY === 1;
  const mapLabel = !coordinateMapSafe ? "canvas fallback" : sameGrid ? "direct" : `direct map ${scaleX.toFixed(2)}×${scaleY.toFixed(2)}`;
  lastVideoFrameInfo = `${frame.codedWidth || "—"}×${frame.codedHeight || "—"} coded · ${visible ? `${visible.x},${visible.y} ${visible.width}×${visible.height}` : "—"} visible · ${frame.displayWidth || "—"}×${frame.displayHeight || "—"} display · ${frame.format || "—"} · ${mapLabel}`;
  if (!coordinateMapSafe) return null;
  try {
    return {
      frame: frame.clone(),
      pixelFormat: forceRgba ? "video-rgba" : DIRECT_LUMA_FORMATS.has(frame.format) ? "y8" : "video-rgba",
      visibleX: visible.x,
      visibleY: visible.y,
      scaleX,
      scaleY,
      sameGrid
    };
  } catch {
    return null;
  }
}
function mappedDirectTrackedFrame(source, x, y, w, h, tracks) {
  // A lattice slot may lose its quad before the surrounding scheduler has
  // finished retiring that slot. Missing geometry is a normal erasure during
  // target loss, never a reason to throw from the camera loop.
  if (tracks.some((track) => !track || !validQuadObject(track.quad) || !track.dim)) return null;
  // Once the source is a TrackProcessor VideoFrame, stay on that camera memory
  // path for every receiver state. Never decline direct Y8 because an optics
  // sample is due; doing so used to fall through to live <video> canvas readback.
  if (optimizerPipelineActive || source.image || !source.videoFrame || typeof VideoFrame !== "function") return null;
  const direct = cloneVideoFrame(source, false);
  if (!direct || direct.pixelFormat !== "y8") {
    direct?.frame.close();
    return null;
  }
  // Padded tracked crops are allowed to extend beyond the display frame. Canvas
  // readback naturally clips those requests, but VideoFrame copyTo/visibleRect
  // does not accept a negative/out-of-range crop. Clamp in display coordinates
  // before mapping into the coded frame; track quads stay in global coordinates
  // and are localized by ox/oy in the worker as before.
  const cropX = Math.max(0, Math.min(source.width, x));
  const cropY = Math.max(0, Math.min(source.height, y));
  const cropRight = Math.max(cropX, Math.min(source.width, x + w));
  const cropBottom = Math.max(cropY, Math.min(source.height, y + h));
  if (cropRight - cropX < 2 || cropBottom - cropY < 2) {
    direct.frame.close();
    return null;
  }
  const pixelXf = direct.visibleX + cropX * direct.scaleX;
  const pixelYf = direct.visibleY + cropY * direct.scaleY;
  const pixelRf = direct.visibleX + cropRight * direct.scaleX;
  const pixelBf = direct.visibleY + cropBottom * direct.scaleY;
  const pixelX = Math.round(pixelXf), pixelY = Math.round(pixelYf);
  const pixelRight = Math.round(pixelRf), pixelBottom = Math.round(pixelBf);
  if ([pixelXf - pixelX, pixelYf - pixelY, pixelRf - pixelRight, pixelBf - pixelBottom].some((delta) => Math.abs(delta) > 1e-4)) {
    direct.frame.close();
    return null;
  }
  const mapPoint = (point) => ({
    x: direct.visibleX + point.x * direct.scaleX,
    y: direct.visibleY + point.y * direct.scaleY
  });
  const mappedTracks = tracks.map((track) => ({
    ...track,
    quad: {
      topLeft: mapPoint(track.quad.topLeft),
      topRight: mapPoint(track.quad.topRight),
      bottomRight: mapPoint(track.quad.bottomRight),
      bottomLeft: mapPoint(track.quad.bottomLeft)
    }
  }));
  return {
    ...direct,
    cropX: pixelX,
    cropY: pixelY,
    w: pixelRight - pixelX,
    h: pixelBottom - pixelY,
    ox: pixelX,
    oy: pixelY,
    tracks: mappedTracks,
    outputMap: {
      offsetX: direct.visibleX,
      offsetY: direct.visibleY,
      scaleX: direct.scaleX,
      scaleY: direct.scaleY
    }
  };
}
function cloneDirectDecodeFrame(source) {
  if (optimizerPipelineActive || source.image || captureNextScan || opticalSampleDue(source) || typeof VideoFrame !== "function") return null;
  return cloneVideoFrame(source, false);
}
function acquisitionSeedWindow(index, width, height) {
  // 3x3 overlapping windows work for both portrait 3xN and landscape Nx3 QR
  // walls. A window is deliberately larger than one cell so a QR that lands on
  // a tile boundary is still whole in a neighboring attempt.
  const cols = 3, rows = 3;
  const col = index % cols;
  const row = Math.floor(index / cols) % rows;
  const cellW = width / cols;
  const cellH = height / rows;
  const padX = cellW * 0.28;
  const padY = cellH * 0.28;
  const quantum = 16;
  const x = Math.max(0, Math.floor((col * cellW - padX) / quantum) * quantum);
  const y = Math.max(0, Math.floor((row * cellH - padY) / quantum) * quantum);
  const right = Math.min(width, Math.ceil(((col + 1) * cellW + padX) / quantum) * quantum);
  const bottom = Math.min(height, Math.ceil(((row + 1) * cellH + padY) / quantum) * quantum);
  return { x, y, w: Math.max(32, right - x), h: Math.max(32, bottom - y) };
}
function cloneDirectFullScanFrame(source) {
  if (optimizerPipelineActive || source.image || captureNextScan || typeof VideoFrame !== "function") return null;
  // Full acquisition/reacquisition must stay on the same TrackProcessor Y plane
  // as locked decoding. A coded frame may have a non-zero visibleRect origin
  // (e.g. 1920x2560 I420 with a 240px left crop for a 1440x2560 display), so
  // map the display frame into coded coordinates instead of requiring sameGrid.
  const direct = cloneVideoFrame(source, false);
  if (!direct || direct.pixelFormat !== "y8") {
    direct?.frame.close();
    return null;
  }
  const pixelXf = direct.visibleX;
  const pixelYf = direct.visibleY;
  const pixelRf = direct.visibleX + source.width * direct.scaleX;
  const pixelBf = direct.visibleY + source.height * direct.scaleY;
  const pixelX = Math.round(pixelXf), pixelY = Math.round(pixelYf);
  const pixelRight = Math.round(pixelRf), pixelBottom = Math.round(pixelBf);
  if ([pixelXf - pixelX, pixelYf - pixelY, pixelRf - pixelRight, pixelBf - pixelBottom].some((delta) => Math.abs(delta) > 1e-4)) {
    direct.frame.close();
    return null;
  }
  return {
    ...direct,
    cropX: pixelX,
    cropY: pixelY,
    w: pixelRight - pixelX,
    h: pixelBottom - pixelY,
    ox: pixelX,
    oy: pixelY,
    outputMap: {
      offsetX: direct.visibleX,
      offsetY: direct.visibleY,
      scaleX: direct.scaleX,
      scaleY: direct.scaleY
    }
  };
}

function captureOptimizerOpticalSample(source) {
  const epoch = activeOptimizerEpoch;
  if (!(epoch == null ? void 0 : epoch.collecting) || source.opticsEpoch !== epoch.id || source.sequence < epoch.firstValidSourceSequence) return;
  const evidence = candidateEvidenceWindows.get(epoch.id);
  if (!evidence || evidence.opticalSourceFrames.has(source.sequence)) return;
  const image = readBoundedVideoCrop(source, 0, 0, source.width, source.height);
  const analyzeStarted = performance.now();
  let metrics;
  let targeted = false;
  if (optimizerFixedTargets.length) {
    const targets = optimizerFixedTargets.filter((target) => target.dim >= 21 && target.dim <= 177).map((target) => ({ quad: target.quad, modules: target.dim }));
    metrics = targets.length ? opticsAnalyzer.analyze(image, targets) : void 0;
    targeted = Boolean(metrics);
    if (!metrics) return;
    if (evidence.opticalTargetedSamples === 0 && evidence.opticalSamples.length) {
      evidence.opticalSamples.length = 0;
      evidence.opticalSourceFrames.clear();
    }
  } else {
    metrics = opticsAnalyzer.analyzeGlobal(image);
    targeted = false;
  }
  const analyzeMs = performance.now() - analyzeStarted;
  opticalAnalyzeCount++;
  opticalAnalyzeTotalMs += analyzeMs;
  opticalAnalyzeMaxMs = Math.max(opticalAnalyzeMaxMs, analyzeMs);
  if (!metrics) return;
  evidence.opticalSourceFrames.add(source.sequence);
  evidence.opticalSamples.push(metrics);
  if (targeted) evidence.opticalTargetedSamples++;
  evidence.temporalSamples.push(metrics.temporalContamination);
  traceOptimizer({
    time: receiverNow(),
    event: targeted ? "OPTICS_QR" : "OPTICS_GLOBAL",
    candidateId: epoch.candidateId,
    candidateEpoch: epoch.id,
    sourceSequence: source.sequence,
    requestedExposure: epoch.requestedExposure,
    requestedIso: epoch.requestedIso,
    actualExposure: epoch.actualExposure,
    actualIso: epoch.actualIso
  });
}
function captureOptimizerProbe(source, trace) {
  const epoch = activeOptimizerEpoch;
  if (!(epoch == null ? void 0 : epoch.collecting) || source.opticsEpoch !== epoch.id || source.sequence < epoch.firstValidSourceSequence) return;
  const evidence = candidateEvidenceWindows.get(epoch.id);
  if (!evidence) return;
  if (optimizerDiscoveryMode || !optimizerFixedTargets.length) {
    const image2 = readBoundedVideoCrop(source, 0, 0, source.width, source.height);
    const id2 = frameId++;
    traceOptimizer({
      time: receiverNow(),
      event: "CAPTURE",
      candidateId: epoch.candidateId,
      candidateEpoch: epoch.id,
      sourceSequence: source.sequence,
      requestedExposure: epoch.requestedExposure,
      requestedIso: epoch.requestedIso,
      actualExposure: epoch.actualExposure,
      actualIso: epoch.actualIso
    });
    submitReceiverJob(
      {
        id: id2,
        buf: image2.data.buffer,
        w: source.width,
        h: source.height,
        ox: 0,
        oy: 0,
        full: true,
        thorough: true,
        optimizerProbe: true,
        sourceSequence: source.sequence,
        opticsEpoch: source.opticsEpoch
      },
      [image2.data.buffer],
      "FULL FRAME",
      trace,
      source.sequence,
      [],
      1,
      source.opticsEpoch
    );
    return;
  }
  const targets = optimizerFixedTargets.filter((target) => validQuadObject(target.quad) && target.dim);
  if (!targets.length) return;
  const points = targets.flatMap((target) => [
    target.quad.topLeft,
    target.quad.topRight,
    target.quad.bottomRight,
    target.quad.bottomLeft
  ]);
  const targetEdge = Math.max(...targets.map((target) => {
    const bounds = trackedQuadBounds(target.quad);
    return bounds ? Math.max(bounds.right - bounds.left, bounds.bottom - bounds.top) : 60;
  }));
  const moduleSize = targetEdge / Math.max(21, targets[0].dim);
  const pad = Math.max(12, Math.round(targetEdge * 0.2));
  let x = Math.max(0, Math.floor(Math.min(...points.map((point) => point.x)) - pad));
  let y = Math.max(0, Math.floor(Math.min(...points.map((point) => point.y)) - pad));
  const right = Math.min(source.width, Math.ceil(Math.max(...points.map((point) => point.x)) + pad));
  const bottom = Math.min(source.height, Math.ceil(Math.max(...points.map((point) => point.y)) + pad));
  let w = right - x;
  let h = bottom - y;
  if (w < 32 || h < 32) return;
  let image = readBoundedVideoCrop(source, x, y, w, h);
  const id = frameId++;
  traceOptimizer({
    time: receiverNow(),
    event: "CAPTURE",
    candidateId: epoch.candidateId,
    candidateEpoch: epoch.id,
    sourceSequence: source.sequence,
    requestedExposure: epoch.requestedExposure,
    requestedIso: epoch.requestedIso,
    actualExposure: epoch.actualExposure,
    actualIso: epoch.actualIso
  });
  submitReceiverJob(
    {
      id,
      buf: image.data.buffer,
      w,
      h,
      ox: x,
      oy: y,
      full: false,
      tracks: targets,
      // Keep the frozen geometry for apples-to-apples comparison, but use the
      // SAME fallback budget as production. The previous optimizerProbe=true
      // path retried every missing QR and could make very dark settings look
      // artificially good even though normal receiving could not sustain them.
      optimizerProbe: false,
      sourceSequence: source.sequence,
      opticsEpoch: source.opticsEpoch
    },
    [image.data.buffer],
    "SHARED TRACKED BATCH CROP",
    trace,
    source.sequence,
    [],
    targets.length,
    source.opticsEpoch
  );
}
async function captureFrame(source) {
  var _a, _b, _c, _d, _e;
  const vw = source.width;
  const vh = source.height;
  if (!vw || !vh) return;
  receiverFrameWidth = vw;
  receiverFrameHeight = vh;
  const now = receiverNow();
  void maintainManualOptics(now);
  maintainAcquisitionAutofocus(now);
  maintainAutomaticQrOptics(now);
  const trace = replayRunning ? {
    sequence: source.sequence,
    timestampMs: now,
    stateBefore: gridLattice.state,
    stateAfter: gridLattice.state,
    decision: "not scheduled",
    workerBusyFraction: pool.size ? pool.busyCount / pool.size : 0,
    jobs: [],
    decoded: [],
    sightings: [],
    reference: [],
    predicted: [],
    transitions: []
  } : void 0;
  if (trace) {
    benchmarkTraces.push(trace);
    activeBenchmarkFrame = trace;
  }
  if (!replayRunning && decoderFreshnessHoldActive) {
    if (now < decoderFreshnessHoldUntil) {
      activeBenchmarkFrame = void 0;
      return;
    }
    decoderFreshnessHoldActive = false;
    decoderFreshnessHoldUntil = 0;
    lastFullScan = 0;
    notePipelineEvent("camera-mutation-settled");
  }
  if (!replayRunning && livePipeline.startedAt) livePipeline.captures++;
  captureTimes.push(now);
  workerLoadSamples.push({ at: now, busy: pool.busyCount, size: pool.size });
  totalCaptures++;
  if (optimizerPipelineActive) {
    captureOptimizerOpticalSample(source);
    if (pool.busyCount === pool.size) {
      capturesDropped++;
      poolBusyTimes.push(now);
      if (trace) {
        trace.decision = "optimizer optics only · worker busy";
        trace.stateAfter = gridLattice.state;
      }
      activeBenchmarkFrame = void 0;
      return;
    }
    captureOptimizerProbe(source, trace);
    activeBenchmarkFrame = void 0;
    return;
  }
  if (pool.busyCount === pool.size && !gridLattice.active) {
    capturesDropped++;
    poolBusyTimes.push(now);
    if (trace) {
      trace.decision = "worker busy";
      trace.stateAfter = gridLattice.state;
    }
    activeBenchmarkFrame = void 0;
    return;
  }
  for (let i = regions.length - 1; i >= 0; i--) {
    const region = regions[i];
    const ttl = region.decoded ? REGION_TTL_MS : SIGHTING_REGION_TTL_MS;
    if (region.gridSlot === void 0 && now - region.seen > ttl) {
      regions.splice(i, 1);
      notePipelineEvent(region.decoded ? "region-decoded-expired" : "region-sighting-expired", regions.length);
    }
  }
  const wasLockedBeforeTick = gridLattice.locked;
  const latticeSnapshot = gridLattice.tick(now);
  if (latticeSnapshot) syncGrid(latticeSnapshot, now);
  else if (gridLattice.state === "REACQUIRE") {
    if (wasLockedBeforeTick) {
      enterGeometryRecovery("whole lattice timed out; fresh acquisition", now, true);
      if (trace) trace.stateAfter = gridLattice.state;
      activeBenchmarkFrame = void 0;
      return;
    }
    for (let i = regions.length - 1; i >= 0; i--) if (regions[i].gridSlot !== void 0) regions.splice(i, 1);
    gridShape = "";
    lastGridSnapshot = void 0;
  }
  const live = decodedCount();
  peakRegions = Math.max(peakRegions, live);
  if (live >= expectedRegions || now - expectedRegionsAt > EXPECTED_REGIONS_DECAY_MS) {
    expectedRegions = live;
    expectedRegionsAt = now;
  }
  const visibleGridSlots = classifyGridSlots(vw, vh);
  if (trace) trace.predicted = visibleGridSlots.map((region) => ({
    slot: region.gridSlot,
    state: region.slotState,
    quad: region.quad,
    submitted: false
  }));
  // Once a framed packet declares the layout, the lattice is authoritative.
  // A single QR miss is a local decode problem, not a reason to wake the
  // expensive generic finder. Only abandon the hot tracked path when every
  // geometrically possible cell has gone cold together.
  const lockedGeometryCandidates = gridLattice.locked && lastGridSnapshot ? visibleGridSlots.filter((region) =>
    region.quad && region.dim && isGridDecodeCandidate(region) && validTrackedQuad(region, vw, vh)
  ) : [];
  const lockedGeometryTrusted = lockedGeometryCandidates.length > 0;
  const recentLockedHits = lockedGeometryCandidates.reduce((count, region) =>
    count + Number(now - (region.decodedSeen ?? -Infinity) < 900), 0
  );
  const lockedDecodeSilenceMs = gridLattice.locked && lastStreamDecodeAt ? now - lastStreamDecodeAt : 0;
  const geometryProbeDue = lockedGeometryTrusted && recentLockedHits === 0 &&
    lockedDecodeSilenceMs >= GEOMETRY_PROBE_SILENCE_MS;
  const allLockedCandidatesCold = lockedGeometryTrusted && recentLockedHits === 0 &&
    lockedGeometryCandidates.every((region) => region.consecutiveMisses >= GEOMETRY_COLD_MISSES);
  // Three tracked misses are evidence for a rescue probe, not evidence that the
  // wall geometry vanished. Previously this destroyed a good lattice after
  // roughly 0.9 s of optical misses and forced dense generic reacquisition.
  // Preserve the hot geometry while rescue scans run in parallel; only abandon
  // it after sustained decoder silence.
  const hardGeometryResetDue = allLockedCandidatesCold &&
    lockedDecodeSilenceMs >= GEOMETRY_HARD_RESET_MS;
  if (hardGeometryResetDue) {
    enterGeometryRecovery("tracked lattice silent too long; fresh acquisition", now, true);
    if (trace) trace.stateAfter = gridLattice.state;
    activeBenchmarkFrame = void 0;
    return;
  }
  // A decoded QR is not the same thing as acquired grid geometry. In SEARCH
  // or REACQUIRE, one valid seed can set expectedRegions/live to 1 before the
  // lattice accepts its geometry. Never let that lone region suppress the
  // full-frame acquisition loop; only an active lattice may hand scheduling
  // over to tracked QR work.
  const preLatticeDiscovery = !gridLattice.active;
  const gridNeedsDiscovery = preLatticeDiscovery || (lockedGeometryTrusted
    ? allLockedCandidatesCold
    : visibleGridSlots.some((region) => !region.decoded || region.slotState === "LOST"));
  const trackingUnhealthy = regions.some((region) => region.gridSlot === void 0 && region.decoded && region.consecutiveMisses >= 4);
  if (gridLattice.locked) strictHotPathLockSeen = true;
  const strictLockedAudit = strictHotPathActive() && strictHotPathLockSeen && gridLattice.locked;
  // Correctness/strict mode is allowed to use the generic detector to acquire
  // the grid once. After lock, it may not hide tracked failures by falling
  // back to local robust decode or by abandoning the grid and reacquiring it.
  gridLattice.noteMissing(strictLockedAudit ? false : gridNeedsDiscovery, now);
  const needsRecoveryScan = strictLockedAudit ? false : preLatticeDiscovery ? true : lockedGeometryTrusted
    ? geometryProbeDue || allLockedCandidatesCold || trackingUnhealthy
    : live === 0 || live < expectedRegions || trackingUnhealthy || gridNeedsDiscovery;
  const captureHasTrackedWork = gridLattice.active ? lockedGeometryCandidates.length > 0 : regions.some((region) => region.decoded && region.quad && region.dim && validTrackedQuad(region, vw, vh));
  const provisionalUnknownVisible = preLatticeDiscovery && lastGridSnapshot ? visibleGridSlots.filter((region) =>
    !region.decoded && region.quad && region.dim && isGridDecodeCandidate(region) && validTrackedQuad(region, vw, vh)
  ) : [];
  const acquisitionInFlight = pool.activeJobs.reduce((count, job) => count + Number(job.full), 0);
  const acquisitionLimit = captureHasTrackedWork ? 1 : 2;
  // SEARCH/REACQUIRE has a hard liveness invariant: if the camera is producing
  // frames and an acquisition worker is free, stale scheduler bookkeeping may
  // never stop discovery. With useful provisional geometry, keep one discovery
  // worker on visible unknown neighbors; if every unknown is offscreen, probe
  // globally only occasionally while tracked subsection throughput continues.
  const provisionalNeedsDiscovery = preLatticeDiscovery && (
    !lastGridSnapshot || !captureHasTrackedWork || provisionalUnknownVisible.length > 0 ||
    now - lastFullScan > GEOMETRY_PROBE_SILENCE_MS
  );
  // Once geometry has been proven, never let a transient zero-output window
  // turn recovery into a 22 Hz stream of expensive full-frame finder scans.
  // Keep most camera frames available to the tracked decoder and inject only
  // a few generic rescue probes per second.
  const scanInterval = gridLattice.locked
    ? LOCKED_RECOVERY_SCAN_MS
    : live === 0 ? ACQUISITION_SCAN_MS : FULL_SCAN_DEGRADED_MS;
  const strictAcquiring = strictHotPathActive() && !gridLattice.locked;
  const fullScanDue = strictAcquiring
    ? Boolean(captureNextScan) || now - lastFullScan > ACQUISITION_SCAN_MS
    : captureNextScan ? !captureHasTrackedWork
      : preLatticeDiscovery
        ? provisionalNeedsDiscovery && acquisitionInFlight < acquisitionLimit
        : needsRecoveryScan && now - lastFullScan > scanInterval;
  if (!fullScanDue && (strictAcquiring || regions.length === 0)) {
    if (trace) {
      trace.decision = "full scan throttled";
      trace.stateAfter = gridLattice.state;
    }
    activeBenchmarkFrame = void 0;
    return;
  }
  if (grab.width !== vw || grab.height !== vh) {
    grab.width = vw;
    grab.height = vh;
  }
  const ctx = grab.getContext("2d", { willReadFrequently: true });
  // Before lock, six simultaneous 3.7 MP finder scans only contend for CPU
  // and memory bandwidth. Two fresh-frame seed searches are enough to keep
  // acquisition parallel without burying slower phones under duplicate work.
  const acquisitionSeedScan = fullScanDue && !captureNextScan && !gridLattice.active;
  const globalRecoverySeedScan = fullScanDue && !captureNextScan && gridLattice.locked && geometryProbeDue;
  if (globalRecoverySeedScan) {
    const recoveryInflight = pool.activeJobs.reduce((count, job) => count + Number(job.full), 0);
    if (recoveryInflight >= 1) {
      if (trace) {
        trace.decision = "global recovery seed already in flight";
        trace.stateAfter = gridLattice.state;
      }
      activeBenchmarkFrame = void 0;
      return;
    }
  }
  if (acquisitionSeedScan) {
    const acquisitionInflight = pool.activeJobs.reduce((count, job) => count + Number(job.full), 0);
    const acquisitionInflightLimit = Math.min(acquisitionLimit, pool.size);
    if (acquisitionInflight >= acquisitionInflightLimit) {
      capturesDropped++;
      poolBusyTimes.push(now);
      notePipelineEvent("acquisition-inflight-cap", acquisitionInflight);
      if (trace) {
        trace.decision = `acquisition capped at ${acquisitionInflightLimit} in-flight seed scans`;
        trace.stateAfter = gridLattice.state;
      }
      activeBenchmarkFrame = void 0;
      return;
    }
  }
  if (fullScanDue && pool.busyCount === pool.size) {
    capturesDropped++;
    poolBusyTimes.push(now);
    activeBenchmarkFrame = void 0;
    return;
  }
  if (fullScanDue) {
    lastFullScan = now;
    fullScans++;
    if (globalRecoverySeedScan) {
      geometryRecoveryProbes++;
      notePipelineEvent("global-recovery-probe", geometryRecoveryProbes);
    }
    // A dense wall can present dozens of finder patterns to the generic
    // detector. That is a bad acquisition problem even when every QR is sharp.
    // Keep the first and every fourth attempt full-frame (important for 1-QR
    // senders), but rotate the intervening attempts through overlapping 3x3
    // seed windows. Any verified packet declares layout + slot and immediately
    // gives the lattice useful provisional geometry.
    const fullFrameSeed = captureNextScan || (fullScans - 1) % ACQUISITION_FULL_EVERY === 0;
    let acquisitionMode = captureNextScan ? "thorough" : fullFrameSeed
      ? fullScans % ACQUISITION_DEEP_EVERY === 0 ? "deep" : "fast"
      : "seed";
    let scanX = 0, scanY = 0, scanW = vw, scanH = vh;
    if (!captureNextScan && preLatticeDiscovery && !lastGridSnapshot && !fullFrameSeed) {
      const seed = acquisitionSeedWindow(acquisitionTileCursor++, vw, vh);
      scanX = seed.x;
      scanY = seed.y;
      scanW = seed.w;
      scanH = seed.h;
    }
    // A provisional seed already tells us where the declared neighbors
    // should roughly be. Search visible unknown slots there while continuing
    // to track exact observed slots; do not spend a full-frame finder pass on
    // camera pixels that cannot contain the declared wall.
    const provisionalCrop = preLatticeDiscovery && provisionalUnknownVisible.length > 0;
    // A generic decoder over the bounding box of *all* provisional unknowns is
    // almost a full-wall scan again. Dense walls then rediscover the same first
    // physical row on every pass (the decoder has a bounded result count), so
    // the lattice may never collect cross-axis geometry and never lock. Probe one
    // predicted unknown slot at a time instead. Rotating these tiny crops both
    // cuts acquisition pixels and guarantees discovery pressure moves around the
    // declared wall instead of repeatedly rewarding the easiest row.
    let boundedScanCandidates = lockedGeometryCandidates;
    if (provisionalCrop) {
      const target = provisionalUnknownVisible[acquisitionTileCursor++ % provisionalUnknownVisible.length];
      boundedScanCandidates = target ? [target] : [];
    }
    if (!captureNextScan && boundedScanCandidates.length && (provisionalCrop || lockedGeometryTrusted && gridLattice.locked && !geometryProbeDue && !allLockedCandidatesCold)) {
      const points = boundedScanCandidates.flatMap((region) => [
        region.quad.topLeft,
        region.quad.topRight,
        region.quad.bottomRight,
        region.quad.bottomLeft
      ]);
      const typicalEdge = Math.max(...boundedScanCandidates.map((region) => Math.max(region.w, region.h)));
      const pad = Math.max(24, Math.round(typicalEdge * (provisionalCrop ? 0.9 : 0.7)));
      const quantum = 16;
      scanX = Math.max(0, Math.floor((Math.min(...points.map((point) => point.x)) - pad) / quantum) * quantum);
      scanY = Math.max(0, Math.floor((Math.min(...points.map((point) => point.y)) - pad) / quantum) * quantum);
      const scanRight = Math.min(vw, Math.ceil((Math.max(...points.map((point) => point.x)) + pad) / quantum) * quantum);
      const scanBottom = Math.min(vh, Math.ceil((Math.max(...points.map((point) => point.y)) + pad) / quantum) * quantum);
      scanW = Math.max(32, scanRight - scanX);
      scanH = Math.max(32, scanBottom - scanY);
    }
    const directFull = source.videoFrame && !source.image && !captureNextScan
      ? mappedDirectTrackedFrame(source, scanX, scanY, scanW, scanH, [])
      : null;
    if (directFull) {
      const id = frameId++;
      if (!submitReceiverJob(
        {
          id,
          videoFrame: directFull.frame,
          cropX: directFull.cropX,
          cropY: directFull.cropY,
          w: directFull.w,
          h: directFull.h,
          ox: directFull.ox,
          oy: directFull.oy,
          full: true,
          pixelFormat: "y8",
          outputMap: directFull.outputMap,
          acquisitionMode
        },
        [directFull.frame],
        "DIRECT RECOVERY Y8",
        trace,
        source.sequence
      )) directFull.frame.close();
      if (trace) trace.stateAfter = gridLattice.state;
      activeBenchmarkFrame = void 0;
      return;
    }
    // A TrackProcessor source is never allowed to switch to the live <video>
    // canvas path. Drop this recovery attempt and use the next camera frame.
    if (source.videoFrame && !source.image) {
      notePipelineEvent("direct-recovery-y8-unavailable");
      if (trace) {
        trace.decision = "direct recovery Y8 unavailable; frame dropped";
        trace.stateAfter = gridLattice.state;
      }
      activeBenchmarkFrame = void 0;
      return;
    }
    const img = scanX || scanY || scanW !== vw || scanH !== vh
      ? readBoundedVideoCrop(source, scanX, scanY, scanW, scanH)
      : source.image
        ? new ImageData(new Uint8ClampedArray(source.image.data), vw, vh)
        : (ctx.drawImage(video, 0, 0), ctx.getImageData(0, 0, vw, vh));
    inspectStaticQrOptics(source, img, scanX, scanY);
    captureSubmittedScan(img, scanX, scanY, true);
    const id = frameId++;
    if (submitReceiverJob(
      { id, buf: img.data.buffer, w: scanW, h: scanH, ox: scanX, oy: scanY, full: true, acquisitionMode },
      [img.data.buffer],
      "FULL FRAME",
      trace,
      source.sequence
    )) {
      if (pendingScanCapture && pendingScanCapture.id === void 0) pendingScanCapture.id = id;
    } else if ((pendingScanCapture == null ? void 0 : pendingScanCapture.id) === void 0) {
      cancelScanCapture();
    }
    if (trace) trace.stateAfter = gridLattice.state;
    activeBenchmarkFrame = void 0;
    return;
  }
  for (const region of regions) {
    if (region.gridSlot === void 0 && region.decoded && region.quad && !validTrackedQuad(region, vw, vh)) invalidateTrackedQuad(region);
  }
  const batchCandidates = (gridLattice.active ? visibleGridSlots.filter(isGridDecodeCandidate) : regions.filter((region) => region.observed && region.decoded)).filter((region) => region.quad && region.dim && validTrackedQuad(region, vw, vh)).slice(0, 32);
  const adaptiveWeakSlots = gridLattice.active && adaptiveWeakSlotScheduling(batchCandidates);
  const batchRegions = adaptiveWeakSlots
    ? batchCandidates.filter((region) => shouldScheduleAdaptiveSlot(region, source.sequence, true))
    : batchCandidates;
  const batchTracks = batchRegions.map((region) => ({
    id: region.id,
    slot: region.gridSlot,
    misses: region.consecutiveMisses,
    quad: region.quad,
    dim: region.dim,
    crc32: Boolean(region.crc32)
  }));
  const lockedLayout = lastGridSnapshot == null ? void 0 : lastGridSnapshot.layout;
// Production keeps one decode job per camera frame. The worker already sees a
// bounded crop around the visible QR wall, so splitting one physical frame into
// several jobs only duplicates frame mapping/binarization work. Spatial lanes
// remain a Strict-mode diagnostic; the normal hot path parallelizes across
// successive camera frames and lets each worker keep its own tracker warm.
const laneCount = strictHotPathActive() && lockedLayout
  ? Math.min(3, Math.min(lockedLayout.cols, lockedLayout.rows) === 1
    ? Math.max(lockedLayout.cols, lockedLayout.rows)
    : Math.min(lockedLayout.cols, lockedLayout.rows))
  : 0;
const healthyTrackedGrid = !captureNextScan && lockedGeometryTrusted && !allLockedCandidatesCold && !trackingUnhealthy;
if (healthyTrackedGrid && lockedLayout && laneCount >= 1 && batchTracks.length >= 1 && pool.size >= laneCount) {
  const groups = Array.from(
    { length: laneCount },
    () => ({ tracks: [], regions: [] })
  );
  const splitByColumns = lockedLayout.cols <= lockedLayout.rows;
  for (let index = 0; index < batchTracks.length; index++) {
    const track = batchTracks[index];
    const region = batchRegions[index];
    if (track.slot === void 0) continue;
    const groupIndex = lockedLayout.cols === 1 ? Math.floor(track.slot / lockedLayout.cols) % laneCount : lockedLayout.rows === 1 ? track.slot % laneCount : splitByColumns ? track.slot % lockedLayout.cols : Math.floor(track.slot / lockedLayout.cols);
    if (groupIndex < 0 || groupIndex >= groups.length) continue;
    groups[groupIndex].tracks.push(track);
    groups[groupIndex].regions.push(region);
  }
  const activeGroups = groups.map((group, groupIndex) => ({ group, groupIndex })).filter(({ group }) => group.tracks.length > 0);
  if (activeGroups.length) {
    const freeSlots = new Set(pool.freeSlots);
    let laneJobsSubmitted = 0;
    activeDecodeBudget = batchTracks.length;
    for (const { group, groupIndex } of activeGroups) {
      const workerSlot = [...freeSlots].find((slot) => slot % laneCount === groupIndex);
      const points = group.tracks.flatMap((track) => [
        track.quad.topLeft,
        track.quad.topRight,
        track.quad.bottomRight,
        track.quad.bottomLeft
      ]);
      const minX = Math.min(...points.map((point) => point.x));
      const minY = Math.min(...points.map((point) => point.y));
      const maxX = Math.max(...points.map((point) => point.x));
      const maxY = Math.max(...points.map((point) => point.y));
      const typicalEdge = Math.max(...group.regions.map((region) => Math.max(region.w, region.h)));
      const cropKey = `${lockedLayout.id}:${group.tracks.map((track) => track.slot).join(",")}`;
      const stableCrop = stableLockedLaneCrop(
        groupIndex, cropKey, laneCount, vw, vh, minX, minY, maxX, maxY, typicalEdge
      );
      const { x, y, w, h } = stableCrop;
      if (w < 32 || h < 32) continue;
      const geometry = { x, y, w, h, tracks: group.tracks, regions: group.regions, sourceSequence: source.sequence, laneCount, strictHotPath: strictHotPathActive() };
      if (workerSlot === void 0) {
        // A stale camera frame is less useful than the next camera frame.
        // RaptorQ is designed to absorb this erasure, so never retain a live
        // VideoFrame clone waiting for a worker and starve the camera pool.
        poolBusyTimes.push(now);
        continue;
      }
      discardPendingGridLane(groupIndex);
      let laneImage;
      const direct = mappedDirectTrackedFrame(source, x, y, w, h, group.tracks);
      if (!direct) {
        if (source.videoFrame && !source.image) {
          notePipelineEvent("direct-lane-y8-unavailable");
          continue;
        }
        laneImage = readBoundedVideoCrop(source, x, y, w, h);
        if (laneJobsSubmitted === 0) inspectStaticQrOptics(source, laneImage, x, y);
      }
      const id = frameId++;
      const laneMessage = direct
        ? { id, videoFrame: direct.frame, cropX: direct.cropX, cropY: direct.cropY, w: direct.w, h: direct.h, ox: direct.ox, oy: direct.oy, full: false, tracks: direct.tracks, pixelFormat: direct.pixelFormat, outputMap: direct.outputMap, strictHotPath: strictHotPathActive() }
        : { id, buf: laneImage.data.buffer, w, h, ox: x, oy: y, full: false, tracks: group.tracks, strictHotPath: strictHotPathActive() };
      const laneTransfer = direct ? [direct.frame] : [laneImage.data.buffer];
      const accepted = submitReceiverJob(
        laneMessage,
        laneTransfer,
        direct ? direct.pixelFormat === "y8" ? "Y8 TRACKED GRID" : "DIRECT TRACKED GRID" : "NATIVE TRACKED GRID",
        trace,
        source.sequence,
        group.regions,
        0,
        void 0,
        workerSlot
      );
      if (!accepted) {
        direct?.frame.close();
        continue;
      }
      cropAttempts.set(id, group.regions.map((region) => ({ region, quad: region.quad })));
      freeSlots.delete(workerSlot);
      laneJobsSubmitted++;
    }
    cropRotate++;
    if (laneJobsSubmitted === 0) poolBusyTimes.push(now);
    if (trace) trace.stateAfter = gridLattice.state;
    activeBenchmarkFrame = void 0;
    return;
  }
}
  // A single tracked grid slot must use the same bounded shared-crop hot
  // path as a multi-QR wall. The legacy per-region crop below is intentionally
  // only for non-grid/provisional regions: unlike this path it is not clamped
  // and quantized to the camera frame, which can mis-map a large 1-QR crop and
  // strand guided decoding while periodic full scans still succeed.
  if (batchTracks.length >= 1) {
    const points = batchTracks.flatMap((track) => [
      track.quad.topLeft,
      track.quad.topRight,
      track.quad.bottomRight,
      track.quad.bottomLeft
    ]);
    const minX = Math.min(...points.map((point) => point.x));
    const minY = Math.min(...points.map((point) => point.y));
    const maxX = Math.max(...points.map((point) => point.x));
    const maxY = Math.max(...points.map((point) => point.y));
    const typicalEdge = Math.max(...batchRegions.map((region) => Math.max(region.w, region.h)));
    const worstMisses = Math.max(...batchRegions.map((region) => region.consecutiveMisses));
    const pad = Math.max(10, Math.round(typicalEdge * (0.1 + Math.min(0.22, worstMisses * 0.04))));
    const cropQuantum = 16;
    const x = Math.max(0, Math.floor((minX - pad) / cropQuantum) * cropQuantum);
    const y = Math.max(0, Math.floor((minY - pad) / cropQuantum) * cropQuantum);
    const right = Math.min(vw, Math.ceil((maxX + pad) / cropQuantum) * cropQuantum);
    const bottom = Math.min(vh, Math.ceil((maxY + pad) / cropQuantum) * cropQuantum);
    const w = right - x;
    const h = bottom - y;
    if (w >= 32 && h >= 32) {
      const healthyGrid = !captureNextScan && lockedGeometryTrusted && !allLockedCandidatesCold && !trackingUnhealthy;
      const freeWorkers = Math.max(0, pool.size - pool.busyCount);
      if (healthyGrid && freeWorkers === 0) {
        const bufferedLatest = !strictHotPathActive() && queuePendingGridLane(0, source, {
          x, y, w, h,
          tracks: batchTracks,
          regions: batchRegions,
          sourceSequence: source.sequence,
          laneCount: 1,
          strictHotPath: false
        });
        poolBusyTimes.push(now);
        if (bufferedLatest) notePipelineEvent("latest-frame-buffered", source.sequence);
        if (trace) trace.decision = bufferedLatest ? "latest frame buffered: workers busy" : "not scheduled: workers busy";
        activeBenchmarkFrame = void 0;
        return;
      }
      let shared;
      const sharedDirect = mappedDirectTrackedFrame(source, x, y, w, h, batchTracks);
      if (!sharedDirect) {
        if (source.videoFrame && !source.image) {
          notePipelineEvent("direct-shared-y8-unavailable");
          activeBenchmarkFrame = void 0;
          return;
        }
        shared = readBoundedVideoCrop(source, x, y, w, h);
        inspectStaticQrOptics(source, shared, x, y);
        captureSubmittedScan(shared, x, y, false, batchTracks.map((track) => track.quad));
      }
      if (healthyGrid || sharedDirect) {
        activeDecodeBudget = batchTracks.length;
        const id2 = frameId++;
        const sharedMessage = sharedDirect
          ? { id: id2, videoFrame: sharedDirect.frame, cropX: sharedDirect.cropX, cropY: sharedDirect.cropY, w: sharedDirect.w, h: sharedDirect.h, ox: sharedDirect.ox, oy: sharedDirect.oy, full: false, tracks: sharedDirect.tracks, pixelFormat: sharedDirect.pixelFormat, outputMap: sharedDirect.outputMap, strictHotPath: strictHotPathActive() }
          : { id: id2, buf: shared.data.buffer, w, h, ox: x, oy: y, full: false, tracks: batchTracks, strictHotPath: strictHotPathActive() };
        const sharedTransfer = sharedDirect ? [sharedDirect.frame] : [shared.data.buffer];
        cropAttempts.set(id2, batchRegions.map((region) => ({ region, quad: region.quad })));
        if (!submitReceiverJob(
          sharedMessage,
          sharedTransfer,
          sharedDirect ? sharedDirect.pixelFormat === "y8" ? "Y8 TRACKED GRID" : "DIRECT TRACKED GRID" : "NATIVE TRACKED GRID",
          trace,
          source.sequence,
          batchRegions
        )) {
          sharedDirect?.frame.close();
          cropAttempts.delete(id2);
          poolBusyTimes.push(now);
          if ((pendingScanCapture == null ? void 0 : pendingScanCapture.id) === void 0) cancelScanCapture();
        } else {
          if (pendingScanCapture && pendingScanCapture.id === void 0) pendingScanCapture.id = id2;
        }
        cropRotate++;
        if (trace) trace.stateAfter = gridLattice.state;
        activeBenchmarkFrame = void 0;
        return;
      }
      const id = frameId++;
      if (submitReceiverJob(
        { id, buf: shared.data.buffer, w, h, ox: x, oy: y, full: false, tracks: batchTracks },
        [shared.data.buffer],
        "SHARED TRACKED BATCH CROP",
        trace,
        source.sequence,
        batchRegions
      )) {
        cropAttempts.set(id, batchRegions.map((region) => ({ region, quad: region.quad })));
        if (pendingScanCapture && pendingScanCapture.id === void 0) pendingScanCapture.id = id;
      } else {
        if ((pendingScanCapture == null ? void 0 : pendingScanCapture.id) === void 0) cancelScanCapture();
        poolBusyTimes.push(now);
      }
    }
    cropRotate++;
    if (trace) trace.stateAfter = gridLattice.state;
    activeBenchmarkFrame = void 0;
    return;
  }
  const eligible = gridLattice.active ? visibleGridSlots.filter(isGridDecodeCandidate).sort((a, b) => slotUsefulness(b) - slotUsefulness(a)) : regions.filter((region) => region.observed && region.decoded);
  activeDecodeBudget = gridLattice.active ? Math.min(8, Math.max(4, pool.size * 2), eligible.length) : eligible.length;
  const scheduledRegions = eligible.slice(0, activeDecodeBudget);
  const trackedCapacity = Math.max(1, pool.size);
  const perRegionCapacity = gridLattice.locked ? 1 : Math.max(1, Math.floor(trackedCapacity / Math.max(1, scheduledRegions.length)));
  let submitted = false;
  for (let i = 0; i < scheduledRegions.length; i++) {
    const r = scheduledRegions[(i + cropRotate) % scheduledRegions.length];
    if (regionInflightCount(r) >= perRegionCapacity) continue;
    // LOST lattice slots can remain in the scheduling set for a frame after
    // their geometry is cleared. Do not manufacture a tracked job from stale
    // region bounds; let the normal recovery/full-scan path reacquire it.
    if (!validQuadObject(r.quad) || !r.dim) {
      if (r.gridSlot !== void 0) r.decoded = false;
      continue;
    }
    const quadBounds = trackedQuadBounds(r.quad);
    const left = (_a = quadBounds == null ? void 0 : quadBounds.left) != null ? _a : r.x;
    const top = (_b = quadBounds == null ? void 0 : quadBounds.top) != null ? _b : r.y;
    const right = (_c = quadBounds == null ? void 0 : quadBounds.right) != null ? _c : r.x + r.w;
    const bottom = (_d = quadBounds == null ? void 0 : quadBounds.bottom) != null ? _d : r.y + r.h;
    const size = Math.max(right - left, bottom - top);
    const missPad = r.gridSlot === void 0 ? 0 : Math.min(0.9, r.consecutiveMisses * 0.08);
    const pad = Math.round(size * (REGION_PAD + missPad) + Math.min(size, 2 * ((_e = r.drift) != null ? _e : 0)));
    const x = Math.floor(left - pad);
    const y = Math.floor(top - pad);
    const w = Math.ceil(right + pad) - x;
    const h = Math.ceil(bottom + pad) - y;
    if (w < 32 || h < 32) continue;
    const individualTrack = {
      id: r.id,
      slot: r.gridSlot,
      misses: r.consecutiveMisses,
      quad: r.quad,
      dim: r.dim,
      crc32: Boolean(r.crc32)
    };
    const direct = mappedDirectTrackedFrame(source, x, y, w, h, [individualTrack]);
    let img;
    if (!direct) {
      if (source.videoFrame && !source.image) {
        notePipelineEvent("direct-individual-y8-unavailable");
        continue;
      }
      img = readBoundedVideoCrop(source, x, y, w, h);
      inspectStaticQrOptics(source, img, x, y);
      captureSubmittedScan(img, x, y, false, r.quad ? [r.quad] : []);
    }
    const id = frameId++;
    cropAttempts.set(id, [{ region: r, quad: r.quad }]);
    const message = direct
      ? { id, videoFrame: direct.frame, cropX: direct.cropX, cropY: direct.cropY, w: direct.w, h: direct.h, ox: direct.ox, oy: direct.oy, full: false, tracks: direct.tracks, pixelFormat: "y8", outputMap: direct.outputMap, strictHotPath: strictHotPathActive() }
      : { id, buf: img.data.buffer, w, h, ox: x, oy: y, full: false, tracks: [individualTrack], strictHotPath: strictHotPathActive() };
    const transfer = direct ? [direct.frame] : [img.data.buffer];
    if (!submitReceiverJob(
      message,
      transfer,
      direct ? "Y8 INDIVIDUAL TRACKED" : "INDIVIDUAL TRACKED CROP",
      trace,
      source.sequence,
      [r]
    )) {
      direct?.frame.close();
      cropAttempts.delete(id);
      if ((pendingScanCapture == null ? void 0 : pendingScanCapture.id) === void 0) cancelScanCapture();
      poolBusyTimes.push(receiverNow());
      break;
    }
    if (pendingScanCapture && pendingScanCapture.id === void 0) pendingScanCapture.id = id;
    submitted = true;
  }
  if (!submitted && scheduledRegions.length > 0) {
    poolBusyTimes.push(now);
    if (trace && !trace.jobs.length) trace.decision = "not scheduled: in-flight track limit";
  }
  cropRotate++;
  if (trace) trace.stateAfter = gridLattice.state;
  activeBenchmarkFrame = void 0;
}
function resetActiveTransfer() {
  releaseTransportDecoder();
  streamKey = "";
  startTs = 0;
  regions.length = 0;
  gridLattice.reset();
  gridShape = "";
  lastGridSnapshot = void 0;
  activeDecodeBudget = 0;
  expectedRegions = 0;
  expectedRegionsAt = 0;
  lastDecodedRegionSize = 0;
  cropAttempts.clear();
  fullScanJobs.clear();
  scanCapturedAt.clear();
  scanOutcomes.clear();
  lastFullScan = 0;
  minimumAcceptedScanId = frameId;
  qrReadTimes.length = 0;
  uniqueQrTimes.length = 0;
  duplicateQrTimes.length = 0;
  resetDuplicateAttribution();
  usefulFrameTimes.length = 0;
  hotJobSubmitSamples.length = 0;
  hotJobCompletionSamples.length = 0;
  workerLoadSamples.length = 0;
  pendingLaneReplaceTimes.length = 0;
  resetHotPathAudit();
  resetGuidedRollout();
  resetGuidedFallbackPolicy();
  strictHotPathLockSeen = false;
  lastDistinctArrivalAt = 0;
  transferFinalizing = false;
  completionDiagnosticsText = "";
  bar.style.width = "0";
  progressEl.setAttribute("aria-valuenow", "0");
  progressLabel.textContent = "0%";
  transferSizeLabel.textContent = "";
  etaLabel.textContent = "";
  metric("m-rate").textContent = "👀";
  speedFeedback.className = "speed-feedback";
  plainQrPolicy.reset();
}
function onDecoded(bytes, box, info) {
  var _a, _b, _c;
  const optimizerAttribution = (info == null ? void 0 : info.scanId) === void 0 ? void 0 : scanCandidateEpoch.get(info.scanId);
  if (optimizerAttribution && ((info == null ? void 0 : info.sourceSequence) !== optimizerAttribution.sourceFrameSequence || info.opticsEpoch !== optimizerAttribution.epoch.id)) {
    optimizerEpochMismatches++;
    console.error("OPTIMIZER ATTRIBUTION BUG", { info, optimizerAttribution });
    traceOptimizer({
      time: receiverNow(),
      event: "ATTRIBUTION_BUG",
      scanId: info == null ? void 0 : info.scanId,
      sourceSequence: info == null ? void 0 : info.sourceSequence,
      candidateEpoch: info == null ? void 0 : info.opticsEpoch
    });
    return;
  }
  if ((info == null ? void 0 : info.scanId) !== void 0 && info.scanId < minimumAcceptedScanId) {
    noteScanOutcome(info.scanId, "stale");
    return;
  }
  totalDecodes++;
  const decodedAt = receiverNow();
  if (done) return;
  qrReadTimes.push(decodedAt);
  const parsed = info?.verifiedPayload && info.header ? { header: info.header, block: bytes.subarray(frameHeaderLength(info.header.mode)) } : parseFrame(bytes);
  if (!parsed) {
    noteScanOutcome(info == null ? void 0 : info.scanId, "rejected");
    if (decoder) return;
    try {
      const text = plainQrDecoder.decode(bytes);
      const settled = plainQrPolicy.addPlain(text, (_a = info == null ? void 0 : info.scanId) != null ? _a : -1);
      if (settled) finishPlainQr(settled);
    } catch {
    }
    return;
  }
  const { header, block } = parsed;
  const optimizerValidKey = optimizerAttribution && (info == null ? void 0 : info.scanId) !== void 0 ? `${info.scanId}|${header.layoutId}|${header.slotIndex}|${header.seq}` : void 0;
  const duplicateOptimizerValid = Boolean(optimizerValidKey && optimizerValidEvents.has(optimizerValidKey));
  if (optimizerValidKey) optimizerValidEvents.add(optimizerValidKey);
  if (duplicateOptimizerValid) {
    optimizerDuplicateValidEvents++;
    totalDecodes--;
    qrReadTimes.pop();
    return;
  }
  focusController.noteValidDecode(info == null ? void 0 : info.scanId);
  if (optimizerAttribution && box) {
    optimizerOverlayHits.push({ box: { ...box }, at: decodedAt });
    if (optimizerOverlayHits.length > 80) optimizerOverlayHits.splice(0, optimizerOverlayHits.length - 80);
    if (optimizerDiscoveryMode) {
      optimizerBootstrapDecode = { box: { ...box }, info };
      if (validQuadObject(info == null ? void 0 : info.quad) && info.modules) {
        optimizerFixedTargets = [{
          id: -1,
          slot: header.slotIndex,
          misses: 0,
          quad: {
            topLeft: { ...info.quad.topLeft },
            topRight: { ...info.quad.topRight },
            bottomRight: { ...info.quad.bottomRight },
            bottomLeft: { ...info.quad.bottomLeft }
          },
          dim: info.modules,
          crc32: true
        }];
        optimizerDiscoveryMode = false;
      }
    }
  }
  if (optimizerAttribution) {
    const epoch = optimizerAttribution.epoch;
    const complete = (info == null ? void 0 : info.scanId) !== void 0 && optimizerAttribution.sourceFrameSequence >= epoch.firstValidSourceSequence && Number.isFinite(epoch.actualExposure) && Number.isFinite(epoch.actualIso);
    if (complete) {
      optimizerAttribution.evidence.validDecodes++;
      optimizerAttribution.evidence.successfulSourceFrames.add(optimizerAttribution.sourceFrameSequence);
      optimizerAttribution.validDecodes++;
      refreshCandidateEvidence(optimizerAttribution.evidence);
      traceOptimizer({
        time: receiverNow(),
        event: "VALID_DECODE",
        candidateId: epoch.candidateId,
        candidateEpoch: epoch.id,
        sourceSequence: optimizerAttribution.sourceFrameSequence,
        scanId: info.scanId,
        requestedExposure: epoch.requestedExposure,
        requestedIso: epoch.requestedIso,
        actualExposure: epoch.actualExposure,
        actualIso: epoch.actualIso,
        validDecode: true,
        usefulSymbol: false
      });
    } else {
      optimizerEpochMismatches++;
      console.error("OPTIMIZER ATTRIBUTION BUG", { scanId: info == null ? void 0 : info.scanId, optimizerAttribution });
      traceOptimizer({ time: receiverNow(), event: "ATTRIBUTION_BUG", scanId: info == null ? void 0 : info.scanId, candidateEpoch: epoch.id });
    }
  }
  const productionTrace = (info == null ? void 0 : info.scanId) === void 0 ? void 0 : benchmarkJobFrames.get(info.scanId);
  if (productionTrace) productionTrace.decoded.push({
    slot: header.slotIndex,
    esi: header.seq,
    bytes: header.blockLen,
    quad: info == null ? void 0 : info.quad
  });
  const identity = streamIdentity(header);
  if (decoder && streamKey !== identity) {
    const samePayload = header.payloadId === decoder.streamSeed && header.totalLen === decoder.totalLen;
    if (!samePayload && decodedAt - lastStreamDecodeAt < 1800) {
      noteScanOutcome(info == null ? void 0 : info.scanId, "otherStream");
      return;
    }
    resetActiveTransfer();
  }
  lastStreamDecodeAt = decodedAt;
  plainQrPolicy.noteFramed();
  let decodedRegion;
  if (!optimizerAttribution) {
    const priorBenchmarkFrame = activeBenchmarkFrame;
    if (productionTrace) activeBenchmarkFrame = productionTrace;
    const packetAt = info?.scanId === void 0 ? decodedAt : scanCapturedAt.get(info.scanId) ?? decodedAt;
    const geometryInfo = { ...info, crc32: true };
    if (info?.geometryMeasured === false) {
      gridLattice.noteValidPacket(packetAt);
      decodedRegion = markGridRegionDecoded(
        regions.find((region) => region.gridSlot === header.slotIndex),
        decodedAt,
        geometryInfo
      );
    } else if (box && validQuadObject(info?.quad) && info?.modules) {
      const snapshot = gridLattice.accept({
        identity,
        layoutId: header.layoutId,
        slotIndex: header.slotIndex,
        at: packetAt,
        scanId: info?.scanId ?? -1,
        box,
        quad: info.quad,
        modules: info.modules
      }, receiverFrameWidth, receiverFrameHeight);
      if (snapshot)
        decodedRegion = syncGrid(snapshot, decodedAt, header.slotIndex, geometryInfo);
    }
    if (productionTrace) productionTrace.stateAfter = gridLattice.state;
    activeBenchmarkFrame = priorBenchmarkFrame;
  }
  if (decodedRegion) noteSequence(decodedRegion, header.seq, info?.scanId === void 0 ? decodedAt : scanCapturedAt.get(info.scanId) ?? decodedAt);
  if (!decoder) {
    decoder = new TransportDecoder(header.k, header.blockLen, header.payloadId, header.totalLen);
    usefulFrameTimes.length = 0;
    uniqueQrTimes.length = 0;
    duplicateQrTimes.length = 0;
  resetDuplicateAttribution();
    streamKey = identity;
    startTs = receiverNow();
    progressEl.style.display = "block";
    progressStatus.style.display = "block";
  }
  const framesNewBefore = decoder.framesNew;
  const usefulBefore = decoder.usefulSymbols;
  const redundantBefore = decoder.framesRedundant;
  decoder.addFrame(header.seq, block);
  const receivedAt = receiverNow();
  const duplicateFrame = decoder.framesNew === framesNewBefore;
  (duplicateFrame ? duplicateQrTimes : uniqueQrTimes).push(receivedAt);
  noteDuplicateAttribution(header.seq, info?.sourceSequence, duplicateFrame);
  noteScanOutcome(
    info == null ? void 0 : info.scanId,
    decoder.framesNew === framesNewBefore ? "duplicate" : decoder.framesRedundant > redundantBefore ? "redundant" : "accepted"
  );
  if (decoder.framesNew > framesNewBefore) {
    if (lastDistinctArrivalAt) maxSequenceGapMs = Math.max(maxSequenceGapMs, receivedAt - lastDistinctArrivalAt);
    lastDistinctArrivalAt = receivedAt;
  }
  if (decoder.usefulSymbols > usefulBefore) {
    const added = decoder.usefulSymbols - usefulBefore;
    usefulFrameTimes.push(receivedAt);
    focusController.noteUsefulDecode(info == null ? void 0 : info.scanId);
    if (optimizerAttribution) {
      optimizerAttribution.evidence.usefulSymbols += added;
      optimizerAttribution.usefulSymbols += added;
      refreshCandidateEvidence(optimizerAttribution.evidence);
      const epoch = optimizerAttribution.epoch;
      traceOptimizer({
        time: receiverNow(),
        event: "USEFUL_SYMBOL",
        candidateId: epoch.candidateId,
        candidateEpoch: epoch.id,
        sourceSequence: optimizerAttribution.sourceFrameSequence,
        scanId: info == null ? void 0 : info.scanId,
        requestedExposure: epoch.requestedExposure,
        requestedIso: epoch.requestedIso,
        actualExposure: epoch.actualExposure,
        actualIso: epoch.actualIso,
        validDecode: true,
        usefulSymbol: true
      });
    }
  }
  if (decoder.isComplete && replayRunning) {
    if (!benchmarkCompletionChecked) {
      benchmarkCompletionChecked = true;
      const payload = decoder.assemble();
      if (fnv1a(payload) === header.payloadId) benchmarkVerifiedBytes = header.totalLen;
    }
  } else if (decoder.isComplete && !transferFinalizing) {
    freezeCompletionDiagnostics();
    void finalizeCompletedTransfer(header.payloadId);
  }
}
function paintTransferComplete() {
  bar.style.width = "100%";
  progressEl.setAttribute("aria-valuenow", "100");
  progressLabel.textContent = "100%";
  transferSizeLabel.textContent = "";
  etaLabel.textContent = "Finalizing…";
}
function waitForProgressPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}
async function finalizeCompletedTransfer(payloadId) {
  if (!decoder || done || transferFinalizing) return;
  transferFinalizing = true;
  const completingDecoder = decoder;
  const completingGeneration = captureGen;
  paintTransferComplete();
  await waitForProgressPaint();
  if (done || decoder !== completingDecoder || captureGen !== completingGeneration) {
    transferFinalizing = false;
    return;
  }
  const payload = completingDecoder.assemble();
  const seconds = (receiverNow() - startTs) / 1e3;
  const ok = fnv1a(payload) === payloadId;
  await finish(payload, ok, seconds);
}
function updateProgressEstimate() {
  if (!decoder || transferFinalizing) return;
  const elapsed = Math.max(0, (receiverNow() - startTs) / 1e3);
  const usefulFrames = decoder.usefulSymbols;
  const estimate = estimateTransferProgress(
    decoder.k,
    usefulFrames,
    elapsed,
    decoder.solvedCount
  );
  const percent = estimate.fraction * 100;
  const shownPercent = percent < 10 ? percent.toFixed(1) : percent.toFixed(0);
  bar.style.width = `${percent.toFixed(1)}%`;
  progressEl.setAttribute("aria-valuenow", String(Math.floor(percent)));
  progressLabel.textContent = `${shownPercent}%`;
  const remainingBytes = Math.max(1, Math.ceil(decoder.totalLen * (1 - estimate.fraction)));
  transferSizeLabel.textContent = formatBytes(remainingBytes);
  const liveKbs = liveGoodputKbs(receiverNow());
  const liveUsefulFps = liveKbs > 0 ? liveKbs * 1024 * expectedCodingOverhead() / decoder.blockLen : 0;
  etaLabel.textContent = liveUsefulFps > 0 && usefulFrames >= 3 ? `${formatDuration(estimate.remainingFrames / liveUsefulFps)} left` : "";
}
function finishPlainQr(text) {
  done = true;
  focusController.detach();
  cancelScanCapture();
  if (scanDialog.open) scanDialog.close();
  releaseScreenWakeLock();
  captureGen++;
  stream == null ? void 0 : stream.getTracks().forEach((track) => track.stop());
  clearInterval(statsTimer);
  statsTimer = void 0;
  pool.resize(0);
  preview.style.display = "none";
  metricsEl.style.display = "none";
  document.body.classList.add("receive-complete");
  document.body.classList.remove("receive-mode");
  setStatus("");
  showSnippet(text);
}
function liveGoodputKbs(now) {
  while (usefulFrameTimes.length && usefulFrameTimes[0] <= now - STATS_WINDOW_MS) {
    usefulFrameTimes.shift();
  }
  if (!decoder || !usefulFrameTimes.length) return 0;
  return usefulFrameTimes.length * decoder.blockLen / expectedCodingOverhead() / 1024 / (STATS_WINDOW_MS / 1e3);
}
async function finish(container, hashOk, seconds) {
  // Normal completion freezes at decoder.isComplete. Keep this as a defensive
  // fallback for any future completion path that reaches finish directly.
  freezeCompletionDiagnostics();
  done = true;
  focusController.detach();
  cancelScanCapture();
  if (scanDialog.open) scanDialog.close();
  releaseScreenWakeLock();
  const finishGen = ++captureGen;
  stream == null ? void 0 : stream.getTracks().forEach((t) => t.stop());
  clearInterval(statsTimer);
  statsTimer = void 0;
  pool.resize(0);
  preview.style.display = "none";
  bar.style.width = "100%";
  progressEl.setAttribute("aria-valuenow", "100");
  transferSizeLabel.textContent = "";
  etaLabel.textContent = `${formatDuration(seconds)} total`;
  try {
    if (!hashOk) throw new Error("The optical stream checksum did not match.");
    const file = await unpackFile(container);
    if (!await verifyFile(file)) throw new Error("The recovered file failed SHA-256 verification.");
    if (finishGen !== captureGen) {
      file.bytes.fill(0);
      return;
    }
    seconds = (receiverNow() - startTs) / 1e3;
    document.body.classList.add("receive-complete");
    document.body.classList.remove("receive-mode");
    transferSizeLabel.textContent = "";
    etaLabel.textContent = `${formatBytes(file.transmittedSize)} · ${formatDuration(seconds)}`;
    pipelineMetrics.style.display = "none";
    const rate = completedGoodputKbs(file.transmittedSize, seconds);
    metric("m-rate").textContent = `${rate.toFixed(1)} KB/s`;
    speedFeedback.className = `speed-feedback ${speedQualityClass(rate)}`;
    progressLabel.textContent = "✓ Complete";
    etaLabel.textContent = `${formatBytes(file.transmittedSize)} in ${formatDuration(seconds)}`;
    if (isSnippet(file)) {
      setStatus("");
      showSnippet(snippetText(file));
      return;
    }
    setStatus("");
    result.replaceChildren();
    if (file.type === "application/vnd.airgapper.files+zip") {
      const entries = readStoredZip(file.bytes);
      for (const entry of entries) {
        if (finishGen !== captureGen) {
          file.bytes.fill(0);
          return;
        }
        await appendReceivedFile(entry, result);
      }
      const archive = document.createElement("section");
      archive.className = "received-file received-archive";
      const archiveType = document.createElement("span");
      archiveType.className = "received-file-type";
      archiveType.textContent = "ZIP";
      const archiveRow = document.createElement("div");
      archiveRow.className = "received-file-download";
      const archiveLink = downloadLink(file.name, "application/zip", file.bytes, file.name);
      archiveLink.title = file.name;
      const archiveSize = document.createElement("span");
      archiveSize.textContent = formatBytes(file.bytes.length);
      archiveRow.append(archiveLink, archiveSize);
      archive.append(archiveType, archiveRow);
      result.append(archive);
    } else {
      await appendReceivedFile({ name: file.name, bytes: file.bytes }, result, file.type, true);
    }
  } catch (error) {
    if (finishGen !== captureGen) return;
    bar.classList.add("error");
    etaLabel.textContent = "Transfer failed";
    speedFeedback.className = "speed-feedback speed-low";
    showError(error instanceof Error ? error.message : String(error));
    const heading = document.createElement("div");
    heading.className = "failed";
    heading.textContent = "Transfer failed";
    const detail = document.createElement("p");
    detail.className = "received-note";
    detail.textContent = "Nothing usable came out of that stream. Restart the sender, then scan it again — a partial transfer costs nothing but the time.";
    result.replaceChildren(heading, detail, restartButton("Try again"));
  } finally {
    releaseTransportDecoder();
    container.fill(0);
  }
}
const MIME_BY_EXTENSION = {
  apng: "image/apng",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  m4v: "video/mp4",
  mov: "video/quicktime",
  mp4: "video/mp4",
  ogv: "video/ogg",
  webm: "video/webm",
  css: "text/css",
  csv: "text/csv",
  html: "text/html",
  json: "application/json",
  md: "text/markdown",
  pdf: "application/pdf",
  txt: "text/plain",
  zip: "application/zip"
};
function inferredType(name) {
  var _a;
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return (_a = MIME_BY_EXTENSION[extension]) != null ? _a : "application/octet-stream";
}
function downloadLink(name, type, bytes, label = `Save ${name}`) {
  const link = document.createElement("a");
  link.className = "download";
  link.href = receivedObjectUrl(new Blob([bytes], { type }));
  link.download = name;
  link.textContent = label;
  link.addEventListener("click", (event) => {
    if (!saveFileOnAndroid(name, type, bytes)) return;
    event.preventDefault();
  });
  return link;
}
async function appendReceivedFile(entry, parent, declaredType, autoplayVideo = false) {
  const dataGeneration = receivedDataGeneration;
  const type = declaredType || inferredType(entry.name);
  const container = document.createElement("section");
  container.className = "received-file";
  const url = receivedObjectUrl(new Blob([entry.bytes], { type }));
  let receivedVideo;
  if (type.startsWith("image/")) {
    const image = document.createElement("img");
    image.className = "received";
    image.alt = `Received file preview: ${entry.name}`;
    image.src = url;
    enableMediaInspection(image);
    container.append(image);
  } else if (type.startsWith("video/") || type.startsWith("audio/")) {
    const player = document.createElement(type.startsWith("video/") ? "video" : "audio");
    player.className = "received";
    player.controls = true;
    player.preload = "metadata";
    player.setAttribute("aria-label", `Received file: ${entry.name}`);
    if (player instanceof HTMLVideoElement) {
      player.playsInline = true;
      if (autoplayVideo) {
        player.autoplay = true;
        receivedVideo = player;
      }
    }
    const src = await servableMediaUrl(entry.bytes, type, url);
    if (dataGeneration !== receivedDataGeneration) {
      purgeReceivedData();
      return;
    }
    if (src !== url) player.addEventListener("error", () => {
      player.src = url;
    }, { once: true });
    player.src = src;
    if (player instanceof HTMLVideoElement) enableMediaInspection(player);
    container.append(player);
  }
  const downloadRow = document.createElement("div");
  downloadRow.className = "received-file-download";
  const link = downloadLink(entry.name, type, entry.bytes, entry.name);
  link.title = entry.name;
  const fileSize = document.createElement("span");
  fileSize.textContent = formatBytes(entry.bytes.length);
  downloadRow.append(link, fileSize);
  container.append(downloadRow);
  parent.append(container);
  if (receivedVideo) {
    void receivedVideo.play().catch(async () => {
      receivedVideo.muted = true;
      await receivedVideo.play().catch(() => void 0);
    });
  }
}
function enableMediaInspection(media) {
  media.classList.add("inspectable");
  media.tabIndex = 0;
  media.title = media instanceof HTMLImageElement ? "Tap to view and zoom" : "Tap to view full screen";
  const open = async () => {
    if (media instanceof HTMLVideoElement) {
      const iosVideo = media;
      if (!media.requestFullscreen && iosVideo.webkitEnterFullscreen) iosVideo.webkitEnterFullscreen();
      else if (media.requestFullscreen) await media.requestFullscreen().catch(() => void 0);
      else window.open(media.currentSrc || media.src, "_blank", "noopener");
      void media.play();
      return;
    }
    const placeholder = document.createComment("received image");
    media.replaceWith(placeholder);
    const inspector = document.createElement("div");
    inspector.className = "media-inspector";
    inspector.setAttribute("role", "dialog");
    inspector.setAttribute("aria-label", "Image viewer");
    const closeButton = document.createElement("button");
    closeButton.className = "media-inspector-close";
    closeButton.type = "button";
    closeButton.setAttribute("aria-label", "Close image");
    closeButton.textContent = "×";
    inspector.append(media, closeButton);
    document.body.append(inspector);
    document.body.classList.add("media-inspecting");
    let scale = 1;
    let x = 0;
    let y = 0;
    const pointers = /* @__PURE__ */ new Map();
    const render = () => {
      media.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px) scale(${scale})`;
    };
    const zoomAt = (nextScale, clientX, clientY) => {
      const clamped = Math.max(1, Math.min(6, nextScale));
      const ratio = clamped / scale;
      x = clientX - innerWidth / 2 - (clientX - innerWidth / 2 - x) * ratio;
      y = clientY - innerHeight / 2 - (clientY - innerHeight / 2 - y) * ratio;
      scale = clamped;
      if (scale === 1) x = y = 0;
      render();
    };
    const close = () => {
      if (!inspector.isConnected) return;
      inspector.remove();
      media.removeAttribute("style");
      placeholder.replaceWith(media);
      document.body.classList.remove("media-inspecting");
      media.focus();
    };
    closeButton.addEventListener("click", close);
    inspector.addEventListener("pointerdown", (event) => {
      if (event.target === closeButton) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      inspector.setPointerCapture(event.pointerId);
      media.classList.add("dragging");
    });
    inspector.addEventListener("pointermove", (event) => {
      var _a;
      const previous = pointers.get(event.pointerId);
      if (!previous) return;
      if (pointers.size === 1) {
        if (scale > 1) {
          x += event.clientX - previous.x;
          y += event.clientY - previous.y;
          render();
        }
      } else {
        const other = (_a = [...pointers.entries()].find(([id]) => id !== event.pointerId)) == null ? void 0 : _a[1];
        if (other) {
          const oldDistance = Math.hypot(previous.x - other.x, previous.y - other.y);
          const newDistance = Math.hypot(event.clientX - other.x, event.clientY - other.y);
          zoomAt(scale * newDistance / Math.max(1, oldDistance), (event.clientX + other.x) / 2, (event.clientY + other.y) / 2);
        }
      }
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    });
    const releasePointer = (event) => {
      pointers.delete(event.pointerId);
      if (!pointers.size) media.classList.remove("dragging");
    };
    inspector.addEventListener("pointerup", releasePointer);
    inspector.addEventListener("pointercancel", releasePointer);
    inspector.addEventListener("wheel", (event) => {
      event.preventDefault();
      zoomAt(scale * Math.exp(-event.deltaY * 2e-3), event.clientX, event.clientY);
    }, { passive: false });
    inspector.addEventListener("dblclick", (event) => zoomAt(scale > 1 ? 1 : 2.5, event.clientX, event.clientY));
  };
  media.addEventListener("click", () => void open());
  media.addEventListener("keydown", (event) => {
    if (!(event instanceof KeyboardEvent) || event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    void open();
  });
}
async function servableMediaUrl(bytes, type, blobUrl) {
  var _a;
  try {
    if (!((_a = navigator.serviceWorker) == null ? void 0 : _a.controller)) return blobUrl;
    const target = new URL(`../received-media/${Date.now()}-${Math.random().toString(36).slice(2)}`, window.location.href).href;
    const cache = await caches.open(RECEIVED_MEDIA_CACHE);
    await cache.put(
      target,
      new Response(new Blob([bytes]), {
        headers: {
          "Content-Type": type,
          "Content-Length": String(bytes.length)
        }
      })
    );
    return `${target}?v=${Date.now()}`;
  } catch {
    return blobUrl;
  }
}
const SNIPPET_LINK = /(?:https?:\/\/|www\.)[^\s<>]+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gi;
const TRAILING_LINK_PUNCTUATION = /[.,;:!?\])}]+$/;
function appendLinkifiedText(parent, text) {
  SNIPPET_LINK.lastIndex = 0;
  let cursor = 0;
  for (let match = SNIPPET_LINK.exec(text); match; match = SNIPPET_LINK.exec(text)) {
    const candidate = match[0].replace(TRAILING_LINK_PUNCTUATION, "");
    if (!candidate) continue;
    parent.append(document.createTextNode(text.slice(cursor, match.index)));
    const isEmail = /^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/.test(candidate);
    const href = isEmail ? `mailto:${candidate}` : candidate.toLowerCase().startsWith("www.") ? `https://${candidate}` : candidate;
    try {
      const url = new URL(href);
      if (!["http:", "https:", "mailto:"].includes(url.protocol)) throw new Error("unsupported link");
      const link = document.createElement("a");
      link.href = url.href;
      link.textContent = candidate;
      link.className = "snippet-link";
      if (url.protocol !== "mailto:") {
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      }
      parent.append(link);
    } catch {
      parent.append(document.createTextNode(candidate));
    }
    cursor = match.index + candidate.length;
  }
  parent.append(document.createTextNode(text.slice(cursor)));
}
function showSnippet(text) {
  const body = document.createElement("p");
  body.className = "received-note";
  appendLinkifiedText(body, text);
  const actions = document.createElement("div");
  actions.className = "note-actions";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "download";
  copy.textContent = "Copy";
  copy.addEventListener("click", async () => {
    try {
      if (!copyTextOnAndroid(text)) await navigator.clipboard.writeText(text);
      copy.textContent = "Copied";
      setTimeout(() => {
        copy.textContent = "Copy";
      }, 1500);
    } catch {
      copy.textContent = "Copy failed";
    }
  });
  actions.append(copy);
  result.replaceChildren(body, actions);
}
function speedQualityClass(rate) {
  return rate < 5 ? "speed-low" : rate < 25 ? "speed-mid" : rate < 75 ? "speed-good" : "speed-high";
}
recordCorpusBtn.addEventListener("click", () => {
  var _a, _b, _c, _d, _e, _f;
  if (benchmarkRecorder) {
    void finishCorpusRecording(benchmarkRecorder);
    return;
  }
  const track = stream == null ? void 0 : stream.getVideoTracks()[0];
  if (!track || !video.videoWidth || !video.videoHeight) {
    showError("Start the camera before recording.");
    return;
  }
  const version = (_c = (_b = (_a = document.querySelector(".app-version")) == null ? void 0 : _a.textContent) == null ? void 0 : _b.replace(/^v/, "")) != null ? _c : "unknown";
  benchmarkRecordingSequence = 0;
  benchmarkRecorder = new AgcapRecorder(7e3, {
    width: video.videoWidth,
    height: video.videoHeight,
    stride: video.videoWidth * 4,
    orientation: (_f = (_d = screen.orientation) == null ? void 0 : _d.type) != null ? _f : `${(_e = window.orientation) != null ? _e : 0}`,
    cameraSettings: track.getSettings(),
    airgapperVersion: version,
    userAgent: navigator.userAgent
  });
  benchmarkCorpus = void 0;
  benchmarkPendingBlob = void 0;
  recordCorpusBtn.textContent = "Stop · 7s";
  setStatus("Recording lossless frames… decoding paused");
});
loadCorpusBtn.addEventListener("click", () => corpusFile.click());
corpusFile.addEventListener("change", async () => {
  var _a;
  const file = (_a = corpusFile.files) == null ? void 0 : _a[0];
  if (!file) return;
  try {
    benchmarkStatus.textContent = "Loading lossless corpus…";
    if (!benchmarkDialog.open) benchmarkDialog.showModal();
    benchmarkCorpus = await AgcapCorpus.load(file);
    benchmarkPendingBlob = void 0;
    benchmarkStatus.textContent = `${benchmarkCorpus.length} frames · ${benchmarkCorpus.header.width}×${benchmarkCorpus.header.height} RGBA · ${benchmarkCorpus.header.recorderDrops} recorder drops`;
    runBenchmarkBtn.disabled = false;
  } catch (error) {
    benchmarkStatus.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    corpusFile.value = "";
  }
});
closeBenchmarkBtn.addEventListener("click", () => benchmarkDialog.close());
runBenchmarkBtn.addEventListener("click", () => void runReceiverBenchmark());
saveBenchmarkBtn.addEventListener("click", () => {
  var _a;
  if (!benchmarkResult) return;
  const blob = new Blob([JSON.stringify(benchmarkResult, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  const header = benchmarkCorpus == null ? void 0 : benchmarkCorpus.header;
  const device = header ? compactDeviceName(header) : "Dunk";
  const mode = replayMode.value === "maximum" ? "max" : "dp";
  const version = compactVersionName(String((_a = benchmarkResult.version) != null ? _a : "v0"));
  link.download = `bm-${device}-${version}-${mode}-${compactTimeName(/* @__PURE__ */ new Date())}.json`;
  link.click();
  saveBenchmarkBtn.textContent = "Downloaded";
  setTimeout(() => {
    URL.revokeObjectURL(link.href);
    saveBenchmarkBtn.textContent = "Save results";
  }, 1500);
});
function waitForWorkers() {
  return new Promise((resolve) => {
    const poll = () => pool.busyCount ? setTimeout(poll, 10) : resolve();
    poll();
  });
}
async function runOracle(corpus) {
  const latencies = [];
  const firstPass = new Array(corpus.length);
  const runPass = async (label, seedsFor, saveReplies) => {
    const workers = Array.from(
      { length: Math.min(corpus.length, selectedWorkerCount()) },
      () => createDecodeWorker()
    );
    let nextIndex = 0;
    let completed = 0;
    try {
      await Promise.all(workers.map(async (worker) => {
        var _a, _b;
        while (nextIndex < corpus.length) {
          const index = nextIndex++;
          const frame = await corpus.frame(index);
          const reply = await new Promise((resolve, reject) => {
            const id = (saveReplies ? 1e6 : 2e6) + index;
            worker.onmessage = (event) => {
              if (event.data.id === -1) return;
              if (event.data.id === id) resolve(event.data);
            };
            worker.onerror = (event) => reject(new Error(event.message || "Reference worker failed"));
            const pixels = frame.rgba.slice();
            worker.postMessage({
              id,
              oracle: true,
              oracleSeeds: seedsFor(index),
              full: true,
              buf: pixels.buffer,
              w: frame.meta.width,
              h: frame.meta.height
            }, [pixels.buffer]);
          });
          if (reply.error) throw new Error(reply.error);
          latencies.push((_a = reply.latencyMs) != null ? _a : 0);
          if (saveReplies) firstPass[index] = reply;
          const trace = benchmarkTraces[index];
          if (trace) {
            const known = new Set(trace.reference.map((item) => item.esi));
            for (const symbol of (_b = reply.symbols) != null ? _b : []) {
              const parsed = parseFrame(symbol.bytes);
              if (!parsed) continue;
              const esi = parsed.header.seq;
              if (known.has(esi)) continue;
              known.add(esi);
              trace.reference.push({ slot: parsed.header.slotIndex, esi, quad: symbol.quad });
            }
          }
          benchmarkStatus.textContent = `${label} ${++completed}/${corpus.length}`;
          await new Promise(requestAnimationFrame);
        }
      }));
    } finally {
      for (const worker of workers) worker.terminate();
    }
  };
  await runPass("Reference map", () => [], true);
  const templates = firstPass.flatMap((reply, index) => {
    var _a;
    return ((_a = reply == null ? void 0 : reply.symbols) != null ? _a : []).flatMap((symbol) => {
      const parsed = parseFrame(symbol.bytes);
      const layoutId = parsed == null ? void 0 : parsed.header.layoutId;
      const slot = parsed == null ? void 0 : parsed.header.slotIndex;
      return symbol.quad && symbol.modules && layoutId !== void 0 && slot !== void 0 ? [{ index, seed: { quad: symbol.quad, modules: symbol.modules, layoutId, slot } }] : [];
    });
  });
  if (templates.length) {
    await runPass("Reference refine", (index) => {
      let nearest = templates[0];
      for (const template of templates) {
        if (Math.abs(template.index - index) < Math.abs(nearest.index - index)) nearest = template;
      }
      return [nearest.seed];
    }, false);
  }
  return latencies;
}
function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}
function missedReason(trace, slot) {
  if (trace.decision === "worker busy") return "worker busy";
  const predicted = trace.predicted.find((item) => item.slot === slot);
  if ((predicted == null ? void 0 : predicted.state) === "OFFSCREEN") return "offscreen threshold";
  if (!trace.jobs.length) return trace.decision;
  if (trace.jobs.some((job) => job.full)) return "full-frame decoder miss";
  if (predicted && !predicted.submitted) return predicted.state === "PARTIAL" ? "partial/offscreen threshold" : "skipped predicted track";
  const submitted = trace.jobs.some((job) => slot !== void 0 && job.tracks.includes(slot));
  if (!submitted && trace.jobs.some((job) => !job.full)) return "crop excluded slot";
  if (trace.jobs.some((job) => job.trackedMisses)) {
    return trace.jobs.some((job) => job.fallbackAttempts && !job.fallbackSuccesses) ? "tracked sampler failed; fallback failed" : "tracked sampler failed";
  }
  return "decoder miss";
}
async function inspectBenchmarkFrame(index) {
  if (!benchmarkCorpus) return;
  const frame = await benchmarkCorpus.frame(index);
  const trace = benchmarkTraces[index];
  benchmarkFrame.width = frame.meta.width;
  benchmarkFrame.height = frame.meta.height;
  const ctx = benchmarkFrame.getContext("2d");
  ctx.putImageData(new ImageData(new Uint8ClampedArray(frame.rgba), frame.meta.width, frame.meta.height), 0, 0);
  const quad = (value, color, width) => {
    if (!validQuadObject(value)) return;
    const points = [value.topLeft, value.topRight, value.bottomRight, value.bottomLeft];
    ctx.beginPath();
    points.forEach((point, i) => i ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
    ctx.closePath();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  };
  for (const job of trace.jobs) {
    ctx.strokeStyle = "#f2a51a";
    ctx.lineWidth = 3;
    ctx.strokeRect(job.x, job.y, job.width, job.height);
  }
  for (const sighting of trace.sightings) {
    ctx.strokeStyle = "#b87500";
    ctx.lineWidth = 3;
    ctx.strokeRect(sighting.x, sighting.y, sighting.w, sighting.h);
  }
  for (const item of trace.predicted) quad(item.quad, item.submitted ? "#248cff" : "#777", 3);
  for (const item of trace.decoded) quad(item.quad, "#20c969", 5);
  for (const item of trace.reference) quad(item.quad, "#e43d3d", 5);
  const production = new Set(trace.decoded.map((item) => item.esi));
  const missed = trace.reference.filter((item) => !production.has(item.esi));
  benchmarkFrameStatus.textContent = `frame ${trace.sequence} · ${trace.stateBefore} → ${trace.stateAfter} · ${trace.decision} · missed ${missed.map((item) => {
    var _a;
    return `${(_a = item.slot) != null ? _a : "?"}: ${missedReason(trace, item.slot)}`;
  }).join(", ") || "none"}`;
}
async function runReceiverBenchmark({ productionOnly = false } = {}) {
  var _a, _b, _c, _d, _e, _f, _g, _h;
  if (replayRunning) return;
  runBenchmarkBtn.disabled = true;
  saveBenchmarkBtn.disabled = true;
  saveBenchmarkBtn.textContent = "Save results";
  benchmarkResult = void 0;
  benchmarkSummary.replaceChildren();
  benchmarkFrame.width = 0;
  benchmarkFrame.height = 0;
  benchmarkFrameStatus.textContent = "";
  if (!benchmarkCorpus && benchmarkPendingBlob) {
    benchmarkStatus.textContent = "Loading recorded frames…";
    await new Promise(requestAnimationFrame);
    try {
      benchmarkCorpus = await AgcapCorpus.load(benchmarkPendingBlob);
    } catch (error) {
      benchmarkStatus.textContent = error instanceof Error ? error.message : String(error);
      runBenchmarkBtn.disabled = false;
      return;
    }
  }
  const corpus = benchmarkCorpus;
  if (!corpus) {
    benchmarkStatus.textContent = "Record or load an .agcap first.";
    runBenchmarkBtn.disabled = false;
    return;
  }
  stopReceiver();
  replayRunning = true;
  benchmarkTraces = [];
  benchmarkJobFrames.clear();
  benchmarkVerifiedBytes = 0;
  benchmarkCompletionChecked = false;
  done = false;
  pool.resize(selectedWorkerCount());
  const firstTime = (_b = (_a = corpus.meta(0)) == null ? void 0 : _a.callbackTimeMs) != null ? _b : 0;
  cameraStartedTs = firstTime;
  const wallStart = performance.now();
  const maximum = replayMode.value === "maximum";
  try {
    for (let index = 0; index < corpus.length; index++) {
      const frame = await corpus.frame(index);
      if (!maximum) {
        const target = wallStart + frame.meta.callbackTimeMs - firstTime;
        const delay = target - performance.now();
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      }
      replayClock = frame.meta.callbackTimeMs;
      benchmarkStatus.textContent = `Production ${index + 1}/${corpus.length}`;
      if (index % 4 === 0) await new Promise(requestAnimationFrame);
      const cameraPixels = fastRegressionCameraFrames?.[index];
      let cameraFrame;
      if (cameraPixels) {
        if (frame.meta.width & 1 || frame.meta.height & 1)
          throw new Error("I420 fast regression requires even frame dimensions");
        cameraFrame = new VideoFrame(cameraPixels, {
          format: "I420",
          codedWidth: frame.meta.width,
          codedHeight: frame.meta.height,
          timestamp: Math.max(0, Math.round(frame.meta.callbackTimeMs * 1000))
        });
      }
      try {
        captureFrame({
          sequence: frame.meta.sequence,
          width: frame.meta.width,
          height: frame.meta.height,
          callbackTimeMs: frame.meta.callbackTimeMs,
          mediaTimeMs: frame.meta.mediaTimeMs,
          presentationTimeMs: frame.meta.presentationTimeMs,
          expectedDisplayTimeMs: frame.meta.expectedDisplayTimeMs,
          ...(cameraFrame
            ? { videoFrame: cameraFrame }
            : { image: new ImageData(new Uint8ClampedArray(frame.rgba), frame.meta.width, frame.meta.height) })
        });
      } finally {
        cameraFrame?.close();
      }
    }
    await waitForWorkers();
    let oracleLatencies = [];
    if (productionOnly) {
      benchmarkStatus.textContent = "Production replay complete";
    } else {
      const savedReference = window.__airgapperBenchmarkReference;
      const savedCorpus = savedReference == null ? void 0 : savedReference.corpus;
      const savedFrames = savedReference == null ? void 0 : savedReference.frames;
      if ((savedCorpus == null ? void 0 : savedCorpus.width) === corpus.header.width && savedCorpus.height === corpus.header.height && savedCorpus.startedAt === corpus.header.startedAt && savedCorpus.framesStored === corpus.header.framesStored && (savedFrames == null ? void 0 : savedFrames.length) === benchmarkTraces.length && savedFrames.every((item, index) => item.sequence === benchmarkTraces[index].sequence)) {
        for (let index = 0; index < benchmarkTraces.length; index++) {
          benchmarkTraces[index].reference = savedFrames[index].reference;
        }
        benchmarkStatus.textContent = "Reference map reused";
      } else {
        oracleLatencies = await runOracle(corpus);
      }
      for (const trace of benchmarkTraces) {
        const known = new Set(trace.reference.map((item) => item.esi));
        for (const packet of trace.decoded) {
          if (known.has(packet.esi)) continue;
          known.add(packet.esi);
          trace.reference.push({ slot: packet.slot, esi: packet.esi, quad: packet.quad });
        }
      }
    }
    const durationSeconds = Math.max(1e-3, (((_d = (_c = corpus.meta(corpus.length - 1)) == null ? void 0 : _c.callbackTimeMs) != null ? _d : firstTime) - firstTime) / 1e3);
    const productionPackets = benchmarkTraces.flatMap((trace) => trace.decoded);
    const opportunities = benchmarkTraces.reduce((sum, trace) => sum + new Set(trace.reference.map((item) => item.esi)).size, 0);
    const captured = benchmarkTraces.reduce((sum, trace) => {
      const production = new Set(trace.decoded.map((item) => item.esi));
      return sum + new Set(trace.reference.filter((item) => production.has(item.esi)).map((item) => item.esi)).size;
    }, 0);
    const jobs = benchmarkTraces.flatMap((trace) => trace.jobs);
    const decodeLatencies = jobs.flatMap((job) => job.decodeMs === void 0 ? [] : [job.decodeMs]);
    const transitions = benchmarkTraces.flatMap((trace) => trace.transitions);
    const firstReference = benchmarkTraces.findIndex((trace) => trace.reference.length > 0);
    const firstProduction = benchmarkTraces.findIndex((trace) => trace.decoded.length > 0);
    const firstLayout = benchmarkTraces.findIndex((trace) => trace.decoded.some((item) => item.slot !== void 0));
    const firstLock = benchmarkTraces.findIndex((trace) => trace.transitions.some((item) => item.to === "GRID_LOCK"));
    const lockLoss = benchmarkTraces.findIndex((trace, index) => index > firstLock && trace.transitions.some((item) => item.to === "PARTIAL_LOSS" || item.to === "REACQUIRE"));
    const localRecovery = benchmarkTraces.findIndex((trace, index) => index >= Math.max(0, lockLoss) && trace.transitions.some((item) => item.to === "PARTIAL_LOSS"));
    const globalRecovery = benchmarkTraces.findIndex((trace, index) => index >= Math.max(0, lockLoss) && trace.transitions.some((item) => item.to === "REACQUIRE"));
    const firstRecovered = benchmarkTraces.findIndex((trace, index) => index > lockLoss && trace.decoded.length > 0);
    const restored = benchmarkTraces.findIndex((trace, index) => index > lockLoss && trace.transitions.some((item) => item.to === "TRACK"));
    const lockedTraces = benchmarkTraces.filter((trace) => ["GRID_LOCK", "TRACK", "PARTIAL_LOSS"].includes(trace.stateBefore));
    const lockedOpportunities = lockedTraces.reduce((sum, trace) => sum + new Set(trace.reference.map((item) => item.esi)).size, 0);
    const lockedCaptured = lockedTraces.reduce((sum, trace) => {
      const production = new Set(trace.decoded.map((item) => item.esi));
      return sum + new Set(trace.reference.filter((item) => production.has(item.esi)).map((item) => item.esi)).size;
    }, 0);
    const uniquePackets = /* @__PURE__ */ new Map();
    for (const packet of productionPackets) if (!uniquePackets.has(packet.esi)) uniquePackets.set(packet.esi, packet);
    const uniqueUseful = uniquePackets.size;
    const uniqueUsefulBytes = [...uniquePackets.values()].reduce((sum, packet) => sum + packet.bytes, 0);
    const extraPackets = productionOnly ? [] : benchmarkTraces.flatMap((trace) => {
      const reference = new Set(trace.reference.map((item) => item.esi));
      return trace.decoded.filter((item) => !reference.has(item.esi));
    });
    const extraUniqueSymbols = new Set(extraPackets.map((item) => item.esi)).size;
    const workerCpuSeconds = Math.max(1e-3, decodeLatencies.reduce((sum, value) => sum + value, 0) / 1e3);
    const benchmarkNative = jobs.flatMap((job) => job.nativeMetrics ? [job.nativeMetrics] : []);
    const benchmarkNativeTracks = benchmarkNative.reduce((sum, metrics) => sum + (metrics.tracks ?? 0), 0);
    const benchmarkCrcFast = benchmarkNative.reduce((sum, metrics) => sum + (metrics.crcFastSuccesses ?? 0), 0);
    const benchmarkNativeMisses = benchmarkNative.reduce((sum, metrics) => sum + (metrics.misses ?? 0), 0);
    const benchmarkRsFallbacks = benchmarkNative.reduce((sum, metrics) => sum + (metrics.rsFallbacks ?? 0), 0);
    const sumNative = (key) => benchmarkNative.reduce((sum, metrics) => sum + (metrics[key] ?? 0), 0);
    const benchmarkFallbackAttempts = jobs.reduce((sum, job) => sum + (job.fallbackAttempts ?? 0), 0);
    const benchmarkFallbackSuccesses = jobs.reduce((sum, job) => sum + (job.fallbackSuccesses ?? 0), 0);
    const hotPath = {
      strict: replayMode.value === "correctness",
      postLockRecoverySuppressed: replayMode.value === "correctness",
      nativeTracks: benchmarkNativeTracks,
      crcFastSuccesses: benchmarkCrcFast,
      crcFastPercent: benchmarkNativeTracks ? benchmarkCrcFast / benchmarkNativeTracks * 100 : 0,
      nativeMisses: benchmarkNativeMisses,
      qrRsFallbacks: benchmarkRsFallbacks,
      anchorSuccesses: sumNative("anchorSuccesses"),
      anchorMisses: sumNative("anchorMisses"),
      thresholdFallbacks: sumNative("thresholdFallbacks"),
      outOfFrameMisses: sumNative("outOfFrameMisses"),
      bitstreamFailures: sumNative("bitstreamFailures"),
      crcFailures: sumNative("crcFailures"),
      multiSampleRetries: sumNative("multiSampleRetries"),
      localRecoveryAttempts: benchmarkFallbackAttempts,
      localRecoverySuccesses: benchmarkFallbackSuccesses,
      readFullAttempts: jobs.reduce((sum, job) => sum + (job.readFullAttempts ?? 0), 0),
      fullScanJobs: jobs.reduce((sum, job) => sum + Number(Boolean(job.full)), 0)
    };
    const processedPixels = jobs.reduce((sum, job) => {
      var _a2;
      return sum + job.pixels + ((_a2 = job.targetedPixels) != null ? _a2 : 0);
    }, 0);
    const byKind = Object.fromEntries([...new Set(jobs.map((job) => job.kind))].map((kind) => {
      const selected = jobs.filter((job) => job.kind === kind);
      return [kind, {
        jobs: selected.length,
        pixels: selected.reduce((sum, job) => sum + job.pixels, 0),
        processedPixels: selected.reduce((sum, job) => {
          var _a2;
          return sum + job.pixels + ((_a2 = job.targetedPixels) != null ? _a2 : 0);
        }, 0),
        bytes: selected.reduce((sum, job) => sum + job.bytes, 0),
        tracks: selected.reduce((sum, job) => sum + job.tracks.length, 0),
        outputSymbols: selected.reduce((sum, job) => {
          var _a2;
          return sum + ((_a2 = job.symbols) != null ? _a2 : 0);
        }, 0),
        hits: selected.reduce((sum, job) => {
          var _a2;
          return sum + ((_a2 = job.trackedHits) != null ? _a2 : 0);
        }, 0),
        misses: selected.reduce((sum, job) => {
          var _a2;
          return sum + ((_a2 = job.trackedMisses) != null ? _a2 : 0);
        }, 0),
        readFullAttempts: selected.reduce((sum, job) => {
          var _a2;
          return sum + ((_a2 = job.readFullAttempts) != null ? _a2 : 0);
        }, 0),
        fallbackAttempts: selected.reduce((sum, job) => {
          var _a2;
          return sum + ((_a2 = job.fallbackAttempts) != null ? _a2 : 0);
        }, 0),
        fallbackSuccesses: selected.reduce((sum, job) => {
          var _a2;
          return sum + ((_a2 = job.fallbackSuccesses) != null ? _a2 : 0);
        }, 0),
        fallbackFailures: selected.reduce((sum, job) => {
          var _a2, _b2;
          return sum + ((_a2 = job.fallbackAttempts) != null ? _a2 : 0) - ((_b2 = job.fallbackSuccesses) != null ? _b2 : 0);
        }, 0),
        targetedAttempts: selected.reduce((sum, job) => {
          var _a2;
          return sum + ((_a2 = job.targetedAttempts) != null ? _a2 : 0);
        }, 0),
        targetedPixels: selected.reduce((sum, job) => {
          var _a2;
          return sum + ((_a2 = job.targetedPixels) != null ? _a2 : 0);
        }, 0),
        targetedSuccesses: selected.reduce((sum, job) => {
          var _a2;
          return sum + ((_a2 = job.targetedSuccesses) != null ? _a2 : 0);
        }, 0)
      }];
    }));
    const failures = benchmarkTraces.flatMap((trace, index) => {
      const production = new Set(trace.decoded.map((item) => item.esi));
      return trace.reference.filter((item) => !production.has(item.esi)).map((item) => ({
        frameIndex: index,
        frameSequence: trace.sequence,
        slot: item.slot,
        esi: item.esi,
        reason: missedReason(trace, item.slot)
      }));
    });
    benchmarkResult = {
      format: productionOnly ? "AirGapper fast production regression" : "AirGapper receiver benchmark",
      productionOnly,
      version: (_e = document.querySelector(".app-version")) == null ? void 0 : _e.textContent,
      corpus: corpus.header,
      replay: { mode: replayMode.value, workers: pool.size, deviceLabel: deviceLabel?.value.trim() || null, device: navigator.userAgent },
      acquisition: { firstReferenceFrame: firstReference < 0 ? null : benchmarkTraces[firstReference].sequence, firstProductionFrame: firstProduction < 0 ? null : benchmarkTraces[firstProduction].sequence, deltaFrames: firstReference < 0 || firstProduction < 0 ? null : firstProduction - firstReference, deltaMs: firstReference < 0 || firstProduction < 0 ? null : benchmarkTraces[firstProduction].timestampMs - benchmarkTraces[firstReference].timestampMs, firstLayoutFrame: firstLayout < 0 ? null : benchmarkTraces[firstLayout].sequence, firstGridLockFrame: firstLock < 0 ? null : benchmarkTraces[firstLock].sequence },
      recovery: { lockLossFrame: lockLoss < 0 ? null : benchmarkTraces[lockLoss].sequence, localRecoveryStartFrame: localRecovery < 0 ? null : benchmarkTraces[localRecovery].sequence, globalReacquisitionStartFrame: globalRecovery < 0 ? null : benchmarkTraces[globalRecovery].sequence, firstRecoveredValidFrame: firstRecovered < 0 ? null : benchmarkTraces[firstRecovered].sequence, fullLockRestoredFrame: restored < 0 ? null : benchmarkTraces[restored].sequence },
      throughput: { durationSeconds, referenceOpportunities: opportunities, productionCaptured: captured, opportunityCapturePercent: opportunities ? captured / opportunities * 100 : 0, lockedReferenceOpportunities: lockedOpportunities, lockedProductionCaptured: lockedCaptured, lockedOpportunityCapturePercent: lockedOpportunities ? lockedCaptured / lockedOpportunities * 100 : 0, extraValidDecodes: extraPackets.length, extraUniqueSymbols, qrPerSecond: productionPackets.length / durationSeconds, uniqueUsefulQrPerSecond: uniqueUseful / durationSeconds, uniqueUsefulVerifiedBytesPerSecond: uniqueUsefulBytes / durationSeconds, verifiedKBPerFrame: benchmarkVerifiedBytes / 1024 / Math.max(1, benchmarkTraces.length), verifiedKBPerSecond: benchmarkVerifiedBytes / 1024 / durationSeconds },
      performance: { frameDropPercent: benchmarkTraces.length ? capturesDropped / benchmarkTraces.length * 100 : 0, workerBusyPercent: benchmarkTraces.length ? benchmarkTraces.reduce((sum, trace) => sum + trace.workerBusyFraction, 0) / benchmarkTraces.length * 100 : 0, pixelsPerSecond: jobs.reduce((sum, job) => sum + job.pixels, 0) / durationSeconds, processedPixelsPerSecond: processedPixels / durationSeconds, bytesRead: jobs.reduce((sum, job) => sum + job.bytes, 0), uniqueUsefulQrPerCpuSecond: uniqueUseful / workerCpuSeconds, uniqueUsefulBytesPerCpuSecond: uniqueUsefulBytes / workerCpuSeconds, uniqueUsefulQrPerMegapixel: uniqueUseful / Math.max(1e-3, processedPixels / 1e6), uniqueUsefulBytesPerMegapixel: uniqueUsefulBytes / Math.max(1e-3, processedPixels / 1e6), decodeP50Ms: percentile(decodeLatencies, 0.5), decodeP95Ms: percentile(decodeLatencies, 0.95), oracleP50Ms: productionOnly ? null : percentile(oracleLatencies, 0.5), workerBusyDrops: capturesDropped, byKind },
      hotPath,
      transitions,
      failures,
      frames: benchmarkTraces
    };
    benchmarkSummary.textContent = `opportunities  ${captured}/${opportunities} (${(opportunities ? captured / opportunities * 100 : 0).toFixed(1)}%)
QR/s           ${(productionPackets.length / durationSeconds).toFixed(1)}
useful QR/s    ${(uniqueUseful / durationSeconds).toFixed(1)}
verified KB/s ${(benchmarkVerifiedBytes / 1024 / durationSeconds).toFixed(1)}
hot CRC       ${hotPath.crcFastSuccesses}/${hotPath.nativeTracks} (${hotPath.crcFastPercent.toFixed(1)}%)
QR-RS/local   ${hotPath.qrRsFallbacks} / ${hotPath.localRecoverySuccesses}/${hotPath.localRecoveryAttempts}
decode p50/95 ${percentile(decodeLatencies, 0.5).toFixed(1)} / ${percentile(decodeLatencies, 0.95).toFixed(1)} ms
busy drops    ${capturesDropped}
pixels/s      ${(jobs.reduce((sum, job) => sum + job.pixels, 0) / durationSeconds).toFixed(0)}
misses        ${failures.length}`;
    const buttons = document.createElement("div");
    buttons.className = "benchmark-controls";
    if (failures.length) {
      const label = document.createElement("strong");
      label.textContent = "Missed frames";
      buttons.append(label);
    }
    for (const failure of failures.slice(0, 40)) {
      const button = document.createElement("button");
      button.className = "secondary-button";
      button.textContent = `Frame ${failure.frameSequence} · slot ${(_f = failure.slot) != null ? _f : "?"}`;
      button.addEventListener("click", () => void inspectBenchmarkFrame(failure.frameIndex));
      buttons.append(button);
    }
    if (failures.length) benchmarkSummary.append(buttons);
    benchmarkStatus.textContent = `Run complete · ${(_h = (_g = replayMode.selectedOptions[0]) == null ? void 0 : _g.textContent) != null ? _h : replayMode.value} · ${selectedWorkerCount()} worker${selectedWorkerCount() === 1 ? "" : "s"} · save this run to compare later`;
    saveBenchmarkBtn.disabled = false;
  } catch (error) {
    benchmarkStatus.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    replayRunning = false;
    replayClock = void 0;
    activeBenchmarkFrame = void 0;
    pool.resize(0);
    runBenchmarkBtn.disabled = false;
  }
}

async function fastRegressionImage(url) {
  const response = await fetch(url);
  if (!response.ok && !url.startsWith("data:")) throw new Error(`Benchmark image failed: ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, canvas.width, canvas.height);
  } finally {
    bitmap.close();
  }
}
function fastRegressionResult(result, expectedFrames) {
  const frames = result?.frames ?? [];
  const jobs = frames.flatMap((frame) => frame.jobs ?? []);
  const decoded = frames.flatMap((frame) => frame.decoded ?? []);
  const unique = new Set(decoded.map((packet) => packet.esi));
  const slotCounts = {};
  for (const packet of decoded) {
    const slot = Number(packet.slot);
    if (Number.isInteger(slot) && slot >= 0) slotCounts[slot] = (slotCounts[slot] ?? 0) + 1;
  }
  const guidedMetrics = jobs.flatMap((job) => job.guidedMetrics ? [job.guidedMetrics] : []);
  const guidedJobs = guidedMetrics.length;
  const sumGuided = (key) => guidedMetrics.reduce((sum, metrics) => sum + (Number(metrics[key]) || 0), 0);
  const guidedTracks = sumGuided("tracks");
  const guidedOutputs = sumGuided("successful");
  const moduleWeighted = guidedMetrics.reduce((sum, metrics) => sum + (Number(metrics.moduleSizeAvg) || 0) * (Number(metrics.tracks) || 0), 0);
  const moduleMins = guidedMetrics.map((metrics) => Number(metrics.moduleSizeMin) || 0).filter((value) => value > 0);
  const moduleMaxes = guidedMetrics.map((metrics) => Number(metrics.moduleSizeMax) || 0).filter((value) => value > 0);
  const guided = {
    jobs: guidedJobs,
    moduleSizeAvg: guidedTracks ? moduleWeighted / guidedTracks : 0,
    moduleSizeMin: moduleMins.length ? Math.min(...moduleMins) : 0,
    moduleSizeMax: moduleMaxes.length ? Math.max(...moduleMaxes) : 0,
    tracks: guidedTracks,
    outputs: guidedOutputs,
    turboAttempts: sumGuided("turboAttempts"),
    turboSuccesses: sumGuided("turboSuccesses"),
    stableEligibleTracks: sumGuided("stableEligibleTracks"),
    stableRsAttempts: sumGuided("stableRsAttempts"),
    stableRsSuccesses: sumGuided("stableRsSuccesses"),
    sparseProfileAttempts: sumGuided("sparseProfileAttempts"),
    sparseProfileSuccesses: sumGuided("sparseProfileSuccesses"),
    dataOnlyAttempts: sumGuided("sparseNoRsAttempts"),
    dataOnlySuccesses: sumGuided("sparseNoRsSuccesses"),
    rsFallbacks: sumGuided("sparseRsFallbacks"),
    sparseAttempts: sumGuided("fastDecodeAttempts"),
    sparseSuccesses: sumGuided("fastDecodeSuccesses"),
    genericFallbackTracks: sumGuided("genericFallbackTracks"),
    genericFallbackSuccesses: sumGuided("genericFallbackSuccesses"),
    genericDecodeAttempts: sumGuided("genericDecodeAttempts"),
    binarizeMs: sumGuided("binarizeMs"),
    finderMs: sumGuided("finderMs"),
    sampleMs: sumGuided("sampleMs"),
    decodeMs: sumGuided("decodeMs"),
    totalMs: sumGuided("totalMs")
  };
  const fullJobs = jobs.filter((job) => job.full).length;
  const trackedJobs = jobs.length - fullJobs;
  const decodeErrors = jobs.filter((job) => job.error).map((job) => String(job.error));
  const lockedStates = new Set(["GRID_LOCK", "TRACK", "PARTIAL_LOSS"]);
  // stateAfter can be updated asynchronously by a decode job whose source was
  // captured several frames earlier. Use stateBefore for wall-clock lock
  // observation; keep acquisition.firstGridLockFrame separately as the source
  // frame whose decode triggered the transition.
  const firstLockedStateFrame = frames.findIndex((frame) => lockedStates.has(frame.stateBefore));
  const stateCounts = {};
  for (const frame of frames) {
    const state = frame.stateBefore ?? "unknown";
    stateCounts[state] = (stateCounts[state] ?? 0) + 1;
  }
  const tail = frames.slice(Math.floor(frames.length / 2));
  const tailJobs = tail.flatMap((frame) => frame.jobs ?? []);
  const tailFullJobs = tailJobs.filter((job) => job.full).length;
  const tailTrackedJobs = tailJobs.length - tailFullJobs;
  const resultObject = {
    version: result?.version,
    productionOnly: result?.productionOnly === true,
    frames: frames.length,
    expectedFrames,
    decodedPackets: decoded.length,
    uniqueSymbols: unique.size,
    decodedSlots: Object.keys(slotCounts).map(Number).sort((a, b) => a - b),
    slotCounts,
    qrPerSecond: result?.throughput?.qrPerSecond ?? 0,
    uniqueUsefulQrPerSecond: result?.throughput?.uniqueUsefulQrPerSecond ?? 0,
    verifiedKBPerSecond: result?.throughput?.verifiedKBPerSecond ?? 0,
    firstProductionFrame: result?.acquisition?.firstProductionFrame,
    lockTriggerSourceFrame: result?.acquisition?.firstGridLockFrame,
    firstGridLockFrame: firstLockedStateFrame >= 0 ? (frames[firstLockedStateFrame]?.sequence ?? firstLockedStateFrame) : null,
    firstLockedStateFrame: firstLockedStateFrame >= 0 ? (frames[firstLockedStateFrame]?.sequence ?? firstLockedStateFrame) : null,
    stateCounts,
    finalState: frames.at(-1)?.stateAfter ?? frames.at(-1)?.stateBefore ?? null,
    transitions: result?.transitions?.length ?? 0,
    jobs: jobs.length,
    fullJobs,
    trackedJobs,
    guidedJobs,
    guidedTracks,
    guidedOutputs,
    guided,
    tailFullJobs,
    tailTrackedJobs,
    decodeP50Ms: result?.performance?.decodeP50Ms ?? 0,
    decodeP95Ms: result?.performance?.decodeP95Ms ?? 0,
    workerBusyPercent: result?.performance?.workerBusyPercent ?? 0,
    hotPath: result?.hotPath,
    byKind: result?.performance?.byKind ?? {},
    decodeErrors
  };
  resultObject.checks = {
    productionOnly: resultObject.productionOnly,
    allFramesReplayed: resultObject.frames === expectedFrames,
    decodedSomething: resultObject.decodedPackets > 0,
    discoveredLayout: resultObject.firstProductionFrame !== null && resultObject.firstProductionFrame !== void 0,
    scheduledWork: resultObject.jobs > 0,
    noDecodeErrors: resultObject.decodeErrors.length === 0,
    oracleSkipped: result?.performance?.oracleP50Ms === null
  };
  resultObject.ok = Object.values(resultObject.checks).every(Boolean);
  return resultObject;
}
function fastRegressionI420(image) {
  const width = image.width;
  const height = image.height;
  if (width & 1 || height & 1) throw new Error("I420 fast regression requires even image dimensions");
  const yBytes = width * height;
  const uvBytes = (width >> 1) * (height >> 1);
  const out = new Uint8Array(yBytes + uvBytes * 2);
  const rgba = image.data;
  // Integer BT.601-ish luminance. The fixture is an emissive black/white QR
  // wall, but using real RGB weights keeps this transport valid for future
  // colored/photographic regression frames too.
  for (let pixel = 0, src = 0; pixel < yBytes; pixel++, src += 4)
    out[pixel] = (77 * rgba[src] + 150 * rgba[src + 1] + 29 * rgba[src + 2] + 128) >> 8;
  out.fill(128, yBytes); // neutral chroma; the receiver consumes plane 0 only
  return out;
}
window.__airgapperRunFastRegression = async ({ urls, order, repeats = 1, fps = 30, mode = "performance", cameraPath = false }) => {
  if (!Array.isArray(urls) || !urls.length) throw new Error("Fast regression needs images");
  const images = [];
  for (const url of urls) images.push(await fastRegressionImage(url));
  const width = images[0].width;
  const height = images[0].height;
  if (images.some((image) => image.width !== width || image.height !== height))
    throw new Error("Fast regression images must have matching dimensions");
  let frameOrder;
  if (Array.isArray(order) && order.length) {
    frameOrder = order.map((index) => {
      if (!Number.isInteger(index) || index < 0 || index >= images.length) throw new Error(`Invalid fast regression frame index ${index}`);
      return index;
    });
  } else {
    frameOrder = [];
    for (let repeat = 0; repeat < Math.max(1, repeats); repeat++)
      for (let index = 0; index < images.length; index++) frameOrder.push(index);
  }
  const frameMs = 1000 / Math.max(1, fps);
  const records = [];
  for (let sequence = 0; sequence < frameOrder.length; sequence++) {
    const image = images[frameOrder[sequence]];
    const at = sequence * frameMs;
    records.push({
      meta: {
        sequence,
        width,
        height,
        stride: width * 4,
        callbackTimeMs: at,
        mediaTimeMs: at,
        presentationTimeMs: at,
        expectedDisplayTimeMs: at
      },
      pixels: new Uint8ClampedArray(image.data)
    });
  }
  fastRegressionCameraFrames = cameraPath
    ? (() => {
        const i420 = images.map(fastRegressionI420);
        return frameOrder.map((index) => i420[index]);
      })()
    : void 0;
  benchmarkCorpus = AgcapCorpus.fromRecords({
    format: "AirGapper fast production regression corpus",
    formatVersion: 4,
    pixelFormat: "RGBA8888",
    compression: "raw",
    width,
    height,
    stride: width * 4,
    framesStored: records.length,
    recorderDrops: 0,
    estimatedCameraDrops: 0,
    cameraSettings: { width, height, frameRate: fps },
    startedAt: `fast-${width}x${height}-${images.length}-${records.length}`
  }, records);
  benchmarkPendingBlob = void 0;
  replayMode.value = mode;
  try {
    await runReceiverBenchmark({ productionOnly: true });
  } finally {
    fastRegressionCameraFrames = void 0;
  }
  if (!benchmarkResult) throw new Error(benchmarkStatus.textContent || "Fast regression failed to produce a result");
  const summary = fastRegressionResult(benchmarkResult, records.length);
  if (!summary.ok) {
    const failed = Object.entries(summary.checks).filter(([, ok]) => !ok).map(([name]) => name).join(", ");
    throw new Error(`Fast regression invariant failed: ${failed} · ${JSON.stringify(summary)}`);
  }
  return summary;
};

function updateStats(forceDiagnostics = false) {
  if (done) return;
  const now = receiverNow();
  if (optimizeEnabled) beginOptimizeWhenReady();
  if (forceDiagnostics || !receiverDevActions.hidden) renderFocusDiagnostics();
  const prune = (a) => {
    while (a.length > 0 && a[0] < now - STATS_WINDOW_MS) a.shift();
  };
  prune(captureTimes);
  prune(qrReadTimes);
  prune(poolBusyTimes);
  prune(scanCompletionTimes);
  prune(decodeFrameTimes);
  prune(uniqueQrTimes);
  prune(duplicateQrTimes);
  prune(usefulFrameTimes);
  const perSecond = (a) => a.length / (STATS_WINDOW_MS / 1e3);
  const cameraRate = perSecond(captureTimes);
  const completionRate = perSecond(scanCompletionTimes);
  const decodeFrameRate = perSecond(decodeFrameTimes);
  const qrRate = perSecond(qrReadTimes);
  const uniqueRate = perSecond(uniqueQrTimes);
const duplicateRate = perSecond(duplicateQrTimes);
const usefulRate = perSecond(usefulFrameTimes);
if ((forceDiagnostics || !receiverDevActions.hidden) && transportDiagnostics) {
  const transportRate = uniqueRate + duplicateRate;
  const duplicatePercent = transportRate > 0 ? duplicateRate / transportRate * 100 : 0;
  const totals = decoder ? `${decoder.framesNew} unique · ${decoder.framesDup} duplicate · ${decoder.framesRedundant} redundant` : "no active transport";
  const runSeconds = decoder && startTs ? Math.max(1e-3, (now - startTs) / 1e3) : 0;
  const cameraSeconds = cameraStartedTs ? Math.max(0, (now - cameraStartedTs) / 1e3) : 0;
  const startupBase = framePumpStartedAt || cameraStartedTs;
  const firstCaptureAt = captureTimes[0] ?? 0;
  const firstJobAt = hotJobSubmitSamples[0]?.at ?? 0;
  const firstQrAt = qrReadTimes[0] ?? 0;
  const startupMs = (at) => startupBase && at ? Math.max(0, at - startupBase) : null;
  const startupValue = (at) => {
    const value = startupMs(at);
    return value === null ? "waiting" : `${value.toFixed(0)}ms`;
  };
  const runUniqueRate = decoder && runSeconds ? decoder.framesNew / runSeconds : 0;
  const runDuplicateRate = decoder && runSeconds ? decoder.framesDup / runSeconds : 0;
  const runUsefulRate = decoder && runSeconds ? decoder.usefulSymbols / runSeconds : 0;
  const runTransportRate = runUniqueRate + runDuplicateRate;
  const runDuplicatePercent = runTransportRate > 0 ? runDuplicateRate / runTransportRate * 100 : 0;
  const runGoodputKbs = decoder && runSeconds ? decoder.usefulSymbols * decoder.blockLen / expectedCodingOverhead() / 1024 / runSeconds : 0;
  noteCameraPerformance(runGoodputKbs, runUniqueRate, runSeconds);
  const fastPercent = hotPathAudit.nativeTracks ? hotPathAudit.crcFastSuccesses / hotPathAudit.nativeTracks * 100 : 0;
  const pipelineSeconds = livePipeline.startedAt ? Math.max(1e-3, (now - livePipeline.startedAt) / 1e3) : 0;
  const activeJobs = pool.activeJobs;
  const oldestActiveMs = activeJobs.length ? Math.max(...activeJobs.map((job) => job.ageMs)) : 0;
  const trackedP50 = livePercentile(livePipeline.trackedLatencies, 0.5);
  const trackedP95 = livePercentile(livePipeline.trackedLatencies, 0.95);
  const fullP50 = livePercentile(livePipeline.fullLatencies, 0.5);
  const fullP95 = livePercentile(livePipeline.fullLatencies, 0.95);
  const workerSeconds = livePipeline.latencyMs / 1e3;
  const activeWorkerSeconds = activeJobs.reduce((sum, job) => sum + job.ageMs, 0) / 1e3;
  const accountedWorkerSeconds = workerSeconds + activeWorkerSeconds;
  const workerCapacitySeconds = pipelineSeconds * Math.max(1, pool.size);
  const workerCpuPercent = workerCapacitySeconds ? Math.min(999, accountedWorkerSeconds / workerCapacitySeconds * 100) : 0;
  const phaseTotalMs = Math.max(1e-6, livePipeline.latencyMs);
  const busyDrops = Math.max(0, capturesDropped - livePipeline.droppedBase);
  const processorTotal = Number(frameTrackProcessor?.totalFrames ?? 0);
  const processorDiscarded = Number(frameTrackProcessor?.discardedFrames ?? 0);
  const processorDropPercent = processorTotal > 0 ? processorDiscarded / processorTotal * 100 : 0;
  const trackedYield = livePipeline.submittedTracks ? livePipeline.trackedOutputSymbols / livePipeline.submittedTracks * 100 : 0;
  const trackedMpPerJob = livePipeline.submittedTracked ? livePipeline.submittedTrackedPixels / livePipeline.submittedTracked / 1e6 : 0;
  const fullMpPerJob = livePipeline.submittedFull ? livePipeline.submittedFullPixels / livePipeline.submittedFull / 1e6 : 0;
  const mpPerSecond = pipelineSeconds ? livePipeline.submittedPixels / 1e6 / pipelineSeconds : 0;
  const trackedMax = livePipeline.trackedLatencies.length ? Math.max(...livePipeline.trackedLatencies) : 0;
  const fullMax = livePipeline.fullLatencies.length ? Math.max(...livePipeline.fullLatencies) : 0;
  const activeSummary = activeJobs.length
    ? activeJobs.map((job) => `w${job.slot}:${job.full ? "full" : "track"}/${job.tracks}@${(job.ageMs / 1e3).toFixed(1)}s`).join(" ")
    : "none";
  const lastCompletionAgeMs = livePipeline.lastCompletedAt ? now - livePipeline.lastCompletedAt : pipelineSeconds * 1e3;
  const lastSubmitAgeMs = livePipeline.lastSubmittedAt ? now - livePipeline.lastSubmittedAt : pipelineSeconds * 1e3;
  const diagnosticP95Ms = Math.max(trackedP95, fullP95);
  const diagnosticStallThresholdMs = Math.max(5e3, Math.min(9e3, diagnosticP95Ms * 4 || 5e3));
  const diagnosticStalled = activeJobs.length > 0 && oldestActiveMs >= diagnosticStallThresholdMs && lastCompletionAgeMs >= diagnosticStallThresholdMs;
  const diagnosticSaturated = !diagnosticStalled && cameraRate > 0 && pool.size > 0 && pool.busyCount === pool.size;
  const pipelineState = diagnosticStalled ? "STALLED" : diagnosticSaturated ? "SATURATED" : activeJobs.length ? "ACTIVE" : "IDLE";
  const diagnosticDevice = deviceLabel?.value.trim() || "unlabeled";
  transportDiagnostics.textContent = `Build ${document.querySelector(".app-version")?.textContent ?? "—"} · Device ${diagnosticDevice}
Transport
Run ${runSeconds ? formatDuration(runSeconds) : "waiting for first packet"}${cameraSeconds ? ` · camera ${formatDuration(cameraSeconds)}` : ""} · recent window ${(STATS_WINDOW_MS / 1e3).toFixed(1)}s
Startup  source ${startupValue(framePumpFirstFrameAt)} · capture ${startupValue(firstCaptureAt)} · job ${startupValue(firstJobAt)} · QR ${startupValue(firstQrAt)} · pump ${framePumpMode}
Average unique ${runUniqueRate.toFixed(1)} QR/s · duplicate ${runDuplicateRate.toFixed(1)} QR/s (${runDuplicatePercent.toFixed(0)}%) · useful ${runUsefulRate.toFixed(1)} QR/s · ${runGoodputKbs.toFixed(1)} KB/s
Recent  unique ${uniqueRate.toFixed(1)} QR/s · duplicate ${duplicateRate.toFixed(1)} QR/s (${duplicatePercent.toFixed(0)}%)
Recent  useful ${usefulRate.toFixed(1)} QR/s · ${liveGoodputKbs(now).toFixed(1)} KB/s
${totals}

Pipeline · ${pipelineState}
Camera ${pipelineSeconds ? formatDuration(pipelineSeconds) : "—"} · delivered ${livePipeline.captures} (${pipelineSeconds ? (livePipeline.captures / pipelineSeconds).toFixed(1) : "0.0"}/s) · processor ${processorTotal || "—"} source / ${processorDiscarded} discarded (${processorDropPercent.toFixed(1)}%)
Schedule ${livePipeline.submittedFrames} frames · ${livePipeline.submittedJobs} jobs = ${livePipeline.submittedTracked} tracked + ${livePipeline.submittedFull} full (${livePipeline.submittedAcquisition} acquire / ${livePipeline.submittedReacquire} reacquire) · ${busyDrops} worker-busy drops · ${activeJobs.length} in flight
Work    ${livePipeline.submittedTracks} tracked QR attempts → ${livePipeline.trackedOutputSymbols} tracked outputs (${trackedYield.toFixed(1)}%) · full outputs ${livePipeline.fullOutputSymbols} · ${livePipeline.readFullAttempts} readFull calls
Pixels  tracked ${trackedMpPerJob.toFixed(2)} MP/job · full ${fullMpPerJob.toFixed(2)} MP/job · submitted ${mpPerSecond.toFixed(1)} MP/s
CPU     ${workerSeconds.toFixed(1)} completed worker-s + ${activeWorkerSeconds.toFixed(1)} active / ${workerCapacitySeconds.toFixed(1)} available (${workerCpuPercent.toFixed(0)}%)
Phases  robust ${(livePipeline.robustMs / 1e3).toFixed(1)}s (${(livePipeline.robustMs / phaseTotalMs * 100).toFixed(0)}%; tracked ${(livePipeline.trackedRobustMs / 1e3).toFixed(1)} / full ${(livePipeline.fullRobustMs / 1e3).toFixed(1)}) · guided ${(livePipeline.guidedMs / 1e3).toFixed(1)}s (${(livePipeline.guidedMs / phaseTotalMs * 100).toFixed(0)}%; bin ${(livePipeline.guidedBinarizeMs / 1e3).toFixed(1)} / finder ${(livePipeline.guidedFinderMs / 1e3).toFixed(1)} / sample ${(livePipeline.guidedSampleMs / 1e3).toFixed(1)} / decode ${(livePipeline.guidedDecodeMs / 1e3).toFixed(1)} [sparse ${(livePipeline.guidedFastDecodeMs / 1e3).toFixed(1)} / fallback ${(livePipeline.guidedGenericDecodeMs / 1e3).toFixed(1)}]) · copy ${(livePipeline.copyMs / 1e3).toFixed(2)}s (${(livePipeline.copyMs / phaseTotalMs * 100).toFixed(1)}%) · native ${(livePipeline.nativeMs / 1e3).toFixed(1)}s · other ${(livePipeline.otherMs / 1e3).toFixed(1)}s · dispatch wait ${(livePipeline.workerWaitMs / 1e3).toFixed(2)}s
Guided  ${guidedRollout.state} · ${livePipeline.guidedJobs} jobs · ${livePipeline.guidedOutputs} outputs · turbo ${livePipeline.guidedTurboSuccesses}/${livePipeline.guidedTurboAttempts} · stableRS ${livePipeline.guidedStableRsSuccesses}/${livePipeline.guidedStableRsAttempts} · stable ${livePipeline.guidedStableEligibleTracks} · warp T/A/P ${livePipeline.guidedTranslationWarpTracks}/${livePipeline.guidedAffineWarpTracks}/${livePipeline.guidedPerspectiveWarpTracks} · finders ${livePipeline.guidedFinderSuccesses}/${livePipeline.guidedFinderAttempts} · sparse ${livePipeline.guidedFastDecodeSuccesses}/${livePipeline.guidedFastDecodeAttempts} · noRS ${livePipeline.guidedSparseNoRsSuccesses}/${livePipeline.guidedSparseNoRsAttempts} · sparseRS ${livePipeline.guidedSparseRsFallbacks} · sparse skip ${livePipeline.guidedSparseSkipped} · fallback ${livePipeline.guidedGenericFallbackSuccesses}/${livePipeline.guidedGenericFallbackTracks} slots · ${livePipeline.guidedGenericDecodeAttempts} decodes · skip ${livePipeline.guidedGenericFallbackSkipped} · decode cost sparse ${(livePipeline.guidedFastDecodeMs / Math.max(1, livePipeline.guidedSparseNoRsAttempts + livePipeline.guidedSparseRsFallbacks)).toFixed(2)}ms/op · fallback ${(livePipeline.guidedGenericDecodeMs / Math.max(1, livePipeline.guidedGenericDecodeAttempts)).toFixed(2)}ms/call · baseline p50 ${guidedBaselineP50().toFixed(1)}ms · in flight ${guidedRollout.inFlight} · failures ${guidedRollout.failures}
Latency tracked avg ${livePipeline.completedTracked ? (livePipeline.trackedLatencyMs / livePipeline.completedTracked).toFixed(1) : "0.0"} · p50 ${trackedP50.toFixed(1)} · p95 ${trackedP95.toFixed(1)} · max ${trackedMax.toFixed(1)} ms · full avg ${livePipeline.completedFull ? (livePipeline.fullLatencyMs / livePipeline.completedFull).toFixed(1) : "0.0"} · p50 ${fullP50.toFixed(1)} · p95 ${fullP95.toFixed(1)} · max ${fullMax.toFixed(1)} ms
Workers ${activeJobs.length}/${pool.size} active · oldest ${(oldestActiveMs / 1e3).toFixed(1)}s · last submit ${(lastSubmitAgeMs / 1e3).toFixed(1)}s · last completion ${(lastCompletionAgeMs / 1e3).toFixed(1)}s · timeouts ${livePipeline.timeouts} · errors ${livePipeline.errors}
Active  ${activeSummary}

Runtime ${RECEIVER_RUNTIME_BUILD}
Hot path ${strictHotPathActive() ? `STRICT · lock ${strictHotPathLockSeen ? "established" : "acquiring"}` : "LIVE"}
Native CRC ${hotPathAudit.crcFastSuccesses}/${hotPathAudit.nativeTracks} (${fastPercent.toFixed(1)}%) · successful ${hotPathAudit.nativeSuccessful} · misses ${hotPathAudit.nativeMisses}
QR-RS ${hotPathAudit.rsFallbacks} · local robust ${hotPathAudit.localRecoverySuccesses}/${hotPathAudit.localRecoveryAttempts} · readFull ${hotPathAudit.readFullAttempts}
Motion ${hotPathAudit.translationSuccesses}/${hotPathAudit.translationAttempts} · calibration ${hotPathAudit.calibrationSuccesses}/${hotPathAudit.calibrationAttempts} · frame misses ${hotPathAudit.outOfFrameMisses}
Cached map CRC ${hotPathAudit.fastSamplerSuccesses}/${hotPathAudit.fastSamplerAttempts} · bitstream ${hotPathAudit.bitstreamFailures} · CRC ${hotPathAudit.crcFailures} · Hybrid fallback ${hotPathAudit.anchorBypassSuccesses}/${hotPathAudit.anchorBypassAttempts}
Geometry ${lastGridSnapshot ? `${lastGridSnapshot.provisional ? "provisional · " : ""}${lastGridSnapshot.observedSlots ?? 0}/${lastGridSnapshot.slots.length} fresh · calibrated ${lastGridSnapshot.correctedSlots ?? 0}/${lastGridSnapshot.slots.length} · global fit ${((lastGridSnapshot.fitError ?? 0) * 100).toFixed(1)}%` : "no lattice"}
Pixel path ${lastDirectPixelPath.toUpperCase()}
Generic full ${hotPathAudit.fullScanSuccesses}/${hotPathAudit.fullScanJobs} · acquisition ${hotPathAudit.acquisitionFullScans} · reacquire ${hotPathAudit.reacquireFullScans}`;
  transportDiagnostics.textContent += `\n${duplicateSourceDeltaSummary()}`;
}
  metric("m-cap").textContent = `${cameraRate.toFixed(1)} fps`;
  metric("m-dec").textContent = `${qrRate.toFixed(1)} QR/s`;
  const activeJobs = pool.activeJobs;
  const oldestActiveMs = activeJobs.length ? Math.max(...activeJobs.map((job) => job.ageMs)) : 0;
  const observedP95Ms = Math.max(livePercentile(livePipeline.trackedLatencies, 0.95), livePercentile(livePipeline.fullLatencies, 0.95));
  const stallThresholdMs = Math.max(5e3, Math.min(9e3, observedP95Ms * 4 || 5e3));
  const completionSilenceMs = livePipeline.lastCompletedAt ? now - livePipeline.lastCompletedAt : now - cameraStartedTs;
  const stalled = activeJobs.length > 0 && oldestActiveMs >= stallThresholdMs && completionSilenceMs >= stallThresholdMs;
  const saturated = !stalled && cameraRate > 0 && pool.size > 0 && pool.busyCount === pool.size;
  const limit = metric("m-limit");
  limit.textContent = lastDecodeError
    ? `Scanner error: ${lastDecodeError}`
    : stalled
      ? `Scanner stalled · oldest job ${(oldestActiveMs / 1e3).toFixed(1)}s`
      : "";
  limit.classList.toggle("scanner-bound", stalled || Boolean(lastDecodeError));
  if (!decoder) return;
  const elapsed = (now - startTs) / 1e3;
  const activeGrid = regions.filter((region) => region.gridSlot !== void 0 && region.slotState === "ACTIVE");
  const liveNow = gridLattice.active ? activeGrid.filter((region) => region.decoded).length : decodedCount();
  if (timeline.length < TIMELINE_MAX_SAMPLES) {
    timeline.push([
      Number(elapsed.toFixed(1)),
      decoder.framesNew,
      decoder.solvedCount,
      liveNow,
      regions.length,
      Number(cameraRate.toFixed(1)),
      Number(qrRate.toFixed(1)),
      fullScans
    ]);
  }
  updateProgressEstimate();
  const liveRate = liveGoodputKbs(now);
  metric("m-rate").textContent = `${liveRate.toFixed(1)} KB/s`;
  speedFeedback.className = `speed-feedback ${speedQualityClass(liveRate)}`;
}
