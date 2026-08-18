from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing anchor in {path}: {old[:140]!r}")
    p.write_text(text.replace(old, new, 1))

cpp = Path("vendor/decimen-codec/source/wrapper/decimen_codec.cpp")
s = cpp.read_text()
anchor = '''// AirGapper's streamed QR profile is fixed by Send: Model-2 byte mode,
'''
helper = r'''struct TurboRsWorkspace
{
    bool ready = false;
    int eccCodewords = 0;
    int minDataCodewords = 0;
    int dataBytes = 0;
    std::vector<int> dataCounts;
    std::vector<ByteArray> blocks;
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
    workspace.ready = workspace.dataBytes > 0;
    return workspace;
}

static DecoderResult decodeAirGapperRsWorkspace(const ByteArray& raw, const QRCode::Version& version)
{
    if (raw.size() != size_t(version.totalCodewords()))
        return {};
    auto& workspace = turboRsWorkspace(version);
    if (!workspace.ready)
        return {};

    size_t offset = 0;
    const int blockCount = int(workspace.blocks.size());
    // Exact Model-2 interleave used by QRDataBlock::GetDataBlocks, but refill
    // persistent per-version block buffers instead of allocating DataBlock +
    // ByteArray objects for every physical QR.
    for (int i = 0; i < workspace.minDataCodewords; ++i)
        for (int block = 0; block < blockCount; ++block)
            workspace.blocks[block][i] = raw[offset++];
    for (int block = 0; block < blockCount; ++block)
        if (workspace.dataCounts[block] > workspace.minDataCodewords)
            workspace.blocks[block][workspace.minDataCodewords] = raw[offset++];
    for (int ecc = 0; ecc < workspace.eccCodewords; ++ecc)
        for (int block = 0; block < blockCount; ++block)
            workspace.blocks[block][workspace.dataCounts[block] + ecc] = raw[offset++];
    if (offset != raw.size())
        return {};

    ByteArray corrected(workspace.dataBytes);
    auto dst = corrected.begin();
    for (int block = 0; block < blockCount; ++block) {
        auto& codewords = workspace.blocks[block];
        if (!ReedSolomonDecode(RSField::QRCode, codewords, workspace.eccCodewords))
            return {};
        dst = std::copy_n(codewords.begin(), workspace.dataCounts[block], dst);
    }
    // Keep ZXing's normal QR bitstream parser untouched; only block storage and
    // deinterleave allocation are optimized here.
    return QRCode::DecodeBitStream(std::move(corrected), version, QRCode::ErrorCorrectionLevel::Low);
}

'''
if anchor not in s:
    raise SystemExit("known profile anchor missing")
s = s.replace(anchor, helper + anchor, 1)

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
if old_sampled not in s:
    raise SystemExit("sampled RS anchor missing")
s = s.replace(old_sampled, '    return decodeAirGapperRsWorkspace(raw, *version);\n', 1)

old_progressive = '''    DecoderResult decoded;
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
if s.count(old_progressive) != 2:
    raise SystemExit(f"expected two progressive RS blocks, got {s.count(old_progressive)}")
s = s.replace(old_progressive, '    DecoderResult decoded = decodeAirGapperRsWorkspace(raw, *version);\n', 2)
# Only the generic no-RS compatibility decoder should still use DataBlock objects.
if s.count('QRCode::DataBlock::GetDataBlocks') != 1:
    raise SystemExit(f"unexpected DataBlock call count {s.count('QRCode::DataBlock::GetDataBlocks')}")
cpp.write_text(s)

Path("vendor/decimen-codec/source/VERSION").write_text("0.1.57\n")
replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.263";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.265";')
replace_once("main.js", 'const APP_BUILD = "v0.5.263";', 'const APP_BUILD = "v0.5.265";')
index = Path("index.html").read_text().replace('v0.5.263', 'v0.5.265')
Path("index.html").write_text(index)
sw = Path("sw.js").read_text().replace('airgapper-static-js-v214', 'airgapper-static-js-v215', 1)
Path("sw.js").write_text(sw)
