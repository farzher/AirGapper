from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected exactly one match, found {count}: {old[:160]!r}")
    p.write_text(text.replace(old, new, 1))


cpp = "vendor/decimen-codec/source/wrapper/decimen_codec.cpp"

replace_once(
    cpp,
    "// Keep Stable-RS while it earns wins, but if a recent 12-attempt window falls\n// below 25% success, bypass it and probe once per 32 eligible slots. CRC-backed\n// probe success immediately re-enables the cached path. Higher-density images\n// keep the normal Stable-RS behavior and do not contaminate this low-density gate.",
    "// Keep Stable-RS while it earns wins, but if a recent 8-attempt per-slot window falls\n"
    "// below 25% success, bypass it and probe once per 16 appearances of that slot.\n"
    "// With several workers, a 32-appearance per-worker probe could otherwise park a\n"
    "// recovered slot on Sparse for many seconds. CRC-backed probe success immediately\n"
    "// re-enables the cached path. Higher-density images keep normal Stable-RS behavior."
)
replace_once(cpp, "    if (++gate.skipped >= 32) {", "    if (++gate.skipped >= 16) {")
replace_once(
    cpp,
    "    if (gate.attempts >= 12 && int(gate.successes) * 4 < int(gate.attempts)) {",
    "    if (gate.attempts >= 8 && int(gate.successes) * 4 < int(gate.attempts)) {"
)

old_wall = """        float wallCorrectionX = 0, wallCorrectionY = 0;
        int wallReferenceTries = 0;
        for (int i = 0; i < trackCount && wallReferenceTries < 4; ++i) {
            const int referenceId = tracks[i].id;
            const uint32_t referenceBit = i < 32 ? (uint32_t(1) << i) : 0;
            if (referenceBit && (repairAllowedMask & referenceBit) == 0)
                continue;
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
new_wall = """        float wallCorrectionX = 0, wallCorrectionY = 0;
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
replace_once(cpp, old_wall, new_wall)

# The regression harness occasionally clicked Send before main.js had installed
# its view handlers. The click was then lost and page.fill waited 30s on a hidden
# textarea. history.state is written only after those handlers are installed, so
# use it as the deterministic application-ready barrier and confirm Send is active.
runner = "benchmark/offline-runner.mjs"
replace_once(
    runner,
    "async function generateSenderProfiles() {\n  await page.goto(baseUrl, { waitUntil: \"networkidle\" });\n  await page.locator('[data-mode=\"send\"]').click();\n  await page.evaluate(() => {",
    "async function generateSenderProfiles() {\n"
    "  await page.goto(baseUrl, { waitUntil: \"networkidle\" });\n"
    "  await page.waitForFunction(() => history.state?.airgapperView === \"home\");\n"
    "  await page.locator('[data-mode=\"send\"]').click();\n"
    "  await page.waitForFunction(() => document.getElementById(\"sendView\")?.classList.contains(\"active\"));\n"
    "  await page.evaluate(() => {"
)

replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.315";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.316";')
replace_once("send/main.js", 'const SEND_RUNTIME_BUILD = "v0.5.315";', 'const SEND_RUNTIME_BUILD = "v0.5.316";')
replace_once("main.js", 'const APP_BUILD = "v0.5.315";', 'const APP_BUILD = "v0.5.316";')
replace_once("index.html", '<span class="app-version">v0.5.315</span>', '<span class="app-version">v0.5.316</span>')
replace_once("index.html", './main.js?build=v0.5.315', './main.js?build=v0.5.316')
replace_once("sw.js", 'const CACHE = "airgapper-static-js-v263";', 'const CACHE = "airgapper-static-js-v264";')

print("staged v0.5.316: proven central wall reference, faster per-slot recovery, deterministic benchmark readiness")
