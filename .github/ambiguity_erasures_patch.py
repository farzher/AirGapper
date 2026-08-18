from pathlib import Path

p = Path('vendor/decimen-codec/source/wrapper/decimen_codec.cpp')
s = p.read_text()

anchor = '''    auto sampleByte = [&](const std::vector<uint32_t>& plan, size_t firstBit,
                          uint8_t& value) -> bool {
        value = 0;
        for (int bit = 0; bit < 8; ++bit) {
            const uint32_t entry = plan[firstBit + bit];
            const int xx = int(entry & 0xff);
            const int y = int((entry >> 8) & 0xff);
            const bool mask = ((entry >> 16) & 1) != 0;
            const int threshold = turboThreshold(thresholdPlane, xx, y);
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
'''
replacement = '''    auto sampleByte = [&](const std::vector<uint32_t>& plan, size_t firstBit,
                          uint8_t& value) -> bool {
        value = 0;
        for (int bit = 0; bit < 8; ++bit) {
            const uint32_t entry = plan[firstBit + bit];
            const int xx = int(entry & 0xff);
            const int y = int((entry >> 8) & 0xff);
            const bool mask = ((entry >> 16) & 1) != 0;
            const int threshold = turboThreshold(thresholdPlane, xx, y);
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

    auto sampleByteCenter = [&](const std::vector<uint32_t>& plan, size_t firstBit,
                                uint8_t& value, bool& ambiguous) -> bool {
        value = 0;
        ambiguous = false;
        for (int bit = 0; bit < 8; ++bit) {
            const uint32_t entry = plan[firstBit + bit];
            const int xx = int(entry & 0xff);
            const int y = int((entry >> 8) & 0xff);
            const bool mask = ((entry >> 16) & 1) != 0;
            const int threshold = turboThreshold(thresholdPlane, xx, y);
            const PointF p = turboWarpedPoint(cache, frameTransform, xx, y);
            const int lum = turboLum(yPlane, width, height, stride, p, dx, dy);
            if (lum < 0)
                return false;
            ambiguous |= std::abs(lum - threshold) <= GUIDED_TURBO_AMBIGUOUS;
            value = uint8_t((value << 1) | uint8_t(mask != (lum <= threshold)));
        }
        return true;
    };

    auto runRs = [&](const ByteArray& source, const ByteArray* erasureFlags) -> DecoderResult {
        auto blocks = QRCode::DataBlock::GetDataBlocks(source, *version, QRCode::ErrorCorrectionLevel::Low);
        if (blocks.empty()) return {};
        std::vector<QRCode::DataBlock> erasureBlocks;
        if (erasureFlags) {
            erasureBlocks = QRCode::DataBlock::GetDataBlocks(*erasureFlags, *version, QRCode::ErrorCorrectionLevel::Low);
            if (erasureBlocks.size() != blocks.size()) return {};
        }
        int dataBytes = 0;
        for (const auto& block : blocks) dataBytes += block.numDataCodewords();
        ByteArray corrected(dataBytes);
        auto dst = corrected.begin();
        for (size_t blockIndex = 0; blockIndex < blocks.size(); ++blockIndex) {
            auto& block = blocks[blockIndex];
            auto& codewords = block.codewords();
            const int dataCount = block.numDataCodewords();
            const int eccCount = int(codewords.size()) - dataCount;
            if (eccCount <= 0) return {};
            std::vector<int> erasures;
            if (erasureFlags) {
                const auto& flags = erasureBlocks[blockIndex].codewords();
                for (int i = 0; i < int(flags.size()); ++i) if (flags[i]) erasures.push_back(i);
                if (int(erasures.size()) > eccCount - 2) return {};
            }
            const bool rsOk = erasureFlags
                ? bool(ReedSolomonDecode(RSField::QRCode, codewords, eccCount, erasures))
                : bool(ReedSolomonDecode(RSField::QRCode, codewords, eccCount));
            if (!rsOk) return {};
            dst = std::copy_n(codewords.begin(), dataCount, dst);
        }
        return QRCode::DecodeBitStream(std::move(corrected), *version, QRCode::ErrorCorrectionLevel::Low);
    };

    ByteArray raw(totalCodewords);
    ByteArray ambiguousCodeword(totalCodewords);
    bool erasureSampling = false;
    int ambiguousCount = 0;
'''
if anchor not in s: raise SystemExit('sampleByte anchor missing')
s = s.replace(anchor, replacement, 1)

old = '''        auto& noRsGate = guidedStableNoRsGate();
        const bool tryNoRsFirst = guidedTryNoRsFirst(noRsGate);
        ByteArray progressiveData;
'''
new = '''        auto& noRsGate = guidedStableNoRsGate();
        const bool tryNoRsFirst = guidedTryNoRsFirst(noRsGate);
        erasureSampling = !tryNoRsFirst && !centerOnly;
        ByteArray progressiveData;
'''
if old not in s: raise SystemExit('noRS gate anchor missing')
s = s.replace(old, new, 1)

old = '''        for (int codeword = 0; codeword < dataPlan.dataCodewords; ++codeword) {
            uint8_t value = 0;
            if (!sampleByte(dataPlan.samples, size_t(codeword) * 8, value)) {
                metrics.sampleMs += guidedNowMs() - sampleStarted;
                return {};
            }
            raw[codeword] = value;
            if (tryNoRsFirst)
                progressiveData[dataPlan.destination[codeword]] = value;
        }
'''
new = '''        for (int codeword = 0; codeword < dataPlan.dataCodewords; ++codeword) {
            uint8_t value = 0;
            bool ambiguous = false;
            const bool sampled = erasureSampling
                ? sampleByteCenter(dataPlan.samples, size_t(codeword) * 8, value, ambiguous)
                : sampleByte(dataPlan.samples, size_t(codeword) * 8, value);
            if (!sampled) {
                metrics.sampleMs += guidedNowMs() - sampleStarted;
                return {};
            }
            raw[codeword] = value;
            if (ambiguous) {
                ambiguousCodeword[codeword] = 1;
                ++ambiguousCount;
            }
            if (tryNoRsFirst)
                progressiveData[dataPlan.destination[codeword]] = value;
        }
'''
if old not in s: raise SystemExit('progressive sample loop missing')
s = s.replace(old, new, 1)

old = '''    for (int codeword = firstParityCodeword; codeword < totalCodewords; ++codeword) {
        uint8_t value = 0;
        if (!sampleByte(fullPlan, size_t(codeword) * 8, value)) {
            metrics.sampleMs += guidedNowMs() - sampleStarted;
            return {};
        }
        raw[codeword] = value;
    }
    metrics.sampleMs += guidedNowMs() - sampleStarted;

    const double decodeStarted = guidedNowMs();
    DecoderResult decoded;
    auto blocks = QRCode::DataBlock::GetDataBlocks(raw, *version, QRCode::ErrorCorrectionLevel::Low);
    bool rsOk = !blocks.empty();
    if (rsOk) {
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
                rsOk = false;
                break;
            }
            dst = std::copy_n(codewords.begin(), dataCount, dst);
        }
        if (rsOk)
            decoded = QRCode::DecodeBitStream(std::move(corrected), *version, QRCode::ErrorCorrectionLevel::Low);
    }
    metrics.decodeMs += guidedNowMs() - decodeStarted;
    return decoded;
'''
new = '''    for (int codeword = firstParityCodeword; codeword < totalCodewords; ++codeword) {
        uint8_t value = 0;
        bool ambiguous = false;
        const bool sampled = erasureSampling
            ? sampleByteCenter(fullPlan, size_t(codeword) * 8, value, ambiguous)
            : sampleByte(fullPlan, size_t(codeword) * 8, value);
        if (!sampled) {
            metrics.sampleMs += guidedNowMs() - sampleStarted;
            return {};
        }
        raw[codeword] = value;
        if (ambiguous) {
            ambiguousCodeword[codeword] = 1;
            ++ambiguousCount;
        }
    }
    metrics.sampleMs += guidedNowMs() - sampleStarted;

    if (erasureSampling && ambiguousCount > 0) {
        const double erasureDecodeStarted = guidedNowMs();
        auto erasureDecoded = runRs(raw, &ambiguousCodeword);
        metrics.decodeMs += guidedNowMs() - erasureDecodeStarted;
        if (erasureDecoded.isValid() && !erasureDecoded.content().bytes.empty() &&
            hasValidCRC32(erasureDecoded.content().bytes))
            return erasureDecoded;

        const double repairSampleStarted = guidedNowMs();
        for (int codeword = 0; codeword < totalCodewords; ++codeword) {
            if (!ambiguousCodeword[codeword]) continue;
            uint8_t value = 0;
            if (!sampleByte(fullPlan, size_t(codeword) * 8, value)) {
                metrics.sampleMs += guidedNowMs() - repairSampleStarted;
                return {};
            }
            raw[codeword] = value;
        }
        metrics.sampleMs += guidedNowMs() - repairSampleStarted;
    }

    const double decodeStarted = guidedNowMs();
    auto decoded = runRs(raw, nullptr);
    metrics.decodeMs += guidedNowMs() - decodeStarted;
    return decoded;
'''
if old not in s: raise SystemExit('RS tail anchor missing')
s = s.replace(old, new, 1)
p.write_text(s)

v = Path('vendor/decimen-codec/source/VERSION')
if v.read_text().strip() != '0.1.56': raise SystemExit('unexpected codec version')
v.write_text('0.1.57\n')
