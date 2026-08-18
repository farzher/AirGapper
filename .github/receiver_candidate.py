from pathlib import Path


def rep(path, old, new):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f'missing anchor {path}: {old[:120]}')
    p.write_text(s.replace(old, new, 1))

# Version/cache.
rep('receive/main.js', 'const RECEIVER_RUNTIME_BUILD = "v0.5.278";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.279";')
rep('main.js', 'const APP_BUILD = "v0.5.278";', 'const APP_BUILD = "v0.5.279";')
p = Path('index.html'); s = p.read_text()
if s.count('v0.5.278') < 2: raise SystemExit('index version anchors missing')
p.write_text(s.replace('v0.5.278', 'v0.5.279'))
rep('sw.js', 'airgapper-static-js-v226', 'airgapper-static-js-v227')

# Guided already returns CRC-valid predicted quads shifted by its current-frame
# wall correction. Recover a coherent batch translation from those results.
p = Path('receive/worker.js'); s = p.read_text()
rep_anchor = '''  let decodedSlotsMask = 0;\n  for (let i = 0; i < count; i++) {'''
rep_value = '''  let decodedSlotsMask = 0;\n  const trackBySlot = new Map(tracks.map((track) => [Number(track.slot ?? track.id), track]));\n  const predictedMotion = [];\n  let measuredGeometryCount = 0;\n  for (let i = 0; i < count; i++) {'''
if rep_anchor not in s: raise SystemExit('worker motion declarations anchor missing')
s = s.replace(rep_anchor, rep_value, 1)
old = '''    if (!validQuad(quad)) continue;\n    symbols.push({\n      bytes,\n      box: boundsOf(quad, ox, oy),\n      quad: shifted(quad, ox, oy),\n      modules,\n      tracked: true,\n      geometryMeasured: status === NATIVE_TRACK_OK,\n      decodePath,\n      header: packet.header\n    });\n  }\n  return { symbols, metrics };\n}'''
new = '''    if (!validQuad(quad)) continue;\n    const outputQuad = shifted(quad, ox, oy);\n    const geometryMeasured = status === NATIVE_TRACK_OK;\n    if (geometryMeasured) {\n      measuredGeometryCount++;\n    } else {\n      const input = trackBySlot.get(slot);\n      if (input?.quad && validQuad(input.quad)) {\n        const names = ["topLeft", "topRight", "bottomRight", "bottomLeft"];\n        const dx = names.reduce((sum, name) => sum + outputQuad[name].x - input.quad[name].x, 0) / names.length;\n        const dy = names.reduce((sum, name) => sum + outputQuad[name].y - input.quad[name].y, 0) / names.length;\n        if (Number.isFinite(dx) && Number.isFinite(dy) && Math.hypot(dx, dy) <= 4.75)\n          predictedMotion.push({ dx, dy });\n      }\n    }\n    symbols.push({\n      bytes,\n      box: boundsOf(quad, ox, oy),\n      quad: outputQuad,\n      modules,\n      tracked: true,\n      geometryMeasured,\n      decodePath,\n      header: packet.header\n    });\n  }\n  // Full measured geometry wins. Otherwise, two or more CRC-valid predicted\n  // QRs agreeing on the same small current-frame offset are strong wall-motion\n  // evidence. Median + tight consensus rejects per-slot/local residual outliers.\n  if (!measuredGeometryCount && predictedMotion.length >= 2) {\n    const median = (values) => {\n      const sorted = [...values].sort((a, b) => a - b);\n      const mid = sorted.length >> 1;\n      return sorted.length & 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;\n    };\n    const dx = median(predictedMotion.map((item) => item.dx));\n    const dy = median(predictedMotion.map((item) => item.dy));\n    const coherent = predictedMotion.filter((item) => Math.hypot(item.dx - dx, item.dy - dy) <= 0.75);\n    const need = Math.max(2, Math.ceil(predictedMotion.length * 0.6));\n    if (coherent.length >= need && Math.hypot(dx, dy) <= 4.5) {\n      const wallMotion = { dx, dy, samples: coherent.length };\n      for (const symbol of symbols) if (symbol.geometryMeasured === false) symbol.wallMotion = wallMotion;\n    }\n  }\n  return { symbols, metrics };\n}'''
if old not in s: raise SystemExit('worker result anchor missing')
s = s.replace(old, new, 1)
p.write_text(s)

# Carry the motion hint through the pool alongside the existing sourceSequence.
rep('shared/worker-pool.js', '            geometryMeasured: symbol.geometryMeasured !== false,\n            decodePath: symbol.decodePath,', '            geometryMeasured: symbol.geometryMeasured !== false,\n            wallMotion: symbol.wallMotion,\n            decodePath: symbol.decodePath,')

# Add a translation-only lattice nudge. Shift the candidate transform and its
# historical measured anchors together so future fits remain in the current pose.
p = Path('receive/grid-lattice.js'); s = p.read_text()
anchor = '''  noteValidPacket(at = this.lastHitAt) {\n    if (!this.candidate) return false;\n    const packetIsCurrent = at >= this.lastHitAt;\n    this.lastHitAt = Math.max(this.lastHitAt, at);\n    if (packetIsCurrent && this.locked)\n      this.transition("TRACK", "valid predicted packet kept lattice alive", at);\n    return true;\n  }\n'''
insert = anchor + '''  nudgeTranslation(dx, dy, at = this.lastHitAt) {\n    if (!this.locked || !this.candidate || !Number.isFinite(dx) || !Number.isFinite(dy)) return null;\n    const distance = Math.hypot(dx, dy);\n    if (distance < 0.08 || distance > 4.5 || at < this.lastHitAt) return null;\n    const shiftQuad = (quad) => {\n      const points = corners(quad).map((point) => ({ x: point.x + dx, y: point.y + dy }));\n      return { topLeft: points[0], topRight: points[1], bottomRight: points[2], bottomLeft: points[3] };\n    };\n    const shiftObservation = (observation) => {\n      const quad = shiftQuad(observation.quad);\n      return { ...observation, quad, box: bounds(quad) };\n    };\n    this.observations = this.observations.map(shiftObservation);\n    const h = [...this.candidate.transform];\n    // Output translation of a projective transform: x'=(N/d)+dx, y'=(M/d)+dy.\n    h[0] += dx * h[6]; h[1] += dx * h[7]; h[2] += dx;\n    h[3] += dy * h[6]; h[4] += dy * h[7]; h[5] += dy;\n    this.candidate = {\n      ...this.candidate,\n      transform: h,\n      observations: this.candidate.observations.map(shiftObservation)\n    };\n    return this.snapshot();\n  }\n'''
if anchor not in s: raise SystemExit('lattice nudge insert anchor missing')
s = s.replace(anchor, insert, 1)
p.write_text(s)

# Main thread: source-ordered, once-per-camera-frame motion feedback. A measured
# QR from the same/newer frame suppresses the inferred nudge.
p = Path('receive/main.js'); s = p.read_text()
s = s.replace('''let geometryRecoveryProbes = 0;\nlet geometryRecoveryResets = 0;\nlet geometrySightingNudges = 0;''', '''let geometryRecoveryProbes = 0;\nlet geometryRecoveryResets = 0;\nlet geometrySightingNudges = 0;\nlet geometryMotionNudges = 0;\nlet geometryMotionPixels = 0;\nlet geometryMotionLastSourceSequence = -1;''', 1)
s = s.replace('''  geometryRecoveryProbes = 0;\n  geometryRecoveryResets = 0;\n  geometryCoverageHealthy = false;''', '''  geometryRecoveryProbes = 0;\n  geometryRecoveryResets = 0;\n  geometryMotionNudges = 0;\n  geometryMotionPixels = 0;\n  geometryMotionLastSourceSequence = -1;\n  geometryCoverageHealthy = false;''', 1)
old = '''    if (info?.geometryMeasured === false) {\n      gridLattice.noteValidPacket(packetAt);\n      decodedRegion = markGridRegionDecoded(\n        regions.find((region) => region.gridSlot === header.slotIndex),\n        decodedAt,\n        geometryInfo\n      );\n    } else if (box && validQuadObject(info?.quad) && info?.modules) {'''
new = '''    if (info?.geometryMeasured === false) {\n      const sourceSequence = Number(info?.sourceSequence);\n      const motion = info?.wallMotion;\n      if (Number.isFinite(sourceSequence) && sourceSequence > geometryMotionLastSourceSequence &&\n          motion && Number(motion.samples) >= 2 && Number.isFinite(motion.dx) && Number.isFinite(motion.dy)) {\n        geometryMotionLastSourceSequence = sourceSequence;\n        const snapshot = gridLattice.nudgeTranslation(Number(motion.dx), Number(motion.dy), packetAt);\n        if (snapshot) {\n          geometryMotionNudges++;\n          geometryMotionPixels += Math.hypot(Number(motion.dx), Number(motion.dy));\n          syncGrid(snapshot, decodedAt);\n        }\n      }\n      gridLattice.noteValidPacket(packetAt);\n      decodedRegion = markGridRegionDecoded(\n        regions.find((region) => region.gridSlot === header.slotIndex),\n        decodedAt,\n        geometryInfo\n      );\n    } else if (box && validQuadObject(info?.quad) && info?.modules) {\n      if (Number.isFinite(Number(info?.sourceSequence)))\n        geometryMotionLastSourceSequence = Math.max(geometryMotionLastSourceSequence, Number(info.sourceSequence));'''
if old not in s: raise SystemExit('main geometry branch anchor missing')
s = s.replace(old, new, 1)
# Add diagnostics beside recovery counters.
old = '`Recovery probes ${geometryRecoveryProbes} · assist ${geometryRecoveryAssistUntil > perfNow ? `${Math.max(0, geometryRecoveryAssistUntil - perfNow).toFixed(0)}ms` : "no"} · sighting nudges ${geometrySightingNudges} · resets ${geometryRecoveryResets}'
new = '`Recovery probes ${geometryRecoveryProbes} · assist ${geometryRecoveryAssistUntil > perfNow ? `${Math.max(0, geometryRecoveryAssistUntil - perfNow).toFixed(0)}ms` : "no"} · motion ${geometryMotionNudges}/${geometryMotionPixels.toFixed(0)}px · sighting nudges ${geometrySightingNudges} · resets ${geometryRecoveryResets}'
if old not in s: raise SystemExit('diagnostic recovery anchor missing')
s = s.replace(old, new, 1)
p.write_text(s)
