from pathlib import Path

p=Path('vendor/decimen-codec/source/wrapper/decimen_codec.cpp')
s=p.read_text()

anchor='''static DetectorResult sampleGuidedSparse(const BitMatrix& image,'''
helper=r'''struct TurboLocalPhase {
    PointF offset{0, 0};
    TurboLevels levels;
    bool moved = false;
};

// The coherent wall offset is intentionally shared, but a real camera can put
// individual dense QRs at a slightly different sub-pixel phase because of lens
// distortion, lattice prediction error and display/camera resampling. When a
// slot's finder evidence or RS decode disagrees, search only its immediate
// sub-pixel neighborhood before paying HybridBinarizer + sparse Guided. This is
// a recovery tier, never an acceptance shortcut: QR RS + AirGapper CRC still
// decide whether any locally-refined sample is usable.
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

    // If the shared correction did not even land on a valid finder template,
    // widen once to roughly one camera pixel. Do not run the old +/-3px wall
    // search for every slot; local recovery must remain cheaper than Guided.
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
                        if (const auto local = turboRefineLocalPhase(*cache, track, frameTransform,
                                                                     yPlane, width, height, stride,
                                                                     dx, dy, false)) {
                            dx = local->offset.x;
                            dy = local->offset.y;
                            levels = local->levels;
                        }
                    }
                    if (!levels.ok) {
                        // The shared wall phase can be wrong for one optically
                        // distorted slot. Only declare the map stale after the
                        // cheap local phase search also fails.
                        stableNeedsRefresh = true;
                    } else {'''
if old not in s: raise SystemExit('stable levels block missing')
s=s.replace(old,new,1)

# In the stable block, accepted geometry must use the slot-local correction.
# Restrict replacements to the section between the stable block and metrics tail.
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
                                // No correctness regression: if single-center RS
                                // cannot reconstruct an exact CRC-valid packet,
                                // retry the old ambiguity-voted sampler before
                                // handing the slot to sparse Guided recovery.
                                decoded = decodeTurboStableRS(*cache, track, frameTransform,
                                                              yPlane, width, height, stride,
                                                              dx, dy, levels, *metrics, false);
                                success = commitTurbo(i, decoded, dx, dy);
                            }
                            if (!success) {
                                // Finder evidence can remain valid while the
                                // cached data-cell phase is half a camera pixel
                                // off. On an RS miss, test the best neighboring
                                // finder phase once before invoking sparse Guided.
                                if (const auto local = turboRefineLocalPhase(*cache, track, frameTransform,
                                                                             yPlane, width, height, stride,
                                                                             dx, dy, true)) {
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
                                }
                            }
                            if (success) {'''
if needle not in section: raise SystemExit('stable RS retry anchor missing')
section=section.replace(needle,retry,1)
s=s[:start]+section+s[end:]

p.write_text(s)

# Version/cache bump only when the candidate is actually applied.
for path, old, new in [
    ('vendor/decimen-codec/source/VERSION','0.1.42','0.1.43'),
    ('main.js','v0.5.232','v0.5.233'),
    ('receive/main.js','v0.5.232','v0.5.233'),
    ('index.html','v0.5.232','v0.5.233'),
]:
    q=Path(path); text=q.read_text()
    if old not in text: raise SystemExit(f'{path}: version target missing')
    q.write_text(text.replace(old,new))

q=Path('sw.js'); text=q.read_text()
import re
m=re.search(r'airgapper-static-js-v(\d+)',text)
if not m: raise SystemExit('sw cache version missing')
text=text[:m.start(1)]+str(int(m.group(1))+1)+text[m.end(1):]
q.write_text(text)
