const devActions = document.querySelector(".receiver-dev-actions");
const video = document.getElementById("video");

if (devActions && video && !document.getElementById("camera-phase-nudge")) {
  const control = document.createElement("div");
  control.id = "camera-phase-nudge";
  control.className = "camera-phase-nudge";
  control.innerHTML = `
    <label><span>Phase step</span><input id="camera-phase-step" type="number" min="0.1" max="8" step="0.1" value="1" inputmode="decimal" aria-label="Camera phase nudge step in milliseconds" /></label>
    <button class="secondary-button" id="camera-phase-earlier" type="button" title="Move camera phase earlier">−</button>
    <button class="secondary-button" id="camera-phase-later" type="button" title="Move camera phase later">+</button>
    <button class="secondary-button" id="camera-phase-reset" type="button">Zero</button>
    <span id="camera-phase-status" role="status">Phase request 0.00 ms</span>
  `;

  const strictControl = document.getElementById("strict-hot-path-control");
  if (strictControl?.parentElement === devActions) strictControl.after(control);
  else devActions.prepend(control);

  const stepInput = document.getElementById("camera-phase-step");
  const earlierBtn = document.getElementById("camera-phase-earlier");
  const laterBtn = document.getElementById("camera-phase-later");
  const resetBtn = document.getElementById("camera-phase-reset");
  const status = document.getElementById("camera-phase-status");
  let requestedPhaseMs = 0;
  let busy = false;

  function activeBrowserTrack() {
    const media = video.srcObject;
    if (!(media instanceof MediaStream)) return null;
    return media.getVideoTracks().find((track) => track.readyState === "live") ?? null;
  }

  function frameRateRange(track) {
    try {
      const cap = track.getCapabilities?.().frameRate;
      return {
        min: Number.isFinite(cap?.min) ? Number(cap.min) : 0,
        max: Number.isFinite(cap?.max) ? Number(cap.max) : Infinity
      };
    } catch {
      return { min: 0, max: Infinity };
    }
  }

  function setBusy(value) {
    busy = value;
    earlierBtn.disabled = value;
    laterBtn.disabled = value;
    resetBtn.disabled = value;
    stepInput.disabled = value;
  }

  function nextVideoFrame(timeoutMs = 750) {
    return new Promise((resolve) => {
      let settled = false;
      let callbackId = 0;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        if (callbackId && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(callbackId);
        finish(null);
      }, timeoutMs);
      if (typeof video.requestVideoFrameCallback === "function") {
        callbackId = video.requestVideoFrameCallback((now, metadata) => finish({ now, mediaTime: Number(metadata?.mediaTime) }));
      } else {
        requestAnimationFrame((now) => finish({ now, mediaTime: NaN }));
      }
    });
  }

  function observedGapMs(before, after) {
    if (!before || !after) return NaN;
    if (Number.isFinite(before.mediaTime) && Number.isFinite(after.mediaTime) && after.mediaTime > before.mediaTime) {
      return (after.mediaTime - before.mediaTime) * 1000;
    }
    return after.now - before.now;
  }

  async function applyRate(track, originalConstraints, fps) {
    const exact = { ...originalConstraints, frameRate: { exact: fps } };
    try {
      await track.applyConstraints(exact);
      return "exact";
    } catch (error) {
      if (error?.name !== "OverconstrainedError" && error?.name !== "TypeError") throw error;
      await track.applyConstraints({ ...originalConstraints, frameRate: { ideal: fps } });
      return "ideal";
    }
  }

  async function restoreRate(track, originalConstraints, steadyFps) {
    try {
      await track.applyConstraints(originalConstraints);
    } catch {
      await track.applyConstraints({ ...originalConstraints, frameRate: { ideal: steadyFps } });
    }
  }

  function signedPhase(phase, period) {
    if (!Number.isFinite(period) || period <= 0) return phase;
    let value = ((phase + period / 2) % period + period) % period - period / 2;
    if (Math.abs(value) < 0.0005) value = 0;
    return value;
  }

  async function nudgePhase(deltaMs) {
    if (busy || !Number.isFinite(deltaMs) || deltaMs === 0) return;
    const track = activeBrowserTrack();
    if (!track) {
      status.textContent = "Phase: start the browser camera first";
      return;
    }

    const settings = track.getSettings?.() ?? {};
    const steadyFps = Number(settings.frameRate);
    if (!Number.isFinite(steadyFps) || steadyFps <= 0) {
      status.textContent = "Phase: camera does not report FPS";
      return;
    }

    const periodMs = 1000 / steadyFps;
    const maxNudge = periodMs * 0.49;
    const requestedDelta = Math.max(-maxNudge, Math.min(maxNudge, deltaMs));
    const range = frameRateRange(track);
    let appliedDelta = requestedDelta;
    let temporaryFps = 1000 / (periodMs + appliedDelta);
    let wrapped = false;

    // An earlier phase normally needs one faster interval. If the browser says
    // the track cannot run that fast, use the equivalent phase modulo one frame:
    // one deliberately long interval instead. This drops a frame once, but the
    // steady-state cadence still returns to the original FPS immediately after.
    if (temporaryFps > range.max + 0.001 && requestedDelta < 0) {
      appliedDelta = periodMs + requestedDelta;
      temporaryFps = 1000 / (periodMs + appliedDelta);
      wrapped = true;
    }

    if (temporaryFps < range.min - 0.001 || temporaryFps > range.max + 0.001) {
      status.textContent = `Phase: ${requestedDelta > 0 ? "+" : ""}${requestedDelta.toFixed(2)} ms unsupported by camera FPS range`;
      return;
    }

    const originalConstraints = track.getConstraints?.() ?? {};
    setBusy(true);
    status.textContent = `Phase: nudging ${requestedDelta > 0 ? "+" : ""}${requestedDelta.toFixed(2)} ms…`;

    let temporaryMode = "";
    let temporaryActual = NaN;
    let before = null;
    let after = null;
    try {
      // Start immediately after a presented camera frame so the temporary
      // cadence is aimed at one sensor/output interval rather than an arbitrary
      // point between callbacks.
      before = await nextVideoFrame();
      if (track.readyState !== "live") throw new Error("camera stopped");
      temporaryMode = await applyRate(track, originalConstraints, temporaryFps);
      temporaryActual = Number(track.getSettings?.().frameRate);
      after = await nextVideoFrame(Math.max(750, (periodMs + appliedDelta) * 4));
    } catch (error) {
      status.textContent = `Phase nudge failed: ${error?.message || error}`;
      return;
    } finally {
      if (track.readyState === "live") {
        try { await restoreRate(track, originalConstraints, steadyFps); } catch {}
      }
      setBusy(false);
    }

    requestedPhaseMs = signedPhase(requestedPhaseMs + requestedDelta, periodMs);
    const gap = observedGapMs(before, after);
    const actualText = Number.isFinite(temporaryActual) ? temporaryActual.toFixed(2) : temporaryFps.toFixed(2);
    const gapText = Number.isFinite(gap) ? ` · observed ${gap.toFixed(2)} ms` : "";
    const wrapText = wrapped ? ` · wrapped via +${appliedDelta.toFixed(2)} ms stall` : "";
    const softText = temporaryMode === "ideal" ? " · ideal only" : "";
    status.textContent = `Phase request ${requestedPhaseMs >= 0 ? "+" : ""}${requestedPhaseMs.toFixed(2)} ms · one-shot ${actualText} fps${gapText}${wrapText}${softText} · restored ${steadyFps.toFixed(2)}`;
  }

  function stepMs() {
    const value = Number(stepInput.value);
    return Number.isFinite(value) ? Math.max(0.1, Math.min(8, value)) : 1;
  }

  earlierBtn.addEventListener("click", () => void nudgePhase(-stepMs()));
  laterBtn.addEventListener("click", () => void nudgePhase(stepMs()));
  resetBtn.addEventListener("click", () => {
    if (Math.abs(requestedPhaseMs) < 0.0005) return;
    void nudgePhase(-requestedPhaseMs);
  });
}
