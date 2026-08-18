from pathlib import Path


def rep(path, old, new):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f'missing anchor {path}: {old[:180]}')
    p.write_text(s.replace(old, new, 1))


# Version/cache.
rep('receive/main.js', 'const RECEIVER_RUNTIME_BUILD = "v0.5.282";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.283";')
rep('main.js', 'const APP_BUILD = "v0.5.282";', 'const APP_BUILD = "v0.5.283";')
rep('index.html', 'main.js?build=v0.5.282', 'main.js?build=v0.5.283')
rep('sw.js', 'airgapper-static-js-v230', 'airgapper-static-js-v231')


# ---------------------------------------------------------------------------
# 1. Guided current-frame geometry is wall-motion evidence too.
#
# v282 only built the tiny translation/rotation/scale fit from
# GUIDED_TRACK_PREDICTED outputs. The expensive Guided profile/finder path
# returns NATIVE_TRACK_OK with a *measured current-frame quad*, which is stronger
# evidence, but the presence of any such result suppressed the motion fit for
# the entire job. On the supplied OP12R bad-lock trace profile was 10/10 while
# motion/similarity remained 0. Feed every CRC-valid Guided output into the same
# robust residual fit; measured and predicted samples use exactly the same
# input->current displacement representation.
p = Path('receive/worker.js')
s = p.read_text()
old = '''  let decodedSlotsMask = 0;\n  const trackBySlot = new Map(tracks.map((track) => [Number(track.slot ?? track.id), track]));\n  const predictedMotion = [];\n  let measuredGeometryCount = 0;'''
new = '''  let decodedSlotsMask = 0;\n  const trackBySlot = new Map(tracks.map((track) => [Number(track.slot ?? track.id), track]));\n  const wallMotionSamples = [];'''
if old not in s:
    raise SystemExit('guided motion declaration anchor missing')
s = s.replace(old, new, 1)

old = '''    const outputQuad = shifted(quad, ox, oy);\n    const geometryMeasured = status === NATIVE_TRACK_OK;\n    if (geometryMeasured) {\n      measuredGeometryCount++;\n    } else {\n      const input = trackBySlot.get(slot);\n      if (input?.quad && validQuad(input.quad)) {\n        const names = ["topLeft", "topRight", "bottomRight", "bottomLeft"];\n        const dx = names.reduce((sum, name) => sum + outputQuad[name].x - input.quad[name].x, 0) / names.length;\n        const dy = names.reduce((sum, name) => sum + outputQuad[name].y - input.quad[name].y, 0) / names.length;\n        if (Number.isFinite(dx) && Number.isFinite(dy) && Math.hypot(dx, dy) <= 4.75) {\n          const points = [input.quad.topLeft, input.quad.topRight, input.quad.bottomRight, input.quad.bottomLeft];\n          const x = points.reduce((sum, point) => sum + point.x, 0) / points.length;\n          const y = points.reduce((sum, point) => sum + point.y, 0) / points.length;\n          const edge = points.reduce((sum, point, index) => {\n            const next = points[(index + 1) % points.length];\n            return sum + Math.hypot(next.x - point.x, next.y - point.y);\n          }, 0) / points.length;\n          predictedMotion.push({ dx, dy, x, y, edge, slot });\n        }\n      }\n    }'''
new = '''    const outputQuad = shifted(quad, ox, oy);\n    const geometryMeasured = status === NATIVE_TRACK_OK;\n    const input = trackBySlot.get(slot);\n    if (input?.quad && validQuad(input.quad)) {\n      const names = ["topLeft", "topRight", "bottomRight", "bottomLeft"];\n      const dx = names.reduce((sum, name) => sum + outputQuad[name].x - input.quad[name].x, 0) / names.length;\n      const dy = names.reduce((sum, name) => sum + outputQuad[name].y - input.quad[name].y, 0) / names.length;\n      // nudgeMotion deliberately accepts only tiny inter-frame updates. Keep\n      // larger jumps for the absolute recovery finder rather than letting one\n      // stale local decode drag the whole wall.\n      if (Number.isFinite(dx) && Number.isFinite(dy) && Math.hypot(dx, dy) <= 5.1) {\n        const points = [input.quad.topLeft, input.quad.topRight, input.quad.bottomRight, input.quad.bottomLeft];\n        const x = points.reduce((sum, point) => sum + point.x, 0) / points.length;\n        const y = points.reduce((sum, point) => sum + point.y, 0) / points.length;\n        const edge = points.reduce((sum, point, index) => {\n          const next = points[(index + 1) % points.length];\n          return sum + Math.hypot(next.x - point.x, next.y - point.y);\n        }, 0) / points.length;\n        wallMotionSamples.push({ dx, dy, x, y, edge, slot, measured: geometryMeasured });\n      }\n    }'''
if old not in s:
    raise SystemExit('guided measured/predicted motion block missing')
s = s.replace(old, new, 1)

# The remainder of this function contains no other predictedMotion identifier.
if s.count('predictedMotion') != 9:
    raise SystemExit(f'unexpected predictedMotion occurrence count: {s.count("predictedMotion")}')
s = s.replace('predictedMotion', 'wallMotionSamples')
old = '  if (!measuredGeometryCount && wallMotionSamples.length >= 2) {'
new = '  if (wallMotionSamples.length >= 2) {'
if old not in s:
    raise SystemExit('guided motion gate missing')
s = s.replace(old, new, 1)
old = '      for (const symbol of symbols) if (symbol.geometryMeasured === false) symbol.wallMotion = wallMotion;'
new = '''      // Publish the one frame-level fit on every decoded symbol. The main\n      // thread applies it once per sourceSequence before either accepting exact\n      // measured quads or marking predicted packets alive.\n      for (const symbol of symbols) symbol.wallMotion = wallMotion;'''
if old not in s:
    raise SystemExit('guided wallMotion publication anchor missing')
s = s.replace(old, new, 1)
p.write_text(s)


# Apply the shared frame motion *before* branching on exact-vs-predicted geometry.
# This lets measured profile/finder results move the entire wall immediately;
# their exact quads then refine the already-recentered lattice normally.
p = Path('receive/main.js')
s = p.read_text()
old = '''    const packetAt = info?.scanId === void 0 ? decodedAt : scanCapturedAt.get(info.scanId) ?? decodedAt;\n    const geometryInfo = { ...info, crc32: true };\n    if (info?.geometryMeasured === false) {\n      const sourceSequence = Number(info?.sourceSequence);\n      const motion = info?.wallMotion;\n      if (Number.isFinite(sourceSequence) && sourceSequence > geometryMotionLastSourceSequence &&\n          motion && Number(motion.samples) >= 2 && Number.isFinite(motion.dx) && Number.isFinite(motion.dy)) {\n        geometryMotionLastSourceSequence = sourceSequence;\n        const hasSimilarity = [motion.a, motion.b, motion.tx, motion.ty].every((value) => Number.isFinite(Number(value)));\n        const snapshot = hasSimilarity\n          ? gridLattice.nudgeMotion(motion, packetAt)\n          : gridLattice.nudgeTranslation(Number(motion.dx), Number(motion.dy), packetAt);\n        if (snapshot) {\n          geometryMotionNudges++;\n          const scale = hasSimilarity ? Math.hypot(Number(motion.a), Number(motion.b)) : 1;\n          const rotation = hasSimilarity ? Math.abs(Math.atan2(Number(motion.b), Number(motion.a))) : 0;\n          if (hasSimilarity && (Math.abs(scale - 1) >= 0.0005 || rotation >= 0.0005))\n            geometrySimilarityNudges++;\n          geometryMotionPixels += Number.isFinite(Number(motion.maxShift))\n            ? Number(motion.maxShift)\n            : Math.hypot(Number(motion.dx), Number(motion.dy));\n          syncGrid(snapshot, decodedAt);\n        }\n      }\n      gridLattice.noteValidPacket(packetAt);'''
new = '''    const packetAt = info?.scanId === void 0 ? decodedAt : scanCapturedAt.get(info.scanId) ?? decodedAt;\n    const geometryInfo = { ...info, crc32: true };\n    const sourceSequence = Number(info?.sourceSequence);\n    const motion = info?.wallMotion;\n    if (Number.isFinite(sourceSequence) && sourceSequence > geometryMotionLastSourceSequence &&\n        motion && Number(motion.samples) >= 2 && Number.isFinite(motion.dx) && Number.isFinite(motion.dy)) {\n      geometryMotionLastSourceSequence = sourceSequence;\n      const hasSimilarity = [motion.a, motion.b, motion.tx, motion.ty].every((value) => Number.isFinite(Number(value)));\n      const motionSnapshot = hasSimilarity\n        ? gridLattice.nudgeMotion(motion, packetAt)\n        : gridLattice.nudgeTranslation(Number(motion.dx), Number(motion.dy), packetAt);\n      if (motionSnapshot) {\n        geometryMotionNudges++;\n        const scale = hasSimilarity ? Math.hypot(Number(motion.a), Number(motion.b)) : 1;\n        const rotation = hasSimilarity ? Math.abs(Math.atan2(Number(motion.b), Number(motion.a))) : 0;\n        if (hasSimilarity && (Math.abs(scale - 1) >= 0.0005 || rotation >= 0.0005))\n          geometrySimilarityNudges++;\n        geometryMotionPixels += Number.isFinite(Number(motion.maxShift))\n          ? Number(motion.maxShift)\n          : Math.hypot(Number(motion.dx), Number(motion.dy));\n        syncGrid(motionSnapshot, decodedAt);\n      }\n    }\n    if (info?.geometryMeasured === false) {\n      gridLattice.noteValidPacket(packetAt);'''
if old not in s:
    raise SystemExit('main shared wall-motion anchor missing')
s = s.replace(old, new, 1)


# ---------------------------------------------------------------------------
# 2. Completion hit attribution must use the QR's declared slot identity.
#
# Spatial regionAt(symbol.box) attribution races lattice refits: a worker can
# decode slot 27 correctly, then the main thread moves the lattice before that
# job's completion accounting runs, causing the valid packet to be recorded as
# a miss. That is exactly how a 66%-successful slot could still display [weak].
old = '''    const hit = completion.symbols.some((symbol) => symbol.box && regionAt(symbol.box) === region);'''
new = '''    const hit = completion.symbols.some((symbol) => {\n      const decodedSlot = Number(symbol.header?.slotIndex);\n      if (region.gridSlot !== void 0 && Number.isInteger(decodedSlot))\n        return decodedSlot === region.gridSlot;\n      return Boolean(symbol.box && regionAt(symbol.box) === region);\n    });'''
if old not in s:
    raise SystemExit('slot completion attribution anchor missing')
s = s.replace(old, new, 1)


# ---------------------------------------------------------------------------
# 3. Recovery must search the selected weak QRs, not merely their big bounding
# crop. Pass the up-to-three ranked recovery targets into the worker. The worker
# can run readDenseY directly on isolated Y subrectangles with the original
# stride—no copy and no extra camera frame—so an easy QR elsewhere in the broad
# crop cannot monopolize the bounded generic finder result list.
old = '''    const directFull = source.videoFrame && !source.image && !captureNextScan\n      ? mappedDirectTrackedFrame(source, scanX, scanY, scanW, scanH, [])\n      : null;'''
new = '''    const recoveryTracks = localRecoverySeedScan ? boundedScanCandidates.map((region) => ({\n      id: region.id,\n      slot: region.gridSlot,\n      misses: region.consecutiveMisses,\n      quad: region.quad,\n      dim: region.dim,\n      crc32: Boolean(region.crc32)\n    })) : [];\n    const directFull = source.videoFrame && !source.image && !captureNextScan\n      ? mappedDirectTrackedFrame(source, scanX, scanY, scanW, scanH, recoveryTracks)\n      : null;'''
if old not in s:
    raise SystemExit('direct recovery track pass-through anchor missing')
s = s.replace(old, new, 1)

old = '''          pixelFormat: "y8",\n          outputMap: directFull.outputMap,\n          acquisitionMode'''
new = '''          pixelFormat: "y8",\n          outputMap: directFull.outputMap,\n          tracks: directFull.tracks,\n          acquisitionMode'''
if old not in s:
    raise SystemExit('direct recovery message anchor missing')
s = s.replace(old, new, 1)

old = '''      { id, buf: img.data.buffer, w: scanW, h: scanH, ox: scanX, oy: scanY, full: true, acquisitionMode },'''
new = '''      { id, buf: img.data.buffer, w: scanW, h: scanH, ox: scanX, oy: scanY, full: true, tracks: recoveryTracks, acquisitionMode },'''
if old not in s:
    raise SystemExit('buffered recovery message anchor missing')
s = s.replace(old, new, 1)
p.write_text(s)


# Targeted sub-rectangle recovery in the worker.
p = Path('receive/worker.js')
s = p.read_text()
old = '''  let readFullAttempts = 0;'''
new = '''  let readFullAttempts = 0;\n  let targetedAttempts = 0;\n  let targetedPixels = 0;\n  let targetedSuccesses = 0;'''
if old not in s:
    raise SystemExit('worker targeted metric declaration anchor missing')
s = s.replace(old, new, 1)

old = '''      const appendResults = (vec, includeErrors) => {\n        try {\n          for (let i = 0; i < vec.size(); i++) {\n            const r = vec.get(i);\n            if (r.valid && r.bytes.length > 0 && validQuad(r.position)) {\n              symbols.push({\n                bytes: r.bytes,\n                box: boundsOf(r.position, ox, oy),\n                quad: shifted(r.position, ox, oy),\n                modules: r.modules,\n                tracked: false,\n                decodePath: full ? "acquire" : "fallback"\n              });\n            } else if (includeErrors) {\n              const box = boundsOf(r.position, ox, oy);\n              if (box && box.w > 0 && box.h > 0) sightings.push(box);\n            }\n          }\n        } finally {\n          vec.delete();\n        }\n      };'''
new = '''      const appendResults = (vec, includeErrors, resultOx = ox, resultOy = oy, expectedSlot) => {\n        try {\n          for (let i = 0; i < vec.size(); i++) {\n            const r = vec.get(i);\n            if (r.valid && r.bytes.length > 0 && validQuad(r.position)) {\n              const packet = expectedSlot === void 0 ? null : parseFrame(r.bytes);\n              if (expectedSlot !== void 0 && packet?.header.slotIndex !== expectedSlot) continue;\n              symbols.push({\n                bytes: r.bytes,\n                box: boundsOf(r.position, resultOx, resultOy),\n                quad: shifted(r.position, resultOx, resultOy),\n                modules: r.modules,\n                tracked: false,\n                decodePath: full ? "acquire" : "fallback",\n                header: packet?.header\n              });\n            } else if (includeErrors) {\n              const box = boundsOf(r.position, resultOx, resultOy);\n              if (box && box.w > 0 && box.h > 0) sightings.push(box);\n            }\n          }\n        } finally {\n          vec.delete();\n        }\n      };'''
if old not in s:
    raise SystemExit('appendResults recovery offset anchor missing')
s = s.replace(old, new, 1)

old = '''        } else if (fullMode === "recovery") {\n          readFullAttempts++;\n          appendResults(readDenseSeed(3), false);\n        } else {'''
new = '''        } else if (fullMode === "recovery") {\n          // Isolate each ranked weak slot inside the already-copied broad Y8\n          // recovery frame. readDenseY accepts an arbitrary pointer + original\n          // stride, so these are zero-copy finder searches. Filter by the\n          // AirGapper slot header: finding an easy neighbor does not count as\n          // repairing the requested target.\n          if (decodePixelFormat === "y8" && Array.isArray(tracks) && tracks.length) {\n            for (const target of tracks.slice(0, 3)) {\n              const local = localQuad(target.quad, ox, oy);\n              const box = local && boundsOf(local, 0, 0);\n              const expectedSlot = Number(target.slot);\n              if (!box || !Number.isInteger(expectedSlot)) continue;\n              const edge = Math.max(box.w, box.h);\n              const pad = Math.max(20, edge * 0.45);\n              const rx = Math.max(0, Math.floor(box.x - pad));\n              const ry = Math.max(0, Math.floor(box.y - pad));\n              const rr = Math.min(pw, Math.ceil(box.x + box.w + pad));\n              const rb = Math.min(ph, Math.ceil(box.y + box.h + pad));\n              const rw = rr - rx, rh = rb - ry;\n              if (rw < 32 || rh < 32) continue;\n              targetedAttempts++;\n              targetedPixels += rw * rh;\n              readFullAttempts++;\n              const before = symbols.length;\n              appendResults(\n                zx.readDenseY(ptr + inputOffset + ry * inputStride + rx, rw, rh, inputStride, 4),\n                false, ox + rx, oy + ry, expectedSlot\n              );\n              if (symbols.length > before) targetedSuccesses++;\n            }\n          }\n          // If predictions are too stale for every isolated crop, retain one\n          // broad seed as a last-resort absolute anchor. Never spend the broad\n          // scan after a target was already recovered.\n          if (!targetedAttempts || targetedSuccesses === 0) {\n            readFullAttempts++;\n            appendResults(readDenseSeed(1), false);\n          }\n        } else {'''
if old not in s:
    raise SystemExit('full recovery branch anchor missing')
s = s.replace(old, new, 1)

old = '''      readFullAttempts,\n      workerWaitMs,\n      latencyMs: performance.now() - startedAt'''
new = '''      readFullAttempts,\n      workerWaitMs,\n      targetedAttempts,\n      targetedPixels,\n      targetedSuccesses,\n      latencyMs: performance.now() - startedAt'''
# This exact final reply appears once at the generic full/fallback exit. If the
# surrounding worker changes, fail closed rather than patching another branch.
if s.count(old) < 1:
    raise SystemExit('worker final targeted metrics reply anchor missing')
# Use the last occurrence because earlier specialized exits intentionally report
# their own metrics.
pos = s.rfind(old)
s = s[:pos] + s[pos:].replace(old, new, 1)
p.write_text(s)


# Add a focused lattice regression: a frame-level similarity update may precede
# exact measured packets from the same source frame without destroying lock.
p = Path('benchmark/grid-lattice-regression.mjs')
s = p.read_text()
anchor = '''assert.equal(lattice.nudgeMotion({ a: 1.2, b: 0, tx: 0, ty: 0, dx: 1, dy: 1, maxShift: 2, samples: 4 }, 1440), null,\n  "unsafe scale jumps must be rejected");\n\nconsole.log("grid-lattice regression: ok");'''
insert = '''assert.equal(lattice.nudgeMotion({ a: 1.2, b: 0, tx: 0, ty: 0, dx: 1, dy: 1, maxShift: 2, samples: 4 }, 1440), null,\n  "unsafe scale jumps must be rejected");\n\n// v283 applies the coherent frame motion before feeding exact measured QR\n// geometry from that same frame. A subsequent exact observation must refine the\n// already-moved wall without dropping distributed lock.\nsnapshot = lattice.accept(detection(0, 1460, { dx: 154, dy: 98 }), frameWidth, frameHeight);\nassert(snapshot, "exact measured geometry after a frame nudge must remain usable");\nassert.equal(lattice.locked, true);\nassert.equal(snapshot.distributedFit, true);\n\nconsole.log("grid-lattice regression: ok");'''
if anchor not in s:
    raise SystemExit('grid lattice v283 regression anchor missing')
s = s.replace(anchor, insert, 1)
p.write_text(s)
