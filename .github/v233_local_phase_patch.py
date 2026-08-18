from pathlib import Path

cpp=Path('vendor/decimen-codec/source/wrapper/decimen_codec.cpp')
s=cpp.read_text()

anchor='''static DetectorResult sampleGuidedSparse(const BitMatrix& image,'''
helper=r'''struct TurboLocalPhase {
    PointF offset{0, 0};
    TurboLevels levels;
    bool moved = false;
};

// A stable wall has one coherent coarse translation, but real camera optics and
// display resampling leave small per-slot phase errors. Search only the local
// sub-pixel neighborhood after cached decoding proves the shared phase is not
// enough. This never accepts bytes by geometry: QR RS + AirGapper CRC remain the
// acceptance gates, and a miss falls through to the existing sparse decoder.
static std::optional<TurboLocalPhase> turboRefineLocalPhase(
    const GuidedTurboTrack& cache, const DecimenGuidedTrack& track,
    const TurboFrameTransform& frameTransform,
    const uint8_t* yPlane, int width, int height, int stride,
    float predictedX, float predictedY, bool requireMove)
{
    TurboLocalPhase best;
    best.offset = PointF{predictedX, predictedY};
    int bestScore = -1;
    auto consider = [&](float dx, float dy) {
        const auto levels = turboReadLevels(cache, track, frameTransform,
                                            yPlane, width, height, stride, dx, dy);
        if (!levels.ok) return;
        const int score = levels.matches * 6 + levels.separation;
        if (score > bestScore) {
            bestScore = score;
            best.offset = PointF{dx, dy};
            best.levels = levels;
        }
    };

    consider(predictedX, predictedY);
    const float step = std::clamp(guidedModuleSize(track) * 0.18f, 0.30f, 0.55f);
    for (int oy = -1; oy <= 1; ++oy)
        for (int ox = -1; ox <= 1; ++ox)
            if (ox || oy)
                consider(predictedX + ox * step, predictedY + oy * step);

    if (bestScore < 0) {
        const float wide = std::max(0.75f, step * 2.0f);
        for (int oy = -1; oy <= 1; ++oy)
            for (int ox = -1; ox <= 1; ++ox)
                if (ox || oy)
                    consider(predictedX + ox * wide, predictedY + oy * wide);
    }
    if (bestScore < 0)
        return std::nullopt;
    best.moved = std::hypot(best.offset.x - predictedX, best.offset.y - predictedY) > 0.08f;
    if (requireMove && !best.moved)
        return std::nullopt;
    return best;
}

'''
if 'turboRefineLocalPhase(' not in s:
    if anchor not in s: raise SystemExit('local phase insertion anchor missing')
    s=s.replace(anchor,helper+anchor,1)

old='''                    const float dx = wallCorrectionX;
                    const float dy = wallCorrectionY;
                    const auto levels = turboReadLevels(*cache, track, frameTransform,
                                                        yPlane, width, height, stride, dx, dy);
                    if (!levels.ok) {
                        // A 147-cell finder miss is cheap evidence that this map
                        // no longer lands on the live modules. Let this same
                        // job's Guided fallback rebuild it instead of cooling it.
                        stableNeedsRefresh = true;
                    } else {'''
new='''                    float dx = wallCorrectionX;
                    float dy = wallCorrectionY;
                    auto levels = turboReadLevels(*cache, track, frameTransform,
                                                  yPlane, width, height, stride, dx, dy);
                    if (!levels.ok) {
                        ++metrics->stableLevelMisses;
                        ++metrics->localPhaseSearches;
                        if (const auto local = turboRefineLocalPhase(*cache, track, frameTransform,
                                                                     yPlane, width, height, stride,
                                                                     dx, dy, false)) {
                            dx = local->offset.x;
                            dy = local->offset.y;
                            levels = local->levels;
                            ++metrics->localPhaseFinderRecoveries;
                        }
                    }
                    if (!levels.ok) {
                        stableNeedsRefresh = true;
                    } else {'''
if old not in s: raise SystemExit('stable levels block missing')
s=s.replace(old,new,1)

start=s.index('// Every calibrated slot may use warped Stable-RS immediately.')
end=s.index('            metrics->fastDecodeMs += guidedNowMs() - turboStarted;', start)
section=s[start:end]
section=section.replace('commitTurbo(i, decoded, wallCorrectionX, wallCorrectionY)', 'commitTurbo(i, decoded, dx, dy)')
needle='''                            if (!success && centerOnlyRs) {
                                // No correctness regression: if single-center RS
                                // cannot reconstruct an exact CRC-valid packet,
                                // retry the old ambiguity-voted sampler before
                                // handing the slot to sparse Guided recovery.
                                decoded = decodeTurboStableRS(*cache, track, frameTransform,
                                                              yPlane, width, height, stride,
                                                              dx, dy, levels, *metrics, false);
                                success = commitTurbo(i, decoded, dx, dy);
                            }
                            if (success) {'''
retry=r'''                            if (!success && centerOnlyRs) {
                                decoded = decodeTurboStableRS(*cache, track, frameTransform,
                                                              yPlane, width, height, stride,
                                                              dx, dy, levels, *metrics, false);
                                success = commitTurbo(i, decoded, dx, dy);
                            }
                            if (!success) {
                                ++metrics->localPhaseSearches;
                                if (const auto local = turboRefineLocalPhase(*cache, track, frameTransform,
                                                                             yPlane, width, height, stride,
                                                                             dx, dy, true)) {
                                    ++metrics->localPhaseFinderRecoveries;
                                    const float localDx = local->offset.x;
                                    const float localDy = local->offset.y;
                                    auto retry = decodeTurboStableRS(*cache, track, frameTransform,
                                                                     yPlane, width, height, stride,
                                                                     localDx, localDy, local->levels,
                                                                     *metrics, centerOnlyRs);
                                    success = commitTurbo(i, retry, localDx, localDy);
                                    if (!success && centerOnlyRs) {
                                        retry = decodeTurboStableRS(*cache, track, frameTransform,
                                                                    yPlane, width, height, stride,
                                                                    localDx, localDy, local->levels,
                                                                    *metrics, false);
                                        success = commitTurbo(i, retry, localDx, localDy);
                                    }
                                    if (success)
                                        ++metrics->localPhaseDecodeRecoveries;
                                }
                            }
                            if (success) {'''
if needle not in section: raise SystemExit('stable RS retry anchor missing')
section=section.replace(needle,retry,1)
s=s[:start]+section+s[end:]

# Keep the C++/JS ABI size assertion in sync with the four added counters.
old_assert='''static_assert(sizeof(DecimenGuidedMetrics) == 160,
              "DecimenGuidedMetrics JS ABI must allocate 160 bytes");'''
new_assert='''static_assert(sizeof(DecimenGuidedMetrics) == 176,
              "DecimenGuidedMetrics JS ABI must allocate 176 bytes");'''
if old_assert not in s: raise SystemExit('guided metrics static_assert anchor missing')
s=s.replace(old_assert,new_assert,1)
cpp.write_text(s)

# Extend the guided metrics ABI with diagnostic-only phase counters.
h=Path('vendor/decimen-codec/source/wrapper/decimen_codec.h')
s=h.read_text()
old='''\tuint32_t stableRsAttempts;\n\tuint32_t stableRsSuccesses;\n\tuint32_t stableEligibleTracks;\n};'''
new='''\tuint32_t stableRsAttempts;\n\tuint32_t stableRsSuccesses;\n\tuint32_t stableEligibleTracks;\n\tuint32_t stableLevelMisses;\n\tuint32_t localPhaseSearches;\n\tuint32_t localPhaseFinderRecoveries;\n\tuint32_t localPhaseDecodeRecoveries;\n};'''
if old not in s: raise SystemExit('guided metrics header anchor missing')
h.write_text(s.replace(old,new,1))

w=Path('receive/worker.js')
s=w.read_text()
if 'const GUIDED_METRICS_BYTES = 160;' not in s: raise SystemExit('guided metrics byte size missing')
s=s.replace('const GUIDED_METRICS_BYTES = 160;', 'const GUIDED_METRICS_BYTES = 176;', 1)
old='''    stableRsAttempts: metricsView.getUint32(144, true),\n    stableRsSuccesses: metricsView.getUint32(148, true),\n    stableEligibleTracks: metricsView.getUint32(152, true)'''
new='''    stableRsAttempts: metricsView.getUint32(144, true),\n    stableRsSuccesses: metricsView.getUint32(148, true),\n    stableEligibleTracks: metricsView.getUint32(152, true),\n    stableLevelMisses: metricsView.getUint32(156, true),\n    localPhaseSearches: metricsView.getUint32(160, true),\n    localPhaseFinderRecoveries: metricsView.getUint32(164, true),\n    localPhaseDecodeRecoveries: metricsView.getUint32(168, true)'''
if old not in s: raise SystemExit('guided metrics JS anchor missing')
w.write_text(s.replace(old,new,1))

m=Path('receive/main.js')
s=m.read_text()
old='''stable ${lastGuidedMetrics.stableEligibleTracks ?? 0} · module ${(lastGuidedMetrics.moduleSizeAvg ?? 0).toFixed(2)}px [${(lastGuidedMetrics.moduleSizeMin ?? 0).toFixed(2)}–${(lastGuidedMetrics.moduleSizeMax ?? 0).toFixed(2)}] · RS'''
new='''stable ${lastGuidedMetrics.stableEligibleTracks ?? 0} · phase ${lastGuidedMetrics.localPhaseDecodeRecoveries ?? 0}/${lastGuidedMetrics.localPhaseSearches ?? 0} (finder ${lastGuidedMetrics.localPhaseFinderRecoveries ?? 0}, level miss ${lastGuidedMetrics.stableLevelMisses ?? 0}) · module ${(lastGuidedMetrics.moduleSizeAvg ?? 0).toFixed(2)}px [${(lastGuidedMetrics.moduleSizeMin ?? 0).toFixed(2)}–${(lastGuidedMetrics.moduleSizeMax ?? 0).toFixed(2)}] · RS'''
if old not in s: raise SystemExit('guided diagnostics module anchor missing')
s=s.replace(old,new,1)
old='''    stableRsSuccesses: sumGuided("stableRsSuccesses"),\n    dataOnlyAttempts: sumGuided("sparseNoRsAttempts"),'''
new='''    stableRsSuccesses: sumGuided("stableRsSuccesses"),\n    stableLevelMisses: sumGuided("stableLevelMisses"),\n    localPhaseSearches: sumGuided("localPhaseSearches"),\n    localPhaseFinderRecoveries: sumGuided("localPhaseFinderRecoveries"),\n    localPhaseDecodeRecoveries: sumGuided("localPhaseDecodeRecoveries"),\n    dataOnlyAttempts: sumGuided("sparseNoRsAttempts"),'''
if old not in s: raise SystemExit('benchmark guided metrics anchor missing')
s=s.replace(old,new,1)
m.write_text(s)

# v0.5.233 is the diagnostic baseline; this candidate becomes v0.5.234.
for path, old, new in [
    ('vendor/decimen-codec/source/VERSION','0.1.42','0.1.43'),
    ('main.js','v0.5.233','v0.5.234'),
    ('receive/main.js','v0.5.233','v0.5.234'),
    ('index.html','v0.5.233','v0.5.234'),
]:
    q=Path(path); text=q.read_text()
    if old not in text: raise SystemExit(f'{path}: version target missing')
    q.write_text(text.replace(old,new))
q=Path('sw.js'); text=q.read_text()
if 'airgapper-static-js-v189' not in text: raise SystemExit('sw cache target missing')
q.write_text(text.replace('airgapper-static-js-v189','airgapper-static-js-v190',1))
