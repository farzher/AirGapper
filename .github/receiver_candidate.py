from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected exactly one match, found {count}: {old[:200]!r}")
    p.write_text(text.replace(old, new, 1))


cpp = "vendor/decimen-codec/source/wrapper/decimen_codec.cpp"

old_bin = """        const double binStart = guidedNowMs();
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
"""
new_bin = """        std::vector<int> order;
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

        // Turbo already proved the rest of the wall. When the remaining misses
        // form a compact band/cluster, do not run HybridBinarizer over unrelated
        // pixels. Pad each missing QR generously (finder search + alignment +
        // binarizer neighborhood), and crop only when the union is <= 50% of the
        // worker image. Scattered misses keep the exact full-frame path.
        int binX = 0, binY = 0, binW = width, binH = height;
        if (!order.empty() && order.size() < size_t(trackCount)) {
            double minX = width, minY = height, maxX = 0, maxY = 0;
            for (int trackIndex : order) {
                const auto& track = tracks[trackIndex];
                const double left = std::min({double(track.x0), double(track.x1), double(track.x2), double(track.x3)});
                const double top = std::min({double(track.y0), double(track.y1), double(track.y2), double(track.y3)});
                const double right = std::max({double(track.x0), double(track.x1), double(track.x2), double(track.x3)});
                const double bottom = std::max({double(track.y0), double(track.y1), double(track.y2), double(track.y3)});
                const int pad = std::max(24, int(std::ceil(guidedModuleSize(track) * 16.0f)));
                minX = std::min(minX, left - pad);
                minY = std::min(minY, top - pad);
                maxX = std::max(maxX, right + pad);
                maxY = std::max(maxY, bottom + pad);
            }
            const int candidateX = std::clamp(int(std::floor(minX)), 0, width);
            const int candidateY = std::clamp(int(std::floor(minY)), 0, height);
            const int candidateR = std::clamp(int(std::ceil(maxX)), 0, width);
            const int candidateB = std::clamp(int(std::ceil(maxY)), 0, height);
            const int candidateW = candidateR - candidateX;
            const int candidateH = candidateB - candidateY;
            const int64_t candidateArea = int64_t(candidateW) * candidateH;
            const int64_t fullArea = int64_t(width) * height;
            if (candidateW >= 64 && candidateH >= 64 && candidateArea > 0 && candidateArea * 2 <= fullArea) {
                binX = candidateX;
                binY = candidateY;
                binW = candidateW;
                binH = candidateH;
            }
        }

        const double binStart = guidedNowMs();
        auto* binPlane = const_cast<uint8_t*>(yPlane + size_t(binY) * stride + binX);
        ImageView iv(binPlane, binW, binH, ImageFormat::Lum, stride, 1);
        HybridBinarizer binarized(iv);
        auto bits = binarized.getBitMatrix();
        metrics->binarizeMs = guidedNowMs() - binStart;
        if (!bits) {
            metrics->misses = metrics->tracks - metrics->successful;
            metrics->totalMs = guidedNowMs() - started;
            return resultCount;
        }

        auto absolutizeMap = [&](std::vector<PointF>& map) {
            if (!binX && !binY)
                return;
            for (auto& point : map) {
                point.x += binX;
                point.y += binY;
            }
        };
        auto absoluteQuad = [&](std::array<PointF, 4> quad) {
            if (binX || binY)
                for (auto& point : quad) {
                    point.x += binX;
                    point.y += binY;
                }
            return quad;
        };
        auto absolutePositionQuad = [&](const Position& position) {
            return absoluteQuad(turboPositionQuad(position));
        };
"""
replace_once(cpp, old_bin, new_bin)

replace_once(
    cpp,
    """            const auto& track = tracks[trackIndex];
            const uint32_t trackBit = trackIndex < 32 ? (uint32_t(1) << trackIndex) : 0;

            QRCode::FinderPatternSet finderSet;
""",
    """            const auto& absoluteTrack = tracks[trackIndex];
            DecimenGuidedTrack localTrack = absoluteTrack;
            localTrack.x0 -= binX; localTrack.y0 -= binY;
            localTrack.x1 -= binX; localTrack.y1 -= binY;
            localTrack.x2 -= binX; localTrack.y2 -= binY;
            localTrack.x3 -= binX; localTrack.y3 -= binY;
            const auto& track = localTrack;
            const uint32_t trackBit = trackIndex < 32 ? (uint32_t(1) << trackIndex) : 0;

            QRCode::FinderPatternSet finderSet;
"""
)

replace_once(
    cpp,
    """                const Position pos = detected.position();
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
""",
    """                const Position pos = detected.position();
                auto& result = results[resultCount++];
                result = {};
                result.id = track.id;
                result.status = DECIMEN_TRACK_OK;
                result.bytesOffset = outputUsed;
                result.bytesLength = int(bytes.size());
                result.dimension = detected.bits().width();
                result.x0 = pos[0].x + binX; result.y0 = pos[0].y + binY;
                result.x1 = pos[1].x + binX; result.y1 = pos[1].y + binY;
                result.x2 = pos[2].x + binX; result.y2 = pos[2].y + binY;
                result.x3 = pos[3].x + binX; result.y3 = pos[3].y + binY;
"""
)

old_fast = """                            result.dimension = track.dimension;
                            result.x0 = fast.quad[0].x; result.y0 = fast.quad[0].y;
                            result.x1 = fast.quad[1].x; result.y1 = fast.quad[1].y;
                            result.x2 = fast.quad[2].x; result.y2 = fast.quad[2].y;
                            result.x3 = fast.quad[3].x; result.y3 = fast.quad[3].y;
                            outputUsed += int(bytes.size());
                            ++metrics->successful;
                            ++metrics->sparseProfileSuccesses;
                            decodedTrack = true;
                            if (mapOut && !sparseMap.empty())
                                seedGuidedTurboQuad(track.id, track.dimension, fast.quad,
                                                    std::move(sparseMap), true);
"""
new_fast = """                            result.dimension = track.dimension;
                            const auto absoluteFastQuad = absoluteQuad(fast.quad);
                            result.x0 = absoluteFastQuad[0].x; result.y0 = absoluteFastQuad[0].y;
                            result.x1 = absoluteFastQuad[1].x; result.y1 = absoluteFastQuad[1].y;
                            result.x2 = absoluteFastQuad[2].x; result.y2 = absoluteFastQuad[2].y;
                            result.x3 = absoluteFastQuad[3].x; result.y3 = absoluteFastQuad[3].y;
                            outputUsed += int(bytes.size());
                            ++metrics->successful;
                            ++metrics->sparseProfileSuccesses;
                            decodedTrack = true;
                            if (mapOut && !sparseMap.empty()) {
                                absolutizeMap(sparseMap);
                                seedGuidedTurboQuad(track.id, track.dimension, absoluteFastQuad,
                                                    std::move(sparseMap), true);
                            }
"""
replace_once(cpp, old_fast, new_fast)

replace_once(
    cpp,
    """                    if (decodedTrack && mapOut) {
                        if (sparseMap.empty())
                            sparseMap = buildHomographySampleMap(track.dimension, sparse.position());
                        seedGuidedTurbo(track.id, track.dimension, sparse.position(), std::move(sparseMap), true);
                    }
""",
    """                    if (decodedTrack && mapOut) {
                        if (sparseMap.empty())
                            sparseMap = buildHomographySampleMap(track.dimension, sparse.position());
                        absolutizeMap(sparseMap);
                        seedGuidedTurboQuad(track.id, track.dimension, absolutePositionQuad(sparse.position()),
                                            std::move(sparseMap), true);
                    }
"""
)

replace_once(
    cpp,
    """                            if (turboSeedEligible(track)) {
                                auto map = buildHomographySampleMap(track.dimension, detected.position());
                                seedGuidedTurbo(track.id, track.dimension, detected.position(), std::move(map), false);
                            }
""",
    """                            if (turboSeedEligible(track)) {
                                auto map = buildHomographySampleMap(track.dimension, detected.position());
                                absolutizeMap(map);
                                seedGuidedTurboQuad(track.id, track.dimension, absolutePositionQuad(detected.position()),
                                                    std::move(map), false);
                            }
"""
)

replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.321";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.322";')
replace_once("send/main.js", 'const SEND_RUNTIME_BUILD = "v0.5.321";', 'const SEND_RUNTIME_BUILD = "v0.5.322";')
replace_once("main.js", 'const APP_BUILD = "v0.5.321";', 'const APP_BUILD = "v0.5.322";')
replace_once("index.html", '<span class="app-version">v0.5.321</span>', '<span class="app-version">v0.5.322</span>')
replace_once("index.html", './main.js?build=v0.5.321', './main.js?build=v0.5.322')
replace_once("sw.js", 'const CACHE = "airgapper-static-js-v269";', 'const CACHE = "airgapper-static-js-v270";')

print("staged v0.5.322: crop fallback binarization to compact missing-QR unions")
