from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    text = p.read_text()
    n = text.count(old)
    if n != count:
        raise SystemExit(f"{path}: expected {count} matches, got {n}: {old[:120]!r}")
    p.write_text(text.replace(old, new))

# Version/cache.
replace("index.html", "v0.5.52", "v0.5.53")
replace("sw.js", 'airgapper-static-js-v15', 'airgapper-static-js-v16')
replace("vendor/decimen-codec/source/VERSION", "0.1.1", "0.1.2")

# Native metrics: make misses diagnosable rather than one undifferentiated count.
replace(
    "vendor/decimen-codec/source/wrapper/decimen_codec.h",
    '''\tuint32_t crcFastSuccesses;\n\tuint32_t rsFallbacks;\n};''',
    '''\tuint32_t crcFastSuccesses;\n\tuint32_t rsFallbacks;\n\tuint32_t anchorSuccesses;\n\tuint32_t anchorMisses;\n\tuint32_t thresholdFallbacks;\n\tuint32_t outOfFrameMisses;\n\tuint32_t bitstreamFailures;\n\tuint32_t crcFailures;\n\tuint32_t multiSampleRetries;\n};'''
)

cpp = Path("vendor/decimen-codec/source/wrapper/decimen_codec.cpp")
text = cpp.read_text()
old_anchor = '''template <class LumAt>\nstatic AnchorReading readAnchor(const PersistentTrack& track, float dx, float dy, const LumAt& lumAt)\n{\n\tuint8_t values[147];\n\tuint8_t expected[147];\n\tint count = 0, blackSum = 0, whiteSum = 0, blackCount = 0, whiteCount = 0;\n\tconst int dim = track.dimension;\n\tconst PointI corners[3] = {{0, 0}, {dim - 7, 0}, {0, dim - 7}};\n\tfor (auto corner : corners)\n\t\tfor (int my = 0; my < 7; ++my)\n\t\t\tfor (int mx = 0; mx < 7; ++mx) {\n\t\t\t\tconst auto& p = track.samples[(corner.y + my) * dim + corner.x + mx];\n\t\t\t\tint lum = lumAt(p.x + dx, p.y + dy);\n\t\t\t\tif (lum < 0)\n\t\t\t\t\treturn {};\n\t\t\t\tbool black = finderIdeal(mx, my);\n\t\t\t\tvalues[count] = static_cast<uint8_t>(lum);\n\t\t\t\texpected[count++] = black;\n\t\t\t\tif (black) {\n\t\t\t\t\tblackSum += lum;\n\t\t\t\t\t++blackCount;\n\t\t\t\t} else {\n\t\t\t\t\twhiteSum += lum;\n\t\t\t\t\t++whiteCount;\n\t\t\t\t}\n\t\t\t}\n\tint black = blackSum / blackCount;\n\tint white = whiteSum / whiteCount;\n\tAnchorReading out;\n\tout.contrast = white - black;\n\tout.threshold = (black + white) / 2;\n\tif (out.contrast < 24)\n\t\treturn out;\n\tfor (int i = 0; i < count; ++i)\n\t\tout.score += (values[i] <= out.threshold) == bool(expected[i]);\n\treturn out;\n}\n'''
new_anchor = '''template <class LumAt>\nstatic AnchorReading readAnchor(const PersistentTrack& track, float dx, float dy, const LumAt& lumAt)\n{\n\t// Camera shading/ISP processing can put the three finder patterns at\n\t// noticeably different luminance levels. Score each finder with its own\n\t// black/white threshold instead of forcing one global finder threshold.\n\tconst int dim = track.dimension;\n\tconst PointI corners[3] = {{0, 0}, {dim - 7, 0}, {0, dim - 7}};\n\tAnchorReading out;\n\tout.contrast = 255;\n\tint globalBlackSum = 0, globalWhiteSum = 0, globalBlackCount = 0, globalWhiteCount = 0;\n\tfor (auto corner : corners) {\n\t\tuint8_t values[49];\n\t\tbool expected[49];\n\t\tint count = 0, blackSum = 0, whiteSum = 0, blackCount = 0, whiteCount = 0;\n\t\tfor (int my = 0; my < 7; ++my)\n\t\t\tfor (int mx = 0; mx < 7; ++mx) {\n\t\t\t\tconst auto& p = track.samples[(corner.y + my) * dim + corner.x + mx];\n\t\t\t\tint lum = lumAt(p.x + dx, p.y + dy);\n\t\t\t\tif (lum < 0)\n\t\t\t\t\treturn {};\n\t\t\t\tbool black = finderIdeal(mx, my);\n\t\t\t\tvalues[count] = static_cast<uint8_t>(lum);\n\t\t\t\texpected[count++] = black;\n\t\t\t\tif (black) { blackSum += lum; ++blackCount; }\n\t\t\t\telse { whiteSum += lum; ++whiteCount; }\n\t\t\t}\n\t\tconst int black = blackSum / blackCount;\n\t\tconst int white = whiteSum / whiteCount;\n\t\tconst int contrast = white - black;\n\t\tout.contrast = std::min(out.contrast, contrast);\n\t\tconst int threshold = (black + white) / 2;\n\t\tif (contrast >= 24)\n\t\t\tfor (int i = 0; i < count; ++i)\n\t\t\t\tout.score += (values[i] <= threshold) == expected[i];\n\t\tglobalBlackSum += blackSum; globalBlackCount += blackCount;\n\t\tglobalWhiteSum += whiteSum; globalWhiteCount += whiteCount;\n\t}\n\tconst int globalBlack = globalBlackSum / globalBlackCount;\n\tconst int globalWhite = globalWhiteSum / globalWhiteCount;\n\tout.threshold = (globalBlack + globalWhite) / 2;\n\tif (out.contrast == 255) out.contrast = 0;\n\treturn out;\n}\n'''
if text.count(old_anchor) != 1:
    raise SystemExit("readAnchor body did not match")
text = text.replace(old_anchor, new_anchor)

marker = '''static DecoderResult decodeWithoutErrorCorrection(const BitMatrix& bits)\n{'''
threshold_code = '''constexpr int TRACK_THRESH_TILES = 8;\nconstexpr int TRACK_TILE_SAMPLES = 4;\n\nstruct TrackThresholdGrid\n{\n\tint t[TRACK_THRESH_TILES][TRACK_THRESH_TILES]{};\n\tbool ok = false;\n};\n\ntemplate <class LumAt>\nstatic TrackThresholdGrid buildTrackThresholds(const PersistentTrack& track, const LumAt& lumAt)\n{\n\tTrackThresholdGrid grid;\n\tint lo[TRACK_THRESH_TILES][TRACK_THRESH_TILES];\n\tint hi[TRACK_THRESH_TILES][TRACK_THRESH_TILES];\n\tint gmin = 255, gmax = 0;\n\tconst int dim = track.dimension;\n\tfor (int ty = 0; ty < TRACK_THRESH_TILES; ++ty)\n\t\tfor (int tx = 0; tx < TRACK_THRESH_TILES; ++tx) {\n\t\t\tlo[ty][tx] = 255;\n\t\t\thi[ty][tx] = 0;\n\t\t\tfor (int sy = 0; sy < TRACK_TILE_SAMPLES; ++sy)\n\t\t\t\tfor (int sx = 0; sx < TRACK_TILE_SAMPLES; ++sx) {\n\t\t\t\t\tconst double fx = (tx + (sx + 0.5) / TRACK_TILE_SAMPLES) / TRACK_THRESH_TILES;\n\t\t\t\t\tconst double fy = (ty + (sy + 0.5) / TRACK_TILE_SAMPLES) / TRACK_THRESH_TILES;\n\t\t\t\t\tconst int mx = std::clamp(int(fx * dim), 0, dim - 1);\n\t\t\t\t\tconst int my = std::clamp(int(fy * dim), 0, dim - 1);\n\t\t\t\t\tconst auto& p = track.samples[my * dim + mx];\n\t\t\t\t\tconst int lum = lumAt(p.x + track.dx, p.y + track.dy);\n\t\t\t\t\tif (lum < 0) continue;\n\t\t\t\t\tlo[ty][tx] = std::min(lo[ty][tx], lum);\n\t\t\t\t\thi[ty][tx] = std::max(hi[ty][tx], lum);\n\t\t\t\t}\n\t\t\tgmin = std::min(gmin, lo[ty][tx]);\n\t\t\tgmax = std::max(gmax, hi[ty][tx]);\n\t\t}\n\tif (gmax - gmin < 24)\n\t\treturn grid;\n\tconst int global = (gmin + gmax) / 2;\n\tfor (int ty = 0; ty < TRACK_THRESH_TILES; ++ty)\n\t\tfor (int tx = 0; tx < TRACK_THRESH_TILES; ++tx)\n\t\t\tgrid.t[ty][tx] = hi[ty][tx] - lo[ty][tx] >= 24 ? (lo[ty][tx] + hi[ty][tx]) / 2 : global;\n\tgrid.ok = true;\n\treturn grid;\n}\n\nstatic DecoderResult decodeWithoutErrorCorrection(const BitMatrix& bits)\n{'''
if text.count(marker) != 1:
    raise SystemExit("decodeWithoutErrorCorrection marker did not match")
text = text.replace(marker, threshold_code)

text = text.replace(
'''\t\tif (!anchored) {\n\t\t\t++track.consecutiveMisses;\n\t\t\t++measured.misses;''',
'''\t\tif (!anchored) {\n\t\t\t++track.consecutiveMisses;\n\t\t\t++measured.misses;\n\t\t\t++measured.anchorMisses;''', 1)
text = text.replace(
'''\t\tconst int dim = track.dimension;\n\t\tconst bool canMultiSample = track.multiSample && anchor.contrast < 180;''',
'''\t\t++measured.anchorSuccesses;\n\t\tconst int dim = track.dimension;\n\t\tconst auto thresholds = buildTrackThresholds(track, lumAt);\n\t\tif (!thresholds.ok) ++measured.thresholdFallbacks;\n\t\tconst bool canMultiSample = track.multiSample && anchor.contrast < 180;''', 1)
text = text.replace(
'''\t\t\t\t\ttrack.sampled.set(x, y, lum <= anchor.threshold);''',
'''\t\t\t\t\tconst int threshold = thresholds.ok\n\t\t\t\t\t\t? thresholds.t[std::clamp(y * TRACK_THRESH_TILES / dim, 0, TRACK_THRESH_TILES - 1)]\n\t\t\t\t\t\t              [std::clamp(x * TRACK_THRESH_TILES / dim, 0, TRACK_THRESH_TILES - 1)]\n\t\t\t\t\t\t: anchor.threshold;\n\t\t\t\t\ttrack.sampled.set(x, y, lum <= threshold);''', 1)
text = text.replace(
'''\t\tif (!sampleGrid(sampledMulti)) {\n\t\t\t++track.consecutiveMisses;\n\t\t\t++measured.misses;''',
'''\t\tif (!sampleGrid(sampledMulti)) {\n\t\t\t++track.consecutiveMisses;\n\t\t\t++measured.misses;\n\t\t\t++measured.outOfFrameMisses;''', 1)
text = text.replace(
'''\t\t\tauto fast = decodeWithoutErrorCorrection(track.sampled);\n\t\t\tmeasured.bitExtractionMs += emscripten_get_now() - fastStarted;\n\t\t\tif (fast.isValid()) {''',
'''\t\t\tauto fast = decodeWithoutErrorCorrection(track.sampled);\n\t\t\tmeasured.bitExtractionMs += emscripten_get_now() - fastStarted;\n\t\t\tif (!fast.isValid())\n\t\t\t\t++measured.bitstreamFailures;\n\t\t\tif (fast.isValid()) {''', 1)
text = text.replace(
'''\t\t\t\tif (crcOK) {\n\t\t\t\t\tfastPacket.assign(bytes.begin(), bytes.end() - 4);\n\t\t\t\t\t++measured.crcFastSuccesses;\n\t\t\t\t}\n''',
'''\t\t\t\tif (crcOK) {\n\t\t\t\t\tfastPacket.assign(bytes.begin(), bytes.end() - 4);\n\t\t\t\t\t++measured.crcFastSuccesses;\n\t\t\t\t} else {\n\t\t\t\t\t++measured.crcFailures;\n\t\t\t\t}\n''', 1)
text = text.replace(
'''\t\t\tif (packet.empty() && canMultiSample && !sampledMulti) {\n\t\t\t\tif (sampleGrid(true)) {''',
'''\t\t\tif (packet.empty() && canMultiSample && !sampledMulti) {\n\t\t\t\t++measured.multiSampleRetries;\n\t\t\t\tif (sampleGrid(true)) {''', 1)
cpp.write_text(text)

# Worker-side struct size/offsets.
replace("receive/worker.js", "const NATIVE_BATCH_METRICS_BYTES = 72;", "const NATIVE_BATCH_METRICS_BYTES = 104;")
replace(
    "receive/worker.js",
    '''    crcFastSuccesses: view.getUint32(nativeMetricsPtr + 64, true),\n    rsFallbacks: view.getUint32(nativeMetricsPtr + 68, true)\n  };''',
    '''    crcFastSuccesses: view.getUint32(nativeMetricsPtr + 64, true),\n    rsFallbacks: view.getUint32(nativeMetricsPtr + 68, true),\n    anchorSuccesses: view.getUint32(nativeMetricsPtr + 72, true),\n    anchorMisses: view.getUint32(nativeMetricsPtr + 76, true),\n    thresholdFallbacks: view.getUint32(nativeMetricsPtr + 80, true),\n    outOfFrameMisses: view.getUint32(nativeMetricsPtr + 84, true),\n    bitstreamFailures: view.getUint32(nativeMetricsPtr + 88, true),\n    crcFailures: view.getUint32(nativeMetricsPtr + 92, true),\n    multiSampleRetries: view.getUint32(nativeMetricsPtr + 96, true)\n  };'''
)

# Main-thread audit counters.
replace(
    "receive/main.js",
    '''  rsFallbacks: 0,\n  localRecoveryAttempts: 0,''',
    '''  rsFallbacks: 0,\n  anchorSuccesses: 0,\n  anchorMisses: 0,\n  thresholdFallbacks: 0,\n  outOfFrameMisses: 0,\n  bitstreamFailures: 0,\n  crcFailures: 0,\n  multiSampleRetries: 0,\n  localRecoveryAttempts: 0,'''
)
replace(
    "receive/main.js",
    '''    hotPathAudit.rsFallbacks += completion.nativeMetrics.rsFallbacks ?? 0;\n  }''',
    '''    hotPathAudit.rsFallbacks += completion.nativeMetrics.rsFallbacks ?? 0;\n    hotPathAudit.anchorSuccesses += completion.nativeMetrics.anchorSuccesses ?? 0;\n    hotPathAudit.anchorMisses += completion.nativeMetrics.anchorMisses ?? 0;\n    hotPathAudit.thresholdFallbacks += completion.nativeMetrics.thresholdFallbacks ?? 0;\n    hotPathAudit.outOfFrameMisses += completion.nativeMetrics.outOfFrameMisses ?? 0;\n    hotPathAudit.bitstreamFailures += completion.nativeMetrics.bitstreamFailures ?? 0;\n    hotPathAudit.crcFailures += completion.nativeMetrics.crcFailures ?? 0;\n    hotPathAudit.multiSampleRetries += completion.nativeMetrics.multiSampleRetries ?? 0;\n  }'''
)
replace(
    "receive/main.js",
    '''QR-RS ${hotPathAudit.rsFallbacks} · local robust ${hotPathAudit.localRecoverySuccesses}/${hotPathAudit.localRecoveryAttempts} · readFull ${hotPathAudit.readFullAttempts}\nGeneric full''',
    '''QR-RS ${hotPathAudit.rsFallbacks} · local robust ${hotPathAudit.localRecoverySuccesses}/${hotPathAudit.localRecoveryAttempts} · readFull ${hotPathAudit.readFullAttempts}\nMisses   anchor ${hotPathAudit.anchorMisses} · frame ${hotPathAudit.outOfFrameMisses} · bitstream ${hotPathAudit.bitstreamFailures} · CRC ${hotPathAudit.crcFailures}\nThreshold local fallback ${hotPathAudit.thresholdFallbacks} · multisample retries ${hotPathAudit.multiSampleRetries}\nGeneric full'''
)

# Saved benchmark hot-path breakdown.
replace(
    "receive/main.js",
    '''    const benchmarkRsFallbacks = benchmarkNative.reduce((sum, metrics) => sum + (metrics.rsFallbacks ?? 0), 0);\n    const benchmarkFallbackAttempts''',
    '''    const benchmarkRsFallbacks = benchmarkNative.reduce((sum, metrics) => sum + (metrics.rsFallbacks ?? 0), 0);\n    const sumNative = (key) => benchmarkNative.reduce((sum, metrics) => sum + (metrics[key] ?? 0), 0);\n    const benchmarkFallbackAttempts'''
)
replace(
    "receive/main.js",
    '''      qrRsFallbacks: benchmarkRsFallbacks,\n      localRecoveryAttempts:''',
    '''      qrRsFallbacks: benchmarkRsFallbacks,\n      anchorSuccesses: sumNative("anchorSuccesses"),\n      anchorMisses: sumNative("anchorMisses"),\n      thresholdFallbacks: sumNative("thresholdFallbacks"),\n      outOfFrameMisses: sumNative("outOfFrameMisses"),\n      bitstreamFailures: sumNative("bitstreamFailures"),\n      crcFailures: sumNative("crcFailures"),\n      multiSampleRetries: sumNative("multiSampleRetries"),\n      localRecoveryAttempts:'''
)

# Invariants.
assert "v0.5.53" in Path("index.html").read_text()
assert "airgapper-static-js-v16" in Path("sw.js").read_text()
assert "NATIVE_BATCH_METRICS_BYTES = 104" in Path("receive/worker.js").read_text()
assert "TRACK_THRESH_TILES = 8" in cpp.read_text()
assert "anchorMisses" in Path("receive/main.js").read_text()
