export type FocusStrategy = "auto" | "continuous" | "single-shot" | "manual";
export type FocusState = "UNAVAILABLE" | "ACQUIRE" | "STABILIZING" | "LOCKED" | "REACQUIRE" | "OVERRIDE";

type FocusRange = { min: number; max: number; step?: number };
type FocusCapabilities = MediaTrackCapabilities & {
  focusMode?: string[];
  focusDistance?: FocusRange;
  pointsOfInterest?: unknown;
};
type FocusSettings = MediaTrackSettings & { focusMode?: string; focusDistance?: number };
type FocusConstraint = MediaTrackConstraintSet & {
  focusMode?: string;
  focusDistance?: number;
  pointsOfInterest?: { x: number; y: number }[];
};

export const FOCUS_TUNING = {
  goodFramesToLock: 8,
  stableEvidenceMs: 650,
  sustainedLossMs: 2800,
  badCompletionsToReacquire: 10,
  geometrySamplesToReacquire: 3,
  scaleChangeRatio: 0.18,
  displacementRatio: 0.12,
  minRefocusCooldownMs: 5000,
  receptionWindowMs: 3000,
};

export interface FocusGeometry {
  x: number;
  y: number;
  scale: number;
  quality: number;
}

export interface FocusDiagnostics {
  state: FocusState;
  availableModes: string[];
  requestedMode?: string;
  actualMode?: string;
  actualDistance?: number;
  distanceRange?: FocusRange;
  poiSupported: boolean;
  initialLockMs?: number;
  refocusCount: number;
  lastRefocusReason: string;
  lastRefocusAt?: number;
  goodStreak: number;
  badStreak: number;
  quality: number;
  receptionBefore?: number;
  receptionAfter?: number;
}

type ApplyFocus = (track: MediaStreamTrack, constraint: FocusConstraint) => Promise<boolean>;

export class FocusController {
  private track?: MediaStreamTrack;
  private caps: FocusCapabilities = {};
  private state: FocusState = "UNAVAILABLE";
  private requestedMode?: string;
  private strategy: FocusStrategy = "auto";
  private manualDistance?: number;
  private attachedAt = 0;
  private firstGoodAt = 0;
  private lastGoodAt = 0;
  private lastEvidenceId = -1;
  private goodStreak = 0;
  private badStreak = 0;
  private geometryChanges = 0;
  private stableGeometry?: FocusGeometry;
  private latestGeometry?: FocusGeometry;
  private initialLockMs?: number;
  private refocusCount = 0;
  private lastRefocusReason = "camera opened";
  private lastRefocusAt?: number;
  private quality = 0;
  private usefulBytes: { at: number; bytes: number }[] = [];
  private receptionBefore?: number;
  private receptionAfter?: number;
  private measuringReacquire = false;
  private poiAimed = false;

  constructor(
    private readonly apply: ApplyFocus,
    private readonly changed: () => void,
    strategy: FocusStrategy = "auto",
    manualDistance?: number,
  ) {
    this.strategy = strategy;
    this.manualDistance = manualDistance;
  }

  get capabilities(): FocusCapabilities { return this.caps; }
  get selectedStrategy(): FocusStrategy { return this.strategy; }

  attach(track: MediaStreamTrack): void {
    this.track = track;
    this.caps = (track.getCapabilities?.() ?? {}) as FocusCapabilities;
    this.attachedAt = performance.now();
    this.firstGoodAt = 0;
    this.lastGoodAt = 0;
    this.lastEvidenceId = -1;
    this.goodStreak = 0;
    this.badStreak = 0;
    this.geometryChanges = 0;
    this.stableGeometry = undefined;
    this.latestGeometry = undefined;
    this.requestedMode = undefined;
    this.poiAimed = false;
    this.state = this.usableModes().length ? (this.strategy === "auto" ? "ACQUIRE" : "OVERRIDE") : "UNAVAILABLE";
    this.changed();
    void this.beginFocus("camera opened", false);
  }

  detach(): void {
    this.track = undefined;
    this.caps = {};
    this.state = "UNAVAILABLE";
    this.changed();
  }

  setStrategy(strategy: FocusStrategy): void {
    this.strategy = strategy;
    this.goodStreak = 0;
    this.badStreak = 0;
    this.state = this.usableModes().length ? (strategy === "auto" ? "REACQUIRE" : "OVERRIDE") : "UNAVAILABLE";
    this.changed();
    void this.beginFocus("strategy changed", strategy === "auto");
  }

  setManualDistance(distance: number): void {
    const range = this.caps.focusDistance;
    if (!range || !Number.isFinite(distance)) return;
    this.manualDistance = Math.max(range.min, Math.min(range.max, distance));
    if (this.strategy === "manual") void this.request("manual", this.manualDistance);
    this.changed();
  }

  refocus(reason = "developer request"): void {
    void this.beginFocus(reason, true);
  }

  noteGood(id: number, geometry: FocusGeometry, usefulBytes = 0, now = performance.now()): void {
    if (usefulBytes > 0) this.usefulBytes.push({ at: now, bytes: usefulBytes });
    this.pruneReception(now);
    this.latestGeometry = geometry;
    this.quality = geometry.quality;
    if (!this.poiAimed && this.caps.pointsOfInterest &&
        (this.state === "ACQUIRE" || this.state === "REACQUIRE" || this.state === "STABILIZING")) {
      this.poiAimed = true;
      const mode = this.requestedMode;
      if (mode === "single-shot" || mode === "continuous") void this.request(mode);
    }
    this.lastGoodAt = now;
    this.badStreak = 0;
    if (id === this.lastEvidenceId) {
      this.changed();
      return;
    }
    this.lastEvidenceId = id;

    if (this.state === "LOCKED") {
      const changed = this.geometryChanged(geometry, this.stableGeometry);
      this.geometryChanges = changed ? this.geometryChanges + 1 : 0;
      if (this.geometryChanges >= FOCUS_TUNING.geometrySamplesToReacquire) {
        void this.beginFocus("sustained grid movement/scale change", true);
      }
      this.changed();
      return;
    }
    if (this.state !== "ACQUIRE" && this.state !== "STABILIZING" && this.state !== "REACQUIRE") return;

    if (!this.firstGoodAt || this.geometryChanged(geometry, this.stableGeometry)) {
      this.firstGoodAt = now;
      this.goodStreak = 1;
      this.stableGeometry = geometry;
      this.state = "STABILIZING";
    } else {
      this.goodStreak++;
      this.stableGeometry = {
        x: this.stableGeometry!.x * 0.8 + geometry.x * 0.2,
        y: this.stableGeometry!.y * 0.8 + geometry.y * 0.2,
        scale: this.stableGeometry!.scale * 0.8 + geometry.scale * 0.2,
        quality: this.stableGeometry!.quality * 0.8 + geometry.quality * 0.2,
      };
    }
    if (this.goodStreak >= FOCUS_TUNING.goodFramesToLock && now - this.firstGoodAt >= FOCUS_TUNING.stableEvidenceMs) {
      void this.lock(now);
    }
    this.changed();
  }

  noteBad(now = performance.now()): void {
    if (this.state !== "LOCKED") return;
    this.badStreak++;
    if (this.lastGoodAt && now - this.lastGoodAt >= FOCUS_TUNING.sustainedLossMs &&
        this.badStreak >= FOCUS_TUNING.badCompletionsToReacquire) {
      void this.beginFocus("sustained loss of valid AirGapper QR", true);
    }
    this.changed();
  }

  diagnostics(now = performance.now()): FocusDiagnostics {
    const settings = this.track?.getSettings() as FocusSettings | undefined;
    if (this.measuringReacquire && this.state === "LOCKED" && this.lastRefocusAt && now - this.lastRefocusAt >= FOCUS_TUNING.receptionWindowMs) {
      this.receptionAfter = this.receptionRate(now);
      this.measuringReacquire = false;
    }
    return {
      state: this.state,
      availableModes: this.usableModes(),
      requestedMode: this.requestedMode,
      actualMode: settings?.focusMode,
      actualDistance: settings?.focusDistance,
      distanceRange: this.caps.focusDistance,
      poiSupported: Boolean(this.caps.pointsOfInterest),
      initialLockMs: this.initialLockMs,
      refocusCount: this.refocusCount,
      lastRefocusReason: this.lastRefocusReason,
      lastRefocusAt: this.lastRefocusAt,
      goodStreak: this.goodStreak,
      badStreak: this.badStreak,
      quality: this.quality,
      receptionBefore: this.receptionBefore,
      receptionAfter: this.receptionAfter,
    };
  }

  private usableModes(): string[] {
    return Array.isArray(this.caps.focusMode) ? this.caps.focusMode : [];
  }

  private supports(mode: string): boolean { return this.usableModes().includes(mode); }

  private async beginFocus(reason: string, count: boolean): Promise<void> {
    const track = this.track;
    if (!track || track.readyState !== "live" || !this.usableModes().length) return;
    const now = performance.now();
    if (count && this.lastRefocusAt && now - this.lastRefocusAt < FOCUS_TUNING.minRefocusCooldownMs && reason !== "developer request") return;
    if (count) {
      this.receptionBefore = this.receptionRate(now);
      this.receptionAfter = undefined;
      this.measuringReacquire = true;
      this.refocusCount++;
      this.lastRefocusAt = now;
    }
    this.lastRefocusReason = reason;
    this.goodStreak = 0;
    this.badStreak = 0;
    this.geometryChanges = 0;
    this.firstGoodAt = 0;
    this.poiAimed = false;
    this.state = this.strategy === "auto" || reason === "developer request" ? (count ? "REACQUIRE" : "ACQUIRE") : "OVERRIDE";
    this.changed();

    if (this.strategy === "manual" && reason !== "developer request") {
      await this.request("manual", this.manualDistance);
      return;
    }
    if (this.strategy === "continuous") {
      await this.request("continuous");
      return;
    }
    if (this.strategy === "single-shot") {
      await this.request("single-shot");
      return;
    }
    const acquisitionMode = this.supports("single-shot") ? "single-shot" : this.supports("continuous") ? "continuous" : undefined;
    if (acquisitionMode) await this.request(acquisitionMode);
  }

  private async request(mode: string, distance?: number): Promise<boolean> {
    const track = this.track;
    if (!track || !this.supports(mode)) return false;
    const target = this.latestGeometry ?? { x: 0.5, y: 0.5, scale: 0, quality: 0 };
    const constraint: FocusConstraint = { focusMode: mode };
    if (mode === "manual" && distance !== undefined) constraint.focusDistance = distance;
    if (mode !== "manual" && this.caps.pointsOfInterest) constraint.pointsOfInterest = [{ x: target.x, y: target.y }];
    this.requestedMode = mode;
    const accepted = await this.apply(track, constraint);
    this.changed();
    return accepted;
  }

  private async lock(now: number): Promise<void> {
    if (this.state === "LOCKED") return;
    const track = this.track;
    if (!track) return;
    const settings = track.getSettings() as FocusSettings;
    if ((this.strategy === "auto" || this.strategy === "manual") && this.supports("manual") && this.caps.focusDistance && Number.isFinite(settings.focusDistance)) {
      const distance = settings.focusDistance!;
      this.manualDistance = distance;
      await this.request("manual", distance);
      const applied = track.getSettings() as FocusSettings;
      const tolerance = Math.max(this.caps.focusDistance.step ?? 0, 0.0001);
      if ((applied.focusMode !== undefined && applied.focusMode !== "manual") ||
          (applied.focusDistance !== undefined && Math.abs(applied.focusDistance - distance) > tolerance)) {
        // Advanced constraint sets may be silently ignored. Restore a usable AF
        // mode instead of leaving a half-applied manual request in control.
        if (this.supports("single-shot")) await this.request("single-shot");
        else if (this.supports("continuous")) await this.request("continuous");
      }
    }
    this.state = this.strategy === "auto" ? "LOCKED" : "OVERRIDE";
    if (this.initialLockMs === undefined) this.initialLockMs = now - this.attachedAt;
    this.changed();
  }

  private geometryChanged(current: FocusGeometry, baseline?: FocusGeometry): boolean {
    if (!baseline) return false;
    const displacement = Math.hypot(current.x - baseline.x, current.y - baseline.y);
    const scale = Math.abs(Math.log(Math.max(0.0001, current.scale) / Math.max(0.0001, baseline.scale)));
    return displacement > FOCUS_TUNING.displacementRatio || scale > FOCUS_TUNING.scaleChangeRatio;
  }

  private pruneReception(now: number): void {
    while (this.usefulBytes.length && this.usefulBytes[0]!.at < now - FOCUS_TUNING.receptionWindowMs) this.usefulBytes.shift();
  }

  private receptionRate(now: number): number {
    this.pruneReception(now);
    return this.usefulBytes.reduce((sum, sample) => sum + sample.bytes, 0) * 1000 / FOCUS_TUNING.receptionWindowMs;
  }
}
