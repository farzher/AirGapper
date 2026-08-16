from pathlib import Path

def replace_exact(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    found = s.count(old)
    if found != count:
        raise SystemExit(f"{path}: expected {count} matches, got {found}: {old[:120]!r}")
    p.write_text(s.replace(old, new, count))

replace_exact("index.html", "v0.5.73", "v0.5.74")
replace_exact("sw.js", "airgapper-static-js-v36", "airgapper-static-js-v37")
replace_exact("vendor/decimen-codec/source/VERSION", "0.1.3\n", "0.1.4\n")

replace_exact(
    "receive/main.js",
    '''      if (workerSlot === void 0) {
        queuePendingGridLane(groupIndex, source, geometry);
        continue;
      }''',
    '''      if (workerSlot === void 0) {
        // A stale camera frame is less useful than the next camera frame.
        // RaptorQ is designed to absorb this erasure, so never retain a live
        // VideoFrame clone waiting for a worker and starve the camera pool.
        poolBusyTimes.push(now);
        continue;
      }'''
)

replace_exact(
    "receive/main.js",
    '''  anchorSuccesses: 0,
  anchorMisses: 0,
  outOfFrameMisses: 0,''',
    '''  anchorSuccesses: 0,
  anchorMisses: 0,
  fastSamplerAttempts: 0,
  fastSamplerSuccesses: 0,
  outOfFrameMisses: 0,'''
)
replace_exact(
    "receive/main.js",
    '''    hotPathAudit.anchorSuccesses += completion.nativeMetrics.anchorSuccesses ?? 0;
    hotPathAudit.anchorMisses += completion.nativeMetrics.anchorMisses ?? 0;
    hotPathAudit.outOfFrameMisses += completion.nativeMetrics.outOfFrameMisses ?? 0;''',
    '''    hotPathAudit.anchorSuccesses += completion.nativeMetrics.anchorSuccesses ?? 0;
    hotPathAudit.anchorMisses += completion.nativeMetrics.anchorMisses ?? 0;
    hotPathAudit.fastSamplerAttempts += completion.nativeMetrics.fastSamplerAttempts ?? 0;
    hotPathAudit.fastSamplerSuccesses += completion.nativeMetrics.fastSamplerSuccesses ?? 0;
    hotPathAudit.outOfFrameMisses += completion.nativeMetrics.outOfFrameMisses ?? 0;'''
)
replace_exact(
    "receive/main.js",
    '''Sampler HybridBinarizer + SampleGrid · CRC ${hotPathAudit.anchorBypassSuccesses}/${hotPathAudit.anchorBypassAttempts}
Pixel path ${lastDirectPixelPath.toUpperCase()}''',
    '''Sampler sparse CRC ${hotPathAudit.fastSamplerSuccesses}/${hotPathAudit.fastSamplerAttempts} · Hybrid fallback CRC ${hotPathAudit.anchorBypassSuccesses}/${hotPathAudit.anchorBypassAttempts}
Pixel path ${lastDirectPixelPath.toUpperCase()}'''
)

replace_exact(
    "receive/worker.js",
    '''    alignmentFitAttempts: view.getUint32(nativeMetricsPtr + 80, true),
    outOfFrameMisses: view.getUint32(nativeMetricsPtr + 84, true),
    bitstreamFailures: view.getUint32(nativeMetricsPtr + 88, true),
    crcFailures: view.getUint32(nativeMetricsPtr + 92, true),
    alignmentFitSuccesses: view.getUint32(nativeMetricsPtr + 96, true),''',
    '''    fastSamplerAttempts: view.getUint32(nativeMetricsPtr + 80, true),
    outOfFrameMisses: view.getUint32(nativeMetricsPtr + 84, true),
    bitstreamFailures: view.getUint32(nativeMetricsPtr + 88, true),
    crcFailures: view.getUint32(nativeMetricsPtr + 92, true),
    fastSamplerSuccesses: view.getUint32(nativeMetricsPtr + 96, true),'''
)

cpp = Path("vendor/decimen-codec/source/wrapper/decimen_codec.cpp")
s = cpp.read_text()

insert_marker = '''static PerspectiveTransform trackedTransform(const PersistentTrack& track, float dx, float dy)
{'''
fast_code = r'''constexpr int FAST_THRESH_TILES = 8;
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
static int tryDecodeBatchSparseAll(TrackedDecoder& decoder, const LumAt& lumAt,
								   DecimenTrackedResult* results, int resultCapacity,
								   uint8_t* output, int outputCapacity,
								   DecimenBatchMetrics* metrics)
{
	DecimenBatchMetrics measured{};
	const double totalStart = emscripten_get_now();

	struct Candidate {
		PersistentTrack* track;
		ByteArray packet;
	};
	std::vector<Candidate> candidates;
	candidates.reserve(decoder.tracks.size());

	int activeTracks = 0;
	for (auto& track : decoder.tracks)
		if (track.active)
			++activeTracks;
	if (activeTracks == 0 || activeTracks > resultCapacity)
		return -1;

	for (auto& track : decoder.tracks) {
		if (!track.active)
			continue;
		if (!track.crc32Payload)
			return -1;

		++measured.alignmentFitAttempts;
		const auto thresholds = buildFastThresholds(track, lumAt);
		if (!thresholds.ok) {
			measured.totalMs = emscripten_get_now() - totalStart;
			if (metrics) *metrics = measured;
			return -1;
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
			measured.totalMs = emscripten_get_now() - totalStart;
			if (metrics) *metrics = measured;
			return -1;
		}

		const double bitsStarted = emscripten_get_now();
		auto decoded = decodeWithoutErrorCorrection(track.sampled);
		measured.bitExtractionMs += emscripten_get_now() - bitsStarted;
		if (!decoded.isValid()) {
			measured.totalMs = emscripten_get_now() - totalStart;
			if (metrics) *metrics = measured;
			return -1;
		}

		const auto& bytes = decoded.content().bytes;
		const double crcStarted = emscripten_get_now();
		const bool crcOK = hasValidCRC32(bytes);
		measured.crcMs += emscripten_get_now() - crcStarted;
		if (!crcOK) {
			measured.totalMs = emscripten_get_now() - totalStart;
			if (metrics) *metrics = measured;
			return -1;
		}

		++measured.alignmentFitSuccesses;
		candidates.push_back({&track, ByteArray(bytes.begin(), bytes.end() - 4)});
	}

	int resultCount = 0;
	int outputUsed = 0;
	for (auto& candidate : candidates) {
		auto& track = *candidate.track;
		if (outputUsed + int(candidate.packet.size()) > outputCapacity)
			return -1;

		auto& result = results[resultCount++];
		++track.framesSinceReacquire;
		std::memcpy(output + outputUsed, candidate.packet.data(), candidate.packet.size());
		result = {
			track.id, DECIMEN_TRACK_OK, outputUsed, int(candidate.packet.size()), 0,
			track.framesSinceReacquire, track.dx, track.dy
		};
		outputUsed += candidate.packet.size();
		track.consecutiveMisses = 0;
		++measured.tracks;
		++measured.successful;
		++measured.crcFastSuccesses;
	}

	if (!decoder.tracks.empty())
		decoder.fallbackCursor = (decoder.fallbackCursor + 1) % decoder.tracks.size();
	measured.totalMs = emscripten_get_now() - totalStart;
	if (metrics)
		*metrics = measured;
	return resultCount;
}

'''
if s.count(insert_marker) != 1:
    raise SystemExit(f"cpp insert marker count {s.count(insert_marker)}")
s = s.replace(insert_marker, fast_code + insert_marker, 1)

old_y = r'''EMSCRIPTEN_KEEPALIVE int decodeTrackedBatchY(int handle, const uint8_t* yPlane, int width, int height, int stride,
											 DecimenTrackedResult* results, int resultCapacity,
											 uint8_t* output, int outputCapacity, DecimenBatchMetrics* metrics)
{
	auto* decoder = trackedDecoder(handle);
	if (!decoder || !yPlane || width <= 0 || height <= 0 || stride < width || !results || resultCapacity < 0 ||
		!output || outputCapacity < 0)
		return -1;
	try {
		const double binStarted = emscripten_get_now();
		ImageView lumView(yPlane, width, height, ImageFormat::Lum, stride, 1);
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
}'''
new_y = r'''EMSCRIPTEN_KEEPALIVE int decodeTrackedBatchY(int handle, const uint8_t* yPlane, int width, int height, int stride,
											 DecimenTrackedResult* results, int resultCapacity,
											 uint8_t* output, int outputCapacity, DecimenBatchMetrics* metrics)
{
	auto* decoder = trackedDecoder(handle);
	if (!decoder || !yPlane || width <= 0 || height <= 0 || stride < width || !results || resultCapacity < 0 ||
		!output || outputCapacity < 0)
		return -1;
	try {
		auto lumAt = [&](float fx, float fy) {
			const int x = int(fx), y = int(fy);
			return x < 0 || y < 0 || x >= width || y >= height
				? -1
				: int(yPlane[size_t(y) * stride + x]);
		};

		DecimenBatchMetrics sparse{};
		const int sparseCount = tryDecodeBatchSparseAll(
			*decoder, lumAt, results, resultCapacity, output, outputCapacity, &sparse);
		if (sparseCount >= 0) {
			if (metrics) *metrics = sparse;
			return sparseCount;
		}

		const double binStarted = emscripten_get_now();
		ImageView lumView(yPlane, width, height, ImageFormat::Lum, stride, 1);
		HybridBinarizer binarized(lumView);
		auto bits = binarized.getBitMatrix();
		const double binMs = emscripten_get_now() - binStarted;
		if (!bits)
			return -1;

		DecimenBatchMetrics measured{};
		const int count = decodeBatchBinarized(
			*decoder, *bits, results, resultCapacity, output, outputCapacity, &measured);

		measured.samplingMs += sparse.samplingMs + binMs;
		measured.bitExtractionMs += sparse.bitExtractionMs;
		measured.crcMs += sparse.crcMs;
		measured.totalMs += sparse.totalMs + binMs;
		measured.samples += sparse.samples;
		measured.alignmentFitAttempts += sparse.alignmentFitAttempts;
		measured.alignmentFitSuccesses += sparse.alignmentFitSuccesses;
		if (metrics) *metrics = measured;
		return count;
	} catch (...) {
		return -1;
	}
}'''
if s.count(old_y) != 1:
    raise SystemExit(f"decodeTrackedBatchY exact count {s.count(old_y)}")
s = s.replace(old_y, new_y, 1)
cpp.write_text(s)
