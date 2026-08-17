var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
const CAMERA_TUNING = {
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
  seekingAfRetryMs: 850,
  seekingAfSlowRetryMs: 4500,
  seekingAfFastRetries: 3,
  seekingAfGoodFocus: 0.58,
  recoverySamples: 3,
  severeFocusScore: 0.24,
  convincingFocusScore: 0.62,
  severeBlurConfirmMs: 480,
  optimizeMovementConfirmMs: 650,
  optimizeBudgetMs: 7e3,
  optimizeWinRatio: 1.14,
  optimizeLossRatio: 0.88
};
const AUTO_QR_EV_BIAS = -0.7;
const AUTO_QR_EV_COOLDOWN_MS = 3e3;
const AUTO_QR_WHITE_LOW = 145;
const AUTO_QR_WHITE_HIGH = 238;
const AUTO_QR_BLACK_HIGH = 105;
const AUTO_QR_SEPARATION_LOW = 50;
class FocusController {
  constructor(apply, changed, strategy = "auto", manualDistance, calibrationMode = "auto", currentScanId = () => 0) {
    this.apply = apply;
    this.changed = changed;
    this.currentScanId = currentScanId;
    __publicField(this, "track");
    __publicField(this, "caps", {});
    __publicField(this, "state", "UNAVAILABLE");
    __publicField(this, "stateSince", performance.now());
    __publicField(this, "strategy");
    __publicField(this, "calibrationMode");
    __publicField(this, "manualDistance");
    __publicField(this, "generation", 0);
    __publicField(this, "attachedAt", 0);
    __publicField(this, "requestedMode");
    __publicField(this, "latest");
    __publicField(this, "stableGeometry");
    __publicField(this, "stableSince", 0);
    __publicField(this, "targetMissingSince", 0);
    __publicField(this, "initialLockMs");
    __publicField(this, "lastReason", "camera opened");
    __publicField(this, "baselineFocus");
    __publicField(this, "baselineExposure");
    __publicField(this, "baselineIso");
    __publicField(this, "autoExposureCompensation");
    __publicField(this, "lastAutoExposureTrimAt", -Infinity);
    __publicField(this, "autoExposureTrimRunning", false);
    __publicField(this, "autoExposureTrimDirection", 0);
    __publicField(this, "autoExposureTrimConfirmations", 0);
    __publicField(this, "requestedExposure");
    __publicField(this, "requestedIso");
    __publicField(this, "focusProbes", 0);
    __publicField(this, "exposureProbes", 0);
    __publicField(this, "bestKnownGood");
    __publicField(this, "lastWorkingState");
    __publicField(this, "committedFocusMode");
    __publicField(this, "committedFocusDistance");
    __publicField(this, "committedExposureMode");
    __publicField(this, "committedExposureTime");
    __publicField(this, "committedIso");
    __publicField(this, "committedExposureCompensation");
    __publicField(this, "candidateExposureTime");
    __publicField(this, "candidateIso");
    __publicField(this, "lockedAt", 0);
    __publicField(this, "fullResetCount", 0);
    __publicField(this, "focusRefinementCount", 0);
    __publicField(this, "exposureRefinementCount", 0);
    __publicField(this, "lockedFocusFailures", 0);
    __publicField(this, "lockedExposureFailures", 0);
    __publicField(this, "optimizeState", "idle");
    __publicField(this, "optimizeRound");
    __publicField(this, "optimizeVisit");
    __publicField(this, "optimizeSurvivors");
    __publicField(this, "optimizeDecision");
    __publicField(this, "optimizeCandidatePerformance");
    __publicField(this, "optimizeBestPerformance");
    __publicField(this, "optimizeSummary");
    __publicField(this, "optimizeExposureStepEV", 1);
    __publicField(this, "optimizeShutterStepEV", 1);
    __publicField(this, "optimizeComparison");
    __publicField(this, "optimizePairedSamples", 0);
    __publicField(this, "optimizeReason", "idle");
    __publicField(this, "optimizeCandidates", []);
    __publicField(this, "optimizeExposureVisited");
    __publicField(this, "optimizeIsoVisited");
    /** Last QR-validated optimizer winner. Recurring Optimize passes refine only
     * around this anchor; they never silently adopt a brighter HAL/Auto state. */
    __publicField(this, "optimizeLearnedExposure");
    __publicField(this, "optimizeLearnedIso");
    __publicField(this, "decodeBoundary", 0);
    __publicField(this, "cameraGenerationStartedAt", performance.now());
    __publicField(this, "lastValidDecodeAt");
    __publicField(this, "lastUsefulDecodeAt");
    __publicField(this, "lastValidScanId", -1);
    __publicField(this, "validDecodesInGeneration", 0);
    __publicField(this, "decoderCompletionsInGeneration", 0);
    __publicField(this, "validDecodeTimes", []);
    __publicField(this, "completionTimes", []);
    __publicField(this, "optimizeMovementSince", 0);
    __publicField(this, "transitions", []);
    /** Initial AF mode configuration is one-time. While acquisition has no
     *  usable QR evidence, bounded single-shot sweeps may be retriggered; any
     *  fresh decode or convincingly sharp optical target stops those retries. */
    __publicField(this, "automaticFocusConfigured", false);
    __publicField(this, "seekingAfRetries", 0);
    __publicField(this, "seekingAfVerified", 0);
    __publicField(this, "seekingAfUnconfirmed", 0);
    __publicField(this, "singleShotAfRejected", false);
    __publicField(this, "continuousAfNudges", 0);
    __publicField(this, "lastSeekingAfAt", -Infinity);
    __publicField(this, "seekingAfRunning", false);
    __publicField(this, "waiter");
    this.strategy = strategy;
    this.manualDistance = manualDistance;
    this.calibrationMode = calibrationMode;
  }
  get capabilities() {
    return this.caps;
  }
  get selectedStrategy() {
    return this.strategy;
  }
  get expectsProbeFrame() {
    return this.state === "OPTIMIZE_EXPOSURE" || this.state === "OPTIMIZE_VERIFY";
  }
  get opticalIntervalMs() {
    if (this.calibrationMode === "off") return Infinity;
    if (this.strategy !== "auto" || this.state === "OVERRIDE") return CAMERA_TUNING.lockedOpticalIntervalMs;
    if (this.expectsProbeFrame) return 0;
    return this.state === "LOCKED" || this.state === "TARGET_LOST_GRACE" ? CAMERA_TUNING.lockedOpticalIntervalMs : CAMERA_TUNING.seekingOpticalIntervalMs;
  }
  attach(track) {
    var _a, _b;
    this.cancel("camera track changed");
    this.track = track;
    this.caps = (_b = (_a = track.getCapabilities) == null ? void 0 : _a.call(track)) != null ? _b : {};
    const focusRange = this.caps.focusDistance;
    if (!focusRange || !Number.isFinite(focusRange.min) || !Number.isFinite(focusRange.max) || focusRange.min < 0 || focusRange.max < focusRange.min || focusRange.max > 1e3) {
      delete this.caps.focusDistance;
    }
    this.attachedAt = performance.now();
    this.latest = void 0;
    this.stableGeometry = void 0;
    this.stableSince = 0;
    this.targetMissingSince = 0;
    this.automaticFocusConfigured = false;
    this.seekingAfRetries = 0;
    this.seekingAfVerified = 0;
    this.seekingAfUnconfirmed = 0;
    this.singleShotAfRejected = false;
    this.continuousAfNudges = 0;
    this.lastSeekingAfAt = -Infinity;
    this.seekingAfRunning = false;
    this.optimizeMovementSince = 0;
    this.initialLockMs = void 0;
    this.optimizeState = "idle";
    this.optimizeRound = void 0;
    this.optimizeVisit = void 0;
    this.optimizeSurvivors = void 0;
    this.optimizeDecision = void 0;
    this.optimizeCandidatePerformance = void 0;
    this.optimizeBestPerformance = void 0;
    this.optimizeSummary = void 0;
    this.optimizeCandidates = [];
    this.optimizeExposureVisited = void 0;
    this.optimizeIsoVisited = void 0;
    this.optimizeLearnedExposure = void 0;
    this.optimizeLearnedIso = void 0;
    this.optimizeExposureStepEV = 1;
    this.optimizeShutterStepEV = 1;
    this.optimizeComparison = void 0;
    this.optimizePairedSamples = 0;
    this.optimizeReason = "camera changed";
    this.bestKnownGood = void 0;
    this.lastWorkingState = void 0;
    this.beginDecodeGeneration();
    this.committedFocusMode = void 0;
    this.committedFocusDistance = void 0;
    this.committedExposureMode = void 0;
    this.committedExposureTime = void 0;
    this.committedIso = void 0;
    this.committedExposureCompensation = void 0;
    this.autoExposureCompensation = void 0;
    this.lastAutoExposureTrimAt = -Infinity;
    this.autoExposureTrimRunning = false;
    this.autoExposureTrimDirection = 0;
    this.autoExposureTrimConfirmations = 0;
    if (this.strategy === "auto") {
      this.transition("SEEKING", "camera track changed; hardware AF acquisition retries armed until QR decode");
      void this.configureInitialHardwareFocusOnce().then(() => this.enterAutomaticExposureState("camera opened", this.generation, false));
    } else {
      this.transition("OVERRIDE", "camera track changed; developer owns focus");
      void this.applyDeveloperFocus();
    }
  }
  detach() {
    this.cancel("camera stopped");
    this.track = void 0;
    this.caps = {};
    this.transition("UNAVAILABLE", "camera stopped");
  }
  setStrategy(strategy) {
    const optimizing = this.isOptimizing();
    this.cancel("focus ownership changed");
    this.strategy = strategy;
    if (optimizing) this.optimizeState = "cancelled";
    if (strategy === "auto") {
      this.optimizeState = "idle";
      this.optimizeBestPerformance = void 0;
      this.optimizeSummary = void 0;
      this.optimizeCandidates = [];
      this.candidateExposureTime = void 0;
      this.candidateIso = void 0;
      this.transition("SEEKING", "automatic focus selected; hardware AF retries; exposure retained");
      this.automaticFocusConfigured = false;
      void this.configureInitialHardwareFocusOnce().then(() => this.enterAutomaticExposureState("automatic focus selected", this.generation, false));
    } else {
      this.optimizeState = "idle";
      this.optimizeBestPerformance = void 0;
      this.optimizeSummary = void 0;
      this.transition("OVERRIDE", "developer owns focus");
      const start = () => this.applyDeveloperFocus();
      if (optimizing) void this.restoreOptimizationBest("exposure").then(start);
      else void start();
    }
  }
  setCalibrationMode(mode) {
    this.cancel("calibration mode changed");
    this.calibrationMode = mode;
    if (this.strategy === "auto") {
      this.transition("SEEKING", "calibration mode changed; focus retained");
      void this.enterAutomaticExposureState("calibration mode changed", this.generation, false);
    } else this.transition("OVERRIDE", "calibration mode changed");
  }
  setManualDistance(distance) {
    const range = this.caps.focusDistance;
    if (!range || !Number.isFinite(distance)) return;
    this.manualDistance = this.quantize(distance, range);
    this.cancel("developer changed focus distance");
    if (this.strategy === "manual") void this.applyDeveloperFocus();
    this.changed();
  }
  developerOverride(reason) {
    this.cancel(reason);
    if (this.strategy === "auto") this.transition("OVERRIDE", reason);
    else {
      this.lastReason = reason;
      this.changed();
    }
  }
  cancelOptimize(reason = "optimization stopped") {
    if (!this.isOptimizing()) return;
    this.cancel(reason);
    this.optimizeState = "paused";
    this.optimizeReason = `${reason}; original settings restored`;
    void this.restoreOptimizationBest("exposure").then(() => this.transition("LOCKED", this.optimizeReason));
  }
  optimizeEligible() {
    const retryHasTarget = this.optimizeState !== "paused" || Boolean(this.latest && !this.targetMissingSince);
    return !this.isOptimizing() && retryHasTarget && Boolean(
      this.track && this.track.readyState === "live" && this.manualExposure() && this.caps.iso
    );
  }
  async optimize(measureOptics, measureDecode, epochs) {
    var _a, _b, _c, _d, _e;
    if (!this.optimizeEligible()) return;
    const generation = ++this.generation;
    const startedAt = performance.now();
    const deadline = startedAt + CAMERA_TUNING.optimizeBudgetMs;
    this.optimizeState = "baseline";
    this.optimizeRound = "baseline";
    this.optimizeCandidates = [];
    this.optimizeExposureVisited = void 0;
    this.optimizeIsoVisited = void 0;
    this.optimizeDecision = "measuring Auto baseline";
    this.optimizeComparison = void 0;
    this.optimizePairedSamples = 0;
    const initialObservation = this.latest;
    if (initialObservation) {
      this.stableGeometry = initialObservation.geometry;
      this.stableSince = performance.now();
    }
    const origin = this.settings();
    const hardwareExposureRange = this.caps.exposureTime;
    const isoRange = this.caps.iso;
    if (!this.manualExposure() || !hardwareExposureRange || !isoRange || origin.exposureTime === void 0 || origin.iso === void 0 || hardwareExposureRange.min <= 0 || isoRange.min <= 0) {
      this.optimizeState = "paused";
      this.optimizeReason = "manual exposure and ISO controls unavailable";
      return;
    }
    const observedFps = Math.max(12, Math.min(120, ((_a = this.latest) == null ? void 0 : _a.captureFps) || 30));
    const frameSafeMax = 8e3 / observedFps;
    const exposureRange = {
      ...hardwareExposureRange,
      max: Math.max(hardwareExposureRange.min, Math.min(hardwareExposureRange.max, frameSafeMax))
    };
    const refinementPass = this.optimizeLearnedExposure !== void 0 && this.optimizeLearnedIso !== void 0;
    const autoExposure = this.quantize(refinementPass ? this.optimizeLearnedExposure : origin.exposureTime, exposureRange);
    const autoIso = this.quantize(refinementPass ? this.optimizeLearnedIso : origin.iso, isoRange);
    const searchIsoRange = refinementPass ? {
      ...isoRange,
      min: this.quantize(Math.max(isoRange.min, autoIso * 0.88), isoRange),
      max: this.quantize(Math.min(isoRange.max, autoIso * 1.15), isoRange)
    } : isoRange;
    if (!refinementPass) this.commitSettings(origin);
    this.optimizeState = "exposure";
    this.transition("OPTIMIZE_EXPOSURE", "pixel-quality exposure search; focus untouched");
    const median = (values) => {
      if (!values.length) return 0;
      const sorted = [...values].sort((a, b) => a - b);
      const middle = sorted.length >> 1;
      return sorted.length & 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    };
    const medianMetric = (samples) => {
      const metrics = samples.map((sample) => sample.metrics);
      const value = (read) => median(metrics.map(read));
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
    };
    const aggregateDecode = (windows) => {
      const measurementMs = windows.reduce((sum, window) => sum + window.measurementMs, 0);
      const submittedJobs = windows.reduce((sum, window) => sum + window.submittedJobs, 0);
      const completedJobs = windows.reduce((sum, window) => sum + window.completedJobs, 0);
      const sourceFrames = windows.reduce((sum, window) => sum + window.sourceFrames, 0);
      const successfulSourceFrames = windows.reduce((sum, window) => sum + window.successfulSourceFrames, 0);
      const qrAttempts = windows.reduce((sum, window) => sum + window.qrAttempts, 0);
      const validDecodes = windows.reduce((sum, window) => sum + window.validDecodes, 0);
      const usefulSymbols = windows.reduce(
        (sum, window) => sum + window.usefulSymbolsPerSecond * window.measurementMs / 1e3,
        0
      );
      return {
        validDecodesPerSecond: measurementMs > 0 ? validDecodes / (measurementMs / 1e3) : 0,
        usefulSymbolsPerSecond: measurementMs > 0 ? usefulSymbols / (measurementMs / 1e3) : 0,
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
        temporalContamination: median(windows.map((window) => {
          var _a2;
          return (_a2 = window.temporalContamination) != null ? _a2 : 0;
        }))
      };
    };
    const candidates = /* @__PURE__ */ new Map();
    let nextId = 1;
    const make = (exposure, iso) => {
      exposure = this.quantize(exposure, exposureRange);
      iso = this.quantize(iso, isoRange);
      const key = `${exposure}|${iso}`;
      const existing = candidates.get(key);
      if (existing) return existing;
      const candidate = {
        id: `C${nextId++}`,
        requestedExposure: exposure,
        requestedIso: iso,
        exposure,
        iso,
        key,
        optics: [],
        decode: [],
        state: "queued",
        coarseGrid: false
      };
      candidates.set(key, candidate);
      return candidate;
    };
    const opticsOf = (candidate) => {
      if (!candidate.optics.length) return void 0;
      const targeted = candidate.optics.filter((sample) => sample.targeted);
      return medianMetric(targeted.length ? targeted : candidate.optics.filter((sample) => !sample.targeted));
    };
    const decodeOf = (candidate) => aggregateDecode(candidate.decode);
    const targetedOf = (candidate) => candidate.optics.some((sample) => sample.targeted);
    let targetedThresholds;
    let globalThresholds;
    let provenBaseline;
    let baselineCandidate;
    const thresholdsFrom = (baseline, targeted) => {
      const noiseRatio = baseline.noise / Math.max(1, baseline.separation);
      return targeted ? {
        separation: Math.max(40, Math.min(64, baseline.separation * 0.58)),
        confidence: Math.max(0.76, Math.min(0.9, baseline.confidence * 0.9)),
        noiseRatio: Math.max(0.26, Math.min(0.48, noiseRatio * 1.65 + 0.03)),
        clipping: Math.max(0.42, Math.min(0.7, baseline.clipping + 0.22)),
        banding: Math.max(0.34, Math.min(0.52, baseline.banding + 0.16))
      } : {
        separation: Math.max(30, Math.min(54, baseline.separation * 0.5)),
        confidence: Math.max(0.52, Math.min(0.78, baseline.confidence * 0.82)),
        noiseRatio: Math.max(0.38, Math.min(0.68, noiseRatio * 1.8 + 0.08)),
        clipping: 0.82,
        banding: 0.75
      };
    };
    const thresholdFor = (candidate) => targetedOf(candidate) ? targetedThresholds : globalThresholds;
    const quality = (candidate) => {
      const metric = opticsOf(candidate);
      const threshold = thresholdFor(candidate);
      if (!metric || !threshold) return { good: false, comfortable: false, margin: -Infinity, needsGain: true };
      const targeted = targetedOf(candidate);
      const provenNoiseRatio = provenBaseline ? provenBaseline.noise / Math.max(1, provenBaseline.separation) : void 0;
      const separationFloor = targeted ? provenBaseline ? Math.max(18, Math.min(threshold.separation, provenBaseline.separation * 0.68)) : Math.max(48, threshold.separation) : threshold.separation;
      const confidenceFloor = targeted ? provenBaseline ? Math.max(0.64, Math.min(threshold.confidence, provenBaseline.confidence * 0.88)) : Math.max(0.82, threshold.confidence) : threshold.confidence;
      const noiseRatio = targeted ? provenBaseline && provenNoiseRatio !== void 0 ? Math.min(0.58, Math.max(threshold.noiseRatio, provenNoiseRatio * 1.45 + 0.03)) : Math.min(0.36, threshold.noiseRatio) : threshold.noiseRatio;
      const clippingCeiling = targeted ? provenBaseline ? Math.min(0.78, Math.max(threshold.clipping, provenBaseline.clipping + 0.18)) : Math.min(0.58, threshold.clipping) : threshold.clipping;
      const bandingCeiling = targeted ? provenBaseline ? Math.min(0.72, Math.max(threshold.banding, provenBaseline.banding + 0.16)) : Math.min(0.38, threshold.banding) : threshold.banding;
      const noiseLimit = Math.max(14, metric.separation * noiseRatio);
      const margins = [
        (metric.separation - separationFloor) / Math.max(1, separationFloor),
        (metric.confidence - confidenceFloor) / Math.max(0.1, 1 - confidenceFloor),
        (noiseLimit - metric.noise) / Math.max(1, noiseLimit),
        (clippingCeiling - metric.clipping) / Math.max(0.1, clippingCeiling),
        (bandingCeiling - metric.banding) / Math.max(0.1, bandingCeiling)
      ];
      let margin = Math.min(...margins);
      const needsGain = metric.separation < threshold.separation || metric.confidence < threshold.confidence;
      if (candidate === baselineCandidate && provenBaseline) margin = Math.max(0, margin);
      return { good: margin >= 0, comfortable: margin >= 0.07, margin, needsGain: candidate === baselineCandidate && provenBaseline ? false : needsGain };
    };
    const refresh = () => {
      const evaluated = [...candidates.values()].filter((candidate) => candidate.optics.length || candidate.decode.length);
      this.optimizeCandidates = evaluated.map((candidate) => {
        var _a2, _b2, _c2, _d2, _e2, _f;
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
          temporalContamination: (_a2 = metric == null ? void 0 : metric.temporalContamination) != null ? _a2 : 0,
          state: candidate.state,
          coarseGrid: candidate.coarseGrid,
          opticalTargeted: targetedOf(candidate),
          opticalGood: targetedOf(candidate) && q.good,
          opticalMargin: Number.isFinite(q.margin) ? q.margin : -1,
          opticalSeparation: (_b2 = metric == null ? void 0 : metric.separation) != null ? _b2 : 0,
          opticalNoise: (_c2 = metric == null ? void 0 : metric.noise) != null ? _c2 : 0,
          opticalClipping: (_d2 = metric == null ? void 0 : metric.clipping) != null ? _d2 : 0,
          opticalBanding: (_e2 = metric == null ? void 0 : metric.banding) != null ? _e2 : 0,
          opticalConfidence: (_f = metric == null ? void 0 : metric.confidence) != null ? _f : 0
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
    const activateExposureCandidate = async (requested, allowPastDeadline = false) => {
      if (!this.current(generation) || !allowPastDeadline && performance.now() >= deadline) return void 0;
      this.candidateExposureTime = requested.requestedExposure;
      this.candidateIso = requested.requestedIso;
      this.requestedExposure = requested.requestedExposure;
      this.requestedIso = requested.requestedIso;
      const before = this.settings();
      epochs.transition({
        candidateId: requested.id,
        requestedExposure: requested.requestedExposure,
        requestedIso: requested.requestedIso
      });
      const patch = {
        exposureMode: "manual",
        exposureTime: requested.requestedExposure,
        iso: requested.requestedIso
      };
      await this.applyProbe(generation, patch, false);
      const requestedChange = before.exposureTime !== requested.requestedExposure || before.iso !== requested.requestedIso;
      const readApplied = async (maxMs) => {
        const started = performance.now();
        let observed = this.settings();
        while (this.current(generation) && performance.now() - started < maxMs) {
          if (observed.exposureTime !== void 0 && observed.iso !== void 0 && (!requestedChange || observed.exposureTime !== before.exposureTime || observed.iso !== before.iso)) return observed;
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
      if (actual.exposureTime === void 0 || actual.iso === void 0) {
        this.optimizeReason = "camera never reported usable manual exposure/ISO settings";
        return void 0;
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
      candidate.coarseGrid || (candidate.coarseGrid = requested.coarseGrid);
      const epoch = await epochs.open({
        candidateId: candidate.id,
        requestedExposure: requested.requestedExposure,
        requestedIso: requested.requestedIso,
        actualExposure: actual.exposureTime,
        actualIso: actual.iso
      });
      if (epoch === void 0) {
        this.optimizeReason = "camera produced no settled source frames for optimizer epoch";
        return void 0;
      }
      return !this.current(generation) ? void 0 : { candidate, epoch };
    };
    const measureCandidate = async (requested, label, round, allowPastDeadline = false) => {
      this.optimizeRound = round;
      const active = await activateExposureCandidate(requested, allowPastDeadline);
      if (!active) return void 0;
      const { candidate, epoch } = active;
      candidate.state = "measuring optics";
      this.optimizeVisit = String(candidate.optics.length + 1);
      let sample;
      try {
        sample = await measureOptics(label, epoch);
      } catch (error) {
        this.optimizeReason = error instanceof Error ? error.message : "optical optimizer measurement failed";
      } finally {
        epochs.close(epoch);
      }
      if (!sample || !this.current(generation)) return void 0;
      candidate.optics.push(sample);
      candidate.state = "measured";
      if (sample.targeted && !targetedThresholds) targetedThresholds = thresholdsFrom(sample.metrics, true);
      if (!sample.targeted && !globalThresholds) globalThresholds = thresholdsFrom(sample.metrics, false);
      refresh();
      return candidate;
    };
    const tuneIsoForExposure = async (exposure, seedIso, label) => {
      const tested = /* @__PURE__ */ new Set();
      let best;
      const remember = (candidate) => {
        var _a2;
        const qb = best ? quality(best) : void 0;
        const qc = quality(candidate);
        if (!best || qc.margin > ((_a2 = qb == null ? void 0 : qb.margin) != null ? _a2 : -Infinity)) best = candidate;
      };
      const test = async (iso, suffix) => {
        if (performance.now() >= deadline - 900) return void 0;
        const candidate = make(exposure, this.quantize(iso, searchIsoRange));
        if (tested.has(candidate.key)) return candidate.optics.length ? candidate : void 0;
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
        if (!targetedOf(seed)) return { good: seed, best };
        let highGood = seed;
        let lowBadIso = searchIsoRange.min;
        for (let refine = 0; refine < 2 && highGood.iso > searchIsoRange.min * 1.04; refine++) {
          const probeIso = this.quantize(Math.sqrt(Math.max(searchIsoRange.min, lowBadIso) * highGood.iso), searchIsoRange);
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
      if (!q.needsGain) return { best };
      const maxIso = this.quantize(searchIsoRange.max, isoRange);
      const midIso = this.quantize(Math.sqrt(Math.max(seed.iso, searchIsoRange.min) * maxIso), isoRange);
      const upward = [midIso, maxIso].filter((iso, index, all) => iso > seed.iso && all.indexOf(iso) === index);
      let lastBad = seed;
      for (const iso of upward) {
        const higher = await test(iso, iso === maxIso ? "max gain" : "more gain");
        if (!higher) continue;
        const higherQ = quality(higher);
        if (higherQ.good) {
          if (!targetedOf(higher)) return { good: higher, best };
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
    let winnerDecode;
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
      const baselineMetric = opticsOf(baseline);
      if (targetedOf(baseline)) targetedThresholds != null ? targetedThresholds : targetedThresholds = thresholdsFrom(baselineMetric, true);
      else globalThresholds != null ? globalThresholds : globalThresholds = thresholdsFrom(baselineMetric, false);
      const hadFreshLiveDecode = targetedOf(baseline) && this.lastValidDecodeAt !== void 0 && startedAt - this.lastValidDecodeAt < 1200;
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
      let lastGood = provenBaseline || quality(baseline).good ? baseline : void 0;
      let firstBadExposure;
      let seedIso = baseline.iso;
      const ratios = refinementPass ? [0.96, 0.92] : [0.85, 0.72, 0.6];
      for (let index = 0; index < ratios.length && performance.now() < deadline - 1500; index++) {
        const exposure = this.quantize(Math.max(exposureRange.min, autoExposure * ratios[index]), exposureRange);
        if (exposure >= autoExposure || lastGood && exposure >= lastGood.exposure) continue;
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
        break;
      }
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
      let passing = measured.filter((candidate) => targetedOf(candidate) && (quality(candidate).good || candidate === baseline && Boolean(provenBaseline))).sort((a, b) => a.exposure - b.exposure || a.iso - b.iso);
      if (!passing.length && performance.now() < deadline + 400) {
        const bootstrap = [...measured].sort((a, b) => quality(b).margin - quality(a).margin || b.exposure - a.exposure).slice(0, 3);
        for (const candidate of bootstrap) {
          const certified = await measureCandidate(candidate, "QR certify", "verify", true);
          if (certified && targetedOf(certified) && quality(certified).good) break;
        }
        passing = [...candidates.values()].filter((candidate) => targetedOf(candidate) && (quality(candidate).good || candidate === baseline && Boolean(provenBaseline))).sort((a, b) => a.exposure - b.exposure || a.iso - b.iso);
      }
      if (!passing.length) {
        await this.restoreOptimizationBest("exposure");
        this.optimizeState = "paused";
        this.optimizeReason = "current QR-validated setting remains best";
        refresh();
        return;
      }
      const comfortable = passing.filter((candidate) => quality(candidate).comfortable);
      let opticalWinner = (_b = comfortable[0]) != null ? _b : passing[0];
      opticalWinner.state = "QR optical winner";
      const safer = [...passing].filter((candidate) => candidate !== opticalWinner && candidate.exposure >= opticalWinner.exposure).sort((a, b) => a.exposure - b.exposure || a.iso - b.iso)[0];
      this.optimizeDecision = safer ? "brief QR/s sanity A/B" : "brief QR/s sanity";
      refresh();
      const finalists = [opticalWinner, safer].filter((candidate, index, all) => Boolean(candidate) && all.indexOf(candidate) === index);
      for (let index = finalists.length - 1; index >= 0 && performance.now() < deadline + 1e3; index--) {
        const candidate = finalists[index];
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
        const saferClearlyWins = saferP.validDecodes >= 2 && (winnerP.validDecodes === 0 || saferP.validDecodesPerSecond > winnerP.validDecodesPerSecond * 1.18);
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
      let finalOptics;
      let finalDecode;
      try {
        finalOptics = await measureOptics("Commit optics", restored.epoch);
        if (finalOptics) opticalWinner.optics.push(finalOptics);
        const sample = await measureDecode("commit · hold", restored.epoch);
        finalDecode = await sample.result;
      } catch {
        finalOptics = void 0;
        finalDecode = void 0;
      } finally {
        epochs.close(restored.epoch);
      }
      const commitGood = Boolean((finalOptics == null ? void 0 : finalOptics.targeted) && quality(opticalWinner).good && finalDecode && finalDecode.validDecodes > 0);
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
            } finally {
              epochs.close(restored.epoch);
            }
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
      this.optimizeLearnedExposure = (_c = this.committedExposureTime) != null ? _c : opticalWinner.exposure;
      this.optimizeLearnedIso = (_d = this.committedIso) != null ? _d : opticalWinner.iso;
      winnerDecode = finalDecode != null ? finalDecode : decodeOf(opticalWinner);
      this.optimizeBestPerformance = winnerDecode;
      this.optimizeCandidatePerformance = winnerDecode;
      const winnerOptics = opticsOf(opticalWinner);
      const finalObservation = ((_e = this.latest) == null ? void 0 : _e.at) && this.latest.at >= startedAt ? this.latest : initialObservation;
      this.optimizeState = "complete";
      this.optimizeRound = void 0;
      this.optimizeVisit = void 0;
      this.optimizeSurvivors = void 0;
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
  startOptimizer(measureOptics, measureDecode, epochs) {
    return this.optimize(measureOptics, measureDecode, epochs);
  }
  pauseOptimizer(reason = "optimizer paused") {
    if (!this.isOptimizing()) return;
    this.cancel(reason);
    this.optimizeState = "paused";
    this.optimizeReason = reason;
  }
  noteDecoderCompletion(scanId, now = performance.now()) {
    if (scanId < this.decodeBoundary) return;
    this.decoderCompletionsInGeneration++;
    this.completionTimes.push(now);
    while (this.completionTimes.length && this.completionTimes[0] < now - 8e3) this.completionTimes.shift();
  }
  noteValidDecode(scanId, now = performance.now()) {
    if (scanId === void 0 || scanId < this.decodeBoundary) return;
    this.lastValidDecodeAt = now;
    if (scanId !== this.lastValidScanId) {
      this.lastValidScanId = scanId;
      this.validDecodesInGeneration++;
      this.validDecodeTimes.push(now);
      while (this.validDecodeTimes.length && this.validDecodeTimes[0] < now - 1e4) this.validDecodeTimes.shift();
    }
  }
  noteUsefulDecode(scanId, now = performance.now()) {
    if (scanId !== void 0 && scanId >= this.decodeBoundary) this.lastUsefulDecodeAt = now;
  }
  adoptAutomaticCameraState(reason) {
    this.commitSettings(this.settings());
    this.beginDecodeGeneration();
    this.lastReason = reason;
    this.changed();
  }
  observe(id, geometry, metrics, totalTiles = 1, now = performance.now(), captureFps = 0) {
    var _a, _b;
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
          focusMode: settings.focusMode,
          focusDistance: settings.focusDistance,
          exposureTime: settings.exposureTime,
          iso: settings.iso,
          optical: metrics,
          geometry
        };
        const convincing = metrics.confidence >= 0.86 && metrics.focusScore >= CAMERA_TUNING.convincingFocusScore && this.exposureAcceptable(metrics, 0.45) && this.validDecodesInGeneration >= 3;
        const priorQuality = this.bestKnownGood ? this.bestKnownGood.optical.focusScore + this.bestKnownGood.optical.exposureScore : -Infinity;
        if (convincing && (!this.bestKnownGood || metrics.focusScore + metrics.exposureScore >= priorQuality - 0.04)) {
          this.bestKnownGood = this.lastWorkingState;
        }
      }
      const reference = this.bestKnownGood;
      const optimizedHold = this.optimizeState === "complete";
      const moved = this.geometryChanged(geometry, reference == null ? void 0 : reference.geometry);
      const silence = this.decodeSilence(now);
      const silenceThreshold = this.silenceThreshold();
      const noProgress = silence >= silenceThreshold;
      const moderateFocusBad = Boolean(reference && moved && metrics.confidence >= 0.82 && metrics.focusScore < Math.max(0.35, reference.optical.focusScore - 0.14));
      const severeFocusBad = metrics.confidence >= 0.78 && metrics.focusScore <= Math.min(
        CAMERA_TUNING.severeFocusScore,
        ((_a = reference == null ? void 0 : reference.optical.focusScore) != null ? _a : 0.55) - 0.25
      );
      const decoderActive = this.decoderCompletionsInGeneration >= 2 && this.pipelineIsActive(now);
      const severeBlurDelay = Math.max(
        CAMERA_TUNING.severeBlurConfirmMs,
        Math.min(900, ((_b = this.medianInterval(this.completionTimes)) != null ? _b : 180) * 2.5)
      );
      const severeConfirmed = severeFocusBad && decoderActive && silence >= severeBlurDelay;
      const focusBad = moderateFocusBad && noProgress || severeConfirmed;
      const exposureBad = Boolean(reference && !focusBad && noProgress && decoderActive && metrics.focusScore >= 0.55 && !this.exposureAcceptable(metrics, Math.max(0.38, reference.optical.exposureScore - 0.22)));
      this.lockedFocusFailures = focusBad ? this.lockedFocusFailures + 1 : 0;
      this.lockedExposureFailures = exposureBad ? this.lockedExposureFailures + 1 : 0;
      const requiredFocusSamples = severeConfirmed ? 2 : CAMERA_TUNING.recoverySamples;
      if (this.lockedFocusFailures >= requiredFocusSamples) {
        this.lockedFocusFailures = 0;
        this.stableGeometry = geometry;
        this.stableSince = now;
        this.transition("STABILIZING", "sustained decoder-backed blur; hardware AF recovery requested");
        void this.maybeRetrySeekingAutofocus(now, metrics, true);
        return;
      } else if (!optimizedHold && this.lockedExposureFailures >= CAMERA_TUNING.recoverySamples) {
        this.lockedExposureFailures = 0;
        this.lastReason = "decoder exposure quality dipped; hardware AE retained";
      } else {
        this.lastReason = decodeFresh ? "real decoder progress; camera held" : metrics.focusScore >= CAMERA_TUNING.focusExcellent && metrics.exposureScore >= CAMERA_TUNING.exposureExcellent ? "decoder silent with excellent static optics; camera held" : "decoder silence below recovery threshold";
      }
      void this.maybeTrimAutomaticExposure(metrics, now);
      this.changed();
      return;
    }
    if (!this.isAcquiring()) return;
    void this.maybeRetrySeekingAutofocus(now, metrics);
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
        this.lastReason = metrics.focusScore < 0.38 ? "image appears soft; hardware focus left untouched" : "waiting for a decodable exposure; focus untouched";
      }
    }
    this.changed();
  }
  noteTargetAbsent(now = performance.now()) {
    if (this.strategy !== "auto" || this.state === "UNAVAILABLE" || this.state === "OVERRIDE") return;
    if (!this.targetMissingSince) this.targetMissingSince = now;
    if (this.isOptimizing()) {
      this.lastReason = "QR absent; explicit exposure tournament continues";
      this.changed();
      return;
    } else if (this.state === "LOCKED") {
      this.transition("TARGET_LOST_GRACE", "static target missing; continuous AF and exposure retained");
    } else if ((this.state === "STABILIZING" || this.state === "TARGET_LOST_GRACE") && now - this.targetMissingSince >= CAMERA_TUNING.targetLostGraceMs) {
      this.stableGeometry = void 0;
      this.stableSince = 0;
      this.transition("SEEKING", "target absent; camera state retained while decoding continues");
    }
    if (this.isAcquiring()) void this.maybeRetrySeekingAutofocus(now);
    this.changed();
  }
  diagnostics() {
    var _a, _b, _c;
    const settings = this.settings();
    const optical = (_a = this.latest) == null ? void 0 : _a.metrics;
    const invariantWarning = void 0;
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
      poiSupported: this.pointsOfInterestSupported(),
      hardwareFocusModes: [...this.focusModes()],
      actualPointsOfInterest: settings.pointsOfInterest,
      exposureRange: this.manualExposure() ? this.caps.exposureTime : void 0,
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
      seekingAfRetries: this.seekingAfRetries,
      seekingAfVerified: this.seekingAfVerified,
      seekingAfUnconfirmed: this.seekingAfUnconfirmed,
      singleShotAfRejected: this.singleShotAfRejected,
      continuousAfNudges: this.continuousAfNudges,
      exposureProbes: this.exposureProbes,
      optical,
      targetDetected: Boolean(this.latest && !this.targetMissingSince),
      geometryStable: Boolean(this.stableSince && performance.now() - this.stableSince >= CAMERA_TUNING.geometryStabilityMs),
      totalTiles: (_c = (_b = this.latest) == null ? void 0 : _b.totalTiles) != null ? _c : 0,
      lastValidDecodeAt: this.lastValidDecodeAt,
      lastUsefulDecodeAt: this.lastUsefulDecodeAt,
      validDecodesInGeneration: this.validDecodesInGeneration,
      decoderCompletionsInGeneration: this.decoderCompletionsInGeneration,
      decodeSilenceMs: this.decodeSilence(performance.now()),
      recentInterdecodeMs: this.medianInterval(this.validDecodeTimes),
      recentCompletionMs: this.medianInterval(this.completionTimes),
      likelyTemporalFailure: Boolean(this.latest && !this.decodeIsFresh(performance.now()) && optical && optical.focusScore >= CAMERA_TUNING.focusExcellent && optical.exposureScore >= CAMERA_TUNING.exposureExcellent),
      knownGood: Boolean(this.bestKnownGood),
      knownGoodSettings: this.bestKnownGood && {
        focusMode: this.bestKnownGood.focusMode,
        focusDistance: this.bestKnownGood.focusDistance,
        exposureTime: this.bestKnownGood.exposureTime,
        iso: this.bestKnownGood.iso
      },
      committedFocusMode: this.committedFocusMode,
      committedFocusDistance: this.committedFocusDistance,
      committedExposureMode: this.committedExposureMode,
      committedExposureTime: this.committedExposureTime,
      committedIso: this.committedIso,
      candidateExposureTime: this.candidateExposureTime,
      candidateIso: this.candidateIso,
      lockedMs: this.state === "LOCKED" ? performance.now() - this.lockedAt : void 0,
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
      lastReason: this.lastReason
    };
  }
  exposureAcceptable(metrics, floor) {
    return metrics.confidence >= 0.86 && metrics.exposureScore >= floor && metrics.separation >= 48 && metrics.noise <= Math.max(20, metrics.separation * 0.25) && metrics.clipping < 0.55 && metrics.banding < 0.32;
  }
  lock(observation, reason) {
    this.commitSettings(this.settings());
    this.lastWorkingState = {
      focusMode: this.committedFocusMode,
      focusDistance: this.committedFocusDistance,
      exposureTime: this.committedExposureTime,
      iso: this.committedIso,
      optical: observation.metrics,
      geometry: observation.geometry
    };
    if (observation.metrics.focusScore >= CAMERA_TUNING.convincingFocusScore && this.exposureAcceptable(observation.metrics, 0.45) && this.validDecodesInGeneration >= 1) {
      this.bestKnownGood = this.lastWorkingState;
    }
    this.candidateExposureTime = void 0;
    this.candidateIso = void 0;
    this.lockedAt = performance.now();
    this.transition("LOCKED", reason);
    this.stableGeometry = observation.geometry;
    this.stableSince = observation.at;
    if (this.initialLockMs === void 0) this.initialLockMs = performance.now() - this.attachedAt;
    this.changed();
  }
  async maybeTrimAutomaticExposure(metrics, now) {
    var _a, _b, _c;
    if (this.autoExposureTrimRunning || this.isOptimizing() || this.strategy !== "auto" || this.state !== "LOCKED" || !this.track || this.track.readyState !== "live") return;
    const range = this.caps.exposureCompensation;
    if (!range || range.min > 0 || range.max < 0 || metrics.confidence < 0.82 || metrics.focusScore < 0.42 || metrics.banding > 0.45) return;
    const settings = this.settings();
    if (settings.exposureMode === "manual") return;
    const tooBright = metrics.whiteLevel > AUTO_QR_WHITE_HIGH || metrics.blackLevel > AUTO_QR_BLACK_HIGH && metrics.separation >= AUTO_QR_SEPARATION_LOW;
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
    const current = this.quantize(Math.min(0, (_b = (_a = settings.exposureCompensation) != null ? _a : this.autoExposureCompensation) != null ? _b : AUTO_QR_EV_BIAS), range);
    const step = Math.max((_c = range.step) != null ? _c : 0, 0.25);
    const next = direction < 0 ? this.quantize(Math.max(range.min, current - step), range) : this.quantize(Math.min(0, current + step), range);
    if (Math.abs(next - current) < 1e-6) return;
    this.autoExposureTrimRunning = true;
    this.lastAutoExposureTrimAt = now;
    this.autoExposureTrimConfirmations = 0;
    try {
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
  async enterAutomaticExposureState(reason, generation = this.generation, resetExposure = false, restoreExposure = false) {
    const track = this.track;
    if (!track || track.readyState !== "live" || !this.current(generation)) return;
    const patch = {};
    if (resetExposure && this.exposureModes().includes("continuous")) {
      patch.exposureMode = "continuous";
      if (this.caps.exposureCompensation && this.caps.exposureCompensation.min <= 0 && this.caps.exposureCompensation.max >= 0) {
        const neutralBias = this.quantize(Math.max(this.caps.exposureCompensation.min, AUTO_QR_EV_BIAS), this.caps.exposureCompensation);
        patch.exposureCompensation = Math.min(0, neutralBias);
        this.autoExposureCompensation = patch.exposureCompensation;
      }
    } else if (restoreExposure && this.settings().exposureMode === "manual" && this.manualExposure() && this.committedExposureTime !== void 0) {
      patch.exposureMode = "manual";
      patch.exposureTime = this.committedExposureTime;
      if (this.committedIso !== void 0) patch.iso = this.committedIso;
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
  async restoreOptimizationBest(axis = "all") {
    const track = this.track;
    if (!track) return;
    const patch = {};
    if (axis === "focus" || axis === "all") {
      const mode = this.committedFocusMode;
      if (mode === "manual" && this.committedFocusDistance !== void 0) {
        patch.focusMode = "manual";
        patch.focusDistance = this.committedFocusDistance;
      } else if (mode && this.focusModes().includes(mode)) patch.focusMode = mode;
    }
    if (axis === "exposure" || axis === "all") {
      if (this.committedExposureMode !== "continuous" && this.manualExposure() && this.committedExposureTime !== void 0) {
        patch.exposureMode = "manual";
        patch.exposureTime = this.committedExposureTime;
        if (this.committedIso !== void 0) patch.iso = this.committedIso;
      } else if (this.committedExposureMode === "continuous" && this.exposureModes().includes("continuous")) {
        patch.exposureMode = "continuous";
        patch.exposureCompensation = this.committedExposureCompensation;
      }
    }
    this.candidateExposureTime = void 0;
    this.candidateIso = void 0;
    if (Object.keys(patch).length) {
      await this.apply(track, patch);
      this.beginDecodeGeneration();
    }
  }
  focusOwner(settings) {
    if (this.state === "UNAVAILABLE") return "NONE";
    if (this.state === "OVERRIDE" || this.strategy !== "auto") return "DEVELOPER";
    return settings.focusMode === "manual" ? "MANUAL" : "HARDWARE";
  }
  transition(next, reason) {
    if (this.state !== next) {
      this.transitions.push(`${this.state} → ${next}: ${reason}`);
      if (this.transitions.length > 8) this.transitions.shift();
      this.state = next;
      this.stateSince = performance.now();
    }
    this.lastReason = this.state === "SEEKING" ? "target absent; camera focus and exposure retained" : this.lastReason;
    this.changed();
  }
  async maybeRetrySeekingAutofocus(now = performance.now(), metrics, force = false) {
    if (this.seekingAfRunning || this.strategy !== "auto" || !this.isAcquiring() || this.isOptimizing()) return;
    const track = this.track;
    if (!track || track.readyState !== "live") return;
    const modes = this.focusModes();
    const canSingle = modes.includes("single-shot") && !this.singleShotAfRejected;
    const canContinuous = modes.includes("continuous") || this.settings().focusMode === "continuous";
    if (!canSingle && !canContinuous) return;
    const silence = this.decodeSilence(now);
    if (!force && this.validDecodesInGeneration > 0 && silence < 2200) return;
    const optical = metrics || (!this.targetMissingSince ? this.latest?.metrics : void 0);
    if (!force && optical && optical.confidence >= 0.78 && optical.focusScore >= CAMERA_TUNING.seekingAfGoodFocus) return;
    const interval = this.seekingAfRetries < CAMERA_TUNING.seekingAfFastRetries
      ? CAMERA_TUNING.seekingAfRetryMs
      : CAMERA_TUNING.seekingAfSlowRetryMs;
    if (!force && now - this.lastSeekingAfAt < interval) return;

    const generation = this.generation;
    const geometry = !this.targetMissingSince ? this.latest?.geometry : void 0;
    const centerX = Math.max(0, Math.min(1, Number.isFinite(geometry?.x) ? geometry.x : 0.5));
    const centerY = Math.max(0, Math.min(1, Number.isFinite(geometry?.y) ? geometry.y : 0.5));
    const offsets = [[0, 0], [-0.025, 0], [0.025, 0], [0, -0.025], [0, 0.025]];
    const offset = offsets[this.seekingAfRetries % offsets.length];
    const point = {
      x: Math.max(0, Math.min(1, centerX + offset[0])),
      y: Math.max(0, Math.min(1, centerY + offset[1]))
    };
    this.seekingAfRunning = true;
    this.lastSeekingAfAt = now;
    this.focusProbes++;
    this.focusRefinementCount++;
    this.seekingAfRetries++;
    try {
      if (canSingle) {
        this.requestedMode = "single-shot";
        const accepted = await this.apply(track, {
          focusMode: "single-shot",
          ...(this.pointsOfInterestSupported() ? { pointsOfInterest: [point] } : {})
        });
        if (!this.current(generation)) return;
        if (accepted) {
          const immediate = this.settings();
          await new Promise((resolve) => setTimeout(resolve, 100));
          if (!this.current(generation)) return;
          const actual = this.settings();
          const verified = immediate.focusMode === "single-shot" || actual.focusMode === "single-shot";
          if (verified) {
            this.seekingAfVerified++;
            this.committedFocusMode = actual.focusMode;
            this.committedFocusDistance = actual.focusDistance;
            this.lastReason = `mandatory single-shot AF confirmed at ${(point.x * 100).toFixed(0)}%,${(point.y * 100).toFixed(0)}%`;
            this.changed();
            return;
          }
          this.seekingAfUnconfirmed++;
          if (this.seekingAfUnconfirmed >= 2) this.singleShotAfRejected = true;
        } else {
          this.seekingAfUnconfirmed++;
          this.singleShotAfRejected = true;
        }
      }

      if (canContinuous) {
        this.requestedMode = "continuous";
        const accepted = await this.apply(track, {
          focusMode: "continuous",
          ...(this.pointsOfInterestSupported() ? { pointsOfInterest: [point] } : {})
        });
        if (!this.current(generation)) return;
        const actual = this.settings();
        if (accepted) this.continuousAfNudges++;
        this.committedFocusMode = actual.focusMode;
        this.committedFocusDistance = actual.focusDistance;
        this.lastReason = accepted
          ? `continuous AF metering nudge ${this.continuousAfNudges} at ${(point.x * 100).toFixed(0)}%,${(point.y * 100).toFixed(0)}%${this.singleShotAfRejected ? "; single-shot rejected" : ""}`
          : "camera rejected autofocus controls; continuous hardware AF left running";
        this.changed();
      }
    } finally {
      this.seekingAfRunning = false;
    }
  }
  async configureInitialHardwareFocusOnce() {
    if (this.automaticFocusConfigured || this.strategy !== "auto") return;
    this.automaticFocusConfigured = true;
    const track = this.track;
    if (!track || track.readyState !== "live") return;
    const modes = this.focusModes();
    if (!modes.includes("single-shot") && !modes.includes("continuous") && this.settings().focusMode !== "continuous") {
      this.lastReason = "hardware autofocus controls unavailable";
      this.changed();
      return;
    }
    this.lastSeekingAfAt = -Infinity;
    await this.maybeRetrySeekingAutofocus(performance.now(), void 0, true);
  }
  async applyDeveloperFocus() {
    var _a, _b, _c;
    const track = this.track;
    if (!track) return;
    if (this.strategy === "manual" && this.manualFocus() && this.manualDistance !== void 0) {
      this.requestedMode = "manual";
      const requested = this.manualDistance;
      await this.apply(track, { focusMode: "manual", focusDistance: requested });
      await new Promise((resolve) => setTimeout(resolve, 80));
      const actual = this.settings();
      const step = (_b = (_a = this.caps.focusDistance) == null ? void 0 : _a.step) != null ? _b : 0.01;
      if (actual.focusMode && actual.focusMode !== "manual" || actual.focusDistance !== void 0 && Math.abs(actual.focusDistance - requested) > step / 2) {
        await this.apply(track, { focusMode: "manual", focusDistance: requested });
      }
    } else if (this.strategy === "camera-auto" || this.strategy === "single-shot") {
      const mode = this.strategy === "single-shot" ? "single-shot" : (_c = this.hardwareFocusMode()) != null ? _c : "continuous";
      this.requestedMode = mode;
      await this.apply(track, { focusMode: mode });
    }
    this.changed();
  }
  async applyProbe(generation, patch, fenceImmediately = true) {
    const track = this.track;
    if (!track || !this.current(generation)) return false;
    if (patch.focusMode) this.requestedMode = patch.focusMode;
    const accepted = await this.apply(track, patch);
    if (accepted && fenceImmediately && this.current(generation)) this.beginDecodeGeneration();
    return accepted && this.current(generation);
  }
  resolveWaiter(observation) {
    const waiter = this.waiter;
    if (!waiter || waiter.generation !== this.generation || observation.id <= waiter.afterId || observation.at < waiter.notBefore) return;
    waiter.afterId = observation.id;
    if (waiter.discard-- > 0) return;
    waiter.samples.push(observation);
    if (waiter.samples.length < waiter.requiredSamples) return;
    this.waiter = void 0;
    waiter.resolve(this.aggregate(waiter.samples));
  }
  aggregate(samples) {
    const median = (values) => {
      values.sort((a, b) => a - b);
      return values[values.length >> 1];
    };
    const value = (read) => median(samples.map(read));
    const metric = (key) => value((sample) => Number(sample.metrics[key]));
    const latest = samples[samples.length - 1];
    return {
      ...latest,
      captureFps: value((sample) => sample.captureFps),
      geometry: {
        x: value((sample) => sample.geometry.x),
        y: value((sample) => sample.geometry.y),
        scale: value((sample) => sample.geometry.scale),
        perspectiveX: value((sample) => sample.geometry.perspectiveX),
        perspectiveY: value((sample) => sample.geometry.perspectiveY),
        quality: value((sample) => sample.geometry.quality)
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
        sampledModules: Math.round(metric("sampledModules"))
      }
    };
  }
  beginDecodeGeneration() {
    this.decodeBoundary = this.currentScanId();
    this.cameraGenerationStartedAt = performance.now();
    this.validDecodesInGeneration = 0;
    this.decoderCompletionsInGeneration = 0;
    this.lastValidScanId = -1;
  }
  medianInterval(times) {
    if (times.length < 2) return void 0;
    const gaps = times.slice(1).map((at, index) => at - times[index]).filter((gap) => gap > 8).sort((a, b) => a - b);
    return gaps.length ? gaps[gaps.length >> 1] : void 0;
  }
  silenceThreshold() {
    var _a;
    const decodeInterval = this.medianInterval(this.validDecodeTimes);
    const completionInterval = this.medianInterval(this.completionTimes);
    return Math.max(1200, ((_a = decodeInterval != null ? decodeInterval : completionInterval) != null ? _a : 350) * 5);
  }
  decodeSilence(now = performance.now()) {
    const since = this.lastValidDecodeAt && this.lastValidDecodeAt >= this.cameraGenerationStartedAt ? this.lastValidDecodeAt : this.cameraGenerationStartedAt;
    return Math.max(0, now - since);
  }
  decodeIsFresh(now = performance.now()) {
    return this.validDecodesInGeneration > 0 && this.decodeSilence(now) <= this.silenceThreshold();
  }
  pipelineIsActive(now = performance.now()) {
    var _a;
    const latest = this.completionTimes.at(-1);
    const interval = (_a = this.medianInterval(this.completionTimes)) != null ? _a : 350;
    return latest !== void 0 && now - latest <= Math.max(1200, interval * 4);
  }
  cancel(reason) {
    var _a;
    this.generation++;
    (_a = this.waiter) == null ? void 0 : _a.resolve(void 0);
    this.waiter = void 0;
    this.lastReason = reason;
  }
  current(generation) {
    return generation === this.generation && Boolean(this.track && this.track.readyState === "live");
  }
  commitSettings(settings) {
    this.committedFocusMode = settings.focusMode;
    this.committedFocusDistance = settings.focusDistance;
    this.committedExposureMode = settings.exposureMode;
    this.committedExposureTime = settings.exposureTime;
    this.committedIso = settings.iso;
    this.committedExposureCompensation = settings.exposureCompensation;
  }
  settings() {
    var _a, _b;
    const settings = { ...(_b = (_a = this.track) == null ? void 0 : _a.getSettings()) != null ? _b : {} };
    settings.focusDistance = this.sanitizeFocusDistance(settings.focusDistance);
    return settings;
  }
  sanitizeFocusDistance(value) {
    const range = this.caps.focusDistance;
    return value !== void 0 && Number.isFinite(value) && value >= 0 && value <= 1e3 && Boolean(range && Number.isFinite(range.min) && Number.isFinite(range.max) && value >= range.min && value <= range.max) ? value : void 0;
  }
  focusModes() {
    return Array.isArray(this.caps.focusMode) ? this.caps.focusMode : [];
  }
  pointsOfInterestSupported() {
    let supported = false;
    try {
      supported = Boolean(navigator.mediaDevices?.getSupportedConstraints?.().pointsOfInterest);
    } catch {
    }
    return Boolean(this.caps.pointsOfInterest) || supported;
  }
  overrideFocusModes() {
    const modes = this.focusModes();
    const actual = this.settings().focusMode;
    const hasFocusApi = modes.length > 0 || actual !== void 0 || Boolean(this.caps.pointsOfInterest);
    return [
      ...hasFocusApi ? ["camera-auto", "single-shot"] : [],
      ...modes.includes("manual") && this.caps.focusDistance ? ["manual"] : []
    ];
  }
  exposureModes() {
    return Array.isArray(this.caps.exposureMode) ? this.caps.exposureMode : [];
  }
  hardwareFocusMode() {
    const modes = this.focusModes();
    const actual = this.settings().focusMode;
    if (modes.includes("continuous") || actual === "continuous") return "continuous";
    if (modes.includes("single-shot") || actual === "single-shot") return "single-shot";
    return modes.length > 0 || actual !== void 0 || Boolean(this.caps.pointsOfInterest) ? "continuous" : void 0;
  }
  manualFocus() {
    return this.focusModes().includes("manual") && Boolean(this.caps.focusDistance);
  }
  manualExposure() {
    return this.exposureModes().includes("manual") && Boolean(this.caps.exposureTime);
  }
  isAcquiring() {
    return this.state === "SEEKING" || this.state === "STABILIZING";
  }
  isOptimizing() {
    return this.optimizeState === "baseline" || this.optimizeState === "exposure" || this.optimizeState === "verification";
  }
  quantize(value, range) {
    const clamped = Math.max(range.min, Math.min(range.max, value));
    if (!range.step || range.step <= 0) return clamped;
    return Math.max(range.min, Math.min(
      range.max,
      range.min + Math.round((clamped - range.min) / range.step) * range.step
    ));
  }
  geometryChanged(current, baseline) {
    if (!baseline) return false;
    const displacement = Math.hypot(current.x - baseline.x, current.y - baseline.y);
    const scale = Math.abs(Math.log(Math.max(1e-4, current.scale) / Math.max(1e-4, baseline.scale)));
    const perspective = Math.max(
      Math.abs(current.perspectiveX - baseline.perspectiveX),
      Math.abs(current.perspectiveY - baseline.perspectiveY)
    );
    return displacement > CAMERA_TUNING.displacementRatio || scale > CAMERA_TUNING.scaleChangeRatio || perspective > CAMERA_TUNING.perspectiveChange;
  }
  blendGeometry(a, b) {
    return {
      x: a.x * 0.75 + b.x * 0.25,
      y: a.y * 0.75 + b.y * 0.25,
      scale: a.scale * 0.75 + b.scale * 0.25,
      perspectiveX: a.perspectiveX * 0.75 + b.perspectiveX * 0.25,
      perspectiveY: a.perspectiveY * 0.75 + b.perspectiveY * 0.25,
      quality: a.quality * 0.75 + b.quality * 0.25
    };
  }
}
export {
  CAMERA_TUNING,
  FocusController
};
