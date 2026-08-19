from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected exactly one match, found {count}: {old[:220]!r}")
    p.write_text(text.replace(old, new, 1))


def replace_between(path, start, end, replacement):
    p = Path(path)
    text = p.read_text()
    a = text.find(start)
    if a < 0:
        raise RuntimeError(f"{path}: missing start marker {start!r}")
    b = text.find(end, a)
    if b < 0:
        raise RuntimeError(f"{path}: missing end marker {end!r}")
    p.write_text(text[:a] + replacement.rstrip() + "\n" + text[b:])


main = "receive/main.js"

# The old controller could make dozens of sensor writes during a live transfer.
# Replace its global-search assumptions with a conservative, task-driven policy:
# acquire under hardware AE, freeze a QR-proven baseline, probe only when that
# baseline is genuinely weak, and then hold until a sustained non-temporal collapse.
replace_once(main, "const AUTO_OPTICS_COHORT_MAX_SLOTS = 18;", "const AUTO_OPTICS_COHORT_MAX_SLOTS = 12;")
replace_once(main, "const AUTO_OPTICS_ACQUISITION_RESCUE_MS = 650;", "const AUTO_OPTICS_ACQUISITION_RESCUE_MS = 1200;")
replace_once(main, "const AUTO_OPTICS_COLLAPSE_YIELD = 0.25;", "const AUTO_OPTICS_COLLAPSE_YIELD = 0.12;")
replace_once(main, "const AUTO_OPTICS_COLLAPSE_RETRY_MS = 900;", "const AUTO_OPTICS_COLLAPSE_RETRY_MS = 1500;")
replace_once(main, "const AUTO_OPTICS_HOLD_COLLAPSE_MS = 1400;", "const AUTO_OPTICS_HOLD_COLLAPSE_MS = 2500;")
replace_once(main, "const AUTO_OPTICS_HOLD_DEGRADE_RATIO = 0.70;", """const AUTO_OPTICS_HOLD_DEGRADE_RATIO = 0.45;
const AUTO_OPTICS_BASELINE_SAMPLE_MS = 320;
const AUTO_OPTICS_CANDIDATE_SAMPLE_MS = 280;
const AUTO_OPTICS_HEALTHY_HOLD_YIELD = 0.82;
const AUTO_OPTICS_ACCEPT_YIELD_GAIN = 0.06;
const AUTO_OPTICS_ACCEPT_SCORE_RATIO = 1.06;
const AUTO_OPTICS_AE_RESCUE_DWELL_MS = 700;
const AUTO_OPTICS_AE_RESCUE_RETRY_MS = 3000;
const AUTO_OPTICS_SHORT_EXPOSURE_TRIGGER = 55; // 5.5 ms""")
replace_once(main, "let autoOpticsRescueRetryAt = 0;\nlet autoOpticsHoldSample;", """let autoOpticsRescueRetryAt = 0;
let autoOpticsAeRescueStep = 0;
let autoOpticsAeBias = 0;
let autoOpticsHoldSample;""")
replace_once(main, "  autoOpticsRescueRetryAt = 0;\n  autoOpticsHoldSample = void 0;", """  autoOpticsRescueRetryAt = 0;
  autoOpticsAeRescueStep = 0;
  autoOpticsAeBias = 0;
  autoOpticsHoldSample = void 0;""")

replace_between(
    main,
    "async function primeAutomaticQrOpticsStartup(track) {",
    "async function abandonAutomaticOpticsStartupMemory(track, reason = \"startup winner produced no QR\") {",
    r'''async function primeAutomaticQrOpticsStartup(track) {
  if (!automaticOpticsSessionAlive(track) || autoOpticsMutationRunning) return;
  // Acquisition authority is hardware AE. A stale remembered/manual setting is
  // never allowed to make the camera blind before the first QR proves itself.
  autoOpticsMutationRunning = true;
  try {
    autoOpticsRuntimeState = "ae";
    autoOpticsMemoryBootAt = 0;
    autoOpticsMemoryBoot = void 0;
    autoOpticsHeldYield = 0;
    autoOpticsHoldSample = void 0;
    autoOpticsHoldCollapseSince = 0;
    autoOpticsAeRescueStep = 0;
    autoOpticsAeBias = 0;
    const baseline = await readAutomaticAeBaseline(track);
    if (!automaticOpticsSessionAlive(track)) return;
    autoOpticsAeBaseline = baseline;
    const now = receiverNow();
    autoOpticsAcquisitionSince = now;
    autoOpticsRetryAt = 0;
    autoOpticsRescueRetryAt = now + AUTO_OPTICS_ACQUISITION_RESCUE_MS;
    const settings = track.getSettings();
    autoOpticsTuneSummary = baseline
      ? `hardware AE acquisition · ${formatExposureMs(settings.exposureTime)} · ISO ${Math.round(settings.iso)}`
      : "hardware AE acquisition";
    focusController.adoptAutomaticCameraState("hardware AE owns acquisition until a QR proves the scene");
    notePipelineEvent("auto-optics-ae-acquire");
  } finally {
    autoOpticsMutationRunning = false;
  }
}
'''
)

replace_between(
    main,
    "async function recoverCollapsedAutomaticOptics(track, yieldRate, reason = \"held optics collapsed\") {",
    "async function waitForFreshAutoOpticsFrames(track, afterSequence, frames = CAMERA_TUNING.exposureDiscardFrames, timeoutMs = 420) {",
    r'''async function recoverCollapsedAutomaticOptics(track, yieldRate, reason = "held optics collapsed") {
  if (autoOpticsMutationRunning || !automaticOptics || !automaticOpticsSessionAlive(track)) return;
  autoOpticsMutationRunning = true;
  try {
    // Roll back to the camera's own meter, not another guessed manual candidate.
    // Once AE produces live QR again the normal post-lock path freezes that exact
    // QR-proven setting and, only if weak, performs one bounded local bracket.
    const baseline = await readAutomaticAeBaseline(track);
    if (!automaticOpticsSessionAlive(track)) return;
    autoOpticsAeBaseline = baseline;
    autoOpticsRuntimeState = "ae";
    const now = receiverNow();
    autoOpticsLockSince = gridLattice.locked ? now : 0;
    autoOpticsAcquisitionSince = now;
    autoOpticsRetryAt = now + AUTO_OPTICS_COLLAPSE_RETRY_MS;
    autoOpticsRescueRetryAt = now + AUTO_OPTICS_ACQUISITION_RESCUE_MS;
    autoOpticsAeRescueStep = 0;
    autoOpticsAeBias = 0;
    autoOpticsHoldSample = void 0;
    autoOpticsHoldCollapseSince = 0;
    autoOpticsHeldYield = 0;
    autoOpticsTuneSummary = `${reason} ${(yieldRate * 100).toFixed(0)}% · neutral hardware AE recovery`;
    focusController.adoptAutomaticCameraState("held QR-proven optics genuinely collapsed; neutral hardware AE restored");
    notePipelineEvent("auto-optics-hold-collapse");
  } finally {
    autoOpticsMutationRunning = false;
  }
}
'''
)

replace_between(
    main,
    "async function settleAutomaticQrOptics(track, now) {",
    "async function releaseAutomaticQrOptics(track, now) {",
    r'''async function settleAutomaticQrOptics(track, now) {
  if (autoOpticsMutationRunning || !automaticOptics || now < autoOpticsRetryAt) return;
  const caps = track.getCapabilities?.() ?? {};
  const exposureRange = caps.exposureTime;
  const isoRange = caps.iso;
  const settings = track.getSettings();
  const canManual = Array.isArray(caps.exposureMode) && caps.exposureMode.includes("manual") && exposureRange && isoRange;
  const baselineExposure = Number(settings.exposureTime);
  const baselineIso = Number(settings.iso);
  if (!canManual || !(baselineExposure > 0) || !(baselineIso > 0)) {
    // If the browser will not give us trustworthy manual control, continuous AE
    // is safer than pretending we optimized it.
    autoOpticsRetryAt = Infinity;
    autoOpticsTuneSummary = "hardware AE hold · manual exposure unavailable";
    return;
  }
  if (!await waitForStableAutoOpticsPose(track, AUTO_OPTICS_POSE_WAIT_MS)) {
    autoOpticsLockSince = now;
    autoOpticsRetryAt = now + 600;
    autoOpticsTuneSummary = "hardware AE · waiting for stable QR geometry";
    return;
  }

  autoOpticsMutationRunning = true;
  autoOpticsRuntimeState = "settling";
  notePipelineEvent("auto-optics-freeze-ae");
  try {
    // Android's recommended AE->manual handoff: copy the values which just
    // produced valid camera results. This is our always-safe rollback point.
    const frozenExposure = quantizeCameraRange(baselineExposure, exposureRange);
    const frozenIso = quantizeCameraRange(baselineIso, isoRange);
    const accepted = await applyCameraConstraint(track, {
      exposureMode: "manual",
      exposureTime: frozenExposure,
      iso: frozenIso
    });
    if (!accepted || !automaticOpticsSessionAlive(track)) {
      autoOpticsRuntimeState = "ae";
      autoOpticsRetryAt = Infinity;
      autoOpticsTuneSummary = "hardware AE hold · manual freeze rejected";
      return;
    }
    const freezeSequence = latestSourceFrameSequence;
    await waitForFreshAutoOpticsFrames(track, freezeSequence, CAMERA_TUNING.exposureDiscardFrames, 500);
    if (!automaticOpticsSessionAlive(track)) return;

    const cohortSize = beginAutomaticOpticsMeasurementCohort();
    if (!cohortSize) {
      autoOpticsRuntimeState = "manual";
      autoOpticsHeldYield = 0.5;
      autoOpticsRetryAt = Infinity;
      autoOpticsHoldSample = autoOpticsPipelineSnapshot();
      autoOpticsTuneSummary = `QR-proven AE frozen · ${formatExposureMs(frozenExposure)} · ISO ${Math.round(frozenIso)} · no stable cohort`;
      return;
    }

    const baseline = await sampleAutomaticOpticsQuality(
      track, frozenIso, latestSourceFrameSequence + 1, AUTO_OPTICS_BASELINE_SAMPLE_MS
    );
    if (!baseline || baseline.unstable || !baseline.valid) {
      autoOpticsRuntimeState = "manual";
      autoOpticsHeldYield = Math.max(0.35, Number(baseline?.yieldRate) || 0);
      autoOpticsRetryAt = Infinity;
      autoOpticsHoldSample = autoOpticsPipelineSnapshot();
      autoOpticsTuneSummary = `QR-proven AE frozen · ${formatExposureMs(frozenExposure)} · ISO ${Math.round(frozenIso)} · calibration skipped`;
      focusController.adoptAutomaticCameraState("QR-proven AE frozen; local comparison lacked stable evidence so no further camera mutation was allowed");
      return;
    }

    let best = { ...baseline, exposure: frozenExposure, iso: frozenIso, label: "AE baseline" };
    const temporal = predictedTemporalBand(latestSourceFrameSequence + 1, receiverNow());
    const temporalDominant = Boolean(temporal && temporal.confidence >= 0.55);
    const shouldProbe = baseline.yieldRate < AUTO_OPTICS_HEALTHY_HOLD_YIELD &&
      !(temporalDominant && baseline.yieldRate >= 0.25);

    if (shouldProbe) {
      autoOpticsRuntimeState = "tuning";
      const candidates = [];
      const seen = new Set([`${frozenExposure}/${frozenIso}`]);
      const add = (exposureRaw, isoRaw, label) => {
        const exposure = quantizeCameraRange(exposureRaw, exposureRange);
        const iso = quantizeCameraRange(isoRaw, isoRange);
        const key = `${exposure}/${iso}`;
        if (!(exposure > 0) || !(iso > 0) || seen.has(key)) return;
        seen.add(key);
        candidates.push({ exposure, iso, label });
      };
      add(frozenExposure, frozenIso / Math.SQRT2, "darker");
      add(frozenExposure, frozenIso * Math.SQRT2, "brighter");
      if (frozenExposure > AUTO_OPTICS_SHORT_EXPOSURE_TRIGGER) {
        const shorter = quantizeCameraRange(Math.max(exposureRange.min, Math.min(50, frozenExposure / Math.SQRT2)), exposureRange);
        add(shorter, frozenIso * frozenExposure / Math.max(exposureRange.min, shorter), "shorter shutter");
      }

      for (const candidate of candidates.slice(0, 3)) {
        if (!automaticOpticsSessionAlive(track)) return;
        if (!await waitForStableAutoOpticsPose(track, 420)) break;
        autoOpticsTuneSummary = `bounded bracket · ${candidate.label} · ${formatExposureMs(candidate.exposure)} · ISO ${Math.round(candidate.iso)}`;
        const measured = await measureAutomaticIsoCandidate(
          track, candidate.exposure, candidate.iso, isoRange,
          { sampleMs: AUTO_OPTICS_CANDIDATE_SAMPLE_MS, settleTimeoutMs: 420 }
        );
        if (!measured || measured.unstable || !measured.valid) {
          // Geometry moved or evidence disappeared. The QR-proven baseline wins;
          // never keep searching while the scene changes underneath us.
          best = { ...baseline, exposure: frozenExposure, iso: frozenIso, label: "AE baseline" };
          break;
        }
        const yieldGain = measured.yieldRate - best.yieldRate;
        const scoreRatio = best.score > 0 ? measured.score / best.score : Infinity;
        if (yieldGain >= AUTO_OPTICS_ACCEPT_YIELD_GAIN && scoreRatio >= AUTO_OPTICS_ACCEPT_SCORE_RATIO) {
          best = { ...measured, exposure: measured.exposure, iso: measured.iso, label: candidate.label };
        }
      }
    }

    const winnerExposure = quantizeCameraRange(best.exposure || frozenExposure, exposureRange);
    const winnerIso = quantizeCameraRange(best.iso || frozenIso, isoRange);
    await applyCameraConstraint(track, {
      exposureMode: "manual",
      exposureTime: winnerExposure,
      iso: winnerIso
    });
    if (!automaticOpticsSessionAlive(track)) return;
    autoOpticsRuntimeState = "manual";
    autoOpticsHeldYield = Math.max(0.01, Number(best.yieldRate) || Number(baseline.yieldRate) || 0.5);
    autoOpticsHoldSample = autoOpticsPipelineSnapshot();
    autoOpticsHoldCollapseSince = 0;
    autoOpticsRetryAt = Infinity;
    autoOpticsAeBaseline = { exposure: frozenExposure, iso: frozenIso, at: receiverNow(), neutral: false };
    if (autoOpticsHeldYield >= AUTO_OPTICS_MEMORY_MIN_YIELD)
      rememberAutomaticOptics(track, winnerExposure, winnerIso, Number(best.score) || 0, autoOpticsHeldYield, frozenExposure * frozenIso);
    autoOpticsTuneSummary = `${best.label || "AE baseline"} · ${formatExposureMs(winnerExposure)} · ISO ${Math.round(winnerIso)} · hold ${(autoOpticsHeldYield * 100).toFixed(0)}%${temporalDominant ? " · temporal seam present; no brightness chase" : ""}`;
    focusController.adoptAutomaticCameraState("bounded QR-proven automatic optics converged; sensor values are now held for the session");
    notePipelineEvent("auto-optics-converged", Math.round(autoOpticsHeldYield * 100));
  } finally {
    autoOpticsMeasurementSlots = void 0;
    autoOpticsMutationRunning = false;
  }
}
'''
)

replace_between(
    main,
    "async function rescueAutomaticQrAcquisition(track, now) {",
    "function maintainAcquisitionAutofocus(now) {",
    r'''async function applyAutomaticAeCompensation(track, requestedEv, label) {
  const caps = track.getCapabilities?.() ?? {};
  const range = caps.exposureCompensation;
  if (!range) return false;
  const ev = quantizeCameraRange(requestedEv, range);
  delete desiredCamera.exposureTime;
  delete desiredCamera.iso;
  desiredCamera.exposureMode = "continuous";
  desiredCamera.exposureCompensation = ev;
  const accepted = await applyCameraConstraint(track, {
    exposureMode: "continuous",
    exposureCompensation: ev
  });
  if (!accepted || !automaticOpticsSessionAlive(track)) return false;
  const actual = track.getSettings();
  autoOpticsAeBias = Number.isFinite(actual.exposureCompensation) ? actual.exposureCompensation : ev;
  autoOpticsTuneSummary = `${label} · hardware AE ${autoOpticsAeBias >= 0 ? "+" : ""}${Number(autoOpticsAeBias.toFixed(2))} EV`;
  return true;
}

async function rescueAutomaticQrAcquisition(track, now) {
  if (autoOpticsMutationRunning || !automaticOptics || gridLattice.locked || now < autoOpticsRescueRetryAt) return;
  const caps = track.getCapabilities?.() ?? {};
  const range = caps.exposureCompensation;
  if (!range || !(range.min < 0 || range.max > 0)) {
    autoOpticsRescueRetryAt = now + 5000;
    autoOpticsTuneSummary = "hardware AE acquisition · EV rescue unavailable";
    return;
  }

  const candidates = [];
  const add = (raw, label) => {
    const value = quantizeCameraRange(raw, range);
    if (!candidates.some((item) => Math.abs(item.value - value) < 1e-6)) candidates.push({ value, label });
  };
  if (range.min < 0) add(Math.max(range.min, -1), "dark rescue");
  if (range.max > 0) add(Math.min(range.max, 1), "bright rescue");
  add(0, "neutral retry");
  if (!candidates.length) return;

  const step = autoOpticsAeRescueStep % candidates.length;
  const candidate = candidates[step];
  autoOpticsMutationRunning = true;
  autoOpticsRuntimeState = "rescue";
  try {
    const accepted = await applyAutomaticAeCompensation(track, candidate.value, candidate.label);
    if (!accepted) {
      autoOpticsRescueRetryAt = receiverNow() + AUTO_OPTICS_AE_RESCUE_RETRY_MS;
      return;
    }
    const appliedSequence = latestSourceFrameSequence;
    await waitForFreshAutoOpticsFrames(track, appliedSequence, 2, 420);
    autoOpticsAeRescueStep = (step + 1) % candidates.length;
    const completedCycle = autoOpticsAeRescueStep === 0;
    autoOpticsRescueRetryAt = receiverNow() + (completedCycle ? AUTO_OPTICS_AE_RESCUE_RETRY_MS : AUTO_OPTICS_AE_RESCUE_DWELL_MS);
    notePipelineEvent("auto-optics-ae-rescue", Math.round(candidate.value * 100));
  } finally {
    if (automaticOpticsSessionAlive(track)) autoOpticsRuntimeState = "ae";
    autoOpticsMutationRunning = false;
  }
}

'''
)

replace_between(
    main,
    "function maintainAutomaticQrOptics(now) {",
    "function populateBrowserCapabilities(track) {",
    r'''function maintainAutomaticQrOptics(now) {
  if (!automaticOptics || replayRunning || optimizerPipelineActive || optimizeRunning || autoOpticsMutationRunning) return;
  const track = stream?.getVideoTracks()[0];
  if (!track || track.readyState !== "live") return;
  if (!autoOpticsAcquisitionSince) autoOpticsAcquisitionSince = now;

  if (autoOpticsRuntimeState === "manual") {
    const poseUsable = gridLattice.locked && autoOpticsPoseUsable(autoOpticsPoseSnapshot());
    if (!poseUsable) {
      autoOpticsHoldSample = void 0;
      autoOpticsHoldCollapseSince = 0;
      return;
    }
    if (!autoOpticsHoldSample || now - autoOpticsHoldSample.at < AUTO_OPTICS_HOLD_SAMPLE_MS) return;
    const sample = autoOpticsPipelineSnapshot();
    const attempts = Math.max(0, sample.attempts - autoOpticsHoldSample.attempts);
    const outputs = Math.max(0, sample.outputs - autoOpticsHoldSample.outputs);
    autoOpticsHoldSample = sample;
    if (attempts < AUTO_OPTICS_HOLD_MIN_ATTEMPTS) return;

    const yieldRate = outputs / attempts;
    const degradationThreshold = Math.max(AUTO_OPTICS_COLLAPSE_YIELD, autoOpticsHeldYield * AUTO_OPTICS_HOLD_DEGRADE_RATIO);
    const temporal = predictedTemporalBand(latestSourceFrameSequence + 1, now);
    const temporalBusy = Boolean(temporal && temporal.confidence >= 0.45);
    // Rolling-shutter bands and camera motion are not brightness evidence. Do not
    // let them destabilize the sensor controller.
    if (temporalBusy || decoderFreshnessHoldActive) {
      autoOpticsHoldCollapseSince = 0;
      return;
    }
    if (yieldRate >= degradationThreshold) {
      autoOpticsHoldCollapseSince = 0;
      return;
    }
    if (!autoOpticsHoldCollapseSince) {
      autoOpticsHoldCollapseSince = now;
      return;
    }
    if (now - autoOpticsHoldCollapseSince >= AUTO_OPTICS_HOLD_COLLAPSE_MS) {
      const reason = yieldRate < AUTO_OPTICS_COLLAPSE_YIELD
        ? "held optics nearly blind"
        : `held optics persistently degraded from ${(autoOpticsHeldYield * 100).toFixed(0)}%`;
      void recoverCollapsedAutomaticOptics(track, yieldRate, reason);
    }
    return;
  }

  if (autoOpticsRuntimeState === "rescue" || autoOpticsRuntimeState === "tuning" || autoOpticsRuntimeState === "settling") return;
  // Old session states from previous controller generations are not authoritative.
  if (autoOpticsRuntimeState === "memory" || autoOpticsRuntimeState === "seed") autoOpticsRuntimeState = "ae";
  if (autoOpticsRuntimeState !== "ae") return;

  if (!gridLattice.locked) {
    autoOpticsLockSince = 0;
    const recentDecode = Boolean(lastStreamDecodeAt && lastStreamDecodeAt >= autoOpticsAcquisitionSince && now - lastStreamDecodeAt < AUTO_OPTICS_RECENT_DECODE_MS);
    if (!recentDecode && now - autoOpticsAcquisitionSince >= AUTO_OPTICS_ACQUISITION_RESCUE_MS && now >= autoOpticsRescueRetryAt)
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
  if (decodeFresh && recentQrRate >= AUTO_OPTICS_MIN_SETTLE_QR_PER_SECOND && recentCaptureRate >= nominalFps * 0.72)
    void settleAutomaticQrOptics(track, now);
}


'''
)

# Make diagnostics describe what the new state machine actually does.
replace_once(main, 'autoOpticsRuntimeState === "rescue" ? " · acquisition exposure search"', 'autoOpticsRuntimeState === "rescue" ? " · acquisition AE bias"')
replace_once(main, 'autoOpticsRuntimeState === "ae" ? " · AE meter/fallback"', 'autoOpticsRuntimeState === "ae" ? " · hardware AE"')
replace_once(main, 'autoOpticsRuntimeState === "tuning" ? " · live ISO search"', 'autoOpticsRuntimeState === "tuning" ? " · bounded local bracket"')

# v334 was still an unpromoted experiment. Supersede it deliberately: v335 is
# based on the proven v333 hot path and changes only JS camera-control behavior.
replace_once(main, 'const RECEIVER_RUNTIME_BUILD = "v0.5.333";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.335";')
replace_once("send/main.js", 'const SEND_RUNTIME_BUILD = "v0.5.333";', 'const SEND_RUNTIME_BUILD = "v0.5.335";')
replace_once("main.js", 'const APP_BUILD = "v0.5.333";', 'const APP_BUILD = "v0.5.335";')
replace_once("index.html", '<span class="app-version">v0.5.333</span>', '<span class="app-version">v0.5.335</span>')
replace_once("index.html", './main.js?build=v0.5.333', './main.js?build=v0.5.335')
replace_once("sw.js", 'const CACHE = "airgapper-static-js-v281";', 'const CACHE = "airgapper-static-js-v283";')

print("staged v0.5.335: QR-proven bounded Auto Optics controller")
