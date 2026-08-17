from pathlib import Path

p = Path("vendor/decimen-codec/source/wrapper/decimen_codec.cpp")
s = p.read_text()

old = '''    std::vector<PointF> samples;
    uint8_t misses = 0;
    uint8_t cooldown = 0;
};'''
new = '''    std::vector<PointF> samples;
    uint8_t misses = 0;
    uint8_t cooldown = 0;
    // CRC-backed Stable-RS successes qualify this calibrated map for the even
    // cheaper data-only probe. This is per physical slot and is reset whenever
    // Guided replaces the map.
    uint8_t stableSuccesses = 0;
};'''
if old not in s:
    raise SystemExit("GuidedTurboTrack fields target not found")
s = s.replace(old, new, 1)

old = '''    cache->samples = std::move(samples);
    cache->misses = 0;
    cache->cooldown = 0;
}'''
new = '''    cache->samples = std::move(samples);
    cache->misses = 0;
    cache->cooldown = 0;
    cache->stableSuccesses = 0;
}'''
if old not in s:
    raise SystemExit("seedGuidedTurbo reset target not found")
s = s.replace(old, new, 1)

old = '''                    } else {
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
                    }'''
new = '''                    } else {
                        // Once this exact distortion-aware map has repeatedly
                        // survived QR RS + AirGapper CRC, try the existing
                        // data-only decoder first on sufficiently resolved QRs.
                        // Its CRC is still an exact acceptance gate. A miss pays
                        // no correctness cost: Stable-RS runs immediately below
                        // and the data-only probe backs off briefly.
                        const bool stableDirectEligible =
                            guidedModuleSize(track) >= GUIDED_TURBO_CANARY_MIN_MODULE &&
                            cache->stableSuccesses >= 2 && !cache->cooldown;
                        if (stableDirectEligible) {
                            directAttempted = true;
                            ++metrics->sampleAttempts;
                            ++metrics->sparseNoRsAttempts;
                            auto decoded = decodeTurboDataOnly(*cache, track, frameTransform,
                                                               yPlane, width, height, stride,
                                                               dx, dy, levels, *metrics);
                            directSuccess = commitTurbo(i, decoded, wallCorrectionX, wallCorrectionY);
                            success = directSuccess;
                            if (directSuccess)
                                ++metrics->sparseNoRsSuccesses;
                            else
                                cache->cooldown = std::max<uint8_t>(cache->cooldown, 2);
                        }
                        if (!success) {
                            stableRsAttempted = true;
                            ++metrics->sampleAttempts;
                            ++metrics->sparseRsFallbacks;
                            ++metrics->stableRsAttempts;
                            auto decoded = decodeTurboStableRS(*cache, track, frameTransform,
                                                               yPlane, width, height, stride,
                                                               dx, dy, levels, *metrics);
                            success = commitTurbo(i, decoded, wallCorrectionX, wallCorrectionY);
                            if (success) {
                                ++metrics->stableRsSuccesses;
                                cache->stableSuccesses = uint8_t(std::min(255, int(cache->stableSuccesses) + 1));
                            }
                        }
                    }'''
if old not in s:
    raise SystemExit("Stable-RS decode block target not found")
s = s.replace(old, new, 1)

old = '''            if (success) {
                ++metrics->turboSuccesses;
                cache->misses = 0;
                cache->cooldown = 0;
            } else if (stableNeedsRefresh) {'''
new = '''            if (success) {
                ++metrics->turboSuccesses;
                cache->misses = 0;
                // A failed data-only probe recovered by Stable-RS is useful
                // evidence to pause only that probe; do not erase its backoff.
                if (!(stableEligible && directAttempted && !directSuccess))
                    cache->cooldown = 0;
            } else if (stableNeedsRefresh) {'''
if old not in s:
    raise SystemExit("turbo success block target not found")
s = s.replace(old, new, 1)

old = '''                cache->misses = 0;
                cache->cooldown = 0;
                cache->distortionAware = false;
            } else if (stableRsAttempted) {'''
new = '''                cache->misses = 0;
                cache->cooldown = 0;
                cache->stableSuccesses = 0;
                cache->distortionAware = false;
            } else if (stableRsAttempted) {'''
if old not in s:
    raise SystemExit("stable refresh block target not found")
s = s.replace(old, new, 1)

old = '''                if (++cache->misses >= 2) {
                    cache->misses = 0;
                    cache->cooldown = 0;
                    cache->distortionAware = false;
                }
            } else if (directAttempted) {'''
new = '''                cache->stableSuccesses = 0;
                if (++cache->misses >= 2) {
                    cache->misses = 0;
                    cache->cooldown = 0;
                    cache->distortionAware = false;
                }
            } else if (directAttempted) {'''
if old not in s:
    raise SystemExit("stable miss block target not found")
s = s.replace(old, new, 1)

old = '''            if (!stableRsAttempted && !turboAdaptive.promoted) {'''
new = '''            if (!stableEligible && !stableRsAttempted && !turboAdaptive.promoted) {'''
if old not in s:
    raise SystemExit("adaptive canary target not found")
s = s.replace(old, new, 1)
old = '''            } else if (!stableRsAttempted && turboAdaptive.promoted && directAttempted) {'''
new = '''            } else if (!stableEligible && !stableRsAttempted && turboAdaptive.promoted && directAttempted) {'''
if old not in s:
    raise SystemExit("adaptive promoted target not found")
s = s.replace(old, new, 1)

p.write_text(s)
