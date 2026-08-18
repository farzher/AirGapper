from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing anchor in {path}: {old[:140]!r}")
    p.write_text(text.replace(old, new, 1))

cpp = Path("vendor/decimen-codec/source/wrapper/decimen_codec.cpp")
s = cpp.read_text()
old = '''    const int dim = track.dimension;
    const PointF left = turboWarpedPoint(cache, frameTransform, std::max(0, x - 1), y);
    const PointF right = turboWarpedPoint(cache, frameTransform, std::min(dim - 1, x + 1), y);
    const PointF up = turboWarpedPoint(cache, frameTransform, x, std::max(0, y - 1));
    const PointF down = turboWarpedPoint(cache, frameTransform, x, std::min(dim - 1, y + 1));
    const float xDiv = (x > 0 && x + 1 < dim) ? 2.0f : 1.0f;
    const float yDiv = (y > 0 && y + 1 < dim) ? 2.0f : 1.0f;
    const PointF ux{(right.x - left.x) / xDiv, (right.y - left.y) / xDiv};
    const PointF uy{(down.x - up.x) / yDiv, (down.y - up.y) / yDiv};
'''
new = '''    const int dim = track.dimension;
    const int lx = std::max(0, x - 1), rx = std::min(dim - 1, x + 1);
    const int uyIndex = std::max(0, y - 1), dyIndex = std::min(dim - 1, y + 1);
    const float xDiv = (x > 0 && x + 1 < dim) ? 2.0f : 1.0f;
    const float yDiv = (y > 0 && y + 1 < dim) ? 2.0f : 1.0f;
    PointF ux, uy;
    if (frameTransform.translationOnly || frameTransform.affineOnly) {
        // Translation cancels from a vector, and affine transforms act on a
        // vector with only their 2x2 matrix. Avoid four full point transforms
        // for every ambiguous bit while preserving the exact probe basis.
        const PointF& left = cache.samples[size_t(y) * dim + lx];
        const PointF& right = cache.samples[size_t(y) * dim + rx];
        const PointF& up = cache.samples[size_t(uyIndex) * dim + x];
        const PointF& down = cache.samples[size_t(dyIndex) * dim + x];
        const PointF rawUx{(right.x - left.x) / xDiv, (right.y - left.y) / xDiv};
        const PointF rawUy{(down.x - up.x) / yDiv, (down.y - up.y) / yDiv};
        if (frameTransform.affineOnly) {
            ux = PointF{
                frameTransform.m00 * float(rawUx.x) + frameTransform.m01 * float(rawUx.y),
                frameTransform.m10 * float(rawUx.x) + frameTransform.m11 * float(rawUx.y)
            };
            uy = PointF{
                frameTransform.m00 * float(rawUy.x) + frameTransform.m01 * float(rawUy.y),
                frameTransform.m10 * float(rawUy.x) + frameTransform.m11 * float(rawUy.y)
            };
        } else {
            ux = rawUx;
            uy = rawUy;
        }
    } else {
        const PointF left = turboWarpedPoint(cache, frameTransform, lx, y);
        const PointF right = turboWarpedPoint(cache, frameTransform, rx, y);
        const PointF up = turboWarpedPoint(cache, frameTransform, x, uyIndex);
        const PointF down = turboWarpedPoint(cache, frameTransform, x, dyIndex);
        ux = PointF{(right.x - left.x) / xDiv, (right.y - left.y) / xDiv};
        uy = PointF{(down.x - up.x) / yDiv, (down.y - up.y) / yDiv};
    }
'''
if old not in s:
    raise SystemExit("turboModuleLum neighbor basis anchor missing")
s = s.replace(old, new, 1)
cpp.write_text(s)

Path("vendor/decimen-codec/source/VERSION").write_text("0.1.57\n")
replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.263";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.264";')
replace_once("main.js", 'const APP_BUILD = "v0.5.263";', 'const APP_BUILD = "v0.5.264";')
index = Path("index.html").read_text().replace('v0.5.263', 'v0.5.264')
Path("index.html").write_text(index)
sw = Path("sw.js").read_text().replace('airgapper-static-js-v214', 'airgapper-static-js-v215', 1)
Path("sw.js").write_text(sw)
