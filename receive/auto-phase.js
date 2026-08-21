const phaseRoot = document.getElementById("camera-phase-nudge");
const pulseInput = document.getElementById("camera-exposure-pulse-ms");
const pulseButton = document.getElementById("camera-exposure-pulse");
const diagnostics = document.getElementById("transport-diagnostics");

if (phaseRoot && pulseInput && pulseButton && diagnostics && !document.getElementById("camera-auto-phase")) {
  const auto = document.createElement("label");
  auto.className = "setting-toggle";
  auto.innerHTML = '<input id="camera-auto-phase" type="checkbox" /><span>Auto shutter phase</span>';
  const autoStatus = document.createElement("span");
  autoStatus.id = "camera-auto-phase-status";
  autoStatus.setAttribute("role", "status");
  autoStatus.textContent = "Off";
  phaseRoot.append(auto, autoStatus);

  const toggle = auto.querySelector("input");

  // Tracking mode: only pulse when the receiver has a confident destructive
  // seam model. The seam detector itself is 2D; row/col is just its dominant
  // orientation label in the diagnostics.
  const CONFIDENCE_MIN = 0.62;
  const REQUIRED_SIGHTINGS = 2;
  const PULSE_COOLDOWN_MS = 1800;
  const MAX_PULSES_PER_WINDOW = 6;
  const PULSE_WINDOW_MS = 20000;

  // Acquisition mode: when there is no decodable QR and no fresh finder hint,
  // blindly step sensor phase. At 30 fps a >33.3 ms exposure pulse should move
  // phase, so six bounded attempts are enough to explore roughly one cycle even
  // when the exact physical step differs by device.
  const ACQUIRE_INITIAL_WAIT_MS = 700;
  const ACQUIRE_PULSE_COOLDOWN_MS = 800;
  const ACQUIRE_FINDER_HOLD_MS = 1200;
  const ACQUIRE_MAX_PULSES = 6;

  let enabled = false;
  let consecutiveSightings = 0;
  let lastPulseAt = -Infinity;
  let pulseWindowStartedAt = 0;
  let pulsesInWindow = 0;
  let observerQueued = false;

  let acquisitionPulses = 0;
  let lastAcquisitionPulseAt = -Infinity;
  let lastAcquisitionRaceMs = 0;
  let wasAcquiring = false;
  let lastFinderHints = 0;
  let lastFinderHintAt = -Infinity;

  function diagnosticText() {
    return diagnostics.textContent || "";
  }

  function parseRollingModel(text = diagnosticText()) {
    if (/Rolling\s+—/.test(text)) return null;
    const match = /Rolling\s+(row|col)\s+([-+]?\d+(?:\.\d+)?)\/([-+]?\d+(?:\.\d+)?)\s+·\s+width\s+([-+]?\d+(?:\.\d+)?)\s+·\s+velocity\s+([-+]?\d+(?:\.\d+)?)\s+slots\/frame\s+·\s+confidence\s+(\d+)%/.exec(text);
    if (!match) return null;
    return {
      axis: match[1],
      position: Number(match[2]),
      span: Number(match[3]),
      width: Number(match[4]),
      velocity: Number(match[5]),
      confidence: Number(match[6]) / 100
    };
  }

  function parseAcquisitionState(text = diagnosticText()) {
    const acquire = /Acquire\s+(done|(\d+)ms race)[^\n]*finder hints\s+(\d+)/.exec(text);
    if (!acquire) return null;
    const payload = /Payload\s+valid\s+(\d+)/.exec(text);
    return {
      acquiring: acquire[1] !== "done",
      raceMs: Number(acquire[2]) || 0,
      finderHints: Number(acquire[3]) || 0,
      validDecodes: Number(payload?.[1]) || 0
    };
  }

  function pulseMs() {
    const value = Number(pulseInput.value);
    return Number.isFinite(value) ? Math.max(1, Math.min(1000, value)) : 40;
  }

  function resetWindow(now) {
    if (!pulseWindowStartedAt || now - pulseWindowStartedAt >= PULSE_WINDOW_MS) {
      pulseWindowStartedAt = now;
      pulsesInWindow = 0;
    }
  }

  function noteAcquisitionState(state, now) {
    const restarted = state.acquiring && (!wasAcquiring || state.raceMs + 100 < lastAcquisitionRaceMs);
    if (restarted) {
      acquisitionPulses = 0;
      lastAcquisitionPulseAt = -Infinity;
      lastFinderHints = state.finderHints;
      lastFinderHintAt = state.finderHints > 0 ? now : -Infinity;
    } else if (state.finderHints > lastFinderHints) {
      lastFinderHintAt = now;
      lastFinderHints = state.finderHints;
    }

    wasAcquiring = state.acquiring;
    lastAcquisitionRaceMs = state.raceMs;
  }

  function considerAcquisition(state, now) {
    noteAcquisitionState(state, now);
    if (!state.acquiring) return false;

    consecutiveSightings = 0;

    if (state.validDecodes > 0) {
      autoStatus.textContent = "Acquire hold · QR decoded";
      return true;
    }

    const finderAge = now - lastFinderHintAt;
    if (Number.isFinite(finderAge) && finderAge < ACQUIRE_FINDER_HOLD_MS) {
      autoStatus.textContent = `Acquire hold · fresh finder hint · ${Math.max(0, ACQUIRE_FINDER_HOLD_MS - finderAge).toFixed(0)} ms`;
      return true;
    }

    if (state.raceMs < ACQUIRE_INITIAL_WAIT_MS) {
      autoStatus.textContent = `Acquire · settling ${state.raceMs.toFixed(0)} ms`;
      return true;
    }

    if (acquisitionPulses >= ACQUIRE_MAX_PULSES) {
      autoStatus.textContent = `Acquire backoff · phase sweep complete (${ACQUIRE_MAX_PULSES})`;
      return true;
    }

    if (now - lastAcquisitionPulseAt < ACQUIRE_PULSE_COOLDOWN_MS) {
      autoStatus.textContent = `Acquire settling · phase ${acquisitionPulses}/${ACQUIRE_MAX_PULSES}`;
      return true;
    }

    if (pulseButton.disabled) {
      autoStatus.textContent = "Acquire · waiting for camera controls";
      return true;
    }

    acquisitionPulses++;
    lastAcquisitionPulseAt = now;
    autoStatus.textContent = `Acquire sweep ${acquisitionPulses}/${ACQUIRE_MAX_PULSES} · ${pulseMs().toFixed(1)} ms`;
    pulseButton.click();
    return true;
  }

  function considerPulse() {
    observerQueued = false;
    if (!enabled) return;

    const now = performance.now();
    const text = diagnosticText();
    const acquisition = parseAcquisitionState(text);
    if (acquisition && considerAcquisition(acquisition, now)) return;

    // Once acquisition has finished, the existing seam-aware controller takes
    // over. A missing model here means there is no known destructive band.
    const model = parseRollingModel(text);
    if (!model) {
      consecutiveSightings = 0;
      if (now - lastPulseAt >= PULSE_COOLDOWN_MS)
        autoStatus.textContent = "Hold · no destructive seam";
      return;
    }

    if (model.confidence < CONFIDENCE_MIN) {
      consecutiveSightings = 0;
      autoStatus.textContent = `Watching · ${Math.round(model.confidence * 100)}% confidence`;
      return;
    }

    consecutiveSightings++;
    if (consecutiveSightings < REQUIRED_SIGHTINGS) {
      autoStatus.textContent = `Confirming ${model.axis} seam · ${Math.round(model.confidence * 100)}%`;
      return;
    }

    if (now - lastPulseAt < PULSE_COOLDOWN_MS) {
      autoStatus.textContent = `Settling · ${model.axis} ${model.position.toFixed(0)}/${model.span.toFixed(0)}`;
      return;
    }

    resetWindow(now);
    if (pulsesInWindow >= MAX_PULSES_PER_WINDOW) {
      autoStatus.textContent = "Backoff · seam persisted after 6 pulses";
      return;
    }

    if (pulseButton.disabled) {
      autoStatus.textContent = "Waiting for camera controls";
      return;
    }

    pulsesInWindow++;
    lastPulseAt = now;
    consecutiveSightings = 0;
    autoStatus.textContent = `Pulse ${pulsesInWindow} · ${pulseMs().toFixed(1)} ms · ${model.axis} ${model.position.toFixed(0)}/${model.span.toFixed(0)} · ${Math.round(model.confidence * 100)}%`;
    pulseButton.click();
  }

  function queueConsider() {
    if (!enabled || observerQueued) return;
    observerQueued = true;
    queueMicrotask(considerPulse);
  }

  const observer = new MutationObserver(queueConsider);
  observer.observe(diagnostics, { childList: true, characterData: true, subtree: true });

  toggle.addEventListener("change", () => {
    enabled = toggle.checked;
    consecutiveSightings = 0;
    lastPulseAt = -Infinity;
    pulseWindowStartedAt = performance.now();
    pulsesInWindow = 0;
    acquisitionPulses = 0;
    lastAcquisitionPulseAt = -Infinity;
    lastAcquisitionRaceMs = 0;
    wasAcquiring = false;
    lastFinderHints = 0;
    lastFinderHintAt = -Infinity;
    autoStatus.textContent = enabled ? `Watching · ${pulseMs().toFixed(1)} ms pulses` : "Off";
    if (enabled) queueConsider();
  });

  pulseInput.addEventListener("change", () => {
    if (enabled) autoStatus.textContent = `Watching · ${pulseMs().toFixed(1)} ms pulses`;
  });
}
