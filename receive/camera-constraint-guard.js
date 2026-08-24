const blockedForReopen = new WeakSet();
let reopenScheduled = false;

function activeCameraTrack() {
  const source = document.getElementById("video")?.srcObject;
  return source?.getVideoTracks?.()[0];
}

function scheduleAutoCameraReopen(track) {
  if (!track || blockedForReopen.has(track)) return;
  blockedForReopen.add(track);
  if (reopenScheduled) return;
  reopenScheduled = true;

  // Do not touch the old manual camera again. Some Android camera HALs can
  // synchronously block Chromium's main thread on *any* focus/exposure write
  // while the sensor is transitioning out of manual exposure. Reopen the
  // camera instead; pause/resume preserves the transport/decoder session.
  setTimeout(() => {
    reopenScheduled = false;
    const receiveView = document.getElementById("receiveView");
    if (!receiveView?.classList.contains("active")) return;
    window.dispatchEvent(new Event("airgapper:pause-mode"));
    queueMicrotask(() => window.dispatchEvent(new Event("airgapper:resume-mode")));
  }, 0);
}

function installManualToAutoReopenGuard() {
  // Capture runs before runtime.js's checkbox listener. Mark the old track as
  // untouchable before AutoOptics can enqueue focus/exposure mutations.
  document.addEventListener("change", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.id !== "camera-exposure-auto" || !input.checked) return;
    const track = activeCameraTrack();
    if (!track || track.readyState !== "live") return;
    const actual = track.getSettings?.() ?? {};
    if (actual.exposureMode === "manual") scheduleAutoCameraReopen(track);
  }, true);

  const proto = globalThis.MediaStreamTrack?.prototype;
  const nativeApply = proto?.applyConstraints;
  if (typeof nativeApply !== "function" || nativeApply.__airgapperManualToAutoGuard) return;

  const guardedApply = function(constraints) {
    if (blockedForReopen.has(this)) {
      // Runtime state may continue advancing while the replacement track opens,
      // but no native mutation is allowed to reach the old camera HAL.
      return Promise.resolve();
    }
    return nativeApply.call(this, constraints);
  };
  Object.defineProperty(guardedApply, "__airgapperManualToAutoGuard", { value: true });
  try { proto.applyConstraints = guardedApply; } catch {}
}

installManualToAutoReopenGuard();
