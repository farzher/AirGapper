from pathlib import Path

cpp = Path('vendor/decimen-codec/source/wrapper/decimen_codec.cpp')
s = cpp.read_text()

if 'decodeAirGapperSparseBilinear' in s:
    raise SystemExit('v236 sparse direct patch already applied')

helper = r'''
// Sparse Guided already has a current-frame 3x3 distortion control lattice.
// Sample AirGapper's fixed codeword placement directly through that lattice
// before asking generic GridSampler to materialize an entire 177x177 matrix.
// Each of the four sparse tiles uses a cheap bilinear warp. This is only a
// speculative fast path: QR RS + AirGapper CRC must both pass, otherwise the
// caller immediately runs the existing perspective SampleGrid path unchanged.
static DecoderResult decodeAirGapperSparseBilinear(
    const BitMatrix& image, int dim,
    const PerspectiveTransform& fallback,
    const Matrix<std::optional<PointF>>& controls,
    const std::vector<int>& centers,
    double* decodeMsOut)
{
    if (decodeMsOut) *decodeMsOut = 0;
    if (centers.size() != 3 || dim < 21 || dim > 177 || ((dim - 17) & 3))
        return {};
    const auto* version = QRCode::Version::Model2((dim - 17) / 4);
    if (!version)
        return {};
    const int totalCodewords = version->totalCodewords();
    const auto& plan = turboCodewordPlan(dim);
    if (totalCodewords <= 0 || plan.size() != size_t(totalCodewords) * 8)
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

    ByteArray raw(totalCodewords);
    bool failed = false;
    for (int codeword = 0; codeword < totalCodewords && !failed; ++codeword) {
        uint8_t value = 0;
        const size_t firstBit = size_t(codeword) * 8;
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
            if (!image.isIn(p)) {
                failed = true;
                break;
            }
            const bool dark = image.get(p);
            value = uint8_t((value << 1) | uint8_t(mask != dark));
        }
        raw[codeword] = value;
    }
    if (failed)
        return {};

    const double decodeStarted = guidedNowMs();
    auto blocks = QRCode::DataBlock::GetDataBlocks(raw, *version, QRCode::ErrorCorrectionLevel::Low);
    if (blocks.empty()) {
        if (decodeMsOut) *decodeMsOut = guidedNowMs() - decodeStarted;
        return {};
    }
    int dataBytes = 0;
    for (const auto& block : blocks)
        dataBytes += block.numDataCodewords();
    ByteArray data(dataBytes);
    auto dst = data.begin();
    for (auto& block : blocks) {
        auto& codewords = block.codewords();
        const int dataCount = block.numDataCodewords();
        const int eccCount = int(codewords.size()) - dataCount;
        if (eccCount <= 0 || !ReedSolomonDecode(RSField::QRCode, codewords, eccCount)) {
            if (decodeMsOut) *decodeMsOut = guidedNowMs() - decodeStarted;
            return {};
        }
        dst = std::copy_n(codewords.begin(), dataCount, dst);
    }
    auto decoded = QRCode::DecodeBitStream(std::move(data), *version, QRCode::ErrorCorrectionLevel::Low);
    if (decodeMsOut) *decodeMsOut = guidedNowMs() - decodeStarted;
    return decoded;
}

'''
anchor = 'static DecoderResult decodeTurboStableRS(const GuidedTurboTrack& cache,'
if anchor not in s:
    raise SystemExit('decodeTurboStableRS insertion anchor missing')
s = s.replace(anchor, helper + anchor, 1)

old_sig = '''static DetectorResult sampleGuidedSparse(const BitMatrix& image,
                                         const DecimenGuidedTrack& track,
                                         const QRCode::FinderPatternSet& fp,
                                         int* alignmentFoundOut,
                                         std::vector<PointF>* sampleMapOut)'''
new_sig = '''static DetectorResult sampleGuidedSparse(const BitMatrix& image,
                                         const DecimenGuidedTrack& track,
                                         const QRCode::FinderPatternSet& fp,
                                         int* alignmentFoundOut,
                                         std::vector<PointF>* sampleMapOut,
                                         DecoderResult* fastDecodedOut,
                                         double* fastDecodeMsOut,
                                         bool* fastAttemptedOut)'''
if old_sig not in s:
    raise SystemExit('sampleGuidedSparse signature anchor missing')
s = s.replace(old_sig, new_sig, 1)

old_start = '''{
    const int dim = track.dimension;
    const auto* version = QRCode::Version::Model2((dim - 17) / 4);'''
new_start = '''{
    if (fastDecodedOut) *fastDecodedOut = {};
    if (fastDecodeMsOut) *fastDecodeMsOut = 0;
    if (fastAttemptedOut) *fastAttemptedOut = false;
    const int dim = track.dimension;
    const auto* version = QRCode::Version::Model2((dim - 17) / 4);'''
# Replace only inside sampleGuidedSparse, not another function with same opening.
sample_at = s.index(new_sig)
start_at = s.index(old_start, sample_at)
s = s[:start_at] + s[start_at:].replace(old_start, new_start, 1)

old_tail = '''    if (sampleMapOut && !buildSparseSampleMap(dim, base, controls, centers, *sampleMapOut))
        sampleMapOut->clear();
    return SampleGrid(image, dim, dim, base, std::move(controls), centers, centers);
}'''
new_tail = '''    if (sampleMapOut && !buildSparseSampleMap(dim, base, controls, centers, *sampleMapOut))
        sampleMapOut->clear();

    // When this slot already has a calibrated persistent map, try the direct
    // fixed-profile sampler first. During calibration/reseed we still run the
    // old SampleGrid path so its exact perspective map and position remain the
    // source of truth for future Stable-RS frames.
    if (!sampleMapOut && fastDecodedOut) {
        if (fastAttemptedOut) *fastAttemptedOut = true;
        auto decoded = decodeAirGapperSparseBilinear(image, dim, base, controls, centers, fastDecodeMsOut);
        if (decoded.isValid() && !decoded.content().bytes.empty() && hasValidCRC32(decoded.content().bytes)) {
            *fastDecodedOut = std::move(decoded);
            return {};
        }
    }
    return SampleGrid(image, dim, dim, base, std::move(controls), centers, centers);
}'''
if old_tail not in s:
    raise SystemExit('sampleGuidedSparse tail anchor missing')
s = s.replace(old_tail, new_tail, 1)

old_caller = '''                std::vector<PointF> sparseMap;
                auto* mapOut = turboSeedEligible(track) ? &sparseMap : nullptr;
                auto sparse = sampleGuidedSparse(*bits, track, finderSet, nullptr, mapOut);
                if (sparse.isValid() && sparse.bits().width() == track.dimension) {
                    metrics->sampleAttempts++;
                    const double fastStart = guidedNowMs();
                    ++metrics->sparseRsFallbacks;
                    ++metrics->sparseProfileAttempts;
                    auto decoded = decodeAirGapperSampledBits(sparse.bits());
                    decodedTrack = commitDecoded(sparse, decoded);
                    if (decodedTrack) {
                        ++metrics->sparseProfileSuccesses;
                    } else {
                        // Keep the stock QR decoder as the exact compatibility
                        // fallback for any unexpected profile/plain QR or fast
                        // parser miss. This attempt is already on a sampled grid,
                        // so failure cannot disturb geometry or cache state.
                        decoded = QRCode::Decode(sparse.bits());
                        decodedTrack = commitDecoded(sparse, decoded);
                    }
                    const double fastElapsed = guidedNowMs() - fastStart;
                    metrics->fastDecodeMs += fastElapsed;
                    metrics->decodeMs += fastElapsed;
                    decodeSpent += fastElapsed;
                    if (decodedTrack) {
                        ++metrics->fastDecodeSuccesses;
                        if (track.id >= 0 && track.id < 32)
                            metrics->sparseSuccessMask |= uint32_t(1) << track.id;
                        if (mapOut) {
                            if (sparseMap.empty())
                                sparseMap = buildHomographySampleMap(track.dimension, sparse.position());
                            seedGuidedTurbo(track.id, track.dimension, sparse.position(), std::move(sparseMap), true);
                        }
                    }
                }
                noteGuidedSparseOutcome(track.id, decodedTrack);'''

new_caller = '''                std::vector<PointF> sparseMap;
                auto* mapOut = turboSeedEligible(track) ? &sparseMap : nullptr;
                DecoderResult directDecoded;
                double directDecodeMs = 0;
                bool directAttempted = false;
                auto sparse = sampleGuidedSparse(*bits, track, finderSet, nullptr, mapOut,
                                                 &directDecoded, &directDecodeMs, &directAttempted);

                if (directAttempted) {
                    ++metrics->sampleAttempts;
                    ++metrics->sparseRsFallbacks;
                    ++metrics->sparseProfileAttempts;
                    metrics->decodeMs += directDecodeMs;
                    decodeSpent += directDecodeMs;
                    if (directDecoded.isValid() && !directDecoded.content().bytes.empty() &&
                        hasValidCRC32(directDecoded.content().bytes)) {
                        // Geometry is still current because guidedFinderTriplet
                        // succeeded in this frame. The exact bytes are protected
                        // by QR RS + AirGapper CRC; keep the tracked quad until a
                        // real SampleGrid reseed is needed.
                        decodedTrack = commitTurbo(trackIndex, directDecoded, 0, 0);
                        if (decodedTrack)
                            ++metrics->sparseProfileSuccesses;
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
                        // Keep the stock QR decoder as the exact compatibility
                        // fallback for any unexpected profile/plain QR or fast
                        // parser miss. This attempt is already on a sampled grid,
                        // so failure cannot disturb geometry or cache state.
                        decoded = QRCode::Decode(sparse.bits());
                        decodedTrack = commitDecoded(sparse, decoded);
                    }
                    const double fastElapsed = guidedNowMs() - fastStart;
                    metrics->fastDecodeMs += fastElapsed;
                    metrics->decodeMs += fastElapsed;
                    decodeSpent += fastElapsed;
                }

                if (decodedTrack) {
                    ++metrics->fastDecodeSuccesses;
                    if (track.id >= 0 && track.id < 32)
                        metrics->sparseSuccessMask |= uint32_t(1) << track.id;
                    if (mapOut && sparse.isValid()) {
                        if (sparseMap.empty())
                            sparseMap = buildHomographySampleMap(track.dimension, sparse.position());
                        seedGuidedTurbo(track.id, track.dimension, sparse.position(), std::move(sparseMap), true);
                    }
                }
                noteGuidedSparseOutcome(track.id, decodedTrack);'''

if old_caller not in s:
    raise SystemExit('guided sparse caller anchor missing')
s = s.replace(old_caller, new_caller, 1)

# The old center-only comment still claimed an unconditional robust retry. v235
# deliberately removed that below 2.25 px/module, so make the contract accurate.
s = s.replace('''                // gate; failure retries the old bilinear/voted sampler in this
                // same slot before sparse Guided recovery can run.''', '''                // gate; the caller may retry the voted sampler when the module
                // scale justifies it, otherwise sparse Guided recovery follows.''', 1)

cpp.write_text(s)

for path, old_version, new_version in [
    ('vendor/decimen-codec/source/VERSION', '0.1.44', '0.1.45'),
    ('main.js', 'v0.5.235', 'v0.5.236'),
    ('receive/main.js', 'v0.5.235', 'v0.5.236'),
    ('index.html', 'v0.5.235', 'v0.5.236'),
]:
    p = Path(path)
    text = p.read_text()
    if old_version not in text:
        raise SystemExit(f'{path}: version target {old_version} missing')
    p.write_text(text.replace(old_version, new_version))

sw = Path('sw.js')
text = sw.read_text()
if 'airgapper-static-js-v191' not in text:
    raise SystemExit('sw cache v191 target missing')
sw.write_text(text.replace('airgapper-static-js-v191', 'airgapper-static-js-v192', 1))
