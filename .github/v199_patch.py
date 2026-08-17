from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"replacement not found in {path}: {old[:180]!r}")
    p.write_text(s.replace(old, new, count))

# Version/cache.
replace("index.html", "v0.5.198", "v0.5.199")
replace("main.js", 'const APP_BUILD = "v0.5.198";', 'const APP_BUILD = "v0.5.199";')
replace("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.198";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.199";')
replace("sw.js", 'const CACHE = "airgapper-static-js-v160";', 'const CACHE = "airgapper-static-js-v161";')
replace("vendor/decimen-codec/source/VERSION", "0.1.22", "0.1.23")

cpp = Path("vendor/decimen-codec/source/wrapper/decimen_codec.cpp")
s = cpp.read_text()

# Resolution is only an eligibility floor now. Every camera must earn full-wall
# Turbo through cheap direct CRC successes; no px/module value bypasses evidence.
s = s.replace('constexpr float GUIDED_TURBO_FULL_MIN_MODULE = 3.05f;\n', '', 1)

old = '''static bool turboSeedEligible(const DecimenGuidedTrack& track)\n{\n    auto* cache = guidedTurboTrack(track.id);\n    if (!cache)\n        return false;\n    const float module = guidedModuleSize(track);\n    if (module < GUIDED_TURBO_CANARY_MIN_MODULE)\n        return false;\n    if (module >= GUIDED_TURBO_FULL_MIN_MODULE)\n        return true;\n    auto& adaptive = guidedTurboAdaptive();\n    if (adaptive.cooldown)\n        return false;\n    if (adaptive.promoted)\n        return true;\n    if (adaptive.seedId < 0)\n        return true;\n    return adaptive.seedId == track.id && !cache->seeded;\n}\n'''
new = '''static bool turboSeedEligible(const DecimenGuidedTrack& track)\n{\n    auto* cache = guidedTurboTrack(track.id);\n    if (!cache || guidedModuleSize(track) < GUIDED_TURBO_CANARY_MIN_MODULE)\n        return false;\n    auto& adaptive = guidedTurboAdaptive();\n    if (adaptive.cooldown)\n        return false;\n    if (adaptive.promoted)\n        return true;\n    if (adaptive.seedId < 0)\n        return true;\n    return adaptive.seedId == track.id && !cache->seeded;\n}\n'''
if old not in s:
    raise SystemExit('turboSeedEligible block missing')
s = s.replace(old, new, 1)

# Replace the bilinear corner-delta approximation with the physically correct
# projective transform from the seed detector quad to the current tracked quad.
start = s.find('static PointF turboWarpedPoint(')
end = s.find('\nstatic bool turboFinderIdeal', start)
if start < 0 or end < 0:
    raise SystemExit('turboWarpedPoint span missing')
new_warp = r'''static PerspectiveTransform turboFrameTransform(const GuidedTurboTrack& cache,
                                                const DecimenGuidedTrack& track)
{
    const auto current = turboTrackQuad(track);
    return PerspectiveTransform(
        QuadrilateralF{cache.seedQuad[0], cache.seedQuad[1], cache.seedQuad[2], cache.seedQuad[3]},
        QuadrilateralF{current[0], current[1], current[2], current[3]});
}

static PointF turboWarpedPoint(const GuidedTurboTrack& cache,
                               const PerspectiveTransform& frameTransform, int x, int y)
{
    return frameTransform(cache.samples[size_t(y) * cache.dimension + x]);
}
'''
s = s[:start] + new_warp + s[end:]

# Thread one per-track frame transform through the direct sampler instead of
# rebuilding any transform per module.
s = s.replace(
'''static TurboLevels turboReadLevels(const GuidedTurboTrack& cache, const DecimenGuidedTrack& track,\n                                   const uint8_t* yPlane, int width, int height, int stride, float dx, float dy)''',
'''static TurboLevels turboReadLevels(const GuidedTurboTrack& cache, const DecimenGuidedTrack& track,\n                                   const PerspectiveTransform& frameTransform,\n                                   const uint8_t* yPlane, int width, int height, int stride, float dx, float dy)''', 1)
s = s.replace('turboWarpedPoint(cache, track, sx, sy)', 'turboWarpedPoint(cache, frameTransform, sx, sy)')

s = s.replace(
'''static int turboModuleLum(const GuidedTurboTrack& cache, const DecimenGuidedTrack& track,\n                          const uint8_t* yPlane, int width, int height, int stride, int x, int y,''',
'''static int turboModuleLum(const GuidedTurboTrack& cache, const DecimenGuidedTrack& track,\n                          const PerspectiveTransform& frameTransform,\n                          const uint8_t* yPlane, int width, int height, int stride, int x, int y,''', 1)
s = s.replace('turboWarpedPoint(cache, track, x, y)', 'turboWarpedPoint(cache, frameTransform, x, y)')
s = s.replace('turboWarpedPoint(cache, track, std::max(0, x - 1), y)', 'turboWarpedPoint(cache, frameTransform, std::max(0, x - 1), y)')
s = s.replace('turboWarpedPoint(cache, track, std::min(dim - 1, x + 1), y)', 'turboWarpedPoint(cache, frameTransform, std::min(dim - 1, x + 1), y)')
s = s.replace('turboWarpedPoint(cache, track, x, std::max(0, y - 1))', 'turboWarpedPoint(cache, frameTransform, x, std::max(0, y - 1))')
s = s.replace('turboWarpedPoint(cache, track, x, std::min(dim - 1, y + 1))', 'turboWarpedPoint(cache, frameTransform, x, std::min(dim - 1, y + 1))')

s = s.replace(
'''static DecoderResult decodeTurboDataOnly(const GuidedTurboTrack& cache, const DecimenGuidedTrack& track,\n                                         const uint8_t* yPlane, int width, int height, int stride,''',
'''static DecoderResult decodeTurboDataOnly(const GuidedTurboTrack& cache, const DecimenGuidedTrack& track,\n                                         const PerspectiveTransform& frameTransform,\n                                         const uint8_t* yPlane, int width, int height, int stride,''', 1)
s = s.replace(
'''static DecoderResult decodeTurboWithRS(const GuidedTurboTrack& cache, const DecimenGuidedTrack& track,\n                                       const uint8_t* yPlane, int width, int height, int stride,''',
'''static DecoderResult decodeTurboWithRS(const GuidedTurboTrack& cache, const DecimenGuidedTrack& track,\n                                       const PerspectiveTransform& frameTransform,\n                                       const uint8_t* yPlane, int width, int height, int stride,''', 1)
# Calls inside both decoder functions.
s = s.replace('turboModuleLum(cache, track, yPlane, width, height, stride,',
              'turboModuleLum(cache, track, frameTransform, yPlane, width, height, stride,')

s = s.replace(
'''static PointF turboRefineWallOffset(const GuidedTurboTrack& cache, const DecimenGuidedTrack& track,\n                                    const uint8_t* yPlane, int width, int height, int stride,\n                                    float predictedX, float predictedY)''',
'''static PointF turboRefineWallOffset(const GuidedTurboTrack& cache, const DecimenGuidedTrack& track,\n                                    const PerspectiveTransform& frameTransform,\n                                    const uint8_t* yPlane, int width, int height, int stride,\n                                    float predictedX, float predictedY)''', 1)
s = s.replace('turboReadLevels(cache, track, yPlane, width, height, stride, dx, dy)',
              'turboReadLevels(cache, track, frameTransform, yPlane, width, height, stride, dx, dy)')

# Expand the once-per-job residual search slightly and exploit subpixel sampling
# with a cheap half-pixel refinement around the best integer translation.
old = '''    for (int oy = -2; oy <= 2; ++oy)\n        for (int ox = -2; ox <= 2; ++ox) {\n            const float dx = predictedX + ox;\n            const float dy = predictedY + oy;\n            const auto levels = turboReadLevels(cache, track, frameTransform, yPlane, width, height, stride, dx, dy);\n            if (!levels.ok)\n                continue;\n            const int score = levels.matches * 4 + levels.separation;\n            if (score > bestScore) {\n                bestScore = score;\n                best = PointF{dx, dy};\n            }\n        }\n    return best;\n}'''
new = '''    for (int oy = -3; oy <= 3; ++oy)\n        for (int ox = -3; ox <= 3; ++ox) {\n            const float dx = predictedX + ox;\n            const float dy = predictedY + oy;\n            const auto levels = turboReadLevels(cache, track, frameTransform, yPlane, width, height, stride, dx, dy);\n            if (!levels.ok)\n                continue;\n            const int score = levels.matches * 4 + levels.separation;\n            if (score > bestScore) {\n                bestScore = score;\n                best = PointF{dx, dy};\n            }\n        }\n    const PointF coarse = best;\n    for (int hy = -1; hy <= 1; ++hy)\n        for (int hx = -1; hx <= 1; ++hx) {\n            const float dx = coarse.x + hx * 0.5f;\n            const float dy = coarse.y + hy * 0.5f;\n            const auto levels = turboReadLevels(cache, track, frameTransform, yPlane, width, height, stride, dx, dy);\n            if (!levels.ok)\n                continue;\n            const int score = levels.matches * 4 + levels.separation;\n            if (score > bestScore) {\n                bestScore = score;\n                best = PointF{dx, dy};\n            }\n        }\n    return best;\n}'''
if old not in s:
    raise SystemExit('residual search block missing')
s = s.replace(old, new, 1)

# Every optical density now goes through evidence-based probation. The old
# highDensityTurbo bypass is exactly what caused 760 attempts in 310 v198 jobs.
start = s.find('        bool highDensityTurbo = false;')
end = s.find('\n        // Shared wall motion is paid once.', start)
if start < 0 or end < 0:
    raise SystemExit('high-density rollout span missing')
new_rollout = r'''        int canaryIndex = -1;
        if (!turboAdaptive.promoted && !turboAdaptive.cooldown) {
            for (int i = 0; i < trackCount; ++i) {
                auto* cache = guidedTurboTrack(tracks[i].id);
                if (cache && cache->seeded && guidedModuleSize(tracks[i]) >= GUIDED_TURBO_CANARY_MIN_MODULE &&
                    (turboAdaptive.seedId < 0 || turboAdaptive.seedId == tracks[i].id)) {
                    canaryIndex = i;
                    break;
                }
            }
        }
        auto turboAllowed = [&](int i) {
            if (guidedModuleSize(tracks[i]) < GUIDED_TURBO_CANARY_MIN_MODULE || turboAdaptive.cooldown)
                return false;
            return turboAdaptive.promoted || i == canaryIndex;
        };
'''
s = s[:start] + new_rollout + s[end:]

# Build a projective seed->live transform once for the reference QR and once for
# each attempted QR. Never construct it inside module sampling.
old = '''            float dx = 0, dy = 0, residual = 0;\n            if (!turboPose(*cache, tracks[i], dx, dy, residual))\n                continue;\n            // The per-module bilinear warp already carries the current quad's\n            // translation/scale/perspective. Search only the small residual wall\n            // motion left by worker latency / lattice prediction.\n            const PointF refined = turboRefineWallOffset(*cache, tracks[i], yPlane, width, height, stride, 0, 0);'''
new = '''            float dx = 0, dy = 0, residual = 0;\n            if (!turboPose(*cache, tracks[i], dx, dy, residual))\n                continue;\n            const auto frameTransform = turboFrameTransform(*cache, tracks[i]);\n            if (!frameTransform.isValid())\n                continue;\n            // The projective frame warp carries current translation/scale/perspective.\n            // Search only the small residual left by lattice/worker latency.\n            const PointF refined = turboRefineWallOffset(*cache, tracks[i], frameTransform,\n                                                          yPlane, width, height, stride, 0, 0);'''
if old not in s:
    raise SystemExit('reference frame transform marker missing')
s = s.replace(old, new, 1)

old = '''            float dx = 0, dy = 0, residual = 0;\n            if (!turboPose(*cache, track, dx, dy, residual))\n                continue;\n            // dx/dy now means only residual correction; the current tracked quad\n            // itself is applied to every cached module by turboWarpedPoint().\n            dx = wallCorrectionX;\n            dy = wallCorrectionY;\n            const auto levels = turboReadLevels(*cache, track, yPlane, width, height, stride, dx, dy);'''
new = '''            float dx = 0, dy = 0, residual = 0;\n            if (!turboPose(*cache, track, dx, dy, residual))\n                continue;\n            const auto frameTransform = turboFrameTransform(*cache, track);\n            if (!frameTransform.isValid())\n                continue;\n            dx = wallCorrectionX;\n            dy = wallCorrectionY;\n            const auto levels = turboReadLevels(*cache, track, frameTransform,\n                                                yPlane, width, height, stride, dx, dy);'''
if old not in s:
    raise SystemExit('track frame transform marker missing')
s = s.replace(old, new, 1)

s = s.replace(
'''            auto decoded = decodeTurboDataOnly(*cache, track, yPlane, width, height, stride,\n                                               dx, dy, levels, *metrics);''',
'''            auto decoded = decodeTurboDataOnly(*cache, track, frameTransform, yPlane, width, height, stride,\n                                               dx, dy, levels, *metrics);''', 1)
s = s.replace(
'''                decoded = decodeTurboWithRS(*cache, track, yPlane, width, height, stride,\n                                            dx, dy, levels, *metrics);''',
'''                decoded = decodeTurboWithRS(*cache, track, frameTransform, yPlane, width, height, stride,\n                                            dx, dy, levels, *metrics);''', 1)

# Probation measures the path we actually want: direct data-only+CRC. Running a
# full cached matrix + QR RS during canary makes failure expensive and inflates
# the apparent Turbo hit rate. RS is available only after direct evidence has
# promoted this worker.
s = s.replace('''            } else if (rsBudget > 0) {\n                --rsBudget;''',
              '''            } else if (turboAdaptive.promoted && rsBudget > 0) {\n                --rsBudget;''', 1)

# Promotion is intentionally conservative because a full-wall miss costs work
# before Guided. Four perfect direct canaries or >=75% over eight earns Turbo.
old = '''                    const bool earlyWin = turboAdaptive.canaryAttempts >= 2 &&\n                                          turboAdaptive.canarySuccesses == turboAdaptive.canaryAttempts;\n                    if (earlyWin || turboAdaptive.canaryAttempts >= 6) {\n                        if (earlyWin || turboAdaptive.canarySuccesses * 2 >= turboAdaptive.canaryAttempts) {\n                            turboAdaptive.promoted = true;\n                            turboAdaptive.canaryAttempts = 0;\n                            turboAdaptive.canarySuccesses = 0;\n                        } else {\n                            coolLowDensityTurbo();\n                        }\n                    }'''
new = '''                    const bool earlyWin = turboAdaptive.canaryAttempts >= 4 &&\n                                          turboAdaptive.canarySuccesses == turboAdaptive.canaryAttempts;\n                    if (earlyWin || turboAdaptive.canaryAttempts >= 8) {\n                        if (earlyWin || turboAdaptive.canarySuccesses * 4 >= turboAdaptive.canaryAttempts * 3) {\n                            turboAdaptive.promoted = true;\n                            turboAdaptive.canaryAttempts = 0;\n                            turboAdaptive.canarySuccesses = 0;\n                        } else {\n                            coolLowDensityTurbo();\n                        }\n                    }'''
if old not in s:
    raise SystemExit('promotion block missing')
s = s.replace(old, new, 1)

# Once promoted, require at least 50% whole-wall Turbo survival over the sample
# window; below that it is unlikely to repay its pre-Guided cost.
s = s.replace('if (turboAdaptive.promotedSuccesses * 4 < turboAdaptive.promotedAttempts)',
              'if (turboAdaptive.promotedSuccesses * 2 < turboAdaptive.promotedAttempts)', 1)

cpp.write_text(s)
