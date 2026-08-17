from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"target not found in {path}: {old[:180]!r}")
    p.write_text(s.replace(old, new, count))


replace("main.js", 'const APP_BUILD = "v0.5.225";', 'const APP_BUILD = "v0.5.226";')
replace("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.225";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.226";')
replace("index.html", '<span class="brand">AirGapper <span class="app-version">v0.5.225</span></span>', '<span class="brand">AirGapper <span class="app-version">v0.5.226</span></span>')
replace("sw.js", 'const CACHE = "airgapper-static-js-v181";', 'const CACHE = "airgapper-static-js-v182";')
replace("vendor/decimen-codec/source/VERSION", "0.1.35\n", "0.1.36\n")

p = Path("vendor/decimen-codec/source/wrapper/decimen_codec.cpp")
s = p.read_text()
old = '''static DecoderResult decodeTurboStableRS(const GuidedTurboTrack& cache,\n                                         const DecimenGuidedTrack& track,\n                                         const TurboFrameTransform& frameTransform,\n                                         const uint8_t* yPlane, int width, int height, int stride,\n                                         float dx, float dy, const TurboLevels& levels,\n                                         DecimenGuidedMetrics& metrics)'''
new = '''static DecoderResult decodeTurboStableRS(const GuidedTurboTrack& cache,\n                                         const DecimenGuidedTrack& track,\n                                         const TurboFrameTransform& frameTransform,\n                                         const uint8_t* yPlane, int width, int height, int stride,\n                                         float dx, float dy, const TurboLevels& levels,\n                                         DecimenGuidedMetrics& metrics, bool centerOnly = false)'''
if old not in s:
    raise SystemExit("Stable-RS signature target missing")
s = s.replace(old, new, 1)

old = '''            const int threshold = turboThreshold(levels, xx, y, dim);\n            const int lum = turboModuleLum(cache, track, frameTransform,\n                                           yPlane, width, height, stride,\n                                           xx, y, dx, dy, threshold, moduleSize);\n            if (lum < 0) { failed = true; break; }'''
new = '''            const int threshold = turboThreshold(levels, xx, y, dim);\n            int lum;\n            if (centerOnly) {\n                // Stable-RS already has full QR error correction and AirGapper\n                // CRC. On a pure-translation calibrated wall, first give RS the\n                // single bilinear module-center sample instead of spending up to\n                // five reads on every threshold-adjacent cell. The caller retries\n                // this exact slot with the conservative voted sampler on failure.\n                const PointF p = turboWarpedPoint(cache, frameTransform, xx, y);\n                lum = turboLum(yPlane, width, height, stride, p, dx, dy);\n            } else {\n                lum = turboModuleLum(cache, track, frameTransform,\n                                     yPlane, width, height, stride,\n                                     xx, y, dx, dy, threshold, moduleSize);\n            }\n            if (lum < 0) { failed = true; break; }'''
if old not in s:
    raise SystemExit("Stable-RS module sampler target missing")
s = s.replace(old, new, 1)

old = '''                            auto decoded = decodeTurboStableRS(*cache, track, frameTransform,\n                                                               yPlane, width, height, stride,\n                                                               dx, dy, levels, *metrics);\n                            success = commitTurbo(i, decoded, wallCorrectionX, wallCorrectionY);\n                            if (success) {'''
new = '''                            const bool centerOnlyRs = frameTransform.translationOnly;\n                            auto decoded = decodeTurboStableRS(*cache, track, frameTransform,\n                                                               yPlane, width, height, stride,\n                                                               dx, dy, levels, *metrics, centerOnlyRs);\n                            success = commitTurbo(i, decoded, wallCorrectionX, wallCorrectionY);\n                            if (!success && centerOnlyRs) {\n                                // No correctness regression: if single-center RS\n                                // cannot reconstruct an exact CRC-valid packet,\n                                // retry the old ambiguity-voted sampler before\n                                // handing the slot to sparse Guided recovery.\n                                decoded = decodeTurboStableRS(*cache, track, frameTransform,\n                                                              yPlane, width, height, stride,\n                                                              dx, dy, levels, *metrics, false);\n                                success = commitTurbo(i, decoded, wallCorrectionX, wallCorrectionY);\n                            }\n                            if (success) {'''
if old not in s:
    raise SystemExit("Stable-RS caller target missing")
s = s.replace(old, new, 1)
p.write_text(s)
