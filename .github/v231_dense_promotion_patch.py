from pathlib import Path

def repl(path,old,new,n=1):
 p=Path(path); s=p.read_text()
 if old not in s: raise SystemExit(f'target missing {path}: {old[:160]!r}')
 p.write_text(s.replace(old,new,n))

repl('main.js','const APP_BUILD = "v0.5.230";','const APP_BUILD = "v0.5.231";')
repl('receive/main.js','const RECEIVER_RUNTIME_BUILD = "v0.5.230";','const RECEIVER_RUNTIME_BUILD = "v0.5.231";')
repl('index.html','<span class="brand">AirGapper <span class="app-version">v0.5.230</span></span>','<span class="brand">AirGapper <span class="app-version">v0.5.231</span></span>')
repl('sw.js','const CACHE = "airgapper-static-js-v186";','const CACHE = "airgapper-static-js-v187";')
repl('vendor/decimen-codec/source/VERSION','0.1.40\n','0.1.41\n')

p=Path('vendor/decimen-codec/source/wrapper/decimen_codec.cpp'); s=p.read_text()
old='''            const bool provenDenseNearest =
                frameTransform.translationOnly &&
                moduleSize >= GUIDED_STABLE_RS_MIN_MODULE &&
                cache.stableSuccesses >= 4;
            if (frameTransform.translationOnly &&
                (moduleSize >= GUIDED_TURBO_NEAREST_MIN_MODULE || provenDenseNearest)) {
                // CRC-Turbo has no QR RS, so dense nearest-center sampling is
                // allowed only after this exact calibrated slot has repeatedly
                // passed Stable-RS + AirGapper CRC. A wrong center bit cannot be
                // accepted: CRC failure falls through to Stable-RS immediately
                // and the caller backs the probe off.
                const PointF p = turboWarpedPoint(cache, frameTransform, xx, y);
                lum = turboNearestLum(yPlane, width, height, stride, p, dx, dy);
            } else {'''
new='''            if (frameTransform.translationOnly && moduleSize >= GUIDED_TURBO_NEAREST_MIN_MODULE) {
                // High-resolution CRC-Turbo can use one calibrated center byte.
                // Dense CRC-Turbo deliberately retains the conservative
                // bilinear/ambiguity-voted sampler below; its win comes from
                // skipping RS, not from weakening optical sampling.
                const PointF p = turboWarpedPoint(cache, frameTransform, xx, y);
                lum = turboNearestLum(yPlane, width, height, stride, p, dx, dy);
            } else {'''
if old not in s: raise SystemExit('v230 dense nearest block missing')
s=s.replace(old,new,1)
s=s.replace('cache->stableSuccesses >= 4;','cache->stableSuccesses >= 2;',1)
p.write_text(s)
