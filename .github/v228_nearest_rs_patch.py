from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"target not found in {path}: {old[:180]!r}")
    p.write_text(s.replace(old, new, count))


replace("main.js", 'const APP_BUILD = "v0.5.227";', 'const APP_BUILD = "v0.5.228";')
replace("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.227";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.228";')
replace("index.html", '<span class="brand">AirGapper <span class="app-version">v0.5.227</span></span>', '<span class="brand">AirGapper <span class="app-version">v0.5.228</span></span>')
replace("sw.js", 'const CACHE = "airgapper-static-js-v183";', 'const CACHE = "airgapper-static-js-v184";')
replace("vendor/decimen-codec/source/VERSION", "0.1.37\n", "0.1.38\n")

p = Path("vendor/decimen-codec/source/wrapper/decimen_codec.cpp")
s = p.read_text()
old = '''            if (centerOnly) {\n                // Stable-RS already has full QR error correction and AirGapper\n                // CRC. On a pure-translation calibrated wall, first give RS the\n                // single bilinear module-center sample instead of spending up to\n                // five reads on every threshold-adjacent cell. The caller retries\n                // this exact slot with the conservative voted sampler on failure.\n                const PointF p = turboWarpedPoint(cache, frameTransform, xx, y);\n                lum = turboLum(yPlane, width, height, stride, p, dx, dy);\n            } else {'''
new = '''            if (centerOnly) {\n                // This path is limited by the caller to calibrated dense QRs\n                // whose live pose is pure translation. Let QR RS absorb an\n                // occasional phase-adjacent module and use one luminance byte\n                // per data cell. AirGapper CRC remains the exact acceptance\n                // gate; failure retries the old bilinear/voted sampler in this\n                // same slot before sparse Guided recovery can run.\n                const PointF p = turboWarpedPoint(cache, frameTransform, xx, y);\n                lum = turboNearestLum(yPlane, width, height, stride, p, dx, dy);\n            } else {'''
if old not in s:
    raise SystemExit("v227 center-only Stable-RS block not found")
s = s.replace(old, new, 1)
p.write_text(s)
