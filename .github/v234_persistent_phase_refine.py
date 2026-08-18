from pathlib import Path

p=Path('vendor/decimen-codec/source/wrapper/decimen_codec.cpp')
s=p.read_text()

old='''    uint8_t stableSuccesses = 0;\n};'''
new='''    uint8_t stableSuccesses = 0;\n    // Residual phase left after coherent wall motion. This is only learned from\n    // an RS+AirGapper-CRC-valid decode and is reset with the distortion map.\n    float localPhaseX = 0;\n    float localPhaseY = 0;\n};'''
if old not in s: raise SystemExit('GuidedTurboTrack phase fields anchor missing')
s=s.replace(old,new,1)

old='''    cache->stableSuccesses = 0;\n}'''
new='''    cache->stableSuccesses = 0;\n    cache->localPhaseX = 0;\n    cache->localPhaseY = 0;\n}'''
if old not in s: raise SystemExit('seedGuidedTurbo reset anchor missing')
s=s.replace(old,new,1)

old='''        if (refreshDistortion && cache.seeded)\n            cache.distortionAware = false;'''
new='''        if (refreshDistortion && cache.seeded) {\n            cache.distortionAware = false;\n            cache.localPhaseX = 0;\n            cache.localPhaseY = 0;\n        }'''
if old not in s: raise SystemExit('pauseTurbo refresh anchor missing')
s=s.replace(old,new,1)

old='''                    float dx = wallCorrectionX;\n                    float dy = wallCorrectionY;\n                    auto levels = turboReadLevels(*cache, track, frameTransform,'''
new='''                    float dx = wallCorrectionX + cache->localPhaseX;\n                    float dy = wallCorrectionY + cache->localPhaseY;\n                    auto levels = turboReadLevels(*cache, track, frameTransform,'''
if old not in s: raise SystemExit('stable phase starting offset anchor missing')
s=s.replace(old,new,1)

old='''                                    if (success)\n                                        ++metrics->localPhaseDecodeRecoveries;'''
new='''                                    if (success) {\n                                        dx = localDx;\n                                        dy = localDy;\n                                        ++metrics->localPhaseDecodeRecoveries;\n                                    }'''
if old not in s: raise SystemExit('local decode recovery anchor missing')
s=s.replace(old,new,1)

old='''                            if (success) {\n                                ++metrics->stableRsSuccesses;\n                                cache->stableSuccesses = uint8_t(std::min(255, int(cache->stableSuccesses) + 1));\n                            }\n                        }\n                    }'''
new='''                            if (success) {\n                                ++metrics->stableRsSuccesses;\n                                cache->stableSuccesses = uint8_t(std::min(255, int(cache->stableSuccesses) + 1));\n                            }\n                        }\n                        if (success) {\n                            cache->localPhaseX = std::clamp(dx - wallCorrectionX, -1.5f, 1.5f);\n                            cache->localPhaseY = std::clamp(dy - wallCorrectionY, -1.5f, 1.5f);\n                        }\n                    }'''
if old not in s: raise SystemExit('stable success persistence anchor missing')
s=s.replace(old,new,1)

# Immediate stale-map invalidation (finder/transform failure).
old='''                cache->stableSuccesses = 0;\n                cache->distortionAware = false;'''
new='''                cache->stableSuccesses = 0;\n                cache->localPhaseX = 0;\n                cache->localPhaseY = 0;\n                cache->distortionAware = false;'''
if s.count(old) != 1: raise SystemExit(f'expected one immediate invalidation anchor, found {s.count(old)}')
s=s.replace(old,new,1)

# Repeated Stable-RS misses invalidate the distortion map only on the second
# miss. Keep the remembered phase for the first transient miss; clear it when
# the map is actually invalidated and Guided is asked to relearn it.
old='''                if (++cache->misses >= 2) {\n                    cache->misses = 0;\n                    cache->cooldown = 0;\n                    cache->distortionAware = false;\n                }'''
new='''                if (++cache->misses >= 2) {\n                    cache->misses = 0;\n                    cache->cooldown = 0;\n                    cache->localPhaseX = 0;\n                    cache->localPhaseY = 0;\n                    cache->distortionAware = false;\n                }'''
if old not in s: raise SystemExit('two-miss invalidation anchor missing')
s=s.replace(old,new,1)

p.write_text(s)
