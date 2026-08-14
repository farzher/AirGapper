import type { QrOpticalMetrics } from "./qr-optics";

export type FocusStrategy = "auto" | "continuous" | "single-shot" | "manual";
export type CalibrationMode = "auto" | "off" | "force";
export type FocusState =
  | "UNAVAILABLE" | "SEEKING" | "STABILIZING" | "BASELINE"
  | "FOCUS_REFINE" | "EXPOSURE_REFINE" | "LOCKED" | "TARGET_LOST_GRACE"
  | "FOCUS_RECOVERY" | "EXPOSURE_RECOVERY" | "OPTIMIZE_FOCUS" | "OPTIMIZE_EXPOSURE" | "OVERRIDE";

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
  focusSaturation: 0.9,
  focusExcellent: 0.78,
  meaningfulFocusImprovement: 0.035,
  maxFocusProbes: 5,
  maxFocusCalibrationMs: 1800,
  maxFocusDistanceRatio: 0.12,
  physicalSettleMs: 150,
  probeSamples: 3,
  probeDiscardFrames: 1,
  exposureExcellent: 0.7,
  exposureSafetyMargin: 0.06,
  maxExposureProbes: 2,
  maxExposureCalibrationMs: 1500,
  freshFramesAfterMutation: 3,
  seekingOpticalIntervalMs: 110,
  lockedOpticalIntervalMs: 320,
  targetLostGraceMs: 1600,
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
  focusDistance?: number;
  exposureTime?: number;
  iso?: number;
  optical: QrOpticalMetrics;
  geometry: FocusGeometry;
}

export interface FocusDiagnostics {
  state: FocusState;
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
  knownGoodSettings?: { focusDistance?: number; exposureTime?: number; iso?: number };
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
  optimizeState: "idle" | "baseline" | "focus" | "exposure" | "cancelled" | "complete";
  optimizeCandidatePerformance?: ReceivePerformance;
  optimizeBestPerformance?: ReceivePerformance;
  transitions: string[];
  lastReason: string;
}

export interface ReceivePerformance {
  usefulSymbolsPerSecond: number;
  decodeSuccessRate: number;
  captureFps: number;
}
type ApplyCamera = (track: MediaStreamTrack, patch: CameraPatch) => Promise<boolean>;

export class FocusController {
  private track?: MediaStreamTrack;
  private caps: CameraCapabilities = {};
  private state: FocusState = "UNAVAILABLE";
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
  private recoveryAxis?: "focus" | "exposure";
  private optimizeState: FocusDiagnostics["optimizeState"] = "idle";
  private optimizeCandidatePerformance?: ReceivePerformance;
  private optimizeBestPerformance?: ReceivePerformance;
  private readonly transitions: string[] = [];
  private poiAimed = false;
  private afRetryCount = 0;
  private lastFocusSettled = false;
  private waiter?: {
    generation: number; afterId: number; notBefore: number; discard: number;
    samples: OpticalObservation[]; distances: number[]; resolve: (value?: OpticalObservation) => void;
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
    return this.state === "BASELINE" || this.state === "FOCUS_REFINE" || this.state === "EXPOSURE_REFINE" ||
      this.state === "FOCUS_RECOVERY" || this.state === "EXPOSURE_RECOVERY" ||
      this.state === "OPTIMIZE_FOCUS" || this.state === "OPTIMIZE_EXPOSURE";
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
    this.afRetryCount = 0;
    this.initialLockMs = undefined;
    this.optimizeState = "idle";
    this.optimizeCandidatePerformance = undefined;
    this.optimizeBestPerformance = undefined;
    this.knownGood = undefined;
    this.committedFocusDistance = undefined;
    this.committedExposureTime = undefined;
    this.committedIso = undefined;
    this.transition(this.strategy === "auto" ? "SEEKING" : "OVERRIDE", "camera track changed");
    if (this.strategy === "auto") void this.enterHardwareAuto("camera opened", this.generation, true);
    else void this.applyDeveloperFocus();
  }

  detach(): void {
    this.cancel("camera stopped");
    this.track = undefined;
    this.caps = {};
    this.transition("UNAVAILABLE", "camera stopped");
  }

  setStrategy(strategy: FocusStrategy): void {
    const optimizing = this.optimizeState === "baseline" || this.optimizeState === "focus" || this.optimizeState === "exposure";
    this.cancel("developer focus strategy changed");
    this.strategy = strategy;
    if (optimizing) this.optimizeState = "cancelled";
    this.transition(strategy === "auto" ? "SEEKING" : "OVERRIDE", "focus ownership changed");
    const applySelected = () => strategy === "auto"
      ? this.enterHardwareAuto("automatic focus selected")
      : this.applyDeveloperFocus();
    if (optimizing) void this.rollbackCommitted().then(applySelected);
    else void applySelected();
  }

  setCalibrationMode(mode: CalibrationMode): void {
    this.cancel("calibration mode changed");
    this.calibrationMode = mode;
    this.transition(this.strategy === "auto" ? "SEEKING" : "OVERRIDE", "calibration mode changed");
    if (this.strategy === "auto") void this.enterHardwareAuto(mode === "off" ? "calibration disabled" : "calibration requested");
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
    if (this.optimizeState !== "baseline" && this.optimizeState !== "focus" && this.optimizeState !== "exposure") return;
    this.cancel(reason);
    this.optimizeState = "cancelled";
    void this.rollbackCommitted().then(() => this.transition("LOCKED", `${reason}; best settings restored`));
  }

  async optimize(measure: (durationMs: number) => Promise<ReceivePerformance>): Promise<void> {
    if (this.strategy !== "auto" || this.state !== "LOCKED" || !this.latest || !this.track) return;
    const generation = ++this.generation;
    const baselineObservation = this.latest;
    const settings = this.settings();
    this.committedFocusDistance = settings.focusDistance;
    this.committedExposureTime = settings.exposureTime;
    this.committedIso = settings.iso;
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
        (candidate.usefulSymbolsPerSecond >= best.usefulSymbolsPerSecond * 0.98 && candidate.decodeSuccessRate > best.decodeSuccessRate + 0.04));
    const safe = (observation: OpticalObservation) => this.exposureAcceptable(observation.metrics, 0.45) && observation.metrics.focusScore >= 0.35;

    const focusRange = this.caps.focusDistance;
    if (this.manualFocus() && focusRange && settings.focusDistance !== undefined) {
      this.optimizeState = "focus";
      const delta = Math.max((focusRange.step ?? 0) * 2, (focusRange.max - focusRange.min) / 40);
      for (const requested of [settings.focusDistance - delta, settings.focusDistance + delta]) {
        if (!this.current(generation)) return;
        const candidate = this.quantize(requested, focusRange);
        if (candidate === this.committedFocusDistance) continue;
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
            this.committedFocusDistance = this.settings().focusDistance ?? candidate;
          }
        }
        await this.rollbackCommitted("focus");
      }
    }
    if (!this.current(generation)) return;
    await this.rollbackCommitted("focus");

    const exposureRange = this.caps.exposureTime;
    if (this.manualExposure() && exposureRange && this.committedExposureTime !== undefined) {
      this.optimizeState = "exposure";
      this.transition("OPTIMIZE_EXPOSURE", "focus fixed; searching shorter exposure by receive throughput");
      for (const factor of [Math.SQRT2, 2]) {
        const candidate = this.quantize(this.committedExposureTime / factor, exposureRange);
        if (candidate >= this.committedExposureTime) continue;
        this.candidateExposureTime = candidate;
        let iso = this.committedIso;
        if (!(await this.applyProbe(generation, { exposureMode: "manual", exposureTime: candidate, ...(iso !== undefined ? { iso } : {}) }))) break;
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
        await this.rollbackCommitted("exposure");
      }
    }
    if (!this.current(generation)) return;
    await this.rollbackCommitted();
    this.optimizeState = "complete";
    this.lock(bestObservation);
    this.lastReason = "one-shot throughput optimization complete; best settings committed";
  }

  refocus(reason = "developer forced calibration"): void {
    this.cancel(reason);
    if (this.strategy !== "auto") {
      void this.applyDeveloperFocus();
      return;
    }
    this.reacquireCount++;
    this.optimizeState = "idle";
    this.transition("SEEKING", reason);
    void this.enterHardwareAuto(reason, this.generation, true).then(() => {
      if (this.latest) this.beginCalibration();
    });
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
    if ((this.state === "BASELINE" || this.state === "FOCUS_REFINE" || this.state === "EXPOSURE_REFINE" ||
        this.state === "OPTIMIZE_FOCUS" || this.state === "OPTIMIZE_EXPOSURE") &&
        this.geometryChanged(geometry, this.stableGeometry)) {
      const optimizing = this.state === "OPTIMIZE_FOCUS" || this.state === "OPTIMIZE_EXPOSURE";
      this.cancel(optimizing ? "target moved during optimization" : "target moved during calibration");
      if (optimizing) this.optimizeState = "cancelled";
      this.transition(optimizing ? "LOCKED" : "STABILIZING", optimizing
        ? "target moved; optimization cancelled and best optics restored"
        : "target moved; probe cancelled and committed optics retained");
      this.stableGeometry = geometry;
      this.stableSince = now;
      void this.rollbackCommitted();
      this.changed();
      return;
    }
    if (!this.poiAimed && this.caps.pointsOfInterest && (this.state === "SEEKING" || this.state === "STABILIZING")) {
      this.poiAimed = true;
      const mode = this.focusModes().includes("continuous") ? "continuous" : this.focusModes().includes("single-shot") ? "single-shot" : undefined;
      if (mode) void this.applyProbe(this.generation, { focusMode: mode, pointsOfInterest: [{ x: geometry.x, y: geometry.y }] });
    }
    if (metrics.exposureScore >= CAMERA_TUNING.exposureExcellent &&
        metrics.focusScore >= CAMERA_TUNING.focusExcellent && decodedNow > 0 && this.state === "LOCKED") {
      const settings = this.settings();
      this.knownGood = {
        focusDistance: settings.focusDistance,
        exposureTime: settings.exposureTime,
        iso: settings.iso,
        optical: metrics,
        geometry,
      };
    }
    if (this.strategy !== "auto" || this.calibrationMode === "off" || this.state === "OVERRIDE") {
      this.changed();
      return;
    }

    if (this.state === "TARGET_LOST_GRACE") {
      this.transition("LOCKED", "static target returned during loss grace; committed optics restored");
      this.targetMissingSince = 0;
      return;
    }
    if (this.state === "LOCKED") {
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
        // Payload success is intentionally absent from this decision. Healthy
        // static structures mean phase/rolling-shutter failures are temporal.
        this.lastReason = decodedNow > 0 ? "payload flowing; committed optics held" : "static optics healthy; payload failure ignored";
      }
      this.changed();
      return;
    }

    if (this.state !== "SEEKING" && this.state !== "STABILIZING") return;
    if (!this.stableGeometry || this.geometryChanged(geometry, this.stableGeometry)) {
      this.stableGeometry = geometry;
      this.stableSince = now;
      this.transition("STABILIZING", "waiting for stable QR geometry");
    } else {
      // Detector jitter is expected, especially while exposure is changing.
      // Blend it without restarting the stability clock.
      this.stableGeometry = this.blendGeometry(this.stableGeometry, geometry);
      if (now - this.stableSince >= CAMERA_TUNING.geometryStabilityMs) this.beginCalibration();
    }
    this.changed();
  }

  noteTargetAbsent(now = performance.now()): void {
    if (this.strategy !== "auto" || this.state === "UNAVAILABLE" || this.state === "OVERRIDE") return;
    if (!this.targetMissingSince) this.targetMissingSince = now;
    if (this.state === "OPTIMIZE_FOCUS" || this.state === "OPTIMIZE_EXPOSURE") {
      this.cancelOptimize("target disappeared during optimization");
    } else if (this.state === "FOCUS_REFINE" || this.state === "EXPOSURE_REFINE" || this.state === "BASELINE") {
      this.cancel("static QR target disappeared during calibration");
      this.transition("STABILIZING", "target absent during probe; committed optics restored");
      this.stableGeometry = undefined;
      void this.rollbackCommitted();
    } else if (this.state === "LOCKED") {
      this.transition("TARGET_LOST_GRACE", "static target missing; waiting through grace");
    } else if (this.state === "TARGET_LOST_GRACE" && now - this.targetMissingSince >= CAMERA_TUNING.targetLostGraceMs) {
      this.cancel("static target absent beyond grace");
      this.stableGeometry = undefined;
      this.stableSince = 0;
      this.transition("SEEKING", "static target absent beyond grace; hardware AF + AE reacquired");
      void this.enterHardwareAuto("sustained target loss", this.generation, true);
    }
    this.changed();
  }

  diagnostics(): FocusDiagnostics {
    const settings = this.settings();
    const optical = this.latest?.metrics;
    return {
      state: this.state,
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
        focusDistance: this.knownGood.focusDistance,
        exposureTime: this.knownGood.exposureTime,
        iso: this.knownGood.iso,
      },
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
      optimizeState: this.optimizeState,
      optimizeCandidatePerformance: this.optimizeCandidatePerformance,
      optimizeBestPerformance: this.optimizeBestPerformance,
      transitions: [...this.transitions],
      lastReason: this.lastReason,
    };
  }

  private beginCalibration(): void {
    if (this.state === "BASELINE" || this.state === "FOCUS_REFINE" || this.state === "EXPOSURE_REFINE") return;
    const generation = ++this.generation;
    void this.calibrate(generation);
  }

  private async calibrate(generation: number): Promise<void> {
    const track = this.track;
    const initial = this.latest;
    if (!track || !initial || !this.current(generation)) return;
    this.transition("BASELINE", "waiting for hardware AF to physically settle");
    this.focusProbes = 0;
    this.exposureProbes = 0;
    let settled = await this.fresh(generation, initial.id, CAMERA_TUNING.physicalSettleMs);
    if (!settled || !this.current(generation)) return;
    const focusRange = this.caps.focusDistance;
    let visiblyBad = !this.lastFocusSettled || settled.metrics.focusScore < 0.35 || settled.metrics.confidence < 0.72;
    if (visiblyBad && this.afRetryCount < 1 && this.focusModes().includes("single-shot")) {
      this.afRetryCount++;
      this.poiAimed = true;
      await this.applyProbe(generation, { focusMode: "single-shot", pointsOfInterest: [{ x: settled.geometry.x, y: settled.geometry.y }] });
      settled = await this.fresh(generation, settled.id, CAMERA_TUNING.physicalSettleMs) ?? settled;
      visiblyBad = !this.lastFocusSettled || settled.metrics.focusScore < 0.35 || settled.metrics.confidence < 0.72;
    }
    const baseline = this.settings();
    this.baselineFocus = baseline.focusDistance;
    this.baselineExposure = baseline.exposureTime;
    this.baselineIso = baseline.iso;
    this.changed();

    let observation = settled;
    if (visiblyBad && settled.metrics.focusScore < 0.35 && this.focusModes().includes("continuous")) {
      this.lastReason = "hardware AF remained poor; continuous focus retained instead of freezing a bad lock";
      this.lock(observation);
      return;
    }
    if (this.manualFocus() && Number.isFinite(this.baselineFocus) && focusRange) {
      const frozenExposure = this.baselineExposure;
      const frozenIso = this.baselineIso;
      const frozen = await this.applyProbe(generation, {
        focusMode: "manual", focusDistance: this.baselineFocus,
        ...(this.manualExposure() && Number.isFinite(frozenExposure)
          ? { exposureMode: "manual", exposureTime: frozenExposure, ...(this.caps.iso && Number.isFinite(frozenIso) ? { iso: frozenIso } : {}) }
          : {}),
      });
      if (!frozen) {
        await this.enterHardwareAuto("initial manual lock rejected; hardware AF/AE retained", generation);
        if (this.latest) this.lock(this.latest);
        return;
      }
      observation = await this.fresh(generation, observation.id) ?? observation;
      if (!this.current(generation)) return;
      if (this.calibrationMode === "force" || observation.metrics.focusScore < CAMERA_TUNING.focusSaturation) {
        observation = await this.refineFocus(generation, observation);
      } else this.lastReason = "hardware AF static edges already excellent; focus refinement skipped";
    } else if (this.focusModes().includes("single-shot")) {
      this.lastReason = "manual focus unavailable; holding hardware single-shot focus";
      await this.applyProbe(generation, { focusMode: "single-shot" });
      observation = await this.fresh(generation, observation.id) ?? observation;
    } else this.lastReason = "manual focus unavailable; hardware focus retained";
    if (!this.current(generation)) return;

    // COMMIT FOCUS. Every following exposure patch is composed with this
    // manual focus value, so exposure ownership cannot move the lens.
    const focused = this.settings();
    this.committedFocusDistance = focused.focusDistance;
    this.candidateFocusDistance = undefined;
    if (this.recoveryAxis === "focus") {
      this.recoveryAxis = undefined;
      this.lastReason = "focus-only recovery completed; exposure and ISO preserved";
    } else if (this.manualExposure() && Number.isFinite(this.settings().exposureTime)) {
      observation = await this.refineExposure(generation, observation);
    } else if (this.manualFocus()) {
      this.lastReason = "manual exposure unavailable; focus locked, hardware AE retained";
    } else {
      this.lastReason = "manual camera controls unavailable; hardware AF/AE retained";
    }
    if (!this.current(generation)) return;
    this.lock(observation);
  }

  private async refineFocus(generation: number, baseline: OpticalObservation): Promise<OpticalObservation> {
    const range = this.caps.focusDistance!;
    const started = performance.now();
    const f0 = this.settings().focusDistance ?? this.baselineFocus!;
    const hardwareStep = Math.max(range.step ?? 0, (range.max - range.min) / 100 || 0.01);
    const delta = Math.max(hardwareStep * 2, (range.max - range.min) / 40);
    const maxDistance = Math.max(delta * 2, (range.max - range.min) * CAMERA_TUNING.maxFocusDistanceRatio);
    const clampCandidate = (value: number) => this.quantize(
      Math.max(f0 - maxDistance, Math.min(f0 + maxDistance, value)), range,
    );
    const neighbors = [clampCandidate(f0 - delta), clampCandidate(f0 + delta)]
      .filter((value, index, all) => value !== f0 && all.indexOf(value) === index);
    const samples: { value: number; observation: OpticalObservation }[] = [{ value: f0, observation: baseline }];
    this.focusRefinementCount++;
    this.transition("FOCUS_REFINE", "local focus probes; exposure frozen at baseline");
    for (const candidate of neighbors) {
      if (!this.current(generation) || this.focusProbes >= CAMERA_TUNING.maxFocusProbes ||
          performance.now() - started >= CAMERA_TUNING.maxFocusCalibrationMs) break;
      this.focusProbes++;
      this.candidateFocusDistance = candidate;
      if (!(await this.applyProbe(generation, { focusMode: "manual", focusDistance: candidate }))) break;
      const observed = await this.fresh(generation, this.latest?.id ?? baseline.id);
      if (!observed) break;
      samples.push({ value: this.settings().focusDistance ?? candidate, observation: observed });
      this.changed();
    }
    const improvingNeighbor = samples
      .filter((sample) => sample.value !== f0)
      .sort((a, b) => b.observation.metrics.focusScore - a.observation.metrics.focusScore)[0];
    if (improvingNeighbor && improvingNeighbor.observation.metrics.focusScore > baseline.metrics.focusScore + 0.015 &&
        this.current(generation) && this.focusProbes < CAMERA_TUNING.maxFocusProbes &&
        performance.now() - started < CAMERA_TUNING.maxFocusCalibrationMs) {
      const direction = Math.sign(improvingNeighbor.value - f0);
      const candidate = clampCandidate(f0 + direction * delta * 2);
      if (!samples.some((sample) => sample.value === candidate)) {
        this.focusProbes++;
        this.candidateFocusDistance = candidate;
        if (await this.applyProbe(generation, { focusMode: "manual", focusDistance: candidate })) {
          const observed = await this.fresh(generation, this.latest?.id ?? baseline.id);
          if (observed) samples.push({ value: this.settings().focusDistance ?? candidate, observation: observed });
        }
      }
    }
    samples.sort((a, b) => a.value - b.value);
    const bestScore = Math.max(...samples.map((sample) => sample.observation.metrics.focusScore));
    const plateau = samples.filter((sample) => sample.observation.metrics.focusScore >= bestScore - 0.025);
    const selected = plateau[Math.floor((plateau.length - 1) / 2)]!;
    const keepBaseline = bestScore < baseline.metrics.focusScore + CAMERA_TUNING.meaningfulFocusImprovement;
    const final = keepBaseline ? samples.reduce((best, sample) => Math.abs(sample.value - f0) < Math.abs(best.value - f0) ? sample : best) : selected;
    this.candidateFocusDistance = final.value;
    if (!(await this.applyProbe(generation, { focusMode: "manual", focusDistance: final.value }))) {
      await this.rollbackCommitted("focus");
      return await this.fresh(generation, this.latest?.id ?? baseline.id) ?? baseline;
    }
    this.lastReason = keepBaseline ? "local focus probes did not convincingly beat hardware AF" : "center of robust static-edge focus plateau selected";
    return await this.fresh(generation, this.latest?.id ?? baseline.id) ?? final.observation;
  }

  private async refineExposure(generation: number, baseline: OpticalObservation): Promise<OpticalObservation> {
    const range = this.caps.exposureTime!;
    const isoRange = this.caps.iso;
    const started = performance.now();
    this.exposureRefinementCount++;
    this.transition("EXPOSURE_REFINE", "exposure/ISO probes; committed manual focus frozen");
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
        this.changed();
        if (acceptable || !isoRange || trialIso === undefined || trialIso >= isoRange.max ||
            this.exposureProbes >= CAMERA_TUNING.maxExposureProbes) break;
        trialIso = this.quantize(Math.min(isoRange.max, trialIso * 1.5), isoRange);
      } while (this.current(generation) && performance.now() - started < CAMERA_TUNING.maxExposureCalibrationMs);
      if (!observed || !acceptable) break;
      // Accepted candidates are authoritative because Android getSettings()
      // commonly trails successful exposure and ISO constraints.
      currentExposure = nextExposure;
      currentIso = trialIso;
      best = observed;
      bestExposure = nextExposure;
      bestIso = trialIso;
    }
    this.requestedExposure = bestExposure;
    this.requestedIso = bestIso;
    this.candidateExposureTime = bestExposure;
    this.candidateIso = bestIso;
    if (!(await this.applyProbe(generation, {
      exposureMode: "manual", exposureTime: bestExposure,
      ...(bestIso !== undefined ? { iso: bestIso } : {}),
    }))) {
      await this.rollbackCommitted("exposure");
      return this.latest ?? baseline;
    }
    this.committedExposureTime = bestExposure;
    this.committedIso = bestIso;
    this.candidateExposureTime = undefined;
    this.candidateIso = undefined;
    this.lastReason = bestExposure < (this.baselineExposure ?? Infinity)
      ? "shorter exposure kept: static binary signal and actual capture FPS remained safe"
      : "AE exposure retained; shorter candidate weakened signal or capture FPS";
    return await this.fresh(generation, this.latest?.id ?? baseline.id) ?? best;
  }

  private exposureAcceptable(metrics: QrOpticalMetrics, floor: number): boolean {
    return metrics.confidence >= 0.86 && metrics.exposureScore >= floor &&
      metrics.separation >= 48 && metrics.noise <= Math.max(20, metrics.separation * 0.25) &&
      metrics.clipping < 0.55 && metrics.banding < 0.32;
  }

  private lock(observation: OpticalObservation): void {
    const settings = this.settings();
    this.committedFocusDistance ??= settings.focusDistance;
    this.committedExposureTime ??= settings.exposureTime;
    this.committedIso ??= settings.iso;
    this.knownGood = {
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
    this.transition("LOCKED", "focus and exposure committed; camera mutation owner released");
    this.stableGeometry = observation.geometry;
    this.stableSince = observation.at;
    if (this.initialLockMs === undefined) this.initialLockMs = performance.now() - this.attachedAt;
    this.changed();
  }

  private async beginFocusRecovery(observation: OpticalObservation): Promise<void> {
    if (this.state !== "LOCKED") return;
    const generation = ++this.generation;
    this.recoveryAxis = "focus";
    this.transition("FOCUS_RECOVERY", "persistent static-edge loss plus geometry change; exposure preserved");
    const mode = this.focusModes().includes("continuous") ? "continuous" : this.focusModes().includes("single-shot") ? "single-shot" : undefined;
    if (!mode || !(await this.applyProbe(generation, { focusMode: mode, pointsOfInterest: [{ x: observation.geometry.x, y: observation.geometry.y }] }))) {
      this.recoveryAxis = undefined;
      this.lock(observation);
      return;
    }
    await this.fresh(generation, observation.id, CAMERA_TUNING.physicalSettleMs);
    if (!this.current(generation)) return;
    this.stableGeometry = observation.geometry;
    this.stableSince = performance.now();
    this.transition("STABILIZING", "hardware AF settling for focus-only recovery");
  }

  private async beginExposureRecovery(observation: OpticalObservation): Promise<void> {
    if (this.state !== "LOCKED" || !this.exposureModes().includes("continuous")) return;
    const generation = ++this.generation;
    this.transition("EXPOSURE_RECOVERY", "persistent static binary-signal loss; focus preserved");
    if (!(await this.applyProbe(generation, { exposureMode: "continuous" }))) {
      this.lock(observation);
      return;
    }
    const recovered = await this.fresh(generation, observation.id, CAMERA_TUNING.physicalSettleMs);
    if (!recovered || !this.current(generation)) {
      await this.rollbackCommitted("exposure");
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
    if (this.current(generation)) {
      this.lastReason = "exposure-only conservative recovery completed; focus preserved";
      this.lock(final);
    }
  }

  private async enterHardwareAuto(reason: string, generation = this.generation, fullReset = false): Promise<void> {
    const track = this.track;
    if (!track || track.readyState !== "live" || !this.current(generation)) return;
    const patch: CameraPatch = {};
    const mode = this.focusModes().includes("continuous") ? "continuous" : this.focusModes().includes("single-shot") ? "single-shot" : undefined;
    if (mode) {
      patch.focusMode = mode;
      this.requestedMode = mode;
    }
    if (this.exposureModes().includes("continuous")) patch.exposureMode = "continuous";
    if (Object.keys(patch).length) {
      if (fullReset) this.fullResetCount++;
      await this.apply(track, patch);
    }
    if (!this.current(generation)) return;
    this.lastReason = reason;
    this.changed();
  }

  private async rollbackCommitted(axis: "focus" | "exposure" | "all" = "all"): Promise<void> {
    const track = this.track;
    if (!track) return;
    const patch: CameraPatch = {};
    if ((axis === "focus" || axis === "all") && this.manualFocus()) {
      const focusDistance = this.committedFocusDistance ?? this.baselineFocus;
      if (focusDistance !== undefined) Object.assign(patch, { focusMode: "manual", focusDistance });
    }
    if ((axis === "exposure" || axis === "all") && this.manualExposure()) {
      const exposureTime = this.committedExposureTime ?? this.baselineExposure;
      const iso = this.committedIso ?? this.baselineIso;
      if (exposureTime !== undefined) Object.assign(patch, {
        exposureMode: "manual", exposureTime, ...(iso !== undefined ? { iso } : {}),
      });
    }
    this.candidateFocusDistance = undefined;
    this.candidateExposureTime = undefined;
    this.candidateIso = undefined;
    if (Object.keys(patch).length) await this.apply(track, patch);
  }

  private transition(next: FocusState, reason: string): void {
    if (this.state !== next) {
      this.transitions.push(`${this.state} → ${next}: ${reason}`);
      if (this.transitions.length > 8) this.transitions.shift();
      this.state = next;
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
        generation, afterId, notBefore: performance.now() + settleMs,
        discard: CAMERA_TUNING.probeDiscardFrames, samples: [], distances: [], resolve,
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
    const distance = this.settings().focusDistance;
    if (distance !== undefined) waiter.distances.push(distance);
    if (waiter.samples.length < CAMERA_TUNING.probeSamples) return;
    this.waiter = undefined;
    const distanceStep = this.caps.focusDistance?.step ?? 0.01;
    const distanceStable = waiter.distances.length < 2 || Math.max(...waiter.distances) - Math.min(...waiter.distances) <= distanceStep * 1.5;
    const focusValues = waiter.samples.map((sample) => sample.metrics.focusScore);
    const qualityStable = Math.max(...focusValues) - Math.min(...focusValues) <= 0.08;
    this.lastFocusSettled = distanceStable && qualityStable;
    waiter.resolve(this.aggregate(waiter.samples));
  }

  private aggregate(samples: OpticalObservation[]): OpticalObservation {
    const middle = <T>(values: T[], value: (item: T) => number): number => {
      const ordered = values.map(value).sort((a, b) => a - b);
      return ordered[ordered.length >> 1]!;
    };
    const latest = samples[samples.length - 1]!;
    const metric = (key: keyof QrOpticalMetrics) => middle(samples, (sample) => Number(sample.metrics[key]));
    return {
      ...latest,
      captureFps: middle(samples, (sample) => sample.captureFps),
      geometry: {
        x: middle(samples, (sample) => sample.geometry.x), y: middle(samples, (sample) => sample.geometry.y),
        scale: middle(samples, (sample) => sample.geometry.scale),
        perspectiveX: middle(samples, (sample) => sample.geometry.perspectiveX),
        perspectiveY: middle(samples, (sample) => sample.geometry.perspectiveY),
        quality: middle(samples, (sample) => sample.geometry.quality),
      },
      metrics: {
        confidence: metric("confidence"), focusScore: metric("focusScore"), exposureScore: metric("exposureScore"),
        transitionWidthModules: metric("transitionWidthModules"), blackLevel: metric("blackLevel"),
        whiteLevel: metric("whiteLevel"), separation: metric("separation"), noise: metric("noise"),
        clipping: metric("clipping"), banding: metric("banding"), temporalContamination: metric("temporalContamination"),
        tiles: Math.round(metric("tiles")), sampledModules: Math.round(metric("sampledModules")),
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

  private settings(): CameraSettings { return (this.track?.getSettings() ?? {}) as CameraSettings; }
  private focusModes(): string[] { return Array.isArray(this.caps.focusMode) ? this.caps.focusMode : []; }
  private exposureModes(): string[] { return Array.isArray(this.caps.exposureMode) ? this.caps.exposureMode : []; }
  private manualFocus(): boolean { return this.focusModes().includes("manual") && Boolean(this.caps.focusDistance); }
  private manualExposure(): boolean { return this.exposureModes().includes("manual") && Boolean(this.caps.exposureTime); }

  private quantize(value: number, range: NumericRange): number {
    const clamped = Math.max(range.min, Math.min(range.max, value));
    if (!range.step || range.step <= 0) return clamped;
    return Math.max(range.min, Math.min(range.max, range.min + Math.round((clamped - range.min) / range.step) * range.step));
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
    return { x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25,
      scale: a.scale * 0.75 + b.scale * 0.25,
      perspectiveX: a.perspectiveX * 0.75 + b.perspectiveX * 0.25,
      perspectiveY: a.perspectiveY * 0.75 + b.perspectiveY * 0.25,
      quality: a.quality * 0.75 + b.quality * 0.25 };
  }
}
