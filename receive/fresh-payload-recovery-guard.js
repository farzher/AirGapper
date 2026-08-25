import { GridLattice } from "./grid-lattice.js";
import { DecodeWorkerPool } from "../shared/worker-pool.js";

// A locked wall that is still producing CRC-valid payload does not need a
// global full-frame recovery scan. Weak/stale individual slots recover locally;
// only real decoder silence is allowed to spend a worker on robust reacquire.
const FRESH_PAYLOAD_HOLD_MS = 550;
let freshPayloadUntil = 0;

function noteFreshPayload(at) {
  const now = performance.now();
  const packetAt = Number(at);
  // detection.at is normally performance.now()-based. If a replay/custom clock
  // supplies something else, freshness is still established at receipt time.
  const base = Number.isFinite(packetAt) && Math.abs(now - packetAt) < 5000 ? Math.max(now, packetAt) : now;
  freshPayloadUntil = Math.max(freshPayloadUntil, base + FRESH_PAYLOAD_HOLD_MS);
}

const baseAccept = GridLattice.prototype.accept;
if (typeof baseAccept === "function" && !baseAccept.__airgapperFreshPayloadRecoveryGuard) {
  const accept = function(detection, frameWidth, frameHeight) {
    const result = baseAccept.call(this, detection, frameWidth, frameHeight);
    if (result && this.locked) noteFreshPayload(detection?.at);
    return result;
  };
  Object.defineProperty(accept, "__airgapperFreshPayloadRecoveryGuard", { value: true });
  GridLattice.prototype.accept = accept;
}

const baseNoteValidPacket = GridLattice.prototype.noteValidPacket;
if (typeof baseNoteValidPacket === "function" && !baseNoteValidPacket.__airgapperFreshPayloadRecoveryGuard) {
  const noteValidPacket = function(at = this.lastHitAt) {
    const accepted = baseNoteValidPacket.call(this, at);
    if (accepted && this.locked) noteFreshPayload(at);
    return accepted;
  };
  Object.defineProperty(noteValidPacket, "__airgapperFreshPayloadRecoveryGuard", { value: true });
  GridLattice.prototype.noteValidPacket = noteValidPacket;
}

function closeRejectedNativeFrame(message) {
  const frame = message?.videoFrame;
  if (typeof VideoFrame === "function" && frame instanceof VideoFrame) {
    try { frame.close(); } catch {}
    message.videoFrame = void 0;
  }
}

const baseSubmitAtSlot = DecodeWorkerPool.prototype.submitAtSlot;
if (typeof baseSubmitAtSlot === "function" && !baseSubmitAtSlot.__airgapperFreshPayloadRecoveryGuard) {
  const submitAtSlot = function(slot, message, transfer) {
    // acquisitionMode is present on both SEARCH acquisition and locked recovery.
    // Before first lock freshPayloadUntil is zero, so normal acquisition is
    // untouched. Once valid packets are flowing, reject only full robust scans;
    // tracked/guided work remains fully parallel.
    if (message?.full && message?.acquisitionMode && performance.now() < freshPayloadUntil) {
      closeRejectedNativeFrame(message);
      return false;
    }
    return baseSubmitAtSlot.call(this, slot, message, transfer);
  };
  Object.defineProperty(submitAtSlot, "__airgapperFreshPayloadRecoveryGuard", { value: true });
  DecodeWorkerPool.prototype.submitAtSlot = submitAtSlot;
}
