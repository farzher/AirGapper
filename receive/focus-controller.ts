import type { QrOpticalMetrics } from "./qr-optics";

export type FocusStrategy = "auto" | "camera-auto" | "single-shot" | "manual";
export type CalibrationMode = "auto" | "off" | "force";
export type FocusState =
  | "UNAVAILABLE" | "SEEKING" | "STABILIZING"
  | "LOCKED" | "TARGET_LOST_GRACE"
  | "OPTIMIZE_EXPOSURE" | "OPTIMIZE_VERIFY" | "OVERRIDE";
export type FocusOwner = "HARDWARE" | "MANUAL" | "DEVELOPER" | "NONE";

type NumericRange = { min: number; max: number; step?: number };
type CameraCapabilities = MediaTrackCapabilities & {
  focusMode?: string[];
  focusDistance?: NumericRange;
  pointsOfInterest?: unknown;
  exposureMode?: string[];
  exposureTime?: NumericRange;
  iso?: NumericRange;
  exposureCompensation?: NumericRange;
};
type CameraSettings = MediaTrackSettings & {
  focusMode?: string;
  focusDistance?: number;
  exposureMode?: string;
  exposureTime?: number;
  iso?: number;
  exposureCompensation?: number;
};
export type CameraPatch = {
  focusMode?: string;
  focusDistance?: number;
  pointsOfInterest?: { x: number; y: number }[];
  exposureMode?: string;
  exposureTime?: number;
  iso?: number;
  exposureCompensation?: number;
};

export const CAMERA_TUNING = {
  geometryStabilityMs: 420,
  scaleChangeRatio: 0.16,
  displacementRatio: 0.1,
  perspectiveChange: 0.14,
  focusExcellent: 0.78,
  focusSettleMs: 150,
  focusProbeSamples: 3,
  focusDiscardFrames: 1,
  exposureDiscardFrames: 2,
  exposureExcellent: 0.7,
  seekingOpticalIntervalMs: 110,
  lockedOpticalIntervalMs: 700,
  targetLostGraceMs: 1600,
  stabilizingRetryMs: 2500,
  poorFocusRetryMs: 480,
  maxStabilizingAfRetries: 2,
  recoverySamples: 3,
  severeFocusScore: 0.24,
  convincingFocusScore: 0.62,
  severeBlurConfirmMs: 480,
  optimizeMovementConfirmMs: 650,
  optimizeBudgetMs: 7000,
  optimizeWinRatio: 1.14,
  optimizeLossRatio: 0.88,
};

// Phone AE is tuned for photographs, where a bright emissive screen is often
// driven much brighter than a QR decoder needs. Keep hardware AE in charge,
// but bias it slightly dark and make small, slow corrections from real QR
// function-module levels. Never brighten above the camera's neutral 0 EV.
const AUTO_QR_EV_BIAS = -0.7;
const AUTO_QR_EV_COOLDOWN_MS = 3000;
const AUTO_QR_WHITE_LOW = 145;
const AUTO_QR_WHITE_HIGH = 238;
const AUTO_QR_BLACK_HIGH = 105;
const AUTO_QR_SEPARATION_LOW = 50;

export interface FocusGeometry {
  x: number;
  y: number;
  scale: number;
  perspectiveX: number;
  perspectiveY: number;
  quality: number;
}

interface OpticalObservation {
  id: number;
  at: number;
  geometry: FocusGeometry;
  metrics: QrOpticalMetrics;
  totalTiles: number;
  captureFps: number;
}

interface CameraSnapshot {
  focusMode?: string;
  focusDistance?: number;
  exposureTime?: number;
  iso?: number;
  exposureCompensation?: number;
  optical: QrOpticalMetrics;
  geometry: FocusGeometry;
}

export interface ReceivePerformance {
  validDecodesPerSecond: number;
  usefulSymbolsPerSecond: number;
  perQrAttemptSuccessRate: number;
  captureFps: number;
  submittedJobs: number;
  completedJobs: number;
  completionCoverage: number;
  sourceFrames: number;
  successfulSourceFrames: number;
  qrAttempts: number;
  validDecodes: number;
  measurementMs: number;
  temporalContamination?: number;
}

export interface PerformanceSample {
  result: Promise<ReceivePerformance>;
}

export interface OptimizerOpticalMeasurement {
  metrics: QrOpticalMetrics;
  sourceFrames: number;
  /** True when metrics came from known QR function modules rather than the global bootstrap fallback. */
  targeted: boolean;
}

export interface OptimizerEpochRequest {
  candidateId: string;
  requestedExposure: number;
  requestedIso: number;
  actualExposure?: number;
  actualIso?: number;
}

export interface OptimizerEpochHooks {
  transition(request: OptimizerEpochRequest): void;
  open(request: Required<OptimizerEpochRequest>): Promise<number | undefined>;
  close(epoch: number): void;
  finish(): void;
}

export interface OptimizerCandidateDiagnostic {
  candidateId: string;
  exposure: number;
  iso: number;
  visits: number;
  sourceFrames: number;
  successfulSourceFrames: number;
  qrAttempts: number;
  validDecodes: number;
  successRate: number;
  normalizedQrRate: number;
  completionCoverage: number;
  temporalContamination: number;
  state: string;
  coarseGrid: boolean;
  opticalTargeted: boolean;
  opticalGood: boolean;
  opticalMargin: number;
  opticalSeparation: number;
  opticalNoise: number;
  opticalClipping: number;
  opticalBanding: number;
  opticalConfidence: number;
}

export interface FocusDiagnostics {
  state: FocusState;
  stateMs: number;
  focusOwner: FocusOwner;
  invariantWarning?: string;
  calibrationMode: CalibrationMode;
  availableModes: string[];
  requestedMode?: string;
  actualMode?: string;
  actualDistance?: number;
  distanceRange?: NumericRange;
  poiSupported: boolean;
  exposureRange?: NumericRange;
  isoRange?: NumericRange;
  actualExposureMode?: string;
  actualExposure?: number;
  actualIso?: number;
  actualExposureCompensation?: number;
  exposureCompensationRange?: NumericRange;
  baselineFocus?: number;
  baselineExposure?: number;
  baselineIso?: number;
  requestedExposure?: number;
  requestedIso?: number;
  focusProbes: number;
  exposureProbes: number;
  optical?: QrOpticalMetrics;
  targetDetected: boolean;
  geometryStable: boolean;
  totalTiles: number;
  lastValidDecodeAt?: number;
  lastUsefulDecodeAt?: number;
  validDecodesInGeneration: number;
  decoderCompletionsInGeneration: number;
  decodeSilenceMs: number;
  recentInterdecodeMs?: number;
  recentCompletionMs?: number;
  likelyTemporalFailure: boolean;
  knownGood: boolean;
  knownGoodSettings?: { focusMode?: string; focusDistance?: number; exposureTime?: number; iso?: number };
  committedFocusMode?: string;
  committedFocusDistance?: number;
  committedExposureMode?: string;
  committedExposureTime?: number;
  committedIso?: number;
  candidateExposureTime?: number;
  candidateIso?: number;
  lockedMs?: number;
  initialLockMs?: number;
  fullResetCount: number;
  focusRefinementCount: number;
  exposureRefinementCount: number;

  optimizeState: "idle" | "baseline" | "exposure" | "verification" | "paused" | "cancelled" | "complete";
  optimizeRound?: "baseline" | "shutter" | "iso" | "refine" | "verify";
  optimizeVisit?: string;
  optimizeSurvivors?: string;
  optimizeDecision?: string;
  optimizeCandidatePerformance?: ReceivePerformance;
  optimizeBestPerformance?: ReceivePerformance;
  optimizeSummary?: string;
  optimizeExposureStepEV?: number;
  optimizeShutterStepEV?: number;
  optimizeComparison?: "WIN" | "LOSS" | "UNCERTAIN";
  optimizePairedSamples?: number;
  optimizeReason?: string;
  optimizeCandidates: OptimizerCandidateDiagnostic[];
  optimizeUniqueConfigurations: number;
  optimizeExposureVisited?: { min: number; max: number; coverage: number };
  optimizeIsoVisited?: { min: number; max: number; coverage: number };
  transitions: string[];
  lastReason: string;
}

type ApplyCamera = (track: MediaStreamTrack, patch: CameraPatch) => Promise<boolean>;

export class FocusController {
  private track?: MediaStreamTrack;
  private caps: CameraCapabilities = {};
  private state: FocusState = "UNAVAILABLE";
  private stateSince = performance.now();
  private strategy: FocusStrategy;
  private calibrationMode: CalibrationMode;
  private manualDistance?: number;
  private generation = 0;
  private attachedAt = 0;
  private requestedMode?: string;
  private latest?: OpticalObservation;
  private stableGeometry?: FocusGeometry;
  private stableSince = 0;
  private targetMissingSince = 0;
  private initialLockMs?: number;
  private lastReason = "camera opened";
  private baselineFocus?: number;
  private baselineExposure?: number;
  private baselineIso?: number;
  private autoExposureCompensation?: number;
  private lastAutoExposureTrimAt = -Infinity;
  private autoExposureTrimRunning = false;
  private autoExposureTrimDirection = 0;
  private autoExposureTrimConfirmations = 0;
  private requestedExposure?: number;
  private requestedIso?: number;
  private focusProbes = 0;
  private exposureProbes = 0;
  private bestKnownGood?: CameraSnapshot;
  private lastWorkingState?: CameraSnapshot;
  private committedFocusMode?: string;
  private committedFocusDistance?: number;
  private committedExposureMode?: string;
  private committedExposureTime?: number;
  private committedIso?: number;
  private committedExposureCompensation?: number;
  private candidateExposureTime?: number;
  private candidateIso?: number;
  private lockedAt = 0;
  private fullResetCount = 0;
  private focusRefinementCount = 0;
  private exposureRefinementCount = 0;
  private lockedFocusFailures = 0;
  private lockedExposureFailures = 0;

  private optimizeState: FocusDiagnostics["optimizeState"] = "idle";
  private optimizeRound?: FocusDiagnostics["optimizeRound"];
  private optimizeVisit?: string;
  private optimizeSurvivors?: string;
  private optimizeDecision?: string;
  private optimizeCandidatePerformance?: ReceivePerformance;
  private optimizeBestPerformance?: ReceivePerformance;
  private optimizeSummary?: string;
  private optimizeExposureStepEV = 1;
  private optimizeShutterStepEV = 1;
  private optimizeComparison?: "WIN" | "LOSS" | "UNCERTAIN";
  private optimizePairedSamples = 0;
  private optimizeReason = "idle";
  private optimizeCandidates: OptimizerCandidateDiagnostic[] = [];
  private optimizeExposureVisited?: { min: number; max: number; coverage: number };
  private optimizeIsoVisited?: { min: number; max: number; coverage: number };
  private decodeBoundary = 0;
  private cameraGenerationStartedAt = performance.now();
  private lastValidDecodeAt?: number;
  private lastUsefulDecodeAt?: number;
  private lastValidScanId = -1;
  private validDecodesInGeneration = 0;
  private decoderCompletionsInGeneration = 0;
  private readonly validDecodeTimes: number[] = [];
  private readonly completionTimes: number[] = [];
  private optimizeMovementSince = 0;
  private readonly transitions: string[] = [];
  /** Automatic focus is configured at most once per camera track. After that,
   *  AirGapper treats focus as read-only: exposure optimization, acquisition,
   *  target loss, and decoder recovery are forbidden from touching the lens. */
  private automaticFocusConfigured = false;
  private waiter?: {
    generation: number;
    afterId: number;
    notBefore: number;
    discard: number;
    samples: OpticalObservation[];
    requiredSamples: number;
    resolve: (value?: OpticalObservation) => void;
  };

  constructor(
    private readonly apply: ApplyCamera,
    private readonly changed: () => void,
    strategy: FocusStrategy = "auto",
    manualDistance?: number,
    calibrationMode: CalibrationMode = "auto",
    private readonly currentScanId: () => number = () => 0,
  ) {
    this.strategy = strategy;
    this.manualDistance = manualDistance;
    this.calibrationMode = calibrationMode;
  }

  get capabilities(): CameraCapabilities { return this.caps; }
  get selectedStrategy(): FocusStrategy { return this.strategy; }
  get expectsProbeFrame(): boolean {
    return this.state === "OPTIMIZE_EXPOSURE" || this.state === "OPTIMIZE_VERIFY";
  }
  get opticalIntervalMs(): number {
    if (this.calibrationMode === "off") return Infinity;
    if (this.strategy !== "auto" || this.state === "OVERRIDE") return CAMERA_TUNING.lockedOpticalIntervalMs;
    if (this.expectsProbeFrame) return 0;
    return this.state === "LOCKED" || this.state === "TARGET_LOST_GRACE"
      ? CAMERA_TUNING.lockedOpticalIntervalMs : CAMERA_TUNING.seekingOpticalIntervalMs;
  }

  attach(track: MediaStreamTrack): void {
    this.cancel("camera track changed");
    this.track = track;
    this.caps = (track.getCapabilities?.() ?? {}) as CameraCapabilities;
    const focusRange = this.caps.focusDistance;
    if (!focusRange || !Number.isFinite(focusRange.min) || !Number.isFinite(focusRange.max) ||
        focusRange.min < 0 || focusRange.max < focusRange.min || focusRange.max > 1000) {
      delete this.caps.focusDistance;
    }
    this.attachedAt = performance.now();
    this.latest = undefined;
    this.stableGeometry = undefined;
    this.stableSince = 0;
    this.targetMissingSince = 0;
    this.automaticFocusConfigured = false;
    this.optimizeMovementSince = 0;
    this.initialLockMs = undefined;
    this.optimizeState = "idle";
    this.optimizeRound = undefined;
    this.optimizeVisit = undefined;
    this.optimizeSurvivors = undefined;
    this.optimizeDecision = undefined;
    this.optimizeCandidatePerformance = undefined;
    this.optimizeBestPerformance = undefined;
    this.optimizeSummary = undefined;
    this.optimizeCandidates = [];
    this.optimizeExposureVisited = undefined;
    this.optimizeIsoVisited = undefined;
    this.optimizeExposureStepEV = 1;
    this.optimizeShutterStepEV = 1;
    this.optimizeComparison = undefined;
    this.optimizePairedSamples = 0;
    this.optimizeReason = "camera changed";
    this.bestKnownGood = undefined;
    this.lastWorkingState = undefined;
    this.beginDecodeGeneration();
    this.committedFocusMode = undefined;
    this.committedFocusDistance = undefined;
    this.committedExposureMode = undefined;
    this.committedExposureTime = undefined;
    this.committedIso = undefined;
    this.committedExposureCompensation = undefined;
    this.autoExposureCompensation = undefined;
    this.lastAutoExposureTrimAt = -Infinity;
    this.autoExposureTrimRunning = false;
    this.autoExposureTrimDirection = 0;
    this.autoExposureTrimConfirmations = 0;
    if (this.strategy === "auto") {
      this.transition("SEEKING", "camera track changed; one hardware AF sweep, then focus held by camera");
      // Static QR scanning does not benefit from continuous AF hunting. Ask the
      // hardware for ONE single-shot sweep when supported, then never touch
      // focus automatically again for this track.
      void this.configureInitialHardwareFocusOnce().then(() =>
        this.enterAutomaticExposureState("camera opened", this.generation, true));
    } else {
      this.transition("OVERRIDE", "camera track changed; developer owns focus");
      void this.applyDeveloperFocus();
    }
  }

  detach(): void {
    this.cancel("camera stopped");
    this.track = undefined;
    this.caps = {};
    this.transition("UNAVAILABLE", "camera stopped");
  }

  setStrategy(strategy: FocusStrategy): void {
    const optimizing = this.isOptimizing();
    this.cancel("focus ownership changed");
    this.strategy = strategy;
    if (optimizing) this.optimizeState = "cancelled";

    if (strategy === "auto") {
      // Switching back from developer/manual control is a hard return to the
      // camera's own 3A. Never resurrect an old optimized/manual ISO/exposure
      // merely because the QR geometry did not move.
      this.optimizeState = "idle";
      this.optimizeBestPerformance = undefined;
      this.optimizeSummary = undefined;
      this.optimizeCandidates = [];
      this.candidateExposureTime = undefined;
      this.candidateIso = undefined;
      this.transition("SEEKING", "automatic focus selected; one hardware AF sweep + hardware AE");
      this.automaticFocusConfigured = false;
      void this.configureInitialHardwareFocusOnce().then(() =>
        this.enterAutomaticExposureState("automatic focus selected", this.generation, true));
    } else {
      // Once the user takes manual ownership, old Optimize state must not be
      // silently restored the next time Auto is selected.
      this.optimizeState = "idle";
      this.optimizeBestPerformance = undefined;
      this.optimizeSummary = undefined;
      this.transition("OVERRIDE", "developer owns focus");
      const start = () => this.applyDeveloperFocus();
      if (optimizing) void this.restoreOptimizationBest("exposure").then(start);
      else void start();
    }
  }

  setCalibrationMode(mode: CalibrationMode): void {
    this.cancel("calibration mode changed");
    this.calibrationMode = mode;
    if (this.strategy === "auto") {
      this.transition("SEEKING", "calibration mode changed; focus retained");
      void this.enterAutomaticExposureState("calibration mode changed", this.generation, true);
    } else this.transition("OVERRIDE", "calibration mode changed");
  }

  setManualDistance(distance: number): void {
    const range = this.caps.focusDistance;
    if (!range || !Number.isFinite(distance)) return;
    this.manualDistance = this.quantize(distance, range);
    this.cancel("developer changed focus distance");
    if (this.strategy === "manual") void this.applyDeveloperFocus();
    this.changed();
  }

  developerOverride(reason: string): void {
    this.cancel(reason);
    if (this.strategy === "auto") this.transition("OVERRIDE", reason);
    else {
      this.lastReason = reason;
      this.changed();
    }
  }

  cancelOptimize(reason = "optimization stopped"): void {
    if (!this.isOptimizing()) return;
    this.cancel(reason);
    this.optimizeState = "paused";
    this.optimizeReason = `${reason}; original settings restored`;
    void this.restoreOptimizationBest("exposure").then(() => this.transition("LOCKED", this.optimizeReason));
  }

  optimizeEligible(): boolean {
    const retryHasTarget = this.optimizeState !== "paused" || Boolean(this.latest && !this.targetMissingSince);
    // Exposure optimization is independent of focus ownership. The user may
    // choose Camera Auto, Single, or Manual focus and still optimize shutter/ISO;
    // Optimize is forbidden from changing that focus choice.
    return !this.isOptimizing() && retryHasTarget && Boolean(
      this.track && this.track.readyState === "live" && this.manualExposure() && this.caps.iso,
    );
  }

  async optimize(
    measureOptics: (label: string, epoch: number) => Promise<OptimizerOpticalMeasurement>,
    measureDecode: (label: string, epoch: number) => Promise<PerformanceSample>,
    epochs: OptimizerEpochHooks,
  ): Promise<void> {
    if (!this.optimizeEligible()) return;
    const generation = ++this.generation;
    const startedAt = performance.now();
    const deadline = startedAt + CAMERA_TUNING.optimizeBudgetMs;
    this.optimizeState = "baseline";
    this.optimizeRound = "baseline";
    this.optimizeCandidates = [];
    this.optimizeExposureVisited = undefined;
    this.optimizeIsoVisited = undefined;
    this.optimizeDecision = "measuring Auto baseline";
    this.optimizeComparison = undefined;
    this.optimizePairedSamples = 0;

    const initialObservation = this.latest;
    if (initialObservation) {
      this.stableGeometry = initialObservation.geometry;
      this.stableSince = performance.now();
    }

    // Optimize never operates the lens. Focus is deliberately read-only for the
    // whole search. applyCameraConstraint() may perform its already-learned
    // one-time AF-hold workaround on a HAL that *requires* manual focus before it
    // will honor manual sensor controls, but this optimizer itself never asks for
    // autofocus, POI changes, focus-mode reassertion or focus recovery.
    const origin = this.settings();
    const hardwareExposureRange = this.caps.exposureTime;
    const isoRange = this.caps.iso;
    if (!this.manualExposure() || !hardwareExposureRange || !isoRange ||
        origin.exposureTime === undefined || origin.iso === undefined ||
        hardwareExposureRange.min <= 0 || isoRange.min <= 0) {
      this.optimizeState = "paused";
      this.optimizeReason = "manual exposure and ISO controls unavailable";
      return;
    }

    const observedFps = Math.max(12, Math.min(120, this.latest?.captureFps || 30));
    const frameSafeMax = 8000 / observedFps; // exposure units are 100 µs
    const exposureRange: NumericRange = {
      ...hardwareExposureRange,
      max: Math.max(hardwareExposureRange.min, Math.min(hardwareExposureRange.max, frameSafeMax)),
    };
    // Optimize is an ongoing mode. Every pass begins from the ACTUAL currently
    // committed winner, not the camera's original hardware-Auto baseline. That
    // lets successive passes learn: each winner becomes the next pass's starting
    // point and we progressively approach the fastest clean exposure boundary.
    const autoExposure = this.quantize(origin.exposureTime, exposureRange);
    const autoIso = this.quantize(origin.iso, isoRange);

    this.commitSettings(origin);
    this.optimizeState = "exposure";
    this.transition("OPTIMIZE_EXPOSURE", "pixel-quality exposure search; focus untouched");

    const median = (values: number[]): number => {
      if (!values.length) return 0;
      const sorted = [...values].sort((a, b) => a - b);
      const middle = sorted.length >> 1;
      return sorted.length & 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
    };
    const medianMetric = (samples: OptimizerOpticalMeasurement[]): QrOpticalMetrics => {
      const metrics = samples.map((sample) => sample.metrics);
      const value = (read: (metric: QrOpticalMetrics) => number) => median(metrics.map(read));
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
        sampledModules: Math.round(value((m) => m.sampledModules)),
      };
    };
    const aggregateDecode = (windows: ReceivePerformance[]): ReceivePerformance => {
      const measurementMs = windows.reduce((sum, window) => sum + window.measurementMs, 0);
      const submittedJobs = windows.reduce((sum, window) => sum + window.submittedJobs, 0);
      const completedJobs = windows.reduce((sum, window) => sum + window.completedJobs, 0);
      const sourceFrames = windows.reduce((sum, window) => sum + window.sourceFrames, 0);
      const successfulSourceFrames = windows.reduce((sum, window) => sum + window.successfulSourceFrames, 0);
      const qrAttempts = windows.reduce((sum, window) => sum + window.qrAttempts, 0);
      const validDecodes = windows.reduce((sum, window) => sum + window.validDecodes, 0);
      const usefulSymbols = windows.reduce(
        (sum, window) => sum + window.usefulSymbolsPerSecond * window.measurementMs / 1000, 0,
      );
      return {
        validDecodesPerSecond: measurementMs > 0 ? validDecodes / (measurementMs / 1000) : 0,
        usefulSymbolsPerSecond: measurementMs > 0 ? usefulSymbols / (measurementMs / 1000) : 0,
        perQrAttemptSuccessRate: qrAttempts ? validDecodes / qrAttempts : 0,
        captureFps: median(windows.map((window) => window.captureFps)),
        submittedJobs,
        completedJobs,
        completionCoverage: submittedJobs ? completedJobs / submittedJobs : 0,
        sourceFrames,
        successfulSourceFrames,
        qrAttempts,
        validDecodes,
        measurementMs,
        temporalContamination: median(windows.map((window) => window.temporalContamination ?? 0)),
      };
    };

    type Candidate = {
      id: string;
      requestedExposure: number;
      requestedIso: number;
      exposure: number;
      iso: number;
      key: string;
      optics: OptimizerOpticalMeasurement[];
      decode: ReceivePerformance[];
      state: string;
      coarseGrid: boolean;
    };
    const candidates = new Map<string, Candidate>();
    let nextId = 1;
    const make = (exposure: number, iso: number): Candidate => {
      exposure = this.quantize(exposure, exposureRange);
      iso = this.quantize(iso, isoRange);
      const key = `${exposure}|${iso}`;
      const existing = candidates.get(key);
      if (existing) return existing;
      const candidate: Candidate = {
        id: `C${nextId++}`,
        requestedExposure: exposure,
        requestedIso: iso,
        exposure,
        iso,
        key,
        optics: [],
        decode: [],
        state: "queued",
        coarseGrid: false,
      };
      candidates.set(key, candidate);
      return candidate;
    };
    const opticsOf = (candidate: Candidate): QrOpticalMetrics | undefined => {
      if (!candidate.optics.length) return undefined;
      const targeted = candidate.optics.filter((sample) => sample.targeted);
      // Never average global bootstrap histograms with real QR-module metrics.
      return medianMetric(targeted.length ? targeted : candidate.optics.filter((sample) => !sample.targeted));
    };
    const decodeOf = (candidate: Candidate): ReceivePerformance => aggregateDecode(candidate.decode);
    const targetedOf = (candidate: Candidate): boolean => candidate.optics.some((sample) => sample.targeted);

    type QualityThresholds = {
      separation: number;
      confidence: number;
      noiseRatio: number;
      clipping: number;
      banding: number;
    };
    let targetedThresholds: QualityThresholds | undefined;
    let globalThresholds: QualityThresholds | undefined;
    // If the current setting is demonstrably decoding the live QR stream, that
    // is stronger evidence than an arbitrary photographic threshold. Candidate
    // optics are judged relative to this proven baseline, while final commit
    // still requires a fresh QR decode at the actual selected setting.
    let provenBaseline: QrOpticalMetrics | undefined;
    let baselineCandidate: Candidate | undefined;
    const thresholdsFrom = (baseline: QrOpticalMetrics, targeted: boolean): QualityThresholds => {
      const noiseRatio = baseline.noise / Math.max(1, baseline.separation);
      return targeted ? {
        separation: Math.max(40, Math.min(64, baseline.separation * 0.58)),
        confidence: Math.max(0.76, Math.min(0.90, baseline.confidence * 0.90)),
        noiseRatio: Math.max(0.26, Math.min(0.48, noiseRatio * 1.65 + 0.03)),
        clipping: Math.max(0.42, Math.min(0.70, baseline.clipping + 0.22)),
        banding: Math.max(0.34, Math.min(0.52, baseline.banding + 0.16)),
      } : {
        separation: Math.max(30, Math.min(54, baseline.separation * 0.50)),
        confidence: Math.max(0.52, Math.min(0.78, baseline.confidence * 0.82)),
        noiseRatio: Math.max(0.38, Math.min(0.68, noiseRatio * 1.8 + 0.08)),
        clipping: 0.82,
        banding: 0.75,
      };
    };
    const thresholdFor = (candidate: Candidate): QualityThresholds | undefined =>
      targetedOf(candidate) ? targetedThresholds : globalThresholds;
    const quality = (candidate: Candidate): { good: boolean; comfortable: boolean; margin: number; needsGain: boolean } => {
      const metric = opticsOf(candidate);
      const threshold = thresholdFor(candidate);
      if (!metric || !threshold) return { good: false, comfortable: false, margin: -Infinity, needsGain: true };
      const targeted = targetedOf(candidate);
      const provenNoiseRatio = provenBaseline
        ? provenBaseline.noise / Math.max(1, provenBaseline.separation)
        : undefined;
      const separationFloor = targeted
        ? provenBaseline
          ? Math.max(18, Math.min(threshold.separation, provenBaseline.separation * 0.68))
          : Math.max(48, threshold.separation)
        : threshold.separation;
      const confidenceFloor = targeted
        ? provenBaseline
          ? Math.max(0.64, Math.min(threshold.confidence, provenBaseline.confidence * 0.88))
          : Math.max(0.82, threshold.confidence)
        : threshold.confidence;
      const noiseRatio = targeted
        ? provenBaseline && provenNoiseRatio !== undefined
          ? Math.min(0.58, Math.max(threshold.noiseRatio, provenNoiseRatio * 1.45 + 0.03))
          : Math.min(0.36, threshold.noiseRatio)
        : threshold.noiseRatio;
      const clippingCeiling = targeted
        ? provenBaseline
          ? Math.min(0.78, Math.max(threshold.clipping, provenBaseline.clipping + 0.18))
          : Math.min(0.58, threshold.clipping)
        : threshold.clipping;
      const bandingCeiling = targeted
        ? provenBaseline
          ? Math.min(0.72, Math.max(threshold.banding, provenBaseline.banding + 0.16))
          : Math.min(0.38, threshold.banding)
        : threshold.banding;
      const noiseLimit = Math.max(14, metric.separation * noiseRatio);
      const margins = [
        (metric.separation - separationFloor) / Math.max(1, separationFloor),
        (metric.confidence - confidenceFloor) / Math.max(0.1, 1 - confidenceFloor),
        (noiseLimit - metric.noise) / Math.max(1, noiseLimit),
        (clippingCeiling - metric.clipping) / Math.max(0.1, clippingCeiling),
        (bandingCeiling - metric.banding) / Math.max(0.1, bandingCeiling),
      ];
      let margin = Math.min(...margins);
      const needsGain = metric.separation < threshold.separation || metric.confidence < threshold.confidence;
      // A fresh live decode proves the current setting is usable even when a
      // rolling-shutter/banding heuristic is pessimistic. Never let the optics
      // model reject the very baseline the real decoder just demonstrated.
      if (candidate === baselineCandidate && provenBaseline) margin = Math.max(0, margin);
      return { good: margin >= 0, comfortable: margin >= 0.07, margin, needsGain: candidate === baselineCandidate && provenBaseline ? false : needsGain };
    };

    const refresh = (): void => {
      const evaluated = [...candidates.values()].filter((candidate) => candidate.optics.length || candidate.decode.length);
      this.optimizeCandidates = evaluated.map((candidate) => {
        const metric = opticsOf(candidate);
        const p = decodeOf(candidate);
        const q = quality(candidate);
        return {
          candidateId: candidate.id,
          exposure: candidate.exposure,
          iso: candidate.iso,
          visits: candidate.optics.length,
          sourceFrames: candidate.optics.reduce((sum, sample) => sum + sample.sourceFrames, 0),
          successfulSourceFrames: p.successfulSourceFrames,
          qrAttempts: p.qrAttempts,
          validDecodes: p.validDecodes,
          successRate: p.perQrAttemptSuccessRate,
          normalizedQrRate: p.validDecodesPerSecond,
          completionCoverage: p.completionCoverage,
          temporalContamination: metric?.temporalContamination ?? 0,
          state: candidate.state,
          coarseGrid: candidate.coarseGrid,
          opticalTargeted: targetedOf(candidate),
          opticalGood: targetedOf(candidate) && q.good,
          opticalMargin: Number.isFinite(q.margin) ? q.margin : -1,
          opticalSeparation: metric?.separation ?? 0,
          opticalNoise: metric?.noise ?? 0,
          opticalClipping: metric?.clipping ?? 0,
          opticalBanding: metric?.banding ?? 0,
          opticalConfidence: metric?.confidence ?? 0,
        };
      }).sort((a, b) => a.exposure - b.exposure || a.iso - b.iso);
      if (evaluated.length) {
        const exposures = evaluated.map((candidate) => candidate.exposure);
        const isos = evaluated.map((candidate) => candidate.iso);
        this.optimizeExposureVisited = { min: Math.min(...exposures), max: Math.max(...exposures), coverage: 1 };
        this.optimizeIsoVisited = { min: Math.min(...isos), max: Math.max(...isos), coverage: 1 };
      }
      this.changed();
    };

    const activateExposureCandidate = async (
      requested: Candidate,
      allowPastDeadline = false,
    ): Promise<{ candidate: Candidate; epoch: number } | undefined> => {
      if (!this.current(generation) || (!allowPastDeadline && performance.now() >= deadline)) return undefined;
      this.candidateExposureTime = requested.requestedExposure;
      this.candidateIso = requested.requestedIso;
      this.requestedExposure = requested.requestedExposure;
      this.requestedIso = requested.requestedIso;
      const before = this.settings();
      epochs.transition({
        candidateId: requested.id,
        requestedExposure: requested.requestedExposure,
        requestedIso: requested.requestedIso,
      });
      const patch: CameraPatch = {
        exposureMode: "manual",
        exposureTime: requested.requestedExposure,
        iso: requested.requestedIso,
      };
      await this.applyProbe(generation, patch, false);

      const requestedChange = before.exposureTime !== requested.requestedExposure || before.iso !== requested.requestedIso;
      const readApplied = async (maxMs: number): Promise<CameraSettings> => {
        const started = performance.now();
        let observed = this.settings();
        while (this.current(generation) && performance.now() - started < maxMs) {
          if (observed.exposureTime !== undefined && observed.iso !== undefined &&
              (!requestedChange || observed.exposureTime !== before.exposureTime || observed.iso !== before.iso)) return observed;
          await new Promise((resolve) => setTimeout(resolve, 24));
          observed = this.settings();
        }
        return observed;
      };
      let actual = await readApplied(140);
      if (requestedChange && actual.exposureTime === before.exposureTime && actual.iso === before.iso && this.current(generation)) {
        await this.applyProbe(generation, patch, false);
        actual = await readApplied(220);
      }
      if (actual.exposureTime === undefined || actual.iso === undefined) {
        this.optimizeReason = "camera never reported usable manual exposure/ISO settings";
        return undefined;
      }
      const key = `${actual.exposureTime}|${actual.iso}`;
      let candidate = candidates.get(key);
      if (!candidate) {
        candidate = requested;
        candidates.delete(requested.key);
        candidate.key = key;
        candidate.exposure = actual.exposureTime;
        candidate.iso = actual.iso;
        candidates.set(key, candidate);
      }
      candidate.coarseGrid ||= requested.coarseGrid;
      const epoch = await epochs.open({
        candidateId: candidate.id,
        requestedExposure: requested.requestedExposure,
        requestedIso: requested.requestedIso,
        actualExposure: actual.exposureTime,
        actualIso: actual.iso,
      });
      if (epoch === undefined) {
        this.optimizeReason = "camera produced no settled source frames for optimizer epoch";
        return undefined;
      }
      return !this.current(generation) ? undefined : { candidate, epoch };
    };

    const measureCandidate = async (
      requested: Candidate,
      label: string,
      round: FocusDiagnostics["optimizeRound"],
      allowPastDeadline = false,
    ): Promise<Candidate | undefined> => {
      this.optimizeRound = round;
      const active = await activateExposureCandidate(requested, allowPastDeadline);
      if (!active) return undefined;
      const { candidate, epoch } = active;
      candidate.state = "measuring optics";
      this.optimizeVisit = String(candidate.optics.length + 1);
      let sample: OptimizerOpticalMeasurement | undefined;
      try {
        sample = await measureOptics(label, epoch);
      } catch (error) {
        this.optimizeReason = error instanceof Error ? error.message : "optical optimizer measurement failed";
      } finally {
        epochs.close(epoch);
      }
      if (!sample || !this.current(generation)) return undefined;
      candidate.optics.push(sample);
      candidate.state = "measured";
      if (sample.targeted && !targetedThresholds) targetedThresholds = thresholdsFrom(sample.metrics, true);
      if (!sample.targeted && !globalThresholds) globalThresholds = thresholdsFrom(sample.metrics, false);
      refresh();
      return candidate;
    };

    const tuneIsoForExposure = async (
      exposure: number,
      seedIso: number,
      label: string,
    ): Promise<{ good?: Candidate; best?: Candidate }> => {
      const tested = new Set<string>();
      let best: Candidate | undefined;
      const remember = (candidate: Candidate): void => {
        const qb = best ? quality(best) : undefined;
        const qc = quality(candidate);
        if (!best || qc.margin > (qb?.margin ?? -Infinity)) best = candidate;
      };
      const test = async (iso: number, suffix: string): Promise<Candidate | undefined> => {
        if (performance.now() >= deadline - 900) return undefined;
        const candidate = make(exposure, this.quantize(iso, isoRange));
        if (tested.has(candidate.key)) return candidate.optics.length ? candidate : undefined;
        tested.add(candidate.key);
        this.exposureProbes++;
        const measured = await measureCandidate(candidate, `${label} ${suffix}`, "iso");
        if (measured) remember(measured);
        return measured;
      };

      const seed = await test(seedIso, "seed");
      if (!seed) return { best };
      let q = quality(seed);
      if (q.good) {
        // Whole-image contrast is bootstrap guidance only. Never use it to lower
        // ISO: that is exactly how a globally contrasted but unreadably dark QR
        // became the old winner. Only real QR-module optics may trim gain.
        if (!targetedOf(seed)) return { good: seed, best };
        // Once a QR-targeted shutter is clean, search downward in gain.
        let highGood = seed;
        let lowBadIso = isoRange.min;
        for (let refine = 0; refine < 2 && highGood.iso > isoRange.min * 1.04; refine++) {
          const probeIso = this.quantize(Math.sqrt(Math.max(isoRange.min, lowBadIso) * highGood.iso), isoRange);
          if (probeIso === highGood.iso || tested.has(`${exposure}|${probeIso}`)) break;
          const lower = await test(probeIso, "lower gain");
          if (!lower) break;
          const lowerQ = quality(lower);
          if (lowerQ.good) highGood = lower;
          else {
            lowBadIso = lower.iso;
            break;
          }
        }
        return { good: highGood, best };
      }

      // Only increase ISO when the pixels say we are short of contrast. A noisy,
      // clipped or banded failure is not "fixed" by blasting more gain into it.
      if (!q.needsGain) return { best };
      const maxIso = this.quantize(isoRange.max, isoRange);
      const midIso = this.quantize(Math.sqrt(Math.max(seed.iso, isoRange.min) * maxIso), isoRange);
      const upward = [midIso, maxIso].filter((iso, index, all) => iso > seed.iso && all.indexOf(iso) === index);
      let lastBad = seed;
      for (const iso of upward) {
        const higher = await test(iso, iso === maxIso ? "max gain" : "more gain");
        if (!higher) continue;
        const higherQ = quality(higher);
        if (higherQ.good) {
          if (!targetedOf(higher)) return { good: higher, best };
          // One geometric midpoint is enough to avoid automatically pinning ISO
          // to max when a substantially lower value is already clean.
          const refineIso = this.quantize(Math.sqrt(lastBad.iso * higher.iso), isoRange);
          if (refineIso > lastBad.iso && refineIso < higher.iso) {
            const middle = await test(refineIso, "gain refine");
            if (middle && quality(middle).good) return { good: middle, best };
          }
          return { good: higher, best };
        }
        if (!higherQ.needsGain) break;
        lastBad = higher;
      }
      return { best };
    };

    let winnerDecode: ReceivePerformance | undefined;
    try {
      const baselineRequested = make(autoExposure, autoIso);
      baselineCandidate = baselineRequested;
      baselineRequested.coarseGrid = true;
      const baseline = await measureCandidate(baselineRequested, "Baseline", "baseline");
      if (!baseline) {
        this.optimizeState = "paused";
        this.optimizeReason = this.optimizeReason || "camera produced no optical optimizer measurements";
        return;
      }
      // The first sample establishes thresholds in whichever mode is currently
      // available: exact QR-function-module optics when geometry exists, or the
      // global black/white fallback before the first successful decode.
      const baselineMetric = opticsOf(baseline)!;
      if (targetedOf(baseline)) targetedThresholds ??= thresholdsFrom(baselineMetric, true);
      else globalThresholds ??= thresholdsFrom(baselineMetric, false);

      // The optimizer used to reject an actively-scanning baseline because a
      // hard optical floor happened to be stricter than the real decoder. Take
      // a short decode sample (and honor a decode immediately preceding the
      // run) so a setting that actually scans becomes the reference truth.
      const hadFreshLiveDecode = targetedOf(baseline) && this.lastValidDecodeAt !== undefined &&
        startedAt - this.lastValidDecodeAt < 1200;
      if (targetedOf(baseline)) {
        const active = await activateExposureCandidate(baseline, true);
        if (active) {
          try {
            this.optimizeRound = "verify";
            const sample = await measureDecode("Baseline decode", active.epoch);
            baseline.decode.push(await sample.result);
          } finally {
            epochs.close(active.epoch);
          }
        }
        if (hadFreshLiveDecode || decodeOf(baseline).validDecodes > 0) provenBaseline = baselineMetric;
      }
      baseline.state = provenBaseline || quality(baseline).good ? "working baseline" : "Auto baseline";
      refresh();

      let lastGood: Candidate | undefined = (provenBaseline || quality(baseline).good) ? baseline : undefined;
      let firstBadExposure: number | undefined;
      let seedIso = baseline.iso;
      // Deliberately narrow: Auto is the bright ceiling; we only search a modest
      // darker/faster band instead of plunging into an unreadable dark tail.
      const ratios = [0.85, 0.72, 0.60];
      for (let index = 0; index < ratios.length && performance.now() < deadline - 1500; index++) {
        const exposure = this.quantize(Math.max(exposureRange.min, autoExposure * ratios[index]!), exposureRange);
        if (exposure >= autoExposure || (lastGood && exposure >= lastGood.exposure)) continue;
        this.optimizeRound = "shutter";
        this.optimizeDecision = `shorter shutter ${index + 1}/${ratios.length}`;
        const tuned = await tuneIsoForExposure(exposure, seedIso, `Shutter ${index + 1}`);
        if (tuned.good) {
          tuned.good.state = "clean";
          lastGood = tuned.good;
          seedIso = tuned.good.iso;
          refresh();
          continue;
        }
        firstBadExposure = exposure;
        if (tuned.best) tuned.best.state = "below quality floor";
        refresh();
        // If max/raised gain could not make this shutter clean, shorter shutters
        // are even less useful. Stop instead of testing the dark tail.
        break;
      }

      // One boundary refinement is enough. This is deliberately not an endless
      // hill climb: we want a fast, stable answer just inside the clean region.
      if (lastGood && firstBadExposure && firstBadExposure < lastGood.exposure && performance.now() < deadline - 1700) {
        const exposure = this.quantize(Math.sqrt(lastGood.exposure * firstBadExposure), exposureRange);
        if (exposure < lastGood.exposure && exposure > firstBadExposure) {
          this.optimizeDecision = "quality-boundary refinement";
          const refined = await tuneIsoForExposure(exposure, lastGood.iso, "Boundary");
          if (refined.good) {
            refined.good.state = "clean boundary";
            lastGood = refined.good;
            seedIso = refined.good.iso;
          } else if (refined.best) refined.best.state = "boundary failed";
          refresh();
        }
      }

      const measured = [...candidates.values()].filter((candidate) => candidate.optics.length);
      if (!measured.length) {
        this.optimizeState = "paused";
        this.optimizeReason = "camera produced no optical optimizer measurements";
        return;
      }
      // GLOBAL metrics are never allowed to certify a winner. If discovery
      // acquired a QR during the sweep, re-measure the strongest bootstrap
      // candidates so they receive exact QR-function-module metrics.
      let passing = measured.filter((candidate) => targetedOf(candidate) &&
        (quality(candidate).good || (candidate === baseline && Boolean(provenBaseline))))
        .sort((a, b) => a.exposure - b.exposure || a.iso - b.iso);
      if (!passing.length && performance.now() < deadline + 400) {
        const bootstrap = [...measured]
          .sort((a, b) => quality(b).margin - quality(a).margin || b.exposure - a.exposure)
          .slice(0, 3);
        for (const candidate of bootstrap) {
          const certified = await measureCandidate(candidate, "QR certify", "verify", true);
          if (certified && targetedOf(certified) && quality(certified).good) break;
        }
        passing = [...candidates.values()].filter((candidate) => targetedOf(candidate) &&
          (quality(candidate).good || (candidate === baseline && Boolean(provenBaseline))))
          .sort((a, b) => a.exposure - b.exposure || a.iso - b.iso);
      }
      if (!passing.length) {
        await this.restoreOptimizationBest("exposure");
        this.optimizeState = "paused";
        this.optimizeReason = "current QR-validated setting remains best";
        refresh();
        return;
      }
      const comfortable = passing.filter((candidate) => quality(candidate).comfortable);
      let opticalWinner = comfortable[0] ?? passing[0]!;
      opticalWinner.state = "QR optical winner";
      const safer = [...passing]
        .filter((candidate) => candidate !== opticalWinner && candidate.exposure >= opticalWinner.exposure)
        .sort((a, b) => a.exposure - b.exposure || a.iso - b.iso)[0];
      this.optimizeDecision = safer ? "brief QR/s sanity A/B" : "brief QR/s sanity";
      refresh();

      // Decoder throughput is now only a final veto/sanity check. It does not
      // steer the exposure search. Compare at most two settings, once each.
      const finalists = [opticalWinner, safer].filter((candidate, index, all): candidate is Candidate =>
        Boolean(candidate) && all.indexOf(candidate) === index);
      for (let index = finalists.length - 1; index >= 0 && performance.now() < deadline + 1000; index--) {
        const candidate = finalists[index]!;
        this.optimizeRound = "verify";
        const active = await activateExposureCandidate(candidate, true);
        if (!active) continue;
        const sample = await measureDecode(`verify · ${finalists.length - index}/${finalists.length}`, active.epoch);
        epochs.close(active.epoch);
        const result = await sample.result;
        active.candidate.decode.push(result);
        active.candidate.state = active.candidate === opticalWinner ? "optical winner verified" : "safer verified";
        refresh();
      }

      if (safer) {
        const winnerP = decodeOf(opticalWinner);
        const saferP = decodeOf(safer);
        const saferClearlyWins = saferP.validDecodes >= 2 &&
          (winnerP.validDecodes === 0 || saferP.validDecodesPerSecond > winnerP.validDecodesPerSecond * 1.18);
        if (saferClearlyWins) {
          opticalWinner.state = "QR/s vetoed";
          safer.state = "winner";
          opticalWinner = safer;
        }
      }

      let restored = await activateExposureCandidate(opticalWinner, true);
      if (!restored) {
        this.optimizeState = "paused";
        this.optimizeReason = "winning settings could not be restored";
        return;
      }
      // Validate the ACTUAL committed frames, not an earlier visit. A final
      // winner must still show real QR-module quality and at least one live QR
      // decode during a longer hold. Otherwise fall back to the safer passing
      // candidate (or the pre-optimize exposure).
      let finalOptics: OptimizerOpticalMeasurement | undefined;
      let finalDecode: ReceivePerformance | undefined;
      try {
        finalOptics = await measureOptics("Commit optics", restored.epoch);
        if (finalOptics) opticalWinner.optics.push(finalOptics);
        const sample = await measureDecode("commit · hold", restored.epoch);
        finalDecode = await sample.result;
      } catch {
        finalOptics = undefined;
        finalDecode = undefined;
      } finally {
        epochs.close(restored.epoch);
      }
      const commitGood = Boolean(finalOptics?.targeted && quality(opticalWinner).good &&
        finalDecode && finalDecode.validDecodes > 0);
      if (!commitGood) {
        opticalWinner.state = "commit validation failed";
        if (safer) {
          restored = await activateExposureCandidate(safer, true);
          if (restored) {
            try {
              const saferOptics = await measureOptics("Safer commit optics", restored.epoch);
              safer.optics.push(saferOptics);
              const saferSample = await measureDecode("commit · safer", restored.epoch);
              const saferDecode = await saferSample.result;
              if (saferOptics.targeted && quality(safer).good && saferDecode.validDecodes > 0) {
                opticalWinner = safer;
                opticalWinner.state = "safe winner";
                finalDecode = saferDecode;
              } else {
                await this.restoreOptimizationBest("exposure");
                this.optimizeState = "paused";
                this.optimizeReason = "final QR validation failed; restored pre-optimize exposure";
                refresh();
                return;
              }
            } finally { epochs.close(restored.epoch); }
          }
        } else {
          await this.restoreOptimizationBest("exposure");
          this.optimizeState = "paused";
          this.optimizeReason = "final QR validation failed; restored pre-optimize exposure";
          refresh();
          return;
        }
      }
      this.commitSettings(this.settings());
      winnerDecode = finalDecode ?? decodeOf(opticalWinner);
      this.optimizeBestPerformance = winnerDecode;
      this.optimizeCandidatePerformance = winnerDecode;
      const winnerOptics = opticsOf(opticalWinner)!;
      const finalObservation = this.latest?.at && this.latest.at >= startedAt ? this.latest : initialObservation;

      this.optimizeState = "complete";
      this.optimizeRound = undefined;
      this.optimizeVisit = undefined;
      this.optimizeSurvivors = undefined;
      this.optimizeDecision = "winner committed";
      const qrRate = winnerDecode.validDecodesPerSecond;
      this.optimizeSummary = `${qrRate.toFixed(1)} QR/s · separation ${winnerOptics.separation.toFixed(0)} · noise ${winnerOptics.noise.toFixed(1)}`;
      this.optimizeReason = `${measured.length} optical settings measured; decoder used only for final sanity check`;
      refresh();
      if (finalObservation) {
        this.lock(finalObservation, "pixel-quality exposure optimizer converged; focus untouched");
      } else {
        this.lockedAt = performance.now();
        this.transition("STABILIZING", "pixel-quality optimizer converged from global contrast bootstrap");
        this.changed();
      }
    } finally {
      epochs.finish();
    }
  }

  startOptimizer(
    measureOptics: (label: string, epoch: number) => Promise<OptimizerOpticalMeasurement>,
    measureDecode: (label: string, epoch: number) => Promise<PerformanceSample>,
    epochs: OptimizerEpochHooks,
  ): Promise<void> {
    return this.optimize(measureOptics, measureDecode, epochs);
  }

  pauseOptimizer(reason = "optimizer paused"): void {
    if (!this.isOptimizing()) return;
    this.cancel(reason);
    this.optimizeState = "paused";
    this.optimizeReason = reason;
  }

  noteDecoderCompletion(scanId: number, now = performance.now()): void {
    if (scanId < this.decodeBoundary) return;
    this.decoderCompletionsInGeneration++;
    this.completionTimes.push(now);
    while (this.completionTimes.length && this.completionTimes[0]! < now - 8000) this.completionTimes.shift();
  }

  noteValidDecode(scanId?: number, now = performance.now()): void {
    if (scanId === undefined || scanId < this.decodeBoundary) return;
    this.lastValidDecodeAt = now;
    if (scanId !== this.lastValidScanId) {
      this.lastValidScanId = scanId;
      this.validDecodesInGeneration++;
      this.validDecodeTimes.push(now);
      while (this.validDecodeTimes.length && this.validDecodeTimes[0]! < now - 10000) this.validDecodeTimes.shift();
    }
  }

  noteUsefulDecode(scanId?: number, now = performance.now()): void {
    if (scanId !== undefined && scanId >= this.decodeBoundary) this.lastUsefulDecodeAt = now;
  }

  observe(
    id: number,
    geometry: FocusGeometry,
    metrics: QrOpticalMetrics,
    totalTiles = 1,
    now = performance.now(),
    captureFps = 0,
  ): void {
    const observation = { id, at: now, geometry, metrics, totalTiles, captureFps };
    this.latest = observation;
    this.targetMissingSince = 0;
    this.resolveWaiter(observation);

    if (this.strategy !== "auto" || this.calibrationMode === "off" || this.state === "OVERRIDE") {
      this.changed();
      return;
    }

    if (this.state === "OPTIMIZE_EXPOSURE" || this.state === "OPTIMIZE_VERIFY") {
      if (this.geometryChanged(geometry, this.stableGeometry)) {
        if (!this.optimizeMovementSince) this.optimizeMovementSince = now;
        if (now - this.optimizeMovementSince >= CAMERA_TUNING.optimizeMovementConfirmMs) {
          this.cancel("target moved during optimization");
          this.optimizeState = "cancelled";
          this.stableGeometry = geometry;
          this.stableSince = now;
                this.optimizeMovementSince = 0;
          this.transition("STABILIZING", "target moved during optimization; exposure best retained; focus untouched");
          return;
        }
      } else this.optimizeMovementSince = 0;
    }




    if (this.state === "TARGET_LOST_GRACE") {
      this.transition("LOCKED", "static target returned during loss grace; camera state retained");
      return;
    }
    if (this.state === "LOCKED") {
      const decodeFresh = this.decodeIsFresh(now);
      if (decodeFresh) {
        const settings = this.settings();
        this.lastWorkingState = {
          focusMode: settings.focusMode, focusDistance: settings.focusDistance,
          exposureTime: settings.exposureTime, iso: settings.iso, optical: metrics, geometry,
        };
        const convincing = metrics.confidence >= 0.86 && metrics.focusScore >= CAMERA_TUNING.convincingFocusScore &&
          this.exposureAcceptable(metrics, 0.45) && this.validDecodesInGeneration >= 3;
        const priorQuality = this.bestKnownGood ? this.bestKnownGood.optical.focusScore + this.bestKnownGood.optical.exposureScore : -Infinity;
        if (convincing && (!this.bestKnownGood || metrics.focusScore + metrics.exposureScore >= priorQuality - 0.04)) {
          this.bestKnownGood = this.lastWorkingState;
        }
      }
      const reference = this.bestKnownGood;
      const optimizedHold = this.optimizeState === "complete";
      const moved = this.geometryChanged(geometry, reference?.geometry);
      const silence = this.decodeSilence(now);
      const silenceThreshold = this.silenceThreshold();
      const noProgress = silence >= silenceThreshold;
      const moderateFocusBad = Boolean(reference && moved && metrics.confidence >= 0.82 &&
        metrics.focusScore < Math.max(0.35, reference.optical.focusScore - 0.14));
      const severeFocusBad = metrics.confidence >= 0.78 && metrics.focusScore <= Math.min(
        CAMERA_TUNING.severeFocusScore, (reference?.optical.focusScore ?? 0.55) - 0.25);
      const decoderActive = this.decoderCompletionsInGeneration >= 2 && this.pipelineIsActive(now);
      const severeBlurDelay = Math.max(CAMERA_TUNING.severeBlurConfirmMs,
        Math.min(900, (this.medianInterval(this.completionTimes) ?? 180) * 2.5));
      const severeConfirmed = severeFocusBad && decoderActive && silence >= severeBlurDelay;
      const focusBad = moderateFocusBad && noProgress || severeConfirmed;
      const exposureBad = Boolean(reference && !focusBad && noProgress && decoderActive && metrics.focusScore >= 0.55 &&
        !this.exposureAcceptable(metrics, Math.max(0.38, reference.optical.exposureScore - 0.22)));
      this.lockedFocusFailures = focusBad ? this.lockedFocusFailures + 1 : 0;
      this.lockedExposureFailures = exposureBad ? this.lockedExposureFailures + 1 : 0;
      const requiredFocusSamples = severeConfirmed ? 2 : CAMERA_TUNING.recoverySamples;
      if (this.lockedFocusFailures >= requiredFocusSamples) {
        this.lockedFocusFailures = 0;
        // Focus is hardware/user-owned. A soft frame is diagnostic information,
        // not permission for AirGapper to restart AF and blur subsequent frames.
        this.lastReason = "sustained blur detected; focus left untouched";
      } else if (!optimizedHold && this.lockedExposureFailures >= CAMERA_TUNING.recoverySamples) {
        this.lockedExposureFailures = 0;
        this.lastReason = "decoder exposure quality dipped; hardware AE retained";
      } else {
        this.lastReason = decodeFresh ? "real decoder progress; camera held" :
          metrics.focusScore >= CAMERA_TUNING.focusExcellent && metrics.exposureScore >= CAMERA_TUNING.exposureExcellent
            ? "decoder silent with excellent static optics; camera held" : "decoder silence below recovery threshold";
      }
      // Auto exposure is hardware-owned, but photographic AE is usually too
      // bright for an emissive QR screen. Nudge only exposure compensation,
      // slowly, from targeted QR pixels. This never touches focus or enters
      // manual shutter/ISO mode.
      void this.maybeTrimAutomaticExposure(metrics, now);
      this.changed();
      return;
    }

    if (!this.isAcquiring()) return;
    if (!this.stableGeometry || this.geometryChanged(geometry, this.stableGeometry)) {
      this.stableGeometry = geometry;
      this.stableSince = now;
      this.transition("STABILIZING", "QR geometry found; camera focus left untouched");
    } else {
      this.stableGeometry = this.blendGeometry(this.stableGeometry, geometry);
      const stable = now - this.stableSince >= CAMERA_TUNING.geometryStabilityMs;
      const decodeProven = this.validDecodesInGeneration > 0 && this.decodeIsFresh(now);
      if (stable && decodeProven) {
        this.lock(observation, "QR decoding stable; hardware focus left untouched");
      } else {
        this.lastReason = metrics.focusScore < 0.38
          ? "image appears soft; hardware focus left untouched"
          : "waiting for a decodable exposure; focus untouched";
      }
    }
    this.changed();
  }

  noteTargetAbsent(now = performance.now()): void {
    if (this.strategy !== "auto" || this.state === "UNAVAILABLE" || this.state === "OVERRIDE") return;
    if (!this.targetMissingSince) this.targetMissingSince = now;
    if (this.isOptimizing()) {
      this.lastReason = "QR absent; explicit exposure tournament continues";
      this.changed();
      return;
    } else if (this.state === "LOCKED") {
      this.transition("TARGET_LOST_GRACE", "static target missing; continuous AF and exposure retained");
    } else if ((this.state === "STABILIZING" || this.state === "TARGET_LOST_GRACE") &&
        now - this.targetMissingSince >= CAMERA_TUNING.targetLostGraceMs) {
      this.stableGeometry = undefined;
      this.stableSince = 0;
        this.transition("SEEKING", "target absent; camera state retained while decoding continues");
    }
    this.changed();
  }

  diagnostics(): FocusDiagnostics {
    const settings = this.settings();
    const optical = this.latest?.metrics;
    const invariantWarning = undefined;
    return {
      state: this.state,
      stateMs: performance.now() - this.stateSince,
      focusOwner: this.focusOwner(settings),
      invariantWarning,
      calibrationMode: this.calibrationMode,
      availableModes: this.overrideFocusModes(),
      requestedMode: this.requestedMode,
      actualMode: settings.focusMode,
      actualDistance: settings.focusDistance,
      distanceRange: this.caps.focusDistance,
      poiSupported: Boolean(this.caps.pointsOfInterest),
      exposureRange: this.manualExposure() ? this.caps.exposureTime : undefined,
      isoRange: this.caps.iso,
      actualExposureMode: settings.exposureMode,
      actualExposure: settings.exposureTime,
      actualIso: settings.iso,
      actualExposureCompensation: settings.exposureCompensation,
      exposureCompensationRange: this.caps.exposureCompensation,
      baselineFocus: this.baselineFocus,
      baselineExposure: this.baselineExposure,
      baselineIso: this.baselineIso,
      requestedExposure: this.requestedExposure,
      requestedIso: this.requestedIso,
      focusProbes: this.focusProbes,
      exposureProbes: this.exposureProbes,
      optical,
      targetDetected: Boolean(this.latest && !this.targetMissingSince),
      geometryStable: Boolean(this.stableSince && performance.now() - this.stableSince >= CAMERA_TUNING.geometryStabilityMs),
      totalTiles: this.latest?.totalTiles ?? 0,
      lastValidDecodeAt: this.lastValidDecodeAt,
      lastUsefulDecodeAt: this.lastUsefulDecodeAt,
      validDecodesInGeneration: this.validDecodesInGeneration,
      decoderCompletionsInGeneration: this.decoderCompletionsInGeneration,
      decodeSilenceMs: this.decodeSilence(performance.now()),
      recentInterdecodeMs: this.medianInterval(this.validDecodeTimes),
      recentCompletionMs: this.medianInterval(this.completionTimes),
      likelyTemporalFailure: Boolean(this.latest && !this.decodeIsFresh(performance.now()) && optical &&
        optical.focusScore >= CAMERA_TUNING.focusExcellent && optical.exposureScore >= CAMERA_TUNING.exposureExcellent),
      knownGood: Boolean(this.bestKnownGood),
      knownGoodSettings: this.bestKnownGood && {
        focusMode: this.bestKnownGood.focusMode,
        focusDistance: this.bestKnownGood.focusDistance,
        exposureTime: this.bestKnownGood.exposureTime,
        iso: this.bestKnownGood.iso,
      },
      committedFocusMode: this.committedFocusMode,
      committedFocusDistance: this.committedFocusDistance,
      committedExposureMode: this.committedExposureMode,
      committedExposureTime: this.committedExposureTime,
      committedIso: this.committedIso,
      candidateExposureTime: this.candidateExposureTime,
      candidateIso: this.candidateIso,
      lockedMs: this.state === "LOCKED" ? performance.now() - this.lockedAt : undefined,
      initialLockMs: this.initialLockMs,
      fullResetCount: this.fullResetCount,
      focusRefinementCount: this.focusRefinementCount,
      exposureRefinementCount: this.exposureRefinementCount,
      optimizeState: this.optimizeState,
      optimizeRound: this.optimizeRound,
      optimizeVisit: this.optimizeVisit,
      optimizeSurvivors: this.optimizeSurvivors,
      optimizeDecision: this.optimizeDecision,
      optimizeCandidatePerformance: this.optimizeCandidatePerformance,
      optimizeBestPerformance: this.optimizeBestPerformance,
      optimizeSummary: this.optimizeSummary,
      optimizeExposureStepEV: this.optimizeExposureStepEV,
      optimizeShutterStepEV: this.optimizeShutterStepEV,
      optimizeComparison: this.optimizeComparison,
      optimizePairedSamples: this.optimizePairedSamples,
      optimizeReason: this.optimizeReason,
      optimizeCandidates: this.optimizeCandidates.map((candidate) => ({ ...candidate })),
      optimizeUniqueConfigurations: this.optimizeCandidates.length,
      optimizeExposureVisited: this.optimizeExposureVisited && { ...this.optimizeExposureVisited },
      optimizeIsoVisited: this.optimizeIsoVisited && { ...this.optimizeIsoVisited },
      transitions: [...this.transitions],
      lastReason: this.lastReason,
    };
  }

  private exposureAcceptable(metrics: QrOpticalMetrics, floor: number): boolean {
    return metrics.confidence >= 0.86 && metrics.exposureScore >= floor &&
      metrics.separation >= 48 && metrics.noise <= Math.max(20, metrics.separation * 0.25) &&
      metrics.clipping < 0.55 && metrics.banding < 0.32;
  }

  private lock(observation: OpticalObservation, reason: string): void {
    this.commitSettings(this.settings());
    this.lastWorkingState = {
      focusMode: this.committedFocusMode,
      focusDistance: this.committedFocusDistance,
      exposureTime: this.committedExposureTime,
      iso: this.committedIso,
      optical: observation.metrics,
      geometry: observation.geometry,
    };
    if (observation.metrics.focusScore >= CAMERA_TUNING.convincingFocusScore &&
        this.exposureAcceptable(observation.metrics, 0.45) && this.validDecodesInGeneration >= 1) {
      this.bestKnownGood = this.lastWorkingState;
    }
    this.candidateExposureTime = undefined;
    this.candidateIso = undefined;
    this.lockedAt = performance.now();
    this.transition("LOCKED", reason);
    this.stableGeometry = observation.geometry;
    this.stableSince = observation.at;
    if (this.initialLockMs === undefined) this.initialLockMs = performance.now() - this.attachedAt;
    this.changed();
  }

  private async maybeTrimAutomaticExposure(metrics: QrOpticalMetrics, now: number): Promise<void> {
    if (this.autoExposureTrimRunning || this.isOptimizing() || this.strategy !== "auto" || this.state !== "LOCKED" ||
        !this.track || this.track.readyState !== "live") return;
    const range = this.caps.exposureCompensation;
    if (!range || range.min > 0 || range.max < 0 || metrics.confidence < 0.82 ||
        metrics.focusScore < 0.42 || metrics.banding > 0.45) return;

    const settings = this.settings();
    if (settings.exposureMode === "manual") return;

    // Auto is intentionally conservative. Start slightly dark, then change only
    // when two consecutive QR-targeted samples agree that the image is clearly
    // outside a wide safe band. This avoids brightness oscillation from display
    // scanout, sensor noise, or one unusual sender frame.
    const tooBright = metrics.whiteLevel > AUTO_QR_WHITE_HIGH ||
      (metrics.blackLevel > AUTO_QR_BLACK_HIGH && metrics.separation >= AUTO_QR_SEPARATION_LOW);
    const tooDark = !tooBright && (metrics.whiteLevel < AUTO_QR_WHITE_LOW || metrics.separation < AUTO_QR_SEPARATION_LOW);
    const direction = tooBright ? -1 : tooDark ? 1 : 0;
    if (direction === 0) {
      this.autoExposureTrimDirection = 0;
      this.autoExposureTrimConfirmations = 0;
      return;
    }
    if (direction !== this.autoExposureTrimDirection) {
      this.autoExposureTrimDirection = direction;
      this.autoExposureTrimConfirmations = 1;
      return;
    }
    this.autoExposureTrimConfirmations++;
    if (this.autoExposureTrimConfirmations < 2 || now - this.lastAutoExposureTrimAt < AUTO_QR_EV_COOLDOWN_MS) return;

    const current = this.quantize(Math.min(0, settings.exposureCompensation ?? this.autoExposureCompensation ?? AUTO_QR_EV_BIAS), range);
    const step = Math.max(range.step ?? 0, 0.25);
    const next = direction < 0
      ? this.quantize(Math.max(range.min, current - step), range)
      : this.quantize(Math.min(0, current + step), range);
    if (Math.abs(next - current) < 1e-6) return;

    this.autoExposureTrimRunning = true;
    this.lastAutoExposureTrimAt = now;
    this.autoExposureTrimConfirmations = 0;
    try {
      // Only the EV number changes. Never re-select AE mode or touch focus.
      const accepted = await this.apply(this.track, { exposureCompensation: next });
      if (accepted) {
        this.autoExposureCompensation = next;
        this.committedExposureCompensation = next;
        this.lastReason = `hardware AE QR bias ${next > 0 ? "+" : ""}${Number(next.toFixed(2))} EV`;
      }
    } finally {
      this.autoExposureTrimRunning = false;
    }
  }

  private async enterAutomaticExposureState(
    reason: string,
    generation = this.generation,
    resetExposure = false,
    restoreExposure = false,
  ): Promise<void> {
    const track = this.track;
    if (!track || track.readyState !== "live" || !this.current(generation)) return;

    const patch: CameraPatch = {};

    // Focus is intentionally absent from this helper. It manages automatic
    // EXPOSURE state only.
    if (resetExposure && this.exposureModes().includes("continuous")) {
      patch.exposureMode = "continuous";
      if (this.caps.exposureCompensation &&
          this.caps.exposureCompensation.min <= 0 && this.caps.exposureCompensation.max >= 0) {
        const neutralBias = this.quantize(Math.max(this.caps.exposureCompensation.min, AUTO_QR_EV_BIAS), this.caps.exposureCompensation);
        patch.exposureCompensation = Math.min(0, neutralBias);
        this.autoExposureCompensation = patch.exposureCompensation;
      }
    } else if (restoreExposure && this.settings().exposureMode === "manual" &&
        this.manualExposure() && this.committedExposureTime !== undefined) {
      patch.exposureMode = "manual";
      patch.exposureTime = this.committedExposureTime;
      if (this.committedIso !== undefined) patch.iso = this.committedIso;
    }

    let accepted = true;
    if (Object.keys(patch).length) {
      if (patch.focusMode && patch.exposureMode) this.fullResetCount++;
      accepted = await this.apply(track, patch);
      this.beginDecodeGeneration();
    }
    if (!this.current(generation)) return;
    this.lastReason = accepted ? reason : `${reason}; camera rejected requested controls`;
    this.changed();
  }

  private async restoreOptimizationBest(axis: "focus" | "exposure" | "all" = "all"): Promise<void> {
    const track = this.track;
    if (!track) return;
    const patch: CameraPatch = {};
    if (axis === "focus" || axis === "all") {
      const mode = this.committedFocusMode;
      if (mode === "manual" && this.committedFocusDistance !== undefined) {
        patch.focusMode = "manual";
        patch.focusDistance = this.committedFocusDistance;
      } else if (mode && this.focusModes().includes(mode)) patch.focusMode = mode;
    }
    if (axis === "exposure" || axis === "all") {
      if (this.committedExposureMode !== "continuous" && this.manualExposure() && this.committedExposureTime !== undefined) {
        patch.exposureMode = "manual";
        patch.exposureTime = this.committedExposureTime;
        if (this.committedIso !== undefined) patch.iso = this.committedIso;
      } else if (this.committedExposureMode === "continuous" && this.exposureModes().includes("continuous")) {
        patch.exposureMode = "continuous";
        patch.exposureCompensation = this.committedExposureCompensation;
      }
    }
    this.candidateExposureTime = undefined;
    this.candidateIso = undefined;
    if (Object.keys(patch).length) {
      await this.apply(track, patch);
      this.beginDecodeGeneration();
    }
  }

  private focusOwner(settings: CameraSettings): FocusOwner {
    if (this.state === "UNAVAILABLE") return "NONE";
    if (this.state === "OVERRIDE" || this.strategy !== "auto") return "DEVELOPER";
    return settings.focusMode === "manual" ? "MANUAL" : "HARDWARE";
  }

  private transition(next: FocusState, reason: string): void {
    if (this.state !== next) {
      this.transitions.push(`${this.state} → ${next}: ${reason}`);
      if (this.transitions.length > 8) this.transitions.shift();
      this.state = next;
      this.stateSince = performance.now();
    }
    this.lastReason = this.state === "SEEKING"
      ? "target absent; camera focus and exposure retained"
      : this.lastReason;
    this.changed();
  }

  private async configureInitialHardwareFocusOnce(): Promise<void> {
    if (this.automaticFocusConfigured || this.strategy !== "auto") return;
    this.automaticFocusConfigured = true;
    const track = this.track;
    if (!track || track.readyState !== "live") return;
    const modes = this.focusModes();
    if (!modes.includes("single-shot")) {
      // If the browser does not expose a one-shot mode, leave its native focus
      // behavior completely alone rather than reasserting continuous AF.
      this.lastReason = "hardware focus mode left unchanged";
      this.changed();
      return;
    }
    this.requestedMode = "single-shot";
    await this.apply(track, { focusMode: "single-shot" });
    this.committedFocusMode = this.settings().focusMode;
    this.committedFocusDistance = this.settings().focusDistance;
    this.lastReason = "single hardware autofocus sweep requested; no automatic refocuses will follow";
    this.changed();
  }

  private async applyDeveloperFocus(): Promise<void> {
    const track = this.track;
    if (!track) return;
    if (this.strategy === "manual" && this.manualFocus() && this.manualDistance !== undefined) {
      this.requestedMode = "manual";
      const requested = this.manualDistance;
      await this.apply(track, { focusMode: "manual", focusDistance: requested });
      await new Promise((resolve) => setTimeout(resolve, 80));
      const actual = this.settings();
      const step = this.caps.focusDistance?.step ?? 0.01;
      if ((actual.focusMode && actual.focusMode !== "manual") ||
          (actual.focusDistance !== undefined && Math.abs(actual.focusDistance - requested) > step / 2)) {
        await this.apply(track, { focusMode: "manual", focusDistance: requested });
      }
    } else if (this.strategy === "camera-auto" || this.strategy === "single-shot") {
      const mode = this.strategy === "single-shot" ? "single-shot" : (this.hardwareFocusMode() ?? "continuous");
      this.requestedMode = mode;
      await this.apply(track, { focusMode: mode });
    }
    this.changed();
  }

  private async applyProbe(generation: number, patch: CameraPatch, fenceImmediately = true): Promise<boolean> {
    const track = this.track;
    if (!track || !this.current(generation)) return false;
    if (patch.focusMode) this.requestedMode = patch.focusMode;
    const accepted = await this.apply(track, patch);
    if (accepted && fenceImmediately && this.current(generation)) this.beginDecodeGeneration();
    return accepted && this.current(generation);
  }

  private resolveWaiter(observation: OpticalObservation): void {
    const waiter = this.waiter;
    if (!waiter || waiter.generation !== this.generation || observation.id <= waiter.afterId || observation.at < waiter.notBefore) return;
    waiter.afterId = observation.id;
    if (waiter.discard-- > 0) return;
    waiter.samples.push(observation);
    if (waiter.samples.length < waiter.requiredSamples) return;
    this.waiter = undefined;
    waiter.resolve(this.aggregate(waiter.samples));
  }
  private aggregate(samples: OpticalObservation[]): OpticalObservation {
    const median = (values: number[]): number => {
      values.sort((a, b) => a - b);
      return values[values.length >> 1]!;
    };
    const value = (read: (sample: OpticalObservation) => number) => median(samples.map(read));
    const metric = (key: keyof QrOpticalMetrics) => value((sample) => Number(sample.metrics[key]));
    const latest = samples[samples.length - 1]!;
    return {
      ...latest,
      captureFps: value((sample) => sample.captureFps),
      geometry: {
        x: value((sample) => sample.geometry.x),
        y: value((sample) => sample.geometry.y),
        scale: value((sample) => sample.geometry.scale),
        perspectiveX: value((sample) => sample.geometry.perspectiveX),
        perspectiveY: value((sample) => sample.geometry.perspectiveY),
        quality: value((sample) => sample.geometry.quality),
      },
      metrics: {
        confidence: metric("confidence"),
        focusScore: metric("focusScore"),
        exposureScore: metric("exposureScore"),
        transitionWidthModules: metric("transitionWidthModules"),
        blackLevel: metric("blackLevel"),
        whiteLevel: metric("whiteLevel"),
        separation: metric("separation"),
        noise: metric("noise"),
        clipping: metric("clipping"),
        banding: metric("banding"),
        temporalContamination: metric("temporalContamination"),
        tiles: Math.round(metric("tiles")),
        sampledModules: Math.round(metric("sampledModules")),
      },
    };
  }

  private beginDecodeGeneration(): void {
    this.decodeBoundary = this.currentScanId();
    this.cameraGenerationStartedAt = performance.now();
    this.validDecodesInGeneration = 0;
    this.decoderCompletionsInGeneration = 0;
    this.lastValidScanId = -1;
  }

  private medianInterval(times: number[]): number | undefined {
    if (times.length < 2) return undefined;
    const gaps = times.slice(1).map((at, index) => at - times[index]!).filter((gap) => gap > 8).sort((a, b) => a - b);
    return gaps.length ? gaps[gaps.length >> 1] : undefined;
  }

  private silenceThreshold(): number {
    const decodeInterval = this.medianInterval(this.validDecodeTimes);
    const completionInterval = this.medianInterval(this.completionTimes);
    return Math.max(1200, (decodeInterval ?? completionInterval ?? 350) * 5);
  }

  private decodeSilence(now = performance.now()): number {
    const since = this.lastValidDecodeAt && this.lastValidDecodeAt >= this.cameraGenerationStartedAt
      ? this.lastValidDecodeAt : this.cameraGenerationStartedAt;
    return Math.max(0, now - since);
  }

  private decodeIsFresh(now = performance.now()): boolean {
    return this.validDecodesInGeneration > 0 && this.decodeSilence(now) <= this.silenceThreshold();
  }

  private pipelineIsActive(now = performance.now()): boolean {
    const latest = this.completionTimes.at(-1);
    const interval = this.medianInterval(this.completionTimes) ?? 350;
    return latest !== undefined && now - latest <= Math.max(1200, interval * 4);
  }

  private cancel(reason: string): void {
    this.generation++;
    this.waiter?.resolve(undefined);
    this.waiter = undefined;
    this.lastReason = reason;
  }

  private current(generation: number): boolean {
    return generation === this.generation && Boolean(this.track && this.track.readyState === "live");
  }

  private commitSettings(settings: CameraSettings): void {
    this.committedFocusMode = settings.focusMode;
    this.committedFocusDistance = settings.focusDistance;
    this.committedExposureMode = settings.exposureMode;
    this.committedExposureTime = settings.exposureTime;
    this.committedIso = settings.iso;
    this.committedExposureCompensation = settings.exposureCompensation;
  }

  private settings(): CameraSettings {
    const settings = { ...(this.track?.getSettings() ?? {}) } as CameraSettings;
    settings.focusDistance = this.sanitizeFocusDistance(settings.focusDistance);
    return settings;
  }
  private sanitizeFocusDistance(value?: number): number | undefined {
    const range = this.caps.focusDistance;
    return value !== undefined && Number.isFinite(value) && value >= 0 && value <= 1000 &&
      Boolean(range && Number.isFinite(range.min) && Number.isFinite(range.max) &&
        value >= range.min && value <= range.max)
      ? value : undefined;
  }
  private focusModes(): string[] { return Array.isArray(this.caps.focusMode) ? this.caps.focusMode : []; }
  private overrideFocusModes(): string[] {
    const modes = this.focusModes();
    const actual = this.settings().focusMode;
    // Android capability reporting is advisory in practice. Some OnePlus camera
    // providers temporarily report only manual even though AF modes still accept
    // constraints. Keep those developer choices visible and verify by applying.
    const hasFocusApi = modes.length > 0 || actual !== undefined || Boolean(this.caps.pointsOfInterest);
    return [
      ...(hasFocusApi ? ["camera-auto", "single-shot"] : []),
      ...(modes.includes("manual") && this.caps.focusDistance ? ["manual"] : []),
    ];
  }
  private exposureModes(): string[] { return Array.isArray(this.caps.exposureMode) ? this.caps.exposureMode : []; }
  private hardwareFocusMode(): string | undefined {
    const modes = this.focusModes();
    const actual = this.settings().focusMode;
    if (modes.includes("continuous") || actual === "continuous") return "continuous";
    if (modes.includes("single-shot") || actual === "single-shot") return "single-shot";
    return modes.length > 0 || actual !== undefined || Boolean(this.caps.pointsOfInterest) ? "continuous" : undefined;
  }
  private manualFocus(): boolean { return this.focusModes().includes("manual") && Boolean(this.caps.focusDistance); }
  private manualExposure(): boolean { return this.exposureModes().includes("manual") && Boolean(this.caps.exposureTime); }
  private isAcquiring(): boolean {
    return this.state === "SEEKING" || this.state === "STABILIZING";
  }
  private isOptimizing(): boolean {
    return this.optimizeState === "baseline" || this.optimizeState === "exposure" || this.optimizeState === "verification";
  }

  private quantize(value: number, range: NumericRange): number {
    const clamped = Math.max(range.min, Math.min(range.max, value));
    if (!range.step || range.step <= 0) return clamped;
    return Math.max(range.min, Math.min(range.max,
      range.min + Math.round((clamped - range.min) / range.step) * range.step));
  }

  private geometryChanged(current: FocusGeometry, baseline?: FocusGeometry): boolean {
    if (!baseline) return false;
    const displacement = Math.hypot(current.x - baseline.x, current.y - baseline.y);
    const scale = Math.abs(Math.log(Math.max(0.0001, current.scale) / Math.max(0.0001, baseline.scale)));
    const perspective = Math.max(
      Math.abs(current.perspectiveX - baseline.perspectiveX),
      Math.abs(current.perspectiveY - baseline.perspectiveY),
    );
    return displacement > CAMERA_TUNING.displacementRatio || scale > CAMERA_TUNING.scaleChangeRatio ||
      perspective > CAMERA_TUNING.perspectiveChange;
  }

  private blendGeometry(a: FocusGeometry, b: FocusGeometry): FocusGeometry {
    return {
      x: a.x * 0.75 + b.x * 0.25,
      y: a.y * 0.75 + b.y * 0.25,
      scale: a.scale * 0.75 + b.scale * 0.25,
      perspectiveX: a.perspectiveX * 0.75 + b.perspectiveX * 0.25,
      perspectiveY: a.perspectiveY * 0.75 + b.perspectiveY * 0.25,
      quality: a.quality * 0.75 + b.quality * 0.25,
    };
  }
}
