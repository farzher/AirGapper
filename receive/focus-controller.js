import {
  CAMERA_TUNING,
  FocusController as CoreFocusController
} from "./focus-controller-core.js";

// Keep camera ownership generations at the public controller boundary. The core
// owns focus/optics policy; this subclass only prevents async work authorized by
// an older camera/strategy generation from mutating or relabeling the new one.
class FocusController extends CoreFocusController {
  attach(track) {
    this.cancel("camera track changed");
    this.track = track;
    this.caps = track.getCapabilities?.() ?? {};
    const focusRange = this.caps.focusDistance;
    if (!focusRange || !Number.isFinite(focusRange.min) || !Number.isFinite(focusRange.max) ||
        focusRange.min < 0 || focusRange.max < focusRange.min || focusRange.max > 1e3) {
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

    const generation = this.generation;
    if (this.strategy === "auto") {
      this.transition("SEEKING", "camera track changed; hardware AF acquisition retries armed until QR decode");
      void this.configureInitialHardwareFocusOnce(generation)
        .then(() => this.enterAutomaticExposureState("camera opened", generation, false));
    } else {
      this.transition("OVERRIDE", "camera track changed; developer owns focus");
      void this.applyDeveloperFocus(generation);
    }
  }

  setStrategy(strategy) {
    const optimizing = this.isOptimizing();
    this.cancel("focus ownership changed");
    this.strategy = strategy;
    const generation = this.generation;
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
      void this.configureInitialHardwareFocusOnce(generation)
        .then(() => this.enterAutomaticExposureState("automatic focus selected", generation, false));
    } else {
      this.optimizeState = "idle";
      this.optimizeBestPerformance = void 0;
      this.optimizeSummary = void 0;
      this.transition("OVERRIDE", "developer owns focus");
      const start = () => {
        if (this.current(generation) && this.strategy === strategy) return this.applyDeveloperFocus(generation);
      };
      if (optimizing) void this.restoreOptimizationBest("exposure", generation).then(start);
      else void start();
    }
  }

  async configureInitialHardwareFocusOnce(generation = this.generation) {
    if (!this.current(generation) || this.automaticFocusConfigured || this.strategy !== "auto") return;
    this.automaticFocusConfigured = true;
    const track = this.track;
    if (!track || track.readyState !== "live") return;
    const modes = this.focusModes();
    const initial = this.settings();
    const canContinuous = modes.includes("continuous") || initial.focusMode === "continuous";
    const canSingle = modes.includes("single-shot");
    if (!canSingle && !canContinuous) {
      if (!this.current(generation)) return;
      this.lastReason = "hardware autofocus controls unavailable";
      this.changed();
      return;
    }

    if (canContinuous) {
      this.requestedMode = "continuous";
      let accepted = initial.focusMode === "continuous";
      if (!accepted) {
        accepted = await this.apply(track, { focusMode: "continuous" });
        if (!this.current(generation) || this.track !== track) return;
      }
      const actual = this.settings();
      if (!this.current(generation) || this.track !== track) return;
      const continuousConfirmed = actual.focusMode === "continuous";
      this.committedFocusMode = actual.focusMode;
      this.committedFocusDistance = actual.focusDistance;
      // Only proven continuous AF gets permanent ownership. The previous logic
      // disabled single-shot merely because continuous was advertised/requested,
      // which could leave acquisition with no escape hatch when the HAL ignored
      // that request.
      this.singleShotAfRejected = continuousConfirmed;
      this.lastSeekingAfAt = continuousConfirmed ? performance.now() : -Infinity;
      if (continuousConfirmed) {
        this.lastReason = initial.focusMode === "continuous"
          ? "continuous hardware AF already running; waiting for QR evidence"
          : "continuous hardware AF selected; waiting for QR evidence";
        this.changed();
        return;
      }
      this.lastReason = accepted
        ? "continuous AF request unconfirmed; single-shot recovery remains armed"
        : "continuous AF rejected; single-shot recovery remains armed";
      this.changed();
      if (canSingle && this.current(generation))
        await this.maybeRetrySeekingAutofocus(performance.now(), void 0, true);
      return;
    }

    this.lastSeekingAfAt = -Infinity;
    if (this.current(generation))
      await this.maybeRetrySeekingAutofocus(performance.now(), void 0, true);
  }

  async applyDeveloperFocus(generation = this.generation) {
    const track = this.track;
    const strategy = this.strategy;
    if (!track || !this.current(generation)) return false;
    if (strategy === "manual" && this.manualFocus() && this.manualDistance !== void 0) {
      this.requestedMode = "manual";
      const requested = this.manualDistance;
      await this.apply(track, { focusMode: "manual", focusDistance: requested });
      if (!this.current(generation) || this.track !== track || this.strategy !== strategy) return false;
      await new Promise((resolve) => setTimeout(resolve, 80));
      if (!this.current(generation) || this.track !== track || this.strategy !== strategy) return false;
      const actual = this.settings();
      const step = this.caps.focusDistance?.step ?? 0.01;
      if (actual.focusMode && actual.focusMode !== "manual" ||
          actual.focusDistance !== void 0 && Math.abs(actual.focusDistance - requested) > step / 2) {
        await this.apply(track, { focusMode: "manual", focusDistance: requested });
        if (!this.current(generation) || this.track !== track || this.strategy !== strategy) return false;
      }
    } else if (strategy === "camera-auto" || strategy === "single-shot") {
      const mode = strategy === "single-shot" ? "single-shot" : this.hardwareFocusMode() ?? "continuous";
      this.requestedMode = mode;
      await this.apply(track, { focusMode: mode });
      if (!this.current(generation) || this.track !== track || this.strategy !== strategy) return false;
    }
    if (!this.current(generation) || this.strategy !== strategy) return false;
    this.changed();
    return true;
  }

  async enterAutomaticExposureState(reason, generation = this.generation, resetExposure = false, restoreExposure = false) {
    const track = this.track;
    if (!track || track.readyState !== "live" || !this.current(generation)) return false;
    const patch = {};
    if (resetExposure && this.exposureModes().includes("continuous")) {
      patch.exposureMode = "continuous";
      if (this.caps.exposureCompensation && this.caps.exposureCompensation.min <= 0 && this.caps.exposureCompensation.max >= 0) {
        const neutralBias = this.quantize(Math.max(this.caps.exposureCompensation.min, -0.8), this.caps.exposureCompensation);
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
      accepted = await this.apply(track, patch);
      if (!this.current(generation) || this.track !== track) return false;
      // Decoder evidence belongs to the camera state that actually exists. A
      // rejected/vetoed request must not erase fresh QR evidence for no reason.
      if (accepted) this.beginDecodeGeneration();
    }
    if (!this.current(generation)) return false;
    this.lastReason = accepted ? reason : `${reason}; camera rejected requested controls`;
    this.changed();
    return accepted;
  }

  async restoreOptimizationBest(axis = "all", generation = this.generation) {
    const track = this.track;
    if (!track || !this.current(generation)) return false;
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
        if (this.committedExposureCompensation !== void 0)
          patch.exposureCompensation = this.committedExposureCompensation;
      }
    }
    this.candidateExposureTime = void 0;
    this.candidateIso = void 0;
    if (!Object.keys(patch).length) return true;
    const accepted = await this.apply(track, patch);
    if (!this.current(generation) || this.track !== track) return false;
    if (accepted) this.beginDecodeGeneration();
    return accepted;
  }

  cancelOptimize(reason = "optimization stopped") {
    if (!this.isOptimizing()) return;
    this.cancel(reason);
    const generation = this.generation;
    this.optimizeState = "paused";
    this.optimizeReason = `${reason}; original settings restored`;
    void this.restoreOptimizationBest("exposure", generation).then(() => {
      if (!this.current(generation) || this.optimizeState !== "paused" || this.strategy !== "auto") return;
      this.transition("LOCKED", this.optimizeReason);
    });
  }
}

export {
  CAMERA_TUNING,
  FocusController
};
