from pathlib import Path
import re

root = Path('.')
main = root / 'receive/main.js'
grid = root / 'receive/grid-lattice.js'

s = main.read_text()

old = '''let geometryRecoveryProbes = 0;\nlet geometryRecoveryResets = 0;\nlet recoveryWorkerRestarts = 0;'''
new = '''let geometryRecoveryProbes = 0;\nlet geometryRecoveryResets = 0;\nlet geometrySightingNudges = 0;\nlet recoveryWorkerRestarts = 0;'''
assert old in s
s = s.replace(old, new, 1)

old = '''  benchmarkJobFrames.delete(id);\n  const fullJob = fullScanJobs.get(id);\n  fullScanIds.delete(id);'''
new = '''  benchmarkJobFrames.delete(id);\n  const fullJob = fullScanJobs.get(id);\n  // A recovery finder pass can fail payload/RS decode while still locating\n  // several QR bodies accurately. Once a wall has been proven, use that\n  // coherent positional evidence to recenter the stored lattice instead of\n  // throwing it away and waiting for a lucky full payload decode.\n  if (fullJob?.reacquire && completion.symbolCount === 0 && completion.sightings?.length) {\n    const nudged = gridLattice.nudgeFromSightings(completion.sightings, receiverNow());\n    if (nudged) {\n      geometrySightingNudges++;\n      syncGrid(nudged, receiverNow());\n      notePipelineEvent("sighting-lattice-nudge", geometrySightingNudges);\n      lastRecoveryReason = `finder sightings recentered locked lattice (${geometrySightingNudges})`;\n    }\n  }\n  fullScanIds.delete(id);'''
assert old in s
s = s.replace(old, new, 1)

old = '''`Recovery probes ${geometryRecoveryProbes} · resets ${geometryRecoveryResets} · worker restarts ${recoveryWorkerRestarts}'''
new = '''`Recovery probes ${geometryRecoveryProbes} · sighting nudges ${geometrySightingNudges} · resets ${geometryRecoveryResets} · worker restarts ${recoveryWorkerRestarts}'''
assert old in s
s = s.replace(old, new, 1)

main.write_text(s)

g = grid.read_text()
needle = '''  noteMissing(anyMissing, now = this.lastHitAt) {\n    if (!this.locked) return;\n    this.transition(anyMissing ? "PARTIAL_LOSS" : "TRACK", anyMissing ? "one or more predicted slots missing" : "all predicted slots healthy", now);\n  }\n  makeCandidate(layout) {'''
insert = '''  noteMissing(anyMissing, now = this.lastHitAt) {\n    if (!this.locked) return;\n    this.transition(anyMissing ? "PARTIAL_LOSS" : "TRACK", anyMissing ? "one or more predicted slots missing" : "all predicted slots healthy", now);\n  }\n  nudgeFromSightings(sightings, at = this.lastHitAt) {\n    if (!this.locked || !this.candidate || !Array.isArray(sightings) || !sightings.length) return null;\n    const snapshot = this.snapshot();\n    if (!snapshot) return null;\n    const validBox = (box) => box && [box.x, box.y, box.w, box.h].every(Number.isFinite) &&\n      box.w >= 20 && box.h >= 20 && Math.max(box.w / box.h, box.h / box.w) < 2.4;\n    const candidates = snapshot.slots.filter((slot) => validBox(slot.box));\n    if (!candidates.length) return null;\n    const unused = new Set(candidates.map((slot) => slot.index));\n    const matches = [];\n    // Greedy nearest-neighbor matching is intentionally conservative. Finder\n    // sightings contain no identity/CRC, so require similar size, proximity to\n    // an already-proven slot, and later a coherent multi-sighting translation.\n    for (const sighting of sightings.filter(validBox)) {\n      const sx = sighting.x + sighting.w / 2;\n      const sy = sighting.y + sighting.h / 2;\n      let best = null;\n      for (const slot of candidates) {\n        if (!unused.has(slot.index)) continue;\n        const box = slot.box;\n        const px = box.x + box.w / 2;\n        const py = box.y + box.h / 2;\n        const edge = Math.max(24, Math.sqrt(box.w * box.h));\n        const ratio = Math.sqrt(sighting.w * sighting.h / Math.max(1, box.w * box.h));\n        if (ratio < 0.5 || ratio > 1.9) continue;\n        const distance = Math.hypot(sx - px, sy - py);\n        if (distance > edge * 0.9) continue;\n        const score = distance / edge + Math.abs(Math.log(ratio)) * 0.55;\n        if (!best || score < best.score) {\n          best = { slot, dx: sx - px, dy: sy - py, ratio, edge, score };\n        }\n      }\n      if (best) {\n        unused.delete(best.slot.index);\n        matches.push(best);\n      }\n    }\n    const wallCount = snapshot.layout.cols * snapshot.layout.rows;\n    const minimumMatches = wallCount <= 1 ? 1 : 2;\n    if (matches.length < minimumMatches) return null;\n    const median = (values) => {\n      const sorted = [...values].sort((a, b) => a - b);\n      const mid = Math.floor(sorted.length / 2);\n      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;\n    };\n    let dx = median(matches.map((match) => match.dx));\n    let dy = median(matches.map((match) => match.dy));\n    const edge = median(matches.map((match) => match.edge));\n    let inliers = matches.filter((match) => Math.hypot(match.dx - dx, match.dy - dy) <= edge * 0.3);\n    if (inliers.length < minimumMatches) return null;\n    dx = median(inliers.map((match) => match.dx));\n    dy = median(inliers.map((match) => match.dy));\n    const shift = Math.hypot(dx, dy);\n    // Ignore sub-pixel/no-op results and large jumps that are more likely to be\n    // a different object/grid. This is a rescue nudge, never reacquisition.\n    if (shift < 1 || shift > edge * 0.72) return null;\n    const bySlot = new Map(inliers.map((match) => [match.slot.index, match]));\n    const movePoint = (point, mx, my, scale, cx, cy) => ({\n      x: cx + (point.x - cx) * scale + mx,\n      y: cy + (point.y - cy) * scale + my\n    });\n    this.observations = this.observations.map((observation) => {\n      const match = bySlot.get(observation.slotIndex);\n      const mx = match ? match.dx : dx;\n      const my = match ? match.dy : dy;\n      // A sighting's bounding box can estimate a small zoom change, but clamp\n      // it tightly because failed finder geometry is noisier than CRC geometry.\n      const scale = match ? Math.max(0.92, Math.min(1.08, match.ratio)) : 1;\n      const box = observation.box;\n      const cx = box.x + box.w / 2;\n      const cy = box.y + box.h / 2;\n      const points = corners(observation.quad).map((point) => movePoint(point, mx, my, scale, cx, cy));\n      const quad = { topLeft: points[0], topRight: points[1], bottomRight: points[2], bottomLeft: points[3] };\n      return { ...observation, quad, box: bounds(quad) };\n    });\n    const updated = this.makeCandidate(this.candidate.layout);\n    if (!updated) return null;\n    this.candidate = updated;\n    // Deliberately do not advance lastHitAt: finder-only evidence may reposition\n    // a proven wall, but only a valid AirGapper packet may keep it alive.\n    this.transition("PARTIAL_LOSS", "finder sightings recentered locked lattice", at);\n    return this.snapshot();\n  }\n  makeCandidate(layout) {'''
assert needle in g
g = g.replace(needle, insert, 1)
grid.write_text(g)

# Version/cache bump.
for name in ['index.html', 'main.js', 'receive/main.js']:
    p = root / name
    text = p.read_text()
    assert 'v0.5.144' in text, name
    p.write_text(text.replace('v0.5.144', 'v0.5.145'))

sw = root / 'sw.js'
text = sw.read_text()
m = re.search(r'airgapper-static-js-v(\d+)', text)
assert m
text = text[:m.start(1)] + str(int(m.group(1)) + 1) + text[m.end(1):]
sw.write_text(text)
