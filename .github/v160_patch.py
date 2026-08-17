from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing anchor in {path}: {old[:140]!r}")
    p.write_text(text.replace(old, new, 1))

replace_once("index.html", "v0.5.159", "v0.5.160")
replace_once("main.js", 'const APP_BUILD = "v0.5.159";', 'const APP_BUILD = "v0.5.160";')
replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.159";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.160";')
replace_once("sw.js", 'airgapper-static-js-v121', 'airgapper-static-js-v122')

# Keep the compact UI label requested by the user, but make the detailed
# diagnostics explicit about what the fast guided stage is actually doing.
p = Path("receive/main.js")
text = p.read_text()
text = text.replace(" · project ${", " · sparse ${")
text = text.replace("[project ${", "[sparse ${")
p.write_text(text)

cpp = Path("vendor/decimen-codec/source/wrapper/decimen_codec.cpp")
text = cpp.read_text()

start = text.index("// Sample a known tracked QR without QRDetector's expensive version-40")
end = text.index("\n} // namespace\n\nextern \"C\" int decodeGuidedBatchY", start)
helper = r'''// A single projective grid is not enough for AirGapper's 177-module wall:
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
                if (distance(*cor1, *cor2) < moduleSize / 2.0 && cor2->size > cor1->size)
                    return ConcentricPattern{(*cor1 + *cor2) / 2, (cor1->size + cor2->size) / 2};
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
    if (++state.failures[id] >= 2) {
        state.failures[id] = 0;
        // A weak geometry should not pay an extra RS decode every frame.
        // Re-probe periodically because a later pose/framing can be friendlier.
        state.cooldown[id] = 10;
    }
}

static DetectorResult sampleGuidedSparse(const BitMatrix& image,
                                         const DecimenGuidedTrack& track,
                                         const QRCode::FinderPatternSet& fp)
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

    // If fewer than half of the real sparse alignment controls were found,
    // avoid a likely-wasted RS decode and use full SampleQR immediately.
    if (alignmentFound < 3)
        return {};

    return SampleGrid(image, dim, dim, base, std::move(controls), centers, centers);
}
'''
text = text[:start] + helper + text[end:]

old = '''            // Fast tracked projection: one SampleGrid + ordinary QR RS decode.
            // This avoids the dozens of alignment-pattern searches SampleQR
            // performs for v40. It uses no persistent pixel/module cache.
            auto projected = sampleGuidedProjection(*bits, track, finderSet);
            if (projected.isValid() && projected.bits().width() == track.dimension) {
                metrics->sampleAttempts++;
                metrics->fastDecodeAttempts++;
                const double fastStart = guidedNowMs();
                auto decoded = QRCode::Decode(projected.bits());
                const double fastElapsed = guidedNowMs() - fastStart;
                metrics->fastDecodeMs += fastElapsed;
                metrics->decodeMs += fastElapsed;
                decodeSpent += fastElapsed;
                decodedTrack = commitDecoded(projected, decoded);
                if (decodedTrack)
                    metrics->fastDecodeSuccesses++;
            }

            // Projection misses retain the exact proven decoder. No cache, no
            // reduced ECC, and no correctness tradeoff: SampleQR remains the
            // oracle and refreshes the returned quad for the lattice.
'''
new = '''            // Sparse distortion-aware tiled sample. Two consecutive misses for
            // this slot put the experiment on a short cooldown, bounding the
            // worst-case cost when a particular pose needs full SampleQR.
            if (guidedSparseAllowed(track.id)) {
                ++metrics->fastDecodeAttempts;
                auto sparse = sampleGuidedSparse(*bits, track, finderSet);
                if (sparse.isValid() && sparse.bits().width() == track.dimension) {
                    metrics->sampleAttempts++;
                    const double fastStart = guidedNowMs();
                    auto decoded = QRCode::Decode(sparse.bits());
                    const double fastElapsed = guidedNowMs() - fastStart;
                    metrics->fastDecodeMs += fastElapsed;
                    metrics->decodeMs += fastElapsed;
                    decodeSpent += fastElapsed;
                    decodedTrack = commitDecoded(sparse, decoded);
                    if (decodedTrack)
                        ++metrics->fastDecodeSuccesses;
                }
                noteGuidedSparseOutcome(track.id, decodedTrack);
            }

            // Sparse misses retain the exact proven decoder. No persistent
            // pixel map and no reduced ECC: SampleQR remains the correctness
            // oracle and refreshes the returned quad for the lattice.
'''
if old not in text:
    raise SystemExit("v159 projection block not found")
text = text.replace(old, new, 1)
cpp.write_text(text)
