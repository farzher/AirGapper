from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"replacement not found in {path}: {old[:180]!r}")
    p.write_text(s.replace(old, new, count))


# Version/cache bump.
replace("index.html", "v0.5.191", "v0.5.192")
replace("main.js", 'const APP_BUILD = "v0.5.191";', 'const APP_BUILD = "v0.5.192";')
replace("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.191";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.192";')
replace("sw.js", 'const CACHE = "airgapper-static-js-v153";', 'const CACHE = "airgapper-static-js-v154";')

# ---------------------------------------------------------------------------
# Auto Optics: one startup owner, optimistic recent-winner boot, fast fallback.
# ---------------------------------------------------------------------------
replace(
    "receive/main.js",
    'const AUTO_OPTICS_MEMORY_MAX_SCALE = 1;\n',
    'const AUTO_OPTICS_MEMORY_MAX_SCALE = 1;\nconst AUTO_OPTICS_MEMORY_BOOT_MAX_MS = 1600;\n'
)
replace(
    "receive/main.js",
    'let autoOpticsAeBaseline;\n',
    'let autoOpticsAeBaseline;\nlet autoOpticsMemoryBootAt = 0;\nlet autoOpticsMemoryBoot;\n'
)

# Preserve pointsOfInterest when a focus mode and ROI are requested together.
replace(
    "receive/main.js",
    '''      } else if (patch.focusMode !== void 0) {\n        await applyStage({ focusMode: patch.focusMode });\n      } else if (patch.pointsOfInterest !== void 0) {''',
    '''      } else if (patch.focusMode !== void 0) {\n        await applyStage({\n          focusMode: patch.focusMode,\n          ...(patch.pointsOfInterest !== void 0 ? { pointsOfInterest: patch.pointsOfInterest } : {})\n        });\n      } else if (patch.pointsOfInterest !== void 0) {'''
)

# Focus controller owns focus only. Auto Optics owns exposure startup.
replace(
    "receive/main.js",
    '''function attachCameraController(track) {\n  focusController.attach(track);\n  if (!automaticOptics) void applyExposureSetting(track);\n}''',
    '''function attachCameraController(track) {\n  focusController.attach(track);\n  if (automaticOptics) void primeAutomaticQrOpticsStartup(track);\n  else void applyExposureSetting(track);\n}'''
)

# populateBrowserCapabilities used to force neutral AE before attach(), producing
# the bright startup flash and then a second exposure mutation. attach() is now
# the sole startup entry point for optics.
replace(
    "receive/main.js",
    '''    showExposureTime(current);\n    syncExposureControls();\n    void applyExposureSetting(track);\n  } else {''',
    '''    showExposureTime(current);\n    syncExposureControls();\n  } else {'''
)

# Cold hardware-AE fallback starts with the QR bias instead of neutral 0 EV.
replace(
    "receive/main.js",
    '''    if (caps.exposureCompensation && caps.exposureCompensation.min <= 0 && caps.exposureCompensation.max >= 0) {\n      patch.exposureCompensation = quantizeCameraRange(0, caps.exposureCompensation);\n    }''',
    '''    if (caps.exposureCompensation && caps.exposureCompensation.min <= 0 && caps.exposureCompensation.max >= 0) {\n      const bias = automaticOptics ? AUTO_QR_EV_BIAS : 0;\n      patch.exposureCompensation = quantizeCameraRange(\n        Math.max(caps.exposureCompensation.min, Math.min(0, bias)),\n        caps.exposureCompensation\n      );\n    }'''
)

replace(
    "receive/main.js",
    '''  autoOpticsHeldYield = 0;\n  autoOpticsAeBaseline = void 0;\n  autoOpticsTuneSummary = "";''',
    '''  autoOpticsHeldYield = 0;\n  autoOpticsAeBaseline = void 0;\n  autoOpticsMemoryBootAt = 0;\n  autoOpticsMemoryBoot = void 0;\n  autoOpticsTuneSummary = "";'''
)

# Insert startup-memory behavior immediately after the memory loader.
p = Path("receive/main.js")
s = p.read_text()
anchor = '''function rememberAutomaticOptics(track, exposure, iso, score = 0, yieldRate = 0, aeProduct = 0) {'''
if anchor not in s:
    raise SystemExit("auto optics memory insertion anchor missing")
startup = r'''function automaticOpticsMemoryHealthy(saved) {
  return Boolean(saved && Number(saved.yieldRate) >= AUTO_OPTICS_MEMORY_MIN_YIELD &&
    Number.isFinite(saved.exposure) && saved.exposure > 0 && Number.isFinite(saved.iso) && saved.iso > 0);
}
function cameraSettingNear(value, target, range) {
  if (!Number.isFinite(value) || !Number.isFinite(target)) return false;
  const step = Number(range?.step) || 0;
  return Math.abs(value - target) <= Math.max(step * 0.75, Math.abs(target) * 0.02, 1e-6);
}
async function primeAutomaticQrOpticsStartup(track) {
  if (!automaticOpticsSessionAlive(track) || autoOpticsMutationRunning) return;
  const caps = track.getCapabilities?.() ?? {};
  const exposureRange = caps.exposureTime;
  const isoRange = caps.iso;
  const saved = usableAutomaticOpticsMemory(track);
  const canRestore = automaticOpticsMemoryHealthy(saved) &&
    Array.isArray(caps.exposureMode) && caps.exposureMode.includes("manual") && exposureRange && isoRange;

  if (!canRestore) {
    autoOpticsRuntimeState = "ae";
    autoOpticsMemoryBootAt = 0;
    autoOpticsMemoryBoot = void 0;
    await applyExposureSetting(track);
    if (automaticOpticsSessionAlive(track)) {
      autoOpticsAcquisitionSince = receiverNow();
      autoOpticsTuneSummary = saved ? "recent winner not proven enough · hardware AE" : "hardware AE";
    }
    return;
  }

  const exposure = quantizeCameraRange(saved.exposure, exposureRange);
  const iso = quantizeCameraRange(saved.iso, isoRange);
  autoOpticsMutationRunning = true;
  try {
    const accepted = await applyCameraConstraint(track, {
      exposureMode: "manual",
      exposureTime: exposure,
      iso
    });
    if (!automaticOpticsSessionAlive(track)) return;
    const actual = track.getSettings();
    const restored = accepted && actual.exposureMode === "manual" &&
      cameraSettingNear(actual.exposureTime, exposure, exposureRange) &&
      cameraSettingNear(actual.iso, iso, isoRange);
    if (!restored) {
      await applyExposureSetting(track);
      if (!automaticOpticsSessionAlive(track)) return;
      autoOpticsRuntimeState = "ae";
      autoOpticsMemoryBootAt = 0;
      autoOpticsMemoryBoot = void 0;
      autoOpticsAcquisitionSince = receiverNow();
      autoOpticsTuneSummary = "recent winner rejected by camera · hardware AE";
      focusController.adoptAutomaticCameraState("recent automatic optics could not be restored; hardware AE");
      return;
    }

    const now = receiverNow();
    autoOpticsRuntimeState = "memory";
    autoOpticsMemoryBootAt = now;
    autoOpticsMemoryBoot = {
      exposure: Number(actual.exposureTime) || exposure,
      iso: Number(actual.iso) || iso,
      yieldRate: Number(saved.yieldRate) || 0
    };
    autoOpticsAcquisitionSince = now;
    autoOpticsRetryAt = Infinity;
    autoOpticsRescueRetryAt = 0;
    autoOpticsHeldYield = autoOpticsMemoryBoot.yieldRate;
    autoOpticsTuneSummary = `startup winner · ${formatExposureMs(autoOpticsMemoryBoot.exposure)} · ISO ${Math.round(autoOpticsMemoryBoot.iso)} · prior ${(autoOpticsHeldYield * 100).toFixed(0)}% · validating`;
    focusController.adoptAutomaticCameraState("restored recent QR-proven automatic optics; validating live decode");
    notePipelineEvent("auto-optics-memory-start");
  } finally {
    autoOpticsMutationRunning = false;
  }
}
async function abandonAutomaticOpticsStartupMemory(track, reason = "startup winner produced no QR") {
  if (autoOpticsMutationRunning || !automaticOpticsSessionAlive(track) || autoOpticsRuntimeState !== "memory") return;
  autoOpticsMutationRunning = true;
  try {
    await applyExposureSetting(track);
    if (!automaticOpticsSessionAlive(track)) return;
    const now = receiverNow();
    autoOpticsRuntimeState = "ae";
    autoOpticsMemoryBootAt = 0;
    autoOpticsMemoryBoot = void 0;
    autoOpticsLockSince = 0;
    autoOpticsAcquisitionSince = now;
    autoOpticsRetryAt = 0;
    autoOpticsRescueRetryAt = now + 900;
    autoOpticsHoldSample = void 0;
    autoOpticsHoldCollapseSince = 0;
    autoOpticsHeldYield = 0;
    autoOpticsTuneSummary = `${reason} · hardware AE fallback`;
    focusController.adoptAutomaticCameraState("recent automatic optics unconfirmed; hardware AE fallback");
    notePipelineEvent("auto-optics-memory-fallback");
  } finally {
    autoOpticsMutationRunning = false;
  }
}
'''
s = s.replace(anchor, startup + anchor, 1)
p.write_text(s)

# Memory is a first-class startup state. A live QR validates it; no QR within a
# short bounded window falls back once to hardware AE without deleting memory.
old = '''  if (autoOpticsRuntimeState === "manual") {\n    const poseUsable = gridLattice.locked && autoOpticsPoseUsable(autoOpticsPoseSnapshot());'''
new = '''  if (autoOpticsRuntimeState === "memory") {\n    const startedAt = autoOpticsMemoryBootAt || now;\n    const liveDecode = Boolean(lastStreamDecodeAt && lastStreamDecodeAt >= startedAt);\n    if (liveDecode) {\n      if (gridLattice.locked) {\n        autoOpticsRuntimeState = "manual";\n        autoOpticsHoldSample = autoOpticsPipelineSnapshot();\n        autoOpticsHoldCollapseSince = 0;\n        autoOpticsRetryAt = Infinity;\n        const restored = autoOpticsMemoryBoot;\n        autoOpticsTuneSummary = restored\n          ? `startup winner validated · ${formatExposureMs(restored.exposure)} · ISO ${Math.round(restored.iso)}`\n          : "startup winner validated";\n        autoOpticsMemoryBootAt = 0;\n        autoOpticsMemoryBoot = void 0;\n        focusController.adoptAutomaticCameraState("recent automatic optics validated by live AirGapper QR");\n        notePipelineEvent("auto-optics-memory-hit");\n      } else {\n        autoOpticsTuneSummary = "startup winner decoding · awaiting lattice lock";\n      }\n      return;\n    }\n    if (now - startedAt >= AUTO_OPTICS_MEMORY_BOOT_MAX_MS)\n      void abandonAutomaticOpticsStartupMemory(track);\n    return;\n  }\n\n  if (autoOpticsRuntimeState === "manual") {\n    const poseUsable = gridLattice.locked && autoOpticsPoseUsable(autoOpticsPoseSnapshot());'''
replace("receive/main.js", old, new)

# If acquisition is already producing real QR payloads, do not start a cold
# brightness search just because the lattice has not promoted to LOCKED yet.
replace(
    "receive/main.js",
    '''  if (!gridLattice.locked) {\n    autoOpticsLockSince = 0;\n    if (now - autoOpticsAcquisitionSince >= AUTO_OPTICS_ACQUISITION_RESCUE_MS && now >= autoOpticsRescueRetryAt)\n      void rescueAutomaticQrAcquisition(track, now);\n    return;\n  }''',
    '''  if (!gridLattice.locked) {\n    autoOpticsLockSince = 0;\n    const liveDecode = Boolean(lastStreamDecodeAt && now - lastStreamDecodeAt < AUTO_OPTICS_RECENT_DECODE_MS);\n    if (!liveDecode && now - autoOpticsAcquisitionSince >= AUTO_OPTICS_ACQUISITION_RESCUE_MS && now >= autoOpticsRescueRetryAt)\n      void rescueAutomaticQrAcquisition(track, now);\n    return;\n  }'''
)

# Make the new memory state visible in copied diagnostics.
replace(
    "receive/main.js",
    '''`AutoOptics ${automaticOptics ? `${autoOpticsRuntimeState}${autoOpticsRuntimeState === "manual" ? ` · hold ${(autoOpticsHeldYield * 100).toFixed(0)}%` : autoOpticsRuntimeState === "ae" ? " · bootstrap AE" : autoOpticsRuntimeState === "tuning" ? " · live ISO search" : ""}${autoOpticsTuneSummary ? ` · ${autoOpticsTuneSummary}` : ""}` : "off"}`''',
    '''`AutoOptics ${automaticOptics ? `${autoOpticsRuntimeState}${autoOpticsRuntimeState === "manual" ? ` · hold ${(autoOpticsHeldYield * 100).toFixed(0)}%` : autoOpticsRuntimeState === "memory" ? " · restoring recent winner" : autoOpticsRuntimeState === "ae" ? " · bootstrap AE" : autoOpticsRuntimeState === "tuning" ? " · live ISO search" : ""}${autoOpticsTuneSummary ? ` · ${autoOpticsTuneSummary}` : ""}` : "off"}`'''
)

# ---------------------------------------------------------------------------
# Focus: real QR-centered AF trigger, verify camera state, recover after blur.
# ---------------------------------------------------------------------------
p = Path("receive/focus-controller.js")
s = p.read_text()
s = s.replace('seekingAfSlowRetryMs: 3000,', 'seekingAfSlowRetryMs: 4500,', 1)
s = s.replace('seekingAfFastRetries: 5,', 'seekingAfFastRetries: 3,', 1)
s = s.replace(
    '__publicField(this, "seekingAfRetries", 0);\n    __publicField(this, "lastSeekingAfAt", -Infinity);',
    '__publicField(this, "seekingAfRetries", 0);\n    __publicField(this, "seekingAfVerified", 0);\n    __publicField(this, "seekingAfUnconfirmed", 0);\n    __publicField(this, "lastSeekingAfAt", -Infinity);',
    1
)
s = s.replace(
    'this.seekingAfRetries = 0;\n    this.lastSeekingAfAt = -Infinity;',
    'this.seekingAfRetries = 0;\n    this.seekingAfVerified = 0;\n    this.seekingAfUnconfirmed = 0;\n    this.lastSeekingAfAt = -Infinity;',
    1
)
# Focus controller must not reset Auto Optics exposure behind main.js's back.
s = s.replace('this.enterAutomaticExposureState("camera opened", this.generation, true)', 'this.enterAutomaticExposureState("camera opened", this.generation, false)', 1)
s = s.replace('this.enterAutomaticExposureState("automatic focus selected", this.generation, true)', 'this.enterAutomaticExposureState("automatic focus selected", this.generation, false)', 1)
s = s.replace('this.enterAutomaticExposureState("calibration mode changed", this.generation, true)', 'this.enterAutomaticExposureState("calibration mode changed", this.generation, false)', 1)
s = s.replace('automatic focus selected; hardware AF retries + hardware AE', 'automatic focus selected; hardware AF retries; exposure retained', 1)

# Sustained, decoder-backed blur is the one case where LOCKED is allowed to
# disturb focus. Exposure is retained while AF reacquires.
old = '''      if (this.lockedFocusFailures >= requiredFocusSamples) {\n        this.lockedFocusFailures = 0;\n        this.lastReason = "sustained blur detected; focus left untouched";\n      } else if (!optimizedHold && this.lockedExposureFailures >= CAMERA_TUNING.recoverySamples) {'''
new = '''      if (this.lockedFocusFailures >= requiredFocusSamples) {\n        this.lockedFocusFailures = 0;\n        this.stableGeometry = geometry;\n        this.stableSince = now;\n        this.transition("STABILIZING", "sustained decoder-backed blur; hardware AF recovery requested");\n        void this.maybeRetrySeekingAutofocus(now, metrics, true);\n        return;\n      } else if (!optimizedHold && this.lockedExposureFailures >= CAMERA_TUNING.recoverySamples) {'''
if old not in s:
    raise SystemExit("locked focus recovery block missing")
s = s.replace(old, new, 1)

s = s.replace('poiSupported: Boolean(this.caps.pointsOfInterest),', 'poiSupported: this.pointsOfInterestSupported(),', 1)
s = s.replace(
    'focusProbes: this.focusProbes,\n      seekingAfRetries: this.seekingAfRetries,',
    'focusProbes: this.focusProbes,\n      seekingAfRetries: this.seekingAfRetries,\n      seekingAfVerified: this.seekingAfVerified,\n      seekingAfUnconfirmed: this.seekingAfUnconfirmed,',
    1
)

old = r'''  async maybeRetrySeekingAutofocus(now = performance.now(), metrics) {
    if (this.seekingAfRunning || this.strategy !== "auto" || !this.isAcquiring() || this.isOptimizing()) return;
    const track = this.track;
    if (!track || track.readyState !== "live" || !this.focusModes().includes("single-shot")) return;
    const silence = this.decodeSilence(now);
    if (this.validDecodesInGeneration > 0 && silence < 2200) return;
    if (metrics && metrics.confidence >= 0.78 && metrics.focusScore >= CAMERA_TUNING.seekingAfGoodFocus) return;
    const interval = this.seekingAfRetries < CAMERA_TUNING.seekingAfFastRetries
      ? CAMERA_TUNING.seekingAfRetryMs
      : CAMERA_TUNING.seekingAfSlowRetryMs;
    if (now - this.lastSeekingAfAt < interval) return;

    const generation = this.generation;
    this.seekingAfRunning = true;
    this.lastSeekingAfAt = now;
    this.requestedMode = "single-shot";
    this.focusProbes++;
    this.focusRefinementCount++;
    try {
      const accepted = await this.apply(track, { focusMode: "single-shot" });
      if (accepted && this.current(generation)) {
        this.seekingAfRetries++;
        const actual = this.settings();
        this.committedFocusMode = actual.focusMode;
        this.committedFocusDistance = actual.focusDistance;
        this.lastReason = `acquisition autofocus retry ${this.seekingAfRetries}; hardware AE retained`;
        this.changed();
      }
    } finally {
      this.seekingAfRunning = false;
    }
  }
'''
new = r'''  async maybeRetrySeekingAutofocus(now = performance.now(), metrics, force = false) {
    if (this.seekingAfRunning || this.strategy !== "auto" || !this.isAcquiring() || this.isOptimizing()) return;
    const track = this.track;
    if (!track || track.readyState !== "live" || !this.focusModes().includes("single-shot")) return;
    const silence = this.decodeSilence(now);
    if (!force && this.validDecodesInGeneration > 0 && silence < 2200) return;
    const optical = metrics || (!this.targetMissingSince ? this.latest?.metrics : void 0);
    if (!force && optical && optical.confidence >= 0.78 && optical.focusScore >= CAMERA_TUNING.seekingAfGoodFocus) return;
    const interval = this.seekingAfRetries < CAMERA_TUNING.seekingAfFastRetries
      ? CAMERA_TUNING.seekingAfRetryMs
      : CAMERA_TUNING.seekingAfSlowRetryMs;
    if (!force && now - this.lastSeekingAfAt < interval) return;

    const generation = this.generation;
    const geometry = !this.targetMissingSince ? this.latest?.geometry : void 0;
    const point = {
      x: Math.max(0, Math.min(1, Number.isFinite(geometry?.x) ? geometry.x : 0.5)),
      y: Math.max(0, Math.min(1, Number.isFinite(geometry?.y) ? geometry.y : 0.5))
    };
    this.seekingAfRunning = true;
    this.lastSeekingAfAt = now;
    this.requestedMode = "single-shot";
    this.focusProbes++;
    this.focusRefinementCount++;
    try {
      const accepted = await this.apply(track, {
        focusMode: "single-shot",
        ...(this.pointsOfInterestSupported() ? { pointsOfInterest: [point] } : {})
      });
      if (accepted && this.current(generation)) {
        const immediate = this.settings();
        await new Promise((resolve) => setTimeout(resolve, 80));
        if (!this.current(generation)) return;
        const actual = this.settings();
        const verified = immediate.focusMode === "single-shot" || actual.focusMode === "single-shot";
        this.seekingAfRetries++;
        if (verified) this.seekingAfVerified++;
        else this.seekingAfUnconfirmed++;
        this.committedFocusMode = actual.focusMode;
        this.committedFocusDistance = actual.focusDistance;
        this.lastReason = verified
          ? `hardware single-shot AF ${this.seekingAfRetries} at ${(point.x * 100).toFixed(0)}%,${(point.y * 100).toFixed(0)}%`
          : `AF trigger ${this.seekingAfRetries} sent at ${(point.x * 100).toFixed(0)}%,${(point.y * 100).toFixed(0)}%; camera reports ${actual.focusMode ?? "unknown"}`;
        this.changed();
      }
    } finally {
      this.seekingAfRunning = false;
    }
  }
'''
if old not in s:
    raise SystemExit("seeking AF function missing")
s = s.replace(old, new, 1)

old = r'''  async configureInitialHardwareFocusOnce() {
    if (this.automaticFocusConfigured || this.strategy !== "auto") return;
    this.automaticFocusConfigured = true;
    const track = this.track;
    if (!track || track.readyState !== "live") return;
    const modes = this.focusModes();
    if (!modes.includes("single-shot")) {
      this.lastReason = "hardware focus mode left unchanged";
      this.changed();
      return;
    }
    this.requestedMode = "single-shot";
    // Start the retry clock with the initial sweep. Without this fence the
    // first target-absent callback can issue a second single-shot immediately
    // and restart the lens before the original sweep has had time to settle.
    this.lastSeekingAfAt = performance.now();
    await this.apply(track, { focusMode: "single-shot" });
    this.committedFocusMode = this.settings().focusMode;
    this.committedFocusDistance = this.settings().focusDistance;
    this.lastReason = "initial hardware autofocus sweep requested; acquisition retries remain armed until QR decode";
    this.changed();
  }
'''
new = r'''  async configureInitialHardwareFocusOnce() {
    if (this.automaticFocusConfigured || this.strategy !== "auto") return;
    this.automaticFocusConfigured = true;
    const track = this.track;
    if (!track || track.readyState !== "live") return;
    if (!this.focusModes().includes("single-shot")) {
      this.lastReason = "single-shot autofocus unavailable; camera focus left continuous";
      this.changed();
      return;
    }
    this.lastSeekingAfAt = -Infinity;
    await this.maybeRetrySeekingAutofocus(performance.now(), void 0, true);
  }
'''
if old not in s:
    raise SystemExit("initial AF function missing")
s = s.replace(old, new, 1)

# SupportedConstraints is the standards-level signal for pointsOfInterest; some
# browsers do not expose it as a getCapabilities() member.
old = '''  focusModes() {\n    return Array.isArray(this.caps.focusMode) ? this.caps.focusMode : [];\n  }\n  overrideFocusModes() {'''
new = '''  focusModes() {\n    return Array.isArray(this.caps.focusMode) ? this.caps.focusMode : [];\n  }\n  pointsOfInterestSupported() {\n    let supported = false;\n    try {\n      supported = Boolean(navigator.mediaDevices?.getSupportedConstraints?.().pointsOfInterest);\n    } catch {\n    }\n    return Boolean(this.caps.pointsOfInterest) || supported;\n  }\n  overrideFocusModes() {'''
if old not in s:
    raise SystemExit("focusModes insertion anchor missing")
s = s.replace(old, new, 1)
p.write_text(s)

# Update diagnostic counters for AF truthfulness.
replace(
    "receive/main.js",
    '''`Counts   full AF+AE ${diagnostic.fullResetCount} · focus-only ${diagnostic.focusRefinementCount} (${diagnostic.seekingAfRetries} acquisition AF) · exposure-only ${diagnostic.exposureRefinementCount}`''',
    '''`Counts   full AF+AE ${diagnostic.fullResetCount} · focus-only ${diagnostic.focusRefinementCount} · AF pulses ${diagnostic.seekingAfRetries} (${diagnostic.seekingAfVerified} mode-confirmed · ${diagnostic.seekingAfUnconfirmed} unconfirmed) · exposure-only ${diagnostic.exposureRefinementCount}`'''
)
