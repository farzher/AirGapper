from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"replacement not found in {path}: {old[:180]!r}")
    p.write_text(s.replace(old, new, count))


def replace_span(path, start, end, new):
    p = Path(path)
    s = p.read_text()
    a = s.find(start)
    if a < 0:
        raise SystemExit(f"start marker missing in {path}: {start!r}")
    b = s.find(end, a)
    if b < 0:
        raise SystemExit(f"end marker missing in {path}: {end!r}")
    p.write_text(s[:a] + new + s[b:])


# Version/cache bump.
replace("index.html", "v0.5.192", "v0.5.193")
replace("main.js", 'const APP_BUILD = "v0.5.192";', 'const APP_BUILD = "v0.5.193";')
replace("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.192";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.193";')
replace("sw.js", 'const CACHE = "airgapper-static-js-v154";', 'const CACHE = "airgapper-static-js-v155";')

# ---------------------------------------------------------------------------
# Exposure controls do not own focus. Touching ISO/exposure must never disable AF.
# ---------------------------------------------------------------------------
replace("receive/main.js", '  focusController.developerOverride("developer changed exposure time");\n', '')
replace("receive/main.js", '  focusController.developerOverride("developer changed ISO");\n', '')

# ---------------------------------------------------------------------------
# Focus constraints: advanced sets are allowed to be silently skipped. For an
# explicit focus mode, make focusMode mandatory at the top level so success is
# meaningful. Keep the advanced path for sensor/exposure and numeric controls.
# ---------------------------------------------------------------------------
old_apply_stage = '''    const applyStage = async (stage) => {\n      if (!Object.keys(stage).length) return true;\n      if (stage.focusMode !== void 0 || stage.focusDistance !== void 0 || stage.pointsOfInterest !== void 0) cameraFocusWritesTotal++;\n      if (stage.exposureMode !== void 0 || stage.exposureTime !== void 0 || stage.iso !== void 0 || stage.exposureCompensation !== void 0) cameraExposureWritesTotal++;\n      const ok = await applyAdvancedConstraint(track, stage);\n      accepted && (accepted = ok);\n      return ok;\n    };'''
new_apply_stage = '''    const applyStage = async (stage) => {\n      if (!Object.keys(stage).length) return true;\n      const focusStage = stage.focusMode !== void 0 || stage.focusDistance !== void 0 || stage.pointsOfInterest !== void 0;\n      const exposureStage = stage.exposureMode !== void 0 || stage.exposureTime !== void 0 || stage.iso !== void 0 || stage.exposureCompensation !== void 0;\n      if (focusStage) cameraFocusWritesTotal++;\n      if (exposureStage) cameraExposureWritesTotal++;\n      let ok = false;\n      if (focusStage && !exposureStage && stage.focusMode !== void 0) {\n        // A bare member inside advanced[] is best-effort and may be ignored while\n        // applyConstraints() still resolves. Make focusMode mandatory. Keep POI\n        // as the simple Point2D sequence because Chromium supports that form.\n        const constraints = { focusMode: { exact: stage.focusMode } };\n        if (stage.pointsOfInterest !== void 0) constraints.pointsOfInterest = stage.pointsOfInterest;\n        try {\n          await track.applyConstraints(constraints);\n          ok = true;\n        } catch {\n          ok = false;\n        }\n      } else {\n        ok = await applyAdvancedConstraint(track, stage);\n      }\n      accepted && (accepted = ok);\n      return ok;\n    };'''
replace("receive/main.js", old_apply_stage, new_apply_stage)

# ---------------------------------------------------------------------------
# Persistent optics learning: keep several recent tested configurations, not one
# brittle winner. A fresh failed retest temporarily cools a configuration but
# never destroys older evidence.
# ---------------------------------------------------------------------------
replace(
    "receive/main.js",
    '''const AUTO_OPTICS_RESCUE_SETTLE_MS = 280;\nconst AUTO_OPTICS_RESCUE_SAMPLE_MS = 720;\nconst AUTO_OPTICS_RESCUE_RETRY_MS = 12000;''',
    '''const AUTO_OPTICS_RESCUE_RETRY_MS = 12000;\nconst AUTO_OPTICS_ACQUIRE_SCAN_MAX_EXPOSURE = 100; // 10 ms, exposureTime is 100 us units\nconst AUTO_OPTICS_HISTORY_KEY = "airgapper:auto-optics-learning:v1";\nconst AUTO_OPTICS_HISTORY_LIMIT = 32;\nconst AUTO_OPTICS_HISTORY_MAX_AGE_MS = 24 * 60 * 60 * 1000;\nconst AUTO_OPTICS_HISTORY_BAD_COOLDOWN_MS = 5 * 60 * 1000;'''
)

# A collapse means "not valid now", not "forget that it ever worked".
replace(
    "receive/main.js",
    '''function forgetAutomaticOptics(track) {\n  try {\n    const all = JSON.parse(localStorage.getItem(AUTO_OPTICS_MEMORY_KEY) || "{}");\n    const key = autoOpticsMemoryKey(track);\n    if (!(key in all)) return;\n    delete all[key];\n    localStorage.setItem(AUTO_OPTICS_MEMORY_KEY, JSON.stringify(all));\n  } catch {\n  }\n}''',
    '''function forgetAutomaticOptics(track) {\n  try {\n    const all = JSON.parse(localStorage.getItem(AUTO_OPTICS_MEMORY_KEY) || "{}");\n    const key = autoOpticsMemoryKey(track);\n    const saved = all[key];\n    if (!saved || typeof saved !== "object") return;\n    saved.invalidatedAt = Date.now();\n    all[key] = saved;\n    localStorage.setItem(AUTO_OPTICS_MEMORY_KEY, JSON.stringify(all));\n  } catch {\n  }\n}'''
)
replace(
    "receive/main.js",
    '''  if (!saved || Date.now() - Number(saved.at || 0) > AUTO_OPTICS_MEMORY_FRESH_MS) return void 0;''',
    '''  if (!saved || Date.now() - Number(saved.at || 0) > AUTO_OPTICS_MEMORY_FRESH_MS) return void 0;\n  if (saved.invalidatedAt && Date.now() - Number(saved.invalidatedAt) < AUTO_OPTICS_HISTORY_BAD_COOLDOWN_MS) return void 0;''',
    1
)
replace("receive/main.js", 'memory cleared · hardware AE reacquire', 'memory cooled · hardware AE reacquire')
replace("receive/main.js", 'memory cleared · hardware AE reacquire', 'memory cooled · hardware AE reacquire')

# Insert the multi-setting history immediately before readAutomaticOpticsMemory().
p = Path("receive/main.js")
s = p.read_text()
anchor = '''function readAutomaticOpticsMemory(track) {'''
if anchor not in s:
    raise SystemExit("memory history insertion anchor missing")
history = r'''function autoOpticsHistoryConfigKey(exposure, iso) {
  return `${Number(exposure).toFixed(2)}/${Number(iso).toFixed(1)}`;
}
function readAutomaticOpticsHistory(track) {
  try {
    const all = JSON.parse(localStorage.getItem(AUTO_OPTICS_HISTORY_KEY) || "{}");
    const raw = Array.isArray(all[autoOpticsMemoryKey(track)]) ? all[autoOpticsMemoryKey(track)] : [];
    const now = Date.now();
    const groups = new Map();
    for (const item of raw) {
      if (!item || !Number.isFinite(item.exposure) || !Number.isFinite(item.iso) || item.exposure <= 0 || item.iso <= 0) continue;
      if (now - Number(item.at || 0) > AUTO_OPTICS_HISTORY_MAX_AGE_MS) continue;
      const key = autoOpticsHistoryConfigKey(item.exposure, item.iso);
      const group = groups.get(key) || [];
      group.push(item);
      groups.set(key, group);
    }
    const candidates = [];
    for (const group of groups.values()) {
      group.sort((a, b) => Number(b.at || 0) - Number(a.at || 0));
      const latest = group[0];
      if (Number(latest.validDecodes || 0) <= 0 && now - Number(latest.at || 0) < AUTO_OPTICS_HISTORY_BAD_COOLDOWN_MS) continue;
      const good = group.find((item) => Number(item.validDecodes || 0) > 0 || Number(item.rate || 0) > 0);
      if (good) candidates.push(good);
    }
    const priority = (item) => {
      const age = Math.max(0, now - Number(item.at || 0));
      const freshness = Math.exp(-age / (6 * 60 * 60 * 1000));
      return freshness * (1 + Math.min(4, Number(item.rate || 0) / 20) + Math.min(2, Number(item.yieldRate || 0) * 2));
    };
    candidates.sort((a, b) => priority(b) - priority(a));
    return candidates;
  } catch {
    return [];
  }
}
function bestAutomaticOpticsHistory(track) {
  return readAutomaticOpticsHistory(track)[0];
}
function rememberAutomaticOpticsHistory(track, exposure, iso, performance) {
  if (!Number.isFinite(exposure) || !Number.isFinite(iso) || exposure <= 0 || iso <= 0 || !performance) return;
  try {
    const all = JSON.parse(localStorage.getItem(AUTO_OPTICS_HISTORY_KEY) || "{}");
    const key = autoOpticsMemoryKey(track);
    const raw = Array.isArray(all[key]) ? all[key] : [];
    raw.unshift({
      exposure,
      iso,
      rate: Number(performance.validDecodesPerSecond || 0),
      yieldRate: Number(performance.perQrAttemptSuccessRate || 0),
      validDecodes: Number(performance.validDecodes || 0),
      qrAttempts: Number(performance.qrAttempts || 0),
      sourceFrames: Number(performance.sourceFrames || 0),
      at: Date.now()
    });
    all[key] = raw.slice(0, AUTO_OPTICS_HISTORY_LIMIT);
    const deviceEntries = Object.entries(all).slice(-8);
    localStorage.setItem(AUTO_OPTICS_HISTORY_KEY, JSON.stringify(Object.fromEntries(deviceEntries)));
  } catch {
  }
}
'''
s = s.replace(anchor, history + anchor, 1)
p.write_text(s)

# Startup winner can come from either the current winner cache or learned history.
replace(
    "receive/main.js",
    '''  const saved = usableAutomaticOpticsMemory(track);\n  const canRestore = automaticOpticsMemoryHealthy(saved) &&''',
    '''  const saved = usableAutomaticOpticsMemory(track) ?? bestAutomaticOpticsHistory(track);\n  const canRestore = automaticOpticsMemoryHealthy(saved) &&''',
    1
)

# Acquisition racing needs short delayed-feedback drains. Capture attribution is
# already epoch-tagged; a late worker completion updates its original candidate.
replace(
    "receive/main.js",
    '''  const targetFrames = discovery ? phase === "commit" ? 6 : phase === "verify" ? 4 : phase === "finalist" ? 4 : phase === "revisit" ? 3 : 2 : phase === "commit" ? singleQr ? 7 : 6 : phase === "verify" ? singleQr ? 5 : 4 : phase === "finalist" ? singleQr ? 5 : 4 : phase === "revisit" ? singleQr ? 5 : 3 : phase === "refine" ? singleQr ? 4 : 3 : singleQr ? 4 : 3;\n  const maxBurstMs = discovery ? phase === "commit" ? 1100 : phase === "verify" ? 800 : phase === "finalist" ? 800 : 650 : phase === "commit" ? 1100 : phase === "verify" ? 800 : phase === "finalist" ? 800 : singleQr ? 750 : 550;''',
    '''  const targetFrames = discovery ? phase === "race" ? 2 : phase === "commit" ? 6 : phase === "verify" ? 4 : phase === "finalist" ? 4 : phase === "revisit" ? 3 : 2 : phase === "commit" ? singleQr ? 7 : 6 : phase === "verify" ? singleQr ? 5 : 4 : phase === "finalist" ? singleQr ? 5 : 4 : phase === "revisit" ? singleQr ? 5 : 3 : phase === "refine" ? singleQr ? 4 : 3 : singleQr ? 4 : 3;\n  const maxBurstMs = discovery ? phase === "race" ? 420 : phase === "commit" ? 1100 : phase === "verify" ? 800 : phase === "finalist" ? 800 : 650 : phase === "commit" ? 1100 : phase === "verify" ? 800 : phase === "finalist" ? 800 : singleQr ? 750 : 550;'''
)
replace(
    "receive/main.js",
    '''    const waitStartedAt = receiverNow();\n    while (token === optimizeMeasureToken && evidence.completedJobs < evidence.submittedJobs && receiverNow() - waitStartedAt < 6e3) {\n      await new Promise((resolve) => setTimeout(resolve, 20));\n    }''',
    '''    const waitStartedAt = receiverNow();\n    const drainMs = phase === "race" ? 900 : 6e3;\n    while (token === optimizeMeasureToken && evidence.completedJobs < evidence.submittedJobs && receiverNow() - waitStartedAt < drainMs) {\n      if (phase === "race" && evidence.validDecodes > 0) break;\n      await new Promise((resolve) => setTimeout(resolve, 20));\n    }'''
)

# High-value acquisition candidates: exploit recent winners first, then randomized
# frame-safe shutter/gain combinations. Exposure and ISO are independent axes;
# there is no longer any "must be darker than AE" invariant.
p = Path("receive/main.js")
s = p.read_text()
anchor = '''async function rescueAutomaticQrAcquisition(track, now) {'''
if anchor not in s:
    raise SystemExit("rescue insertion anchor missing")
helpers = r'''function shuffleAutomaticOpticsCandidates(items) {
  const result = [...items];
  const random = () => {
    try {
      const value = new Uint32Array(1);
      crypto.getRandomValues(value);
      return value[0] / 4294967296;
    } catch {
      return Math.random();
    }
  };
  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}
function buildAutomaticOpticsAcquisitionCandidates(track, aeBaseline, exposureRange, isoRange, fps) {
  const motionSafeExposure = 1e4 / fps * AUTO_OPTICS_SHUTTER_FRAME_FRACTION;
  const safeExposure = quantizeCameraRange(
    Math.min(exposureRange.max, AUTO_OPTICS_ACQUIRE_SCAN_MAX_EXPOSURE, motionSafeExposure),
    exposureRange
  );
  const minIso = quantizeCameraRange(isoRange.min, isoRange);
  const candidates = [];
  const seen = new Set();
  const add = (exposureRaw, isoRaw, label, priority = false) => {
    const exposure = quantizeCameraRange(exposureRaw, exposureRange);
    const iso = quantizeCameraRange(isoRaw, isoRange);
    const key = autoOpticsHistoryConfigKey(exposure, iso);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ exposure, iso, label, priority });
  };

  for (const item of readAutomaticOpticsHistory(track).slice(0, 3))
    add(item.exposure, item.iso, "learned", true);
  const memory = usableAutomaticOpticsMemory(track);
  if (memory) add(memory.exposure, memory.iso, "recent winner", true);
  // This is the most important general bootstrap on a 30 fps phone: 10 ms at
  // minimum gain. It is frame-safe, low-noise, and unlike the old algorithm it
  // remains reachable even when hardware AE starts at a 1-2 ms shutter.
  add(safeExposure, minIso, "frame-safe", true);

  const explore = [];
  const pushExplore = (exposure, iso, label) => {
    const before = candidates.length;
    add(exposure, iso, label, false);
    if (candidates.length > before) explore.push(candidates.pop());
  };
  pushExplore(safeExposure * 0.72, minIso, "shorter");
  pushExplore(safeExposure * 0.48, minIso, "short");
  pushExplore(safeExposure * 0.32, minIso, "very short");
  pushExplore(safeExposure, minIso * Math.SQRT2, "more gain");
  pushExplore(safeExposure * 0.72, minIso * Math.SQRT2, "balanced");
  pushExplore(safeExposure * 0.48, minIso * 2, "fast gain");
  pushExplore(aeBaseline.exposure, aeBaseline.iso, "hardware AE");
  return [...candidates, ...shuffleAutomaticOpticsCandidates(explore)];
}
async function measureAutomaticAcquisitionCandidate(track, candidate, index, total) {
  const id = `AUTO-RACE-${index + 1}`;
  autoOpticsTuneSummary = `race ${index + 1}/${total} · ${candidate.label} · ${formatExposureMs(candidate.exposure)} · ISO ${Math.round(candidate.iso)}`;
  optimizerEpochHooks.transition({ candidateId: id, requestedExposure: candidate.exposure, requestedIso: candidate.iso });
  const accepted = await applyCameraConstraint(track, {
    exposureMode: "manual",
    exposureTime: candidate.exposure,
    iso: candidate.iso
  });
  if (!accepted || !automaticOpticsSessionAlive(track)) return null;
  const actual = track.getSettings();
  if (!Number.isFinite(actual.exposureTime) || !Number.isFinite(actual.iso)) return null;
  const epoch = await optimizerEpochHooks.open({
    candidateId: id,
    requestedExposure: candidate.exposure,
    requestedIso: candidate.iso,
    actualExposure: actual.exposureTime,
    actualIso: actual.iso
  });
  if (epoch === void 0 || !automaticOpticsSessionAlive(track)) return null;
  const sample = await measureReceivePerformance("race", epoch);
  optimizerEpochHooks.close(epoch);
  const performance = await sample.result;
  rememberAutomaticOpticsHistory(track, actual.exposureTime, actual.iso, performance);
  return { candidate, exposure: actual.exposureTime, iso: actual.iso, performance };
}
'''
s = s.replace(anchor, helpers + anchor, 1)
p.write_text(s)

new_rescue = r'''async function rescueAutomaticQrAcquisition(track, now) {
  if (autoOpticsMutationRunning || !automaticOptics || gridLattice.locked || now < autoOpticsRescueRetryAt) return;
  const caps = track.getCapabilities?.() ?? {};
  const exposureRange = caps.exposureTime;
  const isoRange = caps.iso;
  const settings = track.getSettings();
  if (!Array.isArray(caps.exposureMode) || !caps.exposureMode.includes("manual") || !exposureRange || !isoRange ||
      !Number.isFinite(settings.exposureTime) || !Number.isFinite(settings.iso) || settings.exposureTime <= 0 || settings.iso <= 0) {
    autoOpticsRescueRetryAt = now + AUTO_OPTICS_RESCUE_RETRY_MS;
    return;
  }

  const fps = Math.max(12, Math.min(120, Number(settings.frameRate) || 30));
  const aeBaseline = { exposure: settings.exposureTime, iso: settings.iso, at: receiverNow() };
  const candidates = buildAutomaticOpticsAcquisitionCandidates(track, aeBaseline, exposureRange, isoRange, fps);
  if (!candidates.length) {
    autoOpticsRescueRetryAt = now + AUTO_OPTICS_RESCUE_RETRY_MS;
    return;
  }

  autoOpticsMutationRunning = true;
  autoOpticsRuntimeState = "rescue";
  autoOpticsAeBaseline = aeBaseline;
  optimizerDiscoveryMode = true;
  optimizeMeasureToken++;
  notePipelineEvent("auto-optics-acquisition-race");
  let winner = null;
  try {
    for (let index = 0; index < candidates.length; index++) {
      if (!automaticOpticsSessionAlive(track) || gridLattice.locked) break;
      const measured = await measureAutomaticAcquisitionCandidate(track, candidates[index], index, candidates.length);
      if (!measured) continue;
      if (measured.performance.validDecodes > 0) {
        winner = measured;
        break;
      }
    }

    if (winner) {
      const p = winner.performance;
      autoOpticsRuntimeState = "ae";
      autoOpticsLockSince = 0;
      autoOpticsAcquisitionSince = receiverNow();
      autoOpticsRescueRetryAt = receiverNow() + AUTO_OPTICS_RESCUE_RETRY_MS;
      autoOpticsTuneSummary = `race hit · ${winner.candidate.label} · ${formatExposureMs(winner.exposure)} · ISO ${Math.round(winner.iso)} · ${p.validDecodes} QR`;
      rememberAutomaticOptics(
        track,
        winner.exposure,
        winner.iso,
        p.perQrAttemptSuccessRate,
        p.perQrAttemptSuccessRate,
        aeBaseline.exposure * aeBaseline.iso
      );
      focusController.adoptAutomaticCameraState("acquisition optics race found a QR-proven setting");
      notePipelineEvent("auto-optics-acquisition-race-hit");
      return;
    }

    // If no exposure decoded, do not keep oscillating brightness. Hold the best
    // prior / frame-safe candidate and hand recovery back to autofocus. A focus
    // failure cannot be repaired by repeatedly making the image darker.
    const hold = candidates[0];
    await applyCameraConstraint(track, {
      exposureMode: "manual",
      exposureTime: hold.exposure,
      iso: hold.iso
    });
    const actual = track.getSettings();
    autoOpticsRuntimeState = "ae";
    autoOpticsLockSince = 0;
    autoOpticsAcquisitionSince = receiverNow();
    autoOpticsRescueRetryAt = receiverNow() + AUTO_OPTICS_RESCUE_RETRY_MS;
    autoOpticsTuneSummary = `race miss · holding ${hold.label} ${formatExposureMs(actual.exposureTime ?? hold.exposure)} · ISO ${Math.round(actual.iso ?? hold.iso)} · AF recovery continues`;
    focusController.adoptAutomaticCameraState("exposure race found no QR; holding frame-safe optics for focus recovery");
    notePipelineEvent("auto-optics-acquisition-race-miss");
  } finally {
    optimizerEpochHooks.finish();
    optimizerDiscoveryMode = false;
    autoOpticsMutationRunning = false;
  }
}

'''
replace_span(
    "receive/main.js",
    "async function rescueAutomaticQrAcquisition(track, now) {",
    "function maintainAcquisitionAutofocus(now) {",
    new_rescue
)

# ---------------------------------------------------------------------------
# Focus controller: mandatory single-shot first. If the browser rejects it or
# twice fails to report it, stop pretending and drive continuous AF by moving its
# QR-centered metering region. Exposure stays untouched.
# ---------------------------------------------------------------------------
p = Path("receive/focus-controller.js")
s = p.read_text()
s = s.replace(
    '__publicField(this, "seekingAfUnconfirmed", 0);\n    __publicField(this, "lastSeekingAfAt", -Infinity);',
    '__publicField(this, "seekingAfUnconfirmed", 0);\n    __publicField(this, "singleShotAfRejected", false);\n    __publicField(this, "continuousAfNudges", 0);\n    __publicField(this, "lastSeekingAfAt", -Infinity);',
    1
)
s = s.replace(
    'this.seekingAfUnconfirmed = 0;\n    this.lastSeekingAfAt = -Infinity;',
    'this.seekingAfUnconfirmed = 0;\n    this.singleShotAfRejected = false;\n    this.continuousAfNudges = 0;\n    this.lastSeekingAfAt = -Infinity;',
    1
)
s = s.replace(
    'poiSupported: this.pointsOfInterestSupported(),',
    'poiSupported: this.pointsOfInterestSupported(),\n      hardwareFocusModes: [...this.focusModes()],\n      actualPointsOfInterest: settings.pointsOfInterest,',
    1
)
s = s.replace(
    'seekingAfUnconfirmed: this.seekingAfUnconfirmed,',
    'seekingAfUnconfirmed: this.seekingAfUnconfirmed,\n      singleShotAfRejected: this.singleShotAfRejected,\n      continuousAfNudges: this.continuousAfNudges,',
    1
)
p.write_text(s)

new_af = r'''  async maybeRetrySeekingAutofocus(now = performance.now(), metrics, force = false) {
    if (this.seekingAfRunning || this.strategy !== "auto" || !this.isAcquiring() || this.isOptimizing()) return;
    const track = this.track;
    if (!track || track.readyState !== "live") return;
    const modes = this.focusModes();
    const canSingle = modes.includes("single-shot") && !this.singleShotAfRejected;
    const canContinuous = modes.includes("continuous") || this.settings().focusMode === "continuous";
    if (!canSingle && !canContinuous) return;
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
    const centerX = Math.max(0, Math.min(1, Number.isFinite(geometry?.x) ? geometry.x : 0.5));
    const centerY = Math.max(0, Math.min(1, Number.isFinite(geometry?.y) ? geometry.y : 0.5));
    const offsets = [[0, 0], [-0.025, 0], [0.025, 0], [0, -0.025], [0, 0.025]];
    const offset = offsets[this.seekingAfRetries % offsets.length];
    const point = {
      x: Math.max(0, Math.min(1, centerX + offset[0])),
      y: Math.max(0, Math.min(1, centerY + offset[1]))
    };
    this.seekingAfRunning = true;
    this.lastSeekingAfAt = now;
    this.focusProbes++;
    this.focusRefinementCount++;
    this.seekingAfRetries++;
    try {
      if (canSingle) {
        this.requestedMode = "single-shot";
        const accepted = await this.apply(track, {
          focusMode: "single-shot",
          ...(this.pointsOfInterestSupported() ? { pointsOfInterest: [point] } : {})
        });
        if (!this.current(generation)) return;
        if (accepted) {
          const immediate = this.settings();
          await new Promise((resolve) => setTimeout(resolve, 100));
          if (!this.current(generation)) return;
          const actual = this.settings();
          const verified = immediate.focusMode === "single-shot" || actual.focusMode === "single-shot";
          if (verified) {
            this.seekingAfVerified++;
            this.committedFocusMode = actual.focusMode;
            this.committedFocusDistance = actual.focusDistance;
            this.lastReason = `mandatory single-shot AF confirmed at ${(point.x * 100).toFixed(0)}%,${(point.y * 100).toFixed(0)}%`;
            this.changed();
            return;
          }
          this.seekingAfUnconfirmed++;
          if (this.seekingAfUnconfirmed >= 2) this.singleShotAfRejected = true;
        } else {
          this.seekingAfUnconfirmed++;
          this.singleShotAfRejected = true;
        }
      }

      if (canContinuous) {
        this.requestedMode = "continuous";
        const accepted = await this.apply(track, {
          focusMode: "continuous",
          ...(this.pointsOfInterestSupported() ? { pointsOfInterest: [point] } : {})
        });
        if (!this.current(generation)) return;
        const actual = this.settings();
        if (accepted) this.continuousAfNudges++;
        this.committedFocusMode = actual.focusMode;
        this.committedFocusDistance = actual.focusDistance;
        this.lastReason = accepted
          ? `continuous AF metering nudge ${this.continuousAfNudges} at ${(point.x * 100).toFixed(0)}%,${(point.y * 100).toFixed(0)}%${this.singleShotAfRejected ? "; single-shot rejected" : ""}`
          : "camera rejected autofocus controls; continuous hardware AF left running";
        this.changed();
      }
    } finally {
      this.seekingAfRunning = false;
    }
  }
'''
replace_span(
    "receive/focus-controller.js",
    "  async maybeRetrySeekingAutofocus(now = performance.now(), metrics, force = false) {",
    "  async configureInitialHardwareFocusOnce() {",
    new_af
)

new_initial_af = r'''  async configureInitialHardwareFocusOnce() {
    if (this.automaticFocusConfigured || this.strategy !== "auto") return;
    this.automaticFocusConfigured = true;
    const track = this.track;
    if (!track || track.readyState !== "live") return;
    const modes = this.focusModes();
    if (!modes.includes("single-shot") && !modes.includes("continuous") && this.settings().focusMode !== "continuous") {
      this.lastReason = "hardware autofocus controls unavailable";
      this.changed();
      return;
    }
    this.lastSeekingAfAt = -Infinity;
    await this.maybeRetrySeekingAutofocus(performance.now(), void 0, true);
  }
'''
replace_span(
    "receive/focus-controller.js",
    "  async configureInitialHardwareFocusOnce() {",
    "  async applyDeveloperFocus() {",
    new_initial_af
)

# Diagnostics make the fallback behavior explicit.
replace(
    "receive/main.js",
    '''    `Focus    requested ${(_e = diagnostic.requestedMode) != null ? _e : "—"} · actual ${(_f = diagnostic.actualMode) != null ? _f : "—"} · distance ${(_g = diagnostic.actualDistance) != null ? _g : "—"}`,\n    `Focus    committed ${(_h = diagnostic.committedFocusMode) != null ? _h : "—"}/${(_i = diagnostic.committedFocusDistance) != null ? _i : "—"}`,''',
    '''    `Focus    requested ${(_e = diagnostic.requestedMode) != null ? _e : "—"} · actual ${(_f = diagnostic.actualMode) != null ? _f : "—"} · distance ${(_g = diagnostic.actualDistance) != null ? _g : "—"}`,\n    `AF       modes ${(diagnostic.hardwareFocusModes ?? []).join(",") || "—"} · POI ${diagnostic.poiSupported ? "yes" : "no"} · single-shot ${diagnostic.singleShotAfRejected ? "rejected" : diagnostic.seekingAfVerified ? "confirmed" : "unproven"} · ROI nudges ${diagnostic.continuousAfNudges}`,\n    `Focus    committed ${(_h = diagnostic.committedFocusMode) != null ? _h : "—"}/${(_i = diagnostic.committedFocusDistance) != null ? _i : "—"}`,'''
)
replace(
    "receive/main.js",
    '''`Counts   full AF+AE ${diagnostic.fullResetCount} · focus-only ${diagnostic.focusRefinementCount} · AF pulses ${diagnostic.seekingAfRetries} (${diagnostic.seekingAfVerified} mode-confirmed · ${diagnostic.seekingAfUnconfirmed} unconfirmed) · exposure-only ${diagnostic.exposureRefinementCount}`''',
    '''`Counts   full AF+AE ${diagnostic.fullResetCount} · focus-only ${diagnostic.focusRefinementCount} · AF pulses ${diagnostic.seekingAfRetries} (${diagnostic.seekingAfVerified} single-shot · ${diagnostic.seekingAfUnconfirmed} rejected/unconfirmed · ${diagnostic.continuousAfNudges} ROI) · exposure-only ${diagnostic.exposureRefinementCount}`'''
)
