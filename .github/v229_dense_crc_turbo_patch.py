from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"target not found in {path}: {old[:180]!r}")
    p.write_text(s.replace(old, new, count))


replace("main.js", 'const APP_BUILD = "v0.5.228";', 'const APP_BUILD = "v0.5.229";')
replace("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.228";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.229";')
replace("index.html", '<span class="brand">AirGapper <span class="app-version">v0.5.228</span></span>', '<span class="brand">AirGapper <span class="app-version">v0.5.229</span></span>')
replace("sw.js", 'const CACHE = "airgapper-static-js-v184";', 'const CACHE = "airgapper-static-js-v185";')
replace("vendor/decimen-codec/source/VERSION", "0.1.38\n", "0.1.39\n")

p = Path("vendor/decimen-codec/source/wrapper/decimen_codec.cpp")
s = p.read_text()
old = '''                        const bool stableDirectEligible =\n                            guidedModuleSize(track) >= GUIDED_TURBO_CANARY_MIN_MODULE &&\n                            cache->stableSuccesses >= 2 && !cache->cooldown;'''
new = '''                        const float stableModuleSize = guidedModuleSize(track);\n                        const bool denseDirectCanary =\n                            frameTransform.translationOnly &&\n                            stableModuleSize >= GUIDED_STABLE_RS_MIN_MODULE &&\n                            stableModuleSize < GUIDED_TURBO_CANARY_MIN_MODULE &&\n                            cache->stableSuccesses >= 4;\n                        const bool stableDirectEligible = !cache->cooldown && (\n                            (stableModuleSize >= GUIDED_TURBO_CANARY_MIN_MODULE && cache->stableSuccesses >= 2) ||\n                            denseDirectCanary\n                        );'''
if old not in s:
    raise SystemExit("stableDirectEligible target not found")
s = s.replace(old, new, 1)
p.write_text(s)
