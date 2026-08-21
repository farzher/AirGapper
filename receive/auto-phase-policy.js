const DEFAULTS = Object.freeze({
  enableGraceMs: 500,
  acquireRaceGraceMs: 650,
  finderRecentMs: 1400,
  finderFailureMs: 500,
  blindFailureMs: 850,
  badFailureMs: 650,
  weakFailureMs: 1600,
  healthyRatio: 0.65,
  weakRatio: 0.35,
  badRatio: 0.22,
  healthySilenceMs: 550,
  badSilenceMs: 900,
  minCompletedRate: 2,
  phaseSettleMs: 500,
  phaseMeasureMs: 600,
  opticsSettleMs: 1400,
  opticsMaxWaitMs: 7000,
  improvementMargin: 0.10,
  phaseBeforeOptics: 3,
  maxPhaseSteps: 6,
  backoffMs: 3500,
  healthyResetMs: 1800
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

export function recoveryHealth(sample, finderRecent = false) {
  if (!sample) return { score: 0, healthy: false, bad: true, weak: false, label: "no diagnostics" };
  if (sample.acquiring) {
    const decoded = sample.validRate >= 0.5 && sample.decodeSilenceMs < DEFAULTS.badSilenceMs;
    const score = decoded ? 1 : finderRecent ? 0.2 : 0;
    return { score, healthy: decoded, bad: !decoded, weak: false, label: decoded ? "decoded" : finderRecent ? "finder only" : "blind" };
  }

  const completed = finite(sample.completedRate);
  const ratio = sample.successRatio == null ? null : Math.max(0, Math.min(1, finite(sample.successRatio)));
  let score = ratio == null ? (sample.validRate > 0 ? 0.5 : 0) : ratio;
  if (sample.decodeSilenceMs >= DEFAULTS.badSilenceMs) score = 0;
  const healthy = sample.validRate >= 1 && sample.decodeSilenceMs < DEFAULTS.healthySilenceMs &&
    (completed < DEFAULTS.minCompletedRate || ratio == null || ratio >= DEFAULTS.healthyRatio);
  const bad = sample.decodeSilenceMs >= DEFAULTS.badSilenceMs ||
    (completed >= DEFAULTS.minCompletedRate && ratio != null && ratio <= DEFAULTS.badRatio);
  const weak = !healthy && !bad && completed >= DEFAULTS.minCompletedRate && ratio != null && ratio < DEFAULTS.healthyRatio;
  return { score, healthy, bad, weak, label: ratio == null ? "no yield" : `${Math.round(ratio * 100)}% yield` };
}

export class AutoPhasePolicy {
  constructor(options = {}) {
    this.config = { ...DEFAULTS, ...options };
    this.enabled = false;
    this.reset(0);
  }

  reset(now = 0) {
    this.enabledAt = now;
    this.state = "ACQUIRE";
    this.lastAcquiring = null;
    this.lastRaceMs = 0;
    this.lastFinderHints = 0;
    this.recentFinderUntil = 0;
    this.failureSince = 0;
    this.weakSince = 0;
    this.healthySince = 0;
    this.phaseSteps = 0;
    this.opticsTried = false;
    this.currentAction = null;
    this.nextActionAt = 0;
    this.backoffUntil = 0;
    this.lastOutcome = null;
    this.lastHealth = null;
  }

  setEnabled(enabled, now = 0) {
    this.enabled = Boolean(enabled);
    this.reset(now);
  }

  pulseCount() {
    return this.phaseSteps;
  }

  recoveryState() {
    return this.state;
  }

  finderRecent(now) {
    return now < this.recentFinderUntil;
  }

  updateEvidence(sample, now) {
    const finderHints = finite(sample.finderHints);
    const acquisitionRestarted = sample.acquiring && (
      this.lastAcquiring === false || sample.raceMs + 100 < this.lastRaceMs || finderHints < this.lastFinderHints
    );
    if (acquisitionRestarted) {
      this.lastFinderHints = finderHints;
      this.recentFinderUntil = 0;
      this.failureSince = 0;
      this.weakSince = 0;
      this.currentAction = null;
      this.phaseSteps = 0;
      this.opticsTried = false;
      this.backoffUntil = 0;
      this.state = "ACQUIRE";
    } else if (finderHints > this.lastFinderHints) {
      this.recentFinderUntil = now + this.config.finderRecentMs;
      this.lastFinderHints = finderHints;
    } else {
      this.lastFinderHints = finderHints;
    }
    this.lastAcquiring = Boolean(sample.acquiring);
    this.lastRaceMs = finite(sample.raceMs);
  }

  hold(reason, health = this.lastHealth, extra = {}) {
    return { kind: "hold", reason, state: this.state, health, phaseSteps: this.phaseSteps, opticsTried: this.opticsTried, ...extra };
  }

  action(kind, reason, health) {
    return { kind, reason, state: this.state, health, phaseSteps: this.phaseSteps, opticsTried: this.opticsTried };
  }

  noteActionStarted(kind, sample, now = finite(sample?.now)) {
    const health = this.health(sample, now);
    if (kind === "phase") this.phaseSteps++;
    if (kind === "optics") this.opticsTried = true;
    this.currentAction = {
      kind,
      baseline: health.score,
      startedAt: now,
      busySeen: Boolean(sample?.opticsBusy),
      measureAt: now + (kind === "phase" ? this.config.phaseSettleMs + this.config.phaseMeasureMs : this.config.opticsSettleMs)
    };
    this.failureSince = 0;
    this.weakSince = 0;
    this.nextActionAt = this.currentAction.measureAt;
  }

  noteActionRejected(kind, now = 0) {
    if (kind === "phase") this.phaseSteps = this.config.maxPhaseSteps;
    if (kind === "optics") this.opticsTried = true;
    this.currentAction = null;
    this.nextActionAt = now + 250;
  }

  health(sample, now) {
    const finderRecent = this.finderRecent(now);
    const result = recoveryHealth(sample, finderRecent);
    const cfg = this.config;
    if (!sample?.acquiring) {
      const completed = finite(sample?.completedRate);
      const ratio = sample?.successRatio == null ? null : Math.max(0, Math.min(1, finite(sample.successRatio)));
      let score = ratio == null ? (finite(sample?.validRate) > 0 ? 0.5 : 0) : ratio;
      if (finite(sample?.decodeSilenceMs, Infinity) >= cfg.badSilenceMs) score = 0;
      return {
        ...result,
        score,
        healthy: finite(sample?.validRate) >= 1 && finite(sample?.decodeSilenceMs, Infinity) < cfg.healthySilenceMs &&
          (completed < cfg.minCompletedRate || ratio == null || ratio >= cfg.healthyRatio),
        bad: finite(sample?.decodeSilenceMs, Infinity) >= cfg.badSilenceMs ||
          (completed >= cfg.minCompletedRate && ratio != null && ratio <= cfg.badRatio),
        weak: completed >= cfg.minCompletedRate && ratio != null && ratio > cfg.badRatio && ratio < cfg.healthyRatio
      };
    }
    return result;
  }

  finishAction(sample, now, health) {
    const action = this.currentAction;
    if (!action) return null;
    if (action.kind === "optics" && sample.opticsBusy) {
      action.busySeen = true;
      if (now - action.startedAt < this.config.opticsMaxWaitMs) return this.hold("action-running", health, { action: "optics" });
    }
    if (now < action.measureAt) return this.hold("action-settling", health, { action: action.kind });

    const gain = health.score - action.baseline;
    this.lastOutcome = { kind: action.kind, baseline: action.baseline, score: health.score, gain, at: now };
    this.currentAction = null;
    this.nextActionAt = now + 180;

    if (health.healthy) {
      this.state = "GOOD";
      this.failureSince = 0;
      this.weakSince = 0;
      this.healthySince = now;
      return this.hold("action-recovered", health, { action: action.kind, gain });
    }
    if (gain >= this.config.improvementMargin) {
      this.failureSince = now;
      this.weakSince = health.weak ? now : 0;
      return this.hold("action-improved", health, { action: action.kind, gain });
    }
    // A failed experiment is already enough evidence that recovery should keep
    // searching. Do not make the user sit through the initial failure dwell again.
    this.failureSince = now - this.config.badFailureMs;
    this.weakSince = now - this.config.weakFailureMs;
    return this.hold("action-no-gain", health, { action: action.kind, gain });
  }

  enterRecovery(now) {
    if (this.state !== "RECOVER") {
      this.state = "RECOVER";
      this.phaseSteps = 0;
      this.opticsTried = false;
      this.currentAction = null;
      this.backoffUntil = 0;
      this.nextActionAt = now;
    }
  }

  nextRecoveryAction(sample, now, health) {
    if (sample.opticsBusy) return this.hold("external-optics", health);
    if (now < this.nextActionAt) return this.hold("recovery-wait", health);
    if (now < this.backoffUntil) return this.hold("backoff", health);

    const opticsAllowed = sample.opticsAllowed === true;
    const phaseAvailable = sample.phaseAvailable !== false;
    const finderVisible = this.finderRecent(now);

    // Initial acquisition with no QR structure is the one case where optics gets
    // first shot. If QR structure exists but won't decode, phase is the cheaper
    // and more likely fix. Once locked, phase always gets first shot because the
    // current optics were already QR-proven.
    if (sample.acquiring && !finderVisible && opticsAllowed && !this.opticsTried)
      return this.action("optics", "blind-optics-first", health);

    if (phaseAvailable && this.phaseSteps < this.config.phaseBeforeOptics)
      return this.action("phase", sample.acquiring ? "acquire-phase" : "tracking-phase", health);

    if (opticsAllowed && !this.opticsTried)
      return this.action("optics", "optics-after-phase", health);

    if (phaseAvailable && this.phaseSteps < this.config.maxPhaseSteps)
      return this.action("phase", "phase-search", health);

    this.backoffUntil = now + this.config.backoffMs;
    this.phaseSteps = 0;
    this.opticsTried = false;
    return this.hold("backoff", health);
  }

  observe(sample) {
    const now = finite(sample?.now);
    if (!this.enabled) return this.hold("off");
    if (!sample) return this.hold("waiting-diagnostics");

    this.updateEvidence(sample, now);
    const health = this.health(sample, now);
    this.lastHealth = health;

    if (this.currentAction) {
      const result = this.finishAction(sample, now, health);
      if (result && (result.reason === "action-running" || result.reason === "action-settling" ||
        result.reason === "action-recovered" || result.reason === "action-improved")) return result;
      // No gain: continue directly into recovery action selection below.
    }

    if (health.healthy) {
      this.state = "GOOD";
      this.failureSince = 0;
      this.weakSince = 0;
      if (!this.healthySince) this.healthySince = now;
      if (now - this.healthySince >= this.config.healthyResetMs) {
        this.phaseSteps = 0;
        this.opticsTried = false;
        this.backoffUntil = 0;
      }
      return this.hold("healthy", health);
    }
    this.healthySince = 0;

    if (now - this.enabledAt < this.config.enableGraceMs) return this.hold("arming", health);

    if (sample.acquiring) {
      this.state = this.state === "RECOVER" ? "RECOVER" : "ACQUIRE";
      if (sample.raceMs < this.config.acquireRaceGraceMs) return this.hold("acquire-race", health);
      const finderVisible = this.finderRecent(now);
      if (!this.failureSince) this.failureSince = now;
      const dwell = finderVisible ? this.config.finderFailureMs : this.config.blindFailureMs;
      if (now - this.failureSince < dwell) return this.hold(finderVisible ? "finder-no-decode" : "blind-acquisition", health);
      this.enterRecovery(now);
      return this.nextRecoveryAction(sample, now, health);
    }

    if (health.bad) {
      this.weakSince = 0;
      if (!this.failureSince) this.failureSince = now;
      if (now - this.failureSince < this.config.badFailureMs) return this.hold("bad-dwell", health);
      this.enterRecovery(now);
      return this.nextRecoveryAction(sample, now, health);
    }

    this.failureSince = 0;
    if (health.weak) {
      if (!this.weakSince) this.weakSince = now;
      if (now - this.weakSince < this.config.weakFailureMs) return this.hold("weak-dwell", health);
      this.enterRecovery(now);
      return this.nextRecoveryAction(sample, now, health);
    }

    this.weakSince = 0;
    return this.hold("watching", health);
  }
}
