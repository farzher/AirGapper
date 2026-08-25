import { DecodeWorkerPool } from "../shared/worker-pool.js";

// Live SEARCH/REACQUIRE must never let multiple native full-frame camera jobs
// monopolize the decoder pool. A wedged VideoFrame.copyTo() otherwise occupies
// every worker until the long recovery timeout while the camera itself keeps
// delivering frames normally.
const ACQUISITION_TIMEOUT_MS = 1500;

const baseSubmitAtSlot = DecodeWorkerPool.prototype.submitAtSlot;
DecodeWorkerPool.prototype.submitAtSlot = function(slot, message, transfer) {
  const liveAcquisition = Boolean(message?.full && message?.acquisitionMode);
  if (liveAcquisition && this.activeFullCount >= 1) return false;

  const accepted = baseSubmitAtSlot.call(this, slot, message, transfer);
  if (!accepted || !liveAcquisition) return accepted;

  const meta = this.activeMeta?.[slot];
  if (meta && this.activeIds?.[slot] === message.id) {
    meta.timeoutMs = Math.min(Number(meta.timeoutMs) || ACQUISITION_TIMEOUT_MS, ACQUISITION_TIMEOUT_MS);
    meta.deadlineAt = meta.startedAt + meta.timeoutMs;
  }
  return accepted;
};
