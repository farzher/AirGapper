from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"replacement not found in {path}: {old[:200]!r}")
    p.write_text(s.replace(old, new, count))


def replace_span(path, start, end, new):
    p = Path(path)
    s = p.read_text()
    a = s.find(start)
    if a < 0:
        raise SystemExit(f"start marker missing in {path}: {start!r}")
    b = s.find(end, a)
    if b < 0:
        raise SystemExit(f"end marker missing in {path}: {end!r}")
    p.write_text(s[:a] + new + s[b:])


# Version/cache.
replace("index.html", "v0.5.195", "v0.5.196")
replace("main.js", 'const APP_BUILD = "v0.5.195";', 'const APP_BUILD = "v0.5.196";')
replace("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.195";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.196";')
replace("sw.js", 'const CACHE = "airgapper-static-js-v157";', 'const CACHE = "airgapper-static-js-v158";')
replace("vendor/decimen-codec/source/VERSION", "0.1.19", "0.1.20")

# ---------------------------------------------------------------------------
# Existing framing has exactly one spare bit in the RaptorQ header. Spend it
# on layoutId, preserving the 5-bit slot field (0..31). Existing layout IDs
# keep their numbers; this lets the same protocol carry 24/32-symbol walls.
# ---------------------------------------------------------------------------
replace("shared/protocol.js", "!fitsBits(h.layoutId, 3) || !fitsBits(h.slotIndex, 5)", "!fitsBits(h.layoutId, 4) || !fitsBits(h.slotIndex, 5)")
replace("shared/protocol.js", "bit = writeBits(out, bit, h.layoutId, 3);", "bit = writeBits(out, bit, h.layoutId, 4);")
replace("shared/protocol.js", "const layout = readBits(bytes, sequence.next, 3);", "const layout = readBits(bytes, sequence.next, 4);")

replace(
    "shared/grid-layout.js",
    '''  { id: 7, cols: 3, rows: 6 }\n];''',
    '''  { id: 7, cols: 3, rows: 6 },\n  { id: 8, cols: 4, rows: 6 },\n  { id: 9, cols: 4, rows: 8 }\n];'''
)

replace(
    "send/main.js",
    '''  return mode === "single" || mode === "one-two" || mode === "two-two" || mode === "two-three" || mode === "three-five" || mode === "three-six" ? mode : "four-three";''',
    '''  return mode === "single" || mode === "one-two" || mode === "two-two" || mode === "two-three" || mode === "three-five" || mode === "three-six" || mode === "four-six" || mode === "four-eight" ? mode : "four-three";'''
)
replace(
    "send/main.js",
    '''    case "three-six":\n      return { cols: 3, rows: 6, codes: 18 };\n    default:''',
    '''    case "three-six":\n      return { cols: 3, rows: 6, codes: 18 };\n    case "four-six":\n      return { cols: 4, rows: 6, codes: 24 };\n    case "four-eight":\n      return { cols: 4, rows: 8, codes: 32 };\n    default:'''
)
replace(
    "index.html",
    '''<option value="three-six">3:6</option></select>''',
    '''<option value="three-six">3:6</option><option value="four-six">4:6 · 24</option><option value="four-eight">4:8 · 32</option></select>'''
)

# Receiver/worker capacities now follow the protocol's 32-slot ceiling. This
# only expands arrays; scheduling behavior for smaller/older walls is unchanged.
replace("receive/worker.js", "const NATIVE_BATCH_MAX_TRACKS = 18;", "const NATIVE_BATCH_MAX_TRACKS = 32;")
replace("receive/main.js", ").slice(0, 18);", ").slice(0, 32);")

# ---------------------------------------------------------------------------
# Guided Turbo: high-pixels/module only.
# Guided is still the compatibility decoder and the teacher. A successful
# distortion-aware sparse sample exports the exact same tiled sample geometry
# into a worker-local module map. Future frames first try raw Y-plane data-only
# sampling using fixed AirGapper QR facts (Model 2, ECC L, mask 4). If CRC fails,
# a small bounded number of cached full-matrix RS retries are allowed; remaining
# slots fall through to the existing Guided path. Old cameras never seed/enter
# Turbo because their measured pixels/module stay below the gate.
# ---------------------------------------------------------------------------
replace(
    "vendor/decimen-codec/source/wrapper/decimen_codec.cpp",
    '#include "qrcode/QRDataBlock.h"\n',
    '#include "qrcode/QRDataBlock.h"\n#include "qrcode/QRDataMask.h"\n'
)

TURBO_HELPERS = r'''
constexpr float GUIDED_TURBO_SEED_MIN_MODULE = 2.95f;
constexpr float GUIDED_TURBO_RUN_MIN_MODULE = 3.05f;
constexpr int GUIDED_TURBO_RS_BUDGET = 4;
constexpr int GUIDED_TURBO_BAD_COOLDOWN = 6;
constexpr int GUIDED_TURBO_AMBIGUOUS = 11;

struct GuidedTurboTrack
{
    int dimension = 0;
    bool seeded = false;
    bool distortionAware = false;
    std::array<PointF, 4> seedQuad{};
    std::vector<PointF> samples;
    uint8_t misses = 0;
    uint8_t cooldown = 0;
};

static std::array<GuidedTurboTrack, 64>& guidedTurboTracks()
{
    static std::array<GuidedTurboTrack, 64> tracks;
    return tracks;
}

static GuidedTurboTrack* guidedTurboTrack(int id)
{
    return id >= 0 && id < int(guidedTurboTracks().size()) ? &guidedTurboTracks()[id] : nullptr;
}

static bool turboSeedEligible(const DecimenGuidedTrack& track)
{
    return guidedTurboTrack(track.id) && guidedModuleSize(track) >= GUIDED_TURBO_SEED_MIN_MODULE;
}

static std::array<PointF, 4> turboTrackQuad(const DecimenGuidedTrack& track)
{
    return {PointF{track.x0, track.y0}, PointF{track.x1, track.y1},
            PointF{track.x2, track.y2}, PointF{track.x3, track.y3}};
}

static std::array<PointF, 4> turboPositionQuad(const Position& pos)
{
    return {PointF(pos[0]), PointF(pos[1]), PointF(pos[2]), PointF(pos[3])};
}

static std::vector<PointF> buildHomographySampleMap(int dim, const Position& pos)
{
    std::vector<PointF> out;
    if (dim <= 0)
        return out;
    PerspectiveTransform map(
        QuadrilateralF{PointF{0, 0}, PointF{double(dim), 0}, PointF{double(dim), double(dim)}, PointF{0, double(dim)}},
        QuadrilateralF{PointF(pos[0]), PointF(pos[1]), PointF(pos[2]), PointF(pos[3])});
    if (!map.isValid())
        return {};
    out.resize(size_t(dim) * dim);
    for (int y = 0; y < dim; ++y)
        for (int x = 0; x < dim; ++x)
            out[size_t(y) * dim + x] = map(centered(PointI{x, y}));
    return out;
}

static bool buildSparseSampleMap(int dim, const PerspectiveTransform& fallback,
                                 Matrix<std::optional<PointF>>& controls,
                                 const std::vector<int>& centers,
                                 std::vector<PointF>& out)
{
    const int W = Size(centers) - 1;
    const int H = W;
    if (dim <= 0 || W <= 0)
        return false;
    for (int y = 0; y <= H; ++y)
        for (int x = 0; x <= W; ++x)
            if (!controls(x, y))
                controls.set(x, y, fallback(centered(PointI(centers[x], centers[y]))));

    out.assign(size_t(dim) * dim, PointF{});
    for (int ry = 0; ry < H; ++ry)
        for (int rx = 0; rx < W; ++rx) {
            const int x0 = centers[rx], x1 = centers[rx + 1];
            const int y0 = centers[ry], y1 = centers[ry + 1];
            const int beginX = rx == 0 ? 0 : x0;
            const int endX = rx == W - 1 ? dim : x1;
            const int beginY = ry == 0 ? 0 : y0;
            const int endY = ry == H - 1 ? dim : y1;
            PerspectiveTransform local{
                Rectangle(x0, x1, y0, y1, 0.5),
                QuadrilateralF{*controls(rx, ry), *controls(rx + 1, ry),
                               *controls(rx + 1, ry + 1), *controls(rx, ry + 1)}};
            if (!local.isValid())
                return false;
            for (int y = beginY; y < endY; ++y)
                for (int x = beginX; x < endX; ++x)
                    out[size_t(y) * dim + x] = local(centered(PointI{x, y}));
        }
    return true;
}

static void seedGuidedTurbo(int id, int dim, const Position& pos,
                            std::vector<PointF>&& samples, bool distortionAware)
{
    auto* cache = guidedTurboTrack(id);
    if (!cache || dim <= 0 || samples.size() != size_t(dim) * dim)
        return;
    cache->dimension = dim;
    cache->seeded = true;
    cache->distortionAware = distortionAware;
    cache->seedQuad = turboPositionQuad(pos);
    cache->samples = std::move(samples);
    cache->misses = 0;
    cache->cooldown = 0;
}

static bool turboPose(const GuidedTurboTrack& cache, const DecimenGuidedTrack& track,
                      float& dx, float& dy, float& residual)
{
    if (!cache.seeded || cache.dimension != track.dimension ||
        cache.samples.size() != size_t(track.dimension) * track.dimension)
        return false;
    const auto current = turboTrackQuad(track);
    std::array<PointF, 4> delta;
    dx = 0;
    dy = 0;
    for (int i = 0; i < 4; ++i) {
        delta[i] = current[i] - cache.seedQuad[i];
        dx += delta[i].x;
        dy += delta[i].y;
    }
    dx *= 0.25f;
    dy *= 0.25f;
    residual = 0;
    for (const auto& d : delta)
        residual = std::max(residual, float(std::hypot(d.x - dx, d.y - dy)));
    const float module = guidedModuleSize(track);
    return residual <= std::max(1.0f, module * 0.48f);
}

static bool turboFinderIdeal(int x, int y)
{
    return x == 0 || x == 6 || y == 0 || y == 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4);
}

struct TurboLevels
{
    int tl = 128, tr = 128, bl = 128;
    int separation = 0;
    int matches = 0;
    bool ok = false;
};

static int turboLum(const uint8_t* yPlane, int width, int height, int stride, PointF p, float dx, float dy)
{
    const int x = int(std::lround(p.x + dx));
    const int y = int(std::lround(p.y + dy));
    return x < 0 || y < 0 || x >= width || y >= height ? -1 : int(yPlane[size_t(y) * stride + x]);
}

static TurboLevels turboReadLevels(const GuidedTurboTrack& cache, const uint8_t* yPlane,
                                   int width, int height, int stride, float dx, float dy)
{
    TurboLevels out;
    const int dim = cache.dimension;
    const PointI starts[3] = {{0, 0}, {dim - 7, 0}, {0, dim - 7}};
    int thresholds[3] = {};
    int minSep = 255;
    int matches = 0;
    for (int finder = 0; finder < 3; ++finder) {
        int blackSum = 0, whiteSum = 0, blackCount = 0, whiteCount = 0;
        int values[49];
        bool expected[49];
        int n = 0;
        for (int my = 0; my < 7; ++my)
            for (int mx = 0; mx < 7; ++mx) {
                const int sx = starts[finder].x + mx;
                const int sy = starts[finder].y + my;
                const int lum = turboLum(yPlane, width, height, stride,
                    cache.samples[size_t(sy) * dim + sx], dx, dy);
                if (lum < 0)
                    return {};
                const bool black = turboFinderIdeal(mx, my);
                values[n] = lum;
                expected[n++] = black;
                if (black) { blackSum += lum; ++blackCount; }
                else { whiteSum += lum; ++whiteCount; }
            }
        const int black = blackSum / std::max(1, blackCount);
        const int white = whiteSum / std::max(1, whiteCount);
        const int sep = white - black;
        if (sep < 26)
            return {};
        minSep = std::min(minSep, sep);
        thresholds[finder] = (black + white) / 2;
        for (int i = 0; i < n; ++i)
            matches += ((values[i] <= thresholds[finder]) == expected[i]);
    }
    out.tl = thresholds[0];
    out.tr = thresholds[1];
    out.bl = thresholds[2];
    out.separation = minSep;
    out.matches = matches;
    out.ok = matches >= 132;
    return out;
}

static int turboThreshold(const TurboLevels& levels, int x, int y, int dim)
{
    const float fx = (x + 0.5f) / dim;
    const float fy = (y + 0.5f) / dim;
    const float t = levels.tl + (levels.tr - levels.tl) * fx + (levels.bl - levels.tl) * fy;
    const int lo = std::min({levels.tl, levels.tr, levels.bl}) - 12;
    const int hi = std::max({levels.tl, levels.tr, levels.bl}) + 12;
    return std::clamp(int(std::lround(t)), lo, hi);
}

static int turboModuleLum(const GuidedTurboTrack& cache, const uint8_t* yPlane,
                          int width, int height, int stride, int x, int y,
                          float dx, float dy, int threshold, float moduleSize)
{
    const PointF p = cache.samples[size_t(y) * cache.dimension + x];
    int lum = turboLum(yPlane, width, height, stride, p, dx, dy);
    if (lum < 0 || moduleSize < 3.35f || std::abs(lum - threshold) > GUIDED_TURBO_AMBIGUOUS)
        return lum;
    const int cx = int(std::lround(p.x + dx));
    const int cy = int(std::lround(p.y + dy));
    if (cx <= 0 || cy <= 0 || cx + 1 >= width || cy + 1 >= height)
        return lum;
    const size_t row = size_t(cy) * stride;
    const int sum = lum * 2 + yPlane[row + cx - 1] + yPlane[row + cx + 1] +
                    yPlane[row - stride + cx] + yPlane[row + stride + cx];
    return sum / 6;
}

static DecoderResult decodeTurboDataOnly(const GuidedTurboTrack& cache, const DecimenGuidedTrack& track,
                                         const uint8_t* yPlane, int width, int height, int stride,
                                         float dx, float dy, const TurboLevels& levels,
                                         DecimenGuidedMetrics& metrics)
{
    const int dim = track.dimension;
    const auto* version = QRCode::Version::Model2((dim - 17) / 4);
    if (!version)
        return {};
    const auto& ecBlocks = version->ecBlocksForLevel(QRCode::ErrorCorrectionLevel::Low);
    std::vector<int> blockSizes;
    int dataCodewords = 0;
    for (const auto& group : ecBlocks.blockArray())
        for (int i = 0; i < group.count; ++i) {
            blockSizes.push_back(group.dataCodewords);
            dataCodewords += group.dataCodewords;
        }
    if (blockSizes.empty() || dataCodewords <= 0)
        return {};

    const double sampleStarted = guidedNowMs();
    const auto functionPattern = version->buildFunctionPattern();
    ByteArray raw;
    raw.reserve(dataCodewords);
    uint8_t currentByte = 0;
    int bitsRead = 0;
    bool readingUp = true;
    const float moduleSize = guidedModuleSize(track);
    bool failed = false;
    for (int x = dim - 1; x > 0 && int(raw.size()) < dataCodewords && !failed; x -= 2) {
        if (x == 6)
            --x;
        for (int row = 0; row < dim && int(raw.size()) < dataCodewords && !failed; ++row) {
            const int y = readingUp ? dim - 1 - row : row;
            for (int col = 0; col < 2 && int(raw.size()) < dataCodewords; ++col) {
                const int xx = x - col;
                if (functionPattern.get(xx, y))
                    continue;
                const int threshold = turboThreshold(levels, xx, y, dim);
                const int lum = turboModuleLum(cache, yPlane, width, height, stride,
                                               xx, y, dx, dy, threshold, moduleSize);
                if (lum < 0) { failed = true; break; }
                const bool black = lum <= threshold;
                const bool bit = QRCode::GetDataMaskBit(4, xx, y) != black;
                currentByte = uint8_t((currentByte << 1) | uint8_t(bit));
                if (++bitsRead % 8 == 0) {
                    raw.push_back(currentByte);
                    currentByte = 0;
                }
            }
        }
        readingUp = !readingUp;
    }
    metrics->sampleMs += guidedNowMs() - sampleStarted;
    if (failed || int(raw.size()) != dataCodewords)
        return {};

    const double decodeStarted = guidedNowMs();
    const int minData = *std::min_element(blockSizes.begin(), blockSizes.end());
    std::vector<ByteArray> blocks(blockSizes.size());
    for (size_t i = 0; i < blocks.size(); ++i)
        blocks[i].resize(blockSizes[i]);
    int offset = 0;
    for (int i = 0; i < minData; ++i)
        for (size_t block = 0; block < blocks.size(); ++block)
            blocks[block][i] = raw[offset++];
    for (size_t block = 0; block < blocks.size(); ++block)
        if (blockSizes[block] > minData)
            blocks[block][minData] = raw[offset++];
    if (offset != dataCodewords)
        return {};
    ByteArray data(dataCodewords);
    auto dst = data.begin();
    for (const auto& block : blocks)
        dst = std::copy(block.begin(), block.end(), dst);
    auto decoded = QRCode::DecodeBitStream(std::move(data), *version, QRCode::ErrorCorrectionLevel::Low);
    metrics->decodeMs += guidedNowMs() - decodeStarted;
    return decoded;
}

static DecoderResult decodeTurboWithRS(const GuidedTurboTrack& cache, const DecimenGuidedTrack& track,
                                       const uint8_t* yPlane, int width, int height, int stride,
                                       float dx, float dy, const TurboLevels& levels,
                                       DecimenGuidedMetrics& metrics)
{
    const int dim = track.dimension;
    const float moduleSize = guidedModuleSize(track);
    const double sampleStarted = guidedNowMs();
    BitMatrix sampled(dim, dim);
    for (int y = 0; y < dim; ++y)
        for (int x = 0; x < dim; ++x) {
            const int threshold = turboThreshold(levels, x, y, dim);
            const int lum = turboModuleLum(cache, yPlane, width, height, stride,
                                           x, y, dx, dy, threshold, moduleSize);
            if (lum < 0)
                return {};
            if (lum <= threshold)
                sampled.set(x, y);
        }
    metrics->sampleMs += guidedNowMs() - sampleStarted;
    const double decodeStarted = guidedNowMs();
    auto decoded = QRCode::Decode(sampled);
    metrics->decodeMs += guidedNowMs() - decodeStarted;
    return decoded;
}

static PointF turboRefineWallOffset(const GuidedTurboTrack& cache, const uint8_t* yPlane,
                                    int width, int height, int stride, float predictedX, float predictedY)
{
    PointF best{predictedX, predictedY};
    int bestScore = -1;
    for (int oy = -2; oy <= 2; ++oy)
        for (int ox = -2; ox <= 2; ++ox) {
            const float dx = predictedX + ox;
            const float dy = predictedY + oy;
            const auto levels = turboReadLevels(cache, yPlane, width, height, stride, dx, dy);
            if (!levels.ok)
                continue;
            const int score = levels.matches * 4 + levels.separation;
            if (score > bestScore) {
                bestScore = score;
                best = PointF{dx, dy};
            }
        }
    return best;
}
'''
replace(
    "vendor/decimen-codec/source/wrapper/decimen_codec.cpp",
    '''static DetectorResult sampleGuidedSparse(const BitMatrix& image,''',
    TURBO_HELPERS + '\nstatic DetectorResult sampleGuidedSparse(const BitMatrix& image,'
)

# Extend sparse sampling so Guided can export the exact tiled module-center map
# it already paid to establish.
replace(
    "vendor/decimen-codec/source/wrapper/decimen_codec.cpp",
    '''                                         const QRCode::FinderPatternSet& fp,\n                                         int* alignmentFoundOut)''',
    '''                                         const QRCode::FinderPatternSet& fp,\n                                         int* alignmentFoundOut,\n                                         std::vector<PointF>* sampleMapOut)'''
)
replace(
    "vendor/decimen-codec/source/wrapper/decimen_codec.cpp",
    '''    if (alignmentFound < 3)\n        return {};\n\n    return SampleGrid(image, dim, dim, base, std::move(controls), centers, centers);''',
    '''    if (alignmentFound < 3)\n        return {};\n\n    if (sampleMapOut && !buildSparseSampleMap(dim, base, controls, centers, *sampleMapOut))\n        sampleMapOut->clear();\n    return SampleGrid(image, dim, dim, base, std::move(controls), centers, centers);'''
)

NEW_GUIDED = r'''extern "C" int decodeGuidedBatchY(const uint8_t* yPlane, int width, int height, int stride,
                                   const DecimenGuidedTrack* tracks, int trackCount,
                                   DecimenGuidedResult* results, int resultCapacity,
                                   uint8_t* output, int outputCapacity, int maxSymbols,
                                   uint32_t fallbackAllowedMask, DecimenGuidedMetrics* metrics)
{
    if (!metrics)
        return -1;
    *metrics = {};
    const double started = guidedNowMs();
    if (!yPlane || !tracks || !results || !output || width <= 0 || height <= 0 || stride < width ||
        trackCount <= 0 || resultCapacity <= 0 || outputCapacity <= 0 || maxSymbols <= 0) {
        metrics->totalMs = guidedNowMs() - started;
        return -1;
    }

    try {
        metrics->tracks = trackCount;
        int resultCount = 0;
        int outputUsed = 0;
        std::vector<uint8_t> completed(trackCount, 0);

        auto commitTurbo = [&](int trackIndex, const DecoderResult& decoded, float correctionX, float correctionY) {
            if (!decoded.isValid() || decoded.content().bytes.empty() || !hasValidCRC32(decoded.content().bytes))
                return false;
            const ByteArray& bytes = decoded.content().bytes;
            if (outputUsed + int(bytes.size()) > outputCapacity ||
                resultCount >= std::min({resultCapacity, maxSymbols, trackCount}))
                return false;
            const auto& track = tracks[trackIndex];
            std::memcpy(output + outputUsed, bytes.data(), bytes.size());
            auto& result = results[resultCount++];
            result = {};
            result.id = track.id;
            result.status = DECIMEN_TRACK_OK;
            result.bytesOffset = outputUsed;
            result.bytesLength = int(bytes.size());
            result.dimension = track.dimension;
            result.x0 = track.x0 + correctionX; result.y0 = track.y0 + correctionY;
            result.x1 = track.x1 + correctionX; result.y1 = track.y1 + correctionY;
            result.x2 = track.x2 + correctionX; result.y2 = track.y2 + correctionY;
            result.x3 = track.x3 + correctionX; result.y3 = track.y3 + correctionY;
            outputUsed += int(bytes.size());
            completed[trackIndex] = 1;
            ++metrics->successful;
            return true;
        };

        // Shared wall motion: use one high-resolution cached QR as the pose
        // anchor, then apply its residual correction to every cached slot. The
        // main lattice supplies the large/slow pose change; this only refines a
        // few pixels of worker-latency/hand-motion drift.
        float wallCorrectionX = 0, wallCorrectionY = 0;
        for (int i = 0; i < trackCount; ++i) {
            auto* cache = guidedTurboTrack(tracks[i].id);
            if (!cache || !cache->seeded || guidedModuleSize(tracks[i]) < GUIDED_TURBO_RUN_MIN_MODULE)
                continue;
            float dx = 0, dy = 0, residual = 0;
            if (!turboPose(*cache, tracks[i], dx, dy, residual))
                continue;
            const PointF refined = turboRefineWallOffset(*cache, yPlane, width, height, stride, dx, dy);
            wallCorrectionX = refined.x - dx;
            wallCorrectionY = refined.y - dy;
            break;
        }

        int rsBudget = GUIDED_TURBO_RS_BUDGET;
        for (int i = 0; i < trackCount; ++i) {
            const auto& track = tracks[i];
            auto* cache = guidedTurboTrack(track.id);
            if (!cache || !cache->seeded || guidedModuleSize(track) < GUIDED_TURBO_RUN_MIN_MODULE)
                continue;
            if (cache->cooldown) {
                --cache->cooldown;
                continue;
            }
            float dx = 0, dy = 0, residual = 0;
            if (!turboPose(*cache, track, dx, dy, residual))
                continue;
            dx += wallCorrectionX;
            dy += wallCorrectionY;
            const auto levels = turboReadLevels(*cache, yPlane, width, height, stride, dx, dy);
            if (!levels.ok)
                continue;

            ++metrics->reserved; // turbo attempts (ABI-reserved field)
            ++metrics->sampleAttempts;
            ++metrics->sparseNoRsAttempts;
            const double turboStarted = guidedNowMs();
            auto decoded = decodeTurboDataOnly(*cache, track, yPlane, width, height, stride,
                                               dx, dy, levels, *metrics);
            bool success = commitTurbo(i, decoded, wallCorrectionX, wallCorrectionY);
            if (success) {
                ++metrics->sparseNoRsSuccesses;
            } else if (rsBudget > 0) {
                --rsBudget;
                ++metrics->sparseRsFallbacks;
                decoded = decodeTurboWithRS(*cache, track, yPlane, width, height, stride,
                                            dx, dy, levels, *metrics);
                success = commitTurbo(i, decoded, wallCorrectionX, wallCorrectionY);
            }
            metrics->fastDecodeMs += guidedNowMs() - turboStarted;
            if (success) {
                ++metrics->reserved2; // turbo successes (ABI-reserved field)
                cache->misses = 0;
                cache->cooldown = 0;
            } else if (++cache->misses >= 2) {
                cache->misses = 0;
                cache->cooldown = GUIDED_TURBO_BAD_COOLDOWN;
            }
        }

        // A clean high-resolution frame can finish here: no HybridBinarizer,
        // finder search, alignment search, generic parser or QR RS at all.
        if (resultCount >= std::min({resultCapacity, maxSymbols, trackCount})) {
            metrics->misses = metrics->tracks - metrics->successful;
            metrics->totalMs = guidedNowMs() - started;
            return resultCount;
        }

        const double binStart = guidedNowMs();
        ImageView iv(const_cast<uint8_t*>(yPlane), width, height, ImageFormat::Lum, stride, 1);
        HybridBinarizer binarized(iv);
        auto bits = binarized.getBitMatrix();
        metrics->binarizeMs = guidedNowMs() - binStart;
        if (!bits) {
            metrics->misses = metrics->tracks - metrics->successful;
            metrics->totalMs = guidedNowMs() - started;
            return resultCount;
        }

        std::vector<int> order;
        order.reserve(trackCount);
        for (int i = 0; i < trackCount; ++i)
            if (!completed[i])
                order.push_back(i);
        const PointF imageCenter{width * 0.5, height * 0.5};
        std::sort(order.begin(), order.end(), [&](int a, int b) {
            auto center = [](const DecimenGuidedTrack& t) {
                return PointF{(t.x0 + t.x1 + t.x2 + t.x3) * 0.25f,
                              (t.y0 + t.y1 + t.y2 + t.y3) * 0.25f};
            };
            const PointF ca = center(tracks[a]);
            const PointF cb = center(tracks[b]);
            return std::hypot(ca.x - imageCenter.x, ca.y - imageCenter.y) <
                   std::hypot(cb.x - imageCenter.x, cb.y - imageCenter.y);
        });

        for (int trackIndex : order) {
            if (resultCount >= std::min({resultCapacity, maxSymbols, trackCount}))
                break;
            const auto& track = tracks[trackIndex];

            QRCode::FinderPatternSet finderSet;
            const double finderStart = guidedNowMs();
            const bool haveFinders = guidedFinderTriplet(*bits, track, finderSet, *metrics);
            metrics->finderMs += guidedNowMs() - finderStart;
            if (!haveFinders)
                continue;

            const double sampleStart = guidedNowMs();
            double decodeSpent = 0;
            bool decodedTrack = false;

            auto commitDecoded = [&](const DetectorResult& detected, const DecoderResult& decoded) {
                if (!detected.isValid() || detected.bits().width() != track.dimension ||
                    !decoded.isValid() || decoded.content().bytes.empty() || !hasValidCRC32(decoded.content().bytes))
                    return false;
                const ByteArray& bytes = decoded.content().bytes;
                if (outputUsed + int(bytes.size()) > outputCapacity)
                    return false;
                std::memcpy(output + outputUsed, bytes.data(), bytes.size());
                const Position pos = detected.position();
                auto& result = results[resultCount++];
                result = {};
                result.id = track.id;
                result.status = DECIMEN_TRACK_OK;
                result.bytesOffset = outputUsed;
                result.bytesLength = int(bytes.size());
                result.dimension = detected.bits().width();
                result.x0 = pos[0].x; result.y0 = pos[0].y;
                result.x1 = pos[1].x; result.y1 = pos[1].y;
                result.x2 = pos[2].x; result.y2 = pos[2].y;
                result.x3 = pos[3].x; result.y3 = pos[3].y;
                outputUsed += int(bytes.size());
                ++metrics->successful;
                return true;
            };

            if (guidedSparseAllowed(track.id)) {
                ++metrics->fastDecodeAttempts;
                std::vector<PointF> sparseMap;
                auto* mapOut = turboSeedEligible(track) ? &sparseMap : nullptr;
                auto sparse = sampleGuidedSparse(*bits, track, finderSet, nullptr, mapOut);
                if (sparse.isValid() && sparse.bits().width() == track.dimension) {
                    metrics->sampleAttempts++;
                    const double fastStart = guidedNowMs();
                    ++metrics->sparseRsFallbacks;
                    auto decoded = QRCode::Decode(sparse.bits());
                    decodedTrack = commitDecoded(sparse, decoded);
                    const double fastElapsed = guidedNowMs() - fastStart;
                    metrics->fastDecodeMs += fastElapsed;
                    metrics->decodeMs += fastElapsed;
                    decodeSpent += fastElapsed;
                    if (decodedTrack) {
                        ++metrics->fastDecodeSuccesses;
                        if (track.id >= 0 && track.id < 32)
                            metrics->sparseSuccessMask |= uint32_t(1) << track.id;
                        if (mapOut) {
                            if (sparseMap.empty())
                                sparseMap = buildHomographySampleMap(track.dimension, sparse.position());
                            seedGuidedTurbo(track.id, track.dimension, sparse.position(), std::move(sparseMap), true);
                        }
                    }
                }
                noteGuidedSparseOutcome(track.id, decodedTrack);
            } else {
                ++metrics->sparseSkipped;
            }

            if (!decodedTrack) {
                const bool fallbackAllowed = track.id < 0 || track.id >= 32 ||
                    (fallbackAllowedMask & (uint32_t(1) << track.id)) != 0;
                if (!fallbackAllowed) {
                    ++metrics->genericFallbackSkipped;
                } else {
                    ++metrics->genericFallbackTracks;
                    if (track.id >= 0 && track.id < 32)
                        metrics->fallbackAttemptMask |= uint32_t(1) << track.id;
                    for (auto&& detected : QRCode::SampleQR(*bits, finderSet)) {
                        metrics->sampleAttempts++;
                        if (!detected.isValid() || detected.bits().width() != track.dimension)
                            continue;
                        ++metrics->genericDecodeAttempts;
                        const double genericStart = guidedNowMs();
                        auto decoded = QRCode::Decode(detected.bits());
                        const double genericElapsed = guidedNowMs() - genericStart;
                        metrics->genericDecodeMs += genericElapsed;
                        metrics->decodeMs += genericElapsed;
                        decodeSpent += genericElapsed;
                        if (commitDecoded(detected, decoded)) {
                            decodedTrack = true;
                            ++metrics->genericFallbackSuccesses;
                            if (track.id >= 0 && track.id < 32)
                                metrics->fallbackSuccessMask |= uint32_t(1) << track.id;
                            if (turboSeedEligible(track)) {
                                auto map = buildHomographySampleMap(track.dimension, detected.position());
                                seedGuidedTurbo(track.id, track.dimension, detected.position(), std::move(map), false);
                            }
                            break;
                        }
                    }
                }
            }
            metrics->sampleMs += std::max(0.0, guidedNowMs() - sampleStart - decodeSpent);
        }
        metrics->misses = metrics->tracks - metrics->successful;
        metrics->totalMs = guidedNowMs() - started;
        return resultCount;
    } catch (...) {
        metrics->misses = metrics->tracks - metrics->successful;
        metrics->totalMs = guidedNowMs() - started;
        return -1;
    }
}

'''
replace_span(
    "vendor/decimen-codec/source/wrapper/decimen_codec.cpp",
    'extern "C" int decodeGuidedBatchY(',
    '/** How well the three finder patterns match at a candidate offset:',
    NEW_GUIDED
)

# Worker reads the two ABI-reserved counters and labels frames by the cheapest
# path actually used. On old cameras turboAttempts stays zero.
replace(
    "receive/worker.js",
    '''    sparseSkipped: metricsView.getUint32(120, true),\n    fallbackAttemptMask:''',
    '''    sparseSkipped: metricsView.getUint32(120, true),\n    turboAttempts: metricsView.getUint32(124, true),\n    fallbackAttemptMask:'''
)
replace(
    "receive/worker.js",
    '''    sparseSuccessMask: metricsView.getUint32(136, true)\n  };''',
    '''    sparseSuccessMask: metricsView.getUint32(136, true),\n    turboSuccesses: metricsView.getUint32(140, true)\n  };'''
)
replace(
    "receive/worker.js",
    '''          guidedAssistTracks: tracks.length,\n          pixelPath: "y8-guided",''',
    '''          guidedAssistTracks: Math.max(0, tracks.length - (guided?.metrics?.turboSuccesses ?? 0)),\n          pixelPath: guided?.metrics?.turboSuccesses === tracks.length\n            ? "y8-turbo"\n            : guided?.metrics?.turboSuccesses\n              ? "y8-turbo+guided"\n              : "y8-guided",'''
)

# Main diagnostics: make Turbo effectiveness and data-only success visible.
replace(
    "receive/main.js",
    '''  guidedSparseSkipped: 0,\n  guidedJobs:''',
    '''  guidedSparseSkipped: 0,\n  guidedTurboAttempts: 0,\n  guidedTurboSuccesses: 0,\n  guidedJobs:'''
)
replace(
    "receive/main.js",
    '''    guidedSparseNoRsAttempts: 0, guidedSparseNoRsSuccesses: 0, guidedSparseRsFallbacks: 0, guidedSparseSkipped: 0,\n    guidedJobs:''',
    '''    guidedSparseNoRsAttempts: 0, guidedSparseNoRsSuccesses: 0, guidedSparseRsFallbacks: 0, guidedSparseSkipped: 0,\n    guidedTurboAttempts: 0, guidedTurboSuccesses: 0,\n    guidedJobs:'''
)
replace(
    "receive/main.js",
    '''      livePipeline.guidedSparseSkipped += Math.max(0, Number(guided.sparseSkipped) || 0);\n      livePipeline.guidedFinderAttempts''',
    '''      livePipeline.guidedSparseSkipped += Math.max(0, Number(guided.sparseSkipped) || 0);\n      livePipeline.guidedTurboAttempts += Math.max(0, Number(guided.turboAttempts) || 0);\n      livePipeline.guidedTurboSuccesses += Math.max(0, Number(guided.turboSuccesses) || 0);\n      livePipeline.guidedFinderAttempts'''
)
replace(
    "receive/main.js",
    '''Guided  ${guidedRollout.state} · ${livePipeline.guidedJobs} jobs · ${livePipeline.guidedOutputs} outputs · finders''',
    '''Guided  ${guidedRollout.state} · ${livePipeline.guidedJobs} jobs · ${livePipeline.guidedOutputs} outputs · turbo ${livePipeline.guidedTurboSuccesses}/${livePipeline.guidedTurboAttempts} · finders'''
)

# The diagnostics comment was tied to 18 slots; acquisition itself is generic.
replace(
    "receive/main.js",
    '''    // A dense 18-QR wall can present 54 finder patterns to the generic\n    // detector.''',
    '''    // A dense wall can present dozens of finder patterns to the generic\n    // detector.'''
)
