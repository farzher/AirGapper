from pathlib import Path


def rep(path, old, new):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"missing anchor {path}: {old[:240]}")
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
rep('receive/main.js', 'const RECEIVER_RUNTIME_BUILD = "v0.5.293";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.294";')
rep('send/main.js', 'const SEND_RUNTIME_BUILD = "v0.5.293";', 'const SEND_RUNTIME_BUILD = "v0.5.294";')
rep('main.js', 'const APP_BUILD = "v0.5.293";', 'const APP_BUILD = "v0.5.294";')
rep('index.html', 'main.js?build=v0.5.293', 'main.js?build=v0.5.294')
rep('index.html', '<span class="brand">AirGapper <span class="app-version">v0.5.293</span></span>', '<span class="brand">AirGapper <span class="app-version">v0.5.294</span></span>')
rep('sw.js', 'airgapper-static-js-v241', 'airgapper-static-js-v242')

# The emissive QR wall is not a photographic exposure target. v293 still began
# every fresh calibration by deliberately darkening neutral AE by 0.8 EV, even
# though the hardware trace proves the decoder can prefer ~4x the ISO at the same
# shutter. Darkness is now only a tie-break between decoder-equivalent settings.
rep('receive/main.js', 'const AUTO_QR_EV_BIAS = -0.8;', 'const AUTO_QR_EV_BIAS = 0;')
rep('receive/main.js', 'const AUTO_OPTICS_GAIN_SETTLE_MS = 340;', 'const AUTO_OPTICS_GAIN_SETTLE_MS = 220;')
rep('receive/main.js', 'const AUTO_OPTICS_GAIN_SAMPLE_MS = 520;', 'const AUTO_OPTICS_GAIN_SAMPLE_MS = 380;')
rep('receive/main.js', 'const AUTO_OPTICS_MEMORY_MIN_YIELD = 0.15;', 'const AUTO_OPTICS_MEMORY_MIN_YIELD = 0.55;')
rep('receive/main.js', 'const AUTO_OPTICS_GAIN_MAX_PROBES = 4;', 'const AUTO_OPTICS_GAIN_MAX_PROBES = 8;')
rep('receive/main.js', 'const AUTO_OPTICS_GAIN_MAX_BASE_RATIO = 4.0;', 'const AUTO_OPTICS_GAIN_MAX_BASE_RATIO = 8.0;')
rep(
    'receive/main.js',
    'const AUTO_OPTICS_COHORT_MIN_ATTEMPTS_PER_SLOT = 2;\nconst AUTO_OPTICS_NEAR_BEST_SCORE = 0.97;',
    'const AUTO_OPTICS_COHORT_MIN_ATTEMPTS_PER_SLOT = 2;\nconst AUTO_OPTICS_HEALTHY_YIELD = 0.50;\nconst AUTO_OPTICS_HEALTHY_TAIL_YIELD = 0.20;\nconst AUTO_OPTICS_REUSABLE_YIELD = 0.60;\nconst AUTO_OPTICS_REUSABLE_TAIL_YIELD = 0.35;\nconst AUTO_OPTICS_UNHEALTHY_RETRY_MS = 3000;\nconst AUTO_OPTICS_NEAR_BEST_SCORE = 0.97;'
)
rep('receive/main.js', 'const AUTO_OPTICS_COLLAPSE_YIELD = 0.12;', 'const AUTO_OPTICS_COLLAPSE_YIELD = 0.25;')
rep('receive/main.js', 'const AUTO_OPTICS_HISTORY_KEY = "airgapper:auto-optics-learning:v4";', 'const AUTO_OPTICS_HISTORY_KEY = "airgapper:auto-optics-learning:v5";')
rep('receive/main.js', 'const AUTO_OPTICS_MEMORY_KEY = "airgapper:auto-optics-memory:v4";', 'const AUTO_OPTICS_MEMORY_KEY = "airgapper:auto-optics-memory:v5";')
rep('receive/main.js', 'controller: 291,', 'controller: 294,')

# Tag every decode job at submit time. Calibration may finish before a slow job
# returns, so consulting only the current global calibration flag at completion
# time is not safe enough.
rep(
    'receive/main.js',
    '    reacquire: Boolean(message.full && gridLattice.locked),',
    '    reacquire: Boolean(message.full && gridLattice.locked),\n    autoOpticsProbe: Boolean(autoOpticsMeasurementSlots?.size),'
)

# Auto-optics probe frames are observational. They may contribute candidate
# evidence and useful payload bytes, but deliberate bad candidates must not teach
# the production Guided fallback policy or Guided bad-streak controller.
rep(
    'receive/main.js',
    'function noteGuidedCompletion(stage, outputSymbols, tracks, latencyMs) {\n  guidedRollout.inFlight = Math.max(0, guidedRollout.inFlight - 1);\n  if (!stage) return;',
    'function noteGuidedCompletion(stage, outputSymbols, tracks, latencyMs, observational = false) {\n  guidedRollout.inFlight = Math.max(0, guidedRollout.inFlight - 1);\n  if (!stage || observational) return;'
)
rep(
    'receive/main.js',
    '    if (guided) noteGuidedFallbackMetrics(guided);',
    '    if (guided && !auditMode?.autoOpticsProbe) noteGuidedFallbackMetrics(guided);'
)
rep(
    'receive/main.js',
    '      if (auditMode.guided) noteGuidedCompletion(auditMode.guidedStage, outputSymbols, auditMode.tracks, latencyMs);\n      else if (!completion.error && completion.readFullAttempts) noteGuidedRobustBaseline(latencyMs);',
    '      if (auditMode.guided) noteGuidedCompletion(auditMode.guidedStage, outputSymbols, auditMode.tracks, latencyMs, auditMode.autoOpticsProbe);\n      else if (!auditMode.autoOpticsProbe && !completion.error && completion.readFullAttempts) noteGuidedRobustBaseline(latencyMs);'
)

# Most importantly, a calibration miss cannot poison production geometry. v293
# was marking a slot decoded=false after only three intentionally dark probe
# frames. That changed the cohort/scheduler during the experiment and then left
# the real receiver in a recovery storm after calibration.
rep(
    'receive/main.js',
    '''    if (region.gridSlot !== void 0) noteSlotMetric(region.gridSlot, hit);
    region.decodeConfidence = region.decodeConfidence * 0.82 + Number(hit) * 0.18;
    if (!hit && ((_a = region.lastHitScanId) != null ? _a : -1) <= id) {
      region.consecutiveMisses++;
      if (region.consecutiveMisses >= 3) region.decoded = false;
    }''',
    '''    if (!auditMode?.autoOpticsProbe) {
      if (region.gridSlot !== void 0) noteSlotMetric(region.gridSlot, hit);
      region.decodeConfidence = region.decodeConfidence * 0.82 + Number(hit) * 0.18;
      if (!hit && ((_a = region.lastHitScanId) != null ? _a : -1) <= id) {
        region.consecutiveMisses++;
        if (region.consecutiveMisses >= 3) region.decoded = false;
      }
    }'''
)

# Generic recovery during a deliberately bad exposure candidate only burns CPU
# and feeds more state churn. Hold the frozen cohort for the few-second sweep;
# normal recovery resumes immediately after calibration ends.
rep(
    'receive/main.js',
    '''  const globalRecoverySeedScan = fullScanDue && !captureNextScan && gridLattice.locked &&
    (allLockedCandidatesCold || lockedDecodeSilenceMs >= GEOMETRY_PROBE_SILENCE_MS);
  const localRecoverySeedScan = fullScanDue && !captureNextScan && gridLattice.locked &&
    geometryProbeDue && !globalRecoverySeedScan && lockedGeometryCandidates.length > 0;''',
    '''  const globalRecoverySeedScan = fullScanDue && !captureNextScan && !autoOpticsMeasurementSlots?.size && gridLattice.locked &&
    (allLockedCandidatesCold || lockedDecodeSilenceMs >= GEOMETRY_PROBE_SILENCE_MS);
  const localRecoverySeedScan = fullScanDue && !captureNextScan && !autoOpticsMeasurementSlots?.size && gridLattice.locked &&
    geometryProbeDue && !globalRecoverySeedScan && lockedGeometryCandidates.length > 0;'''
)

# Replace the local hill-climb with a global, fixed-cohort gain sweep. v293 saw
# ISO 100=15% and ISO 200=17%, decided that +2 points was not enough evidence to
# continue brighter, and therefore never tested the independently proven ISO~434
# basin. A local optimizer cannot cross a flat/bad basin. This sweep always tests
# octave-spaced gain (1x/2x/4x/8x), then refines around the global winner.
replace_between(
    'receive/main.js',
    'async function tuneAutomaticQrIso(track, exposure, seedIso, isoRange, maxAutoIso, rememberedIso) {',
    'async function settleAutomaticQrOptics(track, now) {',
    r'''async function tuneAutomaticQrIso(track, exposure, seedIso, isoRange, maxAutoIso, rememberedIso) {
  if (!automaticOpticsSessionAlive(track)) return { iso: seedIso, probes: [] };
  autoOpticsRuntimeState = "tuning";
  const cap = Math.max(isoRange.min, Math.min(isoRange.max, maxAutoIso));
  const clampIso = (value) => quantizeCameraRange(Math.max(isoRange.min, Math.min(cap, value)), isoRange);
  const seed = clampIso(seedIso);
  const remembered = Number.isFinite(rememberedIso) ? clampIso(rememberedIso) : void 0;
  const manualHint = Number.isFinite(preferredIso)
    ? clampIso(Number.isFinite(preferredExposureTime) && preferredExposureTime > 0
      ? preferredIso * preferredExposureTime / Math.max(1e-6, exposure)
      : preferredIso)
    : void 0;
  const probes = [];
  const measured = new Map();
  let invalidatedByMotion = false;

  const probe = async (candidate, label, options = {}) => {
    const requested = clampIso(candidate);
    const key = String(requested);
    if (!options.confirm && measured.has(key)) return measured.get(key);
    if (!options.confirm && measured.size >= AUTO_OPTICS_GAIN_MAX_PROBES) return null;
    autoOpticsTuneSummary = `global gain · ${formatExposureMs(exposure)} · ${label} ISO ${Math.round(requested)}`;
    const result = await measureAutomaticIsoCandidate(track, exposure, requested, isoRange, options);
    if (result?.unstable) invalidatedByMotion = true;
    if (result && !options.confirm) {
      measured.set(key, result);
      probes.push(result);
    }
    return result;
  };
  const mergeMap = (a, b) => {
    const merged = new Map();
    for (const [key, value] of a ?? []) merged.set(key, (merged.get(key) || 0) + Number(value || 0));
    for (const [key, value] of b ?? []) merged.set(key, (merged.get(key) || 0) + Number(value || 0));
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
  const tailFor = (item) => Number.isFinite(item?.tailYield) ? item.tailYield : Number(item?.yieldRate) || 0;
  const coverageFor = (item) => Number.isFinite(item?.cohortCoverage) ? item.cohortCoverage : 1;
  const breadthFor = (item) => Number.isFinite(item?.breadth) ? item.breadth : Number(item?.yieldRate > 0);
  const quality = (item) => {
    if (!item?.valid) return -Infinity;
    return coverageFor(item) * (
      0.70 * item.yieldRate +
      0.20 * tailFor(item) +
      0.10 * breadthFor(item)
    );
  };
  const healthy = (item) => Boolean(item?.valid && coverageFor(item) >= 0.95 &&
    item.yieldRate >= AUTO_OPTICS_HEALTHY_YIELD &&
    ((item.cohortSize || 0) <= 2 || tailFor(item) >= AUTO_OPTICS_HEALTHY_TAIL_YIELD));
  const reusable = (item) => Boolean(healthy(item) &&
    item.yieldRate >= AUTO_OPTICS_REUSABLE_YIELD &&
    ((item.cohortSize || 0) <= 2 || tailFor(item) >= AUTO_OPTICS_REUSABLE_TAIL_YIELD));
  const better = (candidate, winner) => {
    if (!candidate?.valid) return false;
    if (!winner?.valid) return true;
    const cq = quality(candidate), wq = quality(winner);
    if (cq > wq + 0.01) return true;
    if (wq > cq + 0.01) return false;
    if (candidate.yieldRate > winner.yieldRate + 0.015) return true;
    if (winner.yieldRate > candidate.yieldRate + 0.015) return false;
    if (tailFor(candidate) > tailFor(winner) + 0.03) return true;
    if (tailFor(winner) > tailFor(candidate) + 0.03) return false;
    return Number(candidate.requestedIso) < Number(winner.requestedIso);
  };
  const bestOf = (items) => items.filter((item) => item?.valid)
    .reduce((winner, item) => better(item, winner) ? item : winner, null);
  const moved = (fallbackIso = seed) => ({
    iso: fallbackIso,
    probes,
    deferred: true,
    retryMs: AUTO_OPTICS_CONTROL_RETRY_MS,
    deferredReason: "global gain sweep invalidated by movement · holding current short shutter"
  });
  const confirmCandidate = async (candidate, label = "confirm") => {
    if (!candidate?.valid) return null;
    const confirmation = await probe(candidate.requestedIso, label, { confirm: true, sampleMs: AUTO_OPTICS_GAIN_SAMPLE_MS });
    if (!confirmation || confirmation.unstable || !confirmation.valid) return null;
    if (confirmation.yieldRate < Math.max(AUTO_OPTICS_COLLAPSE_YIELD, candidate.yieldRate - 0.12) ||
        quality(confirmation) < quality(candidate) - 0.14) return null;
    return combine(candidate, confirmation);
  };

  for (const [hint, label] of [[remembered, "memory"], [manualHint, "manual hint"]]) {
    if (!Number.isFinite(hint)) continue;
    const first = await probe(hint, label);
    if (!automaticOpticsSessionAlive(track)) return { iso: hint, probes };
    if (invalidatedByMotion) return moved(hint);
    if (!healthy(first)) continue;
    const confirmed = await confirmCandidate(first, `${label} confirm`);
    if (!automaticOpticsSessionAlive(track)) return { iso: hint, probes };
    if (invalidatedByMotion) return moved(hint);
    if (confirmed && healthy(confirmed)) {
      autoOpticsTuneSummary = `cohort ${confirmed.cohortSize || 0} · ${formatExposureMs(exposure)} · ${label} ISO ${Math.round(confirmed.iso)} · confirmed ${Math.round(confirmed.yieldRate * 100)}% p25 ${Math.round(tailFor(confirmed) * 100)}%`;
      return { iso: confirmed.iso, probes, best: confirmed, healthy: true, reusable: reusable(confirmed) };
    }
  }

  // Global log-space sweep. Crucially, low gain is not allowed to stop brighter
  // exploration. A flat bad basin at 100/200 must still cross 400/800-class ISO.
  const baseline = await probe(seed, "sweep 1x");
  if (!automaticOpticsSessionAlive(track)) return { iso: seed, probes };
  if (invalidatedByMotion) return moved(seed);
  for (const [factor, label] of [[2, "sweep 2x"], [4, "sweep 4x"], [8, "sweep 8x"]]) {
    const candidate = Math.min(cap, seed * factor);
    if (candidate <= seed * 1.01) continue;
    await probe(candidate, label);
    if (!automaticOpticsSessionAlive(track)) return { iso: seed, probes };
    if (invalidatedByMotion) return moved(seed);
  }
  if (seed > isoRange.min * 1.35 && measured.size < AUTO_OPTICS_GAIN_MAX_PROBES)
    await probe(seed / 2, "sweep 0.5x");
  if (cap > seed * 1.01 && measured.size < AUTO_OPTICS_GAIN_MAX_PROBES)
    await probe(cap, "sweep ceiling");
  if (!automaticOpticsSessionAlive(track)) return { iso: seed, probes };
  if (invalidatedByMotion) return moved(seed);

  const control = await probe(seed, "control", { confirm: true, sampleMs: AUTO_OPTICS_GAIN_SAMPLE_MS });
  if (!automaticOpticsSessionAlive(track)) return { iso: seed, probes };
  if (!control || control.unstable || !control.valid || invalidatedByMotion) {
    autoOpticsTuneSummary = `${formatExposureMs(exposure)} · global control invalidated · retry`;
    return moved(seed);
  }
  if (baseline?.valid && !controlStable(baseline, control)) {
    const drift = Math.abs(baseline.yieldRate - control.yieldRate);
    return {
      iso: seed,
      probes,
      deferred: true,
      retryMs: AUTO_OPTICS_CONTROL_RETRY_MS,
      deferredReason: `global base control drifted ${(drift * 100).toFixed(0)} points · retry after TRACK settles`
    };
  }
  const baselineReference = combine(baseline, control);
  let decisionCandidates = [
    baselineReference,
    ...probes.filter((item) => item?.valid && String(item.requestedIso) !== String(seed))
  ].filter((item) => item?.valid);
  let coarseBest = bestOf(decisionCandidates);
  if (!coarseBest) {
    autoOpticsTuneSummary = `${formatExposureMs(exposure)} · global sweep produced no complete same-slot evidence`;
    return { iso: seed, probes, deferred: true, retryMs: AUTO_OPTICS_CONTROL_RETRY_MS };
  }

  for (const [candidate, label] of [
    [coarseBest.requestedIso / Math.SQRT2, "refine darker"],
    [coarseBest.requestedIso * Math.SQRT2, "refine brighter"]
  ]) {
    if (measured.size >= AUTO_OPTICS_GAIN_MAX_PROBES) break;
    const clamped = clampIso(candidate);
    if (Math.abs(clamped - coarseBest.requestedIso) <= Math.max(1, coarseBest.requestedIso * 0.03)) continue;
    await probe(clamped, label);
    if (!automaticOpticsSessionAlive(track)) return { iso: coarseBest.requestedIso, probes };
    if (invalidatedByMotion) return moved(coarseBest.requestedIso);
  }
  decisionCandidates = [
    baselineReference,
    ...probes.filter((item) => item?.valid && String(item.requestedIso) !== String(seed))
  ].filter((item) => item?.valid);
  const best = bestOf(decisionCandidates) ?? coarseBest;
  if (best.yieldRate < AUTO_OPTICS_COLLAPSE_YIELD) {
    autoOpticsTuneSummary = `cohort ${best.cohortSize || 0} · ${formatExposureMs(exposure)} · ${probes.map(describeAutoIsoProbe).join(" · ")} · all gain regions collapsed`;
    return { iso: best.requestedIso, probes, best, collapsed: true };
  }

  const bestQuality = quality(best);
  const nearBest = decisionCandidates.filter((item) =>
    quality(item) >= bestQuality - 0.025 &&
    item.yieldRate >= best.yieldRate - AUTO_OPTICS_NEAR_BEST_YIELD_DELTA &&
    tailFor(item) >= tailFor(best) - 0.08
  ).sort((a, b) => a.requestedIso - b.requestedIso);
  const selected = nearBest[0] ?? best;
  const selectedIsSeed = String(selected.requestedIso) === String(seed);
  const confirmed = selectedIsSeed
    ? baselineReference
    : await confirmCandidate(selected);
  if (!confirmed) {
    autoOpticsTuneSummary = `${formatExposureMs(exposure)} · global winner confirmation disagreed · retry`;
    return { iso: selected.requestedIso, probes, deferred: true, retryMs: AUTO_OPTICS_CONTROL_RETRY_MS };
  }

  const isHealthy = healthy(confirmed);
  const canReuse = reusable(confirmed);
  autoOpticsTuneSummary = `cohort ${confirmed.cohortSize || 0} · global ${formatExposureMs(exposure)} · ${probes.map(describeAutoIsoProbe).join(" · ")} → ISO ${Math.round(confirmed.iso)} · confirmed ${Math.round(confirmed.yieldRate * 100)}% p25 ${Math.round(tailFor(confirmed) * 100)}%`;
  if (!isHealthy) {
    return {
      iso: confirmed.iso,
      probes,
      best: confirmed,
      deferred: true,
      retryMs: AUTO_OPTICS_UNHEALTHY_RETRY_MS,
      deferredReason: `global sweep best ISO ${Math.round(confirmed.iso)} only ${Math.round(confirmed.yieldRate * 100)}% p25 ${Math.round(tailFor(confirmed) * 100)}% · temporary, not remembered`
    };
  }
  return { iso: confirmed.iso, probes, best: confirmed, healthy: true, reusable: canReuse };
}
'''
)

rep(
    'receive/main.js',
    '    const reusableWinner = tuned.best.yieldRate >= AUTO_OPTICS_MEMORY_MIN_YIELD;',
    '    const reusableWinner = tuned.reusable === true && tuned.best.yieldRate >= AUTO_OPTICS_MEMORY_MIN_YIELD;'
)
rep(
    'receive/main.js',
    '    focusController.adoptAutomaticCameraState("short-shutter automatic optics converged on a confirmed local decoder optimum");',
    '    focusController.adoptAutomaticCameraState("short-shutter automatic optics converged on a globally swept, independently confirmed decoder optimum");'
)

rep(
    'receive/main.js',
    '''      rememberAutomaticOptics(
        track,
        winner.exposure,
        winner.iso,
        p.perQrAttemptSuccessRate,
        p.perQrAttemptSuccessRate,
        aeBaseline.exposure * aeBaseline.iso
      );''',
    '''      // Acquisition race winners remain session evidence only. Durable
      // automatic-optics memory is written after the post-lock global sweep.'''
)

rep(
    'receive/main.js',
    '''  add(seed.exposure, seed.iso * Math.SQRT2, "brighter");
  add(seed.exposure, seed.iso * 2, "bright rescue");''',
    '''  add(seed.exposure, seed.iso * Math.SQRT2, "brighter");
  add(seed.exposure, seed.iso * 2, "bright rescue 2x");
  add(seed.exposure, seed.iso * 4, "bright rescue 4x");
  add(seed.exposure, seed.iso * 8, "bright rescue 8x");'''
)

Path('receive/.v294-ci-trigger').unlink(missing_ok=True)

main = Path('receive/main.js').read_text()
for needle in [
    'const RECEIVER_RUNTIME_BUILD = "v0.5.294";',
    'const AUTO_QR_EV_BIAS = 0;',
    'const AUTO_OPTICS_GAIN_MAX_PROBES = 8;',
    'airgapper:auto-optics-memory:v5',
    'autoOpticsProbe: Boolean(autoOpticsMeasurementSlots?.size)',
    'Global log-space sweep',
    'sweep 4x',
    'AUTO_OPTICS_HEALTHY_YIELD',
    'globally swept, independently confirmed decoder optimum'
]:
    if needle not in main:
        raise SystemExit(f'missing v294 invariant: {needle}')
