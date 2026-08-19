from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected exactly one match, found {count}: {old[:180]!r}")
    p.write_text(text.replace(old, new, 1))


cpp = "vendor/decimen-codec/source/wrapper/decimen_codec.cpp"

# v317 proved that finder agreement alone is not enough to stop sub-pixel
# refinement at ~2 px/module: a 0.5 px phase improvement can prevent thousands
# of later ambiguity-vote samples. Restore the full half-pixel refinement.
replace_once(
    cpp,
    "    consider(predictedX, predictedY);\n    if (bestMatches >= 146)\n        return best;\n    if (bestMatches < 143) {",
    "    consider(predictedX, predictedY);\n    if (bestMatches < 143) {"
)
replace_once(
    cpp,
    "    if (bestScore < 0)\n        return std::nullopt;\n    // A coarse integer search that already lands essentially perfectly is\n    // also done. Avoid eight additional half-pixel finder reads.\n    if (bestMatches >= 146)\n        return best;\n    const PointF coarse = best;",
    "    if (bestScore < 0)\n        return std::nullopt;\n    const PointF coarse = best;"
)

# Version/cache busts. Keep v315 per-slot learning, v316's 8/16 adaptation,
# strict repair-mask reference fencing, and the deterministic benchmark barrier.
replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.317";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.318";')
replace_once("send/main.js", 'const SEND_RUNTIME_BUILD = "v0.5.317";', 'const SEND_RUNTIME_BUILD = "v0.5.318";')
replace_once("main.js", 'const APP_BUILD = "v0.5.317";', 'const APP_BUILD = "v0.5.318";')
replace_once("index.html", '<span class="app-version">v0.5.317</span>', '<span class="app-version">v0.5.318</span>')
replace_once("index.html", './main.js?build=v0.5.317', './main.js?build=v0.5.318')
replace_once("sw.js", 'const CACHE = "airgapper-static-js-v265";', 'const CACHE = "airgapper-static-js-v266";')

print("staged v0.5.318: restore precise subpixel wall phase while keeping per-slot learning")
