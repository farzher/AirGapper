from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing anchor in {path}: {old[:180]!r}")
    p.write_text(text.replace(old, new, 1))

# Version/cache bump.
replace_once("index.html", "v0.5.163", "v0.5.164")
replace_once("main.js", 'const APP_BUILD = "v0.5.163";', 'const APP_BUILD = "v0.5.164";')
replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.163";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.164";')
replace_once("sw.js", 'airgapper-static-js-v125', 'airgapper-static-js-v126')

# Expose sparse-geometry reuse metrics without changing any decode ABI inputs.
p = Path("vendor/decimen-codec/source/wrapper/decimen_codec.h")
text = p.read_text()
old = '''\tdouble fastDecodeMs;\n\tdouble genericDecodeMs;\n};'''
new = '''\tdouble fastDecodeMs;\n\tdouble genericDecodeMs;\n\tuint32_t sparseCacheAttempts;\n\tuint32_t sparseCacheSuccesses;\n\tuint32_t sparseRefreshes;\n};'''
if old not in text:
    raise SystemExit("guided metrics header anchor missing")
p.write_text(text.replace(old, new, 1))

p = Path("receive/worker.js")
text = p.read_text()
text = text.replace('const GUIDED_METRICS_BYTES = 96;', 'const GUIDED_METRICS_BYTES = 112;', 1)
old = '''    fastDecodeMs: metricsView.getFloat64(80, true),\n    genericDecodeMs: metricsView.getFloat64(88, true)\n  };'''
new = '''    fastDecodeMs: metricsView.getFloat64(80, true),\n    genericDecodeMs: metricsView.getFloat64(88, true),\n    sparseCacheAttempts: metricsView.getUint32(96, true),\n    sparseCacheSuccesses: metricsView.getUint32(100, true),\n    sparseRefreshes: metricsView.getUint32(104, true)\n  };'''
if old not in text:
    raise SystemExit("worker guided metrics anchor missing")
p.write_text(text.replace(old, new, 1))

# Aggregate and surface geometry-reuse evidence in receiver diagnostics.
p = Path("receive/main.js")
text = p.read_text()
text = text.replace(
    '  guidedFastDecodeAttempts: 0,\n  guidedFastDecodeSuccesses: 0,\n  guidedGenericDecodeAttempts: 0,',
    '  guidedFastDecodeAttempts: 0,\n  guidedFastDecodeSuccesses: 0,\n  guidedGenericDecodeAttempts: 0,\n  guidedSparseCacheAttempts: 0,\n  guidedSparseCacheSuccesses: 0,\n  guidedSparseRefreshes: 0,',
    1
)
text = text.replace(
    'guidedFastDecodeMs: 0, guidedGenericDecodeMs: 0, guidedFastDecodeAttempts: 0, guidedFastDecodeSuccesses: 0, guidedGenericDecodeAttempts: 0,',
    'guidedFastDecodeMs: 0, guidedGenericDecodeMs: 0, guidedFastDecodeAttempts: 0, guidedFastDecodeSuccesses: 0, guidedGenericDecodeAttempts: 0, guidedSparseCacheAttempts: 0, guidedSparseCacheSuccesses: 0, guidedSparseRefreshes: 0,',
    1
)
old = '''      livePipeline.guidedFastDecodeAttempts += Math.max(0, Number(guided.fastDecodeAttempts) || 0);\n      livePipeline.guidedFastDecodeSuccesses += Math.max(0, Number(guided.fastDecodeSuccesses) || 0);\n      livePipeline.guidedGenericDecodeAttempts += Math.max(0, Number(guided.genericDecodeAttempts) || 0);'''
new = '''      livePipeline.guidedFastDecodeAttempts += Math.max(0, Number(guided.fastDecodeAttempts) || 0);\n      livePipeline.guidedFastDecodeSuccesses += Math.max(0, Number(guided.fastDecodeSuccesses) || 0);\n      livePipeline.guidedGenericDecodeAttempts += Math.max(0, Number(guided.genericDecodeAttempts) || 0);\n      livePipeline.guidedSparseCacheAttempts += Math.max(0, Number(guided.sparseCacheAttempts) || 0);\n      livePipeline.guidedSparseCacheSuccesses += Math.max(0, Number(guided.sparseCacheSuccesses) || 0);\n      livePipeline.guidedSparseRefreshes += Math.max(0, Number(guided.sparseRefreshes) || 0);'''
if old not in text:
    raise SystemExit("guided aggregation anchor missing")
text = text.replace(old, new, 1)
text = text.replace(
    '[sparse ${lastGuidedMetrics.fastDecodeMs.toFixed(1)} ${lastGuidedMetrics.fastDecodeSuccesses}/${lastGuidedMetrics.fastDecodeAttempts} · fallback ${lastGuidedMetrics.genericDecodeMs.toFixed(1)} ${lastGuidedMetrics.genericDecodeAttempts}]',
    '[sparse ${lastGuidedMetrics.fastDecodeMs.toFixed(1)} ${lastGuidedMetrics.fastDecodeSuccesses}/${lastGuidedMetrics.fastDecodeAttempts} · reuse ${lastGuidedMetrics.sparseCacheSuccesses ?? 0}/${lastGuidedMetrics.sparseCacheAttempts ?? 0} · refresh ${lastGuidedMetrics.sparseRefreshes ?? 0} · fallback ${lastGuidedMetrics.genericDecodeMs.toFixed(1)} ${lastGuidedMetrics.genericDecodeAttempts}]',
    1
)
text = text.replace(
    '· sparse ${livePipeline.guidedFastDecodeSuccesses}/${livePipeline.guidedFastDecodeAttempts} · fallback ${livePipeline.guidedGenericDecodeAttempts} · baseline',
    '· sparse ${livePipeline.guidedFastDecodeSuccesses}/${livePipeline.guidedFastDecodeAttempts} · reuse ${livePipeline.guidedSparseCacheSuccesses}/${livePipeline.guidedSparseCacheAttempts} · refresh ${livePipeline.guidedSparseRefreshes} · fallback ${livePipeline.guidedGenericDecodeAttempts} · baseline',
    1
)
p.write_text(text)

cpp = Path("vendor/decimen-codec/source/wrapper/decimen_codec.cpp")
text = cpp.read_text()
start = text.index("struct GuidedSparseState")
end = text.index("\n} // namespace\n\nextern \"C\" int decodeGuidedBatchY", start)
replacement = r'''constexpr uint8_t GUIDED_SPARSE_REUSE_SUCCESSES = 6;

struct GuidedSparseSlotState
{
    uint8_t failures{};
    uint8_t cooldown{};
    uint8_t reuseRemaining{};
    uint16_t validMask{};
    int dimension{};
    float moduleSize{};
    PointF center{};
    std::array<PointF, 9> normalizedOffsets{};
};

struct GuidedSparseState
{
    std::array<GuidedSparseSlotState, 64> slots{};
};

static GuidedSparseState& guidedSparseState()
{
    static GuidedSparseState state;
    return state;
}

static GuidedSparseSlotState* guidedSparseSlot(int id)
{
    auto& slots = guidedSparseState().slots;
    return id >= 0 && id < int(slots.size()) ? &slots[id] : nullptr;
}

static void clearGuidedSparseGeometry(GuidedSparseSlotState& slot)
{
    slot.reuseRemaining = 0;
    slot.validMask = 0;
    slot.dimension = 0;
    slot.moduleSize = 0;
}

static bool guidedSparseAllowed(int id)
{
    auto* slot = guidedSparseSlot(id);
    if (!slot)
        return true;
    if (!slot->cooldown)
        return true;
    --slot->cooldown;
    return false;
}

static void noteGuidedSparseOutcome(int id, bool success)
{
    auto* slot = guidedSparseSlot(id);
    if (!slot)
        return;
    if (success) {
        slot->failures = 0;
        slot->cooldown = 0;
        return;
    }
    clearGuidedSparseGeometry(*slot);
    if (++slot->failures >= 2) {
        slot->failures = 0;
        // A weak geometry should not pay an extra RS decode every frame.
        // Re-probe periodically because a later pose/framing can be friendlier.
        slot->cooldown = 10;
    }
}

static DetectorResult sampleGuidedSparse(const BitMatrix& image,
                                         const DecimenGuidedTrack& track,
                                         const QRCode::FinderPatternSet& fp,
                                         bool& usedCache, bool& refreshed)
{
    usedCache = false;
    refreshed = false;
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

    const double moduleSize = std::max(1.0, guidedModuleSize(track));
    const PointF trackCenter{
        (track.x0 + track.x1 + track.x2 + track.x3) * 0.25,
        (track.y0 + track.y1 + track.y2 + track.y3) * 0.25
    };
    auto* slot = guidedSparseSlot(track.id);
    bool cacheUsable = slot && slot->validMask && slot->reuseRemaining && slot->dimension == dim && slot->moduleSize > 0;
    if (cacheUsable) {
        const double scaleDrift = std::abs(std::log2(moduleSize / slot->moduleSize));
        const double centerDrift = distance(trackCenter, slot->center);
        if (scaleDrift > 0.08 || centerDrift > std::max(8.0, moduleSize * 10.0)) {
            clearGuidedSparseGeometry(*slot);
            cacheUsable = false;
        }
    }

    // Base transform is the fallback only for sparse controls that were not
    // found. Current finder centers still re-anchor translation/rotation/scale
    // on every frame, including cache-reuse frames.
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
    if (cacheUsable) {
        usedCache = true;
        for (int y = 0; y <= N; ++y) {
            for (int x = 0; x <= N; ++x) {
                const int index = y * 3 + x;
                if (!(slot->validMask & (uint16_t(1) << index)))
                    continue;
                const PointF predicted = projectControl(x, y);
                const PointF offset = slot->normalizedOffsets[index];
                controls.set(x, y, predicted + PointF{offset.x * moduleSize, offset.y * moduleSize});
            }
        }
        --slot->reuseRemaining;
    } else {
        refreshed = true;
        if (slot)
            clearGuidedSparseGeometry(*slot);

        auto rememberControl = [&](int x, int y, PointF predicted, PointF actual) {
            controls.set(x, y, actual);
            if (!slot)
                return;
            const int index = y * 3 + x;
            const PointF delta = actual - predicted;
            slot->normalizedOffsets[index] = PointF{delta.x / moduleSize, delta.y / moduleSize};
            slot->validMask |= uint16_t(1) << index;
        };
        auto seedFinderCorner = [&](int x, int y, const ConcentricPattern& finder) {
            const PointF predicted = projectControl(x, y);
            PointF actual = predicted;
            if (auto corners = FindConcentricPatternCorners(image, finder, finder.size, 2)) {
                for (auto corner : *corners) {
                    if (distance(corner, predicted) < finder.size / 2) {
                        actual = corner;
                        break;
                    }
                }
            }
            rememberControl(x, y, predicted, actual);
        };
        seedFinderCorner(0, 0, fp.tl);
        seedFinderCorner(0, N, fp.bl);
        seedFinderCorner(N, 0, fp.tr);

        const int moduleSizePx = std::max(1, int(std::lround(moduleSize)));
        int alignmentFound = 0;
        for (int y = 0; y <= N; ++y) {
            for (int x = 0; x <= N; ++x) {
                if ((x == 0 && y == 0) || (x == 0 && y == N) || (x == N && y == 0))
                    continue;
                const PointF predicted = projectControl(x, y);
                if (auto found = locateGuidedAlignment(image, moduleSizePx, predicted)) {
                    rememberControl(x, y, predicted, PointF(*found));
                    ++alignmentFound;
                }
            }
        }

        // If fewer than half of the real sparse alignment controls were found,
        // avoid a likely-wasted RS decode and use full SampleQR immediately.
        if (alignmentFound < 3) {
            if (slot)
                clearGuidedSparseGeometry(*slot);
            return {};
        }
        if (slot) {
            slot->dimension = dim;
            slot->moduleSize = float(moduleSize);
            slot->center = trackCenter;
            slot->reuseRemaining = GUIDED_SPARSE_REUSE_SUCCESSES;
        }
    }

    return SampleGrid(image, dim, dim, base, std::move(controls), centers, centers);
}
'''
text = text[:start] + replacement + text[end:]

old = '''            if (guidedSparseAllowed(track.id)) {\n                ++metrics->fastDecodeAttempts;\n                auto sparse = sampleGuidedSparse(*bits, track, finderSet);\n                if (sparse.isValid() && sparse.bits().width() == track.dimension) {'''
new = '''            if (guidedSparseAllowed(track.id)) {\n                ++metrics->fastDecodeAttempts;\n                bool usedSparseCache = false;\n                bool refreshedSparse = false;\n                auto sparse = sampleGuidedSparse(*bits, track, finderSet, usedSparseCache, refreshedSparse);\n                if (usedSparseCache)\n                    ++metrics->sparseCacheAttempts;\n                if (refreshedSparse)\n                    ++metrics->sparseRefreshes;\n                if (sparse.isValid() && sparse.bits().width() == track.dimension) {'''
if old not in text:
    raise SystemExit("guided sparse call anchor missing")
text = text.replace(old, new, 1)
old = '''                    decodedTrack = commitDecoded(sparse, decoded);\n                    if (decodedTrack)\n                        ++metrics->fastDecodeSuccesses;'''
new = '''                    decodedTrack = commitDecoded(sparse, decoded);\n                    if (decodedTrack) {\n                        ++metrics->fastDecodeSuccesses;\n                        if (usedSparseCache)\n                            ++metrics->sparseCacheSuccesses;\n                    }'''
if old not in text:
    raise SystemExit("guided sparse success anchor missing")
text = text.replace(old, new, 1)
cpp.write_text(text)
