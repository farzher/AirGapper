function quantile(values, q) {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const x = (sorted.length - 1) * q, lo = Math.floor(x), hi = Math.ceil(x), t = x - lo;
  return sorted[lo] * (1 - t) + sorted[hi] * t;
}
class AirGridPresentationDiagnostics {
  constructor({ windowFrames = 240 } = {}) {
    this.windowFrames = Math.max(16, windowFrames | 0);
    this.frames = [];
  }
  clear() { this.frames.length = 0; }
  noteFrame({ sequence, requestedHz, presentedAtMs, renderMs = 0 } = {}) {
    const at = Number.isFinite(presentedAtMs) ? presentedAtMs : (globalThis.performance?.now?.() ?? Date.now());
    this.frames.push({ sequence: Number(sequence), requestedHz: Number(requestedHz), at, renderMs: Number(renderMs) || 0 });
    if (this.frames.length > this.windowFrames) this.frames.splice(0, this.frames.length - this.windowFrames);
    return this.snapshot();
  }
  snapshot() {
    const intervals = [];
    let missedIntervals = 0;
    for (let i = 1; i < this.frames.length; i++) {
      const dt = this.frames[i].at - this.frames[i - 1].at;
      if (!(dt > 0)) continue;
      intervals.push(dt);
      const hz = this.frames[i].requestedHz || this.frames[i - 1].requestedHz;
      if (hz > 0) missedIntervals += Math.max(0, Math.round(dt / (1000 / hz)) - 1);
    }
    const p50 = quantile(intervals, 0.5);
    const requestedHz = quantile(this.frames.map(frame => frame.requestedHz).filter(value => value > 0), 0.5);
    const render = this.frames.map(frame => frame.renderMs);
    const budgetMs = requestedHz > 0 ? 1000 / requestedHz : 0;
    return {
      frames: this.frames.length,
      requestedHz,
      actualHz: p50 > 0 ? 1000 / p50 : 0,
      intervalP50Ms: p50,
      intervalP95Ms: quantile(intervals, 0.95),
      renderP50Ms: quantile(render, 0.5),
      renderP95Ms: quantile(render, 0.95),
      renderBudgetP95: budgetMs > 0 ? quantile(render, 0.95) / budgetMs : 0,
      missedIntervals,
      missedRate: intervals.length ? missedIntervals / (intervals.length + missedIntervals) : 0
    };
  }
}

export { AirGridPresentationDiagnostics };
