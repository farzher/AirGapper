from pathlib import Path

cpp = Path('vendor/decimen-codec/source/wrapper/decimen_codec.cpp')
s = cpp.read_text()

if 'SparseTileCoefficients' in s:
    raise SystemExit('v240 sparse axis/coeff patch already applied')

old_setup = '''    std::array<std::array<PointF, 4>, 4> tiles{};
    for (int ry = 0; ry < 2; ++ry)
        for (int rx = 0; rx < 2; ++rx)
            tiles[ry * 2 + rx] = {
                control(rx, ry), control(rx + 1, ry),
                control(rx + 1, ry + 1), control(rx, ry + 1)
            };
    const int split = centers[1];
    const int tileStart[2] = {centers[0], centers[1]};
    const float invSpan[2] = {
        1.0f / float(centers[1] - centers[0]),
        1.0f / float(centers[2] - centers[1])
    };
'''
new_setup = '''    struct SparseTileCoefficients {
        PointF a, b, c, d;
    };
    std::array<SparseTileCoefficients, 4> tileCoefficients{};
    for (int ry = 0; ry < 2; ++ry) {
        for (int rx = 0; rx < 2; ++rx) {
            const PointF q00 = control(rx, ry);
            const PointF q10 = control(rx + 1, ry);
            const PointF q11 = control(rx + 1, ry + 1);
            const PointF q01 = control(rx, ry + 1);
            auto& c = tileCoefficients[ry * 2 + rx];
            c.a = q00;
            c.b = PointF{q10.x - q00.x, q10.y - q00.y};
            c.c = PointF{q01.x - q00.x, q01.y - q00.y};
            c.d = PointF{q11.x - q10.x - q01.x + q00.x,
                         q11.y - q10.y - q01.y + q00.y};
        }
    }
    const int split = centers[1];
    const int tileStart[2] = {centers[0], centers[1]};
    const float invSpan[2] = {
        1.0f / float(centers[1] - centers[0]),
        1.0f / float(centers[2] - centers[1])
    };
    std::array<float, 177> axisParam{};
    std::array<uint8_t, 177> axisTile{};
    for (int i = 0; i < dim; ++i) {
        const int tile = i < split ? 0 : 1;
        axisTile[i] = uint8_t(tile);
        axisParam[i] = float(i - tileStart[tile]) * invSpan[tile];
    }
'''
if old_setup not in s:
    raise SystemExit('v239 sparse setup anchor missing')
s = s.replace(old_setup, new_setup, 1)

old_point = '''            const int rx = x < split ? 0 : 1;
            const int ry = y < split ? 0 : 1;
            const float u = float(x - tileStart[rx]) * invSpan[rx];
            const float v = float(y - tileStart[ry]) * invSpan[ry];
            const auto& q = tiles[ry * 2 + rx];
            const PointF top{q[0].x + (q[1].x - q[0].x) * u,
                             q[0].y + (q[1].y - q[0].y) * u};
            const PointF bottom{q[3].x + (q[2].x - q[3].x) * u,
                                q[3].y + (q[2].y - q[3].y) * u};
            const PointF p{top.x + (bottom.x - top.x) * v,
                           top.y + (bottom.y - top.y) * v};'''
new_point = '''            const int rx = axisTile[x];
            const int ry = axisTile[y];
            const float u = axisParam[x];
            const float v = axisParam[y];
            const float uv = u * v;
            const auto& c = tileCoefficients[ry * 2 + rx];
            const PointF p{
                c.a.x + c.b.x * u + c.c.x * v + c.d.x * uv,
                c.a.y + c.b.y * u + c.c.y * v + c.d.y * uv
            };'''
if old_point not in s:
    raise SystemExit('v239 sparse point anchor missing')
s = s.replace(old_point, new_point, 1)

cpp.write_text(s)

for path, old_version, new_version in [
    ('vendor/decimen-codec/source/VERSION', '0.1.48', '0.1.49'),
    ('main.js', 'v0.5.239', 'v0.5.240'),
    ('receive/main.js', 'v0.5.239', 'v0.5.240'),
    ('index.html', 'v0.5.239', 'v0.5.240'),
]:
    p = Path(path)
    text = p.read_text()
    if old_version not in text:
        raise SystemExit(f'{path}: version target {old_version} missing')
    p.write_text(text.replace(old_version, new_version))

sw = Path('sw.js')
text = sw.read_text()
if 'airgapper-static-js-v195' not in text:
    raise SystemExit('sw cache v195 target missing')
sw.write_text(text.replace('airgapper-static-js-v195', 'airgapper-static-js-v196', 1))
