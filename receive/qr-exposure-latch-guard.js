// Stability-first Auto Optics policy: once a verified QR has locked the receiver
// while the camera is already on a motion-safe manual shutter, keep that sensor
// state for the rest of the camera session. The first QR must not immediately
// trigger another exposure tournament: some Android HALs can synchronously stall
// the page on repeated sensor mutations even though continuous autofocus is fine.
const MAX_LATCH_EXPOSURE = 50; // 5 ms; exposureTime uses 0.1 ms units.
const latchedTracks = new WeakSet();

function activeTrack() {
  return document.getElementById("video")?.srcObject?.getVideoTracks?.()[0];
}

function autoOpticsEnabled() {
  const input = document.getElementById("camera-exposure-auto");
  return !input || input.checked;
}

function exposureMutation(constraints) {
  const entries = [constraints, ...(constraints?.advanced ?? [])];
  return entries.some((entry) => entry && (
    entry.exposureMode !== undefined || entry.exposureTime !== undefined ||
    entry.iso !== undefined || entry.exposureCompensation !== undefined
  ));
}

function maybeLatchFromUi() {
  if (!autoOpticsEnabled()) return;
  const diagnostics = document.getElementById("focus-diagnostics")?.textContent || "";
  if (!diagnostics.includes("State    LOCKED")) return;
  const track = activeTrack();
  if (!track || track.readyState !== "live") return;
  const settings = track.getSettings?.() ?? {};
  const exposure = Number(settings.exposureTime);
  if (exposure > 0 && exposure <= MAX_LATCH_EXPOSURE) latchedTracks.add(track);
}

const diagnostics = document.getElementById("focus-diagnostics");
if (diagnostics) {
  new MutationObserver(maybeLatchFromUi).observe(diagnostics, {
    childList: true,
    characterData: true,
    subtree: true
  });
}

// Also sample after normal UI ticks. This keeps the guard independent of how
// FocusController chooses to update its diagnostics DOM.
const latchTimer = setInterval(maybeLatchFromUi, 100);
window.addEventListener("pagehide", () => clearInterval(latchTimer), { once: true });

const proto = globalThis.MediaStreamTrack?.prototype;
const priorApply = proto?.applyConstraints;
if (typeof priorApply === "function" && !priorApply.__airgapperQrExposureLatch) {
  const guardedApply = function(constraints) {
    if (latchedTracks.has(this) && autoOpticsEnabled() && exposureMutation(constraints)) {
      // Preserve the already-proven sensor state. Focus-only writes still pass.
      return Promise.resolve();
    }
    return priorApply.call(this, constraints);
  };
  Object.defineProperty(guardedApply, "__airgapperQrExposureLatch", { value: true });
  try { proto.applyConstraints = guardedApply; } catch {}
}
