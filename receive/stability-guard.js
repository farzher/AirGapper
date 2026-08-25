import { GridLattice } from "./grid-lattice.js";

const FRESH_PAYLOAD_HOLD_MS = 550;
window.airgapperFreshPayloadUntil = 0;

function noteFreshPayload(at) {
  const now = performance.now();
  const packetAt = Number(at);
  const base = Number.isFinite(packetAt) && Math.abs(now - packetAt) < 5000
    ? Math.max(now, packetAt)
    : now;
  window.airgapperFreshPayloadUntil = Math.max(
    Number(window.airgapperFreshPayloadUntil) || 0,
    base + FRESH_PAYLOAD_HOLD_MS
  );
}

// CRC-valid payload is authoritative liveness. Geometry fitting may reject a
// noisy/stale quad, but that must not age a still-decoding wall into recovery.
const baseAccept = GridLattice.prototype.accept;
GridLattice.prototype.accept = function(detection, frameWidth, frameHeight) {
  const at = Number(detection?.at);
  if (this.candidate && Number.isFinite(at)) this.noteValidPacket(at);
  const snapshot = baseAccept.call(this, detection, frameWidth, frameHeight);
  if (snapshot && Number.isFinite(at)) {
    this.noteValidPacket(at);
    snapshot.state = this.state;
    snapshot.provisional = !this.active;
  }
  return snapshot;
};

const baseNoteValidPacket = GridLattice.prototype.noteValidPacket;
GridLattice.prototype.noteValidPacket = function(at = this.lastHitAt) {
  const accepted = baseNoteValidPacket.call(this, at);
  if (accepted && this.locked) noteFreshPayload(at);
  return accepted;
};
