from pathlib import Path


def replace_exact(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    found = s.count(old)
    if found != count:
        raise SystemExit(f"{path}: expected {count} matches, got {found}: {old[:160]!r}")
    p.write_text(s.replace(old, new, count))

# Build/cache/runtime stamps.
replace_exact('index.html', 'v0.5.76', 'v0.5.77')
replace_exact('index.html', './main.js?build=v0.5.76', './main.js?build=v0.5.77')
replace_exact('main.js', 'const APP_BUILD = "v0.5.76";', 'const APP_BUILD = "v0.5.77";')
replace_exact('receive/main.js', 'const RECEIVER_RUNTIME_BUILD = "v0.5.76";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.77";')
replace_exact('sw.js', 'airgapper-static-js-v39', 'airgapper-static-js-v40')
replace_exact('vendor/decimen-codec/source/VERSION', '0.1.4', '0.1.5')

# More accurate diagnostics names for the new cached-map path.
replace_exact(
    'receive/main.js',
    'Misses   anchor ${hotPathAudit.anchorMisses} · frame ${hotPathAudit.outOfFrameMisses} · bitstream ${hotPathAudit.bitstreamFailures} · CRC ${hotPathAudit.crcFailures}\nSampler sparse CRC ${hotPathAudit.fastSamplerSuccesses}/${hotPathAudit.fastSamplerAttempts} · Hybrid fallback CRC ${hotPathAudit.anchorBypassSuccesses}/${hotPathAudit.anchorBypassAttempts}',
    'Calibration ${hotPathAudit.anchorSuccesses}/${hotPathAudit.anchorSuccesses + hotPathAudit.anchorMisses} · frame misses ${hotPathAudit.outOfFrameMisses} · bitstream ${hotPathAudit.bitstreamFailures} · CRC ${hotPathAudit.crcFailures}\nCached map CRC ${hotPathAudit.fastSamplerSuccesses}/${hotPathAudit.fastSamplerAttempts} · Hybrid fallback CRC ${hotPathAudit.anchorBypassSuccesses}/${hotPathAudit.anchorBypassAttempts}'
)

cpp = Path('vendor/decimen-codec/source/wrapper/decimen_codec.cpp')
s = cpp.read_text()

s = s.replace('#include "ReadBarcode.h"\n', '#include "ReadBarcode.h"\n#include "ConcentricFinder.h"\n#include "Matrix.h"\n#include "Quadrilateral.h"\n#include "RegressionLine.h"\n', 1)
s = s.replace('#include <memory>\n', '#include <memory>\n#include <optional>\n', 1)

old_track = '''\tbool multiSample = false;\n\tbool crc32Payload = false;\n\tPointF topLeft{};'''
new_track = '''\tbool multiSample = false;\n\tbool crc32Payload = false;\n\t// The outer quad is only the seed. Once alignment patterns have been\n\t// measured, samples[] becomes a distortion-corrected per-module map and\n\t// the hot path is just Y-plane point loads + threshold + bit extraction.\n\tbool calibrated = false;\n\tint calibrationCooldown = 0;\n\tPointF topLeft{};'''
if s.count(old_track) != 1:
    raise SystemExit('PersistentTrack insertion point not found')
s = s.replace(old_track, new_track, 1)

start = s.index('template <class LumAt>\nstatic int tryDecodeBatchSparseAll(')
end = s.index('\nstatic PerspectiveTransform trackedTransform', start)
new_cached = r'''template <class LumAt>
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
'''
s = s[:start] + new_cached + s[end:]

marker = '''static PerspectiveTransform trackedTransform(const PersistentTrack& track, float dx, float dy)\n{\n\tconst double dim = track.dimension;\n\tconst PointF off{dx, dy};\n\treturn PerspectiveTransform(\n\t\tQuadrilateralF{PointF{0, 0}, PointF{dim, 0}, PointF{dim, dim}, PointF{0, dim}},\n\t\tQuadrilateralF{track.topLeft + off, track.topRight + off, track.bottomRight + off, track.bottomLeft + off});\n}\n'''
if marker not in s:
    raise SystemExit('trackedTransform marker not found')
calibration = r'''

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
}
'''
s = s.replace(marker, marker + calibration, 1)

# Track setup/reset semantics.
s = s.replace('\t\ttrack.multiSample = std::hypot(adjacent.x - center.x, adjacent.y - center.y) < 2.75;\n\t\ttrack.sampled = BitMatrix(dimension, dimension);',
              '\t\ttrack.multiSample = std::hypot(adjacent.x - center.x, adjacent.y - center.y) < 2.75;\n\t\ttrack.calibrated = false;\n\t\ttrack.calibrationCooldown = 0;\n\t\ttrack.sampled = BitMatrix(dimension, dimension);', 1)
s = s.replace('\ttrack.multiSample = false;\n\ttrack.dx = track.dy = 0;',
              '\ttrack.multiSample = false;\n\ttrack.calibrated = true;\n\ttrack.calibrationCooldown = 0;\n\ttrack.dx = track.dy = 0;', 1)

old_y_start = s.index('EMSCRIPTEN_KEEPALIVE int decodeTrackedBatchY(')
old_y_end = s.index('\nEMSCRIPTEN_KEEPALIVE int decodeTrackedBatchRGBA(', old_y_start)
new_y = r'''EMSCRIPTEN_KEEPALIVE int decodeTrackedBatchY(int handle, const uint8_t* yPlane, int width, int height, int stride,
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
			const double calibrationStarted = emscripten_get_now();
			const bool ok = calibrateTrackSampleMap(track, *bits);
			measured.anchorMs += emscripten_get_now() - calibrationStarted;
			if (ok) {
				++measured.anchorSuccesses;
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
'''
s = s[:old_y_start] + new_y + s[old_y_end:]
cpp.write_text(s)

# Partial cached successes must not suppress recovery of the remaining slots.
worker = Path('receive/worker.js')
w = worker.read_text()
old = 'const robustFallback = robustTrackedRecovery && nativeSymbols.length === 0;'
new = 'const robustFallback = robustTrackedRecovery && nativeSymbols.length < tracks.length;'
if w.count(old) != 1:
    raise SystemExit('robustFallback marker not found')
w = w.replace(old, new, 1)
old = '''      // The normal hot path already missed on Y8. Only now copy this exact
      // bounded crop as RGBA for the explicitly counted robust local recovery.'''
new = '''      // Keep any cached-map successes and let the robust detector fill only
      // the missing slots. One bad QR must never throw away four cheap wins.
      symbols.push(...nativeSymbols);

      // The normal hot path already missed on Y8. Only now copy this exact
      // bounded crop as RGBA for the explicitly counted robust local recovery.'''
if w.count(old) != 1:
    raise SystemExit('robust recovery insertion point not found')
w = w.replace(old, new, 1)
old = 'const decodedSlots = /* @__PURE__ */ new Set();'
new = 'const decodedSlots = /* @__PURE__ */ new Set(nativeSymbols.flatMap((symbol) => symbol.header?.slotIndex === void 0 ? [] : [symbol.header.slotIndex]));'
if w.count(old) != 1:
    raise SystemExit('decodedSlots marker not found')
w = w.replace(old, new, 1)
old = '''        trackedHit: false,
        fallbackAttempted: true,
        fallbackSucceeded: symbols.length > 0,'''
new = '''        trackedHit: nativeSymbols.length > 0,
        fallbackAttempted: true,
        fallbackSucceeded: symbols.length > nativeSymbols.length,'''
if w.count(old) != 1:
    raise SystemExit('fallback reply marker not found')
w = w.replace(old, new, 1)
worker.write_text(w)
