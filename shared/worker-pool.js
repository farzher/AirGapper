var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
const WORKER_JOB_TIMEOUT_MS = 12e3;
class DecodeWorkerPool {
  constructor(create, onDecoded, onSighted, onTrackedAttempt, onCompleted) {
    this.create = create;
    this.onDecoded = onDecoded;
    this.onSighted = onSighted;
    this.onTrackedAttempt = onTrackedAttempt;
    this.onCompleted = onCompleted;
    __publicField(this, "workers", []);
    __publicField(this, "busy", []);
    __publicField(this, "activeIds", []);
    __publicField(this, "activeFull", []);
    __publicField(this, "jobTimers", []);
    __publicField(this, "jobOptics", /* @__PURE__ */ new Map());
  }
  get size() {
    return this.workers.length;
  }
  get busyCount() {
    return this.busy.filter(Boolean).length;
  }
  configureWorker(slot, worker) {
    worker.onmessage = (event) => {
      var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j;
      if (this.workers[slot] !== worker) return;
      const message = event.data;
      if (message.id === -1) return;
      if (this.activeIds[slot] !== message.id) return;
      const symbols = (_a = message.symbols) != null ? _a : [];
      const sightings = (_b = message.sightings) != null ? _b : [];
      const jobOptics = this.jobOptics.get(message.id);
      this.jobOptics.delete(message.id);
      clearTimeout(this.jobTimers[slot]);
      this.jobTimers[slot] = void 0;
      this.busy[slot] = false;
      this.activeIds[slot] = void 0;
      this.activeFull[slot] = false;
      const completion = {
        full: Boolean(message.full),
        symbolCount: symbols.length,
        sightingCount: sightings.length,
        trackedAttempted: Boolean(message.trackedAttempted),
        trackedHit: Boolean(message.trackedHit),
        fallbackAttempted: Boolean(message.fallbackAttempted),
        fallbackSucceeded: Boolean(message.fallbackSucceeded),
        readFullAttempts: (_c = message.readFullAttempts) != null ? _c : 0,
        workerWaitMs: (_d = message.workerWaitMs) != null ? _d : 0,
        targetedAttempts: (_e = message.targetedAttempts) != null ? _e : 0,
        targetedPixels: (_f = message.targetedPixels) != null ? _f : 0,
        targetedSuccesses: (_g = message.targetedSuccesses) != null ? _g : 0,
        latencyMs: (_h = message.latencyMs) != null ? _h : 0,
        symbols,
        sightings,
        error: message.error
      };
      try {
        if (message.trackedAttempted) (_i = this.onTrackedAttempt) == null ? void 0 : _i.call(this);
        for (const symbol of symbols) {
          this.onDecoded(symbol.bytes, symbol.box, {
            scanId: message.id,
            sourceSequence: jobOptics == null ? void 0 : jobOptics.sourceSequence,
            opticsEpoch: jobOptics == null ? void 0 : jobOptics.opticsEpoch,
            quad: symbol.quad,
            modules: symbol.modules,
            tracked: symbol.tracked,
            crc32: symbol.crc32
          });
        }
        if (this.onSighted) for (const sighting of sightings) this.onSighted(sighting, message.id);
      } finally {
        (_j = this.onCompleted) == null ? void 0 : _j.call(this, message.id, completion);
      }
    };
    worker.onerror = (event) => {
      var _a, _b;
      if (this.workers[slot] !== worker) return;
      const id = this.activeIds[slot];
      const full = (_a = this.activeFull[slot]) != null ? _a : false;
      clearTimeout(this.jobTimers[slot]);
      this.jobTimers[slot] = void 0;
      this.busy[slot] = id === void 0;
      this.activeIds[slot] = void 0;
      this.activeFull[slot] = false;
      if (id !== void 0) this.jobOptics.delete(id);
      (_b = this.onCompleted) == null ? void 0 : _b.call(this, id != null ? id : -1, {
        full,
        symbolCount: 0,
        sightingCount: 0,
        trackedAttempted: false,
        trackedHit: false,
        fallbackAttempted: false,
        fallbackSucceeded: false,
        readFullAttempts: 0,
        workerWaitMs: 0,
        targetedAttempts: 0,
        targetedPixels: 0,
        targetedSuccesses: 0,
        latencyMs: 0,
        symbols: [],
        sightings: [],
        error: event.message || "Decode worker failed to start"
      });
      worker.terminate();
      if (id !== void 0) {
        const replacement = this.create();
        this.workers[slot] = replacement;
        this.configureWorker(slot, replacement);
      }
    };
  }
  /** Grow or shrink in place. Terminating a busy worker drops its disposable
   * frame during teardown; active operation always receives a completion. */
  resize(count) {
    while (this.workers.length > Math.max(0, count)) {
      this.workers.pop().terminate();
      this.busy.pop();
      this.activeIds.pop();
      this.activeFull.pop();
      clearTimeout(this.jobTimers.pop());
    }
    while (this.workers.length < count) {
      const slot = this.workers.length;
      const worker = this.create();
      this.workers.push(worker);
      this.busy.push(false);
      this.activeIds.push(void 0);
      this.activeFull.push(false);
      this.jobTimers.push(void 0);
      this.configureWorker(slot, worker);
    }
  }
  /** Worker slots that can accept a job right now. Exposed so dense-grid
   * schedulers can preserve per-worker native tracking affinity instead of
   * randomly moving a persistent QR batch between WASM instances. */
  get freeSlots() {
    const slots = [];
    for (let slot = 0; slot < this.workers.length; slot++) if (!this.busy[slot]) slots.push(slot);
    return slots;
  }
  submitAtSlot(slot, message, transfer) {
    var _a, _b;
    if (slot < 0 || slot >= this.workers.length || this.busy[slot]) return false;
    const id = message.id;
    this.busy[slot] = true;
    this.activeIds[slot] = typeof id === "number" ? id : void 0;
    this.activeFull[slot] = Boolean(message.full);
    if (typeof id === "number") {
      const metadata = message;
      this.jobOptics.set(id, {
        sourceSequence: typeof metadata.sourceSequence === "number" ? metadata.sourceSequence : void 0,
        opticsEpoch: typeof metadata.opticsEpoch === "number" ? metadata.opticsEpoch : void 0
      });
    }
    try {
      if (message && typeof message === "object") message.sentAt = performance.now();
      this.workers[slot].postMessage(message, transfer);
      this.jobTimers[slot] = setTimeout(() => {
        var _a2, _b2;
        const activeId = this.activeIds[slot];
        if (this.workers[slot] === void 0 || activeId === void 0 || activeId !== id) return;
        const full = (_a2 = this.activeFull[slot]) != null ? _a2 : false;
        this.jobOptics.delete(activeId);
        const failed = this.workers[slot];
        this.busy[slot] = false;
        this.activeIds[slot] = void 0;
        this.activeFull[slot] = false;
        this.jobTimers[slot] = void 0;
        (_b2 = this.onCompleted) == null ? void 0 : _b2.call(this, activeId, {
          full,
          symbolCount: 0,
          sightingCount: 0,
          trackedAttempted: false,
          trackedHit: false,
          fallbackAttempted: false,
          fallbackSucceeded: false,
          readFullAttempts: 0,
          workerWaitMs: 0,
          targetedAttempts: 0,
          targetedPixels: 0,
          targetedSuccesses: 0,
          latencyMs: WORKER_JOB_TIMEOUT_MS,
          symbols: [],
          sightings: [],
          error: "Decode worker timed out"
        });
        failed.terminate();
        const replacement = this.create();
        this.workers[slot] = replacement;
        this.configureWorker(slot, replacement);
      }, WORKER_JOB_TIMEOUT_MS);
      return true;
    } catch (error) {
      const full = (_a = this.activeFull[slot]) != null ? _a : false;
      this.busy[slot] = false;
      this.activeIds[slot] = void 0;
      this.activeFull[slot] = false;
      if (typeof id === "number") this.jobOptics.delete(id);
      if (typeof id === "number") (_b = this.onCompleted) == null ? void 0 : _b.call(this, id, {
        full,
        symbolCount: 0,
        sightingCount: 0,
        trackedAttempted: false,
        trackedHit: false,
        fallbackAttempted: false,
        fallbackSucceeded: false,
        readFullAttempts: 0,
        workerWaitMs: 0,
        targetedAttempts: 0,
        targetedPixels: 0,
        targetedSuccesses: 0,
        latencyMs: 0,
        symbols: [],
        sightings: [],
        error: error instanceof Error ? error.message : "Could not send frame to decode worker"
      });
      return false;
    }
  }
  /** Submit to a specific free worker. This is intentionally strict: callers
   * requesting affinity would rather drop a disposable camera frame than
   * destroy another worker's warm native geometry cache. */
  submitTo(slot, message, transfer) {
    return Number.isInteger(slot) && this.submitAtSlot(slot, message, transfer);
  }
  /** Hand a frame to any free worker. False when every worker is busy — the
   * caller drops the frame rather than queueing it, because a stale frame is
   * worth less than the next one. */
  submit(message, transfer) {
    const slot = this.busy.indexOf(false);
    return slot !== -1 && this.submitAtSlot(slot, message, transfer);
  }
}
export {
  DecodeWorkerPool
};
