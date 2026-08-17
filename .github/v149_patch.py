from pathlib import Path

root = Path('.')
grid = root / 'receive/grid-lattice.js'
s = grid.read_text()

old = '''// Preserve a proven wall through short optical/display-phase miss bursts.\nconst WHOLE_GRID_LOSS_MS = 3200;'''
new = '''// Preserve a proven wall through short optical/display-phase miss bursts.\nconst WHOLE_GRID_LOSS_MS = 3200;\n// Geometry has two different lifetimes. Identity/lock evidence may survive a\n// brief miss, but quads used to aim the hot decoder must represent the camera\n// pose *now*. Keeping those concepts separate prevents repeatedly decoded easy\n// slots from pushing rarer slot geometry out of the lattice, while also\n// preventing an old exact quad from fighting a newer whole-wall fit.\nconst OBSERVATION_HISTORY_MS = 2500;\nconst CURRENT_FIT_MS = 420;\nconst EXACT_GEOMETRY_MS = 420;'''
assert old in s
s = s.replace(old, new, 1)

old = '''    this.observations.push(detection);\n    this.observations = this.observations.filter((item) => detection.at - item.at < 2500 && item.modules === detection.modules).slice(-32);'''
new = '''    // makeCandidate only uses the newest observation for each slot. Storing a\n    // raw last-N stream was therefore both wasted memory and actively harmful:\n    // a few easy QRs decoded every frame could evict the last good geometry for\n    // the other cells. Keep exactly one CRC-backed observation per slot.\n    this.observations = this.observations.filter((item) =>\n      detection.at - item.at < OBSERVATION_HISTORY_MS &&\n      item.modules === detection.modules &&\n      item.slotIndex !== detection.slotIndex\n    );\n    this.observations.push(detection);'''
assert old in s
s = s.replace(old, new, 1)

old = '''    let observations = [...latest.values()];\n    if (!observations.length) return null;\n    const newest = observations.reduce((a, b) => a.at > b.at ? a : b);\n    const pairsFor = (items) => items.flatMap((observation) => {'''
new = '''    let observations = [...latest.values()];\n    if (!observations.length) return null;\n    const newest = observations.reduce((a, b) => a.at > b.at ? a : b);\n    // A moving phone makes a 1-2 second old quad a different camera pose. When\n    // the current window already spans both lattice axes, fit only that fresh\n    // evidence. Fall back to the longer-lived anchors only when the visible\n    // fragment cannot constrain a 2D wall by itself.\n    const current = observations.filter((observation) => newest.at - observation.at <= CURRENT_FIT_MS);\n    if (lockReady(layout, current)) observations = current;\n    const pairsFor = (items) => items.flatMap((observation) => {'''
assert old in s
s = s.replace(old, new, 1)

old = '''    const observed = new Map(candidate.observations.map((observation) => [observation.slotIndex, observation]));\n    const decoded = new Set(observed.keys());'''
new = '''    const newestAt = candidate.observations.reduce((latest, observation) => Math.max(latest, observation.at), 0);\n    // Exact per-QR geometry is best only while it is fresh. After camera motion,\n    // the current lattice projection is a better aim point than a formerly exact\n    // quad from another pose. This also lets a fresh decode on one part of the\n    // wall move stale cells immediately instead of waiting for each cell to win.\n    const observed = new Map(candidate.observations\n      .filter((observation) => newestAt - observation.at <= EXACT_GEOMETRY_MS)\n      .map((observation) => [observation.slotIndex, observation]));\n    const decoded = new Set(observed.keys());'''
assert old in s
s = s.replace(old, new, 1)

old = '''    return { state: this.state, provisional: !this.active, confidence, layout: candidate.layout, modules, slots, observedSlots: observed.size, fitError: candidate.error };'''
new = '''    return {\n      state: this.state, provisional: !this.active, confidence, layout: candidate.layout, modules, slots,\n      observedSlots: observed.size, storedSlots: this.observations.length, fitSlots: candidate.observations.length,\n      fitError: candidate.error\n    };'''
assert old in s
s = s.replace(old, new, 1)

grid.write_text(s)

# Release/version bump. Do not touch the working optics or guided scheduling.\nfor name in ['index.html', 'main.js', 'receive/main.js']:\n    p = root / name\n    text = p.read_text()\n    assert 'v0.5.148' in text, name\n    p.write_text(text.replace('v0.5.148', 'v0.5.149'))\n\nsw = root / 'sw.js'\ntext = sw.read_text()\nassert 'airgapper-static-js-v111' in text\nsw.write_text(text.replace('airgapper-static-js-v111', 'airgapper-static-js-v112', 1))\n