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
rep('receive/main.js', 'const RECEIVER_RUNTIME_BUILD = "v0.5.290";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.291";')
rep('send/main.js', 'const SEND_RUNTIME_BUILD = "v0.5.290";', 'const SEND_RUNTIME_BUILD = "v0.5.291";')
rep('main.js', 'const APP_BUILD = "v0.5.290";', 'const APP_BUILD = "v0.5.291";')
rep('index.html', 'main.js?build=v0.5.290', 'main.js?build=v0.5.291')
rep('index.html', '<span class="brand">AirGapper <span class="app-version">v0.5.290</span></span>', '<span class="brand">AirGapper <span class="app-version">v0.5.291</span></span>')
rep('sw.js', 'airgapper-static-js-v238', 'airgapper-static-js-v239')

# v290 treated low decoder yield as proof of underexposure.  On dense/tiny QR
# geometry that is false: geometry/sampling can cap yield while brightness is
# already excessive.  Search both sides of the current short-shutter seed, then
# take at most one directional boundary step if the neighboring evidence really
# improves.  Also stop allowing the gain search to exceed roughly 2x the
# deliberately-dark (-0.8 EV) seed product.
rep('receive/main.js', 'const AUTO_OPTICS_GAIN_IMPROVEMENT = 1.03;', 'const AUTO_OPTICS_GAIN_IMPROVEMENT = 1.08;')
rep('receive/main.js', 'const AUTO_OPTICS_MEMORY_MIN_YIELD = 0.35;', 'const AUTO_OPTICS_MEMORY_MIN_YIELD = 0.15;')
rep('receive/main.js', 'const AUTO_OPTICS_TARGET_YIELD = 0.78;\nconst AUTO_OPTICS_NEAR_BEST_SCORE = 0.94;', 'const AUTO_OPTICS_GAIN_DIRECTION_YIELD_DELTA = 0.025;\nconst AUTO_OPTICS_GAIN_MAX_BASE_RATIO = 2.0;\nconst AUTO_OPTICS_NEAR_BEST_SCORE = 0.94;')
rep('receive/main.js', 'const AUTO_OPTICS_AE_PRODUCT_CEILING = 1.50;', 'const AUTO_OPTICS_AE_PRODUCT_CEILING = 1.15;')

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

  // Do not infer brightness direction from an absolute decode-yield target.
  // Dense/tiny-module geometry can depress yield even when the sensor is already
  // too bright.  Always sample one darker and one brighter neighbor first.
  const baseline = await probe(base, remembered !== void 0 ? "memory seed" : "seed");
  if (!automaticOpticsSessionAlive(track)) return { iso: base, probes };
  if (invalidatedByMotion) return { iso: base, probes, deferred: true };

  await probe(base / Math.SQRT2, "darker");
  if (!automaticOpticsSessionAlive(track)) return { iso: base, probes };
  if (invalidatedByMotion) return { iso: base, probes, deferred: true };

  await probe(Math.min(cap, base * Math.SQRT2), "brighter");
  if (!automaticOpticsSessionAlive(track)) return { iso: base, probes };
  if (invalidatedByMotion) return { iso: base, probes, deferred: true };

  const localValid = probes.filter((item) => item.valid);
  const localBest = localValid.reduce((winner, item) =>
    !winner || item.score > winner.score || item.score === winner.score && item.yieldRate > winner.yieldRate ? item : winner, null);
  if (measured.size < AUTO_OPTICS_GAIN_MAX_PROBES && localBest && materiallyBetter(localBest, baseline)) {
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

  // A candidate cannot become persistent memory from one lucky display phase.
  // Confirm it independently after another camera-write boundary.  If framing
  // moves or the repeated yield is materially worse, abandon the comparison.
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
'''
)

# A 31% independently-confirmed profile from the user's hardware is a valid
# acquisition seed even though it is not a globally "robust" 78% sample.  The
# old 35% gate meant v290 held such a winner for the session but never persisted
# it.  Mark new entries as independently confirmed; retain the old 35% bar for
# legacy/history records that did not go through this confirmation path.
rep('receive/main.js', '''function automaticOpticsMemoryHealthy(saved) {
  return Boolean(saved && Number(saved.yieldRate) >= AUTO_OPTICS_MEMORY_MIN_YIELD &&
    Number.isFinite(saved.exposure) && saved.exposure > 0 && Number.isFinite(saved.iso) && saved.iso > 0);
}''', '''function automaticOpticsMemoryHealthy(saved) {
  const minimumYield = saved?.confirmed === true ? AUTO_OPTICS_MEMORY_MIN_YIELD : 0.35;
  return Boolean(saved && Number(saved.yieldRate) >= minimumYield &&
    Number.isFinite(saved.exposure) && saved.exposure > 0 && Number.isFinite(saved.iso) && saved.iso > 0);
}''')

rep('receive/main.js', '''      score: Number.isFinite(score) ? score : 0,
      yieldRate: Number.isFinite(yieldRate) ? yieldRate : 0,
      ...(Number.isFinite(lightScale) ? { lightScale } : {}),
      at: Date.now()''', '''      score: Number.isFinite(score) ? score : 0,
      yieldRate: Number.isFinite(yieldRate) ? yieldRate : 0,
      confirmed: true,
      controller: 291,
      ...(Number.isFinite(lightScale) ? { lightScale } : {}),
      at: Date.now()''')

rep('receive/main.js', '''    if (tuned.best.yieldRate >= AUTO_OPTICS_MEMORY_MIN_YIELD)
      rememberAutomaticOptics(track, tunedExposure, tunedIso, tuned.best.score, tuned.best.yieldRate, aeExposureProduct);
    autoOpticsAeBaseline = void 0;
    focusController.adoptAutomaticCameraState("short-shutter automatic optics converged on the darkest robust gain");
    notePipelineEvent("auto-optics-converged", Math.round(tuned.best.yieldRate * 100));''', '''    const reusableWinner = tuned.best.yieldRate >= AUTO_OPTICS_MEMORY_MIN_YIELD;
    if (reusableWinner)
      rememberAutomaticOptics(track, tunedExposure, tunedIso, tuned.best.score, tuned.best.yieldRate, aeExposureProduct);
    autoOpticsTuneSummary += reusableWinner ? " · remembered" : " · transient";
    autoOpticsAeBaseline = void 0;
    focusController.adoptAutomaticCameraState("short-shutter automatic optics converged on a confirmed local decoder optimum");
    notePipelineEvent("auto-optics-converged", Math.round(tuned.best.yieldRate * 100));''')

# Acquisition rescue should try a sharper exposure before escalating gain.  It
# still retains brighter/low-light escape candidates for genuinely dark scenes.
rep('receive/main.js', '''  for (const item of readAutomaticOpticsHistory(track).slice(0, 2))
    add(item.exposure, item.iso, "learned");
  const memory = usableAutomaticOpticsMemory(track);
  if (memory) add(memory.exposure, memory.iso, "recent winner");
  add(seed.exposure, seed.iso / Math.SQRT2, "darker");
  add(seed.exposure, seed.iso * Math.SQRT2, "brighter");
  add(seed.exposure, seed.iso * 2, "bright rescue");
  const fasterExposure = quantizeCameraRange(Math.max(exposureRange.min, seed.exposure / Math.SQRT2), exposureRange);
  add(fasterExposure, seed.targetProduct / Math.max(exposureRange.min, fasterExposure), "faster");''', '''  const memory = usableAutomaticOpticsMemory(track);
  if (memory) add(memory.exposure, memory.iso, "recent winner");
  for (const item of readAutomaticOpticsHistory(track).slice(0, 2))
    add(item.exposure, item.iso, "learned");
  add(seed.exposure, seed.iso / Math.SQRT2, "darker");
  const fasterExposure = quantizeCameraRange(Math.max(exposureRange.min, seed.exposure / Math.SQRT2), exposureRange);
  add(fasterExposure, seed.targetProduct / Math.max(exposureRange.min, fasterExposure), "faster");
  add(seed.exposure, seed.iso * Math.SQRT2, "brighter");
  add(seed.exposure, seed.iso * 2, "bright rescue");''')

main = Path('receive/main.js').read_text()
for needle in [
    'const RECEIVER_RUNTIME_BUILD = "v0.5.291";',
    'const AUTO_OPTICS_MEMORY_MIN_YIELD = 0.15;',
    'const AUTO_OPTICS_AE_PRODUCT_CEILING = 1.15;',
    'Always sample one darker and one brighter neighbor first.',
    'confirmed: true,',
    'controller: 291,',
    '· remembered',
    'converged on a confirmed local decoder optimum'
]:
    if needle not in main:
        raise SystemExit(f'missing v291 invariant: {needle}')

if 'AUTO_OPTICS_TARGET_YIELD' in main:
    raise SystemExit('v291 still contains the absolute-yield brightness-direction rule')
