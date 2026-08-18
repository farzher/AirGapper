from pathlib import Path


def rep(path, old, new):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f'missing anchor {path}: {old[:160]}')
    p.write_text(s.replace(old, new, 1))


# v0.5.281 already passed CI and was promoted. This candidate is intentionally
# incremental: tighten the evidence used by continuous similarity tracking and
# make partial-wall coverage itself sufficient to enter breadth recovery.
rep('receive/main.js', 'const RECEIVER_RUNTIME_BUILD = "v0.5.281";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.282";')
rep('main.js', 'const APP_BUILD = "v0.5.281";', 'const APP_BUILD = "v0.5.282";')
rep('index.html', 'main.js?build=v0.5.281', 'main.js?build=v0.5.282')
rep('sw.js', 'airgapper-static-js-v229', 'airgapper-static-js-v230')

# Similarity rotation/scale must come from spatially separated CRC-valid QRs.
# Neighboring cells can share local/lens residual and should not be allowed to
# rotate the entire 4x7 lattice. Translation fallback remains available for
# clustered evidence, so this only makes rotation/scale updates safer.
rep(
    'receive/worker.js',
    'const minSpan = Math.max(48, medianEdge * 0.65);',
    'const minSpan = Math.max(80, medianEdge * 1.25);'
)

# v281's first partial-lock guard still required <55% coverage AND another
# condition. The supplied failure ends around 13/28 fresh/calibrated slots, so
# a distributed-looking easy subset can remain below half-wall throughput while
# suppressing recovery. Low wall breadth is itself a bad-lock signal: after the
# existing 320 ms debounce, schedule the bounded breadth-recovery path.
rep(
    'receive/main.js',
    '''  const wallCoverageStarved = lockedGeometryTrusted && visibleGridSlots.length >= SLOT_WEAK_MIN_WALL &&\n    freshLockedHits > 0 && wallFreshRatio < 0.55 && (!freshDistributed || wallFreshRatio < 0.38);''',
    '''  const wallCoverageStarved = lockedGeometryTrusted && visibleGridSlots.length >= SLOT_WEAK_MIN_WALL &&\n    freshLockedHits > 0 && (wallFreshRatio < 0.55 || !freshDistributed);'''
)

# Keep the same breadth condition all the way through scheduling. This matters
# for narrow layouts and avoids a state where starvation is detected but the
# maintenance probe is then vetoed by a separate ratio-only check.
rep(
    'receive/main.js',
    '''  const maintenanceGeometryProbe = (coverageRecoveryAssist || sustainedCoverageStarvation) &&\n    wallFreshRatio < 0.55 && now - lastFullScan >= maintenanceInterval;''',
    '''  const maintenanceGeometryProbe = (coverageRecoveryAssist || sustainedCoverageStarvation) &&\n    (wallFreshRatio < 0.55 || !freshDistributed) && now - lastFullScan >= maintenanceInterval;'''
)
