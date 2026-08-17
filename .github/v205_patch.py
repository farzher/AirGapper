from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"replacement not found in {path}: {old[:240]!r}")
    p.write_text(s.replace(old, new, count))

# Version/cache.
replace("index.html", "v0.5.204", "v0.5.205")
replace("main.js", 'const APP_BUILD = "v0.5.204";', 'const APP_BUILD = "v0.5.205";')
replace("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.204";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.205";')
replace("sw.js", 'const CACHE = "airgapper-static-js-v166";', 'const CACHE = "airgapper-static-js-v167";')
replace("vendor/decimen-codec/source/VERSION", "0.1.26", "0.1.27")

cpp = Path("vendor/decimen-codec/source/wrapper/decimen_codec.cpp")
s = cpp.read_text()

# A worker is already paying for Guided sparse sampling on unresolved slots.
# Capture a distortion-aware sample map the first time each slot succeeds,
# rather than allowing the first seeded QR to monopolize probation. Conversely,
# do not regenerate the 177x177 map on every promoted Guided decode: once a
# distortion-aware cache exists, the live quad/pose warp keeps it current.
old = '''static bool turboSeedEligible(const DecimenGuidedTrack& track)\n{\n    auto* cache = guidedTurboTrack(track.id);\n    if (!cache || guidedModuleSize(track) < GUIDED_TURBO_CANARY_MIN_MODULE)\n        return false;\n    auto& adaptive = guidedTurboAdaptive();\n    if (adaptive.cooldown)\n        return false;\n    if (adaptive.promoted)\n        return true;\n    if (adaptive.seedId < 0)\n        return true;\n    return adaptive.seedId == track.id && !cache->seeded;\n}\n'''
new = '''static bool turboSeedEligible(const DecimenGuidedTrack& track)\n{\n    auto* cache = guidedTurboTrack(track.id);\n    if (!cache || guidedModuleSize(track) < GUIDED_TURBO_CANARY_MIN_MODULE)\n        return false;\n    auto& adaptive = guidedTurboAdaptive();\n    if (adaptive.cooldown)\n        return false;\n    // Guided already computed the sparse distortion controls. Materialize the\n    // full sample map only until this physical slot owns one good calibrated\n    // map (or its QR dimension changes). Rebuilding 177x177 coordinates every\n    // promoted frame was pure hot-path overhead.\n    return !cache->seeded || !cache->distortionAware || cache->dimension != track.dimension;\n}\n'''
if old not in s:
    raise SystemExit("turboSeedEligible block missing")
s = s.replace(old, new, 1)

# Probation used to be permanently tied to adaptive.seedId, so one mediocre QR
# could prevent a worker from ever proving a fast mode even after Guided had
# calibrated better slots. Prefer any already-calibrated rigid slot as the one
# conservative canary. If none is rigid right now, retain the old direct-canary
# fallback on any seeded slot.
old = '''        int canaryIndex = -1;\n        if (!turboAdaptive.promoted && !turboAdaptive.cooldown) {\n            for (int i = 0; i < trackCount; ++i) {\n                auto* cache = guidedTurboTrack(tracks[i].id);\n                if (cache && cache->seeded && guidedModuleSize(tracks[i]) >= GUIDED_TURBO_CANARY_MIN_MODULE &&\n                    (turboAdaptive.seedId < 0 || turboAdaptive.seedId == tracks[i].id)) {\n                    canaryIndex = i;\n                    break;\n                }\n            }\n        }\n'''
new = '''        int canaryIndex = -1;\n        if (!turboAdaptive.promoted && !turboAdaptive.cooldown) {\n            // First choice: a distortion-aware map whose seed->live shape is\n            // actually rigid on this frame. This makes Stable-RS probation test\n            // the stable wall, not whichever QR happened to decode first.\n            for (int i = 0; i < trackCount; ++i) {\n                auto* cache = guidedTurboTrack(tracks[i].id);\n                if (!cache || !cache->seeded || !cache->distortionAware ||\n                    guidedModuleSize(tracks[i]) < GUIDED_TURBO_CANARY_MIN_MODULE)\n                    continue;\n                float dx = 0, dy = 0, residual = 0;\n                if (turboPose(*cache, tracks[i], dx, dy, residual) &&\n                    turboStableRigidEligible(*cache, tracks[i], residual)) {\n                    canaryIndex = i;\n                    break;\n                }\n            }\n            // Direct Turbo can still probe a non-rigid cached slot when no\n            // Stable-RS candidate exists; do not stall probation completely.\n            if (canaryIndex < 0) {\n                for (int i = 0; i < trackCount; ++i) {\n                    auto* cache = guidedTurboTrack(tracks[i].id);\n                    if (cache && cache->seeded &&\n                        guidedModuleSize(tracks[i]) >= GUIDED_TURBO_CANARY_MIN_MODULE) {\n                        canaryIndex = i;\n                        break;\n                    }\n                }\n            }\n        }\n'''
if old not in s:
    raise SystemExit("turbo canary block missing")
s = s.replace(old, new, 1)

cpp.write_text(s)
