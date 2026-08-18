'            metrics.erasureRepairCodewords += uint32_t(repairOrder.size() - partialRepairCount);\n            metrics.sampleMs += guidedNowMs() - remainderSampleStarted;\n        }\n    }\n\n    const double decodeStarted = guidedNowMs();\n    auto decoded = runRs(raw, nullptr);\n    metrics.decodeMs += guidedNowMs() - decodeStarted;\n    if (repairSuccessOut && repairAttemptedOut && *repairAttemptedOut &&\n        decoded.isValid() && !decoded.content().bytes.empty() && hasValidCRC32(decoded.content().bytes))\n        *repairSuccessOut = true;\n    return decoded;'''
)
replace(
    "vendor/decimen-codec/source/wrapper/decimen_codec.cpp",
    '''                                   uint8_t* output, int outputCapacity, int maxSymbols,\n                                   uint32_t fallbackAllowedMask, DecimenGuidedMetrics* metrics)''',
    '''                                   uint8_t* output, int outputCapacity, int maxSymbols,\n                                   uint32_t fallbackAllowedMask, uint32_t repairAllowedMask,\n                                   DecimenGuidedMetrics* metrics)'''
)
replace(
    "vendor/decimen-codec/source/wrapper/decimen_codec.cpp",
    '''        std::vector<uint8_t> completed(trackCount, 0);''',
    '''        std::vector<uint8_t> completed(trackCount, 0);\n        std::vector<uint8_t> cheapAttempted(trackCount, 0);\n        std::vector<uint8_t> salvageAllowed(trackCount, 1);\n        int repairTracksSpent = 0;\n        constexpr int GUIDED_MAX_REPAIR_TRACKS_PER_BATCH = 2;'''
)
replace(
    "vendor/decimen-codec/source/wrapper/decimen_codec.cpp",
    '''            auto* cache = guidedTurboTrack(tracks[i].id);\n            if (!cache || !turboStableWarpEligible(*cache, tracks[i]))''',
    '''            const int referenceId = tracks[i].id;\n            const uint32_t referenceBit = referenceId >= 0 && referenceId < 32 ? (uint32_t(1) << referenceId) : 0;\n            if (referenceBit && (repairAllowedMask & referenceBit) == 0)\n                continue;\n            auto* cache = guidedTurboTrack(referenceId);\n            if (!cache || !turboStableWarpEligible(*cache, tracks[i]))''',
    expected=1
)
replace(
    "vendor/decimen-codec/source/wrapper/decimen_codec.cpp",
    '''        for (int i = 0; i < trackCount; ++i) {\n            const auto& track = tracks[i];\n            auto* cache = guidedTurboTrack(track.id);''',
    '''        for (int i = 0; i < trackCount; ++i) {\n            const auto& track = tracks[i];\n            const uint32_t trackBit = track.id >= 0 && track.id < 32 ? (uint32_t(1) << track.id) : 0;\n            const bool repairMaskAllowed = !trackBit || (repairAllowedMask & trackBit) != 0;\n            const bool allowExpensiveRepair = repairMaskAllowed && repairTracksSpent < GUIDED_MAX_REPAIR_TRACKS_