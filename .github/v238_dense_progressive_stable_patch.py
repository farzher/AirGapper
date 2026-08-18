from pathlib import Path

cpp = Path('vendor/decimen-codec/source/wrapper/decimen_codec.cpp')
s = cpp.read_text()

if 'Stable-RS is progressive below the clean high-resolution lane' in s:
    raise SystemExit('v238 revised progressive Stable-RS patch already applied')

start = s.index('static DecoderResult decodeTurboStableRS(')
end = s.index('static std::optional<PointF> turboRefineWallOffset(', start)
new_stable = r'''// Stable-RS is progressive below the clean high-resolution lane: sample data
// codewords first and try the AirGapper CRC before touching QR parity. If that
// exact fast result misses, retain the already sampled raw data bytes, read only
// the remaining ECC codewords, then perform normal QR Reed-Solomon. The caller
// keeps the existing standalone data-only path for >=2.75 px/module, where that
// minimal sampler is already the cheaper clean-wall implementation.
static DecoderResult decodeTurboStableRS(const GuidedTurboTrack& cache,
                                         const DecimenGuidedTrack& track,
                                         const TurboFrameTransform& frameTransform,
                                         const uint8_t* yPlane, int width, int height, int stride,
                                         float dx, float dy, const TurboLevels& levels,
                                         DecimenGuidedMetrics& metrics, bool centerOnly = false,
                                         bool progressive = false, bool* rsUsedOut = nullptr)
{
    if (rsUsedOut) *rsUsedOut = false;
    const int dim = track.dimension;
    const auto* version = QRCode::Version::Model2((dim - 17) / 4);
    if (!version)
        return {};
    const int totalCodewords = version->totalCodewords();
    const auto& fullPlan = turboCodewordPlan(dim);
    if (totalCodewords <= 0 || fullPlan.size() != size_t(totalCodewords) * 8)
        return {};

    const float moduleSize = guidedModuleSize(track);
    auto sampleByte = [&](const std::vector<uint32_t>& plan, size_t firstBit,
                          uint8_t& value) -> bool {
        value = 0;
        for (int bit = 0; bit < 8; ++bit) {
            const uint32_t entry = plan[firstBit + bit];
            const int xx = int(entry & 0xff);
            const int y = int((entry >> 8) & 0xff);
            const bool mask = ((entry >> 16) & 1) != 0;
            const int threshold = turboThreshold(levels, xx, y, dim);
            int lum;
            if (centerOnly) {
                const PointF p = turboWarpedPoint(cache, frameTransform, xx, y);
                lum = turboNearestLum(yPlane, width, height, stride, p, dx, dy);
            } else {
                lum = turboModuleLum(cache, track, frameTransform,
                                     yPlane, width, height, stride,
                                     xx, y, dx, dy, threshold, moduleSize);
            }
            if (lum < 0)
                return false;
            value = uint8_t((value << 1) | uint8_t(mask != (lum <= threshold)));
        }
        return true;
    };

    ByteArray raw(totalCodewords);
    int firstParityCodeword = 0;
    if (progressive) {
        const auto& dataPlan = turboDataPlan(dim);
        if (dataPlan.dataCodewords <= 0 ||
            dataPlan.samples.size() != size_t(dataPlan.dataCodewords) * 8 ||
            dataPlan.destination.size() != size_t(dataPlan.dataCodewords))
            return {};
        ByteArray data(dataPlan.dataCodewords);
        const double sampleStarted = guidedNowMs();
        for (int codeword = 0; codeword < dataPlan.dataCodewords; ++codeword) {
            uint8_t value = 0;
            if (!sampleByte(dataPlan.samples, size_t(codeword) * 8, value)) {
                metrics.sampleMs += guidedNowMs() - sampleStarted;
                return {};
            }
            raw[codeword] = value;
            data[dataPlan.destination[codeword]] = value;
        }
        metrics.sampleMs += guidedNowMs() - sampleStarted;

        ++metrics.sparseNoRsAttempts;
        const double decodeStarted = guidedNowMs();
        auto direct = QRCode::DecodeBitStream(std::move(data), *version, QRCode::ErrorCorrectionLevel::Low);
        metrics.decodeMs += guidedNowMs() - decodeStarted;
        if (direct.isValid() && !direct.content().bytes.empty() && hasValidCRC32(direct.content().bytes)) {
            ++metrics.sparseNoRsSuccesses;
            return direct;
        }
        firstParityCodeword = dataPlan.dataCodewords;
    }

    if (rsUsedOut) *rsUsedOut = true;
    const double sampleStarted = guidedNowMs();
    for (int codeword = firstParityCodeword; codeword < totalCodewords; ++codeword) {
        uint8_t value = 0;
        if (!sampleByte(fullPlan, size_t(codeword) * 8, value)) {
            metrics.sampleMs += guidedNowMs() - sampleStarted;
            return {};
        }
        raw[codeword] = value;
    }
    metrics.sampleMs += guidedNowMs() - sampleStarted;

    const double decodeStarted = guidedNowMs();
    auto blocks = QRCode::DataBlock::GetDataBlocks(raw, *version, QRCode::ErrorCorrectionLevel::Low);
    if (blocks.empty()) {
        metrics.decodeMs += guidedNowMs() - decodeStarted;
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
            metrics.decodeMs += guidedNowMs() - decodeStarted;
            return {};
        }
        dst = std::copy_n(codewords.begin(), dataCount, dst);
    }
    auto decoded = QRCode::DecodeBitStream(std::move(corrected), *version, QRCode::ErrorCorrectionLevel::Low);
    metrics.decodeMs += guidedNowMs() - decodeStarted;
    return decoded;
}

'''
s = s[:start] + new_stable + s[end:]

# Replace the old broad standalone data-only policy with a high-resolution-only
# policy. Dense/optical Stable-RS uses the progressive sampler, while >=2.75px
# keeps v237's minimal standalone data-only fast lane.
block_start_text = '''                        // Once this exact distortion-aware map has repeatedly
                        // survived QR RS + AirGapper CRC, try the existing
                        // data-only decoder first on sufficiently resolved QRs.'''
block_start = s.index(block_start_text)
block_end_text = '''                        if (!success) {
                            stableRsAttempted = true;'''
block_end = s.index(block_end_text, block_start)
replacement = '''                        const float stableModuleSize = guidedModuleSize(track);
                        const bool stableDirectEligible = !cache->cooldown &&
                            stableModuleSize >= GUIDED_TURBO_NEAREST_MIN_MODULE &&
                            cache->stableSuccesses >= 2;
                        if (stableDirectEligible) {
                            directAttempted = true;
                            ++metrics->sampleAttempts;
                            ++metrics->sparseNoRsAttempts;
                            auto decoded = decodeTurboDataOnly(*cache, track, frameTransform,
                                                               yPlane, width, height, stride,
                                                               dx, dy, levels, *metrics);
                            directSuccess = commitTurbo(i, decoded, wallCorrectionX, wallCorrectionY);
                            success = directSuccess;
                            if (directSuccess)
                                ++metrics->sparseNoRsSuccesses;
                            else
                                cache->cooldown = std::max<uint8_t>(cache->cooldown, 2);
                        }
                        if (!success) {
                            stableRsAttempted = true;'''
s = s[:block_start] + replacement + s[block_end + len(block_end_text):]

old_first = '''                            ++metrics->sampleAttempts;
                            ++metrics->sparseRsFallbacks;
                            ++metrics->stableRsAttempts;
                            const bool centerOnlyRs = frameTransform.translationOnly &&
                                stableModuleSize < GUIDED_TURBO_NEAREST_MIN_MODULE;
                            auto decoded = decodeTurboStableRS(*cache, track, frameTransform,
                                                               yPlane, width, height, stride,
                                                               dx, dy, levels, *metrics, centerOnlyRs);
                            success = commitTurbo(i, decoded, wallCorrectionX, wallCorrectionY);'''
new_first = '''                            ++metrics->sampleAttempts;
                            ++metrics->stableRsAttempts;
                            const bool centerOnlyRs = frameTransform.translationOnly &&
                                stableModuleSize < GUIDED_TURBO_NEAREST_MIN_MODULE;
                            const bool progressiveRs = stableModuleSize < GUIDED_TURBO_NEAREST_MIN_MODULE;
                            bool rsUsed = false;
                            auto decoded = decodeTurboStableRS(*cache, track, frameTransform,
                                                               yPlane, width, height, stride,
                                                               dx, dy, levels, *metrics,
                                                               centerOnlyRs, progressiveRs, &rsUsed);
                            if (rsUsed)
                                ++metrics->sparseRsFallbacks;
                            success = commitTurbo(i, decoded, wallCorrectionX, wallCorrectionY);'''
if old_first not in s:
    raise SystemExit('first Stable-RS call anchor missing')
s = s.replace(old_first, new_first, 1)

old_retry = '''                            if (!success && robustRetryWorthwhile) {
                                ++metrics->sampleAttempts;
                                ++metrics->sparseRsFallbacks;
                                ++metrics->stableRsAttempts;
                                decoded = decodeTurboStableRS(*cache, track, frameTransform,
                                                              yPlane, width, height, stride,
                                                              dx, dy, levels, *metrics, false);
                                success = commitTurbo(i, decoded, wallCorrectionX, wallCorrectionY);
                            }'''
new_retry = '''                            if (!success && robustRetryWorthwhile) {
                                ++metrics->sampleAttempts;
                                ++metrics->stableRsAttempts;
                                bool robustRsUsed = false;
                                decoded = decodeTurboStableRS(*cache, track, frameTransform,
                                                              yPlane, width, height, stride,
                                                              dx, dy, levels, *metrics,
                                                              false, true, &robustRsUsed);
                                if (robustRsUsed)
                                    ++metrics->sparseRsFallbacks;
                                success = commitTurbo(i, decoded, wallCorrectionX, wallCorrectionY);
                            }'''
if old_retry not in s:
    raise SystemExit('robust Stable-RS retry anchor missing')
s = s.replace(old_retry, new_retry, 1)

cpp.write_text(s)

for path, old_version, new_version in [
    ('vendor/decimen-codec/source/VERSION', '0.1.46', '0.1.47'),
    ('main.js', 'v0.5.237', 'v0.5.238'),
    ('receive/main.js', 'v0.5.237', 'v0.5.238'),
    ('index.html', 'v0.5.237', 'v0.5.238'),
]:
    p = Path(path)
    text = p.read_text()
    if old_version not in text:
        raise SystemExit(f'{path}: version target {old_version} missing')
    p.write_text(text.replace(old_version, new_version))

sw = Path('sw.js')
text = sw.read_text()
if 'airgapper-static-js-v193' not in text:
    raise SystemExit('sw cache v193 target missing')
sw.write_text(text.replace('airgapper-static-js-v193', 'airgapper-static-js-v194', 1))
