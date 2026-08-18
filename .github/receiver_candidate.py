from pathlib import Path
import re


def rep(path, old, new):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"missing anchor {path}: {old[:220]}")
    p.write_text(s.replace(old, new, 1))


def sub(path, pattern, replacement):
    p = Path(path)
    s = p.read_text()
    out, count = re.subn(pattern, replacement, s, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f"regex anchor count {count} in {path}: {pattern[:180]}")
    p.write_text(out)


# Version/cache.
rep('receive/main.js', 'const RECEIVER_RUNTIME_BUILD = "v0.5.285";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.286";')
rep('send/main.js', 'const SEND_RUNTIME_BUILD = "v0.5.285";', 'const SEND_RUNTIME_BUILD = "v0.5.286";')
rep('main.js', 'const APP_BUILD = "v0.5.285";', 'const APP_BUILD = "v0.5.286";')
rep('index.html', 'main.js?build=v0.5.285', 'main.js?build=v0.5.286')
rep('sw.js', 'airgapper-static-js-v233', 'airgapper-static-js-v234')

# AirGapper is an animated emissive binary target, not a conventional photo.
# Prefer a short integration and use gain only until decoding becomes robust.
rep('receive/main.js', 'const AUTO_QR_EV_BIAS = -0.7;', 'const AUTO_QR_EV_BIAS = -0.8;')
rep('receive/main.js', 'const AUTO_OPTICS_LOCK_SETTLE_MS = 1400;', 'const AUTO_OPTICS_LOCK_SETTLE_MS = 450;')
rep('receive/main.js', 'const AUTO_OPTICS_SHUTTER_FRAME_FRACTION = 0.30;', '''const AUTO_OPTICS_SHUTTER_FRAME_FRACTION = 0.10;
const AUTO_OPTICS_MAX_SHORT_EXPOSURE = 35; // 3.5 ms; exposureTime uses 0.1 ms units
const AUTO_OPTICS_FALLBACK_EXPOSURE = 50; // one 5 ms escape hatch for genuinely dark scenes''')
rep('receive/main.js', 'const AUTO_OPTICS_GAIN_SAMPLE_MS = 520;', 'const AUTO_OPTICS_GAIN_SAMPLE_MS = 360;')
rep('receive/main.js', 'const AUTO_OPTICS_GAIN_MIN_ATTEMPTS = 12;', 'const AUTO_OPTICS_GAIN_MIN_ATTEMPTS = 10;')
rep('receive/main.js', 'const AUTO_OPTICS_GAIN_MAX_PROBES = 5;', '''const AUTO_OPTICS_GAIN_MAX_PROBES = 4;
const AUTO_OPTICS_TARGET_YIELD = 0.78;
const AUTO_OPTICS_NEAR_BEST_SCORE = 0.94;
const AUTO_OPTICS_NEAR_BEST_YIELD_DELTA = 0.07;
const AUTO_OPTICS_AE_PRODUCT_CEILING = 1.50;''')
rep('receive/main.js', 'const AUTO_OPTICS_POSE_STABLE_MS = 260;', 'const AUTO_OPTICS_POSE_STABLE_MS = 140;')
rep('receive/main.js', 'const AUTO_OPTICS_POSE_WAIT_MS = 1800;', 'const AUTO_OPTICS_POSE_WAIT_MS = 700;')
rep('receive/main.js', 'const AUTO_OPTICS_HISTORY_KEY = "airgapper:auto-optics-learning:v1";', 'const AUTO_OPTICS_HISTORY_KEY = "airgapper:auto-optics-learning:v2";')
rep('receive/main.js', 'const AUTO_OPTICS_MEMORY_KEY = "airgapper:auto-optics-memory:v1";', 'const AUTO_OPTICS_MEMORY_KEY = "airgapper:auto-optics-memory:v2";')
rep('receive/focus-controller.js', 'const AUTO_QR_EV_BIAS = -0.7;', 'const AUTO_QR_EV_BIAS = -0.8;')

# Auto-optics evidence is owned by the source frame captured under a setting.
# Worker completion time is not a camera-setting boundary: old Guided jobs can
# complete hundreds of ms after a new ISO has already been applied.
rep('receive/main.js', 'const hotJobCompletionSamples = [];', '''const hotJobCompletionSamples = [];
const autoOpticsCompletionSamples = [];''')
rep('receive/main.js', '''    guided: Boolean(guidedStage),
    guidedStage,
    kind
  };''', '''    guided: Boolean(guidedStage),
    guidedStage,
    kind,
    sourceSequence: Number(sourceSequence),
    trackSlots: Array.isArray(message.tracks)
      ? message.tracks.map((track) => Number(track.slot ?? track.id)).filter(Number.isInteger)
      : []
  };''')
rep('receive/main.js', '''    const outputSymbols = Math.max(0, Number(completion.symbolCount) || 0);
    livePipeline.latencyMs += latencyMs;''', '''    const outputSymbols = Math.max(0, Number(completion.symbolCount) || 0);
    if (!auditMode.full && Number.isFinite(auditMode.sourceSequence)) {
      const submittedSlots = new Set(auditMode.trackSlots ?? []);
      const attributedOutputs = submittedSlots.size
        ? completion.symbols.reduce((count, symbol) =>
            count + Number(submittedSlots.has(Number(symbol.header?.slotIndex))), 0)
        : Math.min(Math.max(0, Number(auditMode.tracks) || 0), outputSymbols);
      autoOpticsCompletionSamples.push({
        at: receiverNow(),
        sourceSequence: auditMode.sourceSequence,
        tracks: Math.max(0, Number(auditMode.tracks) || 0),
        outputs: Math.min(Math.max(0, Number(auditMode.tracks) || 0), attributedOutputs)
      });
      if (autoOpticsCompletionSamples.length > 512)
        autoOpticsCompletionSamples.splice(0, autoOpticsCompletionSamples.length - 512);
    }
    livePipeline.latencyMs += latencyMs;''')
rep('receive/main.js', '''  resetSlotMetrics();
  resetGuidedFallbackPolicy();''', '''  autoOpticsCompletionSamples.length = 0;
  resetSlotMetrics();
  resetGuidedFallbackPolicy();''')

# Cold acquisition is deterministic hardware AE+AF. A remembered manual state is
# only useful after a QR-proven lattice exists and comparisons can be pose-gated.
sub('receive/main.js',
    r'async function primeAutomaticQrOpticsStartup\(track\) \{.*?\n\}\nasync function abandonAutomaticOpticsStartupMemory',
'''async function primeAutomaticQrOpticsStartup(track) {
  if (!automaticOpticsSessionAlive(track) || autoOpticsMutationRunning) return;
  autoOpticsRuntimeState = "ae";
  autoOpticsMemoryBootAt = 0;
  autoOpticsMemoryBoot = void 0;
  autoOpticsRetryAt = 0;
  autoOpticsRescueRetryAt = 0;
  await applyExposureSetting(track);
  if (!automaticOpticsSessionAlive(track)) return;
  autoOpticsAcquisitionSince = receiverNow();
  autoOpticsTuneSummary = "hardware AE acquisition";
}
async function abandonAutomaticOpticsStartupMemory''')

# Replace the fixed-delay/global-counter tournament with a short-shutter,
# source/slot-attributed robustness-boundary search.
sub('receive/main.js',
    r'async function waitForAutoOptics\(ms, track\) \{.*?\n\}\nasync function releaseAutomaticQrOptics',
'''async function waitForFreshAutoOpticsFrames(track, afterSequence, frames = CAMERA_TUNING.exposureDiscardFrames, timeoutMs = 420) {
  const target = afterSequence + Math.max(1, frames);
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    if (!automaticOpticsSessionAlive(track)) return false;
    if (latestSourceFrameSequence >= target) return true;
    await new Promise((resolve) => setTimeout(resolve, 12));
  }
  return false;
}
function autoOpticsConfidenceScore(outputs, attempts) {
  if (!(attempts > 0)) return 0;
  const p = Math.max(0, Math.min(1, outputs / attempts));
  const z = 1;
  const z2 = z * z;
  const denom = 1 + z2 / attempts;
  const center = p + z2 / (2 * attempts);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * attempts)) / attempts);
  return Math.max(0, (center - margin) / denom);
}
function autoOpticsEvidenceSince(firstSequence) {
  let outputs = 0, attempts = 0, jobs = 0;
  for (const sample of autoOpticsCompletionSamples) {
    if (sample.sourceSequence < firstSequence) continue;
    outputs += sample.outputs;
    attempts += sample.tracks;
    jobs++;
  }
  return { outputs, attempts, jobs };
}
async function sampleAutomaticOpticsQuality(track, iso, firstSequence, sampleMs = AUTO_OPTICS_GAIN_SAMPLE_MS) {
  if (!await waitForStableAutoOpticsPose(track, AUTO_OPTICS_POSE_WAIT_MS)) {
    return { iso, outputs: 0, attempts: 0, jobs: 0, rate: 0, yieldRate: 0, score: 0, valid: false, unstable: true };
  }
  const poseAnchor = autoOpticsPoseSnapshot();
  const targetAttempts = Math.max(
    AUTO_OPTICS_GAIN_MIN_ATTEMPTS,
    Math.min(54, Math.ceil(Math.max(1, poseAnchor.visible) * 2))
  );
  const started = performance.now();
  let poseStable = true;
  let maxCenterDrift = 0;
  let maxScaleDrift = 0;
  let evidence = autoOpticsEvidenceSince(firstSequence);
  while (performance.now() - started < sampleMs) {
    if (!automaticOpticsSessionAlive(track)) return null;
    const pose = autoOpticsPoseSnapshot();
    const drift = autoOpticsPoseDrift(poseAnchor, pose);
    maxCenterDrift = Math.max(maxCenterDrift, drift.center);
    maxScaleDrift = Math.max(maxScaleDrift, drift.scale);
    if (!autoOpticsPoseUsable(pose) || drift.center > AUTO_OPTICS_POSE_MAX_CENTER_DRIFT || drift.scale > AUTO_OPTICS_POSE_MAX_SCALE_LOG2) {
      poseStable = false;
      break;
    }
    evidence = autoOpticsEvidenceSince(firstSequence);
    if (evidence.jobs >= 2 && evidence.attempts >= targetAttempts && performance.now() - started >= 90) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  evidence = autoOpticsEvidenceSince(firstSequence);
  const elapsed = Math.max(0.001, (performance.now() - started) / 1e3);
  const yieldRate = evidence.attempts ? evidence.outputs / evidence.attempts : 0;
  return {
    iso,
    outputs: evidence.outputs,
    attempts: evidence.attempts,
    jobs: evidence.jobs,
    rate: evidence.outputs / elapsed,
    yieldRate,
    score: autoOpticsConfidenceScore(evidence.outputs, evidence.attempts),
    maxCenterDrift,
    maxScaleDrift,
    unstable: !poseStable,
    valid: poseStable && evidence.jobs >= 2 && evidence.attempts >= AUTO_OPTICS_GAIN_MIN_ATTEMPTS
  };
}
async function measureAutomaticIsoCandidate(track, exposure, requestedIso, isoRange, options = {}) {
  if (!automaticOpticsSessionAlive(track)) return null;
  const iso = quantizeCameraRange(requestedIso, isoRange);
  const accepted = await applyCameraConstraint(track, { exposureMode: "manual", exposureTime: exposure, iso });
  if (!accepted || !automaticOpticsSessionAlive(track)) return null;
  const actual = track.getSettings();
  const actualExposure = Number(actual.exposureTime);
  const actualIso = Number(actual.iso);
  if (!Number.isFinite(actualExposure) || !Number.isFinite(actualIso)) return null;
  const appliedSequence = latestSourceFrameSequence;
  const settled = await waitForFreshAutoOpticsFrames(track, appliedSequence, CAMERA_TUNING.exposureDiscardFrames, options.settleTimeoutMs ?? 420);
  if (!settled) {
    return { iso: actualIso, requestedIso: iso, outputs: 0, attempts: 0, jobs: 0, rate: 0, yieldRate: 0, score: 0, valid: false, unstable: true };
  }
  const firstSequence = latestSourceFrameSequence + 1;
  const sample = await sampleAutomaticOpticsQuality(track, actualIso, firstSequence, options.sampleMs ?? AUTO_OPTICS_GAIN_SAMPLE_MS);
  if (!sample) return null;
  return { ...sample, iso: actualIso, requestedIso: iso, exposure: actualExposure, firstSequence };
}
function describeAutoIsoProbe(probe) {
  if (!probe) return "—";
  if (probe.unstable) return `${Math.round(probe.iso)}:moved`;
  if (!probe.valid) return `${Math.round(probe.iso)}:insufficient`;
  return `${Math.round(probe.iso)}:${(probe.yieldRate * 100).toFixed(0)}%`;
}
async function tuneAutomaticQrIso(track, exposure, seedIso, isoRange, maxAutoIso, rememberedIso) {
  if (!automaticOpticsSessionAlive(track)) return { iso: seedIso, probes: [] };
  autoOpticsRuntimeState = "tuning";
  const cap = Math.max(isoRange.min, Math.min(isoRange.max, maxAutoIso));
  const remembered = Number.isFinite(rememberedIso)
    ? quantizeCameraRange(Math.max(isoRange.min, Math.min(cap, rememberedIso)), isoRange)
    : void 0;
  const base = remembered ?? quantizeCameraRange(Math.max(isoRange.min, Math.min(cap, seedIso)), isoRange);
  const probes = [];
  const measured = new Set();
  let invalidatedByMotion = false;
  const probe = async (candidate, label, options = {}) => {
    const requested = quantizeCameraRange(Math.max(isoRange.min, Math.min(cap, candidate)), isoRange);
    const key = String(requested);
    if (measured.has(key) && !options.confirm)
      return probes.find((item) => String(item.requestedIso) === key) || null;
    if (measured.size >= AUTO_OPTICS_GAIN_MAX_PROBES && !options.confirm) return null;
    if (!options.confirm) measured.add(key);
    autoOpticsTuneSummary = `${formatExposureMs(exposure)} · ${label} ISO ${Math.round(requested)}`;
    const result = await measureAutomaticIsoCandidate(track, exposure, requested, isoRange, options);
    if (result?.unstable) invalidatedByMotion = true;
    if (result && !options.confirm) probes.push(result);
    return result;
  };

  const baseline = await probe(base, remembered !== void 0 ? "memory seed" : "dark seed");
  if (!automaticOpticsSessionAlive(track)) return { iso: base, probes };
  if (invalidatedByMotion) return { iso: base, probes, deferred: true };

  if (baseline?.valid && baseline.yieldRate >= AUTO_OPTICS_TARGET_YIELD) {
    let incumbent = baseline;
    for (let step = 0; step < 2 && measured.size < AUTO_OPTICS_GAIN_MAX_PROBES; step++) {
      const darkerIso = incumbent.requestedIso / Math.SQRT2;
      if (darkerIso <= isoRange.min * 1.01 && incumbent.requestedIso <= isoRange.min * 1.01) break;
      const darker = await probe(darkerIso, step ? "darker boundary" : "darker");
      if (!darker || invalidatedByMotion) break;
      if (!darker.valid || darker.yieldRate < AUTO_OPTICS_TARGET_YIELD - 0.10 || darker.score < incumbent.score * 0.82) break;
      incumbent = darker;
    }
  } else {
    let incumbent = baseline;
    for (let step = 0; step < 3 && measured.size < AUTO_OPTICS_GAIN_MAX_PROBES; step++) {
      const currentIso = incumbent?.requestedIso ?? base;
      const brighterIso = Math.min(cap, currentIso * Math.SQRT2);
      if (brighterIso <= currentIso * 1.01) break;
      const brighter = await probe(brighterIso, step ? "more gain" : "brighter");
      if (!brighter || invalidatedByMotion) break;
      incumbent = brighter;
      if (brighter.valid && brighter.yieldRate >= AUTO_OPTICS_TARGET_YIELD) break;
    }
  }
  if (invalidatedByMotion) return { iso: base, probes, deferred: true };

  const valid = probes.filter((item) => item.valid);
  if (!valid.length) {
    autoOpticsTuneSummary = `${formatExposureMs(exposure)} · ${probes.map(describeAutoIsoProbe).join(" · ")} · insufficient`;
    return { iso: base, probes, deferred: true };
  }
  const best = valid.reduce((winner, item) =>
    !winner || item.score > winner.score || item.score === winner.score && item.yieldRate > winner.yieldRate ? item : winner, null);
  if (best.yieldRate < AUTO_OPTICS_COLLAPSE_YIELD) {
    autoOpticsTuneSummary = `${formatExposureMs(exposure)} · ${probes.map(describeAutoIsoProbe).join(" · ")} · collapsed`;
    return { iso: base, probes, best, collapsed: true };
  }
  const yieldFloor = Math.max(AUTO_OPTICS_COLLAPSE_YIELD, best.yieldRate - AUTO_OPTICS_NEAR_BEST_YIELD_DELTA);
  const nearBest = valid.filter((item) =>
    item.score >= best.score * AUTO_OPTICS_NEAR_BEST_SCORE && item.yieldRate >= yieldFloor
  ).sort((a, b) => a.requestedIso - b.requestedIso);
  const selected = nearBest[0] ?? best;

  const confirm = await probe(selected.requestedIso, "confirm", { confirm: true, sampleMs: 430 });
  if (!confirm || confirm.unstable || !confirm.valid) {
    return { iso: selected.requestedIso, probes, deferred: true };
  }
  if (confirm.yieldRate < Math.max(AUTO_OPTICS_COLLAPSE_YIELD, selected.yieldRate - 0.12) ||
      confirm.score < selected.score * 0.80) {
    autoOpticsTuneSummary = `${formatExposureMs(exposure)} · confirmation disagreed · retry later`;
    return { iso: selected.requestedIso, probes, deferred: true };
  }
  const confirmed = {
    ...confirm,
    score: Math.min(selected.score, confirm.score),
    yieldRate: (selected.yieldRate + confirm.yieldRate) / 2,
    rate: (selected.rate + confirm.rate) / 2,
    outputs: selected.outputs + confirm.outputs,
    attempts: selected.attempts + confirm.attempts,
    jobs: selected.jobs + confirm.jobs
  };
  autoOpticsTuneSummary = `${formatExposureMs(exposure)} · ${probes.map(describeAutoIsoProbe).join(" · ")} → ISO ${Math.round(confirm.iso)} · confirmed ${(confirmed.yieldRate * 100).toFixed(0)}%`;
  return { iso: confirm.iso, probes, best: confirmed };
}
async function settleAutomaticQrOptics(track, now) {
  if (autoOpticsMutationRunning || !automaticOptics || now < autoOpticsRetryAt) return;
  const caps = track.getCapabilities?.() ?? {};
  const exposureRange = caps.exposureTime;
  const isoRange = caps.iso;
  const settings = track.getSettings();
  if (!Array.isArray(caps.exposureMode) || !caps.exposureMode.includes("manual") ||
      !exposureRange || !isoRange || !Number.isFinite(settings.exposureTime) ||
      !Number.isFinite(settings.iso) || settings.exposureTime <= 0 || settings.iso <= 0) {
    autoOpticsRetryAt = now + 2500;
    return;
  }
  const fps = Math.max(12, Math.min(120, Number(settings.frameRate) || 30));
  const savedAe = autoOpticsAeBaseline && receiverNow() - autoOpticsAeBaseline.at < 9000 ? autoOpticsAeBaseline : void 0;
  const aeExposure = savedAe?.exposure ?? settings.exposureTime;
  const aeIso = savedAe?.iso ?? settings.iso;
  const aeExposureProduct = aeExposure * aeIso;
  const exposureFor = (raw) => quantizeCameraRange(Math.max(exposureRange.min, Math.min(exposureRange.max, raw)), exposureRange);
  const isoCapFor = (exposure) => quantizeCameraRange(
    Math.min(isoRange.max, Math.max(isoRange.min, aeExposureProduct * AUTO_OPTICS_AE_PRODUCT_CEILING / Math.max(exposureRange.min, exposure))),
    isoRange
  );
  const seedIsoFor = (exposure) => quantizeCameraRange(
    Math.min(isoCapFor(exposure), Math.max(isoRange.min, aeExposureProduct * AUTO_QR_LIGHT_SCALE / Math.max(exposureRange.min, exposure))),
    isoRange
  );
  const targetExposure = exposureFor(Math.min(
    aeExposure,
    AUTO_OPTICS_MAX_SHORT_EXPOSURE,
    1e4 / fps * AUTO_OPTICS_SHUTTER_FRAME_FRACTION
  ));

  autoOpticsMutationRunning = true;
  autoOpticsRuntimeState = "tuning";
  notePipelineEvent("auto-optics-short-shutter-search");
  try {
    let exposure = targetExposure;
    let cap = isoCapFor(exposure);
    let rememberedIso = loadAutomaticOpticsMemory(track, exposure, isoRange, cap, aeExposureProduct);
    let tuned = await tuneAutomaticQrIso(track, exposure, seedIsoFor(exposure), isoRange, cap, rememberedIso);
    if (!automaticOpticsSessionAlive(track)) return;

    if (tuned.collapsed) {
      const fallbackExposure = exposureFor(Math.min(
        aeExposure,
        AUTO_OPTICS_FALLBACK_EXPOSURE,
        exposure * Math.SQRT2
      ));
      if (fallbackExposure > exposure * 1.04) {
        exposure = fallbackExposure;
        cap = isoCapFor(exposure);
        rememberedIso = loadAutomaticOpticsMemory(track, exposure, isoRange, cap, aeExposureProduct);
        tuned = await tuneAutomaticQrIso(track, exposure, seedIsoFor(exposure), isoRange, cap, rememberedIso);
      }
    }
    if (!automaticOpticsSessionAlive(track)) return;
    if (tuned.deferred || tuned.collapsed || !tuned.best?.valid) {
      const why = tuned.deferred ? "comparison invalidated; hold framing" : "short shutter too dark";
      await applyExposureSetting(track);
      if (!automaticOpticsSessionAlive(track)) return;
      autoOpticsRuntimeState = "ae";
      autoOpticsLockSince = 0;
      autoOpticsAcquisitionSince = receiverNow();
      autoOpticsRetryAt = receiverNow() + (tuned.deferred ? 500 : AUTO_OPTICS_COLLAPSE_RETRY_MS);
      autoOpticsTuneSummary = `${why} · hardware AE until clean retry`;
      if (tuned.collapsed) forgetAutomaticOptics(track);
      focusController.adoptAutomaticCameraState("automatic optics comparison invalid; hardware AE retained until clean retry");
      return;
    }

    autoOpticsRuntimeState = "manual";
    autoOpticsHoldSample = autoOpticsPipelineSnapshot();
    autoOpticsHoldCollapseSince = 0;
    autoOpticsHeldYield = tuned.best.yieldRate;
    autoOpticsRetryAt = Infinity;
    const actual = track.getSettings();
    const tunedExposure = Number(actual.exposureTime) || exposure;
    const tunedIso = Number(actual.iso) || tuned.iso;
    if (tuned.best.yieldRate >= AUTO_OPTICS_MEMORY_MIN_YIELD)
      rememberAutomaticOptics(track, tunedExposure, tunedIso, tuned.best.score, tuned.best.yieldRate, aeExposureProduct);
    autoOpticsAeBaseline = void 0;
    focusController.adoptAutomaticCameraState("short-shutter automatic optics converged on the darkest robust gain");
    notePipelineEvent("auto-optics-converged", Math.round(tuned.best.yieldRate * 100));
  } finally {
    autoOpticsMutationRunning = false;
  }
}
async function releaseAutomaticQrOptics''')

# Pre-lock randomized exposure races are gone. Once locked, the hold watchdog is
# unchanged: a winner is never periodically poked, only revisited after sustained
# evidence that live decode yield degraded.
sub('receive/main.js',
    r'\n  if \(autoOpticsRuntimeState === "memory"\) \{.*?\n  \}\n\n  if \(autoOpticsRuntimeState === "manual"\) \{',
    '\n  if (autoOpticsRuntimeState === "manual") {')
rep('receive/main.js', '''  if (!gridLattice.locked) {
    autoOpticsLockSince = 0;
    const liveDecode = Boolean(lastStreamDecodeAt && now - lastStreamDecodeAt < AUTO_OPTICS_RECENT_DECODE_MS);
    if (!liveDecode && now - autoOpticsAcquisitionSince >= AUTO_OPTICS_ACQUISITION_RESCUE_MS && now >= autoOpticsRescueRetryAt)
      void rescueAutomaticQrAcquisition(track, now);
    return;
  }''', '''  if (!gridLattice.locked) {
    autoOpticsLockSince = 0;
    return;
  }''')

# One production controller: the developer action explicitly forgets memory and
# requests a clean AE -> short-shutter recalibration instead of invoking the old
# seven-second FocusController tournament.
rep('index.html', 'id="optics-optimize" type="button" aria-pressed="false">Optimize</button>', 'id="optics-optimize" type="button" aria-pressed="false">Recalibrate</button>')
sub('receive/main.js',
    r'opticsOptimize\.addEventListener\("click", \(\) => \{.*?\n\}\);\nopticsKeep\.addEventListener',
'''opticsOptimize.addEventListener("click", () => {
  if (!automaticOptics) {
    opticsOptimizeStatus.textContent = "Enable Auto";
    return;
  }
  const track = stream?.getVideoTracks()[0];
  if (!track || track.readyState !== "live") {
    opticsOptimizeStatus.textContent = "Camera unavailable";
    return;
  }
  if (autoOpticsMutationRunning) {
    opticsOptimizeStatus.textContent = "Calibration already running";
    return;
  }
  autoOpticsMutationRunning = true;
  forgetAutomaticOptics(track);
  autoOpticsRuntimeState = "ae";
  autoOpticsMemoryBootAt = 0;
  autoOpticsMemoryBoot = void 0;
  autoOpticsLockSince = 0;
  autoOpticsRetryAt = 0;
  autoOpticsHeldYield = 0;
  autoOpticsHoldSample = void 0;
  autoOpticsHoldCollapseSince = 0;
  opticsOptimizeStatus.textContent = "Recalibrating…";
  autoOpticsTuneSummary = "manual recalibration requested · hardware AE baseline";
  void applyExposureSetting(track).then(() => {
    if (automaticOpticsSessionAlive(track)) {
      autoOpticsAcquisitionSince = receiverNow();
      focusController.adoptAutomaticCameraState("manual automatic-optics recalibration requested");
    }
  }).finally(() => {
    autoOpticsMutationRunning = false;
  });
});
opticsKeep.addEventListener''')

# Intent guards.
receive = Path('receive/main.js').read_text()
focus = Path('receive/focus-controller.js').read_text()
index = Path('index.html').read_text()
if 'AUTO_OPTICS_SHUTTER_FRAME_FRACTION = 0.30' in receive:
    raise SystemExit('old 30% shutter survived')
if 'void rescueAutomaticQrAcquisition(track, now)' in receive:
    raise SystemExit('pre-lock randomized acquisition race survived')
if 'const autoOpticsCompletionSamples = [];' not in receive or 'trackSlots:' not in receive:
    raise SystemExit('source/slot-attributed auto optics evidence missing')
if 'measured.has(key) && !options.confirm' not in receive:
    raise SystemExit('independent confirmation probe missing')
if 'darkest robust gain' not in receive or 'AUTO_OPTICS_MAX_SHORT_EXPOSURE = 35' not in receive:
    raise SystemExit('short-shutter frontier controller missing')
if '>Recalibrate</button>' not in index:
    raise SystemExit('production recalibration button missing')
if 'const AUTO_QR_EV_BIAS = -0.8;' not in focus:
    raise SystemExit('FocusController AE bias not synchronized')
