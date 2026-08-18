from pathlib import Path


def rep(path, old, new):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f'missing anchor {path}: {old[:180]}')
    p.write_text(s.replace(old, new, 1))


# Version/cache.
rep('receive/main.js', 'const RECEIVER_RUNTIME_BUILD = "v0.5.283";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.284";')
rep('main.js', 'const APP_BUILD = "v0.5.283";', 'const APP_BUILD = "v0.5.284";')
rep('index.html', 'main.js?build=v0.5.283', 'main.js?build=v0.5.284')
rep('sw.js', 'airgapper-static-js-v231', 'airgapper-static-js-v232')

# Recovery health must be measured against slots the tracked decoder can
# actually attempt. `visibleGridSlots` includes heavily clipped (>10% visible)
# cells while isGridDecodeCandidate deliberately requires >=85% for PARTIAL.
# Using the larger denominator made a healthy 12/12 tracked view look like
# 12/20 = 60% coverage and continuously woke recovery.
rep(
    'receive/main.js',
    '  const wallFreshRatio = freshLockedHits / Math.max(1, visibleGridSlots.length);',
    '  const wallFreshRatio = freshLockedHits / Math.max(1, lockedGeometryCandidates.length);'
)
rep(
    'receive/main.js',
    '''  const liveGridLayout = lastGridSnapshot?.layout;\n  const freshCols = new Set();\n  const freshRows = new Set();''',
    '''  const liveGridLayout = lastGridSnapshot?.layout;\n  const candidateCols = new Set();\n  const candidateRows = new Set();\n  for (const region of lockedGeometryCandidates) {\n    const slot = Number(region.gridSlot);\n    if (!Number.isInteger(slot) || !liveGridLayout) continue;\n    candidateCols.add(slot % liveGridLayout.cols);\n    candidateRows.add(Math.floor(slot / liveGridLayout.cols));\n  }\n  const freshCols = new Set();\n  const freshRows = new Set();'''
)
rep(
    'receive/main.js',
    '''  const freshDistributed = !liveGridLayout ? false\n    : liveGridLayout.cols === 1 ? freshRows.size >= 2\n      : liveGridLayout.rows === 1 ? freshCols.size >= 2\n        : freshCols.size >= 2 && freshRows.size >= 2;''',
    '''  const candidateBreadthCanConstrainPose = !liveGridLayout ? false\n    : liveGridLayout.cols === 1 ? candidateRows.size >= 2\n      : liveGridLayout.rows === 1 ? candidateCols.size >= 2\n        : candidateCols.size >= 2 && candidateRows.size >= 2;\n  // Never demand cross-axis evidence the current camera framing cannot\n  // physically provide. A one-row/one-column view can still be a healthy\n  // tracked subsection of an already-declared wall.\n  const freshDistributed = !candidateBreadthCanConstrainPose || !liveGridLayout ? true\n    : liveGridLayout.cols === 1 ? freshRows.size >= 2\n      : liveGridLayout.rows === 1 ? freshCols.size >= 2\n        : freshCols.size >= 2 && freshRows.size >= 2;'''
)
rep(
    'receive/main.js',
    '  const wallCoverageStarved = lockedGeometryTrusted && visibleGridSlots.length >= SLOT_WEAK_MIN_WALL &&',
    '  const wallCoverageStarved = lockedGeometryTrusted && lockedGeometryCandidates.length >= SLOT_WEAK_MIN_WALL &&'
)

# SEARCH/REACQUIRE is the only acquisition state. Once one CRC-valid QR has
# activated GridLattice, a temporarily local (non-distributed) fit must not route
# back into acquisitionDiscovery: that branch is intentionally aggressive and
# has no locked recovery interval. v283 could therefore submit ~5 full scans/s
# for tens of seconds while TRACK was already producing useful data.
rep(
    'receive/main.js',
    '''  const geometryBootstrap = gridLattice.active && Boolean(lastGridSnapshot) && !lastGridSnapshot.distributedFit;\n  const acquisitionDiscovery = preLatticeDiscovery || geometryBootstrap;''',
    '''  const acquisitionDiscovery = preLatticeDiscovery;'''
)
rep(
    'receive/main.js',
    '''  const provisionalNeedsDiscovery = acquisitionDiscovery && (\n    geometryBootstrap || !lastGridSnapshot || !captureHasTrackedWork || provisionalUnknownVisible.length > 0 ||\n    now - lastFullScan > GEOMETRY_PROBE_SILENCE_MS\n  );''',
    '''  const provisionalNeedsDiscovery = acquisitionDiscovery && (\n    !lastGridSnapshot || !captureHasTrackedWork || provisionalUnknownVisible.length > 0 ||\n    now - lastFullScan > GEOMETRY_PROBE_SILENCE_MS\n  );'''
)
rep(
    'receive/main.js',
    '''    if (!captureNextScan && acquisitionDiscovery && (!lastGridSnapshot || geometryBootstrap && provisionalUnknownVisible.length === 0) && !fullFrameSeed) {''',
    '''    if (!captureNextScan && acquisitionDiscovery && !lastGridSnapshot && !fullFrameSeed) {'''
)

# Local recovery is for repairing *decodable* missing breadth. Do not target
# absent/offscreen predictions; if the whole pose is really gone, the existing
# global recovery path is triggered by synchronized cold tracks/decode silence.
rep(
    'receive/main.js',
    '''      // Repair the missing side, not the side that is already trackable. The\n      // previous recovery pool was lockedGeometryCandidates, which excludes an\n      // OFFSCREEN/invalid prediction by definition and could therefore probe\n      // the surviving half forever. Rank every predicted grid slot, preferring\n      // lost/partial/offscreen and stale slots before healthy active slots.''',
    '''      // Repair missing breadth using slots that are actually present enough\n      // to decode. Offscreen/invalid predictions belong to global pose recovery,\n      // not an endless local finder loop around pixels that cannot contain a QR.'''
)
rep(
    'receive/main.js',
    '''      const statePriority = (region) => region.slotState === "LOST" ? 5\n        : region.slotState === "PARTIAL" ? 4\n          : region.slotState === "OFFSCREEN" ? 3\n            : region.slotState === "LOW_QUALITY" ? 2 : 0;\n      const recoveryPool = regions.filter((region) => region.gridSlot !== void 0 && region.quad && region.dim);''',
    '''      const statePriority = (region) => region.slotState === "LOST" ? 5\n        : region.slotState === "PARTIAL" ? 4\n          : region.slotState === "LOW_QUALITY" ? 2 : 0;\n      const recoveryPool = [...lockedGeometryCandidates];'''
)

# A targeted local recovery that found no requested slot learned exactly what we
# needed: those predictions do not currently decode. Do not immediately spend a
# second generic finder pass over the same broad crop, which mostly rediscovers
# easy neighbors. Global recovery already owns unconstrained finder scans.
rep(
    'receive/worker.js',
    '''          if (!targetedAttempts || targetedSuccesses === 0) {\n            readFullAttempts++;\n            appendResults(readDenseSeed(1), false);\n          }''',
    '''          if (!targetedAttempts) {\n            readFullAttempts++;\n            appendResults(readDenseSeed(1), false);\n          }'''
)

# Diagnostics/capacity must use the same eligibility rule as the scheduler.
rep(
    'receive/main.js',
    '''  const visibleSlotCount = regions.reduce((count, region) => count + Number(region.gridSlot !== void 0 && region.slotState !== "OFFSCREEN"), 0);\n  const qrOpportunityRate = sourceCaptureRate * visibleSlotCount;''',
    '''  const visibleSlotCount = regions.reduce((count, region) => count + Number(region.gridSlot !== void 0 && region.slotState !== "OFFSCREEN"), 0);\n  const decodableSlotCount = regions.reduce((count, region) => count + Number(\n    region.gridSlot !== void 0 && isGridDecodeCandidate(region) &&\n    validTrackedQuad(region, receiverFrameWidth, receiverFrameHeight)\n  ), 0);\n  const qrOpportunityRate = sourceCaptureRate * decodableSlotCount;'''
)
rep(
    'receive/main.js',
    '''    `Capacity ${visibleSlotCount || "—"} visible slots × ${sourceCaptureRate.toFixed(1)} fps = ${qrOpportunityRate.toFixed(1)} QR/s · submitted ${attemptedQrRate.toFixed(1)} (${qrOpportunityRate ? `${(attemptCoverage * 100).toFixed(0)}%` : "—"}) · completed ${completedQrRate.toFixed(1)}`,''',
    '''    `Capacity ${decodableSlotCount || "—"} decodable / ${visibleSlotCount || "—"} visible slots × ${sourceCaptureRate.toFixed(1)} fps = ${qrOpportunityRate.toFixed(1)} QR/s · submitted ${attemptedQrRate.toFixed(1)} (${qrOpportunityRate ? `${(attemptCoverage * 100).toFixed(0)}%` : "—"}) · completed ${completedQrRate.toFixed(1)}`,'''
)

# Guard the intent of the candidate itself.
main = Path('receive/main.js').read_text()
worker = Path('receive/worker.js').read_text()
if 'geometryBootstrap' in main:
    raise SystemExit('geometryBootstrap acquisition path survived')
if 'wallFreshRatio = freshLockedHits / Math.max(1, visibleGridSlots.length)' in main:
    raise SystemExit('bad visible-slot recovery denominator survived')
if 'const recoveryPool = regions.filter' in main:
    raise SystemExit('offscreen local recovery pool survived')
if 'targetedSuccesses === 0' in worker:
    raise SystemExit('generic local-recovery fallthrough survived')
