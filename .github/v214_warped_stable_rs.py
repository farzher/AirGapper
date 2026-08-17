from pathlib import Path
import re


def replace(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"replacement not found in {path}: {old[:240]!r}")
    p.write_text(s.replace(old, new, count))

replace("index.html", "v0.5.213", "v0.5.214")
replace("main.js", 'const APP_BUILD = "v0.5.213";', 'const APP_BUILD = "v0.5.214";')
replace("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.213";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.214";')
replace("sw.js", 'const CACHE = "airgapper-static-js-v175";', 'const CACHE = "airgapper-static-js-v176";')
replace("vendor/decimen-codec/source/VERSION", "0.1.30", "0.1.31")

# The metric ABI field remains stableEligibleTracks; only the human label changes.
p = Path("receive/main.js")
s = p.read_text()
s = s.replace(' · rigid ${livePipeline.guidedStableEligibleTracks}', ' · stable ${livePipeline.guidedStableEligibleTracks}')
s = s.replace(' eligible ${lastGuidedMetrics.stableEligibleTracks ?? 0}', ' stable ${lastGuidedMetrics.stableEligibleTracks ?? 0}')
p.write_text(s)

p = Path("vendor/decimen-codec/source/wrapper/decimen_codec.cpp")
s = p.read_text()

old = '''static bool turboStableRigidEligible(const GuidedTurboTrack& cache,
                                      const DecimenGuidedTrack& track, float residual)
{
    if (!cache.distortionAware)
        return false;
    const float module = guidedModuleSize(track);
    return module >= GUIDED_TURBO_CANARY_MIN_MODULE &&
           residual <= std::max(1.0f, module * 0.40f);
}'''
new = '''static bool turboStableWarpEligible(const GuidedTurboTrack& cache,
                                     const DecimenGuidedTrack& track, float residual)
{
    if (!cache.distortionAware)
        return false;
    const float module = guidedModuleSize(track);
    // Stable-RS now warps the calibrated distortion map from its seed quad to
    // the coherent live track quad. Keep only the broad stale-cache sanity gate
    // used by projective Turbo; the old ~1 px near-translation fence starved
    // >90% of a perfectly stationary wall before RS could even be attempted.
    return module >= GUIDED_TURBO_CANARY_MIN_MODULE &&
           residual <= std::max(4.0f, module * 2.0f);
}'''
if old not in s:
    raise SystemExit("stable eligibility block missing")
s = s.replace(old, new, 1)
s = s.replace("turboStableRigidEligible", "turboStableWarpEligible")

# Translation-only finder/readback helpers are no longer used by Stable-RS.
pattern = re.compile(r'''static TurboLevels turboReadLevelsRigid\(.*?\n\}\n\nstatic std::optional<PointF> turboRefineRigidOffset\(.*?\n\}\n\n// Model-2 data placement''', re.S)
match = pattern.search(s)
if not match:
    raise SystemExit("rigid helper block missing")
s = s[:match.start()] + "// Model-2 data placement" + s[match.end():]

old = '''static DecoderResult decodeTurboStableRS(const GuidedTurboTrack& cache,
                                         const DecimenGuidedTrack& track,
                                         const uint8_t* yPlane, int width, int height, int stride,
                                         float dx, float dy, const TurboLevels& levels,
                                         DecimenGuidedMetrics& metrics)'''
new = '''static DecoderResult decodeTurboStableRS(const GuidedTurboTrack& cache,
                                         const DecimenGuidedTrack& track,
                                         const PerspectiveTransform& frameTransform,
                                         const uint8_t* yPlane, int width, int height, int stride,
                                         float dx, float dy, const TurboLevels& levels,
                                         DecimenGuidedMetrics& metrics)'''
if old not in s:
    raise SystemExit("stable RS signature missing")
s = s.replace(old, new, 1)

old = '''    const double sampleStarted = guidedNowMs();
    ByteArray raw(totalCodewords);
    bool failed = false;'''
new = '''    const double sampleStarted = guidedNowMs();
    ByteArray raw(totalCodewords);
    const float moduleSize = guidedModuleSize(track);
    bool failed = false;'''
# Only replace the occurrence in decodeTurboStableRS: use rfind before decodeStarted marker.
start = s.index("static DecoderResult decodeTurboStableRS")
pos = s.index(old, start)
s = s[:pos] + new + s[pos + len(old):]

old = '''            const int threshold = turboThreshold(levels, xx, y, dim);
            const PointF p = cache.samples[size_t(y) * dim + xx];
            const int lum = turboLum(yPlane, width, height, stride, p, dx, dy);
            if (lum < 0) { failed = true; break; }'''
new = '''            const int threshold = turboThreshold(levels, xx, y, dim);
            const int lum = turboModuleLum(cache, track, frameTransform,
                                           yPlane, width, height, stride,
                                           xx, y, dx, dy, threshold, moduleSize);
            if (lum < 0) { failed = true; break; }'''
pos = s.index(old, start)
s = s[:pos] + new + s[pos + len(old):]

# Shared residual refinement is now useful to both direct Turbo and warped Stable-RS.
s = s.replace('''        if (!turboAdaptive.promoted || !turboAdaptive.rsMode) {
            for (int i = 0; i < trackCount; ++i) {''', '''        if (!turboAdaptive.cooldown) {
            for (int i = 0; i < trackCount; ++i) {''', 1)

old = '''        // Stable-RS uses the calibrated distortion map as-is plus a single
        // shared residual translation. It is enabled only when the live quad is
        // still rigidly consistent with that map; handheld/projective motion stays
        // on the existing projective direct canary + Guided recovery chain.
        float stableResidualX = 0, stableResidualY = 0;
        int stableReferenceTries = 0;
        for (int i = 0; i < trackCount && stableReferenceTries < 3; ++i) {
            auto* cache = guidedTurboTrack(tracks[i].id);
            if (!cache || !cache->seeded || !cache->distortionAware || cache->cooldown)
                continue;
            float poseX = 0, poseY = 0, residual = 0;
            if (!turboPose(*cache, tracks[i], poseX, poseY, residual) ||
                !turboStableWarpEligible(*cache, tracks[i], residual))
                continue;
            ++stableReferenceTries;
            const auto refined = turboRefineRigidOffset(*cache, yPlane, width, height, stride, poseX, poseY);
            if (!refined)
                continue;
            stableResidualX = refined->x - poseX;
            stableResidualY = refined->y - poseY;
            break;
        }

'''
new = '''        // Stable-RS uses the same coherent projective seed->live warp as
        // direct Turbo, plus the one shared sub-pixel residual refined above.
        // RS + AirGapper CRC remain the acceptance oracle, so a stale warp only
        // causes a cheap miss and Guided fallback.

'''
if old not in s:
    raise SystemExit("stable residual block missing")
s = s.replace(old, new, 1)

s = s.replace('''            // `rigid` now means exactly what diagnostics need: this cache/track
            // geometry can use the rigid Stable-RS sampler. Finder contrast is a
            // separate, cheap per-slot gate and must not erase this opportunity.''', '''            // `stable` means the calibrated map can be projectively warped onto
            // this live track. Finder contrast is a separate cheap per-slot gate.''', 1)

old = '''            if (!success && stableEligible && (!turboAdaptive.promoted || turboAdaptive.rsMode)) {
                const float dx = poseX + stableResidualX;
                const float dy = poseY + stableResidualY;
                const auto levels = turboReadLevelsRigid(*cache, yPlane, width, height, stride, dx, dy);
                if (levels.ok) {
                    stableRsAttempted = true;
                    ++metrics->sampleAttempts;
                    ++metrics->sparseRsFallbacks;
                    ++metrics->stableRsAttempts;
                    auto decoded = decodeTurboStableRS(*cache, track, yPlane, width, height, stride,
                                                       dx, dy, levels, *metrics);
                    success = commitTurbo(i, decoded, stableResidualX, stableResidualY);
                    if (success)
                        ++metrics->stableRsSuccesses;
                }
            }'''
new = '''            if (!success && stableEligible && (!turboAdaptive.promoted || turboAdaptive.rsMode)) {
                const auto frameTransform = turboFrameTransform(*cache, track);
                if (frameTransform.isValid()) {
                    const float dx = wallCorrectionX;
                    const float dy = wallCorrectionY;
                    const auto levels = turboReadLevels(*cache, track, frameTransform,
                                                        yPlane, width, height, stride, dx, dy);
                    if (levels.ok) {
                        stableRsAttempted = true;
                        ++metrics->sampleAttempts;
                        ++metrics->sparseRsFallbacks;
                        ++metrics->stableRsAttempts;
                        auto decoded = decodeTurboStableRS(*cache, track, frameTransform,
                                                           yPlane, width, height, stride,
                                                           dx, dy, levels, *metrics);
                        success = commitTurbo(i, decoded, wallCorrectionX, wallCorrectionY);
                        if (success)
                            ++metrics->stableRsSuccesses;
                    }
                }
            }'''
if old not in s:
    raise SystemExit("stable branch missing")
s = s.replace(old, new, 1)

s = s.replace('''            // First choice: a distortion-aware map whose seed->live shape is
            // actually rigid on this frame. This makes Stable-RS probation test
            // the stable wall, not whichever QR happened to decode first.''', '''            // First choice: any distortion-aware map whose cached geometry is
            // still close enough for a projective seed->live warp. Stable-RS no
            // longer requires the seed quad to remain near-translation rigid.''', 1)

p.write_text(s)
