from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"replacement not found in {path}: {old[:160]!r}")
    p.write_text(s.replace(old, new, count))

# Version/cache.
replace("index.html", "v0.5.197", "v0.5.198")
replace("main.js", 'const APP_BUILD = "v0.5.197";', 'const APP_BUILD = "v0.5.198";')
replace("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.197";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.198";')
replace("sw.js", 'const CACHE = "airgapper-static-js-v159";', 'const CACHE = "airgapper-static-js-v160";')
replace("vendor/decimen-codec/source/VERSION", "0.1.21", "0.1.22")

cpp = Path("vendor/decimen-codec/source/wrapper/decimen_codec.cpp")
s = cpp.read_text()

old = '''    const float module = guidedModuleSize(track);\n    return residual <= std::max(1.0f, module * 0.48f);\n}\n\nstatic bool turboFinderIdeal'''
new = '''    const float module = guidedModuleSize(track);\n    // v197 only tolerated nearly-pure translation. At ~2.5 px/module that\n    // rejects or mis-samples perfectly trackable handheld scale/perspective\n    // changes. The hot sampler below now warps every cached module by the\n    // current tracked quad, so this is only a stale-geometry sanity gate.\n    return residual <= std::max(4.0f, module * 2.0f);\n}\n\nstatic PointF turboWarpedPoint(const GuidedTurboTrack& cache, const DecimenGuidedTrack& track, int x, int y)\n{\n    const auto current = turboTrackQuad(track);\n    const float fx = (x + 0.5f) / std::max(1, track.dimension);\n    const float fy = (y + 0.5f) / std::max(1, track.dimension);\n    PointF d[4];\n    for (int i = 0; i < 4; ++i)\n        d[i] = current[i] - cache.seedQuad[i];\n    const PointF top{d[0].x + (d[1].x - d[0].x) * fx, d[0].y + (d[1].y - d[0].y) * fx};\n    const PointF bottom{d[3].x + (d[2].x - d[3].x) * fx, d[3].y + (d[2].y - d[3].y) * fx};\n    const PointF delta{top.x + (bottom.x - top.x) * fy, top.y + (bottom.y - top.y) * fy};\n    const PointF p = cache.samples[size_t(y) * cache.dimension + x];\n    return PointF{p.x + delta.x, p.y + delta.y};\n}\n\nstatic bool turboFinderIdeal'''
if old not in s:
    raise SystemExit("turboPose marker missing")
s = s.replace(old, new, 1)

old = '''static int turboLum(const uint8_t* yPlane, int width, int height, int stride, PointF p, float dx, float dy)\n{\n    const int x = int(std::lround(p.x + dx));\n    const int y = int(std::lround(p.y + dy));\n    return x < 0 || y < 0 || x >= width || y >= height ? -1 : int(yPlane[size_t(y) * stride + x]);\n}\n'''
new = '''static int turboLum(const uint8_t* yPlane, int width, int height, int stride, PointF p, float dx, float dy)\n{\n    // Preserve the sub-pixel location Guided calibrated instead of snapping every\n    // module center to one camera pixel. Bilinear Y sampling is especially useful\n    // around 2-3 px/module where a half-pixel phase error is a large fraction of\n    // the module width.\n    const float px = float(p.x) + dx;\n    const float py = float(p.y) + dy;\n    const int x0 = int(std::floor(px));\n    const int y0 = int(std::floor(py));\n    if (x0 < 0 || y0 < 0 || x0 + 1 >= width || y0 + 1 >= height)\n        return -1;\n    const float fx = px - x0;\n    const float fy = py - y0;\n    const size_t r0 = size_t(y0) * stride;\n    const size_t r1 = size_t(y0 + 1) * stride;\n    const float a = yPlane[r0 + x0] + (yPlane[r0 + x0 + 1] - yPlane[r0 + x0]) * fx;\n    const float b = yPlane[r1 + x0] + (yPlane[r1 + x0 + 1] - yPlane[r1 + x0]) * fx;\n    return int(std::lround(a + (b - a) * fy));\n}\n'''
if old not in s:
    raise SystemExit("turboLum block missing")
s = s.replace(old, new, 1)

s = s.replace(
'''static TurboLevels turboReadLevels(const GuidedTurboTrack& cache, const uint8_t* yPlane,\n                                   int width, int height, int stride, float dx, float dy)''',
'''static TurboLevels turboReadLevels(const GuidedTurboTrack& cache, const DecimenGuidedTrack& track,\n                                   const uint8_t* yPlane, int width, int height, int stride, float dx, float dy)''', 1)
s = s.replace(
'''                const int lum = turboLum(yPlane, width, height, stride,\n                    cache.samples[size_t(sy) * dim + sx], dx, dy);''',
'''                const int lum = turboLum(yPlane, width, height, stride,\n                    turboWarpedPoint(cache, track, sx, sy), dx, dy);''', 1)

start = s.find('static int turboModuleLum(')
end = s.find('\nstatic DecoderResult decodeTurboDataOnly', start)
if start < 0 or end < 0:
    raise SystemExit("turboModuleLum span missing")
new_module = r'''static int turboModuleLum(const GuidedTurboTrack& cache, const DecimenGuidedTrack& track,
                          const uint8_t* yPlane, int width, int height, int stride, int x, int y,
                          float dx, float dy, int threshold, float moduleSize)
{
    const PointF p = turboWarpedPoint(cache, track, x, y);
    int lum = turboLum(yPlane, width, height, stride, p, dx, dy);
    if (lum < 0 || moduleSize < GUIDED_TURBO_CANARY_MIN_MODULE ||
        std::abs(lum - threshold) > GUIDED_TURBO_AMBIGUOUS)
        return lum;

    // Ambiguous low-density modules get a tiny five-point vote *inside the
    // module's own warped basis*. Using +/-1 camera pixels at 2.5 px/module can
    // cross a QR edge; using fractions of neighboring module-center vectors
    // stays safely inside the cell even under perspective.
    const int dim = track.dimension;
    const PointF left = turboWarpedPoint(cache, track, std::max(0, x - 1), y);
    const PointF right = turboWarpedPoint(cache, track, std::min(dim - 1, x + 1), y);
    const PointF up = turboWarpedPoint(cache, track, x, std::max(0, y - 1));
    const PointF down = turboWarpedPoint(cache, track, x, std::min(dim - 1, y + 1));
    const float xDiv = (x > 0 && x + 1 < dim) ? 2.0f : 1.0f;
    const float yDiv = (y > 0 && y + 1 < dim) ? 2.0f : 1.0f;
    const PointF ux{(right.x - left.x) / xDiv, (right.y - left.y) / xDiv};
    const PointF uy{(down.x - up.x) / yDiv, (down.y - up.y) / yDiv};
    const float inset = moduleSize < 3.0f ? 0.16f : 0.22f;
    const PointF probes[4] = {
        PointF{p.x + ux.x * inset, p.y + ux.y * inset},
        PointF{p.x - ux.x * inset, p.y - ux.y * inset},
        PointF{p.x + uy.x * inset, p.y + uy.y * inset},
        PointF{p.x - uy.x * inset, p.y - uy.y * inset}
    };
    int values[5] = {lum, 0, 0, 0, 0};
    for (int i = 0; i < 4; ++i) {
        values[i + 1] = turboLum(yPlane, width, height, stride, probes[i], dx, dy);
        if (values[i + 1] < 0)
            return lum;
    }
    std::sort(std::begin(values), std::end(values));
    return values[2];
}
'''
s = s[:start] + new_module + s[end:]

# Both direct and RS paths use the warped/adaptive sampler.
s = s.replace('turboModuleLum(cache, yPlane, width, height, stride,',
              'turboModuleLum(cache, track, yPlane, width, height, stride,')

s = s.replace(
'''static PointF turboRefineWallOffset(const GuidedTurboTrack& cache, const uint8_t* yPlane,\n                                    int width, int height, int stride, float predictedX, float predictedY)''',
'''static PointF turboRefineWallOffset(const GuidedTurboTrack& cache, const DecimenGuidedTrack& track,\n                                    const uint8_t* yPlane, int width, int height, int stride,\n                                    float predictedX, float predictedY)''', 1)
s = s.replace('const auto levels = turboReadLevels(cache, yPlane, width, height, stride, dx, dy);',
              'const auto levels = turboReadLevels(cache, track, yPlane, width, height, stride, dx, dy);', 1)

old = '''            const PointF refined = turboRefineWallOffset(*cache, yPlane, width, height, stride, dx, dy);\n            wallCorrectionX = refined.x - dx;\n            wallCorrectionY = refined.y - dy;'''
new = '''            // The per-module bilinear warp already carries the current quad's\n            // translation/scale/perspective. Search only the small residual wall\n            // motion left by worker latency / lattice prediction.\n            const PointF refined = turboRefineWallOffset(*cache, tracks[i], yPlane, width, height, stride, 0, 0);\n            wallCorrectionX = refined.x;\n            wallCorrectionY = refined.y;'''
if old not in s:
    raise SystemExit("wall refine call missing")
s = s.replace(old, new, 1)

old = '''            dx += wallCorrectionX;\n            dy += wallCorrectionY;\n            const auto levels = turboReadLevels(*cache, yPlane, width, height, stride, dx, dy);'''
new = '''            // dx/dy now means only residual correction; the current tracked quad\n            // itself is applied to every cached module by turboWarpedPoint().\n            dx = wallCorrectionX;\n            dy = wallCorrectionY;\n            const auto levels = turboReadLevels(*cache, track, yPlane, width, height, stride, dx, dy);'''
if old not in s:
    raise SystemExit("per-track levels call missing")
s = s.replace(old, new, 1)

cpp.write_text(s)
