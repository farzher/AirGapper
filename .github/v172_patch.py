from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"missing anchor in {path}: {old[:180]!r}")
    p.write_text(s.replace(old, new, 1))


replace_once("index.html", "v0.5.171", "v0.5.172")
replace_once("main.js", 'const APP_BUILD = "v0.5.171";', 'const APP_BUILD = "v0.5.172";')
replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.171";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.172";')
replace_once("sw.js", 'airgapper-static-js-v133', 'airgapper-static-js-v134')

p = Path("receive/main.js")
s = p.read_text()

for old, new in {
    'const AUTO_OPTICS_ACQUISITION_RESCUE_MS = 1600;': 'const AUTO_OPTICS_ACQUISITION_RESCUE_MS = 2500;',
    'const AUTO_OPTICS_RESCUE_RETRY_MS = 5000;': 'const AUTO_OPTICS_RESCUE_RETRY_MS = 7000;',
    'const PORTFOLIO_MIN_FRACTION = 0.5;': 'const PORTFOLIO_MIN_FRACTION = 0.6;',
    'const PORTFOLIO_EVAL_MS = 2200;': 'const PORTFOLIO_EVAL_MS = 2400;',
    'const PORTFOLIO_KEEP_SHRINK_RATIO = 1.01;': 'const PORTFOLIO_KEEP_SHRINK_RATIO = 1.04;',
    'const PORTFOLIO_KEEP_GROW_RATIO = 0.99;': 'const PORTFOLIO_KEEP_GROW_RATIO = 0.985;',
}.items():
    if old not in s:
        raise SystemExit(f"missing constant {old}")
    s = s.replace(old, new, 1)

old = '''const PORTFOLIO_SHRINK_STEP = 1;\nconst PORTFOLIO_EXPLORE_EVERY = 10;'''
new = '''const PORTFOLIO_SHRINK_STEP = 1;\nconst PORTFOLIO_GROW_STEP = 2;\nconst PORTFOLIO_EXPLORE_EVERY = 10;'''
if old not in s:
    raise SystemExit("portfolio grow constant anchor missing")
s = s.replace(old, new, 1)

old = '''  captureRate: 0,\n  scheduleRate: 0,\n  utilization: 0,'''
new = '''  captureRate: 0,\n  demandRate: 0,\n  sourceRate: 0,\n  sourceFramesTotal: 0,\n  sourceFramesAt: 0,\n  scheduleRate: 0,\n  utilization: 0,'''
if old not in s:
    raise SystemExit("portfolio state anchor missing")
s = s.replace(old, new, 1)

old = '''    excludedSlots: [], exploreSlot: void 0, uniqueRate: 0, captureRate: 0,\n    scheduleRate: 0, utilization: 0, busyRate: 0, pressure: false\n'''
new = '''    excludedSlots: [], exploreSlot: void 0, uniqueRate: 0, captureRate: 0, demandRate: 0,\n    sourceRate: 0, sourceFramesTotal: 0, sourceFramesAt: 0, scheduleRate: 0,\n    utilization: 0, busyRate: 0, pressure: false\n'''
if old not in s:
    raise SystemExit("portfolio reset anchor missing")
s = s.replace(old, new, 1)

old = '''function portfolioLoadSnapshot(now) {\n  const captureRate = portfolioEventRate(captureTimes, now);\n  const scheduleRate = portfolioEventRate(decodeFrameTimes, now);\n  const uniqueRate = portfolioEventRate(uniqueQrTimes, now);\n  const busyRate = portfolioEventRate(poolBusyTimes, now);\n  const cutoff = now - PORTFOLIO_EVAL_MS;\n  let utilization = 0;\n  let samples = 0;\n  for (let index = workerLoadSamples.length - 1; index >= 0; index--) {\n    const sample = workerLoadSamples[index];\n    if (sample.at <= cutoff) break;\n    if (!sample.size) continue;\n    utilization += sample.busy / sample.size;\n    samples++;\n  }\n  utilization = samples ? utilization / samples : pool.size ? pool.busyCount / pool.size : 0;\n  const coverage = captureRate > 0 ? scheduleRate / captureRate : 1;\n  // Throughput-first pressure: worker-busy events are harmless when we are\n  // still consuming nearly every camera frame. Only shrink the QR portfolio\n  // when saturation is causing real schedule loss. This prevents the controller\n  // from trading useful QR opportunities merely to make worker occupancy pretty.\n  const overloaded = utilization >= PORTFOLIO_PRESSURE_UTIL || busyRate >= 2;\n  const pressure = captureRate >= 12 && (\n    coverage < PORTFOLIO_PRESSURE_COVERAGE && overloaded ||\n    coverage < 0.97 && utilization >= 0.95\n  );\n  const headroom = captureRate >= 12 && coverage >= 0.94 && utilization <= PORTFOLIO_HEADROOM_UTIL;\n  return { captureRate, scheduleRate, uniqueRate, busyRate, utilization, coverage, pressure, headroom };\n}\n'''
new = '''function portfolioSourceDemandRate(now, captureRate) {\n  const total = Number(frameTrackProcessor?.totalFrames);\n  if (Number.isFinite(total) && total >= 0) {\n    if (decodePortfolio.sourceFramesAt > 0 && total >= decodePortfolio.sourceFramesTotal) {\n      const elapsed = now - decodePortfolio.sourceFramesAt;\n      if (elapsed >= 20) {\n        const instant = (total - decodePortfolio.sourceFramesTotal) / (elapsed / 1e3);\n        if (instant >= 1 && instant <= 240) {\n          decodePortfolio.sourceRate = decodePortfolio.sourceRate\n            ? decodePortfolio.sourceRate * 0.72 + instant * 0.28\n            : instant;\n        }\n      }\n    }\n    decodePortfolio.sourceFramesTotal = total;\n    decodePortfolio.sourceFramesAt = now;\n  }\n  if (decodePortfolio.sourceRate > 0) return Math.max(captureRate, decodePortfolio.sourceRate);\n  const nominal = Number(stream?.getVideoTracks?.()[0]?.getSettings?.().frameRate);\n  return Math.max(captureRate, Number.isFinite(nominal) ? nominal : 0);\n}\nfunction portfolioLoadSnapshot(now) {\n  const captureRate = portfolioEventRate(captureTimes, now);\n  const demandRate = portfolioSourceDemandRate(now, captureRate);\n  const scheduleRate = portfolioEventRate(decodeFrameTimes, now);\n  const uniqueRate = portfolioEventRate(uniqueQrTimes, now);\n  const busyRate = portfolioEventRate(poolBusyTimes, now);\n  const cutoff = now - PORTFOLIO_EVAL_MS;\n  let utilization = 0;\n  let samples = 0;\n  for (let index = workerLoadSamples.length - 1; index >= 0; index--) {\n    const sample = workerLoadSamples[index];\n    if (sample.at <= cutoff) break;\n    if (!sample.size) continue;\n    utilization += sample.busy / sample.size;\n    samples++;\n  }\n  utilization = samples ? utilization / samples : pool.size ? pool.busyCount / pool.size : 0;\n  // TrackProcessor may discard frames before the JS capture callback when the\n  // receiver is overloaded. Those are exactly the erasures this controller is\n  // supposed to recover, so compare scheduling against source demand, not only\n  // against frames that survived downstream backpressure.\n  const coverage = demandRate > 0 ? scheduleRate / demandRate : 1;\n  const overloaded = utilization >= PORTFOLIO_PRESSURE_UTIL || busyRate >= 2;\n  const pressure = demandRate >= 12 && (\n    coverage < PORTFOLIO_PRESSURE_COVERAGE && overloaded ||\n    coverage < 0.97 && utilization >= 0.95\n  );\n  const headroom = demandRate >= 12 && coverage >= 0.94 && utilization <= PORTFOLIO_HEADROOM_UTIL;\n  return { captureRate, demandRate, scheduleRate, uniqueRate, busyRate, utilization, coverage, pressure, headroom };\n}\n'''
if old not in s:
    raise SystemExit("portfolio load function anchor missing")
s = s.replace(old, new, 1)

old = '''  decodePortfolio.uniqueRate = metrics.uniqueRate;\n  decodePortfolio.captureRate = metrics.captureRate;\n  decodePortfolio.scheduleRate = metrics.scheduleRate;'''
new = '''  decodePortfolio.uniqueRate = metrics.uniqueRate;\n  decodePortfolio.captureRate = metrics.captureRate;\n  decodePortfolio.demandRate = metrics.demandRate;\n  decodePortfolio.scheduleRate = metrics.scheduleRate;'''
if old not in s:
    raise SystemExit("portfolio metrics assignment anchor missing")
s = s.replace(old, new, 1)

old = '''  const opticsStable = !autoOpticsMutationRunning && !decoderFreshnessHoldActive &&\n    !["tuning", "fine", "rescue", "settling"].includes(autoOpticsRuntimeState);\n  if (!opticsStable || !portfolioLearnedEnough(candidates)) {\n    decodePortfolio.mode = opticsStable ? "learning" : "hold-optics";\n    return decodePortfolio.budget;\n  }\n'''
new = '''  const opticsStable = !autoOpticsMutationRunning && !decoderFreshnessHoldActive &&\n    !["tuning", "fine", "rescue", "settling"].includes(autoOpticsRuntimeState);\n  if (!opticsStable) {\n    // An exposure/ISO mutation changes both slot yield and decoder cost. Any\n    // portfolio comparison spanning that boundary is invalid. Reopen the wall\n    // immediately so the new optics gets fresh evidence instead of inheriting\n    // an old low-K decision and taking many seconds to grow back.\n    decodePortfolio.budget = maxSlots;\n    decodePortfolio.probe = null;\n    decodePortfolio.lowerBlockedUntil = 0;\n    decodePortfolio.upperBlockedUntil = 0;\n    decodePortfolio.lastDecisionAt = now;\n    decodePortfolio.mode = "hold-optics";\n    return maxSlots;\n  }\n  if (!portfolioLearnedEnough(candidates)) {\n    decodePortfolio.mode = "learning";\n    return decodePortfolio.budget;\n  }\n'''
if old not in s:
    raise SystemExit("portfolio optics anchor missing")
s = s.replace(old, new, 1)

old = '''    const baseline = probe.baseline;\n    const captureComparable = baseline.captureRate < 8 || metrics.captureRate < 8 ||\n      Math.abs(metrics.captureRate - baseline.captureRate) / Math.max(1, baseline.captureRate) <= 0.18;\n    if (!captureComparable) {'''
new = '''    const baseline = probe.baseline;\n    const captureComparable = baseline.demandRate < 8 || metrics.demandRate < 8 ||\n      Math.abs(metrics.demandRate - baseline.demandRate) / Math.max(1, baseline.demandRate) <= 0.18;\n    if (!captureComparable) {'''
if old not in s:
    raise SystemExit("portfolio comparable anchor missing")
s = s.replace(old, new, 1)

old = '''    } else {\n      decodePortfolio.budget = Math.max(minSlots, Math.min(maxSlots, probe.originBudget));\n      if (probe.direction < 0) decodePortfolio.lowerBlockedUntil = now + PORTFOLIO_RETRY_MS;\n      else decodePortfolio.upperBlockedUntil = now + PORTFOLIO_RETRY_MS;\n      decodePortfolio.mode = "restore";\n    }'''
new = '''    } else {\n      // A failed shrink is evidence that the lower-K chain was too aggressive;\n      // return to the full opportunity set instead of crawling upward one slot\n      // every few seconds. A failed grow only returns to its known-good origin.\n      decodePortfolio.budget = probe.direction < 0\n        ? maxSlots\n        : Math.max(minSlots, Math.min(maxSlots, probe.originBudget));\n      if (probe.direction < 0) decodePortfolio.lowerBlockedUntil = now + PORTFOLIO_RETRY_MS;\n      else decodePortfolio.upperBlockedUntil = now + PORTFOLIO_RETRY_MS;\n      decodePortfolio.mode = "restore";\n    }'''
if old not in s:
    raise SystemExit("portfolio restore anchor missing")
s = s.replace(old, new, 1)

old = '''  } else if (metrics.headroom && decodePortfolio.budget < maxSlots && now >= decodePortfolio.upperBlockedUntil) {\n    beginDecodePortfolioProbe(1, Math.min(maxSlots, decodePortfolio.budget + 1), metrics, now);'''
new = '''  } else if (metrics.headroom && decodePortfolio.budget < maxSlots && now >= decodePortfolio.upperBlockedUntil) {\n    beginDecodePortfolioProbe(1, Math.min(maxSlots, decodePortfolio.budget + PORTFOLIO_GROW_STEP), metrics, now);'''
if old not in s:
    raise SystemExit("portfolio grow anchor missing")
s = s.replace(old, new, 1)

old = '''  return `Portfolio ${decodePortfolio.budget}/${decodePortfolio.maxSlots} · ${decodePortfolio.mode}${decodePortfolio.pressure ? " · CPU pressure" : ""} · ${(decodePortfolio.scheduleRate).toFixed(1)}/${(decodePortfolio.captureRate).toFixed(1)} fps · ${(decodePortfolio.utilization * 100).toFixed(0)}% busy${explore}${skipped}`;'''
new = '''  const delivered = decodePortfolio.captureRate + 0.5 < decodePortfolio.demandRate\n    ? ` · delivered ${decodePortfolio.captureRate.toFixed(1)}`\n    : "";\n  return `Portfolio ${decodePortfolio.budget}/${decodePortfolio.maxSlots} · ${decodePortfolio.mode}${decodePortfolio.pressure ? " · CPU pressure" : ""} · ${decodePortfolio.scheduleRate.toFixed(1)}/${decodePortfolio.demandRate.toFixed(1)} fps${delivered} · ${(decodePortfolio.utilization * 100).toFixed(0)}% busy${explore}${skipped}`;'''
if old not in s:
    raise SystemExit("portfolio summary anchor missing")
s = s.replace(old, new, 1)

start = s.find('async function rescueAutomaticQrAcquisition(track, now) {')
end = s.find('\nfunction maintainAutomaticQrOptics(now) {', start)
if start < 0 or end < 0:
    raise SystemExit("acquisition rescue function bounds missing")
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
  const motionSafeExposure = 1e4 / fps * AUTO_OPTICS_SHUTTER_FRAME_FRACTION;
  // Hardware AE is the best cold-start brightness estimator. If it already has
  // a motion-safe shutter, do not replace it merely because generic QR search
  // has not seeded yet. The old four-ISO sweep could monopolize the sensor for
  // ~4 seconds and then retry, producing the observed 10-second startup holes.
  if (settings.exposureTime <= motionSafeExposure * 1.05) {
    autoOpticsRescueRetryAt = now + AUTO_OPTICS_RESCUE_RETRY_MS;
    autoOpticsTuneSummary = "cold AE · motion-safe; rescue deferred";
    return;
  }

  const exposureProduct = settings.exposureTime * settings.iso;
  const exposure = quantizeCameraRange(Math.min(settings.exposureTime, motionSafeExposure), exposureRange);
  const requiredIso = exposureProduct / Math.max(exposureRange.min, exposure);
  // If preserving AE brightness at a sharp shutter is impossible, leave AE in
  // charge rather than deliberately testing a badly underexposed frame.
  if (requiredIso > isoRange.max * 1.03) {
    autoOpticsRescueRetryAt = now + AUTO_OPTICS_RESCUE_RETRY_MS;
    autoOpticsTuneSummary = "cold AE · sharp shutter needs too much ISO";
    return;
  }
  const iso = quantizeCameraRange(requiredIso, isoRange);

  autoOpticsMutationRunning = true;
  autoOpticsRuntimeState = "rescue";
  notePipelineEvent("auto-optics-acquisition-motion-clamp");
  try {
    autoOpticsTuneSummary = `cold AE motion clamp · ${formatExposureMs(exposure)} · ISO ${Math.round(iso)}`;
    const accepted = await applyCameraConstraint(track, {
      exposureMode: "manual",
      exposureTime: exposure,
      iso
    });
    if (!accepted || !automaticOpticsSessionAlive(track)) return;
    if (!await waitForAutoOptics(AUTO_OPTICS_RESCUE_SETTLE_MS, track)) return;
    const evidenceStart = receiverNow();
    if (!await waitForAutoOptics(AUTO_OPTICS_RESCUE_SAMPLE_MS, track)) return;
    const freshDecodes = qrReadTimes.reduce((count, at) => count + Number(at >= evidenceStart), 0);
    if (gridLattice.locked || freshDecodes >= 2) {
      autoOpticsRuntimeState = "ae";
      autoOpticsLockSince = 0;
      autoOpticsAcquisitionSince = receiverNow();
      autoOpticsRescueRetryAt = receiverNow() + AUTO_OPTICS_RESCUE_RETRY_MS;
      autoOpticsTuneSummary = `cold motion clamp found QR · ${formatExposureMs(exposure)} · ISO ${Math.round(iso)}`;
      return;
    }
    await applyExposureSetting(track);
    autoOpticsRuntimeState = "ae";
    autoOpticsLockSince = 0;
    autoOpticsAcquisitionSince = receiverNow();
    autoOpticsRescueRetryAt = receiverNow() + AUTO_OPTICS_RESCUE_RETRY_MS;
    autoOpticsTuneSummary = "cold motion clamp missed · hardware AE restored";
  } finally {
    autoOpticsMutationRunning = false;
  }
}
'''
s = s[:start] + new_rescue + s[end:]
p.write_text(s)
