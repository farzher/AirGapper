from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"replacement not found in {path}: {old[:260]!r}")
    p.write_text(s.replace(old, new, count))

replace("index.html", "v0.5.215", "v0.5.216")
replace("main.js", 'const APP_BUILD = "v0.5.215";', 'const APP_BUILD = "v0.5.216";')
replace("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.215";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.216";')
replace("sw.js", 'const CACHE = "airgapper-static-js-v177";', 'const CACHE = "airgapper-static-js-v178";')
replace("vendor/decimen-codec/source/VERSION", "0.1.32", "0.1.33")

p = Path("vendor/decimen-codec/source/wrapper/decimen_codec.cpp")
s = p.read_text()

old = '''static bool turboStableWarpEligible(const GuidedTurboTrack& cache,
                                     const DecimenGuidedTrack& track, float residual)
{
    if (!cache.distortionAware)
        return false;
    const float module = guidedModuleSize(track);
    // Stable-RS now warps the calibrated distortion map from its seed quad to
    // the coherent live track quad. Keep only the broad stale-cache sanity gate
    // used by projective Turbo; the old ~1 px near-translation fence starved
    // >90% of a perfectly stationary wall before RS could even be attempted.
    return module >= GUIDED_TURBO_CANARY_MIN_MODULE &&
           residual <= std::max(4.0f, module * 2.0f);
}'''
new = '''static bool turboStableWarpEligible(const GuidedTurboTrack& cache,
                                     const DecimenGuidedTrack& track)
{
    if (!cache.seeded || !cache.distortionAware || cache.dimension != track.dimension ||
        cache.samples.size() != size_t(track.dimension) * track.dimension)
        return false;
    // The calibrated sample map is explicitly warped from seedQuad to the live
    // coherent quad below. Seed-vs-live shape residual is therefore not a safety
    // criterion. Finder pixels + QR RS + AirGapper CRC are the live evidence.
    return guidedModuleSize(track) >= GUIDED_TURBO_CANARY_MIN_MODULE;
}'''
if old not in s:
    raise SystemExit("stable eligibility block missing")
s = s.replace(old, new, 1)

old = '''static PointF turboRefineWallOffset(const GuidedTurboTrack& cache, const DecimenGuidedTrack& track,
                                    const PerspectiveTransform& frameTransform,
                                    const uint8_t* yPlane, int width, int height, int stride,
                                    float predictedX, float predictedY)'''
new = '''static std::optional<PointF> turboRefineWallOffset(const GuidedTurboTrack& cache, const DecimenGuidedTrack& track,
                                                   const PerspectiveTransform& frameTransform,
                                                   const uint8_t* yPlane, int width, int height, int stride,
                                                   float predictedX, float predictedY)'''
if old not in s:
    raise SystemExit("wall refine signature missing")
s = s.replace(old, new, 1)

old = '''    if (bestScore >= 0) {
        const PointF coarse = best;
        for (int hy = -1; hy <= 1; ++hy)
            for (int hx = -1; hx <= 1; ++hx)
                if (hx || hy)
                    consider(coarse.x + hx * 0.5f, coarse.y + hy * 0.5f);
    }
    return best;
}'''
new = '''    if (bestScore < 0)
        return std::nullopt;
    const PointF coarse = best;
    for (int hy = -1; hy <= 1; ++hy)
        for (int hx = -1; hx <= 1; ++hx)
            if (hx || hy)
                consider(coarse.x + hx * 0.5f, coarse.y + hy * 0.5f);
    return best;
}'''
if old not in s:
    raise SystemExit("wall refine return block missing")
s = s.replace(old, new, 1)

old = '''        int canaryIndex = -1;
        if (!turboAdaptive.promoted && !turboAdaptive.cooldown) {
            // First choice: any distortion-aware map whose cached geometry is
            // still close enough for a projective seed->live warp. Stable-RS no
            // longer requires the seed quad to remain near-translation rigid.
            for (int i = 0; i < trackCount; ++i) {
                auto* cache = guidedTurboTrack(tracks[i].id);
                if (!cache || !cache->seeded || !cache->distortionAware || cache->cooldown ||
                    guidedModuleSize(tracks[i]) < GUIDED_TURBO_CANARY_MIN_MODULE)
                    continue;
                float dx = 0, dy = 0, residual = 0;
                if (turboPose(*cache, tracks[i], dx, dy, residual) &&
                    turboStableWarpEligible(*cache, tracks[i], residual)) {
                    canaryIndex = i;
                    break;
                }
            }
            // Direct Turbo can still probe a non-rigid cached slot when no
            // Stable-RS candidate exists; do not stall probation completely.
            if (canaryIndex < 0) {
                for (int i = 0; i < trackCount; ++i) {
                    auto* cache = guidedTurboTrack(tracks[i].id);
                    if (cache && cache->seeded && !cache->cooldown &&
                        guidedModuleSize(tracks[i]) >= GUIDED_TURBO_CANARY_MIN_MODULE) {
                        canaryIndex = i;
                        break;
                    }
                }
            }
        }'''
new = '''        int canaryIndex = -1;
        if (!turboAdaptive.promoted && !turboAdaptive.cooldown) {
            // The global canary now exists only for the weaker homography-only
            // data path. Distortion-aware Stable-RS slots are independent.
            for (int i = 0; i < trackCount; ++i) {
                auto* cache = guidedTurboTrack(tracks[i].id);
                if (cache && cache->seeded && !cache->distortionAware && !cache->cooldown &&
                    guidedModuleSize(tracks[i]) >= GUIDED_TURBO_CANARY_MIN_MODULE) {
                    canaryIndex = i;
                    break;
                }
            }
        }'''
if old not in s:
    raise SystemExit("canary block missing")
s = s.replace(old, new, 1)

old = '''        float wallCorrectionX = 0, wallCorrectionY = 0;
        for (int i = 0; i < trackCount; ++i) {
            auto* cache = guidedTurboTrack(tracks[i].id);
            if (!cache || !cache->seeded || !cache->distortionAware || cache->cooldown)
                continue;
            float dx = 0, dy = 0, residual = 0;
            if (!turboPose(*cache, tracks[i], dx, dy, residual) ||
                !turboStableWarpEligible(*cache, tracks[i], residual))
                continue;
            const auto frameTransform = turboFrameTransform(*cache, tracks[i]);
            if (!frameTransform.isValid())
                continue;
            const PointF refined = turboRefineWallOffset(*cache, tracks[i], frameTransform,
                                                          yPlane, width, height, stride, 0, 0);
            wallCorrectionX = refined.x;
            wallCorrectionY = refined.y;
            break;
        }'''
new = '''        float wallCorrectionX = 0, wallCorrectionY = 0;
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
        }'''
if old not in s:
    raise SystemExit("wall correction block missing")
s = s.replace(old, new, 1)

old = '''            auto* cache = guidedTurboTrack(track.id);
            if (!cache || !cache->seeded || cache->cooldown)
                continue;
            float poseX = 0, poseY = 0, residual = 0;
            if (!turboPose(*cache, track, poseX, poseY, residual))
                continue;
            // Warped Stable-RS is independently safe per slot because a result
            // is accepted only after QR Reed-Solomon and AirGapper CRC. Do not
            // make 17 good calibrated slots wait for one global canary state.
            const bool stableEligible = turboStableWarpEligible(*cache, track, residual);
            const bool directEligible = turboAllowed(i);
            if (!stableEligible && !directEligible)
                continue;'''
new = '''            auto* cache = guidedTurboTrack(track.id);
            if (!cache || !cache->seeded)
                continue;
            // Stable-RS ignores the old direct-Turbo cooldown. Its projective
            // warp has independent finder/RS/CRC evidence and self-heals below.
            const bool stableEligible = turboStableWarpEligible(*cache, track);
            float poseX = 0, poseY = 0, residual = 0;
            const bool directEligible = !stableEligible && !cache->cooldown && turboAllowed(i) &&
                turboPose(*cache, track, poseX, poseY, residual);
            if (!stableEligible && !directEligible)
                continue;'''
if old not in s:
    raise SystemExit("slot eligibility block missing")
s = s.replace(old, new, 1)

old = '''            if (!success && stableEligible) {
                const auto frameTransform = turboFrameTransform(*cache, track);
                if (frameTransform.isValid()) {
                    const float dx = wallCorrectionX;
                    const float dy = wallCorrectionY;
                    const auto levels = turboReadLevels(*cache, track, frameTransform,
                                                        yPlane, width, height, stride, dx, dy);
                    if (levels.ok) {
                        stableRsAttempted = true;
                        ++metrics->sampleAttempts;
                        ++metrics->sparseRsFallbacks;
                        ++metrics->stableRsAttempts;
                        auto decoded = decodeTurboStableRS(*cache, track, frameTransform,
                                                           yPlane, width, height, stride,
                                                           dx, dy, levels, *metrics);
                        success = commitTurbo(i, decoded, wallCorrectionX, wallCorrectionY);
                        if (success)
                            ++metrics->stableRsSuccesses;
                    }
                }
            }'''
new = '''            bool stableNeedsRefresh = false;
            if (!success && stableEligible) {
                const auto frameTransform = turboFrameTransform(*cache, track);
                if (!frameTransform.isValid()) {
                    stableNeedsRefresh = true;
                } else {
                    const float dx = wallCorrectionX;
                    const float dy = wallCorrectionY;
                    const auto levels = turboReadLevels(*cache, track, frameTransform,
                                                        yPlane, width, height, stride, dx, dy);
                    if (!levels.ok) {
                        // A 147-cell finder miss is cheap evidence that this map
                        // no longer lands on the live modules. Let this same
                        // job's Guided fallback rebuild it instead of cooling it.
                        stableNeedsRefresh = true;
                    } else {
                        stableRsAttempted = true;
                        ++metrics->sampleAttempts;
                        ++metrics->sparseRsFallbacks;
                        ++metrics->stableRsAttempts;
                        auto decoded = decodeTurboStableRS(*cache, track, frameTransform,
                                                           yPlane, width, height, stride,
                                                           dx, dy, levels, *metrics);
                        success = commitTurbo(i, decoded, wallCorrectionX, wallCorrectionY);
                        if (success)
                            ++metrics->stableRsSuccesses;
                    }
                }
            }'''
if old not in s:
    raise SystemExit("stable branch missing")
s = s.replace(old, new, 1)

old = '''            if (success) {
                ++metrics->turboSuccesses;
                cache->misses = 0;
                cache->cooldown = 0;
            } else if (decoderAttempted) {
                if (stableRsAttempted) {
                    // Stable-RS failure is local evidence about this calibrated
                    // slot, never evidence that the whole wall/worker is bad.
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
            }'''
new = '''            if (success) {
                ++metrics->turboSuccesses;
                cache->misses = 0;
                cache->cooldown = 0;
            } else if (stableNeedsRefresh) {
                // Guided runs later in this same batch. Marking only this map
                // stale makes turboSeedEligible() capture its fresh sparse map.
                cache->misses = 0;
                cache->cooldown = 0;
                cache->distortionAware = false;
            } else if (stableRsAttempted) {
                // A single RS miss can be sender/camera phase noise. Repeated
                // misses mean the calibrated map is no longer earning its keep;
                // relearn it from the Guided fallback instead of parking it.
                if (++cache->misses >= 2) {
                    cache->misses = 0;
                    cache->cooldown = 0;
                    cache->distortionAware = false;
                }
            } else if (directAttempted) {
                if (++cache->misses >= 2) {
                    cache->misses = 0;
                    cache->cooldown = GUIDED_TURBO_BAD_COOLDOWN;
                }
            } else if (!stableEligible) {
                cache->cooldown = std::max<uint8_t>(cache->cooldown, 2);
            }'''
if old not in s:
    raise SystemExit("cache evidence block missing")
s = s.replace(old, new, 1)

p.write_text(s)
