from pathlib import Path

p = Path('vendor/decimen-codec/source/wrapper/decimen_codec.cpp')
s = p.read_text()
old = '''                            if (!success) {
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
'''
new = '''                            if (!success) {
                                // v263 proved that slot-local residual refinement can rescue
                                // dense handheld QRs, but it currently runs only *after* a
                                // complete Stable-RS sample/decode has already failed. Finder
                                // evidence is ~200x cheaper than sampling a v40 QR. When the
                                // cached finder template is valid but visibly imperfect, try
                                // the better slot-local offset first. If that corrected RS
                                // attempt misses, the original shared-wall offset remains the
                                // exact fallback, so this only reorders existing CRC-gated work.
                                const bool localFirst = stableModuleSize <= GUIDED_TURBO_CANARY_MIN_MODULE &&
                                                        levels.matches < 143;
                                if (localFirst)
                                    success = retryLocalResidual();

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
                                    // If finder evidence looked strong enough to justify the
                                    // shared correction first, preserve v263's local retry.
                                    if (!success && !localFirst)
                                        success = retryLocalResidual();
                                }
                                guidedNoteDenseStableRs(stableRsGate, stableModuleSize, success);
                                if (success) {
                                    ++metrics->stableRsSuccesses;
                                    cache->stableSuccesses = uint8_t(std::min(255, int(cache->stableSuccesses) + 1));
                                }
                            }
'''
if old not in s:
    raise SystemExit('stable RS block anchor missing')
p.write_text(s.replace(old, new, 1))

v = Path('vendor/decimen-codec/source/VERSION')
current = v.read_text().strip()
if current != '0.1.56':
    raise SystemExit(f'unexpected codec version {current}')
v.write_text('0.1.57\n')
