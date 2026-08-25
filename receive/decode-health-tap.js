import "./user-overlay.js";
import {
  noteDecodeGeometry,
  noteDecodeLatticeState,
  noteDecodeSuccess,
  resetDecodeHealth
} from "./decode-health.js";

const overlay = globalThis.__airgapperUserOverlay;

function wrap(name, before) {
  const original = overlay?.[name];
  if (typeof original !== "function") return;
  overlay[name] = function (...args) {
    before(...args);
    return original.apply(this, args);
  };
}

if (overlay && !overlay.__airgapperDecodeHealthTap) {
  Object.defineProperty(overlay, "__airgapperDecodeHealthTap", {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });

  wrap("success", (slot) => noteDecodeSuccess(slot));
  wrap("geometry", (snapshot, usable) => noteDecodeGeometry(snapshot, usable));
  wrap("latticeState", (state) => noteDecodeLatticeState(state));
  wrap("reset", () => resetDecodeHealth());
}
