from pathlib import Path
import re


def replace(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"replacement not found in {path}: {old[:220]!r}")
    p.write_text(s.replace(old, new, count))


def sub(path, pattern, replacement, count=1):
    p = Path(path)
    s = p.read_text()
    s2, n = re.subn(pattern, replacement, s, count=count, flags=re.S)
    if n != count:
        raise SystemExit(f"regex replacement count {n} != {count} in {path}: {pattern[:180]!r}")
    p.write_text(s2)


# ---------------------------------------------------------------------------
# Versions / cache.
# ---------------------------------------------------------------------------
replace("index.html", "v0.5.205", "v0.5.206")
replace("main.js", 'const APP_BUILD = "v0.5.205";', 'const APP_BUILD = "v0.5.206";')
replace("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.205";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.206";')
replace("sw.js", 'const CACHE = "airgapper-static-js-v167";', 'const CACHE = "airgapper-static-js-v168";')
replace("vendor/decimen-codec/source/VERSION", "0.1.27", "0.1.28")

# ---------------------------------------------------------------------------
# WASM ABI correctness. DecimenGuidedMetrics ends at byte 156 but is 8-byte
# aligned because it contains doubles, so sizeof is 160. v203-v205 allocated
# only 156 bytes in JS and C++ zeroed/wrote 160 bytes into that allocation.
# ---------------------------------------------------------------------------
replace("receive/worker.js", "const GUIDED_METRICS_BYTES = 156;", "const GUIDED_METRICS_BYTES = 160;")

header = Path("vendor/decimen-codec/source/wrapper/decimen_codec.h")
s = header.read_text()
s = s.replace(
'''\tDECIMEN_TRACK_OK = 1,\n\tDECIMEN_TRACK_OUTPUT_FULL = 2,\n};''',
'''\tDECIMEN_TRACK_OK = 1,\n\tDECIMEN_TRACK_OUTPUT_FULL = 2,\n\t// Bytes are valid, but the returned quad is a prediction from cached\n\t// geometry rather than a fresh finder/alignment measurement.\n\tDECIMEN_TRACK_PREDICTED = 3,\n};''', 1)
if 'DECIMEN_TRACK_PREDICTED' not in s:
    raise SystemExit("failed to add predicted status")
header.write_text(s)

cpp = Path("vendor/decimen-codec/source/wrapper/decimen_codec.cpp")
s = cpp.read_text()
s = s.replace(
'''using namespace ZXing;\n\nnamespace ZXing::QRCode {''',
'''using namespace ZXing;\n\nstatic_assert(sizeof(DecimenGuidedMetrics) == 160,\n              "DecimenGuidedMetrics JS ABI must allocate 160 bytes");\n\nnamespace ZXing::QRCode {''', 1)

# Remove dead/obsolete tuning state. Expensive maps are physical calibration,
# not probation state; never destroy them just because a short canary is weak.
s = s.replace('constexpr int GUIDED_TURBO_RS_BUDGET = 4;\n', '', 1)
s = s.replace('constexpr int GUIDED_TURBO_CANARY_COOLDOWN = 24;\n', 'constexpr int GUIDED_TURBO_CANARY_COOLDOWN = 6;\n', 1)

old = '''struct GuidedTurboAdaptive\n{\n    int seedId = -1;\n    int canaryAttempts = 0;\n    int canarySuccesses = 0;\n    int canaryDirectSuccesses = 0;\n    int canaryStableEligible = 0;\n    int promotedAttempts = 0;\n    int promotedSuccesses = 0;\n    int cooldown = 0;\n    bool promoted = false;\n    bool rsMode = false;\n};'''
new = '''struct GuidedTurboAdaptive\n{\n    int canaryAttempts = 0;\n    int canarySuccesses = 0;\n    int canaryDirectSuccesses = 0;\n    int canaryStableAttempts = 0;\n    int canaryStableSuccesses = 0;\n    int promotedAttempts = 0;\n    int promotedSuccesses = 0;\n    int cooldown = 0;\n    bool promoted = false;\n    bool rsMode = false;\n};'''
if old not in s: raise SystemExit("GuidedTurboAdaptive block missing")
s = s.replace(old, new, 1)

pattern = r'''static void coolLowDensityTurbo\(\)\n\{.*?\n\}\n\nstatic void demoteTurboPreserveCache\(\)\n\{.*?\n\}\n'''
replacement = '''static void pauseTurbo(bool refreshDistortion = false, int cooldown = GUIDED_TURBO_CANARY_COOLDOWN)\n{\n    auto& adaptive = guidedTurboAdaptive();\n    adaptive.canaryAttempts = 0;\n    adaptive.canarySuccesses = 0;\n    adaptive.canaryDirectSuccesses = 0;\n    adaptive.canaryStableAttempts = 0;\n    adaptive.canaryStableSuccesses = 0;\n    adaptive.promotedAttempts = 0;\n    adaptive.promotedSuccesses = 0;\n    adaptive.promoted = false;\n    adaptive.rsMode = false;\n    adaptive.cooldown = cooldown;\n    for (auto& cache : guidedTurboTracks()) {\n        cache.misses = 0;\n        cache.cooldown = 0;\n        // A sustained promoted Stable-RS collapse means the lens map no longer\n        // matches the current pose. Keep it usable for projective direct probes\n        // while allowing the next successful Guided sample to replace it.\n        if (refreshDistortion && cache.seeded)\n            cache.distortionAware = false;\n    }\n}\n'''
s, n = re.subn(pattern, replacement, s, count=1, flags=re.S)
if n != 1: raise SystemExit("turbo pause/demotion block missing")

old = '''static bool turboSeedEligible(const DecimenGuidedTrack& track)\n{\n    auto* cache = guidedTurboTrack(track.id);\n    if (!cache || guidedModuleSize(track) < GUIDED_TURBO_CANARY_MIN_MODULE)\n        return false;\n    auto& adaptive = guidedTurboAdaptive();\n    if (adaptive.cooldown)\n        return false;\n    // Guided already computed the sparse distortion controls. Materialize the\n    // full sample map only until this physical slot owns one good calibrated\n    // map (or its QR dimension changes). Rebuilding 177x177 coordinates every\n    // promoted frame was pure hot-path overhead.\n    return !cache->seeded || !cache->distortionAware || cache->dimension != track.dimension;\n}\n'''
new = '''static bool turboSeedEligible(const DecimenGuidedTrack& track)\n{\n    auto* cache = guidedTurboTrack(track.id);\n    if (!cache || guidedModuleSize(track) < GUIDED_TURBO_CANARY_MIN_MODULE)\n        return false;\n    // Calibration piggybacks on Guided work we are already paying for. Keep\n    // learning missing/stale maps even while Turbo probes themselves cool down.\n    return !cache->seeded || !cache->distortionAware || cache->dimension != track.dimension;\n}\n'''
if old not in s: raise SystemExit("turboSeedEligible block missing")
s = s.replace(old, new, 1)

old = '''    cache->misses = 0;\n    cache->cooldown = 0;\n    auto& adaptive = guidedTurboAdaptive();\n    if (adaptive.seedId < 0) adaptive.seedId = id;\n}'''
new = '''    cache->misses = 0;\n    cache->cooldown = 0;\n}'''
if old not in s: raise SystemExit("seedGuidedTurbo tail missing")
s = s.replace(old, new, 1)

# Stable residual search: use the cheap 3x3 neighborhood first. Expand to the
# old +/-2 ring only when the local solution is not already very clean.
pattern = r'''static PointF turboRefineRigidOffset\(const GuidedTurboTrack& cache,\n                                     const uint8_t\* yPlane, int width, int height, int stride,\n                                     float predictedX, float predictedY\)\n\{.*?\n\}\n\nstatic DecoderResult decodeTurboStableRS'''
replacement = '''static PointF turboRefineRigidOffset(const GuidedTurboTrack& cache,\n                                     const uint8_t* yPlane, int width, int height, int stride,\n                                     float predictedX, float predictedY)\n{\n    PointF best{predictedX, predictedY};\n    int bestScore = -1;\n    int bestMatches = -1;\n    auto consider = [&](float dx, float dy) {\n        const auto levels = turboReadLevelsRigid(cache, yPlane, width, height, stride, dx, dy);\n        if (!levels.ok) return;\n        const int score = levels.matches * 4 + levels.separation;\n        if (score > bestScore) {\n            bestScore = score;\n            bestMatches = levels.matches;\n            best = PointF{dx, dy};\n        }\n    };\n    for (int oy = -1; oy <= 1; ++oy)\n        for (int ox = -1; ox <= 1; ++ox)\n            consider(predictedX + ox, predictedY + oy);\n    if (bestMatches < 143) {\n        for (int oy = -2; oy <= 2; ++oy)\n            for (int ox = -2; ox <= 2; ++ox)\n                if (std::max(std::abs(ox), std::abs(oy)) == 2)\n                    consider(predictedX + ox, predictedY + oy);\n    }\n    const PointF coarse = best;\n    for (int hy = -1; hy <= 1; ++hy)\n        for (int hx = -1; hx <= 1; ++hx)\n            consider(coarse.x + hx * 0.5f, coarse.y + hy * 0.5f);\n    return best;\n}\n\n// Model-2 data placement never changes for a given dimension. Stable-RS runs\n// this traversal thousands of times, so build the function-pattern/mask walk\n// once per QR version and keep only packed {x,y,mask4} entries.\nstatic const std::vector<uint32_t>& turboCodewordPlan(int dim)\n{\n    static std::array<std::vector<uint32_t>, 41> plans;\n    static const std::vector<uint32_t> empty;\n    if (dim < 21 || dim > 177 || ((dim - 17) & 3))\n        return empty;\n    const int versionNumber = (dim - 17) / 4;\n    const auto* version = QRCode::Version::Model2(versionNumber);\n    if (!version)\n        return empty;\n    auto& plan = plans[versionNumber];\n    if (!plan.empty())\n        return plan;\n    const size_t wanted = size_t(version->totalCodewords()) * 8;\n    plan.reserve(wanted);\n    const auto functionPattern = version->buildFunctionPattern();\n    bool readingUp = true;\n    for (int x = dim - 1; x > 0 && plan.size() < wanted; x -= 2) {\n        if (x == 6) --x;\n        for (int row = 0; row < dim && plan.size() < wanted; ++row) {\n            const int y = readingUp ? dim - 1 - row : row;\n            for (int col = 0; col < 2 && plan.size() < wanted; ++col) {\n                const int xx = x - col;\n                if (functionPattern.get(xx, y)) continue;\n                const uint32_t mask = uint32_t(QRCode::GetDataMaskBit(4, xx, y));\n                plan.push_back(uint32_t(xx) | (uint32_t(y) << 8) | (mask << 16));\n            }\n        }\n        readingUp = !readingUp;\n    }\n    if (plan.size() != wanted) {\n        plan.clear();\n        return empty;\n    }\n    return plan;\n}\n\nstatic DecoderResult decodeTurboStableRS'''
s, n = re.subn(pattern, replacement, s, count=1, flags=re.S)
if n != 1: raise SystemExit("turboRefineRigidOffset block missing")

# Replace Stable-RS's per-attempt QR traversal/function-pattern build with the
# cached codeword plan. Sampling and threshold math are otherwise identical.
old = '''    const double sampleStarted = guidedNowMs();\n    const auto functionPattern = version->buildFunctionPattern();\n    ByteArray raw;\n    raw.reserve(totalCodewords);\n    uint8_t currentByte = 0;\n    int bitsRead = 0;\n    bool readingUp = true;\n    bool failed = false;\n    for (int x = dim - 1; x > 0 && int(raw.size()) < totalCodewords && !failed; x -= 2) {\n        if (x == 6)\n            --x;\n        for (int row = 0; row < dim && int(raw.size()) < totalCodewords && !failed; ++row) {\n            const int y = readingUp ? dim - 1 - row : row;\n            for (int col = 0; col < 2 && int(raw.size()) < totalCodewords; ++col) {\n                const int xx = x - col;\n                if (functionPattern.get(xx, y))\n                    continue;\n                const int threshold = turboThreshold(levels, xx, y, dim);\n                const PointF p = cache.samples[size_t(y) * dim + xx];\n                const int lum = turboLum(yPlane, width, height, stride, p, dx, dy);\n                if (lum < 0) { failed = true; break; }\n                const bool black = lum <= threshold;\n                const bool bit = QRCode::GetDataMaskBit(4, xx, y) != black;\n                currentByte = uint8_t((currentByte << 1) | uint8_t(bit));\n                if (++bitsRead % 8 == 0) {\n                    raw.push_back(currentByte);\n                    currentByte = 0;\n                }\n            }\n        }\n        readingUp = !readingUp;\n    }\n    metrics.sampleMs += guidedNowMs() - sampleStarted;\n    if (failed || int(raw.size()) != totalCodewords)\n        return {};'''
new = '''    const auto& plan = turboCodewordPlan(dim);\n    if (plan.size() != size_t(totalCodewords) * 8)\n        return {};\n    const double sampleStarted = guidedNowMs();\n    ByteArray raw;\n    raw.reserve(totalCodewords);\n    uint8_t currentByte = 0;\n    bool failed = false;\n    for (size_t bitIndex = 0; bitIndex < plan.size(); ++bitIndex) {\n        const uint32_t entry = plan[bitIndex];\n        const int xx = int(entry & 0xff);\n        const int y = int((entry >> 8) & 0xff);\n        const bool mask = ((entry >> 16) & 1) != 0;\n        const int threshold = turboThreshold(levels, xx, y, dim);\n        const PointF p = cache.samples[size_t(y) * dim + xx];\n        const int lum = turboLum(yPlane, width, height, stride, p, dx, dy);\n        if (lum < 0) { failed = true; break; }\n        const bool black = lum <= threshold;\n        currentByte = uint8_t((currentByte << 1) | uint8_t(mask != black));\n        if ((bitIndex & 7) == 7) {\n            raw.push_back(currentByte);\n            currentByte = 0;\n        }\n    }\n    metrics.sampleMs += guidedNowMs() - sampleStarted;\n    if (failed || int(raw.size()) != totalCodewords)\n        return {};'''
if old not in s: raise SystemExit("Stable-RS traversal block missing")
s = s.replace(old, new, 1)

# Turbo returns valid bytes but only predicted geometry. Never masquerade that
# prediction as a fresh finder/alignment observation.
s = s.replace('result.status = DECIMEN_TRACK_OK;\n            result.bytesOffset = outputUsed;',
              'result.status = DECIMEN_TRACK_PREDICTED;\n            result.bytesOffset = outputUsed;', 1)

# In promoted Stable-RS mode the projective/direct wall refinement is unused.
# Avoid ~thousands of bilinear finder samples per job just to discard the result.
old = '''        float wallCorrectionX = 0, wallCorrectionY = 0;\n        for (int i = 0; i < trackCount; ++i) {\n            auto* cache = guidedTurboTrack(tracks[i].id);\n            if (!cache || !cache->seeded || !turboAllowed(i))\n                continue;\n            float dx = 0, dy = 0, residual = 0;\n            if (!turboPose(*cache, tracks[i], dx, dy, residual))\n                continue;\n            const auto frameTransform = turboFrameTransform(*cache, tracks[i]);\n            if (!frameTransform.isValid())\n                continue;\n            // The projective frame warp carries current translation/scale/perspective.\n            // Search only the small residual left by lattice/worker latency.\n            const PointF refined = turboRefineWallOffset(*cache, tracks[i], frameTransform,\n                                                          yPlane, width, height, stride, 0, 0);\n            wallCorrectionX = refined.x;\n            wallCorrectionY = refined.y;\n            break;\n        }'''
new = '''        float wallCorrectionX = 0, wallCorrectionY = 0;\n        if (!turboAdaptive.promoted || !turboAdaptive.rsMode) {\n            for (int i = 0; i < trackCount; ++i) {\n                auto* cache = guidedTurboTrack(tracks[i].id);\n                if (!cache || !cache->seeded || !turboAllowed(i))\n                    continue;\n                float dx = 0, dy = 0, residual = 0;\n                if (!turboPose(*cache, tracks[i], dx, dy, residual))\n                    continue;\n                const auto frameTransform = turboFrameTransform(*cache, tracks[i]);\n                if (!frameTransform.isValid())\n                    continue;\n                const PointF refined = turboRefineWallOffset(*cache, tracks[i], frameTransform,\n                                                              yPlane, width, height, stride, 0, 0);\n                wallCorrectionX = refined.x;\n                wallCorrectionY = refined.y;\n                break;\n            }\n        }'''
if old not in s: raise SystemExit("wall correction block missing")
s = s.replace(old, new, 1)

# When a distortion-aware rigid canary exists, measure Stable-RS directly. The
# low-yield data-only pass was just extra sampling before the decoder we wanted
# to evaluate. Direct probation remains for non-rigid/projective motion.
s = s.replace(
'''            const bool directMode = !turboAdaptive.promoted || !turboAdaptive.rsMode;''',
'''            const bool stableProbation = !turboAdaptive.promoted && stableEligible && cache->distortionAware;\n            const bool directMode = turboAdaptive.promoted ? !turboAdaptive.rsMode : !stableProbation;''', 1)

# Stable sampling offset is seed->live pose + residual. The *reported* quad is
# already the live track, so add only the residual. v201-v205 added pose twice,
# feeding false motion back into the lattice.
s = s.replace('success = commitTurbo(i, decoded, dx, dy);\n                    if (success)\n                        ++metrics->stableRsSuccesses;',
              'success = commitTurbo(i, decoded, stableResidualX, stableResidualY);\n                    if (success)\n                        ++metrics->stableRsSuccesses;', 1)

# Replace adaptive accounting/promotion. Stable canaries now have their own
# denominator, can promote early at 3/4, and no failure path destroys maps.
pattern = r'''            if \(!turboAdaptive\.promoted\) \{.*?\n            \} else \{.*?\n            \}\n        \}\n\n        // A clean high-resolution frame'''
replacement = '''            if (!turboAdaptive.promoted) {\n                ++turboAdaptive.canaryAttempts;\n                turboAdaptive.canarySuccesses += int(success);\n                turboAdaptive.canaryDirectSuccesses += int(directSuccess);\n                if (stableRsAttempted) {\n                    ++turboAdaptive.canaryStableAttempts;\n                    turboAdaptive.canaryStableSuccesses += int(success);\n                }\n\n                const bool directEarly = turboAdaptive.canaryAttempts >= 4 &&\n                                         turboAdaptive.canaryDirectSuccesses == turboAdaptive.canaryAttempts;\n                const bool stableEarly = turboAdaptive.canaryStableAttempts >= 4 &&\n                                         turboAdaptive.canaryStableSuccesses * 4 >=\n                                         turboAdaptive.canaryStableAttempts * 3;\n                bool promoteDirect = directEarly;\n                bool promoteStable = stableEarly;\n                if (!promoteDirect && !promoteStable && turboAdaptive.canaryAttempts >= 8) {\n                    promoteDirect = turboAdaptive.canaryDirectSuccesses * 4 >=\n                                    turboAdaptive.canaryAttempts * 3;\n                    promoteStable = turboAdaptive.canaryStableAttempts >= 6 &&\n                                    turboAdaptive.canaryStableSuccesses * 2 >=\n                                    turboAdaptive.canaryStableAttempts;\n                }\n                if (promoteDirect || promoteStable) {\n                    turboAdaptive.promoted = true;\n                    turboAdaptive.rsMode = promoteStable && !promoteDirect;\n                    turboAdaptive.canaryAttempts = 0;\n                    turboAdaptive.canarySuccesses = 0;\n                    turboAdaptive.canaryDirectSuccesses = 0;\n                    turboAdaptive.canaryStableAttempts = 0;\n                    turboAdaptive.canaryStableSuccesses = 0;\n                    turboAdaptive.promotedAttempts = 0;\n                    turboAdaptive.promotedSuccesses = 0;\n                } else if (turboAdaptive.canaryAttempts >= 10) {\n                    pauseTurbo(false);\n                }\n            } else {\n                ++turboAdaptive.promotedAttempts;\n                turboAdaptive.promotedSuccesses += int(success);\n                const int evaluationWindow = turboAdaptive.rsMode ? 72 : 36;\n                if (turboAdaptive.promotedAttempts >= evaluationWindow) {\n                    const bool tooWeak = turboAdaptive.rsMode\n                        ? turboAdaptive.promotedSuccesses * 10 < turboAdaptive.promotedAttempts * 3\n                        : turboAdaptive.promotedSuccesses * 2 < turboAdaptive.promotedAttempts;\n                    if (tooWeak)\n                        pauseTurbo(turboAdaptive.rsMode, turboAdaptive.rsMode ? 4 : GUIDED_TURBO_CANARY_COOLDOWN);\n                    else {\n                        turboAdaptive.promotedAttempts = 0;\n                        turboAdaptive.promotedSuccesses = 0;\n                    }\n                }\n            }\n        }\n\n        // A clean high-resolution frame'''
s, n = re.subn(pattern, replacement, s, count=1, flags=re.S)
if n != 1: raise SystemExit("adaptive promotion block missing")

cpp.write_text(s)

# ---------------------------------------------------------------------------
# Worker JS: understand predicted-vs-measured Guided results and pass that fact
# all the way to the main thread. Also use the corrected aligned ABI size.
# ---------------------------------------------------------------------------
worker = Path("receive/worker.js")
s = worker.read_text()
s = s.replace('const NATIVE_TRACK_OK = 1;\nconst GUIDED_TRACK_BYTES = 40;',
'''const NATIVE_TRACK_OK = 1;\nconst GUIDED_TRACK_PREDICTED = 3;\nconst GUIDED_TRACK_BYTES = 40;''', 1)
old = '''  for (let i = 0; i < count; i++) {\n    const base = i * GUIDED_RESULT_BYTES;\n    if (view.getInt32(base + 4, true) !== NATIVE_TRACK_OK) continue;\n    const outputOffset = view.getInt32(base + 8, true);'''
new = '''  for (let i = 0; i < count; i++) {\n    const base = i * GUIDED_RESULT_BYTES;\n    const status = view.getInt32(base + 4, true);\n    if (status !== NATIVE_TRACK_OK && status !== GUIDED_TRACK_PREDICTED) continue;\n    const outputOffset = view.getInt32(base + 8, true);'''
if old not in s: raise SystemExit("guided result status parse missing")
s = s.replace(old, new, 1)
s = s.replace(
'''      modules,\n      tracked: true,\n      header: packet.header''',
'''      modules,\n      tracked: true,\n      geometryMeasured: status === NATIVE_TRACK_OK,\n      header: packet.header''', 1)
worker.write_text(s)

pool = Path("shared/worker-pool.js")
s = pool.read_text()
s = s.replace(
'''            tracked: symbol.tracked,\n            crc32: symbol.crc32,''',
'''            tracked: symbol.tracked,\n            geometryMeasured: symbol.geometryMeasured !== false,\n            crc32: symbol.crc32,''', 1)
pool.write_text(s)

# ---------------------------------------------------------------------------
# Lattice correctness: predicted Turbo packets keep a proven wall alive but do
# not become observations. Also clear learned local corrections on timeout.
# ---------------------------------------------------------------------------
grid = Path("receive/grid-lattice.js")
s = grid.read_text()
old = '''    this.learnSlotCorrection(detection);\n    return this.snapshot();\n  }\n  learnSlotCorrection(detection) {'''
new = '''    this.learnSlotCorrection(detection);\n    return this.snapshot();\n  }\n  noteValidPacket(at = this.lastHitAt) {\n    if (!this.candidate) return null;\n    this.lastHitAt = at;\n    if (this.locked) this.transition("TRACK", "valid predicted packet kept lattice alive", at);\n    return this.snapshot();\n  }\n  learnSlotCorrection(detection) {'''
if old not in s: raise SystemExit("grid noteValidPacket insertion site missing")
s = s.replace(old, new, 1)
old = '''      this.transition("REACQUIRE", "whole lattice expired without a valid packet", now);\n      this.candidate = void 0;\n      this.observations = [];\n      return null;'''
new = '''      this.transition("REACQUIRE", "whole lattice expired without a valid packet", now);\n      this.candidate = void 0;\n      this.observations = [];\n      this.slotCorrections.clear();\n      return null;'''
if old not in s: raise SystemExit("grid timeout reset missing")
s = s.replace(old, new, 1)
grid.write_text(s)

# ---------------------------------------------------------------------------
# Main thread: only measured geometry may teach the lattice. Harden catastrophic
# coverage recovery against a tiny synchronized display-phase miss burst.
# ---------------------------------------------------------------------------
main = Path("receive/main.js")
s = main.read_text()
s = s.replace(
'''let geometryCoverageHealthy = false;\nlet geometryCoverageCollapseStreak = 0;\nlet geometryCoverageCollapseLastAt = 0;''',
'''let geometryCoverageHealthy = false;\nlet geometryCoverageCollapseStreak = 0;\nlet geometryCoverageCollapseLastAt = 0;\nlet geometryCoverageCollapseStartedAt = 0;''', 1)
s = s.replace(
'''const GEOMETRY_COLLAPSE_STREAK = 4;\nconst GEOMETRY_COLLAPSE_MAX_GAP_MS = 650;''',
'''const GEOMETRY_COLLAPSE_STREAK = 4;\nconst GEOMETRY_COLLAPSE_MAX_GAP_MS = 650;\nconst GEOMETRY_COLLAPSE_MIN_SPAN_MS = 180;''', 1)
# Reset the new span timestamp anywhere the existing collapse timestamp is reset.
s = s.replace('geometryCoverageCollapseLastAt = 0;\n',
              'geometryCoverageCollapseLastAt = 0;\n  geometryCoverageCollapseStartedAt = 0;\n')
# The declaration replacement above gets an unwanted indented assignment if the
# global replacement touched it; normalize that one declaration block.
s = s.replace('let geometryCoverageCollapseLastAt = 0;\n  geometryCoverageCollapseStartedAt = 0;\nlet geometryCoverageCollapseStartedAt = 0;',
              'let geometryCoverageCollapseLastAt = 0;\nlet geometryCoverageCollapseStartedAt = 0;')

old = '''    } else if (geometryCoverageHealthy && coverage <= GEOMETRY_COLLAPSE_BAD_RATIO) {\n      if (now - geometryCoverageCollapseLastAt > GEOMETRY_COLLAPSE_MAX_GAP_MS)\n        geometryCoverageCollapseStreak = 0;\n      geometryCoverageCollapseLastAt = now;\n      geometryCoverageCollapseStreak++;\n      if (geometryCoverageCollapseStreak >= GEOMETRY_COLLAPSE_STREAK) {\n        notePipelineEvent("geometry-coverage-collapse", trackedOutputs);\n        enterGeometryRecovery(`tracked coverage collapsed ${trackedOutputs}/${auditMode.tracks}; fresh acquisition`, now, true);\n      }\n    } else if (coverage > GEOMETRY_COLLAPSE_BAD_RATIO) {'''
new = '''    } else if (geometryCoverageHealthy && coverage <= GEOMETRY_COLLAPSE_BAD_RATIO) {\n      if (now - geometryCoverageCollapseLastAt > GEOMETRY_COLLAPSE_MAX_GAP_MS) {\n        geometryCoverageCollapseStreak = 0;\n        geometryCoverageCollapseStartedAt = now;\n      }\n      if (!geometryCoverageCollapseStreak) geometryCoverageCollapseStartedAt = now;\n      geometryCoverageCollapseLastAt = now;\n      geometryCoverageCollapseStreak++;\n      if (geometryCoverageCollapseStreak >= GEOMETRY_COLLAPSE_STREAK &&\n          now - geometryCoverageCollapseStartedAt >= GEOMETRY_COLLAPSE_MIN_SPAN_MS) {\n        notePipelineEvent("geometry-coverage-collapse", trackedOutputs);\n        enterGeometryRecovery(`tracked coverage collapsed ${trackedOutputs}/${auditMode.tracks}; fresh acquisition`, now, true);\n      }\n    } else if (coverage > GEOMETRY_COLLAPSE_BAD_RATIO) {'''
if old not in s: raise SystemExit("geometry coverage collapse block missing")
s = s.replace(old, new, 1)

old = '''  let decodedRegion;\n  if (!optimizerAttribution && box && validQuadObject(info == null ? void 0 : info.quad) && info.modules) {\n    const priorBenchmarkFrame = activeBenchmarkFrame;\n    if (productionTrace) activeBenchmarkFrame = productionTrace;\n    const snapshot = gridLattice.accept({\n      identity,\n      layoutId: header.layoutId,\n      slotIndex: header.slotIndex,\n      at: info.scanId === void 0 ? decodedAt : (_b = scanCapturedAt.get(info.scanId)) != null ? _b : decodedAt,\n      scanId: (_c = info.scanId) != null ? _c : -1,\n      box,\n      quad: info.quad,\n      modules: info.modules\n    }, receiverFrameWidth, receiverFrameHeight);'''
new = '''  let decodedRegion;\n  if (!optimizerAttribution && box && validQuadObject(info == null ? void 0 : info.quad) && info.modules) {\n    const priorBenchmarkFrame = activeBenchmarkFrame;\n    if (productionTrace) activeBenchmarkFrame = productionTrace;\n    const packetAt = info.scanId === void 0 ? decodedAt : (_b = scanCapturedAt.get(info.scanId)) != null ? _b : decodedAt;\n    const snapshot = info.geometryMeasured === false\n      ? gridLattice.noteValidPacket(packetAt)\n      : gridLattice.accept({\n          identity,\n          layoutId: header.layoutId,\n          slotIndex: header.slotIndex,\n          at: packetAt,\n          scanId: (_c = info.scanId) != null ? _c : -1,\n          box,\n          quad: info.quad,\n          modules: info.modules\n        }, receiverFrameWidth, receiverFrameHeight);'''
if old not in s: raise SystemExit("onDecoded lattice accept block missing")
s = s.replace(old, new, 1)
main.write_text(s)
