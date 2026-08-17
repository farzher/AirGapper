from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"missing anchor in {path}: {old[:180]!r}")
    p.write_text(s.replace(old, new, 1))


replace_once("index.html", "v0.5.172", "v0.5.173")
replace_once("main.js", 'const APP_BUILD = "v0.5.172";', 'const APP_BUILD = "v0.5.173";')
replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.172";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.173";')
replace_once("sw.js", 'airgapper-static-js-v134', 'airgapper-static-js-v135')

p = Path("receive/main.js")
s = p.read_text()

old = '''const PORTFOLIO_EVAL_MS = 2400;\nconst PORTFOLIO_DECISION_COOLDOWN_MS = 800;'''
new = '''const PORTFOLIO_EVAL_MS = 2400;\nconst PORTFOLIO_POST_OPTICS_CLEAN_MS = PORTFOLIO_EVAL_MS;\nconst PORTFOLIO_DECISION_COOLDOWN_MS = 800;'''
if old not in s:
    raise SystemExit("portfolio clean constant anchor missing")
s = s.replace(old, new, 1)

old = '''  sourceFramesAt: 0,\n  scheduleRate: 0,'''
new = '''  sourceFramesAt: 0,\n  cleanAfter: 0,\n  scheduleRate: 0,'''
if old not in s:
    raise SystemExit("portfolio state cleanAfter anchor missing")
s = s.replace(old, new, 1)

old = '''    sourceRate: 0, sourceFramesTotal: 0, sourceFramesAt: 0, scheduleRate: 0,\n    utilization: 0, busyRate: 0, pressure: false\n'''
new = '''    sourceRate: 0, sourceFramesTotal: 0, sourceFramesAt: 0, cleanAfter: 0, scheduleRate: 0,\n    utilization: 0, busyRate: 0, pressure: false\n'''
if old not in s:
    raise SystemExit("portfolio reset cleanAfter anchor missing")
s = s.replace(old, new, 1)

start = s.find('function portfolioSlotScore(region) {')
end = s.find('\nfunction portfolioLearnedEnough(candidates) {', start)
if start < 0 or end < 0:
    raise SystemExit("portfolio score bounds missing")
new_score = r'''function portfolioSlotScore(region) {
  const slot = Number(region.gridSlot);
  const measured = Number.isInteger(slot) && slot >= 0 && slot < SLOT_METRIC_COUNT;
  const samples = measured ? slotQualitySamples[slot] : 0;
  const recent = samples >= 4 ? slotQualityScores[slot] : 0.55;
  const attempts = measured ? slotAttemptCounts[slot] : 0;
  const hits = measured ? slotHitCounts[slot] : 0;
  const lifetime = attempts ? hits / attempts : recent;
  // Rank by observed payload yield. A short miss streak already depresses the
  // recent EWMA, so heavily penalizing LOST again made good 30-50% slots fall
  // out of the portfolio and then recover only through sparse probes.
  const success = samples >= PORTFOLIO_LEARN_SAMPLES
    ? Math.max(recent * 0.72 + lifetime * 0.28, lifetime * 0.68)
    : Math.max(0.5, recent * 0.65 + lifetime * 0.35);
  const stateWeight = region.slotState === "ACTIVE" ? 1
    : region.slotState === "LOST" ? 0.9
    : region.slotState === "LOW_QUALITY" ? 0.78
    : region.slotState === "PARTIAL" ? 0.5 : 0;
  const ppm = Math.max(0.7, Math.min(1.1, (region.pixelsPerModule || 2) / 2.5));
  const priorSelected = decodePortfolio.selectedSlots.includes(slot) ? 0.006 : 0;
  return stateWeight * Math.max(0.2, region.visibleFraction || 0) * ppm * (0.12 + success) + priorSelected;
}
'''
s = s[:start] + new_score + s[end:]

old = '''  if (!opticsStable) {\n    // An exposure/ISO mutation changes both slot yield and decoder cost. Any\n    // portfolio comparison spanning that boundary is invalid. Reopen the wall\n    // immediately so the new optics gets fresh evidence instead of inheriting\n    // an old low-K decision and taking many seconds to grow back.\n    decodePortfolio.budget = maxSlots;\n    decodePortfolio.probe = null;\n    decodePortfolio.lowerBlockedUntil = 0;\n    decodePortfolio.upperBlockedUntil = 0;\n    decodePortfolio.lastDecisionAt = now;\n    decodePortfolio.mode = "hold-optics";\n    return maxSlots;\n  }\n  if (!portfolioLearnedEnough(candidates)) {\n'''
new = '''  if (!opticsStable) {\n    // An exposure/ISO mutation changes both slot yield and decoder cost. Any\n    // portfolio comparison spanning that boundary is invalid. Reopen the wall\n    // immediately and require one completely post-mutation measurement window\n    // before another K decision; otherwise the rolling rate still contains the\n    // tuning pause and falsely reports severe CPU pressure for ~2 seconds.\n    decodePortfolio.budget = maxSlots;\n    decodePortfolio.probe = null;\n    decodePortfolio.lowerBlockedUntil = 0;\n    decodePortfolio.upperBlockedUntil = 0;\n    decodePortfolio.lastDecisionAt = now;\n    decodePortfolio.cleanAfter = now + PORTFOLIO_POST_OPTICS_CLEAN_MS;\n    decodePortfolio.mode = "hold-optics";\n    decodePortfolio.pressure = false;\n    return maxSlots;\n  }\n  if (now < decodePortfolio.cleanAfter) {\n    decodePortfolio.budget = maxSlots;\n    decodePortfolio.probe = null;\n    decodePortfolio.mode = "clean-window";\n    decodePortfolio.pressure = false;\n    return maxSlots;\n  }\n  if (!portfolioLearnedEnough(candidates)) {\n'''
if old not in s:
    raise SystemExit("portfolio optics clean window anchor missing")
s = s.replace(old, new, 1)

old = '''  const delivered = decodePortfolio.captureRate + 0.5 < decodePortfolio.demandRate\n    ? ` · delivered ${decodePortfolio.captureRate.toFixed(1)}`\n    : "";\n  return `Portfolio ${decodePortfolio.budget}/${decodePortfolio.maxSlots} · ${decodePortfolio.mode}${decodePortfolio.pressure ? " · CPU pressure" : ""} · ${decodePortfolio.scheduleRate.toFixed(1)}/${decodePortfolio.demandRate.toFixed(1)} fps${delivered} · ${(decodePortfolio.utilization * 100).toFixed(0)}% busy${explore}${skipped}`;\n'''
new = '''  const delivered = decodePortfolio.captureRate + 0.5 < decodePortfolio.demandRate\n    ? ` · delivered ${decodePortfolio.captureRate.toFixed(1)}`\n    : "";\n  const clean = decodePortfolio.mode === "clean-window"\n    ? ` · clean ${(Math.max(0, decodePortfolio.cleanAfter - receiverNow()) / 1e3).toFixed(1)}s`\n    : "";\n  return `Portfolio ${decodePortfolio.budget}/${decodePortfolio.maxSlots} · ${decodePortfolio.mode}${decodePortfolio.pressure ? " · CPU pressure" : ""}${clean} · ${decodePortfolio.scheduleRate.toFixed(1)}/${decodePortfolio.demandRate.toFixed(1)} fps${delivered} · ${(decodePortfolio.utilization * 100).toFixed(0)}% busy${explore}${skipped}`;\n'''
if old not in s:
    raise SystemExit("portfolio summary clean anchor missing")
s = s.replace(old, new, 1)

p.write_text(s)
