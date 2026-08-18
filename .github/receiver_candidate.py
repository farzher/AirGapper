from pathlib import Path


def rep(path, old, new):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"missing anchor {path}: {old[:220]}")
    p.write_text(s.replace(old, new, 1))


def replace_between(path, start, end, new):
    p = Path(path)
    s = p.read_text()
    a = s.find(start)
    if a < 0:
        raise SystemExit(f"missing start anchor {path}: {start}")
    b = s.find(end, a)
    if b < 0:
        raise SystemExit(f"missing end anchor {path}: {end}")
    p.write_text(s[:a] + new.rstrip() + "\n" + s[b:])


# Build/cache bump.
rep('receive/main.js', 'const RECEIVER_RUNTIME_BUILD = "v0.5.292";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.293";')
rep('send/main.js', 'const SEND_RUNTIME_BUILD = "v0.5.292";', 'const SEND_RUNTIME_BUILD = "v0.5.293";')
rep('main.js', 'const APP_BUILD = "v0.5.292";', 'const APP_BUILD = "v0.5.293";')
rep('index.html', 'main.js?build=v0.5.292', 'main.js?build=v0.5.293')
rep('index.html', '<span class="brand">AirGapper <span class="app-version">v0.5.292</span></span>', '<span class="brand">AirGapper <span class="app-version">v0.5.293</span></span>')
rep('sw.js', 'airgapper-static-js-v240', 'airgapper-static-js-v241')

# Hardware A/B on the OnePlus-class camera showed the real optimum around
# 3.3 ms / ISO ~434 while v292's AE-product ceiling literally prevented Auto
# from testing above ~ISO 115.  Broaden the one-time bracket, but make the
# experiment controlled enough that "brighter" cannot win just because a
# different/easier subset of physical QRs happened to be scheduled.
rep('receive/main.js', 'const AUTO_OPTICS_GAIN_MAX_BASE_RATIO = 2.0;', 'const AUTO_OPTICS_GAIN_MAX_BASE_RATIO = 4.0;')
rep('receive/main.js', 'const AUTO_OPTICS_NEAR_BEST_SCORE = 0.94;', 'const AUTO_OPTICS_NEAR_BEST_SCORE = 0.97;')
rep('receive/main.js', 'const AUTO_OPTICS_NEAR_BEST_YIELD_DELTA = 0.07;', 'const AUTO_OPTICS_NEAR_BEST_YIELD_DELTA = 0.03;')
rep('receive/main.js', 'const AUTO_OPTICS_AE_PRODUCT_CEILING = 1.15;', 'const AUTO_OPTICS_AE_PRODUCT_CEILING = 6.0;')
rep(
    'receive/main.js',
    'const AUTO_OPTICS_CONTROL_RETRY_MS = 850;',
    'const AUTO_OPTICS_CONTROL_RETRY_MS = 850;\nconst AUTO_OPTICS_COHORT_MAX_SLOTS = 18;\nconst AUTO_OPTICS_COHORT_MIN_ATTEMPTS_PER_SLOT = 2;'
)

# v292 can contain a confidently-measured-but-nonrepresentative ISO 100 winner.
# v293's memory is only learned from a fixed physical-slot cohort.
rep('receive/main.js', 'const AUTO_OPTICS_HISTORY_KEY = "airgapper:auto-optics-learning:v3";', 'const AUTO_OPTICS_HISTORY_KEY = "airgapper:auto-optics-learning:v4";')
rep('receive/main.js', 'const AUTO_OPTICS_MEMORY_KEY = "airgapper:auto-optics-memory:v3";', 'const AUTO_OPTICS_MEMORY_KEY = "airgapper:auto-optics-memory:v4";')
rep(
    'receive/main.js',
    'let autoOpticsMemoryBoot;\n// These are the user\'s persistent MANUAL optics profile.',
    'let autoOpticsMemoryBoot;\nlet autoOpticsMeasurementSlots;\n// These are the user\'s persistent MANUAL optics profile.'
)
rep(
    'receive/main.js',
    '  autoOpticsMemoryBootAt = 0;\n  autoOpticsMemoryBoot = void 0;\n  autoOpticsTuneSummary = "";\n}',
    '  autoOpticsMemoryBootAt = 0;\n  autoOpticsMemoryBoot = void 0;\n  autoOpticsMeasurementSlots = void 0;\n  autoOpticsTuneSummary = "";\n}'
)

# Keep exact physical-slot attribution in the live completion stream.  v292
# reduced every job to aggregate tracks/outputs even though trackSlots were
# already known, so different candidate windows could compare different QR sets.
rep(
    'receive/main.js',
    '''      const submittedSlots = new Set(auditMode.trackSlots ?? []);
      const attributedOutputs = submittedSlots.size
        ? completion.symbols.reduce((count, symbol) =>
            count + Number(submittedSlots.has(Number(symbol.header?.slotIndex))), 0)
        : Math.min(Math.max(0, Number(auditMode.tracks) || 0), outputSymbols);
      autoOpticsCompletionSamples.push({
        at: receiverNow(),
        sourceSequence: auditMode.sourceSequence,
        tracks: Math.max(0, Number(auditMode.tracks) || 0),
        outputs: Math.min(Math.max(0, Number(auditMode.tracks) || 0), attributedOutputs)
      });''',
    '''      const submittedSlots = new Set((auditMode.trackSlots ?? []).map(Number).filter(Number.isFinite));
      const outputSlots = new Set(completion.symbols
        .map((symbol) => Number(symbol.header?.slotIndex))
        .filter((slot) => Number.isFinite(slot) && submittedSlots.has(slot)));
      const slotResults = [...submittedSlots].map((slot) => [slot, outputSlots.has(slot) ? 1 : 0]);
      const attributedOutputs = submittedSlots.size
        ? outputSlots.size
        : Math.min(Math.max(0, Number(auditMode.tracks) || 0), outputSymbols);
      autoOpticsCompletionSamples.push({
        at: receiverNow(),
        sourceSequence: auditMode.sourceSequence,
        tracks: submittedSlots.size || Math.max(0, Number(auditMode.tracks) || 0),
        outputs: Math.min(submittedSlots.size || Math.max(0, Number(auditMode.tracks) || 0), attributedOutputs),
        slotResults
      });'''
)

# Snapshot a distributed set of physical QR slots once per tuning pass.  The
# scheduler is temporarily forced to this cohort so every ISO sees the same wall.
rep(
    'receive/main.js',
    'function autoOpticsPoseDrift(a, b) {',
    '''function beginAutomaticOpticsMeasurementCohort() {
  const ordered = regions
    .filter((region) => region.gridSlot !== void 0 && region.quad && region.dim &&
      region.visibleFraction >= 0.85 && isGridDecodeCandidate(region))
    .sort((a, b) => Number(a.gridSlot) - Number(b.gridSlot));
  if (!ordered.length) {
    autoOpticsMeasurementSlots = void 0;
    return 0;
  }
  let selected = ordered;
  if (ordered.length > AUTO_OPTICS_COHORT_MAX_SLOTS) {
    selected = [];
    for (let i = 0; i < AUTO_OPTICS_COHORT_MAX_SLOTS; i++) {
      const index = Math.round(i * (ordered.length - 1) / Math.max(1, AUTO_OPTICS_COHORT_MAX_SLOTS - 1));
      const region = ordered[index];
      if (region && !selected.includes(region)) selected.push(region);
    }
  }
  autoOpticsMeasurementSlots = new Set(selected.map((region) => Number(region.gridSlot)).filter(Number.isFinite));
  notePipelineEvent("auto-optics-cohort", autoOpticsMeasurementSlots.size);
  return autoOpticsMeasurementSlots.size;
}
function autoOpticsPoseDrift(a, b) {'''
)

# Preserve per-slot evidence, score a candidate by macro-average wall yield, and
# require every frozen cohort slot to be attempted repeatedly before a sample is
# valid.  This prevents two fast/easy lanes from ending a sample before the weak
# physical QRs have even completed.
replace_between(
    'receive/main.js',
    'function autoOpticsEvidenceSince(firstSequence) {',
    'async function measureAutomaticIsoCandidate(track, exposure, requestedIso, isoRange, options = {}) {',
    '''function autoOpticsEvidenceSince(firstSequence) {
  let outputs = 0, attempts = 0, jobs = 0;
  let firstAt = Infinity, lastAt = 0;
  const slotAttempts = new Map();
  const slotOutputs = new Map();
  for (const sample of autoOpticsCompletionSamples) {
    if (sample.sourceSequence < firstSequence) continue;
    outputs += sample.outputs;
    attempts += sample.tracks;
    jobs++;
    firstAt = Math.min(firstAt, sample.at);
    lastAt = Math.max(lastAt, sample.at);
    for (const [slotRaw, hitRaw] of sample.slotResults ?? []) {
      const slot = Number(slotRaw);
      if (!Number.isFinite(slot)) continue;
      slotAttempts.set(slot, (slotAttempts.get(slot) || 0) + 1);
      slotOutputs.set(slot, (slotOutputs.get(slot) || 0) + Number(Boolean(hitRaw)));
    }
  }
  return { outputs, attempts, jobs, firstAt, lastAt, slotAttempts, slotOutputs };
}
function automaticOpticsCohortMetrics(evidence) {
  const cohort = autoOpticsMeasurementSlots;
  if (!cohort?.size) {
    const yieldRate = evidence.attempts ? evidence.outputs / evidence.attempts : 0;
    return {
      size: 0,
      outputs: evidence.outputs,
      attempts: evidence.attempts,
      coverage: 1,
      breadth: yieldRate > 0 ? 1 : 0,
      meanYield: yieldRate,
      tailYield: yieldRate,
      minAttempts: evidence.attempts,
      ready: evidence.attempts >= AUTO_OPTICS_GAIN_MIN_ATTEMPTS
    };
  }
  let outputs = 0;
  let attempts = 0;
  let covered = 0;
  let successful = 0;
  let minAttempts = Infinity;
  const slotYields = [];
  for (const slot of cohort) {
    const slotAttemptCount = evidence.slotAttempts.get(slot) || 0;
    const slotOutputCount = Math.min(slotAttemptCount, evidence.slotOutputs.get(slot) || 0);
    outputs += slotOutputCount;
    attempts += slotAttemptCount;
    if (slotAttemptCount > 0) covered++;
    if (slotOutputCount > 0) successful++;
    minAttempts = Math.min(minAttempts, slotAttemptCount);
    slotYields.push(slotAttemptCount ? slotOutputCount / slotAttemptCount : 0);
  }
  slotYields.sort((a, b) => a - b);
  const meanYield = slotYields.length ? slotYields.reduce((sum, value) => sum + value, 0) / slotYields.length : 0;
  const tailYield = slotYields.length ? slotYields[Math.floor((slotYields.length - 1) * 0.25)] : 0;
  return {
    size: cohort.size,
    outputs,
    attempts,
    coverage: covered / cohort.size,
    breadth: successful / cohort.size,
    meanYield,
    tailYield,
    minAttempts: Number.isFinite(minAttempts) ? minAttempts : 0,
    ready: covered === cohort.size && minAttempts >= AUTO_OPTICS_COHORT_MIN_ATTEMPTS_PER_SLOT
  };
}
function scoreAutomaticOpticsEvidence(evidence) {
  const cohort = automaticOpticsCohortMetrics(evidence);
  const confidence = autoOpticsConfidenceScore(cohort.outputs, cohort.attempts);
  const score = cohort.size
    ? confidence * cohort.coverage * (0.72 + 0.18 * cohort.breadth + 0.10 * cohort.tailYield)
    : confidence;
  return { ...cohort, score };
}
async function sampleAutomaticOpticsQuality(track, iso, firstSequence, sampleMs = AUTO_OPTICS_GAIN_SAMPLE_MS) {
  if (!await waitForStableAutoOpticsPose(track, AUTO_OPTICS_POSE_WAIT_MS)) {
    return { iso, outputs: 0, attempts: 0, jobs: 0, rate: 0, yieldRate: 0, score: 0, valid: false, unstable: true };
  }
  const poseAnchor = autoOpticsPoseSnapshot();
  const cohortSize = autoOpticsMeasurementSlots?.size || 0;
  const targetAttempts = Math.max(
    AUTO_OPTICS_GAIN_MIN_ATTEMPTS,
    cohortSize * AUTO_OPTICS_COHORT_MIN_ATTEMPTS_PER_SLOT,
    Math.min(72, Math.ceil(Math.max(1, poseAnchor.visible) * 2))
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
    const scored = scoreAutomaticOpticsEvidence(evidence);
    if (evidence.jobs >= 2 && scored.attempts >= targetAttempts && scored.ready && performance.now() - started >= 120) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  evidence = autoOpticsEvidenceSince(firstSequence);
  const scored = scoreAutomaticOpticsEvidence(evidence);
  const elapsed = Math.max(0.001, (performance.now() - started) / 1e3);
  return {
    iso,
    outputs: scored.outputs,
    attempts: scored.attempts,
    jobs: evidence.jobs,
    rate: scored.outputs / elapsed,
    yieldRate: scored.meanYield,
    score: scored.score,
    cohortSize: scored.size,
    cohortCoverage: scored.coverage,
    breadth: scored.breadth,
    tailYield: scored.tailYield,
    minSlotAttempts: scored.minAttempts,
    slotAttempts: evidence.slotAttempts,
    slotOutputs: evidence.slotOutputs,
    maxCenterDrift,
    maxScaleDrift,
    unstable: !poseStable,
    valid: poseStable && evidence.jobs >= 2 && scored.attempts >= AUTO_OPTICS_GAIN_MIN_ATTEMPTS && scored.ready
  };
}
'''
)

rep(
    'receive/main.js',
    '''function describeAutoIsoProbe(probe) {
  if (!probe) return "—";
  if (probe.unstable) return `${Math.round(probe.iso)}:moved`;
  if (!probe.valid) return `${Math.round(probe.iso)}:insufficient`;
  return `${Math.round(probe.iso)}:${(probe.yieldRate * 100).toFixed(0)}%`;
}''',
    '''function describeAutoIsoProbe(probe) {
  if (!probe) return "—";
  if (probe.unstable) return `${Math.round(probe.iso)}:moved`;
  if (!probe.valid) return `${Math.round(probe.iso)}:insufficient`;
  const tail = Number.isFinite(probe.tailYield) ? ` p25 ${(probe.tailYield * 100).toFixed(0)}%` : "";
  return `${Math.round(probe.iso)}:${(probe.yieldRate * 100).toFixed(0)}%${tail}`;
}'''
)

# Controlled broad bracket: base, darker, 2x brighter, base control, then at
# most one 4x bright / 0.5x dark boundary step.  v292's sqrt(2) + AE cap could
# never reach the hardware-proven ISO ~434 region from an ISO-100 seed.
replace_between(
    'receive/main.js',
    'async function tuneAutomaticQrIso(track, exposure, seedIso, isoRange, maxAutoIso, rememberedIso) {',
    'async function settleAutomaticQrOptics(track, now) {',
    '''async function tuneAutomaticQrIso(track, exposure, seedIso, isoRange, maxAutoIso, rememberedIso) {
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
    autoOpticsTuneSummary = `cohort ${autoOpticsMeasurementSlots?.size || 0} · ${formatExposureMs(exposure)} · ${label} ISO ${Math.round(requested)}`;
    const result = await measureAutomaticIsoCandidate(track, exposure, requested, isoRange, options);
    if (result?.unstable) invalidatedByMotion = true;
    if (result && !options.confirm) probes.push(result);
    return result;
  };
  const materiallyBetter = (candidate, reference) => {
    if (!candidate?.valid) return false;
    if (!reference?.valid) return true;
    return candidate.score >= reference.score * AUTO_OPTICS_GAIN_IMPROVEMENT ||
      candidate.yieldRate >= reference.yieldRate + AUTO_OPTICS_GAIN_DIRECTION_YIELD_DELTA;
  };
  const mergeMap = (a, b) => {
    const merged = new Map(a ?? []);
    for (const [key, value] of b ?? []) merged.set(key, (merged.get(key) || 0) + value);
    return merged;
  };
  const combine = (a, b) => {
    if (!a?.valid) return b;
    if (!b?.valid) return a;
    const slotAttempts = mergeMap(a.slotAttempts, b.slotAttempts);
    const slotOutputs = mergeMap(a.slotOutputs, b.slotOutputs);
    const evidence = {
      outputs: a.outputs + b.outputs,
      attempts: a.attempts + b.attempts,
      slotAttempts,
      slotOutputs
    };
    const scored = scoreAutomaticOpticsEvidence(evidence);
    return {
      ...b,
      requestedIso: a.requestedIso,
      outputs: scored.outputs,
      attempts: scored.attempts,
      jobs: a.jobs + b.jobs,
      yieldRate: scored.meanYield,
      rate: (a.rate + b.rate) / 2,
      score: scored.score,
      cohortSize: scored.size,
      cohortCoverage: scored.coverage,
      breadth: scored.breadth,
      tailYield: scored.tailYield,
      minSlotAttempts: scored.minAttempts,
      slotAttempts,
      slotOutputs,
      valid: true
    };
  };
  const controlStable = (a, b) => {
    if (!a?.valid || !b?.valid) return false;
    const yieldDrift = Math.abs(a.yieldRate - b.yieldRate);
    const highScore = Math.max(a.score, b.score);
    const lowScore = Math.min(a.score, b.score);
    const scoreRatio = highScore > 0 ? lowScore / highScore : 1;
    return yieldDrift <= AUTO_OPTICS_CONTROL_MAX_YIELD_DRIFT &&
      scoreRatio >= AUTO_OPTICS_CONTROL_MIN_SCORE_RATIO;
  };

  const baseline = await probe(base, remembered !== void 0 ? "memory seed" : "seed");
  if (!automaticOpticsSessionAlive(track)) return { iso: base, probes };
  if (invalidatedByMotion) return { iso: base, probes, deferred: true };

  const darker = await probe(base / Math.SQRT2, "darker");
  if (!automaticOpticsSessionAlive(track)) return { iso: base, probes };
  if (invalidatedByMotion) return { iso: base, probes, deferred: true };

  const brighter = await probe(Math.min(cap, base * 2), "brighter 2x");
  if (!automaticOpticsSessionAlive(track)) return { iso: base, probes };
  if (invalidatedByMotion) return { iso: base, probes, deferred: true };

  const control = await probe(base, "control", { confirm: true, sampleMs: AUTO_OPTICS_GAIN_SAMPLE_MS });
  if (!automaticOpticsSessionAlive(track)) return { iso: base, probes };
  if (!control || control.unstable || !control.valid || invalidatedByMotion) {
    autoOpticsTuneSummary = `${formatExposureMs(exposure)} · cohort control invalidated · retry after TRACK settles`;
    return {
      iso: base,
      probes,
      deferred: true,
      retryMs: AUTO_OPTICS_CONTROL_RETRY_MS,
      deferredReason: "same-slot control invalidated · holding short shutter until TRACK settles"
    };
  }
  if (baseline?.valid && !controlStable(baseline, control)) {
    const drift = Math.abs(baseline.yieldRate - control.yieldRate);
    autoOpticsTuneSummary = `${formatExposureMs(exposure)} · same-slot base ${Math.round(baseline.yieldRate * 100)}→${Math.round(control.yieldRate * 100)}% · tracker still maturing`;
    return {
      iso: base,
      probes,
      deferred: true,
      retryMs: AUTO_OPTICS_CONTROL_RETRY_MS,
      deferredReason: `same-slot base drifted ${(drift * 100).toFixed(0)} points · holding short shutter until TRACK settles`
    };
  }

  const baselineReference = combine(baseline, control);
  const localValid = [baselineReference, darker, brighter].filter((item) => item?.valid);
  const localBest = localValid.reduce((winner, item) =>
    !winner || item.score > winner.score || item.score === winner.score && item.yieldRate > winner.yieldRate ? item : winner, null);

  if (measured.size < AUTO_OPTICS_GAIN_MAX_PROBES && localBest && materiallyBetter(localBest, baselineReference)) {
    if (localBest.requestedIso < base * 0.99) {
      await probe(base / 2, "darker boundary");
    } else if (localBest.requestedIso > base * 1.01) {
      const brightLimit = Math.min(cap, base * AUTO_OPTICS_GAIN_MAX_BASE_RATIO);
      if (brightLimit > localBest.requestedIso * 1.01)
        await probe(brightLimit, "brighter 4x boundary");
    }
  }
  if (!automaticOpticsSessionAlive(track)) return { iso: base, probes };
  if (invalidatedByMotion) return { iso: base, probes, deferred: true };

  const decisionCandidates = [
    baselineReference,
    ...probes.filter((item) => item?.valid && String(item.requestedIso) !== String(base))
  ].filter((item) => item?.valid);
  if (!decisionCandidates.length) {
    autoOpticsTuneSummary = `${formatExposureMs(exposure)} · ${probes.map(describeAutoIsoProbe).join(" · ")} · insufficient cohort evidence`;
    return { iso: base, probes, deferred: true };
  }
  const best = decisionCandidates.reduce((winner, item) =>
    !winner || item.score > winner.score || item.score === winner.score && item.yieldRate > winner.yieldRate ? item : winner, null);
  if (best.yieldRate < AUTO_OPTICS_COLLAPSE_YIELD) {
    autoOpticsTuneSummary = `${formatExposureMs(exposure)} · ${probes.map(describeAutoIsoProbe).join(" · ")} · collapsed`;
    return { iso: base, probes, best, collapsed: true };
  }
  const yieldFloor = Math.max(AUTO_OPTICS_COLLAPSE_YIELD, best.yieldRate - AUTO_OPTICS_NEAR_BEST_YIELD_DELTA);
  const nearBest = decisionCandidates.filter((item) =>
    item.score >= best.score * AUTO_OPTICS_NEAR_BEST_SCORE && item.yieldRate >= yieldFloor
  ).sort((a, b) => a.requestedIso - b.requestedIso);
  const selected = nearBest[0] ?? best;

  const selectedIsBase = String(selected.requestedIso) === String(base);
  const confirm = selectedIsBase
    ? control
    : await probe(selected.requestedIso, "confirm", { confirm: true, sampleMs: 560 });
  if (!confirm || confirm.unstable || !confirm.valid) {
    return { iso: selected.requestedIso, probes, deferred: true };
  }
  if (!selectedIsBase && (confirm.yieldRate < Math.max(AUTO_OPTICS_COLLAPSE_YIELD, selected.yieldRate - 0.10) ||
      confirm.score < selected.score * 0.84)) {
    autoOpticsTuneSummary = `${formatExposureMs(exposure)} · same-slot confirmation disagreed · retry later`;
    return { iso: selected.requestedIso, probes, deferred: true };
  }
  const confirmed = selectedIsBase ? baselineReference : combine(selected, confirm);
  autoOpticsTuneSummary = `cohort ${confirmed.cohortSize || 0} · ${formatExposureMs(exposure)} · ${probes.map(describeAutoIsoProbe).join(" · ")} · control ${Math.round(control.yieldRate * 100)}% → ISO ${Math.round(confirm.iso)} · confirmed ${Math.round(confirmed.yieldRate * 100)}% p25 ${Math.round((confirmed.tailYield || 0) * 100)}%`;
  return { iso: confirm.iso, probes, best: confirmed };
}
'''
)

# Freeze scheduler composition during post-lock Auto measurements.  All normal
# adaptive weak thinning / repair resumes as soon as the tuning pass ends.
rep(
    'receive/main.js',
    '''  const batchCandidates = (gridLattice.active ? visibleGridSlots.filter(isGridDecodeCandidate) : regions.filter((region) => region.observed && region.decoded)).filter((region) => region.quad && region.dim && validTrackedQuad(region, vw, vh)).slice(0, 32);
  // Payload weakness and wall-pose recovery are separate concerns. Motion
  // now comes from CRC-valid whole-wall feedback and missing breadth has its own
  // targeted recovery probe, so do not flood proven-bad payload slots during a
  // motion wobble. That only lengthens Guided jobs and causes newer frames to be
  // replaced while workers chew on known failures.
  const adaptiveWeakSlots = gridLattice.active && adaptiveWeakSlotScheduling(batchCandidates);''',
    '''  const allBatchCandidates = (gridLattice.active ? visibleGridSlots.filter(isGridDecodeCandidate) : regions.filter((region) => region.observed && region.decoded)).filter((region) => region.quad && region.dim && validTrackedQuad(region, vw, vh)).slice(0, 32);
  const batchCandidates = autoOpticsMeasurementSlots?.size
    ? allBatchCandidates.filter((region) => autoOpticsMeasurementSlots.has(Number(region.gridSlot)))
    : allBatchCandidates;
  // Payload weakness and wall-pose recovery are separate concerns. Motion
  // now comes from CRC-valid whole-wall feedback and missing breadth has its own
  // targeted recovery probe, so do not flood proven-bad payload slots during a
  // motion wobble. That only lengthens Guided jobs and causes newer frames to be
  // replaced while workers chew on known failures. Auto Optics is the exception:
  // its frozen physical-slot cohort must be identical for every candidate.
  const adaptiveWeakSlots = gridLattice.active && !autoOpticsMeasurementSlots?.size && adaptiveWeakSlotScheduling(batchCandidates);'''
)
rep(
    'receive/main.js',
    '''  const eligible = gridLattice.active ? visibleGridSlots.filter(isGridDecodeCandidate).sort((a, b) => slotUsefulness(b) - slotUsefulness(a)) : regions.filter((region) => region.observed && region.decoded);
  activeDecodeBudget = gridLattice.active ? Math.min(8, Math.max(4, pool.size * 2), eligible.length) : eligible.length;
  const scheduledRegions = eligible.slice(0, activeDecodeBudget);''',
    '''  const eligibleBase = gridLattice.active ? visibleGridSlots.filter(isGridDecodeCandidate) : regions.filter((region) => region.observed && region.decoded);
  const eligible = autoOpticsMeasurementSlots?.size
    ? eligibleBase.filter((region) => autoOpticsMeasurementSlots.has(Number(region.gridSlot))).sort((a, b) => Number(a.gridSlot) - Number(b.gridSlot))
    : eligibleBase.sort((a, b) => slotUsefulness(b) - slotUsefulness(a));
  activeDecodeBudget = autoOpticsMeasurementSlots?.size
    ? eligible.length
    : gridLattice.active ? Math.min(8, Math.max(4, pool.size * 2), eligible.length) : eligible.length;
  const scheduledRegions = eligible.slice(0, activeDecodeBudget);'''
)

# Establish the fixed cohort only after TRACK/pose stability, keep it across the
# short-shutter fallback if needed, and always release it before normal running.
rep(
    'receive/main.js',
    '''    let exposure = targetExposure;
    let cap = isoCapFor(exposure);''',
    '''    const cohortSize = beginAutomaticOpticsMeasurementCohort();
    if (!cohortSize) {
      autoOpticsRuntimeState = "ae";
      autoOpticsLockSince = 0;
      autoOpticsRetryAt = receiverNow() + AUTO_OPTICS_CONTROL_RETRY_MS;
      autoOpticsTuneSummary = "waiting for a stable decodable slot cohort";
      return;
    }
    let exposure = targetExposure;
    let cap = isoCapFor(exposure);'''
)
rep(
    'receive/main.js',
    '''    notePipelineEvent("auto-optics-converged", Math.round(tuned.best.yieldRate * 100));
  } finally {
    autoOpticsMutationRunning = false;
  }
}
async function releaseAutomaticQrOptics''',
    '''    notePipelineEvent("auto-optics-converged", Math.round(tuned.best.yieldRate * 100));
  } finally {
    autoOpticsMeasurementSlots = void 0;
    autoOpticsMutationRunning = false;
  }
}
async function releaseAutomaticQrOptics'''
)

main = Path('receive/main.js').read_text()
for needle in [
    'const RECEIVER_RUNTIME_BUILD = "v0.5.293";',
    'airgapper:auto-optics-memory:v4',
    'AUTO_OPTICS_AE_PRODUCT_CEILING = 6.0',
    'AUTO_OPTICS_COHORT_MIN_ATTEMPTS_PER_SLOT',
    'slotResults',
    'beginAutomaticOpticsMeasurementCohort',
    'brighter 4x boundary',
    'same-slot control invalidated',
    'autoOpticsMeasurementSlots?.size'
]:
    if needle not in main:
        raise SystemExit(f'missing v293 invariant: {needle}')
