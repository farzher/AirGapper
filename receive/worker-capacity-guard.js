import { DecodeWorkerPool } from "../shared/worker-pool.js";

const PACKED_TRACK_BYTES = 56;
const PACKED_TRACK_WORDS = PACKED_TRACK_BYTES >> 2;
const PACKED_SYMBOL_BYTES = 88;
const DENSE_REPAIR_MIN_TRACKS = 12;
const MAX_TRACK_BUFFER_POOL = 16;
const MAX_RESULT_BUFFER_POOL = 16;
const TRACKED_JOB_TIMEOUT_MS = 2200;
const RECOVERY_JOB_TIMEOUT_MS = 6500;
const ACQUISITION_JOB_TIMEOUT_MS = 9000;
const receiveVideo = document.getElementById("video");
const packedTrackBufferPool = [];
const packedResultBufferPool = [];

function liveReceiveCamera() {
  const cameraStream = receiveVideo?.srcObject;
  return document.body?.classList?.contains("receive-mode") === true &&
    cameraStream?.active === true;
}

function workerJobTimeout(message) {
  if (!message?.full) return TRACKED_JOB_TIMEOUT_MS;
  return message.acquisitionMode === "thorough" ? ACQUISITION_JOB_TIMEOUT_MS : RECOVERY_JOB_TIMEOUT_MS;
}

function addTransfer(transfer, value) {
  const list = Array.isArray(transfer) ? transfer : [];
  if (value && !list.includes(value)) list.push(value);
  return list;
}

function takeBestFitBuffer(pool, bytes) {
  let bestIndex = -1;
  let bestSize = Infinity;
  for (let index = 0; index < pool.length; index++) {
    const size = pool[index].byteLength;
    if (size >= bytes && size < bestSize) {
      bestIndex = index;
      bestSize = size;
    }
  }
  return bestIndex >= 0 ? pool.splice(bestIndex, 1)[0] : new ArrayBuffer(bytes);
}

function recyclePackedTrackBuffer(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < PACKED_TRACK_BYTES ||
      packedTrackBufferPool.length >= MAX_TRACK_BUFFER_POOL) return;
  packedTrackBufferPool.push(buffer);
}

function recyclePackedResultBuffer(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < PACKED_SYMBOL_BYTES ||
      packedResultBufferPool.length >= MAX_RESULT_BUFFER_POOL) return;
  packedResultBufferPool.push(buffer);
}

function stripIdentityOutputMap(message) {
  const map = message?.outputMap;
  if (!map) return;
  if (Number(map.offsetX) === 0 && Number(map.offsetY) === 0 &&
      Number(map.scaleX) === 1 && Number(map.scaleY) === 1) {
    // worker.js otherwise rebuilds a quad (four point objects) and a box for
    // every decoded QR just to apply this no-op transform.
    message.outputMap = undefined;
  }
}

function keepTrackedCameraOnGuided(message, live) {
  if (live && message && !message.full && !message.strictHotPath &&
      message.videoFrame && Array.isArray(message.tracks) && message.tracks.length >= 2 &&
      (message.pixelFormat === "y8" || message.__airgapperWorkerLumaFromRgba)) {
    message.guidedDecode = true;
    message.__airgapperLiveTracked = true;
  }
}

function capDenseRepairMask(message, live) {
  const tracks = message?.tracks;
  if (!live || message?.full || !message?.guidedDecode ||
      !Array.isArray(tracks) || tracks.length < DENSE_REPAIR_MIN_TRACKS) return;
  const laneMask = tracks.length >= 32 ? 0xffffffff : (2 ** tracks.length - 1) >>> 0;
  const requested = message.guidedRepairMask === undefined
    ? laneMask
    : Number(message.guidedRepairMask) >>> 0;
  const allowed = requested & laneMask;
  if (!allowed || (allowed & (allowed - 1)) === 0) return;
  // RaptorQ already treats a missing QR as an erasure. On a dense wall, bound
  // expensive ambiguity repair to one best candidate and spend the rest of the
  // budget on the next fresh camera frame.
  message.guidedRepairMask = (allowed & -allowed) >>> 0;
}

function attachPackedResultScratch(message, transfer) {
  const tracks = message?.tracks;
  if (!message?.__airgapperLiveTracked || !message?.repeatFilter ||
      !Array.isArray(tracks) || tracks.length < 2) return transfer;
  const scratch = takeBestFitBuffer(packedResultBufferPool, tracks.length * PACKED_SYMBOL_BYTES);
  message.__airgapperPackedSymbolScratch = scratch;
  return addTransfer(transfer, scratch);
}

function packTracks(message, transfer) {
  const tracks = message?.tracks;
  if (message?.full || !message?.videoFrame || !Array.isArray(tracks) || tracks.length < 2) return transfer;
  const count = tracks.length;
  const usedBytes = count * PACKED_TRACK_BYTES;
  const packed = takeBestFitBuffer(packedTrackBufferPool, usedBytes);
  const i32 = new Int32Array(packed);
  const f32 = new Float32Array(packed);
  for (let index = 0; index < count; index++) {
    const track = tracks[index];
    const q = track?.quad;
    if (!q?.topLeft || !q?.topRight || !q?.bottomRight || !q?.bottomLeft) {
      recyclePackedTrackBuffer(packed);
      return transfer;
    }
    const base = index * PACKED_TRACK_WORDS;
    i32[base] = Math.trunc(Number(track.id) || 0);
    i32[base + 1] = Number.isInteger(track.slot) ? track.slot : -1;
    i32[base + 2] = Math.trunc(Number(track.misses) || 0);
    i32[base + 3] = Math.trunc(Number(track.dim) || 0);
    i32[base + 4] = Number(Boolean(track.crc32)) | (Number(Boolean(track.temporalProbe)) << 1);
    f32[base + 5] = Number(track.temporalRisk) || 0;
    f32[base + 6] = Number(q.topLeft.x);
    f32[base + 7] = Number(q.topLeft.y);
    f32[base + 8] = Number(q.topRight.x);
    f32[base + 9] = Number(q.topRight.y);
    f32[base + 10] = Number(q.bottomRight.x);
    f32[base + 11] = Number(q.bottomRight.y);
    f32[base + 12] = Number(q.bottomLeft.x);
    f32[base + 13] = Number(q.bottomLeft.y);
  }
  message.__airgapperPackedTracks = packed;
  message.__airgapperPackedTrackCount = count;
  // DecodeWorkerPool records this after our wrapper runs. Preserve the count so
  // latency/cost samples and the adaptive track-budget controller do not see a
  // packed job as a zero-track job.
  message.trackCount = count;
  message.tracks = undefined;
  return addTransfer(transfer, packed);
}

function recycleUnsentBuffers(message) {
  const tracks = message?.__airgapperPackedTracks;
  const result = message?.__airgapperPackedSymbolScratch;
  if (tracks instanceof ArrayBuffer && tracks.byteLength) recyclePackedTrackBuffer(tracks);
  if (result instanceof ArrayBuffer && result.byteLength) recyclePackedResultBuffer(result);
}

function reusableJobMeta(pool, slot) {
  let metas = pool.__airgapperJobMetaReuse;
  if (!metas) metas = pool.__airgapperJobMetaReuse = [];
  let meta = metas[slot];
  if (!meta) meta = metas[slot] = {};
  return meta;
}

// Packed track descriptors are only needed long enough for worker-rvfc.js to
// unpack them into its reusable track objects. The worker transfers that tiny
// buffer back with the final result; compact result metadata follows the same
// ping-pong pattern. After warm-up neither direction allocates a metadata buffer
// at camera cadence.
const baseConfigureWorker = DecodeWorkerPool.prototype.configureWorker;
if (typeof baseConfigureWorker === "function" && !baseConfigureWorker.__airgapperPackedBufferRecycle) {
  const configureWorker = function(slot, worker) {
    baseConfigureWorker.call(this, slot, worker);
    const baseOnMessage = worker.onmessage;
    worker.onmessage = (event) => {
      const message = event?.data;
      const recycledTrack = message?.__airgapperPackedTrackRecycle;
      if (recycledTrack instanceof ArrayBuffer) {
        recyclePackedTrackBuffer(recycledTrack);
        delete message.__airgapperPackedTrackRecycle;
      }
      const resultMeta = message?.__airgapperPackedSymbolMeta;
      const unusedScratch = message?.__airgapperPackedSymbolScratchRecycle;
      let result;
      try {
        result = baseOnMessage?.call(worker, event);
      } finally {
        // shared/worker-pool.js has synchronously unpacked resultMeta before the
        // base handler returns, so it can immediately become the next worker's
        // scratch buffer. If a frame produced no packed result, the worker sends
        // the unused scratch back under the dedicated recycle field instead.
        if (resultMeta instanceof ArrayBuffer) recyclePackedResultBuffer(resultMeta);
        if (unusedScratch instanceof ArrayBuffer && unusedScratch !== resultMeta)
          recyclePackedResultBuffer(unusedScratch);
        if (message) {
          delete message.__airgapperPackedSymbolScratchRecycle;
          // Keep no stale event reference to a pooled buffer.
          delete message.__airgapperPackedSymbolMeta;
        }
      }
      return result;
    };
  };
  Object.defineProperty(configureWorker, "__airgapperPackedBufferRecycle", { value: true });
  DecodeWorkerPool.prototype.configureWorker = configureWorker;
}

// Replace the pool's submission body rather than wrapping it at the end. The
// stock implementation creates a fresh activeMeta object for every camera job;
// one worker slot can only own one job at a time, so reuse one record per slot.
// This duplicates only the small public bookkeeping contract of worker-pool.js;
// timeout values intentionally match that module exactly.
const baseSubmitAtSlot = DecodeWorkerPool.prototype.submitAtSlot;
if (typeof baseSubmitAtSlot === "function" && !baseSubmitAtSlot.__airgapperRvfclumaGuard) {
  const submitAtSlot = function(slot, message, transfer) {
    if (slot < 0 || slot >= this.workers.length || this.busy[slot]) return false;

    const candidate = message && !message.full && !message.strictHotPath;
    const live = Boolean(candidate && liveReceiveCamera());
    if (live && !message.videoFrame &&
        Array.isArray(message.tracks) && message.tracks.length >= 2 &&
        (!message.pixelFormat || message.pixelFormat === "rgba") && message.buf instanceof ArrayBuffer) {
      const rgba = message.buf;
      const width = Math.trunc(Number(message.w) || 0);
      const height = Math.trunc(Number(message.h) || 0);
      if (width > 0 && height > 0 && rgba.byteLength >= width * height * 4) {
        message.buf = undefined;
        message.videoFrame = rgba;
        message.__airgapperWorkerLumaFromRgba = true;
        message.pixelFormat = "rgba";
        message.payloadBytes = width * height;
        message.guidedDecode = true;
        transfer = addTransfer(transfer, rgba);
      }
    }
    stripIdentityOutputMap(message);
    keepTrackedCameraOnGuided(message, live);
    capDenseRepairMask(message, live);
    transfer = attachPackedResultScratch(message, transfer);
    transfer = packTracks(message, transfer);

    const id = message.id;
    const numericId = typeof id === "number" ? id : void 0;
    const full = Boolean(message.full);
    const startedAt = performance.now();
    const timeoutMs = workerJobTimeout(message);
    const meta = reusableJobMeta(this, slot);
    meta.id = numericId;
    meta.kind = message.jobKind ?? (full ? "full" : "tracked");
    meta.full = full;
    meta.tracks = Number(message.trackCount ?? message.tracks?.length ?? 0);
    meta.pixels = Math.max(0, Number(message.w) || 0) * Math.max(0, Number(message.h) || 0);
    meta.sourceSequence = typeof message.sourceSequence === "number" ? message.sourceSequence : void 0;
    meta.opticsEpoch = typeof message.opticsEpoch === "number" ? message.opticsEpoch : void 0;
    meta.startedAt = startedAt;
    meta.timeoutMs = timeoutMs;
    meta.deadlineAt = startedAt + timeoutMs;

    this.busy[slot] = true;
    this.activeIds[slot] = numericId;
    this.activeFull[slot] = full;
    this.activeMeta[slot] = meta;
    try {
      if (message && typeof message === "object") message.sentAt = startedAt;
      this.workers[slot].postMessage(message, transfer);
      return true;
    } catch (error) {
      this.busy[slot] = false;
      this.activeIds[slot] = void 0;
      this.activeFull[slot] = false;
      this.activeMeta[slot] = null;
      recycleUnsentBuffers(message);
      if (numericId !== void 0) this.onCompleted?.(numericId, {
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
  };
  Object.defineProperty(submitAtSlot, "__airgapperRvfclumaGuard", { value: true });
  DecodeWorkerPool.prototype.submitAtSlot = submitAtSlot;
}

// Every AirGapper decode worker uses the live-camera wrapper. Preserve the
// build/scalar query string so it imports the exact same codec variant.
const NativeWorker = globalThis.Worker;
if (typeof NativeWorker === "function" && !NativeWorker.__airgapperRvfclumaWorkerGuard) {
  const rewriteWorkerUrl = (input) => {
    try {
      const url = input instanceof URL ? new URL(input.href) : new URL(String(input), location.href);
      if (url.pathname.endsWith("/receive/worker.js")) {
        url.pathname = url.pathname.slice(0, -"worker.js".length) + "worker-rvfc.js";
      }
      return url;
    } catch {
      return input;
    }
  };
  function AirGapperWorker(url, options) {
    return new NativeWorker(rewriteWorkerUrl(url), options);
  }
  AirGapperWorker.prototype = NativeWorker.prototype;
  try { Object.setPrototypeOf(AirGapperWorker, NativeWorker); } catch {}
  Object.defineProperty(AirGapperWorker, "__airgapperRvfclumaWorkerGuard", { value: true });
  try { globalThis.Worker = AirGapperWorker; } catch {}
}

// Do not override DecodeWorkerPool.resize() here. runtime.js owns the adaptive
// worker controller and intentionally grows/shrinks based on source FPS,
// measured latency and sustained pressure. A former 8-core guard silently
// forced Auto to seven workers even while the controller believed its target
// was 2-5, which defeated feedback, multiplied WASM/cache memory and reduced
// per-worker temporal locality. Manual worker counts remain untouched.
