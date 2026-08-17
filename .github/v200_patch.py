from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"replacement not found in {path}: {old[:180]!r}")
    p.write_text(s.replace(old, new, count))

# Version/cache.
replace("index.html", "v0.5.199", "v0.5.200")
replace("main.js", 'const APP_BUILD = "v0.5.199";', 'const APP_BUILD = "v0.5.200";')
replace("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.199";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.200";')
replace("sw.js", 'const CACHE = "airgapper-static-js-v161";', 'const CACHE = "airgapper-static-js-v162";')

p = Path("receive/main.js")
s = p.read_text()

old = '''const GEOMETRY_PROBE_SILENCE_MS = 650;\nconst GEOMETRY_COLD_MISSES = 3;\n// A short synchronized miss burst is common when a camera exposure crosses a\n// display transition. Keep proven geometry alive long enough for tracked\n// decoding and occasional generic rescue probes to recover it.\nconst GEOMETRY_HARD_RESET_MS = 2800;\n'''
new = '''const GEOMETRY_PROBE_SILENCE_MS = 650;\nconst GEOMETRY_COLD_MISSES = 3;\n// A hard camera bump often leaves a few old slots readable. Waiting for *zero*\n// hits lets those survivors pin a badly displaced lattice indefinitely. Once a\n// locked wall has demonstrated healthy coverage, treat a short run of severe\n// per-job coverage collapse as camera motion and reacquire immediately.\nconst GEOMETRY_COLLAPSE_MIN_TRACKS = 4;\nconst GEOMETRY_COLLAPSE_HEALTHY_RATIO = 0.55;\nconst GEOMETRY_COLLAPSE_BAD_RATIO = 0.28;\nconst GEOMETRY_COLLAPSE_STREAK = 4;\nconst GEOMETRY_COLLAPSE_MAX_GAP_MS = 650;\n// A short synchronized miss burst is common when a camera exposure crosses a\n// display transition. Keep proven geometry alive long enough for tracked\n// decoding and occasional generic rescue probes to recover it.\nconst GEOMETRY_HARD_RESET_MS = 2800;\n'''
if old not in s:
    raise SystemExit("geometry constants block missing")
s = s.replace(old, new, 1)

old = '''let geometryRecoveryProbes = 0;\nlet geometryRecoveryResets = 0;\nlet geometrySightingNudges = 0;\n'''
new = '''let geometryRecoveryProbes = 0;\nlet geometryRecoveryResets = 0;\nlet geometrySightingNudges = 0;\nlet geometryCoverageHealthy = false;\nlet geometryCoverageCollapseStreak = 0;\nlet geometryCoverageCollapseLastAt = 0;\n'''
if old not in s:
    raise SystemExit("geometry counters block missing")
s = s.replace(old, new, 1)

old = '''function enterGeometryRecovery(reason, now = receiverNow(), restartWorkers = true) {\n  geometryRecoveryResets++;\n  decoderFreshnessHoldActive = false;\n'''
new = '''function enterGeometryRecovery(reason, now = receiverNow(), restartWorkers = true) {\n  geometryRecoveryResets++;\n  geometryCoverageHealthy = false;\n  geometryCoverageCollapseStreak = 0;\n  geometryCoverageCollapseLastAt = 0;\n  decoderFreshnessHoldActive = false;\n'''
if old not in s:
    raise SystemExit("enterGeometryRecovery marker missing")
s = s.replace(old, new, 1)

old = '''  const auditThisCompletion = Boolean(auditMode && auditMode.generation === hotPathAuditGeneration && auditMode.strict === strictHotPathEnabled);\n  const benchmarkTrace = benchmarkJobFrames.get(id);\n'''
new = '''  const auditThisCompletion = Boolean(auditMode && auditMode.generation === hotPathAuditGeneration && auditMode.strict === strictHotPathEnabled);\n  if (!replayRunning && auditThisCompletion && !auditMode?.full && gridLattice.locked &&\n      auditMode.tracks >= GEOMETRY_COLLAPSE_MIN_TRACKS) {\n    const now = receiverNow();\n    const trackedOutputs = Math.min(auditMode.tracks, Math.max(0, Number(completion.symbolCount) || 0));\n    const coverage = trackedOutputs / auditMode.tracks;\n    if (coverage >= GEOMETRY_COLLAPSE_HEALTHY_RATIO) {\n      geometryCoverageHealthy = true;\n      geometryCoverageCollapseStreak = 0;\n      geometryCoverageCollapseLastAt = 0;\n    } else if (geometryCoverageHealthy && coverage <= GEOMETRY_COLLAPSE_BAD_RATIO) {\n      if (now - geometryCoverageCollapseLastAt > GEOMETRY_COLLAPSE_MAX_GAP_MS)\n        geometryCoverageCollapseStreak = 0;\n      geometryCoverageCollapseLastAt = now;\n      geometryCoverageCollapseStreak++;\n      if (geometryCoverageCollapseStreak >= GEOMETRY_COLLAPSE_STREAK) {\n        notePipelineEvent("geometry-coverage-collapse", trackedOutputs);\n        enterGeometryRecovery(`tracked coverage collapsed ${trackedOutputs}/${auditMode.tracks}; fresh acquisition`, now, true);\n      }\n    } else if (coverage > GEOMETRY_COLLAPSE_BAD_RATIO) {\n      geometryCoverageCollapseStreak = 0;\n      geometryCoverageCollapseLastAt = 0;\n    }\n  }\n  const benchmarkTrace = benchmarkJobFrames.get(id);\n'''
if old not in s:
    raise SystemExit("completion audit marker missing")
s = s.replace(old, new, 1)

old = '''  geometryRecoveryProbes = 0;\n  geometryRecoveryResets = 0;\n  recoveryWorkerRestarts = 0;\n'''
new = '''  geometryRecoveryProbes = 0;\n  geometryRecoveryResets = 0;\n  geometryCoverageHealthy = false;\n  geometryCoverageCollapseStreak = 0;\n  geometryCoverageCollapseLastAt = 0;\n  recoveryWorkerRestarts = 0;\n'''
if old not in s:
    raise SystemExit("stopReceiver geometry reset marker missing")
s = s.replace(old, new, 1)

p.write_text(s)
