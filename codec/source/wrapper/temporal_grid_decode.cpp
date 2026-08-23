/*
 * Direct QR module-grid decode for low-count rolling-shutter reconstruction.
 *
 * The temporal worker already knows QR geometry and has a normalized module
 * matrix. Re-rasterizing that matrix into an image and running finder detection
 * again is pure overhead. This entry point goes straight into zxing-cpp's QR
 * decoder (format -> data mask -> Reed-Solomon -> bitstream). AirGapper's own
 * CRC is still verified in JavaScript before a recovered packet is accepted.
 */
#include "BitMatrix.h"
#include "Content.h"
#include "DecoderResult.h"
#include "qrcode/QRDecoder.h"

#include <cstdint>
#include <cstring>

using namespace ZXing;

extern "C" int decodeModuleGrid(const uint8_t* modules, int dimension,
                                uint8_t* output, int outputCapacity)
{
    if (!modules || !output || outputCapacity <= 0 ||
        dimension < 21 || dimension > 177 || ((dimension - 17) & 3))
        return -1;

    BitMatrix bits(dimension, dimension);
    const int count = dimension * dimension;
    for (int i = 0; i < count; ++i) {
        // Temporal JS uses 0 for dark and 255 for light. Accept any grayscale
        // value here so future confidence-aware composition can call the same
        // ABI without first creating a second binary allocation.
        if (modules[i] < 128)
            bits.set(i % dimension, i / dimension);
    }

    auto decoded = QRCode::Decode(bits);
    if (!decoded.isValid() || decoded.content().bytes.empty())
        return 0;

    const auto& bytes = decoded.content().bytes;
    if (int(bytes.size()) > outputCapacity)
        return -2;
    std::memcpy(output, bytes.data(), bytes.size());
    return int(bytes.size());
}
