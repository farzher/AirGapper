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
  parseFrame,
  streamIdentity,
  unpackFile,
  verifyFile
} from "../shared/protocol.js";
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
const startBtn = document.getElementById("start");
const cameraDevice = document.getElementById("camera-device");
const cameraDeviceControl = document.getElementById("camera-device-control");
const cameraResolution = document.getElementById("camera-resolution");
const cameraResolutionLabel = document.getElementById("camera-resolution-label");
const decodeWorkers = document.getElementById("decode-workers");
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
const autoWorkerCount = Math.max(1, Math.min(6, hardwareThreadCount - 1));
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
const BROWSER_MODE_RESULTS_KEY = "airgapper:browser-camera-modes:v1";
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
let automaticOptics = true;
let automaticExposureAxis = true;
let automaticIsoAxis = true;
let preferredExposureTime;
let manualFocusMode = "camera-auto";
let preferredFocusDistance;
let preferredIso;
let exposureApplyGeneration = 0;
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
      if (stage.focusMode !== void 0 || stage.focusDistance !== void 0 || stage.pointsOfInterest !== void 0) cameraFocusWritesTotal++;
      if (stage.exposureMode !== void 0 || stage.exposureTime !== void 0 || stage.iso !== void 0 || stage.exposureCompensation !== void 0) cameraExposureWritesTotal++;
      const ok = await applyAdvancedConstraint(track, stage);
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
        await applyStage({ focusMode: patch.focusMode });
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
    // Mobile's normal receiver always asks for the rear/environment camera.
    // Do not turn the camera Chrome happened to grant into a persistent exact
    // device choice. The selector is developer-only on mobile; selecting an
    // explicit device there still overrides this default.
    preferredCameraDeviceId = "";
    cameraDevice.value = activeExists ? activeId : "";
  } else if (activeExists) {
    // Desktop has no meaningful facingMode. Once Chrome grants a concrete
    // device, pin it for retries so a resolution fallback cannot jump webcams.
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
  return preferredCameraDeviceId
    ? { deviceId: { exact: preferredCameraDeviceId } }
    : { facingMode: "environment" };
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
  if (!automaticOptics) void applyExposureSetting(track);
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
function discardPendingGridLane(groupIndex) {
  const pending = pendingGridLanes[groupIndex];
  if (!pending) return;
  pending.direct.frame.close();
  pendingGridLanes[groupIndex] = null;
}
function clearPendingGridLanes() {
  for (let index = 0; index < pendingGridLanes.length; index++) discardPendingGridLane(index);
}
function queuePendingGridLane(groupIndex, source, geometry) {
  const direct = mappedDirectTrackedFrame(source, geometry.x, geometry.y, geometry.w, geometry.h, geometry.tracks);
  if (!direct) return false;
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
  (slot) => drainPendingGridLane(slot)
);
const captureTimes = [];
const qrReadTimes = [];
const uniqueQrTimes = [];
const duplicateQrTimes = [];
const poolBusyTimes = [];
const scanCompletionTimes = [];
const decodeFrameTimes = [];
let lastDecodeSubmittedSourceSequence = -1;
const usefulFrameTimes = [];
let totalCaptures = 0;
let totalDecodes = 0;
let fullScans = 0;
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
  const targetFrames = discovery ? phase === "commit" ? 6 : phase === "verify" ? 4 : phase === "finalist" ? 4 : phase === "revisit" ? 3 : 2 : phase === "commit" ? singleQr ? 7 : 6 : phase === "verify" ? singleQr ? 5 : 4 : phase === "finalist" ? singleQr ? 5 : 4 : phase === "revisit" ? singleQr ? 5 : 3 : phase === "refine" ? singleQr ? 4 : 3 : singleQr ? 4 : 3;
  const maxBurstMs = discovery ? phase === "commit" ? 1100 : phase === "verify" ? 800 : phase === "finalist" ? 800 : 650 : phase === "commit" ? 1100 : phase === "verify" ? 800 : phase === "finalist" ? 800 : singleQr ? 750 : 550;
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
    while (token === optimizeMeasureToken && evidence.completedJobs < evidence.submittedJobs && receiverNow() - waitStartedAt < 6e3) {
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
copyDiagnostics.addEventListener("click", async () => {
  var _a;
  const focusText = (_a = focusDiagnostics.textContent) != null ? _a : "";
  const text = [focusText, transportDiagnostics?.textContent ?? ""].filter(Boolean).join("\n\n");
  try {
    if (!copyTextOnAndroid(text)) await navigator.clipboard.writeText(text);
    copyDiagnostics.textContent = "Copied";
  } catch {
    copyDiagnostics.textContent = "Copy failed";
  }
  setTimeout(() => {
    copyDiagnostics.textContent = "Copy diagnostics";
  }, 1500);
});
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
const localReacquireIds = /* @__PURE__ */ new Set();
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
  outOfFrameMisses: 0,
  bitstreamFailures: 0,
  crcFailures: 0,
  anchorBypassAttempts: 0,
  anchorBypassSuccesses: 0,
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
function noteDecodeCompleted(id, completion) {
  var _a;
  const auditMode = hotPathJobMode.get(id);
  hotPathJobMode.delete(id);
  const auditThisCompletion = Boolean(auditMode && auditMode.generation === hotPathAuditGeneration && auditMode.strict === strictHotPathEnabled);
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
  }
  benchmarkJobFrames.delete(id);
  const fullJob = fullScanJobs.get(id);
  fullScanIds.delete(id);
  fullScanJobs.delete(id);
  localReacquireIds.delete(id);
  scanCapturedAt.delete(id);
  scanCompletionTimes.push(receiverNow());
  focusController.noteDecoderCompletion(id);
  if (completion.directFrameFailed) {
    directFrameDisabled = true;
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
  if (completion.pixelPath) lastDirectPixelPath = completion.pixelPath;
  if (auditThisCompletion && completion.nativeMetrics) {
    hotPathAudit.trackedJobs++;
    hotPathAudit.nativeTracks += completion.nativeMetrics.tracks ?? 0;
    hotPathAudit.nativeSuccessful += completion.nativeMetrics.successful ?? 0;
    hotPathAudit.crcFastSuccesses += completion.nativeMetrics.crcFastSuccesses ?? 0;
    hotPathAudit.nativeMisses += completion.nativeMetrics.misses ?? 0;
    hotPathAudit.rsFallbacks += completion.nativeMetrics.rsFallbacks ?? 0;
    hotPathAudit.anchorSuccesses += completion.nativeMetrics.anchorSuccesses ?? 0;
    hotPathAudit.anchorMisses += completion.nativeMetrics.anchorMisses ?? 0;
    hotPathAudit.outOfFrameMisses += completion.nativeMetrics.outOfFrameMisses ?? 0;
    hotPathAudit.bitstreamFailures += completion.nativeMetrics.bitstreamFailures ?? 0;
    hotPathAudit.crcFailures += completion.nativeMetrics.crcFailures ?? 0;
    hotPathAudit.anchorBypassAttempts += completion.nativeMetrics.anchorBypassAttempts ?? 0;
    hotPathAudit.anchorBypassSuccesses += completion.nativeMetrics.anchorBypassSuccesses ?? 0;
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
  if (completion.full) {
  } else if (completion.symbolCount === 0) {
  }
  if (completion.trackedAttempted && !completion.trackedHit && completion.fallbackAttempted) {
  }
  finishScanCapture(id, completion);
  scanOutcomes.delete(id);
  const attempts = cropAttempts.get(id);
  cropAttempts.delete(id);
  optimizerAttributionComplete(id);
  if (!attempts) return;
  for (const attempt of attempts) {
    const region = attempt.region;
    region.decodeAttempts++;
    region.lastAttemptAt = receiverNow();
    region.averageDecodeCostMs = region.averageDecodeCostMs ? region.averageDecodeCostMs * 0.8 + completion.latencyMs * 0.2 : completion.latencyMs;
    const hit = completion.symbols.some((symbol) => symbol.box && regionAt(symbol.box) === region);
    region.decodeConfidence = region.decodeConfidence * 0.82 + Number(hit) * 0.18;
    if (!hit && ((_a = region.lastHitScanId) != null ? _a : -1) <= id) {
      region.consecutiveMisses++;
      if (region.consecutiveMisses >= 3) region.decoded = false;
    }
  }
}
const REGION_TTL_MS = 5e3;
const SIGHTING_REGION_TTL_MS = 3e3;
const ACQUISITION_SCAN_MS = 100;
const FULL_SCAN_DEGRADED_MS = 250;
const EXPECTED_REGIONS_DECAY_MS = 1e4;
const MAX_REGIONS = 15;
const REGION_PAD = 0.35;
let cropRotate = 0;
let lastFullScan = 0;
const fullScanIds = /* @__PURE__ */ new Set();
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
function syncGrid(snapshot, now, decodedSlot, info) {
  var _a, _b;
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
      globalGridConfidence: snapshot.confidence
    });
    if (slot.index === decodedSlot) {
      region.decoded = true;
      region.seen = now;
      region.decodedSeen = now;
      region.sightedSeen = now;
      region.consecutiveMisses = 0;
      region.detectionConfidence = 1;
      region.decodeConfidence = 1;
      region.decodeSuccesses++;
      region.crc32 = (_a = info == null ? void 0 : info.crc32) != null ? _a : true;
      if ((info == null ? void 0 : info.scanId) !== void 0) region.lastHitScanId = Math.max((_b = region.lastHitScanId) != null ? _b : -1, info.scanId);
      decodedRegion = region;
    }
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
      const step = Math.max((_b = caps.exposureCompensation.step) != null ? _b : 0, 0.01);
      const raw = Math.max(caps.exposureCompensation.min, Math.min(0, AUTO_QR_EV_BIAS));
      patch.exposureCompensation = Math.max(
        caps.exposureCompensation.min,
        Math.min(0, Math.round((raw - caps.exposureCompensation.min) / step) * step + caps.exposureCompensation.min)
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
  preferredExposureTime = requestedExposure;
  if (requestedIso !== void 0) preferredIso = requestedIso;
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
function populateBrowserCapabilities(track) {
  var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m;
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
    void applyExposureSetting(track);
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
const MAX_QR_MODULES = 177;
const BLUE_MIN_PIXELS_PER_MODULE = 4.5;
const overlayCtx = overlay.getContext("2d");
function captureQualityRate(region, now) {
  pruneSequenceSamples(region, now);
  return region.decodeAttempts ? region.decodeConfidence : region.sequenceSamples.length > 0 ? 0.5 : 0;
}
function hasDensityHeadroom(region) {
  if (!validQuadObject(region.quad) || !region.dim || region.dim >= MAX_QR_MODULES) return false;
  const corners = [
    region.quad.topLeft,
    region.quad.topRight,
    region.quad.bottomRight,
    region.quad.bottomLeft
  ];
  let shortestEdge = Infinity;
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    shortestEdge = Math.min(shortestEdge, Math.hypot(a.x - b.x, a.y - b.y));
  }
  return shortestEdge / region.dim >= BLUE_MIN_PIXELS_PER_MODULE;
}
function captureQualityColor(region, rate) {
  const headroom = hasDensityHeadroom(region);
  let level = 0;
  if ((rate >= 0.95 || region.qualityLevel === 5 && rate >= 0.9) && headroom) level = 5;
  else if ((rate >= 0.8 || region.qualityLevel >= 4 && rate >= 0.72) && headroom) level = 4;
  else if (rate >= 0.6 || region.qualityLevel >= 3 && rate >= 0.52) level = 3;
  else if (rate >= 0.35 || region.qualityLevel >= 2 && rate >= 0.28) level = 2;
  else if (rate >= 0.12 || region.qualityLevel >= 1 && rate >= 0.08) level = 1;
  region.qualityLevel = level;
  return ["#ff665c", "#ffb23e", "#d5d936", "#35d66f", "#42a5ff", "#00efff"][level];
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
    const color = captureQualityColor(r, quality);
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
  const sourceCaptureRate = captureTimes.reduce((count, at) => count + Number(at > receiverNow() - STATS_WINDOW_MS), 0) / (STATS_WINDOW_MS / 1e3);
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
    `Focus    requested ${(_e = diagnostic.requestedMode) != null ? _e : "—"} · actual ${(_f = diagnostic.actualMode) != null ? _f : "—"} · distance ${(_g = diagnostic.actualDistance) != null ? _g : "—"}`,
    `Focus    committed ${(_h = diagnostic.committedFocusMode) != null ? _h : "—"}/${(_i = diagnostic.committedFocusDistance) != null ? _i : "—"}`,
    `Exposure committed ${formatExposureMs(diagnostic.committedExposureTime)} · requested ${formatExposureMs(diagnostic.candidateExposureTime)} · actual ${formatExposureMs(diagnostic.actualExposure)} · EV ${(_j = diagnostic.actualExposureCompensation) != null ? _j : "—"}`,
    `ISO      committed ${(_k = diagnostic.committedIso) != null ? _k : "—"} · requested ${(_l = diagnostic.candidateIso) != null ? _l : "—"} · actual ${(_m = diagnostic.actualIso) != null ? _m : "—"}`,
    optical ? `Static   focus ${optical.focusScore.toFixed(2)} · separation ${optical.separation.toFixed(0)} · noise ${optical.noise.toFixed(1)} · banding ${optical.banding.toFixed(2)} · temporal ${optical.temporalContamination.toFixed(1)} · geometry ${diagnostic.geometryStable ? "stable" : "moving"}` : "Static   waiting for QR",
    `Payload  valid ${diagnostic.validDecodesInGeneration} · completions ${diagnostic.decoderCompletionsInGeneration} · silence ${(diagnostic.decodeSilenceMs / 1e3).toFixed(1)}s · decode gap ${(_o = (_n = diagnostic.recentInterdecodeMs) == null ? void 0 : _n.toFixed(0)) != null ? _o : "—"}ms · completion gap ${(_q = (_p = diagnostic.recentCompletionMs) == null ? void 0 : _p.toFixed(0)) != null ? _q : "—"}ms`,
    `Useful   ${diagnostic.lastUsefulDecodeAt === void 0 ? "none" : `${((performance.now() - diagnostic.lastUsefulDecodeAt) / 1e3).toFixed(1)}s ago`}`,
    `Counts   full AF+AE ${diagnostic.fullResetCount} · focus-only ${diagnostic.focusRefinementCount} · exposure-only ${diagnostic.exposureRefinementCount}`,
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
    lastNativeMetrics ? `Native   ${lastNativeMetrics.totalMs.toFixed(1)}ms · copy ${(lastNativeMetrics.frameCopyMs ?? 0).toFixed(1)} · anchor ${lastNativeMetrics.anchorMs.toFixed(1)} · sample ${lastNativeMetrics.samplingMs.toFixed(1)} · bits ${lastNativeMetrics.bitExtractionMs.toFixed(1)} · CRC ${lastNativeMetrics.crcMs.toFixed(1)} · RS ${lastNativeMetrics.rsFallbackMs.toFixed(1)} · ${lastNativeMetrics.samples} samples · ${lastNativeMetrics.successful}/${lastNativeMetrics.tracks} QR` : "",
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
  manualFocusMode = focusMode.value;
  syncExposureControls();
  saveCameraSettings();
  focusController.setStrategy(manualFocusMode);
});
focusDistance.addEventListener("input", () => {
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
cameraResolution.addEventListener("change", () => void changeCameraSettings());
cameraDevice?.addEventListener("change", () => {
  preferredCameraDeviceId = cameraDevice.value;
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
  clearTimeout(exposureApplyTimer);
  syncExposureControls();
  saveCameraSettings();
  const track = stream == null ? void 0 : stream.getVideoTracks()[0];
  if (!automaticOptics) {
    setOptimizeEnabled(false);
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
  preferredExposureTime = Number(cameraExposure.value);
  focusController.developerOverride("developer changed exposure time");
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
  preferredIso = Number(cameraIso.value);
  automaticIsoAxis = false;
  isoAxisAuto.checked = false;
  cameraIsoValue.value = String(Number(preferredIso.toPrecision(4)));
  syncExposureControls();
  saveCameraSettings();
  focusController.developerOverride("developer changed ISO");
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
  fullScanIds.clear();
  fullScanJobs.clear();
  localReacquireIds.clear();
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
let rvfcLastPresentedFrames = 0;
let rvfcSkippedFrames = 0;
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
  fullScanIds.clear();
  fullScanJobs.clear();
  localReacquireIds.clear();
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
  poolBusyTimes.length = 0;
  scanCompletionTimes.length = 0;
  decodeFrameTimes.length = 0;
  lastDecodeSubmittedSourceSequence = -1;
  cropAttempts.clear();
  cropRotate = 0;
  decodeExceptions = 0;
  lastDecodeError = "";
  lastNativeMetrics = void 0;
  lastDirectPixelPath = "—";
  resetHotPathAudit();
  strictHotPathLockSeen = false;
  trackingInvalidations = 0;
  workerLatencyMaxMs = 0;
  lastDistinctArrivalAt = 0;
  lastStreamDecodeAt = 0;
  maxSequenceGapMs = 0;
  pipelineEvents.length = 0;
  usefulFrameTimes.length = 0;
  totalCaptures = 0;
  totalDecodes = 0;
  fullScans = 0;
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
  fullScanIds.clear();
  fullScanJobs.clear();
  localReacquireIds.clear();
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
  directFrameDisabled = false;
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
  startBtn.style.display = "none";
  preview.style.display = "";
  video.srcObject = stream;
  await video.play().catch(() => void 0);
  preview.classList.remove("camera-loading");
  const activeTrack = stream.getVideoTracks()[0];
  if (activeTrack) {
    await refreshCameraDevices(activeTrack);
    populateBrowserCapabilities(activeTrack);
    showNegotiatedWebMode(activeTrack);
    if (!legacyAndroidApp) attachCameraController(activeTrack);
  }
  syncPreviewAspect();
  setStatus("");
  pool.resize(selectedWorkerCount());
  cameraStartedTs = receiverNow();
  captureGen++;
  startFramePump(captureGen, activeTrack);
  statsTimer = setInterval(updateStats, STATS_TICK_MS);
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
  const width = video.videoWidth || videoFrame?.displayWidth || videoFrame?.visibleRect?.width || videoFrame?.codedWidth || 0;
  const height = video.videoHeight || videoFrame?.displayHeight || videoFrame?.visibleRect?.height || videoFrame?.codedHeight || 0;
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
function startFramePump(gen, track) {
  stopFramePump();
  if (track && typeof MediaStreamTrackProcessor === "function") {
    try {
      const processor = new MediaStreamTrackProcessor({ track, maxBufferSize: 1 });
      const reader = processor.readable.getReader();
      frameTrackProcessor = processor;
      frameTrackReader = reader;
      framePumpMode = "MediaStreamTrackProcessor";
      void pumpTrackFrames(gen, reader, processor);
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
  const auditMode = {
    generation: hotPathAuditGeneration,
    strict: Boolean(message.strictHotPath),
    full: Boolean(message.full),
    acquisition: Boolean(message.full && !gridLattice.locked),
    reacquire: Boolean(message.full && gridLattice.locked),
    kind
  };
  const accepted = preferredWorker === void 0 ? pool.submit(message, transfer) : pool.submitTo(preferredWorker, message, transfer);
  if (accepted) {
    hotPathJobMode.set(message.id, auditMode);
    const submittedAt = receiverNow();
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
      fullScanIds.add(message.id);
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
let directFrameDisabled = false;
function opticalSampleDue(source) {
  if (replayRunning || source.sequence === lastOpticalSourceSequence) return false;
  const interval = focusController.opticalIntervalMs;
  return Number.isFinite(interval) && receiverNow() - lastOpticalSampleAt >= interval;
}
function cloneVideoFrame(source, forceRgba = false) {
  let frame = source.videoFrame;
  if (!frame) {
    try {
      frame = source.videoFrame = new VideoFrame(video);
    } catch {
      return null;
    }
  }
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
  const direct = cloneDirectDecodeFrame(source);
  if (!direct) return null;
  const pixelXf = direct.visibleX + x * direct.scaleX;
  const pixelYf = direct.visibleY + y * direct.scaleY;
  const pixelRf = direct.visibleX + (x + w) * direct.scaleX;
  const pixelBf = direct.visibleY + (y + h) * direct.scaleY;
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
  if (directFrameDisabled || optimizerPipelineActive || source.image || captureNextScan || opticalSampleDue(source) || typeof VideoFrame !== "function") return null;
  return cloneVideoFrame(source, false);
}
function cloneDirectFullScanFrame(source) {
  if (directFrameDisabled || optimizerPipelineActive || source.image || captureNextScan || typeof VideoFrame !== "function") return null;
  const direct = cloneVideoFrame(source, true);
  if (!direct || !direct.sameGrid) {
    direct?.frame.close();
    return null;
  }
  return direct;
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
  captureTimes.push(now);
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
  const latticeSnapshot = gridLattice.tick(now);
  if (latticeSnapshot) syncGrid(latticeSnapshot, now);
  else if (gridLattice.state === "REACQUIRE") {
    for (let i = regions.length - 1; i >= 0; i--) if (regions[i].gridSlot !== void 0) regions.splice(i, 1);
    gridShape = "";
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
  const allLockedCandidatesCold = lockedGeometryTrusted && recentLockedHits === 0 &&
    lockedGeometryCandidates.every((region) => region.consecutiveMisses >= 5);
  if (allLockedCandidatesCold) {
    gridLattice.reacquire(now, "all tracked slots cold; reacquiring geometry");
  }
  const gridNeedsDiscovery = lockedGeometryTrusted
    ? allLockedCandidatesCold
    : visibleGridSlots.some((region) => !region.decoded || region.slotState === "LOST");
  const trackingUnhealthy = regions.some((region) => region.gridSlot === void 0 && region.decoded && region.consecutiveMisses >= 4);
  if (gridLattice.locked) strictHotPathLockSeen = true;
  const strictLockedAudit = strictHotPathActive() && strictHotPathLockSeen && gridLattice.locked;
  // Correctness/strict mode is allowed to use the generic detector to acquire
  // the grid once. After lock, it may not hide tracked failures by falling
  // back to local robust decode or by abandoning the grid and reacquiring it.
  gridLattice.noteMissing(strictLockedAudit ? false : gridNeedsDiscovery, now);
  const needsRecoveryScan = strictLockedAudit ? false : lockedGeometryTrusted
    ? allLockedCandidatesCold || trackingUnhealthy
    : live === 0 || live < expectedRegions || trackingUnhealthy || gridNeedsDiscovery;
  const scanInterval = live === 0 ? ACQUISITION_SCAN_MS : FULL_SCAN_DEGRADED_MS;
  const captureHasTrackedWork = gridLattice.active ? lockedGeometryCandidates.length > 0 : regions.some((region) => region.decoded && region.quad && region.dim && validTrackedQuad(region, vw, vh));
  const strictAcquiring = strictHotPathActive() && !gridLattice.locked;
  const fullScanDue = strictAcquiring
    ? Boolean(captureNextScan) || now - lastFullScan > ACQUISITION_SCAN_MS
    : captureNextScan ? !captureHasTrackedWork : needsRecoveryScan && now - lastFullScan > scanInterval;
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
  if (fullScanDue && pool.busyCount === pool.size) {
    capturesDropped++;
    poolBusyTimes.push(now);
    activeBenchmarkFrame = void 0;
    return;
  }
  if (fullScanDue) {
    lastFullScan = now;
    fullScans++;
    let scanX = 0, scanY = 0, scanW = vw, scanH = vh;
    // During a still-trusted lock, even recovery is bounded to the only place
    // the declared grid can exist. Give it generous motion headroom, but never
    // pay a generic finder to inspect unrelated camera pixels.
    if (!captureNextScan && lockedGeometryTrusted && gridLattice.locked && !allLockedCandidatesCold) {
      const points = lockedGeometryCandidates.flatMap((region) => [
        region.quad.topLeft,
        region.quad.topRight,
        region.quad.bottomRight,
        region.quad.bottomLeft
      ]);
      const typicalEdge = Math.max(...lockedGeometryCandidates.map((region) => Math.max(region.w, region.h)));
      const pad = Math.max(24, Math.round(typicalEdge * 0.7));
      const quantum = 16;
      scanX = Math.max(0, Math.floor((Math.min(...points.map((point) => point.x)) - pad) / quantum) * quantum);
      scanY = Math.max(0, Math.floor((Math.min(...points.map((point) => point.y)) - pad) / quantum) * quantum);
      const scanRight = Math.min(vw, Math.ceil((Math.max(...points.map((point) => point.x)) + pad) / quantum) * quantum);
      const scanBottom = Math.min(vh, Math.ceil((Math.max(...points.map((point) => point.y)) + pad) / quantum) * quantum);
      scanW = Math.max(32, scanRight - scanX);
      scanH = Math.max(32, scanBottom - scanY);
    }
    const directFull = scanX === 0 && scanY === 0 && scanW === vw && scanH === vh && !lockedGeometryTrusted
      ? cloneDirectFullScanFrame(source)
      : null;
    if (directFull) {
      const id = frameId++;
      if (!submitReceiverJob(
        { id, videoFrame: directFull.frame, cropX: 0, cropY: 0, w: vw, h: vh, ox: 0, oy: 0, full: true, pixelFormat: "video-rgba" },
        [directFull.frame],
        "DIRECT FULL FRAME",
        trace,
        source.sequence
      )) directFull.frame.close();
      if (trace) trace.stateAfter = gridLattice.state;
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
      { id, buf: img.data.buffer, w: scanW, h: scanH, ox: scanX, oy: scanY, full: true },
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
  const batchRegions = (gridLattice.active ? visibleGridSlots.filter(isGridDecodeCandidate) : regions.filter((region) => region.decoded)).filter((region) => region.quad && region.dim && validTrackedQuad(region, vw, vh)).slice(0, 15);
  const batchTracks = batchRegions.map((region) => ({
    id: region.id,
    slot: region.gridSlot,
    misses: region.consecutiveMisses,
    quad: region.quad,
    dim: region.dim,
    crc32: Boolean(region.crc32)
  }));
  const lockedLayout = lastGridSnapshot == null ? void 0 : lastGridSnapshot.layout;
const laneCount = lockedLayout ? Math.min(3, Math.min(lockedLayout.cols, lockedLayout.rows) === 1 ? Math.max(lockedLayout.cols, lockedLayout.rows) : Math.min(lockedLayout.cols, lockedLayout.rows)) : 0;
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
      const worstMisses = Math.max(...group.regions.map((region) => region.consecutiveMisses));
      const pad = Math.max(8, Math.round(typicalEdge * (0.08 + Math.min(0.16, worstMisses * 0.03))));
      const cropQuantum = 16;
      const x = Math.max(0, Math.floor((minX - pad) / cropQuantum) * cropQuantum);
      const y = Math.max(0, Math.floor((minY - pad) / cropQuantum) * cropQuantum);
      const right = Math.min(vw, Math.ceil((maxX + pad) / cropQuantum) * cropQuantum);
      const bottom = Math.min(vh, Math.ceil((maxY + pad) / cropQuantum) * cropQuantum);
      const w = right - x;
      const h = bottom - y;
      if (w < 32 || h < 32) continue;
      const geometry = { x, y, w, h, tracks: group.tracks, regions: group.regions, sourceSequence: source.sequence, laneCount, strictHotPath: strictHotPathActive() };
      if (workerSlot === void 0) {
        queuePendingGridLane(groupIndex, source, geometry);
        continue;
      }
      discardPendingGridLane(groupIndex);
      let laneImage;
      const direct = mappedDirectTrackedFrame(source, x, y, w, h, group.tracks);
      if (!direct) {
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
  if (batchTracks.length > 1) {
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
        poolBusyTimes.push(now);
        if (trace) trace.decision = "not scheduled: workers busy";
        activeBenchmarkFrame = void 0;
        return;
      }
      let shared;
      const sharedDirect = healthyGrid ? mappedDirectTrackedFrame(source, x, y, w, h, batchTracks) : null;
      if (!sharedDirect) {
        shared = readBoundedVideoCrop(source, x, y, w, h);
        inspectStaticQrOptics(source, shared, x, y);
        captureSubmittedScan(shared, x, y, false, batchTracks.map((track) => track.quad));
      }
      if (healthyGrid) {
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
  const eligible = gridLattice.active ? visibleGridSlots.filter(isGridDecodeCandidate).sort((a, b) => slotUsefulness(b) - slotUsefulness(a)) : [...regions];
  activeDecodeBudget = gridLattice.active ? Math.min(8, Math.max(4, pool.size * 2), eligible.length) : eligible.length;
  const scheduledRegions = eligible.slice(0, activeDecodeBudget);
  const trackedCapacity = Math.max(1, pool.size);
  const perRegionCapacity = gridLattice.locked ? 1 : Math.max(1, Math.floor(trackedCapacity / Math.max(1, scheduledRegions.length)));
  let submitted = false;
  for (let i = 0; i < scheduledRegions.length; i++) {
    const r = scheduledRegions[(i + cropRotate) % scheduledRegions.length];
    if (regionInflightCount(r) >= perRegionCapacity) continue;
    const quadBounds = r.quad ? trackedQuadBounds(r.quad) : null;
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
    const img = readBoundedVideoCrop(source, x, y, w, h);
    inspectStaticQrOptics(source, img, x, y);
    captureSubmittedScan(img, x, y, false, r.quad ? [r.quad] : []);
    const id = frameId++;
    cropAttempts.set(id, [{ region: r, quad: r.quad }]);
    const individualTrack = {
      id: r.id,
      slot: r.gridSlot,
      misses: r.consecutiveMisses,
      quad: r.quad,
      dim: r.dim,
      crc32: Boolean(r.crc32)
    };
    if (!submitReceiverJob(
      { id, buf: img.data.buffer, w, h, ox: x, oy: y, full: false, tracks: [individualTrack], strictHotPath: strictHotPathActive() },
      [img.data.buffer],
      "INDIVIDUAL TRACKED CROP",
      trace,
      source.sequence,
      [r]
    )) {
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
  fullScanIds.clear();
  fullScanJobs.clear();
  localReacquireIds.clear();
  scanCapturedAt.clear();
  scanOutcomes.clear();
  lastFullScan = 0;
  minimumAcceptedScanId = frameId;
  qrReadTimes.length = 0;
  uniqueQrTimes.length = 0;
  duplicateQrTimes.length = 0;
  usefulFrameTimes.length = 0;
  resetHotPathAudit();
  strictHotPathLockSeen = false;
  lastDistinctArrivalAt = 0;
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
  if (!optimizerAttribution && box && validQuadObject(info == null ? void 0 : info.quad) && info.modules) {
    const priorBenchmarkFrame = activeBenchmarkFrame;
    if (productionTrace) activeBenchmarkFrame = productionTrace;
    const snapshot = gridLattice.accept({
      identity,
      layoutId: header.layoutId,
      slotIndex: header.slotIndex,
      at: info.scanId === void 0 ? decodedAt : (_b = scanCapturedAt.get(info.scanId)) != null ? _b : decodedAt,
      scanId: (_c = info.scanId) != null ? _c : -1,
      box,
      quad: info.quad,
      modules: info.modules
    }, receiverFrameWidth, receiverFrameHeight);
    if (snapshot) {
      decodedRegion = syncGrid(
        snapshot,
        decodedAt,
        header.slotIndex,
        { ...info, crc32: true }
      );
    }
    if (productionTrace) productionTrace.stateAfter = gridLattice.state;
    activeBenchmarkFrame = priorBenchmarkFrame;
  }
  if (decodedRegion) noteSequence(decodedRegion, header.seq, decodedAt);
  if (!decoder) {
    decoder = new TransportDecoder(header.k, header.blockLen, header.payloadId, header.totalLen);
    usefulFrameTimes.length = 0;
    uniqueQrTimes.length = 0;
    duplicateQrTimes.length = 0;
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
  (decoder.framesNew === framesNewBefore ? duplicateQrTimes : uniqueQrTimes).push(receivedAt);
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
  } else if (decoder.isComplete) {
    const payload = decoder.assemble();
    const seconds = (receiverNow() - startTs) / 1e3;
    const ok = fnv1a(payload) === header.payloadId;
    void finish(payload, ok, seconds);
  }
}
function updateProgressEstimate() {
  if (!decoder) return;
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
async function runReceiverBenchmark() {
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
      captureFrame({
        sequence: frame.meta.sequence,
        width: frame.meta.width,
        height: frame.meta.height,
        callbackTimeMs: frame.meta.callbackTimeMs,
        mediaTimeMs: frame.meta.mediaTimeMs,
        presentationTimeMs: frame.meta.presentationTimeMs,
        expectedDisplayTimeMs: frame.meta.expectedDisplayTimeMs,
        image: new ImageData(new Uint8ClampedArray(frame.rgba), frame.meta.width, frame.meta.height)
      });
    }
    await waitForWorkers();
    const savedReference = window.__airgapperBenchmarkReference;
    const savedCorpus = savedReference == null ? void 0 : savedReference.corpus;
    const savedFrames = savedReference == null ? void 0 : savedReference.frames;
    let oracleLatencies = [];
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
    const extraPackets = benchmarkTraces.flatMap((trace) => {
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
      format: "AirGapper receiver benchmark",
      version: (_e = document.querySelector(".app-version")) == null ? void 0 : _e.textContent,
      corpus: corpus.header,
      replay: { mode: replayMode.value, workers: pool.size, device: navigator.userAgent },
      acquisition: { firstReferenceFrame: firstReference < 0 ? null : benchmarkTraces[firstReference].sequence, firstProductionFrame: firstProduction < 0 ? null : benchmarkTraces[firstProduction].sequence, deltaFrames: firstReference < 0 || firstProduction < 0 ? null : firstProduction - firstReference, deltaMs: firstReference < 0 || firstProduction < 0 ? null : benchmarkTraces[firstProduction].timestampMs - benchmarkTraces[firstReference].timestampMs, firstLayoutFrame: firstLayout < 0 ? null : benchmarkTraces[firstLayout].sequence, firstGridLockFrame: firstLock < 0 ? null : benchmarkTraces[firstLock].sequence },
      recovery: { lockLossFrame: lockLoss < 0 ? null : benchmarkTraces[lockLoss].sequence, localRecoveryStartFrame: localRecovery < 0 ? null : benchmarkTraces[localRecovery].sequence, globalReacquisitionStartFrame: globalRecovery < 0 ? null : benchmarkTraces[globalRecovery].sequence, firstRecoveredValidFrame: firstRecovered < 0 ? null : benchmarkTraces[firstRecovered].sequence, fullLockRestoredFrame: restored < 0 ? null : benchmarkTraces[restored].sequence },
      throughput: { durationSeconds, referenceOpportunities: opportunities, productionCaptured: captured, opportunityCapturePercent: opportunities ? captured / opportunities * 100 : 0, lockedReferenceOpportunities: lockedOpportunities, lockedProductionCaptured: lockedCaptured, lockedOpportunityCapturePercent: lockedOpportunities ? lockedCaptured / lockedOpportunities * 100 : 0, extraValidDecodes: extraPackets.length, extraUniqueSymbols, qrPerSecond: productionPackets.length / durationSeconds, uniqueUsefulQrPerSecond: uniqueUseful / durationSeconds, uniqueUsefulVerifiedBytesPerSecond: uniqueUsefulBytes / durationSeconds, verifiedKBPerFrame: benchmarkVerifiedBytes / 1024 / Math.max(1, benchmarkTraces.length), verifiedKBPerSecond: benchmarkVerifiedBytes / 1024 / durationSeconds },
      performance: { frameDropPercent: benchmarkTraces.length ? capturesDropped / benchmarkTraces.length * 100 : 0, workerBusyPercent: benchmarkTraces.length ? benchmarkTraces.reduce((sum, trace) => sum + trace.workerBusyFraction, 0) / benchmarkTraces.length * 100 : 0, pixelsPerSecond: jobs.reduce((sum, job) => sum + job.pixels, 0) / durationSeconds, processedPixelsPerSecond: processedPixels / durationSeconds, bytesRead: jobs.reduce((sum, job) => sum + job.bytes, 0), uniqueUsefulQrPerCpuSecond: uniqueUseful / workerCpuSeconds, uniqueUsefulBytesPerCpuSecond: uniqueUsefulBytes / workerCpuSeconds, uniqueUsefulQrPerMegapixel: uniqueUseful / Math.max(1e-3, processedPixels / 1e6), uniqueUsefulBytesPerMegapixel: uniqueUsefulBytes / Math.max(1e-3, processedPixels / 1e6), decodeP50Ms: percentile(decodeLatencies, 0.5), decodeP95Ms: percentile(decodeLatencies, 0.95), oracleP50Ms: percentile(oracleLatencies, 0.5), workerBusyDrops: capturesDropped, byKind },
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
function updateStats() {
  if (done) return;
  const now = receiverNow();
  if (optimizeEnabled) beginOptimizeWhenReady();
  if (!receiverDevActions.hidden) renderFocusDiagnostics();
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
if (!receiverDevActions.hidden && transportDiagnostics) {
  const transportRate = uniqueRate + duplicateRate;
  const duplicatePercent = transportRate > 0 ? duplicateRate / transportRate * 100 : 0;
  const totals = decoder ? `${decoder.framesNew} unique · ${decoder.framesDup} duplicate · ${decoder.framesRedundant} redundant` : "no active transport";
  const fastPercent = hotPathAudit.nativeTracks ? hotPathAudit.crcFastSuccesses / hotPathAudit.nativeTracks * 100 : 0;
  transportDiagnostics.textContent = `Build ${document.querySelector(".app-version")?.textContent ?? "—"}
Transport
Unique ${uniqueRate.toFixed(1)} QR/s · duplicate ${duplicateRate.toFixed(1)} QR/s (${duplicatePercent.toFixed(0)}%)
Useful ${usefulRate.toFixed(1)} QR/s · ${liveGoodputKbs(now).toFixed(1)} KB/s
${totals}

Hot path ${strictHotPathActive() ? `STRICT · lock ${strictHotPathLockSeen ? "established" : "acquiring"}` : "LIVE"}
Native CRC ${hotPathAudit.crcFastSuccesses}/${hotPathAudit.nativeTracks} (${fastPercent.toFixed(1)}%) · successful ${hotPathAudit.nativeSuccessful} · misses ${hotPathAudit.nativeMisses}
QR-RS ${hotPathAudit.rsFallbacks} · local robust ${hotPathAudit.localRecoverySuccesses}/${hotPathAudit.localRecoveryAttempts} · readFull ${hotPathAudit.readFullAttempts}
Misses   anchor ${hotPathAudit.anchorMisses} · frame ${hotPathAudit.outOfFrameMisses} · bitstream ${hotPathAudit.bitstreamFailures} · CRC ${hotPathAudit.crcFailures}
Sampler HybridBinarizer + SampleGrid · CRC ${hotPathAudit.anchorBypassSuccesses}/${hotPathAudit.anchorBypassAttempts}
Pixel path ${lastDirectPixelPath.toUpperCase()}
Generic full ${hotPathAudit.fullScanSuccesses}/${hotPathAudit.fullScanJobs} · acquisition ${hotPathAudit.acquisitionFullScans} · reacquire ${hotPathAudit.reacquireFullScans}`;
}
  metric("m-cap").textContent = `${decodeFrameRate.toFixed(1)} fps`;
  metric("m-dec").textContent = `${qrRate.toFixed(1)} QR/s`;
  const stalled = cameraStartedTs > 0 && now - cameraStartedTs > STATS_WINDOW_MS && completionRate === 0 && pool.busyCount > 0;
  const limit = metric("m-limit");
  limit.textContent = lastDecodeError ? `Scanner error: ${lastDecodeError}` : stalled ? "Scanner stalled" : "";
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
