from pathlib import Path

cpp = Path('vendor/decimen-codec/source/wrapper/decimen_codec.cpp')
s = cpp.read_text()

if 'decodeAirGapperSparseProgressive' in s:
    raise SystemExit('v237 progressive sparse patch already applied')

# 1) Keep the exact perspective map builder as fallback, but add a cheap
# bilinear builder for CRC-proven sparse geometry. Its control points are the
# same current-frame finder/alignment lattice used by sparse Guided.
insert_before = 'static void seedGuidedTurbo(int id, int dim, const Position& pos,'
if insert_before not in s:
    raise SystemExit('seedGuidedTurbo anchor missing')
bilinear_map = r'''static bool buildSparseSampleMapBilinear(int dim, const PerspectiveTransform& fallback,
                                         Matrix<std::optional<PointF>>& controls,
                                         const std::vector<int>& centers,
                                         std::vector<PointF>& out)
{
    const int W = Size(centers) - 1;
    const int H = W;
    if (dim <= 0 || W <= 0)
        return false;
    for (int y = 0; y <= H; ++y)
        for (int x = 0; x <= W; ++x)
            if (!controls(x, y))
                controls.set(x, y, fallback(centered(PointI(centers[x], centers[y]))));

    out.assign(size_t(dim) * dim, PointF{});
    for (int ry = 0; ry < H; ++ry) {
        for (int rx = 0; rx < W; ++rx) {
            const int x0 = centers[rx], x1 = centers[rx + 1];
            const int y0 = centers[ry], y1 = centers[ry + 1];
            const int beginX = rx == 0 ? 0 : x0;
            const int endX = rx == W - 1 ? dim : x1;
            const int beginY = ry == 0 ? 0 : y0;
            const int endY = ry == H - 1 ? dim : y1;
            const PointF q00 = *controls(rx, ry);
            const PointF q10 = *controls(rx + 1, ry);
            const PointF q11 = *controls(rx + 1, ry + 1);
            const PointF q01 = *controls(rx, ry + 1);
            const float invWidth = 1.0f / float(x1 - x0);
            const float invHeight = 1.0f / float(y1 - y0);
            for (int y = beginY; y < endY; ++y) {
                const float v = float(y - y0) * invHeight;
                const PointF left{q00.x + (q01.x - q00.x) * v,
                                  q00.y + (q01.y - q00.y) * v};
                const PointF right{q10.x + (q11.x - q10.x) * v,
                                   q10.y + (q11.y - q10.y) * v};
                const PointF step{(right.x - left.x) * invWidth,
                                  (right.y - left.y) * invWidth};
                PointF p{left.x + step.x * float(beginX - x0),
                         left.y + step.y * float(beginX - x0)};
                for (int x = beginX; x < endX; ++x) {
                    out[size_t(y) * dim + x] = p;
                    p.x += step.x;
                    p.y += step.y;
                }
            }
        }
    }
    return true;
}

'''
s = s.replace(insert_before, bilinear_map + insert_before, 1)

# 2) Allow a CRC-proven sparse result to seed a map from a corrected quad
# without fabricating a ZXing Position object.
old_seed = '''static void seedGuidedTurbo(int id, int dim, const Position& pos,
                            std::vector<PointF>&& samples, bool distortionAware)
{
    auto* cache = guidedTurboTrack(id);
    if (!cache || dim <= 0 || samples.size() != size_t(dim) * dim)
        return;
    cache->dimension = dim;
    cache->seeded = true;
    cache->distortionAware = distortionAware;
    cache->seedQuad = turboPositionQuad(pos);
    cache->samples = std::move(samples);
    cache->misses = 0;
    cache->cooldown = 0;
    cache->stableSuccesses = 0;
}
'''
new_seed = '''static void seedGuidedTurboQuad(int id, int dim, const std::array<PointF, 4>& quad,
                                std::vector<PointF>&& samples, bool distortionAware)
{
    auto* cache = guidedTurboTrack(id);
    if (!cache || dim <= 0 || samples.size() != size_t(dim) * dim)
        return;
    cache->dimension = dim;
    cache->seeded = true;
    cache->distortionAware = distortionAware;
    cache->seedQuad = quad;
    cache->samples = std::move(samples);
    cache->misses = 0;
    cache->cooldown = 0;
    cache->stableSuccesses = 0;
}

static void seedGuidedTurbo(int id, int dim, const Position& pos,
                            std::vector<PointF>&& samples, bool distortionAware)
{
    seedGuidedTurboQuad(id, dim, turboPositionQuad(pos), std::move(samples), distortionAware);
}
'''
if old_seed not in s:
    raise SystemExit('seedGuidedTurbo block missing')
s = s.replace(old_seed, new_seed, 1)

# 3) Replace v236's always-full-codeword bilinear sampler with progressive
# data-only-first sampling. Data samples are retained in raw[] so an RS fallback
# only reads the parity codewords; it never resamples payload modules.
start = s.index('// Sparse Guided already has a current-frame 3x3 distortion control lattice.')
end = s.index('static DecoderResult decodeTurboStableRS(', start)
progressive = r'''// Sparse Guided already has a current-frame 3x3 distortion control lattice.
// AirGapper also fixes QR Model-2 EC-L/mask-4. Read only data codewords first;
// if DecodeBitStream + AirGapper CRC succeeds, parity modules and QR RS are
// unnecessary. On a miss, keep those already sampled bytes, read only the
// remaining ECC codewords, and run the normal QR RS decoder. No pixel is read
// twice and the exact CRC acceptance contract is unchanged.
struct GuidedSparseFastResult
{
    DecoderResult decoded;
    std::array<PointF, 4> quad{};
    double decodeMs = 0;
    bool attempted = false;
    bool dataOnlyAttempted = false;
    bool dataOnlySuccess = false;
    bool rsAttempted = false;
};

static DecoderResult decodeAirGapperSparseProgressive(
    const BitMatrix& image, int dim,
    const PerspectiveTransform& fallback,
    const Matrix<std::optional<PointF>>& controls,
    const std::vector<int>& centers,
    GuidedSparseFastResult& result)
{
    result.dataOnlyAttempted = true;
    if (centers.size() != 3 || dim < 21 || dim > 177 || ((dim - 17) & 3))
        return {};
    const auto* version = QRCode::Version::Model2((dim - 17) / 4);
    if (!version)
        return {};
    const int totalCodewords = version->totalCodewords();
    const auto& fullPlan = turboCodewordPlan(dim);
    const auto& dataPlan = turboDataPlan(dim);
    if (totalCodewords <= 0 || fullPlan.size() != size_t(totalCodewords) * 8 ||
        dataPlan.dataCodewords <= 0 || dataPlan.samples.size() != size_t(dataPlan.dataCodewords) * 8 ||
        dataPlan.destination.size() != size_t(dataPlan.dataCodewords))
        return {};

    auto control = [&](int x, int y) -> PointF {
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

    auto sampleByte = [&](const std::vector<uint32_t>& plan, size_t firstBit,
                          uint8_t& value) -> bool {
        value = 0;
        for (int bit = 0; bit < 8; ++bit) {
            const uint32_t entry = plan[firstBit + bit];
            const int x = int(entry & 0xff);
            const int y = int((entry >> 8) & 0xff);
            const bool mask = ((entry >> 16) & 1) != 0;
            const int rx = x < centers[1] ? 0 : 1;
            const int ry = y < centers[1] ? 0 : 1;
            const float u = float(x - centers[rx]) / float(centers[rx + 1] - centers[rx]);
            const float v = float(y - centers[ry]) / float(centers[ry + 1] - centers[ry]);
            const auto& q = tiles[ry * 2 + rx];
            const PointF top{q[0].x + (q[1].x - q[0].x) * u,
                             q[0].y + (q[1].y - q[0].y) * u};
            const PointF bottom{q[3].x + (q[2].x - q[3].x) * u,
                                q[3].y + (q[2].y - q[3].y) * u};
            const PointF p{top.x + (bottom.x - top.x) * v,
                           top.y + (bottom.y - top.y) * v};
            if (!image.isIn(p))
                return false;
            const bool dark = image.get(p);
            value = uint8_t((value << 1) | uint8_t(mask != dark));
        }
        return true;
    };

    ByteArray raw(totalCodewords);
    ByteArray data(dataPlan.dataCodewords);
    for (int codeword = 0; codeword < dataPlan.dataCodewords; ++codeword) {
        uint8_t value = 0;
        if (!sampleByte(dataPlan.samples, size_t(codeword) * 8, value))
            return {};
        raw[codeword] = value;
        data[dataPlan.destination[codeword]] = value;
    }

    double decodeStarted = guidedNowMs();
    auto direct = QRCode::DecodeBitStream(std::move(data), *version, QRCode::ErrorCorrectionLevel::Low);
    result.decodeMs += guidedNowMs() - decodeStarted;
    if (direct.isValid() && !direct.content().bytes.empty() && hasValidCRC32(direct.content().bytes)) {
        result.dataOnlySuccess = true;
        return direct;
    }

    result.rsAttempted = true;
    for (int codeword = dataPlan.dataCodewords; codeword < totalCodewords; ++codeword) {
        uint8_t value = 0;
        if (!sampleByte(fullPlan, size_t(codeword) * 8, value))
            return {};
        raw[codeword] = value;
    }

    decodeStarted = guidedNowMs();
    auto blocks = QRCode::DataBlock::GetDataBlocks(raw, *version, QRCode::ErrorCorrectionLevel::Low);
    if (blocks.empty()) {
        result.decodeMs += guidedNowMs() - decodeStarted;
        return {};
    }
    int dataBytes = 0;
    for (const auto& block : blocks)
        dataBytes += block.numDataCodewords();
    ByteArray corrected(dataBytes);
    auto dst = corrected.begin();
    for (auto& block : blocks) {
        auto& codewords = block.codewords();
        const int dataCount = block.numDataCodewords();
        const int eccCount = int(codewords.size()) - dataCount;
        if (eccCount <= 0 || !ReedSolomonDecode(RSField::QRCode, codewords, eccCount)) {
            result.decodeMs += guidedNowMs() - decodeStarted;
            return {};
        }
        dst = std::copy_n(codewords.begin(), dataCount, dst);
    }
    auto decoded = QRCode::DecodeBitStream(std::move(corrected), *version, QRCode::ErrorCorrectionLevel::Low);
    result.decodeMs += guidedNowMs() - decodeStarted;
    return decoded;
}

'''
s = s[:start] + progressive + s[end:]

# 4) Replace the sparse function so the progressive path runs on every valid
# current-frame sparse lattice, including reseeds. A successful fast decode can
# cheaply build a bilinear persistent map; a fast miss falls through to the
# exact old SampleGrid + perspective map path unchanged.
start = s.index('static DetectorResult sampleGuidedSparse(')
end = s.index('\n}\n\n} // namespace', start) + 2
old_sparse = s[start:end]
new_sparse = r'''static DetectorResult sampleGuidedSparse(const BitMatrix& image,
                                         const DecimenGuidedTrack& track,
                                         const QRCode::FinderPatternSet& fp,
                                         int* alignmentFoundOut,
                                         std::vector<PointF>* sampleMapOut,
                                         GuidedSparseFastResult* fastOut)
{
    if (fastOut) *fastOut = GuidedSparseFastResult{};
    const int dim = track.dimension;
    const auto* version = QRCode::Version::Model2((dim - 17) / 4);
    if (!version)
        return {};
    const auto& fullCenters = version->alignmentPatternCenters();
    if (fullCenters.size() < 3)
        return {};

    std::vector<int> centers{
        fullCenters.front(),
        fullCenters[fullCenters.size() / 2],
        fullCenters.back()
    };
    constexpr int N = 2;

    PerspectiveTransform prior(
        QuadrilateralF{PointF{0, 0}, PointF{double(dim), 0},
                       PointF{double(dim), double(dim)}, PointF{0, double(dim)}},
        QuadrilateralF{PointF{track.x0, track.y0}, PointF{track.x1, track.y1},
                       PointF{track.x2, track.y2}, PointF{track.x3, track.y3}});
    if (!prior.isValid())
        return {};

    const PointF priorTL = prior(PointF{3.5, 3.5});
    const PointF priorTR = prior(PointF{dim - 3.5, 3.5});
    const PointF priorBL = prior(PointF{3.5, dim - 3.5});
    const PointF priorU = priorTR - priorTL;
    const PointF priorV = priorBL - priorTL;
    const double det = priorU.x * priorV.y - priorU.y * priorV.x;
    if (std::abs(det) < 1e-5)
        return {};

    const PointF actualTL = fp.tl;
    const PointF actualU = PointF(fp.tr) - actualTL;
    const PointF actualV = PointF(fp.bl) - actualTL;
    auto currentPrediction = [&](PointF oldPoint) {
        const PointF w = oldPoint - priorTL;
        const double a = (w.x * priorV.y - w.y * priorV.x) / det;
        const double b = (priorU.x * w.y - priorU.y * w.x) / det;
        return actualTL + a * actualU + b * actualV;
    };
    auto projectControl = [&](int x, int y) {
        return currentPrediction(prior(centered(PointI{centers[x], centers[y]})));
    };

    const PointF predictedBR = projectControl(N, N);
    if (!image.isIn(predictedBR))
        return {};
    auto sourceQuad = Rectangle(dim, dim, 3.5);
    sourceQuad[2] = sourceQuad[2] - PointF{3, 3};
    PerspectiveTransform base(sourceQuad,
        QuadrilateralF{PointF(fp.tl), PointF(fp.tr), predictedBR, PointF(fp.bl)});
    if (!base.isValid())
        return {};

    Matrix<std::optional<PointF>> controls(3, 3);
    auto seedFinderCorner = [&](int x, int y, const ConcentricPattern& finder) {
        const PointF predicted = projectControl(x, y);
        controls.set(x, y, predicted);
        if (auto corners = FindConcentricPatternCorners(image, finder, finder.size, 2)) {
            for (auto corner : *corners) {
                if (distance(corner, predicted) < finder.size / 2) {
                    controls.set(x, y, corner);
                    break;
                }
            }
        }
    };
    seedFinderCorner(0, 0, fp.tl);
    seedFinderCorner(0, N, fp.bl);
    seedFinderCorner(N, 0, fp.tr);

    const int moduleSize = std::max(1, int(std::lround(guidedModuleSize(track))));
    int alignmentFound = 0;
    for (int y = 0; y <= N; ++y) {
        for (int x = 0; x <= N; ++x) {
            if ((x == 0 && y == 0) || (x == 0 && y == N) || (x == N && y == 0))
                continue;
            const PointF predicted = projectControl(x, y);
            if (auto found = locateGuidedAlignment(image, moduleSize, predicted)) {
                controls.set(x, y, PointF(*found));
                ++alignmentFound;
            }
        }
    }

    if (alignmentFoundOut) *alignmentFoundOut = alignmentFound;
    if (alignmentFound < 3)
        return {};

    if (fastOut) {
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

    if (sampleMapOut && !buildSparseSampleMap(dim, base, controls, centers, *sampleMapOut))
        sampleMapOut->clear();
    return SampleGrid(image, dim, dim, base, std::move(controls), centers, centers);
}'''
s = s[:start] + new_sparse + s[end:]

# 5) Replace the v236 caller with one attempt metric for progressive sparse,
# explicit no-RS/RS accounting, corrected geometry, and bilinear-map reseeding
# on a fast CRC-proven result.
old_begin = '''            if (guidedSparseAllowed(track.id)) {
                ++metrics->fastDecodeAttempts;
                std::vector<PointF> sparseMap;
                auto* mapOut = turboSeedEligible(track) ? &sparseMap : nullptr;
                DecoderResult directDecoded;
                double directDecodeMs = 0;
                bool directAttempted = false;
                auto sparse = sampleGuidedSparse(*bits, track, finderSet, nullptr, mapOut,
                                                 &directDecoded, &directDecodeMs, &directAttempted);
'''
start = s.index(old_begin)
end_marker = '''                noteGuidedSparseOutcome(track.id, decodedTrack);
            } else {
                ++metrics->sparseSkipped;
            }'''
end = s.index(end_marker, start) + len(end_marker)
new_caller = r'''            if (guidedSparseAllowed(track.id)) {
                ++metrics->fastDecodeAttempts;
                std::vector<PointF> sparseMap;
                auto* mapOut = turboSeedEligible(track) ? &sparseMap : nullptr;
                GuidedSparseFastResult fast;
                auto sparse = sampleGuidedSparse(*bits, track, finderSet, nullptr, mapOut, &fast);

                if (fast.attempted) {
                    ++metrics->sampleAttempts;
                    ++metrics->sparseProfileAttempts;
                    if (fast.dataOnlyAttempted)
                        ++metrics->sparseNoRsAttempts;
                    if (fast.dataOnlySuccess)
                        ++metrics->sparseNoRsSuccesses;
                    if (fast.rsAttempted)
                        ++metrics->sparseRsFallbacks;
                    metrics->decodeMs += fast.decodeMs;
                    decodeSpent += fast.decodeMs;
                    if (fast.decoded.isValid() && !fast.decoded.content().bytes.empty() &&
                        hasValidCRC32(fast.decoded.content().bytes)) {
                        const ByteArray& bytes = fast.decoded.content().bytes;
                        if (outputUsed + int(bytes.size()) <= outputCapacity) {
                            std::memcpy(output + outputUsed, bytes.data(), bytes.size());
                            auto& result = results[resultCount++];
                            result = {};
                            result.id = track.id;
                            result.status = DECIMEN_TRACK_OK;
                            result.bytesOffset = outputUsed;
                            result.bytesLength = int(bytes.size());
                            result.dimension = track.dimension;
                            result.x0 = fast.quad[0].x; result.y0 = fast.quad[0].y;
                            result.x1 = fast.quad[1].x; result.y1 = fast.quad[1].y;
                            result.x2 = fast.quad[2].x; result.y2 = fast.quad[2].y;
                            result.x3 = fast.quad[3].x; result.y3 = fast.quad[3].y;
                            outputUsed += int(bytes.size());
                            ++metrics->successful;
                            ++metrics->sparseProfileSuccesses;
                            decodedTrack = true;
                            if (mapOut && !sparseMap.empty())
                                seedGuidedTurboQuad(track.id, track.dimension, fast.quad,
                                                    std::move(sparseMap), true);
                        }
                    }
                }

                if (!decodedTrack && sparse.isValid() && sparse.bits().width() == track.dimension) {
                    metrics->sampleAttempts++;
                    const double fastStart = guidedNowMs();
                    ++metrics->sparseRsFallbacks;
                    ++metrics->sparseProfileAttempts;
                    auto decoded = decodeAirGapperSampledBits(sparse.bits());
                    decodedTrack = commitDecoded(sparse, decoded);
                    if (decodedTrack) {
                        ++metrics->sparseProfileSuccesses;
                    } else {
                        decoded = QRCode::Decode(sparse.bits());
                        decodedTrack = commitDecoded(sparse, decoded);
                    }
                    const double fastElapsed = guidedNowMs() - fastStart;
                    metrics->fastDecodeMs += fastElapsed;
                    metrics->decodeMs += fastElapsed;
                    decodeSpent += fastElapsed;
                    if (decodedTrack && mapOut) {
                        if (sparseMap.empty())
                            sparseMap = buildHomographySampleMap(track.dimension, sparse.position());
                        seedGuidedTurbo(track.id, track.dimension, sparse.position(), std::move(sparseMap), true);
                    }
                }

                if (decodedTrack) {
                    ++metrics->fastDecodeSuccesses;
                    if (track.id >= 0 && track.id < 32)
                        metrics->sparseSuccessMask |= uint32_t(1) << track.id;
                }
                noteGuidedSparseOutcome(track.id, decodedTrack);
            } else {
                ++metrics->sparseSkipped;
            }'''
s = s[:start] + new_caller + s[end:]

cpp.write_text(s)

for path, old_version, new_version in [
    ('vendor/decimen-codec/source/VERSION', '0.1.45', '0.1.46'),
    ('main.js', 'v0.5.236', 'v0.5.237'),
    ('receive/main.js', 'v0.5.236', 'v0.5.237'),
    ('index.html', 'v0.5.236', 'v0.5.237'),
]:
    p = Path(path)
    text = p.read_text()
    if old_version not in text:
        raise SystemExit(f'{path}: version target {old_version} missing')
    p.write_text(text.replace(old_version, new_version))

sw = Path('sw.js')
text = sw.read_text()
if 'airgapper-static-js-v192' not in text:
    raise SystemExit('sw cache v192 target missing')
sw.write_text(text.replace('airgapper-static-js-v192', 'airgapper-static-js-v193', 1))
