from pathlib import Path


def replace_once(text, old, new, label):
    if old not in text:
        raise SystemExit(f"missing pattern: {label}")
    return text.replace(old, new, 1)

p = Path('receive/worker.js')
s = p.read_text()

s = replace_once(s,
'''const ctx = self;\nfunction boundsOf(p, ox, oy) {\n  const xs = [p.topLeft.x, p.topRight.x, p.bottomRight.x, p.bottomLeft.x];\n  const ys = [p.topLeft.y, p.topRight.y, p.bottomRight.y, p.bottomLeft.y];''',
'''const ctx = self;\nfunction validQuad(p) {\n  if (!p) return false;\n  return [p.topLeft, p.topRight, p.bottomRight, p.bottomLeft].every((point) =>\n    point && Number.isFinite(point.x) && Number.isFinite(point.y)\n  );\n}\nfunction boundsOf(p, ox, oy) {\n  if (!validQuad(p)) return null;\n  const xs = [p.topLeft.x, p.topRight.x, p.bottomRight.x, p.bottomLeft.x];\n  const ys = [p.topLeft.y, p.topRight.y, p.bottomRight.y, p.bottomLeft.y];''', 'safe bounds')

s = replace_once(s,
'''function shifted(p, ox, oy) {\n  const s = (pt) => ({ x: pt.x + ox, y: pt.y + oy });''',
'''function shifted(p, ox, oy) {\n  if (!validQuad(p)) return null;\n  const s = (pt) => ({ x: pt.x + ox, y: pt.y + oy });''', 'safe shifted')

s = replace_once(s,
'''function translatedQuad(q, dx, dy) {\n  const move = (p) => ({ x: p.x + dx, y: p.y + dy });''',
'''function translatedQuad(q, dx, dy) {\n  if (!validQuad(q)) return null;\n  const move = (p) => ({ x: p.x + dx, y: p.y + dy });''', 'safe translated')

s = replace_once(s,
'''      const q = track.quad;\n      const accepted = zx._setTrackedDecoderTrack(''',
'''      const q = track.quad;\n      if (!validQuad(q)) return void 0;\n      const accepted = zx._setTrackedDecoderTrack(''', 'native track guard')

s = replace_once(s,
'''      const q = track.quad;\n      const id = track.slot ?? track.id;\n      if (!zx._setTrackedDecoderTrack(handle, slot, id, track.dim,''',
'''      const q = track.quad;\n      if (!validQuad(q)) return null;\n      const id = track.slot ?? track.id;\n      if (!zx._setTrackedDecoderTrack(handle, slot, id, track.dim,''', 'audit track guard')

s = replace_once(s,
'''function localQuad(q, ox, oy) {\n  const move = (point) => ({ x: point.x - ox, y: point.y - oy });''',
'''function localQuad(q, ox, oy) {\n  if (!validQuad(q)) return null;\n  const move = (point) => ({ x: point.x - ox, y: point.y - oy });''', 'safe local quad')

s = replace_once(s,
'''function quadMaxDelta(a, b) {\n  if (!a || !b) return null;''',
'''function quadMaxDelta(a, b) {\n  if (!validQuad(a) || !validQuad(b)) return null;''', 'safe delta')

s = replace_once(s,
'''    const expected = Uint8Array.from(expectedQr.modules.data, (value) => value ? 1 : 0);\n    const freshGlobal = globalQuad(result.position, ox, oy);''',
'''    const expected = Uint8Array.from(expectedQr.modules.data, (value) => value ? 1 : 0);\n    if (!validQuad(result.position) || !validQuad(track.quad)) {\n      return { slot: track.slot, dim: result.modules, error: "decoder returned incomplete position" };\n    }\n    const freshGlobal = globalQuad(result.position, ox, oy);''', 'diagnostic position guard')

s = replace_once(s,
'''function projectedNeighbor(q, dx, dy, stride) {\n  const p0 = q.topLeft, p1 = q.topRight, p2 = q.bottomRight, p3 = q.bottomLeft;''',
'''function projectedNeighbor(q, dx, dy, stride) {\n  if (!validQuad(q)) return null;\n  const p0 = q.topLeft, p1 = q.topRight, p2 = q.bottomRight, p3 = q.bottomLeft;''', 'neighbor guard')

s = replace_once(s,
'''          const predicted = projectedNeighbor(seed.quad, dx, dy, ratio);\n          const result = zx.readTracked(''',
'''          const predicted = projectedNeighbor(seed.quad, dx, dy, ratio);\n          if (!predicted) continue;\n          const result = zx.readTracked(''', 'oracle predicted guard')

# Local robust recovery: a decoded packet without a usable position must never crash.
s = replace_once(s,
'''          symbols.push({\n            bytes: result.bytes,\n            box: boundsOf(result.position, ox, oy),\n            quad: shifted(result.position, ox, oy),\n            modules: result.modules,\n            tracked: false\n          });''',
'''          const recoveredPosition = validQuad(result.position)\n            ? result.position\n            : trackIndex >= 0 ? localQuad(tracks[trackIndex].quad, ox, oy) : null;\n          if (!recoveredPosition) continue;\n          symbols.push({\n            bytes: result.bytes,\n            box: boundsOf(recoveredPosition, ox, oy),\n            quad: shifted(recoveredPosition, ox, oy),\n            modules: result.modules,\n            tracked: false\n          });''', 'robust result guard')

# Legacy single tracked path can reuse the known quad if ZXing omits a position.
s = replace_once(s,
'''      if (r.valid && r.bytes.length > 0) {\n        symbols.push({\n          bytes: r.bytes,\n          box: boundsOf(r.position, ox, oy),\n          quad: shifted(r.position, ox, oy),\n          modules: r.modules,\n          tracked: true\n        });\n        trackedHit = true;\n      }''',
'''      if (r.valid && r.bytes.length > 0) {\n        const trackedPosition = validQuad(r.position) ? r.position : localQuad(quad, ox, oy);\n        if (trackedPosition) {\n          symbols.push({\n            bytes: r.bytes,\n            box: boundsOf(trackedPosition, ox, oy),\n            quad: shifted(trackedPosition, ox, oy),\n            modules: r.modules,\n            tracked: true\n          });\n          trackedHit = true;\n        }\n      }''', 'single tracked position guard')

# This is the crash the desktop run hit: includeErrors may contain candidates with no position.
s = replace_once(s,
'''            if (r.valid && r.bytes.length > 0) {\n              symbols.push({\n                bytes: r.bytes,\n                box: boundsOf(r.position, ox, oy),\n                quad: shifted(r.position, ox, oy),\n                modules: r.modules,\n                tracked: false\n              });\n            } else if (includeErrors) {\n              const box = boundsOf(r.position, ox, oy);\n              if (box.w > 0 && box.h > 0) sightings.push(box);\n            }''',
'''            if (r.valid && r.bytes.length > 0 && validQuad(r.position)) {\n              symbols.push({\n                bytes: r.bytes,\n                box: boundsOf(r.position, ox, oy),\n                quad: shifted(r.position, ox, oy),\n                modules: r.modules,\n                tracked: false\n              });\n            } else if (includeErrors) {\n              const box = boundsOf(r.position, ox, oy);\n              if (box && box.w > 0 && box.h > 0) sightings.push(box);\n            }''', 'full scan error-position guard')

p.write_text(s)

p = Path('index.html')
s = p.read_text().replace('v0.5.58', 'v0.5.59')
p.write_text(s)

p = Path('sw.js')
s = p.read_text().replace('airgapper-static-js-v21', 'airgapper-static-js-v22')
p.write_text(s)
