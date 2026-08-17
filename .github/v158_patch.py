from pathlib import Path

root = Path('.')
p = root / 'receive/main.js'
s = p.read_text()

assert 'const RECEIVER_RUNTIME_BUILD = "v0.5.157";' in s
s = s.replace('const RECEIVER_RUNTIME_BUILD = "v0.5.157";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.158";', 1)

old = '''const AUTO_OPTICS_RESCUE_RETRY_MS = 5000;
const AUTO_OPTICS_MEMORY_KEY = "airgapper:auto-optics-memory:v1";
let autoOpticsTuneSummary = "";
let autoOpticsRuntimeState = "ae";
let autoOpticsMutationRunning = false;
let autoOpticsLockSince = 0;
let autoOpticsRetryAt = 0;
let autoOpticsAcquisitionSince = 0;
let autoOpticsRescueRetryAt = 0;'''
new = '''const AUTO_OPTICS_RESCUE_RETRY_MS = 5000;
const AUTO_OPTICS_MEMORY_KEY = "airgapper:auto-optics-memory:v1";
const AUTO_OPTICS_WARM_START_MS = 220;
const AUTO_OPTICS_FINE_INTERVAL_MS = 8000;
const AUTO_OPTICS_FINE_SAMPLE_MS = 360;
const AUTO_OPTICS_FINE_SETTLE_MS = 220;
const AUTO_OPTICS_FINE_FACTOR = Math.pow(2, 1 / 6);
const AUTO_OPTICS_FINE_IMPROVEMENT = 1.018;
let autoOpticsTuneSummary = "";
let autoOpticsRuntimeState = "ae";
let autoOpticsMutationRunning = false;
let autoOpticsLockSince = 0;
let autoOpticsRetryAt = 0;
let autoOpticsAcquisitionSince = 0;
let autoOpticsRescueRetryAt = 0;
let autoOpticsWarmStartApplied = false;
let autoOpticsFineTuneAt = 0;
let autoOpticsFineTuneDirection = 1;'''
assert old in s
s = s.replace(old, new, 1)

old = '''  autoOpticsAcquisitionSince = 0;
  autoOpticsRescueRetryAt = 0;
  autoOpticsTuneSummary = "";'''
new = '''  autoOpticsAcquisitionSince = 0;
  autoOpticsRescueRetryAt = 0;
  autoOpticsWarmStartApplied = false;
  autoOpticsFineTuneAt = 0;
  autoOpticsFineTuneDirection = 1;
  autoOpticsTuneSummary = "";'''
assert old in s
s = s.replace(old, new, 1)

start = s.index('function loadAutomaticOpticsMemory(')
end = s.index('function autoOpticsPipelineSnapshot()', start)
new_memory = r'''function readAutomaticOpticsMemory(track) {
  try {
    const all = JSON.parse(localStorage.getItem(AUTO_OPTICS_MEMORY_KEY) || "{}");
    const saved = all?.[autoOpticsMemoryKey(track)];
    if (!saved || !Number.isFinite(saved.iso) || !Number.isFinite(saved.exposure) || saved.iso <= 0 || saved.exposure <= 0)
      return void 0;
    return saved;
  } catch {
    return void 0;
  }
}
function loadAutomaticOpticsMemory(track, exposure, isoRange, cap) {
  const saved = readAutomaticOpticsMemory(track);
  if (!saved) return void 0;
  const adjusted = saved.iso * saved.exposure / Math.max(1e-6, exposure);
  return quantizeCameraRange(Math.min(cap, Math.max(isoRange.min, adjusted)), isoRange);
}
function rememberAutomaticOptics(track, exposure, iso, score = 0) {
  if (!Number.isFinite(exposure) || !Number.isFinite(iso) || exposure <= 0 || iso <= 0) return;
  try {
    const all = JSON.parse(localStorage.getItem(AUTO_OPTICS_MEMORY_KEY) || "{}");
    all[autoOpticsMemoryKey(track)] = {
      exposure,
      iso,
      score: Number.isFinite(score) ? score : 0,
      direction: autoOpticsFineTuneDirection < 0 ? -1 : 1,
      at: Date.now()
    };
    const entries = Object.entries(all).sort((a, b) => Number(b[1]?.at || 0) - Number(a[1]?.at || 0)).slice(0, 8);
    localStorage.setItem(AUTO_OPTICS_MEMORY_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
  }
}
async function warmStartRememberedAutomaticOptics(track, now) {
  if (autoOpticsWarmStartApplied || autoOpticsMutationRunning || !automaticOptics) return;
  autoOpticsWarmStartApplied = true;
  const saved = readAutomaticOpticsMemory(track);
  if (!saved) return;
  const caps = track.getCapabilities?.() ?? {};
  const exposureRange = caps.exposureTime;
  const isoRange = caps.iso;
  const settings = track.getSettings();
  if (!exposureRange || !isoRange || !Number.isFinite(settings.frameRate)) return;
  const fps = Math.max(12, Math.min(120, Number(settings.frameRate) || 30));
  const motionSafeExposure = 1e4 / fps * AUTO_OPTICS_SHUTTER_FRAME_FRACTION;
  const exposure = quantizeCameraRange(Math.min(saved.exposure, motionSafeExposure), exposureRange);
  const iso = quantizeCameraRange(saved.iso * saved.exposure / Math.max(1e-6, exposure), isoRange);
  autoOpticsFineTuneDirection = saved.direction === -1 ? -1 : 1;
  autoOpticsMutationRunning = true;
  autoOpticsRuntimeState = "warm";
  try {
    const accepted = await applyCameraConstraint(track, {
      exposureMode: "manual",
      exposureTime: exposure,
      iso
    });
    if (!accepted || !automaticOpticsSessionAlive(track)) {
      autoOpticsRuntimeState = "ae";
      return;
    }
    autoOpticsTuneSummary = `memory ${Math.round(iso)} warm start`;
    autoOpticsAcquisitionSince = now;
  } finally {
    autoOpticsMutationRunning = false;
  }
}
'''
s = s[:start] + new_memory + s[end:]

start = s.index('async function measureAutomaticIsoCandidate(')
end = s.index('function describeAutoIsoProbe(', start)
new_measure = r'''function autoOpticsConfidenceScore(outputs, attempts) {
  if (!(attempts > 0)) return 0;
  const p = Math.max(0, Math.min(1, outputs / attempts));
  const z = 1;
  const z2 = z * z;
  const denom = 1 + z2 / attempts;
  const center = p + z2 / (2 * attempts);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * attempts)) / attempts);
  return Math.max(0, (center - margin) / denom);
}
async function sampleAutomaticOpticsQuality(track, iso, sampleMs = AUTO_OPTICS_GAIN_SAMPLE_MS, poseWaitMs = AUTO_OPTICS_POSE_WAIT_MS) {
  if (!await waitForStableAutoOpticsPose(track, poseWaitMs)) {
    return {
      outputs: 0, attempts: 0, jobs: 0, rate: 0, yieldRate: 0, tracksPerJob: 0, score: 0,
      valid: false, unstable: true
    };
  }
  const before = autoOpticsPipelineSnapshot();
  const poseAnchor = autoOpticsPoseSnapshot();
  let minVisible = poseAnchor.visible;
  let maxCenterDrift = 0;
  let maxScaleDrift = 0;
  let poseStable = autoOpticsPoseUsable(poseAnchor);
  const sampleUntil = performance.now() + sampleMs;
  while (performance.now() < sampleUntil) {
    if (!automaticOpticsSessionAlive(track)) return null;
    await new Promise((resolve) => setTimeout(resolve, Math.min(40, Math.max(1, sampleUntil - performance.now()))));
    const pose = autoOpticsPoseSnapshot();
    minVisible = Math.min(minVisible, pose.visible);
    const drift = autoOpticsPoseDrift(poseAnchor, pose);
    maxCenterDrift = Math.max(maxCenterDrift, drift.center);
    maxScaleDrift = Math.max(maxScaleDrift, drift.scale);
    if (!autoOpticsPoseUsable(pose) || drift.center > AUTO_OPTICS_POSE_MAX_CENTER_DRIFT || drift.scale > AUTO_OPTICS_POSE_MAX_SCALE_LOG2)
      poseStable = false;
  }
  const after = autoOpticsPipelineSnapshot();
  const elapsed = Math.max(0.001, (after.at - before.at) / 1e3);
  const outputs = Math.max(0, after.outputs - before.outputs);
  const attempts = Math.max(0, after.attempts - before.attempts);
  const jobs = Math.max(0, after.jobs - before.jobs);
  const rate = outputs / elapsed;
  const yieldRate = attempts ? outputs / attempts : 0;
  const tracksPerJob = jobs ? attempts / jobs : 0;
  // Optics quality must not be confused with CPU scheduling. Screen recording,
  // thermal load, and worker contention can change jobs/s without changing the
  // camera image. Rank candidates by a conservative per-QR success estimate;
  // rate remains diagnostic/tie-break information only.
  const score = autoOpticsConfidenceScore(outputs, attempts);
  return {
    iso, outputs, attempts, jobs, rate, yieldRate, tracksPerJob, score,
    minVisible, maxCenterDrift, maxScaleDrift, unstable: !poseStable,
    valid: poseStable && attempts >= AUTO_OPTICS_GAIN_MIN_ATTEMPTS && jobs >= 2
  };
}
async function measureAutomaticIsoCandidate(track, exposure, requestedIso, isoRange, options = {}) {
  if (!automaticOpticsSessionAlive(track)) return null;
  const iso = quantizeCameraRange(requestedIso, isoRange);
  const accepted = await applyCameraConstraint(track, {
    exposureMode: "manual",
    exposureTime: exposure,
    iso
  });
  if (!accepted || !automaticOpticsSessionAlive(track)) return null;
  const settleMs = options.settleMs ?? AUTO_OPTICS_GAIN_SETTLE_MS;
  const sampleMs = options.sampleMs ?? AUTO_OPTICS_GAIN_SAMPLE_MS;
  const poseWaitMs = options.poseWaitMs ?? AUTO_OPTICS_POSE_WAIT_MS;
  if (!await waitForAutoOptics(settleMs, track)) return null;
  const sample = await sampleAutomaticOpticsQuality(track, iso, sampleMs, poseWaitMs);
  if (!sample) return null;
  const actualIso = Number(track.getSettings().iso);
  return {
    ...sample,
    iso: Number.isFinite(actualIso) ? actualIso : iso,
    requestedIso: iso
  };
}
'''
s = s[:start] + new_measure + s[end:]

# A remembered camera should not look like a first-use five-probe search. Validate
# memory locally, then let the steady-state hill climber continue later.
tune_start = s.index('async function tuneAutomaticQrIso(')
mem_start = s.index('  if (remembered !== void 0) {', tune_start)
else_marker = s.index('  } else {\n    // First use', mem_start)
new_mem_branch = r'''  if (remembered !== void 0) {
    const factor = AUTO_OPTICS_FINE_FACTOR;
    const direction = autoOpticsFineTuneDirection < 0 ? -1 : 1;
    const neighbor = await probe(base * (direction > 0 ? factor : 1 / factor));
    if (!automaticOpticsSessionAlive(track)) return { iso: base, probes };
    if (better(neighbor, baseline)) {
      autoOpticsFineTuneDirection = direction;
    } else {
      autoOpticsFineTuneDirection = -direction;
      // Only spend a third startup probe when remembered quality is clearly
      // weak. Normal reloads therefore settle after memory + one local check.
      if ((baseline?.yieldRate ?? 0) < 0.52 && measured.size < 3)
        await probe(base * (direction > 0 ? 1 / factor : factor));
    }
'''
s = s[:mem_start] + new_mem_branch + s[else_marker:]

old = '''    autoOpticsRuntimeState = "manual";
    // Automatic optics is intentionally one-way for this camera session.
    // Continuous AE reacts to the animated QR wall itself and repeatedly moves
    // a scene that decodes better when held still. Once we have a verified QR
    // lock, keep this manual exposure through ordinary loss/reacquisition.
    autoOpticsRetryAt = Infinity;
    preferredExposureTime = track.getSettings().exposureTime ?? exposure;
    preferredIso = track.getSettings().iso ?? tuned.iso ?? iso;
    if (tuned.best?.valid) rememberAutomaticOptics(track, preferredExposureTime, preferredIso);
    saveCameraSettings();'''
new = '''    autoOpticsRuntimeState = "manual";
    // Hold the winner, but keep Auto Optics alive as a very low-duty-cycle
    // controller. It may test one nearby ISO later when geometry is stable.
    autoOpticsRetryAt = Infinity;
    autoOpticsFineTuneAt = receiverNow() + AUTO_OPTICS_FINE_INTERVAL_MS;
    preferredExposureTime = track.getSettings().exposureTime ?? exposure;
    preferredIso = track.getSettings().iso ?? tuned.iso ?? iso;
    if (tuned.best?.valid) rememberAutomaticOptics(track, preferredExposureTime, preferredIso, tuned.best.score);
    saveCameraSettings();'''
assert old in s
s = s.replace(old, new, 1)

insert_at = s.index('async function releaseAutomaticQrOptics(')
fine = r'''async function fineTuneAutomaticQrOptics(track, now) {
  if (autoOpticsMutationRunning || autoOpticsRuntimeState !== "manual" || !automaticOptics || now < autoOpticsFineTuneAt)
    return;
  const caps = track.getCapabilities?.() ?? {};
  const isoRange = caps.iso;
  const settings = track.getSettings();
  if (!isoRange || !Number.isFinite(settings.exposureTime) || !Number.isFinite(settings.iso)) {
    autoOpticsFineTuneAt = now + AUTO_OPTICS_FINE_INTERVAL_MS;
    return;
  }
  if (!autoOpticsPoseUsable(autoOpticsPoseSnapshot())) {
    autoOpticsFineTuneAt = now + 1800;
    return;
  }
  const exposure = settings.exposureTime;
  const currentIso = quantizeCameraRange(settings.iso, isoRange);
  const direction = autoOpticsFineTuneDirection < 0 ? -1 : 1;
  const candidateIso = quantizeCameraRange(
    currentIso * (direction > 0 ? AUTO_OPTICS_FINE_FACTOR : 1 / AUTO_OPTICS_FINE_FACTOR),
    isoRange
  );
  if (candidateIso === currentIso) {
    autoOpticsFineTuneDirection = -direction;
    autoOpticsFineTuneAt = now + AUTO_OPTICS_FINE_INTERVAL_MS;
    return;
  }

  autoOpticsMutationRunning = true;
  autoOpticsRuntimeState = "fine";
  try {
    // Baseline is passive: do not rewrite the sensor merely to measure it.
    const baseline = await sampleAutomaticOpticsQuality(track, currentIso, AUTO_OPTICS_FINE_SAMPLE_MS, 700);
    if (!baseline?.valid) {
      autoOpticsTuneSummary = `steady ISO ${Math.round(currentIso)} · fine tune deferred`;
      autoOpticsFineTuneAt = receiverNow() + 2200;
      return;
    }
    const candidate = await measureAutomaticIsoCandidate(track, exposure, candidateIso, isoRange, {
      settleMs: AUTO_OPTICS_FINE_SETTLE_MS,
      sampleMs: AUTO_OPTICS_FINE_SAMPLE_MS,
      poseWaitMs: 700
    });
    if (!candidate?.valid) {
      await applyCameraConstraint(track, { exposureMode: "manual", exposureTime: exposure, iso: currentIso });
      autoOpticsTuneSummary = `steady ${Math.round(currentIso)} · ${Math.round(candidateIso)}:move/reframe`;
      autoOpticsFineTuneAt = receiverNow() + 2200;
      return;
    }
    const improved = candidate.score > baseline.score * AUTO_OPTICS_FINE_IMPROVEMENT;
    if (improved) {
      preferredIso = candidate.iso;
      autoOpticsFineTuneDirection = direction;
      rememberAutomaticOptics(track, exposure, candidate.iso, candidate.score);
      saveCameraSettings();
      autoOpticsTuneSummary = `steady ${Math.round(currentIso)}:${(baseline.yieldRate * 100).toFixed(0)}% · probe ${Math.round(candidate.iso)}:${(candidate.yieldRate * 100).toFixed(0)}% → ${Math.round(candidate.iso)}`;
      autoOpticsFineTuneAt = receiverNow() + Math.round(AUTO_OPTICS_FINE_INTERVAL_MS * 0.75);
    } else {
      await applyCameraConstraint(track, { exposureMode: "manual", exposureTime: exposure, iso: currentIso });
      preferredIso = currentIso;
      autoOpticsFineTuneDirection = -direction;
      rememberAutomaticOptics(track, exposure, currentIso, baseline.score);
      autoOpticsTuneSummary = `steady ${Math.round(currentIso)}:${(baseline.yieldRate * 100).toFixed(0)}% · probe ${Math.round(candidate.iso)}:${(candidate.yieldRate * 100).toFixed(0)}% → keep`;
      autoOpticsFineTuneAt = receiverNow() + AUTO_OPTICS_FINE_INTERVAL_MS;
    }
  } finally {
    autoOpticsRuntimeState = "manual";
    autoOpticsMutationRunning = false;
  }
}

'''
s = s[:insert_at] + fine + s[insert_at:]

# Replace acquisition rescue so a failed remembered warm start really returns to
# hardware AE before constructing AE-relative rescue candidates.
start = s.index('async function rescueAutomaticQrAcquisition(')
end = s.index('\nfunction maintainAutomaticQrOptics(', start)
new_rescue = r'''async function rescueAutomaticQrAcquisition(track, now) {
  if (autoOpticsMutationRunning || !automaticOptics || gridLattice.locked || now < autoOpticsRescueRetryAt) return;
  const caps = track.getCapabilities?.() ?? {};
  const exposureRange = caps.exposureTime;
  const isoRange = caps.iso;
  let settings = track.getSettings();
  if (!Array.isArray(caps.exposureMode) || !caps.exposureMode.includes("manual") || !exposureRange || !isoRange) {
    autoOpticsRescueRetryAt = now + AUTO_OPTICS_RESCUE_RETRY_MS;
    return;
  }
  const startedFromWarm = autoOpticsRuntimeState === "warm";
  autoOpticsMutationRunning = true;
  autoOpticsRuntimeState = "rescue";
  notePipelineEvent("auto-optics-acquisition-rescue");
  try {
    if (startedFromWarm) {
      await applyExposureSetting(track);
      if (!await waitForAutoOptics(420, track)) return;
      settings = track.getSettings();
    }
    if (!Number.isFinite(settings.exposureTime) || !Number.isFinite(settings.iso) || settings.exposureTime <= 0 || settings.iso <= 0) {
      autoOpticsRuntimeState = "ae";
      autoOpticsRescueRetryAt = receiverNow() + AUTO_OPTICS_RESCUE_RETRY_MS;
      return;
    }
    const fps = Math.max(12, Math.min(120, Number(settings.frameRate) || 30));
    const motionSafeExposure = 1e4 / fps * AUTO_OPTICS_SHUTTER_FRAME_FRACTION;
    const exposureProduct = settings.exposureTime * settings.iso;
    const exposure = quantizeCameraRange(Math.min(settings.exposureTime, motionSafeExposure), exposureRange);
    const aeIso = quantizeCameraRange(exposureProduct / Math.max(exposureRange.min, exposure), isoRange);
    const maxAutoIso = Math.min(isoRange.max, Math.max(isoRange.min, settings.iso * 4));
    const remembered = loadAutomaticOpticsMemory(track, exposure, isoRange, isoRange.max);
    const candidates = [];
    const add = (value) => {
      if (!Number.isFinite(value)) return;
      const candidate = quantizeCameraRange(Math.min(maxAutoIso, Math.max(isoRange.min, value)), isoRange);
      if (!candidates.some((prior) => Math.abs(prior - candidate) <= Math.max(Number(isoRange.step) || 0, candidate * 0.01)))
        candidates.push(candidate);
    };
    add(remembered);
    add(aeIso);
    add(aeIso * 2);
    add(aeIso / 2);

    for (const candidate of candidates) {
      if (!automaticOpticsSessionAlive(track)) return;
      autoOpticsTuneSummary = `acquisition rescue · ISO ${Math.round(candidate)}`;
      const accepted = await applyCameraConstraint(track, {
        exposureMode: "manual",
        exposureTime: exposure,
        iso: candidate
      });
      if (!accepted || !automaticOpticsSessionAlive(track)) continue;
      if (!await waitForAutoOptics(AUTO_OPTICS_RESCUE_SETTLE_MS, track)) return;
      const evidenceStart = receiverNow();
      if (!await waitForAutoOptics(AUTO_OPTICS_RESCUE_SAMPLE_MS, track)) return;
      const freshDecodes = qrReadTimes.reduce((count, at) => count + Number(at >= evidenceStart), 0);
      if (gridLattice.locked || freshDecodes >= 2) {
        autoOpticsRuntimeState = "ae";
        autoOpticsLockSince = 0;
        autoOpticsAcquisitionSince = receiverNow();
        autoOpticsRescueRetryAt = receiverNow() + 2500;
        autoOpticsTuneSummary = `acquisition rescue · ISO ${Math.round(candidate)} found QR`;
        return;
      }
    }
    await applyExposureSetting(track);
    autoOpticsRuntimeState = "ae";
    autoOpticsLockSince = 0;
    autoOpticsAcquisitionSince = receiverNow();
    autoOpticsRescueRetryAt = receiverNow() + AUTO_OPTICS_RESCUE_RETRY_MS;
    autoOpticsTuneSummary = "acquisition rescue deferred";
  } finally {
    autoOpticsMutationRunning = false;
  }
}
'''
s = s[:start] + new_rescue + s[end:]

start = s.index('function maintainAutomaticQrOptics(')
end = s.index('\n\nfunction populateBrowserCapabilities(', start)
new_maintain = r'''function maintainAutomaticQrOptics(now) {
  if (!automaticOptics || replayRunning || optimizerPipelineActive || optimizeRunning || autoOpticsMutationRunning) return;
  const track = stream?.getVideoTracks()[0];
  if (!track || track.readyState !== "live") return;
  if (!autoOpticsAcquisitionSince) autoOpticsAcquisitionSince = now;

  if (autoOpticsRuntimeState === "manual") {
    if (now >= autoOpticsFineTuneAt && gridLattice.locked && autoOpticsPoseUsable(autoOpticsPoseSnapshot()))
      void fineTuneAutomaticQrOptics(track, now);
    return;
  }
  if (autoOpticsRuntimeState !== "ae" && autoOpticsRuntimeState !== "warm") return;

  if (!autoOpticsWarmStartApplied && now - autoOpticsAcquisitionSince >= AUTO_OPTICS_WARM_START_MS) {
    void warmStartRememberedAutomaticOptics(track, now);
    return;
  }
  if (!gridLattice.locked) {
    autoOpticsLockSince = 0;
    if (now - autoOpticsAcquisitionSince >= AUTO_OPTICS_ACQUISITION_RESCUE_MS && now >= autoOpticsRescueRetryAt)
      void rescueAutomaticQrAcquisition(track, now);
    return;
  }
  if (!autoOpticsPoseUsable(autoOpticsPoseSnapshot())) {
    autoOpticsLockSince = 0;
    return;
  }
  if (!autoOpticsLockSince) autoOpticsLockSince = now;
  if (now - autoOpticsLockSince < AUTO_OPTICS_LOCK_SETTLE_MS || now < autoOpticsRetryAt) return;

  const settings = track.getSettings();
  const recentDecodes = qrReadTimes.reduce((count, at) => count + Number(at > now - AUTO_OPTICS_RECENT_DECODE_MS), 0);
  const recentQrRate = recentDecodes / (AUTO_OPTICS_RECENT_DECODE_MS / 1e3);
  const captureWindowMs = 800;
  const recentCaptureRate = captureTimes.reduce((count, at) => count + Number(at > now - captureWindowMs), 0) / (captureWindowMs / 1e3);
  const nominalFps = Math.max(12, Math.min(120, Number(settings.frameRate) || 30));
  const decodeFresh = Boolean(lastStreamDecodeAt && now - lastStreamDecodeAt < AUTO_OPTICS_RECENT_DECODE_MS);
  if (decodeFresh && recentQrRate >= AUTO_OPTICS_MIN_SETTLE_QR_PER_SECOND && recentCaptureRate >= nominalFps * 0.78)
    void settleAutomaticQrOptics(track, now);
}
'''
s = s[:start] + new_maintain + s[end:]

# Fine-tune/recovery mutations should not be hidden by adjacent-repeat filtering.
s = s.replace(
'''    !replayRunning && !optimizerPipelineActive && autoOpticsRuntimeState !== "tuning" && !captureNextScan''',
'''    !replayRunning && !optimizerPipelineActive && !["tuning", "fine", "rescue", "settling"].includes(autoOpticsRuntimeState) && !captureNextScan''',
1)

# Diagnostics: scheduled camera frames are not equivalent to productive decode FPS.
s = s.replace('· decode frames ${decodeSourceRate.toFixed(1)}/s · jobs', '· scheduled frames ${decodeSourceRate.toFixed(1)}/s · jobs', 1)
s = s.replace('metric("m-cap").textContent = `${decodeFrameRate.toFixed(1)} fps`;', 'metric("m-cap").textContent = `${decodeFrameRate.toFixed(1)} scan/s`;', 1)
s = s.replace(
'''`AutoOptics ${automaticOptics ? autoOpticsRuntimeState : "off"}${autoOpticsRuntimeState === "manual" ? " · locked for session" : autoOpticsRuntimeState === "ae" ? " · bootstrap AE" : autoOpticsRuntimeState === "tuning" ? " · live ISO search" : ""}${autoOpticsTuneSummary ? ` · ${autoOpticsTuneSummary}` : ""}`''',
'''`AutoOptics ${automaticOptics ? autoOpticsRuntimeState : "off"}${autoOpticsRuntimeState === "manual" ? " · adaptive hold" : autoOpticsRuntimeState === "warm" ? " · remembered start" : autoOpticsRuntimeState === "ae" ? " · bootstrap AE" : autoOpticsRuntimeState === "tuning" ? " · live ISO search" : autoOpticsRuntimeState === "fine" ? " · micro-tuning" : ""}${autoOpticsTuneSummary ? ` · ${autoOpticsTuneSummary}` : ""}`''',
1)

p.write_text(s)

for name in ['index.html', 'main.js']:
    p = root / name
    text = p.read_text()
    assert 'v0.5.157' in text, name
    p.write_text(text.replace('v0.5.157', 'v0.5.158'))

p = root / 'sw.js'
text = p.read_text()
assert 'airgapper-static-js-v119' in text
p.write_text(text.replace('airgapper-static-js-v119', 'airgapper-static-js-v120', 1))
