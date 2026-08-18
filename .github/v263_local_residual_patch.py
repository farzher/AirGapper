from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing anchor in {path}: {old[:140]!r}")
    p.write_text(text.replace(old, new, 1))

cpp = Path("vendor/decimen-codec/source/wrapper/decimen_codec.cpp")
s = cpp.read_text()

old = '''                        const auto levels = turboReadLevels(*cache, track, frameTransform,
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
'''
new = '''                        const auto levels = turboReadLevels(*cache, track, frameTransform,
                                                            yPlane, width, height, stride, dx, dy);
                        const bool centerOnlyRs = frameTransform.translationOnly &&
                            stableModuleSize < GUIDED_TURBO_NEAREST_MIN_MODULE;
                        const bool progressiveRs = stableModuleSize < GUIDED_TURBO_NEAREST_MIN_MODULE;

                        // Keep the existing shared-wall correction as the primary
                        // path. Only on a dense cached miss, refine this QR's finder
                        // offset locally and retry Stable-RS before paying for
                        // current-frame sparse alignment sampling. A handheld
                        // rotation/scale makes the residual vary across the wall,
                        // which one global translation cannot represent.
                        auto retryLocalResidual = [&]() {
                            if (stableModuleSize > GUIDED_TURBO_CANARY_MIN_MODULE)
                                return false;
                            const auto refined = turboRefineWallOffset(*cache, track, frameTransform,
                                                                        yPlane, width, height, stride,
                                                                        dx, dy);
                            if (!refined || std::hypot(refined->x - dx, refined->y - dy) < 0.20f)
                                return false;
                            const auto localLevels = turboReadLevels(*cache, track, frameTransform,
                                                                     yPlane, width, height, stride,
                                                                     refined->x, refined->y);
                            if (!localLevels.ok)
                                return false;
                            stableRsAttempted = true;
                            ++metrics->sampleAttempts;
                            ++metrics->stableRsAttempts;
                            bool localRsUsed = false;
                            auto localDecoded = decodeTurboStableRS(*cache, track, frameTransform,
                                                                    yPlane, width, height, stride,
                                                                    refined->x, refined->y, localLevels, *metrics,
                                                                    centerOnlyRs, progressiveRs, &localRsUsed);
                            if (localRsUsed)
                                ++metrics->sparseRsFallbacks;
                            return commitTurbo(i, localDecoded, refined->x, refined->y);
                        };

                        if (!levels.ok) {
                            success = retryLocalResidual();
                            if (success) {
                                guidedNoteDenseStableRs(stableRsGate, stableModuleSize, true);
                                ++metrics->stableRsSuccesses;
                                cache->stableSuccesses = uint8_t(std::min(255, int(cache->stableSuccesses) + 1));
                            } else {
                                // Finder evidence still cannot land this map on the
                                // live QR; let sparse Guided rebuild it in this job.
                                stableNeedsRefresh = true;
                            }
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
                                if (!success)
                                    success = retryLocalResidual();
                                guidedNoteDenseStableRs(stableRsGate, stableModuleSize, success);
                                if (success) {
                                    ++metrics->stableRsSuccesses;
                                    cache->stableSuccesses = uint8_t(std::min(255, int(cache->stableSuccesses) + 1));
                                }
                            }
                        }
'''
if old not in s:
    raise SystemExit("stable RS block anchor missing")
s = s.replace(old, new, 1)
cpp.write_text(s)

Path("vendor/decimen-codec/source/VERSION").write_text("0.1.56\n")
replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.260";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.263";')
replace_once("main.js", 'const APP_BUILD = "v0.5.260";', 'const APP_BUILD = "v0.5.263";')
index = Path("index.html").read_text().replace('v0.5.260', 'v0.5.263')
Path("index.html").write_text(index)
sw = Path("sw.js").read_text().replace('airgapper-static-js-v213', 'airgapper-static-js-v214', 1)
Path("sw.js").write_text(sw)
