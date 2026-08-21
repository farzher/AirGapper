import { AutoPhasePolicy, parseAutoPhaseDiagnostics } from "./auto-phase-policy.js";

const phaseRoot = document.getElementById("camera-phase-nudge");
const pulseInput = document.getElementById("camera-exposure-pulse-ms");
const pulseButton = document.getElementById("camera-exposure-pulse");
const pulseStatus = document.getElementById("camera-exposure-pulse-status");
const diagnostics = document.getElementById("focus-diagnostics");
const opticsAuto = document.getElementById("camera-exposure-auto");
const opticsOptimize = document.getElementById("optics-optimize");
const opticsStatus = document.getElementById("optics-optimize-status");

if (phaseRoot && pulseInput && pulseButton && diagnostics && !document.getElementById("camera-auto-phase")) {
  const auto = document.createElement("label");
  auto.className = "setting-toggle";
  auto.innerHTML = '<input id="camera-auto-phase" type="checkbox" /><span>Auto recovery</span>';
  const autoStatus = document.createElement("span");
  autoStatus.id = "camera-auto-phase-status";
  autoStatus.setAttribute("role", "status");
  autoStatus.textContent = "Off";
  phaseRoot.append(auto, autoStatus);

  const toggle = auto.querySelector("input");
  const policy = new AutoPhasePolicy();
  let enabled = false;
  let observerQueued = false;
  let autoDispatch = "";
  let lastSample;

  function pulseMs() {
    const value = Number(pulseInput.value);
    return Number.isFinite(value) ? Math.max(1, Math.min(1000, value)) : 40;
  }

  function sampleNow() {
    const sample = parseAutoPhaseDiagnostics(diagnostics.textContent || "");
    if (!sample) return null;
    sample.now = performance.now();
    sample.opticsAllowed = Boolean(opticsAuto?.checked);
    sample.phaseAvailable = true;
    return sample;
  }

  function percent(value) {
    return Number.isFinite(Number(value)) ? `${Math.round(Number(value) * 100)}%` : "—";
  }

  function healthLabel(sample, health) {
    if (!sample) return "waiting for diagnostics";
    if (sample.acquiring) {
      if (sample.validRate >= 0.5) return `${sample.validRate.toFixed(1)} QR/s`;
      if (sample.finderHints > 0) return `${sample.finderHints} finder hints · no decode`;
      return "nothing visible";
    }
    const ratio = sample.successRatio == null ? "—" : percent(sample.successRatio);
    return `${ratio} · ${sample.validRate.toFixed(1)}/${sample.completedRate.toFixed(1)} QR/s${health?.label ? ` · ${health.label}` : ""}`;
  }

  function ownershipLabel(sample) {
    return sample?.opticsAllowed ? "auto optics allowed" : "manual optics · phase only";
  }

  function statusFor(decision, sample) {
    const health = decision.health;
    const healthText = healthLabel(sample, health);
    const phase = `${decision.phaseSteps ?? policy.pulseCount()}/6`;
    switch (decision.reason) {
      case "off": return "Off";
      case "waiting-diagnostics": return "Watching · waiting for receiver diagnostics";
      case "arming": return `ACQUIRE · arming · ${healthText}`;
      case "healthy": return `GOOD · ${healthText} · camera frozen`;
      case "acquire-race": return `ACQUIRE · normal search first · ${sample.raceMs.toFixed(0)} ms`;
      case "finder-no-decode": return `ACQUIRE · QR visible but not decoding · ${ownershipLabel(sample)}`;
      case "blind-acquisition": return `ACQUIRE · nothing visible · ${ownershipLabel(sample)}`;
      case "bad-dwell": return `Weak scan · confirming failure · ${healthText}`;
      case "weak-dwell": return `Weak scan · ${healthText} · waiting before recovery`;
      case "external-optics": return "RECOVER · AutoOptics is changing camera · waiting";
      case "action-running": return "RECOVER · optics test running";
      case "action-settling": return `RECOVER · ${decision.action} settling · phase ${phase}`;
      case "action-recovered": return `GOOD · ${decision.action} recovered scan · ${healthText}`;
      case "action-improved": return `RECOVER · ${decision.action} improved scan · ${healthText}`;
      case "action-no-gain": return `RECOVER · ${decision.action} did not help · ${healthText}`;
      case "recovery-wait": return `RECOVER · measuring · ${healthText}`;
      case "backoff": return "RECOVER · searched current options · rechecking shortly";
      default:
        if (decision.kind === "phase") return `RECOVER · try phase ${Math.min(6, (decision.phaseSteps ?? 0) + 1)}/6 · baseline ${healthText}`;
        if (decision.kind === "optics") return `RECOVER · try optics · baseline ${healthText}`;
        return `${decision.state || "WATCH"} · ${healthText}`;
    }
  }

  function firePhase(decision, sample) {
    if (!enabled || !toggle.checked) return;
    if (pulseButton.disabled) {
      autoStatus.textContent = `RECOVER · phase control busy · ${healthLabel(sample, decision.health)}`;
      return;
    }
    const beforeDisabled = pulseButton.disabled;
    autoDispatch = "phase";
    try {
      pulseButton.click();
    } finally {
      autoDispatch = "";
    }
    if (!beforeDisabled && pulseButton.disabled) {
      policy.noteActionStarted("phase", sample, sample.now);
      autoStatus.textContent = `RECOVER · phase ${policy.pulseCount()}/6 · ${pulseMs().toFixed(1)} ms pulse · measuring result`;
    } else {
      policy.noteActionRejected("phase", sample.now);
      autoStatus.textContent = pulseStatus?.textContent || "RECOVER · phase control unavailable";
    }
  }

  function fireOptics(decision, sample) {
    if (!enabled || !toggle.checked) return;
    if (!sample.opticsAllowed) {
      policy.noteActionRejected("optics", sample.now);
      autoStatus.textContent = "RECOVER · manual optics preserved · phase only";
      return;
    }
    if (!opticsOptimize || opticsOptimize.disabled) {
      policy.noteActionRejected("optics", sample.now);
      autoStatus.textContent = "RECOVER · optics recalibration unavailable";
      return;
    }
    policy.noteActionStarted("optics", sample, sample.now);
    autoDispatch = "optics";
    try {
      opticsOptimize.click();
    } finally {
      autoDispatch = "";
    }
    autoStatus.textContent = `RECOVER · optics test started · ${opticsStatus?.textContent || "measuring"}`;
  }

  function consider() {
    observerQueued = false;
    if (!enabled || !toggle.checked) return;
    const sample = sampleNow();
    if (!sample) {
      autoStatus.textContent = "Watching · waiting for receiver diagnostics";
      return;
    }
    lastSample = sample;
    const decision = policy.observe(sample);
    if (decision.kind === "phase") firePhase(decision, sample);
    else if (decision.kind === "optics") fireOptics(decision, sample);
    else autoStatus.textContent = statusFor(decision, sample);
  }

  function queueConsider() {
    if (!enabled || !toggle.checked || observerQueued) return;
    observerQueued = true;
    queueMicrotask(consider);
  }

  const observer = new MutationObserver(queueConsider);
  observer.observe(diagnostics, { childList: true, characterData: true, subtree: true });
  const timer = setInterval(queueConsider, 220);
  window.addEventListener("pagehide", () => clearInterval(timer), { once: true });

  // Manual developer actions are still experiments in the same control loop.
  // Account for them so Auto Recovery measures the new state before acting again.
  pulseButton.addEventListener("click", () => {
    if (!enabled || !toggle.checked || autoDispatch === "phase") return;
    queueMicrotask(() => {
      if (!pulseButton.disabled) return;
      const sample = sampleNow();
      if (!sample) return;
      policy.noteActionStarted("phase", sample, sample.now);
      autoStatus.textContent = `Manual phase pulse · measuring · ${policy.pulseCount()}/6`;
    });
  });

  opticsOptimize?.addEventListener("click", () => {
    if (!enabled || !toggle.checked || autoDispatch === "optics" || !opticsAuto?.checked) return;
    const sample = sampleNow();
    if (!sample) return;
    policy.noteActionStarted("optics", sample, sample.now);
    autoStatus.textContent = "Manual optics recalibration · measuring";
  });

  toggle.addEventListener("change", () => {
    enabled = toggle.checked;
    policy.setEnabled(enabled, performance.now());
    observerQueued = false;
    autoStatus.textContent = enabled
      ? `ACQUIRE · watching QR health · ${opticsAuto?.checked ? "auto optics allowed" : "manual optics · phase only"}`
      : "Off";
    if (enabled) queueConsider();
  });

  opticsAuto?.addEventListener("change", () => {
    if (enabled) {
      autoStatus.textContent = opticsAuto.checked
        ? "Watching · Auto optics allowed during recovery"
        : "Watching · Manual optics preserved · phase only";
      queueConsider();
    }
  });

  pulseInput.addEventListener("change", () => {
    if (enabled) autoStatus.textContent = `Watching · phase pulse ${pulseMs().toFixed(1)} ms${lastSample ? ` · ${healthLabel(lastSample, policy.lastHealth)}` : ""}`;
  });
}
