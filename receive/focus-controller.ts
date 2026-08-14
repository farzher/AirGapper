import type { QrOpticalMetrics } from "./qr-optics";

export type FocusStrategy = "auto" | "continuous" | "single-shot" | "manual";
export type CalibrationMode = "auto" | "off" | "force";
export type FocusState =
  | "UNAVAILABLE" | "SEEKING" | "STABILIZING" | "AUTO_AF_SETTLE" | "AUTO_FREEZE_VERIFY"
  | "LOCKED" | "TARGET_LOST_GRACE" | "EXPOSURE_RECOVERY"
  | "OPTIMIZE_FOCUS" | "OPTIMIZE_EXPOSURE" | "OPTIMIZE_VERIFY" | "OVERRIDE";
export type FocusOwner = "HARDWARE" | "MANUAL" | "OPTIMIZE" | "DEVELOPER" | "NONE";

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
  physicalSettleMs: 150,
  probeSamples: 3,
  probeDiscardFrames: 1,
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
  prolongedSilenceMs: 9000,
  severeBlurConfirmMs: 480,
  fullRecoveryCooldownMs: 12000,
  automaticRecoveryCooldownMs: 4500,
  optimizeMovementConfirmMs: 650,
  optimizeTargetGraceMs: 1200,
  optimizeBudgetMs: 12000,
  optimizeWinRatio: 1.14,
  optimizeLossRatio: 0.88,
  optimizeMaxPairs: 3,
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
  completedJobs: number;
  qrAttempts: number;
  validDecodes: number;
  measurementMs: number;
  temporalContamination?: number;
}

export interface PerformanceSample {
  result: Promise<ReceivePerformance>;
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
  candidateFocusDistance?: number;
  candidateExposureTime?: number;
  candidateIso?: number;
  lockedMs?: number;
  initialLockMs?: number;
  fullRecoveryCount: number;
  fullResetCount: number;
  focusRefinementCount: number;
  exposureRefinementCount: number;
  manualFreezeAttempted: boolean;
  manualFreezeVerified: boolean;
  manualFreezeUnsafe: boolean;
  optimizeState: "idle" | "baseline" | "focus" | "exposure" | "verification" | "paused" | "cancelled" | "complete";
  optimizeCandidatePerformance?: ReceivePerformance;
  optimizeBestPerformance?: ReceivePerformance;
  optimizeSummary?: string;
  optimizeFocusStep?: number;
  optimizeExposureStepEV?: number;
  optimizeGainStepEV?: number;
  optimizeComparison?: "WIN" | "LOSS" | "UNCERTAIN";
  optimizePairedSamples?: number;
  optimizeReason?: string;
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
  private fullRecoveryCount = 0;
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
  private candidateFocusDistance?: number;
  private candidateExposureTime?: number;
  private candidateIso?: number;
  private lockedAt = 0;
  private fullResetCount = 0;
  private focusRefinementCount = 0;
  private exposureRefinementCount = 0;
  private lockedFocusFailures = 0;
  private lockedExposureFailures = 0;
  private stabilizingAfRetries = 0;
  private manualFreezeAttempted = false;
  private manualFreezeVerified = false;
  private manualFreezeUnsafe = false;
  private optimizeState: FocusDiagnostics["optimizeState"] = "idle";
  private optimizeCandidatePerformance?: ReceivePerformance;
  private optimizeBestPerformance?: ReceivePerformance;
  private optimizeSummary?: string;
  private optimizeFocusStep?: number;
  private optimizeExposureStepEV = 0.5;
  private optimizeGainStepEV = 0.5;
  private optimizeComparison?: "WIN" | "LOSS" | "UNCERTAIN";
  private optimizePairedSamples = 0;
  private optimizeReason = "idle";
  private readonly optimizeCandidates = new Map<string, { result: "accepted" | "rejected" | "uncertain"; at: number; performance?: ReceivePerformance; staticQuality?: QrOpticalMetrics }>();
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
  private fullRecoveryAt = -Infinity;
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
    return this.state === "AUTO_AF_SETTLE" || this.state === "AUTO_FREEZE_VERIFY" || this.state === "EXPOSURE_RECOVERY" ||
      this.state === "OPTIMIZE_FOCUS" || this.state === "OPTIMIZE_EXPOSURE" || this.state === "OPTIMIZE_VERIFY";
  }
  get opticalIntervalMs(): number {
    if (this.strategy !== "auto" || this.calibrationMode === "off" || this.state === "OVERRIDE") return Infinity;
    if (this.expectsProbeFrame) return 0;
    return this.state === "LOCKED" || this.state === "TARGET_LOST_GRACE"
      ? CAMERA_TUNING.lockedOpticalIntervalMs : CAMERA_TUNING.seekingOpticalIntervalMs;
  }

  attach(track: MediaStreamTrack): void {
    this.cancel("camera track changed");
    this.track = track;
    this.caps = (track.getCapabilities?.() ?? {}) as CameraCapabilities;
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
    this.optimizeCandidatePerformance = undefined;
    this.optimizeBestPerformance = undefined;
    this.optimizeSummary = undefined;
    this.optimizeFocusStep = undefined;
    this.optimizeExposureStepEV = 0.5;
    this.optimizeGainStepEV = 0.5;
    this.optimizeComparison = undefined;
    this.optimizePairedSamples = 0;
    this.optimizeReason = "camera changed";
    this.optimizeCandidates.clear();
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
    this.manualFreezeAttempted = false;
    this.manualFreezeVerified = false;
    this.manualFreezeUnsafe = false;
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
    this.cancel("focus ownership changed");
    this.strategy = strategy;
    if (optimizing) this.optimizeState = "cancelled";
    if (strategy === "auto") {
      this.transition("SEEKING", "automatic optics selected; hardware AF owns focus");
      const start = () => this.enterAutoFocusAcquisition("automatic focus selected", this.generation, true);
      if (optimizing) void this.restoreOptimizationBest().then(start);
      else void start();
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

  cancelOptimize(reason = "optimization cancelled"): void {
    if (!this.isOptimizing()) return;
    this.cancel(reason);
    this.optimizeState = "cancelled";
    void this.restoreOptimizationBest().then(() => this.transition("LOCKED", `${reason}; best settings restored`));
  }

  optimizeEligible(now = performance.now()): boolean {
    const stable = Boolean(this.stableSince && now - this.stableSince >= CAMERA_TUNING.geometryStabilityMs);
    const recentlyDecoded = Boolean(this.lastValidDecodeAt && now - this.lastValidDecodeAt <= this.silenceThreshold());
    const inactive = !this.isOptimizing() && !["SEEKING", "TARGET_LOST_GRACE", "EXPOSURE_RECOVERY"].includes(this.state);
    return this.strategy === "auto" && Boolean(this.track && this.latest && !this.targetMissingSince) &&
      stable && recentlyDecoded && inactive;
  }

  async optimize(measure: (label: string) => Promise<PerformanceSample>): Promise<void> {
    if (!this.optimizeEligible()) return;
    const generation = ++this.generation;
    const optimizeStartedAt = performance.now();
    let deadline = optimizeStartedAt + CAMERA_TUNING.optimizeBudgetMs;
    const explicitlyRestarted = this.optimizeState === "complete";
    this.beginDecodeGeneration();
    this.optimizeState = "baseline";
    this.optimizeSummary = undefined;
    this.optimizeComparison = undefined;
    this.optimizeReason = "measuring incumbent";
    const initialSettings = this.settings();
    const initialObservation = this.latest!;
    this.commitSettings(initialSettings);
    const focusRange = this.caps.focusDistance;
    if (explicitlyRestarted) {
      this.optimizeCandidates.clear();
      if (focusRange) this.optimizeFocusStep = Math.max(this.optimizeFocusStep ?? 0, (focusRange.max - focusRange.min) / 128);
      this.optimizeExposureStepEV = Math.max(this.optimizeExposureStepEV, 0.25);
      this.optimizeGainStepEV = Math.max(this.optimizeGainStepEV, 0.25);
    } else if (this.optimizeFocusStep === undefined) {
      this.optimizeFocusStep = focusRange ? Math.max((focusRange.step ?? 0) * 2, (focusRange.max - focusRange.min) / 16) : 0;
      this.optimizeExposureStepEV = 0.5;
      this.optimizeGainStepEV = 0.5;
    }

    const median = (values: number[]): number => {
      const sorted = [...values].sort((a, b) => a - b);
      const middle = sorted.length >> 1;
      return sorted.length & 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
    };
    const aggregate = (windows: ReceivePerformance[]): ReceivePerformance => ({
      validDecodesPerSecond: median(windows.map((window) => window.validDecodesPerSecond)),
      usefulSymbolsPerSecond: median(windows.map((window) => window.usefulSymbolsPerSecond)),
      perQrAttemptSuccessRate: median(windows.map((window) => window.perQrAttemptSuccessRate)),
      captureFps: median(windows.map((window) => window.captureFps)),
      completedJobs: windows.reduce((sum, window) => sum + window.completedJobs, 0),
      qrAttempts: windows.reduce((sum, window) => sum + window.qrAttempts, 0),
      validDecodes: windows.reduce((sum, window) => sum + window.validDecodes, 0),
      measurementMs: windows.reduce((sum, window) => sum + window.measurementMs, 0),
      temporalContamination: median(windows.map((window) => window.temporalContamination ?? 0)),
    });
    const safe = (observation: OpticalObservation): boolean => observation.metrics.confidence >= 0.62 &&
      observation.metrics.focusScore >= 0.2 && observation.metrics.separation >= 24 &&
      observation.metrics.exposureScore >= 0.18 && observation.metrics.clipping < 0.82 && observation.metrics.banding < 0.58;
    const patchFor = (settings: CameraSettings): CameraPatch => ({
      focusMode: settings.focusMode,
      focusDistance: settings.focusMode === "manual" ? settings.focusDistance : undefined,
      exposureMode: settings.exposureMode,
      exposureTime: settings.exposureMode === "manual" ? settings.exposureTime : undefined,
      iso: settings.exposureMode === "manual" ? settings.iso : undefined,
      exposureCompensation: settings.exposureMode !== "manual" ? settings.exposureCompensation : undefined,
    });
    const keyFor = (settings: CameraSettings): string => [settings.focusMode, settings.focusDistance,
      settings.exposureMode, settings.exposureTime, settings.iso, settings.exposureCompensation].join("|");
    const applySettled = async (patch: CameraPatch, afterId: number) => {
      if (!(await this.applyProbe(generation, patch, false))) return undefined;
      const observation = await this.fresh(generation, afterId);
      return observation && this.current(generation) ? { settings: this.settings(), observation } : undefined;
    };
    const classify = (candidate: ReceivePerformance, incumbent: ReceivePerformance): "WIN" | "LOSS" | "UNCERTAIN" => {
      if (candidate.qrAttempts >= 6 && candidate.validDecodes === 0 && incumbent.validDecodes >= 2) return "LOSS";
      if (incumbent.qrAttempts >= 6 && incumbent.validDecodes === 0 && candidate.validDecodes >= 2) return "WIN";
      if (candidate.qrAttempts < 3 || incumbent.qrAttempts < 3 || candidate.completedJobs < 2 || incumbent.completedJobs < 2) return "UNCERTAIN";
      const ratio = candidate.validDecodesPerSecond / Math.max(0.15, incumbent.validDecodesPerSecond);
      const contaminationMargin = Math.max(candidate.temporalContamination ?? 0, incumbent.temporalContamination ?? 0) > 0.42 ? 0.05 : 0;
      if (ratio >= CAMERA_TUNING.optimizeWinRatio + contaminationMargin) return "WIN";
      if (ratio <= CAMERA_TUNING.optimizeLossRatio - contaminationMargin) return "LOSS";
      if (Math.abs(ratio - 1) < 0.05 && candidate.validDecodes + incumbent.validDecodes >= 8) {
        if (candidate.usefulSymbolsPerSecond > incumbent.usefulSymbolsPerSecond * 1.08 + 0.2) return "WIN";
        if (candidate.usefulSymbolsPerSecond < incumbent.usefulSymbolsPerSecond * 0.92) return "LOSS";
        if (candidate.perQrAttemptSuccessRate > incumbent.perQrAttemptSuccessRate + 0.05) return "WIN";
        return "LOSS";
      }
      return "UNCERTAIN";
    };

    const baselineSample = await measure("Baseline");
    let incumbentPerformance = await baselineSample.result;
    if (!this.current(generation)) return;
    const baselineRate = incumbentPerformance.validDecodesPerSecond;
    if (baselineRate >= 8) deadline = Math.min(deadline, optimizeStartedAt + 8000);
    let incumbentSettings = this.settings();
    let incumbentObservation = this.latest ?? initialObservation;
    let incumbentWindows = [incumbentPerformance];
    this.optimizeBestPerformance = incumbentPerformance;

    type Collected = { settings: CameraSettings; patch: CameraPatch; key: string; observation: OpticalObservation; samples: PerformanceSample[]; windows: ReceivePerformance[] };
    const searchNeighborhood = async (patches: CameraPatch[], label: string): Promise<boolean> => {
      if (performance.now() >= deadline) return false;
      const incumbentKey = keyFor(incumbentSettings);
      const incumbentSamples: PerformanceSample[] = [];
      const candidates: Collected[] = [];
      incumbentSamples.push(await measure(`${label} · incumbent`));
      for (const patch of patches) {
        if (performance.now() >= deadline || !this.current(generation)) break;
        const applied = await applySettled(patch, this.latest?.id ?? incumbentObservation.id);
        if (!applied) continue;
        const key = keyFor(applied.settings);
        if (key === incumbentKey || candidates.some((candidate) => candidate.key === key)) continue;
        const cached = this.optimizeCandidates.get(key);
        if (cached && cached.result !== "uncertain") continue;
        if (!safe(applied.observation)) {
          this.optimizeCandidates.set(key, { result: "rejected", at: performance.now(), staticQuality: applied.observation.metrics });
          this.optimizeReason = "candidate rejected static";
          continue;
        }
        const sample = await measure(`${label} · challenger`);
        candidates.push({ settings: applied.settings, patch: patchFor(applied.settings), key, observation: applied.observation, samples: [sample], windows: [] });
      }
      const restored = await applySettled(patchFor(incumbentSettings), this.latest?.id ?? incumbentObservation.id);
      if (restored) incumbentObservation = restored.observation;
      incumbentSamples.push(await measure(`${label} · incumbent`));
      const [incumbentResults] = await Promise.all([
        Promise.all(incumbentSamples.map((sample) => sample.result)),
        Promise.all(candidates.map(async (candidate) => { candidate.windows.push(...await Promise.all(candidate.samples.map((sample) => sample.result))); })),
      ]);
      let raceIncumbent = aggregate(incumbentResults);

      // Initial bursts were collected A,B,C,...,A. Decoder completion may have
      // happened after the camera moved; scan ranges retain attribution.
      let promising = candidates.filter((candidate) => classify(aggregate(candidate.windows), raceIncumbent) !== "LOSS");
      for (let round = 1; round < CAMERA_TUNING.optimizeMaxPairs && promising.length && performance.now() < deadline; round++) {
        const extra: { candidate: Collected; sample: PerformanceSample }[] = [];
        // Rotate promising candidates so repeated windows naturally land at a
        // different sender/camera phase without sleeping for phase drift.
        promising = [...promising.slice(round % promising.length), ...promising.slice(0, round % promising.length)];
        for (const candidate of promising) {
          if (performance.now() >= deadline) break;
          const applied = await applySettled(candidate.patch, this.latest?.id ?? incumbentObservation.id);
          if (applied) extra.push({ candidate, sample: await measure(`${label} · finalist`) });
        }
        const backToIncumbent = await applySettled(patchFor(incumbentSettings), this.latest?.id ?? incumbentObservation.id);
        if (backToIncumbent) incumbentObservation = backToIncumbent.observation;
        const incumbentExtra = await measure(`${label} · incumbent`);
        await Promise.all(extra.map(async ({ candidate, sample }) => candidate.windows.push(await sample.result)));
        const incumbentWindow = await incumbentExtra.result;
        incumbentWindows.push(incumbentWindow);
        raceIncumbent = aggregate([...incumbentResults, incumbentWindow]);
        promising = promising.filter((candidate) => classify(aggregate(candidate.windows), raceIncumbent) === "UNCERTAIN" ||
          classify(aggregate(candidate.windows), raceIncumbent) === "WIN");
        if (promising.some((candidate) => classify(aggregate(candidate.windows), raceIncumbent) === "WIN")) break;
      }

      let winner: Collected | undefined;
      for (const candidate of candidates) {
        const candidatePerformance = aggregate(candidate.windows);
        let decision = classify(candidatePerformance, raceIncumbent);
        const effectivelyEqual = candidatePerformance.qrAttempts >= 3 && raceIncumbent.qrAttempts >= 3 &&
          Math.abs(candidatePerformance.validDecodesPerSecond - raceIncumbent.validDecodesPerSecond) <=
          Math.max(0.2, raceIncumbent.validDecodesPerSecond * 0.03) &&
          Math.abs(candidatePerformance.usefulSymbolsPerSecond - raceIncumbent.usefulSymbolsPerSecond) <=
            Math.max(0.2, raceIncumbent.usefulSymbolsPerSecond * 0.05) &&
          Math.abs(candidatePerformance.perQrAttemptSuccessRate - raceIncumbent.perQrAttemptSuccessRate) <= 0.03;
        if (effectivelyEqual && ((candidate.settings.exposureTime ?? Infinity) < (incumbentSettings.exposureTime ?? Infinity) ||
            (candidate.settings.exposureTime === incumbentSettings.exposureTime &&
              (candidate.settings.iso ?? Infinity) < (incumbentSettings.iso ?? Infinity)))) decision = "WIN";
        this.optimizeCandidatePerformance = candidatePerformance;
        this.optimizeComparison = decision;
        this.optimizePairedSamples = candidate.windows.length;
        if (decision === "WIN" && (!winner || candidatePerformance.validDecodesPerSecond > aggregate(winner.windows).validDecodesPerSecond)) winner = candidate;
        else this.optimizeCandidates.set(candidate.key, {
          result: decision === "UNCERTAIN" ? "uncertain" : "rejected", at: performance.now(),
          performance: candidatePerformance, staticQuality: candidate.observation.metrics,
        });
      }
      if (!winner) {
        incumbentWindows.push(...incumbentResults);
        incumbentPerformance = aggregate(incumbentWindows);
        this.optimizeBestPerformance = incumbentPerformance;
        this.optimizeReason = promising.length ? "equivalent; incumbent retained" : "challengers lost";
        return false;
      }
      const accepted = await applySettled(winner.patch, this.latest?.id ?? incumbentObservation.id);
      if (!accepted) return false;
      incumbentSettings = accepted.settings;
      incumbentObservation = accepted.observation;
      incumbentWindows = [...winner.windows];
      incumbentPerformance = aggregate(winner.windows);
      this.commitSettings(incumbentSettings);
      this.optimizeBestPerformance = incumbentPerformance;
      this.optimizeCandidates.set(winner.key, { result: "accepted", at: performance.now(), performance: incumbentPerformance, staticQuality: winner.observation.metrics });
      this.optimizeReason = "candidate accepted";
      return true;
    };

    const focusMinimum = focusRange ? Math.max(focusRange.step ?? 0, (focusRange.max - focusRange.min) / 256) : 0;
    const skipFocus = initialObservation.metrics.focusScore >= CAMERA_TUNING.focusExcellent && incumbentPerformance.perQrAttemptSuccessRate >= 0.65;
    if (this.manualFocus() && focusRange && incumbentSettings.focusDistance !== undefined && !skipFocus) {
      this.optimizeState = "focus";
      this.transition("OPTIMIZE_FOCUS", "adaptive focus pattern search");
      while ((this.optimizeFocusStep ?? 0) >= focusMinimum && performance.now() < deadline) {
        const origin = incumbentSettings.focusDistance;
        const patches = [-1, 1].map((direction) => ({ ...patchFor(incumbentSettings), focusMode: "manual",
          focusDistance: this.quantize(origin! + direction * this.optimizeFocusStep!, focusRange) }));
        this.focusProbes += patches.length;
        if (!(await searchNeighborhood(patches, "Focusing"))) {
          this.optimizeFocusStep! /= 2;
          this.optimizeReason = "focus step shrunk";
        }
      }
    } else {
      this.optimizeFocusStep = focusMinimum;
      this.optimizeReason = skipFocus ? "excellent hardware focus retained" : "focus unavailable";
    }

    const exposureRange = this.caps.exposureTime;
    const isoRange = this.caps.iso;
    if (this.manualExposure() && exposureRange && isoRange && incumbentSettings.exposureTime !== undefined && incumbentSettings.iso !== undefined) {
      this.optimizeState = "exposure";
      this.transition("OPTIMIZE_EXPOSURE", "joint exposure and gain pattern search");
      const minimumEV = 0.125;
      while ((this.optimizeExposureStepEV >= minimumEV || this.optimizeGainStepEV >= minimumEV) && performance.now() < deadline) {
        const exposure = incumbentSettings.exposureTime;
        const iso = incumbentSettings.iso;
        const e = 2 ** this.optimizeExposureStepEV;
        const g = 2 ** this.optimizeGainStepEV;
        const directions = [[exposure / e, iso], [exposure * e, iso], [exposure / e, iso * g], [exposure * e, iso / g]];
        if (this.optimizeExposureStepEV <= 0.25) directions.push([exposure, iso / g], [exposure, iso * g]);
        const seen = new Set<string>();
        const patches = directions.flatMap(([requestedExposure, requestedIso]) => {
          const actualExposure = this.quantize(requestedExposure, exposureRange);
          const actualIso = this.quantize(requestedIso, isoRange);
          const key = `${actualExposure}|${actualIso}`;
          if (seen.has(key) || (actualExposure === exposure && actualIso === iso)) return [];
          seen.add(key);
          return [{ ...patchFor(incumbentSettings), exposureMode: "manual", exposureTime: actualExposure, iso: actualIso }];
        });
        this.exposureProbes += patches.length;
        if (!(await searchNeighborhood(patches, "Tuning exposure"))) {
          this.optimizeExposureStepEV /= 2;
          this.optimizeGainStepEV /= 2;
          this.optimizeReason = "exposure/gain step shrunk";
        }
      }
    }

    if (!this.current(generation)) return;
    this.optimizeState = "verification";
    const final = await applySettled(patchFor(incumbentSettings), this.latest?.id ?? incumbentObservation.id);
    if (!final) {
      this.optimizeState = "paused";
      this.optimizeReason = "target evidence unavailable";
      return;
    }
    incumbentObservation = final.observation;
    this.commitSettings(final.settings);
    this.optimizeState = "complete";
    this.optimizeComparison = undefined;
    this.optimizeReason = performance.now() >= deadline ? "budget reached; best incumbent committed" : "converged";
    const gain = baselineRate > 0 ? (incumbentPerformance.validDecodesPerSecond / baselineRate - 1) * 100 : 0;
    this.optimizeSummary = `${gain >= 0 ? "+" : ""}${gain.toFixed(0)}% · ${incumbentPerformance.validDecodesPerSecond.toFixed(1)} QR/s`;
    this.lock(incumbentObservation, "optimizer converged; camera held");
  }

  startOptimizer(measure: (label: string) => Promise<PerformanceSample>): Promise<void> {
    return this.optimize(measure);
  }

  pauseOptimizer(reason = "optimizer paused"): void {
    if (!this.isOptimizing()) return;
    this.cancel(reason);
    this.optimizeState = "paused";
    this.optimizeReason = reason;
  }

  resetFocusOptimization(): void {
    this.optimizeFocusStep = undefined;
    this.optimizeCandidates.clear();
  }

  resetAllOptimization(): void {
    this.optimizeFocusStep = undefined;
    this.optimizeExposureStepEV = 0.5;
    this.optimizeGainStepEV = 0.5;
    this.optimizeCandidates.clear();
    this.optimizeState = "idle";
  }
  fullAutoRecovery(reason = "automatic full recovery"): void {
    this.cancel(reason);
    this.beginDecodeGeneration();
    if (this.strategy !== "auto") {
      void this.applyDeveloperFocus();
      return;
    }
    this.fullRecoveryCount++;
    this.optimizeState = "idle";
    this.optimizeCandidatePerformance = undefined;
    this.optimizeBestPerformance = undefined;
    this.optimizeSummary = undefined;
    this.optimizeCandidates.clear();
    this.optimizeFocusStep = undefined;
    this.acquisitionBracketRunning = false;
    this.acquisitionBracketTried = false;
    this.stableGeometry = undefined;
    this.stableSince = 0;
    this.targetMissingSince = 0;
    this.poiAimed = false;
    this.poorFocusSince = 0;
    this.lockedFocusFailures = 0;
    this.lockedExposureFailures = 0;
    this.stabilizingAfRetries = 0;
    this.lastWorkingState = undefined;
    this.committedFocusMode = undefined;
    this.committedFocusDistance = undefined;
    this.transition("SEEKING", `${reason}; hardware AF + AE active`);
    void this.enterAutoFocusAcquisition(reason, this.generation, true, false, this.latest?.geometry);
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

    if (this.state === "OPTIMIZE_FOCUS" || this.state === "OPTIMIZE_EXPOSURE" || this.state === "OPTIMIZE_VERIFY") {
      if (this.geometryChanged(geometry, this.stableGeometry)) {
        if (!this.optimizeMovementSince) this.optimizeMovementSince = now;
        if (now - this.optimizeMovementSince >= CAMERA_TUNING.optimizeMovementConfirmMs) {
          this.cancel("target moved during optimization");
          this.optimizeState = "cancelled";
          this.stableGeometry = geometry;
          this.stableSince = now;
          this.poiAimed = false;
          this.optimizeMovementSince = 0;
          this.optimizeFocusStep = undefined;
          this.transition("STABILIZING", "target moved during optimization; exposure best retained and hardware AF restored");
          void this.enterAutoFocusAcquisition("optimization cancelled by movement", this.generation, false, true, geometry);
          return;
        }
      } else this.optimizeMovementSince = 0;
    }
    if ((this.state === "AUTO_AF_SETTLE" || this.state === "AUTO_FREEZE_VERIFY") &&
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
      } else if (this.lockedExposureFailures >= CAMERA_TUNING.recoverySamples) {
        this.lockedExposureFailures = 0;
        void this.beginExposureRecovery(observation);
      } else if (decoderActive && noProgress && silence >= Math.max(1400, silenceThreshold * 1.3) &&
          (metrics.focusScore < CAMERA_TUNING.focusExcellent || metrics.exposureScore < CAMERA_TUNING.exposureExcellent) &&
          now - this.fullRecoveryAt >= CAMERA_TUNING.automaticRecoveryCooldownMs) {
        void this.beginAmbiguousRecovery(observation);
      } else if (decoderActive && silence >= Math.max(6000, Math.min(CAMERA_TUNING.prolongedSilenceMs, silenceThreshold * 5)) &&
          !(metrics.focusScore >= CAMERA_TUNING.focusExcellent && metrics.exposureScore >= CAMERA_TUNING.exposureExcellent && metrics.temporalContamination > 0.35) &&
          now - this.fullRecoveryAt >= CAMERA_TUNING.fullRecoveryCooldownMs) {
        this.fullRecoveryAt = now;
        this.fullAutoRecovery("prolonged decoder silence; controlled full recovery");
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
      if (now - this.targetMissingSince >= CAMERA_TUNING.optimizeTargetGraceMs) this.cancelOptimize("target disappeared during optimization");
    } else if (this.state === "AUTO_AF_SETTLE" || this.state === "AUTO_FREEZE_VERIFY") {
      this.cancel("static QR target disappeared during calibration");
      this.stableGeometry = undefined;
      this.stableSince = 0;
      this.poiAimed = false;
      this.transition("STABILIZING", "target disappeared; hardware AF restored and exposure retained");
      void this.enterAutoFocusAcquisition("target disappeared during calibration", this.generation, false, true);
    } else if (this.state === "LOCKED") {
      this.transition("TARGET_LOST_GRACE", "static target missing; waiting through grace");
    } else if (this.state === "STABILIZING" && now - this.targetMissingSince >= CAMERA_TUNING.targetLostGraceMs) {
      this.cancel("target absent while stabilizing");
      this.stableGeometry = undefined;
      this.stableSince = 0;
      this.poiAimed = false;
      this.transition("SEEKING", "target absent while stabilizing; hardware AF + AE active");
      void this.enterAutoFocusAcquisition("target absent while stabilizing", this.generation, true);
    } else if (this.state === "TARGET_LOST_GRACE" && now - this.targetMissingSince >= CAMERA_TUNING.targetLostGraceMs) {
      this.cancel("static target absent beyond grace");
      this.stableGeometry = undefined;
      this.stableSince = 0;
      this.poiAimed = false;
      this.transition("SEEKING", "static target absent beyond grace; hardware AF + AE recovery");
      void this.enterAutoFocusAcquisition("sustained target loss", this.generation, true);
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
      availableModes: this.focusModes(),
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
      candidateFocusDistance: this.candidateFocusDistance,
      candidateExposureTime: this.candidateExposureTime,
      candidateIso: this.candidateIso,
      lockedMs: this.state === "LOCKED" ? performance.now() - this.lockedAt : undefined,
      initialLockMs: this.initialLockMs,
      fullRecoveryCount: this.fullRecoveryCount,
      fullResetCount: this.fullResetCount,
      focusRefinementCount: this.focusRefinementCount,
      exposureRefinementCount: this.exposureRefinementCount,
      manualFreezeAttempted: this.manualFreezeAttempted,
      manualFreezeVerified: this.manualFreezeVerified,
      manualFreezeUnsafe: this.manualFreezeUnsafe,
      optimizeState: this.optimizeState,
      optimizeCandidatePerformance: this.optimizeCandidatePerformance,
      optimizeBestPerformance: this.optimizeBestPerformance,
      optimizeSummary: this.optimizeSummary,
      optimizeFocusStep: this.optimizeFocusStep,
      optimizeExposureStepEV: this.optimizeExposureStepEV,
      optimizeGainStepEV: this.optimizeGainStepEV,
      optimizeComparison: this.optimizeComparison,
      optimizePairedSamples: this.optimizePairedSamples,
      optimizeReason: this.optimizeReason,
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
    this.transition("AUTO_AF_SETTLE", "payload decoded; verifying hardware AF before optional freeze");
    this.focusProbes = 0;
    this.exposureProbes = 0;
    const baseline = await this.fresh(generation, initial.id, CAMERA_TUNING.physicalSettleMs);
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
    let focused = baseline;

    if (!this.manualFreezeUnsafe && this.manualFocus() && Number.isFinite(settings.focusDistance)) {
      this.manualFreezeAttempted = true;
      this.transition("AUTO_FREEZE_VERIFY", "transactionally verifying the hardware-selected focus distance");
      const requested = settings.focusDistance!;
      const accepted = await this.applyProbe(generation, { focusMode: "manual", focusDistance: requested });
      const frozen = accepted ? await this.fresh(generation, baseline.id, CAMERA_TUNING.physicalSettleMs) : undefined;
      const actual = this.settings();
      const staticHeld = Boolean(frozen && frozen.metrics.focusScore >= baseline.metrics.focusScore - 0.06);
      const decodeHeld = Boolean(frozen && this.validDecodesInGeneration > 0 && this.decodeIsFresh());
      const modeHeld = actual.focusMode === "manual";
      if (frozen && modeHeld && (decodeHeld || staticHeld)) {
        this.manualFreezeVerified = true;
        focused = frozen;
      } else {
        this.manualFreezeVerified = false;
        this.manualFreezeUnsafe = true;
        await this.enterAutoFocusAcquisition("manual focus freeze degraded or was not reproduced; hardware AF retained", generation, false, true, baseline.geometry);
        focused = baseline;
      }
    }

    if (!this.current(generation)) return;
    const focusStillProven = this.decodeIsFresh() && focused.metrics.focusScore > 0;
    if (!focusStillProven) {
      this.transition("STABILIZING", "focus lost decode evidence; hardware AF restored");
      void this.enterAutoFocusAcquisition("focus not proven after settle", generation, false, true, focused.geometry);
      return;
    }
    if (this.current(generation)) this.lock(focused, this.manualFreezeVerified
      ? "verified hardware-selected focus frozen; acquisition complete"
      : "hardware autofocus is decoding; acquisition complete");
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
    this.candidateFocusDistance = undefined;
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

  private async beginAmbiguousRecovery(observation: OpticalObservation): Promise<void> {
    if (this.state !== "LOCKED") return;
    const generation = ++this.generation;
    this.beginDecodeGeneration();
    this.fullRecoveryAt = performance.now();
    this.stableGeometry = observation.geometry;
    this.stableSince = performance.now();
    this.poiAimed = false;
    this.transition("STABILIZING", "decoder silent with uncertain optics; hardware AF + AE active");
    await this.enterAutoFocusAcquisition("automatic targeted AF + AE recovery", generation, true, false, observation.geometry);
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
    const recovered = await this.fresh(generation, observation.id, CAMERA_TUNING.physicalSettleMs);
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
    if (!this.isAcquiring() || this.acquisitionBracketRunning || this.validDecodesInGeneration > 0) return;
    const generation = this.generation;
    const track = this.track;
    if (!track) return;
    this.acquisitionBracketRunning = true;
    this.acquisitionBracketTried = true;
    const settings = this.settings();
    const compensation = this.caps.exposureCompensation;
    const darkerFirst = observation.metrics.clipping > 0.55 || observation.metrics.whiteLevel > 245;
    let afterId = observation.id;

    if (compensation && this.exposureModes().some((mode) => mode === "continuous" || mode === "single-shot")) {
      const origin = settings.exposureCompensation ?? 0;
      const step = Math.max(compensation.step ?? 0, Math.min(0.5, (compensation.max - compensation.min) / 4));
      const directions = darkerFirst ? [-1, 1] : [1, -1];
      for (const direction of directions) {
        if (!this.acquisitionBracketRunning || !this.current(generation) || this.validDecodesInGeneration > 0) return;
        const candidate = this.quantize(origin + direction * step, compensation);
        if (candidate === origin) continue;
        if (!(await this.applyProbe(generation, { exposureMode: "continuous", exposureCompensation: candidate }))) break;
        const settled = await this.fresh(generation, afterId);
        if (!settled) break;
        afterId = settled.id;
        if (this.validDecodesInGeneration > 0) return;
      }
      if (this.current(generation) && this.validDecodesInGeneration === 0) {
        await this.applyProbe(generation, { exposureMode: "continuous", exposureCompensation: origin });
      }
    } else if (this.manualExposure() && this.caps.exposureTime && settings.exposureTime !== undefined) {
      const originExposure = settings.exposureTime;
      const originIso = settings.iso;
      const directions = darkerFirst ? [1 / Math.SQRT2, Math.SQRT2] : [Math.SQRT2, 1 / Math.SQRT2];
      for (const factor of directions) {
        if (!this.acquisitionBracketRunning || !this.current(generation) || this.validDecodesInGeneration > 0) return;
        const patch: CameraPatch = {
          focusMode: this.hardwareFocusMode(),
          exposureMode: "manual",
          exposureTime: this.quantize(originExposure * factor, this.caps.exposureTime),
          ...(originIso !== undefined ? { iso: originIso } : {}),
        };
        if (!(await this.applyProbe(generation, patch))) break;
        const settled = await this.fresh(generation, afterId);
        if (!settled) break;
        afterId = settled.id;
        if (this.validDecodesInGeneration > 0) return;
      }
      if (this.current(generation) && this.validDecodesInGeneration === 0 && this.exposureModes().includes("continuous")) {
        await this.applyProbe(generation, { focusMode: this.hardwareFocusMode(), exposureMode: "continuous" });
      }
    }
    this.acquisitionBracketRunning = false;
    this.lastReason = "bounded acquisition brightness bracket exhausted; hardware 3A retained";
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
      patch.focusMode = mode;
      this.requestedMode = mode;
      if (geometry && this.caps.pointsOfInterest) patch.pointsOfInterest = [{ x: geometry.x, y: geometry.y }];
    }
    if ((resetExposure || this.isAcquiring()) && this.exposureModes().includes("continuous")) patch.exposureMode = "continuous";
    else if (restoreExposure && this.settings().exposureMode === "manual" && this.manualExposure() && this.committedExposureTime !== undefined) {
      patch.exposureMode = "manual";
      patch.exposureTime = this.committedExposureTime;
      if (this.committedIso !== undefined) patch.iso = this.committedIso;
    }
    let accepted = true;
    if (Object.keys(patch).length) {
      if (resetExposure) this.fullResetCount++;
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
    this.candidateFocusDistance = undefined;
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
    if (this.state === "OPTIMIZE_FOCUS" || this.state === "OPTIMIZE_EXPOSURE" || this.state === "OPTIMIZE_VERIFY") return "OPTIMIZE";
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

  private fresh(generation: number, afterId: number, settleMs = CAMERA_TUNING.physicalSettleMs): Promise<OpticalObservation | undefined> {
    if (!this.current(generation)) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      this.waiter?.resolve(undefined);
      this.waiter = {
        generation,
        afterId,
        notBefore: performance.now() + settleMs,
        discard: CAMERA_TUNING.probeDiscardFrames,
        samples: [],
        resolve,
      };
      const frameInterval = this.latest?.captureFps ? 1000 / this.latest.captureFps : 0;
      const evidenceInterval = Math.max(80, frameInterval, this.medianInterval(this.completionTimes) ?? 0);
      const timeoutMs = Math.max(1600, Math.min(5000,
        settleMs + evidenceInterval * (CAMERA_TUNING.probeDiscardFrames + CAMERA_TUNING.probeSamples + 2)));
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
    if (waiter.samples.length < CAMERA_TUNING.probeSamples) return;
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

  private settings(): CameraSettings { return (this.track?.getSettings() ?? {}) as CameraSettings; }
  private focusModes(): string[] { return Array.isArray(this.caps.focusMode) ? this.caps.focusMode : []; }
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
    return this.optimizeState === "baseline" || this.optimizeState === "focus" || this.optimizeState === "exposure" ||
      this.optimizeState === "verification";
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
