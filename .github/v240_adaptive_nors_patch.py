from pathlib import Path

cpp = Path('vendor/decimen-codec/source/wrapper/decimen_codec.cpp')
s = cpp.read_text()

if 'guidedSparseNoRsGate' in s:
    raise SystemExit('v240 adaptive no-RS patch already applied')

anchor = '''struct GuidedSparseFastResult
{
    DecoderResult decoded;
'''
replacement = '''struct GuidedNoRsGate
{
    uint16_t attempts = 0;
    uint16_t successes = 0;
    uint16_t skipped = 0;
    bool suppressed = false;
};

static GuidedNoRsGate& guidedSparseNoRsGate()
{
    static GuidedNoRsGate gate;
    return gate;
}

static GuidedNoRsGate& guidedStableNoRsGate()
{
    static GuidedNoRsGate gate;
    return gate;
}

// CRC-only decode is a large win on clean frames, but real handheld optics can
// enter regimes where it almost never succeeds. Learn that independently per
// worker/path. When recent success falls below 12.5%, QR RS gets first chance;
// raw-data decode is retained behind RS failure, and a periodic probe lets the
// shortcut recover quickly when the image becomes clean again.
static bool guidedTryNoRsFirst(GuidedNoRsGate& gate)
{
    if (!gate.suppressed)
        return true;
    if (++gate.skipped >= 64) {
        gate.skipped = 0;
        return true;
    }
    return false;
}

static void guidedNoteNoRs(GuidedNoRsGate& gate, bool success)
{
    gate.skipped = 0;
    if (gate.suppressed) {
        if (success) {
            gate.suppressed = false;
            gate.attempts = 1;
            gate.successes = 1;
        }
        return;
    }

    ++gate.attempts;
    gate.successes += uint16_t(success);
    if (gate.attempts >= 12 && int(gate.successes) * 8 < int(gate.attempts)) {
        gate.suppressed = true;
        gate.attempts = 0;
        gate.successes = 0;
        return;
    }
    if (gate.attempts >= 32) {
        gate.attempts /= 2;
        gate.successes /= 2;
    }
}

struct GuidedSparseFastResult
{
    DecoderResult decoded;
'''
if anchor not in s:
    raise SystemExit('GuidedSparseFastResult anchor missing')
s = s.replace(anchor, replacement, 1)

old = '''    result.dataOnlyAttempted = true;
    if (centers.size() != 3 || dim < 21 || dim > 177 || ((dim - 17) & 3))
'''
new = '''    result.dataOnlyAttempted = false;
    if (centers.size() != 3 || dim < 21 || dim > 177 || ((dim - 17) & 3))
'''
if old not in s:
    raise SystemExit('sparse progressive entry anchor missing')
s = s.replace(old, new, 1)

old = '''    ByteArray raw(totalCodewords);
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
new = '''    ByteArray raw(totalCodewords);
    ByteArray data(dataPlan.dataCodewords);
    for (int codeword = 0; codeword < dataPlan.dataCodewords; ++codeword) {
        uint8_t value = 0;
        if (!sampleByte(dataPlan.samples, size_t(codeword) * 8, value))
            return {};
        raw[codeword] = value;
        data[dataPlan.destination[codeword]] = value;
    }

    auto& noRsGate = guidedSparseNoRsGate();
    const bool tryNoRsFirst = guidedTryNoRsFirst(noRsGate);
    auto tryDirect = [&]() -> DecoderResult {
        result.dataOnlyAttempted = true;
        const double decodeStarted = guidedNowMs();
        auto direct = QRCode::DecodeBitStream(std::move(data), *version, QRCode::ErrorCorrectionLevel::Low);
        result.decodeMs += guidedNowMs() - decodeStarted;
        const bool accepted = direct.isValid() && !direct.content().bytes.empty() &&
                              hasValidCRC32(direct.content().bytes);
        result.dataOnlySuccess = accepted;
        guidedNoteNoRs(noRsGate, accepted);
        return accepted ? std::move(direct) : DecoderResult{};
    };

    if (tryNoRsFirst) {
        auto direct = tryDirect();
        if (direct.isValid())
            return direct;
    }

    result.rsAttempted = true;
    for (int codeword = dataPlan.dataCodewords; codeword < totalCodewords; ++codeword) {
        uint8_t value = 0;
        if (!sampleByte(fullPlan, size_t(codeword) * 8, value)) {
            if (!tryNoRsFirst) {
                auto direct = tryDirect();
                if (direct.isValid())
                    return direct;
            }
            return {};
        }
        raw[codeword] = value;
    }

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
    result.decodeMs += guidedNowMs() - decodeStarted;
    if (decoded.isValid() && !decoded.content().bytes.empty() && hasValidCRC32(decoded.content().bytes))
        return decoded;

    if (!tryNoRsFirst) {
        auto direct = tryDirect();
        if (direct.isValid())
            return direct;
    }
    return decoded;
}
'''
if old not in s:
    raise SystemExit('sparse progressive tail anchor missing')
s = s.replace(old, new, 1)

old = '''    ByteArray raw(totalCodewords);
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
new = '''    ByteArray raw(totalCodewords);
    ByteArray progressiveData;
    int firstParityCodeword = 0;
    bool tryNoRsFirst = false;
    GuidedNoRsGate* noRsGate = nullptr;
    if (progressive) {
        const auto& dataPlan = turboDataPlan(dim);
        if (dataPlan.dataCodewords <= 0 ||
            dataPlan.samples.size() != size_t(dataPlan.dataCodewords) * 8 ||
            dataPlan.destination.size() != size_t(dataPlan.dataCodewords))
            return {};
        progressiveData.resize(dataPlan.dataCodewords);
        const double sampleStarted = guidedNowMs();
        for (int codeword = 0; codeword < dataPlan.dataCodewords; ++codeword) {
            uint8_t value = 0;
            if (!sampleByte(dataPlan.samples, size_t(codeword) * 8, value)) {
                metrics.sampleMs += guidedNowMs() - sampleStarted;
                return {};
            }
            raw[codeword] = value;
            progressiveData[dataPlan.destination[codeword]] = value;
        }
        metrics.sampleMs += guidedNowMs() - sampleStarted;

        noRsGate = &guidedStableNoRsGate();
        tryNoRsFirst = guidedTryNoRsFirst(*noRsGate);
        if (tryNoRsFirst) {
            ++metrics.sparseNoRsAttempts;
            const double decodeStarted = guidedNowMs();
            auto direct = QRCode::DecodeBitStream(std::move(progressiveData), *version, QRCode::ErrorCorrectionLevel::Low);
            metrics.decodeMs += guidedNowMs() - decodeStarted;
            const bool accepted = direct.isValid() && !direct.content().bytes.empty() &&
                                  hasValidCRC32(direct.content().bytes);
            guidedNoteNoRs(*noRsGate, accepted);
            if (accepted) {
                ++metrics.sparseNoRsSuccesses;
                return direct;
            }
        }
        firstParityCodeword = dataPlan.dataCodewords;
    }

    auto tryDeferredNoRs = [&]() -> DecoderResult {
        if (!progressive || tryNoRsFirst || !noRsGate)
            return {};
        ++metrics.sparseNoRsAttempts;
        const double decodeStarted = guidedNowMs();
        auto direct = QRCode::DecodeBitStream(std::move(progressiveData), *version, QRCode::ErrorCorrectionLevel::Low);
        metrics.decodeMs += guidedNowMs() - decodeStarted;
        const bool accepted = direct.isValid() && !direct.content().bytes.empty() &&
                              hasValidCRC32(direct.content().bytes);
        guidedNoteNoRs(*noRsGate, accepted);
        if (accepted) {
            ++metrics.sparseNoRsSuccesses;
            return direct;
        }
        return {};
    };

    if (rsUsedOut) *rsUsedOut = true;
    const double sampleStarted = guidedNowMs();
    for (int codeword = firstParityCodeword; codeword < totalCodewords; ++codeword) {
        uint8_t value = 0;
        if (!sampleByte(fullPlan, size_t(codeword) * 8, value)) {
            metrics.sampleMs += guidedNowMs() - sampleStarted;
            auto direct = tryDeferredNoRs();
            return direct.isValid() ? direct : DecoderResult{};
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
    if (decoded.isValid() && !decoded.content().bytes.empty() && hasValidCRC32(decoded.content().bytes))
        return decoded;

    auto direct = tryDeferredNoRs();
    return direct.isValid() ? direct : decoded;
}
'''
if old not in s:
    raise SystemExit('Stable-RS progressive block anchor missing')
s = s.replace(old, new, 1)

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
