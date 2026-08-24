let reopenAutoRequested = false;
let reopenScheduled = false;

function requestedScalar(value) {
  if (value && typeof value === "object") return value.exact ?? value.ideal;
  return value;
}

function requestedExposureMode(constraints) {
  if (!constraints || typeof constraints !== "object") return void 0;
  const direct = requestedScalar(constraints.exposureMode);
  if (direct !== void 0) return direct;
  if (!Array.isArray(constraints.advanced)) return void 0;
  for (const set of constraints.advanced) {
    const value = requestedScalar(set?.exposureMode);
    if (value !== void 0) return value;
  }
  return void 0;
}

function scheduleAutoCameraReopen(track) {
  if (reopenScheduled) return;
  reopenScheduled = true;
  reopenAutoRequested = false;
  setTimeout(() => {
    reopenScheduled = false;
    if (track?.readyState !== "live") return;
    const receiveView = document.getElementById("receiveView");
    if (!receiveView?.classList.contains("active")) return;

    // Some Android camera stacks synchronously block the browser main thread
    // when an already-manual sensor is switched back to continuous AE. Reopen
    // the camera instead. AirGapper's pause/resume path preserves the transfer
    // decoder/session while replacing the live camera track and frame pump.
    window.dispatchEvent(new Event("airgapper:pause-mode"));
    queueMicrotask(() => window.dispatchEvent(new Event("airgapper:resume-mode")));
  }, 0);
}

function installManualToAutoReopenGuard() {
  document.addEventListener("change", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.id !== "camera-exposure-auto") return;
    reopenAutoRequested = input.checked;
  }, true);

  const proto = globalThis.MediaStreamTrack?.prototype;
  const nativeApply = proto?.applyConstraints;
  if (typeof nativeApply !== "function" || nativeApply.__airgapperManualToAutoGuard) return;

  const guardedApply = function(constraints) {
    if (reopenAutoRequested && requestedExposureMode(constraints) === "continuous") {
      const actual = this.getSettings?.() ?? {};
      if (actual.exposureMode === "manual") {
        scheduleAutoCameraReopen(this);
        // The runtime has already switched its AutoOptics state before this
        // write. Treat the dangerous in-place write as accepted; the fresh
        // camera track opened on the next task starts in native hardware auto.
        return Promise.resolve();
      }
      reopenAutoRequested = false;
    }
    return nativeApply.call(this, constraints);
  };
  Object.defineProperty(guardedApply, "__airgapperManualToAutoGuard", { value: true });
  try { proto.applyConstraints = guardedApply; } catch {}
}

installManualToAutoReopenGuard();
