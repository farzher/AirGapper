const TRACKED_JOB_TIMEOUT_MS = 2200;
const RECOVERY_JOB_TIMEOUT_MS = 6500;
const ACQUISITION_JOB_TIMEOUT_MS = 9000;
const WORKER_WATCHDOG_MS = 250;
const PACKED_SYMBOL_BYTES = 88;
let receiveVideo;

function workerJobTimeout(message) {
  if (!message?.full) return TRACKED_JOB_TIMEOUT_MS;
  return message.acquisitionMode === "thorough" ? ACQUISITION_JOB_TIMEOUT_MS : RECOVERY_JOB_TIMEOUT_MS;
}

function liveReceiveCamera() {
  if (typeof document === "undefined") return false;
  receiveVideo ??= document.getElementById("video");
  return document.body?.classList?.contains("receive-mode") === true &&
    receiveVideo?.srcObject?.active === true;
}

function addTransfer(transfer, value) {
  const list = Array.isArray(transfer) ? transfer : [];
  if (value && !list.includes(value)) list.push(value);
  return list;
}

function packedMode(code) {
  return code === 0 ? "direct" : code === 1 ? "mds" : code === 2 ? "raptorq" : "";
}

function packedDecodePath(code) {
  return code === 3 ? "fallback" : code === 2 ? "sparse" : code === 4 ? "robust" : "hot";
}

/** Safari/iOS currently reaches Receive through requestVideoFrameCallback +
 * canvas ImageData rather than the transferable VideoFrame/Y8 camera path.
 * Once geometry is known, keeping those tracked crops as RGBA needlessly locks
 * the worker onto the slower generic decoder. The live worker wrapper can
 * compact green->Y8 in-place after ownership transfer, so this fallback must
 * never allocate a second full Y plane on the browser main thread. */
function prepareTrackedBrowserY8(message, transfer) {
  // The normal TrackProcessor path is already a direct VideoFrame/Y8 payload.
  // Test cheap message state before touching DOM/camera state.
  if (message?.full || message?.videoFrame || message?.strictHotPath || !liveReceiveCamera()) return transfer;
  if (!Array.isArray(message?.tracks) || message.tracks.length < 2) return transfer;
  if (message.pixelFormat && message.pixelFormat !== "rgba") return transfer;
  if (!(message.buf instanceof ArrayBuffer)) return transfer;
  const width = Math.trunc(Number(message.w) || 0);
  const height = Math.trunc(Number(message.h) || 0);
  const pixels = width * height;
  if (width <= 0 || height <= 0 || pixels <= 0 || message.buf.byteLength < pixels * 4) return transfer;

  const rgba = message.buf;
  message.buf = void 0;
  message.videoFrame = rgba;
  message.__airgapperWorkerLumaFromRgba = true;
  message.pixelFormat = "rgba";
  message.payloadBytes = pixels;
  message.guidedDecode = true;
  return addTransfer(transfer, rgba);
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
    this.resizeGeneration = 0;
    this.lastNonZeroSize = 1;
    this.watchdog = void 0;
    // Normal live decode consumes this synchronously. Reuse it for every symbol
    // instead of allocating one metadata object per QR. Optimizer-attributed jobs
    // use a dedicated object because runtime may intentionally retain it.
    this.decodeInfo = {};
    this.packedSymbolPools = [];
    this.packedSymbolLists = [];
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
  ensureWatchdog() {
    if (this.watchdog !== void 0 || this.workers.length === 0) return;
    this.watchdog = setInterval(() => this.checkTimeouts(), WORKER_WATCHDOG_MS);
  }
  stopWatchdog() {
    if (this.watchdog === void 0) return;
    clearInterval(this.watchdog);
    this.watchdog = void 0;
  }
  checkTimeouts() {
    if (!this.workers.length) {
      this.stopWatchdog();
      return;
    }
    const now = performance.now();
    for (let slot = 0; slot < this.activeMeta.length; slot++) {
      const meta = this.activeMeta[slot];
      if (!meta || !this.busy[slot] || !(meta.deadlineAt > 0) || now < meta.deadlineAt) continue;
      this.timeoutWorker(slot, meta);
    }
  }
  timeoutWorker(slot, meta) {
    const activeId = this.activeIds[slot];
    if (activeId === void 0 || activeId !== meta.id || !this.workers[slot]) return;
    const full = this.activeFull[slot] ?? false;
    const failed = this.workers[slot];
    const timeoutMs = meta.timeoutMs;
    this.busy[slot] = false;
    this.activeIds[slot] = void 0;
    this.activeFull[slot] = false;
    this.activeMeta[slot] = null;
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
  }
  packedSymbol(slot, index) {
    let pool = this.packedSymbolPools[slot];
    if (!pool) pool = this.packedSymbolPools[slot] = [];
    let symbol = pool[index];
    if (!symbol) {
      symbol = { header: {} };
      pool[index] = symbol;
    }
    return symbol;
  }
  unpackPackedSymbols(slot, message) {
    const meta = message.__airgapperPackedSymbolMeta;
    const payload = message.__airgapperPackedSymbolPayload;
    const count = Math.trunc(Number(message.__airgapperPackedSymbolCount) || 0);
    if (!(meta instanceof ArrayBuffer) || !(payload instanceof ArrayBuffer) || count <= 0 ||
        meta.byteLength < count * PACKED_SYMBOL_BYTES) return null;
    let list = this.packedSymbolLists[slot];
    if (!list) list = this.packedSymbolLists[slot] = [];
    list.length = count;
    const view = new DataView(meta);
    for (let index = 0; index < count; index++) {
      const base = index * PACKED_SYMBOL_BYTES;
      const byteOffset = view.getUint32(base, true);
      const byteLength = view.getUint32(base + 4, true);
      if (byteLength <= 0 || byteOffset + byteLength > payload.byteLength) return null;
      const symbol = this.packedSymbol(slot, index);
      const flags = view.getUint8(base + 10);
      const header = symbol.header;
      header.mode = packedMode(view.getUint8(base + 12));
      header.seq = view.getUint32(base + 20, true);
      header.layoutId = view.getUint8(base + 13);
      header.extendedGrid = Boolean(flags & 16);
      header.gridCols = view.getUint8(base + 14);
      header.gridRows = view.getUint8(base + 15);
      header.slotIndex = view.getUint16(base + 16, true);
      header.k = view.getUint32(base + 24, true);
      header.blockLen = view.getUint32(base + 28, true);
      header.totalLen = view.getUint32(base + 32, true);
      header.payloadId = view.getUint32(base + 36, true);
      symbol.bytes = new Uint8Array(payload, byteOffset, byteLength);
      symbol.modules = view.getUint16(base + 8, true);
      symbol.tracked = Boolean(flags & 1);
      symbol.geometryMeasured = Boolean(flags & 2);
      symbol.crc32 = Boolean(flags & 4);
      symbol.verifiedPayload = Boolean(flags & 8);
      symbol.decodePath = packedDecodePath(view.getUint8(base + 11));
      // Motion is coherent whole-wall evidence; onDecoded consumes at most the
      // first source-sequence report. Carry one object per frame, not per QR.
      symbol.wallMotion = index === 0 ? message.__airgapperPackedWallMotion : undefined;
      if (symbol.geometryMeasured) {
        // Measured geometry can be retained by GridLattice observations, so
        // these <=4 records deliberately receive fresh point/quad objects. The
        // remaining payload-only QRs allocate none of this geometry graph.
        symbol.box = {
          x: view.getFloat32(base + 40, true),
          y: view.getFloat32(base + 44, true),
          w: view.getFloat32(base + 48, true),
          h: view.getFloat32(base + 52, true)
        };
        symbol.quad = {
          topLeft: { x: view.getFloat32(base + 56, true), y: view.getFloat32(base + 60, true) },
          topRight: { x: view.getFloat32(base + 64, true), y: view.getFloat32(base + 68, true) },
          bottomRight: { x: view.getFloat32(base + 72, true), y: view.getFloat32(base + 76, true) },
          bottomLeft: { x: view.getFloat32(base + 80, true), y: view.getFloat32(base + 84, true) }
        };
      } else {
        symbol.box = undefined;
        symbol.quad = undefined;
      }
      list[index] = symbol;
    }
    return list;
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
      const packedSymbols = this.unpackPackedSymbols(slot, message);
      const symbols = packedSymbols ?? message.symbols ?? [];
      const sightings = message.sightings ?? [];
      const jobMeta = this.activeMeta[slot];
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
        error: message.error ?? (message.__airgapperPackedSymbolMeta && !packedSymbols ? "Packed worker result was invalid" : undefined)
      };
      try {
        if (message.trackedAttempted) this.onTrackedAttempt?.();
        const reusableInfo = jobMeta?.opticsEpoch === void 0 ? this.decodeInfo : null;
        for (const symbol of symbols) {
          const info = reusableInfo ?? {};
          info.scanId = message.id;
          info.sourceSequence = jobMeta?.sourceSequence;
          info.opticsEpoch = jobMeta?.opticsEpoch;
          info.quad = symbol.quad;
          info.modules = symbol.modules;
          info.tracked = symbol.tracked;
          info.geometryMeasured = symbol.geometryMeasured !== false;
          info.wallMotion = symbol.wallMotion;
          info.decodePath = symbol.decodePath;
          info.crc32 = symbol.crc32;
          info.verifiedPayload = Boolean(symbol.verifiedPayload);
          info.header = symbol.header;
          this.onDecoded(symbol.bytes, symbol.box, info);
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
      this.packedSymbolPools.pop();
      this.packedSymbolLists.pop();
    }
    while (this.workers.length < target) {
      const slot = this.workers.length;
      const worker = this.create();
      this.workers.push(worker);
      this.busy.push(false);
      this.activeIds.push(void 0);
      this.activeFull.push(false);
      this.activeMeta.push(null);
      this.packedSymbolPools.push([]);
      this.packedSymbolLists.push([]);
      this.configureWorker(slot, worker);
    }
    if (target > 0) this.ensureWatchdog();
    else this.stopWatchdog();

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
    const timeoutMs = workerJobTimeout(message);
    this.activeMeta[slot] = {
      id: typeof id === "number" ? id : void 0,
      kind: message.jobKind ?? (message.full ? "full" : "tracked"),
      full: Boolean(message.full),
      tracks: Number(message.trackCount ?? message.tracks?.length ?? 0),
      pixels: Math.max(0, Number(message.w) || 0) * Math.max(0, Number(message.h) || 0),
      sourceSequence: typeof message.sourceSequence === "number" ? message.sourceSequence : void 0,
      opticsEpoch: typeof message.opticsEpoch === "number" ? message.opticsEpoch : void 0,
      startedAt,
      timeoutMs,
      deadlineAt: startedAt + timeoutMs
    };
    try {
      if (message && typeof message === "object") message.sentAt = startedAt;
      transfer = prepareTrackedBrowserY8(message, transfer);
      this.workers[slot].postMessage(message, transfer);
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