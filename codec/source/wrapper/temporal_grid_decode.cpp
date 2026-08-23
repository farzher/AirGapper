/*
 * Direct QR module-grid decode for low-count rolling-shutter reconstruction.
 *
 * The temporal worker already knows QR geometry and has a normalized module
 * matrix. Re-rasterizing that matrix into an image and running finder detection
 * again is pure overhead. These entry points go straight into QR decoding.
 * AirGapper's own CRC is still verified in JavaScript before a recovered packet
 * is accepted.
 */
#include "BitMatrix.h"
#include "ByteArray.h"
#include "Content.h"
#include "DecoderResult.h"
#include "ReedSolomon.h"
#include "qrcode/QRDataBlock.h"
#include "qrcode/QRDataMask.h"
#include "qrcode/QRDecoder.h"
#include "qrcode/QRVersion.h"

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <vector>

using namespace ZXing;

namespace ZXing::QRCode {
DecoderResult DecodeBitStream(ByteArray&& bytes, const Version& version, ErrorCorrectionLevel ecLevel);
}

namespace {

static bool validDimension(int dimension)
{
    return dimension >= 21 && dimension <= 177 && ((dimension - 17) & 3) == 0;
}

static BitMatrix toBitMatrix(const uint8_t* modules, int dimension)
{
    BitMatrix bits(dimension, dimension);
    const int count = dimension * dimension;
    for (int i = 0; i < count; ++i)
        if (modules[i] < 128)
            bits.set(i % dimension, i / dimension);
    return bits;
}

static int copyDecoded(const DecoderResult& decoded, uint8_t* output, int outputCapacity)
{
    if (!decoded.isValid() || decoded.content().bytes.empty())
        return 0;
    const auto& bytes = decoded.content().bytes;
    if (int(bytes.size()) > outputCapacity)
        return -2;
    std::memcpy(output, bytes.data(), bytes.size());
    return int(bytes.size());
}

// AirGapper sender QRs use Model-2 EC-L and mask 4. Build the fixed data-module
// traversal once per version. Each entry packs x, y and the mask bit.
static const std::vector<uint32_t>& codewordPlan(int dimension)
{
    static std::array<std::vector<uint32_t>, 41> plans;
    static const std::vector<uint32_t> empty;
    if (!validDimension(dimension))
        return empty;
    const int versionNumber = (dimension - 17) / 4;
    const auto* version = QRCode::Version::Model2(versionNumber);
    if (!version)
        return empty;
    auto& plan = plans[versionNumber];
    if (!plan.empty())
        return plan;

    const size_t wanted = size_t(version->totalCodewords()) * 8;
    plan.reserve(wanted);
    const auto functionPattern = version->buildFunctionPattern();
    bool readingUp = true;
    for (int x = dimension - 1; x > 0 && plan.size() < wanted; x -= 2) {
        if (x == 6) --x;
        for (int row = 0; row < dimension && plan.size() < wanted; ++row) {
            const int y = readingUp ? dimension - 1 - row : row;
            for (int col = 0; col < 2 && plan.size() < wanted; ++col) {
                const int xx = x - col;
                if (functionPattern.get(xx, y)) continue;
                const uint32_t mask = uint32_t(QRCode::GetDataMaskBit(4, xx, y));
                plan.push_back(uint32_t(xx) | (uint32_t(y) << 8) | (mask << 16));
            }
        }
        readingUp = !readingUp;
    }
    if (plan.size() != wanted) {
        plan.clear();
        return empty;
    }
    return plan;
}

static DecoderResult decodeKnownProfileWithErasures(const uint8_t* modules,
                                                      const uint8_t* erasureModules,
                                                      int dimension)
{
    const auto* version = QRCode::Version::Model2((dimension - 17) / 4);
    if (!version)
        return {};
    const int totalCodewords = version->totalCodewords();
    const auto& plan = codewordPlan(dimension);
    if (totalCodewords <= 0 || plan.size() != size_t(totalCodewords) * 8)
        return {};

    ByteArray raw(totalCodewords);
    ByteArray rawErasure(totalCodewords);
    std::fill(rawErasure.begin(), rawErasure.end(), uint8_t(255));

    for (int codeword = 0; codeword < totalCodewords; ++codeword) {
        uint8_t value = 0;
        bool erased = false;
        const size_t firstBit = size_t(codeword) * 8;
        for (int bit = 0; bit < 8; ++bit) {
            const uint32_t entry = plan[firstBit + bit];
            const int x = int(entry & 0xff);
            const int y = int((entry >> 8) & 0xff);
            const bool mask = ((entry >> 16) & 1) != 0;
            const int index = y * dimension + x;
            const bool dark = modules[index] < 128;
            value = uint8_t((value << 1) | uint8_t(mask != dark));
            erased = erased || erasureModules[index] != 0;
        }
        raw[codeword] = value;
        if (erased) rawErasure[codeword] = 0;
    }

    auto blocks = QRCode::DataBlock::GetDataBlocks(raw, *version, QRCode::ErrorCorrectionLevel::Low);
    auto erasureBlocks = QRCode::DataBlock::GetDataBlocks(rawErasure, *version, QRCode::ErrorCorrectionLevel::Low);
    if (blocks.empty() || erasureBlocks.size() != blocks.size())
        return {};

    int dataBytes = 0;
    for (const auto& block : blocks)
        dataBytes += block.numDataCodewords();
    ByteArray corrected(dataBytes);
    auto dst = corrected.begin();

    for (size_t blockIndex = 0; blockIndex < blocks.size(); ++blockIndex) {
        auto& block = blocks[blockIndex];
        auto& codewords = block.codewords();
        const int dataCount = block.numDataCodewords();
        const int eccCount = int(codewords.size()) - dataCount;
        if (eccCount <= 0)
            return {};

        const auto& scores = erasureBlocks[blockIndex].codewords();
        std::vector<int> erasures;
        erasures.reserve(eccCount);
        for (int i = 0; i < int(scores.size()); ++i)
            if (scores[i] == 0)
                erasures.push_back(i);
        if (int(erasures.size()) > eccCount)
            return {};

        const bool ok = erasures.empty()
            ? bool(ReedSolomonDecode(RSField::QRCode, codewords, eccCount))
            : bool(ReedSolomonDecode(RSField::QRCode, codewords, eccCount, erasures));
        if (!ok)
            return {};
        dst = std::copy_n(codewords.begin(), dataCount, dst);
    }

    return QRCode::DecodeBitStream(std::move(corrected), *version, QRCode::ErrorCorrectionLevel::Low);
}

} // namespace

extern "C" int decodeModuleGrid(const uint8_t* modules, int dimension,
                                uint8_t* output, int outputCapacity)
{
    if (!modules || !output || outputCapacity <= 0 || !validDimension(dimension))
        return -1;
    return copyDecoded(QRCode::Decode(toBitMatrix(modules, dimension)), output, outputCapacity);
}

extern "C" int decodeModuleGridErasures(const uint8_t* modules,
                                        const uint8_t* erasureModules,
                                        int dimension,
                                        uint8_t* output,
                                        int outputCapacity)
{
    if (!modules || !erasureModules || !output || outputCapacity <= 0 || !validDimension(dimension))
        return -1;

    // A normal decode is cheapest and remains the first choice when ordinary QR
    // RS can already tolerate the transition. Only fall into explicit erasures
    // when the hard matrix fails.
    const auto normal = QRCode::Decode(toBitMatrix(modules, dimension));
    const int direct = copyDecoded(normal, output, outputCapacity);
    if (direct != 0)
        return direct;

    const auto erased = decodeKnownProfileWithErasures(modules, erasureModules, dimension);
    return copyDecoded(erased, output, outputCapacity);
}
