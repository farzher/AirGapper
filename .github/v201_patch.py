from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"replacement not found in {path}: {old[:220]!r}")
    p.write_text(s.replace(old, new, count))

# Version/cache.
replace("index.html", "v0.5.200", "v0.5.201")
replace("main.js", 'const APP_BUILD = "v0.5.200";', 'const APP_BUILD = "v0.5.201";')
replace("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.200";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.201";')
replace("sw.js", 'const CACHE = "airgapper-static-js-v162";', 'const CACHE = "airgapper-static-js-v163";')
replace("vendor/decimen-codec/source/VERSION", "0.1.23", "0.1.24")

cpp = Path("vendor/decimen-codec/source/wrapper/decimen_codec.cpp")
s = cpp.read_text()

# Direct access to the same QR RS primitive used by QRDecoder, without paying
# BitMatrix/format/version/parser overhead for a wall whose QR parameters are fixed.
s = s.replace('#include "DecoderResult.h"\n', '#include "DecoderResult.h"\n#include "ReedSolomon.h"\n', 1)

old = '''struct GuidedTurboAdaptive\n{\n    int seedId = -1;\n    int canaryAttempts = 0;\n    int canarySuccesses = 0;\n    int promotedAttempts = 0;\n    int promotedSuccesses = 0;\n    int cooldown = 0;\n    bool promoted = false;\n};'''
new = '''struct GuidedTurboAdaptive\n{\n    int seedId = -1;\n    int canaryAttempts = 0;\n    int canarySuccesses = 0;\n    int canaryDirectSuccesses = 0;\n    int canaryStableEligible = 0;\n    int promotedAttempts = 0;\n    int promotedSuccesses = 0;\n    int cooldown = 0;\n    bool promoted = false;\n    bool rsMode = false;\n};'''
if old not in s:
    raise SystemExit('GuidedTurboAdaptive block missing')
s = s.replace(old, new, 1)

old = '''    adaptive.canaryAttempts = 0;\n    adaptive.canarySuccesses = 0;\n    adaptive.promotedAttempts = 0;\n    adaptive.promotedSuccesses = 0;\n    adaptive.promoted = false;'''
new = '''    adaptive.canaryAttempts = 0;\n    adaptive.canarySuccesses = 0;\n    adaptive.canaryDirectSuccesses = 0;\n    adaptive.canaryStableEligible = 0;\n    adaptive.promotedAttempts = 0;\n    adaptive.promotedSuccesses = 0;\n    adaptive.promoted = false;\n    adaptive.rsMode = false;'''
if old not in s:
    raise SystemExit('coolLowDensityTurbo reset block missing')
s = s.replace(old, new, 1)

# Strict gate for the stable-only rigid cached map. The projective Turbo path
# remains available for moving phones; this path is deliberately only the fast
# upper bound when the calibrated distortion map still has the same shape.
marker = '''static PerspectiveTransform turboFrameTransform(const GuidedTurboTrack& cache,\n                                                const DecimenGuidedTrack& track)'''
insert = r'''static bool turboStableRigidEligible(const GuidedTurboTrack& cache,
                                      const DecimenGuidedTrack& track, float residual)
{
    if (!cache.distortionAware)
        return false;
    const float module = guidedModuleSize(track);
    return module >= GUIDED_TURBO_CANARY_MIN_MODULE &&
           residual <= std::max(0.65f, module * 0.24f);
}

'''
if marker not in s:
    raise SystemExit('turboFrameTransform marker missing')
s = s.replace(marker, insert + marker, 1)

# Add the stable rigid finder threshold/refinement and direct-codeword RS decoder
# after the generic cached full-matrix fallback. This sampler touches only QR
# codeword modules and uses one bilinear Y sample per module. RS, not 5-point
# ambiguity voting, supplies error tolerance.
marker = '''static PointF turboRefineWallOffset(const GuidedTurboTrack& cache, const DecimenGuidedTrack& track,'''
new_helpers = r'''static TurboLevels turboReadLevelsRigid(const GuidedTurboTrack& cache,
                                         const uint8_t* yPlane, int width, int height, int stride,
                                         float dx, float dy)
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
                const PointF p = cache.samples[size_t(sy) * dim + sx];
                const int lum = turboLum(yPlane, width, height, stride, p, dx, dy);
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

static PointF turboRefineRigidOffset(const GuidedTurboTrack& cache,
                                     const uint8_t* yPlane, int width, int height, int stride,
                                     float predictedX, float predictedY)
{
    PointF best{predictedX, predictedY};
    int bestScore = -1;
    for (int oy = -2; oy <= 2; ++oy)
        for (int ox = -2; ox <= 2; ++ox) {
            const float dx = predictedX + ox;
            const float dy = predictedY + oy;
            const auto levels = turboReadLevelsRigid(cache, yPlane, width, height, stride, dx, dy);
            if (!levels.ok)
                continue;
            const int score = levels.matches * 4 + levels.separation;
            if (score > bestScore) {
                bestScore = score;
                best = PointF{dx, dy};
            }
        }
    const PointF coarse = best;
    for (int hy = -1; hy <= 1; ++hy)
        for (int hx = -1; hx <= 1; ++hx) {
            const float dx = coarse.x + hx * 0.5f;
            const float dy = coarse.y + hy * 0.5f;
            const auto levels = turboReadLevelsRigid(cache, yPlane, width, height, stride, dx, dy);
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

static DecoderResult decodeTurboStableRS(const GuidedTurboTrack& cache,
                                         const DecimenGuidedTrack& track,
                                         const uint8_t* yPlane, int width, int height, int stride,
                                         float dx, float dy, const TurboLevels& levels,
                                         DecimenGuidedMetrics& metrics)
{
    const int dim = track.dimension;
    const auto* version = QRCode::Version::Model2((dim - 17) / 4);
    if (!version)
        return {};
    const int totalCodewords = version->totalCodewords();
    if (totalCodewords <= 0)
        return {};

    const double sampleStarted = guidedNowMs();
    const auto functionPattern = version->buildFunctionPattern();
    ByteArray raw;
    raw.reserve(totalCodewords);
    uint8_t currentByte = 0;
    int bitsRead = 0;
    bool readingUp = true;
    bool failed = false;
    for (int x = dim - 1; x > 0 && int(raw.size()) < totalCodewords && !failed; x -= 2) {
        if (x == 6)
            --x;
        for (int row = 0; row < dim && int(raw.size()) < totalCodewords && !failed; ++row) {
            const int y = readingUp ? dim - 1 - row : row;
            for (int col = 0; col < 2 && int(raw.size()) < totalCodewords; ++col) {
                const int xx = x - col;
                if (functionPattern.get(xx, y))
                    continue;
                const int threshold = turboThreshold(levels, xx, y, dim);
                const PointF p = cache.samples[size_t(y) * dim + xx];
                const int lum = turboLum(yPlane, width, height, stride, p, dx, dy);
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
    metrics.sampleMs += guidedNowMs() - sampleStarted;
    if (failed || int(raw.size()) != totalCodewords)
        return {};

    const double decodeStarted = guidedNowMs();
    auto blocks = QRCode::DataBlock::GetDataBlocks(raw, *version, QRCode::ErrorCorrectionLevel::Low);
    if (blocks.empty()) {
        metrics.decodeMs += guidedNowMs() - decodeStarted;
        return {};
    }
    int dataBytes = 0;
    for (const auto& block : blocks)
        dataBytes += block.numDataCodewords();
    ByteArray data(dataBytes);
    auto dst = data.begin();
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
    auto decoded = QRCode::DecodeBitStream(std::move(data), *version, QRCode::ErrorCorrectionLevel::Low);
    metrics.decodeMs += guidedNowMs() - decodeStarted;
    return decoded;
}

'''
if marker not in s:
    raise SystemExit('turboRefineWallOffset marker missing')
s = s.replace(marker, new_helpers + marker, 1)

# Replace the old generic-RS budget rollout with a two-mode Turbo:
# - direct mode after strong no-RS evidence;
# - stable-RS mode after the rigid cached codeword path proves >=5/8 canaries.
# During probation only one slot participates, so non-stable phones pay at most
# one experimental QR per job and fall back to Guided immediately.
old_start = s.find('        int rsBudget = GUIDED_TURBO_RS_BUDGET;\n        for (int i = 0; i < trackCount; ++i) {')
old_end = s.find('\n        // A clean high-resolution frame can finish here:', old_start)
if old_start < 0 or old_end < 0:
    raise SystemExit('Turbo loop span missing')
new_loop = r'''        // Stable-RS uses the calibrated distortion map as-is plus a single
        // shared residual translation. It is enabled only when the live quad is
        // still rigidly consistent with that map; handheld/projective motion stays
        // on the existing projective direct canary + Guided recovery chain.
        float stableResidualX = 0, stableResidualY = 0;
        bool stableReference = false;
        for (int i = 0; i < trackCount; ++i) {
            auto* cache = guidedTurboTrack(tracks[i].id);
            if (!cache || !cache->seeded || !turboAllowed(i))
                continue;
            float poseX = 0, poseY = 0, residual = 0;
            if (!turboPose(*cache, tracks[i], poseX, poseY, residual) ||
                !turboStableRigidEligible(*cache, tracks[i], residual))
                continue;
            const PointF refined = turboRefineRigidOffset(*cache, yPlane, width, height, stride, poseX, poseY);
            stableResidualX = refined.x - poseX;
            stableResidualY = refined.y - poseY;
            stableReference = true;
            break;
        }

        for (int i = 0; i < trackCount; ++i) {
            const auto& track = tracks[i];
            auto* cache = guidedTurboTrack(track.id);
            if (!cache || !cache->seeded || !turboAllowed(i))
                continue;
            if (cache->cooldown) {
                --cache->cooldown;
                continue;
            }
            float poseX = 0, poseY = 0, residual = 0;
            if (!turboPose(*cache, track, poseX, poseY, residual))
                continue;
            const bool stableEligible = stableReference && turboStableRigidEligible(*cache, track, residual);
            const bool directMode = !turboAdaptive.promoted || !turboAdaptive.rsMode;

            ++metrics->reserved; // Turbo attempts (ABI-reserved field)
            const double turboStarted = guidedNowMs();
            bool success = false;
            bool directSuccess = false;
            bool stableRsAttempted = false;

            if (directMode) {
                const auto frameTransform = turboFrameTransform(*cache, track);
                if (frameTransform.isValid()) {
                    const float dx = wallCorrectionX;
                    const float dy = wallCorrectionY;
                    const auto levels = turboReadLevels(*cache, track, frameTransform,
                                                        yPlane, width, height, stride, dx, dy);
                    if (levels.ok) {
                        ++metrics->sampleAttempts;
                        ++metrics->sparseNoRsAttempts;
                        auto decoded = decodeTurboDataOnly(*cache, track, frameTransform,
                                                           yPlane, width, height, stride,
                                                           dx, dy, levels, *metrics);
                        directSuccess = commitTurbo(i, decoded, wallCorrectionX, wallCorrectionY);
                        success = directSuccess;
                        if (directSuccess)
                            ++metrics->sparseNoRsSuccesses;
                    }
                }
            }

            // In probation this is one QR/job. Once stable-RS has proven itself,
            // it becomes the primary full-wall path and avoids the duplicate
            // data-only sampling entirely.
            if (!success && stableEligible && (!turboAdaptive.promoted || turboAdaptive.rsMode)) {
                const float dx = poseX + stableResidualX;
                const float dy = poseY + stableResidualY;
                const auto levels = turboReadLevelsRigid(*cache, yPlane, width, height, stride, dx, dy);
                if (levels.ok) {
                    stableRsAttempted = true;
                    ++metrics->sampleAttempts;
                    ++metrics->sparseRsFallbacks;
                    auto decoded = decodeTurboStableRS(*cache, track, yPlane, width, height, stride,
                                                       dx, dy, levels, *metrics);
                    success = commitTurbo(i, decoded, dx, dy);
                }
            }

            metrics->fastDecodeMs += guidedNowMs() - turboStarted;
            if (success) {
                ++metrics->reserved2; // Turbo successes (ABI-reserved field)
                cache->misses = 0;
                cache->cooldown = 0;
            } else if (++cache->misses >= 2) {
                cache->misses = 0;
                cache->cooldown = GUIDED_TURBO_BAD_COOLDOWN;
            }

            if (!turboAdaptive.promoted) {
                ++turboAdaptive.canaryAttempts;
                turboAdaptive.canarySuccesses += int(success);
                turboAdaptive.canaryDirectSuccesses += int(directSuccess);
                turboAdaptive.canaryStableEligible += int(stableEligible);

                const bool directEarly = turboAdaptive.canaryAttempts >= 4 &&
                                         turboAdaptive.canaryDirectSuccesses == turboAdaptive.canaryAttempts;
                if (directEarly) {
                    turboAdaptive.promoted = true;
                    turboAdaptive.rsMode = false;
                } else if (turboAdaptive.canaryAttempts >= 8) {
                    const bool directWin = turboAdaptive.canaryDirectSuccesses * 4 >=
                                           turboAdaptive.canaryAttempts * 3;
                    const bool stableRsWin = turboAdaptive.canaryStableEligible >= 6 &&
                                             turboAdaptive.canarySuccesses * 8 >=
                                             turboAdaptive.canaryAttempts * 5;
                    if (directWin || stableRsWin) {
                        turboAdaptive.promoted = true;
                        turboAdaptive.rsMode = !directWin;
                    } else {
                        coolLowDensityTurbo();
                    }
                }
                if (turboAdaptive.promoted) {
                    turboAdaptive.canaryAttempts = 0;
                    turboAdaptive.canarySuccesses = 0;
                    turboAdaptive.canaryDirectSuccesses = 0;
                    turboAdaptive.canaryStableEligible = 0;
                    turboAdaptive.promotedAttempts = 0;
                    turboAdaptive.promotedSuccesses = 0;
                }
            } else {
                ++turboAdaptive.promotedAttempts;
                turboAdaptive.promotedSuccesses += int(success);
                if (turboAdaptive.promotedAttempts >= 36) {
                    // Full-wall Turbo must clear at least half of attempted slots
                    // to repay itself versus going straight to Guided.
                    if (turboAdaptive.promotedSuccesses * 2 < turboAdaptive.promotedAttempts)
                        coolLowDensityTurbo();
                    else {
                        turboAdaptive.promotedAttempts = 0;
                        turboAdaptive.promotedSuccesses = 0;
                    }
                }
            }
        }
'''
s = s[:old_start] + new_loop + s[old_end:]

cpp.write_text(s)
