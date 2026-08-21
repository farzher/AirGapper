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
  const CONFIDENCE_MIN = 0.62;
  const REQUIRED_SIGHTINGS = 2;
  const PULSE_COOLDOWN_MS = 1800;
  const MAX_PULSES_PER_WINDOW = 6;
  const PULSE_WINDOW_MS = 20000;

  let enabled = false;
  let consecutiveSightings = 0;
  let lastPulseAt = -Infinity;
  let pulseWindowStartedAt = 0;
  let pulsesInWindow = 0;
  let observerQueued = false;

  function parseRollingModel() {
    const text = diagnostics.textContent || "";
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

  function considerPulse() {
    observerQueued = false;
    if (!enabled) return;

    const now = performance.now();
    const model = parseRollingModel();
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
    autoStatus.textContent = enabled ? `Watching · ${pulseMs().toFixed(1)} ms pulses` : "Off";
    if (enabled) queueConsider();
  });

  pulseInput.addEventListener("change", () => {
    if (enabled) autoStatus.textContent = `Watching · ${pulseMs().toFixed(1)} ms pulses`;
  });
}
