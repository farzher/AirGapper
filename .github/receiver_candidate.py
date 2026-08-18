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
rep('receive/main.js', 'const RECEIVER_RUNTIME_BUILD = "v0.5.291";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.292";')
rep('send/main.js', 'const SEND_RUNTIME_BUILD = "v0.5.291";', 'const SEND_RUNTIME_BUILD = "v0.5.292";')
rep('main.js', 'const APP_BUILD = "v0.5.291";', 'const APP_BUILD = "v0.5.292";')
rep('index.html', 'main.js?build=v0.5.291', 'main.js?build=v0.5.292')
rep('index.html', '<span class="brand">AirGapper <span class="app-version">v0.5.291</span></span>', '<span class="brand">AirGapper <span class="app-version">v0.5.292</span></span>')
rep('sw.js', 'airgapper-static-js-v239', 'airgapper-static-js-v240')

# v291 correctly searched both brightness directions, but it still compared them
# sequentially while the lattice/Guided tracker was maturing.  That creates a
# monotonic time bias: later candidates inherit better geometry and appear to
# decode better even when the camera setting is not responsible.  Give TRACK a
# little longer to settle, collect more attempts per sample, and require a
# repeated base-setting control to remain stable across the candidate bracket.
rep('receive/main.js', 'const AUTO_OPTICS_LOCK_SETTLE_MS = 450;', 'const AUTO_OPTICS_LOCK_SETTLE_MS = 1200;')
rep('receive/main.js', 'const AUTO_OPTICS_GAIN_SAMPLE_MS = 360;', 'const AUTO_OPTICS_GAIN_SAMPLE_MS = 520;')
rep('receive/main.js', 'const AUTO_OPTICS_GAIN_MIN_ATTEMPTS = 10;', 'const AUTO_OPTICS_GAIN_MIN_ATTEMPTS = 20;')
rep(
    'receive/main.js',
    'const AUTO_OPTICS_GAIN_DIRECTION_YIELD_DELTA = 0.025;\nconst AUTO_OPTICS_GAIN_MAX_BASE_RATIO = 2.0;',
    'const AUTO_OPTICS_GAIN_DIRECTION_YIELD_DELTA = 0.025;\nconst AUTO_OPTICS_GAIN_MAX_BASE_RATIO = 2.0;\nconst AUTO_OPTICS_CONTROL_MAX_YIELD_DRIFT = 0.08;\nconst AUTO_OPTICS_CONTROL_MIN_SCORE_RATIO = 0.72;\nconst AUTO_OPTICS_CONTROL_RETRY_MS = 850;'
)

# v291 memory/history can contain winners selected under the temporal bias above.
# Do not cold-start from those entries.  v292 will learn once under the controlled
# bracket and subsequent reloads can then reuse that result immediately.
rep('receive/main.js', 'const AUTO_OPTICS_HISTORY_KEY = "airgapper:auto-optics-learning:v2";', 'const AUTO_OPTICS_HISTORY_KEY = "airgapper:auto-optics-learning:v3";')
rep('receive/main.js', 'const AUTO_OPTICS_MEMORY_KEY = "airgapper:auto-optics-memory:v2";', 'const AUTO_OPTICS_MEMORY_KEY = "airgapper:auto-optics-memory:v3";')

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
    autoOpticsTuneSummary = `${formatExposureMs(exposure)} · ${label} ISO ${Math.round(requested)}`;
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
  const combine = (a, b) => {
    if (!a?.valid) return b;
    if (!b?.valid) return a;
    const outputs = a.outputs + b.outputs;
    const attempts = a.attempts + b.attempts;
    const jobs = a.jobs + b.jobs;
    return {
      ...b,
      requestedIso: a.requestedIso,
      outputs,
      attempts,
      jobs,
      yieldRate: attempts ? outputs / attempts : 0,
      rate: (a.rate + b.rate) / 2,
      score: autoOpticsConfidenceScore(outputs, attempts),
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

  // Bracket the local search with the same base setting.  If the base improves
  // or degrades materially while we were testing neighbors, the decoder/tracker
  // changed underneath the experiment.  Throw the whole comparison away rather
  // than attributing that time trend to ISO.
  const baseline = await probe(base, remembered !== void 0 ? "memory seed" : "seed");
  if (!automaticOpticsSessionAlive(track)) return { iso: base, probes };
  if (invalidatedByMotion) return { iso: base, probes, deferred: true };

  const darker = await probe(base / Math.SQRT2, "darker");
  if (!automaticOpticsSessionAlive(track)) return { iso: base, probes };
  if (invalidatedByMotion) return { iso: base, probes, deferred: true };

  const brighter = await probe(Math.min(cap, base * Math.SQRT2), "brighter");
  if (!automaticOpticsSessionAlive(track)) return { iso: base, probes };
  if (invalidatedByMotion) return { iso: base, probes, deferred: true };

  const control = await probe(base, "control", { confirm: true, sampleMs: AUTO_OPTICS_GAIN_SAMPLE_MS });
  if (!automaticOpticsSessionAlive(track)) return { iso: base, probes };
  if (!control || control.unstable || !control.valid || invalidatedByMotion) {
    autoOpticsTuneSummary = `${formatExposureMs(exposure)} · control invalidated · retry after TRACK settles`;
    return {
      iso: base,
      probes,
      deferred: true,
      retryMs: AUTO_OPTICS_CONTROL_RETRY_MS,
      deferredReason: "comparison control invalidated · holding short shutter until TRACK settles"
    };
  }
  if (baseline?.valid && !controlStable(baseline, control)) {
    const drift = Math.abs(baseline.yieldRate - control.yieldRate);
    autoOpticsTuneSummary = `${formatExposureMs(exposure)} · base ${Math.round(baseline.yieldRate * 100)}→${Math.round(control.yieldRate * 100)}% · tracker still maturing`;
    return {
      iso: base,
      probes,
      deferred: true,
      retryMs: AUTO_OPTICS_CONTROL_RETRY_MS,
      deferredReason: `base control drifted ${(drift * 100).toFixed(0)} points · holding short shutter until TRACK settles`
    };
  }

  const baselineReference = combine(baseline, control);
  const localValid = [baselineReference, darker, brighter].filter((item) => item?.valid);
  const localBest = localValid.reduce((winner, item) =>
    !winner || item.score > winner.score || item.score === winner.score && item.yieldRate > winner.yieldRate ? item : winner, null);

  // Only spend the fourth exploratory write when a neighbor actually beat the
  // time-controlled base.  Boundary candidates are therefore adjacent in time
  // to the control sample instead of being rewarded merely for occurring later.
  if (measured.size < AUTO_OPTICS_GAIN_MAX_PROBES && localBest && materiallyBetter(localBest, baselineReference)) {
    if (localBest.requestedIso < base * 0.99) {
      await probe(localBest.requestedIso / Math.SQRT2, "darker boundary");
    } else if (localBest.requestedIso > base * 1.01) {
      const brightLimit = Math.min(cap, base * AUTO_OPTICS_GAIN_MAX_BASE_RATIO);
      const nextIso = Math.min(brightLimit, localBest.requestedIso * Math.SQRT2);
      if (nextIso > localBest.requestedIso * 1.01)
        await probe(nextIso, "brighter boundary");
    }
  }
  if (!automaticOpticsSessionAlive(track)) return { iso: base, probes };
  if (invalidatedByMotion) return { iso: base, probes, deferred: true };

  const decisionCandidates = [
    baselineReference,
    ...probes.filter((item) => item?.valid && String(item.requestedIso) !== String(base))
  ].filter((item) => item?.valid);
  if (!decisionCandidates.length) {
    autoOpticsTuneSummary = `${formatExposureMs(exposure)} · ${probes.map(describeAutoIsoProbe).join(" · ")} · insufficient`;
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

  // The end control is already an independent second application of the base.
  // Reuse it when base wins; otherwise independently reapply/confirm the selected
  // neighbor after the control boundary.
  const selectedIsBase = String(selected.requestedIso) === String(base);
  const confirm = selectedIsBase
    ? control
    : await probe(selected.requestedIso, "confirm", { confirm: true, sampleMs: 520 });
  if (!confirm || confirm.unstable || !confirm.valid) {
    return { iso: selected.requestedIso, probes, deferred: true };
  }
  if (!selectedIsBase && (confirm.yieldRate < Math.max(AUTO_OPTICS_COLLAPSE_YIELD, selected.yieldRate - 0.12) ||
      confirm.score < selected.score * 0.80)) {
    autoOpticsTuneSummary = `${formatExposureMs(exposure)} · confirmation disagreed · retry later`;
    return { iso: selected.requestedIso, probes, deferred: true };
  }
  const confirmed = selectedIsBase
    ? baselineReference
    : combine(selected, confirm);
  autoOpticsTuneSummary = `${formatExposureMs(exposure)} · ${probes.map(describeAutoIsoProbe).join(" · ")} · control ${Math.round(control.yieldRate * 100)}% → ISO ${Math.round(confirm.iso)} · confirmed ${Math.round(confirmed.yieldRate * 100)}%`;
  return { iso: confirm.iso, probes, best: confirmed };
}
'''
)

# Preserve the real reason a comparison was deferred.  v291 overwrote every
# deferred result with "movement", hiding tracker-maturity invalidations.
rep(
    'receive/main.js',
    '''    if (tuned.deferred) {
      autoOpticsRuntimeState = "ae";
      autoOpticsLockSince = 0;
      autoOpticsRetryAt = receiverNow() + 350;
      autoOpticsTuneSummary = "comparison invalidated by movement · holding short shutter";
      focusController.adoptAutomaticCameraState("automatic optics comparison deferred; current short-shutter setting held until framing stabilizes");
      return;
    }''',
    '''    if (tuned.deferred) {
      autoOpticsRuntimeState = "ae";
      autoOpticsLockSince = 0;
      autoOpticsRetryAt = receiverNow() + Math.max(350, Number(tuned.retryMs) || 0);
      autoOpticsTuneSummary = tuned.deferredReason || "comparison invalidated by movement · holding short shutter";
      focusController.adoptAutomaticCameraState(tuned.deferredReason
        ? "automatic optics comparison deferred because decoder geometry changed during the control bracket"
        : "automatic optics comparison deferred; current short-shutter setting held until framing stabilizes");
      return;
    }'''
)

main = Path('receive/main.js').read_text()
for needle in [
    'const RECEIVER_RUNTIME_BUILD = "v0.5.292";',
    'AUTO_OPTICS_CONTROL_MAX_YIELD_DRIFT = 0.08',
    'airgapper:auto-optics-memory:v3',
    'tracker still maturing',
    'control invalidated',
    'decisionCandidates'
]:
    if needle not in main:
        raise SystemExit(f'missing v292 invariant: {needle}')
