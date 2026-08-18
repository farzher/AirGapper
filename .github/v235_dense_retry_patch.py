from pathlib import Path

cpp = Path('vendor/decimen-codec/source/wrapper/decimen_codec.cpp')
s = cpp.read_text()

old = '''                            const bool centerOnlyRs = frameTransform.translationOnly &&
                                guidedModuleSize(track) < GUIDED_TURBO_NEAREST_MIN_MODULE;
                            auto decoded = decodeTurboStableRS(*cache, track, frameTransform,
                                                               yPlane, width, height, stride,
                                                               dx, dy, levels, *metrics, centerOnlyRs);
                            success = commitTurbo(i, decoded, wallCorrectionX, wallCorrectionY);
                            if (!success && centerOnlyRs) {
                                // No correctness regression: if single-center RS
                                // cannot reconstruct an exact CRC-valid packet,
                                // retry the old ambiguity-voted sampler before
                                // handing the slot to sparse Guided recovery.
                                decoded = decodeTurboStableRS(*cache, track, frameTransform,
                                                              yPlane, width, height, stride,
                                                              dx, dy, levels, *metrics, false);
                                success = commitTurbo(i, decoded, wallCorrectionX, wallCorrectionY);
                            }
'''

new = '''                            const bool centerOnlyRs = frameTransform.translationOnly &&
                                stableModuleSize < GUIDED_TURBO_NEAREST_MIN_MODULE;
                            auto decoded = decodeTurboStableRS(*cache, track, frameTransform,
                                                               yPlane, width, height, stride,
                                                               dx, dy, levels, *metrics, centerOnlyRs);
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
                                ++metrics->sparseRsFallbacks;
                                ++metrics->stableRsAttempts;
                                decoded = decodeTurboStableRS(*cache, track, frameTransform,
                                                              yPlane, width, height, stride,
                                                              dx, dy, levels, *metrics, false);
                                success = commitTurbo(i, decoded, wallCorrectionX, wallCorrectionY);
                            }
'''

if 'robustRetryWorthwhile' in s:
    raise SystemExit('v235 dense retry patch already applied')
if old not in s:
    raise SystemExit('Stable-RS retry anchor missing')
s = s.replace(old, new, 1)
cpp.write_text(s)

for path, old_version, new_version in [
    ('vendor/decimen-codec/source/VERSION', '0.1.43', '0.1.44'),
    ('main.js', 'v0.5.234', 'v0.5.235'),
    ('receive/main.js', 'v0.5.234', 'v0.5.235'),
    ('index.html', 'v0.5.234', 'v0.5.235'),
]:
    p = Path(path)
    text = p.read_text()
    if old_version not in text:
        raise SystemExit(f'{path}: version target {old_version} missing')
    p.write_text(text.replace(old_version, new_version))

sw = Path('sw.js')
text = sw.read_text()
if 'airgapper-static-js-v190' not in text:
    raise SystemExit('sw cache v190 target missing')
sw.write_text(text.replace('airgapper-static-js-v190', 'airgapper-static-js-v191', 1))
