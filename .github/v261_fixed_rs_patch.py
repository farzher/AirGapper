from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing anchor in {path}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))

cpp = Path("vendor/decimen-codec/source/wrapper/decimen_codec.cpp")
s = cpp.read_text()

anchor = '''static DecoderResult decodeTurboDataOnly(const GuidedTurboTrack& cache, const DecimenGuidedTrack& track,
'''
helper = r'''// AirGapper sender QRs are always Model-2 byte mode, EC-L, mask 4. Once QR
// error correction has produced the data-codeword stream, the generic mode/ECI/
// segment parser is unnecessary. Parse the one byte segment directly; CRC at
// the caller remains the final acceptance oracle. Any non-AirGapper shape falls
// back to ZXing's generic parser.
static DecoderResult decodeAirGapperByteData(const ByteArray& data, const QRCode::Version& version)
{
    if (data.size() < 3 || (data[0] >> 4) != 0x4)
        return {};
    const bool longCount = version.versionNumber() >= 10;
    const int count = longCount
        ? ((int(data[0] & 0x0f) << 12) | (int(data[1]) << 4) | (int(data[2]) >> 4))
        : ((int(data[0] & 0x0f) << 4) | (int(data[1]) >> 4));
    const int base = longCount ? 2 : 1;
    if (count <= 0 || size_t(base + count + 1) > data.size())
        return {};

    Content content;
    content.bytes.resize(count);
    for (int i = 0; i < count; ++i)
        content.bytes[i] = uint8_t(((data[base + i] & 0x0f) << 4) | (data[base + i + 1] >> 4));
    DecoderResult result(std::move(content));
    result.setVersionNumber(version.versionNumber());
    result.setEcLevel("L");
    return result;
}

static DecoderResult decodeAirGapperByteDataOrGeneric(ByteArray&& data, const QRCode::Version& version)
{
    auto fast = decodeAirGapperByteData(data, version);
    if (fast.isValid())
        return fast;
    return QRCode::DecodeBitStream(std::move(data), version, QRCode::ErrorCorrectionLevel::Low);
}

// QR block sizes/interleave order depend only on version + EC level. Guided
// decodes thousands of the same version, so allocate the RS blocks once per
// worker/version and refill them in place. This is the same mapping as ZXing's
// QRDataBlock::GetDataBlocks, without constructing vectors/ByteArrays per QR.
struct TurboRsWorkspace
{
    bool ready = false;
    int eccCodewords = 0;
    int minDataCodewords = 0;
    int dataBytes = 0;
    std::vector<int> dataCounts;
    std::vector<ByteArray> blocks;
    ByteArray corrected;
};

static TurboRsWorkspace& turboRsWorkspace(const QRCode::Version& version)
{
    static std::array<TurboRsWorkspace, 41> workspaces;
    auto& workspace = workspaces[version.versionNumber()];
    if (workspace.ready)
        return workspace;

    const auto& ec = version.ecBlocksForLevel(QRCode::ErrorCorrectionLevel::Low);
    workspace.eccCodewords = ec.codewordsPerBlock;
    for (const auto& group : ec.blockArray())
        for (int i = 0; i < group.count; ++i)
            workspace.dataCounts.push_back(group.dataCodewords);
    if (workspace.eccCodewords <= 0 || workspace.dataCounts.empty())
        return workspace;

    workspace.minDataCodewords = *std::min_element(workspace.dataCounts.begin(), workspace.dataCounts.end());
    for (int count : workspace.dataCounts) {
        if (count < workspace.minDataCodewords || count > workspace.minDataCodewords + 1) {
            workspace.dataCounts.clear();
            return workspace;
        }
        workspace.dataBytes += count;
        workspace.blocks.emplace_back(size_t(count + workspace.eccCodewords));
    }
    workspace.corrected.resize(workspace.dataBytes);
    workspace.ready = workspace.dataBytes > 0;
    return workspace;
}

static DecoderResult decodeAirGapperRawRs(const ByteArray& raw, const QRCode::Version& version)
{
    if (raw.size() != size_t(version.totalCodewords()))
        return {};
    auto& workspace = turboRsWorkspace(version);
    if (!workspace.ready)
        return {};

    size_t offset = 0;
    const int blockCount = int(workspace.blocks.size());
    // Common data bytes are interleaved across all blocks.
    for (int i = 0; i < workspace.minDataCodewords; ++i)
        for (int block = 0; block < blockCount; ++block)
            workspace.blocks[block][i] = raw[offset++];
    // QR versions with two block sizes put the one extra data byte for every
    // longer block next.
    for (int block = 0; block < blockCount; ++block)
        if (workspace.dataCounts[block] > workspace.minDataCodewords)
            workspace.blocks[block][workspace.minDataCodewords] = raw[offset++];
    // ECC bytes are then interleaved by parity position across all blocks.
    for (int ecc = 0; ecc < workspace.eccCodewords; ++ecc)
        for (int block = 0; block < blockCount; ++block)
            workspace.blocks[block][workspace.dataCounts[block] + ecc] = raw[offset++];
    if (offset != raw.size())
        return {};

    size_t dataOffset = 0;
    for (int block = 0; block < blockCount; ++block) {
        auto& codewords = workspace.blocks[block];
        if (!ReedSolomonDecode(RSField::QRCode, codewords, workspace.eccCodewords))
            return {};
        const int count = workspace.dataCounts[block];
        std::copy_n(codewords.begin(), count, workspace.corrected.begin() + dataOffset);
        dataOffset += count;
    }
    if (dataOffset != workspace.corrected.size())
        return {};

    auto fast = decodeAirGapperByteData(workspace.corrected, version);
    if (fast.isValid())
        return fast;
    // Non-AirGapper/plain QR compatibility is not part of the hot path, but
    // retain it without moving the reusable workspace buffer.
    ByteArray generic(workspace.corrected.begin(), workspace.corrected.end());
    return QRCode::DecodeBitStream(std::move(generic), version, QRCode::ErrorCorrectionLevel::Low);
}

'''
if anchor not in s:
    raise SystemExit("decodeTurboDataOnly anchor missing")
s = s.replace(anchor, helper + anchor, 1)

# Data-only cached path: direct byte parser first, generic fallback only for a non-AirGapper segment shape.
s = s.replace(
    'auto decoded = QRCode::DecodeBitStream(std::move(data), *version, QRCode::ErrorCorrectionLevel::Low);',
    'auto decoded = decodeAirGapperByteDataOrGeneric(std::move(data), *version);',
    1,
)

# Sampled known-profile RS: replace generic block object construction with reusable fixed workspace.
old_sampled = '''    auto blocks = QRCode::DataBlock::GetDataBlocks(raw, *version, QRCode::ErrorCorrectionLevel::Low);
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
'''
new_sampled = '''    return decodeAirGapperRawRs(raw, *version);
'''
if old_sampled not in s:
    raise SystemExit("sampled RS block anchor missing")
s = s.replace(old_sampled, new_sampled, 1)

# Sparse no-RS parse.
s = s.replace(
    'auto direct = QRCode::DecodeBitStream(std::move(data), *version, QRCode::ErrorCorrectionLevel::Low);',
    'auto direct = decodeAirGapperByteDataOrGeneric(std::move(data), *version);',
    1,
)

# Sparse RS block section.
old_sparse = '''    DecoderResult decoded;
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
'''
new_sparse = '''    DecoderResult decoded = decodeAirGapperRawRs(raw, *version);
'''
if old_sparse not in s:
    raise SystemExit("sparse RS block anchor missing")
s = s.replace(old_sparse, new_sparse, 1)

# Stable progressive no-RS parse (same text but a different variable name).
s = s.replace(
    'auto direct = QRCode::DecodeBitStream(std::move(progressiveData), *version, QRCode::ErrorCorrectionLevel::Low);',
    'auto direct = decodeAirGapperByteDataOrGeneric(std::move(progressiveData), *version);',
    1,
)

# Stable RS uses the same generic block section as sparse; replace the remaining occurrence.
if old_sparse not in s:
    raise SystemExit("stable RS block anchor missing")
s = s.replace(old_sparse, new_sparse, 1)

# The only remaining DataBlock::GetDataBlocks must be the generic compatibility decoder.
if s.count('QRCode::DataBlock::GetDataBlocks') != 1:
    raise SystemExit(f"unexpected generic DataBlock count: {s.count('QRCode::DataBlock::GetDataBlocks')}")
cpp.write_text(s)

Path("vendor/decimen-codec/source/VERSION").write_text("0.1.56\n")
replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.260";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.261";')
replace_once("main.js", 'const APP_BUILD = "v0.5.260";', 'const APP_BUILD = "v0.5.261";')
index = Path("index.html").read_text().replace('v0.5.260', 'v0.5.261')
Path("index.html").write_text(index)
sw = Path("sw.js").read_text().replace('airgapper-static-js-v213', 'airgapper-static-js-v214', 1)
Path("sw.js").write_text(sw)
