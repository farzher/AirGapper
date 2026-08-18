from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing anchor in {path}: {old[:140]!r}")
    p.write_text(text.replace(old, new, 1))

cpp = Path("vendor/decimen-codec/source/wrapper/decimen_codec.cpp")
s = cpp.read_text()
old_sig = '''static std::optional<PointF> turboRefineWallOffset(const GuidedTurboTrack& cache, const DecimenGuidedTrack& track,
                                                   const TurboFrameTransform& frameTransform,
                                                   const uint8_t* yPlane, int width, int height, int stride,
                                                   float predictedX, float predictedY)
'''
new_sig = '''static std::optional<PointF> turboRefineWallOffset(const GuidedTurboTrack& cache, const DecimenGuidedTrack& track,
                                                   const TurboFrameTransform& frameTransform,
                                                   const uint8_t* yPlane, int width, int height, int stride,
                                                   float predictedX, float predictedY, int maxRing = 3)
'''
if old_sig not in s:
    raise SystemExit("turboRefineWallOffset signature missing")
s = s.replace(old_sig, new_sig, 1)
old_ring3 = '''    if (bestMatches < 132) {
        for (int oy = -3; oy <= 3; ++oy)
            for (int ox = -3; ox <= 3; ++ox)
                if (std::max(std::abs(ox), std::abs(oy)) == 3)
                    consider(predictedX + ox, predictedY + oy);
    }
'''
new_ring3 = '''    if (maxRing >= 3 && bestMatches < 132) {
        for (int oy = -3; oy <= 3; ++oy)
            for (int ox = -3; ox <= 3; ++ox)
                if (std::max(std::abs(ox), std::abs(oy)) == 3)
                    consider(predictedX + ox, predictedY + oy);
    }
    // The first shared wall anchor is allowed one wider ring. This is paid once
    // per batch and lets a stale 300-500 ms handheld geometry snapshot recover
    // from a ~4 px global displacement instead of forcing every QR into sparse.
    if (maxRing >= 4 && bestMatches < 132) {
        for (int oy = -4; oy <= 4; ++oy)
            for (int ox = -4; ox <= 4; ++ox)
                if (std::max(std::abs(ox), std::abs(oy)) == 4)
                    consider(predictedX + ox, predictedY + oy);
    }
'''
if old_ring3 not in s:
    raise SystemExit("ring3 block missing")
s = s.replace(old_ring3, new_ring3, 1)

anchor = '''static DetectorResult sampleGuidedSparse(const BitMatrix& image,
'''
helper = r'''struct TurboWallMotion
{
    std::array<PointF, 3> centers{};
    std::array<PointF, 3> offsets{};
    int count = 0;

    PointF correction(PointF p) const
    {
        if (count <= 0)
            return {0, 0};
        if (count == 1)
            return offsets[0];

        const PointF d1 = centers[1] - centers[0];
        const PointF o1 = offsets[1] - offsets[0];
        PointF out = offsets[0];
        if (count >= 3) {
            const PointF d2 = centers[2] - centers[0];
            const PointF o2 = offsets[2] - offsets[0];
            const float det = float(d1.x * d2.y - d1.y * d2.x);
            if (std::abs(det) > 64.0f) {
                const PointF w = p - centers[0];
                const float u = float(w.x * d2.y - w.y * d2.x) / det;
                const float v = float(d1.x * w.y - d1.y * w.x) / det;
                out = offsets[0] + u * o1 + v * o2;
            } else {
                const float denom = float(d1.x * d1.x + d1.y * d1.y);
                const float t = denom > 1.0f ? float((p.x - centers[0].x) * d1.x +
                                                     (p.y - centers[0].y) * d1.y) / denom : 0.0f;
                out = offsets[0] + t * o1;
            }
        } else {
            const float denom = float(d1.x * d1.x + d1.y * d1.y);
            const float t = denom > 1.0f ? float((p.x - centers[0].x) * d1.x +
                                                 (p.y - centers[0].y) * d1.y) / denom : 0.0f;
            out = offsets[0] + t * o1;
        }
        // Every measured anchor is itself constrained to a tiny finder search.
        // Bound extrapolation so one noisy reference cannot drag all 28 cached
        // maps away from the real image; RS+CRC still validates every QR.
        out.x = std::clamp(float(out.x), -6.0f, 6.0f);
        out.y = std::clamp(float(out.y), -6.0f, 6.0f);
        return out;
    }

    PointF correction(const DecimenGuidedTrack& track) const
    {
        return correction(PointF{
            (track.x0 + track.x1 + track.x2 + track.x3) * 0.25f,
            (track.y0 + track.y1 + track.y2 + track.y3) * 0.25f
        });
    }
};

static TurboWallMotion turboMeasureWallMotion(const DecimenGuidedTrack* tracks, int trackCount,
                                              const uint8_t* yPlane, int width, int height, int stride)
{
    TurboWallMotion motion;
    struct Candidate { int index; PointF center; };
    std::vector<Candidate> candidates;
    candidates.reserve(trackCount);
    for (int i = 0; i < trackCount; ++i) {
        auto* cache = guidedTurboTrack(tracks[i].id);
        if (!cache || !turboStableWarpEligible(*cache, tracks[i]))
            continue;
        const PointF center{
            (tracks[i].x0 + tracks[i].x1 + tracks[i].x2 + tracks[i].x3) * 0.25f,
            (tracks[i].y0 + tracks[i].y1 + tracks[i].y2 + tracks[i].y3) * 0.25f
        };
        candidates.push_back({i, center});
    }
    if (candidates.empty())
        return motion;

    std::vector<uint8_t> used(candidates.size(), 0);
    int attempts = 0;
    auto measure = [&](size_t candidateIndex, PointF predicted, int maxRing) {
        if (candidateIndex >= candidates.size() || used[candidateIndex] || attempts >= 6)
            return false;
        used[candidateIndex] = 1;
        ++attempts;
        const auto& candidate = candidates[candidateIndex];
        auto* cache = guidedTurboTrack(tracks[candidate.index].id);
        if (!cache)
            return false;
        const auto frameTransform = turboFrameTransform(*cache, tracks[candidate.index]);
        if (!frameTransform.isValid())
            return false;
        const auto refined = turboRefineWallOffset(*cache, tracks[candidate.index], frameTransform,
                                                    yPlane, width, height, stride,
                                                    predicted.x, predicted.y, maxRing);
        if (!refined)
            return false;
        motion.centers[motion.count] = candidate.center;
        motion.offsets[motion.count] = *refined;
        ++motion.count;
        return true;
    };

    // First anchor: prefer an interior QR because it is least likely to be cut
    // off by a handheld crop. Allow a 4 px search only here.
    const PointF imageCenter{width * 0.5f, height * 0.5f};
    std::vector<size_t> order(candidates.size());
    for (size_t i = 0; i < order.size(); ++i) order[i] = i;
    std::sort(order.begin(), order.end(), [&](size_t a, size_t b) {
        return distance(candidates[a].center, imageCenter) < distance(candidates[b].center, imageCenter);
    });
    for (size_t ci : order)
        if (measure(ci, {0, 0}, 4) || attempts >= 2)
            break;
    if (motion.count == 0)
        return motion;

    // Second anchor: maximize baseline. Predict it with the first anchor's
    // translation, so its local search is centered on the already observed wall move.
    std::sort(order.begin(), order.end(), [&](size_t a, size_t b) {
        return distance(candidates[a].center, motion.centers[0]) >
               distance(candidates[b].center, motion.centers[0]);
    });
    for (size_t ci : order)
        if (measure(ci, motion.offsets[0], 2) || attempts >= 4)
            break;
    if (motion.count < 2)
        return motion;

    // Third anchor: maximize triangle area so the three local translations can
    // describe a real affine residual field (rotation/scale/shear) across the wall.
    const PointF baseline = motion.centers[1] - motion.centers[0];
    std::sort(order.begin(), order.end(), [&](size_t a, size_t b) {
        auto area = [&](size_t i) {
            const PointF w = candidates[i].center - motion.centers[0];
            return std::abs(float(baseline.x * w.y - baseline.y * w.x));
        };
        return area(a) > area(b);
    });
    for (size_t ci : order) {
        const PointF predicted = motion.correction(candidates[ci].center);
        if (measure(ci, predicted, 2) || attempts >= 6)
            break;
    }
    return motion;
}

'''
if anchor not in s:
    raise SystemExit("sampleGuidedSparse anchor missing")
s = s.replace(anchor, helper + anchor, 1)

old_wall = '''        // Shared wall motion is paid once from any calibrated Stable-RS slot.
        // Stable-RS has its own RS+CRC oracle and no longer depends on the old
        // global Turbo canary/promotion state. A bad cache cools locally below.
        float wallCorrectionX = 0, wallCorrectionY = 0;
        int wallReferenceTries = 0;
        for (int i = 0; i < trackCount && wallReferenceTries < 4; ++i) {
            auto* cache = guidedTurboTrack(tracks[i].id);
            if (!cache || !turboStableWarpEligible(*cache, tracks[i]))
                continue;
            const auto frameTransform = turboFrameTransform(*cache, tracks[i]);
            if (!frameTransform.isValid())
                continue;
            ++wallReferenceTries;
            const auto refined = turboRefineWallOffset(*cache, tracks[i], frameTransform,
                                                        yPlane, width, height, stride, 0, 0);
            if (!refined)
                continue;
            wallCorrectionX = refined->x;
            wallCorrectionY = refined->y;
            break;
        }
'''
new_wall = '''        // The tracked quads can be hundreds of milliseconds old when six workers
        // are saturated. Measure the live residual once at several spatially
        // separated QRs and reuse an affine correction field across the wall.
        // One anchor degenerates to the old shared translation; two capture a
        // baseline gradient; three capture handheld rotation/scale/shear.
        const TurboWallMotion wallMotion = turboMeasureWallMotion(
            tracks, trackCount, yPlane, width, height, stride);
'''
if old_wall not in s:
    raise SystemExit("old shared wall correction block missing")
s = s.replace(old_wall, new_wall, 1)
s = s.replace(
    '''                    const float dx = wallCorrectionX;
                    const float dy = wallCorrectionY;
''',
    '''                    const PointF wallCorrection = wallMotion.correction(track);
                    const float dx = wallCorrection.x;
                    const float dy = wallCorrection.y;
''',
    1,
)
s = s.replace(
    '''                        const float dx = wallCorrectionX;
                        const float dy = wallCorrectionY;
''',
    '''                        const PointF wallCorrection = wallMotion.correction(track);
                        const float dx = wallCorrection.x;
                        const float dy = wallCorrection.y;
''',
    1,
)
s = s.replace('commitTurbo(i, decoded, wallCorrectionX, wallCorrectionY)', 'commitTurbo(i, decoded, wallCorrection.x, wallCorrection.y)')
if 'wallCorrectionX' in s or 'wallCorrectionY' in s:
    raise SystemExit("obsolete global wall correction remains")
cpp.write_text(s)

Path("vendor/decimen-codec/source/VERSION").write_text("0.1.56\n")
replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.260";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.262";')
replace_once("main.js", 'const APP_BUILD = "v0.5.260";', 'const APP_BUILD = "v0.5.262";')
index = Path("index.html").read_text().replace('v0.5.260', 'v0.5.262')
Path("index.html").write_text(index)
sw = Path("sw.js").read_text().replace('airgapper-static-js-v213', 'airgapper-static-js-v214', 1)
Path("sw.js").write_text(sw)
