from pathlib import Path

def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing anchor in {path}: {old[:100]!r}")
    p.write_text(text.replace(old, new, 1))

cpp = Path("vendor/decimen-codec/source/wrapper/decimen_codec.cpp")
s = cpp.read_text()
old = '''static int turboThreshold(const TurboLevels& levels, int x, int y, int dim)
{
    const float fx = (x + 0.5f) / dim;
    const float fy = (y + 0.5f) / dim;
    const float t = levels.tl + (levels.tr - levels.tl) * fx + (levels.bl - levels.tl) * fy;
    const int lo = std::min({levels.tl, levels.tr, levels.bl}) - 12;
    const int hi = std::max({levels.tl, levels.tr, levels.bl}) + 12;
    return std::clamp(int(std::lround(t)), lo, hi);
}
'''
new = '''struct TurboThresholdPlane
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
'''
if old not in s:
    raise SystemExit("threshold function anchor missing")
s = s.replace(old, new, 1)
# Exactly two stable/data samplers use the threshold. Hoist all invariant math once per QR.
s = s.replace(
    '    const float moduleSize = guidedModuleSize(track);\n    bool failed = false;',
    '    const float moduleSize = guidedModuleSize(track);\n    const auto thresholdPlane = turboThresholdPlane(levels, dim);\n    bool failed = false;',
    1,
)
s = s.replace('const int threshold = turboThreshold(levels, xx, y, dim);', 'const int threshold = turboThreshold(thresholdPlane, xx, y);', 1)
# Stable-RS has its own moduleSize declaration later.
needle = '    const float moduleSize = guidedModuleSize(track);\n    auto sampleByte = [&](const std::vector<uint32_t>& plan, size_t firstBit,'
replacement = '    const float moduleSize = guidedModuleSize(track);\n    const auto thresholdPlane = turboThresholdPlane(levels, dim);\n    auto sampleByte = [&](const std::vector<uint32_t>& plan, size_t firstBit,'
if needle not in s:
    raise SystemExit("Stable-RS module anchor missing")
s = s.replace(needle, replacement, 1)
s = s.replace('const int threshold = turboThreshold(levels, xx, y, dim);', 'const int threshold = turboThreshold(thresholdPlane, xx, y);', 1)
if 'turboThreshold(levels,' in s:
    raise SystemExit("old per-bit threshold call remains")
cpp.write_text(s)

Path("vendor/decimen-codec/source/VERSION").write_text("0.1.55\n")
replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.258";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.259";')
replace_once("main.js", 'const APP_BUILD = "v0.5.258";', 'const APP_BUILD = "v0.5.259";')
index = Path("index.html").read_text().replace('v0.5.258', 'v0.5.259')
Path("index.html").write_text(index)
sw = Path("sw.js").read_text().replace('airgapper-static-js-v211', 'airgapper-static-js-v212', 1)
Path("sw.js").write_text(sw)
