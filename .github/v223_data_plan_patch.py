from pathlib import Path

p = Path("vendor/decimen-codec/source/wrapper/decimen_codec.cpp")
s = p.read_text()
start = s.index('static DecoderResult decodeTurboDataOnly(')
end = s.index('// Model-2 data placement never changes for a given dimension.', start)
old = s[start:end]
new = r'''static const std::vector<uint32_t>& turboCodewordPlan(int dim);

struct TurboDataPlan
{
    std::vector<uint32_t> samples;
    std::vector<uint16_t> destination;
    int dataCodewords = 0;
};

// The QR placement walk, function mask, EC block layout and data deinterleave
// destination are immutable for a Model-2 version + EC level. CRC-Turbo used to
// rebuild all of them for every physical QR on every frame. Build once per
// worker/version, then sample data codewords directly into DecodeBitStream order.
static const TurboDataPlan& turboDataPlan(int dim)
{
    static std::array<TurboDataPlan, 41> plans;
    static const TurboDataPlan empty;
    if (dim < 21 || dim > 177 || ((dim - 17) & 3))
        return empty;
    const int versionNumber = (dim - 17) / 4;
    const auto* version = QRCode::Version::Model2(versionNumber);
    if (!version)
        return empty;
    auto& plan = plans[versionNumber];
    if (plan.dataCodewords)
        return plan;

    const auto& ecBlocks = version->ecBlocksForLevel(QRCode::ErrorCorrectionLevel::Low);
    std::vector<int> blockSizes;
    for (const auto& group : ecBlocks.blockArray())
        for (int i = 0; i < group.count; ++i)
            blockSizes.push_back(group.dataCodewords);
    if (blockSizes.empty())
        return empty;

    int dataCodewords = 0;
    std::vector<int> blockOffsets(blockSizes.size());
    for (size_t block = 0; block < blockSizes.size(); ++block) {
        blockOffsets[block] = dataCodewords;
        dataCodewords += blockSizes[block];
    }
    if (dataCodewords <= 0 || dataCodewords >= 65536)
        return empty;

    const auto& fullPlan = turboCodewordPlan(dim);
    const size_t wantedBits = size_t(dataCodewords) * 8;
    if (fullPlan.size() < wantedBits)
        return empty;
    plan.samples.assign(fullPlan.begin(), fullPlan.begin() + wantedBits);
    plan.destination.resize(dataCodewords);

    const int minData = *std::min_element(blockSizes.begin(), blockSizes.end());
    int raw = 0;
    for (int i = 0; i < minData; ++i)
        for (size_t block = 0; block < blockSizes.size(); ++block)
            plan.destination[raw++] = uint16_t(blockOffsets[block] + i);
    for (size_t block = 0; block < blockSizes.size(); ++block)
        if (blockSizes[block] > minData)
            plan.destination[raw++] = uint16_t(blockOffsets[block] + minData);
    if (raw != dataCodewords) {
        plan = {};
        return empty;
    }
    plan.dataCodewords = dataCodewords;
    return plan;
}

static DecoderResult decodeTurboDataOnly(const GuidedTurboTrack& cache, const DecimenGuidedTrack& track,
                                         const TurboFrameTransform& frameTransform,
                                         const uint8_t* yPlane, int width, int height, int stride,
                                         float dx, float dy, const TurboLevels& levels,
                                         DecimenGuidedMetrics& metrics)
{
    const int dim = track.dimension;
    const auto* version = QRCode::Version::Model2((dim - 17) / 4);
    if (!version)
        return {};
    const auto& plan = turboDataPlan(dim);
    if (plan.dataCodewords <= 0 || plan.samples.size() != size_t(plan.dataCodewords) * 8 ||
        plan.destination.size() != size_t(plan.dataCodewords))
        return {};

    const double sampleStarted = guidedNowMs();
    ByteArray data(plan.dataCodewords);
    const float moduleSize = guidedModuleSize(track);
    bool failed = false;
    for (int codeword = 0; codeword < plan.dataCodewords && !failed; ++codeword) {
        uint8_t value = 0;
        const size_t firstBit = size_t(codeword) * 8;
        for (int bit = 0; bit < 8; ++bit) {
            const uint32_t entry = plan.samples[firstBit + bit];
            const int xx = int(entry & 0xff);
            const int y = int((entry >> 8) & 0xff);
            const bool mask = ((entry >> 16) & 1) != 0;
            const int threshold = turboThreshold(levels, xx, y, dim);
            const int lum = turboModuleLum(cache, track, frameTransform, yPlane, width, height, stride,
                                           xx, y, dx, dy, threshold, moduleSize);
            if (lum < 0) { failed = true; break; }
            value = uint8_t((value << 1) | uint8_t(mask != (lum <= threshold)));
        }
        if (!failed)
            data[plan.destination[codeword]] = value;
    }
    metrics.sampleMs += guidedNowMs() - sampleStarted;
    if (failed)
        return {};

    const double decodeStarted = guidedNowMs();
    auto decoded = QRCode::DecodeBitStream(std::move(data), *version, QRCode::ErrorCorrectionLevel::Low);
    metrics.decodeMs += guidedNowMs() - decodeStarted;
    return decoded;
}

'''
s = s[:start] + new + s[end:]
p.write_text(s)
