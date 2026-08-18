from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing expected text in {path}: {old[:160]!r}")
    p.write_text(text.replace(old, new, 1))

# v271 made one QR sufficient to activate the declared wall. That is correct for
# responsiveness, but lockReady() was also reused by makeCandidate() to decide
# whether a 420 ms observation window may replace all older distributed anchors.
# With lockReady == one QR, one easy slot could refit the entire wall from itself
# and strand the opposite half of the grid. Separate activation from fit trust.
replace_once(
    "receive/grid-lattice.js",
    '''function lockReady(layout, observations) {\n  // One CRC-verified AirGapper QR is a complete geometric seed. The packet\n  // declares the wall layout and this QR's slot; its measured four-corner quad\n  // provides the eight constraints needed for the wall homography. Additional\n  // QRs improve the fit / learn lens residuals, but must never delay acquisition.\n  return observations.length > 0;\n}''',
    '''function activationReady(layout, observations) {\n  // One CRC-verified AirGapper QR is enough to predict every declared slot and\n  // begin tracked decoding immediately.\n  return observations.length > 0;\n}\nfunction distributedFitReady(layout, observations) {\n  const count = layout.cols * layout.rows;\n  if (count <= 1) return observations.length > 0;\n  const slots = [...new Set(observations.map((observation) => observation.slotIndex))];\n  if (slots.length < 2) return false;\n  if (layout.cols === 1 || layout.rows === 1) return true;\n  const cols = new Set(slots.map((slot) => slot % layout.cols));\n  const rows = new Set(slots.map((slot) => Math.floor(slot / layout.cols)));\n  // A fresh fit may replace the longer-lived anchors only after observations\n  // span both wall axes. Two diagonal slots are enough. Two slots from one row\n  // or one column are still only a local/provisional geometric seed.\n  return cols.size >= 2 && rows.size >= 2;\n}'''
)
replace_once(
    "receive/grid-lattice.js",
    'if (lockReady(declaredLayout, this.candidate.observations)) {',
    'if (activationReady(declaredLayout, this.candidate.observations)) {'
)
replace_once(
    "receive/grid-lattice.js",
    'if (lockReady(layout, current)) observations = current;',
    'if (distributedFitReady(layout, current)) observations = current;'
)
replace_once(
    "receive/grid-lattice.js",
    'return { layout, transform, observations, score, error };',
    'return { layout, transform, observations, score, error, distributedFit: distributedFitReady(layout, observations) };'
)
replace_once(
    "receive/grid-lattice.js",
    '''      observedSlots: observed.size, correctedSlots: this.slotCorrections.size,\n      storedSlots: this.observations.length, fitSlots: candidate.observations.length,\n      fitError: candidate.error''',
    '''      observedSlots: observed.size, correctedSlots: this.slotCorrections.size,\n      storedSlots: this.observations.length, fitSlots: candidate.observations.length,\n      distributedFit: Boolean(candidate.distributedFit), fitError: candidate.error'''
)

# One QR should start tracked decoding immediately, but do not stop acquisition
# until the global fit is cross-axis constrained. Keep at most one acquisition
# job beside tracked work, probing predicted unknown slots (or rotating image
# windows if the provisional homography incorrectly projects them offscreen).
replace_once(
    "receive/main.js",
    '  const preLatticeDiscovery = !gridLattice.active;\n  const gridNeedsDiscovery = preLatticeDiscovery || (lockedGeometryTrusted',
    '  const preLatticeDiscovery = !gridLattice.active;\n  const geometryBootstrap = gridLattice.active && Boolean(lastGridSnapshot) && !lastGridSnapshot.distributedFit;\n  const acquisitionDiscovery = preLatticeDiscovery || geometryBootstrap;\n  const gridNeedsDiscovery = preLatticeDiscovery || (lockedGeometryTrusted'
)
replace_once(
    "receive/main.js",
    '  const provisionalUnknownVisible = preLatticeDiscovery && lastGridSnapshot ? visibleGridSlots.filter((region) =>',
    '  const provisionalUnknownVisible = acquisitionDiscovery && lastGridSnapshot ? visibleGridSlots.filter((region) =>'
)
replace_once(
    "receive/main.js",
    '''  const provisionalNeedsDiscovery = preLatticeDiscovery && (\n    !lastGridSnapshot || !captureHasTrackedWork || provisionalUnknownVisible.length > 0 ||\n    now - lastFullScan > GEOMETRY_PROBE_SILENCE_MS\n  );''',
    '''  const provisionalNeedsDiscovery = acquisitionDiscovery && (\n    geometryBootstrap || !lastGridSnapshot || !captureHasTrackedWork || provisionalUnknownVisible.length > 0 ||\n    now - lastFullScan > GEOMETRY_PROBE_SILENCE_MS\n  );'''
)
replace_once(
    "receive/main.js",
    '''      : preLatticeDiscovery\n        ? provisionalNeedsDiscovery && acquisitionInFlight < acquisitionLimit''',
    '''      : acquisitionDiscovery\n        ? provisionalNeedsDiscovery && acquisitionInFlight < acquisitionLimit'''
)
replace_once(
    "receive/main.js",
    '    if (!captureNextScan && preLatticeDiscovery && !lastGridSnapshot && !fullFrameSeed) {',
    '    if (!captureNextScan && acquisitionDiscovery && (!lastGridSnapshot || geometryBootstrap && provisionalUnknownVisible.length === 0) && !fullFrameSeed) {'
)
replace_once(
    "receive/main.js",
    '    const provisionalCrop = preLatticeDiscovery && provisionalUnknownVisible.length > 0;',
    '    const provisionalCrop = acquisitionDiscovery && provisionalUnknownVisible.length > 0;'
)

# Surface whether the current wall fit is globally constrained so hardware traces
# make partial-lattice traps obvious.
replace_once(
    "receive/main.js",
    '''Geometry ${lastGridSnapshot ? `${lastGridSnapshot.provisional ? "provisional · " : ""}${lastGridSnapshot.observedSlots ?? 0}/${lastGridSnapshot.slots.length} fresh · calibrated ${lastGridSnapshot.correctedSlots ?? 0}/${lastGridSnapshot.slots.length} · global fit ${((lastGridSnapshot.fitError ?? 0) * 100).toFixed(1)}%` : "no lattice"}''',
    '''Geometry ${lastGridSnapshot ? `${lastGridSnapshot.provisional ? "provisional · " : ""}${lastGridSnapshot.observedSlots ?? 0}/${lastGridSnapshot.slots.length} fresh · calibrated ${lastGridSnapshot.correctedSlots ?? 0}/${lastGridSnapshot.slots.length} · fit ${lastGridSnapshot.distributedFit ? "distributed" : "local"} · global fit ${((lastGridSnapshot.fitError ?? 0) * 100).toFixed(1)}%` : "no lattice"}'''
)

# Version/cache bust. Sender behavior is unchanged from v274.
replace_once("main.js", 'const APP_BUILD = "v0.5.274";', 'const APP_BUILD = "v0.5.275";')
replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.274";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.275";')
replace_once("send/main.js", 'const SEND_RUNTIME_BUILD = "v0.5.274";', 'const SEND_RUNTIME_BUILD = "v0.5.275";')
replace_once("index.html", 'v0.5.274</span>', 'v0.5.275</span>')
replace_once("index.html", './main.js?build=v0.5.274', './main.js?build=v0.5.275')
replace_once("sw.js", 'airgapper-static-js-v222', 'airgapper-static-js-v223')
