#include <jni.h>

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <vector>

#include "ReadBarcode.h"
#include "ImageView.h"
#include "BarcodeFormat.h"
#include "airgapper_codec.h"

using namespace ZXing;

namespace {

constexpr uint32_t RESULT_MAGIC = 0x32444741; // AGD2 little endian
constexpr uint16_t RESULT_HEADER_BYTES = 104;
constexpr uint16_t RESULT_VERSION = 1;
constexpr int RESULT_RECORD_BYTES = 52;
constexpr int GUIDED_METRICS_BYTES = sizeof(AirGapperGuidedMetrics);
constexpr int GUIDED_OUTPUT_BYTES = 512 * 1024;

struct PacketMetadata {
    int width = 0;
    int height = 0;
    int jobId = 0;
    int sourceSequence = 0;
    int64_t frameNumber = 0;
    int64_t timestampNs = 0;
    int64_t exposureNs = 0;
    int64_t frameDurationNs = 0;
    int64_t rollingShutterSkewNs = 0;
    float focusDistance = 0;
    int iso = 0;
    int settingsEpoch = 0;
    int orientation = 0;
    int pipeline = 0;
    int mode = 0;
};

static void putU16(std::vector<uint8_t>& out, size_t at, uint16_t value)
{
    out[at] = uint8_t(value);
    out[at + 1] = uint8_t(value >> 8);
}

static void putU32(std::vector<uint8_t>& out, size_t at, uint32_t value)
{
    for (int i = 0; i < 4; ++i) out[at + i] = uint8_t(value >> (i * 8));
}

static void putI32(std::vector<uint8_t>& out, size_t at, int32_t value)
{
    putU32(out, at, static_cast<uint32_t>(value));
}

static void putI64(std::vector<uint8_t>& out, size_t at, int64_t value)
{
    const uint64_t u = static_cast<uint64_t>(value);
    for (int i = 0; i < 8; ++i) out[at + i] = uint8_t(u >> (i * 8));
}

static void putF32(std::vector<uint8_t>& out, size_t at, float value)
{
    uint32_t bits = 0;
    std::memcpy(&bits, &value, sizeof(bits));
    putU32(out, at, bits);
}

static void writeHeader(std::vector<uint8_t>& out, const PacketMetadata& meta,
                        int resultCount, int metricsBytes, int recordsBytes, int payloadBytes)
{
    putU32(out, 0, RESULT_MAGIC);
    putU16(out, 4, RESULT_HEADER_BYTES);
    putU16(out, 6, RESULT_VERSION);
    putI32(out, 8, meta.width);
    putI32(out, 12, meta.height);
    putI32(out, 16, meta.jobId);
    putI32(out, 20, meta.sourceSequence);
    putI64(out, 24, meta.frameNumber);
    putI64(out, 32, meta.timestampNs);
    putI64(out, 40, meta.exposureNs);
    putI64(out, 48, meta.frameDurationNs);
    putI64(out, 56, meta.rollingShutterSkewNs);
    putF32(out, 64, meta.focusDistance);
    putI32(out, 68, meta.iso);
    putI32(out, 72, meta.settingsEpoch);
    putI32(out, 76, meta.orientation);
    putI32(out, 80, meta.pipeline);
    putI32(out, 84, meta.mode);
    putI32(out, 88, resultCount);
    putI32(out, 92, metricsBytes);
    putI32(out, 96, recordsBytes);
    putI32(out, 100, payloadBytes);
}

static jbyteArray toJavaBytes(JNIEnv* env, const std::vector<uint8_t>& bytes)
{
    auto result = env->NewByteArray(static_cast<jsize>(bytes.size()));
    if (!result) return nullptr;
    if (!bytes.empty()) env->SetByteArrayRegion(result, 0, static_cast<jsize>(bytes.size()),
                                                 reinterpret_cast<const jbyte*>(bytes.data()));
    return result;
}

static uint8_t* directPlane(JNIEnv* env, jobject buffer, jint yOffset)
{
    if (!buffer || yOffset < 0) return nullptr;
    auto* base = static_cast<uint8_t*>(env->GetDirectBufferAddress(buffer));
    const jlong capacity = env->GetDirectBufferCapacity(buffer);
    if (!base || capacity <= yOffset) return nullptr;
    return base + yOffset;
}

static PacketMetadata makeMeta(jint width, jint height, jint jobId, jint sourceSequence,
                               jlong frameNumber, jlong timestampNs, jlong exposureNs,
                               jlong frameDurationNs, jlong rollingShutterSkewNs,
                               jfloat focusDistance, jint iso, jint settingsEpoch,
                               jint orientation, jint pipeline, int mode)
{
    PacketMetadata meta;
    meta.width = width;
    meta.height = height;
    meta.jobId = jobId;
    meta.sourceSequence = sourceSequence;
    meta.frameNumber = frameNumber;
    meta.timestampNs = timestampNs;
    meta.exposureNs = exposureNs;
    meta.frameDurationNs = frameDurationNs;
    meta.rollingShutterSkewNs = rollingShutterSkewNs;
    meta.focusDistance = focusDistance;
    meta.iso = iso;
    meta.settingsEpoch = settingsEpoch;
    meta.orientation = orientation;
    meta.pipeline = pipeline;
    meta.mode = mode;
    return meta;
}

static void writeRecord(std::vector<uint8_t>& out, size_t base, int id, int status,
                        int bytesOffset, int bytesLength, int dimension,
                        float x0, float y0, float x1, float y1,
                        float x2, float y2, float x3, float y3)
{
    putI32(out, base, id);
    putI32(out, base + 4, status);
    putI32(out, base + 8, bytesOffset);
    putI32(out, base + 12, bytesLength);
    putI32(out, base + 16, dimension);
    putF32(out, base + 20, x0); putF32(out, base + 24, y0);
    putF32(out, base + 28, x1); putF32(out, base + 32, y1);
    putF32(out, base + 36, x2); putF32(out, base + 40, y2);
    putF32(out, base + 44, x3); putF32(out, base + 48, y3);
}

} // namespace

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_airgapper_app_NativeDecoder_decodeGuided(
        JNIEnv* env, jclass,
        jobject yPlane, jint yOffset, jint width, jint height, jint stride,
        jintArray idsArray, jintArray dimensionsArray, jfloatArray quadsArray,
        jint fallbackMask, jint repairMask,
        jint jobId, jint sourceSequence,
        jlong frameNumber, jlong timestampNs, jlong exposureNs, jlong frameDurationNs,
        jlong rollingShutterSkewNs, jfloat focusDistance, jint iso, jint settingsEpoch,
        jint orientation, jint pipeline)
{
    uint8_t* y = directPlane(env, yPlane, yOffset);
    if (!y || width <= 0 || height <= 0 || stride < width || !idsArray || !dimensionsArray || !quadsArray)
        return nullptr;

    const jsize trackCount = env->GetArrayLength(idsArray);
    if (trackCount <= 0 || env->GetArrayLength(dimensionsArray) != trackCount ||
        env->GetArrayLength(quadsArray) != trackCount * 8)
        return nullptr;

    std::vector<jint> ids(trackCount);
    std::vector<jint> dimensions(trackCount);
    std::vector<jfloat> quads(trackCount * 8);
    env->GetIntArrayRegion(idsArray, 0, trackCount, ids.data());
    env->GetIntArrayRegion(dimensionsArray, 0, trackCount, dimensions.data());
    env->GetFloatArrayRegion(quadsArray, 0, trackCount * 8, quads.data());

    std::vector<AirGapperGuidedTrack> tracks(trackCount);
    for (int i = 0; i < trackCount; ++i) {
        auto& track = tracks[i];
        track = {};
        track.id = ids[i];
        track.dimension = dimensions[i];
        track.x0 = quads[i * 8]; track.y0 = quads[i * 8 + 1];
        track.x1 = quads[i * 8 + 2]; track.y1 = quads[i * 8 + 3];
        track.x2 = quads[i * 8 + 4]; track.y2 = quads[i * 8 + 5];
        track.x3 = quads[i * 8 + 6]; track.y3 = quads[i * 8 + 7];
    }

    std::vector<AirGapperGuidedResult> results(trackCount);
    std::vector<uint8_t> payload(GUIDED_OUTPUT_BYTES);
    AirGapperGuidedMetrics metrics{};
    const int count = decodeGuidedBatchY(
            y, width, height, stride,
            tracks.data(), trackCount,
            results.data(), trackCount,
            payload.data(), static_cast<int>(payload.size()), trackCount,
            static_cast<uint32_t>(fallbackMask), static_cast<uint32_t>(repairMask), &metrics);
    if (count < 0) return nullptr;

    int payloadUsed = 0;
    for (int i = 0; i < count; ++i)
        payloadUsed = std::max(payloadUsed, results[i].bytesOffset + results[i].bytesLength);
    payloadUsed = std::clamp(payloadUsed, 0, static_cast<int>(payload.size()));

    const int recordsBytes = count * RESULT_RECORD_BYTES;
    std::vector<uint8_t> packet(RESULT_HEADER_BYTES + GUIDED_METRICS_BYTES + recordsBytes + payloadUsed);
    const auto meta = makeMeta(width, height, jobId, sourceSequence, frameNumber, timestampNs,
                               exposureNs, frameDurationNs, rollingShutterSkewNs, focusDistance,
                               iso, settingsEpoch, orientation, pipeline, 1);
    writeHeader(packet, meta, count, GUIDED_METRICS_BYTES, recordsBytes, payloadUsed);
    std::memcpy(packet.data() + RESULT_HEADER_BYTES, &metrics, GUIDED_METRICS_BYTES);
    const size_t recordsBase = RESULT_HEADER_BYTES + GUIDED_METRICS_BYTES;
    for (int i = 0; i < count; ++i) {
        const auto& result = results[i];
        writeRecord(packet, recordsBase + size_t(i) * RESULT_RECORD_BYTES,
                    result.id, result.status, result.bytesOffset, result.bytesLength, result.dimension,
                    result.x0, result.y0, result.x1, result.y1,
                    result.x2, result.y2, result.x3, result.y3);
    }
    if (payloadUsed)
        std::memcpy(packet.data() + recordsBase + recordsBytes, payload.data(), payloadUsed);
    return toJavaBytes(env, packet);
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_airgapper_app_NativeDecoder_decodeFull(
        JNIEnv* env, jclass,
        jobject yPlane, jint yOffset, jint width, jint height, jint stride,
        jint cropX, jint cropY, jint cropWidth, jint cropHeight,
        jboolean tryHarder, jboolean tryDownscale, jint maxSymbols, jboolean returnErrors,
        jint jobId, jint sourceSequence,
        jlong frameNumber, jlong timestampNs, jlong exposureNs, jlong frameDurationNs,
        jlong rollingShutterSkewNs, jfloat focusDistance, jint iso, jint settingsEpoch,
        jint orientation, jint pipeline)
{
    uint8_t* y = directPlane(env, yPlane, yOffset);
    if (!y || width <= 0 || height <= 0 || stride < width) return nullptr;
    const int x = std::clamp(static_cast<int>(cropX), 0, std::max(0, static_cast<int>(width) - 1));
    const int yy = std::clamp(static_cast<int>(cropY), 0, std::max(0, static_cast<int>(height) - 1));
    const int w = std::clamp(static_cast<int>(cropWidth), 1, static_cast<int>(width) - x);
    const int h = std::clamp(static_cast<int>(cropHeight), 1, static_cast<int>(height) - yy);
    const uint8_t* crop = y + size_t(yy) * stride + x;

    try {
        ImageView image(crop, w, h, ImageFormat::Lum, stride, 1);
        const auto read = [&](bool downscale, bool errors) {
            auto options = ReaderOptions()
                    .formats(BarcodeFormat::QRCode)
                    .tryHarder(tryHarder == JNI_TRUE)
                    .tryRotate(false)
                    .tryInvert(false)
                    .tryDownscale(downscale)
                    .returnErrors(errors)
                    .maxNumberOfSymbols(std::max(1, static_cast<int>(maxSymbols)));
            return ReadBarcodes(image, options);
        };
        auto barcodes = read(tryDownscale == JNI_TRUE, returnErrors == JNI_TRUE);
        const auto validPayload = [](const auto& barcode) {
            return barcode.isValid() && !barcode.bytes().empty();
        };
        // Match the browser acquisition path: dense full-resolution finder first,
        // then immediately retry the scale pyramid when the dense pass yields no
        // valid AirGapper QR. Native v2 previously omitted this retry entirely.
        if (tryDownscale != JNI_TRUE && std::max(w, h) >= 900 &&
                std::none_of(barcodes.begin(), barcodes.end(), validPayload)) {
            auto fallback = read(true, false);
            if (std::any_of(fallback.begin(), fallback.end(), validPayload))
                barcodes = std::move(fallback);
        }

        const int count = static_cast<int>(barcodes.size());
        int payloadBytes = 0;
        for (const auto& barcode : barcodes) payloadBytes += static_cast<int>(barcode.bytes().size());
        const int recordsBytes = count * RESULT_RECORD_BYTES;
        std::vector<uint8_t> packet(RESULT_HEADER_BYTES + recordsBytes + payloadBytes);
        const auto meta = makeMeta(width, height, jobId, sourceSequence, frameNumber, timestampNs,
                                   exposureNs, frameDurationNs, rollingShutterSkewNs, focusDistance,
                                   iso, settingsEpoch, orientation, pipeline, 0);
        writeHeader(packet, meta, count, 0, recordsBytes, payloadBytes);

        int payloadOffset = 0;
        const size_t payloadBase = RESULT_HEADER_BYTES + recordsBytes;
        for (int i = 0; i < count; ++i) {
            const auto& barcode = barcodes[i];
            const auto position = barcode.position();
            const auto bytes = barcode.bytes();
            const int length = static_cast<int>(bytes.size());
            const int dimension = barcode.symbol().width();
            writeRecord(packet, RESULT_HEADER_BYTES + size_t(i) * RESULT_RECORD_BYTES,
                        -1, barcode.isValid() ? AIRGAPPER_TRACK_OK : AIRGAPPER_TRACK_MISS,
                        payloadOffset, length, dimension,
                        position[0].x + x, position[0].y + yy,
                        position[1].x + x, position[1].y + yy,
                        position[2].x + x, position[2].y + yy,
                        position[3].x + x, position[3].y + yy);
            if (length) {
                std::memcpy(packet.data() + payloadBase + payloadOffset, bytes.data(), length);
                payloadOffset += length;
            }
        }
        return toJavaBytes(env, packet);
    } catch (...) {
        return nullptr;
    }
}
