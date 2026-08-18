from pathlib import Path


def rep(path, old, new):
    p = Path(path); s = p.read_text()
    if old not in s: raise SystemExit(f'missing anchor {path}: {old[:120]}')
    p.write_text(s.replace(old, new, 1))

rep('receive/main.js', 'const RECEIVER_RUNTIME_BUILD = "v0.5.279";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.280";')
rep('main.js', 'const APP_BUILD = "v0.5.279";', 'const APP_BUILD = "v0.5.280";')
p = Path('index.html'); s = p.read_text()
if s.count('v0.5.279') < 2: raise SystemExit('index version anchors missing')
p.write_text(s.replace('v0.5.279', 'v0.5.280'))
rep('sw.js', 'airgapper-static-js-v227', 'airgapper-static-js-v228')

p = Path('receive/main.js'); s = p.read_text()
# A partial-but-live wall only needs occasional geometry maintenance. True
# packet silence still uses the fast recovery threshold.
s = s.replace('const LOCKED_RECOVERY_SCAN_MS = 350;\nconst GEOMETRY_FAST_HIT_MS = 220;', 'const LOCKED_RECOVERY_SCAN_MS = 350;\nconst GEOMETRY_MAINTENANCE_SCAN_MS = 1200;\nconst GEOMETRY_FAST_HIT_MS = 220;', 1)
old = '''  const coverageRecoveryAssist = lockedGeometryTrusted && geometryRecoveryAssistUntil > now;\n  const geometryProbeDue = lockedGeometryTrusted && (coverageRecoveryAssist ||\n    freshLockedHits === 0 && lockedDecodeSilenceMs >= GEOMETRY_FAST_PROBE_SILENCE_MS);\n'''
new = '''  const coverageRecoveryAssist = lockedGeometryTrusted && geometryRecoveryAssistUntil > now;\n  const wallFreshRatio = freshLockedHits / Math.max(1, visibleGridSlots.length);\n  const aggressiveGeometryProbe = freshLockedHits === 0 && lockedDecodeSilenceMs >= GEOMETRY_FAST_PROBE_SILENCE_MS;\n  const maintenanceGeometryProbe = coverageRecoveryAssist && wallFreshRatio < 0.55 &&\n    now - lastFullScan >= GEOMETRY_MAINTENANCE_SCAN_MS;\n  const geometryProbeDue = lockedGeometryTrusted && (aggressiveGeometryProbe || maintenanceGeometryProbe);\n'''
if old not in s: raise SystemExit('geometryProbeDue anchor missing')
s = s.replace(old, new, 1)
# Do not bypass the maintenance throttle every time a low-output lane completes.
s = s.replace('''        geometryRecoveryAssistUntil = Math.max(geometryRecoveryAssistUntil, now + 550);\n        lastFullScan = 0;\n        notePipelineEvent("geometry-recovery-assist", trackedOutputs);''', '''        geometryRecoveryAssistUntil = Math.max(geometryRecoveryAssistUntil, now + 550);\n        notePipelineEvent("geometry-recovery-assist", trackedOutputs);''', 1)
# Plain/ungridded acquisition regions are obsolete once the framed lattice is
# authoritative; they must not keep requesting full recovery scans forever.
old = '''  const needsRecoveryScan = strictLockedAudit ? false : preLatticeDiscovery ? true : lockedGeometryTrusted\n    ? geometryProbeDue || allLockedCandidatesCold || trackingUnhealthy\n    : live === 0 || live < expectedRegions || trackingUnhealthy || gridNeedsDiscovery;'''
new = '''  const needsRecoveryScan = strictLockedAudit ? false : preLatticeDiscovery ? true : lockedGeometryTrusted\n    ? geometryProbeDue || allLockedCandidatesCold\n    : live === 0 || live < expectedRegions || trackingUnhealthy || gridNeedsDiscovery;'''
if old not in s: raise SystemExit('needsRecoveryScan anchor missing')
s = s.replace(old, new, 1)
p.write_text(s)
