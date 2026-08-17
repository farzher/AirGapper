from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"replacement not found in {path}: {old[:240]!r}")
    p.write_text(s.replace(old, new, count))

replace("index.html", "v0.5.203", "v0.5.204")
replace("main.js", 'const APP_BUILD = "v0.5.203";', 'const APP_BUILD = "v0.5.204";')
replace("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.203";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.204";')
replace("sw.js", 'const CACHE = "airgapper-static-js-v165";', 'const CACHE = "airgapper-static-js-v166";')

grid = Path("receive/grid-lattice.js")
s = grid.read_text()
old = '''    // The whole-grid homography is a prediction model, not a replacement for\n    // measured per-QR geometry. Real phone lenses distort a large QR field in\n    // ways a single projective transform cannot represent. Once a slot has\n    // actually decoded, keep that exact CRC-backed quad and use the lattice\n    // only for cells that have not yet been observed.\n    const newestAt = candidate.observations.reduce((latest, observation) => Math.max(latest, observation.at), 0);\n    // Exact per-QR geometry is best only while it is fresh. After camera motion,\n    // the current lattice projection is a better aim point than a formerly exact\n    // quad from another pose. This also lets a fresh decode on one part of the\n    // wall move stale cells immediately instead of waiting for each cell to win.'''
new = '''    // The whole-grid homography owns frame-to-frame pose. CRC-backed local\n    // observations remain useful for freshness/identity and for learning the\n    // persistent per-slot lens residual, but raw one-frame quads are never\n    // published directly into the tracking hot path.\n    const newestAt = candidate.observations.reduce((latest, observation) => Math.max(latest, observation.at), 0);\n    // Freshness still records which slots have recently decoded; geometry is\n    // global pose plus the slowly learned local correction below.'''
if old not in s: raise SystemExit("snapshot comment block missing")
s = s.replace(old, new, 1)

old = '''    const slots = [];\n    for (let index = 0; index < count; index++) {\n      // Never publish a raw per-frame QR quad.'''
new = '''    const slots = [];\n    for (let index = 0; index < count; index++) {\n      const observation = observed.get(index);\n      // Never publish a raw per-frame QR quad.'''
if old not in s: raise SystemExit("snapshot loop missing")
s = s.replace(old, new, 1)
grid.write_text(s)
