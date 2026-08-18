from pathlib import Path

cpp=Path('vendor/decimen-codec/source/wrapper/decimen_codec.cpp')
s=cpp.read_text()
anchor='''static DecoderResult decodeTurboStableRS(const GuidedTurboTrack& cache,'''
helper=r'''// AirGapper's streamed QR profile is fixed by Send: Model-2 byte mode,
// error-correction level L and mask pattern 4. Once Guided has already sampled
// a normalized QR BitMatrix, running the generic format/mask parser again is
// redundant. Decode the known placement directly; CRC remains the acceptance
// gate at commitDecoded(), and the caller immediately retries generic QRCode::
// Decode on any miss, so non-AirGapper/plain QR compatibility is unchanged.
static DecoderResult decodeAirGapperSampledBits(const BitMatrix& bits)
{
    const int dim = bits.width();
    if (dim != bits.height() || dim < 21 || dim > 177 || ((dim - 17) & 3))
        return {};
    const auto* version = QRCode::Version::Model2((dim - 17) / 4);
    if (!version)
        return {};
    const int totalCodewords = version->totalCodewords();
    if (totalCodewords <= 0)
        return {};
    const auto& plan = turboCodewordPlan(dim);
    if (plan.size() != size_t(totalCodewords) * 8)
        return {};

    ByteArray raw(totalCodewords);
    for (int codeword = 0; codeword < totalCodewords; ++codeword) {
        uint8_t value = 0;
        const size_t firstBit = size_t(codeword) * 8;
        for (int bit = 0; bit < 8; ++bit) {
            const uint32_t entry = plan[firstBit + bit];
            const int x = int(entry & 0xff);
            const int y = int((entry >> 8) & 0xff);
            const bool mask = ((entry >> 16) & 1) != 0;
            const bool dark = bits.get(x, y);
            value = uint8_t((value << 1) | uint8_t(mask != dark));
        }
        raw[codeword] = value;
    }

    auto blocks = QRCode::DataBlock::GetDataBlocks(raw, *version, QRCode::ErrorCorrectionLevel::Low);
    if (blocks.empty())
        return {};
    int dataBytes = 0;
    for (const auto& block : blocks)
        dataBytes += block.numDataCodewords();
    ByteArray data(dataBytes);
    auto dst = data.begin();
    for (auto& block : blocks) {
        auto& codewords = block.codewords();
        const int dataCount = block.numDataCodewords();
        const int eccCount = int(codewords.size()) - dataCount;
        if (eccCount <= 0 || !ReedSolomonDecode(RSField::QRCode, codewords, eccCount))
            return {};
        dst = std::copy_n(codewords.begin(), dataCount, dst);
    }
    return QRCode::DecodeBitStream(std::move(data), *version, QRCode::ErrorCorrectionLevel::Low);
}

'''
if 'decodeAirGapperSampledBits(' not in s:
    if anchor not in s: raise SystemExit('Stable-RS helper anchor missing')
    s=s.replace(anchor,helper+anchor,1)

old='''                    ++metrics->sparseRsFallbacks;
                    auto decoded = QRCode::Decode(sparse.bits());
                    decodedTrack = commitDecoded(sparse, decoded);
                    const double fastElapsed = guidedNowMs() - fastStart;'''
new='''                    ++metrics->sparseRsFallbacks;
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
                    const double fastElapsed = guidedNowMs() - fastStart;'''
if old not in s: raise SystemExit('sparse generic decode anchor missing')
s=s.replace(old,new,1)

old_assert='''static_assert(sizeof(DecimenGuidedMetrics) == 160,
              "DecimenGuidedMetrics JS ABI must allocate 160 bytes");'''
new_assert='''static_assert(sizeof(DecimenGuidedMetrics) == 168,
              "DecimenGuidedMetrics JS ABI must allocate 168 bytes");'''
if old_assert not in s: raise SystemExit('metrics size static_assert missing')
s=s.replace(old_assert,new_assert,1)
cpp.write_text(s)

h=Path('vendor/decimen-codec/source/wrapper/decimen_codec.h')
s=h.read_text()
old='''\tuint32_t stableRsAttempts;\n\tuint32_t stableRsSuccesses;\n\tuint32_t stableEligibleTracks;\n};'''
new='''\tuint32_t stableRsAttempts;\n\tuint32_t stableRsSuccesses;\n\tuint32_t stableEligibleTracks;\n\tuint32_t sparseProfileAttempts;\n\tuint32_t sparseProfileSuccesses;\n};'''
if old not in s: raise SystemExit('metrics struct tail missing')
h.write_text(s.replace(old,new,1))

w=Path('receive/worker.js')
s=w.read_text()
if 'const GUIDED_METRICS_BYTES = 160;' not in s: raise SystemExit('worker metrics byte size missing')
s=s.replace('const GUIDED_METRICS_BYTES = 160;', 'const GUIDED_METRICS_BYTES = 168;', 1)
old='''    stableRsAttempts: metricsView.getUint32(144, true),\n    stableRsSuccesses: metricsView.getUint32(148, true),\n    stableEligibleTracks: metricsView.getUint32(152, true)'''
new='''    stableRsAttempts: metricsView.getUint32(144, true),\n    stableRsSuccesses: metricsView.getUint32(148, true),\n    stableEligibleTracks: metricsView.getUint32(152, true),\n    sparseProfileAttempts: metricsView.getUint32(156, true),\n    sparseProfileSuccesses: metricsView.getUint32(160, true)'''
if old not in s: raise SystemExit('worker metrics parser tail missing')
w.write_text(s.replace(old,new,1))

m=Path('receive/main.js')
s=m.read_text()
old='''stable ${lastGuidedMetrics.stableEligibleTracks ?? 0} · module ${(lastGuidedMetrics.moduleSizeAvg ?? 0).toFixed(2)}px [${(lastGuidedMetrics.moduleSizeMin ?? 0).toFixed(2)}–${(lastGuidedMetrics.moduleSizeMax ?? 0).toFixed(2)}] · RS'''
new='''stable ${lastGuidedMetrics.stableEligibleTracks ?? 0} · profile ${lastGuidedMetrics.sparseProfileSuccesses ?? 0}/${lastGuidedMetrics.sparseProfileAttempts ?? 0} · module ${(lastGuidedMetrics.moduleSizeAvg ?? 0).toFixed(2)}px [${(lastGuidedMetrics.moduleSizeMin ?? 0).toFixed(2)}–${(lastGuidedMetrics.moduleSizeMax ?? 0).toFixed(2)}] · RS'''
if old not in s: raise SystemExit('live Guided diagnostics anchor missing')
s=s.replace(old,new,1)
old='''    stableRsSuccesses: sumGuided("stableRsSuccesses"),\n    dataOnlyAttempts: sumGuided("sparseNoRsAttempts"),'''
new='''    stableRsSuccesses: sumGuided("stableRsSuccesses"),\n    sparseProfileAttempts: sumGuided("sparseProfileAttempts"),\n    sparseProfileSuccesses: sumGuided("sparseProfileSuccesses"),\n    dataOnlyAttempts: sumGuided("sparseNoRsAttempts"),'''
if old not in s: raise SystemExit('benchmark Guided aggregate anchor missing')
s=s.replace(old,new,1)
if 'const RECEIVER_RUNTIME_BUILD = "v0.5.233";' not in s: raise SystemExit('receiver version anchor missing')
s=s.replace('const RECEIVER_RUNTIME_BUILD = "v0.5.233";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.234";', 1)
m.write_text(s)

for path in ['main.js','index.html']:
    q=Path(path); text=q.read_text()
    if 'v0.5.233' not in text: raise SystemExit(f'{path}: app version anchor missing')
    q.write_text(text.replace('v0.5.233','v0.5.234'))
q=Path('vendor/decimen-codec/source/VERSION'); text=q.read_text().strip()
if text != '0.1.42': raise SystemExit(f'unexpected codec version {text}')
q.write_text('0.1.43\n')
q=Path('sw.js'); text=q.read_text()
if 'airgapper-static-js-v189' not in text: raise SystemExit('sw cache anchor missing')
q.write_text(text.replace('airgapper-static-js-v189','airgapper-static-js-v190',1))
