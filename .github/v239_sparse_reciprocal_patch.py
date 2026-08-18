from pathlib import Path

cpp = Path('vendor/decimen-codec/source/wrapper/decimen_codec.cpp')
s = cpp.read_text()

if 'invSpan[2]' in s:
    raise SystemExit('v239 reciprocal sparse patch already applied')

old = '''    std::array<std::array<PointF, 4>, 4> tiles{};
    for (int ry = 0; ry < 2; ++ry)
        for (int rx = 0; rx < 2; ++rx)
            tiles[ry * 2 + rx] = {
                control(rx, ry), control(rx + 1, ry),
                control(rx + 1, ry + 1), control(rx, ry + 1)
            };

    auto sampleByte = [&](const std::vector<uint32_t>& plan, size_t firstBit,
                          uint8_t& value) -> bool {'''
new = '''    std::array<std::array<PointF, 4>, 4> tiles{};
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

    auto sampleByte = [&](const std::vector<uint32_t>& plan, size_t firstBit,
                          uint8_t& value) -> bool {'''
if old not in s:
    raise SystemExit('sparse tile setup anchor missing')
s = s.replace(old, new, 1)

old_uv = '''            const int rx = x < centers[1] ? 0 : 1;
            const int ry = y < centers[1] ? 0 : 1;
            const float u = float(x - centers[rx]) / float(centers[rx + 1] - centers[rx]);
            const float v = float(y - centers[ry]) / float(centers[ry + 1] - centers[ry]);'''
new_uv = '''            const int rx = x < split ? 0 : 1;
            const int ry = y < split ? 0 : 1;
            const float u = float(x - tileStart[rx]) * invSpan[rx];
            const float v = float(y - tileStart[ry]) * invSpan[ry];'''
if old_uv not in s:
    raise SystemExit('sparse per-bit division anchor missing')
s = s.replace(old_uv, new_uv, 1)

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
