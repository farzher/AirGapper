s += countMaskBits(Number(guided.erasureRepairAttemptMask) >>> 0);\n      livePipeline.guidedErasureRepairSuccesses += countMaskBits(Number(guided.erasureRepairSuccessMask) >>> 0);\n      livePipeline.guidedErasureRepairSuppressed += countMaskBits(Number(guided.erasureRepairSuppressedMask) >>> 0);\n      noteGuidedRepairMetrics(guided);\n      livePipeline.guidedFinderAttempts += Math.max(0, Number(guided.finderAttempts) || 0);'''
)
replace(
    "receive/main.js",
    '''  guidedErasureRsAttempts: 0,\n  guidedErasureRsSuccesses: 0,\n  guidedErasureRepairCodewords: 0,\n  guidedJobs: 0,''',
    '''  guidedErasureRsAttempts: 0,\n  guidedErasureRsSuccesses: 0,\n  guidedErasureRepairCodewords: 0,\n  guidedErasureRepairAttempts: 0,\n  guidedErasureRepairSuccesses: 0,\n  guidedErasureRepairSuppressed: 0,\n  guidedJobs: 0,'''
)
replace(
    "receive/main.js",
    '''    guidedErasureRsAttempts: 0, guidedErasureRsSuccesses: 0, guidedErasureRepairCodewords: 0,\n    guidedJobs: 0,''',
    '''    guidedErasureRsAttempts: 0, guidedErasureRsSuccesses: 0, guidedErasureRepairCodewords: 0,\n    guidedErasureRepairAttempts: 0, guidedErasureRepairSuccesses: 0, guidedErasureRepairSuppressed: 0,\n    guidedJobs: 0,'''
)
replace(
    "receive/main.js",
    '''function resetSlotMetrics() {\n  slotAttemptCounts.fill(0);''',
    '''function resetSlotMetrics() {\n  resetTemporalBandModel();\n  slotRepairYield.fill(0.28);\n  slotRepairSamples.fill(0);\n  slotRepairCost.fill(480);\n  lastGuidedRepairAllowed = 0;\n  lastGuidedRepairCandidates = 0;\n  guidedRepairPressureFences = 0;\n  guidedRepairTemporalFences = 0;\n  slotAttemptCounts.fill(0);'''
)
replace(
    "receive/main.js",
    '''    `Pressure worker-busy ${workerBusyEventRate.toFixed(1)}/s · latest replacements ${(pendingLaneReplaceTimes.length / (STATS_WINDOW_MS / 1e3)).toFixed(1)}/s · repeat skips ${repeatSkipRate.toFixed(1)}/s · crop recenters ${laneCropRecentersTotal} · tracks ${Number.isFinite(selectedTracksPerFrameLimit()) ? `manual ${selectedTracksPerFrameLimit()}` : `auto ${lastTrackBudgetSelected || "—"}/${lastTrackBudgetCandidates || "—"} ${autoTrackBudgetReason}`} · budget drops ${trackBudgetDroppedTracks} · probes ${trackBudgetProbeTracks} · band avoids ${trackBudgetTemporalAvoided} · avg job ${averageJobMs.toFixed(1)}ms · robust ${averageRobustSearchMs.toFixed(1)}ms/${averageRobustBands.toFixed(1)} bands · guided ${averageGuidedMs.toFixed(1)}ms · native ${averageNativeMs.toFixed(1)}ms · copy ${averageCopyMs.toFixed(1)}ms`,''',
    '''    `Pressure worker-busy ${workerBusyEventRate.toFixed(1)}/s · latest replacements ${(pendingLaneReplaceTimes.length / (STATS_WINDOW_MS / 1e3)).toFixed(1)}/s · repeat skips ${repeatSkipRate.toFixed(1)}/s · crop recenters ${laneCropRecentersTotal} · tracks ${Number.isFinite(se