import type { QrOpticalMetrics } from "./qr-optics";

export type FocusStrategy = "auto" | "camera-auto" | "single-shot" | "manual";
export type CalibrationMode = "auto" | "off" | "force";
export type FocusState =
  | "UNAVAILABLE" | "SEEKING" | "STABILIZING" | "AUTO_AF_SETTLE"
  | "LOCKED" | "TARGET_LOST_GRACE" | "EXPOSURE_RECOVERY"
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
  exposureDiscardFrames: 3,
  exposureExcellent: 0.7,
  seekingOpticalIntervalMs: 110,
  lockedOpticalIntervalMs: 320,
  targetLostGraceMs: 1600,
  stabilizingRetryMs: 2500,
  poorFocusRetryMs: 480,
  maxStabilizingAfRetries: 2,
  recoverySamples: 3,
  severeFocusScore: 0.24,
  convincingFocusScore: 0.62,
  severeBlurConfirmMs: 480,
  optimizeMovementConfirmMs: 650,
  optimizeBudgetMs: 16000,
  optimizeWinRatio: 1.14,
  optimizeLossRatio: 0.88,
  acquisitionBracketDelayMs: 900,
};

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
  optimizeRound?: "coarse" | "revisit" | "finalist" | "refine";
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
  private stabilizingAfRetries = 0;

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
  private acquisitionBracketRunning = false;
  private acquisitionBracketTried = false;
  private decodeBoundary = 0;
  private cameraGenerationStartedAt = performance.now();
  private lastValidDecodeAt?: number;
  private lastUsefulDecodeAt?: number;
  private lastValidScanId = -1;
  private validDecodesInGeneration = 0;
  private decoderCompletionsInGeneration = 0;
  private readonly validDecodeTimes: number[] = [];
  private readonly completionTimes: number[] = [];
  private poorFocusSince = 0;
  private optimizeMovementSince = 0;
  private readonly transitions: string[] = [];
  private poiAimed = false;
  private invariantRepairPending = false;
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
    return this.state === "AUTO_AF_SETTLE" || this.state === "EXPOSURE_RECOVERY" ||
      this.state === "OPTIMIZE_EXPOSURE" || this.state === "OPTIMIZE_VERIFY";
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
    this.poiAimed = false;
    this.optimizeMovementSince = 0;
    this.stabilizingAfRetries = 0;
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
    this.acquisitionBracketRunning = false;
    this.acquisitionBracketTried = false;
    this.bestKnownGood = undefined;
    this.lastWorkingState = undefined;
    this.beginDecodeGeneration();
    this.committedFocusMode = undefined;
    this.committedFocusDistance = undefined;
    this.committedExposureMode = undefined;
    this.committedExposureTime = undefined;
    this.committedIso = undefined;
    this.committedExposureCompensation = undefined;
    if (this.strategy === "auto") {
      this.transition("SEEKING", "camera track changed; hardware AF owns focus");
      void this.enterAutoFocusAcquisition("camera opened", this.generation, true);
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
    const optimizedGeometryStillValid = this.optimizeState === "complete" && Boolean(this.latest && this.stableGeometry) &&
      !this.geometryChanged(this.latest!.geometry, this.stableGeometry);
    this.cancel("focus ownership changed");
    this.strategy = strategy;
    if (optimizing) this.optimizeState = "cancelled";
    if (strategy === "auto") {
      if (optimizedGeometryStillValid) {
        this.transition("STABILIZING", "restoring optimized optics for unchanged geometry");
        const generation = this.generation;
        void this.restoreOptimizationBest().then(() => {
          if (!this.current(generation)) return;
          if (this.latest) this.lock(this.latest, "optimized optics restored");
        });
      } else {
        if (this.optimizeState === "complete") {
          this.optimizeState = "idle";
          this.optimizeBestPerformance = undefined;
          this.optimizeSummary = undefined;
        }
        this.transition("SEEKING", "automatic optics selected; hardware AF owns focus");
        void this.enterAutoFocusAcquisition("automatic focus selected", this.generation, true);
      }
    } else {
      this.transition("OVERRIDE", "developer owns focus");
      const start = () => this.applyDeveloperFocus();
      if (optimizing) void this.restoreOptimizationBest().then(start);
      else void start();
    }
  }

  setCalibrationMode(mode: CalibrationMode): void {
    this.cancel("calibration mode changed");
    this.calibrationMode = mode;
    if (this.strategy === "auto") {
      this.transition("SEEKING", "calibration mode changed; hardware AF owns focus");
      void this.enterAutoFocusAcquisition("calibration mode changed", this.generation, true);
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
    void this.restoreOptimizationBest().then(() => this.transition("LOCKED", this.optimizeReason));
  }

  optimizeEligible(): boolean {
    const retryHasTarget = this.optimizeState !== "paused" || Boolean(this.latest && !this.targetMissingSince);
    return this.strategy === "auto" && !this.isOptimizing() && retryHasTarget && Boolean(
      this.track && this.track.readyState === "live" && this.manualExposure() && this.caps.iso,
    );
  }

  async optimize(
    measure: (label: string, epoch: number) => Promise<PerformanceSample>,
    epochs: OptimizerEpochHooks,
  ): Promise<void> {
    if (!this.optimizeEligible()) return;
    const generation = ++this.generation;
    const startedAt = performance.now();
    const deadline = startedAt + CAMERA_TUNING.optimizeBudgetMs;
    this.optimizeState = "baseline";
    this.optimizeRound = "coarse";
    this.optimizeCandidates = [];
    this.optimizeExposureVisited = undefined;
    this.optimizeIsoVisited = undefined;
    this.optimizeDecision = "starting";

    const initialObservation = this.latest;
    if (initialObservation) {
      this.stableGeometry = initialObservation.geometry;
      this.stableSince = performance.now();
    }
    const focusHealthy = Boolean(initialObservation && this.decodeIsFresh() && initialObservation.metrics.focusScore >= 0.55);
    if (!focusHealthy) {
      const patch: CameraPatch = {};
      const mode = this.hardwareFocusMode();
      if (mode) patch.focusMode = mode;
      if (this.caps.pointsOfInterest) patch.pointsOfInterest = [{
        x: initialObservation?.geometry.x ?? 0.5, y: initialObservation?.geometry.y ?? 0.5,
      }];
      this.transition("OPTIMIZE_EXPOSURE", "quick hardware AF refresh before exposure tournament");
      if (Object.keys(patch).length) await this.applyProbe(generation, patch, false);
      if (initialObservation) await this.waitForObservations(generation, initialObservation.id, 100, 0, 1, 500);
      else await new Promise((resolve) => setTimeout(resolve, 160));
      if (!this.current(generation)) return;
    }

    const origin = this.settings();
    const hardwareExposureRange = this.caps.exposureTime;
    const isoRange = this.caps.iso;
    if (!this.manualExposure() || !hardwareExposureRange || !isoRange || origin.exposureTime === undefined || origin.iso === undefined) {
      this.optimizeState = "paused";
      this.optimizeReason = "manual exposure and ISO controls unavailable";
      return;
    }
    const exposureRange: NumericRange = { ...hardwareExposureRange };
    if (exposureRange.max <= exposureRange.min) {
      this.optimizeState = "paused";
      this.optimizeReason = "camera has no safe exposure range";
      return;
    }
    this.commitSettings(origin);
    this.optimizeState = "exposure";
    this.transition("OPTIMIZE_EXPOSURE", "focus unchanged; full-range exposure tournament");

    const median = (values: number[]): number => {
      if (!values.length) return 0;
      const sorted = [...values].sort((a, b) => a - b);
      const middle = sorted.length >> 1;
      return sorted.length & 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
    };
    const aggregate = (windows: ReceivePerformance[]): ReceivePerformance => ({
      validDecodesPerSecond: median(windows.map((window) => window.validDecodesPerSecond)),
      usefulSymbolsPerSecond: median(windows.map((window) => window.usefulSymbolsPerSecond)),
      perQrAttemptSuccessRate: median(windows.map((window) => window.perQrAttemptSuccessRate)),
      captureFps: median(windows.map((window) => window.captureFps)),
      submittedJobs: windows.reduce((sum, window) => sum + window.submittedJobs, 0),
      completedJobs: windows.reduce((sum, window) => sum + window.completedJobs, 0),
      completionCoverage: median(windows.map((window) => window.completionCoverage)),
      sourceFrames: windows.reduce((sum, window) => sum + window.sourceFrames, 0),
      successfulSourceFrames: windows.reduce((sum, window) => sum + window.successfulSourceFrames, 0),
      qrAttempts: windows.reduce((sum, window) => sum + window.qrAttempts, 0),
      validDecodes: windows.reduce((sum, window) => sum + window.validDecodes, 0),
      measurementMs: windows.reduce((sum, window) => sum + window.measurementMs, 0),
      temporalContamination: median(windows.map((window) => window.temporalContamination ?? 0)),
    });
    type Candidate = {
      id: string; requestedExposure: number; requestedIso: number; exposure: number; iso: number;
      key: string; windows: ReceivePerformance[]; state: string; coarseGrid: boolean;
    };
    const candidates = new Map<string, Candidate>();
    let nextId = 1;
    const make = (exposure: number, iso: number): Candidate => {
      exposure = this.quantize(exposure, exposureRange);
      iso = this.quantize(iso, isoRange);
      const key = `${exposure}|${iso}`;
      const existing = candidates.get(key);
      if (existing) return existing;
      const candidate = {
        id: `C${nextId++}`, requestedExposure: exposure, requestedIso: iso, exposure, iso,
        key, windows: [], state: "queued", coarseGrid: false,
      };
      candidates.set(key, candidate);
      return candidate;
    };
    const incumbent = make(origin.exposureTime, origin.iso);
    const performanceOf = (candidate: Candidate) => aggregate(candidate.windows);
    const rate = (performance: ReceivePerformance) => performance.perQrAttemptSuccessRate *
      (performance.sourceFrames ? performance.qrAttempts / performance.sourceFrames : 0) * performance.captureFps;
    const compare = (a: Candidate, b: Candidate): number => {
      const ap = performanceOf(a), bp = performanceOf(b);
      const gap = rate(ap) - rate(bp);
      if (Math.abs(gap) > Math.max(0.2, Math.max(rate(ap), rate(bp)) * 0.04)) return gap > 0 ? -1 : 1;
      if (Math.abs(ap.perQrAttemptSuccessRate - bp.perQrAttemptSuccessRate) > 0.02) {
        return ap.perQrAttemptSuccessRate > bp.perQrAttemptSuccessRate ? -1 : 1;
      }
      if (Math.abs(ap.completionCoverage - bp.completionCoverage) > 0.1) return ap.completionCoverage > bp.completionCoverage ? -1 : 1;
      if (a.exposure !== b.exposure) return a.exposure - b.exposure;
      return a.iso - b.iso;
    };
    const refresh = (): void => {
      const evaluated = [...candidates.values()].filter((candidate) => candidate.windows.length).sort(compare);
      this.optimizeCandidates = evaluated.map((candidate) => {
        const p = performanceOf(candidate);
        return {
          candidateId: candidate.id, exposure: candidate.exposure, iso: candidate.iso, visits: candidate.windows.length,
          sourceFrames: p.sourceFrames, successfulSourceFrames: p.successfulSourceFrames,
          qrAttempts: p.qrAttempts, validDecodes: p.validDecodes,
          successRate: p.perQrAttemptSuccessRate, normalizedQrRate: rate(p), completionCoverage: p.completionCoverage,
          temporalContamination: p.temporalContamination ?? 0, state: candidate.state, coarseGrid: candidate.coarseGrid,
        };
      });
      if (!evaluated.length) return;
      const exposures = evaluated.map((candidate) => candidate.exposure);
      const isos = evaluated.map((candidate) => candidate.iso);
      const minE = Math.min(...exposures), maxE = Math.max(...exposures);
      const minIso = Math.min(...isos), maxIso = Math.max(...isos);
      const coarseCells = evaluated.filter((candidate) => candidate.coarseGrid).length;
      this.optimizeExposureVisited = { min: minE, max: maxE, coverage: coarseCells / 25 };
      this.optimizeIsoVisited = { min: minIso, max: maxIso, coverage: coarseCells / 25 };
      this.changed();
    };
    const activateExposureCandidate = async (requested: Candidate): Promise<{ candidate: Candidate; epoch: number } | undefined> => {
      if (!this.current(generation)) return undefined;
      this.candidateExposureTime = requested.requestedExposure;
      this.candidateIso = requested.requestedIso;
      this.requestedExposure = requested.requestedExposure;
      this.requestedIso = requested.requestedIso;
      const before = this.settings();
      epochs.transition({ candidateId: requested.id, requestedExposure: requested.requestedExposure, requestedIso: requested.requestedIso });
      if (!(await this.applyProbe(generation, {
        exposureMode: "manual", exposureTime: requested.requestedExposure, iso: requested.requestedIso,
      }, false))) return undefined;
      let actual = this.settings();
      for (let retry = 0; retry < 8 && this.current(generation) &&
          (actual.exposureTime === undefined || actual.iso === undefined); retry++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        actual = this.settings();
      }
      if (actual.exposureTime === undefined || actual.iso === undefined) return undefined;
      const requestedChange = before.exposureTime !== requested.requestedExposure || before.iso !== requested.requestedIso;
      if (requestedChange && actual.exposureTime === before.exposureTime && actual.iso === before.iso) return undefined;
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
        candidateId: candidate.id, requestedExposure: requested.requestedExposure, requestedIso: requested.requestedIso,
        actualExposure: actual.exposureTime, actualIso: actual.iso,
      });
      return epoch === undefined || !this.current(generation) ? undefined : { candidate, epoch };
    };
    const captureRound = async (
      requested: Candidate[], round: FocusDiagnostics["optimizeRound"], ignoreDeadline = false,
    ): Promise<Candidate[]> => {
      this.optimizeRound = round;
      const pending: Promise<void>[] = [];
      const captured: Candidate[] = [];
      const visited = new Set<string>();
      for (let index = 0; index < requested.length && (ignoreDeadline || performance.now() < deadline); index++) {
        const active = await activateExposureCandidate(requested[index]!);
        if (!active || visited.has(active.candidate.key)) {
          if (active) epochs.close(active.epoch);
          continue;
        }
        const { candidate, epoch } = active;
        visited.add(candidate.key);
        candidate.state = "measuring";
        this.optimizeVisit = String(candidate.windows.length + 1);
        this.optimizeSurvivors = `${index + 1}/${requested.length}`;
        const sample = await measure(`${round} · ${index + 1}/${requested.length}`, epoch);
        epochs.close(epoch);
        captured.push(candidate);
        pending.push(sample.result.then((result) => {
          candidate.windows.push(result);
          candidate.state = result.completionCoverage >= 0.8 ? "evaluated" : "incomplete";
          refresh();
        }));
      }
      await Promise.all(pending);
      return captured;
    };

    try {
      const level = (range: NumericRange, index: number) => this.quantize(
        2 ** (Math.log2(range.min) + Math.log2(range.max / range.min) * index / 4), range,
      );
      const exposures = Array.from({ length: 5 }, (_, index) => level(exposureRange, index));
      const isos = Array.from({ length: 5 }, (_, index) => level(isoRange, index));
      const coarse: Candidate[] = [];
      for (let isoIndex = 0; isoIndex < isos.length; isoIndex++) {
        const row = exposures.map((exposure) => make(exposure, isos[isoIndex]!));
        if (isoIndex & 1) row.reverse();
        coarse.push(...row);
      }
      for (const candidate of coarse) candidate.coarseGrid = true;
      if (!coarse.includes(incumbent)) coarse.push(incumbent);
      const uniqueCoarse = coarse.filter((candidate, index, all) => all.indexOf(candidate) === index);
      this.exposureProbes += uniqueCoarse.length;
      await captureRound(uniqueCoarse, "coarse", true);
      if (!this.current(generation) || !this.optimizeCandidates.length) return;
      const baselineRate = incumbent.windows.length ? rate(performanceOf(incumbent)) : 0;

      let survivors = [...candidates.values()].filter((candidate) => candidate.windows.length).sort(compare).slice(0, 6);
      for (const candidate of candidates.values()) if (candidate.windows.length && !survivors.includes(candidate)) candidate.state = "eliminated";
      this.optimizeSurvivors = `${survivors.length}/${this.optimizeCandidates.length}`;
      this.optimizeDecision = "top six revisit";
      await captureRound([...survivors].reverse(), "revisit", true);

      survivors = survivors.sort(compare).slice(0, 3);
      for (const candidate of candidates.values()) {
        if (candidate.windows.length && !survivors.includes(candidate) && candidate.state !== "eliminated") candidate.state = "eliminated";
      }
      this.optimizeDecision = "three finalists";
      await captureRound([survivors[1]!, survivors[2]!, survivors[0]!], "finalist", true);
      let winner = survivors.sort(compare)[0]!;
      winner.state = "coarse winner";

      if (performance.now() < deadline) {
        const nearest = (levels: number[], value: number) => levels.reduce((best, level, index) =>
          Math.abs(Math.log(level / value)) < Math.abs(Math.log(levels[best]! / value)) ? index : best, 0);
        const eIndex = nearest(exposures, winner.exposure);
        const iIndex = nearest(isos, winner.iso);
        const midpoints = (levels: number[], index: number, range: NumericRange) => [
          index > 0 ? Math.sqrt(levels[index - 1]! * levels[index]!) : levels[index]!,
          levels[index]!,
          index + 1 < levels.length ? Math.sqrt(levels[index]! * levels[index + 1]!) : levels[index]!,
        ].map((value) => this.quantize(value, range));
        const localExposures = midpoints(exposures, eIndex, exposureRange);
        const localIsos = midpoints(isos, iIndex, isoRange);
        const refinements = localIsos.flatMap((iso) => localExposures.map((exposure) => make(exposure, iso)))
          .filter((candidate, index, all) => candidate !== winner && !candidate.windows.length && all.indexOf(candidate) === index);
        for (const candidate of refinements) candidate.state = "refinement";
        this.exposureProbes += refinements.length;
        const measured = await captureRound(refinements, "refine", true);
        const local = [winner, ...measured].sort(compare).slice(0, 3);
        await captureRound([local[1]!, local[2]!, local[0]!].filter(Boolean), "refine", true);
        winner = local.sort(compare)[0]!;
      }
      winner.state = "winner";

      this.optimizeState = "verification";
      const final = await activateExposureCandidate(winner);
      if (!final) {
        this.optimizeState = "paused";
        this.optimizeReason = "winning settings could not be restored";
        return;
      }
      const verification = await measure("Winner", final.epoch);
      epochs.close(final.epoch);
      winner.windows.push(await verification.result);
      const repeatableVisits = winner.windows.filter((window) =>
        window.completionCoverage >= 0.8 && window.validDecodes > 0).length;
      if (repeatableVisits < 2 || performanceOf(winner).perQrAttemptSuccessRate <= 0) {
        winner.state = "rejected: not repeatable";
        refresh();
        await this.restoreOptimizationBest("exposure");
        this.optimizeState = "paused";
        this.optimizeReason = "no repeatable QR winner; original settings restored";
        return;
      }
      winner.state = "winner";
      this.commitSettings(this.settings());
      refresh();
      const finalObservation = this.latest?.at && this.latest.at >= startedAt ? this.latest : initialObservation;
      if (!finalObservation || !this.current(generation)) {
        this.optimizeState = "paused";
        this.optimizeReason = "no stable QR geometry available";
        return;
      }
      this.optimizeState = "complete";
      this.optimizeRound = undefined;
      this.optimizeVisit = undefined;
      this.optimizeDecision = "winner committed";
      const finalPerformance = performanceOf(winner);
      const finalRate = rate(finalPerformance);
      this.optimizeBestPerformance = finalPerformance;
      const gain = baselineRate ? (finalRate / baselineRate - 1) * 100 : 0;
      this.optimizeSummary = `${gain >= 0 ? "+" : ""}${gain.toFixed(0)}% · ${finalRate.toFixed(1)} estimated valid symbols/s`;
      this.optimizeReason = `${uniqueCoarse.filter((candidate) => candidate.coarseGrid).length} Cartesian cells · full hardware exposure × ISO range`;
      this.lock(finalObservation, "full-range exposure tournament converged; hardware focus retained");
    } finally {
      epochs.finish();
    }
  }
  startOptimizer(
    measure: (label: string, epoch: number) => Promise<PerformanceSample>,
    epochs: OptimizerEpochHooks,
  ): Promise<void> {
    return this.optimize(measure, epochs);
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
    this.acquisitionBracketRunning = false;
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
    this.repairAcquisitionInvariant();

    if (this.state === "OPTIMIZE_EXPOSURE" || this.state === "OPTIMIZE_VERIFY") {
      if (this.geometryChanged(geometry, this.stableGeometry)) {
        if (!this.optimizeMovementSince) this.optimizeMovementSince = now;
        if (now - this.optimizeMovementSince >= CAMERA_TUNING.optimizeMovementConfirmMs) {
          this.cancel("target moved during optimization");
          this.optimizeState = "cancelled";
          this.stableGeometry = geometry;
          this.stableSince = now;
          this.poiAimed = false;
          this.optimizeMovementSince = 0;
          this.transition("STABILIZING", "target moved during optimization; exposure best retained and hardware AF restored");
          void this.enterAutoFocusAcquisition("optimization cancelled by movement", this.generation, false, true, geometry);
          return;
        }
      } else this.optimizeMovementSince = 0;
    }
    if (this.state === "AUTO_AF_SETTLE" &&
        this.geometryChanged(geometry, this.stableGeometry)) {
      this.cancel("target moved during automatic calibration");
      this.stableGeometry = geometry;
      this.stableSince = now;
      this.poiAimed = false;
      this.transition("STABILIZING", "target moved; hardware AF restored and exposure retained");
      void this.enterAutoFocusAcquisition("target moved during calibration", this.generation, false, true);
      return;
    }

    if (!this.poiAimed && this.caps.pointsOfInterest && this.isAcquiring()) {
      this.poiAimed = true;
      void this.enterAutoFocusAcquisition("QR point-of-interest sent to hardware AF", this.generation, false, true, geometry);
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
        void this.beginFocusRecovery(observation);
      } else if (!optimizedHold && this.lockedExposureFailures >= CAMERA_TUNING.recoverySamples) {
        this.lockedExposureFailures = 0;
        void this.beginExposureRecovery(observation);
      } else {
        this.lastReason = decodeFresh ? "real decoder progress; camera held" :
          metrics.focusScore >= CAMERA_TUNING.focusExcellent && metrics.exposureScore >= CAMERA_TUNING.exposureExcellent
            ? "decoder silent with excellent static optics; camera held" : "decoder silence below recovery threshold";
      }
      this.changed();
      return;
    }

    if (!this.isAcquiring()) return;
    if (!this.stableGeometry || this.geometryChanged(geometry, this.stableGeometry)) {
      this.stableGeometry = geometry;
      this.stableSince = now;
      this.stabilizingAfRetries = 0;
      this.acquisitionBracketTried = false;
      this.transition("STABILIZING", "QR geometry found; hardware AF remains active");
      void this.enterAutoFocusAcquisition("geometry changed; hardware AF owns focus", this.generation, false, true, geometry);
    } else {
      this.stableGeometry = this.blendGeometry(this.stableGeometry, geometry);
      const stable = now - this.stableSince >= CAMERA_TUNING.geometryStabilityMs;
      const focusProven = this.validDecodesInGeneration > 0 && this.decodeIsFresh(now) && metrics.focusScore > 0;
      if (stable && focusProven) this.beginAutoAfSettle();
      else if (stable && !focusProven && !this.acquisitionBracketTried && !this.acquisitionBracketRunning &&
          now - this.stableSince >= CAMERA_TUNING.acquisitionBracketDelayMs && metrics.focusScore >= 0.38 &&
          (metrics.exposureScore < 0.55 || metrics.separation < 48 || metrics.clipping > 0.45 ||
            (now - this.stableSince >= 1800 && !(metrics.focusScore >= CAMERA_TUNING.focusExcellent &&
              metrics.exposureScore >= CAMERA_TUNING.exposureExcellent && metrics.temporalContamination > 0.35)))) {
        void this.beginAcquisitionBrightnessBracket(observation);
      } else if (!focusProven && metrics.focusScore < 0.38) {
        if (!this.poorFocusSince) this.poorFocusSince = now;
        if (now - this.poorFocusSince >= CAMERA_TUNING.poorFocusRetryMs) this.retryStabilizingAf(geometry);
      } else {
        this.poorFocusSince = 0;
        if (this.state === "STABILIZING" && now - this.stateSince >= CAMERA_TUNING.stabilizingRetryMs && metrics.focusScore < 0.55) {
          this.retryStabilizingAf(geometry);
        }
      }
    }
    this.changed();
  }

  noteTargetAbsent(now = performance.now()): void {
    if (this.strategy !== "auto" || this.state === "UNAVAILABLE" || this.state === "OVERRIDE") return;
    this.repairAcquisitionInvariant();
    if (!this.targetMissingSince) this.targetMissingSince = now;
    if (this.isOptimizing()) {
      this.lastReason = "QR absent; explicit exposure tournament continues";
      this.changed();
      return;
    } else if (this.state === "AUTO_AF_SETTLE") {
      this.cancel("static QR target disappeared during calibration");
      this.stableGeometry = undefined;
      this.stableSince = 0;
      this.poiAimed = false;
      this.transition("STABILIZING", "target disappeared; hardware AF restored and exposure retained");
      void this.enterAutoFocusAcquisition("target disappeared during calibration", this.generation, false, true);
    } else if (this.state === "LOCKED") {
      this.transition("TARGET_LOST_GRACE", "static target missing; continuous AF and exposure retained");
    } else if ((this.state === "STABILIZING" || this.state === "TARGET_LOST_GRACE") &&
        now - this.targetMissingSince >= CAMERA_TUNING.targetLostGraceMs) {
      this.stableGeometry = undefined;
      this.stableSince = 0;
      this.poiAimed = false;
      this.transition("SEEKING", "target absent; camera state retained while decoding continues");
    }
    this.changed();
  }

  diagnostics(): FocusDiagnostics {
    const settings = this.settings();
    const optical = this.latest?.metrics;
    const invariantWarning = this.acquisitionManualInvariant(settings)
      ? "BUG: manual focus active during automatic acquisition"
      : undefined;
    if (invariantWarning) this.repairAcquisitionInvariant();
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

  private beginAutoAfSettle(): void {
    if (this.state === "AUTO_AF_SETTLE") return;
    const generation = ++this.generation;
    void this.settleAndLockHardwareFocus(generation);
  }

  private async settleAndLockHardwareFocus(generation: number): Promise<void> {
    const initial = this.latest;
    if (!initial || !this.current(generation)) return;
    this.transition("AUTO_AF_SETTLE", "payload decoded; verifying continuous hardware AF");
    this.focusProbes = 0;
    this.exposureProbes = 0;
    const baseline = await this.waitForFocusSettled(generation, initial.id);
    if (!baseline || !this.current(generation) || !this.decodeIsFresh() || baseline.metrics.focusScore <= 0) {
      this.transition("STABILIZING", "hardware AF not yet proven useful; autofocus remains active");
      this.stateSince = performance.now();
      void this.enterAutoFocusAcquisition("AF settle lacked decode evidence", generation, false, true, initial.geometry);
      return;
    }
    const settings = this.settings();
    this.baselineFocus = settings.focusDistance;
    this.baselineExposure = settings.exposureTime;
    this.baselineIso = settings.iso;
    this.committedFocusMode = settings.focusMode;
    this.committedFocusDistance = settings.focusDistance;
    this.committedExposureTime = settings.exposureTime;
    this.committedIso = settings.iso;
    const focused = baseline;
    if (!this.current(generation)) return;
    const focusStillProven = this.decodeIsFresh() && focused.metrics.focusScore > 0;
    if (!focusStillProven) {
      this.transition("STABILIZING", "focus lost decode evidence; hardware AF restored");
      void this.enterAutoFocusAcquisition("focus not proven after settle", generation, false, true, focused.geometry);
      return;
    }
    if (this.current(generation)) this.lock(focused, "continuous hardware autofocus is decoding; acquisition complete");
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
    this.stabilizingAfRetries = 0;
    if (this.initialLockMs === undefined) this.initialLockMs = performance.now() - this.attachedAt;
    this.changed();
  }

  private async beginFocusRecovery(observation: OpticalObservation): Promise<void> {
    if (this.state !== "LOCKED") return;
    const generation = ++this.generation;
    this.beginDecodeGeneration();
    this.focusRefinementCount++;
    this.lastReason = "sustained blur; hardware AF taking focus ownership";
    this.stableGeometry = observation.geometry;
    this.stableSince = performance.now();
    this.poiAimed = false;
    await this.enterAutoFocusAcquisition("focus-only recovery; exposure untouched", generation, false, false, observation.geometry);
    if (this.current(generation)) this.transition("STABILIZING", "hardware AF active for focus-only recovery");
  }

  private async beginExposureRecovery(observation: OpticalObservation): Promise<void> {
    if (this.state !== "LOCKED" || !this.exposureModes().includes("continuous")) return;
    const generation = ++this.generation;
    this.exposureRefinementCount++;
    this.beginDecodeGeneration();
    this.transition("EXPOSURE_RECOVERY", "persistent static exposure loss; focus retained; hardware AE enabled");
    if (!(await this.applyProbe(generation, { exposureMode: "continuous" }))) {
      this.lock(observation, "exposure recovery rejected; prior camera state retained");
      return;
    }
    const recovered = await this.waitForExposureSettled(generation, observation.id);
    if (!recovered || !this.current(generation)) {
      await this.restoreCommittedExposure();
      return;
    }
    const actual = this.settings();
    this.baselineExposure = actual.exposureTime;
    this.baselineIso = actual.iso;
    if (this.current(generation)) this.lock(recovered, "hardware AE recovery complete; focus retained");
  }

  private async beginAcquisitionBrightnessBracket(observation: OpticalObservation): Promise<void> {
    if (!this.isAcquiring() || this.acquisitionBracketRunning || this.validDecodesInGeneration > 0 || !this.track) return;
    const generation = this.generation;
    this.acquisitionBracketRunning = true;
    this.acquisitionBracketTried = true;
    const settings = this.settings();
    const compensation = this.caps.exposureCompensation;
    const midpoint = (observation.metrics.blackLevel + observation.metrics.whiteLevel) / 2;
    const clearlyBright = observation.metrics.clipping > 0.55 || observation.metrics.whiteLevel > 245 || midpoint > 190;
    const clearlyDark = !clearlyBright && (observation.metrics.whiteLevel < 155 || midpoint < 95);
    let afterId = observation.id;

    if (compensation && this.exposureModes().some((mode) => mode === "continuous" || mode === "single-shot")) {
      const origin = settings.exposureCompensation ?? 0;
      const offsets = clearlyBright ? [-1, -2] : clearlyDark ? [1, 2] : [1, -1];
      for (const offset of offsets) {
        if (!this.acquisitionBracketRunning || !this.current(generation) || this.validDecodesInGeneration > 0) return;
        const candidate = this.quantize(origin + offset, compensation);
        if (candidate === origin) continue;
        if (!(await this.applyProbe(generation, { exposureMode: "continuous", exposureCompensation: candidate }, false))) break;
        const settled = await this.waitForExposureSettled(generation, afterId);
        if (!settled) break;
        afterId = settled.id;
        if (this.validDecodesInGeneration > 0) return;
      }
      if (this.current(generation) && this.validDecodesInGeneration === 0) {
        await this.applyProbe(generation, { exposureMode: "continuous", exposureCompensation: origin }, false);
      }
    } else if (this.manualExposure() && this.caps.exposureTime && settings.exposureTime !== undefined) {
      const originExposure = settings.exposureTime;
      const originIso = settings.iso;
      const factors = clearlyBright ? [0.5, 0.25] : clearlyDark ? [2, 4] : [2, 0.5];
      for (const factor of factors) {
        if (!this.acquisitionBracketRunning || !this.current(generation) || this.validDecodesInGeneration > 0) return;
        const patch: CameraPatch = {
          exposureMode: "manual",
          exposureTime: this.quantize(originExposure * factor, this.caps.exposureTime),
          ...(originIso !== undefined ? { iso: originIso } : {}),
        };
        if (!(await this.applyProbe(generation, patch, false))) break;
        const settled = await this.waitForExposureSettled(generation, afterId);
        if (!settled) break;
        afterId = settled.id;
        if (this.validDecodesInGeneration > 0) return;
      }
      if (this.current(generation) && this.validDecodesInGeneration === 0 && this.exposureModes().includes("continuous")) {
        await this.applyProbe(generation, { exposureMode: "continuous" }, false);
      }
    }
    this.acquisitionBracketRunning = false;
    this.lastReason = "assertive acquisition brightness bracket exhausted; hardware AF retained";
  }
  private retryStabilizingAf(geometry: FocusGeometry): void {
    if (this.stabilizingAfRetries < CAMERA_TUNING.maxStabilizingAfRetries) {
      this.stabilizingAfRetries++;
      this.stateSince = performance.now();
      this.stableSince = performance.now();
      this.poiAimed = false;
      this.poorFocusSince = 0;
      this.lastReason = `STABILIZING timeout; hardware AF retrigger ${this.stabilizingAfRetries}`;
      void this.enterAutoFocusAcquisition(this.lastReason, this.generation, false, true, geometry);
    } else {
      this.stableGeometry = undefined;
      this.stableSince = 0;
      this.transition("SEEKING", "AF retries exhausted; continuous hardware AF left running");
      void this.enterAutoFocusAcquisition("continuous hardware AF left running", this.generation, false, true);
    }
  }

  private async enterAutoFocusAcquisition(
    reason: string,
    generation = this.generation,
    resetExposure = false,
    restoreExposure = false,
    geometry?: FocusGeometry,
  ): Promise<void> {
    const track = this.track;
    if (!track || track.readyState !== "live" || !this.current(generation)) return;
    const mode = this.hardwareFocusMode();
    const patch: CameraPatch = {};
    if (mode) {
      this.requestedMode = mode;
      if (this.settings().focusMode !== mode || geometry) patch.focusMode = mode;
      if (geometry && this.caps.pointsOfInterest) patch.pointsOfInterest = [{ x: geometry.x, y: geometry.y }];
    }
    if (resetExposure && this.exposureModes().includes("continuous") && this.settings().exposureMode !== "continuous") {
      patch.exposureMode = "continuous";
    }
    else if (restoreExposure && this.settings().exposureMode === "manual" && this.manualExposure() && this.committedExposureTime !== undefined) {
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
    const actual = this.settings();
    if (mode && actual.focusMode === "manual") {
      accepted = await this.apply(track, { focusMode: mode }) && accepted;
    }
    this.lastReason = accepted ? reason : `${reason}; camera rejected AF/AE constraints`;
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
      if (this.committedExposureMode === "manual" && this.manualExposure() && this.committedExposureTime !== undefined) {
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

  private async restoreCommittedExposure(): Promise<void> {
    const track = this.track;
    if (!track) return;
    if (this.committedExposureMode === "continuous" && this.exposureModes().includes("continuous")) {
      await this.apply(track, { exposureMode: "continuous" });
    } else if (this.committedExposureMode === "manual" && this.manualExposure() && this.committedExposureTime !== undefined) {
      await this.apply(track, {
        exposureMode: "manual",
        exposureTime: this.committedExposureTime,
        ...(this.committedIso !== undefined ? { iso: this.committedIso } : {}),
      });
    }
  }

  private repairAcquisitionInvariant(): void {
    if (!this.acquisitionManualInvariant(this.settings()) || this.invariantRepairPending) return;
    this.invariantRepairPending = true;
    void this.enterAutoFocusAcquisition("BUG repaired: manual focus was active during automatic acquisition", this.generation, false, true)
      .finally(() => { this.invariantRepairPending = false; });
  }

  private acquisitionManualInvariant(settings: CameraSettings): boolean {
    return this.strategy === "auto" && (this.state === "SEEKING" || this.state === "STABILIZING" ||
      this.state === "AUTO_AF_SETTLE") && settings.focusMode === "manual";
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
    this.lastReason = reason;
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
    } else if (this.strategy === "camera-auto") {
      const mode = this.hardwareFocusMode();
      if (mode) {
        this.requestedMode = mode;
        await this.apply(track, { focusMode: mode });
      }
    } else if (this.focusModes().includes(this.strategy)) {
      this.requestedMode = this.strategy;
      await this.apply(track, { focusMode: this.strategy });
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

  private waitForFocusSettled(
    generation: number,
    afterId: number,
    settleMs = CAMERA_TUNING.focusSettleMs,
  ): Promise<OpticalObservation | undefined> {
    return this.waitForObservations(
      generation,
      afterId,
      settleMs,
      CAMERA_TUNING.focusDiscardFrames,
      CAMERA_TUNING.focusProbeSamples,
      1600,
    );
  }

  private waitForExposureSettled(generation: number, afterId: number): Promise<OpticalObservation | undefined> {
    return this.waitForObservations(
      generation,
      afterId,
      0,
      CAMERA_TUNING.exposureDiscardFrames,
      1,
      900,
    );
  }

  private waitForObservations(
    generation: number,
    afterId: number,
    settleMs: number,
    discard: number,
    requiredSamples: number,
    minimumTimeoutMs: number,
  ): Promise<OpticalObservation | undefined> {
    if (!this.current(generation)) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      this.waiter?.resolve(undefined);
      this.waiter = {
        generation,
        afterId,
        notBefore: performance.now() + settleMs,
        discard,
        samples: [],
        requiredSamples,
        resolve,
      };
      const frameInterval = this.latest?.captureFps ? 1000 / this.latest.captureFps : 50;
      const timeoutMs = Math.max(minimumTimeoutMs, settleMs + frameInterval * (discard + requiredSamples + 3) * 2);
      setTimeout(() => {
        if (this.waiter?.resolve === resolve) {
          this.waiter = undefined;
          resolve(undefined);
        }
      }, timeoutMs);
    });
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
    return [
      ...(modes.includes("continuous") || modes.includes("single-shot") ? ["camera-auto"] : []),
      ...(modes.includes("single-shot") ? ["single-shot"] : []),
      ...(modes.includes("manual") && this.caps.focusDistance ? ["manual"] : []),
    ];
  }
  private exposureModes(): string[] { return Array.isArray(this.caps.exposureMode) ? this.caps.exposureMode : []; }
  private hardwareFocusMode(): string | undefined {
    return this.focusModes().includes("continuous") ? "continuous" :
      this.focusModes().includes("single-shot") ? "single-shot" : undefined;
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
