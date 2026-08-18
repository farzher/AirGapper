region) => slotSchedulingYield(region, now)).sort((a, b) => b - a);''',
    '''const yields = candidates.map((region) => slotSchedulingYield(region, now)).sort((a, b) => b - a);'''
)
replace(
    "receive/main.js",
    '''  const ranked = candidates.map((region) => ({ region, score: slotSchedulingYield(region, now) }))''',
    '''  const ranked = candidates.map((region) => ({ region, score: slotSchedulingYield(region, now, sourceSequence) }))'''
)
replace(
    "receive/main.js",
    '''  const useColumn = columnBand && (!rowBand || missCols.length <= missRows.length);\n  const key = `${useColumn ? "c" : "r"}:${(useColumn ? missCols : missRows).join(",")}`;''',
    '''  const useColumn = columnBand && (!rowBand || missCols.length <= missRows.length);\n  const bandIndices = useColumn ? missCols : missRows;\n  const bandSpan = useColumn ? layout.cols : layout.rows;\n  const key = `${useColumn ? "c" : "r"}:${bandIndices.join(",")}`;'''
)
replace(
    "receive/main.js",
    '''  const transientBand = temporalBandRepeat <= TEMPORAL_BAND_MAX_REPEAT;\n  temporalBandDetections++;\n  const avoidUntil = receiverNow() + TEMPORAL_BAND_AVOID_MS;''',
    '''  const transientBand = temporalBandRepeat <= TEMPORAL_BAND_MAX_REPEAT;\n  temporalBandDetections++;\n  const bandNow = receiverNow();\n  updateTemporalBandModel(useColumn ? "c" : "r", bandIndices, bandSpan, sourceSequence, bandNow);\n  const avoidUntil = bandNow + TEMPORAL_BAND_AVOID_MS;'''
)
replace(
    "receive/main.js",
    '''  const guidedStage = chooseGuidedStage(message);\n  if (guidedStage) message.guidedFallbackMask = guidedFallbackMaskForTracks(message.tracks);''',
    '''  const guidedStage = chooseGuidedStage(message);\n  if (guidedStage) {\n    const fallbackMask = guidedFallbackMaskForTracks(message.tracks);\n    if (gridLattice.locked && !message.full && !message.strictHotPath && !autoOpticsMeasurementSlots?.size) {\n      message.guidedRepairMask = guidedRepairMaskForTracks(message.tracks, message.sourceSequence, receiverNow());\n      // Full SampleQR is also salvage. A seam/pressure-fenced track gets its cheap\n      // Guided attempt but cannot immediately spend the CPU we just denied.\n      message.guidedFallbackMask = (fallbackMask & message.guidedRepairMask) >>> 0;\n    } else {\n      message.guidedRepairMask = 0xffffffff;\n      message.guidedFallbackMask = fallbackMask;\n    }\n  }'''
)
replace(
    "receive/main.js",
    '''      livePipeline.guidedErasureRepairCodewords += Math.max(0, Number(guided.erasureRepairCodewords) || 0);\n      livePipeline.guidedFinderAttempts += Math.max(0, Number(guided.finderAttempts) || 0);''',
    '''      livePipeline.guidedErasureRepairCodewords += Math.max(0, Number(guided.erasureRepairCodewords) || 0);\n      livePipeline.guidedErasureRepairAttempt