import { DecodeWorkerPool } from "../shared/worker-pool.js";

// Native VideoFrames hold scarce camera buffers until copyTo() finishes in the
// decode worker. A few simultaneous slow copies can pin the whole camera buffer
// pool and collapse TrackProcessor delivery even though QR decoding itself is
// healthy. Keep decode parallelism, but bound only the tiny preflight/copy stage:
// once a worker posts preflight it has copied and closed its VideoFrame and no
// longer counts against this limit.
const MAX_CONCURRENT_NATIVE_COPIES = 2;

function isNativeVideoFrame(value) {
  return typeof VideoFrame === "function" && value instanceof VideoFrame;
}

function activeNativeCopies(pool) {
  let count = 0;
  const active = pool.activeMeta;
  if (!Array.isArray(active)) return 0;
  for (const meta of active) {
    if (meta?.__airgapperNativeFrameCopy && meta.__airgapperPreflight === false) count++;
  }
  return count;
}

const baseSubmitAtSlot = DecodeWorkerPool.prototype.submitAtSlot;
if (typeof baseSubmitAtSlot === "function" && !baseSubmitAtSlot.__airgapperCameraCopyGuard) {
  const submitAtSlot = function(slot, message, transfer) {
    const nativeFrame = isNativeVideoFrame(message?.videoFrame);
    if (nativeFrame && activeNativeCopies(this) >= MAX_CONCURRENT_NATIVE_COPIES) return false;

    const accepted = baseSubmitAtSlot.call(this, slot, message, transfer);
    if (!accepted) return false;

    if (nativeFrame) {
      const meta = this.activeMeta?.[slot];
      if (meta && meta.id === message.id) {
        meta.__airgapperNativeFrameCopy = true;
        // worker-capacity-guard owns the preflight transition. Set the initial
        // state here as well so this guard remains correct if wrapper order ever
        // changes.
        if (meta.__airgapperPreflight === undefined) meta.__airgapperPreflight = false;
      }
    }
    return true;
  };
  Object.defineProperty(submitAtSlot, "__airgapperCameraCopyGuard", { value: true });
  DecodeWorkerPool.prototype.submitAtSlot = submitAtSlot;
}
