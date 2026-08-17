from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"replacement not found in {path}: {old[:220]!r}")
    p.write_text(s.replace(old, new, count))


# Version/cache.
replace("index.html", "v0.5.209", "v0.5.210")
replace("main.js", 'const APP_BUILD = "v0.5.209";', 'const APP_BUILD = "v0.5.210";')
replace("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.209";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.210";')
replace("sw.js", 'const CACHE = "airgapper-static-js-v171";', 'const CACHE = "airgapper-static-js-v172";')
replace("vendor/decimen-codec/source/VERSION", "0.1.29", "0.1.30")

cpp = Path("vendor/decimen-codec/source/wrapper/decimen_codec.cpp")
s = cpp.read_text()

# Direct/projective Turbo already has a live seed->track transform, so its residual
# translation should normally be tiny. Check the predicted offset first and only
# widen the search when finder evidence says it is necessary. This avoids the old
# unconditional 58 finder-template evaluations on every direct probe.
old = '''static PointF turboRefineWallOffset(const GuidedTurboTrack& cache, const DecimenGuidedTrack& track,
                                    const PerspectiveTransform& frameTransform,
                                    const uint8_t* yPlane, int width, int height, int stride,
                                    float predictedX, float predictedY)
{
    PointF best{predictedX, predictedY};
    int bestScore = -1;
    for (int oy = -3; oy <= 3; ++oy)
        for (int ox = -3; ox <= 3; ++ox) {
            const float dx = predictedX + ox;
            const float dy = predictedY + oy;
            const auto levels = turboReadLevels(cache, track, frameTransform, yPlane, width, height, stride, dx, dy);
            if (!levels.ok)
                continue;
            const int score = levels.matches * 4 + levels.separation;
            if (score > bestScore) {
                bestScore = score;
                best = PointF{dx, dy};
            }
        }
    const PointF coarse = best;
    for (int hy = -1; hy <= 1; ++hy)
        for (int hx = -1; hx <= 1; ++hx) {
            const float dx = coarse.x + hx * 0.5f;
            const float dy = coarse.y + hy * 0.5f;
            const auto levels = turboReadLevels(cache, track, frameTransform, yPlane, width, height, stride, dx, dy);
            if (!levels.ok)
                continue;
            const int score = levels.matches * 4 + levels.separation;
            if (score > bestScore) {
                bestScore = score;
                best = PointF{dx, dy};
            }
        }
    return best;
}'''
new = '''static PointF turboRefineWallOffset(const GuidedTurboTrack& cache, const DecimenGuidedTrack& track,
                                    const PerspectiveTransform& frameTransform,
                                    const uint8_t* yPlane, int width, int height, int stride,
                                    float predictedX, float predictedY)
{
    PointF best{predictedX, predictedY};
    int bestScore = -1;
    int bestMatches = -1;
    auto consider = [&](float dx, float dy) {
        const auto levels = turboReadLevels(cache, track, frameTransform, yPlane, width, height, stride, dx, dy);
        if (!levels.ok) return;
        const int score = levels.matches * 4 + levels.separation;
        if (score > bestScore) {
            bestScore = score;
            bestMatches = levels.matches;
            best = PointF{dx, dy};
        }
    };
    consider(predictedX, predictedY);
    if (bestMatches < 143) {
        for (int oy = -1; oy <= 1; ++oy)
            for (int ox = -1; ox <= 1; ++ox)
                if (ox || oy)
                    consider(predictedX + ox, predictedY + oy);
    }
    if (bestMatches < 140) {
        for (int oy = -2; oy <= 2; ++oy)
            for (int ox = -2; ox <= 2; ++ox)
                if (std::max(std::abs(ox), std::abs(oy)) == 2)
                    consider(predictedX + ox, predictedY + oy);
    }
    if (bestMatches < 132) {
        for (int oy = -3; oy <= 3; ++oy)
            for (int ox = -3; ox <= 3; ++ox)
                if (std::max(std::abs(ox), std::abs(oy)) == 3)
                    consider(predictedX + ox, predictedY + oy);
    }
    if (bestScore >= 0) {
        const PointF coarse = best;
        for (int hy = -1; hy <= 1; ++hy)
            for (int hx = -1; hx <= 1; ++hx)
                if (hx || hy)
                    consider(coarse.x + hx * 0.5f, coarse.y + hy * 0.5f);
    }
    return best;
}'''
if old not in s: raise SystemExit("wall refine block missing")
s = s.replace(old, new, 1)

# Cooldowns are worker-job time, not only time when a slot happens to be selected
# as the single probation canary. Decay them once per Guided job so a bad canary
# can rotate to another calibrated slot instead of pinning probation.
old = '''        auto& turboAdaptive = guidedTurboAdaptive();
        if (turboAdaptive.cooldown)
            --turboAdaptive.cooldown;

        int canaryIndex = -1;'''
new = '''        auto& turboAdaptive = guidedTurboAdaptive();
        if (turboAdaptive.cooldown)
            --turboAdaptive.cooldown;
        for (auto& cache : guidedTurboTracks())
            if (cache.cooldown)
                --cache.cooldown;

        int canaryIndex = -1;'''
if old not in s: raise SystemExit("adaptive cooldown block missing")
s = s.replace(old, new, 1)

# Probation should select a cache that is actually available this job.
s = s.replace('''                if (!cache || !cache->seeded || !cache->distortionAware ||
                    guidedModuleSize(tracks[i]) < GUIDED_TURBO_CANARY_MIN_MODULE)''', '''                if (!cache || !cache->seeded || !cache->distortionAware || cache->cooldown ||
                    guidedModuleSize(tracks[i]) < GUIDED_TURBO_CANARY_MIN_MODULE)''', 1)
s = s.replace('''                    if (cache && cache->seeded &&
                        guidedModuleSize(tracks[i]) >= GUIDED_TURBO_CANARY_MIN_MODULE) {''', '''                    if (cache && cache->seeded && !cache->cooldown &&
                        guidedModuleSize(tracks[i]) >= GUIDED_TURBO_CANARY_MIN_MODULE) {''', 1)

# The v208 safety gate made one canary's finder-refinement success a prerequisite
# for Stable-RS across the entire job. That starved a decoder which is independently
# finder-gated per slot. Search up to three rigid caches for a useful shared residual,
# but a missing shared refinement is not a veto: zero residual is safe because each
# Stable-RS slot validates its own finder levels before reading codewords.
old = '''        float stableResidualX = 0, stableResidualY = 0;
        bool stableReference = false;
        for (int i = 0; i < trackCount; ++i) {
            auto* cache = guidedTurboTrack(tracks[i].id);
            if (!cache || !cache->seeded || !turboAllowed(i))
                continue;
            float poseX = 0, poseY = 0, residual = 0;
            if (!turboPose(*cache, tracks[i], poseX, poseY, residual) ||
                !turboStableRigidEligible(*cache, tracks[i], residual))
                continue;
            const auto refined = turboRefineRigidOffset(*cache, yPlane, width, height, stride, poseX, poseY);
            if (!refined)
                continue;
            stableResidualX = refined->x - poseX;
            stableResidualY = refined->y - poseY;
            stableReference = true;
            break;
        }
'''
new = '''        float stableResidualX = 0, stableResidualY = 0;
        int stableReferenceTries = 0;
        for (int i = 0; i < trackCount && stableReferenceTries < 3; ++i) {
            auto* cache = guidedTurboTrack(tracks[i].id);
            if (!cache || !cache->seeded || !cache->distortionAware || cache->cooldown)
                continue;
            float poseX = 0, poseY = 0, residual = 0;
            if (!turboPose(*cache, tracks[i], poseX, poseY, residual) ||
                !turboStableRigidEligible(*cache, tracks[i], residual))
                continue;
            ++stableReferenceTries;
            const auto refined = turboRefineRigidOffset(*cache, yPlane, width, height, stride, poseX, poseY);
            if (!refined)
                continue;
            stableResidualX = refined->x - poseX;
            stableResidualY = refined->y - poseY;
            break;
        }
'''
if old not in s: raise SystemExit("stable reference block missing")
s = s.replace(old, new, 1)

old = '''            if (cache->cooldown) {
                --cache->cooldown;
                continue;
            }
            float poseX = 0, poseY = 0, residual = 0;
            if (!turboPose(*cache, track, poseX, poseY, residual))
                continue;
            const bool stableEligible = stableReference && turboStableRigidEligible(*cache, track, residual);
            if (stableEligible)
                ++metrics->stableEligibleTracks;'''
new = '''            if (cache->cooldown)
                continue;
            float poseX = 0, poseY = 0, residual = 0;
            if (!turboPose(*cache, track, poseX, poseY, residual))
                continue;
            // `rigid` now means exactly what diagnostics need: this cache/track
            // geometry can use the rigid Stable-RS sampler. Finder contrast is a
            // separate, cheap per-slot gate and must not erase this opportunity.
            const bool stableEligible = turboStableRigidEligible(*cache, track, residual);
            if (stableEligible)
                ++metrics->stableEligibleTracks;'''
if old not in s: raise SystemExit("stable eligibility block missing")
s = s.replace(old, new, 1)

# Distinguish a cheap Turbo candidate from an actual decoder execution. v208 counted
# finder/level misses as failed canary/promoted decodes, causing repeated pauses and
# map refreshes without Stable-RS ever running.
s = s.replace('''            bool success = false;
            bool directSuccess = false;
            bool stableRsAttempted = false;

            if (directMode) {''', '''            bool success = false;
            bool directSuccess = false;
            bool directAttempted = false;
            bool stableRsAttempted = false;

            if (directMode) {''', 1)
s = s.replace('''                    if (levels.ok) {
                        ++metrics->sampleAttempts;
                        ++metrics->sparseNoRsAttempts;''', '''                    if (levels.ok) {
                        directAttempted = true;
                        ++metrics->sampleAttempts;
                        ++metrics->sparseNoRsAttempts;''', 1)

old = '''            metrics->fastDecodeMs += guidedNowMs() - turboStarted;
            if (success) {
                ++metrics->turboSuccesses;
                cache->misses = 0;
                cache->cooldown = 0;
            } else if (turboAdaptive.promoted && turboAdaptive.rsMode) {
                if (++cache->misses >= 4) {
                    cache->misses = 0;
                    cache->cooldown = 2;
                }
            } else if (++cache->misses >= 2) {
                cache->misses = 0;
                cache->cooldown = GUIDED_TURBO_BAD_COOLDOWN;
            }

            if (!turboAdaptive.promoted) {
                ++turboAdaptive.canaryAttempts;
                turboAdaptive.canaryDirectSuccesses += int(directSuccess);
                if (stableRsAttempted) {
                    ++turboAdaptive.canaryStableAttempts;
                    turboAdaptive.canaryStableSuccesses += int(success);
                }

                const bool directEarly = turboAdaptive.canaryAttempts >= 4 &&
                                         turboAdaptive.canaryDirectSuccesses == turboAdaptive.canaryAttempts;
                const bool stableEarly = turboAdaptive.canaryStableAttempts >= 4 &&
                                         turboAdaptive.canaryStableSuccesses * 4 >=
                                         turboAdaptive.canaryStableAttempts * 3;
                bool promoteDirect = directEarly;
                bool promoteStable = stableEarly;
                if (!promoteDirect && !promoteStable && turboAdaptive.canaryAttempts >= 8) {
                    promoteDirect = turboAdaptive.canaryDirectSuccesses * 4 >=
                                    turboAdaptive.canaryAttempts * 3;
                    promoteStable = turboAdaptive.canaryStableAttempts >= 6 &&
                                    turboAdaptive.canaryStableSuccesses * 2 >=
                                    turboAdaptive.canaryStableAttempts;
                }
                if (promoteDirect || promoteStable) {
                    turboAdaptive.promoted = true;
                    turboAdaptive.rsMode = promoteStable && !promoteDirect;
                    turboAdaptive.canaryAttempts = 0;
                    turboAdaptive.canaryDirectSuccesses = 0;
                    turboAdaptive.canaryStableAttempts = 0;
                    turboAdaptive.canaryStableSuccesses = 0;
                    turboAdaptive.promotedAttempts = 0;
                    turboAdaptive.promotedSuccesses = 0;
                } else if (turboAdaptive.canaryAttempts >= 10) {
                    pauseTurbo(false);
                }
            } else {
                ++turboAdaptive.promotedAttempts;
                turboAdaptive.promotedSuccesses += int(success);
                const int evaluationWindow = turboAdaptive.rsMode ? 72 : 36;
                if (turboAdaptive.promotedAttempts >= evaluationWindow) {
                    const bool tooWeak = turboAdaptive.rsMode
                        ? turboAdaptive.promotedSuccesses * 10 < turboAdaptive.promotedAttempts * 3
                        : turboAdaptive.promotedSuccesses * 2 < turboAdaptive.promotedAttempts;
                    if (tooWeak)
                        pauseTurbo(turboAdaptive.rsMode, turboAdaptive.rsMode ? 4 : GUIDED_TURBO_CANARY_COOLDOWN);
                    else {
                        turboAdaptive.promotedAttempts = 0;
                        turboAdaptive.promotedSuccesses = 0;
                    }
                }
            }'''
new = '''            metrics->fastDecodeMs += guidedNowMs() - turboStarted;
            const bool decoderAttempted = directAttempted || stableRsAttempted;
            if (success) {
                ++metrics->turboSuccesses;
                cache->misses = 0;
                cache->cooldown = 0;
            } else if (decoderAttempted) {
                if (turboAdaptive.promoted && turboAdaptive.rsMode) {
                    if (++cache->misses >= 4) {
                        cache->misses = 0;
                        cache->cooldown = 2;
                    }
                } else if (++cache->misses >= 2) {
                    cache->misses = 0;
                    cache->cooldown = GUIDED_TURBO_BAD_COOLDOWN;
                }
            } else {
                // No decoder ran, so this is anchor evidence rather than a decode
                // failure. Briefly rotate away from this slot during probation.
                cache->cooldown = std::max<uint8_t>(cache->cooldown, 2);
            }

            if (!turboAdaptive.promoted) {
                if (!decoderAttempted)
                    continue;
                ++turboAdaptive.canaryAttempts;
                turboAdaptive.canaryDirectSuccesses += int(directSuccess);
                if (stableRsAttempted) {
                    ++turboAdaptive.canaryStableAttempts;
                    turboAdaptive.canaryStableSuccesses += int(success);
                }

                const bool directEarly = turboAdaptive.canaryAttempts >= 4 &&
                                         turboAdaptive.canaryDirectSuccesses == turboAdaptive.canaryAttempts;
                const bool stableEarly = turboAdaptive.canaryStableAttempts >= 4 &&
                                         turboAdaptive.canaryStableSuccesses * 4 >=
                                         turboAdaptive.canaryStableAttempts * 3;
                bool promoteDirect = directEarly;
                bool promoteStable = stableEarly;
                if (!promoteDirect && !promoteStable && turboAdaptive.canaryAttempts >= 8) {
                    promoteDirect = turboAdaptive.canaryDirectSuccesses * 4 >=
                                    turboAdaptive.canaryAttempts * 3;
                    promoteStable = turboAdaptive.canaryStableAttempts >= 6 &&
                                    turboAdaptive.canaryStableSuccesses * 2 >=
                                    turboAdaptive.canaryStableAttempts;
                }
                if (promoteDirect || promoteStable) {
                    turboAdaptive.promoted = true;
                    turboAdaptive.rsMode = promoteStable && !promoteDirect;
                    turboAdaptive.canaryAttempts = 0;
                    turboAdaptive.canaryDirectSuccesses = 0;
                    turboAdaptive.canaryStableAttempts = 0;
                    turboAdaptive.canaryStableSuccesses = 0;
                    turboAdaptive.promotedAttempts = 0;
                    turboAdaptive.promotedSuccesses = 0;
                } else if (turboAdaptive.canaryAttempts >= 10) {
                    pauseTurbo(false);
                }
            } else if (decoderAttempted) {
                ++turboAdaptive.promotedAttempts;
                turboAdaptive.promotedSuccesses += int(success);
                const int evaluationWindow = turboAdaptive.rsMode ? 72 : 36;
                if (turboAdaptive.promotedAttempts >= evaluationWindow) {
                    const bool tooWeak = turboAdaptive.rsMode
                        ? turboAdaptive.promotedSuccesses * 10 < turboAdaptive.promotedAttempts * 3
                        : turboAdaptive.promotedSuccesses * 2 < turboAdaptive.promotedAttempts;
                    if (tooWeak)
                        pauseTurbo(turboAdaptive.rsMode, turboAdaptive.rsMode ? 4 : GUIDED_TURBO_CANARY_COOLDOWN);
                    else {
                        turboAdaptive.promotedAttempts = 0;
                        turboAdaptive.promotedSuccesses = 0;
                    }
                }
            }'''
if old not in s: raise SystemExit("turbo evidence block missing")
s = s.replace(old, new, 1)

cpp.write_text(s)
