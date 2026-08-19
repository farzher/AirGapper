from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected exactly one match, found {count}: {old[:180]!r}")
    p.write_text(text.replace(old, new, 1))


cpp = "vendor/decimen-codec/source/wrapper/decimen_codec.cpp"

# Finder agreement is max 147. If the predicted shared-wall residual already
# matches at least 146/147 finder modules, a sub-pixel neighborhood search is
# extremely unlikely to buy anything. CRC still gates every eventual QR result.
replace_once(
    cpp,
    "    consider(predictedX, predictedY);\n    if (bestMatches < 143) {",
    "    consider(predictedX, predictedY);\n"
    "    if (bestMatches >= 146)\n"
    "        return best;\n"
    "    if (bestMatches < 143) {"
)
replace_once(
    cpp,
    "    if (bestScore < 0)\n        return std::nullopt;\n    const PointF coarse = best;",
    "    if (bestScore < 0)\n"
    "        return std::nullopt;\n"
    "    // A coarse integer search that already lands essentially perfectly is\n"
    "    // also done. Avoid eight additional half-pixel finder reads.\n"
    "    if (bestMatches >= 146)\n"
    "        return best;\n"
    "    const PointF coarse = best;"
)

# v316's central/proven sorting looked attractive but the corpus showed the
# local residual of a center QR is not necessarily representative of the whole
# wall. Preserve the receiver's existing track order (which already reflects
# scheduling/quality), while retaining v316's important repair-mask and
# per-slot-suppression fences.
old_wall = """        float wallCorrectionX = 0, wallCorrectionY = 0;
        std::vector<int> wallReferenceOrder;
        wallReferenceOrder.reserve(std::min(trackCount, 32));
        const PointF wallImageCenter{width * 0.5, height * 0.5};
        auto trackCenter = [](const DecimenGuidedTrack& track) {
            return PointF{(track.x0 + track.x1 + track.x2 + track.x3) * 0.25f,
                          (track.y0 + track.y1 + track.y2 + track.y3) * 0.25f};
        };
        for (int i = 0; i < trackCount && i < 32; ++i) {
            const uint32_t referenceBit = uint32_t(1) << i;
            if ((repairAllowedMask & referenceBit) == 0)
                continue;
            const int referenceId = tracks[i].id;
            auto* cache = guidedTurboTrack(referenceId);
            if (!cache || !turboStableWarpEligible(*cache, tracks[i]))
                continue;
            auto& referenceGate = guidedDenseStableRsGate(referenceId, tracks[i].dimension);
            if (guidedModuleSize(tracks[i]) <= GUIDED_STABLE_ADAPT_MAX_MODULE && referenceGate.suppressed)
                continue;
            wallReferenceOrder.push_back(i);
        }
        std::sort(wallReferenceOrder.begin(), wallReferenceOrder.end(), [&](int a, int b) {
            const auto* ca = guidedTurboTrack(tracks[a].id);
            const auto* cb = guidedTurboTrack(tracks[b].id);
            const int sa = ca ? int(ca->stableSuccesses) : 0;
            const int sb = cb ? int(cb->stableSuccesses) : 0;
            if (sa != sb)
                return sa > sb;
            const PointF pa = trackCenter(tracks[a]);
            const PointF pb = trackCenter(tracks[b]);
            const double da = std::hypot(pa.x - wallImageCenter.x, pa.y - wallImageCenter.y);
            const double db = std::hypot(pb.x - wallImageCenter.x, pb.y - wallImageCenter.y);
            if (std::abs(da - db) > 1e-6)
                return da < db;
            return tracks[a].id < tracks[b].id;
        });
        int wallReferenceTries = 0;
        for (int i : wallReferenceOrder) {
            if (wallReferenceTries >= 4)
                break;
            auto* cache = guidedTurboTrack(tracks[i].id);
            if (!cache)
                continue;
            const auto frameTransform = turboFrameTransform(*cache, tracks[i]);
            if (!frameTransform.isValid())
                continue;
            ++wallReferenceTries;
            const auto refined = turboRefineWallOffset(*cache, tracks[i], frameTransform,
                                                        yPlane, width, height, stride, 0, 0);
            if (!refined)
                continue;
            wallCorrectionX = refined->x;
            wallCorrectionY = refined->y;
            break;
        }
"""
new_wall = """        float wallCorrectionX = 0, wallCorrectionY = 0;
        int wallReferenceTries = 0;
        // Preserve the receiver's quality-aware track order. Only indices with
        // an actual 32-bit repair-mask bit may influence the shared correction;
        // a temporally fenced slot must not steer the rest of the wall.
        for (int i = 0; i < trackCount && i < 32 && wallReferenceTries < 4; ++i) {
            const uint32_t referenceBit = uint32_t(1) << i;
            if ((repairAllowedMask & referenceBit) == 0)
                continue;
            const int referenceId = tracks[i].id;
            auto* cache = guidedTurboTrack(referenceId);
            if (!cache || !turboStableWarpEligible(*cache, tracks[i]))
                continue;
            auto& referenceGate = guidedDenseStableRsGate(referenceId, tracks[i].dimension);
            if (guidedModuleSize(tracks[i]) <= GUIDED_STABLE_ADAPT_MAX_MODULE && referenceGate.suppressed)
                continue;
            const auto frameTransform = turboFrameTransform(*cache, tracks[i]);
            if (!frameTransform.isValid())
                continue;
            ++wallReferenceTries;
            const auto refined = turboRefineWallOffset(*cache, tracks[i], frameTransform,
                                                        yPlane, width, height, stride, 0, 0);
            if (!refined)
                continue;
            wallCorrectionX = refined->x;
            wallCorrectionY = refined->y;
            break;
        }
"""
replace_once(cpp, old_wall, new_wall)

# Version/cache busts. Keep v316's deterministic benchmark readiness fix.
replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.316";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.317";')
replace_once("send/main.js", 'const SEND_RUNTIME_BUILD = "v0.5.316";', 'const SEND_RUNTIME_BUILD = "v0.5.317";')
replace_once("main.js", 'const APP_BUILD = "v0.5.316";', 'const APP_BUILD = "v0.5.317";')
replace_once("index.html", '<span class="app-version">v0.5.316</span>', '<span class="app-version">v0.5.317</span>')
replace_once("index.html", './main.js?build=v0.5.316', './main.js?build=v0.5.317')
replace_once("sw.js", 'const CACHE = "airgapper-static-js-v264";', 'const CACHE = "airgapper-static-js-v265";')

print("staged v0.5.317: preserve quality track order and skip needless wall subpixel probes")
