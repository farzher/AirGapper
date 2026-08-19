from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected exactly one match, found {count}: {old[:220]!r}")
    p.write_text(text.replace(old, new, 1))


cpp = "vendor/decimen-codec/source/wrapper/decimen_codec.cpp"

old = """struct TurboThresholdPlane
{
    float base = 128;
    float stepX = 0;
    float stepY = 0;
    int lo = 0;
    int hi = 255;
};

static TurboThresholdPlane turboThresholdPlane(const TurboLevels& levels, int dim)
{
    const float invDim = 1.0f / float(dim);
    TurboThresholdPlane plane;
    plane.stepX = float(levels.tr - levels.tl) * invDim;
    plane.stepY = float(levels.bl - levels.tl) * invDim;
    plane.base = float(levels.tl) + 0.5f * (plane.stepX + plane.stepY);
    plane.lo = std::min({levels.tl, levels.tr, levels.bl}) - 12;
    plane.hi = std::max({levels.tl, levels.tr, levels.bl}) + 12;
    return plane;
}

static int turboThreshold(const TurboThresholdPlane& plane, int x, int y)
{
    const float t = plane.base + plane.stepX * float(x) + plane.stepY * float(y);
    return std::clamp(int(std::lround(t)), plane.lo, plane.hi);
}
"""
new = """struct TurboThresholdPlane
{
    // QR Model-2 tops out at 177 modules. The three finder-derived threshold
    // anchors are fixed for one QR attempt, so precompute the two separable
    // terms once instead of doing two floating multiplies for every sampled bit.
    // Arrays are intentionally not value-initialized; only [0, dim) is read.
    std::array<float, 177> xBase;
    std::array<float, 177> yTerm;
    int lo = 0;
    int hi = 255;
};

static TurboThresholdPlane turboThresholdPlane(const TurboLevels& levels, int dim)
{
    const float invDim = 1.0f / float(dim);
    const float stepX = float(levels.tr - levels.tl) * invDim;
    const float stepY = float(levels.bl - levels.tl) * invDim;
    const float base = float(levels.tl) + 0.5f * (stepX + stepY);
    TurboThresholdPlane plane;
    // Preserve the original left-associated float expression exactly:
    // (base + stepX*x) + stepY*y. We cache each product/subexpression but do
    // not change rounding, clamp, threshold, sampling, RS, or CRC semantics.
    for (int x = 0; x < dim; ++x)
        plane.xBase[x] = base + stepX * float(x);
    for (int y = 0; y < dim; ++y)
        plane.yTerm[y] = stepY * float(y);
    plane.lo = std::min({levels.tl, levels.tr, levels.bl}) - 12;
    plane.hi = std::max({levels.tl, levels.tr, levels.bl}) + 12;
    return plane;
}

static int turboThreshold(const TurboThresholdPlane& plane, int x, int y)
{
    const float t = plane.xBase[x] + plane.yTerm[y];
    return std::clamp(int(std::lround(t)), plane.lo, plane.hi);
}
"""
replace_once(cpp, old, new)

replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.330";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.331";')
replace_once("send/main.js", 'const SEND_RUNTIME_BUILD = "v0.5.330";', 'const SEND_RUNTIME_BUILD = "v0.5.331";')
replace_once("main.js", 'const APP_BUILD = "v0.5.330";', 'const APP_BUILD = "v0.5.331";')
replace_once("index.html", '<span class="app-version">v0.5.330</span>', '<span class="app-version">v0.5.331</span>')
replace_once("index.html", './main.js?build=v0.5.330', './main.js?build=v0.5.331')
replace_once("sw.js", 'const CACHE = "airgapper-static-js-v278";', 'const CACHE = "airgapper-static-js-v279";')

print("staged v0.5.331: precompute separable threshold-plane terms per QR attempt")
