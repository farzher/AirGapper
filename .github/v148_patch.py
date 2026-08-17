from pathlib import Path

root = Path('.')
main = root / 'receive/main.js'
worker = root / 'receive/worker.js'

s = main.read_text()
assert 'const RECEIVER_RUNTIME_BUILD = "v0.5.147";' in s
assert 'const GUIDED_MIN_TRACKS = 6;' in s
# Guided is much cheaper than dense robust even for small partial walls. The
# v147 run ended with track/3 jobs falling back to ~190 ms robust work solely
# because the rollout gate required six tracks.
s = s.replace('const RECEIVER_RUNTIME_BUILD = "v0.5.147";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.148";', 1)
s = s.replace('const GUIDED_MIN_TRACKS = 6;', 'const GUIDED_MIN_TRACKS = 2;', 1)
main.write_text(s)

w = worker.read_text()
old_gate = '      if (guidedDecode && decodePixelFormat === "y8" && tracks.length >= 6) {'
assert old_gate in w
start = w.index(old_gate)
end = w.index('      readFullAttempts++;', start)
old = w[start:end]
new = '''      if (guidedDecode && decodePixelFormat === "y8" && tracks.length >= 2) {\n        // Guided is the production tracked decoder. The v147 OP12R trace showed\n        // 1776 guided outputs in 25.9 worker-seconds, while the native pre-pass\n        // spent 35.3 worker-seconds for only 149 CRC hits (2.7%). Do not pay that\n        // cost on every fresh frame. Sparse dense-robust scouts remain the\n        // independent recovery path selected by the main-thread scheduler.\n        const guided = decodeGuidedBatch(\n          zx, ptr + inputOffset, pw, ph, inputStride, ox, oy, tracks\n        );\n        if (guided) symbols.push(...guided.symbols);\n        mapOutputToDisplay();\n        ctx.postMessage({\n          id,\n          symbols,\n          sightings,\n          full: false,\n          trackedAttempted: true,\n          trackedHit: symbols.length > 0,\n          fallbackAttempted: false,\n          fallbackSucceeded: false,\n          readFullAttempts: 0,\n          workerWaitMs,\n          frameCopyMs,\n          guidedMetrics: guided?.metrics,\n          nativeAssistTracks: 0,\n          nativeAssistHits: 0,\n          guidedAssistTracks: tracks.length,\n          pixelPath: "y8-guided",\n          guidedError: guided?.error,\n          latencyMs: performance.now() - startedAt\n        });\n        return;\n      }\n'''
w = w[:start] + new + w[end:]
worker.write_text(w)

# Product/version labels.
for name in ['index.html', 'main.js']:
    p = root / name
    text = p.read_text()
    assert 'v0.5.147' in text, name
    p.write_text(text.replace('v0.5.147', 'v0.5.148'))

sw = root / 'sw.js'
text = sw.read_text()
assert 'airgapper-static-js-v110' in text
sw.write_text(text.replace('airgapper-static-js-v110', 'airgapper-static-js-v111', 1))

# Guard the v147 production policy that v148 relies on.
check = main.read_text()
assert 'const GUIDED_ROBUST_SCOUT_EVERY = 12;' in check
assert 'const GUIDED_ROBUST_SCOUT_BAD_EVERY = 4;' in check
assert 'message.guidedDecode = true;' in check
assert 'const GUIDED_MIN_TRACKS = 2;' in check

checkw = worker.read_text()
assert 'if (guidedDecode && decodePixelFormat === "y8" && tracks.length >= 2)' in checkw
assert 'nativeAssistTracks: 0' in checkw
assert 'pixelPath: "y8-guided"' in checkw
assert 'const ROBUST_BATCH_MAX_RESULTS = 8;' in checkw
