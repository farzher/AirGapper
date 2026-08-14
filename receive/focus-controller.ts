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
  lockCooldownMs: 4000,
  focusSaturation: 0.9,
  focusExcellent: 0.78,
  meaningfulFocusImprovement: 0.035,
  maxFocusProbes: 5,
  maxFocusCalibrationMs: 1300,
  maxFocusDistanceRatio: 0.12,
  exposureExcellent: 0.7,
  exposureSafetyMargin: 0.06,
  maxExposureProbes: 10,
  maxExposureCalibrationMs: 2800,
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
  transitions: string[];
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
  private recoveryAxis: "all" | "focus" = "all";
  private readonly transitions: string[] = [];
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
    this.knownGood = undefined;
    this.committedFocusDistance = undefined;
    this.committedExposureTime = undefined;
    this.committedIso = undefined;
    this.recoveryAxis = "all";
    this.transition(this.strategy === "auto" ? "SEEKING" : "OVERRIDE", "camera track changed");
    void this.enterHardwareAuto("camera opened", this.generation, true);
  }

  detach(): void {
    this.cancel("camera stopped");
    this.track = undefined;
    this.caps = {};
    this.transition("UNAVAILABLE", "camera stopped");
  }

  setStrategy(strategy: FocusStrategy): void {
    this.cancel("developer focus strategy changed");
    this.strategy = strategy;
    this.transition(strategy === "auto" ? "SEEKING" : "OVERRIDE", "focus ownership changed");
    if (strategy === "auto") void this.enterHardwareAuto("automatic focus selected");
    else void this.applyDeveloperFocus();
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

  refocus(reason = "developer forced calibration"): void {
    this.cancel(reason);
    if (this.strategy !== "auto") {
      void this.applyDeveloperFocus();
      return;
    }
    this.recoveryAxis = "all";
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
  ): void {
    const observation = { id, at: now, geometry, metrics, decodedNow, decodedRecently, totalTiles };
    this.latest = observation;
    this.targetMissingSince = 0;
    this.resolveWaiter(observation);
    if ((this.state === "BASELINE" || this.state === "FOCUS_REFINE" || this.state === "EXPOSURE_REFINE") &&
        this.geometryChanged(geometry, this.stableGeometry)) {
      this.cancel("target moved during calibration");
      this.transition("STABILIZING", "target moved; probe cancelled and committed optics retained");
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

    if (this.state === "LOCKED" || this.state === "TARGET_LOST_GRACE") {
      const majorGeometryChange = this.geometryChanged(geometry, this.stableGeometry);
      this.geometryChanges = majorGeometryChange ? this.geometryChanges + 1 : 0;
      // LOCKED owns no camera mutations. Optical scores and payload misses are
      // diagnostics only: demonstrated settings beat noisy health estimates.
      if (this.geometryChanges >= CAMERA_TUNING.geometrySamplesToReacquire &&
          now - this.lockedAt >= CAMERA_TUNING.lockCooldownMs) {
        void this.reacquireFocus("large sustained geometry change after lock cooldown");
      } else {
        this.transition("LOCKED", decodedNow > 0
          ? "payload flowing; committed optics held"
          : "payload miss or optical fluctuation; committed optics held");
      }
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
    if (this.state === "FOCUS_REFINE" || this.state === "EXPOSURE_REFINE" || this.state === "BASELINE") {
      this.cancel("static QR target disappeared during calibration");
      this.transition("TARGET_LOST_GRACE", "target absent during probe; committed optics restored");
      this.stableGeometry = undefined;
      void this.rollbackCommitted();
    } else if (this.state === "LOCKED") {
      this.transition("TARGET_LOST_GRACE", "target briefly absent; committed camera lock retained");
    }
    if (now - this.targetMissingSince >= CAMERA_TUNING.targetLossGraceMs && this.state === "TARGET_LOST_GRACE") {
      void this.reacquire("target absent beyond grace period", true);
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
    this.transition("BASELINE", this.recoveryAxis === "focus"
      ? "capturing focus baseline with committed exposure frozen"
      : "capturing hardware AF/AE baseline");
    this.focusProbes = 0;
    this.exposureProbes = 0;
    const baseline = this.settings();
    this.baselineFocus = baseline.focusDistance;
    this.baselineExposure = baseline.exposureTime;
    this.baselineIso = baseline.iso;
    this.changed();

    let observation = this.latest ?? initial;
    if (this.manualFocus() && Number.isFinite(this.baselineFocus)) {
      const frozenExposure = this.recoveryAxis === "focus" ? this.committedExposureTime : this.baselineExposure;
      const frozenIso = this.recoveryAxis === "focus" ? this.committedIso : this.baselineIso;
      const frozen = await this.applyProbe(generation, {
        focusMode: "manual", focusDistance: this.baselineFocus,
        ...(this.manualExposure() && Number.isFinite(frozenExposure)
          ? { exposureMode: "manual", exposureTime: frozenExposure, ...(this.caps.iso && Number.isFinite(frozenIso) ? { iso: frozenIso } : {}) }
          : {}),
      });
      if (!frozen) {
        if (this.recoveryAxis === "focus") await this.rollbackCommitted("focus");
        else await this.enterHardwareAuto("initial manual lock rejected; hardware AF/AE retained", generation);
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
      await this.rollbackCommitted("exposure");
      this.lock(observation);
      return;
    }

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
    let bestScore = this.exposureUtility(baseline.metrics);
    const qualityFloor = Math.max(0.54, Math.min(0.76, baseline.metrics.exposureScore - CAMERA_TUNING.exposureSafetyMargin));

    while (this.current(generation) && this.exposureProbes < CAMERA_TUNING.maxExposureProbes &&
        performance.now() - started < CAMERA_TUNING.maxExposureCalibrationMs) {
      let nextIso = currentIso;
      let nextExposure = currentExposure;
      const exposureStep = Math.max(range.step ?? 0, 1e-6);
      if (isoRange && currentIso !== undefined && currentIso > isoRange.min) {
        nextIso = this.quantize(Math.max(isoRange.min, currentIso / 2), isoRange);
      } else if (currentExposure > range.min + exposureStep / 2) {
        nextExposure = this.quantize(Math.max(range.min, currentExposure / 2), range);
      }
      if (nextExposure === currentExposure && nextIso === currentIso) break;
      this.exposureProbes++;
      this.requestedExposure = nextExposure;
      this.requestedIso = nextIso;
      this.candidateExposureTime = nextExposure;
      this.candidateIso = nextIso;
      if (!(await this.applyProbe(generation, {
        exposureMode: "manual", exposureTime: nextExposure,
        ...(nextIso !== undefined ? { iso: nextIso } : {}),
      }))) break;
      const observed = await this.fresh(generation, this.latest?.id ?? baseline.id);
      if (!observed) break;
      const score = this.exposureUtility(observed.metrics);
      const acceptable = this.exposureAcceptable(observed.metrics, qualityFloor);
      this.changed();
      if (!acceptable || score < bestScore - 0.025) break;
      // Android frequently reports the previous camera settings for several
      // frames after accepting a constraint. The accepted candidate is the
      // transaction source of truth; getSettings remains diagnostic only.
      currentExposure = nextExposure;
      currentIso = nextIso;
      best = observed;
      bestScore = score;
      bestExposure = nextExposure;
      bestIso = nextIso;
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
    this.lastReason = best.metrics.whiteLevel <= 242 && best.metrics.blackLevel <= 48
      ? "balanced highlight and shadow levels committed"
      : "best robust brightness committed at camera limit";
    return await this.fresh(generation, this.latest?.id ?? baseline.id) ?? best;
  }

  private exposureUtility(metrics: QrOpticalMetrics): number {
    const brightPenalty = Math.max(0, metrics.whiteLevel - 238) / 45 + Math.max(0, metrics.blackLevel - 42) / 80;
    return metrics.exposureScore - brightPenalty - metrics.clipping * 0.8 - metrics.banding * 0.15;
  }

  private exposureAcceptable(metrics: QrOpticalMetrics, floor: number): boolean {
    return metrics.confidence >= 0.86 && metrics.exposureScore >= floor &&
      metrics.separation >= 55 && metrics.noise <= Math.max(22, metrics.separation * 0.28) &&
      metrics.banding < 0.32;
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
    this.geometryChanges = 0;
    if (this.initialLockMs === undefined) this.initialLockMs = performance.now() - this.attachedAt;
    this.changed();
  }

  private async reacquire(reason: string, fullReset = false): Promise<void> {
    if (this.state === "SEEKING") return;
    this.cancel(reason);
    this.reacquireCount++;
    this.recoveryAxis = "all";
    this.stableGeometry = undefined;
    this.stableSince = 0;
    this.geometryChanges = 0;
    this.targetMissingSince = 0;
    this.poiAimed = false;
    this.transition("SEEKING", reason);
    if (fullReset) await this.enterHardwareAuto(reason, this.generation, true);
  }

  private async reacquireFocus(reason: string): Promise<void> {
    if (this.state !== "LOCKED" && this.state !== "TARGET_LOST_GRACE") return;
    this.cancel(reason);
    this.reacquireCount++;
    this.recoveryAxis = "focus";
    this.geometryChanges = 0;
    this.stableGeometry = this.latest?.geometry;
    this.stableSince = performance.now();
    this.transition("STABILIZING", `${reason}; exposure/ISO remain committed`);
    const track = this.track;
    const mode = this.focusModes().includes("continuous") ? "continuous" : this.focusModes().includes("single-shot") ? "single-shot" : undefined;
    if (track && mode) await this.apply(track, { focusMode: mode });
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
    this.geometryChanges = 0;
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

  private blendGeometry(a: FocusGeometry, b: FocusGeometry): FocusGeometry {
    return { x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25,
      scale: a.scale * 0.75 + b.scale * 0.25,
      perspectiveX: a.perspectiveX * 0.75 + b.perspectiveX * 0.25,
      perspectiveY: a.perspectiveY * 0.75 + b.perspectiveY * 0.25,
      quality: a.quality * 0.75 + b.quality * 0.25 };
  }
}
