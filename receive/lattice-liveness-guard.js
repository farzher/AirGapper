import { GridLattice } from "./grid-lattice.js";

const baseAccept = GridLattice.prototype.accept;
if (typeof baseAccept === "function" && !baseAccept.__airgapperCrcLiveness) {
  const accept = function(detection, frameWidth, frameHeight) {
    const snapshot = baseAccept.call(this, detection, frameWidth, frameHeight);
    const at = Number(detection?.at);
    if (snapshot && Number.isFinite(at)) {
      // A CRC-valid measured QR proves the retained wall is alive just as
      // strongly as a predicted-geometry QR. Refresh liveness for both paths;
      // geometry itself still changes only through accept/nudge.
      this.noteValidPacket(at);
      snapshot.state = this.state;
      snapshot.provisional = !this.active;
    }
    return snapshot;
  };
  Object.defineProperty(accept, "__airgapperCrcLiveness", { value: true });
  GridLattice.prototype.accept = accept;
}
