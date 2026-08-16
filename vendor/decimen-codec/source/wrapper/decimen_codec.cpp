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
#include "DetectorResult.h"
#include "Content.h"
#include "qrcode/QRDecoder.h"
#include "qrcode/QRDetector.h"
#include "qrcode/QRBitMatrixParser.h"
#include "qrcode/QRDataBlock.h"
#include "qrcode/QRFormatInformation.h"
#include "qrcode/QRVersion.h"
#include "ByteArray.h"
#include "decimen_codec.h"

#include <algorithm>
#include <cmath>
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

	const double bitsStarted = emscripten_get_now();
	auto decoded = decodeWithoutErrorCorrection(track.sampled);
	measured.bitExtractionMs += emscripten_get_now() - bitsStarted;
	if (!decoded.isValid()) {
		++measured.bitstreamFailures;
		return {};
	}

	const auto& bytes = decoded.content().bytes;
	const double crcStarted = emscripten_get_now();
	const bool crcOK = hasValidCRC32(bytes);
	measured.crcMs += emscripten_get_now() - crcStarted;
	if (!crcOK) {
		++measured.crcFailures;
		return {};
	}

	++measured.alignmentFitSuccesses;
	ByteArray packet(int(bytes.size() - 4));
	std::copy_n(bytes.begin(), bytes.size() - 4, packet.begin());
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

	for (auto& track : decoder.tracks) {
		if (!track.active || resultCount >= resultCapacity)
			continue;

		auto& result = results[resultCount++];
		++measured.tracks;
		++track.framesSinceReacquire;
		result = {track.id, DECIMEN_TRACK_MISS, outputUsed, 0, track.consecutiveMisses,
				  track.framesSinceReacquire, track.dx, track.dy};

		// The distortion map is persistent, but a handheld camera is not. Before
		// touching the full module grid, align the three invariant finder patterns
		// and apply that cheap translation to every cached sample point. On a
		// stable frame this is only 147 luminance reads.
		if (track.crc32Payload) {
			++measured.translationAttempts;
			AnchorReading motion;
			const double motionStarted = emscripten_get_now();
			const bool tracked = refineAnchor(track, lumAt, motion);
			measured.anchorMs += emscripten_get_now() - motionStarted;
			if (tracked)
				++measured.translationSuccesses;
		}

		ByteArray packet = track.crc32Payload ? decodeCachedTrack(track, lumAt, measured) : ByteArray{};
		if (packet.empty()) {
			++track.consecutiveMisses;
			++measured.misses;
			result.consecutiveMisses = track.consecutiveMisses;
			continue;
		}

		if (outputUsed + int(packet.size()) > outputCapacity) {
			result.status = DECIMEN_TRACK_OUTPUT_FULL;
			result.bytesOffset = -1;
			continue;
		}
		std::memcpy(output + outputUsed, packet.data(), packet.size());
		result.status = DECIMEN_TRACK_OK;
		result.bytesOffset = outputUsed;
		result.bytesLength = packet.size();
		outputUsed += packet.size();
		track.consecutiveMisses = 0;
		result.consecutiveMisses = 0;
		++measured.successful;
		++measured.crcFastSuccesses;
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

// Spend the expensive image analysis once, then keep the actual module-center
// coordinates. This mirrors zxing-cpp's alignment-pattern tiled sampler, but
// stores the resulting coordinates instead of throwing them away after one
// decode. Subsequent frames never need HybridBinarizer or SampleGrid.
static bool calibrateTrackSampleMap(PersistentTrack& track, const BitMatrix& image)
{
	const int dim = track.dimension;
	const int versionNumber = (dim - 17) / 4;
	const auto* version = QRCode::Version::Model2(versionNumber);
	if (!version)
		return false;
	const auto& apM = version->alignmentPatternCenters();
	if (apM.size() < 2)
		return false;

	auto base = trackedTransform(track, track.dx, track.dy);
	if (!base.isValid())
		return false;
	const int N = int(apM.size()) - 1;
	Matrix<std::optional<PointF>> apP(int(apM.size()), int(apM.size()));
	auto projectM2P = [&](int x, int y) { return base(centered(PointI(apM[x], apM[y]))); };

	auto center = base(PointF{dim / 2.0, dim / 2.0});
	auto right = base(PointF{dim / 2.0 + 1.0, dim / 2.0});
	auto down = base(PointF{dim / 2.0, dim / 2.0 + 1.0});
	const int moduleSize = std::max(1, int(std::lround((distance(center, right) + distance(center, down)) / 2.0)));

	auto fpSize = [&](double mx, double my) {
		auto a = base(PointF{mx - 3.5, my});
		auto b = base(PointF{mx + 3.5, my});
		return distance(a, b);
	};
	auto makeFp = [&](double mx, double my) {
		ConcentricPattern fp;
		static_cast<PointF&>(fp) = base(PointF{mx, my});
		fp.size = fpSize(mx, my);
		return fp;
	};
	auto seedFinderControl = [&](int x, int y, const ConcentricPattern& fp) {
		auto target = projectM2P(x, y);
		apP.set(x, y, target);
		if (auto quad = FindConcentricPatternCorners(image, fp, int(std::ceil(fp.size)), 2)) {
			double best = fp.size;
			for (auto c : *quad) {
				double d = distance(c, target);
				if (d < best) {
					best = d;
					apP.set(x, y, c);
				}
			}
		}
	};
	seedFinderControl(0, 0, makeFp(3.5, 3.5));
	seedFinderControl(0, N, makeFp(3.5, dim - 3.5));
	seedFinderControl(N, 0, makeFp(dim - 3.5, 3.5));

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
	// passes its CRC. A bad alignment fit therefore cannot poison later frames.
	auto decoded = decodeWithoutErrorCorrection(sampled);
	if (!decoded.isValid() || !hasValidCRC32(decoded.content().bytes))
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
			if ((!track.calibrated || track.consecutiveMisses >= 2) && track.calibrationCooldown == 0)
				calibrationDue = true;
		}
		if (!calibrationDue) {
			measured.totalMs = emscripten_get_now() - totalStart;
			if (metrics) *metrics = measured;
			return count;
		}

		// Calibration is off the steady-state path. It is paid only for a new
		// track or after repeated CRC misses, then its distortion-corrected
		// module map is reused by decodeBatchCachedY on following frames.
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

		bool calibratedAny = false;
		for (auto& track : decoder->tracks) {
			if (!track.active || track.calibrationCooldown > 0 || (track.calibrated && track.consecutiveMisses < 2))
				continue;
			++measured.calibrationAttempts;
			const double calibrationStarted = emscripten_get_now();
			const bool ok = calibrateTrackSampleMap(track, *bits);
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
	function("readTracked", &readTracked);
	function("trackedMatrix", &trackedMatrix);
	function("projectPoint", &projectPoint);
	function("binarizedRow", &binarizedRow);
};
