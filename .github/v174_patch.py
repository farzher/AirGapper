from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"missing anchor in {path}: {old[:180]!r}")
    p.write_text(s.replace(old, new, 1))


replace_once("index.html", "v0.5.173", "v0.5.174")
replace_once("main.js", 'const APP_BUILD = "v0.5.173";', 'const APP_BUILD = "v0.5.174";')
replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.173";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.174";')
replace_once("sw.js", 'airgapper-static-js-v135', 'airgapper-static-js-v136')

p = Path("receive/main.js")
s = p.read_text()

start = s.find('const PORTFOLIO_MIN_WALL = 8;')
end = s.find('\nfunction cornerSlotMetrics() {', start)
if start < 0 or end < 0:
    raise SystemExit('decode portfolio block bounds missing')
s = s[:start] + s[end + 1:]

old = '''  const adaptiveWeakSlots = gridLattice.active && adaptiveWeakSlotScheduling(batchCandidates);\n  const weakFilteredRegions = adaptiveWeakSlots\n    ? batchCandidates.filter((region) => shouldScheduleAdaptiveSlot(region, source.sequence, true))\n    : batchCandidates;\n  const portfolioEnabled = gridLattice.active && !captureNextScan && lockedGeometryTrusted && !allLockedCandidatesCold && !trackingUnhealthy;\n  const batchRegions = selectDecodePortfolio(weakFilteredRegions, source.sequence, now, portfolioEnabled);\n'''
new = '''  const adaptiveWeakSlots = gridLattice.active && adaptiveWeakSlotScheduling(batchCandidates);\n  const batchRegions = adaptiveWeakSlots\n    ? batchCandidates.filter((region) => shouldScheduleAdaptiveSlot(region, source.sequence, true))\n    : batchCandidates;\n'''
if old not in s:
    raise SystemExit('scheduler portfolio anchor missing')
s = s.replace(old, new, 1)

old = '''  resetSlotMetrics();\n  resetDecodePortfolio();\n  resetGuidedRollout();\n'''
new = '''  resetSlotMetrics();\n  resetGuidedRollout();\n'''
if old not in s:
    raise SystemExit('portfolio reset call anchor missing')
s = s.replace(old, new, 1)

old = '''    cornerSlotMetrics(),\n    decodePortfolioSummary(),\n    `Pressure worker-busy ${workerBusyEventRate.toFixed(1)}/s'''
new = '''    cornerSlotMetrics(),\n    `Pressure worker-busy ${workerBusyEventRate.toFixed(1)}/s'''
if old not in s:
    raise SystemExit('portfolio diagnostics anchor missing')
s = s.replace(old, new, 1)

for forbidden in [
    'decodePortfolio', 'selectDecodePortfolio', 'PORTFOLIO_',
    'portfolioLoadSnapshot', 'portfolioSlotScore', 'portfolioSourceDemandRate'
]:
    if forbidden in s:
        raise SystemExit(f'portfolio residue remains: {forbidden}')

p.write_text(s)
