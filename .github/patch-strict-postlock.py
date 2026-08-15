from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    text = p.read_text()
    n = text.count(old)
    if n != count:
        raise SystemExit(f"{path}: expected {count} matches, got {n}: {old[:140]!r}")
    p.write_text(text.replace(old, new))

replace("index.html", "v0.5.51", "v0.5.52")
replace("sw.js", 'const CACHE = "airgapper-static-js-v14";', 'const CACHE = "airgapper-static-js-v15";')

replace(
    "receive/main.js",
    '''let strictHotPathEnabled = false;\nstrictHotPathToggle.addEventListener("change", () => {\n  strictHotPathEnabled = strictHotPathToggle.checked;\n  resetHotPathAudit();\n});''',
    '''let strictHotPathEnabled = false;\nlet strictHotPathLockSeen = false;\nstrictHotPathToggle.addEventListener("change", () => {\n  strictHotPathEnabled = strictHotPathToggle.checked;\n  strictHotPathLockSeen = false;\n  resetHotPathAudit();\n});'''
)

# Strict mode allows discovery only until the first real grid lock. Once locked,
# it refuses both state-machine/global reacquisition and worker-local rescue.
replace(
    "receive/main.js",
    '''  const gridNeedsDiscovery = lockedGeometryTrusted\n    ? allLockedCandidatesCold\n    : visibleGridSlots.some((region) => !region.decoded || region.slotState === "LOST");\n  const trackingUnhealthy = regions.some((region) => region.gridSlot === void 0 && region.decoded && region.consecutiveMisses >= 4);\n  gridLattice.noteMissing(gridNeedsDiscovery, now);\n  const needsRecoveryScan = lockedGeometryTrusted\n    ? allLockedCandidatesCold || trackingUnhealthy\n    : live === 0 || live < expectedRegions || trackingUnhealthy || gridNeedsDiscovery;''',
    '''  const gridNeedsDiscovery = lockedGeometryTrusted\n    ? allLockedCandidatesCold\n    : visibleGridSlots.some((region) => !region.decoded || region.slotState === "LOST");\n  const trackingUnhealthy = regions.some((region) => region.gridSlot === void 0 && region.decoded && region.consecutiveMisses >= 4);\n  if (gridLattice.locked) strictHotPathLockSeen = true;\n  const strictLockedAudit = strictHotPathActive() && strictHotPathLockSeen;\n  // Correctness/strict mode is allowed to use the generic detector to acquire\n  // the grid once. After lock, it may not hide tracked failures by falling\n  // back to local robust decode or by abandoning the grid and reacquiring it.\n  gridLattice.noteMissing(strictLockedAudit ? false : gridNeedsDiscovery, now);\n  const needsRecoveryScan = strictLockedAudit ? false : lockedGeometryTrusted\n    ? allLockedCandidatesCold || trackingUnhealthy\n    : live === 0 || live < expectedRegions || trackingUnhealthy || gridNeedsDiscovery;'''
)

# Reset the post-lock strict latch with both session-reset paths.
replace(
    "receive/main.js",
    '''  resetHotPathAudit();\n  lastDistinctArrivalAt = 0;''',
    '''  resetHotPathAudit();\n  strictHotPathLockSeen = false;\n  lastDistinctArrivalAt = 0;'''
)
replace(
    "receive/main.js",
    '''  lastNativeMetrics = void 0;\n  resetHotPathAudit();\n  trackingInvalidations = 0;''',
    '''  lastNativeMetrics = void 0;\n  resetHotPathAudit();\n  strictHotPathLockSeen = false;\n  trackingInvalidations = 0;'''
)

# Make full-frame reasoning generic instead of relying on one job label.
replace(
    "receive/main.js",
    '  if (trace.jobs.some((job) => job.kind === "FULL FRAME")) return "full-frame decoder miss";',
    '  if (trace.jobs.some((job) => job.full)) return "full-frame decoder miss";'
)
replace(
    "receive/main.js",
    '  if (!submitted && trace.jobs.some((job) => job.kind !== "FULL FRAME")) return "crop excluded slot";',
    '  if (!submitted && trace.jobs.some((job) => !job.full)) return "crop excluded slot";'
)

# Benchmark per-kind stats must include the actual hot-path labels (Y8/DIRECT/NATIVE
# TRACKED GRID), not just the old legacy labels.
replace(
    "receive/main.js",
    '    const byKind = Object.fromEntries(["FULL FRAME", "SHARED TRACKED BATCH CROP", "INDIVIDUAL TRACKED CROP"].map((kind) => {',
    '    const byKind = Object.fromEntries([...new Set(jobs.map((job) => job.kind))].map((kind) => {'
)

replace(
    "receive/main.js",
    'Hot path ${strictHotPathActive() ? "STRICT" : "LIVE"}',
    'Hot path ${strictHotPathActive() ? `STRICT · lock ${strictHotPathLockSeen ? "established" : "acquiring"}` : "LIVE"}'
)

# Benchmark result records the post-lock guarantee explicitly.
replace(
    "receive/main.js",
    '''    const hotPath = {\n      strict: replayMode.value === "correctness",''',
    '''    const hotPath = {\n      strict: replayMode.value === "correctness",\n      postLockRecoverySuppressed: replayMode.value === "correctness",'''
)

main = Path("receive/main.js").read_text()
assert "strictLockedAudit ? false : gridNeedsDiscovery" in main
assert "strictLockedAudit ? false : lockedGeometryTrusted" in main
assert "[...new Set(jobs.map((job) => job.kind))]" in main
assert 'job.full' in main
assert "v0.5.52" in Path("index.html").read_text()
