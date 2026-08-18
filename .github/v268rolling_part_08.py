de = false, guidedFallbackMask = 0xffffffff, guidedRepairMask = 0xffffffff, sourceSequence, repeatFilter = false,'''
)
replace(
    "receive/worker.js",
    '''          zx, ptr + inputOffset, pw, ph, inputStride, ox, oy, tracks, guidedFallbackMask\n        );''',
    '''          zx, ptr + inputOffset, pw, ph, inputStride, ox, oy, tracks, guidedFallbackMask, guidedRepairMask\n        );'''
)
replace(
    "receive/main.js",
    '''const TEMPORAL_BAND_AVOID_MS = 500;\nconst TRACK_BUDGET_MIN = 8;''',
    '''const TEMPORAL_BAND_AVOID_MS = 500;\nconst TEMPORAL_MODEL_FRESH_MS = 900;\nconst TEMPORAL_MODEL_RISK_THRESHOLD = 0.34;\nconst TEMPORAL_MODEL_OVERLAY_THRESHOLD = 0.18;\nconst GUIDED_REPAIR_PRESSURE_LIMIT = 1;\nconst temporalBandModel = {\n  axis: "",\n  position: 0,\n  velocity: 0,\n  width: 1,\n  span: 0,\n  sourceSequence: -1,\n  updatedAt: -Infinity,\n  confidence: 0,\n  detections: 0\n};\nconst slotRepairYield = new Float32Array(SLOT_METRIC_COUNT);\nslotRepairYield.fill(0.28);\nconst slotRepairSamples = new Uint16Array(SLOT_METRIC_COUNT);\nconst slotRepairCost = new Float32Array(SLOT_METRIC_COUNT);\nslotRepairCost.fill(480);\nlet lastGuidedRepairAllowed = 0;\nlet lastGuidedRepairCandidates = 0;\nlet guidedRepairPressureFences = 0;\nlet guidedRepairTemporalFences = 0;\nconst TRACK_BUDGET_MIN = 8;'''
)
replace(
    "receive/main.js",
    '''function resetTrackBudgetController() {''',
    '''function resetTemporalBandModel() {\n  temporalBandModel.axis = "";\n  temporalBandModel.position = 0;\n  temporalBandModel.velocity = 0;\n  temporalBandModel.width = 1;\n  temporalBandModel.span = 0;\n  temporalBandModel.sourceSequence = -1;\n  temporalBandModel.updatedAt = -Infinity;\n  temporalBandModel.confidence = 0;\n  temporalBandModel.detections = 0;\n  temporalBandAvoidUntil.fill(0);\n}\nfunction circularBandDelta(next, previous, span) {\n  if (!(span > 1)) return next - previous;\n  let delta = next - previous;\n  const half = span / 2;\n  while (delta > half) delta -= span;\n  while (delta < -half) delta += span;\n  return delta;\n}\nfunction updateTemporalBandModel(axis, indices, span, sourceSequence, now) {\n  if (!indices.length || !(span > 0) || !Number.isFinite(sourceSequence)) return;\n  const position = indices.reduce((sum, value) => sum + value, 0) / indices.length;\n  const width = Math.max(1, indices[indices.length - 1] - indices[0] + 1);\n  const sameAxis = temporalBandModel.axis === axis && temporalBandModel.span === span &&\n    temporalBandModel.sourceSequence >= 0 && sourceSequence > temporalBandModel.sourceSequence;\n  let velocity = 0;\n  if (sameAxis) {\n    const frames = Math.max(1, sourceSequence - temporalBandModel.sourceSequence);\n    const observed = circularBandDelta(position, temporalBandModel.position, span) / frames;\n    