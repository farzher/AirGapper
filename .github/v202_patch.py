from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"replacement not found in {path}: {old[:220]!r}")
    p.write_text(s.replace(old, new, count))

# Version/cache.
replace("index.html", "v0.5.201", "v0.5.202")
replace("main.js", 'const APP_BUILD = "v0.5.201";', 'const APP_BUILD = "v0.5.202";')
replace("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.201";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.202";')
replace("sw.js", 'const CACHE = "airgapper-static-js-v163";', 'const CACHE = "airgapper-static-js-v164";')
replace("vendor/decimen-codec/source/VERSION", "0.1.24", "0.1.25")

cpp = Path("vendor/decimen-codec/source/wrapper/decimen_codec.cpp")
s = cpp.read_text()

# Stable-RS is useful even when it cannot independently decode half the wall.
# Preserve its expensive distortion maps when backing off instead of making
# Guided relearn them from scratch.
marker = '''static bool turboSeedEligible(const DecimenGuidedTrack& track)\n{'''
helper = r'''static void demoteTurboPreserveCache()
{
    auto& adaptive = guidedTurboAdaptive();
    adaptive.canaryAttempts = 0;
    adaptive.canarySuccesses = 0;
    adaptive.canaryDirectSuccesses = 0;
    adaptive.canaryStableEligible = 0;
    adaptive.promotedAttempts = 0;
    adaptive.promotedSuccesses = 0;
    adaptive.promoted = false;
    adaptive.rsMode = false;
    // Briefly stop probing, but keep every calibrated distortion-aware map.
    adaptive.cooldown = 8;
    for (auto& cache : guidedTurboTracks()) {
        cache.misses = 0;
        cache.cooldown = 0;
    }
}

'''
if marker not in s:
    raise SystemExit('turboSeedEligible marker missing')
s = s.replace(marker, helper + marker, 1)

# A cheap RS predecoder only needs to save a substantial fraction of Guided
# work to repay itself. v201 measured ~48% stable-RS recovery yet rejected it
# because the original gate was 5/8.
old = '''                    const bool stableRsWin = turboAdaptive.canaryStableEligible >= 6 &&\n                                             turboAdaptive.canarySuccesses * 8 >=\n                                             turboAdaptive.canaryAttempts * 5;'''
new = '''                    const bool stableRsWin = turboAdaptive.canaryStableEligible >= 6 &&\n                                             turboAdaptive.canarySuccesses * 8 >=\n                                             turboAdaptive.canaryAttempts * 3;'''
if old not in s:
    raise SystemExit('stableRsWin threshold missing')
s = s.replace(old, new, 1)

# If a rigid stable canary is merely mediocre, keep its maps warm and retry
# later. Non-rigid/soft scenes retain the old full cooldown behavior.
old = '''                    } else {\n                        coolLowDensityTurbo();\n                    }'''
new = '''                    } else {\n                        if (turboAdaptive.canaryStableEligible >= 6)\n                            demoteTurboPreserveCache();\n                        else\n                            coolLowDensityTurbo();\n                    }'''
if old not in s:
    raise SystemExit('canary rejection block missing')
s = s.replace(old, new, 1)

# Two misses are normal for a ~40-50% successful predecoder. In RS mode only
# cool an individual slot after a real streak, and then only very briefly.
old = '''            if (success) {\n                ++metrics->reserved2; // Turbo successes (ABI-reserved field)\n                cache->misses = 0;\n                cache->cooldown = 0;\n            } else if (++cache->misses >= 2) {\n                cache->misses = 0;\n                cache->cooldown = GUIDED_TURBO_BAD_COOLDOWN;\n            }'''
new = '''            if (success) {\n                ++metrics->reserved2; // Turbo successes (ABI-reserved field)\n                cache->misses = 0;\n                cache->cooldown = 0;\n            } else if (turboAdaptive.promoted && turboAdaptive.rsMode) {\n                if (++cache->misses >= 4) {\n                    cache->misses = 0;\n                    cache->cooldown = 2;\n                }\n            } else if (++cache->misses >= 2) {\n                cache->misses = 0;\n                cache->cooldown = GUIDED_TURBO_BAD_COOLDOWN;\n            }'''
if old not in s:
    raise SystemExit('cache miss policy missing')
s = s.replace(old, new, 1)

# Give full-wall RS mode a statistically useful window and judge it by its real
# economics: saving ~30% of Guided slots is already worthwhile. Direct mode
# keeps the stricter 50% rule. RS demotion preserves calibration.
old = '''                if (turboAdaptive.promotedAttempts >= 36) {\n                    // Full-wall Turbo must clear at least half of attempted slots\n                    // to repay itself versus going straight to Guided.\n                    if (turboAdaptive.promotedSuccesses * 2 < turboAdaptive.promotedAttempts)\n                        coolLowDensityTurbo();\n                    else {\n                        turboAdaptive.promotedAttempts = 0;\n                        turboAdaptive.promotedSuccesses = 0;\n                    }\n                }'''
new = '''                const int evaluationWindow = turboAdaptive.rsMode ? 72 : 36;\n                if (turboAdaptive.promotedAttempts >= evaluationWindow) {\n                    const bool tooWeak = turboAdaptive.rsMode\n                        ? turboAdaptive.promotedSuccesses * 10 < turboAdaptive.promotedAttempts * 3\n                        : turboAdaptive.promotedSuccesses * 2 < turboAdaptive.promotedAttempts;\n                    if (tooWeak) {\n                        if (turboAdaptive.rsMode)\n                            demoteTurboPreserveCache();\n                        else\n                            coolLowDensityTurbo();\n                    } else {\n                        turboAdaptive.promotedAttempts = 0;\n                        turboAdaptive.promotedSuccesses = 0;\n                    }\n                }'''
if old not in s:
    raise SystemExit('promotion evaluation block missing')
s = s.replace(old, new, 1)

cpp.write_text(s)
