from pathlib import Path

root = Path('.')
main = root / 'receive/main.js'
s = main.read_text()

assert 'const RECEIVER_RUNTIME_BUILD = "v0.5.150";' in s
s = s.replace('const RECEIVER_RUNTIME_BUILD = "v0.5.150";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.151";', 1)

old = '''async function tuneAutomaticQrIso(track, exposure, baseIso, isoRange, maxAutoIso) {\n  if (!automaticIsoAxis || !automaticOpticsSessionAlive(track)) return { iso: baseIso, probes: [] };'''
new = '''async function tuneAutomaticQrIso(track, exposure, baseIso, isoRange, maxAutoIso) {\n  // The per-axis Auto flags belong to manual Optics mode. When the top-level\n  // Optics controller is Auto, it owns exposure + gain for its one-time camera\n  // calibration. A previously hand-pinned ISO must not silently disable this\n  // search while the manual controls are hidden. Preserve the pin for the next\n  // time the user explicitly switches Optics off, but ignore it here.\n  if (!automaticOpticsSessionAlive(track)) return { iso: baseIso, probes: [] };'''
assert old in s
s = s.replace(old, new, 1)
main.write_text(s)

for name in ['index.html', 'main.js']:
    p = root / name
    text = p.read_text()
    assert 'v0.5.150' in text, name
    p.write_text(text.replace('v0.5.150', 'v0.5.151'))

sw = root / 'sw.js'
text = sw.read_text()
assert 'airgapper-static-js-v112' in text
sw.write_text(text.replace('airgapper-static-js-v112', 'airgapper-static-js-v113', 1))

# Keep the fresh-lattice release bundled with this build.
lattice = (root / 'receive/grid-lattice.js').read_text()
assert 'const OBSERVATION_HISTORY_MS = 2500;' in lattice
assert 'const CURRENT_FIT_MS = 420;' in lattice
assert 'const EXACT_GEOMETRY_MS = 420;' in lattice
