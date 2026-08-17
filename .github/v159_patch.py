from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing anchor in {path}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))

# Version/cache bump.
replace_once("index.html", "v0.5.158", "v0.5.159")
replace_once("main.js", 'const APP_BUILD = "v0.5.158";', 'const APP_BUILD = "v0.5.159";')
replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.158";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.159";')
replace_once("sw.js", 'airgapper-static-js-v120', 'airgapper-static-js-v121')

# User-facing compact metric stays terse: call scheduled decode-source rate fps.
replace_once(
    "receive/main.js",
    'metric("m-cap").textContent = `${decodeFrameRate.toFixed(1)} scan/s`;',
    'metric("m-cap").textContent = `${decodeFrameRate.toFixed(1)} fps`;'
)

# The existing fast metrics now describe the new projection sampler rather than
# the historical no-RS parser. Make diagnostics say what they measure.
p = Path("receive/main.js")
text = p.read_text()
text = text.replace(
    'decode ${(livePipeline.guidedDecodeMs / 1e3).toFixed(1)} [fast ${(livePipeline.guidedFastDecodeMs / 1e3).toFixed(1)} / RS ${(livePipeline.guidedGenericDecodeMs / 1e3).toFixed(1)}]',
    'decode ${(livePipeline.guidedDecodeMs / 1e3).toFixed(1)} [project ${(livePipeline.guidedFastDecodeMs / 1e3).toFixed(1)} / fallback ${(livePipeline.guidedGenericDecodeMs / 1e3).toFixed(1)}]'
)
text = text.replace(
    'finders ${livePipeline.guidedFinderSuccesses}/${livePipeline.guidedFinderAttempts} · fast ${livePipeline.guidedFastDecodeSuccesses}/${livePipeline.guidedFastDecodeAttempts} · RS ${livePipeline.guidedGenericDecodeAttempts}',
    'finders ${livePipeline.guidedFinderSuccesses}/${livePipeline.guidedFinderAttempts} · project ${livePipeline.guidedFastDecodeSuccesses}/${livePipeline.guidedFastDecodeAttempts} · fallback ${livePipeline.guidedGenericDecodeAttempts}'
)
text = text.replace(
    '[fast ${lastGuidedMetrics.fastDecodeMs.toFixed(1)} ${lastGuidedMetrics.fastDecodeSuccesses}/${lastGuidedMetrics.fastDecodeAttempts} · RS ${lastGuidedMetrics.genericDecodeMs.toFixed(1)} ${lastGuidedMetrics.genericDecodeAttempts}]',
    '[project ${lastGuidedMetrics.fastDecodeMs.toFixed(1)} ${lastGuidedMetrics.fastDecodeSuccesses}/${lastGuidedMetrics.fastDecodeAttempts} · fallback ${lastGuidedMetrics.genericDecodeMs.toFixed(1)} ${lastGuidedMetrics.genericDecodeAttempts}]'
)
p.write_text(text)

cpp = Path("vendor/decimen-codec/source/wrapper/decimen_codec.cpp")
text = cpp.read_text()

helper_anchor = '''    out = QRCode::FinderPatternSet{*found[0], *found[1], *found[2]};
    metrics.finderTriplets++;
    return true;
}

} // namespace
'''
helper_new = '''    out = QRCode::FinderPatternSet{*found[0], *found[1], *found[2]};
    metrics.finderTriplets++;
    return true;
}

// Sample a known tracked QR without QRDetector's expensive version-40
// alignment-pattern lattice search. The previous successful position quad
// gives us a high-quality projective prior. Current-frame finder centers give
// an exact affine correction for translation/rotation/scale/shear; apply that
// correction to the prior bottom-right alignment-point prediction, then sample
// the whole module grid once. A CRC-verified miss simply falls through to the
// stock SampleQR path below, so this is an opportunistic accelerator only.
static DetectorResult sampleGuidedProjection(const BitMatrix& image,
                                             const DecimenGuidedTrack& track,
                                             const QRCode::FinderPatternSet& fp)
{
    const int dim = track.dimension;
    const QuadrilateralF moduleBounds{
        PointF{0, 0}, PointF{double(dim), 0},
        PointF{double(dim), double(dim)}, PointF{0, double(dim)}
    };
    const QuadrilateralF priorPixels{
        PointF{track.x0, track.y0}, PointF{track.x1, track.y1},
        PointF{track.x2, track.y2}, PointF{track.x3, track.y3}
    };
    PerspectiveTransform prior(moduleBounds, priorPixels);

    const PointF predictedTL = prior(PointF{3.5, 3.5});
    const PointF predictedTR = prior(PointF{dim - 3.5, 3.5});
    const PointF predictedBL = prior(PointF{3.5, dim - 3.5});
    // For model-2 QR >= v2, QRDetector's brOffset={3,3} means this fourth
    // control point is the bottom-right alignment-pattern center.
    const PointF predictedBR = prior(PointF{dim - 6.5, dim - 6.5});

    const PointF u = predictedTR - predictedTL;
    const PointF v = predictedBL - predictedTL;
    const PointF w = predictedBR - predictedTL;
    const double det = u.x * v.y - u.y * v.x;

    PointF correctedBR;
    PointF brOffset{3, 3};
    if (std::abs(det) > 1e-5) {
        const double a = (w.x * v.y - w.y * v.x) / det;
        const double b = (u.x * w.y - u.y * w.x) / det;
        const PointF actualTL = fp.tl;
        correctedBR = actualTL + (PointF(fp.tr) - actualTL) * a + (PointF(fp.bl) - actualTL) * b;
    } else {
        // Degenerate prior: use the same cheap parallelogram fallback as
        // QRDetector and interpret the fourth point as the finder-corner
        // projection rather than an alignment center.
        correctedBR = PointF(fp.tr) - PointF(fp.tl) + PointF(fp.bl);
        brOffset = PointF{0, 0};
    }

    if (!image.isIn(correctedBR))
        return {};

    const QuadrilateralF moduleControl{
        PointF{3.5, 3.5},
        PointF{dim - 3.5, 3.5},
        PointF{dim - 3.5 - brOffset.x, dim - 3.5 - brOffset.y},
        PointF{3.5, dim - 3.5}
    };
    PerspectiveTransform mod2Pix(moduleControl,
        QuadrilateralF{PointF(fp.tl), PointF(fp.tr), correctedBR, PointF(fp.bl)});
    return SampleGrid(image, dim, dim, mod2Pix);
}

} // namespace
'''
if helper_anchor not in text:
    raise SystemExit("guided helper anchor not found")
text = text.replace(helper_anchor, helper_new, 1)

loop_old = '''            const double sampleStart = guidedNowMs();
            double decodeSpent = 0;
            bool decodedTrack = false;
            for (auto&& detected : QRCode::SampleQR(*bits, finderSet)) {
                metrics->sampleAttempts++;
                if (!detected.isValid() || detected.bits().width() != track.dimension)
                    continue;
                ++metrics->genericDecodeAttempts;
                const double genericStart = guidedNowMs();
                auto decoded = QRCode::Decode(detected.bits());
                const double genericElapsed = guidedNowMs() - genericStart;
                metrics->genericDecodeMs += genericElapsed;
                metrics->decodeMs += genericElapsed;
                decodeSpent += genericElapsed;
                if (!decoded.isValid() || decoded.content().bytes.empty() || !hasValidCRC32(decoded.content().bytes))
                    continue;
                ByteArray bytes = decoded.content().bytes;

                if (outputUsed + int(bytes.size()) > outputCapacity)
                    break;
                std::memcpy(output + outputUsed, bytes.data(), bytes.size());
                const Position pos = detected.position();
                auto& result = results[resultCount++];
                result = {};
                result.id = track.id;
                result.status = DECIMEN_TRACK_OK;
                result.bytesOffset = outputUsed;
                result.bytesLength = int(bytes.size());
                result.dimension = detected.bits().width();
                result.x0 = pos[0].x; result.y0 = pos[0].y;
                result.x1 = pos[1].x; result.y1 = pos[1].y;
                result.x2 = pos[2].x; result.y2 = pos[2].y;
                result.x3 = pos[3].x; result.y3 = pos[3].y;
                outputUsed += int(bytes.size());
                metrics->successful++;
                decodedTrack = true;
                break;
            }
            metrics->sampleMs += std::max(0.0, guidedNowMs() - sampleStart - decodeSpent);
            (void)decodedTrack;
'''
loop_new = '''            const double sampleStart = guidedNowMs();
            double decodeSpent = 0;
            bool decodedTrack = false;

            auto commitDecoded = [&](const DetectorResult& detected, const DecoderResult& decoded) {
                if (!detected.isValid() || detected.bits().width() != track.dimension ||
                    !decoded.isValid() || decoded.content().bytes.empty() || !hasValidCRC32(decoded.content().bytes))
                    return false;
                const ByteArray& bytes = decoded.content().bytes;
                if (outputUsed + int(bytes.size()) > outputCapacity)
                    return false;
                std::memcpy(output + outputUsed, bytes.data(), bytes.size());
                const Position pos = detected.position();
                auto& result = results[resultCount++];
                result = {};
                result.id = track.id;
                result.status = DECIMEN_TRACK_OK;
                result.bytesOffset = outputUsed;
                result.bytesLength = int(bytes.size());
                result.dimension = detected.bits().width();
                result.x0 = pos[0].x; result.y0 = pos[0].y;
                result.x1 = pos[1].x; result.y1 = pos[1].y;
                result.x2 = pos[2].x; result.y2 = pos[2].y;
                result.x3 = pos[3].x; result.y3 = pos[3].y;
                outputUsed += int(bytes.size());
                metrics->successful++;
                return true;
            };

            // Fast tracked projection: one SampleGrid + ordinary QR RS decode.
            // This avoids the dozens of alignment-pattern searches SampleQR
            // performs for v40. It uses no persistent pixel/module cache.
            auto projected = sampleGuidedProjection(*bits, track, finderSet);
            if (projected.isValid() && projected.bits().width() == track.dimension) {
                metrics->sampleAttempts++;
                metrics->fastDecodeAttempts++;
                const double fastStart = guidedNowMs();
                auto decoded = QRCode::Decode(projected.bits());
                const double fastElapsed = guidedNowMs() - fastStart;
                metrics->fastDecodeMs += fastElapsed;
                metrics->decodeMs += fastElapsed;
                decodeSpent += fastElapsed;
                decodedTrack = commitDecoded(projected, decoded);
                if (decodedTrack)
                    metrics->fastDecodeSuccesses++;
            }

            // Projection misses retain the exact proven decoder. No cache, no
            // reduced ECC, and no correctness tradeoff: SampleQR remains the
            // oracle and refreshes the returned quad for the lattice.
            if (!decodedTrack) {
                for (auto&& detected : QRCode::SampleQR(*bits, finderSet)) {
                    metrics->sampleAttempts++;
                    if (!detected.isValid() || detected.bits().width() != track.dimension)
                        continue;
                    ++metrics->genericDecodeAttempts;
                    const double genericStart = guidedNowMs();
                    auto decoded = QRCode::Decode(detected.bits());
                    const double genericElapsed = guidedNowMs() - genericStart;
                    metrics->genericDecodeMs += genericElapsed;
                    metrics->decodeMs += genericElapsed;
                    decodeSpent += genericElapsed;
                    if (commitDecoded(detected, decoded)) {
                        decodedTrack = true;
                        break;
                    }
                }
            }
            metrics->sampleMs += std::max(0.0, guidedNowMs() - sampleStart - decodeSpent);
'''
if loop_old not in text:
    raise SystemExit("guided loop anchor not found")
text = text.replace(loop_old, loop_new, 1)
cpp.write_text(text)
