import { AutoPhasePolicy, parseAutoPhaseDiagnostics } from "./auto-phase-policy.js";

const phaseRoot = document.getElementById("camera-phase-nudge");
const pulseInput = document.getElementById("camera-exposure-pulse-ms");
const pulseButton = document.getElementById("camera-exposure-pulse");
const pulseStatus = document.getElementById("camera-exposure-pulse-status");
// Health/seam/acquisition metrics are rendered by renderFocusDiagnostics().
// transport-diagnostics is a different pipeline summary and does not contain
// Capacity/Output/AutoOptics/Payload/Acquire, so observing it leaves the policy
// permanently stuck at "waiting for receiver diagnostics".
const diagnostics = document.getElementById("focus-diagnostics");

if (phaseRoot && pulseInput && pulseButton && diagnostics && !document.getElementById("camera-auto-phase")) {
  const auto = document.createElement("label");
  auto.className = "setting-toggle";
  auto.innerHTML = '<input id="camera-auto-phase" type="checkbox" /><span>Auto shutter phase</span>';
  const autoStatus = document.createElement("span");
  autoStatus.id = "camera-auto-phase-status";
  autoStatus.setAttribute("role", "status");
  autoStatus.textContent = "Off · 0 auto pulses";
  phaseRoot.append(auto, autoStatus);

  const toggle = auto.querySelector("input");
  const policy = new AutoPhasePolicy();
  let enabled = false;
  let observerQueued = false;
  let autoPulseDispatch = false;
  let lastSample;

  function pulseMs() {
    const value = Number(pulseInput.value);
    return Number.isFinite(value) ? Math.max(1, Math.min(1000, value)) : 40;
  }

  function diagnosticText() {
    return diagnostics.textContent || "";
  }

  function percent(value) {
    return value === null || value === undefined || !Number.isFinite(Number(value))
      ? "—"
      : `${Math.round(Number(value) * 100)}%`;
  }

  function visibleLabel(sample) {
    if (sample.acquiring) {
      return sample.finderHints > 0 ? `${sample.finderHints} finder hints` : "no finder yet";
    }
    return `${sample.visibleSlots || 0} visible`;
  }

  function rateLabel(sample) {
    if (sample.acquiring) return `${sample.validRate.toFixed(1)} QR/s`;
    return `${sample.validRate.toFixed(1)}/${sample.completedRate.toFixed(1)} QR/s · ${percent(sample.successRatio)}`;
  }

  function statusFor(decision, sample) {
    const pulseCount = `${policy.pulseCount()}/6`;
    switch (decision.reason) {
      case "off": return `Off · ${pulseCount} auto pulses`;
      case "waiting-diagnostics": return "Watching · waiting for receiver diagnostics";
      case "arming": return `Watching · arming · ${visibleLabel(sample)}`;
      case "settling": return `Settling after phase pulse · ${pulseCount}`;
      case "backoff": return `Backoff · ${pulseCount} pulses · rechecking shortly`;
      case "acquire-valid": return `Acquire hold · QR decoded · ${rateLabel(sample)}`;
      case "acquire-race": return `Acquire · full finder/optics race · ${sample.raceMs.toFixed(0)} ms`;
      case "finder-no-decode": return `Acquire · QR structure visible, not decoding · ${visibleLabel(sample)}`;
      case "optics-visible": return `Acquire · QR structure visible · waiting for AutoOptics ${sample.opticsRuntime || sample.opticsController}`;
      case "optics-blind": return `Acquire · nothing visible · AutoOptics ${sample.opticsRuntime || sample.opticsController} searching first`;
      case "blind-acquisition": return `Acquire · nothing visible · phase search ready · ${pulseCount}`;
      case "no-visible-slots": return "Hold · proven grid is offscreen";
      case "healthy": return `Hold · healthy · ${visibleLabel(sample)} · ${rateLabel(sample)}`;
      case "optics-tracking": return `Poor scan · waiting for AutoOptics ${sample.opticsRuntime || sample.opticsController}`;
      case "seam-degraded": return `Degraded · seam ${Math.round((sample.seam?.confidence || 0) * 100)}% · ${rateLabel(sample)}`;
      case "decode-silence": return `Degraded · ${(sample.decodeSilenceMs / 1000).toFixed(1)}s without QR · ${visibleLabel(sample)}`;
      case "low-decode-yield": return `Degraded · ${visibleLabel(sample)} · ${rateLabel(sample)}`;
      default: return `Watching · ${visibleLabel(sample)} · ${rateLabel(sample)}`;
    }
  }

  function fireAutoPulse(decision, sample, now) {
    // Re-check the DOM state at the exact actuation point. Programmatic exposure
    // pulses are impossible while the checkbox is off, even if a queued
    // diagnostics observer was created before the user toggled it.
    if (!enabled || !toggle.checked) return;
    if (pulseButton.disabled) {
      autoStatus.textContent = `Waiting for camera controls · ${statusFor(decision, sample)}`;
      return;
    }

    const beforeDisabled = pulseButton.disabled;
    autoPulseDispatch = true;
    try {
      pulseButton.click();
    } finally {
      autoPulseDispatch = false;
    }

    // phase-nudge.js disables the button synchronously once a real manual
    // exposure pulse starts. If the camera does not expose manual exposure,
    // don't count a fake phase attempt toward the search budget.
    if (!beforeDisabled && pulseButton.disabled) {
      policy.notePulse(now);
      const reason = decision.reason === "finder-no-decode" ? "visible QR, no decode"
        : decision.reason === "blind-acquisition" ? "blind acquisition"
        : decision.reason === "seam-degraded" ? "destructive seam"
        : decision.reason === "decode-silence" ? "decode silence"
        : "low decode yield";
      autoStatus.textContent = `Pulse ${policy.pulseCount()}/6 · ${pulseMs().toFixed(1)} ms · ${reason}`;
    } else {
      autoStatus.textContent = pulseStatus?.textContent || "Exposure pulse unavailable";
    }
  }

  function considerPulse() {
    observerQueued = false;
    if (!enabled || !toggle.checked) return;
    const sample = parseAutoPhaseDiagnostics(diagnosticText());
    if (!sample) {
      autoStatus.textContent = "Watching · waiting for receiver diagnostics";
      return;
    }
    sample.now = performance.now();
    lastSample = sample;
    const decision = policy.observe(sample);
    if (decision.kind === "pulse") fireAutoPulse(decision, sample, sample.now);
    else autoStatus.textContent = statusFor(decision, sample);
  }

  function queueConsider() {
    if (!enabled || !toggle.checked || observerQueued) return;
    observerQueued = true;
    queueMicrotask(considerPulse);
  }

  const observer = new MutationObserver(queueConsider);
  observer.observe(diagnostics, { childList: true, characterData: true, subtree: true });

  // A manual Pulse while Auto is enabled also changes phase. Account for it so
  // the controller waits for fresh evidence instead of immediately pulsing again.
  pulseButton.addEventListener("click", () => {
    if (!enabled || !toggle.checked || autoPulseDispatch) return;
    queueMicrotask(() => {
      if (pulseButton.disabled) {
        policy.notePulse(performance.now());
        autoStatus.textContent = `Manual pulse · settling · ${policy.pulseCount()}/6`;
      }
    });
  });

  toggle.addEventListener("change", () => {
    enabled = toggle.checked;
    policy.setEnabled(enabled, performance.now());
    observerQueued = false;
    autoStatus.textContent = enabled
      ? `Watching decode health · ${pulseMs().toFixed(1)} ms pulses`
      : "Off · 0 auto pulses";
    if (enabled) queueConsider();
  });

  pulseInput.addEventListener("change", () => {
    if (enabled) {
      const suffix = lastSample ? ` · ${visibleLabel(lastSample)}` : "";
      autoStatus.textContent = `Watching decode health · ${pulseMs().toFixed(1)} ms pulses${suffix}`;
    }
  });
}
