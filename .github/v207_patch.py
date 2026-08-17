from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"replacement not found in {path}: {old[:220]!r}")
    p.write_text(s.replace(old, new, count))


replace("index.html", "v0.5.206", "v0.5.207")
replace("main.js", 'const APP_BUILD = "v0.5.206";', 'const APP_BUILD = "v0.5.207";')
replace("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.206";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.207";')
replace("sw.js", 'const CACHE = "airgapper-static-js-v168";', 'const CACHE = "airgapper-static-js-v169";')

# Six workers finish out of order. Geometry is camera-time state, so a late
# completion must never replace a newer observation or move lastHitAt backward.
grid = Path("receive/grid-lattice.js")
s = grid.read_text()
old = '''    this.frameWidth = Math.max(1, frameWidth);\n    this.frameHeight = Math.max(1, frameHeight);\n    this.lastHitAt = detection.at;\n    if (this.candidate && this.candidate.layout.id !== declaredLayout.id) {'''
new = '''    this.frameWidth = Math.max(1, frameWidth);\n    this.frameHeight = Math.max(1, frameHeight);\n    const packetIsCurrent = detection.at >= this.lastHitAt;\n    this.lastHitAt = Math.max(this.lastHitAt, detection.at);\n    if (this.candidate && this.candidate.layout.id !== declaredLayout.id) {'''
if old not in s: raise SystemExit("grid lastHitAt block missing")
s = s.replace(old, new, 1)

old = '''    // makeCandidate only uses the newest observation for each slot. Storing a\n    // raw last-N stream was therefore both wasted memory and actively harmful:\n    // a few easy QRs decoded every frame could evict the last good geometry for\n    // the other cells. Keep exactly one CRC-backed observation per slot.\n    this.observations = this.observations.filter((item) =>\n      detection.at - item.at < OBSERVATION_HISTORY_MS &&\n      item.modules === detection.modules &&\n      item.slotIndex !== detection.slotIndex\n    );\n    this.observations.push(detection);'''
new = '''    // Worker completions are not camera ordered. A slow older job must never\n    // replace a newer observation for the same slot. History is also pruned\n    // relative to the newest packet seen by the lattice, not the arrival order.\n    const previousSlot = this.observations.find((item) => item.slotIndex === detection.slotIndex);\n    const slotGeometryIsFresh = !previousSlot ||\n      detection.at > previousSlot.at ||\n      detection.at === previousSlot.at && detection.scanId >= previousSlot.scanId;\n    if (!slotGeometryIsFresh) return this.candidate ? this.snapshot() : null;\n    this.observations = this.observations.filter((item) =>\n      this.lastHitAt - item.at < OBSERVATION_HISTORY_MS &&\n      item.modules === detection.modules &&\n      item.slotIndex !== detection.slotIndex\n    );\n    this.observations.push(detection);'''
if old not in s: raise SystemExit("grid observation replacement block missing")
s = s.replace(old, new, 1)

s = s.replace(
'''      this.transition("TRACK", "valid packet refreshed locked lattice", detection.at);''',
'''      if (packetIsCurrent) this.transition("TRACK", "valid packet refreshed locked lattice", detection.at);''', 1)
s = s.replace(
'''    this.learnSlotCorrection(detection);\n    return this.snapshot();''',
'''    if (packetIsCurrent) this.learnSlotCorrection(detection);\n    return this.snapshot();''', 1)
old = '''  noteValidPacket(at = this.lastHitAt) {\n    if (!this.candidate) return null;\n    this.lastHitAt = at;\n    if (this.locked) this.transition("TRACK", "valid predicted packet kept lattice alive", at);\n    return this.snapshot();\n  }'''
new = '''  noteValidPacket(at = this.lastHitAt) {\n    if (!this.candidate) return null;\n    const packetIsCurrent = at >= this.lastHitAt;\n    this.lastHitAt = Math.max(this.lastHitAt, at);\n    if (packetIsCurrent && this.locked)\n      this.transition("TRACK", "valid predicted packet kept lattice alive", at);\n    return this.snapshot();\n  }'''
if old not in s: raise SystemExit("grid noteValidPacket block missing")
s = s.replace(old, new, 1)
grid.write_text(s)

# Coverage health is also temporal state. Ignore late completions from older job
# IDs so they cannot resurrect a stale bad streak after a newer healthy frame.
main = Path("receive/main.js")
s = main.read_text()
s = s.replace(
'''let geometryCoverageCollapseStartedAt = 0;\nlet recoveryWorkerRestarts = 0;''',
'''let geometryCoverageCollapseStartedAt = 0;\nlet geometryCoverageLastScanId = -1;\nlet recoveryWorkerRestarts = 0;''', 1)
s = s.replace(
'''  if (!replayRunning && auditThisCompletion && !auditMode?.full && gridLattice.locked &&\n      auditMode.tracks >= GEOMETRY_COLLAPSE_MIN_TRACKS) {\n    const now = receiverNow();''',
'''  if (!replayRunning && auditThisCompletion && !auditMode?.full && gridLattice.locked &&\n      auditMode.tracks >= GEOMETRY_COLLAPSE_MIN_TRACKS && id >= geometryCoverageLastScanId) {\n    geometryCoverageLastScanId = id;\n    const now = receiverNow();''', 1)
# Reset ordering guard with each diagnostic/recovery epoch.
s = s.replace(
'''  geometryCoverageCollapseStartedAt = 0;\n  recoveryWorkerRestarts = 0;''',
'''  geometryCoverageCollapseStartedAt = 0;\n  geometryCoverageLastScanId = -1;\n  recoveryWorkerRestarts = 0;''', 1)
s = s.replace(
'''  geometryCoverageCollapseStartedAt = 0;\n  decoderFreshnessHoldActive = false;''',
'''  geometryCoverageCollapseStartedAt = 0;\n  geometryCoverageLastScanId = -1;\n  decoderFreshnessHoldActive = false;''', 1)
# Clean indentation from v206's deliberately broad timestamp reset insertion.
s = s.replace('      geometryCoverageCollapseLastAt = 0;\n  geometryCoverageCollapseStartedAt = 0;',
              '      geometryCoverageCollapseLastAt = 0;\n      geometryCoverageCollapseStartedAt = 0;')
main.write_text(s)
