from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected exactly one match, found {count}: {old[:140]!r}")
    p.write_text(text.replace(old, new, 1))


cpp = "vendor/decimen-codec/source/wrapper/decimen_codec.cpp"

# The old dense Stable-RS learner was worker-global. A dense wall is not
# homogeneous: edge optics, rolling-shutter phase, and local pose make some
# physical slots excellent cached candidates and others persistent losers.
# Learn the decision independently for each AirGapper slot.
replace_once(
    cpp,
    "struct GuidedStableRsGate\n{\n    uint16_t attempts = 0;\n    uint16_t successes = 0;\n    uint16_t skipped = 0;\n    bool suppressed = false;\n};\n\nstatic GuidedStableRsGate& guidedDenseStableRsGate()\n{\n    static GuidedStableRsGate gate;\n    return gate;\n}",
    "struct GuidedStableRsGate\n{\n    uint16_t attempts = 0;\n    uint16_t successes = 0;\n    uint16_t skipped = 0;\n    int dimension = 0;\n    bool suppressed = false;\n};\n\nstatic GuidedStableRsGate& guidedDenseStableRsGate(int id, int dimension)\n{\n    static std::array<GuidedStableRsGate, 128> gates;\n    static GuidedStableRsGate fallback;\n    auto& gate = id >= 0 && id < int(gates.size()) ? gates[id] : fallback;\n    // A new QR version is a new optical problem. Do not inherit a suppression\n    // decision learned for a different module lattice in the same worker.\n    if (gate.dimension != dimension) {\n        gate = {};\n        gate.dimension = dimension;\n    }\n    return gate;\n}"
)
replace_once(
    cpp,
    "                auto& stableRsGate = guidedDenseStableRsGate();",
    "                auto& stableRsGate = guidedDenseStableRsGate(track.id, track.dimension);"
)

# If repair is fenced, a failed Stable-RS attempt used to be deliberately
# ignored by the adaptive learner. Preserve that protection for genuinely bad
# temporal frames, but remember the failure provisionally: if current-frame
# Sparse then CRC-decodes the same QR, the frame was decodable and the Stable-RS
# miss is valid evidence that this slot should favor Sparse.
replace_once(
    cpp,
    "        std::vector<uint8_t> refreshTurboFromSparse(trackCount, 0);\n        int repairTracksSpent = 0;",
    "        std::vector<uint8_t> refreshTurboFromSparse(trackCount, 0);\n"
    "        std::vector<uint8_t> deferredStableGateFailure(trackCount, 0);\n"
    "        int repairTracksSpent = 0;"
)
replace_once(
    cpp,
    "                                if (success || allowExpensiveRepair)\n                                    guidedNoteDenseStableRs(stableRsGate, stableModuleSize, success);",
    "                                if (success) {\n"
    "                                    guidedNoteDenseStableRs(stableRsGate, stableModuleSize, true);\n"
    "                                } else if (allowExpensiveRepair) {\n"
    "                                    guidedNoteDenseStableRs(stableRsGate, stableModuleSize, false);\n"
    "                                } else if (stableRsAttempted && i >= 0 && i < int(deferredStableGateFailure.size())) {\n"
    "                                    deferredStableGateFailure[i] = 1;\n"
    "                                }"
)

# Confirm deferred failure only when Sparse proves the same current frame was
# actually decodable. This is the key distinction between a chronically losing
# cached slot and a rolling-shutter-corrupted frame where every path should miss.
replace_once(
    cpp,
    "                if (decodedTrack) {\n                    ++metrics->fastDecodeSuccesses;\n                    if (trackBit)\n                        metrics->sparseSuccessMask |= trackBit;\n                }",
    "                if (decodedTrack) {\n"
    "                    ++metrics->fastDecodeSuccesses;\n"
    "                    if (trackBit)\n"
    "                        metrics->sparseSuccessMask |= trackBit;\n"
    "                    if (trackIndex >= 0 && trackIndex < int(deferredStableGateFailure.size()) &&\n"
    "                        deferredStableGateFailure[trackIndex]) {\n"
    "                        auto& stableRsGate = guidedDenseStableRsGate(track.id, track.dimension);\n"
    "                        guidedNoteDenseStableRs(stableRsGate, guidedModuleSize(track), false);\n"
    "                        deferredStableGateFailure[trackIndex] = 0;\n"
    "                    }\n"
    "                }"
)

# A slot already learned as a low-density Stable-RS loser should not be used as
# the shared wall-motion reference either. That avoids paying refinement on a
# chronic edge/phase loser and keeps its residual from steering good slots.
replace_once(
    cpp,
    "            auto* cache = guidedTurboTrack(referenceId);\n            if (!cache || !turboStableWarpEligible(*cache, tracks[i]))\n                continue;",
    "            auto* cache = guidedTurboTrack(referenceId);\n"
    "            if (!cache || !turboStableWarpEligible(*cache, tracks[i]))\n"
    "                continue;\n"
    "            auto& referenceGate = guidedDenseStableRsGate(referenceId, tracks[i].dimension);\n"
    "            if (guidedModuleSize(tracks[i]) <= GUIDED_STABLE_ADAPT_MAX_MODULE && referenceGate.suppressed)\n"
    "                continue;"
)

# Version/cache busts.
replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.314";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.315";')
replace_once("send/main.js", 'const SEND_RUNTIME_BUILD = "v0.5.314";', 'const SEND_RUNTIME_BUILD = "v0.5.315";')
replace_once("main.js", 'const APP_BUILD = "v0.5.314";', 'const APP_BUILD = "v0.5.315";')
replace_once("index.html", '<span class="app-version">v0.5.314</span>', '<span class="app-version">v0.5.315</span>')
replace_once("index.html", './main.js?build=v0.5.314', './main.js?build=v0.5.315')
replace_once("sw.js", 'const CACHE = "airgapper-static-js-v262";', 'const CACHE = "airgapper-static-js-v263";')

print("staged v0.5.315: per-slot Stable-RS learning with Sparse-confirmed failures")
