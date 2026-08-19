from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing patch anchor in {path}: {old[:100]!r}")
    p.write_text(text.replace(old, new, 1))


main = "receive/main.js"

replace_once(main,
    'const RECEIVER_RUNTIME_BUILD = "v0.5.336";',
    'const RECEIVER_RUNTIME_BUILD = "v0.5.337";')

replace_once(main,
    'const slotFastUpdatedAt = new Float64Array(SLOT_METRIC_COUNT);\nlet autoTrackBudgetTarget = 32;',
    'const slotFastUpdatedAt = new Float64Array(SLOT_METRIC_COUNT);\n'
    'const slotGeometryProbeUntil = new Float64Array(SLOT_METRIC_COUNT);\n'
    'const slotGeometryRetryAt = new Float64Array(SLOT_METRIC_COUNT);\n'
    'let autoTrackBudgetTarget = 32;')

replace_once(main,
    '  slotQualityScores.fill(0.5);\n  slotAdaptiveWeak.fill(0);\n}\nfunction noteSlotDecoded(slot) {',
    '  slotQualityScores.fill(0.5);\n'
    '  slotAdaptiveWeak.fill(0);\n'
    '  slotGeometryProbeUntil.fill(0);\n'
    '  slotGeometryRetryAt.fill(0);\n'
    '}\n'
    'function resetSlotSchedulingHistory(slot, now = receiverNow()) {\n'
    '  const index = Number(slot);\n'
    '  if (!Number.isInteger(index) || index < 0 || index >= SLOT_METRIC_COUNT) return false;\n'
    '  // Geometry changed, so all decode-quality evidence collected against the\n'
    '  // previous sampling transform is stale. Return this slot to neutral rather\n'
    '  // than letting an old miss streak keep it LOST/weak forever.\n'
    '  slotFastYield[index] = 0.85;\n'
    '  slotFastSamples[index] = 0;\n'
    '  slotFastUpdatedAt[index] = now;\n'
    '  slotQualitySamples[index] = 0;\n'
    '  slotQualityScores[index] = 0.65;\n'
    '  slotAdaptiveWeak[index] = 0;\n'
    '  slotRepairYield[index] = 0.28;\n'
    '  slotRepairSamples[index] = 0;\n'
    '  slotRepairCost[index] = 480;\n'
    '  resetGuidedFallbackSlot(index);\n'
    '  return true;\n'
    '}\n'
    'function noteSlotDecoded(slot) {')

replace_once(main,
    'function shouldScheduleAdaptiveSlot(region, sourceSequence, adaptive) {\n'
    '  if (!adaptive) return true;\n'
    '  const slot = Number(region.gridSlot);\n'
    '  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_METRIC_COUNT || !slotAdaptiveWeak[slot]) return true;',
    'function shouldScheduleAdaptiveSlot(region, sourceSequence, adaptive) {\n'
    '  if (!adaptive) return true;\n'
    '  const slot = Number(region.gridSlot);\n'
    '  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_METRIC_COUNT) return true;\n'
    '  // A slot whose geometry was just self-healed must be allowed to prove the\n'
    '  // new transform immediately, regardless of its old weak-slot throttle.\n'
    '  if (slotGeometryProbeUntil[slot] > receiverNow()) return true;\n'
    '  if (!slotAdaptiveWeak[slot]) return true;')

replace_once(main,
    '  const add = (entry) => {\n'
    '    if (!entry || selectedIds.has(entry.region.id) || selected.length >= budget) return;\n'
    '    selected.push(entry);\n'
    '    selectedIds.add(entry.region.id);\n'
    '  };\n\n'
    '  // Preserve a spatially distributed pose basis while spending the remaining',
    '  const add = (entry) => {\n'
    '    if (!entry || selectedIds.has(entry.region.id) || selected.length >= budget) return;\n'
    '    selected.push(entry);\n'
    '    selectedIds.add(entry.region.id);\n'
    '  };\n\n'
    '  // Geometry self-heal is a short explicit exploration window. Put those\n'
    '  // slots ahead of normal yield ranking so a historically bad score cannot\n'
    '  // starve the exact slot we just repaired.\n'
    '  for (const entry of ranked) {\n'
    '    const slot = Number(entry.region.gridSlot);\n'
    '    if (Number.isInteger(slot) && slot >= 0 && slot < SLOT_METRIC_COUNT && slotGeometryProbeUntil[slot] > now) add(entry);\n'
    '  }\n\n'
    '  // Preserve a spatially distributed pose basis while spending the remaining')

replace_once(main,
    '          if (region.consecutiveMisses >= 5 && region.gridSlot !== void 0) {\n'
    '            const healed = gridLattice.dropSlotCorrection(Number(region.gridSlot));\n'
    '            if (healed) {\n'
    '              geometrySlotCorrectionResets++;\n'
    '              syncGrid(healed, receiverNow());\n'
    '              notePipelineEvent("slot-correction-reset", Number(region.gridSlot));\n'
    '              lastRecoveryReason = `slot s${region.gridSlot} dropped stale local geometry (${geometrySlotCorrectionResets})`;\n'
    '            }\n'
    '          }',
    '          if (region.consecutiveMisses >= 5 && region.gridSlot !== void 0) {\n'
    '            const slot = Number(region.gridSlot);\n'
    '            const recoveryNow = receiverNow();\n'
    '            // Only self-heal a fully visible, comfortably sampled QR. Partial\n'
    '            // and sub-2px/module cells are expected to miss and must not keep\n'
    '            // resetting the scheduler. Rate-limit a genuinely bad full slot.\n'
    '            const geometryEligible = region.visibleFraction >= 0.88 && region.pixelsPerModule >= 2.4;\n'
    '            if (geometryEligible && recoveryNow >= slotGeometryRetryAt[slot]) {\n'
    '              const healed = gridLattice.dropSlotCorrection(slot);\n'
    '              resetSlotSchedulingHistory(slot, recoveryNow);\n'
    '              slotGeometryProbeUntil[slot] = recoveryNow + 900;\n'
    '              slotGeometryRetryAt[slot] = recoveryNow + 3000;\n'
    '              region.consecutiveMisses = 0;\n'
    '              region.decodeConfidence = Math.max(region.decodeConfidence, 0.65);\n'
    '              resetTrackBudgetController();\n'
    '              geometrySlotCorrectionResets++;\n'
    '              if (healed) syncGrid(healed, recoveryNow);\n'
    '              const refreshed = regions.find((item) => Number(item.gridSlot) === slot);\n'
    '              if (refreshed) {\n'
    '                refreshed.consecutiveMisses = 0;\n'
    '                refreshed.decodeConfidence = Math.max(refreshed.decodeConfidence, 0.65);\n'
    '              }\n'
    '              notePipelineEvent("slot-geometry-reprobe", slot);\n'
    '              lastRecoveryReason = `slot s${slot} geometry self-heal reprobe (${geometrySlotCorrectionResets})`;\n'
    '            }\n'
    '          }')

replace_once("main.js", 'const APP_BUILD = "v0.5.336";', 'const APP_BUILD = "v0.5.337";')
replace_once("sw.js", 'const CACHE = "airgapper-static-js-v284";', 'const CACHE = "airgapper-static-js-v285";')

print("v0.5.337 candidate applied")
