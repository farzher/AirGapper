from pathlib import Path


def replace_once(text, old, new, label):
    if old not in text:
        raise SystemExit(f"{label} anchor missing")
    return text.replace(old, new, 1)

cpp = Path('vendor/decimen-codec/source/wrapper/decimen_codec.cpp')
s = cpp.read_text()

old = '''    auto sampleByteCenter = [&](const std::vector<uint32_t>& plan, size_t firstBit,
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
'''
new = '''    auto sampleByteCenter = [&](const std::vector<uint32_t>& plan, size_t firstBit,
                                uint8_t& value, uint8_t& minMargin) -> bool {
        value = 0;
        minMargin = 255;
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
            const int margin = std::min(255, std::abs(lum - threshold));
            minMargin = std::min(minMargin, uint8_t(margin));
            value = uint8_t((value << 1) | uint8_t(mask != (lum <= threshold)));
        }
        return true;
    };
'''
s = replace_once(s, old, new, 'center confidence')

old = '''    auto runRs = [&](const ByteArray& source, const ByteArray* erasureFlags) -> DecoderResult {
        auto blocks = QRCode::DataBlock::GetDataBlocks(source, *version, QRCode::ErrorCorrectionLevel::Low);
        if (blocks.empty()) return {};
        std::vector<QRCode::DataBlock> erasureBlocks;
        if (erasureFlags) {
            erasureBlocks = QRCode::DataBlock::GetDataBlocks(*erasureFlags, *version, QRCode::ErrorCorrectionLevel::Low);
            if (erasureBlocks.size() != blocks.size()) return {};
        }
'''
new = '''    auto runRs = [&](const ByteArray& source, const ByteArray* erasureScores) -> DecoderResult {
        auto blocks = QRCode::DataBlock::GetDataBlocks(source, *version, QRCode::ErrorCorrectionLevel::Low);
        if (blocks.empty()) return {};
        std::vector<QRCode::DataBlock> scoreBlocks;
        if (erasureScores) {
            scoreBlocks = QRCode::DataBlock::GetDataBlocks(*erasureScores, *version, QRCode::ErrorCorrectionLevel::Low);
            if (scoreBlocks.size() != blocks.size()) return {};
        }
'''
s = replace_once(s, old, new, 'RS score blocks')

old = '''            std::vector<int> erasures;
            if (erasureFlags) {
                const auto& flags = erasureBlocks[blockIndex].codewords();
                for (int i = 0; i < int(flags.size()); ++i) if (flags[i]) erasures.push_back(i);
                if (int(erasures.size()) > eccCount - 2) return {};
            }
            const bool rsOk = erasureFlags
                ? bool(ReedSolomonDecode(RSField::QRCode, codewords, eccCount, erasures))
                : bool(ReedSolomonDecode(RSField::QRCode, codewords, eccCount));
'''
new = '''            std::vector<int> erasures;
            if (erasureScores) {
                const auto& scores = scoreBlocks[blockIndex].codewords();
                std::vector<int> candidates;
                candidates.reserve(scores.size());
                for (int i = 0; i < int(scores.size()); ++i)
                    if (scores[i] <= GUIDED_TURBO_AMBIGUOUS) candidates.push_back(i);
                std::sort(candidates.begin(), candidates.end(), [&](int a, int b) {
                    return scores[a] < scores[b];
                });
                // QR-L v40 has 30 parity symbols/block. Do not spend the whole
                // correction budget on broad low-margin guesses: erase only the
                // worst 80%, leaving parity to correct a few unknown mistakes.
                const int erasureLimit = std::max(1, (eccCount * 4) / 5);
                if (int(candidates.size()) > erasureLimit)
                    candidates.resize(erasureLimit);
                erasures = std::move(candidates);
            }
            const bool rsOk = erasureScores
                ? bool(ReedSolomonDecode(RSField::QRCode, codewords, eccCount, erasures))
                : bool(ReedSolomonDecode(RSField::QRCode, codewords, eccCount));
'''
s = replace_once(s, old, new, 'ranked erasures')

s = replace_once(
    s,
    '    ByteArray ambiguousCodeword(totalCodewords);\n',
    '    ByteArray ambiguityScore(totalCodewords, uint8_t(255));\n',
    'ambiguity score storage'
)

old_loop = '''            uint8_t value = 0;
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
'''
new_loop = '''            uint8_t value = 0;
            uint8_t minMargin = 255;
            const bool sampled = erasureSampling
                ? sampleByteCenter(dataPlan.samples, size_t(codeword) * 8, value, minMargin)
                : sampleByte(dataPlan.samples, size_t(codeword) * 8, value);
            if (!sampled) {
                metrics.sampleMs += guidedNowMs() - sampleStarted;
                return {};
            }
            raw[codeword] = value;
            if (minMargin <= GUIDED_TURBO_AMBIGUOUS) {
                ambiguityScore[codeword] = minMargin;
                ++ambiguousCount;
            }
'''
s = replace_once(s, old_loop, new_loop, 'data confidence loop')

old_loop = '''        uint8_t value = 0;
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
'''
new_loop = '''        uint8_t value = 0;
        uint8_t minMargin = 255;
        const bool sampled = erasureSampling
            ? sampleByteCenter(fullPlan, size_t(codeword) * 8, value, minMargin)
            : sampleByte(fullPlan, size_t(codeword) * 8, value);
        if (!sampled) {
            metrics.sampleMs += guidedNowMs() - sampleStarted;
            return {};
        }
        raw[codeword] = value;
        if (minMargin <= GUIDED_TURBO_AMBIGUOUS) {
            ambiguityScore[codeword] = minMargin;
            ++ambiguousCount;
        }
'''
s = replace_once(s, old_loop, new_loop, 'parity confidence loop')

s = replace_once(s, 'auto erasureDecoded = runRs(raw, &ambiguousCodeword);',
                 'auto erasureDecoded = runRs(raw, &ambiguityScore);', 'erasure decode scores')

old = '''        metrics.erasureRepairCodewords += uint32_t(ambiguousCount);
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
'''
new = '''        std::vector<int> repairOrder;
        repairOrder.reserve(ambiguousCount);
        for (int codeword = 0; codeword < totalCodewords; ++codeword)
            if (ambiguityScore[codeword] <= GUIDED_TURBO_AMBIGUOUS)
                repairOrder.push_back(codeword);
        std::sort(repairOrder.begin(), repairOrder.end(), [&](int a, int b) {
            return ambiguityScore[a] < ambiguityScore[b];
        });

        // Repair the least-confident ~1/8 of the QR first. On the v268 phone
        // trace failed erasure attempts were re-reading ~1200 codewords each;
        // a targeted first stage gives normal RS a chance after only ~460 v40
        // codewords, while preserving the full robust repair as a final fallback.
        const int partialRepairCount = std::min<int>(
            repairOrder.size(), std::max(64, totalCodewords / 8));
        const double repairSampleStarted = guidedNowMs();
        for (int i = 0; i < partialRepairCount; ++i) {
            const int codeword = repairOrder[i];
            uint8_t value = 0;
            if (!sampleByte(fullPlan, size_t(codeword) * 8, value)) {
                metrics.sampleMs += guidedNowMs() - repairSampleStarted;
                return {};
            }
            raw[codeword] = value;
        }
        metrics.erasureRepairCodewords += uint32_t(partialRepairCount);
        metrics.sampleMs += guidedNowMs() - repairSampleStarted;

        if (partialRepairCount < int(repairOrder.size())) {
            const double partialDecodeStarted = guidedNowMs();
            auto partialDecoded = runRs(raw, nullptr);
            metrics.decodeMs += guidedNowMs() - partialDecodeStarted;
            if (partialDecoded.isValid() && !partialDecoded.content().bytes.empty() &&
                hasValidCRC32(partialDecoded.content().bytes))
                return partialDecoded;

            const double remainderSampleStarted = guidedNowMs();
            for (int i = partialRepairCount; i < int(repairOrder.size()); ++i) {
                const int codeword = repairOrder[i];
                uint8_t value = 0;
                if (!sampleByte(fullPlan, size_t(codeword) * 8, value)) {
                    metrics.sampleMs += guidedNowMs() - remainderSampleStarted;
                    return {};
                }
                raw[codeword] = value;
            }
            metrics.erasureRepairCodewords += uint32_t(repairOrder.size() - partialRepairCount);
            metrics.sampleMs += guidedNowMs() - remainderSampleStarted;
        }
'''
s = replace_once(s, old, new, 'staged repair')

cpp.write_text(s)

version = Path('vendor/decimen-codec/source/VERSION')
if version.read_text().strip() != '0.1.57':
    raise SystemExit('unexpected codec version')
version.write_text('0.1.58\n')

main = Path('main.js')
s = main.read_text()
s = replace_once(s, 'const APP_BUILD = "v0.5.269";', 'const APP_BUILD = "v0.5.270";', 'app build')
main.write_text(s)

receive = Path('receive/main.js')
s = receive.read_text()
s = replace_once(s, 'const RECEIVER_RUNTIME_BUILD = "v0.5.268";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.270";', 'receiver build')
receive.write_text(s)

index = Path('index.html')
s = index.read_text()
if s.count('v0.5.269') < 2:
    raise SystemExit('index version anchors missing')
s = s.replace('v0.5.269', 'v0.5.270')
index.write_text(s)

sw = Path('sw.js')
s = sw.read_text()
s = replace_once(s, 'airgapper-static-js-v217', 'airgapper-static-js-v218', 'service worker cache')
sw.write_text(s)
