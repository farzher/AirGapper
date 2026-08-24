import { GridLattice } from "./grid-lattice.js";

const baseAccept = GridLattice.prototype.accept;
if (typeof baseAccept === "function" && !baseAccept.__airgapperCrcLiveness) {
  const accept = function(detection, frameWidth, frameHeight) {
    const at = Number(detection?.at);

    // Runtime reaches GridLattice.accept only after the AirGapper packet CRC and
    // stream identity have been accepted. That is strong wall-presence evidence
    // even when this particular quad is too stale/noisy to update geometry.
    // Refresh liveness BEFORE geometry acceptance so a rejected fit cannot age a
    // still-decoding wall into DORMANT/acquisition.
    if (this.candidate && Number.isFinite(at)) this.noteValidPacket(at);

    const snapshot = baseAccept.call(this, detection, frameWidth, frameHeight);
    if (snapshot && Number.isFinite(at)) {
      // The first valid packet may have created the candidate above, so refresh
      // once after acceptance as well. Geometry itself still changes only in
      // accept/nudge; this call updates presence/liveness only.
      this.noteValidPacket(at);
      snapshot.state = this.state;
      snapshot.provisional = !this.active;
    }
    return snapshot;
  };
  Object.defineProperty(accept, "__airgapperCrcLiveness", { value: true });
  GridLattice.prototype.accept = accept;
}
