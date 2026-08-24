const TRACKED_JOB_TIMEOUT_MS = 2200;
const RECOVERY_JOB_TIMEOUT_MS = 6500;
const ACQUISITION_JOB_TIMEOUT_MS = 9000;

function workerJobTimeout(message) {
  if (!message?.full) return TRACKED_JOB_TIMEOUT_MS;
  return message.acquisitionMode === "thorough" ? ACQUISITION_JOB_TIMEOUT_MS : RECOVERY_JOB_TIMEOUT_MS;
}

function liveReceiveCamera() {
  if (typeof document === "undefined") return false;
  const video = document.getElementById("video");
  const tracks = video?.srcObject?.getVideoTracks?.() ?? [];
  return document.body?.classList?.contains("receive-mode") === true &&
    tracks.some((track) => track?.readyState === "live");
}

/** Safari/iOS currently reaches Receive through requestVideoFrameCallback +
 * canvas ImageData rather than the transferable VideoFrame/Y8 camera path.
 * Once geometry is known, keeping those tracked crops as RGBA needlessly locks
 * the worker onto the slower generic decoder. AirGapper QRs are achromatic, so
 * the green channel is a clean luma proxy and is materially cheaper than a
 * weighted RGB conversion. Convert only live tracked batches with 2+ known QRs;
 * full acquisition/recovery images keep their existing robust RGBA path. */
function prepareTrackedBrowserY8(message, transfer) {
  if (!liveReceiveCamera() || message?.full || message?.videoFrame || message?.strictHotPath) return transfer;
  if (!Array.isArray(message?.tracks) || message.tracks.length < 2) return transfer;
  if (message.pixelFormat && message.pixelFormat !== "rgba") return transfer;
  if (!(message.buf instanceof ArrayBuffer)) return transfer;
  const width = Math.trunc(Number(message.w) || 0);
  const height = Math.trunc(Number(message.h) || 0);
  const pixels = width * height;
  if (width <= 0 || height <= 0 || pixels <= 0 || message.buf.byteLength < pixels * 4) return transfer;

  const rgba = new Uint8Array(message.buf, 0, pixels * 4);
  const y8 = new Uint8Array(pixels);
  // Camera QR content is black/white; green is both the highest-SNR Bayer
  // channel and an adequate luminance proxy. One byte read + one byte write per
  // pixel keeps this fallback cheap enough for iPhone's live tracked crops.
  for (let dst = 0, src = 1; dst < pixels; dst++, src += 4) y8[dst] = rgba[src];

  // The decode worker deliberately distinguishes a direct camera/Y8 payload
  // from an ordinary buffered image. Sending this fallback through `buf` made
  // the pixels Y8 but left `usedDirectFrame` false, so the worker skipped the
  // Guided tracked lane and spent its time in dense/robust recovery. Route the
  // packed Y plane through the existing direct-frame ArrayBuffer slot instead.
  message.buf = void 0;
  message.videoFrame = y8.buffer;
  message.pixelFormat = "y8";
  message.yOffset = 0;
  message.yStride = width;
  message.payloadBytes = pixels;
  message.guidedDecode = true;
  return [y8.buffer];
}

class DecodeWorkerPool {
  constructor(create, onDecoded, onSighted, onTrackedAttempt, onCompleted, onAvailable, onFrameSignature) {
    this.create = create;
    this.onDecoded = onDecoded;
    this.onSighted = onSighted;
    this.onTrackedAttempt = onTrackedAttempt;
    this.onCompleted = onCompleted;
    this.onAvailable = onAvailable;
    this.onFrameSignature = onFrameSignature;
    this.workers = [];
    this.busy = [];
    this.activeIds = [];
    this.activeFull = [];
    this.activeMeta = [];
    this.jobTimers = [];
    this.resizeGeneration = 0;
    this.lastNonZeroSize = 1;
  }
  get size() {
    return this.workers.length;
  }
  get busyCount() {
    let count = 0;
    for (let index = 0; index < this.busy.length; index++) count += Number(this.busy[index]);
    return count;
  }
  get activeCount() {
    return this.busyCount;
  }
  get activeFullCount() {
    let count = 0;
    for (let index = 0; index < this.busy.length; index++) {
      if (this.busy[index] && this.activeFull[index]) count++;
    }
    return count;
  }
  get oldestActiveAgeMs() {
    const now = performance.now();
    let oldest = 0;
    for (const meta of this.activeMeta) {
      if (meta) oldest = Math.max(oldest, now - meta.startedAt);
    }
    return oldest;
  }
  configureWorker(slot, worker) {
    worker.onmessage = (event) => {
      if (this.workers[slot] !== worker) return;
      const message = event.data;
      if (message.id === -1) return;
      if (this.activeIds[slot] !== message.id) return;
      if (message.preflight) {
        this.onFrameSignature?.({
          id: message.id,
          sourceSequence: message.sourceSequence,
          signature: message.frameSignature
        });
        return;
      }
      const symbols = message.symbols ?? [];
      const sightings = message.sightings ?? [];
      const jobMeta = this.activeMeta[slot];
      clearTimeout(this.jobTimers[slot]);
      this.jobTimers[slot] = void 0;
      this.busy[slot] = false;
      this.activeIds[slot] = void 0;
      this.activeFull[slot] = false;
      this.activeMeta[slot] = null;
      this.onAvailable?.(slot);
      const completion = {
        full: Boolean(message.full),
        symbolCount: symbols.length,
        sightingCount: sightings.length,
        trackedAttempted: Boolean(message.trackedAttempted),
        trackedHit: Boolean(message.trackedHit),
        fallbackAttempted: Boolean(message.fallbackAttempted),
        fallbackSucceeded: Boolean(message.fallbackSucceeded),
        readFullAttempts: message.readFullAttempts ?? 0,
        workerWaitMs: message.workerWaitMs ?? 0,
        targetedAttempts: message.targetedAttempts ?? 0,
        targetedPixels: message.targetedPixels ?? 0,
        targetedSuccesses: message.targetedSuccesses ?? 0,
        latencyMs: message.latencyMs ?? 0,
        frameCopyMs: message.frameCopyMs ?? 0,
        directMetrics: message.directMetrics,
        guidedMetrics: message.guidedMetrics,
        guidedError: message.guidedError,
        pixelPath: message.pixelPath,
        robustMs: message.robustMs ?? 0,
        robustBands: message.robustBands ?? 1,
        robustSearchMs: message.robustSearchMs ?? 0,
        exactFastPath: Boolean(message.exactFastPath),
        directFrameFailed: Boolean(message.directFrameFailed),
        repeatSkipped: Boolean(message.repeatSkipped),
        repeatDistance: Number(message.repeatDistance),
        symbols,
        sightings,
        error: message.error
      };
      try {
        if (message.trackedAttempted) this.onTrackedAttempt?.();
        for (const symbol of symbols) {
          this.onDecoded(symbol.bytes, symbol.box, {
            scanId: message.id,
            sourceSequence: jobMeta?.sourceSequence,
            opticsEpoch: jobMeta?.opticsEpoch,
            quad: symbol.quad,
            modules: symbol.modules,
            tracked: symbol.tracked,
            geometryMeasured: symbol.geometryMeasured !== false,
            wallMotion: symbol.wallMotion,
            decodePath: symbol.decodePath,
            crc32: symbol.crc32,
            verifiedPayload: Boolean(symbol.verifiedPayload),
            header: symbol.header
          });
        }
        if (this.onSighted) for (const sighting of sightings) this.onSighted(sighting, message.id);
      } finally {
        this.onCompleted?.(message.id, completion);
      }
    };
    worker.onerror = (event) => {
      if (this.workers[slot] !== worker) return;
      const id = this.activeIds[slot];
      const full = this.activeFull[slot] ?? false;
      clearTimeout(this.jobTimers[slot]);
      this.jobTimers[slot] = void 0;
      this.busy[slot] = false;
      this.activeIds[slot] = void 0;
      this.activeFull[slot] = false;
      this.activeMeta[slot] = null;
      this.onCompleted?.(id ?? -1, {
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
      const replacement = this.create();
      this.workers[slot] = replacement;
      this.configureWorker(slot, replacement);
    };
  }
  /** Grow or shrink in place. Terminating a busy worker drops its disposable
   * frame during teardown; active operation always receives a completion. */
  resize(count) {
    const target = Math.max(0, Math.trunc(Number(count) || 0));
    const generation = ++this.resizeGeneration;
    if (target > 0) this.lastNonZeroSize = target;

    while (this.workers.length > target) {
      this.workers.pop().terminate();
      this.busy.pop();
      this.activeIds.pop();
      this.activeFull.pop();
      this.activeMeta.pop();
      clearTimeout(this.jobTimers.pop());
    }
    while (this.workers.length < target) {
      const slot = this.workers.length;
      const worker = this.create();
      this.workers.push(worker);
      this.busy.push(false);
      this.activeIds.push(void 0);
      this.activeFull.push(false);
      this.activeMeta.push(null);
      this.jobTimers.push(void 0);
      this.configureWorker(slot, worker);
    }

    // A live receiver must never remain at 0 workers: captureFrame treats a
    // zero-size pool as fully saturated (0 busy === 0 size), which otherwise
    // drops every camera frame forever. Intended restart sequences call
    // resize(0) followed synchronously by resize(N), invalidating this token.
    // Stop/pause/finish have no live video track, so they remain at zero.
    if (target === 0) {
      queueMicrotask(() => {
        if (generation !== this.resizeGeneration || this.workers.length !== 0 || !liveReceiveCamera()) return;
        this.resize(Math.max(1, this.lastNonZeroSize));
      });
    }
  }
  /** Live worker ownership for diagnostics. Ages are measured from postMessage,
   * so a long-running job cannot masquerade as an unexplained scanner stall. */
  get activeJobs() {
    const now = performance.now();
    return this.activeMeta.flatMap((meta, slot) => meta ? [{ ...meta, slot, ageMs: Math.max(0, now - meta.startedAt) }] : []);
  }
  /** Worker slots that can accept a job right now. Exposed so dense-grid
   * schedulers can preserve per-worker decoder-cache affinity instead of
   * randomly moving a persistent QR batch between WASM instances. */
  get freeSlots() {
    const slots = [];
    for (let slot = 0; slot < this.workers.length; slot++) if (!this.busy[slot]) slots.push(slot);
    return slots;
  }
  submitAtSlot(slot, message, transfer) {
    if (slot < 0 || slot >= this.workers.length || this.busy[slot]) return false;
    const id = message.id;
    this.busy[slot] = true;
    this.activeIds[slot] = typeof id === "number" ? id : void 0;
    this.activeFull[slot] = Boolean(message.full);
    const startedAt = performance.now();
    this.activeMeta[slot] = {
      id: typeof id === "number" ? id : void 0,
      kind: message.jobKind ?? (message.full ? "full" : "tracked"),
      full: Boolean(message.full),
      tracks: Number(message.trackCount ?? message.tracks?.length ?? 0),
      pixels: Math.max(0, Number(message.w) || 0) * Math.max(0, Number(message.h) || 0),
      sourceSequence: typeof message.sourceSequence === "number" ? message.sourceSequence : void 0,
      opticsEpoch: typeof message.opticsEpoch === "number" ? message.opticsEpoch : void 0,
      startedAt
    };
    try {
      if (message && typeof message === "object") message.sentAt = startedAt;
      transfer = prepareTrackedBrowserY8(message, transfer);
      this.workers[slot].postMessage(message, transfer);
      const timeoutMs = workerJobTimeout(message);
      this.jobTimers[slot] = setTimeout(() => {
        const activeId = this.activeIds[slot];
        if (this.workers[slot] === void 0 || activeId === void 0 || activeId !== id) return;
        const full = this.activeFull[slot] ?? false;
        const failed = this.workers[slot];
        this.busy[slot] = false;
        this.activeIds[slot] = void 0;
        this.activeFull[slot] = false;
        this.activeMeta[slot] = null;
        this.jobTimers[slot] = void 0;
        this.onCompleted?.(activeId, {
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
          latencyMs: timeoutMs,
          symbols: [],
          sightings: [],
          error: "Decode worker timed out"
        });
        failed.terminate();
        const replacement = this.create();
        this.workers[slot] = replacement;
        this.configureWorker(slot, replacement);
      }, timeoutMs);
      return true;
    } catch (error) {
      const full = this.activeFull[slot] ?? false;
      this.busy[slot] = false;
      this.activeIds[slot] = void 0;
      this.activeFull[slot] = false;
      this.activeMeta[slot] = null;
      if (typeof id === "number") this.onCompleted?.(id, {
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
   * destroy another worker's warm decoder geometry cache. */
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