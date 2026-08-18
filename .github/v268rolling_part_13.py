lectedTracksPerFrameLimit()) ? `manual ${selectedTracksPerFrameLimit()}` : `auto ${lastTrackBudgetSelected || "—"}/${lastTrackBudgetCandidates || "—"} ${autoTrackBudgetReason}`} · budget drops ${trackBudgetDroppedTracks} · probes ${trackBudgetProbeTracks} · band avoids ${trackBudgetTemporalAvoided} · salvage ${lastGuidedRepairAllowed}/${lastGuidedRepairCandidates} · fences ${guidedRepairTemporalFences} seam/${guidedRepairPressureFences} CPU · avg job ${averageJobMs.toFixed(1)}ms · robust ${averageRobustSearchMs.toFixed(1)}ms/${averageRobustBands.toFixed(1)} bands · guided ${averageGuidedMs.toFixed(1)}ms · native ${averageNativeMs.toFixed(1)}ms · copy ${averageCopyMs.toFixed(1)}ms`,'''
)
replace(
    "receive/main.js",
    '''    decoder ? `Framing  ${transportSourceBytes} source + ${transportMetadataBytes} metadata = ${transportFrameBytes} QR bytes · ${(transportMetadataBytes / Math.max(1, transportFrameBytes) * 100).toFixed(2)}% metadata` : "",''',
    '''    (() => {\n      const band = predictedTemporalBand(Math.max(temporalBandLastSource, 0) + 1, perfNow);\n      return band ? `Rolling  ${band.axis === "r" ? "row" : "col"} ${band.position.toFixed(2)}/${band.span} · width ${band.width.toFixed(2)} · velocity ${band.velocity >= 0 ? "+" : ""}${band.velocity.toFixed(2)} slots/frame · confidence ${(band.confidence * 100).toFixed(0)}%` : "Rolling  —";\n    })(),\n    decoder ? `Framing  ${transportSourceBytes} source + ${transportMetadataBytes} metadata = ${transportFrameBytes} QR bytes · ${(transportMetadataBytes / Math.max(1, transportFrameBytes) * 100).toFixed(2)}% metadata` : "",'''
)
replace(
    "receive/main.js",
    ''' · erasure ${lastGuidedMetrics.erasureRsSuccesses ?? 0}/${lastGuidedMetrics.erasureRsAttempts ?? 0} repair ${lastGuidedMetrics.erasureRepairCodewords ?? 0} · profile''',
    ''' · erasure ${lastGuidedMetrics.erasureRsSuccesses ?? 0}/${lastGuidedMetrics.erasureRsAttempts ?? 0} repair ${lastGuidedMetrics.erasureRepairCodewords ?? 0} salvage ${countMaskBits(Number(lastGuidedMetrics.erasureRepairSuccessMask) >>> 0)}/${countMaskBits(Number(lastGuidedMetrics.erasureRepairAttemptMask) >>> 0)} suppress ${countMaskBits(Number(lastGuidedMetrics.erasureRepairSuppressedMask) >>> 0)} · profile'''
)
replace(
    "receive/main.js",
    ''' · erasure ${livePipeline.guidedErasureRsSuccesses}/${livePipeline.guidedErasureRsAttempts} repair ${livePipeline.guidedErasureRepairCodewords} · finders''',
    ''' · erasure ${livePipeline.guidedErasureRsSuccesses}/${livePipeline.guidedErasureRsAttempts} repair ${livePipeline.guidedErasureRepairCodewords} salvage ${livePipeline.guidedErasureRepairSuccesses}/${livePipeline.guidedErasureRepairAttempts} suppress ${livePipeline.guidedErasureRepairSuppressed} · finders'''
)
replace(
    "receive/main.js",
    ''' 