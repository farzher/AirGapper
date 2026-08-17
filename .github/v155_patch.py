from pathlib import Path

root = Path('.')

# ---- codec header -----------------------------------------------------------
p = root / 'vendor/decimen-codec/source/wrapper/decimen_codec.h'
s = p.read_text()
s = s.replace(
'''void setTrackedDecoderFallbackBudget(int handle, int maxRSFallbacksPerFrame);''',
'''void setTrackedDecoderFallbackBudget(int handle, int maxRSFallbacksPerFrame);
void setTrackedDecoderAutoCalibration(int handle, int enabled);''', 1)
s = s.replace(
'''\t\t\t\t\t\t uint8_t* output, int outputCapacity, int maxSymbols,
\t\t\t\t\t\t DecimenGuidedMetrics* metrics);''',
'''\t\t\t\t\t\t uint8_t* output, int outputCapacity, int maxSymbols,
\t\t\t\t\t\t DecimenGuidedMetrics* metrics, int trackedDecoderHandle);''', 1)
p.write_text(s)

# ---- codec CMake export -----------------------------------------------------
p = root / 'vendor/decimen-codec/source/CMakeLists.txt'
s = p.read_text()
old = "'_setTrackedDecoderTrackCRC32', '_setTrackedDecoderFallbackBudget', '_decodeTrackedBatchY'"
new = "'_setTrackedDecoderTrackCRC32', '_setTrackedDecoderFallbackBudget', '_setTrackedDecoderAutoCalibration', '_decodeTrackedBatchY'"
assert old in s
s = s.replace(old, new, 1)
p.write_text(s)

# ---- codec implementation --------------------------------------------------
p = root / 'vendor/decimen-codec/source/wrapper/decimen_codec.cpp'
s = p.read_text()
old = '''namespace {\n\nconstexpr auto GUIDED_QR_FINDER = FixedPattern<5, 7>{1, 1, 3, 1, 1};'''
new = '''namespace {\n\n// The persistent sampler is defined later in this file. Guided decoding owns\n// the high-confidence current-frame finder triplet, so let it seed that cache\n// instead of forcing the cache to rediscover all finders itself.\nstatic bool seedTrackedCacheFromGuided(int handle, int id, int dimension,\n                                       const BitMatrix& image, const QRCode::FinderPatternSet& fp);\n\nconstexpr auto GUIDED_QR_FINDER = FixedPattern<5, 7>{1, 1, 3, 1, 1};'''
assert old in s
s = s.replace(old, new, 1)

old = '''                                   uint8_t* output, int outputCapacity, int maxSymbols,\n                                   DecimenGuidedMetrics* metrics)'''
new = '''                                   uint8_t* output, int outputCapacity, int maxSymbols,\n                                   DecimenGuidedMetrics* metrics, int trackedDecoderHandle)'''
assert old in s
s = s.replace(old, new, 1)

old = '''        int resultCount = 0;\n        int outputUsed = 0;\n        for (int trackIndex : order) {'''
new = '''        int resultCount = 0;\n        int outputUsed = 0;\n        int cacheSeedsThisCall = 0;\n        for (int trackIndex : order) {'''
assert old in s
s = s.replace(old, new, 1)

old = '''                if (!decoded.isValid() || decoded.content().bytes.empty() || !hasValidCRC32(decoded.content().bytes))\n                    continue;\n                ByteArray bytes = decoded.content().bytes;'''
new = '''                if (!decoded.isValid() || decoded.content().bytes.empty() || !hasValidCRC32(decoded.content().bytes))\n                    continue;\n\n                // Calibration used to be the fatal cost of the old native\n                // pre-pass: it independently scanned the whole crop for finder\n                // sets before it could build a distortion-corrected module map.\n                // We already have the exact finder triplet here. Seed at most\n                // four maps per job to amortize setup; subsequent frames can\n                // point-sample those maps before falling back to SampleQR.\n                if (trackedDecoderHandle && cacheSeedsThisCall < 4 &&\n                    seedTrackedCacheFromGuided(trackedDecoderHandle, track.id, track.dimension, *bits, finderSet))\n                    ++cacheSeedsThisCall;\n\n                ByteArray bytes = decoded.content().bytes;'''
assert old in s
s = s.replace(old, new, 1)

old = '''struct TrackedDecoder\n{\n\tint maxDimension;\n\tint maxRSFallbacks = 2;'''
new = '''struct TrackedDecoder\n{\n\tint maxDimension;\n\tint maxRSFallbacks = 2;\n\tbool autoCalibration = true;'''
assert old in s
s = s.replace(old, new, 1)

# Define the guided seeding bridge immediately after the existing validated\n# calibration routine, before metrics helpers.
needle = '''\ttrack.consecutiveMisses = 0;\n\treturn true;\n}\n\nstatic void addBatchMetrics'''
replacement = '''\ttrack.consecutiveMisses = 0;\n\treturn true;\n}\n\nstatic bool seedTrackedCacheFromGuided(int handle, int id, int dimension,\n                                       const BitMatrix& image, const QRCode::FinderPatternSet& fp)\n{\n\tauto* decoder = trackedDecoder(handle);\n\tif (!decoder)\n\t\treturn false;\n\tfor (auto& track : decoder->tracks) {\n\t\tif (!track.active || track.id != id || track.dimension != dimension)\n\t\t\tcontinue;\n\t\tif (track.calibrated)\n\t\t\treturn false;\n\t\tif (track.calibrationCooldown > 0) {\n\t\t\t--track.calibrationCooldown;\n\t\t\treturn false;\n\t\t}\n\t\tconst bool ok = calibrateTrackSampleMap(track, image, fp);\n\t\tif (!ok)\n\t\t\ttrack.calibrationCooldown = 4;\n\t\treturn ok;\n\t}\n\treturn false;\n}\n\nstatic void addBatchMetrics'''
assert needle in s
s = s.replace(needle, replacement, 1)

old = '''EMSCRIPTEN_KEEPALIVE void setTrackedDecoderFallbackBudget(int handle, int maxRSFallbacksPerFrame)\n{\n\tauto* decoder = trackedDecoder(handle);\n\tif (decoder)\n\t\tdecoder->maxRSFallbacks = std::clamp(maxRSFallbacksPerFrame, 0, int(decoder->tracks.size()));\n}\n\nEMSCRIPTEN_KEEPALIVE int decodeTrackedBatchY'''
new = '''EMSCRIPTEN_KEEPALIVE void setTrackedDecoderFallbackBudget(int handle, int maxRSFallbacksPerFrame)\n{\n\tauto* decoder = trackedDecoder(handle);\n\tif (decoder)\n\t\tdecoder->maxRSFallbacks = std::clamp(maxRSFallbacksPerFrame, 0, int(decoder->tracks.size()));\n}\n\nEMSCRIPTEN_KEEPALIVE void setTrackedDecoderAutoCalibration(int handle, int enabled)\n{\n\tauto* decoder = trackedDecoder(handle);\n\tif (decoder)\n\t\tdecoder->autoCalibration = enabled != 0;\n}\n\nEMSCRIPTEN_KEEPALIVE int decodeTrackedBatchY'''
assert old in s
s = s.replace(old, new, 1)

old = '''\t\tif (measured.tracks > 0 && measured.successful == measured.tracks) {\n\t\t\tmeasured.totalMs = emscripten_get_now() - totalStart;\n\t\t\tif (metrics) *metrics = measured;\n\t\t\treturn count;\n\t\t}\n\n\t\tbool calibrationDue = false;'''
new = '''\t\tif (measured.tracks > 0 && measured.successful == measured.tracks) {\n\t\t\tmeasured.totalMs = emscripten_get_now() - totalStart;\n\t\t\tif (metrics) *metrics = measured;\n\t\t\treturn count;\n\t\t}\n\n\t\t// Production guided mode seeds calibration with its already-verified\n\t\t// finder triplets. Never fall back to the old whole-crop finder scan in\n\t\t// that mode; a cache miss is intentionally handed back to guided decode.\n\t\tif (!decoder->autoCalibration) {\n\t\t\tmeasured.totalMs = emscripten_get_now() - totalStart;\n\t\t\tif (metrics) *metrics = measured;\n\t\t\treturn count;\n\t\t}\n\n\t\tbool calibrationDue = false;'''
assert old in s
s = s.replace(old, new, 1)
p.write_text(s)

# ---- worker hybrid cache ---------------------------------------------------
p = root / 'receive/worker.js'
s = p.read_text()
old = '''let nativeConfigured = [];\nlet nativeCropOrigin = "";\nconst nativeRefresh = /* @__PURE__ */ new Set();'''
new = '''let nativeConfigured = [];\nlet nativeCropOrigin = "";\nlet nativeCachePrimed = false;\nconst nativeRefresh = /* @__PURE__ */ new Set();'''
assert old in s
s = s.replace(old, new, 1)

old = '''function decodeGuidedBatch(zx, yPtr, width, height, stride, ox, oy, tracks) {'''
new = '''function decodeGuidedBatch(zx, yPtr, width, height, stride, ox, oy, tracks, seedHandle = 0) {'''
assert old in s
s = s.replace(old, new, 1)
old = '''  const count = zx._decodeGuidedBatchY(\n    yPtr, width, height, stride,\n    guidedTracksPtr, tracks.length,\n    guidedResultsPtr, NATIVE_BATCH_MAX_TRACKS,\n    guidedOutputPtr, GUIDED_OUTPUT_BYTES,\n    tracks.length, guidedMetricsPtr\n  );'''
new = '''  const guidedArgs = [\n    yPtr, width, height, stride,\n    guidedTracksPtr, tracks.length,\n    guidedResultsPtr, NATIVE_BATCH_MAX_TRACKS,\n    guidedOutputPtr, GUIDED_OUTPUT_BYTES,\n    tracks.length, guidedMetricsPtr\n  ];\n  const count = scalarCodec\n    ? zx._decodeGuidedBatchY(...guidedArgs)\n    : zx._decodeGuidedBatchY(...guidedArgs, seedHandle);'''
assert old in s
s = s.replace(old, new, 1)

old = '''  zx._setTrackedDecoderFallbackBudget(nativeBatchHandle, 0);\n  return Boolean(nativeResultsPtr && nativeOutputPtr && nativeMetricsPtr);'''
new = '''  zx._setTrackedDecoderFallbackBudget(nativeBatchHandle, 0);\n  zx._setTrackedDecoderAutoCalibration?.(nativeBatchHandle, 0);\n  return Boolean(nativeResultsPtr && nativeOutputPtr && nativeMetricsPtr);'''
assert old in s
s = s.replace(old, new, 1)

old = '''  const originChanged = origin !== nativeCropOrigin;\n  const byId = /* @__PURE__ */ new Map();'''
new = '''  const originChanged = origin !== nativeCropOrigin;\n  let configurationChanged = originChanged;\n  const byId = /* @__PURE__ */ new Map();'''
assert old in s
s = s.replace(old, new, 1)
old = '''    if (mustConfigure) {\n      const q = track.quad;'''
new = '''    if (mustConfigure) {\n      configurationChanged = true;\n      const q = track.quad;'''
assert old in s
s = s.replace(old, new, 1)
old = '''  nativeConfigured.length = tracks.length;\n  nativeCropOrigin = origin;\n  return byId;'''
new = '''  nativeConfigured.length = tracks.length;\n  nativeCropOrigin = origin;\n  if (configurationChanged) nativeCachePrimed = false;\n  return byId;'''
assert old in s
s = s.replace(old, new, 1)

old = '''      if (guidedDecode && decodePixelFormat === "y8" && tracks.length >= 2) {\n        // Guided is the production tracked decoder. The v147 OP12R trace showed\n        // 1776 guided outputs in 25.9 worker-seconds, while the native pre-pass\n        // spent 35.3 worker-seconds for only 149 CRC hits (2.7%). Do not pay that\n        // cost on every fresh frame. Sparse dense-robust scouts remain the\n        // independent recovery path selected by the main-thread scheduler.\n        const guided = decodeGuidedBatch(\n          zx, ptr + inputOffset, pw, ph, inputStride, ox, oy, tracks\n        );\n        if (guided) symbols.push(...guided.symbols);\n        mapOutputToDisplay();\n        ctx.postMessage({\n          id,\n          symbols,\n          sightings,\n          full: false,\n          trackedAttempted: true,\n          trackedHit: symbols.length > 0,\n          fallbackAttempted: false,\n          fallbackSucceeded: false,\n          readFullAttempts: 0,\n          workerWaitMs,\n          frameCopyMs,\n          guidedMetrics: guided?.metrics,\n          nativeAssistTracks: 0,\n          nativeAssistHits: 0,\n          guidedAssistTracks: tracks.length,\n          pixelPath: "y8-guided",\n          guidedError: guided?.error,\n          latencyMs: performance.now() - startedAt\n        });\n        return;\n      }'''
new = '''      if (guidedDecode && decodePixelFormat === "y8" && tracks.length >= 2) {\n        // Guided remains the correctness oracle, but successful guided finder\n        // triplets now seed the codec's distortion-corrected module cache. On\n        // following frames, point-sample that cache first and send only misses\n        // through expensive SampleQR. Unlike the old native pre-pass, cache\n        // misses never trigger an independent whole-crop calibration scan.\n        const configured = !scalarCodec ? configureNativeBatch(zx, tracks, ox, oy) : undefined;\n        let native;\n        let remainingTracks = tracks;\n        if (configured && nativeCachePrimed) {\n          native = decodeNativeBatch(\n            zx, ptr + inputOffset, pw, ph, ox, oy, tracks, "y8", inputStride\n          );\n          if (native?.symbols.length) {\n            symbols.push(...native.symbols);\n            const nativeSlots = new Set(native.symbols.map((symbol) => symbol.header?.slotIndex).filter((slot) => slot !== undefined));\n            remainingTracks = tracks.filter((track) => track.slot === undefined || !nativeSlots.has(track.slot));\n          }\n        }\n        const guided = remainingTracks.length\n          ? decodeGuidedBatch(\n              zx, ptr + inputOffset, pw, ph, inputStride, ox, oy, remainingTracks,\n              configured ? nativeBatchHandle : 0\n            )\n          : null;\n        if (guided?.symbols.length) {\n          symbols.push(...guided.symbols);\n          if (configured) nativeCachePrimed = true;\n        }\n        mapOutputToDisplay();\n        ctx.postMessage({\n          id,\n          symbols,\n          sightings,\n          full: false,\n          trackedAttempted: true,\n          trackedHit: symbols.length > 0,\n          fallbackAttempted: false,\n          fallbackSucceeded: false,\n          readFullAttempts: 0,\n          workerWaitMs,\n          frameCopyMs,\n          nativeMetrics: native?.metrics,\n          guidedMetrics: guided?.metrics,\n          nativeAssistTracks: native?.metrics?.tracks ?? 0,\n          nativeAssistHits: native?.symbols.length ?? 0,\n          guidedAssistTracks: remainingTracks.length,\n          pixelPath: native ? (guided ? "y8-cache+guided" : "y8-cache") : "y8-guided",\n          guidedError: guided?.error,\n          latencyMs: performance.now() - startedAt\n        });\n        return;\n      }'''
assert old in s
s = s.replace(old, new, 1)
p.write_text(s)

# ---- app version/cache ------------------------------------------------------
p = root / 'receive/main.js'
s = p.read_text()
assert 'const RECEIVER_RUNTIME_BUILD = "v0.5.154";' in s
p.write_text(s.replace('const RECEIVER_RUNTIME_BUILD = "v0.5.154";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.155";', 1))
for name in ['index.html', 'main.js']:
    p = root / name
    text = p.read_text()
    assert 'v0.5.154' in text, name
    p.write_text(text.replace('v0.5.154', 'v0.5.155'))
sw = root / 'sw.js'
text = sw.read_text()
assert 'airgapper-static-js-v116' in text
sw.write_text(text.replace('airgapper-static-js-v116', 'airgapper-static-js-v117', 1))
