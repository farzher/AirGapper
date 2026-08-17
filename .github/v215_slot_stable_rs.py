from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"replacement not found in {path}: {old[:260]!r}")
    p.write_text(s.replace(old, new, count))

replace("index.html", "v0.5.214", "v0.5.215")
replace("main.js", 'const APP_BUILD = "v0.5.214";', 'const APP_BUILD = "v0.5.215";')
replace("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.214";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.215";')
replace("sw.js", 'const CACHE = "airgapper-static-js-v176";', 'const CACHE = "airgapper-static-js-v177";')
replace("vendor/decimen-codec/source/VERSION", "0.1.31", "0.1.32")

p = Path("vendor/decimen-codec/source/wrapper/decimen_codec.cpp")
s = p.read_text()

old = '''        // Shared wall motion is paid once. In the 1440p canary state only the
        // single proving slot participates, so a soft/old camera cannot turn
        // this experiment into a second full decoder.
        float wallCorrectionX = 0, wallCorrectionY = 0;
        if (!turboAdaptive.cooldown) {
            for (int i = 0; i < trackCount; ++i) {
                auto* cache = guidedTurboTrack(tracks[i].id);
                if (!cache || !cache->seeded || !turboAllowed(i))
                    continue;
                float dx = 0, dy = 0, residual = 0;
                if (!turboPose(*cache, tracks[i], dx, dy, residual))
                    continue;
                const auto frameTransform = turboFrameTransform(*cache, tracks[i]);
                if (!frameTransform.isValid())
                    continue;
                const PointF refined = turboRefineWallOffset(*cache, tracks[i], frameTransform,
                                                              yPlane, width, height, stride, 0, 0);
                wallCorrectionX = refined.x;
                wallCorrectionY = refined.y;
                break;
            }
        }'''
new = '''        // Shared wall motion is paid once from any calibrated Stable-RS slot.
        // Stable-RS has its own RS+CRC oracle and no longer depends on the old
        // global Turbo canary/promotion state. A bad cache cools locally below.
        float wallCorrectionX = 0, wallCorrectionY = 0;
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
if old not in s:
    raise SystemExit("wall correction block missing")
s = s.replace(old, new, 1)

old = '''            auto* cache = guidedTurboTrack(track.id);
            if (!cache || !cache->seeded || !turboAllowed(i))
                continue;
            if (cache->cooldown)
                continue;
            float poseX = 0, poseY = 0, residual = 0;
            if (!turboPose(*cache, track, poseX, poseY, residual))
                continue;
            // `stable` means the calibrated map can be projectively warped onto
            // this live track. Finder contrast is a separate cheap per-slot gate.
            const bool stableEligible = turboStableWarpEligible(*cache, track, residual);
            if (stableEligible)
                ++metrics->stableEligibleTracks;
            const bool stableProbation = !turboAdaptive.promoted && stableEligible && cache->distortionAware;
            const bool directMode = turboAdaptive.promoted ? !turboAdaptive.rsMode : !stableProbation;

            ++metrics->turboAttempts;'''
new = '''            auto* cache = guidedTurboTrack(track.id);
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
                continue;
            if (stableEligible)
                ++metrics->stableEligibleTracks;
            const bool directMode = !stableEligible && directEligible;

            ++metrics->turboAttempts;'''
if old not in s:
    raise SystemExit("slot eligibility block missing")
s = s.replace(old, new, 1)

old = '''            // In probation this is one QR/job. Once stable-RS has proven itself,
            // it becomes the primary full-wall path and avoids the duplicate
            // data-only sampling entirely.
            if (!success && stableEligible && (!turboAdaptive.promoted || turboAdaptive.rsMode)) {'''
new = '''            // Every calibrated slot may use warped Stable-RS immediately.
            // The 147-cell finder/contrast check is the cheap performance gate;
            // RS + AirGapper CRC is the correctness gate.
            if (!success && stableEligible) {'''
if old not in s:
    raise SystemExit("stable branch condition missing")
s = s.replace(old, new, 1)

old = '''            } else if (decoderAttempted) {
                if (turboAdaptive.promoted && turboAdaptive.rsMode) {
                    if (++cache->misses >= 4) {
                        cache->misses = 0;
                        cache->cooldown = 2;
                    }
                } else if (++cache->misses >= 2) {
                    cache->misses = 0;
                    cache->cooldown = GUIDED_TURBO_BAD_COOLDOWN;
                }
            } else {'''
new = '''            } else if (decoderAttempted) {
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
            } else {'''
if old not in s:
    raise SystemExit("cache miss block missing")
s = s.replace(old, new, 1)

old = '''            if (!turboAdaptive.promoted) {
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
                        pauseTurbo(turboAdaptive.rsMode, turboAdaptive.rsMode ? 4 : GUIDED_TURBO_CANARY_COOLDOWN);'''
new = '''            // The global adaptive controller now governs only the weaker
            // data-only Turbo experiment. Stable-RS is slot-local and must not
            // promote, demote, pause, or invalidate other calibrated maps.
            if (!stableRsAttempted && !turboAdaptive.promoted) {
                if (!directAttempted)
                    continue;
                ++turboAdaptive.canaryAttempts;
                turboAdaptive.canaryDirectSuccesses += int(directSuccess);

                const bool directEarly = turboAdaptive.canaryAttempts >= 4 &&
                                         turboAdaptive.canaryDirectSuccesses == turboAdaptive.canaryAttempts;
                bool promoteDirect = directEarly;
                if (!promoteDirect && turboAdaptive.canaryAttempts >= 8) {
                    promoteDirect = turboAdaptive.canaryDirectSuccesses * 4 >=
                                    turboAdaptive.canaryAttempts * 3;
                }
                if (promoteDirect) {
                    turboAdaptive.promoted = true;
                    turboAdaptive.rsMode = false;
                    turboAdaptive.canaryAttempts = 0;
                    turboAdaptive.canaryDirectSuccesses = 0;
                    turboAdaptive.canaryStableAttempts = 0;
                    turboAdaptive.canaryStableSuccesses = 0;
                    turboAdaptive.promotedAttempts = 0;
                    turboAdaptive.promotedSuccesses = 0;
                } else if (turboAdaptive.canaryAttempts >= 10) {
                    pauseTurbo(false);
                }
            } else if (!stableRsAttempted && turboAdaptive.promoted && directAttempted) {
                ++turboAdaptive.promotedAttempts;
                turboAdaptive.promotedSuccesses += int(success);
                const int evaluationWindow = 36;
                if (turboAdaptive.promotedAttempts >= evaluationWindow) {
                    const bool tooWeak = turboAdaptive.promotedSuccesses * 2 < turboAdaptive.promotedAttempts;
                    if (tooWeak)
                        pauseTurbo(false, GUIDED_TURBO_CANARY_COOLDOWN);'''
if old not in s:
    raise SystemExit("global adaptive evidence block missing")
s = s.replace(old, new, 1)

# Remaining tail of the evaluation block still resets the window when strong.
# Its braces/else body are shared and remain valid.

p.write_text(s)
