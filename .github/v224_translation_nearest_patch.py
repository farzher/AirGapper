from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"target not found in {path}: {old[:160]!r}")
    p.write_text(s.replace(old, new, count))


# App/runtime/cache versions. v218-v223 changed the codec without advancing the
# app-visible build, which made it too easy for phone tests to run stale assets.
replace("main.js", 'const APP_BUILD = "v0.5.217";', 'const APP_BUILD = "v0.5.224";')
replace("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.217";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.224";')
replace("index.html", '<span class="brand">AirGapper <span class="app-version">v0.5.217</span></span>', '<span class="brand">AirGapper <span class="app-version">v0.5.224</span></span>')
replace("sw.js", 'const CACHE = "airgapper-static-js-v179";', 'const CACHE = "airgapper-static-js-v180";')
replace("vendor/decimen-codec/source/VERSION", "0.1.33\n", "0.1.34\n")

p = Path("vendor/decimen-codec/source/wrapper/decimen_codec.cpp")
s = p.read_text()
s = s.replace(
    '''constexpr float GUIDED_TURBO_CANARY_MIN_MODULE = 2.25f;\nconstexpr float GUIDED_STABLE_RS_MIN_MODULE = 1.75f;\nconstexpr int GUIDED_TURBO_BAD_COOLDOWN = 6;''',
    '''constexpr float GUIDED_TURBO_CANARY_MIN_MODULE = 2.25f;\nconstexpr float GUIDED_STABLE_RS_MIN_MODULE = 1.75f;\n// The one-pixel center sampler is intentionally stricter than CRC-Turbo itself.\n// It is only used after a map has repeatedly passed RS+CRC and the live pose is\n// pure translation. Anything closer to the optical limit keeps bilinear Y.\nconstexpr float GUIDED_TURBO_NEAREST_MIN_MODULE = 2.75f;\nconstexpr int GUIDED_TURBO_NEAREST_AMBIGUOUS = 18;\nconstexpr int GUIDED_TURBO_BAD_COOLDOWN = 6;''',
    1
)
if "GUIDED_TURBO_NEAREST_MIN_MODULE" not in s:
    raise SystemExit("constant insertion failed")

old = '''static TurboLevels turboReadLevels(const GuidedTurboTrack& cache, const DecimenGuidedTrack& track,\n                                   const TurboFrameTransform& frameTransform,'''
helper = '''static int turboNearestLum(const uint8_t* yPlane, int width, int height, int stride, PointF p, float dx, float dy)\n{\n    const int x = int(std::lround(float(p.x) + dx));\n    const int y = int(std::lround(float(p.y) + dy));\n    if (x < 0 || y < 0 || x >= width || y >= height)\n        return -1;\n    return yPlane[size_t(y) * stride + x];\n}\n\nstatic TurboLevels turboReadLevels(const GuidedTurboTrack& cache, const DecimenGuidedTrack& track,\n                                   const TurboFrameTransform& frameTransform,'''
if old not in s:
    raise SystemExit("nearest helper anchor missing")
s = s.replace(old, helper, 1)

old = '''            const int threshold = turboThreshold(levels, xx, y, dim);\n            const int lum = turboModuleLum(cache, track, frameTransform, yPlane, width, height, stride,\n                                           xx, y, dx, dy, threshold, moduleSize);\n            if (lum < 0) { failed = true; break; }\n            value = uint8_t((value << 1) | uint8_t(mask != (lum <= threshold)));'''
new = '''            const int threshold = turboThreshold(levels, xx, y, dim);\n            int lum;\n            if (frameTransform.translationOnly && moduleSize >= GUIDED_TURBO_NEAREST_MIN_MODULE) {\n                // Stable tripod/handheld-hold case: a calibrated module center\n                // that is far from the live threshold does not need four-pixel\n                // bilinear interpolation. One Y byte is enough. Borderline\n                // modules retain the existing bilinear + in-cell vote. Any\n                // confident-but-wrong read is rejected by AirGapper CRC and\n                // Stable-RS runs immediately in this same tracked job.\n                const PointF p = turboWarpedPoint(cache, frameTransform, xx, y);\n                lum = turboNearestLum(yPlane, width, height, stride, p, dx, dy);\n                if (lum >= 0 && std::abs(lum - threshold) <= GUIDED_TURBO_NEAREST_AMBIGUOUS)\n                    lum = turboModuleLum(cache, track, frameTransform, yPlane, width, height, stride,\n                                         xx, y, dx, dy, threshold, moduleSize);\n            } else {\n                lum = turboModuleLum(cache, track, frameTransform, yPlane, width, height, stride,\n                                     xx, y, dx, dy, threshold, moduleSize);\n            }\n            if (lum < 0) { failed = true; break; }\n            value = uint8_t((value << 1) | uint8_t(mask != (lum <= threshold)));'''
# Replace only the CRC/data-only decoder occurrence; it appears before Stable-RS.
if old not in s:
    raise SystemExit("CRC-Turbo sample block missing")
s = s.replace(old, new, 1)
p.write_text(s)
