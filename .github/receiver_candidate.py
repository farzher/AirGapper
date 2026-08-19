from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected exactly one match, found {count}: {old[:200]!r}")
    p.write_text(text.replace(old, new, 1))


cpp = "vendor/decimen-codec/source/wrapper/decimen_codec.cpp"

# Do not rebuild a 177x177 distortion map after a single cached miss. The
# current-frame Sparse path can carry that frame without constructing ~31k map
# points. A successful Stable-RS on the next frame clears cache->misses; only a
# second consecutive repair-authorized Stable-RS miss requests a fresh map.
# Geometry failures already set distortionAware=false via stableNeedsRefresh and
# therefore still rebuild immediately through turboSeedEligible(). Temporal/CPU
# fenced misses never request a map rebuild.
replace_once(
    cpp,
    "            if (!success && stableEligible && stableRsAttempted)\n                refreshTurboFromSparse[i] = 1;",
    "            if (!success && stableEligible && stableRsAttempted &&\n"
    "                allowExpensiveRepair && cache->misses > 0)\n"
    "                refreshTurboFromSparse[i] = 1;"
)

replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.323";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.324";')
replace_once("send/main.js", 'const SEND_RUNTIME_BUILD = "v0.5.323";', 'const SEND_RUNTIME_BUILD = "v0.5.324";')
replace_once("main.js", 'const APP_BUILD = "v0.5.323";', 'const APP_BUILD = "v0.5.324";')
replace_once("index.html", '<span class="app-version">v0.5.323</span>', '<span class="app-version">v0.5.324</span>')
replace_once("index.html", './main.js?build=v0.5.323', './main.js?build=v0.5.324')
replace_once("sw.js", 'const CACHE = "airgapper-static-js-v271";', 'const CACHE = "airgapper-static-js-v272";')

print("staged v0.5.324: rebuild distortion maps only after repeated cached failure")
