from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected exactly one match, found {count}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))

# --- Native Guided/Turbo: refresh a cached distortion map when that cached
# path loses but the current-frame Sparse path subsequently proves the QR by CRC.
cpp = "vendor/decimen-codec/source/wrapper/decimen_codec.cpp"
replace_once(
    cpp,
    "        std::vector<uint8_t> completed(trackCount, 0);\n        int repairTracksSpent = 0;",
    "        std::vector<uint8_t> completed(trackCount, 0);\n"
    "        // A CRC-valid current-frame Sparse result is authoritative evidence\n"
    "        // that a failed cached Stable-RS map should be replaced. Keep this\n"
    "        // batch-local request separate from the expensive-repair fence: a\n"
    "        // temporal/CPU fence must stop repair work, not prevent a successful\n"
    "        // fallback we already paid for from healing the cache for next frame.\n"
    "        std::vector<uint8_t> refreshTurboFromSparse(trackCount, 0);\n"
    "        int repairTracksSpent = 0;"
)
replace_once(
    cpp,
    "                        if (!levels.ok) {\n                            success = retryLocalResidual();",
    "                        if (!levels.ok) {\n"
    "                            // Finder/threshold evidence cannot land the cached\n"
    "                            // map on this live QR. If Sparse succeeds later in\n"
    "                            // this same batch, capture its fresh distortion map.\n"
    "                            refreshTurboFromSparse[i] = 1;\n"
    "                            success = retryLocalResidual();"
)
replace_once(
    cpp,
    "            metrics->fastDecodeMs += guidedNowMs() - turboStarted;\n            const bool decoderAttempted = directAttempted || stableRsAttempted;",
    "            if (!success && stableEligible && stableRsAttempted)\n"
    "                refreshTurboFromSparse[i] = 1;\n"
    "            metrics->fastDecodeMs += guidedNowMs() - turboStarted;\n"
    "            const bool decoderAttempted = directAttempted || stableRsAttempted;"
)
replace_once(
    cpp,
    "                std::vector<PointF> sparseMap;\n                auto* mapOut = turboSeedEligible(track) ? &sparseMap : nullptr;\n                GuidedSparseFastResult fast;",
    "                std::vector<PointF> sparseMap;\n"
    "                const bool refreshTurboMap = turboSeedEligible(track) ||\n"
    "                    (trackIndex >= 0 && trackIndex < int(refreshTurboFromSparse.size()) &&\n"
    "                     refreshTurboFromSparse[trackIndex]);\n"
    "                auto* mapOut = refreshTurboMap ? &sparseMap : nullptr;\n"
    "                GuidedSparseFastResult fast;"
)

# --- Receiver: measure temporal prediction quality on the exact submitted
# slots, and let Auto recover toward an all-slots optimum faster when its cost
# model says there is no benefit to capping the wall.
main = "receive/main.js"
replace_once(main, 'const RECEIVER_RUNTIME_BUILD = "v0.5.313";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.314";')
replace_once(
    main,
    "const TEMPORAL_MODEL_RISK_THRESHOLD = 0.34;\nconst TEMPORAL_MODEL_OVERLAY_THRESHOLD = 0.18;\nconst GUIDED_REPAIR_PRESSURE_LIMIT = 1;",
    "const TEMPORAL_MODEL_RISK_THRESHOLD = 0.34;\n"
    "const TEMPORAL_MODEL_OVERLAY_THRESHOLD = 0.18;\n"
    "let temporalPredictionFrames = 0;\n"
    "let temporalPredictionRiskAttempts = 0;\n"
    "let temporalPredictionRiskMisses = 0;\n"
    "let temporalPredictionSafeAttempts = 0;\n"
    "let temporalPredictionSafeMisses = 0;\n"
    "const GUIDED_REPAIR_PRESSURE_LIMIT = 1;"
)
replace_once(
    main,
    "  return Math.max(risk, Math.min(1, modeled));\n}\nfunction countMaskBits(mask) {",
    "  return Math.max(risk, Math.min(1, modeled));\n"
    "}\n"
    "function temporalPredictionSnapshot(trackSlots, sourceSequence, now = receiverNow()) {\n"
    "  const model = predictedTemporalBand(sourceSequence, now);\n"
    "  if (!model || model.confidence < 0.08) return null;\n"
    "  const slots = [...new Set((trackSlots ?? []).map(Number).filter((slot) =>\n"
    "    Number.isInteger(slot) && slot >= 0 && slot < SLOT_METRIC_COUNT\n"
    "  ))];\n"
    "  if (!slots.length) return null;\n"
    "  return slots.map((slot) => [slot, temporalBandRiskForSlot(slot, sourceSequence, now)]);\n"
    "}\n"
    "function noteTemporalPredictionOutcome(prediction, outputSlots) {\n"
    "  if (!Array.isArray(prediction) || !prediction.length) return;\n"
    "  temporalPredictionFrames++;\n"
    "  for (const [slotRaw, riskRaw] of prediction) {\n"
    "    const slot = Number(slotRaw);\n"
    "    const risk = Math.max(0, Math.min(1, Number(riskRaw) || 0));\n"
    "    const missed = !outputSlots.has(slot);\n"
    "    if (risk >= TEMPORAL_MODEL_RISK_THRESHOLD) {\n"
    "      temporalPredictionRiskAttempts++;\n"
    "      temporalPredictionRiskMisses += Number(missed);\n"
    "    } else {\n"
    "      temporalPredictionSafeAttempts++;\n"
    "      temporalPredictionSafeMisses += Number(missed);\n"
    "    }\n"
    "  }\n"
    "}\n"
    "function resetTemporalPredictionValidation() {\n"
    "  temporalPredictionFrames = 0;\n"
    "  temporalPredictionRiskAttempts = 0;\n"
    "  temporalPredictionRiskMisses = 0;\n"
    "  temporalPredictionSafeAttempts = 0;\n"
    "  temporalPredictionSafeMisses = 0;\n"
    "}\n"
    "function temporalPredictionSummary() {\n"
    "  const riskAttempts = temporalPredictionRiskAttempts;\n"
    "  const safeAttempts = temporalPredictionSafeAttempts;\n"
    "  const misses = temporalPredictionRiskMisses + temporalPredictionSafeMisses;\n"
    "  if (!temporalPredictionFrames || !(riskAttempts + safeAttempts))\n"
    "    return \"Temporal prediction waiting for a learned band\";\n"
    "  const riskMiss = riskAttempts ? temporalPredictionRiskMisses / riskAttempts : 0;\n"
    "  const safeMiss = safeAttempts ? temporalPredictionSafeMisses / safeAttempts : 0;\n"
    "  const recall = misses ? temporalPredictionRiskMisses / misses : 0;\n"
    "  const coverage = riskAttempts / Math.max(1, riskAttempts + safeAttempts);\n"
    "  return `Temporal predicted-risk miss ${(riskMiss * 100).toFixed(0)}% (${temporalPredictionRiskMisses}/${riskAttempts}) · safe miss ${(safeMiss * 100).toFixed(1)}% (${temporalPredictionSafeMisses}/${safeAttempts}) · miss recall ${(recall * 100).toFixed(0)}% · risk coverage ${(coverage * 100).toFixed(0)}% · ${temporalPredictionFrames} frames`;\n"
    "}\n"
    "function countMaskBits(mask) {"
)
replace_once(
    main,
    "    if (bestCount < autoTrackBudgetTarget) autoTrackBudgetTarget = Math.max(bestCount, autoTrackBudgetTarget - 4);\n    else if (bestCount > autoTrackBudgetTarget) autoTrackBudgetTarget = Math.min(bestCount, autoTrackBudgetTarget + 2);",
    "    if (bestCount < autoTrackBudgetTarget) autoTrackBudgetTarget = Math.max(bestCount, autoTrackBudgetTarget - 4);\n"
    "    else if (bestCount > autoTrackBudgetTarget) {\n"
    "      // If the measured optimum is the whole wall, recover quickly from a\n"
    "      // transient pressure cut. Partial optima still ramp cautiously so a\n"
    "      // noisy cost estimate cannot immediately flood the workers again.\n"
    "      const rise = bestCount === count ? 4 : 2;\n"
    "      autoTrackBudgetTarget = Math.min(bestCount, autoTrackBudgetTarget + rise);\n"
    "    }"
)
replace_once(
    main,
    "      const slotResults = [...submittedSlots].map((slot) => [slot, outputSlots.has(slot) ? 1 : 0]);\n      const attributedOutputs = submittedSlots.size",
    "      const slotResults = [...submittedSlots].map((slot) => [slot, outputSlots.has(slot) ? 1 : 0]);\n"
    "      noteTemporalPredictionOutcome(auditMode.temporalPrediction, outputSlots);\n"
    "      const attributedOutputs = submittedSlots.size"
)
replace_once(
    main,
    "      : []\n  };\n  message.jobKind = kind;",
    "      : []\n"
    "  };\n"
    "  if (!auditMode.full && !auditMode.autoOpticsProbe && auditMode.trackSlots.length)\n"
    "    auditMode.temporalPrediction = temporalPredictionSnapshot(\n"
    "      auditMode.trackSlots, auditMode.sourceSequence, receiverNow()\n"
    "    );\n"
    "  message.jobKind = kind;"
)
replace_once(
    main,
    "  resetDuplicateAttribution();\n  repeatSkipTimes.length = 0;",
    "  resetDuplicateAttribution();\n"
    "  resetTemporalBandModel();\n"
    "  temporalBandSkipThroughSource.fill(-1);\n"
    "  temporalBandDetections = 0;\n"
    "  temporalBandSkippedTracks = 0;\n"
    "  temporalBandLastKey = \"\";\n"
    "  temporalBandLastSource = -1;\n"
    "  temporalBandRepeat = 0;\n"
    "  resetTemporalPredictionValidation();\n"
    "  repeatSkipTimes.length = 0;"
)
replace_once(
    main,
    "    })(),\n    decoder ? `Framing  ${transportSourceBytes}",
    "    })(),\n"
    "    temporalPredictionSummary(),\n"
    "    decoder ? `Framing  ${transportSourceBytes}"
)
replace_once(
    main,
    " · turbo ${livePipeline.guidedTurboSuccesses}/${livePipeline.guidedTurboAttempts} · stableRS ${livePipeline.guidedStableRsSuccesses}/${livePipeline.guidedStableRsAttempts}",
    " · turbo ${livePipeline.guidedTurboSuccesses}/${livePipeline.guidedTurboAttempts} · turbo cost ${(livePipeline.guidedFastDecodeMs / Math.max(1, livePipeline.guidedTurboAttempts)).toFixed(2)}ms/attempt · stableRS ${livePipeline.guidedStableRsSuccesses}/${livePipeline.guidedStableRsAttempts}"
)

# Version/cache busts. Sender behavior itself is unchanged in this candidate.
replace_once("send/main.js", 'const SEND_RUNTIME_BUILD = "v0.5.313";', 'const SEND_RUNTIME_BUILD = "v0.5.314";')
replace_once("main.js", 'const APP_BUILD = "v0.5.313";', 'const APP_BUILD = "v0.5.314";')
replace_once("index.html", '<span class="app-version">v0.5.313</span>', '<span class="app-version">v0.5.314</span>')
replace_once("index.html", './main.js?build=v0.5.313', './main.js?build=v0.5.314')
replace_once("sw.js", 'const CACHE = "airgapper-static-js-v261";', 'const CACHE = "airgapper-static-js-v262";')

print("staged v0.5.314: sparse cache healing, temporal validation, faster Auto budget recovery")
