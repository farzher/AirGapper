from pathlib import Path

cpp = Path('vendor/decimen-codec/source/wrapper/decimen_codec.cpp')
s = cpp.read_text()

s = s.replace(
'''// enter regimes where it almost never succeeds. Learn that independently per
// worker/path. When recent success falls below 12.5%, QR RS gets first chance;
// raw-data decode is retained behind RS failure, and a periodic probe lets the
// shortcut recover quickly when the image becomes clean again.
''',
'''// enter regimes where it almost never succeeds. Learn that independently per
// worker/path. When recent success falls below 12.5%, stop paying for the raw
// decode entirely and use QR RS. A periodic probe lets the shortcut recover
// quickly when the image becomes clean again.
''', 1)

old_sparse = '''    ByteArray raw(totalCodewords);
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
'''
new_sparse = '''    auto& noRsGate = guidedSparseNoRsGate();
    const bool tryNoRsFirst = guidedTryNoRsFirst(noRsGate);
    ByteArray raw(totalCodewords);
    ByteArray data;
    if (tryNoRsFirst)
        data.resize(dataPlan.dataCodewords);
    for (int codeword = 0; codeword < dataPlan.dataCodewords; ++codeword) {
        uint8_t value = 0;
        if (!sampleByte(dataPlan.samples, size_t(codeword) * 8, value))
            return {};
        raw[codeword] = value;
        if (tryNoRsFirst)
            data[dataPlan.destination[codeword]] = value;
    }

    if (tryNoRsFirst) {
        result.dataOnlyAttempted = true;
        const double decodeStarted = guidedNowMs();
        auto direct = QRCode::DecodeBitStream(std::move(data), *version, QRCode::ErrorCorrectionLevel::Low);
        result.decodeMs += guidedNowMs() - decodeStarted;
        const bool accepted = direct.isValid() && !direct.content().bytes.empty() &&
                              hasValidCRC32(direct.content().bytes);
        result.dataOnlySuccess = accepted;
        guidedNoteNoRs(noRsGate, accepted);
        if (accepted)
            return direct;
    }

    result.rsAttempted = true;
    for (int codeword = dataPlan.dataCodewords; codeword < totalCodewords; ++codeword) {
        uint8_t value = 0;
        if (!sampleByte(fullPlan, size_t(codeword) * 8, value))
            return {};
        raw[codeword] = value;
    }
'''
if old_sparse not in s:
    raise SystemExit('sparse no-RS block anchor missing')
s = s.replace(old_sparse, new_sparse, 1)

old_sparse_tail = '''    if (decoded.isValid() && !decoded.content().bytes.empty() && hasValidCRC32(decoded.content().bytes))
        return decoded;

    if (!tryNoRsFirst) {
        auto direct = tryDirect();
        if (direct.isValid())
            return direct;
    }
    return decoded;
}
'''
new_sparse_tail = '''    return decoded;
}
'''
if old_sparse_tail not in s:
    raise SystemExit('sparse deferred no-RS tail anchor missing')
s = s.replace(old_sparse_tail, new_sparse_tail, 1)

old_stable_setup = '''    ByteArray raw(totalCodewords);
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
'''
new_stable_setup = '''    ByteArray raw(totalCodewords);
    int firstParityCodeword = 0;
    if (progressive) {
        const auto& dataPlan = turboDataPlan(dim);
        if (dataPlan.dataCodewords <= 0 ||
            dataPlan.samples.size() != size_t(dataPlan.dataCodewords) * 8 ||
            dataPlan.destination.size() != size_t(dataPlan.dataCodewords))
            return {};
        auto& noRsGate = guidedStableNoRsGate();
        const bool tryNoRsFirst = guidedTryNoRsFirst(noRsGate);
        ByteArray progressiveData;
        if (tryNoRsFirst)
            progressiveData.resize(dataPlan.dataCodewords);
        const double sampleStarted = guidedNowMs();
        for (int codeword = 0; codeword < dataPlan.dataCodewords; ++codeword) {
            uint8_t value = 0;
            if (!sampleByte(dataPlan.samples, size_t(codeword) * 8, value)) {
                metrics.sampleMs += guidedNowMs() - sampleStarted;
                return {};
            }
            raw[codeword] = value;
            if (tryNoRsFirst)
                progressiveData[dataPlan.destination[codeword]] = value;
        }
        metrics.sampleMs += guidedNowMs() - sampleStarted;

        if (tryNoRsFirst) {
            ++metrics.sparseNoRsAttempts;
            const double decodeStarted = guidedNowMs();
            auto direct = QRCode::DecodeBitStream(std::move(progressiveData), *version, QRCode::ErrorCorrectionLevel::Low);
            metrics.decodeMs += guidedNowMs() - decodeStarted;
            const bool accepted = direct.isValid() && !direct.content().bytes.empty() &&
                                  hasValidCRC32(direct.content().bytes);
            guidedNoteNoRs(noRsGate, accepted);
            if (accepted) {
                ++metrics.sparseNoRsSuccesses;
                return direct;
            }
        }
        firstParityCodeword = dataPlan.dataCodewords;
    }
'''
if old_stable_setup not in s:
    raise SystemExit('stable progressive setup anchor missing')
s = s.replace(old_stable_setup, new_stable_setup, 1)

old_parity_fail = '''        if (!sampleByte(fullPlan, size_t(codeword) * 8, value)) {
            metrics.sampleMs += guidedNowMs() - sampleStarted;
            auto direct = tryDeferredNoRs();
            if (direct.isValid()) return std::move(direct);
            return {};
        }
'''
new_parity_fail = '''        if (!sampleByte(fullPlan, size_t(codeword) * 8, value)) {
            metrics.sampleMs += guidedNowMs() - sampleStarted;
            return {};
        }
'''
if old_parity_fail not in s:
    raise SystemExit('stable parity failure deferred anchor missing')
s = s.replace(old_parity_fail, new_parity_fail, 1)

old_stable_tail = '''    if (decoded.isValid() && !decoded.content().bytes.empty() && hasValidCRC32(decoded.content().bytes))
        return decoded;

    auto direct = tryDeferredNoRs();
    if (direct.isValid()) return std::move(direct);
    return decoded;
}
'''
new_stable_tail = '''    return decoded;
}
'''
if old_stable_tail not in s:
    raise SystemExit('stable deferred no-RS tail anchor missing')
s = s.replace(old_stable_tail, new_stable_tail, 1)

cpp.write_text(s)

Path('vendor/decimen-codec/source/VERSION').write_text('0.1.52\n')
for path in ['main.js', 'receive/main.js', 'index.html']:
    p = Path(path)
    text = p.read_text()
    if 'v0.5.243' not in text:
        raise SystemExit(f'{path}: v0.5.243 missing')
    p.write_text(text.replace('v0.5.243', 'v0.5.244'))

sw = Path('sw.js')
text = sw.read_text()
if 'airgapper-static-js-v199' not in text:
    raise SystemExit('sw cache v199 missing')
sw.write_text(text.replace('airgapper-static-js-v199', 'airgapper-static-js-v200', 1))
