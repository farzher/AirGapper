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

# The base v234 candidate has already made dx/dy mutable in the Stable-RS block.
old='''                    float dx = wallCorrectionX;\n                    float dy = wallCorrectionY;\n                    auto levels = turboReadLevels(*cache, track, frameTransform,'''
new='''                    float dx = wallCorrectionX + cache->localPhaseX;\n                    float dy = wallCorrectionY + cache->localPhaseY;\n                    auto levels = turboReadLevels(*cache, track, frameTransform,'''
if old not in s: raise SystemExit('stable phase starting offset anchor missing')
s=s.replace(old,new,1)

# If an RS-failure local search succeeds, make that offset the one persisted by
# the common success hook below.
old='''                                    if (success)\n                                        ++metrics->localPhaseDecodeRecoveries;'''
new='''                                    if (success) {\n                                        dx = localDx;\n                                        dy = localDy;\n                                        ++metrics->localPhaseDecodeRecoveries;\n                                    }'''
if old not in s: raise SystemExit('local decode recovery anchor missing')
s=s.replace(old,new,1)

# At this point success can have come from CRC-Turbo, Stable-RS, or a local phase
# retry. All accepted paths have AirGapper CRC, and Stable-RS additionally has QR
# RS. Store only the residual relative to the shared wall correction.
old='''                            if (success) {\n                                ++metrics->stableRsSuccesses;\n                                cache->stableSuccesses = uint8_t(std::min(255, int(cache->stableSuccesses) + 1));\n                            }\n                        }\n                    }'''
new='''                            if (success) {\n                                ++metrics->stableRsSuccesses;\n                                cache->stableSuccesses = uint8_t(std::min(255, int(cache->stableSuccesses) + 1));\n                            }\n                        }\n                        if (success) {\n                            cache->localPhaseX = std::clamp(dx - wallCorrectionX, -1.5f, 1.5f);\n                            cache->localPhaseY = std::clamp(dy - wallCorrectionY, -1.5f, 1.5f);\n                        }\n                    }'''
if old not in s: raise SystemExit('stable success persistence anchor missing')
s=s.replace(old,new,1)

old='''                cache->stableSuccesses = 0;\n                cache->distortionAware = false;'''
new='''                cache->stableSuccesses = 0;\n                cache->localPhaseX = 0;\n                cache->localPhaseY = 0;\n                cache->distortionAware = false;'''
# There are two stale-map paths; clear phase in both.
count=s.count(old)
if count < 2: raise SystemExit(f'expected two stable invalidation anchors, found {count}')
s=s.replace(old,new)

p.write_text(s)
