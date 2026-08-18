from pathlib import Path

cpp = Path('vendor/decimen-codec/source/wrapper/decimen_codec.cpp')
s = cpp.read_text()

if 'SparseBilinearRows' in s:
    raise SystemExit('v239 sparse row mapper already applied')

# Insert a compact row-coefficient mapper beside the existing full-map helper.
# It resolves the sparse 3x3 lattice once per slot, then each module lookup is
# only a tile select plus two multiply-adds. This removes divisions and repeated
# four-corner interpolation from every sampled QR bit.
anchor = 'static bool buildSparseSampleMapBilinear(int dim, const PerspectiveTransform& fallback,'
idx = s.index(anchor)
end = s.index('\n}\n\nstatic void seedGuidedTurboQuad', idx) + 3
helper = r'''
struct SparseBilinearRows
{
    struct TileRow {
        PointF origin{};
        PointF step{};
        int x0 = 0;
    };
    std::array<std::array<TileRow, 2>, 177> rows{};
    int dim = 0;
    int split = 0;
    bool valid = false;

    SparseBilinearRows(int dimension, const PerspectiveTransform& fallback,
                       const Matrix<std::optional<PointF>>& controls,
                       const std::vector<int>& centers)
        : dim(dimension)
    {
        if (dim <= 0 || dim > 177 || centers.size() != 3)
            return;
        split = centers[1];
        auto control = [&](int x, int y) -> PointF {
            const auto& value = controls(x, y);
            return value ? *value : fallback(centered(PointI{centers[x], centers[y]}));
        };
        std::array<std::array<PointF, 3>, 3> c{};
        for (int y = 0; y < 3; ++y)
            for (int x = 0; x < 3; ++x)
                c[y][x] = control(x, y);

        for (int y = 0; y < dim; ++y) {
            const int ry = y < split ? 0 : 1;
            const int y0 = centers[ry], y1 = centers[ry + 1];
            const float v = float(y - y0) / float(y1 - y0);
            for (int rx = 0; rx < 2; ++rx) {
                const int x0 = centers[rx], x1 = centers[rx + 1];
                const PointF q00 = c[ry][rx];
                const PointF q10 = c[ry][rx + 1];
                const PointF q01 = c[ry + 1][rx];
                const PointF q11 = c[ry + 1][rx + 1];
                const PointF left{q00.x + (q01.x - q00.x) * v,
                                  q00.y + (q01.y - q00.y) * v};
                const PointF right{q10.x + (q11.x - q10.x) * v,
                                   q10.y + (q11.y - q10.y) * v};
                auto& row = rows[y][rx];
                row.origin = left;
                row.step = PointF{(right.x - left.x) / float(x1 - x0),
                                  (right.y - left.y) / float(x1 - x0)};
                row.x0 = x0;
            }
        }
        valid = true;
    }

    PointF point(int x, int y) const
    {
        const int rx = x < split ? 0 : 1;
        const auto& row = rows[y][rx];
        const float d = float(x - row.x0);
        return PointF{row.origin.x + row.step.x * d,
                      row.origin.y + row.step.y * d};
    }

    bool buildMap(std::vector<PointF>& out) const
    {
        if (!valid)
            return false;
        out.resize(size_t(dim) * dim);
        for (int y = 0; y < dim; ++y)
            for (int x = 0; x < dim; ++x)
                out[size_t(y) * dim + x] = point(x, y);
        return true;
    }
};

'''
s = s[:end] + helper + s[end:]

# Rewrite the progressive sparse decoder to accept the precomputed row mapper.
old_sig = '''static DecoderResult decodeAirGapperSparseProgressive(
    const BitMatrix& image, int dim,
    const PerspectiveTransform& fallback,
    const Matrix<std::optional<PointF>>& controls,
    const std::vector<int>& centers,
    GuidedSparseFastResult& result)'''
new_sig = '''static DecoderResult decodeAirGapperSparseProgressive(
    const BitMatrix& image, int dim,
    const SparseBilinearRows& mapper,
    GuidedSparseFastResult& result)'''
if old_sig not in s:
    raise SystemExit('progressive sparse signature missing')
s = s.replace(old_sig, new_sig, 1)

old_guard = '''    result.dataOnlyAttempted = true;
    if (centers.size() != 3 || dim < 21 || dim > 177 || ((dim - 17) & 3))
        return {};'''
new_guard = '''    result.dataOnlyAttempted = true;
    if (!mapper.valid || dim < 21 || dim > 177 || ((dim - 17) & 3))
        return {};'''
if old_guard not in s:
    raise SystemExit('progressive sparse guard missing')
s = s.replace(old_guard, new_guard, 1)

old_setup = '''    auto control = [&](int x, int y) -> PointF {
        const auto& value = controls(x, y);
        return value ? *value : fallback(centered(PointI{centers[x], centers[y]}));
    };
    std::array<std::array<PointF, 4>, 4> tiles{};
    for (int ry = 0; ry < 2; ++ry)
        for (int rx = 0; rx < 2; ++rx)
            tiles[ry * 2 + rx] = {
                control(rx, ry), control(rx + 1, ry),
                control(rx + 1, ry + 1), control(rx, ry + 1)
            };

'''
if old_setup not in s:
    raise SystemExit('old sparse bilinear setup missing')
s = s.replace(old_setup, '', 1)

old_point = '''            const int rx = x < centers[1] ? 0 : 1;
            const int ry = y < centers[1] ? 0 : 1;
            const float u = float(x - centers[rx]) / float(centers[rx + 1] - centers[rx]);
            const float v = float(y - centers[ry]) / float(centers[ry + 1] - centers[ry]);
            const auto& q = tiles[ry * 2 + rx];
            const PointF top{q[0].x + (q[1].x - q[0].x) * u,
                             q[0].y + (q[1].y - q[0].y) * u};
            const PointF bottom{q[3].x + (q[2].x - q[3].x) * u,
                                q[3].y + (q[2].y - q[3].y) * u};
            const PointF p{top.x + (bottom.x - top.x) * v,
                           top.y + (bottom.y - top.y) * v};'''
new_point = '''            const PointF p = mapper.point(x, y);'''
if old_point not in s:
    raise SystemExit('old per-bit sparse interpolation missing')
s = s.replace(old_point, new_point, 1)

# In sampleGuidedSparse construct the mapper once after control discovery, use
# it for decoding, and if the slot needs a persistent map reuse the same mapper
# instead of reconstructing the lattice a second time.
old_fast = '''    if (fastOut) {
        fastOut->attempted = true;
        fastOut->quad = {
            currentPrediction(PointF{track.x0, track.y0}),
            currentPrediction(PointF{track.x1, track.y1}),
            currentPrediction(PointF{track.x2, track.y2}),
            currentPrediction(PointF{track.x3, track.y3})
        };
        auto decoded = decodeAirGapperSparseProgressive(image, dim, base, controls, centers, *fastOut);
        if (decoded.isValid() && !decoded.content().bytes.empty() && hasValidCRC32(decoded.content().bytes)) {
            fastOut->decoded = std::move(decoded);
            if (sampleMapOut && !buildSparseSampleMapBilinear(dim, base, controls, centers, *sampleMapOut))
                sampleMapOut->clear();
            return {};
        }
    }
'''
new_fast = '''    SparseBilinearRows mapper(dim, base, controls, centers);
    if (fastOut && mapper.valid) {
        fastOut->attempted = true;
        fastOut->quad = {
            currentPrediction(PointF{track.x0, track.y0}),
            currentPrediction(PointF{track.x1, track.y1}),
            currentPrediction(PointF{track.x2, track.y2}),
            currentPrediction(PointF{track.x3, track.y3})
        };
        auto decoded = decodeAirGapperSparseProgressive(image, dim, mapper, *fastOut);
        if (decoded.isValid() && !decoded.content().bytes.empty() && hasValidCRC32(decoded.content().bytes)) {
            fastOut->decoded = std::move(decoded);
            if (sampleMapOut && !mapper.buildMap(*sampleMapOut))
                sampleMapOut->clear();
            return {};
        }
    }
'''
if old_fast not in s:
    raise SystemExit('sampleGuidedSparse fast block missing')
s = s.replace(old_fast, new_fast, 1)

cpp.write_text(s)

for path, old_version, new_version in [
    ('vendor/decimen-codec/source/VERSION', '0.1.47', '0.1.48'),
    ('main.js', 'v0.5.238', 'v0.5.239'),
    ('receive/main.js', 'v0.5.238', 'v0.5.239'),
    ('index.html', 'v0.5.238', 'v0.5.239'),
]:
    p = Path(path)
    text = p.read_text()
    if old_version not in text:
        raise SystemExit(f'{path}: version target {old_version} missing')
    p.write_text(text.replace(old_version, new_version))

sw = Path('sw.js')
text = sw.read_text()
if 'airgapper-static-js-v194' not in text:
    raise SystemExit('sw cache v194 target missing')
sw.write_text(text.replace('airgapper-static-js-v194', 'airgapper-static-js-v195', 1))
