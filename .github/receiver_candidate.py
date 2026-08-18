from pathlib import Path
import re


def rep(path, old, new):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f'missing anchor {path}: {old[:180]}')
    p.write_text(s.replace(old, new, 1))


def rx(path, pattern, replacement, flags=re.S):
    p = Path(path)
    s = p.read_text()
    out, count = re.subn(pattern, replacement, s, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f'regex anchor failed {path}: {pattern[:160]} ({count})')
    p.write_text(out)


# Version/cache.
rep('receive/main.js', 'const RECEIVER_RUNTIME_BUILD = "v0.5.282";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.283";')
rep('main.js', 'const APP_BUILD = "v0.5.282";', 'const APP_BUILD = "v0.5.283";')
rep('index.html', 'main.js?build=v0.5.282', 'main.js?build=v0.5.283')
rep('sw.js', 'airgapper-static-js-v230', 'airgapper-static-js-v231')

# 1) Every CRC-valid Guided output is current-frame motion evidence. v282 only
# used predicted Turbo outputs; measured profile/finder quads suppressed the fit.
p = Path('receive/worker.js')
s = p.read_text()
s = s.replace(
    '  const predictedMotion = [];\n  let measuredGeometryCount = 0;',
    '  const wallMotionSamples = [];',
    1
)
if 'const wallMotionSamples = [];' not in s:
    raise SystemExit('guided motion declaration anchor missing')
pattern = r'''    const outputQuad = shifted\(quad, ox, oy\);\n    const geometryMeasured = status === NATIVE_TRACK_OK;\n    if \(geometryMeasured\) \{.*?\n    \}\n    symbols\.push\(\{'''
replacement = '''    const outputQuad = shifted(quad, ox, oy);\n    const geometryMeasured = status === NATIVE_TRACK_OK;\n    const input = trackBySlot.get(slot);\n    if (input?.quad && validQuad(input.quad)) {\n      const names = ["topLeft", "topRight", "bottomRight", "bottomLeft"];\n      const dx = names.reduce((sum, name) => sum + outputQuad[name].x - input.quad[name].x, 0) / names.length;\n      const dy = names.reduce((sum, name) => sum + outputQuad[name].y - input.quad[name].y, 0) / names.length;\n      if (Number.isFinite(dx) && Number.isFinite(dy) && Math.hypot(dx, dy) <= 5.1) {\n        const points = [input.quad.topLeft, input.quad.topRight, input.quad.bottomRight, input.quad.bottomLeft];\n        const x = points.reduce((sum, point) => sum + point.x, 0) / points.length;\n        const y = points.reduce((sum, point) => sum + point.y, 0) / points.length;\n        const edge = points.reduce((sum, point, index) => {\n          const next = points[(index + 1) % points.length];\n          return sum + Math.hypot(next.x - point.x, next.y - point.y);\n        }, 0) / points.length;\n        wallMotionSamples.push({ dx, dy, x, y, edge, slot, measured: geometryMeasured });\n      }\n    }\n    symbols.push({'''
s, count = re.subn(pattern, replacement, s, count=1, flags=re.S)
if count != 1:
    raise SystemExit('guided measured/predicted motion block missing')
s = s.replace('predictedMotion', 'wallMotionSamples')
s = s.replace('if (!measuredGeometryCount && wallMotionSamples.length >= 2) {', 'if (wallMotionSamples.length >= 2) {', 1)
s = s.replace(
    '      for (const symbol of symbols) if (symbol.geometryMeasured === false) symbol.wallMotion = wallMotion;',
    '      for (const symbol of symbols) symbol.wallMotion = wallMotion;',
    1
)
if 'measuredGeometryCount' in s or 'predictedMotion' in s:
    raise SystemExit('old guided motion gating survived')
p.write_text(s)

# Apply the coherent frame motion once before branching exact-vs-predicted.
p = Path('receive/main.js')
s = p.read_text()
pattern = r'''    const geometryInfo = \{ \.\.\.info, crc32: true \};\n    if \(info\?\.geometryMeasured === false\) \{\n      const sourceSequence = Number\(info\?\.sourceSequence\);\n      const motion = info\?\.wallMotion;\n      if \(Number\.isFinite\(sourceSequence\).*?\n      \}\n      gridLattice\.noteValidPacket\(packetAt\);'''
replacement = '''    const geometryInfo = { ...info, crc32: true };\n    const sourceSequence = Number(info?.sourceSequence);\n    const motion = info?.wallMotion;\n    if (Number.isFinite(sourceSequence) && sourceSequence > geometryMotionLastSourceSequence &&\n        motion && Number(motion.samples) >= 2 && Number.isFinite(motion.dx) && Number.isFinite(motion.dy)) {\n      geometryMotionLastSourceSequence = sourceSequence;\n      const hasSimilarity = [motion.a, motion.b, motion.tx, motion.ty].every((value) => Number.isFinite(Number(value)));\n      const motionSnapshot = hasSimilarity\n        ? gridLattice.nudgeMotion(motion, packetAt)\n        : gridLattice.nudgeTranslation(Number(motion.dx), Number(motion.dy), packetAt);\n      if (motionSnapshot) {\n        geometryMotionNudges++;\n        const scale = hasSimilarity ? Math.hypot(Number(motion.a), Number(motion.b)) : 1;\n        const rotation = hasSimilarity ? Math.abs(Math.atan2(Number(motion.b), Number(motion.a))) : 0;\n        if (hasSimilarity && (Math.abs(scale - 1) >= 0.0005 || rotation >= 0.0005))\n          geometrySimilarityNudges++;\n        geometryMotionPixels += Number.isFinite(Number(motion.maxShift))\n          ? Number(motion.maxShift)\n          : Math.hypot(Number(motion.dx), Number(motion.dy));\n        syncGrid(motionSnapshot, decodedAt);\n      }\n    }\n    if (info?.geometryMeasured === false) {\n      gridLattice.noteValidPacket(packetAt);'''
s, count = re.subn(pattern, replacement, s, count=1, flags=re.S)
if count != 1:
    raise SystemExit('main shared wall-motion block missing')

# 2) Slot hit accounting must use packet identity, never moving box ownership.
old = '    const hit = completion.symbols.some((symbol) => symbol.box && regionAt(symbol.box) === region);'
new = '''    const hit = completion.symbols.some((symbol) => {\n      const decodedSlot = Number(symbol.header?.slotIndex);\n      if (region.gridSlot !== void 0 && Number.isInteger(decodedSlot)) return decodedSlot === region.gridSlot;\n      return Boolean(symbol.box && regionAt(symbol.box) === region);\n    });'''
if old not in s:
    raise SystemExit('slot completion attribution anchor missing')
s = s.replace(old, new, 1)

# 3) Pass the ranked weak targets into the full recovery worker so it can search
# isolated subrectangles inside the already-copied broad Y plane.
old = '''    const directFull = source.videoFrame && !source.image && !captureNextScan\n      ? mappedDirectTrackedFrame(source, scanX, scanY, scanW, scanH, [])\n      : null;'''
new = '''    const recoveryTracks = localRecoverySeedScan ? boundedScanCandidates.map((region) => ({\n      id: region.id, slot: region.gridSlot, misses: region.consecutiveMisses,\n      quad: region.quad, dim: region.dim, crc32: Boolean(region.crc32)\n    })) : [];\n    const directFull = source.videoFrame && !source.image && !captureNextScan\n      ? mappedDirectTrackedFrame(source, scanX, scanY, scanW, scanH, recoveryTracks)\n      : null;'''
if old not in s:
    raise SystemExit('direct recovery target anchor missing')
s = s.replace(old, new, 1)
s = s.replace(
    '          outputMap: directFull.outputMap,\n          acquisitionMode',
    '          outputMap: directFull.outputMap,\n          tracks: directFull.tracks,\n          acquisitionMode',
    1
)
s = s.replace(
    '{ id, buf: img.data.buffer, w: scanW, h: scanH, ox: scanX, oy: scanY, full: true, acquisitionMode },',
    '{ id, buf: img.data.buffer, w: scanW, h: scanH, ox: scanX, oy: scanY, full: true, tracks: recoveryTracks, acquisitionMode },',
    1
)
p.write_text(s)

# Targeted zero-copy Y8 recovery. Filter each local finder result by the QR's
# declared slot so an easy neighbor cannot masquerade as recovery success.
p = Path('receive/worker.js')
s = p.read_text()
s = s.replace(
    '  let readFullAttempts = 0;',
    '  let readFullAttempts = 0;\n  let targetedAttempts = 0;\n  let targetedPixels = 0;\n  let targetedSuccesses = 0;',
    1
)
pattern = r'''      const appendResults = \(vec, includeErrors\) => \{.*?\n      \};\n      if \(full\) \{'''
replacement = '''      const appendResults = (vec, includeErrors, resultOx = ox, resultOy = oy, expectedSlot) => {\n        try {\n          for (let i = 0; i < vec.size(); i++) {\n            const r = vec.get(i);\n            if (r.valid && r.bytes.length > 0 && validQuad(r.position)) {\n              const packet = expectedSlot === void 0 ? null : parseFrame(r.bytes);\n              if (expectedSlot !== void 0 && packet?.header.slotIndex !== expectedSlot) continue;\n              symbols.push({\n                bytes: r.bytes,\n                box: boundsOf(r.position, resultOx, resultOy),\n                quad: shifted(r.position, resultOx, resultOy),\n                modules: r.modules,\n                tracked: false,\n                decodePath: full ? "acquire" : "fallback",\n                header: packet?.header\n              });\n            } else if (includeErrors) {\n              const box = boundsOf(r.position, resultOx, resultOy);\n              if (box && box.w > 0 && box.h > 0) sightings.push(box);\n            }\n          }\n        } finally {\n          vec.delete();\n        }\n      };\n      if (full) {'''
s, count = re.subn(pattern, replacement, s, count=1, flags=re.S)
if count != 1:
    raise SystemExit('appendResults anchor missing')
old = '''        } else if (fullMode === "recovery") {\n          readFullAttempts++;\n          appendResults(readDenseSeed(3), false);\n        } else {'''
new = '''        } else if (fullMode === "recovery") {\n          if (decodePixelFormat === "y8" && Array.isArray(tracks) && tracks.length) {\n            for (const target of tracks.slice(0, 3)) {\n              const local = localQuad(target.quad, ox, oy);\n              const box = local && boundsOf(local, 0, 0);\n              const expectedSlot = Number(target.slot);\n              if (!box || !Number.isInteger(expectedSlot)) continue;\n              const edge = Math.max(box.w, box.h);\n              const pad = Math.max(20, edge * 0.45);\n              const rx = Math.max(0, Math.floor(box.x - pad));\n              const ry = Math.max(0, Math.floor(box.y - pad));\n              const rr = Math.min(pw, Math.ceil(box.x + box.w + pad));\n              const rb = Math.min(ph, Math.ceil(box.y + box.h + pad));\n              const rw = rr - rx, rh = rb - ry;\n              if (rw < 32 || rh < 32) continue;\n              targetedAttempts++;\n              targetedPixels += rw * rh;\n              readFullAttempts++;\n              const before = symbols.length;\n              appendResults(\n                zx.readDenseY(ptr + inputOffset + ry * inputStride + rx, rw, rh, inputStride, 4),\n                false, ox + rx, oy + ry, expectedSlot\n              );\n              if (symbols.length > before) targetedSuccesses++;\n            }\n          }\n          if (!targetedAttempts || targetedSuccesses === 0) {\n            readFullAttempts++;\n            appendResults(readDenseSeed(1), false);\n          }\n        } else {'''
if old not in s:
    raise SystemExit('recovery branch anchor missing')
s = s.replace(old, new, 1)
# Add metrics to the generic final worker reply (last matching reply block).
old = '''      readFullAttempts,\n      workerWaitMs,\n      latencyMs: performance.now() - startedAt'''
new = '''      readFullAttempts,\n      workerWaitMs,\n      targetedAttempts,\n      targetedPixels,\n      targetedSuccesses,\n      latencyMs: performance.now() - startedAt'''
pos = s.rfind(old)
if pos < 0:
    raise SystemExit('final worker reply anchor missing')
s = s[:pos] + s[pos:].replace(old, new, 1)
p.write_text(s)

# Existing lattice regression already tests similarity transforms. Add the exact
# sequencing v283 uses: frame nudge followed by a measured packet.
p = Path('benchmark/grid-lattice-regression.mjs')
s = p.read_text()
anchor = '''assert.equal(lattice.nudgeMotion({ a: 1.2, b: 0, tx: 0, ty: 0, dx: 1, dy: 1, maxShift: 2, samples: 4 }, 1440), null,\n  "unsafe scale jumps must be rejected");\n\nconsole.log("grid-lattice regression: ok");'''
insert = '''assert.equal(lattice.nudgeMotion({ a: 1.2, b: 0, tx: 0, ty: 0, dx: 1, dy: 1, maxShift: 2, samples: 4 }, 1440), null,\n  "unsafe scale jumps must be rejected");\n\nsnapshot = lattice.accept(detection(0, 1460, { dx: 154, dy: 98 }), frameWidth, frameHeight);\nassert(snapshot, "measured geometry after a coherent frame nudge must remain usable");\nassert.equal(lattice.locked, true);\nassert.equal(snapshot.distributedFit, true);\n\nconsole.log("grid-lattice regression: ok");'''
if anchor not in s:
    raise SystemExit('grid regression anchor missing')
p.write_text(s.replace(anchor, insert, 1))
