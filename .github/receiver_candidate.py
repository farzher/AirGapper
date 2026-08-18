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
# Shutter time is the expensive axis because it integrates display transitions
# and hand motion. At 30 fps, 10% of a frame is 3.33 ms -- almost exactly the
# manually-proven 3.28 ms regime on the production phone. ISO is then the fast
# brightness axis, and the controller searches only until robust decode yield is
# reached rather than asking the camera to make a pleasant photograph.
rep('receive/main.js', 'const AUTO_QR_EV_BIAS = -0.7;', 'const AUTO_QR_EV_BIAS = -0.8;')
rep('receive/main.js', 'const AUTO_OPTICS_LOCK_SETTLE_MS = 1400;', 'const AUTO_OPTICS_LOCK_SETTLE_MS = 450;')
rep('receive/main.js', 'const AUTO_OPTICS_SHUTTER_FRAME_FRACTION = 0.30;', '''const AUTO_OPTICS_SHUTTER_FRAME_FRACTION = 0.10;
const AUTO_OPTICS_MAX_SHORT_EXPOSURE = 35; // 3.5 ms; exposureTime uses Chromium's 0.1 ms camera units
const AUTO_OPTICS_FALLBACK_EXPOSURE = 50; // one bounded 5 ms escape hatch for genuinely dark scenes''')
rep('receive/main.js', 'const AUTO_OPTICS_GAIN_SETTLE_MS = 340;', 'const AUTO_OPTICS_GAIN_SETTLE_MS = 140;')
rep('receive/main.js', 'const AUTO_OPTICS_GAIN_SAMPLE_MS = 520;', 'const AUTO_OPTICS_GAIN_SAMPLE_MS = 320;')
rep('receive/main.js', 'const AUTO_OPTICS_GAIN_MIN_ATTEMPTS = 12;', 'const AUTO_OPTICS_GAIN_MIN_ATTEMPTS = 10;')
rep('receive/main.js', 'const AUTO_OPTICS_GAIN_MAX_PROBES = 5;', '''const AUTO_OPTICS_GAIN_MAX_PROBES = 4;
const AUTO_OPTICS_TARGET_YIELD = 0.76;
const AUTO_OPTICS_NEAR_BEST_SCORE = 0.94;
const AUTO_OPTICS_NEAR_BEST_YIELD_DELTA = 0.07;
const AUTO_OPTICS_AE_PRODUCT_CEILING = 1.50;''')
rep('receive/main.js', 'const AUTO_OPTICS_POSE_STABLE_MS = 260;', 'const AUTO_OPTICS_POSE_STABLE_MS = 140;')
rep('receive/main.js', 'const AUTO_OPTICS_POSE_WAIT_MS = 1800;', 'const AUTO_OPTICS_POSE_WAIT_MS = 800;')
rep('receive/main.js', 'const AUTO_OPTICS_ACQUISITION_RESCUE_MS = 2500;', 'const AUTO_OPTICS_ACQUISITION_RESCUE_MS = 650;')
rep('receive/main.js', 'const AUTO_OPTICS_RESCUE_RETRY_MS = 12000;', 'const AUTO_OPTICS_RESCUE_RETRY_MS = 3000;')
rep('receive/main.js', 'const AUTO_OPTICS_MEMORY_BOOT_MAX_MS = 1600;', 'const AUTO_OPTICS_MEMORY_BOOT_MAX_MS = 650;')

# The developer Optimize button uses the same physical premise. Previously its
# "safe" range could include nearly a whole 30-fps frame, then only probe 60-85%
# of that value. Clamp its starting range to 18% of a frame so the search can
# actually reach the short-shutter regime instead of spending seven seconds in
# blur-heavy territory.
rep('receive/focus-controller.js', 'const frameSafeMax = 8e3 / observedFps;', 'const frameSafeMax = 1e4 / observedFps * 0.18;')
rep('receive/focus-controller.js', 'const AUTO_QR_EV_BIAS = -0.7;', 'const AUTO_QR_EV_BIAS = -0.8;')

# Attribute automatic-optics quality to the source frame that was actually
# captured under a setting. Completion time is NOT an exposure boundary: Guided
# jobs can finish hundreds of ms later. This removes the main source of bogus
# candidate wins/losses without pausing or draining the production pipeline.
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

# Keep the existing immediate-memory startup. A QR-proven setting is exactly the
# best first guess on a repeat run. The correction is that memory is a seed, not
# a prison: if it produces no QR quickly, arm the acquisition race immediately
# without bouncing through a long hardware-AE wait.
sub('receive/main.js',
    r'async function abandonAutomaticOpticsStartupMemory\(track, reason = "startup winner produced no QR"\) \{.*?\n\}\nfunction rememberAutomaticOptics',
'''async function abandonAutomaticOpticsStartupMemory(track, reason = "startup winner produced no QR") {
  if (autoOpticsMutationRunning || !automaticOpticsSessionAlive(track) || autoOpticsRuntimeState !== "memory") return;
  autoOpticsMutationRunning = true;
  try {
    const now = receiverNow();
    autoOpticsRuntimeState = "rescue";
    autoOpticsMemoryBootAt = 0;
    autoOpticsMemoryBoot = void 0;
    autoOpticsLockSince = 0;
    autoOpticsAcquisitionSince = now - AUTO_OPTICS_ACQUISITION_RESCUE_MS;
    autoOpticsRetryAt = 0;
    autoOpticsRescueRetryAt = 0;
    autoOpticsHoldSample = void 0;
    autoOpticsHoldCollapseSince = 0;
    autoOpticsHeldYield = 0;
    autoOpticsTuneSummary = `${reason} · trying short-shutter alternatives`;
    focusController.adoptAutomaticCameraState("recent automatic optics produced no QR; immediate acquisition alternatives armed");
    notePipelineEvent("auto-optics-memory-race");
  } finally {
    autoOpticsMutationRunning = false;
  }
}
function rememberAutomaticOptics''')

# A deterministic pre-lock ladder. Memory has already had the first shot through
# primeAutomaticQrOpticsStartup(), so after its short timeout do not test the same
# value again. Derive a 3-ish ms seed from the current light product, bracket gain
# on both sides, include one even faster equivalent-product option and one bounded
# 5 ms low-light escape hatch. First CRC-valid QR wins immediately.
sub('receive/main.js',
    r'function buildAutomaticOpticsAcquisitionCandidates\(track, aeBaseline, exposureRange, isoRange, fps\) \{.*?\n\}\nasync function measureAutomaticAcquisitionCandidate',
'''function buildAutomaticOpticsAcquisitionCandidates(track, aeBaseline, exposureRange, isoRange, fps) {
  const frameShort = 1e4 / fps * AUTO_OPTICS_SHUTTER_FRAME_FRACTION;
  const shortExposure = quantizeCameraRange(
    Math.min(exposureRange.max, AUTO_OPTICS_MAX_SHORT_EXPOSURE, frameShort),
    exposureRange
  );
  const fallbackExposure = quantizeCameraRange(
    Math.min(exposureRange.max, AUTO_OPTICS_FALLBACK_EXPOSURE, 1e4 / fps * 0.18),
    exposureRange
  );
  const currentKey = autoOpticsHistoryConfigKey(aeBaseline.exposure, aeBaseline.iso);
  const targetProduct = Math.max(
    exposureRange.min * isoRange.min,
    aeBaseline.exposure * aeBaseline.iso * AUTO_QR_LIGHT_SCALE
  );
  const seedIso = quantizeCameraRange(targetProduct / Math.max(exposureRange.min, shortExposure), isoRange);
  const candidates = [];
  const seen = new Set();
  const add = (exposureRaw, isoRaw, label, allowCurrent = false) => {
    const exposure = quantizeCameraRange(exposureRaw, exposureRange);
    const iso = quantizeCameraRange(isoRaw, isoRange);
    const key = autoOpticsHistoryConfigKey(exposure, iso);
    if (seen.has(key) || !allowCurrent && key === currentKey) return;
    seen.add(key);
    candidates.push({ exposure, iso, label });
  };

  add(shortExposure, seedIso, "short-shutter");
  add(shortExposure, seedIso / Math.SQRT2, "darker");
  add(shortExposure, seedIso * Math.SQRT2, "brighter");
  add(shortExposure / Math.SQRT2, seedIso * Math.SQRT2, "faster");
  for (const item of readAutomaticOpticsHistory(track).slice(0, 2))
    add(item.exposure, item.iso, "learned alternative");
  const memory = usableAutomaticOpticsMemory(track);
  if (memory) add(memory.exposure, memory.iso, "recent alternative");
  if (fallbackExposure > shortExposure * 1.08)
    add(fallbackExposure, targetProduct / Math.max(exposureRange.min, fallbackExposure), "low-light");
  add(aeBaseline.exposure, aeBaseline.iso, "current", true);
  return candidates;
}
async function measureAutomaticAcquisitionCandidate''')

# On a complete pre-lock miss, hold the physics-derived short-shutter seed rather
# than the first (possibly stale) history item. Retry soon: bad exposure must not
# become a fail state, but neither should the camera strobe through candidates
# continuously while autofocus is still doing useful work.
rep('receive/main.js', '''    const hold = candidates[0];
    await applyCameraConstraint(track, {
      exposureMode: "manual",
      exposureTime: hold.exposure,
      iso: hold.iso
    });''', '''    const hold = candidates.find((candidate) => candidate.label === "short-shutter") ?? candidates[0];
    await applyCameraConstraint(track, {
      exposureMode: "manual",
      exposureTime: hold.exposure,
      iso: hold.iso
    });''')

# Replace global rolling-counter ISO sampling with source-sequence attribution.
# Every candidate waits for fresh post-write frames, then counts only jobs whose
# CAPTURE sequence belongs to that candidate. Pose movement invalidates the
# window instead of poisoning a score. Search is one-dimensional and monotonic:
# if robust, walk darker; if weak, walk brighter. Among statistically-near-best
# candidates the lower ISO always wins, then a fresh confirmation window protects
# against one lucky display phase.
sub('receive/main.js',
    r'async function sampleAutomaticOpticsQuality\(track, iso, sampleMs = AUTO_OPTICS_GAIN_SAMPLE_MS, poseWaitMs = AUTO_OPTICS_POSE_WAIT_MS\) \{.*?\n\}\nasync function settleAutomaticQrOptics',
'''function autoOpticsEvidenceSince(firstSequence) {
  let outputs = 0, attempts = 0, jobs = 0;
  for (const sample of autoOpticsCompletionSamples) {
    if (sample.sourceSequence < firstSequence) continue;
    outputs += sample.outputs;
    attempts += sample.tracks;
    jobs++;
  }
  return { outputs, attempts, jobs };
}
async function waitForFreshAutoOpticsFrames(track, afterSequence, frames = CAMERA_TUNING.exposureDiscardFrames, timeoutMs = 440) {
  const target = afterSequence + Math.max(1, frames);
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    if (!automaticOpticsSessionAlive(track)) return false;
    if (latestSourceFrameSequence >= target) return true;
    await new Promise((resolve) => setTimeout(resolve, 12));
  }
  return false;
}
async function sampleAutomaticOpticsQuality(track, iso, firstSequence, sampleMs = AUTO_OPTICS_GAIN_SAMPLE_MS) {
  if (!await waitForStableAutoOpticsPose(track, AUTO_OPTICS_POSE_WAIT_MS)) {
    return { iso, outputs: 0, attempts: 0, jobs: 0, rate: 0, yieldRate: 0, score: 0, valid: false, unstable: true };
  }
  const anchor = autoOpticsPoseSnapshot();
  const targetAttempts = Math.max(AUTO_OPTICS_GAIN_MIN_ATTEMPTS, Math.min(48, Math.ceil(Math.max(1, anchor.visible) * 2)));
  const started = performance.now();
  let stable = true;
  let evidence = autoOpticsEvidenceSince(firstSequence);
  while (performance.now() - started < sampleMs) {
    if (!automaticOpticsSessionAlive(track)) return null;
    const pose = autoOpticsPoseSnapshot();
    const drift = autoOpticsPoseDrift(anchor, pose);
    if (!autoOpticsPoseUsable(pose) || drift.center > AUTO_OPTICS_POSE_MAX_CENTER_DRIFT || drift.scale > AUTO_OPTICS_POSE_MAX_SCALE_LOG2) {
      stable = false;
      break;
    }
    evidence = autoOpticsEvidenceSince(firstSequence);
    if (evidence.jobs >= 2 && evidence.attempts >= targetAttempts && performance.now() - started >= 100) break;
    await new Promise((resolve) => setTimeout(resolve, 18));
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
    unstable: !stable,
    valid: stable && evidence.jobs >= 2 && evidence.attempts >= AUTO_OPTICS_GAIN_MIN_ATTEMPTS
  };
}
async function measureAutomaticIsoCandidate(track, exposure, requestedIso, isoRange, options = {}) {
  if (!automaticOpticsSessionAlive(track)) return null;
  const iso = quantizeCameraRange(requestedIso, isoRange);
  const beforeSequence = latestSourceFrameSequence;
  const accepted = await applyCameraConstraint(track, { exposureMode: "manual", exposureTime: exposure, iso });
  if (!accepted || !automaticOpticsSessionAlive(track)) return null;
  if (!await waitForFreshAutoOpticsFrames(track, beforeSequence, CAMERA_TUNING.exposureDiscardFrames, options.settleTimeoutMs ?? 440)) {
    return { iso, requestedIso: iso, outputs: 0, attempts: 0, jobs: 0, rate: 0, yieldRate: 0, score: 0, valid: false, unstable: true };
  }
  const actual = track.getSettings();
  const actualIso = Number(actual.iso);
  const actualExposure = Number(actual.exposureTime);
  const firstSequence = latestSourceFrameSequence + 1;
  const sample = await sampleAutomaticOpticsQuality(
    track,
    Number.isFinite(actualIso) ? actualIso : iso,
    firstSequence,
    options.sampleMs ?? AUTO_OPTICS_GAIN_SAMPLE_MS
  );
  if (!sample) return null;
  return {
    ...sample,
    requestedIso: iso,
    iso: Number.isFinite(actualIso) ? actualIso : iso,
    exposure: Number.isFinite(actualExposure) ? actualExposure : exposure,
    firstSequence
  };
}
function describeAutoIsoProbe(probe) {
  if (!probe) return "—";
  if (probe.unstable) return `${Math.round(probe.iso)}:move`;
  if (!probe.valid) return `${Math.round(probe.iso)}:?`;
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
  const probe = async (candidate, label, options = {}) => {
    const requested = quantizeCameraRange(Math.max(isoRange.min, Math.min(cap, candidate)), isoRange);
    const key = String(requested);
    if (!options.confirm && measured.has(key)) return probes.find((item) => String(item.requestedIso) === key) ?? null;
    if (!options.confirm && measured.size >= AUTO_OPTICS_GAIN_MAX_PROBES) return null;
    if (!options.confirm) measured.add(key);
    autoOpticsTuneSummary = `${formatExposureMs(exposure)} · ${label} ISO ${Math.round(requested)}`;
    const result = await measureAutomaticIsoCandidate(track, exposure, requested, isoRange, options);
    if (result && !options.confirm) probes.push(result);
    return result;
  };
  const restore = async (iso) => {
    if (automaticOpticsSessionAlive(track))
      await applyCameraConstraint(track, { exposureMode: "manual", exposureTime: exposure, iso });
  };

  let current = await probe(base, remembered !== void 0 ? "memory" : "seed");
  if (!automaticOpticsSessionAlive(track)) return { iso: base, probes };
  if (current?.unstable) {
    await restore(base);
    return { iso: base, probes, deferred: true };
  }

  if (current?.valid && current.yieldRate >= AUTO_OPTICS_TARGET_YIELD) {
    for (let step = 0; step < 2 && measured.size < AUTO_OPTICS_GAIN_MAX_PROBES; step++) {
      const nextIso = current.requestedIso / Math.SQRT2;
      if (nextIso >= current.requestedIso * 0.99 || current.requestedIso <= isoRange.min * 1.01) break;
      const darker = await probe(nextIso, step ? "darker boundary" : "darker");
      if (!darker || darker.unstable) {
        if (darker?.unstable) {
          await restore(current.iso);
          return { iso: current.iso, probes, deferred: true };
        }
        break;
      }
      if (!darker.valid || darker.yieldRate < AUTO_OPTICS_TARGET_YIELD - 0.10 || darker.score < current.score * 0.80) break;
      current = darker;
    }
  } else {
    for (let step = 0; step < 3 && measured.size < AUTO_OPTICS_GAIN_MAX_PROBES; step++) {
      const fromIso = current?.requestedIso ?? base;
      const nextIso = Math.min(cap, fromIso * Math.SQRT2);
      if (nextIso <= fromIso * 1.01) break;
      const brighter = await probe(nextIso, step ? "more gain" : "brighter");
      if (!brighter || brighter.unstable) {
        if (brighter?.unstable) {
          await restore(current?.iso ?? base);
          return { iso: current?.iso ?? base, probes, deferred: true };
        }
        break;
      }
      current = brighter;
      if (brighter.valid && brighter.yieldRate >= AUTO_OPTICS_TARGET_YIELD) break;
    }
  }

  const valid = probes.filter((item) => item?.valid);
  if (!valid.length) {
    await restore(base);
    autoOpticsTuneSummary = `${probes.map(describeAutoIsoProbe).join(" · ")} · insufficient clean evidence`;
    return { iso: base, probes, deferred: true };
  }
  const bestScore = Math.max(...valid.map((item) => item.score));
  const bestYield = Math.max(...valid.map((item) => item.yieldRate));
  const nearBest = valid.filter((item) =>
    item.score >= bestScore * AUTO_OPTICS_NEAR_BEST_SCORE &&
    item.yieldRate >= bestYield - AUTO_OPTICS_NEAR_BEST_YIELD_DELTA
  );
  let winner = [...(nearBest.length ? nearBest : valid)].sort((a, b) =>
    a.iso - b.iso || b.score - a.score || b.yieldRate - a.yieldRate
  )[0];
  if (!winner || winner.yieldRate < AUTO_OPTICS_COLLAPSE_YIELD) {
    await restore(base);
    autoOpticsTuneSummary = `${probes.map(describeAutoIsoProbe).join(" · ")} · collapsed`;
    return { iso: base, probes, best: winner, collapsed: true };
  }

  await restore(winner.iso);
  const confirm = await probe(winner.iso, "confirm", { confirm: true, sampleMs: Math.max(220, AUTO_OPTICS_GAIN_SAMPLE_MS) });
  if (confirm?.valid && !confirm.unstable) {
    const confirmationFloor = Math.max(AUTO_OPTICS_COLLAPSE_YIELD, winner.yieldRate - 0.18);
    if (confirm.yieldRate >= confirmationFloor) {
      winner = { ...winner, ...confirm, requestedIso: winner.requestedIso };
    } else {
      const safer = valid.filter((item) => item.iso > winner.iso).sort((a, b) => a.iso - b.iso)[0];
      if (safer) {
        await restore(safer.iso);
        const saferConfirm = await probe(safer.iso, "safer confirm", { confirm: true, sampleMs: Math.max(220, AUTO_OPTICS_GAIN_SAMPLE_MS) });
        if (saferConfirm?.valid && saferConfirm.yieldRate >= AUTO_OPTICS_COLLAPSE_YIELD)
          winner = { ...safer, ...saferConfirm, requestedIso: safer.requestedIso };
      }
    }
  }
  await restore(winner.iso);
  autoOpticsTuneSummary = `${probes.map(describeAutoIsoProbe).join(" · ")} → ISO ${Math.round(winner.iso)} (${(winner.yieldRate * 100).toFixed(0)}%)`;
  return { iso: winner.iso, probes, best: winner };
}
async function settleAutomaticQrOptics''')

# Rebuild the post-lock handoff around the short-shutter premise. The first pass
# is <=3.5 ms at 30 fps. If that entire ISO range genuinely collapses, try one
# 5 ms pass before conceding to hardware AE. Movement defers tuning while holding
# the current manual seed; it never causes an AE brightness flash.
sub('receive/main.js',
    r'async function settleAutomaticQrOptics\(track, now\) \{.*?\n\}\nasync function releaseAutomaticQrOptics',
'''async function settleAutomaticQrOptics(track, now) {
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
  const frameShort = 1e4 / fps * AUTO_OPTICS_SHUTTER_FRAME_FRACTION;
  const savedAe = autoOpticsAeBaseline && receiverNow() - autoOpticsAeBaseline.at < 9000
    ? autoOpticsAeBaseline
    : void 0;
  const aeExposure = savedAe?.exposure ?? settings.exposureTime;
  const aeIso = savedAe?.iso ?? settings.iso;
  const aeExposureProduct = aeExposure * aeIso;
  const targetProduct = aeExposureProduct * AUTO_QR_LIGHT_SCALE;
  let exposure = quantizeCameraRange(
    Math.min(aeExposure, frameShort, AUTO_OPTICS_MAX_SHORT_EXPOSURE),
    exposureRange
  );
  let iso = quantizeCameraRange(targetProduct / Math.max(exposureRange.min, exposure), isoRange);
  const rememberedIso = loadAutomaticOpticsMemory(track, exposure, isoRange, isoRange.max, aeExposureProduct);
  const aeIsoAtShort = aeExposureProduct / Math.max(exposureRange.min, exposure);
  const maxAutoIso = Math.min(
    isoRange.max,
    Math.max(isoRange.min, aeIsoAtShort * AUTO_OPTICS_AE_PRODUCT_CEILING, (rememberedIso ?? 0) * Math.SQRT2)
  );

  autoOpticsMutationRunning = true;
  autoOpticsRuntimeState = "settling";
  notePipelineEvent("auto-optics-short-shutter-handoff");
  try {
    const accepted = await applyCameraConstraint(track, { exposureMode: "manual", exposureTime: exposure, iso });
    if (!accepted || !automaticOpticsSessionAlive(track)) {
      autoOpticsRuntimeState = "ae";
      autoOpticsRetryAt = receiverNow() + 1800;
      return;
    }

    let tuned = await tuneAutomaticQrIso(track, exposure, iso, isoRange, maxAutoIso, rememberedIso);
    if (!automaticOpticsSessionAlive(track)) return;
    if (tuned.deferred) {
      autoOpticsRuntimeState = "manual";
      autoOpticsLockSince = receiverNow();
      autoOpticsRetryAt = receiverNow() + 550;
      autoOpticsTuneSummary = `${autoOpticsTuneSummary} · hold framing`;
      focusController.adoptAutomaticCameraState("automatic optics comparison deferred by movement; holding short-shutter seed");
      return;
    }

    if (tuned.collapsed) {
      const fallbackExposure = quantizeCameraRange(
        Math.min(exposureRange.max, AUTO_OPTICS_FALLBACK_EXPOSURE, 1e4 / fps * 0.18),
        exposureRange
      );
      if (fallbackExposure > exposure * 1.12) {
        const fallbackSeed = quantizeCameraRange(
          (tuned.iso || iso) * exposure / fallbackExposure,
          isoRange
        );
        const fallbackCap = Math.min(isoRange.max, maxAutoIso * exposure / fallbackExposure * Math.SQRT2);
        exposure = fallbackExposure;
        iso = fallbackSeed;
        autoOpticsTuneSummary = `short shutter dark · ${formatExposureMs(exposure)} escape`;
        tuned = await tuneAutomaticQrIso(track, exposure, iso, isoRange, Math.max(isoRange.min, fallbackCap), void 0);
        if (!automaticOpticsSessionAlive(track)) return;
      }
    }

    if (tuned.deferred) {
      autoOpticsRuntimeState = "manual";
      autoOpticsRetryAt = receiverNow() + 550;
      focusController.adoptAutomaticCameraState("automatic optics low-light comparison deferred; holding current manual optics");
      return;
    }
    if (tuned.collapsed || !tuned.best?.valid) {
      const collapsedYield = tuned.best?.yieldRate ?? 0;
      await applyExposureSetting(track);
      autoOpticsRuntimeState = "ae";
      autoOpticsLockSince = 0;
      autoOpticsAcquisitionSince = receiverNow();
      autoOpticsRetryAt = receiverNow() + AUTO_OPTICS_COLLAPSE_RETRY_MS;
      forgetAutomaticOptics(track);
      autoOpticsTuneSummary = `manual range collapsed ${(collapsedYield * 100).toFixed(0)}% · hardware AE reacquire`;
      focusController.adoptAutomaticCameraState("short-shutter and bounded low-light optics both failed; hardware AE reacquire");
      return;
    }

    autoOpticsRuntimeState = "manual";
    autoOpticsHoldSample = autoOpticsPipelineSnapshot();
    autoOpticsHoldCollapseSince = 0;
    autoOpticsHeldYield = tuned.best.yieldRate;
    autoOpticsRetryAt = Infinity;
    const tunedExposure = track.getSettings().exposureTime ?? exposure;
    const tunedIso = track.getSettings().iso ?? tuned.iso ?? iso;
    if (tuned.best.valid && tuned.best.yieldRate >= AUTO_OPTICS_MEMORY_MIN_YIELD)
      rememberAutomaticOptics(track, tunedExposure, tunedIso, tuned.best.score, tuned.best.yieldRate, aeExposureProduct);
    autoOpticsAeBaseline = void 0;
    focusController.adoptAutomaticCameraState("automatic QR optics converged at the darkest robust short-shutter setting");
  } finally {
    autoOpticsMutationRunning = false;
  }
}
async function releaseAutomaticQrOptics''')

# Intent guards: remembered startup must survive; stale completion attribution and
# 30%-frame shutter logic must not.
main = Path('receive/main.js').read_text()
focus = Path('receive/focus-controller.js').read_text()
assert 'const RECEIVER_RUNTIME_BUILD = "v0.5.286";' in main
assert 'const AUTO_OPTICS_SHUTTER_FRAME_FRACTION = 0.10;' in main
assert 'restored recent QR-proven automatic optics; validating live decode' in main
assert 'hardware AE acquisition' not in main
assert 'autoOpticsCompletionSamples' in main
assert 'sourceSequence: Number(sourceSequence)' in main
assert 'trying short-shutter alternatives' in main
assert 'shuffleAutomaticOpticsCandidates(explore)' not in main
assert 'candidates.find((candidate) => candidate.label === "short-shutter")' in main
assert 'automatic QR optics converged at the darkest robust short-shutter setting' in main
assert 'const frameSafeMax = 1e4 / observedFps * 0.18;' in focus
