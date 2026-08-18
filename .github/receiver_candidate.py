from pathlib import Path
import re

def rep(path, old, new):
    p=Path(path); s=p.read_text()
    if old not in s: raise SystemExit(f'missing anchor {path}: {old[:80]}')
    p.write_text(s.replace(old,new,1))

rep('receive/main.js','const RECEIVER_RUNTIME_BUILD = "v0.5.276";','const RECEIVER_RUNTIME_BUILD = "v0.5.277";')
rep('receive/main.js','const LOCKED_RECOVERY_SCAN_MS = 90;','const LOCKED_RECOVERY_SCAN_MS = 160;')
rep('receive/main.js','    tracks: Array.isArray(message.tracks) ? message.tracks.length : 0,\n    guided: Boolean(guidedStage),','    tracks: Array.isArray(message.tracks) ? message.tracks.length : 0,\n    sourceSequence: Number.isFinite(sourceSequence) ? sourceSequence : -1,\n    guided: Boolean(guidedStage),')
rep('receive/main.js','let geometryCoverageLastScanId = -1;\nlet geometryRecoveryAssistUntil = 0;','let geometryCoverageLastScanId = -1;\nlet geometryCoverageLastSourceSequence = -1;\nlet geometryRecoveryAssistUntil = 0;')

p=Path('receive/main.js'); s=p.read_text()
# Remove destructive reset from coverage-collapse. The existing 2.8s whole-wall
# silence path remains the only destructive geometry reset.
s=s.replace('''      if (geometryCoverageCollapseStreak >= GEOMETRY_COLLAPSE_STREAK &&\n          now - geometryCoverageCollapseStartedAt >= GEOMETRY_COLLAPSE_MIN_SPAN_MS) {\n        notePipelineEvent("geometry-coverage-collapse", trackedOutputs);\n        enterGeometryRecovery(`tracked coverage collapsed ${trackedOutputs}/${auditMode.tracks}; fresh acquisition`, now, true);\n      }\n''','')
# Do not let multiple split-lane completions from one camera frame advance the
# collapse streak. Older completions are ignored for this heuristic.
s=s.replace('''    geometryCoverageLastScanId = id;\n    const now = receiverNow();\n    const trackedOutputs = Math.min(auditMode.tracks, Math.max(0, Number(completion.symbolCount) || 0));\n''','''    geometryCoverageLastScanId = id;\n    const sourceSequence = Number(auditMode.sourceSequence);\n    if (sourceSequence >= 0 && sourceSequence <= geometryCoverageLastSourceSequence) {\n      hotPathJobMode.delete(id);\n      return;\n    }\n    if (sourceSequence >= 0) geometryCoverageLastSourceSequence = sourceSequence;\n    const now = receiverNow();\n    const trackedOutputs = Math.min(auditMode.tracks, Math.max(0, Number(completion.symbolCount) || 0));\n''',1)
# Preserve the marker across ordinary state; clear it only when recovery state is
# explicitly reset. Add it next to every existing scan marker reset.
s=s.replace('geometryCoverageLastScanId = -1;\n  geometryRecoveryAssistUntil = 0;','geometryCoverageLastScanId = -1;\n  geometryCoverageLastSourceSequence = -1;\n  geometryRecoveryAssistUntil = 0;')
s=s.replace('geometryCoverageLastScanId = -1;\n  decoderFreshnessHoldActive = false;','geometryCoverageLastScanId = -1;\n  geometryCoverageLastSourceSequence = -1;\n  decoderFreshnessHoldActive = false;')
# Recovery probes should target weak/stale geometry, not repeatedly reconfirm an
# easy central QR.
old='''      const ranked = [...lockedGeometryCandidates].sort((a, b) => {\n        const ad = Math.hypot(a.x + a.w / 2 - cx, a.y + a.h / 2 - cy);\n        const bd = Math.hypot(b.x + b.w / 2 - cx, b.y + b.h / 2 - cy);\n        return ad - bd;\n      });\n      const poolSize = Math.min(5, ranked.length);'''
new='''      const ranked = [...lockedGeometryCandidates].sort((a, b) => {\n        const missDelta = (b.consecutiveMisses || 0) - (a.consecutiveMisses || 0);\n        if (missDelta) return missDelta;\n        const ageDelta = (a.decodedSeen ?? -Infinity) - (b.decodedSeen ?? -Infinity);\n        if (ageDelta) return ageDelta;\n        const ad = Math.hypot(a.x + a.w / 2 - cx, a.y + a.h / 2 - cy);\n        const bd = Math.hypot(b.x + b.w / 2 - cx, b.y + b.h / 2 - cy);\n        return bd - ad;\n      });\n      const poolSize = Math.min(6, ranked.length);'''
if old not in s: raise SystemExit('recovery ranking anchor missing')
s=s.replace(old,new,1)
p.write_text(s)

rep('main.js','const APP_BUILD = "v0.5.276";','const APP_BUILD = "v0.5.277";')
p=Path('index.html'); s=p.read_text();
if s.count('v0.5.276') < 2: raise SystemExit('index version')
p.write_text(s.replace('v0.5.276','v0.5.277'))
rep('sw.js','airgapper-static-js-v224','airgapper-static-js-v225')
