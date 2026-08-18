>> 0;\n  const attemptedCount = countMaskBits(attempts);\n  const codewordsPerAttempt = attemptedCount ? Math.max(1, Number(guided?.erasureRepairCodewords) || 0) / attemptedCount : 0;\n  for (let slot = 0; slot < SLOT_METRIC_COUNT; slot++) {\n    const bit = (1 << slot) >>> 0;\n    if (!(attempts & bit)) continue;\n    const hit = Boolean(successes & bit);\n    const alpha = slotRepairSamples[slot] < 5 ? 0.34 : 0.18;\n    slotRepairYield[slot] = slotRepairYield[slot] * (1 - alpha) + Number(hit) * alpha;\n    slotRepairCost[slot] = slotRepairCost[slot] * (1 - alpha) + codewordsPerAttempt * alpha;\n    slotRepairSamples[slot] = Math.min(65535, slotRepairSamples[slot] + 1);\n  }\n}\nfunction guidedRepairValue(track, now) {\n  const slot = Number(track?.slot ?? track?.id);\n  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_METRIC_COUNT) return 0;\n  const fast = slotFastSamples[slot] ? slotFastYield[slot] : 0.82;\n  const repair = slotRepairSamples[slot] ? slotRepairYield[slot] : 0.28;\n  const cost = Math.max(64, slotRepairCost[slot]);\n  return (0.15 + repair * 0.70 + fast * 0.15) / Math.sqrt(cost);\n}\nfunction guidedRepairMaskForTracks(tracks, sourceSequence, now = receiverNow()) {\n  const items = [];\n  let mask = 0;\n  for (const track of tracks ?? []) {\n    const slot = Number(track?.slot ?? track?.id);\n    if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_METRIC_COUNT) continue;\n    const bit = (1 << slot) >>> 0;\n    const risk = temporalBandRiskForSlot(slot, sourceSequence, now);\n    if (risk >= TEMPORAL_MODEL_RISK_THRESHOLD) {\n      guidedRepairTemporalFences++;\n      continue;\n    }\n    items.push({ track, slot, bit, value: guidedRepairValue(track, now) });\n  }\n  lastGuidedRepairCandidates = (tracks ?? []).length;\n  if (!recentTrackPressure(now)) {\n    for (const item of items) mask = (mask | item.bit) >>> 0;\n  } else {\n    items.sort((a, b) => b.value - a.value || a.slot - b.slot);\n    for (const item of items.slice(0, GUIDED_REPAIR_PRESSURE_LIMIT)) mask = (mask | item.bit) >>> 0;\n    guidedRepairPressureFences += Math.max(0, items.length - GUIDED_REPAIR_PRESSURE_LIMIT);\n  }\n  lastGuidedRepairAllowed = countMaskBits(mask);\n  return mask >>> 0;\n}\nfunction resetTrackBudgetController() {'''
)
replace(
    "receive/main.js",
    '''function slotSchedulingYield(region, now) {''',
    '''function slotSchedulingYield(region, now, sourceSequence = temporalBandLastSource + 1) {'''
)
replace(
    "receive/main.js",
    '''  if (temporalBandAvoidUntil[slot] > now) estimate *= 0.16;''',
    '''  const temporalRisk = temporalBandRiskForSlot(slot, sourceSequence, now);\n  if (temporalRisk > 0) estimate *= Math.max(0.06, 1 - temporalRisk * 0.94);'''
)
replace(
    "receive/main.js",
    '''const yields = candidates.map((