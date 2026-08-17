/*
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (c) 2026 Evan Crawley (Bash Alarmist)
 *
 * Decimen-specific zxing-cpp WASM wrapper.
 *
 * Two decode paths:
 *
 *  readFull — stock acquisition through the public ReadBarcodes API, QR-only,
 *  with the sweeps a closed system never needs (invert, rotate) hard-off.
 *  Returns every symbol's bytes AND its position quad; error results ride
 *  along (position only) so the receiver can aim crops at codes that
 *  detected but failed ECC.
 *
 *  readTracked — the Decimen fast path. The receiver already knows where a
 *  code is (last decode's quad) and how big it is (module count), so
 *  detection — the expensive half of every decode — is skipped entirely:
 *  rebuild the module→pixel homography from the cached quad, binarize,
 *  sample the grid, Reed–Solomon decode. Sender screens are flat, so a
 *  single homography is exact up to lens distortion; zxing-cpp itself falls
 *  back to the plain projection when alignment fitting fails, for the same
 *  reason (see GridSampler.cpp). Any failure here is cheap and the caller
 *  falls back to readFull, which also re-anchors the quad.
 *
 * The quad convention matches GridSampler exactly: the reported position IS
 * mod2Pix applied to {0,0},{dim,0},{dim,dim},{0,dim}, so feeding a previous
 * result's position back in reconstructs the sampling transform.
 */

#include <array>
#include "ReadBarcode.h"
#include "ConcentricFinder.h"
#include "Matrix.h"
#include "Quadrilateral.h"
#include "RegressionLine.h"
#include "HybridBinarizer.h"
#include "GridSampler.h"
#include "PerspectiveTransform.h"
#include "DecoderResult.h"
#include "ReedSolomon.h"
#include "DetectorResult.h"
#include "Content.h"
#include "qrcode/QRDecoder.h"
#include "qrcode/QRDetector.h"
#include "qrcode/QRBitMatrixParser.h"
#include "qrcode/QRDataBlock.h"
#include "qrcode/QRDataMask.h"
#include "qrcode/QRFormatInformation.h"
#include "qrcode/QRVersion.h"
#include "ByteArray.h"
#include "decimen_codec.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <memory>
#include <optional>

#include <emscripten.h>
#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <string>
#include <vector>

using namespace ZXing;

static_assert(sizeof(DecimenGuidedTrack) == 40,
              "DecimenGuidedTrack JS ABI must use 40-byte records");
static_assert(sizeof(DecimenGuidedResult) == 52,
              "DecimenGuidedResult JS ABI must use 52-byte records");
static_assert(sizeof(DecimenGuidedMetrics) == 160,
              "DecimenGuidedMetrics JS ABI must allocate 160 bytes");
static_assert(offsetof(DecimenGuidedMetrics, turboAttempts) == 124,
              "DecimenGuidedMetrics turboAttempts JS offset changed");
static_assert(offsetof(DecimenGuidedMetrics, turboSuccesses) == 140,
              "DecimenGuidedMetrics turboSuccesses JS offset changed");
static_assert(offsetof(DecimenGuidedMetrics, stableRsAttempts) == 144,
              "DecimenGuidedMetrics stableRsAttempts JS offset changed");
static_assert(offsetof(DecimenGuidedMetrics, stableEligibleTracks) == 152,
              "DecimenGuidedMetrics stableEligibleTracks JS offset changed");

namespace ZXing::QRCode {
DecoderResult DecodeBitStream(ByteArray&& bytes, const Version& version, ErrorCorrectionLevel ecLevel);
}

// Stamped by the build (CMake definitions fed from build.sh, whose version
// source of truth is package.json). The defaults only appear in by-hand
// compiles.
#ifndef DECIMEN_CODEC_VERSION
#define DECIMEN_CODEC_VERSION "0.0.0-dev"
#endif
#ifndef DECIMEN_CODEC_BUILD
#define DECIMEN_CODEC_BUILD "dev"
#endif

/** Which build is this? version() is the package.json version; build() is
 *  the git short hash, "-dirty" when built from an uncommitted tree. */
static std::string codecVersion() { return DECIMEN_CODEC_VERSION; }
static std::string codecBuild() { return DECIMEN_CODEC_BUILD; }

struct DecimenResult
{
	bool valid{};
	std::string error{};
	emscripten::val bytes;
	Position position{};
	/** Symbol dimension in modules (17 + 4·version). The receiver feeds this
	 *  back into readTracked; 0 when unknown (errors, non-QR). */
	int modules{};
};

/** RGBA → packed luminance. HybridBinarizer's block averaging assumes a
 *  single-channel plane; feeding it raw RGBA shifts the whole binarized
 *  matrix (~36 px on a 400 px image — found the hard way). ReadBarcode.cpp
 *  does this exact extraction internally (SetupLumImageView); the tracked
 *  path has to do it for itself. */
static std::vector<uint8_t> toLum(const ImageView& iv)
{
	std::vector<uint8_t> lum(iv.width() * iv.height());
	auto* dst = lum.data();
	for (int y = 0; y < iv.height(); y++) {
		const uint8_t* src = iv.data(0, y);
		for (int x = 0; x < iv.width(); x++, src += 4)
			*dst++ = RGBToLum(src[0], src[1], src[2]);
	}
	return lum;
}

static emscripten::val toUint8Array(const std::vector<uint8_t>& bytes)
{
	thread_local const emscripten::val Uint8Array = emscripten::val::global("Uint8Array");
	// Uint8Array.new_ COPIES out of the wasm heap synchronously, so the view
	// over a local ByteArray is safe.
	return Uint8Array.new_(emscripten::typed_memory_view(bytes.size(), bytes.data()));
}

std::vector<DecimenResult> readFull(int bufferPtr, int width, int height, bool tryHarder, int maxSymbols,
									bool returnErrors)
{
	try {
		ImageView iv(reinterpret_cast<uint8_t*>(bufferPtr), width, height, ImageFormat::RGBA);
		auto opts = ReaderOptions()
						.formats(BarcodeFormat::QRCode)
						.tryHarder(tryHarder)
						.tryRotate(false)
						.tryInvert(false)
						.tryDownscale(tryHarder)
						.returnErrors(returnErrors)
						.maxNumberOfSymbols(maxSymbols);

		auto barcodes = ReadBarcodes(iv, opts);

		std::vector<DecimenResult> results;
		results.reserve(barcodes.size());
		for (auto&& barcode : barcodes) {
			// symbol() is the sampled module matrix — its width IS the QR
			// dimension. (Barcode::version() would give the same number via
			// extra(), but that call links ~290 KB of metadata machinery.)
			results.push_back({barcode.isValid(), ToString(barcode.error()), toUint8Array(barcode.bytes()),
							   barcode.position(), barcode.symbol().width()});
		}
		return results;
	} catch (const std::exception& e) {
		return {{false, e.what(), {}, {}}};
	} catch (...) {
		return {{false, "unknown error", {}, {}}};
	}
}

static std::vector<DecimenResult> readFullYWithOptions(int bufferPtr, int width, int height, int stride,
                                                    bool tryHarder, bool tryDownscale,
                                                    int maxSymbols, bool returnErrors)
{
    try {
        ImageView iv(reinterpret_cast<uint8_t*>(bufferPtr), width, height, ImageFormat::Lum, stride, 1);
        auto opts = ReaderOptions()
                        .formats(BarcodeFormat::QRCode)
                        .tryHarder(tryHarder)
                        .tryRotate(false)
                        .tryInvert(false)
                        .tryDownscale(tryDownscale)
                        .returnErrors(returnErrors)
                        .maxNumberOfSymbols(maxSymbols);
        auto barcodes = ReadBarcodes(iv, opts);
        std::vector<DecimenResult> results;
        results.reserve(barcodes.size());
        for (auto&& barcode : barcodes)
            results.push_back({barcode.isValid(), ToString(barcode.error()), toUint8Array(barcode.bytes()),
                               barcode.position(), barcode.symbol().width()});
        return results;
    } catch (const std::exception& e) {
        return {{false, e.what(), {}, {}}};
    } catch (...) {
        return {{false, "unknown error", {}, {}}};
    }
}

std::vector<DecimenResult> readFullY(int bufferPtr, int width, int height, int stride, bool tryHarder,
                                    int maxSymbols, bool returnErrors)
{
    return readFullYWithOptions(bufferPtr, width, height, stride, tryHarder, tryHarder, maxSymbols, returnErrors);
}

// Dense tracked AirGapper walls need tryHarder's 3-row QR finder stride for
// v40 symbols, but not ReadBarcodes' image pyramid. With maxSymbols=18 the
// generic API otherwise keeps scanning 1/3 and 1/9 scale copies whenever the
// full-resolution pass finds fewer than all 18 symbols. Those copies cannot
// preserve enough pixels/module for our dense v40 wall and only burn CPU.
std::vector<DecimenResult> readDenseY(int bufferPtr, int width, int height, int stride, int maxSymbols)
{
    return readFullYWithOptions(bufferPtr, width, height, stride, true, false, maxSymbols, false);
}


namespace {

constexpr auto GUIDED_QR_FINDER = FixedPattern<5, 7>{1, 1, 3, 1, 1};

static double guidedNowMs()
{
    return emscripten_get_now();
}

// Defined by the persistent decoder below. Guided decoding uses the exact
// current-frame BitMatrix produced by SampleQR, so the cheap no-RS parser is
// safe to try here without reviving any cached/stale module-map machinery.
static DecoderResult decodeWithoutErrorCorrection(const BitMatrix& bits);
static bool hasValidCRC32(const ByteArray& bytes);

static float guidedModuleSize(const DecimenGuidedTrack& track)
{
    const auto edge = [](float ax, float ay, float bx, float by) {
        return std::hypot(bx - ax, by - ay);
    };
    const float shortest = std::min({
        edge(track.x0, track.y0, track.x1, track.y1),
        edge(track.x1, track.y1, track.x2, track.y2),
        edge(track.x2, track.y2, track.x3, track.y3),
        edge(track.x3, track.y3, track.x0, track.y0)
    });
    return shortest / std::max(1, track.dimension);
}

static std::optional<ConcentricPattern> locateGuidedFinder(const BitMatrix& image, PointF predicted,
                                                            float moduleSize, int maxRing,
                                                            DecimenGuidedMetrics& metrics)
{
    const int width = std::max(12, int(std::lround(moduleSize * 14.0f)));
    const float step = std::max(1.0f, moduleSize * 1.25f);
    for (int ring = 0; ring <= maxRing; ++ring) {
        for (int gy = -ring; gy <= ring; ++gy) {
            for (int gx = -ring; gx <= ring; ++gx) {
                if (ring && std::max(std::abs(gx), std::abs(gy)) != ring)
                    continue;
                PointF candidate = predicted + PointF{gx * step, gy * step};
                if (!image.isIn(candidate) || !image.get(candidate))
                    continue;
                metrics.finderAttempts++;
                if (auto found = LocateConcentricPattern<true>(image, GUIDED_QR_FINDER, candidate, width)) {
                    metrics.finderSuccesses++;
                    return found;
                }
            }
        }
    }
    return std::nullopt;
}

static bool guidedFinderTriplet(const BitMatrix& image, const DecimenGuidedTrack& track,
                                QRCode::FinderPatternSet& out, DecimenGuidedMetrics& metrics)
{
    const int dim = track.dimension;
    if (dim < 21 || dim > 177 || ((dim - 17) & 3))
        return false;
    const float moduleSize = guidedModuleSize(track);
    if (!(moduleSize >= 1.0f && moduleSize < 32.0f))
        return false;

    PerspectiveTransform mod2Pix(
        QuadrilateralF{PointF{0, 0}, PointF{double(dim), 0}, PointF{double(dim), double(dim)}, PointF{0, double(dim)}},
        QuadrilateralF{PointF{track.x0, track.y0}, PointF{track.x1, track.y1},
                       PointF{track.x2, track.y2}, PointF{track.x3, track.y3}});

    std::array<PointF, 3> predicted = {
        mod2Pix(PointF{3.5, dim - 3.5}), // bottom-left
        mod2Pix(PointF{3.5, 3.5}),       // top-left
        mod2Pix(PointF{dim - 3.5, 3.5})  // top-right
    };

    // Start with the finder farthest from image edges; partial edge QRs can
    // still use an interior finder as the motion anchor. Once one real finder
    // is found, its displacement recenters the other two searches.
    std::array<int, 3> order = {0, 1, 2};
    auto margin = [&](PointF p) {
        return std::min({p.x, p.y, float(image.width()) - p.x, float(image.height()) - p.y});
    };
    std::sort(order.begin(), order.end(), [&](int a, int b) { return margin(predicted[a]) > margin(predicted[b]); });

    std::array<std::optional<ConcentricPattern>, 3> found;
    int anchor = -1;
    for (int index : order) {
        found[index] = locateGuidedFinder(image, predicted[index], moduleSize, 4, metrics);
        if (found[index]) {
            anchor = index;
            break;
        }
    }
    if (anchor < 0)
        return false;

    const PointF delta = PointF(*found[anchor]) - predicted[anchor];
    for (int index = 0; index < 3; ++index) {
        if (index == anchor)
            continue;
        found[index] = locateGuidedFinder(image, predicted[index] + delta, moduleSize, 2, metrics);
        if (!found[index])
            return false;
    }

    out = QRCode::FinderPatternSet{*found[0], *found[1], *found[2]};
    metrics.finderTriplets++;
    return true;
}

// A single projective grid is not enough for AirGapper's 177-module wall:
// real phone lenses bow the interior by over half a module even when the four
// outer corners are correct. Full SampleQR fixes that by locating the entire
// version-40 alignment lattice (7x7 control positions), but doing dozens of
// local alignment searches for every tracked QR dominates guided sampling.
//
// This fast stage keeps the distortion-aware tiled GridSampler while reducing
// the control lattice to 3x3: the three finder-adjacent controls plus up to six
// real alignment patterns at {first, middle, last} version-40 centers. Missing
// controls fall back to a current-frame projective estimate inside SampleGrid.
// A normal QR RS decode + AirGapper CRC is still the oracle; misses immediately
// fall through to the complete SampleQR path.
static std::optional<ConcentricPattern> locateGuidedAlignment(const BitMatrix& image,
                                                              int moduleSize, PointF estimate)
{
    for (auto d : {PointF{0, 0}, {0, -1}, {0, 1}, {-1, 0}, {1, 0},
                   {-1, -1}, {1, -1}, {1, 1}, {-1, 1}}) {
        const PointF p = estimate + moduleSize * 2.25 * d;
        if (!image.isIn(p))
            continue;
        auto cor = CenterOfRing(image, PointI(p), moduleSize * 3, 1, false);
        if (!cor || !image.get(*cor))
            continue;
        if (auto cor1 = CenterOfRing(image, PointI(*cor), moduleSize * 2, 1))
            if (auto cor2 = CenterOfRing(image, PointI(*cor), moduleSize * 3, 2))
                if (distance(*cor1, *cor2) < moduleSize / 2.0 && cor2->size > cor1->size) {
                    ConcentricPattern found;
                    static_cast<PointF&>(found) = (*cor1 + *cor2) / 2;
                    found.size = (cor1->size + cor2->size) / 2;
                    return found;
                }
    }
    return std::nullopt;
}

struct GuidedSparseState
{
    std::array<uint8_t, 64> failures{};
    std::array<uint8_t, 64> cooldown{};
};

static GuidedSparseState& guidedSparseState()
{
    static GuidedSparseState state;
    return state;
}

static bool guidedSparseAllowed(int id)
{
    if (id < 0 || id >= int(guidedSparseState().cooldown.size()))
        return true;
    auto& cooldown = guidedSparseState().cooldown[id];
    if (!cooldown)
        return true;
    --cooldown;
    return false;
}

static void noteGuidedSparseOutcome(int id, bool success)
{
    if (id < 0 || id >= int(guidedSparseState().failures.size()))
        return;
    auto& state = guidedSparseState();
    if (success) {
        state.failures[id] = 0;
        state.cooldown[id] = 0;
        return;
    }
    if (++state.failures[id] >= 4) {
        state.failures[id] = 0;
        // Sparse sampling is materially cheaper than full SampleQR and often
        // recovers on the very next animated frame. Back off only briefly after
        // a real miss streak; the old 10-appearance cooldown stranded good slots.
        state.cooldown[id] = 2;
    }
}

// Full SampleQR fallback policy is owned by the main thread so every worker
// learns from the same physical-slot history. The codec only executes the
// supplied allow-mask and reports per-slot outcomes back.


constexpr float GUIDED_TURBO_CANARY_MIN_MODULE = 2.25f;
constexpr int GUIDED_TURBO_BAD_COOLDOWN = 6;
constexpr int GUIDED_TURBO_CANARY_COOLDOWN = 6;
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

struct GuidedTurboAdaptive
{
    int canaryAttempts = 0;
    int canaryDirectSuccesses = 0;
    int canaryStableAttempts = 0;
    int canaryStableSuccesses = 0;
    int promotedAttempts = 0;
    int promotedSuccesses = 0;
    int cooldown = 0;
    bool promoted = false;
    bool rsMode = false;
};

static std::array<GuidedTurboTrack, 64>& guidedTurboTracks()
{
    static std::array<GuidedTurboTrack, 64> tracks;
    return tracks;
}

static GuidedTurboAdaptive& guidedTurboAdaptive()
{
    static GuidedTurboAdaptive state;
    return state;
}

static GuidedTurboTrack* guidedTurboTrack(int id)
{
    return id >= 0 && id < int(guidedTurboTracks().size()) ? &guidedTurboTracks()[id] : nullptr;
}

static void pauseTurbo(bool refreshDistortion = false, int cooldown = GUIDED_TURBO_CANARY_COOLDOWN)
{
    auto& adaptive = guidedTurboAdaptive();
    adaptive.canaryAttempts = 0;
    adaptive.canaryDirectSuccesses = 0;
    adaptive.canaryStableAttempts = 0;
    adaptive.canaryStableSuccesses = 0;
    adaptive.promotedAttempts = 0;
    adaptive.promotedSuccesses = 0;
    adaptive.promoted = false;
    adaptive.rsMode = false;
    adaptive.cooldown = cooldown;
    for (auto& cache : guidedTurboTracks()) {
        cache.misses = 0;
        cache.cooldown = 0;
        // A sustained promoted Stable-RS collapse means the lens map no longer
        // matches the current pose. Keep it usable for projective direct probes
        // while allowing the next successful Guided sample to replace it.
        if (refreshDistortion && cache.seeded)
            cache.distortionAware = false;
    }
}

static bool turboSeedEligible(const DecimenGuidedTrack& track)
{
    auto* cache = guidedTurboTrack(track.id);
    if (!cache || guidedModuleSize(track) < GUIDED_TURBO_CANARY_MIN_MODULE)
        return false;
    // Calibration piggybacks on Guided work we are already paying for. Keep
    // learning missing/stale maps even while Turbo probes themselves cool down.
    return !cache->seeded || !cache->distortionAware || cache->dimension != track.dimension;
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
    // v197 only tolerated nearly-pure translation. At ~2.5 px/module that
    // rejects or mis-samples perfectly trackable handheld scale/perspective
    // changes. The hot sampler below now warps every cached module by the
    // current tracked quad, so this is only a stale-geometry sanity gate.
    return residual <= std::max(4.0f, module * 2.0f);
}

static bool turboStableWarpEligible(const GuidedTurboTrack& cache,
                                     const DecimenGuidedTrack& track, float residual)
{
    if (!cache.distortionAware)
        return false;
    const float module = guidedModuleSize(track);
    // Stable-RS now warps the calibrated distortion map from its seed quad to
    // the coherent live track quad. Keep only the broad stale-cache sanity gate
    // used by projective Turbo; the old ~1 px near-translation fence starved
    // >90% of a perfectly stationary wall before RS could even be attempted.
    return module >= GUIDED_TURBO_CANARY_MIN_MODULE &&
           residual <= std::max(4.0f, module * 2.0f);
}

static PerspectiveTransform turboFrameTransform(const GuidedTurboTrack& cache,
                                                const DecimenGuidedTrack& track)
{
    const auto current = turboTrackQuad(track);
    return PerspectiveTransform(
        QuadrilateralF{cache.seedQuad[0], cache.seedQuad[1], cache.seedQuad[2], cache.seedQuad[3]},
        QuadrilateralF{current[0], current[1], current[2], current[3]});
}

static PointF turboWarpedPoint(const GuidedTurboTrack& cache,
                               const PerspectiveTransform& frameTransform, int x, int y)
{
    return frameTransform(cache.samples[size_t(y) * cache.dimension + x]);
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
    // Preserve the sub-pixel location Guided calibrated instead of snapping every
    // module center to one camera pixel. Bilinear Y sampling is especially useful
    // around 2-3 px/module where a half-pixel phase error is a large fraction of
    // the module width.
    const float px = float(p.x) + dx;
    const float py = float(p.y) + dy;
    const int x0 = int(std::floor(px));
    const int y0 = int(std::floor(py));
    if (x0 < 0 || y0 < 0 || x0 + 1 >= width || y0 + 1 >= height)
        return -1;
    const float fx = px - x0;
    const float fy = py - y0;
    const size_t r0 = size_t(y0) * stride;
    const size_t r1 = size_t(y0 + 1) * stride;
    const float a = yPlane[r0 + x0] + (yPlane[r0 + x0 + 1] - yPlane[r0 + x0]) * fx;
    const float b = yPlane[r1 + x0] + (yPlane[r1 + x0 + 1] - yPlane[r1 + x0]) * fx;
    return int(std::lround(a + (b - a) * fy));
}

static TurboLevels turboReadLevels(const GuidedTurboTrack& cache, const DecimenGuidedTrack& track,
                                   const PerspectiveTransform& frameTransform,
                                   const uint8_t* yPlane, int width, int height, int stride, float dx, float dy)
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
                    turboWarpedPoint(cache, frameTransform, sx, sy), dx, dy);
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

static int turboModuleLum(const GuidedTurboTrack& cache, const DecimenGuidedTrack& track,
                          const PerspectiveTransform& frameTransform,
                          const uint8_t* yPlane, int width, int height, int stride, int x, int y,
                          float dx, float dy, int threshold, float moduleSize)
{
    const PointF p = turboWarpedPoint(cache, frameTransform, x, y);
    int lum = turboLum(yPlane, width, height, stride, p, dx, dy);
    if (lum < 0 || moduleSize < GUIDED_TURBO_CANARY_MIN_MODULE ||
        std::abs(lum - threshold) > GUIDED_TURBO_AMBIGUOUS)
        return lum;

    // Ambiguous low-density modules get a tiny five-point vote *inside the
    // module's own warped basis*. Using +/-1 camera pixels at 2.5 px/module can
    // cross a QR edge; using fractions of neighboring module-center vectors
    // stays safely inside the cell even under perspective.
    const int dim = track.dimension;
    const PointF left = turboWarpedPoint(cache, frameTransform, std::max(0, x - 1), y);
    const PointF right = turboWarpedPoint(cache, frameTransform, std::min(dim - 1, x + 1), y);
    const PointF up = turboWarpedPoint(cache, frameTransform, x, std::max(0, y - 1));
    const PointF down = turboWarpedPoint(cache, frameTransform, x, std::min(dim - 1, y + 1));
    const float xDiv = (x > 0 && x + 1 < dim) ? 2.0f : 1.0f;
    const float yDiv = (y > 0 && y + 1 < dim) ? 2.0f : 1.0f;
    const PointF ux{(right.x - left.x) / xDiv, (right.y - left.y) / xDiv};
    const PointF uy{(down.x - up.x) / yDiv, (down.y - up.y) / yDiv};
    const float inset = moduleSize < 3.0f ? 0.16f : 0.22f;
    const PointF probes[4] = {
        PointF{p.x + ux.x * inset, p.y + ux.y * inset},
        PointF{p.x - ux.x * inset, p.y - ux.y * inset},
        PointF{p.x + uy.x * inset, p.y + uy.y * inset},
        PointF{p.x - uy.x * inset, p.y - uy.y * inset}
    };
    int values[5] = {lum, 0, 0, 0, 0};
    for (int i = 0; i < 4; ++i) {
        values[i + 1] = turboLum(yPlane, width, height, stride, probes[i], dx, dy);
        if (values[i + 1] < 0)
            return lum;
    }
    std::sort(std::begin(values), std::end(values));
    return values[2];
}

static DecoderResult decodeTurboDataOnly(const GuidedTurboTrack& cache, const DecimenGuidedTrack& track,
                                         const PerspectiveTransform& frameTransform,
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
                const int lum = turboModuleLum(cache, track, frameTransform, yPlane, width, height, stride,
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
    metrics.sampleMs += guidedNowMs() - sampleStarted;
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
    metrics.decodeMs += guidedNowMs() - decodeStarted;
    return decoded;
}

// Model-2 data placement never changes for a given dimension. Stable-RS runs
// this traversal thousands of times, so build the function-pattern/mask walk
// once per QR version and keep only packed {x,y,mask4} entries.
static const std::vector<uint32_t>& turboCodewordPlan(int dim)
{
    static std::array<std::vector<uint32_t>, 41> plans;
    static const std::vector<uint32_t> empty;
    if (dim < 21 || dim > 177 || ((dim - 17) & 3))
        return empty;
    const int versionNumber = (dim - 17) / 4;
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
    for (int x = dim - 1; x > 0 && plan.size() < wanted; x -= 2) {
        if (x == 6) --x;
        for (int row = 0; row < dim && plan.size() < wanted; ++row) {
            const int y = readingUp ? dim - 1 - row : row;
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

static DecoderResult decodeTurboStableRS(const GuidedTurboTrack& cache,
                                         const DecimenGuidedTrack& track,
                                         const PerspectiveTransform& frameTransform,
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

    const auto& plan = turboCodewordPlan(dim);
    if (plan.size() != size_t(totalCodewords) * 8)
        return {};
    const double sampleStarted = guidedNowMs();
    ByteArray raw(totalCodewords);
    const float moduleSize = guidedModuleSize(track);
    bool failed = false;
    for (int codeword = 0; codeword < totalCodewords && !failed; ++codeword) {
        uint8_t value = 0;
        const size_t firstBit = size_t(codeword) * 8;
        for (int bit = 0; bit < 8; ++bit) {
            const uint32_t entry = plan[firstBit + bit];
            const int xx = int(entry & 0xff);
            const int y = int((entry >> 8) & 0xff);
            const bool mask = ((entry >> 16) & 1) != 0;
            const int threshold = turboThreshold(levels, xx, y, dim);
            const int lum = turboModuleLum(cache, track, frameTransform,
                                           yPlane, width, height, stride,
                                           xx, y, dx, dy, threshold, moduleSize);
            if (lum < 0) { failed = true; break; }
            value = uint8_t((value << 1) | uint8_t(mask != (lum <= threshold)));
        }
        raw[codeword] = value;
    }
    metrics.sampleMs += guidedNowMs() - sampleStarted;
    if (failed)
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

static PointF turboRefineWallOffset(const GuidedTurboTrack& cache, const DecimenGuidedTrack& track,
                                    const PerspectiveTransform& frameTransform,
                                    const uint8_t* yPlane, int width, int height, int stride,
                                    float predictedX, float predictedY)
{
    PointF best{predictedX, predictedY};
    int bestScore = -1;
    int bestMatches = -1;
    auto consider = [&](float dx, float dy) {
        const auto levels = turboReadLevels(cache, track, frameTransform, yPlane, width, height, stride, dx, dy);
        if (!levels.ok) return;
        const int score = levels.matches * 4 + levels.separation;
        if (score > bestScore) {
            bestScore = score;
            bestMatches = levels.matches;
            best = PointF{dx, dy};
        }
    };
    consider(predictedX, predictedY);
    if (bestMatches < 143) {
        for (int oy = -1; oy <= 1; ++oy)
            for (int ox = -1; ox <= 1; ++ox)
                if (ox || oy)
                    consider(predictedX + ox, predictedY + oy);
    }
    if (bestMatches < 140) {
        for (int oy = -2; oy <= 2; ++oy)
            for (int ox = -2; ox <= 2; ++ox)
                if (std::max(std::abs(ox), std::abs(oy)) == 2)
                    consider(predictedX + ox, predictedY + oy);
    }
    if (bestMatches < 132) {
        for (int oy = -3; oy <= 3; ++oy)
            for (int ox = -3; ox <= 3; ++ox)
                if (std::max(std::abs(ox), std::abs(oy)) == 3)
                    consider(predictedX + ox, predictedY + oy);
    }
    if (bestScore >= 0) {
        const PointF coarse = best;
        for (int hy = -1; hy <= 1; ++hy)
            for (int hx = -1; hx <= 1; ++hx)
                if (hx || hy)
                    consider(coarse.x + hx * 0.5f, coarse.y + hy * 0.5f);
    }
    return best;
}

static DetectorResult sampleGuidedSparse(const BitMatrix& image,
                                         const DecimenGuidedTrack& track,
                                         const QRCode::FinderPatternSet& fp,
                                         int* alignmentFoundOut,
                                         std::vector<PointF>* sampleMapOut)
{
    const int dim = track.dimension;
    const auto* version = QRCode::Version::Model2((dim - 17) / 4);
    if (!version)
        return {};
    const auto& fullCenters = version->alignmentPatternCenters();
    if (fullCenters.size() < 3)
        return {};

    std::vector<int> centers{
        fullCenters.front(),
        fullCenters[fullCenters.size() / 2],
        fullCenters.back()
    };
    constexpr int N = 2;

    PerspectiveTransform prior(
        QuadrilateralF{PointF{0, 0}, PointF{double(dim), 0},
                       PointF{double(dim), double(dim)}, PointF{0, double(dim)}},
        QuadrilateralF{PointF{track.x0, track.y0}, PointF{track.x1, track.y1},
                       PointF{track.x2, track.y2}, PointF{track.x3, track.y3}});
    if (!prior.isValid())
        return {};

    const PointF priorTL = prior(PointF{3.5, 3.5});
    const PointF priorTR = prior(PointF{dim - 3.5, 3.5});
    const PointF priorBL = prior(PointF{3.5, dim - 3.5});
    const PointF priorU = priorTR - priorTL;
    const PointF priorV = priorBL - priorTL;
    const double det = priorU.x * priorV.y - priorU.y * priorV.x;
    if (std::abs(det) < 1e-5)
        return {};

    const PointF actualTL = fp.tl;
    const PointF actualU = PointF(fp.tr) - actualTL;
    const PointF actualV = PointF(fp.bl) - actualTL;
    auto currentPrediction = [&](PointF oldPoint) {
        const PointF w = oldPoint - priorTL;
        const double a = (w.x * priorV.y - w.y * priorV.x) / det;
        const double b = (priorU.x * w.y - priorU.y * w.x) / det;
        return actualTL + a * actualU + b * actualV;
    };
    auto projectControl = [&](int x, int y) {
        return currentPrediction(prior(centered(PointI{centers[x], centers[y]})));
    };

    // Base transform is only the fallback for missing sparse controls. Its
    // fourth point is the previous bottom-right alignment prediction after the
    // exact current finder affine correction, not a stale raw corner.
    const PointF predictedBR = projectControl(N, N);
    if (!image.isIn(predictedBR))
        return {};
    auto sourceQuad = Rectangle(dim, dim, 3.5);
    sourceQuad[2] = sourceQuad[2] - PointF{3, 3};
    PerspectiveTransform base(sourceQuad,
        QuadrilateralF{PointF(fp.tl), PointF(fp.tr), predictedBR, PointF(fp.bl)});
    if (!base.isValid())
        return {};

    Matrix<std::optional<PointF>> controls(3, 3);
    auto seedFinderCorner = [&](int x, int y, const ConcentricPattern& finder) {
        const PointF predicted = projectControl(x, y);
        controls.set(x, y, predicted);
        if (auto corners = FindConcentricPatternCorners(image, finder, finder.size, 2)) {
            for (auto corner : *corners) {
                if (distance(corner, predicted) < finder.size / 2) {
                    controls.set(x, y, corner);
                    break;
                }
            }
        }
    };
    seedFinderCorner(0, 0, fp.tl);
    seedFinderCorner(0, N, fp.bl);
    seedFinderCorner(N, 0, fp.tr);

    const int moduleSize = std::max(1, int(std::lround(guidedModuleSize(track))));
    int alignmentFound = 0;
    for (int y = 0; y <= N; ++y) {
        for (int x = 0; x <= N; ++x) {
            if ((x == 0 && y == 0) || (x == 0 && y == N) || (x == N && y == 0))
                continue;
            const PointF predicted = projectControl(x, y);
            if (auto found = locateGuidedAlignment(image, moduleSize, predicted)) {
                controls.set(x, y, PointF(*found));
                ++alignmentFound;
            }
        }
    }

    if (alignmentFoundOut) *alignmentFoundOut = alignmentFound;
    // If fewer than half of the real sparse alignment controls were found,
    // avoid a likely-wasted RS decode and use full SampleQR immediately.
    if (alignmentFound < 3)
        return {};

    if (sampleMapOut && !buildSparseSampleMap(dim, base, controls, centers, *sampleMapOut))
        sampleMapOut->clear();
    return SampleGrid(image, dim, dim, base, std::move(controls), centers, centers);
}

} // namespace

extern "C" int decodeGuidedBatchY(const uint8_t* yPlane, int width, int height, int stride,
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
            result.status = DECIMEN_TRACK_PREDICTED;
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

        auto& turboAdaptive = guidedTurboAdaptive();
        if (turboAdaptive.cooldown)
            --turboAdaptive.cooldown;
        for (auto& cache : guidedTurboTracks())
            if (cache.cooldown)
                --cache.cooldown;

        int canaryIndex = -1;
        if (!turboAdaptive.promoted && !turboAdaptive.cooldown) {
            // First choice: any distortion-aware map whose cached geometry is
            // still close enough for a projective seed->live warp. Stable-RS no
            // longer requires the seed quad to remain near-translation rigid.
            for (int i = 0; i < trackCount; ++i) {
                auto* cache = guidedTurboTrack(tracks[i].id);
                if (!cache || !cache->seeded || !cache->distortionAware || cache->cooldown ||
                    guidedModuleSize(tracks[i]) < GUIDED_TURBO_CANARY_MIN_MODULE)
                    continue;
                float dx = 0, dy = 0, residual = 0;
                if (turboPose(*cache, tracks[i], dx, dy, residual) &&
                    turboStableWarpEligible(*cache, tracks[i], residual)) {
                    canaryIndex = i;
                    break;
                }
            }
            // Direct Turbo can still probe a non-rigid cached slot when no
            // Stable-RS candidate exists; do not stall probation completely.
            if (canaryIndex < 0) {
                for (int i = 0; i < trackCount; ++i) {
                    auto* cache = guidedTurboTrack(tracks[i].id);
                    if (cache && cache->seeded && !cache->cooldown &&
                        guidedModuleSize(tracks[i]) >= GUIDED_TURBO_CANARY_MIN_MODULE) {
                        canaryIndex = i;
                        break;
                    }
                }
            }
        }
        auto turboAllowed = [&](int i) {
            if (guidedModuleSize(tracks[i]) < GUIDED_TURBO_CANARY_MIN_MODULE || turboAdaptive.cooldown)
                return false;
            return turboAdaptive.promoted || i == canaryIndex;
        };

        // Shared wall motion is paid once. In the 1440p canary state only the
        // single proving slot participates, so a soft/old camera cannot turn
        // this experiment into a second full decoder.
        float wallCorrectionX = 0, wallCorrectionY = 0;
        if (!turboAdaptive.cooldown) {
            for (int i = 0; i < trackCount; ++i) {
                auto* cache = guidedTurboTrack(tracks[i].id);
                if (!cache || !cache->seeded || !turboAllowed(i))
                    continue;
                float dx = 0, dy = 0, residual = 0;
                if (!turboPose(*cache, tracks[i], dx, dy, residual))
                    continue;
                const auto frameTransform = turboFrameTransform(*cache, tracks[i]);
                if (!frameTransform.isValid())
                    continue;
                const PointF refined = turboRefineWallOffset(*cache, tracks[i], frameTransform,
                                                              yPlane, width, height, stride, 0, 0);
                wallCorrectionX = refined.x;
                wallCorrectionY = refined.y;
                break;
            }
        }

        // Stable-RS uses the same coherent projective seed->live warp as
        // direct Turbo, plus the one shared sub-pixel residual refined above.
        // RS + AirGapper CRC remain the acceptance oracle, so a stale warp only
        // causes a cheap miss and Guided fallback.

        for (int i = 0; i < trackCount; ++i) {
            const auto& track = tracks[i];
            auto* cache = guidedTurboTrack(track.id);
            if (!cache || !cache->seeded || !turboAllowed(i))
                continue;
            if (cache->cooldown)
                continue;
            float poseX = 0, poseY = 0, residual = 0;
            if (!turboPose(*cache, track, poseX, poseY, residual))
                continue;
            // `stable` means the calibrated map can be projectively warped onto
            // this live track. Finder contrast is a separate cheap per-slot gate.
            const bool stableEligible = turboStableWarpEligible(*cache, track, residual);
            if (stableEligible)
                ++metrics->stableEligibleTracks;
            const bool stableProbation = !turboAdaptive.promoted && stableEligible && cache->distortionAware;
            const bool directMode = turboAdaptive.promoted ? !turboAdaptive.rsMode : !stableProbation;

            ++metrics->turboAttempts;
            const double turboStarted = guidedNowMs();
            bool success = false;
            bool directSuccess = false;
            bool directAttempted = false;
            bool stableRsAttempted = false;

            if (directMode) {
                const auto frameTransform = turboFrameTransform(*cache, track);
                if (frameTransform.isValid()) {
                    const float dx = wallCorrectionX;
                    const float dy = wallCorrectionY;
                    const auto levels = turboReadLevels(*cache, track, frameTransform,
                                                        yPlane, width, height, stride, dx, dy);
                    if (levels.ok) {
                        directAttempted = true;
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
                const auto frameTransform = turboFrameTransform(*cache, track);
                if (frameTransform.isValid()) {
                    const float dx = wallCorrectionX;
                    const float dy = wallCorrectionY;
                    const auto levels = turboReadLevels(*cache, track, frameTransform,
                                                        yPlane, width, height, stride, dx, dy);
                    if (levels.ok) {
                        stableRsAttempted = true;
                        ++metrics->sampleAttempts;
                        ++metrics->sparseRsFallbacks;
                        ++metrics->stableRsAttempts;
                        auto decoded = decodeTurboStableRS(*cache, track, frameTransform,
                                                           yPlane, width, height, stride,
                                                           dx, dy, levels, *metrics);
                        success = commitTurbo(i, decoded, wallCorrectionX, wallCorrectionY);
                        if (success)
                            ++metrics->stableRsSuccesses;
                    }
                }
            }

            metrics->fastDecodeMs += guidedNowMs() - turboStarted;
            const bool decoderAttempted = directAttempted || stableRsAttempted;
            if (success) {
                ++metrics->turboSuccesses;
                cache->misses = 0;
                cache->cooldown = 0;
            } else if (decoderAttempted) {
                if (turboAdaptive.promoted && turboAdaptive.rsMode) {
                    if (++cache->misses >= 4) {
                        cache->misses = 0;
                        cache->cooldown = 2;
                    }
                } else if (++cache->misses >= 2) {
                    cache->misses = 0;
                    cache->cooldown = GUIDED_TURBO_BAD_COOLDOWN;
                }
            } else {
                // No decoder ran, so this is anchor evidence rather than a decode
                // failure. Briefly rotate away from this slot during probation.
                cache->cooldown = std::max<uint8_t>(cache->cooldown, 2);
            }

            if (!turboAdaptive.promoted) {
                if (!decoderAttempted)
                    continue;
                ++turboAdaptive.canaryAttempts;
                turboAdaptive.canaryDirectSuccesses += int(directSuccess);
                if (stableRsAttempted) {
                    ++turboAdaptive.canaryStableAttempts;
                    turboAdaptive.canaryStableSuccesses += int(success);
                }

                const bool directEarly = turboAdaptive.canaryAttempts >= 4 &&
                                         turboAdaptive.canaryDirectSuccesses == turboAdaptive.canaryAttempts;
                const bool stableEarly = turboAdaptive.canaryStableAttempts >= 4 &&
                                         turboAdaptive.canaryStableSuccesses * 4 >=
                                         turboAdaptive.canaryStableAttempts * 3;
                bool promoteDirect = directEarly;
                bool promoteStable = stableEarly;
                if (!promoteDirect && !promoteStable && turboAdaptive.canaryAttempts >= 8) {
                    promoteDirect = turboAdaptive.canaryDirectSuccesses * 4 >=
                                    turboAdaptive.canaryAttempts * 3;
                    promoteStable = turboAdaptive.canaryStableAttempts >= 6 &&
                                    turboAdaptive.canaryStableSuccesses * 2 >=
                                    turboAdaptive.canaryStableAttempts;
                }
                if (promoteDirect || promoteStable) {
                    turboAdaptive.promoted = true;
                    turboAdaptive.rsMode = promoteStable && !promoteDirect;
                    turboAdaptive.canaryAttempts = 0;
                    turboAdaptive.canaryDirectSuccesses = 0;
                    turboAdaptive.canaryStableAttempts = 0;
                    turboAdaptive.canaryStableSuccesses = 0;
                    turboAdaptive.promotedAttempts = 0;
                    turboAdaptive.promotedSuccesses = 0;
                } else if (turboAdaptive.canaryAttempts >= 10) {
                    pauseTurbo(false);
                }
            } else if (decoderAttempted) {
                ++turboAdaptive.promotedAttempts;
                turboAdaptive.promotedSuccesses += int(success);
                const int evaluationWindow = turboAdaptive.rsMode ? 72 : 36;
                if (turboAdaptive.promotedAttempts >= evaluationWindow) {
                    const bool tooWeak = turboAdaptive.rsMode
                        ? turboAdaptive.promotedSuccesses * 10 < turboAdaptive.promotedAttempts * 3
                        : turboAdaptive.promotedSuccesses * 2 < turboAdaptive.promotedAttempts;
                    if (tooWeak)
                        pauseTurbo(turboAdaptive.rsMode, turboAdaptive.rsMode ? 4 : GUIDED_TURBO_CANARY_COOLDOWN);
                    else {
                        turboAdaptive.promotedAttempts = 0;
                        turboAdaptive.promotedSuccesses = 0;
                    }
                }
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

/** How well the three finder patterns match at a candidate offset: sampled
 *  through the transform, compared against the ideal 7×7 template. Max 147.
 *  This is the cheap anchor — 147 point samples per candidate versus a full
 *  31K-point grid sample, so a 5×5 pixel search costs microseconds. */
static int finderScore(const BitMatrix& img, const PerspectiveTransform& mod2Pix, int dim, PointF off)
{
	// Ideal finder module: black border ring, white ring, black 3×3 core.
	auto ideal = [](int x, int y) {
		return x == 0 || x == 6 || y == 0 || y == 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4);
	};
	const PointI corners[3] = {{0, 0}, {dim - 7, 0}, {0, dim - 7}};
	int score = 0;
	for (auto c : corners)
		for (int my = 0; my < 7; my++)
			for (int mx = 0; mx < 7; mx++) {
				PointF p = mod2Pix(centered(PointI{c.x + mx, c.y + my})) + off;
				if (img.isIn(p) && img.get(p) == ideal(mx, my))
					score++;
			}
	return score;
}

// ---- Point-sampled fast path -----------------------------------------------
// The tracked geometry names ~31K module centers; binarizing the whole crop
// first (~200K-pixel luminance pass + HybridBinarizer) just to read those
// points was the dominant remaining per-decode cost. This path reads RGBA
// luminance directly at each projected center and thresholds it against a
// coarse tile grid built from ~1K sparse probes — an order of magnitude
// fewer pixel touches. Misses fall through to the binarized pipeline below,
// so lighting conditions this crude thresholding can't handle only cost the
// attempt, never the decode.

constexpr int THRESH_TILES = 8;
constexpr int TILE_SAMPLES = 4; // 4×4 probes per tile

static inline int lumAt(const uint8_t* rgba, int width, int height, PointF p)
{
	int x = int(p.x), y = int(p.y);
	if (x < 0 || y < 0 || x >= width || y >= height)
		return -1;
	const uint8_t* px = rgba + (size_t(y) * width + x) * 4;
	return RGBToLum(px[0], px[1], px[2]);
}

struct ThresholdGrid
{
	int t[THRESH_TILES][THRESH_TILES];
	bool ok = false;
};

static ThresholdGrid buildThresholds(const uint8_t* rgba, int width, int height, const PerspectiveTransform& mod2Pix,
									 int dim)
{
	ThresholdGrid grid;
	const double tile = double(dim) / THRESH_TILES;
	int gmin = 255, gmax = 0;
	int lo[THRESH_TILES][THRESH_TILES], hi[THRESH_TILES][THRESH_TILES];
	for (int ty = 0; ty < THRESH_TILES; ty++)
		for (int tx = 0; tx < THRESH_TILES; tx++) {
			lo[ty][tx] = 255;
			hi[ty][tx] = 0;
			for (int sy = 0; sy < TILE_SAMPLES; sy++)
				for (int sx = 0; sx < TILE_SAMPLES; sx++) {
					double mx = (tx + (sx + 0.5) / TILE_SAMPLES) * tile;
					double my = (ty + (sy + 0.5) / TILE_SAMPLES) * tile;
					int l = lumAt(rgba, width, height, mod2Pix(PointF{mx, my}));
					if (l < 0)
						continue;
					lo[ty][tx] = std::min(lo[ty][tx], l);
					hi[ty][tx] = std::max(hi[ty][tx], l);
				}
			gmin = std::min(gmin, lo[ty][tx]);
			gmax = std::max(gmax, hi[ty][tx]);
		}
	if (gmax - gmin < 24)
		return grid; // flat image — no code under this quad
	for (int ty = 0; ty < THRESH_TILES; ty++)
		for (int tx = 0; tx < THRESH_TILES; tx++) {
			// QR data is dense enough that every tile normally sees both
			// colors; a low-contrast tile (glare washout) borrows the
			// global threshold rather than inventing one from noise.
			grid.t[ty][tx] =
				hi[ty][tx] - lo[ty][tx] >= 24 ? (lo[ty][tx] + hi[ty][tx]) / 2 : (gmin + gmax) / 2;
		}
	grid.ok = true;
	return grid;
}

static inline bool darkAt(const uint8_t* rgba, int width, int height, const ThresholdGrid& grid,
						  const PerspectiveTransform& mod2Pix, int dim, PointF off, double mx, double my)
{
	int l = lumAt(rgba, width, height, mod2Pix(PointF{mx, my}) + off);
	if (l < 0)
		return false;
	int tx = std::clamp(int(mx * THRESH_TILES / dim), 0, THRESH_TILES - 1);
	int ty = std::clamp(int(my * THRESH_TILES / dim), 0, THRESH_TILES - 1);
	return l <= grid.t[ty][tx];
}

/** finderScore's twin for the point-sampled path — same ideal template, same
 *  max of 147, but reading RGBA + tile thresholds instead of a BitMatrix. */
static int finderScorePoints(const uint8_t* rgba, int width, int height, const ThresholdGrid& grid,
							 const PerspectiveTransform& mod2Pix, int dim, PointF off)
{
	auto ideal = [](int x, int y) {
		return x == 0 || x == 6 || y == 0 || y == 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4);
	};
	const PointI corners[3] = {{0, 0}, {dim - 7, 0}, {0, dim - 7}};
	int score = 0;
	for (auto c : corners)
		for (int my = 0; my < 7; my++)
			for (int mx = 0; mx < 7; mx++)
				if (darkAt(rgba, width, height, grid, mod2Pix, dim, off, c.x + mx + 0.5, c.y + my + 0.5) ==
					ideal(mx, my))
					score++;
	return score;
}

DecimenResult readTracked(int bufferPtr, int width, int height, int dim, double x0, double y0, double x1, double y1,
						  double x2, double y2, double x3, double y3)
{
	try {
		const uint8_t* rgba = reinterpret_cast<const uint8_t*>(bufferPtr);

		PerspectiveTransform mod2Pix(
			QuadrilateralF{PointF{0, 0}, PointF{double(dim), 0}, PointF{double(dim), double(dim)},
						   PointF{0, double(dim)}},
			QuadrilateralF{PointF{x0, y0}, PointF{x1, y1}, PointF{x2, y2}, PointF{x3, y3}});

		// Point-sampled attempt first: its own finder-anchor search, then a
		// direct grid read and one RS decode. Everything below it survives as
		// the fallback chain. Same adaptive skip as the plain path below:
		// rigid point geometry loses to lens bow exactly like the plain
		// homography does, and a doomed attempt every call is pure heat.
		static int pointLossStreak = 0;
		static int pointCallsSinceProbe = 0;
		const bool tryPoints = pointLossStreak < 4 || ++pointCallsSinceProbe >= 64;
		if (tryPoints && pointCallsSinceProbe >= 64)
			pointCallsSinceProbe = 0;
		bool pointsAttempted = false;
		if (tryPoints) {
			auto grid = buildThresholds(rgba, width, height, mod2Pix, dim);
			if (grid.ok) {
			pointsAttempted = true;
			PointF pBest{0, 0};
			int pScore = -1;
			for (int dy = -2; dy <= 2; dy++)
				for (int dx = -2; dx <= 2; dx++) {
					int s = finderScorePoints(rgba, width, height, grid, mod2Pix, dim, PointF(dx, dy));
					if (s > pScore) {
						pScore = s;
						pBest = PointF(dx, dy);
					}
				}
			const PointF pCoarse = pBest;
			for (double fy = -0.5; fy <= 0.5; fy += 0.5)
				for (double fx = -0.5; fx <= 0.5; fx += 0.5) {
					PointF off = pCoarse + PointF(fx, fy);
					int s = finderScorePoints(rgba, width, height, grid, mod2Pix, dim, off);
					if (s > pScore) {
						pScore = s;
						pBest = off;
					}
				}
			if (pScore >= 125) {
				BitMatrix sampled(dim, dim);
				for (int y = 0; y < dim; y++)
					for (int x = 0; x < dim; x++)
						if (darkAt(rgba, width, height, grid, mod2Pix, dim, pBest, x + 0.5, y + 0.5))
							sampled.set(x, y);
				auto decoded = QRCode::Decode(sampled);
				if (decoded.isValid()) {
					pointLossStreak = 0;
					// Same corner convention as GridSampler's projectCorner,
					// so the returned quad feeds the next tracked call.
					auto proj = [&](PointI p) { return PointI(mod2Pix(PointF(p)) + pBest + PointF(0.5, 0.5)); };
					Position pos{proj({0, 0}), proj({dim, 0}), proj({dim, dim}), proj({0, dim})};
					return {true, "", toUint8Array(decoded.content().bytes), pos, dim};
				}
			}
			}
		}

		ImageView iv(reinterpret_cast<uint8_t*>(bufferPtr), width, height, ImageFormat::RGBA);
		auto lum = toLum(iv);
		ImageView lumView(lum.data(), width, height, ImageFormat::Lum);
		HybridBinarizer binarized(lumView);
		auto bits = binarized.getBitMatrix();
		if (!bits)
			return {false, "binarization produced no matrix", {}, {}};

		// Finder-anchored refinement: the cached quad is one or more frames
		// old, and a raw homography tolerates barely 1 px of drift before RS
		// falls over. Slide the transform over a ±2 px window (then ±0.5 px
		// around the winner), scoring the three finder patterns at each
		// offset, and sample at the best. Extends drift tolerance to ~2.5 px
		// for microseconds of scoring — the full sample + RS runs once.
		PointF best{0, 0};
		int bestScore = -1;
		for (int dy = -2; dy <= 2; dy++)
			for (int dx = -2; dx <= 2; dx++) {
				int s = finderScore(*bits, mod2Pix, dim, PointF(dx, dy));
				if (s > bestScore) {
					bestScore = s;
					best = PointF(dx, dy);
				}
			}
		const PointF coarse = best;
		for (double fy = -0.5; fy <= 0.5; fy += 0.5)
			for (double fx = -0.5; fx <= 0.5; fx += 0.5) {
				PointF off = coarse + PointF(fx, fy);
				int s = finderScore(*bits, mod2Pix, dim, off);
				if (s > bestScore) {
					bestScore = s;
					best = off;
				}
			}
		// Below ~85% the anchor is gone (code moved past the window, or the
		// frame is trash) — bail cheaply and let the caller run detection.
		if (bestScore < 125)
			return {false, "finder anchor lost", {}, {}};

		PerspectiveTransform refined(
			QuadrilateralF{PointF{0, 0}, PointF{double(dim), 0}, PointF{double(dim), double(dim)},
						   PointF{0, double(dim)}},
			QuadrilateralF{PointF{x0 + best.x, y0 + best.y}, PointF{x1 + best.x, y1 + best.y},
						   PointF{x2 + best.x, y2 + best.y}, PointF{x3 + best.x, y3 + best.y}});

		// First try: one plain-homography sample. Exact for flat, undistorted
		// geometry, and the cheapest decode there is. Real lenses bow the
		// interior of a 177-module code by over half a module even when the
		// corners are pinned — a field run measured 550 tracked attempts, 550
		// RS failures on exactly this — so an RS reject here is EXPECTED on
		// real captures and falls through to the alignment-fitted path below.
		// ADAPTIVE: once the plain path keeps losing to the fitted one, its
		// wasted RS attempt gets skipped, with periodic re-probes — scene
		// geometry changes, and the statics are per-worker (wasm instances
		// are single-threaded and private to each worker).
		static int plainLossStreak = 0;
		static int callsSinceProbe = 0;
		const bool tryPlain = plainLossStreak < 4 || ++callsSinceProbe >= 64;
		if (tryPlain && callsSinceProbe >= 64)
			callsSinceProbe = 0;
		if (tryPlain) {
			if (auto detected = SampleGrid(*bits, dim, dim, refined); detected.isValid()) {
				auto decoded = QRCode::Decode(detected.bits());
				if (decoded.isValid()) {
					plainLossStreak = 0;
					if (pointsAttempted)
						pointLossStreak++;
					return {true, "", toUint8Array(decoded.content().bytes), detected.position(), dim};
				}
			}
		}

		// Second try: zxing's own SampleQR, seeded with finder patterns
		// SYNTHESIZED from the refined transform instead of found by the
		// global detector search — which is the expensive half of a stock
		// decode. SampleQR re-derives dimension, traces edges, and fits the
		// alignment-pattern grid from the actual image, exactly like the full
		// path, so it survives the lens distortion the plain homography
		// cannot. Detection skipped, robustness kept.
		auto fpCenter = [&](double mx, double my) { return mod2Pix(PointF{mx, my}) + best; };
		auto fpSize = [&](double mx, double my) {
			auto a = mod2Pix(PointF{mx - 3.5, my});
			auto b = mod2Pix(PointF{mx + 3.5, my});
			return std::hypot(b.x - a.x, b.y - a.y);
		};
		auto makeFp = [&](double mx, double my) {
			ConcentricPattern cp;
			static_cast<PointF&>(cp) = fpCenter(mx, my);
			cp.size = fpSize(mx, my);
			return cp;
		};
		QRCode::FinderPatternSet fp{makeFp(3.5, dim - 3.5), makeFp(3.5, 3.5), makeFp(dim - 3.5, 3.5)};
		for (auto&& detected : QRCode::SampleQR(*bits, fp)) {
			// The stream's version is locked — a candidate at any other
			// dimension is a mis-estimate, not our code.
			if (!detected.isValid() || detected.bits().width() != dim)
				continue;
			auto decoded = QRCode::Decode(detected.bits());
			if (decoded.isValid()) {
				if (tryPlain)
					plainLossStreak++;
				if (pointsAttempted)
					pointLossStreak++;
				return {true, "", toUint8Array(decoded.content().bytes), detected.position(), dim};
			}
		}
		return {false, "tracked sample failed", {}, {}};
	} catch (const std::exception& e) {
		return {false, e.what(), {}, {}};
	} catch (...) {
		return {false, "unknown error", {}, {}};
	}
}

// ---- Persistent batched tracked decoder -----------------------------------

namespace {

struct CachedSamplePoint
{
	float x;
	float y;
};

struct PersistentTrack
{
	int id = 0;
	int dimension = 0;
	bool active = false;
	float dx = 0;
	float dy = 0;
	int consecutiveMisses = 0;
	int framesSinceReacquire = 0;
	bool multiSample = false;
	bool crc32Payload = false;
	// The outer quad is only the seed. Once alignment patterns have been
	// measured, samples[] becomes a distortion-corrected per-module map and
	// the hot path is just Y-plane point loads + threshold + bit extraction.
	bool calibrated = false;
	int calibrationCooldown = 0;
	PointF topLeft{};
	PointF topRight{};
	PointF bottomRight{};
	PointF bottomLeft{};
	std::vector<CachedSamplePoint> samples;
	BitMatrix sampled;
};

struct TrackedDecoder
{
	int maxDimension;
	int maxRSFallbacks = 2;
	size_t fallbackCursor = 0;
	std::vector<PersistentTrack> tracks;
};

static TrackedDecoder* trackedDecoder(int handle)
{
	return reinterpret_cast<TrackedDecoder*>(static_cast<uintptr_t>(static_cast<uint32_t>(handle)));
}

static bool finderIdeal(int x, int y)
{
	return x == 0 || x == 6 || y == 0 || y == 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4);
}

struct AnchorReading
{
	int score = 0;
	int threshold = 128;
	int contrast = 0;
};

template <class LumAt>
static AnchorReading readAnchor(const PersistentTrack& track, float dx, float dy, const LumAt& lumAt)
{
	// Camera shading/ISP processing can put the three finder patterns at
	// noticeably different luminance levels. Score each finder with its own
	// black/white threshold instead of forcing one global finder threshold.
	const int dim = track.dimension;
	const PointI corners[3] = {{0, 0}, {dim - 7, 0}, {0, dim - 7}};
	AnchorReading out;
	out.contrast = 255;
	int globalBlackSum = 0, globalWhiteSum = 0, globalBlackCount = 0, globalWhiteCount = 0;
	for (auto corner : corners) {
		uint8_t values[49];
		bool expected[49];
		int count = 0, blackSum = 0, whiteSum = 0, blackCount = 0, whiteCount = 0;
		for (int my = 0; my < 7; ++my)
			for (int mx = 0; mx < 7; ++mx) {
				const auto& p = track.samples[(corner.y + my) * dim + corner.x + mx];
				int lum = lumAt(p.x + dx, p.y + dy);
				if (lum < 0)
					return {};
				bool black = finderIdeal(mx, my);
				values[count] = static_cast<uint8_t>(lum);
				expected[count++] = black;
				if (black) { blackSum += lum; ++blackCount; }
				else { whiteSum += lum; ++whiteCount; }
			}
		const int black = blackSum / blackCount;
		const int white = whiteSum / whiteCount;
		const int contrast = white - black;
		out.contrast = std::min(out.contrast, contrast);
		const int threshold = (black + white) / 2;
		if (contrast >= 24)
			for (int i = 0; i < count; ++i)
				out.score += (values[i] <= threshold) == expected[i];
		globalBlackSum += blackSum; globalBlackCount += blackCount;
		globalWhiteSum += whiteSum; globalWhiteCount += whiteCount;
	}
	const int globalBlack = globalBlackSum / globalBlackCount;
	const int globalWhite = globalWhiteSum / globalWhiteCount;
	out.threshold = (globalBlack + globalWhite) / 2;
	if (out.contrast == 255) out.contrast = 0;
	return out;
}

template <class LumAt>
static bool refineAnchor(PersistentTrack& track, const LumAt& lumAt, AnchorReading& reading)
{
	auto test = [&](float dx, float dy) {
		auto candidate = readAnchor(track, dx, dy, lumAt);
		if (candidate.score > reading.score) {
			reading = candidate;
			track.dx = dx;
			track.dy = dy;
		}
	};

	reading = readAnchor(track, track.dx, track.dy, lumAt);
	if (reading.score >= 140 && reading.contrast >= 32)
		return true;

	const float originX = track.dx, originY = track.dy;
	for (int y = -1; y <= 1; ++y)
		for (int x = -1; x <= 1; ++x)
			if (x || y)
				test(originX + x * 0.5f, originY + y * 0.5f);
	if (reading.score >= 132 && reading.contrast >= 24)
		return true;

	for (int y = -1; y <= 1; ++y)
		for (int x = -1; x <= 1; ++x)
			if (x || y)
				test(originX + float(x), originY + float(y));
	if (reading.score >= 125 && reading.contrast >= 24)
		return true;

	// Worker latency can leave a lattice anchor several camera frames behind.
	// Measured fallback re-anchors differ by 3 px at the median and up to 6 px
	// at p95, beyond the old ±1 px search despite otherwise matching geometry.
	// Finder probes are cheap; widen only failed anchors before paying for the
	// generic detector over the whole shared crop.
	for (int y = -6; y <= 6; ++y)
		for (int x = -6; x <= 6; ++x)
			if (std::abs(x) > 1 || std::abs(y) > 1)
				test(originX + float(x), originY + float(y));
	return reading.score >= 125 && reading.contrast >= 24;
}

static DecoderResult decodeWithoutErrorCorrection(const BitMatrix& bits)
{
	auto format = QRCode::ReadFormatInformation(bits);
	if (!format.isValid())
		return FormatError("Invalid format information");
	const auto* version = QRCode::ReadVersion(bits, format.type());
	if (!version)
		return FormatError("Invalid version");
	auto codewords = QRCode::ReadCodewords(bits, *version, format);
	if (codewords.empty())
		return FormatError("Failed to read codewords");
	auto blocks = QRCode::DataBlock::GetDataBlocks(codewords, *version, format.ecLevel);
	if (blocks.empty())
		return FormatError("Failed to deinterleave codewords");
	size_t dataSize = 0;
	for (const auto& block : blocks)
		dataSize += block.numDataCodewords();
	ByteArray data(dataSize);
	auto dst = data.begin();
	for (const auto& block : blocks)
		dst = std::copy_n(block.codewords().begin(), block.numDataCodewords(), dst);
	return QRCode::DecodeBitStream(std::move(data), *version, format.ecLevel);
}

static const std::array<uint32_t, 256> CRC32_TABLE = [] {
	std::array<uint32_t, 256> table{};
	for (uint32_t value = 0; value < table.size(); ++value) {
		uint32_t crc = value;
		for (int bit = 0; bit < 8; ++bit)
			crc = (crc >> 1) ^ ((crc & 1u) ? 0xedb88320u : 0u);
		table[value] = crc;
	}
	return table;
}();

static uint32_t crc32(const uint8_t* data, size_t size)
{
	uint32_t crc = 0xffffffffu;
	for (size_t i = 0; i < size; ++i)
		crc = (crc >> 8) ^ CRC32_TABLE[(crc ^ data[i]) & 0xffu];
	return ~crc;
}

static bool hasValidCRC32(const ByteArray& bytes)
{
	if (bytes.size() < 4)
		return false;
	size_t n = bytes.size() - 4;
	uint32_t expected = uint32_t(bytes[n]) | uint32_t(bytes[n + 1]) << 8 |
						uint32_t(bytes[n + 2]) << 16 | uint32_t(bytes[n + 3]) << 24;
	return crc32(bytes.data(), n) == expected;
}

constexpr int FAST_THRESH_TILES = 8;
constexpr int FAST_TILE_SAMPLES = 4;

struct FastThresholdGrid
{
	int t[FAST_THRESH_TILES][FAST_THRESH_TILES]{};
	bool ok = false;
};

template <class LumAt>
static FastThresholdGrid buildFastThresholds(const PersistentTrack& track, const LumAt& lumAt)
{
	FastThresholdGrid grid;
	int lo[FAST_THRESH_TILES][FAST_THRESH_TILES];
	int hi[FAST_THRESH_TILES][FAST_THRESH_TILES];
	int globalMin = 255, globalMax = 0;
	const int dim = track.dimension;

	for (int ty = 0; ty < FAST_THRESH_TILES; ++ty)
		for (int tx = 0; tx < FAST_THRESH_TILES; ++tx) {
			lo[ty][tx] = 255;
			hi[ty][tx] = 0;
			for (int sy = 0; sy < FAST_TILE_SAMPLES; ++sy)
				for (int sx = 0; sx < FAST_TILE_SAMPLES; ++sx) {
					const double fx = (tx + (sx + 0.5) / FAST_TILE_SAMPLES) / FAST_THRESH_TILES;
					const double fy = (ty + (sy + 0.5) / FAST_TILE_SAMPLES) / FAST_THRESH_TILES;
					const int mx = std::clamp(int(fx * dim), 0, dim - 1);
					const int my = std::clamp(int(fy * dim), 0, dim - 1);
					const auto& p = track.samples[my * dim + mx];
					const int lum = lumAt(p.x + track.dx, p.y + track.dy);
					if (lum < 0)
						continue;
					lo[ty][tx] = std::min(lo[ty][tx], lum);
					hi[ty][tx] = std::max(hi[ty][tx], lum);
				}
			if (hi[ty][tx] >= lo[ty][tx]) {
				globalMin = std::min(globalMin, lo[ty][tx]);
				globalMax = std::max(globalMax, hi[ty][tx]);
			}
		}

	if (globalMax - globalMin < 24)
		return grid;

	const int global = (globalMin + globalMax) / 2;
	for (int ty = 0; ty < FAST_THRESH_TILES; ++ty)
		for (int tx = 0; tx < FAST_THRESH_TILES; ++tx)
			grid.t[ty][tx] = hi[ty][tx] >= lo[ty][tx] && hi[ty][tx] - lo[ty][tx] >= 24
				? (lo[ty][tx] + hi[ty][tx]) / 2
				: global;

	grid.ok = true;
	return grid;
}

template <class LumAt>
static ByteArray decodeCachedTrack(PersistentTrack& track, const LumAt& lumAt, DecimenBatchMetrics& measured)
{
	++measured.alignmentFitAttempts;
	const auto thresholds = buildFastThresholds(track, lumAt);
	if (!thresholds.ok) {
		++measured.bitstreamFailures;
		return {};
	}

	const int dim = track.dimension;
	const double sampleStarted = emscripten_get_now();
	bool inFrame = true;
	for (int y = 0; y < dim && inFrame; ++y)
		for (int x = 0; x < dim; ++x) {
			const auto& p = track.samples[y * dim + x];
			const int lum = lumAt(p.x + track.dx, p.y + track.dy);
			if (lum < 0) {
				inFrame = false;
				break;
			}
			const int threshold = thresholds.t[
				std::clamp(y * FAST_THRESH_TILES / dim, 0, FAST_THRESH_TILES - 1)
			][
				std::clamp(x * FAST_THRESH_TILES / dim, 0, FAST_THRESH_TILES - 1)
			];
			track.sampled.set(x, y, lum <= threshold);
		}
	measured.samples += dim * dim;
	measured.samplingMs += emscripten_get_now() - sampleStarted;
	if (!inFrame) {
		++measured.outOfFrameMisses;
		return {};
	}

	auto packetFromBytes = [&](const ByteArray& bytes) {
		ByteArray packet;
		if (bytes.size() <= 4)
			return packet;
		const double crcStarted = emscripten_get_now();
		const bool crcOK = hasValidCRC32(bytes);
		measured.crcMs += emscripten_get_now() - crcStarted;
		if (!crcOK) {
			++measured.crcFailures;
			return packet;
		}
		packet.resize(bytes.size() - 4);
		std::copy_n(bytes.begin(), bytes.size() - 4, packet.begin());
		return packet;
	};

	// Cheapest possible interpretation first: no QR Reed-Solomon. A pristine
	// sampled matrix still exits here.
	const double bitsStarted = emscripten_get_now();
	auto fast = decodeWithoutErrorCorrection(track.sampled);
	measured.bitExtractionMs += emscripten_get_now() - bitsStarted;
	if (fast.isValid()) {
		auto packet = packetFromBytes(fast.content().bytes);
		if (!packet.empty()) {
			++measured.alignmentFitSuccesses;
			return packet;
		}
	} else {
		++measured.bitstreamFailures;
	}

	// At high optical density a v40 matrix can contain a few bad modules even
	// when its geometry is perfectly usable. Do not run a detector, re-sample,
	// or recalibrate for that. Apply QR's own error correction directly to the
	// already-cached matrix, then require the AirGapper CRC as the final oracle.
	if (!track.calibrated)
		return {};

	const double rsStarted = emscripten_get_now();
	auto corrected = QRCode::Decode(track.sampled);
	measured.rsFallbackMs += emscripten_get_now() - rsStarted;
	++measured.rsFallbacks;
	if (!corrected.isValid())
		return {};

	auto packet = packetFromBytes(corrected.content().bytes);
	if (!packet.empty())
		++measured.alignmentFitSuccesses;
	return packet;
}

template <class LumAt>
static int decodeBatchCachedY(TrackedDecoder& decoder, const LumAt& lumAt,
                                      DecimenTrackedResult* results, int resultCapacity,
                                      uint8_t* output, int outputCapacity, DecimenBatchMetrics* metrics)
{
    DecimenBatchMetrics measured{};
    const double totalStart = emscripten_get_now();
    int resultCount = 0;
    int outputUsed = 0;

    struct PendingTrack {
        PersistentTrack* track = nullptr;
        DecimenTrackedResult* result = nullptr;
    };
    std::vector<PendingTrack> pending;
    pending.reserve(decoder.tracks.size());

    auto tryTrack = [&](PersistentTrack& track, DecimenTrackedResult& result) {
        ByteArray packet = track.crc32Payload ? decodeCachedTrack(track, lumAt, measured) : ByteArray{};
        if (packet.empty())
            return false;
        if (outputUsed + int(packet.size()) > outputCapacity) {
            result.status = DECIMEN_TRACK_OUTPUT_FULL;
            result.bytesOffset = -1;
            return true;
        }
        std::memcpy(output + outputUsed, packet.data(), packet.size());
        result.status = DECIMEN_TRACK_OK;
        result.bytesOffset = outputUsed;
        result.bytesLength = packet.size();
        outputUsed += packet.size();
        track.consecutiveMisses = 0;
        result.consecutiveMisses = 0;
        result.dx = track.dx;
        result.dy = track.dy;
        ++measured.successful;
        ++measured.crcFastSuccesses;
        return true;
    };

    // First try the last CRC-confirmed transform. Most frames should pay no
    // finder-search cost at all. Only a lane with misses enters motion search.
    for (auto& track : decoder.tracks) {
        if (!track.active || resultCount >= resultCapacity)
            continue;
        auto& result = results[resultCount++];
        ++measured.tracks;
        ++track.framesSinceReacquire;
        result = {track.id, DECIMEN_TRACK_MISS, outputUsed, 0, track.consecutiveMisses,
                  track.framesSinceReacquire, track.dx, track.dy};
        if (!tryTrack(track, result))
            pending.push_back({&track, &result});
    }

    // Handheld motion is shared by all QRs in a lane. Do not independently
    // run the expensive +/-6px finder search for every QR. Pick the healthiest
    // missed calibrated track, estimate one translation, then move all cached
    // maps by that delta and retry only the misses.
    if (!pending.empty() && pending.size() == measured.tracks) {
        PendingTrack* reference = nullptr;
        for (auto& candidate : pending) {
            if (!candidate.track->crc32Payload || !candidate.track->calibrated)
                continue;
            if (!reference || candidate.track->consecutiveMisses < reference->track->consecutiveMisses)
                reference = &candidate;
        }

        if (reference) {
            auto& ref = *reference->track;
            const float oldX = ref.dx, oldY = ref.dy;
            AnchorReading motion;
            ++measured.translationAttempts;
            const double motionStarted = emscripten_get_now();
            const bool tracked = refineAnchor(ref, lumAt, motion);
            measured.anchorMs += emscripten_get_now() - motionStarted;
            if (tracked) {
                ++measured.translationSuccesses;
                const float deltaX = ref.dx - oldX;
                const float deltaY = ref.dy - oldY;
                const bool moved = std::abs(deltaX) > 0.01f || std::abs(deltaY) > 0.01f;
                if (moved) {
                    for (auto& track : decoder.tracks) {
                        if (!track.active || &track == &ref)
                            continue;
                        track.dx += deltaX;
                        track.dy += deltaY;
                    }
                    std::vector<PendingTrack> stillPending;
                    stillPending.reserve(pending.size());
                    for (auto& candidate : pending) {
                        if (!tryTrack(*candidate.track, *candidate.result))
                            stillPending.push_back(candidate);
                    }
                    pending = std::move(stillPending);
                }
            } else {
                ref.dx = oldX;
                ref.dy = oldY;
            }
        }
    }

    // Miss accounting is final-state only. A QR recovered by the shared motion
    // retry is a success, not both a miss and a success in the same frame.
    for (auto& candidate : pending) {
        auto& track = *candidate.track;
        auto& result = *candidate.result;
        ++track.consecutiveMisses;
        ++measured.misses;
        result.consecutiveMisses = track.consecutiveMisses;
        result.dx = track.dx;
        result.dy = track.dy;
    }

    measured.totalMs = emscripten_get_now() - totalStart;
    if (metrics)
        *metrics = measured;
    return resultCount;
}

static PerspectiveTransform trackedTransform(const PersistentTrack& track, float dx, float dy)
{
	const double dim = track.dimension;
	const PointF off{dx, dy};
	return PerspectiveTransform(
		QuadrilateralF{PointF{0, 0}, PointF{dim, 0}, PointF{dim, dim}, PointF{0, dim}},
		QuadrilateralF{track.topLeft + off, track.topRight + off, track.bottomRight + off, track.bottomLeft + off});
}


static std::optional<PointF> locateAlignmentPatternForCache(const BitMatrix& image, int moduleSize, PointF estimate)
{
	for (auto d : {PointF{0, 0}, {0, -1}, {0, 1}, {-1, 0}, {1, 0}, {-1, -1}, {1, -1}, {1, 1}, {-1, 1}}) {
		auto p = estimate + moduleSize * 2.25 * d;
		if (!image.isIn(p))
			continue;
		auto cor = CenterOfRing(image, PointI(p), moduleSize * 3, 1, false);
		if (!cor || !image.get(*cor))
			continue;
		if (auto cor1 = CenterOfRing(image, PointI(*cor), moduleSize * 2, 1))
			if (auto cor2 = CenterOfRing(image, PointI(*cor), moduleSize * 3, 2))
				if (distance(*cor1, *cor2) < moduleSize / 2.0 && cor2->size > cor1->size)
					return (*cor1 + *cor2) / 2;
	}
	return {};
}

static const QRCode::FinderPatternSet* finderSetForTrack(
	const PersistentTrack& track, const QRCode::FinderPatternSets& sets)
{
	auto expected = trackedTransform(track, track.dx, track.dy);
	if (!expected.isValid())
		return nullptr;
	const double dim = track.dimension;
	const PointF expectedTL = expected(PointF{3.5, 3.5});
	const PointF expectedTR = expected(PointF{dim - 3.5, 3.5});
	const PointF expectedBL = expected(PointF{3.5, dim - 3.5});
	const QRCode::FinderPatternSet* best = nullptr;
	double bestScore = 1e30;
	for (const auto& fp : sets) {
		const double dTL = distance(fp.tl, expectedTL);
		const double dTR = distance(fp.tr, expectedTR);
		const double dBL = distance(fp.bl, expectedBL);
		const double finderSize = (fp.tl.size + fp.tr.size + fp.bl.size) / 3.0;
		const double gate = std::max(10.0, finderSize * 2.5);
		if (std::max({dTL, dTR, dBL}) > gate)
			continue;
		const double score = dTL * dTL + dTR * dTR + dBL * dBL;
		if (score < bestScore) {
			bestScore = score;
			best = &fp;
		}
	}
	return best;
}

// Spend the expensive image analysis once, then keep the actual module-center
// coordinates. Calibration is seeded by zxing-cpp's REAL finder detections,
// not finder patterns synthesized back from an already-warped outer quad.
// This preserves the information SampleQR uses to survive lens distortion.
static bool calibrateTrackSampleMap(PersistentTrack& track, const BitMatrix& image,
										 const QRCode::FinderPatternSet& fp)
{
	const int dim = track.dimension;
	const int versionNumber = (dim - 17) / 4;
	const auto* version = QRCode::Version::Model2(versionNumber);
	if (!version)
		return false;
	const auto& apM = version->alignmentPatternCenters();
	if (apM.size() < 2)
		return false;

	// Use the old tracked quad only to predict the bottom-right alignment
	// pattern. The transform itself is then rebuilt from the three measured
	// finder patterns plus that measured alignment point, matching SampleQR's
	// geometry convention (bottom-right is three modules inward).
	auto seed = trackedTransform(track, track.dx, track.dy);
	if (!seed.isValid())
		return false;
	const int N = int(apM.size()) - 1;
	const double finderModule = (fp.tl.size + fp.tr.size + fp.bl.size) / (3.0 * 7.0);
	const int moduleSize = std::max(1, int(std::lround(finderModule)));
	PointF br = fp.tr - fp.tl + fp.bl;
	PointF brOffset{0, 0};
	const auto brEstimate = seed(centered(PointI(apM[N], apM[N])));
	if (auto found = locateAlignmentPatternForCache(image, moduleSize, brEstimate)) {
		br = *found;
		brOffset = PointF{3, 3};
	}
	const auto moduleQuad = [&] {
		auto q = Rectangle(dim, dim, 3.5);
		q[2] = q[2] - brOffset;
		return q;
	}();
	PerspectiveTransform base(moduleQuad, QuadrilateralF{fp.tl, fp.tr, br, fp.bl});
	if (!base.isValid())
		return false;

	Matrix<std::optional<PointF>> apP(int(apM.size()), int(apM.size()));
	auto projectM2P = [&](int x, int y) { return base(centered(PointI(apM[x], apM[y]))); };

	// Same finder-control seeding used by SampleQR: the alignment-grid corner
	// nearest each projected control point is measured from the actual finder.
	auto seedFinderControl = [&](int x, int y, const ConcentricPattern& observed) {
		auto target = *apP.set(x, y, projectM2P(x, y));
		if (auto quad = FindConcentricPatternCorners(image, observed, observed.size, 2))
			for (auto c : *quad)
				if (distance(c, target) < observed.size / 2.0)
					apP.set(x, y, c);
	};
	seedFinderControl(0, 0, fp.tl);
	seedFinderControl(0, N, fp.bl);
	seedFinderControl(N, 0, fp.tr);

	auto bestGuess = [&](int x, int y) {
		if (auto p = apP(x, y))
			return *p;
		return projectM2P(x, y);
	};

	for (int y = 0; y <= N; ++y)
		for (int x = 0; x <= N; ++x) {
			if (apP(x, y))
				continue;
			PointF guessed = x * y == 0
				? bestGuess(x, y)
				: bestGuess(x - 1, y) + bestGuess(x, y - 1) - bestGuess(x - 1, y - 1);
			if (auto found = locateAlignmentPatternForCache(image, moduleSize, guessed))
				apP.set(x, y, *found);
		}

	// Fill difficult alignment locations from neighboring measured rows/cols,
	// exactly the information a single outer homography cannot represent.
	for (int y = 0; y <= N; ++y)
		for (int x = 0; x <= N; ++x) {
			if (apP(x, y))
				continue;
			std::vector<PointF> horizontal, vertical;
			for (int i = 2; i < 2 * N + 2 && horizontal.size() < 2; ++i) {
				int xi = x + i / 2 * (i % 2 ? 1 : -1);
				if (0 <= xi && xi <= N && apP(xi, y))
					horizontal.push_back(*apP(xi, y));
			}
			for (int i = 2; i < 2 * N + 2 && vertical.size() < 2; ++i) {
				int yi = y + i / 2 * (i % 2 ? 1 : -1);
				if (0 <= yi && yi <= N && apP(x, yi))
					vertical.push_back(*apP(x, yi));
			}
			if (horizontal.size() == 2 && vertical.size() == 2) {
				auto guessed = intersect(RegressionLine(horizontal[0], horizontal[1]), RegressionLine(vertical[0], vertical[1]));
				if (auto found = locateAlignmentPatternForCache(image, moduleSize, guessed))
					apP.set(x, y, *found);
				else
					apP.set(x, y, guessed);
			}
		}

	for (int y = 0; y <= N; ++y)
		for (int x = 0; x <= N; ++x)
			if (!apP(x, y))
				apP.set(x, y, projectM2P(x, y));

	std::vector<CachedSamplePoint> candidate(size_t(dim) * dim);
	BitMatrix sampled(dim, dim);
	for (int gy = 0; gy < N; ++gy)
		for (int gx = 0; gx < N; ++gx) {
			const int x0 = apM[gx], x1 = apM[gx + 1], y0 = apM[gy], y1 = apM[gy + 1];
			PerspectiveTransform cell(
				Rectangle(x0, x1, y0, y1, 0.5),
				QuadrilateralF{*apP(gx, gy), *apP(gx + 1, gy), *apP(gx + 1, gy + 1), *apP(gx, gy + 1)}
			);
			if (!cell.isValid())
				return false;
			const int sx0 = gx == 0 ? 0 : x0;
			const int sx1 = gx == N - 1 ? dim : x1;
			const int sy0 = gy == 0 ? 0 : y0;
			const int sy1 = gy == N - 1 ? dim : y1;
			for (int y = sy0; y < sy1; ++y)
				for (int x = sx0; x < sx1; ++x) {
					auto p = cell(centered(PointI{x, y}));
					if (!image.isIn(p))
						return false;
					candidate[size_t(y) * dim + x] = {float(p.x), float(p.y)};
					if (image.get(p))
						sampled.set(x, y);
				}
		}

	// Only cache a calibration that decodes the current AirGapper packet and
	// passes its CRC. At v40/high density, a geometrically correct sample can
	// still contain a few bad modules, so requiring a bit-perfect no-RS parse
	// here creates a catch-22: the map can never become calibrated and therefore
	// never reaches the cached QR-RS path. Calibration is rare setup work, so
	// validate with no-RS first, then QR Reed-Solomon before rejecting the map.
	auto decoded = decodeWithoutErrorCorrection(sampled);
	bool calibrationValid = decoded.isValid() && hasValidCRC32(decoded.content().bytes);
	if (!calibrationValid) {
		auto corrected = QRCode::Decode(sampled);
		calibrationValid = corrected.isValid() && hasValidCRC32(corrected.content().bytes);
	}
	if (!calibrationValid)
		return false;

	track.samples = std::move(candidate);
	track.sampled = std::move(sampled);
	track.dx = track.dy = 0;
	track.calibrated = true;
	track.calibrationCooldown = 0;
	track.consecutiveMisses = 0;
	return true;
}

static void addBatchMetrics(DecimenBatchMetrics& dst, const DecimenBatchMetrics& src)
{
	dst.anchorMs += src.anchorMs;
	dst.samplingMs += src.samplingMs;
	dst.bitExtractionMs += src.bitExtractionMs;
	dst.crcMs += src.crcMs;
	dst.rsFallbackMs += src.rsFallbackMs;
	dst.tracks += src.tracks;
	dst.samples += src.samples;
	dst.successful += src.successful;
	dst.misses += src.misses;
	dst.crcFastSuccesses += src.crcFastSuccesses;
	dst.rsFallbacks += src.rsFallbacks;
	dst.anchorSuccesses += src.anchorSuccesses;
	dst.anchorMisses += src.anchorMisses;
	dst.alignmentFitAttempts += src.alignmentFitAttempts;
	dst.outOfFrameMisses += src.outOfFrameMisses;
	dst.bitstreamFailures += src.bitstreamFailures;
	dst.crcFailures += src.crcFailures;
	dst.alignmentFitSuccesses += src.alignmentFitSuccesses;
	dst.anchorBypassAttempts += src.anchorBypassAttempts;
	dst.anchorBypassSuccesses += src.anchorBypassSuccesses;
	dst.translationAttempts += src.translationAttempts;
	dst.translationSuccesses += src.translationSuccesses;
	dst.calibrationAttempts += src.calibrationAttempts;
	dst.calibrationSuccesses += src.calibrationSuccesses;
}

// The persistent hot path intentionally uses the same two pixel operations as
// the known-good matrix oracle: HybridBinarizer + SampleGrid. Detection is
// still skipped entirely. The old sparse tile-threshold sampler was faster in
// synthetic frames but produced invalid format/bitstream data on real camera
// input, so optimizing it only hid a correctness bug.
static int decodeBatchBinarized(TrackedDecoder& decoder, const BitMatrix& imageBits, DecimenTrackedResult* results,
							 int resultCapacity, uint8_t* output, int outputCapacity, DecimenBatchMetrics* metrics)
{
	DecimenBatchMetrics measured{};
	const double totalStart = emscripten_get_now();
	int resultCount = 0, outputUsed = 0, budgetedFallbacks = 0;
	const size_t trackSlots = decoder.tracks.size();

	for (size_t step = 0; step < trackSlots; ++step) {
		auto& track = decoder.tracks[(decoder.fallbackCursor + step) % trackSlots];
		if (!track.active || resultCount >= resultCapacity)
			continue;

		auto& result = results[resultCount++];
		result = {track.id, DECIMEN_TRACK_MISS, outputUsed, 0, track.consecutiveMisses,
				  track.framesSinceReacquire, track.dx, track.dy};
		++measured.tracks;
		++track.framesSinceReacquire;
		const int dim = track.dimension;

		auto sampleGrid = [&](float dx, float dy) {
			const double sampleStarted = emscripten_get_now();
			auto detected = SampleGrid(imageBits, dim, dim, trackedTransform(track, dx, dy));
			measured.samples += dim * dim;
			measured.samplingMs += emscripten_get_now() - sampleStarted;
			if (!detected.isValid())
				return false;
			track.sampled = std::move(detected).bits();
			return true;
		};

		auto fastDecode = [&]() {
			ByteArray fastPacket;
			double fastStarted = emscripten_get_now();
			auto fast = decodeWithoutErrorCorrection(track.sampled);
			measured.bitExtractionMs += emscripten_get_now() - fastStarted;
			if (!fast.isValid()) {
				++measured.bitstreamFailures;
				return fastPacket;
			}
			const auto& bytes = fast.content().bytes;
			fastStarted = emscripten_get_now();
			const bool crcOK = hasValidCRC32(bytes);
			measured.crcMs += emscripten_get_now() - fastStarted;
			if (!crcOK) {
				++measured.crcFailures;
				return fastPacket;
			}
			fastPacket.assign(bytes.begin(), bytes.end() - 4);
			++measured.crcFastSuccesses;
			return fastPacket;
		};

		// First attempt is always the last CRC-confirmed geometry. This is the
		// actual hot path: no finder scan, no detector and no Reed-Solomon.
		++measured.anchorBypassAttempts;
		if (!sampleGrid(track.dx, track.dy)) {
			++track.consecutiveMisses;
			++measured.misses;
			++measured.outOfFrameMisses;
			result.consecutiveMisses = track.consecutiveMisses;
			continue;
		}

		ByteArray packet;
		if (track.crc32Payload) {
			packet = fastDecode();
			if (!packet.empty())
				++measured.anchorBypassSuccesses;
		}

		// Only after a cached-grid CRC miss do we spend work refining motion.
		// Crucially, an anchor candidate is not committed unless the resulting
		// matrix also passes the packet CRC. Finder confidence can therefore
		// never poison future tracked geometry.
		const float trustedDx = track.dx, trustedDy = track.dy;
		if (track.crc32Payload && packet.empty()) {
			AnchorReading anchor;
			auto binaryLumAt = [&](float fx, float fy) {
				const PointF p{fx, fy};
				return imageBits.isIn(p) ? (imageBits.get(p) ? 0 : 255) : -1;
			};
			const double anchorStarted = emscripten_get_now();
			const bool anchored = refineAnchor(track, binaryLumAt, anchor);
			measured.anchorMs += emscripten_get_now() - anchorStarted;
			if (anchored) {
				++measured.anchorSuccesses;
				const bool moved = std::abs(track.dx - trustedDx) > 0.01f || std::abs(track.dy - trustedDy) > 0.01f;
				if (moved) {
					if (sampleGrid(track.dx, track.dy))
						packet = fastDecode();
				}
			} else {
				++measured.anchorMisses;
			}
			if (packet.empty()) {
				track.dx = trustedDx;
				track.dy = trustedDy;
			}
		}

		const bool allowRS = !track.crc32Payload || budgetedFallbacks < decoder.maxRSFallbacks;
		if (packet.empty() && allowRS) {
			if (track.crc32Payload)
				++budgetedFallbacks;
			// If a failed refinement changed the sampled matrix, restore the
			// trusted geometry before any non-AirGapper compatibility RS decode.
			if (!track.crc32Payload)
				sampleGrid(track.dx, track.dy);
			const double rsStarted = emscripten_get_now();
			auto decoded = QRCode::Decode(track.sampled);
			measured.rsFallbackMs += emscripten_get_now() - rsStarted;
			++measured.rsFallbacks;
			if (decoded.isValid()) {
				const auto& bytes = decoded.content().bytes;
				if (!track.crc32Payload) {
					packet.assign(bytes.begin(), bytes.end());
				} else {
					const double crcStarted = emscripten_get_now();
					const bool crcOK = hasValidCRC32(bytes);
					measured.crcMs += emscripten_get_now() - crcStarted;
					if (crcOK)
						packet.assign(bytes.begin(), bytes.end() - 4);
				}
			}
		}

		if (packet.empty()) {
			++track.consecutiveMisses;
			++measured.misses;
			result.consecutiveMisses = track.consecutiveMisses;
			result.dx = track.dx;
			result.dy = track.dy;
			continue;
		}

		if (outputUsed + int(packet.size()) > outputCapacity) {
			result.status = DECIMEN_TRACK_OUTPUT_FULL;
			result.bytesOffset = -1;
		} else {
			std::memcpy(output + outputUsed, packet.data(), packet.size());
			result.status = DECIMEN_TRACK_OK;
			result.bytesOffset = outputUsed;
			result.bytesLength = packet.size();
			outputUsed += packet.size();
			++measured.successful;
		}
		track.consecutiveMisses = 0;
		result.consecutiveMisses = 0;
		result.framesSinceReacquire = track.framesSinceReacquire;
		result.dx = track.dx;
		result.dy = track.dy;
	}

	if (trackSlots)
		decoder.fallbackCursor = (decoder.fallbackCursor + std::max(1, decoder.maxRSFallbacks)) % trackSlots;
	measured.totalMs = emscripten_get_now() - totalStart;
	if (metrics)
		*metrics = measured;
	return resultCount;
}

} // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE int createTrackedDecoder(int maxTracks, int maxDimension)
{
	if (maxTracks <= 0 || maxTracks > 256 || maxDimension < 21 || maxDimension > 177)
		return 0;
	try {
		auto decoder = std::make_unique<TrackedDecoder>();
		decoder->maxDimension = maxDimension;
		decoder->tracks.resize(maxTracks);
		return static_cast<int>(reinterpret_cast<uintptr_t>(decoder.release()));
	} catch (...) {
		return 0;
	}
}

EMSCRIPTEN_KEEPALIVE void destroyTrackedDecoder(int handle)
{
	delete trackedDecoder(handle);
}

EMSCRIPTEN_KEEPALIVE int setTrackedDecoderTrack(int handle, int slot, int id, int dimension,
											 float x0, float y0, float x1, float y1,
											 float x2, float y2, float x3, float y3)
{
	auto* decoder = trackedDecoder(handle);
	if (!decoder || slot < 0 || slot >= int(decoder->tracks.size()) || dimension < 21 ||
		dimension > decoder->maxDimension || (dimension - 17) % 4)
		return 0;
	try {
		PerspectiveTransform transform(
			QuadrilateralF{PointF{0, 0}, PointF{double(dimension), 0}, PointF{double(dimension), double(dimension)},
						   PointF{0, double(dimension)}},
			QuadrilateralF{PointF{x0, y0}, PointF{x1, y1}, PointF{x2, y2}, PointF{x3, y3}});
		if (!transform.isValid())
			return 0;
		auto& track = decoder->tracks[slot];
		track.topLeft = PointF{x0, y0};
		track.topRight = PointF{x1, y1};
		track.bottomRight = PointF{x2, y2};
		track.bottomLeft = PointF{x3, y3};
		track.samples.resize(dimension * dimension);
		for (int y = 0; y < dimension; ++y)
			for (int x = 0; x < dimension; ++x) {
				auto& cached = track.samples[y * dimension + x];
				auto p = transform(PointF{x + 0.5, y + 0.5});
				cached.x = float(p.x);
				cached.y = float(p.y);
			}
		auto center = transform(PointF{dimension / 2.0, dimension / 2.0});
		auto adjacent = transform(PointF{dimension / 2.0 + 1.0, dimension / 2.0});
		track.multiSample = std::hypot(adjacent.x - center.x, adjacent.y - center.y) < 2.75;
		track.calibrated = false;
		track.calibrationCooldown = 0;
		track.sampled = BitMatrix(dimension, dimension);
		track.id = id;
		track.dimension = dimension;
		track.dx = track.dy = 0;
		track.consecutiveMisses = track.framesSinceReacquire = 0;
		track.active = true;
		return 1;
	} catch (...) {
		return 0;
	}
}

EMSCRIPTEN_KEEPALIVE void clearTrackedDecoderTrack(int handle, int slot)
{
	auto* decoder = trackedDecoder(handle);
	if (decoder && slot >= 0 && slot < int(decoder->tracks.size()))
		decoder->tracks[slot].active = false;
}

EMSCRIPTEN_KEEPALIVE int setTrackedDecoderSampleMap(int handle, int slot, const float* xy, int pointCount)
{
	auto* decoder = trackedDecoder(handle);
	if (!decoder || !xy || slot < 0 || slot >= int(decoder->tracks.size()))
		return 0;
	auto& track = decoder->tracks[slot];
	if (!track.active || pointCount != track.dimension * track.dimension)
		return 0;
	for (int i = 0; i < pointCount; ++i) {
		track.samples[i].x = xy[i * 2];
		track.samples[i].y = xy[i * 2 + 1];
	}
	track.multiSample = false;
	track.calibrated = true;
	track.calibrationCooldown = 0;
	track.dx = track.dy = 0;
	track.consecutiveMisses = track.framesSinceReacquire = 0;
	return 1;
}

EMSCRIPTEN_KEEPALIVE void setTrackedDecoderTrackCRC32(int handle, int slot, int enabled)
{
	auto* decoder = trackedDecoder(handle);
	if (decoder && slot >= 0 && slot < int(decoder->tracks.size()))
		decoder->tracks[slot].crc32Payload = enabled != 0;
}

EMSCRIPTEN_KEEPALIVE void setTrackedDecoderFallbackBudget(int handle, int maxRSFallbacksPerFrame)
{
	auto* decoder = trackedDecoder(handle);
	if (decoder)
		decoder->maxRSFallbacks = std::clamp(maxRSFallbacksPerFrame, 0, int(decoder->tracks.size()));
}

EMSCRIPTEN_KEEPALIVE int decodeTrackedBatchY(int handle, const uint8_t* yPlane, int width, int height, int stride,
											 DecimenTrackedResult* results, int resultCapacity,
											 uint8_t* output, int outputCapacity, DecimenBatchMetrics* metrics)
{
	auto* decoder = trackedDecoder(handle);
	if (!decoder || !yPlane || width <= 0 || height <= 0 || stride < width || !results || resultCapacity < 0 ||
		!output || outputCapacity < 0)
		return -1;
	try {
		const double totalStart = emscripten_get_now();
		auto lumAt = [&](float fx, float fy) {
			const int x = int(fx), y = int(fy);
			return x < 0 || y < 0 || x >= width || y >= height
				? -1
				: int(yPlane[size_t(y) * stride + x]);
		};

		DecimenBatchMetrics measured{};
		int count = decodeBatchCachedY(*decoder, lumAt, results, resultCapacity, output, outputCapacity, &measured);
		if (measured.tracks > 0 && measured.successful == measured.tracks) {
			measured.totalMs = emscripten_get_now() - totalStart;
			if (metrics) *metrics = measured;
			return count;
		}

		bool calibrationDue = false;
		for (auto& track : decoder->tracks) {
			if (!track.active)
				continue;
			if (track.calibrationCooldown > 0)
				--track.calibrationCooldown;
			if (!track.calibrated && track.calibrationCooldown == 0)
				calibrationDue = true;
		}
		if (!calibrationDue) {
			measured.totalMs = emscripten_get_now() - totalStart;
			if (metrics) *metrics = measured;
			return count;
		}

		// Calibration is initialization/reconfiguration work only. Ordinary CRC
		// misses are packet erasures; they must never trigger repeated expensive
		// geometry rebuilding on the steady-state camera path.
		const double binStarted = emscripten_get_now();
		ImageView lumView(yPlane, width, height, ImageFormat::Lum, stride, 1);
		HybridBinarizer binarized(lumView);
		auto bits = binarized.getBitMatrix();
		measured.anchorMs += emscripten_get_now() - binStarted;
		if (!bits) {
			measured.totalMs = emscripten_get_now() - totalStart;
			if (metrics) *metrics = measured;
			return count;
		}

		// Do the expensive finder scan once per lane calibration pass. Each track
		// then binds to the nearby real finder triplet instead of reconstructing
		// finder geometry from its outer quad.
		const double finderStarted = emscripten_get_now();
		auto finderPatterns = QRCode::FindFinderPatterns(*bits, true);
		auto finderSets = QRCode::GenerateFinderPatternSets(finderPatterns);
		measured.anchorMs += emscripten_get_now() - finderStarted;

		bool calibratedAny = false;
		for (auto& track : decoder->tracks) {
			if (!track.active || track.calibrationCooldown > 0 || track.calibrated)
				continue;
			++measured.calibrationAttempts;
			const double calibrationStarted = emscripten_get_now();
			const auto* finderSet = finderSetForTrack(track, finderSets);
			const bool ok = finderSet && calibrateTrackSampleMap(track, *bits, *finderSet);
			measured.anchorMs += emscripten_get_now() - calibrationStarted;
			if (ok) {
				++measured.anchorSuccesses;
				++measured.calibrationSuccesses;
				calibratedAny = true;
			} else {
				++measured.anchorMisses;
				track.calibrationCooldown = 4;
			}
		}

		if (calibratedAny) {
			DecimenBatchMetrics retry{};
			count = decodeBatchCachedY(*decoder, lumAt, results, resultCapacity, output, outputCapacity, &retry);
			addBatchMetrics(measured, retry);
		}
		measured.totalMs = emscripten_get_now() - totalStart;
		if (metrics) *metrics = measured;
		return count;
	} catch (...) {
		return -1;
	}
}

EMSCRIPTEN_KEEPALIVE int decodeTrackedBatchRGBA(int handle, const uint8_t* rgba, int width, int height, int stride,
												DecimenTrackedResult* results, int resultCapacity,
												uint8_t* output, int outputCapacity, DecimenBatchMetrics* metrics)
{
	auto* decoder = trackedDecoder(handle);
	if (!decoder || !rgba || width <= 0 || height <= 0 || stride < width * 4 || !results || resultCapacity < 0 ||
		!output || outputCapacity < 0)
		return -1;
	try {
		const double binStarted = emscripten_get_now();
		std::vector<uint8_t> lum(size_t(width) * height);
		for (int y = 0; y < height; ++y) {
			const uint8_t* src = rgba + size_t(y) * stride;
			uint8_t* dst = lum.data() + size_t(y) * width;
			for (int x = 0; x < width; ++x, src += 4)
				dst[x] = RGBToLum(src[0], src[1], src[2]);
		}
		ImageView lumView(lum.data(), width, height, ImageFormat::Lum);
		HybridBinarizer binarized(lumView);
		auto bits = binarized.getBitMatrix();
		const double binMs = emscripten_get_now() - binStarted;
		if (!bits)
			return -1;
		const int count = decodeBatchBinarized(*decoder, *bits, results, resultCapacity, output, outputCapacity, metrics);
		if (metrics) {
			metrics->samplingMs += binMs;
			metrics->totalMs += binMs;
		}
		return count;
	} catch (...) {
		return -1;
	}
}

} // extern "C"

/** Debug: the raw sampled module grid for a quad, row-major 0/1 — lets a
 *  test diff the sample against ground truth to localize errors. */
emscripten::val trackedMatrix(int bufferPtr, int width, int height, int dim, double x0, double y0, double x1,
							  double y1, double x2, double y2, double x3, double y3)
{
	ImageView iv(reinterpret_cast<uint8_t*>(bufferPtr), width, height, ImageFormat::RGBA);
	auto lum = toLum(iv);
	ImageView lumView(lum.data(), width, height, ImageFormat::Lum);
	HybridBinarizer binarized(lumView);
	auto bits = binarized.getBitMatrix();
	if (!bits)
		return emscripten::val::null();
	PerspectiveTransform mod2Pix(
		QuadrilateralF{PointF{0, 0}, PointF{double(dim), 0}, PointF{double(dim), double(dim)},
					   PointF{0, double(dim)}},
		QuadrilateralF{PointF{x0, y0}, PointF{x1, y1}, PointF{x2, y2}, PointF{x3, y3}});
	auto detected = SampleGrid(*bits, dim, dim, mod2Pix);
	if (!detected.isValid())
		return emscripten::val::null();
	std::vector<uint8_t> out(dim * dim);
	for (int y = 0; y < dim; y++)
		for (int x = 0; x < dim; x++)
			out[y * dim + x] = detected.bits().get(x, y);
	return toUint8Array(out);
}

/** Debug: project one module-space point through the same transform the
 *  tracked path builds — isolates transform construction from sampling. */
emscripten::val projectPoint(int dim, double x0, double y0, double x1, double y1, double x2, double y2, double x3,
							 double y3, double mx, double my)
{
	PerspectiveTransform mod2Pix(
		QuadrilateralF{PointF{0, 0}, PointF{double(dim), 0}, PointF{double(dim), double(dim)},
					   PointF{0, double(dim)}},
		QuadrilateralF{PointF{x0, y0}, PointF{x1, y1}, PointF{x2, y2}, PointF{x3, y3}});
	auto p = mod2Pix(PointF{mx, my});
	emscripten::val out = emscripten::val::object();
	out.set("x", p.x);
	out.set("y", p.y);
	out.set("valid", mod2Pix.isValid());
	return out;
}

/** Debug: one row of the binarized matrix, 0/1 per pixel. */
emscripten::val binarizedRow(int bufferPtr, int width, int height, int y)
{
	ImageView iv(reinterpret_cast<uint8_t*>(bufferPtr), width, height, ImageFormat::RGBA);
	auto lum = toLum(iv);
	ImageView lumView(lum.data(), width, height, ImageFormat::Lum);
	HybridBinarizer binarized(lumView);
	auto bits = binarized.getBitMatrix();
	if (!bits)
		return emscripten::val::null();
	std::vector<uint8_t> out(width);
	for (int x = 0; x < width; x++)
		out[x] = bits->get(x, y);
	return toUint8Array(out);
}

EMSCRIPTEN_BINDINGS(DecimenCodec)
{
	using namespace emscripten;

	value_object<DecimenResult>("DecimenResult")
		.field("valid", &DecimenResult::valid)
		.field("error", &DecimenResult::error)
		.field("bytes", &DecimenResult::bytes)
		.field("position", &DecimenResult::position)
		.field("modules", &DecimenResult::modules);

	value_object<PointI>("Point").field("x", &PointI::x).field("y", &PointI::y);

	value_object<Position>("Position")
		.field("topLeft", emscripten::index<0>())
		.field("topRight", emscripten::index<1>())
		.field("bottomRight", emscripten::index<2>())
		.field("bottomLeft", emscripten::index<3>());

	register_vector<DecimenResult>("vector<DecimenResult>");

	function("version", &codecVersion);
	function("build", &codecBuild);
	function("readFull", &readFull);
	function("readFullY", &readFullY);
	function("readDenseY", &readDenseY);
	function("readTracked", &readTracked);
	function("trackedMatrix", &trackedMatrix);
	function("projectPoint", &projectPoint);
	function("binarizedRow", &binarizedRow);
};
