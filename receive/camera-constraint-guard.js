const blockedForReopen = new WeakSet();
let reopenScheduled = false;
let reopenGeneration = 0;

function activeCameraTrack() {
  const source = document.getElementById("video")?.srcObject;
  return source?.getVideoTracks?.()[0];
}

function cameraReleaseBarrier(ms = 120) {
  // track.stop() flips readyState immediately, but Chromium/Camera2 may still be
  // releasing the underlying sensor. A real macrotask delay prevents the new
  // getUserMedia request from racing that teardown; a microtask does not.
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scheduleAutoCameraReopen(track) {
  if (!track || blockedForReopen.has(track)) return;
  blockedForReopen.add(track);
  if (reopenScheduled) return;
  reopenScheduled = true;
  const generation = ++reopenGeneration;

  // Do not touch the old manual camera again. Some Android camera HALs can
  // synchronously block Chromium's main thread on *any* focus/exposure write
  // while the sensor is transitioning out of manual exposure. Reopen the
  // camera instead; pause/resume preserves the transport/decoder session.
  setTimeout(async () => {
    try {
      const receiveView = document.getElementById("receiveView");
      if (!receiveView?.classList.contains("active")) return;

      window.dispatchEvent(new Event("airgapper:pause-mode"));

      // pauseReceiver() synchronously stops the track, but Android camera
      // teardown itself is asynchronous below Chromium. Give Camera2 a small,
      // bounded release window before opening the replacement stream. This is
      // deliberately outside runtime camera constraints so the old track stays
      // completely mutation-free during the transition.
      await cameraReleaseBarrier();

      if (generation !== reopenGeneration) return;
      if (!receiveView.classList.contains("active")) return;
      window.dispatchEvent(new Event("airgapper:resume-mode"));
    } finally {
      if (generation === reopenGeneration) reopenScheduled = false;
    }
  }, 0);
}

function installManualToAutoReopenGuard() {
  // Capture runs before runtime.js's checkbox listener. Mark the old track as
  // untouchable before AutoOptics can enqueue focus/exposure mutations. Some
  // camera stacks report exposureMode poorly, so the still-visible ManualOptics
  // panel is also authoritative evidence that this click crosses that boundary.
  document.addEventListener("change", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.id !== "camera-exposure-auto" || !input.checked) return;
    const track = activeCameraTrack();
    if (!track || track.readyState !== "live") return;
    const actual = track.getSettings?.() ?? {};
    const manualPanel = document.getElementById("camera-optics-manual");
    if (actual.exposureMode === "manual" || manualPanel && !manualPanel.hidden) scheduleAutoCameraReopen(track);
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
