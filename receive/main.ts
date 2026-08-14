// Receiver: camera → WASM QR decode in workers → transport decoder → file.
//
// Field lessons baked in:
// - iOS treats `frameRate: {ideal: 60}` as a suggestion and delivers 30.
//   Demand `exact` first (it works at 1280-wide), fall back to `ideal`.
// - requestVideoFrameCallback chains survive a stopped stream and resume on
//   the next one — a generation counter prevents zombie capture loops.
// - Progress must track frames COLLECTED: LT peeling back-loads its solve
//   cascade, so blocks-solved looks stalled and then teleports to done.
// - Android Chrome exposes focusMode / frameRate.max through getCapabilities;
//   iOS Safari exposes neither. shared/platform.ts owns
//   the probing, so everything here is capability-gated rather than UA-gated.

import { TransportDecoder } from "../shared/transport";
import { prepareRaptorQ } from "../shared/raptorq";
import { formatBytes } from "../shared/format";
import {
  completedGoodputKbs,
  estimateTransferProgress,
  expectedCodingOverhead,
  formatDuration,
} from "../shared/progress";
import { createDecodeWorker, usesSimpleDecodeWorker } from "./worker-factory";
import { GridLattice, type GridSnapshot } from "./grid-lattice";
import {
  DecodeWorkerPool,
  type DecodeCompletion,
  type SymbolBox,
  type SymbolInfo,
  type SymbolQuad,
} from "../shared/worker-pool";
import { PlainQrPolicy } from "../shared/plain-qr-policy";
import { isSnippet, snippetText } from "../shared/snippet";
import {
  fnv1a,
  parseFrame,
  streamIdentity,
  unpackFile,
  verifyFile,
} from "../shared/protocol";
import { statusLine } from "../shared/status-line";
import { releaseScreenWakeLock, requestScreenWakeLock } from "../shared/wake-lock";
import { applyAdvancedConstraint, probeCameraCapabilities } from "../shared/platform";
import {
  FocusController,
  CAMERA_TUNING,
  type CameraPatch,
  type FocusGeometry,
  type FocusStrategy,
  type ReceivePerformance,
} from "./focus-controller";
import { StaticQrOpticsAnalyzer, type QrOpticalTarget } from "./qr-optics";
import {
  copyTextOnAndroid,
  isAndroidApp,
  isLegacyAndroidApp,
  saveFileOnAndroid,
  showScanCaptureMenuOnAndroid,
} from "../shared/android";
import { readStoredZip, type ZipEntry } from "../shared/zip";
import { AgcapCorpus, AgcapRecorder, type AgcapHeader } from "./agcap";

const startBtn = document.getElementById("start") as HTMLButtonElement;
const cameraResolution = document.getElementById("camera-resolution") as HTMLSelectElement;
const cameraResolutionLabel = document.getElementById("camera-resolution-label")!;
const decodeWorkers = document.getElementById("decode-workers") as HTMLSelectElement;
const decodeWorkersControl = document.getElementById("decode-workers-control")!;
const cameraActual = document.getElementById("camera-actual")!;
const cameraExposureControl = document.getElementById("camera-exposure-control")!;
const cameraExposureAuto = document.getElementById("camera-exposure-auto") as HTMLInputElement;
const cameraOpticsManual = document.getElementById("camera-optics-manual")!;
const opticsAutoActions = document.getElementById("optics-auto-actions")!;
const exposureAxisAuto = document.getElementById("exposure-axis-auto") as HTMLInputElement;
const isoAxisAuto = document.getElementById("iso-axis-auto") as HTMLInputElement;
const exposureAxisToggle = document.getElementById("exposure-axis-toggle")!;
const isoAxisToggle = document.getElementById("iso-axis-toggle")!;
const exposureAxisReset = document.getElementById("exposure-axis-reset") as HTMLButtonElement;
const isoAxisReset = document.getElementById("iso-axis-reset") as HTMLButtonElement;
const exposureAxisName = document.getElementById("exposure-axis-name")!;
const isoAxisName = document.getElementById("iso-axis-name")!;
const cameraExposure = document.getElementById("camera-exposure") as HTMLInputElement;
const cameraExposureValue = document.getElementById("camera-exposure-value") as HTMLOutputElement;
const captureScanBtn = document.getElementById("capture-scan") as HTMLButtonElement;
const recordCorpusBtn = document.getElementById("record-corpus") as HTMLButtonElement;
const loadCorpusBtn = document.getElementById("load-corpus") as HTMLButtonElement;
const receiverSettings = document.querySelector<HTMLDetailsElement>(".receiver-settings")!;
const receiverDevActions = document.querySelector<HTMLElement>(".receiver-dev-actions")!;
const focusDev = document.getElementById("focus-dev")!;
const focusMode = document.getElementById("focus-mode") as HTMLSelectElement;
const focusAxisName = document.getElementById("focus-axis-name")!;
const focusAxisReset = document.getElementById("focus-axis-reset") as HTMLButtonElement;
const focusRefocus = document.getElementById("focus-refocus") as HTMLButtonElement;
const opticsOptimize = document.getElementById("optics-optimize") as HTMLButtonElement;
const opticsOptimizeStatus = document.getElementById("optics-optimize-status")!;
const focusDistanceControl = document.getElementById("focus-distance-control")!;
const focusDistance = document.getElementById("focus-distance") as HTMLInputElement;
const focusDistanceValue = document.getElementById("focus-distance-value") as HTMLOutputElement;
const cameraIsoControl = document.getElementById("camera-iso-control")!;
const cameraIso = document.getElementById("camera-iso") as HTMLInputElement;
const cameraIsoValue = document.getElementById("camera-iso-value") as HTMLOutputElement;
const focusDiagnostics = document.getElementById("focus-diagnostics")!;
const focusTuningInputs = [...document.querySelectorAll<HTMLInputElement>("[data-camera-tuning]")];
const corpusFile = document.getElementById("corpus-file") as HTMLInputElement;
const benchmarkDialog = document.getElementById("benchmark-dialog") as HTMLDialogElement;
const closeBenchmarkBtn = document.getElementById("close-benchmark") as HTMLButtonElement;
const runBenchmarkBtn = document.getElementById("run-benchmark") as HTMLButtonElement;
const saveBenchmarkBtn = document.getElementById("save-benchmark") as HTMLButtonElement;
const replayMode = document.getElementById("replay-mode") as HTMLSelectElement;
const benchmarkStatus = document.getElementById("benchmark-status")!;
const benchmarkSummary = document.getElementById("benchmark-summary")!;
const benchmarkFrame = document.getElementById("benchmark-frame") as HTMLCanvasElement;
const benchmarkFrameStatus = document.getElementById("benchmark-frame-status")!;
const scanDialog = document.getElementById("scan-dialog") as HTMLDialogElement;
const closeScanBtn = document.getElementById("close-scan") as HTMLButtonElement;
const scanDialogStatus = document.getElementById("scan-dialog-status")!;
const scanSightingLegend = document.getElementById("scan-sighting-legend")!;
const scanCapture = document.getElementById("scan-capture") as HTMLCanvasElement;
const video = document.getElementById("video") as HTMLVideoElement;
const preview = document.getElementById("preview")!;
const cameraBox = document.querySelector<HTMLDivElement>(".preview")!;
const overlay = document.getElementById("detect-overlay") as HTMLCanvasElement;
const stats = document.getElementById("stats")!;
const progressEl = document.getElementById("progress")!;
const bar = document.getElementById("bar")!;
const progressStatus = document.getElementById("progress-status")!;
const progressLabel = document.getElementById("progress-label")!;
const transferSizeLabel = document.getElementById("transfer-size-label")!;
const etaLabel = document.getElementById("eta-label")!;
const result = document.getElementById("result")!;
const metricsEl = document.getElementById("metrics")!;
metricsEl.addEventListener("click", (event) => {
  const target = event.target as Element;
  if (target.closest("summary") || target.closest(".receiver-settings .row")) return;
  receiverSettings.open = !receiverSettings.open;
});
const speedFeedback = document.getElementById("speed-feedback")!;
const pipelineMetrics = document.getElementById("pipeline-metrics")!;
const diagnosticsEl: HTMLDetailsElement | null = null;
const legacyAndroidApp = isLegacyAndroidApp();
document.body.classList.toggle("legacy-android-camera", legacyAndroidApp);
const hardwareThreadCount = Math.max(1, navigator.hardwareConcurrency || 2);
// A 32-bit WebView shares its limited renderer address space with the live
// camera. Starting multiple WASM decoders as that surface is allocated can
// kill the process on older phones; modern 64-bit devices keep the fast pool.
const autoWorkerCount = legacyAndroidApp
  ? 1
  : Math.max(1, Math.min(4, hardwareThreadCount - 2));
const autoWorkerOption = decodeWorkers.querySelector<HTMLOptionElement>('option[value="auto"]')!;
autoWorkerOption.textContent = `Auto (${autoWorkerCount})`;
for (let count = 1; count <= hardwareThreadCount; count++) {
  decodeWorkers.add(new Option(String(count), String(count)));
}
function selectedWorkerCount(): number {
  if (legacyAndroidApp) return 1;
  return decodeWorkers.value === "auto"
    ? autoWorkerCount
    : Math.max(1, Math.min(hardwareThreadCount, Number(decodeWorkers.value) || autoWorkerCount));
}
// Camera maximum resolution is not maximum optical throughput: a 4K video
// frame is 9× the pixels of 1280×960, and the synchronous canvas readback can
// collapse an older phone to ~2 fps. 1280 keeps V40 modules comfortably large
// while leaving enough CPU budget for capture and decode.
const CAMERA_SETTINGS_KEY = "airgapper:camera-settings:v8";
const BROWSER_MODE_RESULTS_KEY = "airgapper:browser-camera-modes:v1";
const STANDARD_RESOLUTIONS = [
  [640, 480], [960, 720], [1280, 720], [1280, 960], [1920, 1080], [2560, 1440], [3840, 2160],
] as const;
let requestedWidth = 1280;
let requestedHeight = 720;
let requestedFps = 60;
let automaticOptics = true;
let automaticExposureAxis = true;
let automaticIsoAxis = true;
let preferredExposureTime: number | undefined;
let manualFocusMode: Exclude<FocusStrategy, "auto"> = "continuous";
let preferredFocusDistance: number | undefined;
let preferredIso: number | undefined;
let exposureApplyGeneration = 0;
let cameraMutationQueue = Promise.resolve();
let desiredCamera: CameraPatch = {};
let lastCameraMutation: { kind: string; before: CameraPatch; requested: CameraPatch; after: CameraPatch } | undefined;

function mutateCamera(track: MediaStreamTrack, mutation: () => Promise<void>): Promise<void> {
  const operation = cameraMutationQueue.catch(() => undefined).then(async () => {
    if (track.readyState === "live" && stream?.getVideoTracks()[0] === track) await mutation();
  });
  cameraMutationQueue = operation.catch(() => undefined);
  return operation;
}
function seedDesiredCamera(track: MediaStreamTrack): void {
  const settings = track.getSettings() as MediaTrackSettings & CameraPatch;
  desiredCamera = {
    focusMode: settings.focusMode,
    focusDistance: settings.focusDistance,
    exposureMode: settings.exposureMode,
    exposureTime: settings.exposureTime,
    iso: settings.iso,
  };
}
function applyCameraConstraint(track: MediaStreamTrack, patch: CameraPatch): Promise<boolean> {
  let accepted = false;
  const enteringManualFocus = patch.focusMode === "manual" && desiredCamera.focusMode !== "manual";
  const enteringManualExposure = patch.exposureMode === "manual" && desiredCamera.exposureMode !== "manual";
  if (patch.exposureMode === "continuous") {
    delete desiredCamera.exposureTime;
    if (patch.iso === undefined) delete desiredCamera.iso;
  }
  Object.assign(desiredCamera, patch);
  return mutateCamera(track, async () => {
    const before = track.getSettings() as MediaTrackSettings & CameraPatch;
    // Build at execution time, not enqueue time. If a newer generation or a
    // developer override superseded this queued operation, it therefore
    // applies the newest desired state instead of stale probe values.
    const effectiveCamera = (includeFocusDistance = true, includeExposureValues = true): CameraPatch => {
      const effective: CameraPatch = { ...desiredCamera };
      if (effective.focusMode !== "manual" || !includeFocusDistance) delete effective.focusDistance;
      if (effective.exposureMode !== "manual") delete effective.exposureTime;
      if (!includeExposureValues) {
        delete effective.exposureTime;
        delete effective.iso;
      }
      if (effective.exposureMode === "manual") delete effective.pointsOfInterest;
      return effective;
    };
    // Android camera providers often require each mode transition before its
    // numeric value. These mode-only sets still carry the unrelated desired
    // camera state, so neither focus nor exposure can reset the other.
    if (enteringManualFocus && desiredCamera.focusMode === "manual") {
      await applyAdvancedConstraint(track, effectiveCamera(false, !enteringManualExposure));
    }
    if (enteringManualExposure && desiredCamera.exposureMode === "manual") {
      await applyAdvancedConstraint(track, effectiveCamera(true, false));
    }
    accepted = await applyAdvancedConstraint(track, effectiveCamera());
    // Reading settings here is intentional: many Android providers quantize or
    // silently reject one member of an otherwise accepted advanced set.
    const after = track.getSettings() as MediaTrackSettings & CameraPatch;
    const kind = patch.focusMode !== undefined || patch.focusDistance !== undefined
      ? (patch.exposureMode !== undefined || patch.exposureTime !== undefined || patch.iso !== undefined ? "focus + exposure" : "focus")
      : patch.iso !== undefined && patch.exposureTime === undefined ? "ISO" : "exposure";
    const optics = (value: MediaTrackSettings & CameraPatch): CameraPatch => ({
      focusMode: value.focusMode, focusDistance: value.focusDistance,
      exposureMode: value.exposureMode, exposureTime: value.exposureTime, iso: value.iso,
    });
    lastCameraMutation = { kind, before: optics(before), requested: effectiveCamera(), after: optics(after) };
  }).then(() => accepted);
}
let exposureApplyTimer: ReturnType<typeof setTimeout> | undefined;
interface BrowserMode { key: string; width: number; height: number; fps: number; label: string }
function formatCameraSize(width: number, height: number): string {
  return `${Math.max(width, height)}×${Math.min(width, height)}`;
}
function formatCameraMode(width: number, height: number, fps: number): string {
  return `${formatCameraSize(width, height)} · ${fps} fps`;
}
const browserModeResults = loadBrowserModeResults();
let browserModes: BrowserMode[] = [];
let automaticBrowserMode: BrowserMode | undefined;

function loadBrowserModeResults(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(BROWSER_MODE_RESULTS_KEY) ?? "{}") as Record<string, boolean>; }
  catch { return {}; }
}
function saveBrowserModeResult(key: string, supported: boolean): void {
  browserModeResults[key] = supported;
  try { localStorage.setItem(BROWSER_MODE_RESULTS_KEY, JSON.stringify(browserModeResults)); }
  catch { /* Validation still applies for this session. */ }
}

function standardBrowserModes(): BrowserMode[] {
  return STANDARD_RESOLUTIONS.flatMap(([width, height]) => [30, 60].map((fps) => ({
    key: `${width}x${height}@${fps}`, width, height, fps, label: formatCameraMode(width, height, fps),
  }))).sort((a, b) => a.width - b.width || a.height - b.height || a.fps - b.fps);
}
function populateCameraOptions(): void {
  browserModes = standardBrowserModes().filter((mode) => browserModeResults[mode.key] !== false);
  cameraResolution.replaceChildren(
    new Option("Auto", "auto"),
    ...browserModes.map((mode) => new Option(
      `${mode.label}${browserModeResults[mode.key] === true ? "" : " · Try"}`, mode.key,
    )),
  );
  cameraResolution.value = "auto";
}
function restoreCameraSettings(): void {
  try {
    const saved = JSON.parse(localStorage.getItem(CAMERA_SETTINGS_KEY) ?? "null") as {
      resolution?: string; automaticOptics?: boolean;
      automaticExposureAxis?: boolean; automaticIsoAxis?: boolean; exposureTime?: number; workers?: string;
      manualFocusMode?: Exclude<FocusStrategy, "auto">; focusDistance?: number; iso?: number;
    } | null;
    if (!saved) return;
    if (saved.resolution && [...cameraResolution.options].some((option) => option.value === saved.resolution)) {
      cameraResolution.value = saved.resolution;
    }
    if (typeof saved.automaticOptics === "boolean") automaticOptics = saved.automaticOptics;
    if (typeof saved.automaticExposureAxis === "boolean") automaticExposureAxis = saved.automaticExposureAxis;
    if (typeof saved.automaticIsoAxis === "boolean") automaticIsoAxis = saved.automaticIsoAxis;
    if (typeof saved.exposureTime === "number" && Number.isFinite(saved.exposureTime)) preferredExposureTime = saved.exposureTime;
    if (saved.workers && [...decodeWorkers.options].some((option) => option.value === saved.workers)) decodeWorkers.value = saved.workers;
    if (["continuous", "single-shot", "manual"].includes(saved.manualFocusMode ?? "")) manualFocusMode = saved.manualFocusMode!;
    if (typeof saved.focusDistance === "number" && Number.isFinite(saved.focusDistance)) preferredFocusDistance = saved.focusDistance;
    if (typeof saved.iso === "number" && Number.isFinite(saved.iso)) preferredIso = saved.iso;
  } catch { /* Defaults remain usable with blocked or corrupt storage. */ }
}
function saveCameraSettings(): void {
  try {
    localStorage.setItem(CAMERA_SETTINGS_KEY, JSON.stringify({
      resolution: cameraResolution.value,
      automaticOptics,
      automaticExposureAxis,
      automaticIsoAxis,
      exposureTime: preferredExposureTime,
      workers: decodeWorkers.value,
      manualFocusMode,
      focusDistance: preferredFocusDistance,
      iso: preferredIso,
    }));
  } catch { /* Storage is optional. */ }
}
function readRequestedCameraSettings(): void {
  const browserMode = browserModes.find((mode) => mode.key === cameraResolution.value);
  if (!browserMode) return;
  requestedWidth = browserMode.width;
  requestedHeight = browserMode.height;
  requestedFps = browserMode.fps;
}
function showRequestedCameraSettings(): void {
  readRequestedCameraSettings();
  cameraActual.textContent = cameraResolution.value === "auto"
    ? "Auto" : formatCameraMode(requestedWidth, requestedHeight, requestedFps);
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
  automaticOptics ? "auto" : manualFocusMode,
  preferredFocusDistance,
  "auto",
  () => frameId,
);
const opticsAnalyzer = new StaticQrOpticsAnalyzer();
function attachCameraController(track: MediaStreamTrack): void {
  focusController.attach(track);
  if (!automaticOptics) {
    focusController.setStrategy(manualFocusMode);
    void applyExposureSetting(track);
  }
}
focusMode.value = manualFocusMode;

// Keep developer controls out of the normal settings UI. Show, hide, then show
// Settings within half a second to reveal them. A slower close/reopen hides them.
const DEV_SETTINGS_TOGGLE_WINDOW_MS = 500;
const settingsToggleTimes: number[] = [];
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
  while (settingsToggleTimes.length && settingsToggleTimes[0]! < now - DEV_SETTINGS_TOGGLE_WINDOW_MS) settingsToggleTimes.shift();
  if (receiverSettings.open && settingsToggleTimes.length >= 3) receiverDevActions.hidden = false;
});
const metric = (id: string) => document.getElementById(id)!;

let replayClock: number | undefined;
function receiverNow(): number { return replayClock ?? performance.now(); }

type BenchmarkJobKind = "FULL FRAME" | "SHARED TRACKED BATCH CROP" | "INDIVIDUAL TRACKED CROP";
interface BenchmarkJob {
  id: number; kind: BenchmarkJobKind; pixels: number; bytes: number; width: number; height: number; x: number; y: number;
  tracks: number[]; submittedAt: number; workerWaitMs?: number; decodeMs?: number; symbols?: number;
  trackedHits?: number; trackedMisses?: number; readFullAttempts?: number; fallbackAttempts?: number; fallbackSuccesses?: number;
  targetedAttempts?: number; targetedPixels?: number; targetedSuccesses?: number;
}
interface BenchmarkFrameTrace {
  sequence: number; timestampMs: number; stateBefore: string; stateAfter: string; decision: string; workerBusyFraction: number;
  jobs: BenchmarkJob[]; decoded: { slot?: number; esi: number; bytes: number; quad?: SymbolQuad }[]; sightings: SymbolBox[];
  reference: { slot?: number; esi: number; quad?: SymbolQuad }[];
  predicted: { slot: number; state?: string; quad?: SymbolQuad; submitted: boolean }[];
  transitions: { from: string; to: string; reason: string; at: number }[];
}
let activeBenchmarkFrame: BenchmarkFrameTrace | undefined;
let benchmarkCorpus: AgcapCorpus | undefined;
let benchmarkPendingBlob: Blob | undefined;
let benchmarkRecorder: AgcapRecorder | undefined;
let benchmarkRecordingSequence = 0;
let benchmarkTraces: BenchmarkFrameTrace[] = [];
const benchmarkJobFrames = new Map<number, BenchmarkFrameTrace>();
let benchmarkResult: Record<string, unknown> | undefined;
let benchmarkVerifiedBytes = 0;
let benchmarkCompletionChecked = false;
let replayRunning = false;
let receiverFrameWidth = 0;
let receiverFrameHeight = 0;

function noteGridTransition(from: string, to: string, reason: string, at: number): void {
  const trace = activeBenchmarkFrame ?? benchmarkTraces.at(-1);
  trace?.transitions.push({ from, to, reason, at });
}

// Every live receiver rate uses the same one-second rolling window.
const STATS_WINDOW_MS = 1000;
const STATS_TICK_MS = 250;

let stream: MediaStream | null = null;
let decoder: TransportDecoder | null = null;
function releaseTransportDecoder(): void {
  decoder?.free();
  decoder = null;
}
let streamKey = "";
let reportStreamId = 0; // pairs this run with the sender's diagnostics post
let startTs = 0;
let captureGen = 0;
let cameraStartGen = 0;
let receiverPaused = false;
let pauseStartedAt = 0;
let done = false;
let statsTimer: ReturnType<typeof setInterval> | undefined;
const plainQrDecoder = new TextDecoder("utf-8", { fatal: true });
const plainQrPolicy = new PlainQrPolicy();
const RECEIVED_MEDIA_CACHE = "received-media";
const receivedObjectUrls = new Set<string>();
let receivedDataGeneration = 0;

function receivedObjectUrl(blob: Blob): string {
  const url = URL.createObjectURL(blob);
  receivedObjectUrls.add(url);
  return url;
}

function purgeReceivedData(): void {
  receivedDataGeneration++;
  for (const url of receivedObjectUrls) URL.revokeObjectURL(url);
  receivedObjectUrls.clear();
  if ("caches" in window) void caches.delete(RECEIVED_MEDIA_CACHE).catch(() => undefined);
}

// Remove anything a previous page session could not clean up (for example if
// the browser killed it while received media was still open).
purgeReceivedData();

const pool = new DecodeWorkerPool(
  createDecodeWorker,
  (bytes, box, info) => onDecoded(bytes, box, info),
  // A sighting is a detected-but-undecoded code: no bytes, but a position.
  // Heavily gated in noteRegion (refresh-only on matches, size-checked on
  // creation) because failed quads are often junk — but a plausible one lets
  // the crop path go decode what the full frame could not.
  (sighting) => {
    // Detector errors may seed one cold native crop, but only a decoded,
    // protocol-valid packet is allowed to move an established lattice.
    if (!gridLattice.active) noteRegion(sighting, receiverNow(), false);
  },
  () => undefined,
  (id, completion) => noteDecodeCompleted(id, completion),
);
const captureTimes: number[] = [];
// Every successfully decoded QR, including duplicate or redundant sender
// symbols. This is scanner throughput; useful transfer speed is shown as KB/s.
const qrReadTimes: number[] = [];
const poolBusyTimes: number[] = [];
// Decoder jobs that actually finished searching a submitted frame or crop,
// regardless of whether they found a QR code.
const scanCompletionTimes: number[] = [];
// Timestamps of frames that contributed new transport information. Unlike the
// transfer-wide average, this window drops immediately when optical lock is
// lost, so the speed display works as aiming feedback.
const usefulFrameTimes: number[] = [];

// Run-level totals for the diagnostics report (npm run diagnostics). The
// The live timestamp windows above are pruned for the UI rates and cannot
// answer "how much, in total, did this run do".
let totalCaptures = 0;
let totalDecodes = 0;
let totalUsefulSymbols = 0;
let fullScans = 0;
let cheapFullScans = 0;
let thoroughFullScans = 0;
let localReacquisitions = 0;
let globalReacquisitions = 0;
let peakRegions = 0;
let capturesDropped = 0; // pool full — frame never even submitted
let cropsSubmitted = 0;

type CandidateEvidence = {
  boundary: number;
  startedAt: number;
  captures: number;
  completedJobs: number;
  qrAttempts: number;
  validDecodes: number;
  usefulSymbols: number;
};
let candidateEvidence: CandidateEvidence | undefined;

function recentCompletionIntervalMs(now: number): number {
  const recent = scanCompletionTimes.filter((at) => at > now - 6000);
  const gaps = recent.slice(1).map((at, index) => at - recent[index]!).filter((gap) => gap > 0).sort((a, b) => a - b);
  return gaps.length ? gaps[gaps.length >> 1]! : 350;
}

async function measureReceivePerformance(label: string): Promise<ReceivePerformance> {
  const startedAt = receiverNow();
  const evidence: CandidateEvidence = {
    boundary: frameId,
    startedAt,
    captures: totalCaptures,
    completedJobs: 0,
    qrAttempts: 0,
    validDecodes: 0,
    usefulSymbols: 0,
  };
  candidateEvidence = evidence;
  const targetAttempts = 8;
  const minCompletions = 4;
  const minMs = 700;
  const maxMs = Math.max(2200, Math.min(4200, recentCompletionIntervalMs(startedAt) * targetAttempts * 1.35));
  try {
    for (;;) {
      const elapsed = receiverNow() - startedAt;
      opticsOptimizeStatus.textContent = `Optimize: ${label} · collecting ${Math.min(targetAttempts, evidence.qrAttempts)}/${targetAttempts} attempts`;
      const enoughEvidence = evidence.completedJobs >= minCompletions && evidence.qrAttempts >= targetAttempts;
      if (elapsed >= minMs && enoughEvidence && (evidence.validDecodes > 0 || evidence.qrAttempts >= targetAttempts)) break;
      if (elapsed >= maxMs) break;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  } finally {
    if (candidateEvidence === evidence) candidateEvidence = undefined;
  }
  const seconds = Math.max(0.001, (receiverNow() - startedAt) / 1000);
  const validDecodesPerSecond = evidence.validDecodes / seconds;
  const priorBest = focusController.diagnostics().optimizeBestPerformance;
  opticsOptimizeStatus.textContent = `Optimize: ${label} · ${validDecodesPerSecond.toFixed(1)} valid QR/s${priorBest ? ` · best ${priorBest.validDecodesPerSecond.toFixed(1)}` : ""}`;
  return {
    validDecodesPerSecond,
    usefulSymbolsPerSecond: evidence.usefulSymbols / seconds,
    perQrAttemptSuccessRate: evidence.qrAttempts ? evidence.validDecodes / evidence.qrAttempts : 0,
    captureFps: (totalCaptures - evidence.captures) / seconds,
    completedJobs: evidence.completedJobs,
    qrAttempts: evidence.qrAttempts,
    validDecodes: evidence.validDecodes,
  };
}

opticsOptimize.addEventListener("click", () => {
  const diagnostic = focusController.diagnostics();
  const state = diagnostic.optimizeState;
  if (state === "baseline" || state === "focus" || state === "exposure" || state === "iso") {
    focusController.cancelOptimize("Optimize cancelled");
    opticsOptimizeStatus.textContent = "Optimize cancelled · best restored";
    return;
  }
  if (!automaticOptics) {
    opticsOptimizeStatus.textContent = "Optimize: enable Auto";
    return;
  }
  if (diagnostic.state !== "LOCKED") {
    opticsOptimizeStatus.textContent = "Optimize: waiting for lock";
    return;
  }
  if (!diagnostic.geometryStable) {
    opticsOptimizeStatus.textContent = "Optimize: waiting for stable target";
    return;
  }
  opticsOptimize.textContent = "Cancel";
  opticsOptimizeStatus.textContent = "Optimize: starting";
  void focusController.optimize(measureReceivePerformance).then(() => {
    const finished = focusController.diagnostics();
    if (finished.optimizeState === "cancelled") return;
    opticsOptimizeStatus.textContent = finished.optimizeSummary ? `Optimize complete · ${finished.optimizeSummary}` : "Optimize complete";
  }).finally(() => { opticsOptimize.textContent = "Optimize"; });
});
let trackedDecodes = 0; // decodes via the fork's detection-skipping fast path
let trackedAttempts = 0; // crops that TRIED the fast path — hits/attempts is
// the fork's real hit rate; zero attempts means the quad/dim plumbing broke
let cameraStartedTs = 0; // acquisition latency = first decode − camera start
let zeroRegionMs = 0; // transfer time spent with tracking fully collapsed
let degradedMs = 0; // transfer time spent below the expected code count
// One sample per stats tick (250 ms): elapsed s, framesNew, solved blocks,
// live regions, capture fps, decode fps. The shape of a bad run — where it
// stalled, when tracking collapsed — is invisible in run totals.
const timeline: number[][] = [];
const TIMELINE_MAX_SAMPLES = 2400; // 10 min — past that the tail tells nothing new

// Per-code crop tracking. The scene is static (both devices propped), so once
// a code has been seen its next frames are decoded from a padded crop around
// its last position: one code per crop means no finder-pattern confusion
// between neighbors, far fewer pixels per decode, and the crops parallelize
// across the worker pool. A periodic full-frame scan (re)acquires anything
// the crops lose — nothing here can get permanently stuck.
interface Region extends SymbolBox {
  id: number;
  seen: number;
  /** True once bytes have actually decoded here. Sighting-only regions are
   *  probationary: they get crops, but they are not drawn, not counted
   *  toward the expected code total, and evicted first. */
  decoded: boolean;
  /** Last successful byte decode. Detector sightings are tracked separately:
   * they may draw feedback, but cannot make a stale decode-proven region live. */
  decodedSeen?: number;
  sightedSeen?: number;
  /** Distinct sender symbols seen recently. Keeping the sequence itself makes
   * late worker replies harmless: an older frame can fill a gap instead of
   * being discarded merely because a newer worker finished first. */
  sequenceSamples: { seq: number; at: number }[];
  qualityLevel: number;
  /** How far the code moved between its last two decodes, in capture px —
   *  a handheld receiver's crops must lead the target, not chase it. */
  drift?: number;
  /** Corner quad + module count of the last decode here — the tracked fast
   *  path in the worker rebuilds its sampling transform from these and skips
   *  detection entirely. Only ever set from real decodes. */
  quad?: SymbolQuad;
  dim?: number;
  crc32?: boolean;
  consecutiveMisses: number;
  /** Lattice slots exist independently of whether their QR has decoded. */
  gridSlot?: number;
  detectionConfidence: number;
  decodeConfidence: number;
  globalGridConfidence: number;
  slotState?: "ACTIVE" | "PARTIAL" | "OFFSCREEN" | "LOW_QUALITY" | "LOST";
  visibleFraction: number;
  pixelsPerModule: number;
  decodeAttempts: number;
  decodeSuccesses: number;
  averageDecodeCostMs: number;
  /** Highest submission id that successfully decoded this slot. Used instead
   *  of quad object identity because a lattice refresh replaces every quad. */
  lastHitScanId?: number;
  lastAttemptAt?: number;
}
const regions: Region[] = [];
const gridLattice = new GridLattice(noteGridTransition);
let gridShape = "";
let lastGridSnapshot: GridSnapshot | undefined;
let activeDecodeBudget = 0;
let nextRegionId = 1;
// Retain one trustworthy size after active regions expire. During a bad
// camera/display phase, full acquisition may detect a QR but fail its bytes;
// this yardstick lets that sighting seed a crop instead of leaving the receiver
// stuck with no regions and throwing the useful position away.
let lastDecodedRegionSize = 0;
// Crop replies retain the exact anchor they attempted, so a miss can
// invalidate stale tracked geometry without clobbering a newer worker's hit.
type CropAttempt = { region: Region; quad?: SymbolQuad };
const cropAttempts = new Map<number, CropAttempt[]>();
const scanCapturedAt = new Map<number, number>();
const localReacquireIds = new Set<number>();

type ScanOutcome = { rejected: number; stale: number; otherStream: number; duplicate: number; redundant: number; accepted: number };
const scanOutcomes = new Map<number, ScanOutcome>();
function noteScanOutcome(scanId: number | undefined, kind: keyof ScanOutcome): void {
  if (scanId === undefined) return;
  const outcome = scanOutcomes.get(scanId) ?? { rejected: 0, stale: 0, otherStream: 0, duplicate: 0, redundant: 0, accepted: 0 };
  outcome[kind]++;
  scanOutcomes.set(scanId, outcome);
}
function regionInflightCount(region: Region): number {
  let count = 0;
  for (const attempts of cropAttempts.values()) {
    if (attempts.some((attempt) => attempt.region === region)) count++;
  }
  return count;
}

// Bounded pipeline evidence for diagnostics builds. These distinguish an idle
// scheduler from decoder misses without turning every camera frame into a log.
let schedulerNoJobs = 0;
let cropMisses = 0;
let fullDetectorMisses = 0;
let fullSightings = 0;
let trackedMissFallbacks = 0;
let decodeExceptions = 0;
let lastDecodeError = "";
let regionExpiries = 0;
let regionCreations = 0;
let trackingInvalidations = 0;
let submittedJobs = 0;
let completedJobs = 0;
let workerLatencyTotalMs = 0;
let workerLatencyMaxMs = 0;
let fullLatencyTotalMs = 0;
let fullLatencyCount = 0;
let lastFullLatencyMs = 0;
let lastDistinctArrivalAt = 0;
// Any valid packet refreshes this, including a duplicate. It gates deliberate
// sender/layout handover without letting stale pipelined replies steal a live
// transfer back.
let lastStreamDecodeAt = 0;
let maxSequenceGapMs = 0;
const pipelineEvents: [number, string, number][] = [];
const PIPELINE_EVENT_LIMIT = 80;

function notePipelineEvent(kind: string, value = 0): void {
  if (pipelineEvents.length >= PIPELINE_EVENT_LIMIT) return;
  pipelineEvents.push([
    Number(((receiverNow() - cameraStartedTs) / 1000).toFixed(2)),
    kind,
    value,
  ]);
}

const QUALITY_WINDOW_MS = 3000;

function pruneSequenceSamples(region: Region, now: number): void {
  while (region.sequenceSamples.length && region.sequenceSamples[0]!.at < now - QUALITY_WINDOW_MS) {
    region.sequenceSamples.shift();
  }
}

function noteSequence(region: Region, seq: number, now: number): void {
  pruneSequenceSamples(region, now);
  // Camera frames are pipelined through several workers and can complete out of
  // order. Retain every distinct sequence in the window so a late completion
  // fills the gap that it actually fills. Re-reading one displayed symbol is
  // neutral: it proves the image still decodes, but not that another sender
  // frame was caught.
  if (!region.sequenceSamples.some((sample) => sample.seq === seq)) {
    region.sequenceSamples.push({ seq, at: now });
    region.sequenceSamples.sort((a, b) => a.at - b.at);
  }
}

function noteDecodeCompleted(id: number, completion: DecodeCompletion): void {
  const benchmarkTrace = benchmarkJobFrames.get(id);
  const benchmarkJob = benchmarkTrace?.jobs.find((job) => job.id === id);
  if (benchmarkJob) {
    benchmarkTrace!.sightings.push(...completion.sightings);
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
  }
  benchmarkJobFrames.delete(id);
  const fullJob = fullScanJobs.get(id);
  fullScanIds.delete(id);
  fullScanJobs.delete(id);
  localReacquireIds.delete(id);
  scanCapturedAt.delete(id);
  scanCompletionTimes.push(receiverNow());
  completedJobs++;
  focusController.noteDecoderCompletion(id);
  const evidence = candidateEvidence;
  if (evidence && id >= evidence.boundary) {
    evidence.completedJobs++;
    evidence.qrAttempts += Math.max(1, completion.symbolCount, completion.targetedAttempts + completion.readFullAttempts + Number(completion.fallbackAttempted));
  }
  workerLatencyTotalMs += completion.latencyMs;
  workerLatencyMaxMs = Math.max(workerLatencyMaxMs, completion.latencyMs);
  if (fullJob) {
    lastFullLatencyMs = completion.latencyMs;
    fullLatencyTotalMs += completion.latencyMs;
    fullLatencyCount++;
  }
  if (completion.error) {
    decodeExceptions++;
    lastDecodeError = completion.error;
    notePipelineEvent("decode-exception", decodeExceptions);
  } else if (completion.symbolCount > 0) {
    lastDecodeError = "";
  }
  // A decoder miss is channel evidence only. Static QR optics and geometry,
  // sampled independently on fresh camera frames, own camera reacquisition.
  if (completion.full) {
    fullSightings += completion.sightingCount;
    if (completion.symbolCount === 0 && completion.sightingCount === 0) fullDetectorMisses++;
  } else if (completion.symbolCount === 0) {
    cropMisses++;
  }
  if (completion.trackedAttempted && !completion.trackedHit && completion.fallbackAttempted) {
    trackedMissFallbacks++;
  }

  finishScanCapture(id, completion);
  scanOutcomes.delete(id);
  const attempts = cropAttempts.get(id);
  cropAttempts.delete(id);
  if (!attempts) return;
  if (completion.trackedAttempted) trackedAttempts += attempts.length;
  // Attribute misses per slot. In a multi-track reply, one successful QR must
  // not hide every missing neighbor or move/contract their independent ROIs.
  for (const attempt of attempts) {
    const region = attempt.region;
    region.decodeAttempts++;
    region.lastAttemptAt = receiverNow();
    region.averageDecodeCostMs = region.averageDecodeCostMs
      ? region.averageDecodeCostMs * 0.8 + completion.latencyMs * 0.2
      : completion.latencyMs;
    const hit = completion.symbols.some((symbol) => symbol.box && regionAt(symbol.box) === region);
    region.decodeConfidence = region.decodeConfidence * 0.82 + Number(hit) * 0.18;
    // onDecoded() runs before this completion and may rebuild every lattice
    // quad. Scan ids, unlike object identity, distinguish a genuine newer hit
    // from that routine geometry refresh, so missing slots actually age into
    // expanded-crop and reacquisition states.
    if (!hit && (region.lastHitScanId ?? -1) <= id) {
      region.consecutiveMisses++;
      if (region.consecutiveMisses >= 3) region.decoded = false;
    }
  }
}

// Tried and reverted: a longer TTL for regions with a decode track record
// (6 s after 5 hits). It measured WORSE — a stale region squats on crop
// slots at a dead position, and by keeping regions.length looking healthy it
// suppresses the degraded rescan cadence exactly when reacquisition is
// needed. Expiring fast and rescanning hard wins.
const REGION_TTL_MS = 5000;
// A probationary detector sighting has no decodedSeen timestamp; keeping it
// through several cold full scans gives its cheap crop path time to recover.
const SIGHTING_REGION_TTL_MS = 3000;
// Tracking only revisits known positions, so it cannot discover a larger grid.
// Keep acquisition sparse enough not to disrupt preview, but frequent enough
// that one early decode cannot masquerade as the complete layout.
const FULL_SCAN_INTERVAL_MS = 1500;
// With no lock at all the receiver used to full-scan EVERY capture — sixty
// 1.2 MP tryHarder decodes per second for the whole aiming phase, the app's
// hottest loop (fullScans regularly passed 100 before the first timeline
// sample). Ten per second keeps acquisition feeling instant — ≤100 ms added
// to first lock — and cuts the aiming burn ~85%.
const ACQUISITION_SCAN_MS = 100;
const FULL_SCAN_DEGRADED_MS = 250;
// The high-water mark ages out: a sender restarted with a smaller layout
// would otherwise keep this receiver rescanning for codes that no longer
// exist until the transfer ends.
const EXPECTED_REGIONS_DECAY_MS = 10_000;
// Keep one tracked region for every cell in the densest 3×5 layout.
const MAX_REGIONS = 15;
const REGION_PAD = 0.35;
let cropRotate = 0;
let lastFullScan = 0;
// Full detector jobs are tracked separately from cheap crop work. Only one may
// run at once so detector work cannot contend with camera delivery and crops.
const fullScanIds = new Set<number>();
const fullScanJobs = new Map<number, { thorough: boolean; native: boolean; reacquire: boolean }>();
let currentScanningState: ScanningState = "SEARCH";
let expectedRegions = 0;
let expectedRegionsAt = 0;

function decodedCount(): number {
  let n = 0;
  for (const r of regions) if (r.decoded) n++;
  return n;
}

function regionAt(box: SymbolBox): Region | undefined {
  return regions.find((r) => {
    const dx = Math.abs(box.x + box.w / 2 - (r.x + r.w / 2));
    const dy = Math.abs(box.y + box.h / 2 - (r.y + r.h / 2));
    return dx < Math.max(box.w, r.w) / 2 && dy < Math.max(box.h, r.h) / 2;
  });
}

function noteRegion(box: SymbolBox, now: number, decoded = true, info?: SymbolInfo): void {
  for (const r of regions) {
    const dx = Math.abs(box.x + box.w / 2 - (r.x + r.w / 2));
    const dy = Math.abs(box.y + box.h / 2 - (r.y + r.h / 2));
    if (dx < Math.max(box.w, r.w) / 2 && dy < Math.max(box.h, r.h) / 2) {
      if (!decoded) {
        // A sighting is an eyewitness report, not a successful track. It may
        // keep a probationary crop alive, but must not keep a decode-proven
        // region counted as healthy forever. Otherwise repeated error results
        // suppress cold full-frame reacquisition during the exact stall they
        // are reporting.
        r.sightedSeen = now;
        if (!r.decoded) r.seen = now;
        return;
      }
      // Half-life blend of per-decode displacement: steady hands decay it to
      // zero, a moving hand keeps the crop padding wide (see captureFrame).
      r.drift = 0.5 * (r.drift ?? 0) + 0.5 * Math.hypot(dx, dy);
      const geometryIsFresh = info?.scanId === undefined || info.scanId >= (r.lastHitScanId ?? -1);
      if (geometryIsFresh) Object.assign(r, box);
      r.seen = now;
      r.decoded = true;
      r.decodedSeen = now;
      r.sightedSeen = now;
      lastDecodedRegionSize = Math.max(box.w, box.h);
      if (geometryIsFresh && info?.quad) r.quad = info.quad;
      if (geometryIsFresh && info?.modules) r.dim = info.modules;
      if (geometryIsFresh && info?.crc32 !== undefined) r.crc32 = info.crc32;
      r.consecutiveMisses = 0;
      if (geometryIsFresh && info?.scanId !== undefined) r.lastHitScanId = info.scanId;
      return;
    }
  }
  if (!decoded) {
    // A sighting may only FOUND a region when it looks like the codes this
    // stream already decodes: grid codes are same-version and same-size on
    // screen, so a quad far off a decode-proven code's size is detector
    // noise. With nothing decoded yet there is no yardstick — full scans own
    // acquisition then, and phantom regions would only starve them.
    const reference = regions.find((r) => r.decoded);
    const referenceSize = reference ? Math.max(reference.w, reference.h) : lastDecodedRegionSize;
    if (referenceSize) {
      const ratio = Math.max(box.w, box.h) / referenceSize;
      if (ratio < 0.5 || ratio > 2) return;
    } else {
      // A reduced acquisition scan may locate geometry without enough pixels to
      // decode it. Retain one plausible cold candidate for a native crop, but
      // reject the small square error boxes produced by individual finder
      // patterns in a dense lattice—they are not QR bounds and send the crop
      // path to exactly the wrong place and scale.
      const coldMinSize = Math.max(24, Math.min(receiverFrameWidth, receiverFrameHeight) * 0.06);
      if (box.w < coldMinSize || box.h < coldMinSize ||
          Math.max(box.w / box.h, box.h / box.w) > 2.25 ||
          box.w * box.h > receiverFrameWidth * receiverFrameHeight * 0.8) return;
      if (regions.some((region) => !region.decoded)) return;
    }
    // Error-result quads wobble and split while a display transition is in
    // flight. Never draw more probationary regions than the number of codes
    // currently missing from the layout high-water mark; for a single sender
    // this turns the detector's several guesses back into one error outline.
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
    decodedSeen: decoded ? now : undefined,
    sightedSeen: now,
    sequenceSamples: [],
    qualityLevel: 0,
    quad: info?.quad,
    dim: info?.modules,
    crc32: info?.crc32,
    consecutiveMisses: 0,
    detectionConfidence: decoded ? 1 : 0.35,
    decodeConfidence: decoded ? 1 : 0,
    globalGridConfidence: 0,
    visibleFraction: 1,
    pixelsPerModule: 0,
    decodeAttempts: 0,
    decodeSuccesses: 0,
    averageDecodeCostMs: 0,
    lastHitScanId: decoded ? info?.scanId : undefined,
  });
  regionCreations++;
  notePipelineEvent(decoded ? "region-decoded-created" : "region-sighting-created", regions.length);
  if (regions.length > MAX_REGIONS) {
    regions.sort((a, b) => Number(b.decoded) - Number(a.decoded) || b.seen - a.seen);
    regions.length = MAX_REGIONS;
  }
}

function syncGrid(snapshot: GridSnapshot, now: number, decodedSlot?: number, info?: SymbolInfo): Region | undefined {
  lastGridSnapshot = snapshot;
  const shape = `${snapshot.layout.cols}x${snapshot.layout.rows}`;
  if (shape !== gridShape) {
    for (let i = regions.length - 1; i >= 0; i--) if (regions[i]!.gridSlot !== undefined) regions.splice(i, 1);
    gridShape = shape;
  }
  // A validated AirGapper lattice supersedes all independently acquired boxes.
  // From here on every region is a slot derived from one global transform.
  for (let i = regions.length - 1; i >= 0; i--) if (regions[i]!.gridSlot === undefined) regions.splice(i, 1);
  let decodedRegion: Region | undefined;
  for (const slot of snapshot.slots) {
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
        averageDecodeCostMs: 0,
      };
      regions.push(region);
      regionCreations++;
    }
    Object.assign(region, slot.box, {
      quad: slot.quad,
      dim: snapshot.modules,
      globalGridConfidence: snapshot.confidence,
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
      region.crc32 = info?.crc32 ?? true;
      if (info?.scanId !== undefined) region.lastHitScanId = Math.max(region.lastHitScanId ?? -1, info.scanId);
      decodedRegion = region;
    }
  }
  expectedRegions = snapshot.slots.length;
  expectedRegionsAt = now;
  peakRegions = Math.max(peakRegions, snapshot.slots.length);
  return decodedRegion;
}

function classifyGridSlots(vw: number, vh: number): Region[] {
  const visible: Region[] = [];
  for (const region of regions) {
    if (region.gridSlot === undefined || !region.quad || !region.dim) continue;
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
      const next = points[(index + 1) % 4]!;
      return Math.hypot(point.x - next.x, point.y - next.y);
    }));
    region.pixelsPerModule = shortestEdge / region.dim;
    if (region.visibleFraction < 0.1) region.slotState = "OFFSCREEN";
    else if (region.visibleFraction < 0.88) region.slotState = "PARTIAL";
    else if (region.consecutiveMisses >= 3) region.slotState = "LOST";
    // Detection becomes unreliable before direct sampling does. Keep a fully
    // visible low-density slot eligible for the tracked sampler down to the
    // practical two-pixel/module floor instead of silently scheduling nothing.
    else if (region.pixelsPerModule < 2) region.slotState = "LOW_QUALITY";
    else region.slotState = "ACTIVE";
    if (region.slotState !== "OFFSCREEN") visible.push(region);
  }
  return visible;
}

function isGridDecodeCandidate(region: Region): boolean {
  return region.slotState === "ACTIVE" || region.slotState === "LOST" || region.slotState === "LOW_QUALITY" ||
    // A narrow clipped edge can remain recoverable through QR error correction
    // and the known transform. Do not spend work on substantially absent codes.
    (region.slotState === "PARTIAL" && region.visibleFraction >= 0.85);
}

function slotUsefulness(region: Region): number {
  const success = region.decodeAttempts ? region.decodeConfidence : 0.65;
  const quality = Math.min(1.5, region.pixelsPerModule / 4);
  const cost = region.averageDecodeCostMs || 8;
  const stateWeight = region.slotState === "ACTIVE" ? 1 : region.slotState === "LOST" ? 0.35 : region.slotState === "LOW_QUALITY" ? 0.2 : region.slotState === "PARTIAL" ? 0.12 : 0;
  return stateWeight * region.visibleFraction * quality * (0.25 + success) / Math.sqrt(cost);
}

function gridDebugSummary(): string {
  if (!lastGridSnapshot) return "";
  const slots = regions.filter((region) => region.gridSlot !== undefined);
  const visible = slots.filter((region) => region.slotState !== "OFFSCREEN");
  const active = slots.filter((region) => region.slotState === "ACTIVE");
  const partial = slots.filter((region) => region.slotState === "PARTIAL");
  const offscreen = slots.filter((region) => region.slotState === "OFFSCREEN");
  const best = [...active].sort((a, b) => slotUsefulness(b) - slotUsefulness(a)).slice(0, activeDecodeBudget);
  const avgPpm = best.length ? best.reduce((sum, region) => sum + region.pixelsPerModule, 0) / best.length : 0;
  const successesPerFrame = totalCaptures ? totalDecodes / totalCaptures : 0;
  return `sender ${lastGridSnapshot.layout.cols}×${lastGridSnapshot.layout.rows} · visible ${visible.length}/${slots.length} · active ${active.length} · offscreen ${offscreen.length} · partial ${partial.length} · best ${best.map((region) => region.gridSlot).join(",")} · ${avgPpm.toFixed(1)} px/module · budget ${activeDecodeBudget} · ${successesPerFrame.toFixed(1)} QR/frame · ${liveGoodputKbs(receiverNow()).toFixed(1)} KB/s`;
}

/** The selected resolution reserves the initial camera box. Cameras can still
 *  negotiate a different shape, so metadata replaces that estimate with the
 *  stream's real dimensions. With the aspect matched, contain shows every
 *  capture pixel edge to edge. */
function syncPreviewAspect() {
  if (video.videoWidth && video.videoHeight) cameraBox.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
}
function showNegotiatedWebMode(track: MediaStreamTrack, prefix = ""): void {
  const active = track.getSettings();
  const size = active.width && active.height ? formatCameraSize(active.width, active.height) : "Camera active";
  cameraActual.textContent = `${prefix ? `${prefix} · ` : ""}${size}${active.frameRate ? ` · ${Math.round(active.frameRate)} fps` : ""}`;
}
function sameModeSize(a: BrowserMode, b: BrowserMode): boolean {
  return (a.width === b.width && a.height === b.height) || (a.width === b.height && a.height === b.width);
}
function formatExposureMs(value?: number): string {
  return value === undefined ? "—" : `${Number((value * 0.1).toPrecision(3))} ms`;
}
function showExposureTime(value: number): void {
  cameraExposureValue.value = formatExposureMs(value);
}
function syncExposureControls(): void {
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
    [automaticIsoAxis, isoAxisToggle, cameraIso, cameraIsoValue, isoAxisReset, isoAxisName],
  ] as const) {
    toggle.hidden = !automatic;
    slider.hidden = automatic;
    output.hidden = automatic;
    reset.hidden = automatic;
    name.hidden = !automatic;
  }
}
async function applyExposureSetting(track: MediaStreamTrack): Promise<void> {
  const generation = ++exposureApplyGeneration;
  if (automaticOptics) return;
  if (automaticExposureAxis && automaticIsoAxis) {
    await applyCameraConstraint(track, { exposureMode: "continuous" });
    return;
  }
  const activeSettings = track.getSettings() as MediaTrackSettings & CameraPatch;
  // ISO is only honored by Android camera HALs in manual exposure mode. When
  // ISO alone is overridden, freeze the current AE-selected shutter time.
  const requested = automaticExposureAxis ? activeSettings.exposureTime : preferredExposureTime;
  if (requested === undefined) return;
  if (automaticIsoAxis) delete desiredCamera.iso;
  const requestedIso = automaticIsoAxis ? undefined : preferredIso;

  // Several Android camera providers silently ignore a time bundled with the
  // mode switch. Put the camera in manual first, then send the value by itself.
  await applyCameraConstraint(track, { exposureMode: "manual" });
  await applyCameraConstraint(track, { exposureTime: requested, ...(requestedIso !== undefined ? { iso: requestedIso } : {}) });
  await new Promise((resolve) => setTimeout(resolve, 80));
  if (generation !== exposureApplyGeneration || track.readyState !== "live") return;

  type ExposureSettings = MediaTrackSettings & { exposureMode?: string; exposureTime?: number; iso?: number };
  const active = track.getSettings() as ExposureSettings;
  const step = Number(cameraExposure.step) || 0.1;
  const isoStep = Number(cameraIso.step) || 1;
  if ((active.exposureMode && active.exposureMode !== "manual") ||
      (active.exposureTime !== undefined && Math.abs(active.exposureTime - requested) > step / 2) ||
      (requestedIso !== undefined && active.iso !== undefined && Math.abs(active.iso - requestedIso) > isoStep / 2)) {
    await applyCameraConstraint(track, {
      exposureMode: "manual", exposureTime: requested,
      ...(requestedIso !== undefined ? { iso: requestedIso } : {}),
    });
    if (generation !== exposureApplyGeneration) return;
  }
  // Android camera providers can report a stale exposureTime after accepting
  // the constraint. Keep the user's requested value as the UI and saved source
  // of truth instead of letting that delayed camera report move the slider.
  cameraExposure.value = String(requested);
  showExposureTime(requested);
}
function populateBrowserCapabilities(track: MediaStreamTrack): void {
  seedDesiredCamera(track);
  const caps = track.getCapabilities?.() as (MediaTrackCapabilities & {
    exposureMode?: string[];
    exposureTime?: { min: number; max: number; step?: number };
    iso?: { min: number; max: number; step?: number };
  }) | undefined;
  cameraResolutionLabel.textContent = "Mode";
  if (!caps?.width || !caps.height) return;
  const hasExposureModes = caps.exposureMode?.includes("continuous") && caps.exposureMode.includes("manual");
  const exposure = hasExposureModes ? caps.exposureTime : undefined;
  const exposureMin = exposure ? Math.max(1, exposure.min) : 1;
  const exposureMax = exposure ? Math.min(300, exposure.max) : 0;
  cameraExposureControl.hidden = !exposure || exposureMin >= exposureMax;
  if (exposure && exposureMin < exposureMax) {
    const current = Math.max(exposureMin, Math.min(exposureMax, preferredExposureTime ?? 100));
    preferredExposureTime = current;
    cameraExposure.min = String(exposureMin);
    cameraExposure.max = String(exposureMax);
    cameraExposure.step = String(Math.max(exposure.step ?? 0, 0.1));
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
    preferredIso = Math.max(iso.min, Math.min(iso.max, preferredIso ?? (Number((track.getSettings() as MediaTrackSettings & { iso?: number }).iso) || iso.min)));
    cameraIso.min = String(iso.min);
    cameraIso.max = String(iso.max);
    cameraIso.step = String(iso.step ?? 1);
    cameraIso.value = String(preferredIso);
    cameraIsoValue.value = String(Number(preferredIso.toPrecision(4)));
  }
  const widthMin = caps.width.min ?? 0;
  const widthMax = caps.width.max ?? Infinity;
  const heightMin = caps.height.min ?? 0;
  const heightMax = caps.height.max ?? Infinity;
  const fpsMin = caps.frameRate?.min ?? 0;
  const fpsMax = caps.frameRate?.max ?? Infinity;
  const active = track.getSettings();
  if (cameraResolution.value === "auto" && active.width && active.height) {
    const fps = Math.round(active.frameRate ?? 30);
    automaticBrowserMode = {
      key: "auto", width: active.width, height: active.height, fps,
      label: formatCameraMode(active.width, active.height, fps),
    };
  }
  browserModes = standardBrowserModes().filter((mode) =>
    mode.width >= widthMin && mode.width <= widthMax && mode.height >= heightMin && mode.height <= heightMax &&
    mode.fps >= fpsMin && mode.fps <= fpsMax && browserModeResults[mode.key] !== false &&
    !(automaticBrowserMode && sameModeSize(mode, automaticBrowserMode) && Math.abs(mode.fps - automaticBrowserMode.fps) < 1));
  const prior = cameraResolution.value;
  const options = browserModes.map((mode) => ({
    width: mode.width,
    height: mode.height,
    fps: mode.fps,
    option: new Option(`${mode.label}${browserModeResults[mode.key] === true ? "" : " · Try"}`, mode.key),
  }));
  if (automaticBrowserMode) {
    options.push({
      width: automaticBrowserMode.width,
      height: automaticBrowserMode.height,
      fps: automaticBrowserMode.fps,
      option: new Option(`${automaticBrowserMode.label} · Auto`, "auto"),
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
// Fires whenever the intrinsic size changes — device rotation, or a live
// capture-width change the camera accepted.
video.addEventListener("resize", syncPreviewAspect);
video.addEventListener("loadedmetadata", syncPreviewAspect);
window.addEventListener("resize", syncPreviewAspect);

// Viewfinder corner brackets around each code the decoder is tracking, fading
// out once a region stops producing decodes. Long before REGION_TTL_MS: the
// brackets answer "is it reading THIS code right now", so they should die as
// soon as the answer stops being yes, while the crop tracker keeps trying.
const INDICATOR_FADE_MS = 700;
const SIGHTING_FADE_MS = 450;
const MAX_QR_MODULES = 177;
const BLUE_MIN_PIXELS_PER_MODULE = 4.5;
const overlayCtx = overlay.getContext("2d")!;

function captureQualityRate(region: Region, now: number): number {
  pruneSequenceSamples(region, now);
  // ESI identifies an equation rather than sender wall-clock position. MDS
  // rows and systematic source IDs intentionally repeat, so an ESI span is not
  // a capture-opportunity denominator. The scheduler's per-attempt EWMA is the
  // honest optical success signal.
  return region.decodeAttempts ? region.decodeConfidence : region.sequenceSamples.length > 0 ? 0.5 : 0;
}

function hasDensityHeadroom(region: Region): boolean {
  if (!region.quad || !region.dim || region.dim >= MAX_QR_MODULES) return false;
  const corners = [
    region.quad.topLeft,
    region.quad.topRight,
    region.quad.bottomRight,
    region.quad.bottomLeft,
  ];
  let shortestEdge = Infinity;
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % corners.length]!;
    shortestEdge = Math.min(shortestEdge, Math.hypot(a.x - b.x, a.y - b.y));
  }
  return shortestEdge / region.dim >= BLUE_MIN_PIXELS_PER_MODULE;
}

function captureQualityColor(region: Region, rate: number): string {
  const headroom = hasDensityHeadroom(region);
  // Separate enter/leave thresholds keep an established indication from
  // flickering on one miss. Red is reserved for near-total capture failure;
  // sustained 95% capture gets its own unmistakably bright blue.
  let level = 0;
  if ((rate >= 0.95 || (region.qualityLevel === 5 && rate >= 0.9)) && headroom) level = 5;
  else if ((rate >= 0.8 || (region.qualityLevel >= 4 && rate >= 0.72)) && headroom) level = 4;
  else if (rate >= 0.6 || (region.qualityLevel >= 3 && rate >= 0.52)) level = 3;
  else if (rate >= 0.35 || (region.qualityLevel >= 2 && rate >= 0.28)) level = 2;
  else if (rate >= 0.12 || (region.qualityLevel >= 1 && rate >= 0.08)) level = 1;
  region.qualityLevel = level;
  return ["#ff665c", "#ffb23e", "#d5d936", "#35d66f", "#42a5ff", "#00efff"][level]!;
}

/** Grid-layout reading order: rows first, columns within a row. Two boxes are
 *  the same row when their vertical centers are within half a code of each
 *  other — grid codes are same-size and aligned, so this is unambiguous. */
function layoutOrder(a: Region, b: Region): number {
  const dy = a.y + a.h / 2 - (b.y + b.h / 2);
  if (Math.abs(dy) > Math.max(a.h, b.h) / 2) return dy;
  return a.x + a.w / 2 - (b.x + b.w / 2);
}

function drawOverlay(now: number) {
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
  // Regions live in capture pixels; the video sits object-fit: contain inside
  // the same box as the overlay, so one letterbox mapping places everything.
  const scale = Math.min(pw / vw, ph / vh);
  const offX = (pw - vw * scale) / 2;
  const offY = (ph - vh * scale) / 2;
  overlayCtx.lineCap = "round";
  overlayCtx.lineJoin = "round";
  // Solid glowing corners mean a successful frame. A plausible code that the
  // detector can see but cannot decode gets a short-lived dashed outline;
  // this makes distance/focus/cropping trouble visible without covering the
  // camera image or adding instructions over it.
  const ordered = [...regions].sort(layoutOrder);
  for (const r of ordered) {
    const decodedAge = now - (r.decodedSeen ?? -Infinity);
    const sightingAge = now - (r.sightedSeen ?? r.seen);
    const successful = decodedAge <= INDICATOR_FADE_MS;
    if (!successful && sightingAge > SIGHTING_FADE_MS) continue;

    const quality = captureQualityRate(r, now);
    const color = captureQualityColor(r, quality);
    overlayCtx.strokeStyle = color;
    overlayCtx.shadowColor = color;
    overlayCtx.shadowBlur = successful ? 5 * dpr : 0;
    overlayCtx.lineWidth = Math.max(successful ? 2.5 : 1.5, (successful ? 2.5 : 1.5) * dpr);
    overlayCtx.setLineDash(successful ? [] : [5 * dpr, 5 * dpr]);
    // Brackets sit just outside the code so they never obscure its modules.
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
  overlayCtx.globalAlpha = 1;
  overlayCtx.shadowBlur = 0;
  overlayCtx.setLineDash([]);
}
function focusGeometry(): FocusGeometry | undefined {
  const snapshot = lastGridSnapshot;
  if (!snapshot || !receiverFrameWidth || !receiverFrameHeight || !snapshot.slots.length) return undefined;
  const points = snapshot.slots.flatMap((slot) => [slot.quad.topLeft, slot.quad.topRight, slot.quad.bottomRight, slot.quad.bottomLeft]);
  const left = Math.min(...points.map((point) => point.x));
  const right = Math.max(...points.map((point) => point.x));
  const top = Math.min(...points.map((point) => point.y));
  const bottom = Math.max(...points.map((point) => point.y));
  const tracked = regions.filter((region) => region.gridSlot !== undefined);
  const quality = tracked.length ? tracked.reduce((sum, region) => sum + region.decodeConfidence, 0) / tracked.length : snapshot.confidence;
  const representative = snapshot.slots[Math.floor(snapshot.slots.length / 2)]!.quad;
  const topEdge = Math.hypot(representative.topRight.x - representative.topLeft.x, representative.topRight.y - representative.topLeft.y);
  const bottomEdge = Math.hypot(representative.bottomRight.x - representative.bottomLeft.x, representative.bottomRight.y - representative.bottomLeft.y);
  const leftEdge = Math.hypot(representative.bottomLeft.x - representative.topLeft.x, representative.bottomLeft.y - representative.topLeft.y);
  const rightEdge = Math.hypot(representative.bottomRight.x - representative.topRight.x, representative.bottomRight.y - representative.topRight.y);
  return {
    x: Math.max(0, Math.min(1, (left + right) / 2 / receiverFrameWidth)),
    y: Math.max(0, Math.min(1, (top + bottom) / 2 / receiverFrameHeight)),
    scale: Math.sqrt(Math.max(1, (right - left) * (bottom - top)) / (receiverFrameWidth * receiverFrameHeight)),
    perspectiveX: Math.log(Math.max(0.0001, topEdge) / Math.max(0.0001, bottomEdge)),
    perspectiveY: Math.log(Math.max(0.0001, leftEdge) / Math.max(0.0001, rightEdge)),
    quality,
  };
}

function renderFocusDiagnostics(): void {
  const diagnostic = focusController?.diagnostics();
  if (!diagnostic) return;
  focusDev.hidden = diagnostic.state === "UNAVAILABLE";
  focusMode.value = manualFocusMode;
  for (const option of focusMode.options) option.disabled = !diagnostic.availableModes.includes(option.value);
  const range = diagnostic.distanceRange;
  focusDistanceControl.hidden = automaticOptics || (!range && diagnostic.availableModes.length === 0);
  if (range) {
    focusDistance.min = String(range.min);
    focusDistance.max = String(range.max);
    focusDistance.step = String(range.step || (range.max - range.min) / 100 || 0.01);
    if (document.activeElement !== focusDistance) focusDistance.value = String(preferredFocusDistance ?? diagnostic.actualDistance ?? range.min);
    focusDistanceValue.value = Number(focusDistance.value).toPrecision(4);
  }
  for (const input of focusTuningInputs) {
    const key = input.dataset.cameraTuning as keyof typeof CAMERA_TUNING;
    if (document.activeElement !== input) input.value = String(CAMERA_TUNING[key]);
  }
  const optical = diagnostic.optical;
  const optimizing = diagnostic.optimizeState === "baseline" || diagnostic.optimizeState === "focus" || diagnostic.optimizeState === "exposure" || diagnostic.optimizeState === "iso";
  opticsOptimize.textContent = optimizing ? "Cancel" : "Optimize";
  const optimizeEligible = automaticOptics && diagnostic.state === "LOCKED" && diagnostic.geometryStable;
  opticsOptimize.disabled = !optimizing && !optimizeEligible;
  if (!optimizing && diagnostic.optimizeState !== "complete" && diagnostic.optimizeState !== "cancelled") {
    opticsOptimizeStatus.textContent = diagnostic.state !== "LOCKED"
      ? "Optimize: waiting for lock"
      : !diagnostic.geometryStable ? "Optimize: waiting for stable target" : "Optimize: ready";
  }
  focusRefocus.disabled = optimizing;
  const mutation = lastCameraMutation;
  const cameraLine = (value?: CameraPatch) => value
    ? `${value.focusMode ?? "—"}/${value.focusDistance ?? "—"} · ${value.exposureMode ?? "—"}/${formatExposureMs(value.exposureTime)} · ISO ${value.iso ?? "—"}`
    : "—";
  focusDiagnostics.textContent = [
    diagnostic.invariantWarning ? `!!! ${diagnostic.invariantWarning} — SELF-HEALING TO HARDWARE AF !!!` : "",
    `State    ${diagnostic.state} · ${(diagnostic.stateMs / 1000).toFixed(1)}s${diagnostic.lockedMs === undefined ? "" : ` · locked ${(diagnostic.lockedMs / 1000).toFixed(1)}s`}`,
    `Owner    ${diagnostic.focusOwner}`,
    `Focus    requested ${diagnostic.requestedMode ?? "—"} · actual ${diagnostic.actualMode ?? "—"} · distance ${diagnostic.actualDistance ?? "—"}`,
    `Freeze   attempted ${diagnostic.manualFreezeAttempted ? "yes" : "no"} · verified ${diagnostic.manualFreezeVerified ? "yes" : "no"} · unsafe ${diagnostic.manualFreezeUnsafe ? "yes" : "no"}`,
    `Focus    committed ${diagnostic.committedFocusMode ?? "—"}/${diagnostic.committedFocusDistance ?? "—"} · candidate ${diagnostic.candidateFocusDistance ?? "—"}`,
    `Exposure committed ${formatExposureMs(diagnostic.committedExposureTime)} · actual ${formatExposureMs(diagnostic.actualExposure)} · candidate ${formatExposureMs(diagnostic.candidateExposureTime)}`,
    `ISO      committed ${diagnostic.committedIso ?? "—"} · actual ${diagnostic.actualIso ?? "—"} · candidate ${diagnostic.candidateIso ?? "—"}`,
    optical ? `Static   focus ${optical.focusScore.toFixed(2)} · separation ${optical.separation.toFixed(0)} · noise ${optical.noise.toFixed(1)} · banding ${optical.banding.toFixed(2)} · temporal ${optical.temporalContamination.toFixed(1)} · geometry ${diagnostic.geometryStable ? "stable" : "moving"}` : "Static   waiting for QR",
    `Payload  valid ${diagnostic.validDecodesInGeneration} · completions ${diagnostic.decoderCompletionsInGeneration} · silence ${(diagnostic.decodeSilenceMs / 1000).toFixed(1)}s`,
    `Counts   full AF+AE ${diagnostic.fullResetCount} · focus-only ${diagnostic.focusRefinementCount} · exposure-only ${diagnostic.exposureRefinementCount} · reacquire ${diagnostic.reacquireCount}`,
    `Optimize ${diagnostic.optimizeState}${diagnostic.optimizeCandidatePerformance ? ` · candidate ${diagnostic.optimizeCandidatePerformance.validDecodesPerSecond.toFixed(1)} valid/s · ${diagnostic.optimizeCandidatePerformance.usefulSymbolsPerSecond.toFixed(1)} useful/s · ${(diagnostic.optimizeCandidatePerformance.perQrAttemptSuccessRate * 100).toFixed(0)}%/attempt` : ""}`,
    diagnostic.optimizeBestPerformance ? `Best     ${diagnostic.optimizeBestPerformance.validDecodesPerSecond.toFixed(1)} valid/s · focus ${diagnostic.committedFocusDistance ?? "—"} · ${formatExposureMs(diagnostic.committedExposureTime)} · ISO ${diagnostic.committedIso ?? "—"}` : "",
    `Analyzer ${(opticalAnalyzeCount / Math.max(0.001, (performance.now() - opticalTimingStartedAt) / 1000)).toFixed(1)}/s · avg ${(opticalAnalyzeTotalMs / Math.max(1, opticalAnalyzeCount)).toFixed(2)}ms · max ${opticalAnalyzeMaxMs.toFixed(2)}ms`,
    `Reason   ${diagnostic.lastReason}`,
    `Mutation ${mutation?.kind ?? "—"}`,
    mutation ? `  before    ${cameraLine(mutation.before)}\n  requested ${cameraLine(mutation.requested)}\n  after     ${cameraLine(mutation.after)}` : "",
    diagnostic.transitions.length ? `Transitions\n${diagnostic.transitions.join("\n")}` : "",
  ].filter(Boolean).join("\n");
}

focusMode.addEventListener("change", () => {
  manualFocusMode = focusMode.value as Exclude<FocusStrategy, "auto">;
  syncExposureControls();
  saveCameraSettings();
  if (!automaticOptics) focusController.setStrategy(manualFocusMode);
});
focusRefocus.addEventListener("click", () => focusController.refocus("Reacquire requested"));
focusDistance.addEventListener("input", () => {
  preferredFocusDistance = Number(focusDistance.value);
  focusDistanceValue.value = Number(focusDistance.value).toPrecision(4);
  saveCameraSettings();
  focusController.setManualDistance(preferredFocusDistance);
});
for (const input of focusTuningInputs) input.addEventListener("change", () => {
  const key = input.dataset.cameraTuning as keyof typeof CAMERA_TUNING;
  const value = Number(input.value);
  if (Number.isFinite(value)) CAMERA_TUNING[key] = value;
  renderFocusDiagnostics();
});

startBtn.onclick = () => void start();
const changeCameraSettings = async () => {
  showRequestedCameraSettings();
  saveCameraSettings();
  const track = stream?.getVideoTracks()[0];
  if (!track || done) return;
  if (cameraResolution.value === "auto") {
    await mutateCamera(track, () => track.applyConstraints({
      width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 },
    })).catch(() => undefined);
    populateBrowserCapabilities(track);
    showNegotiatedWebMode(track);
    attachCameraController(track);
    return;
  }
  const attempted = browserModes.find((mode) => mode.key === cameraResolution.value);
  if (!attempted) return;
  try {
    await mutateCamera(track, () => track.applyConstraints({
      width: { exact: attempted.width }, height: { exact: attempted.height }, frameRate: { exact: attempted.fps },
    }));
    const active = track.getSettings();
    const exactSize = (active.width === attempted.width && active.height === attempted.height) ||
      (active.width === attempted.height && active.height === attempted.width);
    const exact = exactSize && Math.abs((active.frameRate ?? attempted.fps) - attempted.fps) < 1;
    if (!exact) throw new Error("Browser negotiated a different mode");
    saveBrowserModeResult(attempted.key, true);
    const option = [...cameraResolution.options].find((candidate) => candidate.value === attempted.key);
    if (option) option.textContent = attempted.label;
    populateBrowserCapabilities(track);
    showNegotiatedWebMode(track);
    attachCameraController(track);
  } catch {
    saveBrowserModeResult(attempted.key, false);
    cameraResolution.querySelector(`option[value="${CSS.escape(attempted.key)}"]`)?.remove();
    cameraResolution.value = "auto";
    populateBrowserCapabilities(track);
    showNegotiatedWebMode(track, `${attempted.label} unavailable; kept current mode`);
    saveCameraSettings();
    attachCameraController(track);
  }
};
cameraResolution.addEventListener("change", () => void changeCameraSettings());
cameraExposureAuto.addEventListener("change", () => {
  automaticOptics = cameraExposureAuto.checked;
  clearTimeout(exposureApplyTimer);
  syncExposureControls();
  saveCameraSettings();
  const track = stream?.getVideoTracks()[0];
  if (!automaticOptics) focusController.setStrategy(manualFocusMode);
  else focusController.setStrategy("auto");
  if (track) void applyExposureSetting(track);
});
exposureAxisAuto.addEventListener("change", () => {
  automaticExposureAxis = exposureAxisAuto.checked;
  syncExposureControls();
  saveCameraSettings();
  const track = stream?.getVideoTracks()[0];
  if (track) void applyExposureSetting(track);
});
isoAxisAuto.addEventListener("change", () => {
  automaticIsoAxis = isoAxisAuto.checked;
  syncExposureControls();
  saveCameraSettings();
  const track = stream?.getVideoTracks()[0];
  if (track) void applyExposureSetting(track);
});
exposureAxisReset.addEventListener("click", () => {
  automaticExposureAxis = true;
  syncExposureControls();
  saveCameraSettings();
  const track = stream?.getVideoTracks()[0];
  if (track) void applyExposureSetting(track);
});
isoAxisReset.addEventListener("click", () => {
  automaticIsoAxis = true;
  syncExposureControls();
  saveCameraSettings();
  const track = stream?.getVideoTracks()[0];
  if (track) void applyExposureSetting(track);
});
function queueExposureChange(immediate = false): void {
  preferredExposureTime = Number(cameraExposure.value);
  focusController.developerOverride("developer changed exposure time");
  showExposureTime(preferredExposureTime);
  saveCameraSettings();
  clearTimeout(exposureApplyTimer);
  const apply = () => {
    const track = stream?.getVideoTracks()[0];
    if (track && !automaticOptics) void applyExposureSetting(track);
  };
  if (immediate) apply();
  else exposureApplyTimer = setTimeout(apply, 80);
}
cameraExposure.addEventListener("input", () => queueExposureChange());
cameraExposure.addEventListener("change", () => queueExposureChange(true));
function queueIsoChange(immediate = false): void {
  preferredIso = Number(cameraIso.value);
  automaticIsoAxis = false;
  isoAxisAuto.checked = false;
  cameraIsoValue.value = String(Number(preferredIso.toPrecision(4)));
  syncExposureControls();
  saveCameraSettings();
  focusController.developerOverride("developer changed ISO");
  clearTimeout(exposureApplyTimer);
  const apply = () => {
    const track = stream?.getVideoTracks()[0];
    if (track && !automaticOptics) void applyExposureSetting(track);
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
  pool.resize(selectedWorkerCount());
});
window.addEventListener("airgapper:enter-receive", () => {
  if (!stream && !startBtn.disabled) void start();
});

const { setStatus, showError } = statusLine(stats);

/** By the time a transfer ends the camera, worker pool and stats timer are all
 *  torn down and `done` is latched, so a reload is the honest way back to a
 *  live receiver — and it drops the recovered bytes from memory on the way. */
function restartButton(label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary-button";
  button.textContent = label;
  button.addEventListener("click", () => window.location.reload());
  return button;
}

/** Put the page back the way it was so a refused camera can be retried without
 *  a reload. Tapping "Block" by accident on the permission prompt is easy, and
 *  a dead page with no button is a bad answer to it. */
function offerRetry(message: string) {
  startBtn.disabled = false;
  startBtn.hidden = false;
  startBtn.style.display = "";
  startBtn.textContent = "Try camera again";
  preview.style.display = "";
  preview.classList.remove("camera-loading");
  metricsEl.style.display = "block";
  progressStatus.style.display = "block";
  progressEl.style.display = "block";
  if (diagnosticsEl) diagnosticsEl.style.display = "none";
  showError(message);
}

/** Stop every hot-path resource before this in-page view is hidden. */
function stopReceiver(): void {
  cameraStartGen++;
  focusController.detach();
  captureGen++;
  receiverPaused = false;
  pauseStartedAt = 0;
  releaseScreenWakeLock();
  document.body.classList.remove("receive-complete");
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  clearInterval(statsTimer);
  statsTimer = undefined;
  pool.resize(0);
  releaseTransportDecoder();
  streamKey = "";
  reportStreamId = 0;
  startTs = 0;
  done = false;
  regions.length = 0;
  gridLattice.reset();
  gridShape = "";
  lastGridSnapshot = undefined;
  activeDecodeBudget = 0;
  lastDecodedRegionSize = 0;
  expectedRegions = 0;
  expectedRegionsAt = 0;
  lastFullScan = 0;
  fullScanIds.clear();
  fullScanJobs.clear();
  localReacquireIds.clear();
  currentScanningState = "SEARCH";
  scanCapturedAt.clear();
  scanOutcomes.clear();
  captureTimes.length = 0;
  qrReadTimes.length = 0;
  poolBusyTimes.length = 0;
  scanCompletionTimes.length = 0;
  cropAttempts.clear();
  cropRotate = 0;
  schedulerNoJobs = 0;
  cropMisses = 0;
  fullDetectorMisses = 0;
  fullSightings = 0;
  trackedMissFallbacks = 0;
  decodeExceptions = 0;
  lastDecodeError = "";
  regionExpiries = 0;
  regionCreations = 0;
  trackingInvalidations = 0;
  submittedJobs = 0;
  completedJobs = 0;
  workerLatencyTotalMs = 0;
  workerLatencyMaxMs = 0;
  fullLatencyTotalMs = 0;
  fullLatencyCount = 0;
  lastFullLatencyMs = 0;
  lastDistinctArrivalAt = 0;
  lastStreamDecodeAt = 0;
  maxSequenceGapMs = 0;
  pipelineEvents.length = 0;
  usefulFrameTimes.length = 0;
  totalCaptures = 0;
  totalDecodes = 0;
  totalUsefulSymbols = 0;
  fullScans = 0;
  cheapFullScans = 0;
  thoroughFullScans = 0;
  localReacquisitions = 0;
  globalReacquisitions = 0;
  peakRegions = 0;
  capturesDropped = 0;
  cropsSubmitted = 0;
  trackedDecodes = 0;
  trackedAttempts = 0;
  cameraStartedTs = 0;
  lastOpticalSampleAt = -Infinity;
  lastOpticalSourceSequence = -1;
  opticalAnalyzeCount = 0;
  opticalAnalyzeTotalMs = 0;
  opticalAnalyzeMaxMs = 0;
  opticalTimingStartedAt = performance.now();
  zeroRegionMs = 0;
  degradedMs = 0;
  timeline.length = 0;
  plainQrPolicy.reset();
  result.replaceChildren();
  purgeReceivedData();
  preview.style.display = "none";
  preview.classList.remove("camera-loading");
  cameraActual.textContent = "";
  clearTimeout(scanCaptureTimer);
  scanCaptureTimer = undefined;
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
  if (diagnosticsEl) {
    diagnosticsEl.style.display = "none";
    diagnosticsEl.open = false;
    const label = diagnosticsEl.querySelector("summary");
    if (label) label.textContent = "Progress and measured KB/s";
  }
  startBtn.disabled = false;
  startBtn.hidden = false;
  startBtn.style.display = "";
  startBtn.textContent = "Enable camera";
  setStatus("");
}
function pauseReceiver(): void {
  if (receiverPaused || done) return;
  focusController.detach();
  receiverPaused = true;
  pauseStartedAt = receiverNow();
  cameraStartGen++;
  captureGen++;
  releaseScreenWakeLock();
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
  clearInterval(statsTimer);
  statsTimer = undefined;
  pool.resize(0);
  cropAttempts.clear();
  fullScanIds.clear();
  fullScanJobs.clear();
  localReacquireIds.clear();
  scanCapturedAt.clear();
  minimumAcceptedScanId = frameId;
}

function resumeReceiver(): void {
  if (!receiverPaused || done) return;
  const pausedFor = receiverNow() - pauseStartedAt;
  receiverPaused = false;
  if (startTs) startTs += pausedFor;
  if (cameraStartedTs) cameraStartedTs += pausedFor;
  void start();
}

window.addEventListener("airgapper:leave-mode", () => {
  if (document.getElementById("receiveView")?.classList.contains("active")) stopReceiver();
});
window.addEventListener("pagehide", stopReceiver);
window.addEventListener("airgapper:pause-mode", () => {
  if (document.getElementById("receiveView")?.classList.contains("active")) pauseReceiver();
});
window.addEventListener("airgapper:resume-mode", () => {
  if (document.getElementById("receiveView")?.classList.contains("active")) resumeReceiver();
});

const localCameraMessage =
  "This browser does not allow camera access from a local file. Use the installed offline PWA for receiving.";

async function start() {
  const startAttempt = cameraStartGen;
  try {
    await prepareRaptorQ();
  } catch (error) {
    offerRetry(`Transport: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (startAttempt !== cameraStartGen || receiverPaused) return;
  // Materialize the complete receiver layout before camera permission or
  // startup can delay it. Camera readiness should only replace the viewfinder,
  // never determine the size or visibility of the controls below it.
  preview.style.display = "";
  preview.classList.add("camera-loading");
  metricsEl.style.display = "block";
  progressStatus.style.display = "block";
  progressEl.style.display = "block";
  showRequestedCameraSettings();
  if (!navigator.mediaDevices?.getUserMedia) {
    // Mobile browsers commonly omit the API entirely for file:// origins.
    offerRetry(
      location.protocol === "file:"
        ? localCameraMessage
        : "Camera access needs HTTPS. Open the hosted app or its installed offline PWA.",
    );
    return;
  }
  const captureWidth = requestedWidth;
  const captureHeight = requestedHeight;
  const captureFps = requestedFps;
  startBtn.disabled = true;
  startBtn.style.display = "none";
  const base: MediaTrackConstraints = {
    facingMode: "environment",
    width: { exact: captureWidth },
    height: { exact: captureHeight },
  };
  let acquiredStream: MediaStream;
  try {
    if (legacyAndroidApp) {
      // Some 32-bit Android camera providers crash or remain wedged when
      // Chromium forwards exact dimensions or any frame-rate constraint.
      // Make one broadly satisfiable request; never retry a rejected mode.
      acquiredStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: "environment",
          width: { ideal: captureWidth },
          height: { ideal: captureHeight },
        },
      });
    } else if (cameraResolution.value === "auto") {
      acquiredStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } },
      });
    } else if (isAndroidApp()) {
      // Keep one non-fatal request in the APK; a rejected exact request can
      // wedge older camera providers before the ideal fallback runs.
      try {
        acquiredStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...base, frameRate: { exact: captureFps } } });
      } catch {
        acquiredStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: "environment", width: { ideal: captureWidth }, height: { ideal: captureHeight }, frameRate: { ideal: captureFps } },
        });
      }
    } else {
      try {
        acquiredStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { ...base, frameRate: { exact: captureFps } },
        });
      } catch {
        acquiredStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: "environment", width: { ideal: captureWidth }, height: { ideal: captureHeight }, frameRate: { ideal: captureFps } },
        });
      }
    }
  } catch (err) {
    if (startAttempt !== cameraStartGen || receiverPaused) return;
    const denied = err instanceof DOMException && err.name === "NotAllowedError";
    offerRetry(
      denied
        ? location.protocol === "file:"
          ? localCameraMessage
          : "Camera permission denied — allow it, then tap Enable camera again."
        : `Camera: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  if (startAttempt !== cameraStartGen || receiverPaused) {
    acquiredStream.getTracks().forEach((track) => track.stop());
    return;
  }
  stream = acquiredStream;

  startBtn.style.display = "none";
  // "": back to the stylesheet's flex — the zone centers the camera box.
  preview.style.display = "";
  if (diagnosticsEl) diagnosticsEl.style.display = "block";
  video.srcObject = stream;
  await video.play().catch(() => undefined);
  preview.classList.remove("camera-loading");
  const activeTrack = stream.getVideoTracks()[0];
  if (activeTrack) {
    populateBrowserCapabilities(activeTrack);
    showNegotiatedWebMode(activeTrack);
    if (!legacyAndroidApp) attachCameraController(activeTrack);
  }
  syncPreviewAspect();
  setStatus("");

  pool.resize(selectedWorkerCount());

  cameraStartedTs = receiverNow();
  captureGen++;
  scheduleFrame(captureGen);
  statsTimer = setInterval(updateStats, STATS_TICK_MS);
  await requestScreenWakeLock();
}

interface VideoFrameMetadata {
  mediaTime?: number;
  presentationTime?: number;
  expectedDisplayTime?: number;
}
type VideoRVFC = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, metadata: VideoFrameMetadata) => void) => number;
};
interface ReceiverFrame {
  sequence: number;
  width: number;
  height: number;
  callbackTimeMs: number;
  mediaTimeMs: number;
  presentationTimeMs: number;
  expectedDisplayTimeMs: number;
  image?: ImageData;
}

const CORPUS_DEVICE_NAMES: Record<string, string> = {
  "0dc8b7d5f6e84e81cf126349d821a9d948a6db87ea4a810c04a51aec6999401c": "OP5",
  "5e792630f18c1d6bc5fc26e8ce6d90a27163fd50f32c7631256aa9e7bc7b193e": "OP12R",
};
function compactDeviceName(header: AgcapHeader): string {
  const id = String(header.cameraSettings.deviceId ?? "");
  return CORPUS_DEVICE_NAMES[id] ?? `D${id.slice(0, 4) || "unk"}`;
}
function compactVersionName(version: string): string {
  return version.replace(/^v?0\./, "v").replace(/^([^v])/, "v$1");
}
function compactTimeName(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  const two = (number: number) => String(number).padStart(2, "0");
  return `${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}-${two(date.getUTCHours())}${two(date.getUTCMinutes())}`;
}

async function finishCorpusRecording(recorder: AgcapRecorder): Promise<void> {
  if (benchmarkRecorder !== recorder) return;
  benchmarkRecorder = undefined;
  recordCorpusBtn.disabled = true;
  recordCorpusBtn.textContent = "Saving…";
  try {
    const { blob, header, corpus } = await recorder.finish();
    benchmarkPendingBlob = undefined;
    benchmarkCorpus = corpus;
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `cap-${compactDeviceName(header)}-${compactVersionName(header.airgapperVersion)}-${compactTimeName(header.startedAt)}.agcap`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
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

function scheduleFrame(gen: number) {
  if (done || gen !== captureGen) return;
  const v = video as VideoRVFC;
  const next = (callbackTime = performance.now(), metadata: VideoFrameMetadata = {}) => {
    if (done || gen !== captureGen) return;
    const width = video.videoWidth;
    const height = video.videoHeight;
    const sequence = benchmarkRecordingSequence++;
    const recorder = benchmarkRecorder;
    const frame: ReceiverFrame = {
      sequence, width, height, callbackTimeMs: callbackTime,
      mediaTimeMs: (metadata.mediaTime ?? callbackTime / 1000) * 1000,
      presentationTimeMs: metadata.presentationTime ?? callbackTime,
      expectedDisplayTimeMs: metadata.expectedDisplayTime ?? callbackTime,
    };
    if (recorder && width && height) {
      const orientation = screen.orientation?.type ?? `${window.orientation ?? 0}`;
      const frameMeta = {
        sequence, mediaTimeMs: frame.mediaTimeMs, presentationTimeMs: frame.presentationTimeMs,
        expectedDisplayTimeMs: frame.expectedDisplayTimeMs, callbackTimeMs: frame.callbackTimeMs,
        width, height, stride: width * 4, orientation,
      };
      recorder.addVideo(frameMeta, video);
      recordCorpusBtn.textContent = recorder.complete ? "Saving…" : `Stop · ${Math.max(1, Math.ceil((recorder.durationMs - recorder.elapsedMs) / 1000))}s`;
      // Corpus capture owns the camera readback. Running production decoding at
      // the same time would only steal callbacks; its decisions are recreated
      // later from these untouched frames during deterministic replay.
      drawOverlay(receiverNow());
      if (recorder.complete) void finishCorpusRecording(recorder);
      scheduleFrame(gen);
      return;
    }
    captureFrame(frame);
    drawOverlay(receiverNow());
    scheduleFrame(gen);
  };
  if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(next);
  else requestAnimationFrame((now) => next(now));
}

const grab = document.createElement("canvas");
const replaySourceCanvas = document.createElement("canvas");
// A transfer handover invalidates every older in-flight capture. Submission
// ids are monotonic, so stale asynchronous replies cannot reclaim the lock.
let minimumAcceptedScanId = 0;
let captureNextScan = false;
let scanCaptureTimer: ReturnType<typeof setTimeout> | undefined;
const SCAN_CAPTURE_TIMEOUT_MS = 12_000;
let pendingScanCapture: {
  id?: number;
  image: ImageData;
  ox: number;
  oy: number;
  full: boolean;
  tracks: SymbolQuad[];
  scaleX: number;
  scaleY: number;
} | null = null;
let lastRawScanImage: ImageData | null = null;
const scanSaveCanvas = document.createElement("canvas");
let scanHoldTimer: ReturnType<typeof setTimeout> | undefined;
let scanHoldStart: { x: number; y: number } | undefined;
let scanSaveInProgress = false;

async function saveRawScan(): Promise<void> {
  const image = lastRawScanImage;
  if (!image || scanSaveInProgress) return;
  scanSaveInProgress = true;
  try {
    scanSaveCanvas.width = image.width;
    scanSaveCanvas.height = image.height;
    scanSaveCanvas.getContext("2d")!.putImageData(image, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => scanSaveCanvas.toBlob(resolve, "image/png"));
    if (!blob) return;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const name = `airgapper-scan-${stamp}.png`;
    if (!saveFileOnAndroid(name, "image/png", bytes)) {
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    }
  } finally {
    scanSaveInProgress = false;
  }
}

function cancelScanHold(): void {
  clearTimeout(scanHoldTimer);
  scanHoldTimer = undefined;
  scanHoldStart = undefined;
}
scanCapture.addEventListener("pointerdown", (event) => {
  if (!lastRawScanImage || event.button !== 0 || !isAndroidApp()) return;
  cancelScanHold();
  scanHoldStart = { x: event.clientX, y: event.clientY };
  scanHoldTimer = setTimeout(() => {
    cancelScanHold();
    navigator.vibrate?.(30);
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
(window as Window & { airgapperSaveRawScan?: () => void }).airgapperSaveRawScan = () => void saveRawScan();

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

function trackedQuadBounds(quad: SymbolQuad): { left: number; top: number; right: number; bottom: number } | null {
  const points = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];
  if (points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return null;
  return {
    left: Math.min(...points.map((point) => point.x)),
    top: Math.min(...points.map((point) => point.y)),
    right: Math.max(...points.map((point) => point.x)),
    bottom: Math.max(...points.map((point) => point.y)),
  };
}

function validTrackedQuad(region: Region, vw: number, vh: number): boolean {
  if (!region.quad) return false;
  const bounds = trackedQuadBounds(region.quad);
  if (!bounds) return false;
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  const regionSize = Math.max(region.w, region.h);
  const quadSize = Math.max(width, height);
  return width >= 24 && height >= 24 &&
    Math.max(width / height, height / width) <= 2.5 &&
    bounds.right > 0 && bounds.bottom > 0 && bounds.left < vw && bounds.top < vh &&
    quadSize >= regionSize * 0.4 && quadSize <= regionSize * 2.5;
}

function invalidateTrackedQuad(region: Region): void {
  region.quad = undefined;
  region.dim = undefined;
  region.consecutiveMisses = 0;
  trackingInvalidations++;
  notePipelineEvent("tracking-invalidated", trackingInvalidations);
}

function captureSubmittedScan(
  image: ImageData,
  ox: number,
  oy: number,
  full: boolean,
  tracks: SymbolQuad[] = [],
  scaleX = 1,
  scaleY = 1,
): void {
  if (!captureNextScan) return;
  captureNextScan = false;
  // The worker transfer detaches image.data, so retain a cheap memory copy.
  // This replaces the old second synchronous canvas readback, which made the
  // Capture button feel hung on full-resolution frames.
  pendingScanCapture = {
    image: new ImageData(new Uint8ClampedArray(image.data), image.width, image.height),
    ox, oy, full, tracks, scaleX, scaleY,
  };
  scanCapture.width = image.width;
  scanCapture.height = image.height;
  scanCapture.getContext("2d")!.putImageData(pendingScanCapture.image, 0, 0);
  scanDialogStatus.textContent = `${full ? "Full-frame scan" : `${tracks.length || 1} tracked region${tracks.length === 1 ? "" : "s"}`} · ${image.width}×${image.height} · decoding…`;
  scanSightingLegend.hidden = true;
  if (!scanDialog.open) scanDialog.showModal();
}

function cancelScanCapture(): void {
  clearTimeout(scanCaptureTimer);
  scanCaptureTimer = undefined;
  pendingScanCapture = null;
  captureNextScan = false;
  captureScanBtn.textContent = "Capture";
  captureScanBtn.disabled = false;
}

function finishScanCapture(id: number, completion: DecodeCompletion): void {
  const capture = pendingScanCapture;
  if (!capture || capture.id !== id) return;
  cancelScanCapture();
  lastRawScanImage = capture.image;
  scanCapture.width = capture.image.width;
  scanCapture.height = capture.image.height;
  const ctx = scanCapture.getContext("2d")!;
  ctx.putImageData(capture.image, 0, 0);
  const drawQuad = (quad: SymbolQuad, color: string, width: number) => {
    const points = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];
    ctx.beginPath();
    points.forEach((point, index) => {
      const x = (point.x - capture.ox) / capture.scaleX;
      const y = (point.y - capture.oy) / capture.scaleY;
      if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
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
    box.h / capture.scaleY,
  );
  const tracked = !capture.full;
  const mode = capture.full ? "Full-frame scan" : `${capture.tracks.length || 1} tracked region${capture.tracks.length === 1 ? "" : "s"}`;
  scanDialogStatus.textContent = completion.error
    ? `${mode} · ${capture.image.width}×${capture.image.height} · ${completion.error}`
    : tracked
      ? `${mode} · ${capture.image.width}×${capture.image.height} · ${completion.symbolCount} decoded${completion.fallbackAttempted ? ` · fallback searched${completion.sightingCount ? ` · ${completion.sightingCount} found` : ""}` : ""}`
      : `${mode} · ${capture.image.width}×${capture.image.height} · ${completion.symbolCount} decoded · ${completion.sightingCount} found`;
  const outcome = scanOutcomes.get(id);
  if (outcome && completion.symbolCount > 0) {
    const details = [
      outcome.accepted && `${outcome.accepted} accepted`,
      outcome.duplicate && `${outcome.duplicate} duplicate`,
      outcome.redundant && `${outcome.redundant} redundant`,
      outcome.rejected && `${outcome.rejected} rejected`,
      outcome.stale && `${outcome.stale} stale`,
      outcome.otherStream && `${outcome.otherStream} other stream`,
    ].filter(Boolean).join(" · ");
    if (details) scanDialogStatus.textContent += ` · ${details}`;
  }
  const gridSummary = gridDebugSummary();
  if (gridSummary) scanDialogStatus.textContent += ` · ${gridSummary}`;
  scanSightingLegend.hidden = tracked && !completion.fallbackAttempted;
  if (!scanDialog.open) scanDialog.showModal();
}

function readBoundedVideoCrop(source: ReceiverFrame, x: number, y: number, w: number, h: number): ImageData {
  // Keep predicted symbols just outside the sensor represented inside the
  // crop. Filling that narrow missing edge white lets the known-transform QR
  // sampler and Reed–Solomon correction attempt it instead of rejecting
  // negative coordinates before ECC runs.
  if (grab.width < w) grab.width = w;
  if (grab.height < h) grab.height = h;
  const ctx = grab.getContext("2d", { willReadFrequently: true })!;
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
      replaySourceCanvas.getContext("2d")!.putImageData(source.image, 0, 0);
      ctx.drawImage(replaySourceCanvas, sx, sy, right - sx, bottom - sy, sx - x, sy - y, right - sx, bottom - sy);
    } else {
      ctx.drawImage(video, sx, sy, right - sx, bottom - sy, sx - x, sy - y, right - sx, bottom - sy);
    }
  }
  return ctx.getImageData(0, 0, w, h);
}

type ScanningState = "SEARCH" | "PARTIAL_LOCK" | "LOCKED" | "REACQUIRE";

function submitReceiverJob(
  message: { id: number; buf: ArrayBuffer; w: number; h: number; full: boolean; [key: string]: unknown },
  transfer: Transferable[],
  kind: BenchmarkJobKind,
  trace: BenchmarkFrameTrace | undefined,
  trackedRegions: Region[] = [],
): boolean {
  const accepted = pool.submit(message, transfer);
  if (accepted) {
    submittedJobs++;
    scanCapturedAt.set(message.id, receiverNow());
    if (kind === "FULL FRAME") {
      fullScanIds.add(message.id);
      fullScanJobs.set(message.id, { thorough: false, native: true, reacquire: gridLattice.state === "REACQUIRE" });
    }
  }
  if (trace) {
    trace.decision = accepted ? kind : "worker busy";
    const job: BenchmarkJob = {
      id: message.id, kind, pixels: message.w * message.h, bytes: message.w * message.h * 4,
      width: message.w, height: message.h, x: Number(message.ox) || 0, y: Number(message.oy) || 0, tracks: trackedRegions.map((region) => region.gridSlot ?? region.id),
      submittedAt: receiverNow(),
    };
    trace.jobs.push(job);
    if (accepted) {
      benchmarkJobFrames.set(message.id, trace);
      for (const predicted of trace.predicted) if (job.tracks.includes(predicted.slot)) predicted.submitted = true;
    }
  }
  return accepted;
}

// The stripe-signature dup-skip that used to live here is gone: field runs
// showed screen captures defeat it (sensor noise plus refresh-phase shimmer
// shift the stripe between two captures of the SAME displayed frame — 452
// duplicate decodes leaked through in one 30 fps run), and it was the last
// thing requiring main-thread pixel access. Duplicates now cost one cheap
// tracked decode each, which the pool absorbs without noticing.

const opticalTargets: QrOpticalTarget[] = [];
let lastOpticalSampleAt = -Infinity;
let lastOpticalSourceSequence = -1;
let opticalAnalyzeCount = 0;
let opticalAnalyzeTotalMs = 0;
let opticalAnalyzeMaxMs = 0;
let opticalTimingStartedAt = performance.now();
function inspectStaticQrOptics(source: ReceiverFrame, image: ImageData, ox = 0, oy = 0): void {
  if (replayRunning || source.sequence === lastOpticalSourceSequence) return;
  const now = receiverNow();
  const interval = focusController.opticalIntervalMs;
  if (!Number.isFinite(interval) || now - lastOpticalSampleAt < interval) return;
  opticalTargets.length = 0;
  let eligibleTargetExists = false;
  for (const region of regions) {
    if (!region.quad || !region.dim || region.visibleFraction < 0.85) continue;
    eligibleTargetExists = true;
    const q = region.quad;
    const inside = (point: { x: number; y: number }) =>
      point.x >= ox + 2 && point.y >= oy + 2 && point.x < ox + image.width - 2 && point.y < oy + image.height - 2;
    if (inside(q.topLeft) && inside(q.topRight) && inside(q.bottomRight) && inside(q.bottomLeft)) {
      opticalTargets.push({ quad: q, modules: region.dim });
    }
  }
  if (!opticalTargets.length) {
    // A crop not containing the known static target says nothing about target
    // loss. Another job from this source frame may cheaply provide it.
    if (!eligibleTargetExists) focusController.noteTargetAbsent(now);
    return;
  }
  // Claim the source sequence immediately before the sole analyzer call. A
  // later full/shared/individual crop from this camera frame cannot repeat it.
  lastOpticalSourceSequence = source.sequence;
  lastOpticalSampleAt = now;
  const analyzeStarted = performance.now();
  const metrics = opticsAnalyzer.analyze(image, opticalTargets, ox, oy);
  const analyzeMs = performance.now() - analyzeStarted;
  opticalAnalyzeCount++;
  opticalAnalyzeTotalMs += analyzeMs;
  opticalAnalyzeMaxMs = Math.max(opticalAnalyzeMaxMs, analyzeMs);
  if (!metrics || (metrics.confidence < 0.55 && !focusController.expectsProbeFrame)) {
    focusController.noteTargetAbsent(now);
    return;
  }
  const geometry = focusGeometry();
  if (!geometry) return;
  const captureFps = captureTimes.reduce((count, at) => count + Number(at > now - STATS_WINDOW_MS), 0);
  focusController.observe(source.sequence, geometry, metrics, Math.max(1, expectedRegions), now, captureFps);
}

function captureFrame(source: ReceiverFrame) {
  const vw = source.width;
  const vh = source.height;
  if (!vw || !vh) return;
  receiverFrameWidth = vw;
  receiverFrameHeight = vh;
  const now = receiverNow();
  const trace: BenchmarkFrameTrace | undefined = replayRunning ? {
    sequence: source.sequence, timestampMs: now, stateBefore: gridLattice.state, stateAfter: gridLattice.state,
    decision: "not scheduled", workerBusyFraction: pool.size ? pool.busyCount / pool.size : 0,
    jobs: [], decoded: [], sightings: [], reference: [], predicted: [], transitions: [],
  } : undefined;
  if (trace) { benchmarkTraces.push(trace); activeBenchmarkFrame = trace; }
  captureTimes.push(now);
  totalCaptures++;
  if (pool.busyCount === pool.size) {
    capturesDropped++;
    poolBusyTimes.push(now);
    if (trace) { trace.decision = "worker busy"; trace.stateAfter = gridLattice.state; }
    activeBenchmarkFrame = undefined;
    return;
  }

  if (usesSimpleDecodeWorker) {
    // The compatibility scalar decoder is reliable on native full frames, but
    // the modern reduced-acquisition → lattice-tracking handoff can leave it
    // repeatedly decoding geometry without collecting packets. Keep this
    // compatibility path deliberately simple: submit the same thorough frame
    // that the working Capture button uses whenever its sole worker is free.
    if (grab.width !== vw || grab.height !== vh) {
      grab.width = vw;
      grab.height = vh;
    }
    const ctx = grab.getContext("2d", { willReadFrequently: true })!;
    const img = source.image
      ? new ImageData(new Uint8ClampedArray(source.image.data), vw, vh)
      : (ctx.drawImage(video, 0, 0, vw, vh), ctx.getImageData(0, 0, vw, vh));
    inspectStaticQrOptics(source, img);
    captureSubmittedScan(img, 0, 0, true);
    const id = frameId++;
    if (submitReceiverJob(
      { id, buf: img.data.buffer, w: vw, h: vh, ox: 0, oy: 0, full: true, thorough: true },
      [img.data.buffer], "FULL FRAME", trace,
    )) {
      fullScans++;
      thoroughFullScans++;
      fullScanIds.add(id);
      fullScanJobs.set(id, { thorough: true, native: true, reacquire: false });
      scanCapturedAt.set(id, now);
      if (pendingScanCapture && pendingScanCapture.id === undefined) pendingScanCapture.id = id;
    } else if (pendingScanCapture?.id === undefined) {
      cancelScanCapture();
    }
    if (trace) trace.stateAfter = gridLattice.state;
    activeBenchmarkFrame = undefined;
    return;
  }

  for (let i = regions.length - 1; i >= 0; i--) {
    const region = regions[i]!;
    const ttl = region.decoded ? REGION_TTL_MS : SIGHTING_REGION_TTL_MS;
    if (region.gridSlot === undefined && now - region.seen > ttl) {
      regions.splice(i, 1);
      regionExpiries++;
      notePipelineEvent(region.decoded ? "region-decoded-expired" : "region-sighting-expired", regions.length);
    }
  }
  const latticeSnapshot = gridLattice.tick(now);
  if (latticeSnapshot) syncGrid(latticeSnapshot, now);
  else if (gridLattice.state === "REACQUIRE") {
    for (let i = regions.length - 1; i >= 0; i--) if (regions[i]!.gridSlot !== undefined) regions.splice(i, 1);
    gridShape = "";
  }
  // Decode confidence is separate from the lattice lock: undecoded slots stay
  // alive and search locally instead of disappearing from the global model.
  const live = decodedCount();
  peakRegions = Math.max(peakRegions, live);
  if (live >= expectedRegions || now - expectedRegionsAt > EXPECTED_REGIONS_DECAY_MS) {
    expectedRegions = live;
    expectedRegionsAt = now;
  }
  const visibleGridSlots = classifyGridSlots(vw, vh);
  if (trace) trace.predicted = visibleGridSlots.map((region) => ({
    slot: region.gridSlot!, state: region.slotState, quad: region.quad, submitted: false,
  }));
  const gridNeedsDiscovery = visibleGridSlots.some((region) =>
    !region.decoded || region.slotState === "LOST");
  const trackingUnhealthy = regions.some((region) => region.gridSlot === undefined && region.decoded && region.consecutiveMisses >= 4);
  gridLattice.noteMissing(gridNeedsDiscovery, now);
  const scanInterval =
    live === 0
      ? ACQUISITION_SCAN_MS
      : live < expectedRegions || trackingUnhealthy || gridNeedsDiscovery
        ? FULL_SCAN_DEGRADED_MS
        : FULL_SCAN_INTERVAL_MS;
  // A due full scan takes priority over crops, deliberately. The crop loop
  // below fills every free worker slot each frame, so any "only scan when a
  // slot is spare" politeness starves the rescan that reacquires a missing
  // code — tried, and it measurably worsened multi-code lock-on. Scans are
  // rare (1.5 s healthy, 250 ms degraded, 100 ms cold); crops keep the slot
  // next frame — including crops of probationary sighting regions, which now
  // run between cold scans instead of being crowded out by them.
  // Predicted crops are the fast path, never the only path. A single imperfect
  // anchor, display transition, or missed neighbor must not suppress global
  // reacquisition forever. Degraded grids rescan quickly; a healthy grid still
  // gets a sparse scan that can correct motion and discover every visible QR.
  // A requested diagnostic capture prefers the locked lattice crop, but only
  // when such a crop actually exists. The previous unconditional suppression
  // of full scans deadlocked Capture in SEARCH: no regions meant no crop job,
  // while captureNextScan itself prevented the full-frame job that could finish.
  const captureHasTrackedWork = gridLattice.active
    ? visibleGridSlots.some((region) => region.quad && region.dim && isGridDecodeCandidate(region) &&
      validTrackedQuad(region, vw, vh))
    : regions.some((region) => region.decoded && region.quad && region.dim && validTrackedQuad(region, vw, vh));
  const fullScanDue = captureNextScan
    ? !captureHasTrackedWork
    : now - lastFullScan > scanInterval;
  if (!fullScanDue && regions.length === 0) {
    schedulerNoJobs++;
    if (trace) { trace.decision = "full scan throttled"; trace.stateAfter = gridLattice.state; }
    activeBenchmarkFrame = undefined;
    return;
  }

  // Read back only the bounded work selected above. Full-frame RGBA is used
  // for sparse acquisition; healthy tracks copy QR-sized crops only.
  if (grab.width !== vw || grab.height !== vh) {
    grab.width = vw;
    grab.height = vh;
  }
  const ctx = grab.getContext("2d", { willReadFrequently: true })!;
  if (fullScanDue) {
    lastFullScan = now;
    fullScans++;
    const img = source.image
      ? new ImageData(new Uint8ClampedArray(source.image.data), vw, vh)
      : (ctx.drawImage(video, 0, 0), ctx.getImageData(0, 0, vw, vh));
    inspectStaticQrOptics(source, img);
    captureSubmittedScan(img, 0, 0, true);
    const id = frameId++;
    if (submitReceiverJob(
      { id, buf: img.data.buffer, w: vw, h: vh, ox: 0, oy: 0, full: true },
      [img.data.buffer], "FULL FRAME", trace,
    )) {
      if (pendingScanCapture && pendingScanCapture.id === undefined) pendingScanCapture.id = id;
    } else if (pendingScanCapture?.id === undefined) {
      cancelScanCapture();
    }
    if (trace) trace.stateAfter = gridLattice.state;
    activeBenchmarkFrame = undefined;
    return;
  }
  for (const region of regions) {
    if (region.gridSlot === undefined && region.decoded && region.quad && !validTrackedQuad(region, vw, vh)) invalidateTrackedQuad(region);
  }
  const batchRegions = (gridLattice.active
    ? visibleGridSlots.filter(isGridDecodeCandidate)
    : regions.filter((region) => region.decoded))
    .filter((region) => region.quad && region.dim && validTrackedQuad(region, vw, vh))
    .slice(0, 15);
  const batchTracks = batchRegions.map((region) => ({
    id: region.id, slot: region.gridSlot, misses: region.consecutiveMisses,
    quad: region.quad!, dim: region.dim!, crc32: Boolean(region.crc32),
  }));
  if (batchTracks.length > 1) {
    // One readback and one worker message per camera frame. Four independent
    // getImageData calls were stalling camera delivery even though the decode
    // workers were mostly idle.
    const points = batchTracks.flatMap((track) => [
      track.quad.topLeft, track.quad.topRight, track.quad.bottomRight, track.quad.bottomLeft,
    ]);
    const minX = Math.min(...points.map((point) => point.x));
    const minY = Math.min(...points.map((point) => point.y));
    const maxX = Math.max(...points.map((point) => point.x));
    const maxY = Math.max(...points.map((point) => point.y));
    const typicalEdge = Math.max(...batchRegions.map((region) => Math.max(region.w, region.h)));
    const worstMisses = Math.max(...batchRegions.map((region) => region.consecutiveMisses));
    // Padding is based on one QR, not the whole lattice. Grow it briefly under
    // motion so the fallback detector can re-anchor a shaking camera without
    // turning the normal locked crop back into a full-frame readback.
    const pad = Math.max(8, Math.round(typicalEdge * (0.18 + Math.min(0.3, worstMisses * 0.06))));
    // Padding outside the sensor is synthetic white and contains no recovery
    // information. Do not make the batch fallback search it: benchmark crops
    // were otherwise routinely larger than the native frame.
    const x = Math.max(0, Math.floor(minX - pad));
    const y = Math.max(0, Math.floor(minY - pad));
    const right = Math.min(vw, Math.ceil(maxX + pad));
    const bottom = Math.min(vh, Math.ceil(maxY + pad));
    const w = right - x;
    const h = bottom - y;
    if (w >= 32 && h >= 32) {
      const img = readBoundedVideoCrop(source, x, y, w, h);
      inspectStaticQrOptics(source, img, x, y);
      captureSubmittedScan(img, x, y, false, batchTracks.map((track) => track.quad));
      const id = frameId++;
      if (submitReceiverJob(
        { id, buf: img.data.buffer, w, h, ox: x, oy: y, full: false, tracks: batchTracks },
        [img.data.buffer], "SHARED TRACKED BATCH CROP", trace, batchRegions,
      )) {
        cropAttempts.set(id, batchRegions.map((region) => ({ region, quad: region.quad })));
        if (pendingScanCapture && pendingScanCapture.id === undefined) pendingScanCapture.id = id;
        cropsSubmitted += batchTracks.length;
      } else {
        if (pendingScanCapture?.id === undefined) cancelScanCapture();
        poolBusyTimes.push(now);
      }
    }
    cropRotate++;
    if (trace) trace.stateAfter = gridLattice.state;
    activeBenchmarkFrame = undefined;
    return;
  }

  // Rank only useful, fully visible lattice slots. The full sender layout is a
  // coordinate system, not a work list: offscreen, clipped, and undersampled
  // slots consume no worker time and do not count as failures.
  const eligible = gridLattice.active
    ? visibleGridSlots
      .filter(isGridDecodeCandidate)
      .sort((a, b) => slotUsefulness(b) - slotUsefulness(a))
    : [...regions];
  activeDecodeBudget = gridLattice.active ? Math.min(8, Math.max(4, pool.size * 2), eligible.length) : eligible.length;
  const scheduledRegions = eligible.slice(0, activeDecodeBudget);
  const trackedCapacity = Math.max(1, pool.size);
  const perRegionCapacity = Math.max(1, Math.floor(trackedCapacity / Math.max(1, scheduledRegions.length)));
  let submitted = false;
  for (let i = 0; i < scheduledRegions.length; i++) {
    const r = scheduledRegions[(i + cropRotate) % scheduledRegions.length]!;
    if (regionInflightCount(r) >= perRegionCapacity) continue;
    // The quad is the geometry actually passed to tracked decoding, so crop
    // around it—not the independently updated axis-aligned region box. A stale
    // box could otherwise clip half the QR while the search quad sat outside.
    const quadBounds = r.quad ? trackedQuadBounds(r.quad) : null;
    const left = quadBounds?.left ?? r.x;
    const top = quadBounds?.top ?? r.y;
    const right = quadBounds?.right ?? r.x + r.w;
    const bottom = quadBounds?.bottom ?? r.y + r.h;
    const size = Math.max(right - left, bottom - top);
    // Each missing slot widens only its own ROI. The global transform and all
    // successful slots remain fixed; expansion is capped before neighboring
    // finder patterns can dominate this crop.
    const missPad = r.gridSlot === undefined ? 0 : Math.min(0.9, r.consecutiveMisses * 0.08);
    const pad = Math.round(size * (REGION_PAD + missPad) + Math.min(size, 2 * (r.drift ?? 0)));
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
    if (!submitReceiverJob(
      { id, buf: img.data.buffer, w, h, ox: x, oy: y, full: false, quad: r.quad, dim: r.dim },
      [img.data.buffer], "INDIVIDUAL TRACKED CROP", trace, [r],
    )) {
      cropAttempts.delete(id);
      if (pendingScanCapture?.id === undefined) cancelScanCapture();
      poolBusyTimes.push(receiverNow());
      break;
    }
    if (pendingScanCapture && pendingScanCapture.id === undefined) pendingScanCapture.id = id;
    cropsSubmitted++;
    submitted = true;
  }
  // Being blocked by per-track limits is scanner saturation too.
  if (!submitted && scheduledRegions.length > 0) {
    poolBusyTimes.push(now);
    if (trace && !trace.jobs.length) trace.decision = "not scheduled: in-flight track limit";
  }
  cropRotate++;
  if (trace) trace.stateAfter = gridLattice.state;
  activeBenchmarkFrame = undefined;
}

function resetActiveTransfer(): void {
  // Transfer/protocol boundaries do not imply an optical change. Keep the
  // committed camera lock across them.
  releaseTransportDecoder();
  streamKey = "";
  reportStreamId = 0;
  startTs = 0;
  regions.length = 0;
  gridLattice.reset();
  gridShape = "";
  lastGridSnapshot = undefined;
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
  currentScanningState = "SEARCH";
  lastFullScan = 0;
  minimumAcceptedScanId = frameId;
  qrReadTimes.length = 0;
  usefulFrameTimes.length = 0;
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

function onDecoded(bytes: Uint8Array, box?: SymbolBox, info?: SymbolInfo) {
  if (info?.scanId !== undefined && info.scanId < minimumAcceptedScanId) {
    noteScanOutcome(info.scanId, "stale");
    return;
  }
  totalDecodes++;
  if (info?.tracked) trackedDecodes++;
  const decodedAt = receiverNow();
  if (done) return;
  qrReadTimes.push(decodedAt);
  const parsed = parseFrame(bytes);
  if (!parsed) {
    noteScanOutcome(info?.scanId, "rejected");
    // Finder-pattern sightings and arbitrary binary decodes never become
    // tracks. A fully decoded UTF-8 QR may still be a standard plain snippet.
    if (decoder) return;
    try {
      const text = plainQrDecoder.decode(bytes);
      if (box) noteRegion(box, decodedAt, true, info);
      const settled = plainQrPolicy.addPlain(text, info?.scanId ?? -1);
      if (settled) finishPlainQr(settled);
    } catch {
      // Non-text binary QR content is not a plain snippet or AirGapper frame.
    }
    return;
  }
  const { header, block } = parsed;
  focusController.noteValidDecode(info?.scanId);
  const evidence = candidateEvidence;
  if (evidence && info?.scanId !== undefined && info.scanId >= evidence.boundary) evidence.validDecodes++;
  const productionTrace = info?.scanId === undefined ? undefined : benchmarkJobFrames.get(info.scanId);
  if (productionTrace) productionTrace.decoded.push({
    slot: header.slotIndex, esi: header.seq, bytes: header.blockLen, quad: info?.quad,
  });
  const identity = streamIdentity(header);
  // A live stream is sticky against stray codes and out-of-order worker
  // replies, but after it has been optically silent a valid packet from a new
  // sender or layout starts a clean transfer. Sender settings restart with a
  // new session, so layout changes recover without reloading the receiver.
  if (decoder && streamKey !== identity) {
    if (decodedAt - lastStreamDecodeAt < 1800) {
      noteScanOutcome(info?.scanId, "otherStream");
      return;
    }
    resetActiveTransfer();
  }
  lastStreamDecodeAt = decodedAt;

  plainQrPolicy.noteFramed();
  let decodedRegion: Region | undefined;
  if (box && info?.quad && info.modules) {
    const priorBenchmarkFrame = activeBenchmarkFrame;
    if (productionTrace) activeBenchmarkFrame = productionTrace;
    const snapshot = gridLattice.accept({
      identity,
      layoutId: header.layoutId,
      slotIndex: header.slotIndex,
      at: info.scanId === undefined ? decodedAt : (scanCapturedAt.get(info.scanId) ?? decodedAt),
      scanId: info.scanId ?? -1,
      box,
      quad: info.quad,
      modules: info.modules,
    }, receiverFrameWidth, receiverFrameHeight);
    if (snapshot) {
      decodedRegion = syncGrid(
        snapshot,
        decodedAt,
        header.slotIndex,
        { ...info, crc32: true },
      );
    }
    if (productionTrace) productionTrace.stateAfter = gridLattice.state;
    activeBenchmarkFrame = priorBenchmarkFrame;
  }
  if (decodedRegion) noteSequence(decodedRegion, header.seq, decodedAt);

  // streamIdentity() covers every invariant header field. parseFrame has
  // already checked magic, lengths, field ranges and CRC before this point.
  if (!decoder) {
    decoder = new TransportDecoder(header.k, header.blockLen, header.payloadId, header.totalLen);
    usefulFrameTimes.length = 0;
    streamKey = identity;
    reportStreamId = header.payloadId;
    startTs = receiverNow();
    progressEl.style.display = "block";
    progressStatus.style.display = "block";
  }
  const framesNewBefore = decoder.framesNew;
  const usefulBefore = decoder.usefulSymbols;
  const redundantBefore = decoder.framesRedundant;
  decoder.addFrame(header.seq, block);
  const receivedAt = receiverNow();
  noteScanOutcome(
    info?.scanId,
    decoder.framesNew === framesNewBefore
      ? "duplicate"
      : decoder.framesRedundant > redundantBefore ? "redundant" : "accepted",
  );
  if (decoder.framesNew > framesNewBefore) {
    if (lastDistinctArrivalAt) maxSequenceGapMs = Math.max(maxSequenceGapMs, receivedAt - lastDistinctArrivalAt);
    lastDistinctArrivalAt = receivedAt;
  }
  if (decoder.usefulSymbols > usefulBefore) {
    const added = decoder.usefulSymbols - usefulBefore;
    totalUsefulSymbols += added;
    usefulFrameTimes.push(receivedAt);
    focusController.noteUsefulDecode(info?.scanId);
    if (candidateEvidence && info?.scanId !== undefined && info.scanId >= candidateEvidence.boundary) candidateEvidence.usefulSymbols += added;
  }
  updateProgressEstimate();

  if (decoder.isComplete && replayRunning) {
    if (!benchmarkCompletionChecked) {
      benchmarkCompletionChecked = true;
      const payload = decoder.assemble()!;
      if (fnv1a(payload) === header.payloadId) benchmarkVerifiedBytes = header.totalLen;
    }
  } else if (decoder.isComplete) {
    const payload = decoder.assemble()!;
    const seconds = (receiverNow() - startTs) / 1000;
    const ok = fnv1a(payload) === header.payloadId;
    void finish(payload, ok, seconds);
  }
}

function updateProgressEstimate() {
  if (!decoder) return;
  const elapsed = Math.max(0, (receiverNow() - startTs) / 1000);
  // Progress runs on coding innovation, not successful QR decodes. MDS uses
  // exact matrix rank; RaptorQ discounts duplicate and failed-rank symbols.
  const usefulFrames = decoder.usefulSymbols;
  const estimate = estimateTransferProgress(
    decoder.k,
    usefulFrames,
    elapsed,
    decoder.solvedCount,
    decoder.mode,
  );
  const percent = estimate.fraction * 100;
  const shownPercent = percent < 10 ? percent.toFixed(1) : percent.toFixed(0);
  bar.style.width = `${percent.toFixed(1)}%`;
  progressEl.setAttribute("aria-valuenow", String(Math.floor(percent)));
  progressLabel.textContent = `${shownPercent}%`;
  const remainingBytes = Math.max(1, Math.ceil(decoder.totalLen * (1 - estimate.fraction)));
  transferSizeLabel.textContent = formatBytes(remainingBytes);
  const liveKbs = liveGoodputKbs(receiverNow());
  const liveUsefulFps = liveKbs > 0
    ? liveKbs * 1024 * expectedCodingOverhead(decoder.mode) / decoder.blockLen
    : 0;
  etaLabel.textContent = liveUsefulFps > 0 && usefulFrames >= 3
    ? `${formatDuration(estimate.remainingFrames / liveUsefulFps)} left`
    : "";
}

/** Plain text is the complete standard QR payload. It deliberately has no
 * AirGapper container or SHA-256; files never take this path. */
function finishPlainQr(text: string): void {
  done = true;
  focusController.detach();
  cancelScanCapture();
  if (scanDialog.open) scanDialog.close();
  releaseScreenWakeLock();
  captureGen++;
  stream?.getTracks().forEach((track) => track.stop());
  clearInterval(statsTimer);
  statsTimer = undefined;
  pool.resize(0);
  preview.style.display = "none";
  metricsEl.style.display = "none";
  document.body.classList.add("receive-complete");
  document.body.classList.remove("receive-mode");
  setStatus("");
  showSnippet(text);
}

/** One-second information goodput for live aiming feedback. The completed
 * transfer reports the transmitted payload bytes divided by total time. */
function liveGoodputKbs(now: number): number {
  while (usefulFrameTimes.length && usefulFrameTimes[0]! <= now - STATS_WINDOW_MS) {
    usefulFrameTimes.shift();
  }
  if (!decoder || !usefulFrameTimes.length) return 0;
  return usefulFrameTimes.length * decoder.blockLen /
    expectedCodingOverhead(decoder.mode) / 1024 / (STATS_WINDOW_MS / 1000);
}

async function finish(container: Uint8Array, hashOk: boolean, seconds: number) {
  done = true;
  const cameraAutomationDiagnostics = focusController.diagnostics();
  focusController.detach();
  cancelScanCapture();
  if (scanDialog.open) scanDialog.close();
  releaseScreenWakeLock();
  const finishGen = ++captureGen;
  // Snapshot diagnostics before teardown, but do not report success until the
  // recovered output passes SHA-256.
  let diagnosticsBase: Record<string, unknown> | null = null;
  if (import.meta.env.DEV && import.meta.env.VITE_DIAGNOSTICS === "1") {
    const track = stream?.getVideoTracks()[0];
    const camera = track?.getSettings();
    diagnosticsBase = {
      role: "receiver",
      when: new Date().toISOString(),
      streamId: reportStreamId,
      acquisitionSeconds: cameraStartedTs ? Number(((startTs - cameraStartedTs) / 1000).toFixed(2)) : null,
      payloadSha256: [...container.slice(9, 41)].map((b) => b.toString(16).padStart(2, "0")).join(""),
      transport: {
        mode: decoder?.mode,
        k: decoder?.k,
        blockLen: decoder?.blockLen,
        framesNew: decoder?.framesNew,
        framesDup: decoder?.framesDup,
        framesRedundant: decoder?.framesRedundant,
        innovativeSymbols: decoder?.usefulSymbols,
        sourceRank: decoder?.mode === "mds" ? decoder.solvedCount : null,
        solvedBlocks: decoder?.mode === "raptorq" ? decoder.solvedCount : null,
        overhead: decoder ? Number((decoder.framesNew / decoder.k).toFixed(2)) : null,
        usefulOverhead: decoder ? Number((decoder.usefulSymbols / decoder.k).toFixed(2)) : null,
        innovationRate: decoder?.framesNew
          ? Number((decoder.usefulSymbols / decoder.framesNew).toFixed(3))
          : null,
      },
      codes: peakRegions,
      grid: lastGridSnapshot ? {
        senderLayout: `${lastGridSnapshot.layout.cols}x${lastGridSnapshot.layout.rows}`,
        state: lastGridSnapshot.state,
        confidence: Number(lastGridSnapshot.confidence.toFixed(3)),
        totalSlots: regions.filter((region) => region.gridSlot !== undefined).length,
        visibleSlots: regions.filter((region) => region.gridSlot !== undefined && region.slotState !== "OFFSCREEN").length,
        activeDecodeSlots: activeDecodeBudget,
        offscreenSlots: regions.filter((region) => region.slotState === "OFFSCREEN").length,
        partialSlots: regions.filter((region) => region.slotState === "PARTIAL").length,
        bestVisible: regions.filter((region) => region.slotState === "ACTIVE")
          .sort((a, b) => slotUsefulness(b) - slotUsefulness(a)).slice(0, activeDecodeBudget).map((region) => region.gridSlot),
        averagePixelsPerModule: (() => {
          const active = regions.filter((region) => region.slotState === "ACTIVE");
          return active.length ? Number((active.reduce((sum, region) => sum + region.pixelsPerModule, 0) / active.length).toFixed(2)) : 0;
        })(),
        decodeBudget: activeDecodeBudget,
        verifiedKbs: Number(liveGoodputKbs(receiverNow()).toFixed(2)),
      } : null,
      pipeline: {
        captureMode: "bounded-rgba-crops",
        captures: totalCaptures,
        capturesDroppedPoolBusy: capturesDropped,
        cropsSubmitted,
        submittedJobs,
        completedJobs,
        fullScans,
        cheapFullScans,
        thoroughFullScans,
        lastFullScanLatencyMs: Number(lastFullLatencyMs.toFixed(1)),
        averageFullScanLatencyMs: fullLatencyCount ? Number((fullLatencyTotalMs / fullLatencyCount).toFixed(1)) : 0,
        localReacquisitions,
        globalReacquisitions,
        scanningState: currentScanningState,
        decodes: totalDecodes,
        trackedAttempts,
        trackedDecodes,
        trackedHitRate: trackedAttempts ? Number((trackedDecodes / trackedAttempts).toFixed(3)) : 0,
        trackedMissFallbacks,
        schedulerNoJobs,
        cropMisses,
        fullDetectorMisses,
        fullSightings,
        decodeExceptions,
        regionCreations,
        regionExpiries,
        trackingInvalidations,
        zeroRegionMs,
        degradedMs,
        maxSequenceGapMs: Number(maxSequenceGapMs.toFixed(1)),
        workerJobs: completedJobs,
        workerLatencyMeanMs: completedJobs ? Number((workerLatencyTotalMs / completedJobs).toFixed(1)) : 0,
        workerLatencyMaxMs: Number(workerLatencyMaxMs.toFixed(1)),
        events: pipelineEvents,
      },
      workers: pool.size,
      requested: {
        width: requestedWidth,
        height: requestedHeight,
        fps: requestedFps ?? "auto",
        workers: selectedWorkerCount(),
        workerSetting: decodeWorkers.value,
      },
      camera: camera ? { width: camera.width, height: camera.height, fps: camera.frameRate, facingMode: camera.facingMode ?? null } : null,
      cameraAutomation: cameraAutomationDiagnostics,
      cameraCapabilities: track ? probeCameraCapabilities(track) : null,
      device: { cores: navigator.hardwareConcurrency ?? null, ua: navigator.userAgent },
      timelineKey: "seconds, framesNew, solvedBlocks, decodedRegions, trackedRegions, captureFps, decodeFps, fullScansCumulative",
      timeline,
    };
  }
  let diagnosticsSent = false;
  const sendDiagnostics = (ok: boolean, finalSeconds: number, uniqueBytes: number) => {
    if (!diagnosticsBase || diagnosticsSent) return;
    diagnosticsSent = true;
    void fetch("/__diagnostics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...diagnosticsBase,
        ok,
        sha256Verified: ok,
        seconds: Number(finalSeconds.toFixed(2)),
        payloadBytes: uniqueBytes,
        goodputKBs: ok ? Number(completedGoodputKbs(uniqueBytes, finalSeconds).toFixed(1)) : 0,
      }),
    }).catch(() => undefined);
  };
  // Tear the whole capture pipeline down: the camera, the stats timer, and the
  // decode pool. Each worker holds its own ~940 KB zxing WASM instance, which
  // is worth reclaiming on a phone the moment the last frame is in.
  stream?.getTracks().forEach((t) => t.stop());
  clearInterval(statsTimer);
  statsTimer = undefined;
  pool.resize(0);
  preview.style.display = "none";
  // The metrics stay, frozen at their last tick — but "Live" is no longer
  // true, so the panel relabels itself as the record of the run it now is.
  const diagnosticsLabel = diagnosticsEl?.querySelector("summary");
  if (diagnosticsLabel) diagnosticsLabel.textContent = "Transfer summary";
  bar.style.width = "100%";
  progressEl.setAttribute("aria-valuenow", "100");
  transferSizeLabel.textContent = "";
  etaLabel.textContent = `${formatDuration(seconds)} total`;
  try {
    if (!hashOk) throw new Error("The optical stream checksum did not match.");
    const file = await unpackFile(container);
    if (!(await verifyFile(file))) throw new Error("The recovered file failed SHA-256 verification.");
    if (finishGen !== captureGen) {
      file.bytes.fill(0);
      return;
    }
    seconds = (receiverNow() - startTs) / 1000;
    document.body.classList.add("receive-complete");
    // Restore the root scroller so mobile browsers can use their normal
    // pull-to-refresh gesture on the completed screen.
    document.body.classList.remove("receive-mode");
    transferSizeLabel.textContent = "";
    etaLabel.textContent = `${formatBytes(file.transmittedSize)} · ${formatDuration(seconds)}`;
    pipelineMetrics.style.display = "none";
    sendDiagnostics(true, seconds, file.bytes.length);

    // The container carries its own media type, so the receiver never has to be
    // told in advance whether a file or a text snippet is coming. Report the
    // bytes that actually crossed the optical link, compressed when gzip won.
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
    sendDiagnostics(false, (receiverNow() - startTs) / 1000, 0);
    // Everything is already torn down by this point, so the only way back to a
    // live receiver is a reload. Offer it: a failed checksum used to leave the
    // page dead with nothing but an error string on it.
    bar.classList.add("error");
    etaLabel.textContent = "Transfer failed";
    speedFeedback.className = "speed-feedback speed-low";
    showError(error instanceof Error ? error.message : String(error));
    const heading = document.createElement("div");
    heading.className = "failed";
    heading.textContent = "Transfer failed";
    const detail = document.createElement("p");
    detail.className = "received-note";
    detail.textContent =
      "Nothing usable came out of that stream. Restart the sender, then scan it again — " +
      "a partial transfer costs nothing but the time.";
    result.replaceChildren(heading, detail, restartButton("Try again"));
  } finally {
    releaseTransportDecoder();
    container.fill(0);
  }
}

const MIME_BY_EXTENSION: Record<string, string> = {
  apng: "image/apng", gif: "image/gif", jpeg: "image/jpeg", jpg: "image/jpeg",
  png: "image/png", svg: "image/svg+xml", webp: "image/webp",
  mp3: "audio/mpeg", m4a: "audio/mp4", oga: "audio/ogg", ogg: "audio/ogg", wav: "audio/wav",
  m4v: "video/mp4", mov: "video/quicktime", mp4: "video/mp4", ogv: "video/ogg", webm: "video/webm",
  css: "text/css", csv: "text/csv", html: "text/html", json: "application/json",
  md: "text/markdown", pdf: "application/pdf", txt: "text/plain", zip: "application/zip",
};

function inferredType(name: string): string {
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

function downloadLink(name: string, type: string, bytes: Uint8Array, label = `Save ${name}`): HTMLAnchorElement {
  const link = document.createElement("a");
  link.className = "download";
  link.href = receivedObjectUrl(new Blob([bytes as BlobPart], { type }));
  link.download = name;
  link.textContent = label;
  link.addEventListener("click", (event) => {
    if (!saveFileOnAndroid(name, type, bytes)) return;
    event.preventDefault();
  });
  return link;
}

async function appendReceivedFile(
  entry: ZipEntry,
  parent: HTMLElement,
  declaredType?: string,
  autoplayVideo = false,
): Promise<void> {
  const dataGeneration = receivedDataGeneration;
  const type = declaredType || inferredType(entry.name);
  const container = document.createElement("section");
  container.className = "received-file";
  const url = receivedObjectUrl(new Blob([entry.bytes as BlobPart], { type }));
  let receivedVideo: HTMLVideoElement | undefined;
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
    if (src !== url) player.addEventListener("error", () => { player.src = url; }, { once: true });
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
      // Browsers commonly require muted playback when transfer completion is
      // too far removed from the original user gesture.
      receivedVideo.muted = true;
      await receivedVideo.play().catch(() => undefined);
    });
  }
}

function enableMediaInspection(media: HTMLImageElement | HTMLVideoElement): void {
  media.classList.add("inspectable");
  media.tabIndex = 0;
  media.title = media instanceof HTMLImageElement ? "Tap to view and zoom" : "Tap to view full screen";

  const open = async (): Promise<void> => {
    if (media instanceof HTMLVideoElement) {
      const iosVideo = media as HTMLVideoElement & { webkitEnterFullscreen?: () => void };
      if (!media.requestFullscreen && iosVideo.webkitEnterFullscreen) iosVideo.webkitEnterFullscreen();
      else if (media.requestFullscreen) await media.requestFullscreen().catch(() => undefined);
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
    const pointers = new Map<number, { x: number; y: number }>();
    const render = (): void => {
      media.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px) scale(${scale})`;
    };
    const zoomAt = (nextScale: number, clientX: number, clientY: number): void => {
      const clamped = Math.max(1, Math.min(6, nextScale));
      const ratio = clamped / scale;
      x = clientX - innerWidth / 2 - (clientX - innerWidth / 2 - x) * ratio;
      y = clientY - innerHeight / 2 - (clientY - innerHeight / 2 - y) * ratio;
      scale = clamped;
      if (scale === 1) x = y = 0;
      render();
    };
    const close = (): void => {
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
      const previous = pointers.get(event.pointerId);
      if (!previous) return;
      if (pointers.size === 1) {
        if (scale > 1) { x += event.clientX - previous.x; y += event.clientY - previous.y; render(); }
      } else {
        const other = [...pointers.entries()].find(([id]) => id !== event.pointerId)?.[1];
        if (other) {
          const oldDistance = Math.hypot(previous.x - other.x, previous.y - other.y);
          const newDistance = Math.hypot(event.clientX - other.x, event.clientY - other.y);
          zoomAt(scale * newDistance / Math.max(1, oldDistance), (event.clientX + other.x) / 2, (event.clientY + other.y) / 2);
        }
      }
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    });
    const releasePointer = (event: PointerEvent): void => {
      pointers.delete(event.pointerId);
      if (!pointers.size) media.classList.remove("dragging");
    };
    inspector.addEventListener("pointerup", releasePointer);
    inspector.addEventListener("pointercancel", releasePointer);
    inspector.addEventListener("wheel", (event) => {
      event.preventDefault();
      zoomAt(scale * Math.exp(-event.deltaY * .002), event.clientX, event.clientY);
    }, { passive: false });
    inspector.addEventListener("dblclick", (event) => zoomAt(scale > 1 ? 1 : 2.5, event.clientX, event.clientY));
  };
  media.addEventListener("click", () => void open());
  media.addEventListener("keydown", (event) => {
    if (!(event instanceof KeyboardEvent) || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    void open();
  });
}

/** A playable URL for received media. iOS Safari will not reliably play media
 *  handed to <video>/<audio> as a blob: URL — WebKit's media loader wants real
 *  HTTP semantics, Range requests included (a lesson inherited from the
 *  baseline receiver's range-shim worker). The bytes go into the Cache API and
 *  come back out through the service worker's range-aware route at a real URL
 *  (see runtimeCaching in vite.config.ts). The blob URL stands in when no
 *  worker controls the page: first ever visit, or the standalone file. */
async function servableMediaUrl(bytes: Uint8Array, type: string, blobUrl: string): Promise<string> {
  try {
    if (!navigator.serviceWorker?.controller) return blobUrl;
    // Resolved against the page (one directory deep), landing on the site
    // root — where the worker's route matches under any deploy subpath. Each
    // received file gets its own path so several media players can coexist.
    const target = new URL(`../received-media/${Date.now()}-${Math.random().toString(36).slice(2)}`, window.location.href).href;
    const cache = await caches.open(RECEIVED_MEDIA_CACHE);
    await cache.put(
      target,
      new Response(new Blob([bytes as BlobPart]), {
        headers: {
          "Content-Type": type,
          "Content-Length": String(bytes.length),
        },
      }),
    );
    // The query defeats the media element's memory of this URL from an
    // earlier transfer; the worker matches with ignoreSearch.
    return `${target}?v=${Date.now()}`;
  } catch {
    return blobUrl;
  }
}

const SNIPPET_LINK = /(?:https?:\/\/|www\.)[^\s<>]+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gi;
const TRAILING_LINK_PUNCTUATION = /[.,;:!?\])}]+$/;

/** Add only text nodes and narrowly validated anchors; received text is never
 * interpreted as HTML. This keeps links useful without making snippets an
 * injection path. */
function appendLinkifiedText(parent: HTMLElement, text: string): void {
  SNIPPET_LINK.lastIndex = 0;
  let cursor = 0;
  for (let match = SNIPPET_LINK.exec(text); match; match = SNIPPET_LINK.exec(text)) {
    const candidate = match[0].replace(TRAILING_LINK_PUNCTUATION, "");
    if (!candidate) continue;
    parent.append(document.createTextNode(text.slice(cursor, match.index)));
    const isEmail = /^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/.test(candidate);
    const href = isEmail
      ? `mailto:${candidate}`
      : candidate.toLowerCase().startsWith("www.") ? `https://${candidate}` : candidate;
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

/** Nothing is persisted: the text lives here until the page is closed. */
function showSnippet(text: string) {
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
      setTimeout(() => { copy.textContent = "Copy"; }, 1500);
    } catch {
      copy.textContent = "Copy failed";
    }
  });
  actions.append(copy);

  result.replaceChildren(body, actions);
}

function speedQualityClass(rate: number): string {
  return rate < 5
    ? "speed-low"
    : rate < 25
      ? "speed-mid"
      : rate < 75
        ? "speed-good"
        : "speed-high";
}

recordCorpusBtn.addEventListener("click", () => {
  if (benchmarkRecorder) {
    void finishCorpusRecording(benchmarkRecorder);
    return;
  }
  const track = stream?.getVideoTracks()[0];
  if (!track || !video.videoWidth || !video.videoHeight) {
    showError("Start the camera before recording.");
    return;
  }
  const version = document.querySelector(".app-version")?.textContent?.replace(/^v/, "") ?? "unknown";
  benchmarkRecordingSequence = 0;
  benchmarkRecorder = new AgcapRecorder(7000, {
    width: video.videoWidth, height: video.videoHeight, stride: video.videoWidth * 4,
    orientation: screen.orientation?.type ?? `${window.orientation ?? 0}`,
    cameraSettings: track.getSettings(), airgapperVersion: version, userAgent: navigator.userAgent,
  });
  benchmarkCorpus = undefined;
  benchmarkPendingBlob = undefined;
  recordCorpusBtn.textContent = "Stop · 7s";
  setStatus("Recording lossless frames… decoding paused");
});
loadCorpusBtn.addEventListener("click", () => corpusFile.click());
corpusFile.addEventListener("change", async () => {
  const file = corpusFile.files?.[0];
  if (!file) return;
  try {
    benchmarkStatus.textContent = "Loading lossless corpus…";
    if (!benchmarkDialog.open) benchmarkDialog.showModal();
    benchmarkCorpus = await AgcapCorpus.load(file);
    benchmarkPendingBlob = undefined;
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
  if (!benchmarkResult) return;
  const blob = new Blob([JSON.stringify(benchmarkResult, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  const header = benchmarkCorpus?.header;
  const device = header ? compactDeviceName(header) : "Dunk";
  const mode = replayMode.value === "maximum" ? "max" : "dp";
  const version = compactVersionName(String(benchmarkResult.version ?? "v0"));
  link.download = `bm-${device}-${version}-${mode}-${compactTimeName(new Date())}.json`;
  link.click();
  saveBenchmarkBtn.textContent = "Downloaded";
  setTimeout(() => {
    URL.revokeObjectURL(link.href);
    saveBenchmarkBtn.textContent = "Save results";
  }, 1500);
});

function waitForWorkers(): Promise<void> {
  return new Promise((resolve) => {
    const poll = () => pool.busyCount ? setTimeout(poll, 10) : resolve();
    poll();
  });
}

interface OracleMessage {
  id: number;
  symbols?: { bytes: Uint8Array; quad?: SymbolQuad; modules?: number }[];
  latencyMs?: number;
  error?: string;
}

interface SavedBenchmarkReference {
  sequence: number;
  reference: { slot?: number; esi: number; quad?: SymbolQuad }[];
}

interface SavedBenchmarkReferenceSet {
  corpus: { width: number; height: number; startedAt: string; framesStored: number };
  frames: SavedBenchmarkReference[];
}

declare global {
  interface Window { __airgapperBenchmarkReference?: SavedBenchmarkReferenceSet }
}

async function runOracle(corpus: AgcapCorpus): Promise<number[]> {
  type OracleSeed = { quad: SymbolQuad; modules: number; layoutId: number; slot: number };
  const latencies: number[] = [];
  const firstPass: OracleMessage[] = new Array(corpus.length);

  const runPass = async (label: string, seedsFor: (index: number) => OracleSeed[], saveReplies: boolean) => {
    const workers = Array.from(
      { length: Math.min(corpus.length, selectedWorkerCount()) },
      () => createDecodeWorker(),
    );
    let nextIndex = 0;
    let completed = 0;
    try {
      await Promise.all(workers.map(async (worker) => {
        while (nextIndex < corpus.length) {
          const index = nextIndex++;
          const frame = await corpus.frame(index);
          const reply = await new Promise<OracleMessage>((resolve, reject) => {
            const id = (saveReplies ? 1_000_000 : 2_000_000) + index;
            worker.onmessage = (event: MessageEvent<OracleMessage>) => {
              if (event.data.id === -1) return;
              if (event.data.id === id) resolve(event.data);
            };
            worker.onerror = (event) => reject(new Error(event.message || "Reference worker failed"));
            const pixels = frame.rgba.slice();
            worker.postMessage({
              id, oracle: true, oracleSeeds: seedsFor(index), full: true,
              buf: pixels.buffer, w: frame.meta.width, h: frame.meta.height,
            }, [pixels.buffer]);
          });
          if (reply.error) throw new Error(reply.error);
          latencies.push(reply.latencyMs ?? 0);
          if (saveReplies) firstPass[index] = reply;
          const trace = benchmarkTraces[index];
          if (trace) {
            const known = new Set(trace.reference.map((item) => item.esi));
            for (const symbol of reply.symbols ?? []) {
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
  const templates = firstPass.flatMap((reply, index) => (reply?.symbols ?? []).flatMap((symbol) => {
    const parsed = parseFrame(symbol.bytes);
    const layoutId = parsed?.header.layoutId;
    const slot = parsed?.header.slotIndex;
    return symbol.quad && symbol.modules && layoutId !== undefined && slot !== undefined
      ? [{ index, seed: { quad: symbol.quad, modules: symbol.modules, layoutId, slot } }]
      : [];
  }));
  if (templates.length) {
    await runPass("Reference refine", (index) => {
      let nearest = templates[0]!;
      for (const template of templates) {
        if (Math.abs(template.index - index) < Math.abs(nearest.index - index)) nearest = template;
      }
      return [nearest.seed];
    }, false);
  }
  return latencies;
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))]!;
}

function missedReason(trace: BenchmarkFrameTrace, slot: number | undefined): string {
  if (trace.decision === "worker busy") return "worker busy";
  const predicted = trace.predicted.find((item) => item.slot === slot);
  if (predicted?.state === "OFFSCREEN") return "offscreen threshold";
  if (!trace.jobs.length) return trace.decision;
  if (trace.jobs.some((job) => job.kind === "FULL FRAME")) return "full-frame decoder miss";
  if (predicted && !predicted.submitted) return predicted.state === "PARTIAL" ? "partial/offscreen threshold" : "skipped predicted track";
  const submitted = trace.jobs.some((job) => slot !== undefined && job.tracks.includes(slot));
  if (!submitted && trace.jobs.some((job) => job.kind !== "FULL FRAME")) return "crop excluded slot";
  if (trace.jobs.some((job) => job.trackedMisses)) {
    return trace.jobs.some((job) => job.fallbackAttempts && !job.fallbackSuccesses) ? "tracked sampler failed; fallback failed" : "tracked sampler failed";
  }
  return "decoder miss";
}

async function inspectBenchmarkFrame(index: number): Promise<void> {
  if (!benchmarkCorpus) return;
  const frame = await benchmarkCorpus.frame(index);
  const trace = benchmarkTraces[index]!;
  benchmarkFrame.width = frame.meta.width;
  benchmarkFrame.height = frame.meta.height;
  const ctx = benchmarkFrame.getContext("2d")!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(frame.rgba), frame.meta.width, frame.meta.height), 0, 0);
  const quad = (value: SymbolQuad | undefined, color: string, width: number) => {
    if (!value) return;
    const points = [value.topLeft, value.topRight, value.bottomRight, value.bottomLeft];
    ctx.beginPath();
    points.forEach((point, i) => i ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
    ctx.closePath(); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
  };
  for (const job of trace.jobs) { ctx.strokeStyle = "#f2a51a"; ctx.lineWidth = 3; ctx.strokeRect(job.x, job.y, job.width, job.height); }
  for (const sighting of trace.sightings) { ctx.strokeStyle = "#b87500"; ctx.lineWidth = 3; ctx.strokeRect(sighting.x, sighting.y, sighting.w, sighting.h); }
  for (const item of trace.predicted) quad(item.quad, item.submitted ? "#248cff" : "#777", 3);
  for (const item of trace.decoded) quad(item.quad, "#20c969", 5);
  for (const item of trace.reference) quad(item.quad, "#e43d3d", 5);
  const production = new Set(trace.decoded.map((item) => item.esi));
  const missed = trace.reference.filter((item) => !production.has(item.esi));
  benchmarkFrameStatus.textContent = `frame ${trace.sequence} · ${trace.stateBefore} → ${trace.stateAfter} · ${trace.decision} · missed ${missed.map((item) => `${item.slot ?? "?"}: ${missedReason(trace, item.slot)}`).join(", ") || "none"}`;
}

async function runReceiverBenchmark(): Promise<void> {
  if (replayRunning) return;
  runBenchmarkBtn.disabled = true;
  saveBenchmarkBtn.disabled = true;
  saveBenchmarkBtn.textContent = "Save results";
  benchmarkResult = undefined;
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
  const firstTime = corpus.meta(0)?.callbackTimeMs ?? 0;
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
        sequence: frame.meta.sequence, width: frame.meta.width, height: frame.meta.height,
        callbackTimeMs: frame.meta.callbackTimeMs, mediaTimeMs: frame.meta.mediaTimeMs,
        presentationTimeMs: frame.meta.presentationTimeMs, expectedDisplayTimeMs: frame.meta.expectedDisplayTimeMs,
        image: new ImageData(new Uint8ClampedArray(frame.rgba), frame.meta.width, frame.meta.height),
      });
    }
    await waitForWorkers();
    const savedReference = window.__airgapperBenchmarkReference;
    const savedCorpus = savedReference?.corpus;
    const savedFrames = savedReference?.frames;
    let oracleLatencies: number[] = [];
    if (savedCorpus?.width === corpus.header.width && savedCorpus.height === corpus.header.height &&
        savedCorpus.startedAt === corpus.header.startedAt && savedCorpus.framesStored === corpus.header.framesStored &&
        savedFrames?.length === benchmarkTraces.length && savedFrames.every((item, index) => item.sequence === benchmarkTraces[index]!.sequence)) {
      for (let index = 0; index < benchmarkTraces.length; index++) {
        benchmarkTraces[index]!.reference = savedFrames[index]!.reference;
      }
      benchmarkStatus.textContent = "Reference map reused";
    } else {
      oracleLatencies = await runOracle(corpus);
    }
    // The reference is a lower bound, not ground truth: every protocol-valid
    // production packet is direct proof that a QR was available in that frame.
    // Fold those discoveries back into the map so a stronger production path
    // improves the corpus oracle instead of being mislabeled as an "extra".
    for (const trace of benchmarkTraces) {
      const known = new Set(trace.reference.map((item) => item.esi));
      for (const packet of trace.decoded) {
        if (known.has(packet.esi)) continue;
        known.add(packet.esi);
        trace.reference.push({ slot: packet.slot, esi: packet.esi, quad: packet.quad });
      }
    }
    const durationSeconds = Math.max(0.001, ((corpus.meta(corpus.length - 1)?.callbackTimeMs ?? firstTime) - firstTime) / 1000);
    const productionPackets = benchmarkTraces.flatMap((trace) => trace.decoded);
    const opportunities = benchmarkTraces.reduce((sum, trace) => sum + new Set(trace.reference.map((item) => item.esi)).size, 0);
    const captured = benchmarkTraces.reduce((sum, trace) => {
      const production = new Set(trace.decoded.map((item) => item.esi));
      return sum + new Set(trace.reference.filter((item) => production.has(item.esi)).map((item) => item.esi)).size;
    }, 0);
    const jobs = benchmarkTraces.flatMap((trace) => trace.jobs);
    const decodeLatencies = jobs.flatMap((job) => job.decodeMs === undefined ? [] : [job.decodeMs]);
    const transitions = benchmarkTraces.flatMap((trace) => trace.transitions);
    const firstReference = benchmarkTraces.findIndex((trace) => trace.reference.length > 0);
    const firstProduction = benchmarkTraces.findIndex((trace) => trace.decoded.length > 0);
    const firstLayout = benchmarkTraces.findIndex((trace) => trace.decoded.some((item) => item.slot !== undefined));
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
    const uniquePackets = new Map<number, (typeof productionPackets)[number]>();
    for (const packet of productionPackets) if (!uniquePackets.has(packet.esi)) uniquePackets.set(packet.esi, packet);
    const uniqueUseful = uniquePackets.size;
    const uniqueUsefulBytes = [...uniquePackets.values()].reduce((sum, packet) => sum + packet.bytes, 0);
    const extraPackets = benchmarkTraces.flatMap((trace) => {
      const reference = new Set(trace.reference.map((item) => item.esi));
      return trace.decoded.filter((item) => !reference.has(item.esi));
    });
    const extraUniqueSymbols = new Set(extraPackets.map((item) => item.esi)).size;
    const workerCpuSeconds = Math.max(0.001, decodeLatencies.reduce((sum, value) => sum + value, 0) / 1000);
    const processedPixels = jobs.reduce((sum, job) => sum + job.pixels + (job.targetedPixels ?? 0), 0);
    const byKind = Object.fromEntries((["FULL FRAME", "SHARED TRACKED BATCH CROP", "INDIVIDUAL TRACKED CROP"] as BenchmarkJobKind[]).map((kind) => {
      const selected = jobs.filter((job) => job.kind === kind);
      return [kind, {
        jobs: selected.length, pixels: selected.reduce((sum, job) => sum + job.pixels, 0), processedPixels: selected.reduce((sum, job) => sum + job.pixels + (job.targetedPixels ?? 0), 0),
        bytes: selected.reduce((sum, job) => sum + job.bytes, 0), tracks: selected.reduce((sum, job) => sum + job.tracks.length, 0), outputSymbols: selected.reduce((sum, job) => sum + (job.symbols ?? 0), 0),
        hits: selected.reduce((sum, job) => sum + (job.trackedHits ?? 0), 0), misses: selected.reduce((sum, job) => sum + (job.trackedMisses ?? 0), 0),
        readFullAttempts: selected.reduce((sum, job) => sum + (job.readFullAttempts ?? 0), 0), fallbackAttempts: selected.reduce((sum, job) => sum + (job.fallbackAttempts ?? 0), 0), fallbackSuccesses: selected.reduce((sum, job) => sum + (job.fallbackSuccesses ?? 0), 0), fallbackFailures: selected.reduce((sum, job) => sum + (job.fallbackAttempts ?? 0) - (job.fallbackSuccesses ?? 0), 0),
        targetedAttempts: selected.reduce((sum, job) => sum + (job.targetedAttempts ?? 0), 0), targetedPixels: selected.reduce((sum, job) => sum + (job.targetedPixels ?? 0), 0), targetedSuccesses: selected.reduce((sum, job) => sum + (job.targetedSuccesses ?? 0), 0),
      }];
    }));
    const failures = benchmarkTraces.flatMap((trace, index) => {
      const production = new Set(trace.decoded.map((item) => item.esi));
      return trace.reference.filter((item) => !production.has(item.esi)).map((item) => ({
        frameIndex: index, frameSequence: trace.sequence, slot: item.slot, esi: item.esi, reason: missedReason(trace, item.slot),
      }));
    });
    benchmarkResult = {
      format: "AirGapper receiver benchmark", version: document.querySelector(".app-version")?.textContent,
      corpus: corpus.header, replay: { mode: replayMode.value, workers: pool.size, device: navigator.userAgent },
      acquisition: { firstReferenceFrame: firstReference < 0 ? null : benchmarkTraces[firstReference]!.sequence, firstProductionFrame: firstProduction < 0 ? null : benchmarkTraces[firstProduction]!.sequence, deltaFrames: firstReference < 0 || firstProduction < 0 ? null : firstProduction - firstReference, deltaMs: firstReference < 0 || firstProduction < 0 ? null : benchmarkTraces[firstProduction]!.timestampMs - benchmarkTraces[firstReference]!.timestampMs, firstLayoutFrame: firstLayout < 0 ? null : benchmarkTraces[firstLayout]!.sequence, firstGridLockFrame: firstLock < 0 ? null : benchmarkTraces[firstLock]!.sequence },
      recovery: { lockLossFrame: lockLoss < 0 ? null : benchmarkTraces[lockLoss]!.sequence, localRecoveryStartFrame: localRecovery < 0 ? null : benchmarkTraces[localRecovery]!.sequence, globalReacquisitionStartFrame: globalRecovery < 0 ? null : benchmarkTraces[globalRecovery]!.sequence, firstRecoveredValidFrame: firstRecovered < 0 ? null : benchmarkTraces[firstRecovered]!.sequence, fullLockRestoredFrame: restored < 0 ? null : benchmarkTraces[restored]!.sequence },
      throughput: { durationSeconds, referenceOpportunities: opportunities, productionCaptured: captured, opportunityCapturePercent: opportunities ? captured / opportunities * 100 : 0, lockedReferenceOpportunities: lockedOpportunities, lockedProductionCaptured: lockedCaptured, lockedOpportunityCapturePercent: lockedOpportunities ? lockedCaptured / lockedOpportunities * 100 : 0, extraValidDecodes: extraPackets.length, extraUniqueSymbols, qrPerSecond: productionPackets.length / durationSeconds, uniqueUsefulQrPerSecond: uniqueUseful / durationSeconds, uniqueUsefulVerifiedBytesPerSecond: uniqueUsefulBytes / durationSeconds, verifiedKBPerFrame: benchmarkVerifiedBytes / 1024 / Math.max(1, benchmarkTraces.length), verifiedKBPerSecond: benchmarkVerifiedBytes / 1024 / durationSeconds },
      performance: { frameDropPercent: benchmarkTraces.length ? capturesDropped / benchmarkTraces.length * 100 : 0, workerBusyPercent: benchmarkTraces.length ? benchmarkTraces.reduce((sum, trace) => sum + trace.workerBusyFraction, 0) / benchmarkTraces.length * 100 : 0, pixelsPerSecond: jobs.reduce((sum, job) => sum + job.pixels, 0) / durationSeconds, processedPixelsPerSecond: processedPixels / durationSeconds, bytesRead: jobs.reduce((sum, job) => sum + job.bytes, 0), uniqueUsefulQrPerCpuSecond: uniqueUseful / workerCpuSeconds, uniqueUsefulBytesPerCpuSecond: uniqueUsefulBytes / workerCpuSeconds, uniqueUsefulQrPerMegapixel: uniqueUseful / Math.max(0.001, processedPixels / 1_000_000), uniqueUsefulBytesPerMegapixel: uniqueUsefulBytes / Math.max(0.001, processedPixels / 1_000_000), decodeP50Ms: percentile(decodeLatencies, .5), decodeP95Ms: percentile(decodeLatencies, .95), oracleP50Ms: percentile(oracleLatencies, .5), workerBusyDrops: capturesDropped, byKind },
      transitions, failures, frames: benchmarkTraces,
    };
    benchmarkSummary.textContent = `opportunities  ${captured}/${opportunities} (${(opportunities ? captured / opportunities * 100 : 0).toFixed(1)}%)\nQR/s           ${(productionPackets.length / durationSeconds).toFixed(1)}\nuseful QR/s    ${(uniqueUseful / durationSeconds).toFixed(1)}\nverified KB/s ${(benchmarkVerifiedBytes / 1024 / durationSeconds).toFixed(1)}\ndecode p50/95 ${percentile(decodeLatencies, .5).toFixed(1)} / ${percentile(decodeLatencies, .95).toFixed(1)} ms\nbusy drops    ${capturesDropped}\npixels/s      ${(jobs.reduce((sum, job) => sum + job.pixels, 0) / durationSeconds).toFixed(0)}\nmisses        ${failures.length}`;
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
      button.textContent = `Frame ${failure.frameSequence} · slot ${failure.slot ?? "?"}`;
      button.addEventListener("click", () => void inspectBenchmarkFrame(failure.frameIndex));
      buttons.append(button);
    }
    if (failures.length) benchmarkSummary.append(buttons);
    benchmarkStatus.textContent = `Run complete · ${replayMode.selectedOptions[0]?.textContent ?? replayMode.value} · ${selectedWorkerCount()} worker${selectedWorkerCount() === 1 ? "" : "s"} · save this run to compare later`;
    saveBenchmarkBtn.disabled = false;
  } catch (error) {
    benchmarkStatus.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    replayRunning = false;
    replayClock = undefined;
    activeBenchmarkFrame = undefined;
    pool.resize(0);
    runBenchmarkBtn.disabled = false;
  }
}

function updateStats() {
  if (done) return;
  const now = receiverNow();
  if (!receiverDevActions.hidden) renderFocusDiagnostics();
  const prune = (a: number[]) => {
    while (a.length > 0 && a[0]! < now - STATS_WINDOW_MS) a.shift();
  };
  prune(captureTimes);
  prune(qrReadTimes);
  prune(poolBusyTimes);
  prune(scanCompletionTimes);
  const perSecond = (a: number[]) => a.length / (STATS_WINDOW_MS / 1000);
  const cameraRate = perSecond(captureTimes);
  const scanRate = perSecond(scanCompletionTimes);
  const qrRate = perSecond(qrReadTimes);
  metric("m-cap").textContent = `${scanRate.toFixed(1)} fps`;
  metric("m-dec").textContent = `${qrRate.toFixed(1)} QR/s`;
  const stalled = cameraStartedTs > 0 && now - cameraStartedTs > STATS_WINDOW_MS &&
    scanRate === 0 && pool.busyCount > 0;
  const limit = metric("m-limit");
  limit.textContent = lastDecodeError
    ? `Scanner error: ${lastDecodeError}`
    : stalled
      ? "Scanner stalled"
      : "";
  limit.classList.toggle("scanner-bound", stalled || Boolean(lastDecodeError));
  if (!decoder) return;
  const elapsed = (now - startTs) / 1000;
  // Diagnostics accounting, gated on a running transfer so camera-pointing
  // time doesn't pollute it. Tick granularity matches this timer. Decode-
  // proven regions are the signal, matching the scheduler: a probationary
  // sighting region must not mask a missing code (degradedMs) or hide a full
  // tracking collapse (zeroRegionMs). The timeline carries BOTH counts so
  // phantom churn stays visible next to the real one.
  const activeGrid = regions.filter((region) => region.gridSlot !== undefined && region.slotState === "ACTIVE");
  const liveNow = gridLattice.active ? activeGrid.filter((region) => region.decoded).length : decodedCount();
  const expectedNow = gridLattice.active ? activeGrid.length : expectedRegions;
  if (liveNow === 0) zeroRegionMs += STATS_TICK_MS;
  if (liveNow < expectedNow) degradedMs += STATS_TICK_MS;
  if (timeline.length < TIMELINE_MAX_SAMPLES) {
    timeline.push([
      Number(elapsed.toFixed(1)),
      decoder.framesNew,
      decoder.solvedCount,
      liveNow,
      regions.length,
      Number(cameraRate.toFixed(1)),
      Number(qrRate.toFixed(1)),
      fullScans,
    ]);
  }
  updateProgressEstimate();
  const liveRate = liveGoodputKbs(now);
  metric("m-rate").textContent = `${liveRate.toFixed(1)} KB/s`;
  speedFeedback.className = `speed-feedback ${speedQualityClass(liveRate)}`;

}
