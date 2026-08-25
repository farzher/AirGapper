import { DecodeWorkerPool } from "../shared/worker-pool.js";

const PACKED_TRACK_BYTES = 56;
const PACKED_TRACK_WORDS = PACKED_TRACK_BYTES >> 2;
const PACKED_SYMBOL_BYTES = 88;
const DENSE_REPAIR_MIN_TRACKS = 12;
const MAX_TRACK_BUFFER_POOL = 16;
const MAX_RESULT_BUFFER_POOL = 16;
const MAX_CONCURRENT_NATIVE_COPIES = 2;
const receiveVideo = document.getElementById("video");
const packedTrackBufferPool = [];
const packedResultBufferPool = [];

// A rare damaged optical frame can drive Guided into a very slow synchronous
// WASM path. The pool's normal job timeout is the single timeout authority.
// Learn only from genuine tracked decode timeouts and temporarily reduce work on
// following frames; camera-copy stalls are transport failures and do not train
// decoder pressure.
let trackedTimeoutPressure = 0;
let trackedTimeoutCount = 0;
let trackedDecodeTimeoutCount = 0;
let trackedPreflightTimeoutCount = 0;
function noteTrackedTimeout(reachedPreflight) {
  trackedTimeoutCount++;
  if (!reachedPreflight) {
    trackedPreflightTimeoutCount++;
    return;
  }
  trackedDecodeTimeoutCount++;
  trackedTimeoutPressure = Math.min(1, trackedTimeoutPressure + (trackedTimeoutPressure ? 0.2 : 0.35));
}
function noteHealthyTrackedCompletion(message, meta) {
  if (!meta || meta.full || message?.error) return;
  const latency = Number(message?.latencyMs);
  const timeout = Number(meta.timeoutMs);
  if (!Number.isFinite(latency) || latency <= 0 || !Number.isFinite(timeout) || timeout <= 0) return;
  if (latency <= timeout * 0.25) {
    const useful = Number(message?.__airgapperPackedSymbolCount ?? message?.symbols?.length ?? 0) > 0;
    trackedTimeoutPressure = Math.max(0, trackedTimeoutPressure - (useful ? 0.08 : 0.04));
  }
}
function applyTimeoutBackpressure(message, live) {
  const tracks = message?.tracks;
  if (!live || message?.full || !Array.isArray(tracks) || tracks.length < 4 || trackedTimeoutPressure <= 0) return;
  const originalCount = tracks.length;
  const fraction = 1 - 0.6 * trackedTimeoutPressure;
  const limit = Math.max(4, Math.min(originalCount, Math.ceil(originalCount * fraction)));
  if (limit < originalCount) message.tracks = tracks.slice(0, limit);
  if (trackedTimeoutPressure >= 0.5) {
    message.guidedRepairMask = 0;
    message.guidedFallbackMask = 0;
  }
}

function liveReceiveCamera() {
  const cameraStream = receiveVideo?.srcObject;
  return document.body?.classList?.contains("receive-mode") === true && cameraStream?.active === true;
}

function addTransfer(transfer, value) {
  const list = Array.isArray(transfer) ? transfer : [];
  if (value && !list.includes(value)) list.push(value);
  return list;
}

function nativeFrame(value) {
  return typeof VideoFrame === "function" && value instanceof VideoFrame;
}

function closeMessageFrame(message) {
  if (!nativeFrame(message?.videoFrame)) return;
  try { message.videoFrame.close(); } catch {}
  message.videoFrame = void 0;
}

function activeNativeCopies(pool) {
  let count = 0;
  for (const meta of pool.activeMeta ?? []) {
    if (meta?.__airgapperNativeFrameCopy && !meta.__airgapperCopyComplete) count++;
  }
  return count;
}

function copyStageTimeout(meta) {
  const normal = Math.max(1, Number(meta?.timeoutMs) || 1);
  return Math.max(250, Math.min(600, normal * 0.20));
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
  if (bestIndex < 0) return new ArrayBuffer(bytes);
  const lastIndex = pool.length - 1;
  const buffer = pool[bestIndex];
  if (bestIndex !== lastIndex) pool[bestIndex] = pool[lastIndex];
  pool.pop();
  return buffer;
}

function recyclePackedTrackBuffer(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < PACKED_TRACK_BYTES || packedTrackBufferPool.length >= MAX_TRACK_BUFFER_POOL) return;
  packedTrackBufferPool.push(buffer);
}

function recyclePackedResultBuffer(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < PACKED_SYMBOL_BYTES || packedResultBufferPool.length >= MAX_RESULT_BUFFER_POOL) return;
  packedResultBufferPool.push(buffer);
}

function stripIdentityOutputMap(message) {
  const map = message?.outputMap;
  if (!map) return;
  if (Number(map.offsetX) === 0 && Number(map.offsetY) === 0 && Number(map.scaleX) === 1 && Number(map.scaleY) === 1) {
    message.outputMap = undefined;
  }
}

function keepTrackedCameraOnGuided(message, live) {
  if (live && message && !message.full && !message.strictHotPath && message.videoFrame &&
      Array.isArray(message.tracks) && message.tracks.length >= 2 &&
      (message.pixelFormat === "y8" || message.__airgapperWorkerLumaFromRgba)) {
    message.guidedDecode = true;
    message.__airgapperLiveTracked = true;
  }
}

function capDenseRepairMask(message, live) {
  const tracks = message?.tracks;
  if (!live || message?.full || !message?.guidedDecode || !Array.isArray(tracks) || tracks.length < DENSE_REPAIR_MIN_TRACKS) return;
  const laneMask = tracks.length >= 32 ? 0xffffffff : (2 ** tracks.length - 1) >>> 0;
  const requested = message.guidedRepairMask === undefined ? laneMask : Number(message.guidedRepairMask) >>> 0;
  const allowed = requested & laneMask;
  if (!allowed || (allowed & (allowed - 1)) === 0) return;
  const chosen = (allowed & -allowed) >>> 0;
  message.guidedRepairMask = chosen;
  if (message.guidedFallbackMask !== undefined)
    message.guidedFallbackMask = (Number(message.guidedFallbackMask) >>> 0) & chosen;
}

function attachPackedResultScratch(message, transfer) {
  const tracks = message?.tracks;
  if (!message?.__airgapperLiveTracked || !message?.repeatFilter || !Array.isArray(tracks) || tracks.length < 2) return transfer;
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

const baseFailureCompletion = DecodeWorkerPool.prototype.failureCompletion;
if (typeof baseFailureCompletion === "function" && !baseFailureCompletion.__airgapperStaleTrackedTimeout) {
  const failureCompletion = function(slot, full, latencyMs, error) {
    const completion = baseFailureCompletion.call(this, slot, full, latencyMs, error);
    if (!full && error === "Decode worker timed out") {
      completion.timedOut = true;
      completion.staleFrame = true;
      completion.error = undefined;
      completion.guidedError = undefined;
    }
    return completion;
  };
  Object.defineProperty(failureCompletion, "__airgapperStaleTrackedTimeout", { value: true });
  DecodeWorkerPool.prototype.failureCompletion = failureCompletion;
}

const baseTimeoutWorker = DecodeWorkerPool.prototype.timeoutWorker;
if (typeof baseTimeoutWorker === "function" && !baseTimeoutWorker.__airgapperWorkerPolicy) {
  const timeoutWorker = function(slot, meta) {
    if (meta?.__airgapperNativeFrameCopy) meta.__airgapperPreflight = Boolean(meta.__airgapperCopyComplete);
    if (!(this.activeFull?.[slot] ?? false)) noteTrackedTimeout(Boolean(meta?.__airgapperPreflight));
    return baseTimeoutWorker.call(this, slot, meta);
  };
  Object.defineProperty(timeoutWorker, "__airgapperWorkerPolicy", { value: true });
  DecodeWorkerPool.prototype.timeoutWorker = timeoutWorker;
}

const baseConfigureWorker = DecodeWorkerPool.prototype.configureWorker;
if (typeof baseConfigureWorker === "function" && !baseConfigureWorker.__airgapperWorkerPolicy) {
  const configureWorker = function(slot, worker) {
    baseConfigureWorker.call(this, slot, worker);
    worker.__airgapperCameraCopyWarm = false;
    const baseOnMessage = worker.onmessage;
    worker.onmessage = (event) => {
      const message = event?.data;
      const activeMeta = this.activeMeta?.[slot];
      if (message?.__airgapperCameraCopyComplete) {
        if (activeMeta && activeMeta.id === message.id) {
          activeMeta.__airgapperCopyComplete = true;
          activeMeta.__airgapperPreflight = true;
          // Same watchdog, next stage: the native camera buffer is released,
          // so the decoder gets its normal remaining budget.
          activeMeta.deadlineAt = performance.now() + Math.max(1, Number(activeMeta.timeoutMs) || 1);
          worker.__airgapperCameraCopyWarm = true;
        }
        return;
      }
      if (message?.preflight && activeMeta) activeMeta.__airgapperPreflight = true;
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
        if (!message?.preflight) noteHealthyTrackedCompletion(message, activeMeta);
      } finally {
        if (resultMeta instanceof ArrayBuffer) recyclePackedResultBuffer(resultMeta);
        if (unusedScratch instanceof ArrayBuffer && unusedScratch !== resultMeta) recyclePackedResultBuffer(unusedScratch);
        if (message) {
          delete message.__airgapperPackedSymbolScratchRecycle;
          delete message.__airgapperPackedSymbolMeta;
        }
      }
      return result;
    };
  };
  Object.defineProperty(configureWorker, "__airgapperWorkerPolicy", { value: true });
  DecodeWorkerPool.prototype.configureWorker = configureWorker;
}

const baseSubmitAtSlot = DecodeWorkerPool.prototype.submitAtSlot;
if (typeof baseSubmitAtSlot === "function" && !baseSubmitAtSlot.__airgapperWorkerPolicy) {
  const submitAtSlot = function(slot, message, transfer) {
    if (slot < 0 || slot >= this.workers.length || this.ready?.[slot] !== true || this.busy[slot]) {
      closeMessageFrame(message);
      return false;
    }

    const cameraLive = liveReceiveCamera();
    const native = nativeFrame(message?.videoFrame);
    const worker = this.workers?.[slot];
    // Capacity is a resource concern, not an acquisition-algorithm concern.
    // Every live full-frame job consumes a bounded acquisition lane while the
    // acquisition policy remains the sole owner of seed/fast/hunt/thorough mode.
    const fullAcquisition = Boolean(cameraLive && message?.full);
    const acquisitionConcurrency = this.workers.length >= 4 ? 2 : 1;
    if (fullAcquisition && this.activeFullCount >= acquisitionConcurrency) {
      closeMessageFrame(message);
      return false;
    }
    if (native && activeNativeCopies(this) >= MAX_CONCURRENT_NATIVE_COPIES) {
      closeMessageFrame(message);
      return false;
    }

    const candidate = message && !message.full && !message.strictHotPath;
    const live = Boolean(candidate && cameraLive);
    applyTimeoutBackpressure(message, live);
    if (live && !message.videoFrame && Array.isArray(message.tracks) && message.tracks.length >= 2 &&
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

    const accepted = baseSubmitAtSlot.call(this, slot, message, transfer);
    if (!accepted) {
      recycleUnsentBuffers(message);
      closeMessageFrame(message);
      return false;
    }

    const meta = this.activeMeta?.[slot];
    if (meta && meta.id === message.id) {
      meta.__airgapperPreflight = false;
      if (native) {
        meta.__airgapperNativeFrameCopy = true;
        meta.__airgapperCopyComplete = false;
        // Keep the first camera job on a newly-created decoder conservative.
        // After one proven copy, a later 250-600 ms copy stall is a wedged
        // camera buffer and the pool's existing watchdog can reclaim it.
        if (worker?.__airgapperCameraCopyWarm) {
          meta.deadlineAt = Math.min(meta.deadlineAt, meta.startedAt + copyStageTimeout(meta));
        }
      }
    }
    return true;
  };
  Object.defineProperty(submitAtSlot, "__airgapperWorkerPolicy", { value: true });
  DecodeWorkerPool.prototype.submitAtSlot = submitAtSlot;
}

window.airgapperTrackedTimeoutState = () => ({
  count: trackedTimeoutCount,
  decode: trackedDecodeTimeoutCount,
  preflight: trackedPreflightTimeoutCount,
  pressure: trackedTimeoutPressure
});

// worker-camera reports when native copyTo() releases the camera frame, then
// worker-rvfc owns the packed/live-camera adaptations. Copy completion is only
// an ownership/diagnostic signal; it never creates a second timeout authority.
const NativeWorker = globalThis.Worker;
if (typeof NativeWorker === "function" && !NativeWorker.__airgapperDecodeWorkerGuard) {
  const rewriteWorkerUrl = (input) => {
    try {
      const url = input instanceof URL ? new URL(input.href) : new URL(String(input), location.href);
      if (url.pathname.endsWith("/receive/worker.js")) {
        url.pathname = url.pathname.slice(0, -"worker.js".length) + "worker-camera.js";
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
  Object.defineProperty(AirGapperWorker, "__airgapperDecodeWorkerGuard", { value: true });
  try { globalThis.Worker = AirGapperWorker; } catch {}
}