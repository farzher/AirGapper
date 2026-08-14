import type { QrOpticalMetrics } from "./qr-optics";

export type FocusStrategy = "auto" | "continuous" | "single-shot" | "manual";
export type CalibrationMode = "auto" | "off" | "force";
export type FocusState =
  | "UNAVAILABLE" | "SEEKING" | "STABILIZING" | "BASELINE"
  | "FOCUS_REFINE" | "EXPOSURE_REFINE" | "LOCKED" | "TARGET_LOST_GRACE" | "OVERRIDE";

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
  targetLossGraceMs: 480,
  geometrySamplesToReacquire: 3,
  scaleChangeRatio: 0.16,
  displacementRatio: 0.1,
  perspectiveChange: 0.14,
  movingDisplacementRatio: 0.018,
  movingScaleRatio: 0.035,
  movingPerspective: 0.04,
  opticalDegradationSamples: 5,
  focusSaturation: 0.9,
  focusExcellent: 0.78,
  meaningfulFocusImprovement: 0.035,
  maxFocusProbes: 5,
  maxFocusCalibrationMs: 1300,
  maxFocusDistanceRatio: 0.12,
  exposureExcellent: 0.7,
  exposureSafetyMargin: 0.06,
  maxExposureProbes: 7,
  maxExposureCalibrationMs: 1900,
  maxIsoMultiplier: 6,
  freshFramesAfterMutation: 2,
  lockedOpticalIntervalMs: 180,
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
  initialLockMs?: number;
  reacquireCount: number;
  lastReason: string;
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
  private geometryChanges = 0;
  private opticalBad = 0;
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
  private lockedOptical?: QrOpticalMetrics;
  private poiAimed = false;
  private waiter?: { generation: number; afterId: number; remaining: number; resolve: (value?: OpticalObservation) => void };

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
  get expectsProbeFrame(): boolean { return this.state === "BASELINE" || this.state === "FOCUS_REFINE" || this.state === "EXPOSURE_REFINE"; }
  get opticalIntervalMs(): number { return this.state === "LOCKED" ? CAMERA_TUNING.lockedOpticalIntervalMs : 0; }

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
    this.initialLockMs = undefined;
    this.state = this.strategy === "auto" ? "SEEKING" : "OVERRIDE";
    this.changed();
    void this.enterHardwareAuto("camera opened");
  }

  detach(): void {
    this.cancel("camera stopped");
    this.track = undefined;
    this.caps = {};
    this.state = "UNAVAILABLE";
    this.changed();
  }

  setStrategy(strategy: FocusStrategy): void {
    this.cancel("developer focus strategy changed");
    this.strategy = strategy;
    this.state = strategy === "auto" ? "SEEKING" : "OVERRIDE";
    this.changed();
    if (strategy === "auto") void this.enterHardwareAuto("automatic focus selected");
    else void this.applyDeveloperFocus();
  }

  setCalibrationMode(mode: CalibrationMode): void {
    this.cancel("calibration mode changed");
    this.calibrationMode = mode;
    this.state = this.strategy === "auto" ? "SEEKING" : "OVERRIDE";
    this.changed();
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
    if (this.strategy === "auto") this.state = "OVERRIDE";
    this.lastReason = reason;
    this.changed();
  }

  refocus(reason = "developer forced calibration"): void {
    this.cancel(reason);
    if (this.strategy !== "auto") {
      void this.applyDeveloperFocus();
      return;
    }
    this.state = "SEEKING";
    this.changed();
    void this.enterHardwareAuto(reason).then(() => {
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
  ): void {
    const priorGeometry = this.latest?.geometry;
    const observation = { id, at: now, geometry, metrics, decodedNow, decodedRecently, totalTiles };
    this.latest = observation;
    this.targetMissingSince = 0;
    this.resolveWaiter(observation);
    if ((this.state === "BASELINE" || this.state === "FOCUS_REFINE" || this.state === "EXPOSURE_REFINE") &&
        (this.geometryChanged(geometry, this.stableGeometry) || this.geometryMoving(geometry, priorGeometry))) {
      this.cancel("target moved during calibration");
      this.state = "SEEKING";
      this.stableGeometry = geometry;
      this.stableSince = now;
      void this.enterHardwareAuto("target moved; waiting for stable geometry");
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

    if (this.state === "LOCKED" || this.state === "TARGET_LOST_GRACE") {
      const moved = this.geometryChanged(geometry, this.stableGeometry) || this.geometryMoving(geometry, priorGeometry);
      this.geometryChanges = moved ? this.geometryChanges + 1 : 0;
      const reference = this.knownGood?.optical ?? this.lockedOptical ?? metrics;
      const focusFloor = Math.min(0.58, reference.focusScore * 0.62);
      const exposureFloor = Math.min(0.52, reference.exposureScore * 0.58);
      const degraded = metrics.confidence < 0.72 || metrics.focusScore < focusFloor || metrics.exposureScore < exposureFloor;
      this.opticalBad = degraded ? this.opticalBad + 1 : Math.max(0, this.opticalBad - 2);
      if (this.geometryChanges >= CAMERA_TUNING.geometrySamplesToReacquire) {
        void this.reacquire("sustained target movement, scale, or perspective change");
      } else if (this.opticalBad >= CAMERA_TUNING.opticalDegradationSamples) {
        void this.reacquire(metrics.focusScore < focusFloor
          ? "sustained static QR edge deterioration"
          : "sustained static QR exposure deterioration");
      } else {
        this.state = "LOCKED";
        this.lastReason = decodedNow === 0 && metrics.focusScore >= CAMERA_TUNING.focusExcellent && metrics.exposureScore >= CAMERA_TUNING.exposureExcellent
          ? "payload miss; static optics healthy, likely phase/rolling-shutter channel loss"
          : "static optics and geometry healthy; camera retained";
      }
      this.changed();
      return;
    }

    if (this.state !== "SEEKING" && this.state !== "STABILIZING") return;
    if (!this.stableGeometry || this.geometryChanged(geometry, this.stableGeometry) || this.geometryMoving(geometry, priorGeometry)) {
      this.stableGeometry = geometry;
      this.stableSince = now;
      this.state = "STABILIZING";
      this.lastReason = "waiting for stable QR geometry";
    } else {
      this.stableGeometry = this.blendGeometry(this.stableGeometry, geometry);
      if (now - this.stableSince >= CAMERA_TUNING.geometryStabilityMs) this.beginCalibration();
    }
    this.changed();
  }

  noteTargetAbsent(now = performance.now()): void {
    if (this.strategy !== "auto" || this.state === "UNAVAILABLE" || this.state === "OVERRIDE") return;
    if (!this.targetMissingSince) this.targetMissingSince = now;
    if (this.state === "FOCUS_REFINE" || this.state === "EXPOSURE_REFINE" || this.state === "BASELINE") {
      this.cancel("static QR target disappeared during calibration");
      this.state = "SEEKING";
      this.stableGeometry = undefined;
      void this.enterHardwareAuto("calibration canceled; restoring hardware AF/AE");
    } else if (this.state === "LOCKED") {
      this.state = "TARGET_LOST_GRACE";
      this.lastReason = "target briefly absent; known camera lock retained";
    }
    if (now - this.targetMissingSince >= CAMERA_TUNING.targetLossGraceMs && this.state === "TARGET_LOST_GRACE") {
      void this.reacquire("target absent beyond grace period");
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
      initialLockMs: this.initialLockMs,
      reacquireCount: this.reacquireCount,
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
    this.state = "BASELINE";
    this.focusProbes = 0;
    this.exposureProbes = 0;
    this.lastReason = "capturing hardware AF/AE baseline";
    const baseline = this.settings();
    this.baselineFocus = baseline.focusDistance;
    this.baselineExposure = baseline.exposureTime;
    this.baselineIso = baseline.iso;
    this.changed();

    if (this.knownGood && this.similarGeometry(initial.geometry, this.knownGood.geometry)) {
      const restored = await this.tryKnownGood(generation, initial.id);
      if (restored) return;
      await this.enterHardwareAuto("previous lock did not validate; using hardware AF/AE", generation);
    }
    if (!this.current(generation)) return;

    let observation = this.latest ?? initial;
    if (this.manualFocus() && Number.isFinite(this.baselineFocus)) {
      const frozen = await this.applyProbe(generation, {
        focusMode: "manual", focusDistance: this.baselineFocus,
        ...(this.manualExposure() && Number.isFinite(this.baselineExposure)
          ? { exposureMode: "manual", exposureTime: this.baselineExposure, ...(this.caps.iso && Number.isFinite(this.baselineIso) ? { iso: this.baselineIso } : {}) }
          : {}),
      });
      if (!frozen) {
        await this.enterHardwareAuto("manual camera lock rejected; hardware AF/AE retained", generation);
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

    if (this.manualExposure() && Number.isFinite(this.settings().exposureTime)) {
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
    this.state = "FOCUS_REFINE";
    for (const candidate of neighbors) {
      if (!this.current(generation) || this.focusProbes >= CAMERA_TUNING.maxFocusProbes ||
          performance.now() - started >= CAMERA_TUNING.maxFocusCalibrationMs) break;
      this.focusProbes++;
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
    if (!(await this.applyProbe(generation, { focusMode: "manual", focusDistance: final.value }))) {
      await this.enterHardwareAuto("manual focus rejected; hardware AF retained", generation);
      return this.latest ?? baseline;
    }
    this.lastReason = keepBaseline ? "local focus probes did not convincingly beat hardware AF" : "center of robust static-edge focus plateau selected";
    return await this.fresh(generation, this.latest?.id ?? baseline.id) ?? final.observation;
  }

  private async refineExposure(generation: number, baseline: OpticalObservation): Promise<OpticalObservation> {
    const range = this.caps.exposureTime!;
    const isoRange = this.caps.iso;
    const started = performance.now();
    this.state = "EXPOSURE_REFINE";
    let currentExposure = this.quantize(this.settings().exposureTime ?? this.baselineExposure!, range);
    let currentIso = isoRange ? (this.settings().iso ?? this.baselineIso) : undefined;
    let best = baseline;
    let bestExposure = currentExposure;
    let bestIso = currentIso;
    const qualityFloor = Math.max(CAMERA_TUNING.exposureExcellent,
      Math.min(0.86, baseline.metrics.exposureScore - CAMERA_TUNING.exposureSafetyMargin));
    const shortEnough = currentExposure <= Math.max(range.min * 2, 2);
    if (this.calibrationMode !== "force" && shortEnough && baseline.metrics.exposureScore >= qualityFloor + CAMERA_TUNING.exposureSafetyMargin) {
      this.requestedExposure = currentExposure;
      this.requestedIso = currentIso;
      if (await this.applyProbe(generation, {
        exposureMode: "manual", exposureTime: currentExposure,
        ...(currentIso !== undefined ? { iso: currentIso } : {}),
      })) {
        this.lastReason = "hardware AE already short and excellent; exposure locked without searching";
        return await this.fresh(generation, baseline.id) ?? baseline;
      }
      await this.enterHardwareAuto("manual exposure lock rejected; hardware AE retained", generation);
      return this.latest ?? baseline;
    }

    while (this.current(generation) && this.exposureProbes < CAMERA_TUNING.maxExposureProbes &&
        performance.now() - started < CAMERA_TUNING.maxExposureCalibrationMs) {
      const nextExposure = this.quantize(Math.max(range.min, currentExposure / 2), range);
      if (nextExposure >= currentExposure - Math.max(range.step ?? 0, 1e-6) / 2) break;
      this.exposureProbes++;
      this.requestedExposure = nextExposure;
      this.requestedIso = currentIso;
      if (!(await this.applyProbe(generation, {
        exposureMode: "manual", exposureTime: nextExposure,
        ...(currentIso !== undefined ? { iso: currentIso } : {}),
      }))) {
        await this.enterHardwareAuto("manual exposure rejected; hardware AE retained", generation);
        return this.latest ?? baseline;
      }
      let observed = await this.fresh(generation, this.latest?.id ?? baseline.id);
      if (!observed) break;
      let accepted = this.exposureAcceptable(observed.metrics, qualityFloor);
      if (!accepted && isoRange && currentIso !== undefined && this.exposureProbes < CAMERA_TUNING.maxExposureProbes) {
        const recovery = Math.max(1.25, baseline.metrics.separation / Math.max(1, observed.metrics.separation));
        const isoCeiling = Math.min(isoRange.max, (this.baselineIso ?? currentIso) * CAMERA_TUNING.maxIsoMultiplier);
        const nextIso = this.quantize(Math.min(isoCeiling, currentIso * recovery), isoRange);
        if (nextIso > currentIso) {
          this.exposureProbes++;
          this.requestedIso = nextIso;
          if (!(await this.applyProbe(generation, { exposureMode: "manual", exposureTime: nextExposure, iso: nextIso }))) break;
          observed = await this.fresh(generation, this.latest?.id ?? baseline.id);
          accepted = Boolean(observed && this.exposureAcceptable(observed.metrics, qualityFloor));
          if (accepted) currentIso = this.settings().iso ?? nextIso;
        }
      }
      this.changed();
      if (!observed || !accepted) break;
      currentExposure = this.settings().exposureTime ?? nextExposure;
      bestExposure = currentExposure;
      bestIso = this.settings().iso ?? currentIso;
      best = observed;
      if (currentExposure <= range.min + Math.max(range.step ?? 0, 1e-6) / 2) break;
    }
    this.requestedExposure = bestExposure;
    this.requestedIso = bestIso;
    if (!(await this.applyProbe(generation, {
      exposureMode: "manual", exposureTime: bestExposure,
      ...(bestIso !== undefined ? { iso: bestIso } : {}),
    }))) {
      await this.enterHardwareAuto("manual exposure lock rejected; hardware AE retained", generation);
      return this.latest ?? baseline;
    }
    this.lastReason = bestExposure < (this.baselineExposure ?? Infinity)
      ? "shortest robust static-QR exposure locked with safety margin"
      : "shorter exposure lost static signal; hardware AE baseline retained";
    return await this.fresh(generation, this.latest?.id ?? baseline.id) ?? best;
  }

  private exposureAcceptable(metrics: QrOpticalMetrics, floor: number): boolean {
    return metrics.confidence >= 0.86 && metrics.exposureScore >= floor &&
      metrics.separation >= 55 && metrics.noise <= Math.max(22, metrics.separation * 0.28) &&
      metrics.banding < 0.32;
  }

  private async tryKnownGood(generation: number, afterId: number): Promise<boolean> {
    const saved = this.knownGood!;
    const patch: CameraPatch = {};
    if (this.manualFocus() && saved.focusDistance !== undefined) Object.assign(patch, { focusMode: "manual", focusDistance: saved.focusDistance });
    if (this.manualExposure() && saved.exposureTime !== undefined) Object.assign(patch, {
      exposureMode: "manual", exposureTime: saved.exposureTime, ...(saved.iso !== undefined ? { iso: saved.iso } : {}),
    });
    if (!Object.keys(patch).length) return false;
    this.lastReason = "quickly validating previous known-good camera lock";
    await this.applyProbe(generation, patch);
    const observed = await this.fresh(generation, afterId);
    if (!observed || observed.metrics.focusScore < CAMERA_TUNING.focusExcellent ||
        observed.metrics.exposureScore < CAMERA_TUNING.exposureExcellent) return false;
    this.lock(observed);
    this.lastReason = "previous known-good lock restored and validated on fresh static QR frames";
    this.changed();
    return true;
  }

  private lock(observation: OpticalObservation): void {
    this.state = "LOCKED";
    this.lockedOptical = observation.metrics;
    this.stableGeometry = observation.geometry;
    this.stableSince = observation.at;
    this.geometryChanges = 0;
    this.opticalBad = 0;
    if (this.initialLockMs === undefined) this.initialLockMs = performance.now() - this.attachedAt;
    this.changed();
  }

  private async reacquire(reason: string): Promise<void> {
    if (this.state === "SEEKING") return;
    this.cancel(reason);
    this.reacquireCount++;
    this.state = "SEEKING";
    this.latest = undefined;
    this.stableGeometry = undefined;
    this.stableSince = 0;
    this.geometryChanges = 0;
    this.opticalBad = 0;
    this.targetMissingSince = 0;
    this.poiAimed = false;
    this.changed();
    await this.enterHardwareAuto(reason);
  }

  private async enterHardwareAuto(reason: string, generation = this.generation): Promise<void> {
    const track = this.track;
    if (!track || track.readyState !== "live" || !this.current(generation)) return;
    const patch: CameraPatch = {};
    const mode = this.focusModes().includes("continuous") ? "continuous" : this.focusModes().includes("single-shot") ? "single-shot" : undefined;
    if (mode) {
      patch.focusMode = mode;
      this.requestedMode = mode;
    }
    if (this.exposureModes().includes("continuous")) patch.exposureMode = "continuous";
    if (Object.keys(patch).length) await this.apply(track, patch);
    if (!this.current(generation)) return;
    this.lastReason = reason;
    this.changed();
  }

  private async applyDeveloperFocus(): Promise<void> {
    const track = this.track;
    if (!track) return;
    if (this.strategy === "manual" && this.manualFocus() && this.manualDistance !== undefined) {
      this.requestedMode = "manual";
      await this.apply(track, { focusMode: "manual", focusDistance: this.manualDistance });
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

  private fresh(generation: number, afterId: number): Promise<OpticalObservation | undefined> {
    if (!this.current(generation)) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      this.waiter?.resolve(undefined);
      this.waiter = {
        generation,
        afterId,
        remaining: CAMERA_TUNING.freshFramesAfterMutation,
        resolve,
      };
      setTimeout(() => {
        if (this.waiter?.resolve === resolve) {
          this.waiter = undefined;
          resolve(undefined);
        }
      }, 520);
    });
  }

  private resolveWaiter(observation: OpticalObservation): void {
    const waiter = this.waiter;
    if (!waiter || waiter.generation !== this.generation || observation.id <= waiter.afterId) return;
    waiter.afterId = observation.id;
    if (--waiter.remaining > 0) return;
    this.waiter = undefined;
    waiter.resolve(observation);
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

  private geometryMoving(current: FocusGeometry, prior?: FocusGeometry): boolean {
    if (!prior) return false;
    return Math.hypot(current.x - prior.x, current.y - prior.y) > CAMERA_TUNING.movingDisplacementRatio ||
      Math.abs(Math.log(Math.max(0.0001, current.scale) / Math.max(0.0001, prior.scale))) > CAMERA_TUNING.movingScaleRatio ||
      Math.abs(current.perspectiveX - prior.perspectiveX) > CAMERA_TUNING.movingPerspective ||
      Math.abs(current.perspectiveY - prior.perspectiveY) > CAMERA_TUNING.movingPerspective;
  }

  private similarGeometry(current: FocusGeometry, baseline: FocusGeometry): boolean {
    return Math.hypot(current.x - baseline.x, current.y - baseline.y) < CAMERA_TUNING.displacementRatio * 0.65 &&
      Math.abs(Math.log(Math.max(0.0001, current.scale) / Math.max(0.0001, baseline.scale))) < CAMERA_TUNING.scaleChangeRatio * 0.65 &&
      Math.abs(current.perspectiveX - baseline.perspectiveX) < CAMERA_TUNING.perspectiveChange * 0.65 &&
      Math.abs(current.perspectiveY - baseline.perspectiveY) < CAMERA_TUNING.perspectiveChange * 0.65;
  }

  private blendGeometry(a: FocusGeometry, b: FocusGeometry): FocusGeometry {
    return { x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25,
      scale: a.scale * 0.75 + b.scale * 0.25,
      perspectiveX: a.perspectiveX * 0.75 + b.perspectiveX * 0.25,
      perspectiveY: a.perspectiveY * 0.75 + b.perspectiveY * 0.25,
      quality: a.quality * 0.75 + b.quality * 0.25 };
  }
}
