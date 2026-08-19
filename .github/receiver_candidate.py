from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected exactly one match, found {count}: {old[:200]!r}")
    p.write_text(text.replace(old, new, 1))


cpp = "vendor/decimen-codec/source/wrapper/decimen_codec.cpp"

# Write ROI-local calibration maps directly into worker-absolute coordinates
# during the map construction pass we already pay for. v322 proved that walking
# a 177x177 map a second time solely to add {binX,binY} erased the binarization win.
replace_once(
    cpp,
    "static std::vector<PointF> buildHomographySampleMap(int dim, const Position& pos)\n{",
    "static std::vector<PointF> buildHomographySampleMap(int dim, const Position& pos,\n"
    "                                                    PointF outputOffset = PointF{0, 0})\n{"
)
replace_once(
    cpp,
    "            out[size_t(y) * dim + x] = map(centered(PointI{x, y}));",
    "            out[size_t(y) * dim + x] = map(centered(PointI{x, y})) + outputOffset;"
)
replace_once(
    cpp,
    "static bool buildSparseSampleMap(int dim, const PerspectiveTransform& fallback,\n                                 Matrix<std::optional<PointF>>& controls,\n                                 const std::vector<int>& centers,\n                                 std::vector<PointF>& out)\n{",
    "static bool buildSparseSampleMap(int dim, const PerspectiveTransform& fallback,\n"
    "                                 Matrix<std::optional<PointF>>& controls,\n"
    "                                 const std::vector<int>& centers,\n"
    "                                 std::vector<PointF>& out,\n"
    "                                 PointF outputOffset = PointF{0, 0})\n{"
)
replace_once(
    cpp,
    "                    out[size_t(y) * dim + x] = local(centered(PointI{x, y}));",
    "                    out[size_t(y) * dim + x] = local(centered(PointI{x, y})) + outputOffset;"
)
replace_once(
    cpp,
    "static bool buildSparseSampleMapBilinear(int dim, const PerspectiveTransform& fallback,\n                                         Matrix<std::optional<PointF>>& controls,\n                                         const std::vector<int>& centers,\n                                         std::vector<PointF>& out)\n{",
    "static bool buildSparseSampleMapBilinear(int dim, const PerspectiveTransform& fallback,\n"
    "                                         Matrix<std::optional<PointF>>& controls,\n"
    "                                         const std::vector<int>& centers,\n"
    "                                         std::vector<PointF>& out,\n"
    "                                         PointF outputOffset = PointF{0, 0})\n{"
)
replace_once(
    cpp,
    "                    out[size_t(y) * dim + x] = p;\n                    p.x += step.x;",
    "                    out[size_t(y) * dim + x] = p + outputOffset;\n                    p.x += step.x;"
)

replace_once(
    cpp,
    "static DetectorResult sampleGuidedSparse(const BitMatrix& image,\n                                         const DecimenGuidedTrack& track,\n                                         const QRCode::FinderPatternSet& fp,\n                                         int* alignmentFoundOut,\n                                         std::vector<PointF>* sampleMapOut,\n                                         GuidedSparseFastResult* fastOut)\n{",
    "static DetectorResult sampleGuidedSparse(const BitMatrix& image,\n"
    "                                         const DecimenGuidedTrack& track,\n"
    "                                         const QRCode::FinderPatternSet& fp,\n"
    "                                         int* alignmentFoundOut,\n"
    "                                         std::vector<PointF>* sampleMapOut,\n"
    "                                         GuidedSparseFastResult* fastOut,\n"
    "                                         PointF sampleMapOffset = PointF{0, 0})\n{"
)
replace_once(
    cpp,
    "            if (sampleMapOut && !buildSparseSampleMapBilinear(dim, base, controls, centers, *sampleMapOut))",
    "            if (sampleMapOut && !buildSparseSampleMapBilinear(dim, base, controls, centers, *sampleMapOut, sampleMapOffset))"
)
replace_once(
    cpp,
    "    if (sampleMapOut && !buildSparseSampleMap(dim, base, controls, centers, *sampleMapOut))",
    "    if (sampleMapOut && !buildSparseSampleMap(dim, base, controls, centers, *sampleMapOut, sampleMapOffset))"
)

# Remove v322's O(dim^2) post-build translation helper. Quad shifting is only
# four points and remains cheap/necessary for result geometry.
old_helper = """        auto absolutizeMap = [&](std::vector<PointF>& map) {
            if (!binX && !binY)
                return;
            for (auto& point : map) {
                point.x += binX;
                point.y += binY;
            }
        };
        auto absoluteQuad = [&](std::array<PointF, 4> quad) {
"""
replace_once(
    cpp,
    old_helper,
    """        auto absoluteQuad = [&](std::array<PointF, 4> quad) {
"""
)

replace_once(
    cpp,
    "                auto sparse = sampleGuidedSparse(*bits, track, finderSet, nullptr, mapOut, &fast);",
    "                auto sparse = sampleGuidedSparse(*bits, track, finderSet, nullptr, mapOut, &fast,\n"
    "                                                 PointF{float(binX), float(binY)});"
)
replace_once(
    cpp,
    """                            if (mapOut && !sparseMap.empty()) {
                                absolutizeMap(sparseMap);
                                seedGuidedTurboQuad(track.id, track.dimension, absoluteFastQuad,
                                                    std::move(sparseMap), true);
                            }
""",
    """                            if (mapOut && !sparseMap.empty())
                                seedGuidedTurboQuad(track.id, track.dimension, absoluteFastQuad,
                                                    std::move(sparseMap), true);
"""
)
replace_once(
    cpp,
    """                    if (decodedTrack && mapOut) {
                        if (sparseMap.empty())
                            sparseMap = buildHomographySampleMap(track.dimension, sparse.position());
                        absolutizeMap(sparseMap);
                        seedGuidedTurboQuad(track.id, track.dimension, absolutePositionQuad(sparse.position()),
                                            std::move(sparseMap), true);
                    }
""",
    """                    if (decodedTrack && mapOut) {
                        if (sparseMap.empty())
                            sparseMap = buildHomographySampleMap(track.dimension, sparse.position(),
                                                                PointF{float(binX), float(binY)});
                        seedGuidedTurboQuad(track.id, track.dimension, absolutePositionQuad(sparse.position()),
                                            std::move(sparseMap), true);
                    }
"""
)
replace_once(
    cpp,
    """                            if (turboSeedEligible(track)) {
                                auto map = buildHomographySampleMap(track.dimension, detected.position());
                                absolutizeMap(map);
                                seedGuidedTurboQuad(track.id, track.dimension, absolutePositionQuad(detected.position()),
                                                    std::move(map), false);
                            }
""",
    """                            if (turboSeedEligible(track)) {
                                auto map = buildHomographySampleMap(track.dimension, detected.position(),
                                                                   PointF{float(binX), float(binY)});
                                seedGuidedTurboQuad(track.id, track.dimension, absolutePositionQuad(detected.position()),
                                                    std::move(map), false);
                            }
"""
)

replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.322";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.323";')
replace_once("send/main.js", 'const SEND_RUNTIME_BUILD = "v0.5.322";', 'const SEND_RUNTIME_BUILD = "v0.5.323";')
replace_once("main.js", 'const APP_BUILD = "v0.5.322";', 'const APP_BUILD = "v0.5.323";')
replace_once("index.html", '<span class="app-version">v0.5.322</span>', '<span class="app-version">v0.5.323</span>')
replace_once("index.html", './main.js?build=v0.5.322', './main.js?build=v0.5.323')
replace_once("sw.js", 'const CACHE = "airgapper-static-js-v270";', 'const CACHE = "airgapper-static-js-v271";')

print("staged v0.5.323: write cropped Sparse maps absolute during construction")
