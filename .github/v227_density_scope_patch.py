from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"target not found in {path}: {old[:180]!r}")
    p.write_text(s.replace(old, new, count))


replace("main.js", 'const APP_BUILD = "v0.5.226";', 'const APP_BUILD = "v0.5.227";')
replace("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.226";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.227";')
replace("index.html", '<span class="brand">AirGapper <span class="app-version">v0.5.226</span></span>', '<span class="brand">AirGapper <span class="app-version">v0.5.227</span></span>')
replace("sw.js", 'const CACHE = "airgapper-static-js-v182";', 'const CACHE = "airgapper-static-js-v183";')
replace("vendor/decimen-codec/source/VERSION", "0.1.36\n", "0.1.37\n")

replace(
    "vendor/decimen-codec/source/wrapper/decimen_codec.cpp",
    'const bool centerOnlyRs = frameTransform.translationOnly;',
    '''const bool centerOnlyRs = frameTransform.translationOnly &&
                                guidedModuleSize(track) < GUIDED_TURBO_NEAREST_MIN_MODULE;'''
)
