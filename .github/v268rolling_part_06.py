 (!repairSpentThisTrack) { repairSpentThisTrack = true; ++repairTracksSpent; }\n                                    }\n                                    if (robustRepairSuccess && trackBit) metrics->erasureRepairSuccessMask |= trackBit;'''
)
replace(
    "vendor/decimen-codec/source/wrapper/decimen_codec.cpp",
    '''                                if (!success)\n                                    success = retryLocalResidual();\n                                guidedNoteDenseStableRs(stableRsGate, stableModuleSize, success);''',
    '''                                if (!success && allowExpensiveRepair && !repairSpentThisTrack)\n                                    success = retryLocalResidual();\n                                if (success || allowExpensiveRepair)\n                                    guidedNoteDenseStableRs(stableRsGate, stableModuleSize, success);'''
)
replace(
    "vendor/decimen-codec/source/wrapper/decimen_codec.cpp",
    '''            const bool decoderAttempted = directAttempted || stableRsAttempted;\n            if (success) {''',
    '''            const bool decoderAttempted = directAttempted || stableRsAttempted;\n            cheapAttempted[i] = uint8_t(decoderAttempted);\n            if (repairSpentThisTrack && !success) salvageAllowed[i] = 0;\n            if (success) {'''
)
replace(
    "vendor/decimen-codec/source/wrapper/decimen_codec.cpp",
    '''            } else if (stableRsAttempted) {\n                // A single RS miss can be sender/camera phase noise. Repeated\n                // misses mean the calibrated map is no longer earning its keep;\n                // relearn it from the Guided fallback instead of parking it.\n                cache->stableSuccesses = 0;\n                if (++cache->misses >= 2) {\n                    cache->misses = 0;\n                    cache->cooldown = 0;\n                    cache->distortionAware = false;\n                }''',
    '''            } else if (stableRsAttempted && allowExpensiveRepair) {\n                // A single RS miss can be sender/camera phase noise. Repeated\n                // misses mean the calibrated map is no longer earning its keep;\n                // relearn it from the Guided fallback instead of parking it.\n                // Intentionally suppressed temporal frames never poison this cache.\n                cache->stableSuccesses = 0;\n                if (++cache->misses >= 2) {\n                    cache->misses = 0;\n                    cache->cooldown = 0;\n                    cache->distortionAware = false;\n                }'''
)
replace(
    "vendor/decimen-codec/source/wrapper/decimen_codec.cpp",
    '''        const double binStart = guidedNowMs();\n        ImageView iv(const_cast<uint8_t*>(yPlane), width, height, ImageFormat::Lum,