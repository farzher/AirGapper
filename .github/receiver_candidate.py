from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected exactly one match, found {count}: {old[:180]!r}")
    p.write_text(text.replace(old, new, 1))


cpp = "vendor/decimen-codec/source/wrapper/decimen_codec.cpp"

old = """    const int dim = track.dimension;
    const PointF left = turboWarpedPoint(cache, frameTransform, std::max(0, x - 1), y);
    const PointF right = turboWarpedPoint(cache, frameTransform, std::min(dim - 1, x + 1), y);
    const PointF up = turboWarpedPoint(cache, frameTransform, x, std::max(0, y - 1));
    const PointF down = turboWarpedPoint(cache, frameTransform, x, std::min(dim - 1, y + 1));
    const float xDiv = (x > 0 && x + 1 < dim) ? 2.0f : 1.0f;
    const float yDiv = (y > 0 && y + 1 < dim) ? 2.0f : 1.0f;
    const PointF ux{(right.x - left.x) / xDiv, (right.y - left.y) / xDiv};
    const PointF uy{(down.x - up.x) / yDiv, (down.y - up.y) / yDiv};
"""
new = """    const int dim = track.dimension;
    const int lx = std::max(0, x - 1), rx = std::min(dim - 1, x + 1);
    const int uyIndex = std::max(0, y - 1), dyIndex = std::min(dim - 1, y + 1);
    const float xDiv = (x > 0 && x + 1 < dim) ? 2.0f : 1.0f;
    const float yDiv = (y > 0 && y + 1 < dim) ? 2.0f : 1.0f;
    PointF ux, uy;
    if (frameTransform.translationOnly) {
        // Translation cancels from neighboring-point differences exactly. The
        // distortion-aware cache already stores the calibrated module centers,
        // so do not re-run four transforms just to recover the same local basis.
        const PointF& left = cache.samples[size_t(y) * dim + lx];
        const PointF& right = cache.samples[size_t(y) * dim + rx];
        const PointF& up = cache.samples[size_t(uyIndex) * dim + x];
        const PointF& down = cache.samples[size_t(dyIndex) * dim + x];
        ux = PointF{(right.x - left.x) / xDiv, (right.y - left.y) / xDiv};
        uy = PointF{(down.x - up.x) / yDiv, (down.y - up.y) / yDiv};
    } else {
        const PointF left = turboWarpedPoint(cache, frameTransform, lx, y);
        const PointF right = turboWarpedPoint(cache, frameTransform, rx, y);
        const PointF up = turboWarpedPoint(cache, frameTransform, x, uyIndex);
        const PointF down = turboWarpedPoint(cache, frameTransform, x, dyIndex);
        ux = PointF{(right.x - left.x) / xDiv, (right.y - left.y) / xDiv};
        uy = PointF{(down.x - up.x) / yDiv, (down.y - up.y) / yDiv};
    }
"""
replace_once(cpp, old, new)

replace_once(
    cpp,
    "    std::sort(std::begin(values), std::end(values));\n    return values[2];",
    "    // We only need the median of five. A fixed eight-comparison network is\n"
    "    // cheaper in WASM than invoking the generic tiny-range sort thousands\n"
    "    // of times on a dense ambiguous frame, with identical output.\n"
    "    auto swapIf = [](int& a, int& b) { if (a > b) std::swap(a, b); };\n"
    "    swapIf(values[0], values[1]);\n"
    "    swapIf(values[3], values[4]);\n"
    "    swapIf(values[0], values[2]);\n"
    "    swapIf(values[1], values[2]);\n"
    "    swapIf(values[0], values[3]);\n"
    "    swapIf(values[2], values[3]);\n"
    "    swapIf(values[1], values[4]);\n"
    "    swapIf(values[1], values[2]);\n"
    "    return values[2];"
)

replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.318";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.319";')
replace_once("send/main.js", 'const SEND_RUNTIME_BUILD = "v0.5.318";', 'const SEND_RUNTIME_BUILD = "v0.5.319";')
replace_once("main.js", 'const APP_BUILD = "v0.5.318";', 'const APP_BUILD = "v0.5.319";')
replace_once("index.html", '<span class="app-version">v0.5.318</span>', '<span class="app-version">v0.5.319</span>')
replace_once("index.html", './main.js?build=v0.5.318', './main.js?build=v0.5.319')
replace_once("sw.js", 'const CACHE = "airgapper-static-js-v266";', 'const CACHE = "airgapper-static-js-v267";')

print("staged v0.5.319: cheaper exact ambiguity sampling on translation-dominant locked walls")
