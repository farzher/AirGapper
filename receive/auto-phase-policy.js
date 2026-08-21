const DEFAULTS = Object.freeze({
  enableGraceMs: 650,
  settleAfterPulseMs: 850,
  acquireRaceGraceMs: 650,
  acquireFinderFailureMs: 500,
  acquireBlindFailureMs: 800,
  finderRecentMs: 1400,
  trackingFailureMs: 650,
  seamFailureMs: 450,
  healthySilenceMs: 450,
  badSilenceMs: 850,
  minCompletedRate: 2,
  poorSuccessRatio: 0.30,
  healthySuccessRatio: 0.50,
  seamSuccessRatioCeiling: 0.65,
  seamConfidence: 0.62,
  healthyResetMs: 2200,
  pulseWindowMs: 20000,
  maxPulsesPerWindow: 6,
  backoffMs: 5000
});

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function tokenNumber(value) {
  return value === "—" || value === undefined ? 0 : finite(value);
}

export function parseAutoPhaseDiagnostics(text) {
  if (!text) return null;
  const acquire = /Acquire\s+(done|(\d+)ms race)[^\n]*?finder hints\s+(\d+)/.exec(text);
  if (!acquire) return null;

  const capacity = /Capacity\s+(\d+|—)\s+decodable\s+\/\s+(\d+|—)\s+visible[^\n]*?submitted\s+([\d.]+)[^\n]*?completed\s+([\d.]+)/.exec(text);
  const output = /Output\s+valid\s+([\d.]+)\s+·\s+unique\s+([\d.]+)\s+·\s+duplicate\s+([\d.]+)\s+QR\/s/.exec(text);
  const payload = /Payload\s+valid\s+(\d+)\s+·\s+completions\s+(\d+)\s+·\s+silence\s+([\d.]+)s/.exec(text);
  const optics = /AutoOptics\s+(off|([A-Z]+)\s+·\s+([a-z-]+))/.exec(text);
  const rolling = /Rolling\s+(row|col)\s+([-+]?\d+(?:\.\d+)?)\/([-+]?\d+(?:\.\d+)?)\s+·\s+width\s+([-+]?\d+(?:\.\d+)?)\s+·\s+velocity\s+([-+]?\d+(?:\.\d+)?)\s+slots\/frame\s+·\s+confidence\s+(\d+)%/.exec(text);

  const completedRate = finite(capacity?.[4]);
  const validRate = finite(output?.[1]);
  const successRatio = completedRate >= 0.01 ? Math.max(0, Math.min(1, validRate / completedRate)) : null;
  const opticsController = optics?.[2] || (optics?.[1] === "off" ? "OFF" : "");
  const opticsRuntime = optics?.[3] || "";
  const opticsBusy = ["LEARN", "RECOVER"].includes(opticsController) ||
    ["rescue", "settling", "tuning", "seed", "memory"].includes(opticsRuntime);

  return {
    acquiring: acquire[1] !== "done",
    raceMs: finite(acquire[2]),
    finderHints: finite(acquire[3]),
    decodableSlots: tokenNumber(capacity?.[1]),
    visibleSlots: tokenNumber(capacity?.[2]),
    submittedRate: finite(capacity?.[3]),
    completedRate,
    validRate,
    uniqueRate: finite(output?.[2]),
    duplicateRate: finite(output?.[3]),
    validTotal: finite(payload?.[1]),
    completionTotal: finite(payload?.[2]),
    decodeSilenceMs: payload ? finite(payload[3]) * 1000 : Infinity,
    successRatio,
    opticsController,
    opticsRuntime,
    opticsBusy,
    seam: rolling ? {
      axis: rolling[1],
      position: finite(rolling[2]),
      span: finite(rolling[3]),
      width: finite(rolling[4]),
      velocity: finite(rolling[5]),
      confidence: finite(rolling[6]) / 100
    } : null
  };
}

export class AutoPhasePolicy {
  constructor(options = {}) {
    this.config = { ...DEFAULTS, ...options };
    this.enabled = false;
    this.reset(0);
  }

  reset(now = 0) {
    this.enabledAt = now;
    this.lastPulseAt = -Infinity;
    this.settleUntil = 0;
    this.windowStartedAt = now;
    this.pulsesInWindow = 0;
    this.backoffUntil = 0;
    this.lastFinderHints = 0;
    this.recentFinderUntil = 0;
    this.finderFailureSince = 0;
    this.blindFailureSince = 0;
    this.trackingFailureSince = 0;
    this.seamFailureSince = 0;
    this.healthySince = 0;
    this.lastAcquiring = null;
    this.lastRaceMs = 0;
  }

  setEnabled(enabled, now) {
    this.enabled = Boolean(enabled);
    this.reset(now);
  }

  pulseCount() {
    return this.pulsesInWindow;
  }

  notePulse(now) {
    this.rotateWindow(now);
    this.pulsesInWindow++;
    this.lastPulseAt = now;
    this.settleUntil = now + this.config.settleAfterPulseMs;
    // A phase change invalidates all failure evidence from the old phase. New
    // finder/QR observations must earn the next decision.
    this.recentFinderUntil = 0;
    this.finderFailureSince = 0;
    this.blindFailureSince = 0;
    this.trackingFailureSince = 0;
    this.seamFailureSince = 0;
    this.healthySince = 0;
  }

  rotateWindow(now) {
    if (now - this.windowStartedAt >= this.config.pulseWindowMs) {
      this.windowStartedAt = now;
      this.pulsesInWindow = 0;
      this.backoffUntil = 0;
    }
    if (this.backoffUntil && now >= this.backoffUntil) {
      this.windowStartedAt = now;
      this.pulsesInWindow = 0;
      this.backoffUntil = 0;
    }
  }

  pulseDecision(reason) {
    return { kind: "pulse", reason, nextPulse: this.pulsesInWindow + 1, maxPulses: this.config.maxPulsesPerWindow };
  }

  hold(reason) {
    return { kind: "hold", reason, pulses: this.pulsesInWindow, maxPulses: this.config.maxPulsesPerWindow };
  }

  observe(sample) {
    const now = finite(sample?.now);
    if (!this.enabled) return this.hold("off");
    if (!sample) return this.hold("waiting-diagnostics");

    this.rotateWindow(now);
    if (this.backoffUntil > now) return this.hold("backoff");
    if (this.pulsesInWindow >= this.config.maxPulsesPerWindow) {
      this.backoffUntil = now + this.config.backoffMs;
      return this.hold("backoff");
    }
    if (now - this.enabledAt < this.config.enableGraceMs) return this.hold("arming");
    if (now < this.settleUntil) return this.hold("settling");

    const finderHints = finite(sample.finderHints);
    const acquisitionRestarted = sample.acquiring && (
      this.lastAcquiring === false ||
      sample.raceMs + 100 < this.lastRaceMs ||
      finderHints < this.lastFinderHints
    );
    if (acquisitionRestarted) {
      this.recentFinderUntil = 0;
      this.finderFailureSince = 0;
      this.blindFailureSince = 0;
      this.lastFinderHints = finderHints;
    } else if (finderHints > this.lastFinderHints) {
      this.recentFinderUntil = now + this.config.finderRecentMs;
      if (!this.finderFailureSince) this.finderFailureSince = now;
      this.lastFinderHints = finderHints;
    } else {
      this.lastFinderHints = finderHints;
    }

    this.lastAcquiring = Boolean(sample.acquiring);
    this.lastRaceMs = finite(sample.raceMs);

    if (sample.acquiring) return this.observeAcquisition(sample, now);
    return this.observeTracking(sample, now);
  }

  observeAcquisition(sample, now) {
    this.trackingFailureSince = 0;
    this.seamFailureSince = 0;
    this.healthySince = 0;

    // A valid packet can briefly arrive before the lattice diagnostic flips to
    // "done". Never disturb that successful phase while geometry catches up.
    if (sample.validRate >= 0.5 && sample.decodeSilenceMs < this.config.badSilenceMs) {
      this.finderFailureSince = 0;
      this.blindFailureSince = 0;
      return this.hold("acquire-valid");
    }
    if (sample.raceMs < this.config.acquireRaceGraceMs) return this.hold("acquire-race");

    const finderRecent = now < this.recentFinderUntil;
    if (finderRecent) {
      this.blindFailureSince = 0;
      if (!this.finderFailureSince) this.finderFailureSince = now;
      if (sample.opticsBusy) return this.hold("optics-visible");
      if (now - this.finderFailureSince >= this.config.acquireFinderFailureMs)
        return this.pulseDecision("finder-no-decode");
      return this.hold("finder-no-decode");
    }

    this.finderFailureSince = 0;
    if (!this.blindFailureSince) this.blindFailureSince = now;
    // No QR evidence is ambiguous: focus/exposure may simply be wrong. Let an
    // in-progress AutoOptics mutation finish before changing shutter phase.
    if (sample.opticsBusy) return this.hold("optics-blind");
    if (now - this.blindFailureSince >= this.config.acquireBlindFailureMs)
      return this.pulseDecision("blind-acquisition");
    return this.hold("blind-acquisition");
  }

  observeTracking(sample, now) {
    this.finderFailureSince = 0;
    this.blindFailureSince = 0;

    const visible = finite(sample.visibleSlots);
    const completed = finite(sample.completedRate);
    const valid = finite(sample.validRate);
    const ratio = sample.successRatio === null || sample.successRatio === undefined
      ? null
      : Math.max(0, Math.min(1, finite(sample.successRatio)));

    if (visible <= 0) {
      this.trackingFailureSince = 0;
      this.seamFailureSince = 0;
      this.healthySince = 0;
      return this.hold("no-visible-slots");
    }

    const healthy = valid >= 1 && sample.decodeSilenceMs < this.config.healthySilenceMs &&
      (completed < this.config.minCompletedRate || ratio === null || ratio >= this.config.healthySuccessRatio);
    if (healthy) {
      this.trackingFailureSince = 0;
      this.seamFailureSince = 0;
      if (!this.healthySince) this.healthySince = now;
      if (now - this.healthySince >= this.config.healthyResetMs) {
        this.windowStartedAt = now;
        this.pulsesInWindow = 0;
        this.backoffUntil = 0;
      }
      return this.hold("healthy");
    }
    this.healthySince = 0;

    const poorBySilence = sample.decodeSilenceMs >= this.config.badSilenceMs;
    const poorByYield = completed >= this.config.minCompletedRate && ratio !== null && ratio < this.config.poorSuccessRatio;
    const poor = poorBySilence || poorByYield;
    const seamUseful = sample.seam?.confidence >= this.config.seamConfidence &&
      (ratio === null || ratio < this.config.seamSuccessRatioCeiling);

    // AutoOptics and an exposure pulse both mutate camera constraints. Never
    // issue them concurrently; wait for optics to finish, then judge its result.
    if (sample.opticsBusy) {
      this.trackingFailureSince = 0;
      this.seamFailureSince = 0;
      return this.hold("optics-tracking");
    }

    if (seamUseful) {
      if (!this.seamFailureSince) this.seamFailureSince = now;
      if (now - this.seamFailureSince >= this.config.seamFailureMs)
        return this.pulseDecision("seam-degraded");
    } else {
      this.seamFailureSince = 0;
    }

    if (poor) {
      if (!this.trackingFailureSince) this.trackingFailureSince = now;
      // This path deliberately works with one or two QRs. A geometric seam is
      // optional evidence, never a prerequisite for phase recovery.
      if (now - this.trackingFailureSince >= this.config.trackingFailureMs)
        return this.pulseDecision(poorBySilence ? "decode-silence" : "low-decode-yield");
      return this.hold(poorBySilence ? "decode-silence" : "low-decode-yield");
    }

    this.trackingFailureSince = 0;
    return this.hold("watching");
  }
}
