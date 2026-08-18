from pathlib import Path

p=Path('vendor/decimen-codec/source/wrapper/decimen_codec.cpp')
s=p.read_text()
start=s.find('static std::optional<TurboLocalPhase> turboRefineLocalPhase(')
end=s.find('\nstatic DetectorResult sampleGuidedSparse(', start)
if start < 0 or end < 0:
    raise SystemExit('local phase helper not found after base candidate patch')

replacement=r'''static int turboPhaseContrastScore(
    const GuidedTurboTrack& cache, const DecimenGuidedTrack& track,
    const TurboFrameTransform& frameTransform,
    const uint8_t* yPlane, int width, int height, int stride,
    float dx, float dy)
{
    // Phase selection does not need a full 147-cell finder verification at
    // every candidate. Sample a small set of high-information black/white
    // modules from each finder; the winning candidate still has to pass the
    // complete turboReadLevels check before any QR decode is attempted.
    struct Probe { uint8_t x, y; bool black; };
    static constexpr Probe probes[] = {
        {0,0,true}, {3,0,true}, {6,0,true}, {0,3,true}, {6,3,true}, {3,3,true},
        {1,1,false}, {3,1,false}, {5,1,false}, {1,3,false}, {5,3,false}, {3,5,false}
    };
    const int dim = cache.dimension;
    const PointI starts[3] = {{0, 0}, {dim - 7, 0}, {0, dim - 7}};
    int total = 0;
    for (const auto& start : starts) {
        int blackSum = 0, whiteSum = 0, blackCount = 0, whiteCount = 0;
        for (const auto& probe : probes) {
            const int sx = start.x + probe.x;
            const int sy = start.y + probe.y;
            const int lum = turboLum(yPlane, width, height, stride,
                turboWarpedPoint(cache, frameTransform, sx, sy), dx, dy);
            if (lum < 0)
                return -1;
            if (probe.black) { blackSum += lum; ++blackCount; }
            else { whiteSum += lum; ++whiteCount; }
        }
        const int black = blackSum / blackCount;
        const int white = whiteSum / whiteCount;
        const int sep = white - black;
        if (sep < 16)
            return -1;
        total += sep;
    }
    return total;
}

static std::optional<TurboLocalPhase> turboRefineLocalPhase(
    const GuidedTurboTrack& cache, const DecimenGuidedTrack& track,
    const TurboFrameTransform& frameTransform,
    const uint8_t* yPlane, int width, int height, int stride,
    float predictedX, float predictedY, bool requireMove)
{
    TurboLocalPhase best;
    int bestScore = -1;
    auto consider = [&](float dx, float dy) {
        const int score = turboPhaseContrastScore(cache, track, frameTransform,
                                                   yPlane, width, height, stride, dx, dy);
        if (score > bestScore) {
            bestScore = score;
            best.offset = PointF{dx, dy};
        }
    };
    auto searchNeighbors = [&](float step, bool includeCenter) {
        bestScore = -1;
        if (includeCenter)
            consider(predictedX, predictedY);
        for (int oy = -1; oy <= 1; ++oy)
            for (int ox = -1; ox <= 1; ++ox)
                if (ox || oy)
                    consider(predictedX + ox * step, predictedY + oy * step);
        if (bestScore < 0)
            return false;
        best.levels = turboReadLevels(cache, track, frameTransform, yPlane,
                                      width, height, stride,
                                      best.offset.x, best.offset.y);
        return best.levels.ok;
    };

    const float step = std::clamp(guidedModuleSize(track) * 0.18f, 0.30f, 0.55f);
    // On an RS failure the predicted phase has already been tried, so compare
    // neighboring phases only. On a finder-level miss, include the prediction
    // because the cheap contrast probes may still identify it as usable.
    bool ok = searchNeighbors(step, !requireMove);
    if (!ok) {
        const float wide = std::max(0.75f, step * 2.0f);
        ok = searchNeighbors(wide, false);
    }
    if (!ok)
        return std::nullopt;
    best.moved = std::hypot(best.offset.x - predictedX, best.offset.y - predictedY) > 0.08f;
    if (requireMove && !best.moved)
        return std::nullopt;
    return best;
}
'''
s=s[:start]+replacement+s[end:]
p.write_text(s)
