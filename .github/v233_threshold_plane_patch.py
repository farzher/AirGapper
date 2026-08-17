from pathlib import Path


def repl(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"target missing {path}: {old[:180]!r}")
    p.write_text(s.replace(old, new, count))


repl('main.js', 'const APP_BUILD = "v0.5.232";', 'const APP_BUILD = "v0.5.233";')
repl('receive/main.js', 'const RECEIVER_RUNTIME_BUILD = "v0.5.232";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.233";')
repl('index.html', '<span class="brand">AirGapper <span class="app-version">v0.5.232</span></span>', '<span class="brand">AirGapper <span class="app-version">v0.5.233</span></span>')
repl('sw.js', 'const CACHE = "airgapper-static-js-v188";', 'const CACHE = "airgapper-static-js-v189";')
repl('vendor/decimen-codec/source/VERSION', '0.1.42\n', '0.1.43\n')

p = Path('vendor/decimen-codec/source/wrapper/decimen_codec.cpp')
s = p.read_text()
old = '''struct TurboLevels
{
    int tl = 128, tr = 128, bl = 128;
    int separation = 0;
    int matches = 0;
    bool ok = false;
};'''
new = '''struct TurboLevels
{
    int tl = 128, tr = 128, bl = 128;
    int separation = 0;
    int matches = 0;
    // The threshold surface is affine across the QR. Precompute its coefficients
    // once from the three finder measurements instead of dividing and finding
    // min/max for every sampled data module.
    float thresholdBase = 128.0f;
    float thresholdXStep = 0.0f;
    float thresholdYStep = 0.0f;
    int thresholdLo = 116;
    int thresholdHi = 140;
    bool ok = false;
};'''
if old not in s: raise SystemExit('TurboLevels target missing')
s = s.replace(old, new, 1)
old = '''    out.separation = minSep;
    out.matches = matches;
    out.ok = matches >= 132;
    return out;'''
new = '''    out.separation = minSep;
    out.matches = matches;
    const float invDim = 1.0f / float(dim);
    out.thresholdXStep = float(out.tr - out.tl) * invDim;
    out.thresholdYStep = float(out.bl - out.tl) * invDim;
    out.thresholdBase = float(out.tl) + 0.5f * (out.thresholdXStep + out.thresholdYStep);
    out.thresholdLo = std::min({out.tl, out.tr, out.bl}) - 12;
    out.thresholdHi = std::max({out.tl, out.tr, out.bl}) + 12;
    out.ok = matches >= 132;
    return out;'''
if old not in s: raise SystemExit('TurboLevels finalization target missing')
s = s.replace(old, new, 1)
old = '''static int turboThreshold(const TurboLevels& levels, int x, int y, int dim)
{
    const float fx = (x + 0.5f) / dim;
    const float fy = (y + 0.5f) / dim;
    const float t = levels.tl + (levels.tr - levels.tl) * fx + (levels.bl - levels.tl) * fy;
    const int lo = std::min({levels.tl, levels.tr, levels.bl}) - 12;
    const int hi = std::max({levels.tl, levels.tr, levels.bl}) + 12;
    return std::clamp(int(std::lround(t)), lo, hi);
}'''
new = '''static int turboThreshold(const TurboLevels& levels, int x, int y, int /*dim*/)
{
    const float t = levels.thresholdBase + float(x) * levels.thresholdXStep + float(y) * levels.thresholdYStep;
    return std::clamp(int(std::lround(t)), levels.thresholdLo, levels.thresholdHi);
}'''
if old not in s: raise SystemExit('turboThreshold target missing')
s = s.replace(old, new, 1)
p.write_text(s)
