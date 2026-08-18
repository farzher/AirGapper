 refined->y);'''
)
replace(
    "vendor/decimen-codec/source/wrapper/decimen_codec.cpp",
    '''                            } else {\n                                // Finder evidence still cannot land this map on the\n                                // live QR; let sparse Guided rebuild it in this job.\n                                stableNeedsRefresh = true;\n                            }''',
    '''                            } else if (allowExpensiveRepair) {\n                                // Finder evidence still cannot land this map on the\n                                // live QR; let sparse Guided rebuild it in this job.\n                                stableNeedsRefresh = true;\n                            } else if (trackBit) {\n                                metrics->erasureRepairSuppressedMask |= trackBit;\n                            }'''
)
replace(
    "vendor/decimen-codec/source/wrapper/decimen_codec.cpp",
    '''                                else\n                                    cache->cooldown = std::max<uint8_t>(cache->cooldown, 2);''',
    '''                                else if (allowExpensiveRepair)\n                                    cache->cooldown = std::max<uint8_t>(cache->cooldown, 2);''',
    expected=1
)
replace(
    "vendor/decimen-codec/source/wrapper/decimen_codec.cpp",
    '''                                bool rsUsed = false;\n                                auto decoded = decodeTurboStableRS(*cache, track, frameTransform,\n                                                                   yPlane, width, height, stride,\n                                                                   dx, dy, levels, *metrics,\n                                                                   centerOnlyRs, progressiveRs, &rsUsed);\n                                if (rsUsed)\n                                    ++metrics->sparseRsFallbacks;''',
    '''                                bool rsUsed = false;\n                                bool repairAttempted = false;\n                                bool repairSuccess = false;\n                                auto decoded = decodeTurboStableRS(*cache, track, frameTransform,\n                                                                   yPlane, width, height, stride,\n                                                                   dx, dy, levels, *metrics,\n                                                                   centerOnlyRs, progressiveRs, allowExpensiveRepair,\n                                                                   &rsUsed, &repairAttempted, &repairSuccess);\n                                if (rsUsed)\n                                    ++metrics->sparseRsFallbacks;\n                                if (repairAttempted && trackBit