from pathlib import Path
import re

root = Path('.')
main = root / 'receive/main.js'
grid = root / 'receive/grid-lattice.js'

s = main.read_text()
old = '''const FULL_SCAN_DEGRADED_MS = 250;\nconst GEOMETRY_PROBE_SILENCE_MS = 650;\nconst GEOMETRY_COLD_MISSES = 3;'''
new = '''const FULL_SCAN_DEGRADED_MS = 250;\nconst LOCKED_RECOVERY_SCAN_MS = 220;\nconst GEOMETRY_PROBE_SILENCE_MS = 650;\nconst GEOMETRY_COLD_MISSES = 3;\n// A short synchronized miss burst is common when a camera exposure crosses a\n// display transition. Keep proven geometry alive long enough for tracked\n// decoding and occasional generic rescue probes to recover it.\nconst GEOMETRY_HARD_RESET_MS = 2800;'''
assert old in s
s = s.replace(old, new, 1)

old = '''  const allLockedCandidatesCold = lockedGeometryTrusted && recentLockedHits === 0 &&\n    lockedGeometryCandidates.every((region) => region.consecutiveMisses >= GEOMETRY_COLD_MISSES);\n  if (allLockedCandidatesCold) {\n    enterGeometryRecovery("all tracked slots cold; fresh acquisition", now, true);\n    if (trace) trace.stateAfter = gridLattice.state;\n    activeBenchmarkFrame = void 0;\n    return;\n  }'''
new = '''  const allLockedCandidatesCold = lockedGeometryTrusted && recentLockedHits === 0 &&\n    lockedGeometryCandidates.every((region) => region.consecutiveMisses >= GEOMETRY_COLD_MISSES);\n  // Three tracked misses are evidence for a rescue probe, not evidence that the\n  // wall geometry vanished. Previously this destroyed a good lattice after\n  // roughly 0.9 s of optical misses and forced dense generic reacquisition.\n  // Preserve the hot geometry while rescue scans run in parallel; only abandon\n  // it after sustained decoder silence.\n  const hardGeometryResetDue = allLockedCandidatesCold &&\n    lockedDecodeSilenceMs >= GEOMETRY_HARD_RESET_MS;\n  if (hardGeometryResetDue) {\n    enterGeometryRecovery("tracked lattice silent too long; fresh acquisition", now, true);\n    if (trace) trace.stateAfter = gridLattice.state;\n    activeBenchmarkFrame = void 0;\n    return;\n  }'''
assert old in s
s = s.replace(old, new, 1)

old = '''  const scanInterval = live === 0 ? ACQUISITION_SCAN_MS : FULL_SCAN_DEGRADED_MS;'''
new = '''  // Once geometry has been proven, never let a transient zero-output window\n  // turn recovery into a 22 Hz stream of expensive full-frame finder scans.\n  // Keep most camera frames available to the tracked decoder and inject only\n  // a few generic rescue probes per second.\n  const scanInterval = gridLattice.locked\n    ? LOCKED_RECOVERY_SCAN_MS\n    : live === 0 ? ACQUISITION_SCAN_MS : FULL_SCAN_DEGRADED_MS;'''
assert old in s
s = s.replace(old, new, 1)

main.write_text(s)

g = grid.read_text()
assert 'const WHOLE_GRID_LOSS_MS = 1400;' in g
g = g.replace(
    'const WHOLE_GRID_LOSS_MS = 1400;',
    '// Preserve a proven wall through short optical/display-phase miss bursts.\\nconst WHOLE_GRID_LOSS_MS = 3200;',
    1
)
grid.write_text(g)

# Version/cache bump.
for name in ['index.html', 'main.js', 'receive/main.js']:
    p = root / name
    text = p.read_text()
    assert 'v0.5.142' in text, name
    p.write_text(text.replace('v0.5.142', 'v0.5.143'))

sw = root / 'sw.js'
text = sw.read_text()
m = re.search(r'airgapper-static-js-v(\\d+)', text)
assert m
text = text[:m.start(1)] + str(int(m.group(1)) + 1) + text[m.end(1):]
sw.write_text(text)
