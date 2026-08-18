from pathlib import Path

cpp = Path('vendor/decimen-codec/source/wrapper/decimen_codec.cpp')
s = cpp.read_text()

anchor = '''struct GuidedSparseFastResult
{
'''
insert = '''constexpr float GUIDED_STABLE_ADAPT_MAX_MODULE = 2.05f;

struct GuidedStableRsGate
{
    uint16_t attempts = 0;
    uint16_t successes = 0;
    uint16_t skipped = 0;
    bool suppressed = false;
};

static GuidedStableRsGate& guidedDenseStableRsGate()
{
    static GuidedStableRsGate gate;
    return gate;
}

// Below ~2 px/module, a handheld phase/pose can make cached Stable-RS much
// more expensive than going directly to current-frame sparse Guided recovery.
// Keep Stable-RS while it earns wins, but if a recent 12-attempt window falls
// below 25% success, bypass it and probe once per 32 eligible slots. CRC-backed
// probe success immediately re-enables the cached path. Higher-density images
// keep the normal Stable-RS behavior and do not contaminate this low-density gate.
static bool guidedTryDenseStableRs(GuidedStableRsGate& gate, float moduleSize)
{
    if (moduleSize > GUIDED_STABLE_ADAPT_MAX_MODULE || !gate.suppressed)
        return true;
    if (++gate.skipped >= 32) {
        gate.skipped = 0;
        return true;
    }
    return false;
}

static void guidedNoteDenseStableRs(GuidedStableRsGate& gate, float moduleSize, bool success)
{
    if (moduleSize > GUIDED_STABLE_ADAPT_MAX_MODULE)
        return;
    gate.skipped = 0;
    if (gate.suppressed) {
        if (success) {
            gate.suppressed = false;
            gate.attempts = 1;
            gate.successes = 1;
        }
        return;
    }
    ++gate.attempts;
    gate.successes += uint16_t(success);
    if (gate.attempts >= 12 && int(gate.successes) * 4 < int(gate.attempts)) {
        gate.suppressed = true;
        gate.attempts = 0;
        gate.successes = 0;
        return;
    }
    if (gate.attempts >= 32) {
        gate.attempts /= 2;
        gate.successes /= 2;
    }
}

struct GuidedSparseFastResult
{
'''
if anchor not in s:
    raise SystemExit('GuidedSparseFastResult anchor missing')
s = s.replace(anchor, insert, 1)

old = '''            // Every calibrated slot may use warped Stable-RS immediately.
            // The 147-cell finder/contrast check is the cheap performance gate;
            // RS + AirGapper CRC is the correctness gate.
            bool stableNeedsRefresh = false;
            if (!success && stableEligible) {
                const auto frameTransform = turboFrameTransform(*cache, track);
                if (!frameTransform.isValid()) {
                    stableNeedsRefresh = true;
                } else {
                    noteWarpMode(frameTransform);
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
                        const float stableModuleSize = guidedModuleSize(track);
                        const bool stableDirectEligible = !cache->cooldown &&
                            stableModuleSize >= GUIDED_TURBO_NEAREST_MIN_MODULE &&
                            cache->stableSuccesses >= 2;
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
                            ++metrics->stableRsAttempts;
                            const bool centerOnlyRs = frameTransform.translationOnly &&
                                stableModuleSize < GUIDED_TURBO_NEAREST_MIN_MODULE;
                            const bool progressiveRs = stableModuleSize < GUIDED_TURBO_NEAREST_MIN_MODULE;
                            bool rsUsed = false;
                            auto decoded = decodeTurboStableRS(*cache, track, frameTransform,
                                                               yPlane, width, height, stride,
                                                               dx, dy, levels, *metrics,
                                                               centerOnlyRs, progressiveRs, &rsUsed);
                            if (rsUsed)
                                ++metrics->sparseRsFallbacks;
                            success = commitTurbo(i, decoded, wallCorrectionX, wallCorrectionY);
                            // Below the 2.25 px/module data-only crossover, a failed
                            // center sample is strong evidence that this cached phase
                            // is not worth sampling a second time. Sparse Guided is
                            // already the stronger recovery there, so avoid paying a
                            // second full v40 grid read before handing the slot over.
                            const bool robustRetryWorthwhile = centerOnlyRs &&
                                stableModuleSize >= GUIDED_TURBO_CANARY_MIN_MODULE;
                            if (!success && robustRetryWorthwhile) {
                                ++metrics->sampleAttempts;
                                ++metrics->stableRsAttempts;
                                bool robustRsUsed = false;
                                decoded = decodeTurboStableRS(*cache, track, frameTransform,
                                                              yPlane, width, height, stride,
                                                              dx, dy, levels, *metrics,
                                                              false, true, &robustRsUsed);
                                if (robustRsUsed)
                                    ++metrics->sparseRsFallbacks;
                                success = commitTurbo(i, decoded, wallCorrectionX, wallCorrectionY);
                            }
                            if (success) {
                                ++metrics->stableRsSuccesses;
                                cache->stableSuccesses = uint8_t(std::min(255, int(cache->stableSuccesses) + 1));
                            }
                        }
                    }
                }
            }
'''
new = '''            // Every calibrated slot may use warped Stable-RS immediately while
            // that cached path is earning enough wins. Very dense handheld images
            // adaptively bypass a losing Stable-RS lane and fall directly through
            // to current-frame sparse Guided below.
            bool stableNeedsRefresh = false;
            if (!success && stableEligible) {
                const float stableModuleSize = guidedModuleSize(track);
                auto& stableRsGate = guidedDenseStableRsGate();
                const bool stableProbeAllowed = guidedTryDenseStableRs(stableRsGate, stableModuleSize);
                if (stableProbeAllowed) {
                    const auto frameTransform = turboFrameTransform(*cache, track);
                    if (!frameTransform.isValid()) {
                        stableNeedsRefresh = true;
                    } else {
                        noteWarpMode(frameTransform);
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
                            const bool stableDirectEligible = !cache->cooldown &&
                                stableModuleSize >= GUIDED_TURBO_NEAREST_MIN_MODULE &&
                                cache->stableSuccesses >= 2;
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
                                ++metrics->stableRsAttempts;
                                const bool centerOnlyRs = frameTransform.translationOnly &&
                                    stableModuleSize < GUIDED_TURBO_NEAREST_MIN_MODULE;
                                const bool progressiveRs = stableModuleSize < GUIDED_TURBO_NEAREST_MIN_MODULE;
                                bool rsUsed = false;
                                auto decoded = decodeTurboStableRS(*cache, track, frameTransform,
                                                                   yPlane, width, height, stride,
                                                                   dx, dy, levels, *metrics,
                                                                   centerOnlyRs, progressiveRs, &rsUsed);
                                if (rsUsed)
                                    ++metrics->sparseRsFallbacks;
                                success = commitTurbo(i, decoded, wallCorrectionX, wallCorrectionY);
                                const bool robustRetryWorthwhile = centerOnlyRs &&
                                    stableModuleSize >= GUIDED_TURBO_CANARY_MIN_MODULE;
                                if (!success && robustRetryWorthwhile) {
                                    ++metrics->sampleAttempts;
                                    ++metrics->stableRsAttempts;
                                    bool robustRsUsed = false;
                                    decoded = decodeTurboStableRS(*cache, track, frameTransform,
                                                                  yPlane, width, height, stride,
                                                                  dx, dy, levels, *metrics,
                                                                  false, true, &robustRsUsed);
                                    if (robustRsUsed)
                                        ++metrics->sparseRsFallbacks;
                                    success = commitTurbo(i, decoded, wallCorrectionX, wallCorrectionY);
                                }
                                guidedNoteDenseStableRs(stableRsGate, stableModuleSize, success);
                                if (success) {
                                    ++metrics->stableRsSuccesses;
                                    cache->stableSuccesses = uint8_t(std::min(255, int(cache->stableSuccesses) + 1));
                                }
                            }
                        }
                    }
                }
            }
'''
if old not in s:
    raise SystemExit('Stable-RS block anchor missing')
s = s.replace(old, new, 1)
cpp.write_text(s)

Path('vendor/decimen-codec/source/VERSION').write_text('0.1.53\n')
for path in ['main.js', 'receive/main.js', 'index.html']:
    p = Path(path)
    text = p.read_text()
    if 'v0.5.244' not in text:
        raise SystemExit(f'{path}: v0.5.244 missing')
    p.write_text(text.replace('v0.5.244', 'v0.5.245'))

sw = Path('sw.js')
text = sw.read_text()
if 'airgapper-static-js-v200' not in text:
    raise SystemExit('sw cache v200 missing')
sw.write_text(text.replace('airgapper-static-js-v200', 'airgapper-static-js-v201', 1))
