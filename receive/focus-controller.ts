import type { QrOpticalMetrics } from "./qr-optics";

export type FocusStrategy = "auto" | "continuous" | "single-shot" | "manual";
export type CalibrationMode = "auto" | "off" | "force";
export type FocusState =
  | "UNAVAILABLE" | "SEEKING" | "STABILIZING" | "AUTO_AF_SETTLE" | "AUTO_FREEZE_VERIFY"
  | "EXPOSURE_REFINE" | "LOCKED" | "TARGET_LOST_GRACE" | "EXPOSURE_RECOVERY"
  | "OPTIMIZE_FOCUS" | "OPTIMIZE_EXPOSURE" | "OVERRIDE";
export type FocusOwner = "HARDWARE" | "MANUAL" | "OPTIMIZE" | "DEVELOPER" | "NONE";

type NumericRange = { min: number; max: number; step?: number };
type CameraCapabilities = MediaTrackCapabilities & {
  focusMode?: string[];
  focusDistance?: NumericRange;
  pointsOfInterest?: unknown;
  exposureMode?: string[];
  exposureTime?: NumericRange;
  iso?: NumericRange;
};
type CameraSettings = MediaTrackSettings & {
  focusMode?: string;
  focusDistance?: number;
  exposureMode?: string;
  exposureTime?: number;
  iso?: number;
};
export type CameraPatch = {
  focusMode?: string;
  focusDistance?: number;
  pointsOfInterest?: { x: number; y: number }[];
  exposureMode?: string;
  exposureTime?: number;
  iso?: number;
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
  exposureSafetyMargin: 0.06,
  maxExposureProbes: 2,
  maxExposureCalibrationMs: 1500,
  seekingOpticalIntervalMs: 110,
  lockedOpticalIntervalMs: 320,
  targetLostGraceMs: 1600,
  stabilizingRetryMs: 2500,
  maxStabilizingAfRetries: 2,
  recoverySamples: 3,
  recentTileWindowMs: 1800,
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
  decodedNow: number;
  decodedRecently: number;
  totalTiles: number;
  captureFps: number;
}

interface CameraSnapshot {
  focusMode?: string;
  focusDistance?: number;
  exposureTime?: number;
  iso?: number;
  optical: QrOpticalMetrics;
  geometry: FocusGeometry;
}

export interface ReceivePerformance {
  usefulSymbolsPerSecond: number;
  decodeSuccessRate: number;
  captureFps: number;
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
  actualExposure?: number;
  actualIso?: number;
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
  decodedNow: number;
  decodedRecently: number;
  totalTiles: number;
  likelyTemporalFailure: boolean;
  knownGood: boolean;
  knownGoodSettings?: { focusMode?: string; focusDistance?: number; exposureTime?: number; iso?: number };
  committedFocusMode?: string;
  committedFocusDistance?: number;
  committedExposureTime?: number;
  committedIso?: number;
  candidateFocusDistance?: number;
  candidateExposureTime?: number;
  candidateIso?: number;
  lockedMs?: number;
  initialLockMs?: number;
  reacquireCount: number;
  fullResetCount: number;
  focusRefinementCount: number;
  exposureRefinementCount: number;
  manualFreezeAttempted: boolean;
  manualFreezeVerified: boolean;
  manualFreezeUnsafe: boolean;
  optimizeState: "idle" | "baseline" | "focus" | "exposure" | "cancelled" | "complete";
  optimizeCandidatePerformance?: ReceivePerformance;
  optimizeBestPerformance?: ReceivePerformance;
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
  private reacquireCount = 0;
  private lastReason = "camera opened";
  private baselineFocus?: number;
  private baselineExposure?: number;
  private baselineIso?: number;
  private requestedExposure?: number;
  private requestedIso?: number;
  private focusProbes = 0;
  private exposureProbes = 0;
  private knownGood?: CameraSnapshot;
  private committedFocusMode?: string;
  private committedFocusDistance?: number;
  private committedExposureTime?: number;
  private committedIso?: number;
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
  ) {
    this.strategy = strategy;
    this.manualDistance = manualDistance;
    this.calibrationMode = calibrationMode;
  }

  get capabilities(): CameraCapabilities { return this.caps; }
  get selectedStrategy(): FocusStrategy { return this.strategy; }
  get expectsProbeFrame(): boolean {
    return this.state === "AUTO_AF_SETTLE" || this.state === "AUTO_FREEZE_VERIFY" || this.state === "EXPOSURE_REFINE" ||
      this.state === "EXPOSURE_RECOVERY" || this.state === "OPTIMIZE_FOCUS" || this.state === "OPTIMIZE_EXPOSURE";
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
    this.stabilizingAfRetries = 0;
    this.initialLockMs = undefined;
    this.optimizeState = "idle";
    this.optimizeCandidatePerformance = undefined;
    this.optimizeBestPerformance = undefined;
    this.knownGood = undefined;
    this.committedFocusMode = undefined;
    this.committedFocusDistance = undefined;
    this.committedExposureTime = undefined;
    this.committedIso = undefined;
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

  async optimize(measure: (durationMs: number) => Promise<ReceivePerformance>): Promise<void> {
    if (this.strategy !== "auto" || this.state !== "LOCKED" || !this.latest || !this.track ||
        !this.diagnostics().geometryStable) return;
    const generation = ++this.generation;
    const baselineObservation = this.latest;
    const settings = this.settings();
    this.commitSettings(settings);
    const windowMs = baselineObservation.totalTiles > 1 ? 500 : 850;
    this.optimizeState = "baseline";
    this.transition("OPTIMIZE_FOCUS", "measuring receive-throughput baseline");
    let bestPerformance = await measure(windowMs);
    this.optimizeBestPerformance = bestPerformance;
    this.optimizeCandidatePerformance = bestPerformance;
    if (!this.current(generation)) return;
    let bestObservation = this.latest ?? baselineObservation;
    const better = (candidate: ReceivePerformance, best: ReceivePerformance) =>
      candidate.captureFps >= best.captureFps * 0.88 &&
      (candidate.usefulSymbolsPerSecond > best.usefulSymbolsPerSecond * 1.03 ||
        (candidate.usefulSymbolsPerSecond >= best.usefulSymbolsPerSecond * 0.98 &&
          candidate.decodeSuccessRate > best.decodeSuccessRate + 0.04));
    const safe = (observation: OpticalObservation) =>
      this.exposureAcceptable(observation.metrics, 0.45) && observation.metrics.focusScore >= 0.35;

    const focusRange = this.caps.focusDistance;
    if (this.manualFocus() && focusRange && settings.focusDistance !== undefined) {
      this.optimizeState = "focus";
      const delta = Math.max((focusRange.step ?? 0) * 2, (focusRange.max - focusRange.min) / 40);
      for (const requested of [settings.focusDistance - delta, settings.focusDistance + delta]) {
        if (!this.current(generation)) return;
        const candidate = this.quantize(requested, focusRange);
        if (this.committedFocusMode === "manual" && candidate === this.committedFocusDistance) continue;
        this.focusProbes++;
        this.candidateFocusDistance = candidate;
        if (!(await this.applyProbe(generation, { focusMode: "manual", focusDistance: candidate }))) break;
        const optical = await this.fresh(generation, this.latest?.id ?? baselineObservation.id);
        if (!optical) { this.cancelOptimize("static target unavailable"); return; }
        if (safe(optical)) {
          const performance = await measure(windowMs);
          this.optimizeCandidatePerformance = performance;
          if (!this.current(generation)) return;
          if (better(performance, bestPerformance)) {
            bestPerformance = performance;
            this.optimizeBestPerformance = performance;
            bestObservation = optical;
            this.committedFocusMode = "manual";
            this.committedFocusDistance = this.settings().focusDistance ?? candidate;
          }
        }
        await this.restoreOptimizationBest("focus");
      }
    }
    if (!this.current(generation)) return;
    await this.restoreOptimizationBest("focus");

    const exposureRange = this.caps.exposureTime;
    if (this.manualExposure() && exposureRange && this.committedExposureTime !== undefined) {
      this.optimizeState = "exposure";
      this.transition("OPTIMIZE_EXPOSURE", "focus fixed; searching shorter exposure by receive throughput");
      for (const factor of [Math.SQRT2, 2]) {
        const candidate = this.quantize(this.committedExposureTime / factor, exposureRange);
        if (candidate >= this.committedExposureTime) continue;
        this.candidateExposureTime = candidate;
        let iso = this.committedIso;
        if (!(await this.applyProbe(generation, {
          exposureMode: "manual", exposureTime: candidate, ...(iso !== undefined ? { iso } : {}),
        }))) break;
        let optical = await this.fresh(generation, this.latest?.id ?? bestObservation.id);
        if (!optical) { this.cancelOptimize("static target unavailable"); return; }
        if (!safe(optical) && this.caps.iso && iso !== undefined) {
          iso = this.quantize(Math.min(this.caps.iso.max, iso * 1.5), this.caps.iso);
          await this.applyProbe(generation, { exposureMode: "manual", exposureTime: candidate, iso });
          optical = await this.fresh(generation, this.latest?.id ?? bestObservation.id);
          if (!optical) { this.cancelOptimize("static target unavailable"); return; }
        }
        if (safe(optical)) {
          const performance = await measure(windowMs);
          this.optimizeCandidatePerformance = performance;
          if (!this.current(generation)) return;
          if (better(performance, bestPerformance)) {
            bestPerformance = performance;
            this.optimizeBestPerformance = performance;
            bestObservation = optical;
            this.committedExposureTime = this.settings().exposureTime ?? candidate;
            this.committedIso = this.settings().iso ?? iso;
          }
        }
        await this.restoreOptimizationBest("exposure");
      }
    }
    if (!this.current(generation)) return;
    await this.restoreOptimizationBest();
    this.optimizeState = "complete";
    this.lock(bestObservation, "one-shot throughput optimization complete; best settings committed");
  }

  refocus(reason = "developer forced calibration"): void {
    this.cancel(reason);
    if (this.strategy !== "auto") {
      void this.applyDeveloperFocus();
      return;
    }
    this.reacquireCount++;
    this.optimizeState = "idle";
    this.stableGeometry = undefined;
    this.stableSince = 0;
    this.poiAimed = false;
    this.stabilizingAfRetries = 0;
    this.transition("SEEKING", `${reason}; hardware AF + AE reacquisition`);
    void this.enterAutoFocusAcquisition(reason, this.generation, true);
  }

  observe(
    id: number,
    geometry: FocusGeometry,
    metrics: QrOpticalMetrics,
    decodedNow = 0,
    decodedRecently = 0,
    totalTiles = 1,
    now = performance.now(),
    captureFps = 0,
  ): void {
    const observation = { id, at: now, geometry, metrics, decodedNow, decodedRecently, totalTiles, captureFps };
    this.latest = observation;
    this.targetMissingSince = 0;
    this.resolveWaiter(observation);

    if (this.strategy !== "auto" || this.calibrationMode === "off" || this.state === "OVERRIDE") {
      this.changed();
      return;
    }
    this.repairAcquisitionInvariant();

    if ((this.state === "OPTIMIZE_FOCUS" || this.state === "OPTIMIZE_EXPOSURE") &&
        this.geometryChanged(geometry, this.stableGeometry)) {
      this.cancel("target moved during optimization");
      this.optimizeState = "cancelled";
      this.stableGeometry = geometry;
      this.stableSince = now;
      this.poiAimed = false;
      this.transition("STABILIZING", "target moved during optimization; exposure best retained and hardware AF restored");
      void this.enterAutoFocusAcquisition("optimization cancelled by movement", this.generation, false, true, geometry);
      return;
    }
    if ((this.state === "AUTO_AF_SETTLE" || this.state === "AUTO_FREEZE_VERIFY" || this.state === "EXPOSURE_REFINE") &&
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
      if (decodedNow > 0 && metrics.focusScore > 0) {
        const settings = this.settings();
        this.knownGood = {
          focusMode: settings.focusMode,
          focusDistance: settings.focusDistance,
          exposureTime: settings.exposureTime,
          iso: settings.iso,
          optical: metrics,
          geometry,
        };
      }
      const reference = this.knownGood;
      const moved = this.geometryChanged(geometry, reference?.geometry);
      const focusBad = Boolean(reference && moved && metrics.confidence >= 0.82 &&
        metrics.focusScore < Math.max(0.35, reference.optical.focusScore - 0.14));
      const exposureBad = Boolean(reference && !focusBad && metrics.focusScore >= 0.55 &&
        !this.exposureAcceptable(metrics, Math.max(0.42, reference.optical.exposureScore - 0.2)));
      this.lockedFocusFailures = focusBad ? this.lockedFocusFailures + 1 : 0;
      this.lockedExposureFailures = exposureBad ? this.lockedExposureFailures + 1 : 0;
      if (this.lockedFocusFailures >= CAMERA_TUNING.recoverySamples) {
        this.lockedFocusFailures = 0;
        void this.beginFocusRecovery(observation);
      } else if (this.lockedExposureFailures >= CAMERA_TUNING.recoverySamples) {
        this.lockedExposureFailures = 0;
        void this.beginExposureRecovery(observation);
      } else {
        this.lastReason = decodedNow > 0 ? "hardware-selected focus is decoding; lens left alone" : "static optics healthy; payload failure ignored";
      }
      this.changed();
      return;
    }

    if (!this.isAcquiring()) return;
    if (!this.stableGeometry || this.geometryChanged(geometry, this.stableGeometry)) {
      this.stableGeometry = geometry;
      this.stableSince = now;
      this.stabilizingAfRetries = 0;
      this.transition("STABILIZING", "QR geometry found; hardware AF remains active");
      void this.enterAutoFocusAcquisition("geometry changed; hardware AF owns focus", this.generation, false, true, geometry);
    } else {
      this.stableGeometry = this.blendGeometry(this.stableGeometry, geometry);
      const stable = now - this.stableSince >= CAMERA_TUNING.geometryStabilityMs;
      const focusProven = decodedNow > 0 && metrics.focusScore > 0;
      if (stable && focusProven) this.beginAutoAfSettle();
      else if (this.state === "STABILIZING" && now - this.stateSince >= CAMERA_TUNING.stabilizingRetryMs) {
        this.retryStabilizingAf(geometry);
      }
    }
    this.changed();
  }

  noteTargetAbsent(now = performance.now()): void {
    if (this.strategy !== "auto" || this.state === "UNAVAILABLE" || this.state === "OVERRIDE") return;
    this.repairAcquisitionInvariant();
    if (!this.targetMissingSince) this.targetMissingSince = now;
    if (this.isOptimizing()) {
      this.cancelOptimize("target disappeared during optimization");
    } else if (this.state === "AUTO_AF_SETTLE" || this.state === "AUTO_FREEZE_VERIFY" || this.state === "EXPOSURE_REFINE") {
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
      this.transition("SEEKING", "static target absent beyond grace; hardware AF + AE reacquired");
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
      actualExposure: settings.exposureTime,
      actualIso: settings.iso,
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
      decodedNow: this.latest?.decodedNow ?? 0,
      decodedRecently: this.latest?.decodedRecently ?? 0,
      totalTiles: this.latest?.totalTiles ?? 0,
      likelyTemporalFailure: Boolean(this.latest && this.latest.decodedNow === 0 && optical &&
        optical.focusScore >= CAMERA_TUNING.focusExcellent && optical.exposureScore >= CAMERA_TUNING.exposureExcellent),
      knownGood: Boolean(this.knownGood),
      knownGoodSettings: this.knownGood && {
        focusMode: this.knownGood.focusMode,
        focusDistance: this.knownGood.focusDistance,
        exposureTime: this.knownGood.exposureTime,
        iso: this.knownGood.iso,
      },
      committedFocusMode: this.committedFocusMode,
      committedFocusDistance: this.committedFocusDistance,
      committedExposureTime: this.committedExposureTime,
      committedIso: this.committedIso,
      candidateFocusDistance: this.candidateFocusDistance,
      candidateExposureTime: this.candidateExposureTime,
      candidateIso: this.candidateIso,
      lockedMs: this.state === "LOCKED" ? performance.now() - this.lockedAt : undefined,
      initialLockMs: this.initialLockMs,
      reacquireCount: this.reacquireCount,
      fullResetCount: this.fullResetCount,
      focusRefinementCount: this.focusRefinementCount,
      exposureRefinementCount: this.exposureRefinementCount,
      manualFreezeAttempted: this.manualFreezeAttempted,
      manualFreezeVerified: this.manualFreezeVerified,
      manualFreezeUnsafe: this.manualFreezeUnsafe,
      optimizeState: this.optimizeState,
      optimizeCandidatePerformance: this.optimizeCandidatePerformance,
      optimizeBestPerformance: this.optimizeBestPerformance,
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
    if (!baseline || !this.current(generation) || baseline.decodedRecently === 0 || baseline.metrics.focusScore <= 0) {
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
      const decodeHeld = Boolean(frozen && frozen.decodedNow > 0);
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
    const focusStillProven = focused.decodedRecently > 0 && focused.metrics.focusScore > 0;
    if (!focusStillProven) {
      this.transition("STABILIZING", "focus lost decode evidence; hardware AF restored");
      void this.enterAutoFocusAcquisition("focus not proven after settle", generation, false, true, focused.geometry);
      return;
    }
    if (this.manualExposure() && Number.isFinite(this.settings().exposureTime)) {
      focused = await this.refineExposure(generation, focused);
    }
    if (this.current(generation)) this.lock(focused, this.manualFreezeVerified
      ? "verified hardware-selected focus frozen; acquisition complete"
      : "hardware autofocus is decoding; acquisition complete");
  }

  private async refineExposure(generation: number, baseline: OpticalObservation): Promise<OpticalObservation> {
    if (baseline.decodedRecently === 0 || baseline.metrics.focusScore <= 0) return baseline;
    const range = this.caps.exposureTime!;
    const isoRange = this.caps.iso;
    const started = performance.now();
    this.exposureRefinementCount++;
    this.transition("EXPOSURE_REFINE", "proven focus held; conservative exposure probes active");
    let currentExposure = this.quantize(this.settings().exposureTime ?? this.baselineExposure!, range);
    let currentIso = isoRange ? this.quantize(this.settings().iso ?? this.baselineIso ?? isoRange.min, isoRange) : undefined;
    let best = baseline;
    let bestExposure = currentExposure;
    let bestIso = currentIso;
    const qualityFloor = Math.max(0.48, Math.min(0.72, baseline.metrics.exposureScore - CAMERA_TUNING.exposureSafetyMargin));

    while (this.current(generation) && this.exposureProbes < CAMERA_TUNING.maxExposureProbes &&
        performance.now() - started < CAMERA_TUNING.maxExposureCalibrationMs) {
      const exposureStep = Math.max(range.step ?? 0, 1e-6);
      const nextExposure = this.quantize(Math.max(range.min, currentExposure / Math.SQRT2), range);
      if (nextExposure >= currentExposure - exposureStep / 2) break;
      let trialIso = currentIso;
      let observed: OpticalObservation | undefined;
      let acceptable = false;
      do {
        this.exposureProbes++;
        this.requestedExposure = nextExposure;
        this.requestedIso = trialIso;
        this.candidateExposureTime = nextExposure;
        this.candidateIso = trialIso;
        if (!(await this.applyProbe(generation, {
          exposureMode: "manual", exposureTime: nextExposure,
          ...(trialIso !== undefined ? { iso: trialIso } : {}),
        }))) break;
        observed = await this.fresh(generation, this.latest?.id ?? baseline.id);
        acceptable = Boolean(observed && this.exposureAcceptable(observed.metrics, qualityFloor) &&
          (!baseline.captureFps || !observed.captureFps || observed.captureFps >= baseline.captureFps * 0.88));
        if (acceptable || !isoRange || trialIso === undefined || trialIso >= isoRange.max ||
            this.exposureProbes >= CAMERA_TUNING.maxExposureProbes) break;
        trialIso = this.quantize(Math.min(isoRange.max, trialIso * 1.5), isoRange);
      } while (this.current(generation) && performance.now() - started < CAMERA_TUNING.maxExposureCalibrationMs);
      if (!observed || !acceptable) break;
      currentExposure = nextExposure;
      currentIso = trialIso;
      best = observed;
      bestExposure = nextExposure;
      bestIso = trialIso;
    }
    this.requestedExposure = bestExposure;
    this.requestedIso = bestIso;
    if (!(await this.applyProbe(generation, {
      exposureMode: "manual", exposureTime: bestExposure,
      ...(bestIso !== undefined ? { iso: bestIso } : {}),
    }))) {
      await this.restoreCommittedExposure();
      return baseline;
    }
    this.committedExposureTime = this.settings().exposureTime ?? bestExposure;
    this.committedIso = this.settings().iso ?? bestIso;
    this.candidateExposureTime = undefined;
    this.candidateIso = undefined;
    return await this.fresh(generation, this.latest?.id ?? baseline.id) ?? best;
  }

  private exposureAcceptable(metrics: QrOpticalMetrics, floor: number): boolean {
    return metrics.confidence >= 0.86 && metrics.exposureScore >= floor &&
      metrics.separation >= 48 && metrics.noise <= Math.max(20, metrics.separation * 0.25) &&
      metrics.clipping < 0.55 && metrics.banding < 0.32;
  }

  private lock(observation: OpticalObservation, reason: string): void {
    this.commitSettings(this.settings());
    this.knownGood = {
      focusMode: this.committedFocusMode,
      focusDistance: this.committedFocusDistance,
      exposureTime: this.committedExposureTime,
      iso: this.committedIso,
      optical: observation.metrics,
      geometry: observation.geometry,
    };
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

  private async beginFocusRecovery(observation: OpticalObservation): Promise<void> {
    if (this.state !== "LOCKED") return;
    const generation = ++this.generation;
    this.focusRefinementCount++;
    this.lastReason = "distance changed; hardware AF taking focus ownership";
    this.stableGeometry = observation.geometry;
    this.stableSince = performance.now();
    this.poiAimed = false;
    await this.enterAutoFocusAcquisition("focus-only recovery; exposure and ISO preserved", generation, false, true, observation.geometry);
    if (this.current(generation)) this.transition("STABILIZING", "hardware AF active for focus-only recovery");
  }

  private async beginExposureRecovery(observation: OpticalObservation): Promise<void> {
    if (this.state !== "LOCKED" || !this.exposureModes().includes("continuous")) return;
    const generation = ++this.generation;
    this.transition("EXPOSURE_RECOVERY", "persistent static exposure loss; focus retained");
    if (!(await this.applyProbe(generation, { exposureMode: "continuous" }))) {
      this.lock(observation, "exposure recovery rejected; prior camera state retained");
      return;
    }
    const recovered = await this.fresh(generation, observation.id, CAMERA_TUNING.physicalSettleMs);
    if (!recovered || !this.current(generation)) {
      await this.restoreCommittedExposure();
      return;
    }
    let final = recovered;
    const actual = this.settings();
    this.baselineExposure = actual.exposureTime;
    this.baselineIso = actual.iso;
    if (this.manualExposure() && Number.isFinite(actual.exposureTime)) {
      await this.applyProbe(generation, {
        exposureMode: "manual", exposureTime: actual.exposureTime!,
        ...(this.caps.iso && actual.iso !== undefined ? { iso: actual.iso } : {}),
      });
      final = await this.refineExposure(generation, recovered);
    }
    if (this.current(generation)) this.lock(final, "exposure-only recovery complete; focus retained");
  }

  private retryStabilizingAf(geometry: FocusGeometry): void {
    if (this.stabilizingAfRetries < CAMERA_TUNING.maxStabilizingAfRetries) {
      this.stabilizingAfRetries++;
      this.stateSince = performance.now();
      this.stableSince = performance.now();
      this.poiAimed = false;
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
    if (resetExposure && this.exposureModes().includes("continuous")) patch.exposureMode = "continuous";
    else if (restoreExposure && this.manualExposure() && this.committedExposureTime !== undefined) {
      patch.exposureMode = "manual";
      patch.exposureTime = this.committedExposureTime;
      if (this.committedIso !== undefined) patch.iso = this.committedIso;
    }
    if (Object.keys(patch).length) {
      if (resetExposure) this.fullResetCount++;
      await this.apply(track, patch);
    }
    if (!this.current(generation)) return;
    const actual = this.settings();
    if (mode && actual.focusMode === "manual") {
      await this.apply(track, { focusMode: mode });
    }
    this.lastReason = reason;
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
    if ((axis === "exposure" || axis === "all") && this.manualExposure() && this.committedExposureTime !== undefined) {
      patch.exposureMode = "manual";
      patch.exposureTime = this.committedExposureTime;
      if (this.committedIso !== undefined) patch.iso = this.committedIso;
    }
    this.candidateFocusDistance = undefined;
    this.candidateExposureTime = undefined;
    this.candidateIso = undefined;
    if (Object.keys(patch).length) await this.apply(track, patch);
  }

  private async restoreCommittedExposure(): Promise<void> {
    const track = this.track;
    if (!track || !this.manualExposure() || this.committedExposureTime === undefined) return;
    await this.apply(track, {
      exposureMode: "manual",
      exposureTime: this.committedExposureTime,
      ...(this.committedIso !== undefined ? { iso: this.committedIso } : {}),
    });
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
    if (this.state === "OPTIMIZE_FOCUS" || this.state === "OPTIMIZE_EXPOSURE") return "OPTIMIZE";
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

  private async applyProbe(generation: number, patch: CameraPatch): Promise<boolean> {
    const track = this.track;
    if (!track || !this.current(generation)) return false;
    if (patch.focusMode) this.requestedMode = patch.focusMode;
    const accepted = await this.apply(track, patch);
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
      setTimeout(() => {
        if (this.waiter?.resolve === resolve) {
          this.waiter = undefined;
          resolve(undefined);
        }
      }, 1100);
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
      decodedNow: Math.max(...samples.map((sample) => sample.decodedNow)),
      decodedRecently: Math.max(...samples.map((sample) => sample.decodedRecently)),
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
    this.committedExposureTime = settings.exposureTime;
    this.committedIso = settings.iso;
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
    return this.optimizeState === "baseline" || this.optimizeState === "focus" || this.optimizeState === "exposure";
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
