from pathlib import Path

p = Path("receive/main.js")
s = p.read_text()
old = '''    const provisionalCrop = preLatticeDiscovery && provisionalUnknownVisible.length > 0;\n    const boundedScanCandidates = provisionalCrop ? provisionalUnknownVisible : lockedGeometryCandidates;\n    if (!captureNextScan && boundedScanCandidates.length && (provisionalCrop || lockedGeometryTrusted && gridLattice.locked && !geometryProbeDue && !allLockedCandidatesCold)) {'''
new = '''    const provisionalCrop = preLatticeDiscovery && provisionalUnknownVisible.length > 0;\n    // A generic decoder over the bounding box of *all* provisional unknowns is\n    // almost a full-wall scan again. Dense walls then rediscover the same first\n    // physical row on every pass (the decoder has a bounded result count), so\n    // the lattice may never collect cross-axis geometry and never lock. Probe one\n    // predicted unknown slot at a time instead. Rotating these tiny crops both\n    // cuts acquisition pixels and guarantees discovery pressure moves around the\n    // declared wall instead of repeatedly rewarding the easiest row.\n    let boundedScanCandidates = lockedGeometryCandidates;\n    if (provisionalCrop) {\n      const target = provisionalUnknownVisible[acquisitionTileCursor++ % provisionalUnknownVisible.length];\n      boundedScanCandidates = target ? [target] : [];\n    }\n    if (!captureNextScan && boundedScanCandidates.length && (provisionalCrop || lockedGeometryTrusted && gridLattice.locked && !geometryProbeDue && !allLockedCandidatesCold)) {'''
if old not in s:
    raise SystemExit("provisional acquisition crop anchor missing")
s = s.replace(old, new, 1)
p.write_text(s)
