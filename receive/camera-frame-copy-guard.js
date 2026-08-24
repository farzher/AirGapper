import { DecodeWorkerPool } from "../shared/worker-pool.js";

// Native VideoFrames hold scarce camera buffers until copyTo() finishes in the
// decode worker. A few simultaneous slow copies can pin the whole camera buffer
// pool and collapse TrackProcessor delivery even though QR decoding itself is
// healthy. Keep decode parallelism, but bound only the copy stage: once the
// worker reports copy-complete it has released the native frame and the normal
// decoder timeout takes over.
const MAX_CONCURRENT_NATIVE_COPIES = 2;

function isNativeVideoFrame(value) {
  return typeof VideoFrame === "function" && value instanceof VideoFrame;
}

function activeNativeCopies(pool) {
  let count = 0;
  const active = pool.activeMeta;
  if (!Array.isArray(active)) return 0;
  for (const meta of active) {
    if (meta?.__airgapperNativeFrameCopy && !meta.__airgapperCopyComplete) count++;
  }
  return count;
}

function copyStageTimeout(meta) {
  const normal = Math.max(1, Number(meta?.timeoutMs) || 1);
  // Scale from the normal job budget instead of a camera FPS/device rule. Copy
  // should be a small prefix of a decode job; retain generous bounds for slow
  // devices while reclaiming a genuinely wedged camera buffer far before the
  // multi-second decoder watchdog.
  return Math.max(250, Math.min(600, normal * 0.20));
}

const baseConfigureWorker = DecodeWorkerPool.prototype.configureWorker;
if (typeof baseConfigureWorker === "function" && !baseConfigureWorker.__airgapperCameraCopyStage) {
  const configureWorker = function(slot, worker) {
    baseConfigureWorker.call(this, slot, worker);
    worker.__airgapperCameraCopyWarm = false;
    const baseOnMessage = worker.onmessage;
    worker.onmessage = (event) => {
      const message = event?.data;
      if (message?.__airgapperCameraCopyComplete) {
        const meta = this.activeMeta?.[slot];
        if (meta && meta.id === message.id) {
          meta.__airgapperCopyComplete = true;
          // worker-capacity-guard historically called this boundary preflight.
          // Keep that diagnostic/backpressure contract, now backed by an exact
          // copyTo-complete signal instead of the optional repeat signature.
          meta.__airgapperPreflight = true;
          meta.deadlineAt = performance.now() + Math.max(1, Number(meta.timeoutMs) || 1);
          worker.__airgapperCameraCopyWarm = true;
        }
        return;
      }
      return baseOnMessage?.call(worker, event);
    };
  };
  Object.defineProperty(configureWorker, "__airgapperCameraCopyStage", { value: true });
  DecodeWorkerPool.prototype.configureWorker = configureWorker;
}

const baseTimeoutWorker = DecodeWorkerPool.prototype.timeoutWorker;
if (typeof baseTimeoutWorker === "function" && !baseTimeoutWorker.__airgapperCameraCopyStage) {
  const timeoutWorker = function(slot, meta) {
    if (meta?.__airgapperNativeFrameCopy) {
      // Make the existing stale-timeout split exact: false means the native
      // frame never finished copying; true means the frame was already closed
      // and any later stall belongs to decode/WASM.
      meta.__airgapperPreflight = Boolean(meta.__airgapperCopyComplete);
    }
    return baseTimeoutWorker.call(this, slot, meta);
  };
  Object.defineProperty(timeoutWorker, "__airgapperCameraCopyStage", { value: true });
  DecodeWorkerPool.prototype.timeoutWorker = timeoutWorker;
}

const baseSubmitAtSlot = DecodeWorkerPool.prototype.submitAtSlot;
if (typeof baseSubmitAtSlot === "function" && !baseSubmitAtSlot.__airgapperCameraCopyGuard) {
  const submitAtSlot = function(slot, message, transfer) {
    const nativeFrame = isNativeVideoFrame(message?.videoFrame);
    if (nativeFrame && activeNativeCopies(this) >= MAX_CONCURRENT_NATIVE_COPIES) return false;

    const worker = this.workers?.[slot];
    const accepted = baseSubmitAtSlot.call(this, slot, message, transfer);
    if (!accepted) return false;

    if (nativeFrame) {
      const meta = this.activeMeta?.[slot];
      if (meta && meta.id === message.id) {
        meta.__airgapperNativeFrameCopy = true;
        meta.__airgapperCopyComplete = false;
        meta.__airgapperPreflight = false;
        // Never apply the short copy deadline to a newly created worker: its
        // first job may still be compiling/initializing WASM before copyTo().
        // After one proven copy, future camera-buffer stalls are safe to reclaim
        // quickly. Copy-complete restores the full decoder deadline above.
        if (worker?.__airgapperCameraCopyWarm) {
          meta.deadlineAt = Math.min(meta.deadlineAt, meta.startedAt + copyStageTimeout(meta));
        }
      }
    }
    return true;
  };
  Object.defineProperty(submitAtSlot, "__airgapperCameraCopyGuard", { value: true });
  DecodeWorkerPool.prototype.submitAtSlot = submitAtSlot;
}

// worker-capacity-guard already routes worker.js through worker-rvfc.js. Wrap
// that route one level earlier so camera workers install the exact copy-stage
// signal before worker-rvfc imports the real decoder. Passing worker-camera.js
// through the prior Worker wrapper avoids a second rewrite.
const PriorWorker = globalThis.Worker;
if (typeof PriorWorker === "function" && !PriorWorker.__airgapperCameraCopyWorker) {
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
  function CameraCopyWorker(url, options) {
    return new PriorWorker(rewriteWorkerUrl(url), options);
  }
  CameraCopyWorker.prototype = PriorWorker.prototype;
  try { Object.setPrototypeOf(CameraCopyWorker, PriorWorker); } catch {}
  Object.defineProperty(CameraCopyWorker, "__airgapperCameraCopyWorker", { value: true });
  try { globalThis.Worker = CameraCopyWorker; } catch {}
}
