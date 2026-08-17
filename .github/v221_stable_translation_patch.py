from pathlib import Path

p = Path("vendor/decimen-codec/source/wrapper/decimen_codec.cpp")
s = p.read_text()
old = '''static PerspectiveTransform turboFrameTransform(const GuidedTurboTrack& cache,
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
new = '''// A locked camera spends most frames in an almost-rigid pose. Re-solving a
// projective division for every cached module is wasted work when all four live
// corners moved by the same sub-pixel translation. Keep the full projective
// transform ready for real scale/rotation/perspective motion, but recognize the
// common stable case once per slot/job and reuse the calibrated sample map with
// a single translation add. Finder evidence + QR RS + AirGapper CRC still gate
// every accepted Stable-RS result, so a borderline classification can only
// cause this attempt to miss and fall through to Guided.
struct TurboFrameTransform
{
    PerspectiveTransform perspective;
    PointF translation{0, 0};
    bool translationOnly = false;

    TurboFrameTransform(const GuidedTurboTrack& cache, const DecimenGuidedTrack& track)
        : perspective(
            QuadrilateralF{cache.seedQuad[0], cache.seedQuad[1], cache.seedQuad[2], cache.seedQuad[3]},
            QuadrilateralF{PointF{track.x0, track.y0}, PointF{track.x1, track.y1},
                           PointF{track.x2, track.y2}, PointF{track.x3, track.y3}})
    {
        const std::array<PointF, 4> current{
            PointF{track.x0, track.y0}, PointF{track.x1, track.y1},
            PointF{track.x2, track.y2}, PointF{track.x3, track.y3}
        };
        std::array<PointF, 4> delta;
        for (int i = 0; i < 4; ++i) {
            delta[i] = current[i] - cache.seedQuad[i];
            translation.x += delta[i].x;
            translation.y += delta[i].y;
        }
        translation.x *= 0.25f;
        translation.y *= 0.25f;
        float residual = 0;
        for (const auto& d : delta)
            residual = std::max(residual, float(std::hypot(d.x - translation.x, d.y - translation.y)));
        const float module = guidedModuleSize(track);
        const float tolerance = std::clamp(module * 0.08f, 0.15f, 0.40f);
        translationOnly = residual <= tolerance;
    }

    bool isValid() const { return translationOnly || perspective.isValid(); }
    PointF operator()(PointF p) const { return translationOnly ? p + translation : perspective(p); }
};

static TurboFrameTransform turboFrameTransform(const GuidedTurboTrack& cache,
                                                const DecimenGuidedTrack& track)
{
    return TurboFrameTransform(cache, track);
}

static PointF turboWarpedPoint(const GuidedTurboTrack& cache,
                               const TurboFrameTransform& frameTransform, int x, int y)
{
    return frameTransform(cache.samples[size_t(y) * cache.dimension + x]);
}
'''
if old not in s:
    raise SystemExit("turboFrameTransform target not found")
s = s.replace(old, new, 1)
count = s.count("const PerspectiveTransform& frameTransform")
if count < 4:
    raise SystemExit(f"expected >=4 turbo frame transform parameters, found {count}")
s = s.replace("const PerspectiveTransform& frameTransform", "const TurboFrameTransform& frameTransform")
p.write_text(s)
