const TRACKED_JOB_TIMEOUT_MS = 2200;
const RECOVERY_JOB_TIMEOUT_MS = 6500;
const ACQUISITION_JOB_TIMEOUT_MS = 9000;
const WORKER_WATCHDOG_MS = 250;
const PACKED_SYMBOL_BYTES = 88;
const PACKED_SYMBOL_WORDS = PACKED_SYMBOL_BYTES >> 2;
const EMPTY_SYMBOLS = Object.freeze([]);
const EMPTY_SIGHTINGS = Object.freeze([]);
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
    // onAvailable() may synchronously schedule the next job before the current
    // completion has finished consuming jobMeta. Keep two metadata records per
    // slot and alternate them so both jobs can overlap in JS without allocation.
    this.metaRecords = [];
    this.metaRecordNext = [];
    this.resizeGeneration = 0;
    this.lastNonZeroSize = 1;
    this.watchdog = void 0;
    // Normal live decode consumes this synchronously. Reuse it for every symbol
    // instead of allocating one metadata object per QR. Optimizer-attributed jobs
    // use a dedicated object because runtime may intentionally retain it.
    this.decodeInfo = {};
    this.packedSymbolPools = [];
    this.packedSymbolLists = [];
    // A worker slot can finish only one job at a time. Runtime consumes these
    // synchronously, so keep mutable summary/preflight records per slot instead
    // of allocating callback envelopes at camera cadence.
    this.completions = [];
    this.frameSignatureInfos = [];
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
  completionFor(slot) {
    let completion = this.completions[slot];
    if (!completion) completion = this.completions[slot] = {};
    return completion;
  }
  failureCompletion(slot, full, latencyMs, error) {
    const completion = this.completionFor(slot);
    completion.full = Boolean(full);
    completion.symbolCount = 0;
    completion.sightingCount = 0;
    completion.trackedAttempted = false;
    completion.trackedHit = false;
    completion.fallbackAttempted = false;
    completion.fallbackSucceeded = false;
    completion.readFullAttempts = 0;
    completion.workerWaitMs = 0;
    completion.targetedAttempts = 0;
    completion.targetedPixels = 0;
    completion.targetedSuccesses = 0;
    completion.latencyMs = latencyMs;
    completion.frameCopyMs = 0;
    completion.directMetrics = undefined;
    completion.guidedMetrics = undefined;
    completion.guidedError = undefined;
    completion.pixelPath = undefined;
    completion.robustMs = 0;
    completion.robustBands = 1;
    completion.robustSearchMs = 0;
    completion.exactFastPath = false;
    completion.directFrameFailed = false;
    completion.repeatSkipped = false;
    completion.repeatDistance = NaN;
    completion.symbols = EMPTY_SYMBOLS;
    completion.sightings = EMPTY_SIGHTINGS;
    completion.error = error;
    return completion;
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
    this.onCompleted?.(
      activeId,
      this.failureCompletion(slot, full, timeoutMs, "Decode worker timed out")
    );
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
    const u32 = new Uint32Array(meta);
    const f32 = new Float32Array(meta);
    for (let index = 0; index < count; index++) {
      const base = index * PACKED_SYMBOL_WORDS;
      const byteOffset = u32[base];
      const byteLength = u32[base + 1];
      if (byteLength <= 0 || byteOffset + byteLength > payload.byteLength) return null;
      const symbol = this.packedSymbol(slot, index);
      const control0 = u32[base + 3];
      const control1 = u32[base + 4];
      const flags = control0 & 255;
      const header = symbol.header;
      header.mode = packedMode(control0 >>> 16 & 255);
      header.seq = u32[base + 5];
      header.layoutId = control0 >>> 24 & 255;
      header.extendedGrid = Boolean(flags & 16);
      header.gridCols = control1 & 255;
      header.gridRows = control1 >>> 8 & 255;
      header.slotIndex = control1 >>> 16 & 0xffff;
      header.k = u32[base + 6];
      header.blockLen = u32[base + 7];
      header.totalLen = u32[base + 8];
      header.payloadId = u32[base + 9];
      symbol.bytes = new Uint8Array(payload, byteOffset, byteLength);
      symbol.modules = u32[base + 2];
      symbol.tracked = Boolean(flags & 1);
      symbol.geometryMeasured = Boolean(flags & 2);
      symbol.crc32 = Boolean(flags & 4);
      symbol.verifiedPayload = Boolean(flags & 8);
      symbol.decodePath = packedDecodePath(control0 >>> 8 & 255);
      // Motion is coherent whole-wall evidence; onDecoded consumes at most the
      // first source-sequence report. Carry one object per frame, not per QR.
      symbol.wallMotion = index === 0 ? message.__airgapperPackedWallMotion : undefined;
      if (symbol.geometryMeasured) {
        // Measured geometry can be retained by GridLattice observations, so
        // these <=4 records deliberately receive fresh point/quad objects. The
        // remaining payload-only QRs allocate none of this geometry graph.
        symbol.box = {
          x: f32[base + 10],
          y: f32[base + 11],
          w: f32[base + 12],
          h: f32[base + 13]
        };
        symbol.quad = {
          topLeft: { x: f32[base + 14], y: f32[base + 15] },
          topRight: { x: f32[base + 16], y: f32[base + 17] },
          bottomRight: { x: f32[base + 18], y: f32[base + 19] },
          bottomLeft: { x: f32[base + 20], y: f32[base + 21] }
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
        const info = this.frameSignatureInfos[slot];
        info.id = message.id;
        info.sourceSequence = message.sourceSequence;
        info.signature = message.frameSignature;
        this.onFrameSignature?.(info);
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
      const completion = this.completionFor(slot);
      completion.full = Boolean(message.full);
      completion.symbolCount = symbols.length;
      completion.sightingCount = sightings.length;
      completion.trackedAttempted = Boolean(message.trackedAttempted);
      completion.trackedHit = Boolean(message.trackedHit);
      completion.fallbackAttempted = Boolean(message.fallbackAttempted);
      completion.fallbackSucceeded = Boolean(message.fallbackSucceeded);
      completion.readFullAttempts = message.readFullAttempts ?? 0;
      completion.workerWaitMs = message.workerWaitMs ?? 0;
      completion.targetedAttempts = message.targetedAttempts ?? 0;
      completion.targetedPixels = message.targetedPixels ?? 0;
      completion.targetedSuccesses = message.targetedSuccesses ?? 0;
      completion.latencyMs = message.latencyMs ?? 0;
      completion.frameCopyMs = message.frameCopyMs ?? 0;
      completion.directMetrics = message.directMetrics;
      completion.guidedMetrics = message.guidedMetrics;
      completion.guidedError = message.guidedError;
      completion.pixelPath = message.pixelPath;
      completion.robustMs = message.robustMs ?? 0;
      completion.robustBands = message.robustBands ?? 1;
      completion.robustSearchMs = message.robustSearchMs ?? 0;
      completion.exactFastPath = Boolean(message.exactFastPath);
      completion.directFrameFailed = Boolean(message.directFrameFailed);
      completion.repeatSkipped = Boolean(message.repeatSkipped);
      completion.repeatDistance = Number(message.repeatDistance);
      completion.symbols = symbols;
      completion.sightings = sightings;
      completion.error = message.error ??
        (message.__airgapperPackedSymbolMeta && !packedSymbols ? "Packed worker result was invalid" : undefined);
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
      this.onCompleted?.(
        id ?? -1,
        this.failureCompletion(slot, full, 0, event.message || "Decode worker failed to start")
      );
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
      this.metaRecords.pop();
      this.metaRecordNext.pop();
      this.packedSymbolPools.pop();
      this.packedSymbolLists.pop();
      this.completions.pop();
      this.frameSignatureInfos.pop();
    }
    while (this.workers.length < target) {
      const slot = this.workers.length;
      const worker = this.create();
      this.workers.push(worker);
      this.busy.push(false);
      this.activeIds.push(void 0);
      this.activeFull.push(false);
      this.activeMeta.push(null);
      this.metaRecords.push([{}, {}]);
      this.metaRecordNext.push(0);
      this.packedSymbolPools.push([]);
      this.packedSymbolLists.push([]);
      this.completions.push({});
      this.frameSignatureInfos.push({});
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
    const recordIndex = this.metaRecordNext[slot];
    this.metaRecordNext[slot] = recordIndex ^ 1;
    const meta = this.metaRecords[slot][recordIndex];
    meta.id = typeof id === "number" ? id : void 0;
    meta.kind = message.jobKind ?? (message.full ? "full" : "tracked");
    meta.full = Boolean(message.full);
    meta.tracks = Number(message.trackCount ?? message.tracks?.length ?? 0);
    meta.pixels = Math.max(0, Number(message.w) || 0) * Math.max(0, Number(message.h) || 0);
    meta.sourceSequence = typeof message.sourceSequence === "number" ? message.sourceSequence : void 0;
    meta.opticsEpoch = typeof message.opticsEpoch === "number" ? message.opticsEpoch : void 0;
    meta.startedAt = startedAt;
    meta.timeoutMs = timeoutMs;
    meta.deadlineAt = startedAt + timeoutMs;
    this.activeMeta[slot] = meta;
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
      if (typeof id === "number") {
        const message = error instanceof Error ? error.message : "Could not send frame to decode worker";
        this.onCompleted?.(id, this.failureCompletion(slot, full, 0, message));
      }
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
