from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected exactly one match, found {count}: {old[:220]!r}")
    p.write_text(text.replace(old, new, 1))


cpp = "vendor/decimen-codec/source/wrapper/decimen_codec.cpp"

replace_once(
    cpp,
    "                const uint32_t mask = uint32_t(QRCode::GetDataMaskBit(4, xx, y));\n"
    "                const uint32_t sampleIndex = uint32_t(y * dim + xx);\n"
    "                plan.push_back(uint32_t(xx) | (uint32_t(y) << 8) | (mask << 16) |\n"
    "                               (sampleIndex << 17));",
    "                const uint32_t mask = uint32_t(QRCode::GetDataMaskBit(4, xx, y));\n"
    "                plan.push_back(uint32_t(xx) | (uint32_t(y) << 8) | (mask << 16));"
)

replace_once(
    cpp,
    "static PointF turboWarpedPoint(const GuidedTurboTrack& cache,\n"
    "                               const TurboFrameTransform& frameTransform, int x, int y)\n"
    "{\n"
    "    const PointF p = cache.samples[size_t(y) * cache.dimension + x];\n"
    "    return frameTransform.perspectiveMesh ? frameTransform.meshWarp(p, x, y) : frameTransform(p);\n"
    "}\n\n"
    "static PointF turboWarpedPlanPoint(const GuidedTurboTrack& cache,\n"
    "                                   const TurboFrameTransform& frameTransform,\n"
    "                                   int x, int y, uint32_t sampleIndex)\n"
    "{\n"
    "    const PointF p = cache.samples[sampleIndex];\n"
    "    return frameTransform.perspectiveMesh ? frameTransform.meshWarp(p, x, y) : frameTransform(p);\n"
    "}\n",
    "static PointF turboWarpedPoint(const GuidedTurboTrack& cache,\n"
    "                               const TurboFrameTransform& frameTransform, int x, int y)\n"
    "{\n"
    "    const PointF p = cache.samples[size_t(y) * cache.dimension + x];\n"
    "    return frameTransform.perspectiveMesh ? frameTransform.meshWarp(p, x, y) : frameTransform(p);\n"
    "}\n"
)

replace_once(
    cpp,
    "static int turboModuleLum(const GuidedTurboTrack& cache, const DecimenGuidedTrack& track,\n"
    "                          const TurboFrameTransform& frameTransform,\n"
    "                          const uint8_t* yPlane, int width, int height, int stride, int x, int y,\n"
    "                          uint32_t sampleIndex, float dx, float dy, int threshold, float moduleSize)\n"
    "{\n"
    "    const PointF p = turboWarpedPlanPoint(cache, frameTransform, x, y, sampleIndex);",
    "static int turboModuleLum(const GuidedTurboTrack& cache, const DecimenGuidedTrack& track,\n"
    "                          const TurboFrameTransform& frameTransform,\n"
    "                          const uint8_t* yPlane, int width, int height, int stride, int x, int y,\n"
    "                          float dx, float dy, int threshold, float moduleSize)\n"
    "{\n"
    "    const PointF p = turboWarpedPoint(cache, frameTransform, x, y);"
)

# Remove packed-index declarations from the three hot samplers.
replace_once(
    cpp,
    "            const bool mask = ((entry >> 16) & 1) != 0;\n"
    "            const uint32_t sampleIndex = entry >> 17;\n"
    "            const int threshold = turboThreshold(thresholdPlane, xx, y);\n"
    "            int lum;\n"
    "            if (frameTransform.translationOnly && moduleSize >= GUIDED_TURBO_NEAREST_MIN_MODULE) {",
    "            const bool mask = ((entry >> 16) & 1) != 0;\n"
    "            const int threshold = turboThreshold(thresholdPlane, xx, y);\n"
    "            int lum;\n"
    "            if (frameTransform.translationOnly && moduleSize >= GUIDED_TURBO_NEAREST_MIN_MODULE) {"
)
replace_once(
    cpp,
    "                const PointF p = turboWarpedPlanPoint(cache, frameTransform, xx, y, sampleIndex);\n"
    "                lum = turboNearestLum(yPlane, width, height, stride, p, dx, dy);\n"
    "            } else {\n"
    "                lum = turboModuleLum(cache, track, frameTransform, yPlane, width, height, stride,\n"
    "                                     xx, y, sampleIndex, dx, dy, threshold, moduleSize);",
    "                const PointF p = turboWarpedPoint(cache, frameTransform, xx, y);\n"
    "                lum = turboNearestLum(yPlane, width, height, stride, p, dx, dy);\n"
    "            } else {\n"
    "                lum = turboModuleLum(cache, track, frameTransform, yPlane, width, height, stride,\n"
    "                                     xx, y, dx, dy, threshold, moduleSize);"
)
replace_once(
    cpp,
    "            const bool mask = ((entry >> 16) & 1) != 0;\n"
    "            const uint32_t sampleIndex = entry >> 17;\n"
    "            const int threshold = turboThreshold(thresholdPlane, xx, y);\n"
    "            int lum;\n"
    "            if (centerOnly) {\n"
    "                const PointF p = turboWarpedPlanPoint(cache, frameTransform, xx, y, sampleIndex);",
    "            const bool mask = ((entry >> 16) & 1) != 0;\n"
    "            const int threshold = turboThreshold(thresholdPlane, xx, y);\n"
    "            int lum;\n"
    "            if (centerOnly) {\n"
    "                const PointF p = turboWarpedPoint(cache, frameTransform, xx, y);"
)
replace_once(
    cpp,
    "                lum = turboModuleLum(cache, track, frameTransform,\n"
    "                                     yPlane, width, height, stride,\n"
    "                                     xx, y, sampleIndex, dx, dy, threshold, moduleSize);",
    "                lum = turboModuleLum(cache, track, frameTransform,\n"
    "                                     yPlane, width, height, stride,\n"
    "                                     xx, y, dx, dy, threshold, moduleSize);"
)
replace_once(
    cpp,
    "            const bool mask = ((entry >> 16) & 1) != 0;\n"
    "            const uint32_t sampleIndex = entry >> 17;\n"
    "            const int threshold = turboThreshold(thresholdPlane, xx, y);\n"
    "            const PointF p = turboWarpedPlanPoint(cache, frameTransform, xx, y, sampleIndex);\n"
    "            const int lum = turboLum(yPlane, width, height, stride, p, dx, dy);",
    "            const bool mask = ((entry >> 16) & 1) != 0;\n"
    "            const int threshold = turboThreshold(thresholdPlane, xx, y);\n"
    "            const PointF p = turboWarpedPoint(cache, frameTransform, xx, y);\n"
    "            const int lum = turboLum(yPlane, width, height, stride, p, dx, dy);"
)

replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.329";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.330";')
replace_once("send/main.js", 'const SEND_RUNTIME_BUILD = "v0.5.329";', 'const SEND_RUNTIME_BUILD = "v0.5.330";')
replace_once("main.js", 'const APP_BUILD = "v0.5.329";', 'const APP_BUILD = "v0.5.330";')
replace_once("index.html", '<span class="app-version">v0.5.329</span>', '<span class="app-version">v0.5.330</span>')
replace_once("index.html", './main.js?build=v0.5.329', './main.js?build=v0.5.330')
replace_once("sw.js", 'const CACHE = "airgapper-static-js-v277";', 'const CACHE = "airgapper-static-js-v278";')

print("staged v0.5.330: restore the v328 measured-fast hot path")
