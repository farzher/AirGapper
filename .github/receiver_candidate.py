from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected exactly one match, found {count}: {old[:200]!r}")
    p.write_text(text.replace(old, new, 1))


cpp = "vendor/decimen-codec/source/wrapper/decimen_codec.cpp"
replace_once(
    cpp,
    "            if (!success && stableEligible && stableRsAttempted &&\n                allowExpensiveRepair && cache->misses > 0)\n                refreshTurboFromSparse[i] = 1;",
    "            if (!success && stableEligible && stableRsAttempted)\n"
    "                refreshTurboFromSparse[i] = 1;"
)

replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.324";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.325";')
replace_once("send/main.js", 'const SEND_RUNTIME_BUILD = "v0.5.324";', 'const SEND_RUNTIME_BUILD = "v0.5.325";')
replace_once("main.js", 'const APP_BUILD = "v0.5.324";', 'const APP_BUILD = "v0.5.325";')
replace_once("index.html", '<span class="app-version">v0.5.324</span>', '<span class="app-version">v0.5.325</span>')
replace_once("index.html", './main.js?build=v0.5.324', './main.js?build=v0.5.325')
replace_once("sw.js", 'const CACHE = "airgapper-static-js-v272";', 'const CACHE = "airgapper-static-js-v273";')

print("staged v0.5.325: restore immediate Sparse-proven distortion-map healing")
