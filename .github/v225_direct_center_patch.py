from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"target not found in {path}: {old[:180]!r}")
    p.write_text(s.replace(old, new, count))


replace("main.js", 'const APP_BUILD = "v0.5.224";', 'const APP_BUILD = "v0.5.225";')
replace("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.224";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.225";')
replace("index.html", '<span class="brand">AirGapper <span class="app-version">v0.5.224</span></span>', '<span class="brand">AirGapper <span class="app-version">v0.5.225</span></span>')
replace("sw.js", 'const CACHE = "airgapper-static-js-v180";', 'const CACHE = "airgapper-static-js-v181";')
replace("vendor/decimen-codec/source/VERSION", "0.1.34\n", "0.1.35\n")

p = Path("vendor/decimen-codec/source/wrapper/decimen_codec.cpp")
s = p.read_text()
old = '''            if (frameTransform.translationOnly && moduleSize >= GUIDED_TURBO_NEAREST_MIN_MODULE) {\n                // Stable tripod/handheld-hold case: a calibrated module center\n                // that is far from the live threshold does not need four-pixel\n                // bilinear interpolation. One Y byte is enough. Borderline\n                // modules retain the existing bilinear + in-cell vote. Any\n                // confident-but-wrong read is rejected by AirGapper CRC and\n                // Stable-RS runs immediately in this same tracked job.\n                const PointF p = turboWarpedPoint(cache, frameTransform, xx, y);\n                lum = turboNearestLum(yPlane, width, height, stride, p, dx, dy);\n                if (lum >= 0 && std::abs(lum - threshold) <= GUIDED_TURBO_NEAREST_AMBIGUOUS)\n                    lum = turboModuleLum(cache, track, frameTransform, yPlane, width, height, stride,\n                                         xx, y, dx, dy, threshold, moduleSize);\n            } else {'''
new = '''            if (frameTransform.translationOnly && moduleSize >= GUIDED_TURBO_NEAREST_MIN_MODULE) {\n                // This slot already earned CRC-Turbo by repeatedly surviving\n                // full RS+CRC, and the live quad differs only by translation.\n                // Read the calibrated module center directly. AirGapper CRC is\n                // still the acceptance gate; a single bad page immediately\n                // falls through to Stable-RS and backs this probe off.\n                const PointF p = turboWarpedPoint(cache, frameTransform, xx, y);\n                lum = turboNearestLum(yPlane, width, height, stride, p, dx, dy);\n            } else {'''
if old not in s:
    raise SystemExit("v224 nearest-confidence block not found")
s = s.replace(old, new, 1)
p.write_text(s)
