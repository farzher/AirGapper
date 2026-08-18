dx, float dy, const TurboLevels& levels,\n                                         DecimenGuidedMetrics& metrics, bool centerOnly = false,\n                                         bool progressive = false, bool* rsUsedOut = nullptr)''',
    '''static DecoderResult decodeTurboStableRS(const GuidedTurboTrack& cache,\n                                         const DecimenGuidedTrack& track,\n                                         const TurboFrameTransform& frameTransform,\n                                         const uint8_t* yPlane, int width, int height, int stride,\n                                         float dx, float dy, const TurboLevels& levels,\n                                         DecimenGuidedMetrics& metrics, bool centerOnly = false,\n                                         bool progressive = false, bool allowRepair = true,\n                                         bool* rsUsedOut = nullptr, bool* repairAttemptedOut = nullptr,\n                                         bool* repairSuccessOut = nullptr)'''
)
replace(
    "vendor/decimen-codec/source/wrapper/decimen_codec.cpp",
    '''{\n    if (rsUsedOut) *rsUsedOut = false;\n    const int dim = track.dimension;''',
    '''{\n    if (rsUsedOut) *rsUsedOut = false;\n    if (repairAttemptedOut) *repairAttemptedOut = false;\n    if (repairSuccessOut) *repairSuccessOut = false;\n    const int dim = track.dimension;''',
    expected=1
)
replace(
    "vendor/decimen-codec/source/wrapper/decimen_codec.cpp",
    '''        std::vector<int> repairOrder;\n        repairOrder.reserve(ambiguousCount);''',
    '''        if (repairAttemptedOut) *repairAttemptedOut = true;\n        if (!allowRepair)\n            return {};\n\n        std::vector<int> repairOrder;\n        repairOrder.reserve(ambiguousCount);'''
)
replace(
    "vendor/decimen-codec/source/wrapper/decimen_codec.cpp",
    '''            if (partialDecoded.isValid() && !partialDecoded.content().bytes.empty() &&\n                hasValidCRC32(partialDecoded.content().bytes))\n                return partialDecoded;''',
    '''            if (partialDecoded.isValid() && !partialDecoded.content().bytes.empty() &&\n                hasValidCRC32(partialDecoded.content().bytes)) {\n                if (repairSuccessOut) *repairSuccessOut = true;\n                return partialDecoded;\n            }'''
)
replace(
    "vendor/decimen-codec/source/wrapper/decimen_codec.cpp",
    '''            metrics.erasureRepairCodewords += uint32_t(repairOrder.size() - partialRepairCount);\n            metrics.sampleMs += guidedNowMs() - remainderSampleStarted;\n        }\n    }\n\n    const double decodeStarted = guidedNowMs();\n    auto decoded = runRs(raw, nullptr);\n    metrics.decodeMs += guidedNowMs() - decodeStarted;\n    return decoded;''',
    ''