from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"replacement not found in {path}: {old[:180]!r}")
    p.write_text(s.replace(old, new, count))


def replace_span(path, start, end, new):
    p = Path(path)
    s = p.read_text()
    a = s.find(start)
    if a < 0:
        raise SystemExit(f"start marker missing in {path}: {start!r}")
    b = s.find(end, a)
    if b < 0:
        raise SystemExit(f"end marker missing in {path}: {end!r}")
    p.write_text(s[:a] + new + s[b:])


replace("index.html", "v0.5.194", "v0.5.195")
replace("main.js", 'const APP_BUILD = "v0.5.194";', 'const APP_BUILD = "v0.5.195";')
replace("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.194";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.195";')
replace("sw.js", 'const CACHE = "airgapper-static-js-v156";', 'const CACHE = "airgapper-static-js-v157";')

# v194 proved the persistent cached decoder is much more viable on the good
# camera (34% CRC vs the historical ~2.7%), but putting its expensive map
# calibration in front of Guided regressed total throughput. Restore Guided as
# the production decoder while preserving the v194 startup-optics fix. The
# next cache iteration will be taught by successful Guided geometry rather than
# running a second locator/calibrator over the same frame.
replace(
    "receive/worker.js",
    '''const nativeRefresh = /* @__PURE__ */ new Set();\nlet nativeGuidedSamples = 0;\nlet nativeGuidedHitEwma = 0;\nlet nativeGuidedCooldown = 0;\nlet nativeGuidedProbeDelay = Math.floor(Math.random() * 4);\nconst NATIVE_GUIDED_BAD_RATIO = 0.20;\nconst NATIVE_GUIDED_COOLDOWN_JOBS = 12;''',
    '''const nativeRefresh = /* @__PURE__ */ new Set();'''
)

start = '''      if (guidedDecode && decodePixelFormat === "y8" && tracks.length >= 2) {\n        // The high-quality camera changes the economics of the old native'''
end = '''      readFullAttempts++;'''
new = '''      if (guidedDecode && decodePixelFormat === "y8" && tracks.length >= 2) {\n        // Guided remains the production tracked decoder. v194 proved cached\n        // module maps can work on the better camera, but calibrating a second\n        // native tracker before Guided added ~105 ms/job and reduced scheduled\n        // camera frames. The next cache path must reuse Guided's successful\n        // geometry instead of duplicating localization work.\n        const guided = decodeGuidedBatch(\n          zx, ptr + inputOffset, pw, ph, inputStride, ox, oy, tracks, guidedFallbackMask\n        );\n        if (guided) symbols.push(...guided.symbols);\n        mapOutputToDisplay();\n        ctx.postMessage({\n          id,\n          symbols,\n          sightings,\n          full: false,\n          trackedAttempted: true,\n          trackedHit: symbols.length > 0,\n          fallbackAttempted: false,\n          fallbackSucceeded: false,\n          readFullAttempts: 0,\n          workerWaitMs,\n          frameCopyMs,\n          guidedMetrics: guided?.metrics,\n          nativeAssistTracks: 0,\n          nativeAssistHits: 0,\n          guidedAssistTracks: tracks.length,\n          pixelPath: "y8-guided",\n          guidedError: guided?.error,\n          latencyMs: performance.now() - startedAt\n        });\n        return;\n      }\n'''
replace_span("receive/worker.js", start, end, new)
