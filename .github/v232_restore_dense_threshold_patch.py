from pathlib import Path


def repl(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"target missing {path}: {old[:180]!r}")
    p.write_text(s.replace(old, new, count))


repl('main.js', 'const APP_BUILD = "v0.5.231";', 'const APP_BUILD = "v0.5.232";')
repl('receive/main.js', 'const RECEIVER_RUNTIME_BUILD = "v0.5.231";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.232";')
repl('index.html', '<span class="brand">AirGapper <span class="app-version">v0.5.231</span></span>', '<span class="brand">AirGapper <span class="app-version">v0.5.232</span></span>')
repl('sw.js', 'const CACHE = "airgapper-static-js-v187";', 'const CACHE = "airgapper-static-js-v188";')
repl('vendor/decimen-codec/source/VERSION', '0.1.41\n', '0.1.42\n')

p = Path('vendor/decimen-codec/source/wrapper/decimen_codec.cpp')
s = p.read_text()
old = '''const bool denseDirectCanary =
                            frameTransform.translationOnly &&
                            stableModuleSize >= GUIDED_STABLE_RS_MIN_MODULE &&
                            stableModuleSize < GUIDED_TURBO_CANARY_MIN_MODULE &&
                            cache->stableSuccesses >= 2;'''
new = '''const bool denseDirectCanary =
                            frameTransform.translationOnly &&
                            stableModuleSize >= GUIDED_STABLE_RS_MIN_MODULE &&
                            stableModuleSize < GUIDED_TURBO_CANARY_MIN_MODULE &&
                            // Dense no-RS sampling is more expensive than the
                            // nearest-center Stable-RS lane. Require four exact
                            // RS+CRC proofs before spending that probe; v229
                            // measured this as the better crossover point.
                            cache->stableSuccesses >= 4;'''
if old not in s:
    raise SystemExit('denseDirectCanary v231 threshold target missing')
s = s.replace(old, new, 1)
p.write_text(s)
