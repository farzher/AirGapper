from pathlib import Path

cpp = Path('vendor/decimen-codec/source/wrapper/decimen_codec.cpp')
s = cpp.read_text()

if 'affineOnly' in s:
    raise SystemExit('v241 affine warp patch already applied')

old = '''    PerspectiveTransform perspective;
    PointF translation{0, 0};
    bool translationOnly = false;
'''
new = '''    PerspectiveTransform perspective;
    PointF translation{0, 0};
    float m00 = 1, m01 = 0, m10 = 0, m11 = 1, tx = 0, ty = 0;
    bool translationOnly = false;
    bool affineOnly = false;
'''
if old not in s:
    raise SystemExit('TurboFrameTransform fields anchor missing')
s = s.replace(old, new, 1)

old = '''        const float module = guidedModuleSize(track);
        const float tolerance = std::clamp(module * 0.08f, 0.15f, 0.40f);
        translationOnly = residual <= tolerance;
    }

    bool isValid() const { return translationOnly || perspective.isValid(); }
    PointF operator()(PointF p) const { return translationOnly ? p + translation : perspective(p); }
'''
new = '''        const float module = guidedModuleSize(track);
        const float tolerance = std::clamp(module * 0.08f, 0.15f, 0.40f);
        translationOnly = residual <= tolerance;

        // Handheld motion is usually translation + rotation/scale/shear between
        // adjacent camera frames. Those transforms are affine and do not need a
        // projective divide for every QR bit. Solve the affine map once from
        // TL/TR/BL, then use the fourth corner only as an accuracy oracle.
        // Significant perspective still uses the exact homography below.
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
    }

    bool isValid() const { return translationOnly || affineOnly || perspective.isValid(); }
    PointF operator()(PointF p) const
    {
        if (translationOnly)
            return p + translation;
        if (affineOnly)
            return PointF{m00 * float(p.x) + m01 * float(p.y) + tx,
                          m10 * float(p.x) + m11 * float(p.y) + ty};
        return perspective(p);
    }
'''
if old not in s:
    raise SystemExit('TurboFrameTransform constructor anchor missing')
s = s.replace(old, new, 1)

old_comment = '''// A locked camera spends most frames in an almost-rigid pose. Re-solving a
// projective division for every cached module is wasted work when all four live
// corners moved by the same sub-pixel translation. Keep the full projective
// transform ready for real scale/rotation/perspective motion, but recognize the
// common stable case once per slot/job and reuse the calibrated sample map with
// a single translation add. Finder evidence + QR RS + AirGapper CRC still gate
// every accepted Stable-RS result, so a borderline classification can only
// cause this attempt to miss and fall through to Guided.
'''
new_comment = '''// Avoid a projective division per sampled module whenever the current tracked
// quad proves a cheaper transform is accurate: pure translation first, then an
// affine map for ordinary handheld rotation/scale/shear, with the full homography
// reserved for genuine perspective change. Finder evidence + QR RS + AirGapper
// CRC still gate every accepted result, so a cheap-warp miss falls through.
'''
if old_comment not in s:
    raise SystemExit('TurboFrameTransform comment anchor missing')
s = s.replace(old_comment, new_comment, 1)

cpp.write_text(s)

for path, old_version, new_version in [
    ('vendor/decimen-codec/source/VERSION', '0.1.49', '0.1.50'),
    ('main.js', 'v0.5.240', 'v0.5.241'),
    ('receive/main.js', 'v0.5.240', 'v0.5.241'),
    ('index.html', 'v0.5.240', 'v0.5.241'),
]:
    p = Path(path)
    text = p.read_text()
    if old_version not in text:
        raise SystemExit(f'{path}: version target {old_version} missing')
    p.write_text(text.replace(old_version, new_version))

sw = Path('sw.js')
text = sw.read_text()
if 'airgapper-static-js-v196' not in text:
    raise SystemExit('sw cache v196 target missing')
sw.write_text(text.replace('airgapper-static-js-v196', 'airgapper-static-js-v197', 1))
