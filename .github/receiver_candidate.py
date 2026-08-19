from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected exactly one match, found {count}: {old[:220]!r}")
    p.write_text(text.replace(old, new, 1))


# ---- Native metrics ABI ----------------------------------------------------
h = "vendor/decimen-codec/source/wrapper/decimen_codec.h"
replace_once(
    h,
    "\tuint32_t erasureRepairAttemptMask;\n\tuint32_t erasureRepairSuccessMask;\n\tuint32_t erasureRepairSuppressedMask;\n};",
    "\tuint32_t erasureRepairAttemptMask;\n"
    "\tuint32_t erasureRepairSuccessMask;\n"
    "\tuint32_t erasureRepairSuppressedMask;\n"
    "\tuint32_t stablePrimaryAttempts;\n"
    "\tuint32_t stablePrimarySuccesses;\n"
    "\tuint32_t stableRobustRetryAttempts;\n"
    "\tuint32_t stableRobustRetrySuccesses;\n"
    "\tuint32_t stableLocalRetryAttempts;\n"
    "\tuint32_t stableLocalRetrySuccesses;\n"
    "};"
)

cpp = "vendor/decimen-codec/source/wrapper/decimen_codec.cpp"
replace_once(
    cpp,
    "static_assert(sizeof(DecimenGuidedMetrics) == 208,\n              \"DecimenGuidedMetrics JS ABI must allocate 208 bytes\");",
    "static_assert(sizeof(DecimenGuidedMetrics) == 232,\n"
    "              \"DecimenGuidedMetrics JS ABI must allocate 232 bytes\");"
)
replace_once(
    cpp,
    "static_assert(offsetof(DecimenGuidedMetrics, stableEligibleTracks) == 152,\n              \"DecimenGuidedMetrics stableEligibleTracks JS offset changed\");",
    "static_assert(offsetof(DecimenGuidedMetrics, stableEligibleTracks) == 152,\n"
    "              \"DecimenGuidedMetrics stableEligibleTracks JS offset changed\");\n"
    "static_assert(offsetof(DecimenGuidedMetrics, stablePrimaryAttempts) == 204,\n"
    "              \"DecimenGuidedMetrics stablePrimaryAttempts JS offset changed\");\n"
    "static_assert(offsetof(DecimenGuidedMetrics, stableLocalRetrySuccesses) == 224,\n"
    "              \"DecimenGuidedMetrics stableLocalRetrySuccesses JS offset changed\");"
)

# Local-residual retry lane.
replace_once(
    cpp,
    "                            ++metrics->sampleAttempts;\n                            ++metrics->stableRsAttempts;\n                            bool localRsUsed = false;",
    "                            ++metrics->sampleAttempts;\n"
    "                            ++metrics->stableRsAttempts;\n"
    "                            ++metrics->stableLocalRetryAttempts;\n"
    "                            bool localRsUsed = false;"
)
replace_once(
    cpp,
    "                            if (localRepairSuccess && trackBit) metrics->erasureRepairSuccessMask |= trackBit;\n                            return commitTurbo(i, localDecoded, refined->x, refined->y);",
    "                            if (localRepairSuccess && trackBit) metrics->erasureRepairSuccessMask |= trackBit;\n"
    "                            const bool localSuccess = commitTurbo(i, localDecoded, refined->x, refined->y);\n"
    "                            if (localSuccess) ++metrics->stableLocalRetrySuccesses;\n"
    "                            return localSuccess;"
)

# Primary Stable-RS lane.
replace_once(
    cpp,
    "                                stableRsAttempted = true;\n                                ++metrics->sampleAttempts;\n                                ++metrics->stableRsAttempts;\n                                bool rsUsed = false;",
    "                                stableRsAttempted = true;\n"
    "                                ++metrics->sampleAttempts;\n"
    "                                ++metrics->stableRsAttempts;\n"
    "                                ++metrics->stablePrimaryAttempts;\n"
    "                                bool rsUsed = false;"
)
replace_once(
    cpp,
    "                                if (repairSuccess && trackBit) metrics->erasureRepairSuccessMask |= trackBit;\n                                success = commitTurbo(i, decoded, wallCorrectionX, wallCorrectionY);\n                                const bool robustRetryWorthwhile",
    "                                if (repairSuccess && trackBit) metrics->erasureRepairSuccessMask |= trackBit;\n"
    "                                success = commitTurbo(i, decoded, wallCorrectionX, wallCorrectionY);\n"
    "                                if (success) ++metrics->stablePrimarySuccesses;\n"
    "                                const bool robustRetryWorthwhile"
)

# Robust center->full-sampler retry lane.
replace_once(
    cpp,
    "                                    ++metrics->sampleAttempts;\n                                    ++metrics->stableRsAttempts;\n                                    bool robustRsUsed = false;",
    "                                    ++metrics->sampleAttempts;\n"
    "                                    ++metrics->stableRsAttempts;\n"
    "                                    ++metrics->stableRobustRetryAttempts;\n"
    "                                    bool robustRsUsed = false;"
)
replace_once(
    cpp,
    "                                    if (robustRepairSuccess && trackBit) metrics->erasureRepairSuccessMask |= trackBit;\n                                    success = commitTurbo(i, decoded, wallCorrectionX, wallCorrectionY);",
    "                                    if (robustRepairSuccess && trackBit) metrics->erasureRepairSuccessMask |= trackBit;\n"
    "                                    success = commitTurbo(i, decoded, wallCorrectionX, wallCorrectionY);\n"
    "                                    if (success) ++metrics->stableRobustRetrySuccesses;"
)

# ---- JS ABI reader ---------------------------------------------------------
worker = "receive/worker.js"
replace_once(worker, "const GUIDED_METRICS_BYTES = 208;", "const GUIDED_METRICS_BYTES = 232;")
replace_once(
    worker,
    "    erasureRepairAttemptMask: metricsView.getUint32(192, true),\n"
    "    erasureRepairSuccessMask: metricsView.getUint32(196, true),\n"
    "    erasureRepairSuppressedMask: metricsView.getUint32(200, true)\n",
    "    erasureRepairAttemptMask: metricsView.getUint32(192, true),\n"
    "    erasureRepairSuccessMask: metricsView.getUint32(196, true),\n"
    "    erasureRepairSuppressedMask: metricsView.getUint32(200, true),\n"
    "    stablePrimaryAttempts: metricsView.getUint32(204, true),\n"
    "    stablePrimarySuccesses: metricsView.getUint32(208, true),\n"
    "    stableRobustRetryAttempts: metricsView.getUint32(212, true),\n"
    "    stableRobustRetrySuccesses: metricsView.getUint32(216, true),\n"
    "    stableLocalRetryAttempts: metricsView.getUint32(220, true),\n"
    "    stableLocalRetrySuccesses: metricsView.getUint32(224, true)\n"
)

# ---- Receiver live + replay diagnostics ----------------------------------
main = "receive/main.js"
replace_once(
    main,
    "  guidedStableRsAttempts: 0,\n  guidedStableRsSuccesses: 0,\n  guidedStableEligibleTracks: 0,",
    "  guidedStableRsAttempts: 0,\n"
    "  guidedStableRsSuccesses: 0,\n"
    "  guidedStablePrimaryAttempts: 0, guidedStablePrimarySuccesses: 0,\n"
    "  guidedStableRobustRetryAttempts: 0, guidedStableRobustRetrySuccesses: 0,\n"
    "  guidedStableLocalRetryAttempts: 0, guidedStableLocalRetrySuccesses: 0,\n"
    "  guidedStableEligibleTracks: 0,"
)
replace_once(
    main,
    "    guidedStableRsAttempts: 0, guidedStableRsSuccesses: 0, guidedStableEligibleTracks: 0,",
    "    guidedStableRsAttempts: 0, guidedStableRsSuccesses: 0,\n"
    "    guidedStablePrimaryAttempts: 0, guidedStablePrimarySuccesses: 0,\n"
    "    guidedStableRobustRetryAttempts: 0, guidedStableRobustRetrySuccesses: 0,\n"
    "    guidedStableLocalRetryAttempts: 0, guidedStableLocalRetrySuccesses: 0,\n"
    "    guidedStableEligibleTracks: 0,"
)
replace_once(
    main,
    "      livePipeline.guidedStableRsAttempts += Math.max(0, Number(guided.stableRsAttempts) || 0);\n"
    "      livePipeline.guidedStableRsSuccesses += Math.max(0, Number(guided.stableRsSuccesses) || 0);\n"
    "      livePipeline.guidedStableEligibleTracks += Math.max(0, Number(guided.stableEligibleTracks) || 0);",
    "      livePipeline.guidedStableRsAttempts += Math.max(0, Number(guided.stableRsAttempts) || 0);\n"
    "      livePipeline.guidedStableRsSuccesses += Math.max(0, Number(guided.stableRsSuccesses) || 0);\n"
    "      livePipeline.guidedStablePrimaryAttempts += Math.max(0, Number(guided.stablePrimaryAttempts) || 0);\n"
    "      livePipeline.guidedStablePrimarySuccesses += Math.max(0, Number(guided.stablePrimarySuccesses) || 0);\n"
    "      livePipeline.guidedStableRobustRetryAttempts += Math.max(0, Number(guided.stableRobustRetryAttempts) || 0);\n"
    "      livePipeline.guidedStableRobustRetrySuccesses += Math.max(0, Number(guided.stableRobustRetrySuccesses) || 0);\n"
    "      livePipeline.guidedStableLocalRetryAttempts += Math.max(0, Number(guided.stableLocalRetryAttempts) || 0);\n"
    "      livePipeline.guidedStableLocalRetrySuccesses += Math.max(0, Number(guided.stableLocalRetrySuccesses) || 0);\n"
    "      livePipeline.guidedStableEligibleTracks += Math.max(0, Number(guided.stableEligibleTracks) || 0);"
)
replace_once(
    main,
    "    stableRsAttempts: sumGuided(\"stableRsAttempts\"),\n    stableRsSuccesses: sumGuided(\"stableRsSuccesses\"),\n    sparseProfileAttempts:",
    "    stableRsAttempts: sumGuided(\"stableRsAttempts\"),\n"
    "    stableRsSuccesses: sumGuided(\"stableRsSuccesses\"),\n"
    "    stablePrimaryAttempts: sumGuided(\"stablePrimaryAttempts\"),\n"
    "    stablePrimarySuccesses: sumGuided(\"stablePrimarySuccesses\"),\n"
    "    stableRobustRetryAttempts: sumGuided(\"stableRobustRetryAttempts\"),\n"
    "    stableRobustRetrySuccesses: sumGuided(\"stableRobustRetrySuccesses\"),\n"
    "    stableLocalRetryAttempts: sumGuided(\"stableLocalRetryAttempts\"),\n"
    "    stableLocalRetrySuccesses: sumGuided(\"stableLocalRetrySuccesses\"),\n"
    "    sparseProfileAttempts:"
)
replace_once(
    main,
    " · stableRS ${livePipeline.guidedStableRsSuccesses}/${livePipeline.guidedStableRsAttempts} · stable ${livePipeline.guidedStableEligibleTracks}",
    " · stableRS ${livePipeline.guidedStableRsSuccesses}/${livePipeline.guidedStableRsAttempts}"
    " [primary ${livePipeline.guidedStablePrimarySuccesses}/${livePipeline.guidedStablePrimaryAttempts}"
    " · robust ${livePipeline.guidedStableRobustRetrySuccesses}/${livePipeline.guidedStableRobustRetryAttempts}"
    " · local ${livePipeline.guidedStableLocalRetrySuccesses}/${livePipeline.guidedStableLocalRetryAttempts}]"
    " · stable ${livePipeline.guidedStableEligibleTracks}"
)

# Version/cache busts.
replace_once(main, 'const RECEIVER_RUNTIME_BUILD = "v0.5.331";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.332";')
replace_once("send/main.js", 'const SEND_RUNTIME_BUILD = "v0.5.331";', 'const SEND_RUNTIME_BUILD = "v0.5.332";')
replace_once("main.js", 'const APP_BUILD = "v0.5.331";', 'const APP_BUILD = "v0.5.332";')
replace_once("index.html", '<span class="app-version">v0.5.331</span>', '<span class="app-version">v0.5.332</span>')
replace_once("index.html", './main.js?build=v0.5.331', './main.js?build=v0.5.332')
replace_once("sw.js", 'const CACHE = "airgapper-static-js-v279";', 'const CACHE = "airgapper-static-js-v280";')

print("staged v0.5.332: split Stable-RS primary/robust/local retry metrics")
