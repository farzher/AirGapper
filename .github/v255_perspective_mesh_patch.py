from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f'{path}: patch anchor missing: {old[:80]!r}')
    p.write_text(text.replace(old, new, 1))

p = Path('vendor/decimen-codec/source/wrapper/decimen_codec.cpp')
text = p.read_text()
start = text.index('struct TurboFrameTransform\n{')
end = text.index('static bool turboFinderIdeal', start)
new_block = r'''constexpr int TURBO_PERSPECTIVE_MESH_CELLS = 4;
constexpr int TURBO_PERSPECTIVE_MESH_POINTS = TURBO_PERSPECTIVE_MESH_CELLS + 1;

struct TurboFrameTransform
{
    PerspectiveTransform perspective;
    PointF translation{0, 0};
    float m00 = 1, m01 = 0, m10 = 0, m11 = 1, tx = 0, ty = 0;
    std::array<PointF, TURBO_PERSPECTIVE_MESH_POINTS * TURBO_PERSPECTIVE_MESH_POINTS> perspectiveDelta{};
    float perspectiveMeshScale = 0;
    bool translationOnly = false;
    bool affineOnly = false;
    bool perspectiveMesh = false;

    PointF meshWarp(PointF p, int x, int y) const
    {
        const float gx = std::clamp(float(x) * perspectiveMeshScale, 0.0f,
                                    float(TURBO_PERSPECTIVE_MESH_CELLS));
        const float gy = std::clamp(float(y) * perspectiveMeshScale, 0.0f,
                                    float(TURBO_PERSPECTIVE_MESH_CELLS));
        const int ix = std::min(TURBO_PERSPECTIVE_MESH_CELLS - 1, std::max(0, int(gx)));
        const int iy = std::min(TURBO_PERSPECTIVE_MESH_CELLS - 1, std::max(0, int(gy)));
        const float u = gx - ix;
        const float v = gy - iy;
        const int stride = TURBO_PERSPECTIVE_MESH_POINTS;
        const PointF& d00 = perspectiveDelta[iy * stride + ix];
        const PointF& d10 = perspectiveDelta[iy * stride + ix + 1];
        const PointF& d01 = perspectiveDelta[(iy + 1) * stride + ix];
        const PointF& d11 = perspectiveDelta[(iy + 1) * stride + ix + 1];
        const PointF top{d00.x + (d10.x - d00.x) * u,
                         d00.y + (d10.y - d00.y) * u};
        const PointF bottom{d01.x + (d11.x - d01.x) * u,
                            d01.y + (d11.y - d01.y) * u};
        const PointF delta{top.x + (bottom.x - top.x) * v,
                           top.y + (bottom.y - top.y) * v};
        return p + delta;
    }

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

        if (!translationOnly) {
            const PointF seedU = cache.seedQuad[1] - cache.seedQuad[0];
            const PointF seedV = cache.seedQuad[3] - cache.seedQuad[0];
            const PointF liveU = current[1] - current[0];
            const PointF liveV = current[3] - current[0];
            const float det = float(seedU.x * seedV.y - seedU.y * seedV.x);
            if (std::abs(det) > 1e-5f) {
                const float inv00 = float(seedV.y) / det;
                const float inv01 = -float(seedV.x) / det;
                const float inv10 = -float(seedU.y) / det;
                const float inv11 = float(seedU.x) / det;
                m00 = float(liveU.x) * inv00 + float(liveV.x) * inv10;
                m01 = float(liveU.x) * inv01 + float(liveV.x) * inv11;
                m10 = float(liveU.y) * inv00 + float(liveV.y) * inv10;
                m11 = float(liveU.y) * inv01 + float(liveV.y) * inv11;
                tx = float(current[0].x) - m00 * float(cache.seedQuad[0].x) - m01 * float(cache.seedQuad[0].y);
                ty = float(current[0].y) - m10 * float(cache.seedQuad[0].x) - m11 * float(cache.seedQuad[0].y);
                const PointF predictedBR{
                    m00 * float(cache.seedQuad[2].x) + m01 * float(cache.seedQuad[2].y) + tx,
                    m10 * float(cache.seedQuad[2].x) + m11 * float(cache.seedQuad[2].y) + ty
                };
                const float affineError = float(std::hypot(predictedBR.x - current[2].x,
                                                           predictedBR.y - current[2].y));
                const float affineTolerance = std::clamp(module * 0.18f, 0.30f, 0.75f);
                affineOnly = affineError <= affineTolerance;
            }
        }

        // A true handheld projective warp is smooth. Preserve the calibrated
        // lens-distortion sample map and approximate only the frame-to-frame
        // displacement field with a 4x4 bilinear mesh. This replaces one
        // homography divide per sampled module with multiply/add. Validate the
        // approximation at every cell center before enabling it; otherwise use
        // the exact PerspectiveTransform. QR RS + AirGapper CRC remain the final
        // acceptance oracle either way.
        const int dim = track.dimension;
        if (!translationOnly && !affineOnly && perspective.isValid() && dim > 1 &&
            cache.samples.size() == size_t(dim) * dim) {
            perspectiveMeshScale = float(TURBO_PERSPECTIVE_MESH_CELLS) / float(dim - 1);
            auto controlCoord = [&](int index) {
                return std::clamp(int(std::lround(double(index) * (dim - 1) /
                                                  TURBO_PERSPECTIVE_MESH_CELLS)), 0, dim - 1);
            };
            for (int gy = 0; gy < TURBO_PERSPECTIVE_MESH_POINTS; ++gy)
                for (int gx = 0; gx < TURBO_PERSPECTIVE_MESH_POINTS; ++gx) {
                    const int x = controlCoord(gx);
                    const int y = controlCoord(gy);
                    const PointF p = cache.samples[size_t(y) * dim + x];
                    perspectiveDelta[gy * TURBO_PERSPECTIVE_MESH_POINTS + gx] = perspective(p) - p;
                }

            float maxError = 0;
            for (int gy = 0; gy < TURBO_PERSPECTIVE_MESH_CELLS; ++gy)
                for (int gx = 0; gx < TURBO_PERSPECTIVE_MESH_CELLS; ++gx) {
                    const int x = std::clamp(int(std::lround((gx + 0.5) * (dim - 1) /
                                                             TURBO_PERSPECTIVE_MESH_CELLS)), 0, dim - 1);
                    const int y = std::clamp(int(std::lround((gy + 0.5) * (dim - 1) /
                                                             TURBO_PERSPECTIVE_MESH_CELLS)), 0, dim - 1);
                    const PointF p = cache.samples[size_t(y) * dim + x];
                    const PointF exact = perspective(p);
                    const PointF approx = meshWarp(p, x, y);
                    maxError = std::max(maxError, float(std::hypot(exact.x - approx.x,
                                                                   exact.y - approx.y)));
                }
            const float meshTolerance = std::clamp(module * 0.10f, 0.14f, 0.30f);
            perspectiveMesh = maxError <= meshTolerance;
        }
    }

    bool isValid() const { return translationOnly || affineOnly || perspectiveMesh || perspective.isValid(); }
    PointF operator()(PointF p) const
    {
        if (translationOnly)
            return p + translation;
        if (affineOnly)
            return PointF{m00 * float(p.x) + m01 * float(p.y) + tx,
                          m10 * float(p.x) + m11 * float(p.y) + ty};
        return perspective(p);
    }
};

static TurboFrameTransform turboFrameTransform(const GuidedTurboTrack& cache,
                                                const DecimenGuidedTrack& track)
{
    return TurboFrameTransform(cache, track);
}

static PointF turboWarpedPoint(const GuidedTurboTrack& cache,
                               const TurboFrameTransform& frameTransform, int x, int y)
{
    const PointF p = cache.samples[size_t(y) * cache.dimension + x];
    return frameTransform.perspectiveMesh ? frameTransform.meshWarp(p, x, y) : frameTransform(p);
}

'''
p.write_text(text[:start] + new_block + text[end:])

replace_once('vendor/decimen-codec/source/VERSION', '0.1.53\n', '0.1.54\n')
for path in ['main.js', 'receive/main.js', 'index.html']:
    replace_once(path, 'v0.5.253', 'v0.5.255')
replace_once('sw.js', 'airgapper-static-js-v209', 'airgapper-static-js-v210')
