from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 match, got {count}")
    return text.replace(old, new, 1)

cpp_path = Path("vendor/decimen-codec/source/wrapper/decimen_codec.cpp")
cpp = cpp_path.read_text()

cpp = replace_once(
    cpp,
    "\tbool crc32Payload = false;\n\tstd::vector<CachedSamplePoint> samples;",
    "\tbool crc32Payload = false;\n\tPointF topLeft{};\n\tPointF topRight{};\n\tPointF bottomRight{};\n\tPointF bottomLeft{};\n\tstd::vector<CachedSamplePoint> samples;",
    "persistent track corners",
)

start = cpp.index("constexpr int TRACK_THRESH_TILES = 8;")
end = cpp.index("\n} // namespace\n\nextern \"C\" {", start)
replacement = r'''static DecoderResult decodeWithoutErrorCorrection(const BitMatrix& bits)
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

static PerspectiveTransform trackedTransform(const PersistentTrack& track, float dx, float dy)
{
	const double dim = track.dimension;
	const PointF off{dx, dy};
	return PerspectiveTransform(
		QuadrilateralF{PointF{0, 0}, PointF{dim, 0}, PointF{dim, dim}, PointF{0, dim}},
		QuadrilateralF{track.topLeft + off, track.topRight + off, track.bottomRight + off, track.bottomLeft + off});
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
		if (track.crc32Payload)
			packet = fastDecode();
		if (!packet.empty())
			++measured.anchorBypassSuccesses;

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
				if (moved && sampleGrid(track.dx, track.dy))
					packet = fastDecode();
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
'''
cpp = cpp[:start] + replacement + cpp[end:]

cpp = replace_once(
    cpp,
    "\t\tauto& track = decoder->tracks[slot];\n\t\ttrack.samples.resize(dimension * dimension);",
    "\t\tauto& track = decoder->tracks[slot];\n\t\ttrack.topLeft = PointF{x0, y0};\n\t\ttrack.topRight = PointF{x1, y1};\n\t\ttrack.bottomRight = PointF{x2, y2};\n\t\ttrack.bottomLeft = PointF{x3, y3};\n\t\ttrack.samples.resize(dimension * dimension);",
    "store track quad",
)

old_y = r'''EMSCRIPTEN_KEEPALIVE int decodeTrackedBatchY(int handle, const uint8_t* yPlane, int width, int height, int stride,
											 DecimenTrackedResult* results, int resultCapacity,
											 uint8_t* output, int outputCapacity, DecimenBatchMetrics* metrics)
{
	auto* decoder = trackedDecoder(handle);
	if (!decoder || !yPlane || width <= 0 || height <= 0 || stride < width || !results || resultCapacity < 0 ||
		!output || outputCapacity < 0)
		return -1;
	auto lumAtY = [&](float fx, float fy) {
		int x = int(fx), y = int(fy);
		return x < 0 || y < 0 || x >= width || y >= height ? -1 : int(yPlane[size_t(y) * stride + x]);
	};
	try {
		return decodeBatch(*decoder, lumAtY, results, resultCapacity, output, outputCapacity, metrics);
	} catch (...) {
		return -1;
	}
}
'''
new_y = r'''EMSCRIPTEN_KEEPALIVE int decodeTrackedBatchY(int handle, const uint8_t* yPlane, int width, int height, int stride,
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
}
'''
cpp = replace_once(cpp, old_y, new_y, "Y tracked decoder")

old_rgba = r'''EMSCRIPTEN_KEEPALIVE int decodeTrackedBatchRGBA(int handle, const uint8_t* rgba, int width, int height, int stride,
												DecimenTrackedResult* results, int resultCapacity,
												uint8_t* output, int outputCapacity, DecimenBatchMetrics* metrics)
{
	auto* decoder = trackedDecoder(handle);
	if (!decoder || !rgba || width <= 0 || height <= 0 || stride < width * 4 || !results || resultCapacity < 0 ||
		!output || outputCapacity < 0)
		return -1;
	auto lumAtRGBA = [&](float fx, float fy) {
		int x = int(fx), y = int(fy);
		if (x < 0 || y < 0 || x >= width || y >= height)
			return -1;
		const uint8_t* px = rgba + size_t(y) * stride + x * 4;
		return int(RGBToLum(px[0], px[1], px[2]));
	};
	try {
		return decodeBatch(*decoder, lumAtRGBA, results, resultCapacity, output, outputCapacity, metrics);
	} catch (...) {
		return -1;
	}
}
'''
new_rgba = r'''EMSCRIPTEN_KEEPALIVE int decodeTrackedBatchRGBA(int handle, const uint8_t* rgba, int width, int height, int stride,
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
'''
cpp = replace_once(cpp, old_rgba, new_rgba, "RGBA tracked decoder")

if "TRACK_THRESH_TILES" in cpp or "buildTrackThresholds" in cpp:
    raise SystemExit("old point-threshold sampler still present")
if "decodeBatch(*decoder" in cpp:
    raise SystemExit("old decodeBatch call still present")
cpp_path.write_text(cpp)

# Developer diagnostics should name the real hot path instead of the removed
# custom local-threshold sampler.
main_path = Path("receive/main.js")
main = main_path.read_text()
main = main.replace("Threshold local fallback ${hotPathAudit.thresholdFallbacks} · multisample retries ${hotPathAudit.multiSampleRetries}",
                    "Sampler HybridBinarizer + SampleGrid · cached-grid CRC ${hotPathAudit.anchorBypassSuccesses}/${hotPathAudit.anchorBypassAttempts}")
main = main.replace("Anchor bypass CRC ${hotPathAudit.anchorBypassSuccesses}/${hotPathAudit.anchorBypassAttempts}",
                    "Cached-grid CRC ${hotPathAudit.anchorBypassSuccesses}/${hotPathAudit.anchorBypassAttempts}")
main_path.write_text(main)

index = Path("index.html")
text = index.read_text()
text = replace_once(text, "v0.5.55", "v0.5.56", "index version")
index.write_text(text)

sw = Path("sw.js")
text = sw.read_text()
text = replace_once(text, 'airgapper-static-js-v18', 'airgapper-static-js-v19', "service worker cache")
sw.write_text(text)

print("patched persistent tracked sampler to HybridBinarizer + SampleGrid")
