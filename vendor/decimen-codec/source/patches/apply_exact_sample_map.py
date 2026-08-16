from pathlib import Path

root = Path('third_party/zxing-cpp')

def replace_once(path, old, new):
    p = root / path
    text = p.read_text()
    if old not in text:
        raise SystemExit(f'ZXing patch anchor not found: {path}: {old[:80]!r}')
    p.write_text(text.replace(old, new, 1))

replace_once('core/src/DetectorResult.h',
    '#include <utility>\n',
    '#include <utility>\n#include <vector>\n')
replace_once('core/src/DetectorResult.h',
    '\tBitMatrix _bits;\n\tQuadrilateralI _position;\n',
    '\tBitMatrix _bits;\n\tQuadrilateralI _position;\n\tstd::vector<PointF> _samplePoints;\n')
replace_once('core/src/DetectorResult.h',
    '\tDetectorResult(BitMatrix&& bits, QuadrilateralI&& position) : _bits(std::move(bits)), _position(std::move(position)) {}\n',
    '\tDetectorResult(BitMatrix&& bits, QuadrilateralI&& position, std::vector<PointF>&& samplePoints = {})\n\t\t: _bits(std::move(bits)), _position(std::move(position)), _samplePoints(std::move(samplePoints)) {}\n')
replace_once('core/src/DetectorResult.h',
    '\tQuadrilateralI&& position() && { return std::move(_position); }\n',
    '\tQuadrilateralI&& position() && { return std::move(_position); }\n\tconst std::vector<PointF>& samplePoints() const { return _samplePoints; }\n')

replace_once('core/src/GridSampler.cpp',
    '\tBitMatrix res(width, height);\n',
    '\tBitMatrix res(width, height);\n\tstd::vector<PointF> samplePoints(static_cast<std::size_t>(width) * height);\n')
replace_once('core/src/GridSampler.cpp',
    '\t\t\t\tif (!image.isIn(p))\n\t\t\t\t\treturn {};\n\n#ifdef PRINT_DEBUG\n',
    '\t\t\t\tif (!image.isIn(p))\n\t\t\t\t\treturn {};\n\t\t\t\tsamplePoints[static_cast<std::size_t>(y) * width + x] = p;\n\n#ifdef PRINT_DEBUG\n')
replace_once('core/src/GridSampler.cpp',
    '\treturn {std::move(res),\n\t\t\t{projectCorner({0, 0}), projectCorner({width, 0}), projectCorner({width, height}), projectCorner({0, height})}};\n',
    '\treturn {std::move(res),\n\t\t\t{projectCorner({0, 0}), projectCorner({width, 0}), projectCorner({width, height}), projectCorner({0, height})},\n\t\t\tstd::move(samplePoints)};\n')
