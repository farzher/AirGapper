from pathlib import Path


def replace(path, old, new, count=1):
    p=Path(path); s=p.read_text()
    if old not in s: raise SystemExit(f"target not found in {path}: {old[:180]!r}")
    p.write_text(s.replace(old,new,count))

replace('main.js','const APP_BUILD = "v0.5.229";','const APP_BUILD = "v0.5.230";')
replace('receive/main.js','const RECEIVER_RUNTIME_BUILD = "v0.5.229";','const RECEIVER_RUNTIME_BUILD = "v0.5.230";')
replace('index.html','<span class="brand">AirGapper <span class="app-version">v0.5.229</span></span>','<span class="brand">AirGapper <span class="app-version">v0.5.230</span></span>')
replace('sw.js','const CACHE = "airgapper-static-js-v185";','const CACHE = "airgapper-static-js-v186";')
replace('vendor/decimen-codec/source/VERSION','0.1.39\n','0.1.40\n')

p=Path('vendor/decimen-codec/source/wrapper/decimen_codec.cpp'); s=p.read_text()
old='''            if (frameTransform.translationOnly && moduleSize >= GUIDED_TURBO_NEAREST_MIN_MODULE) {\n                // This slot already earned CRC-Turbo by repeatedly surviving\n                // full RS+CRC, and the live quad differs only by translation.\n                // Read the calibrated module center directly. AirGapper CRC is\n                // still the acceptance gate; a single bad page immediately\n                // falls through to Stable-RS and backs this probe off.\n                const PointF p = turboWarpedPoint(cache, frameTransform, xx, y);\n                lum = turboNearestLum(yPlane, width, height, stride, p, dx, dy);\n            } else {'''
new='''            const bool provenDenseNearest =\n                frameTransform.translationOnly &&\n                moduleSize >= GUIDED_STABLE_RS_MIN_MODULE &&\n                cache.stableSuccesses >= 4;\n            if (frameTransform.translationOnly &&\n                (moduleSize >= GUIDED_TURBO_NEAREST_MIN_MODULE || provenDenseNearest)) {\n                // CRC-Turbo has no QR RS, so dense nearest-center sampling is\n                // allowed only after this exact calibrated slot has repeatedly\n                // passed Stable-RS + AirGapper CRC. A wrong center bit cannot be\n                // accepted: CRC failure falls through to Stable-RS immediately\n                // and the caller backs the probe off.\n                const PointF p = turboWarpedPoint(cache, frameTransform, xx, y);\n                lum = turboNearestLum(yPlane, width, height, stride, p, dx, dy);\n            } else {'''
if old not in s: raise SystemExit('data-only sampling branch not found')
s=s.replace(old,new,1); p.write_text(s)
