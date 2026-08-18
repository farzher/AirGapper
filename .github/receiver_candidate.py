from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    text = p.read_text()
    found = text.count(old)
    if found != count:
        raise SystemExit(f"{path}: expected {count} occurrence(s), found {found}: {old[:160]!r}")
    p.write_text(text.replace(old, new, count))

# Version/cache bump.
replace("send/main.js", 'const SEND_RUNTIME_BUILD = "v0.5.305";', 'const SEND_RUNTIME_BUILD = "v0.5.306";')
replace("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.305";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.306";')
replace("main.js", 'const APP_BUILD = "v0.5.305";', 'const APP_BUILD = "v0.5.306";')
replace("index.html", 'v0.5.305', 'v0.5.306', 2)
replace("sw.js", 'airgapper-static-js-v253', 'airgapper-static-js-v254')

# Developer control: this is tracked decoder work per camera frame, not sender QR count.
replace(
    "index.html",
    '<label><span>Device label</span><input id="device-label" type="text" placeholder="OnePlus 12R" autocomplete="off" /></label><label id="decode-workers-control"><span>Workers</span><select id="decode-workers"><option value="auto" selected>Auto</option></select></label>',
    '<label><span>Device label</span><input id="device-label" type="text" placeholder="OnePlus 12R" autocomplete="off" /></label><label id="decode-workers-control"><span>Workers</span><select id="decode-workers"><option value="auto" selected>Auto</option></select></label><label id="decode-tracks-control"><span>Tracks/frame</span><select id="decode-tracks-per-frame"><option value="auto" selected>Auto</option><option value="32">32</option><option value="28">28</option><option value="24">24</option><option value="20">20</option><option value="16">16</option><option value="12">12</option><option value="8">8</option></select></label>'
)

replace(
    "receive/main.js",
    '''const decodeWorkers = document.getElementById("decode-workers");\nconst deviceLabel = document.getElementById("device-label");\nconst decodeWorkersControl = document.getElementById("decode-workers-control");\nconst strictHotPathToggle = document.getElementById("strict-hot-path");''',
    '''const decodeWorkers = document.getElementById("decode-workers");\nconst decodeTracksPerFrame = document.getElementById("decode-tracks-per-frame");\nconst deviceLabel = document.getElementById("device-label");\nconst decodeWorkersControl = document.getElementById("decode-workers-control");\nconst strictHotPathToggle = document.getElementById("strict-hot-path");'''
)

replace(
    "receive/main.js",
    '''function selectedWorkerCount() {\n  return decodeWorkers.value === "auto" ? autoWorkerCount : Math.max(1, Math.min(hardwareThreadCount, Number(decodeWorkers.value) || autoWorkerCount));\n}\nlet strictHotPathEnabled = strictHotPathToggle.checked;''',
    '''function selectedWorkerCount() {\n  return decodeWorkers.value === "auto" ? autoWorkerCount : Math.max(1, Math.min(hardwareThreadCount, Number(decodeWorkers.value) || autoWorkerCount));\n}\nconst TRACKS_PER_FRAME_KEY = "airgapper:tracks-per-frame:v1";\nfunction selectedTracksPerFrameLimit() {\n  const value = decodeTracksPerFrame?.value;\n  if (!value || value === "auto") return Infinity;\n  const parsed = Number(value);\n  return Number.isFinite(parsed) ? Math.max(1, Math.min(32, Math.trunc(parsed))) : Infinity;\n}\nif (decodeTracksPerFrame) {\n  try {\n    const saved = localStorage.getItem(TRACKS_PER_FRAME_KEY);\n    if (saved && Array.from(decodeTracksPerFrame.options).some((option) => option.value === saved)) decodeTracksPerFrame.value = saved;\n  } catch {}\n  decodeTracksPerFrame.addEventListener("change", () => {\n    try { localStorage.setItem(TRACKS_PER_FRAME_KEY, decodeTracksPerFrame.value); } catch {}\n    resetTrackBudgetController();\n  });\n}\nlet strictHotPathEnabled = strictHotPathToggle.checked;'''
)

# Fast, short-lived scheduling evidence is intentionally separate from the
# long-lived weak-slot model. Rolling shutter is a frame-local erasure and should
# influence CPU spending immediately without poisoning physical-slot quality.
replace(
    "receive/main.js",
    '''let temporalBandLastSource = -1;\nlet temporalBandRepeat = 0;\nconst slotAttemptCounts = new Uint32Array(SLOT_METRIC_COUNT);''',
    '''let temporalBandLastSource = -1;\nlet temporalBandRepeat = 0;\nconst TEMPORAL_BAND_AVOID_MS = 500;\nconst TRACK_BUDGET_MIN = 8;\nconst TRACK_BUDGET_UPDATE_MS = 400;\nconst TRACK_BUDGET_WINDOW_MS = 1400;\nconst TRACK_BUDGET_IMPROVEMENT = 1.025;\nconst TRACK_BUDGET_PROBE_EVERY = 7;\nconst temporalBandAvoidUntil = new Float64Array(SLOT_METRIC_COUNT);\nconst slotFastYield = new Float32Array(SLOT_METRIC_COUNT);\nslotFastYield.fill(0.85);\nconst slotFastSamples = new Uint16Array(SLOT_METRIC_COUNT);\nconst slotFastUpdatedAt = new Float64Array(SLOT_METRIC_COUNT);\nlet autoTrackBudgetTarget = 32;\nlet autoTrackBudgetUpdatedAt = -Infinity;\nlet autoTrackBudgetCandidateCount = 0;\nlet autoTrackBudgetReason = "warmup";\nlet lastTrackBudgetSelected = 0;\nlet lastTrackBudgetCandidates = 0;\nlet trackBudgetDroppedTracks = 0;\nlet trackBudgetProbeTracks = 0;\nlet trackBudgetTemporalAvoided = 0;\nconst slotAttemptCounts = new Uint32Array(SLOT_METRIC_COUNT);'''
)

replace(
    "receive/main.js",
    '''function temporalBandMissSlots(auditMode, completion) {''',
    '''function resetTrackBudgetController() {\n  autoTrackBudgetTarget = 32;\n  autoTrackBudgetUpdatedAt = -Infinity;\n  autoTrackBudgetCandidateCount = 0;\n  autoTrackBudgetReason = "warmup";\n}\nfunction noteSlotFastMetric(slot, hit) {\n  const index = Number(slot);\n  if (!Number.isInteger(index) || index < 0 || index >= SLOT_METRIC_COUNT) return;\n  const alpha = slotFastSamples[index] < 4 ? 0.38 : 0.24;\n  slotFastYield[index] = slotFastYield[index] * (1 - alpha) + Number(Boolean(hit)) * alpha;\n  slotFastSamples[index] = Math.min(65535, slotFastSamples[index] + 1);\n  slotFastUpdatedAt[index] = receiverNow();\n}\nfunction slotSchedulingYield(region, now) {\n  const slot = Number(region.gridSlot);\n  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_METRIC_COUNT) return 0.5;\n  // Fast evidence decays back toward a neutral prior so a temporarily crossed\n  // rolling-shutter row cannot be excluded forever. Periodic probes accelerate\n  // recovery when that row becomes clean again.\n  const age = Math.max(0, now - slotFastUpdatedAt[slot]);\n  const decay = Math.exp(-age / 2200);\n  const fast = slotFastSamples[slot] ? 0.82 + (slotFastYield[slot] - 0.82) * decay : 0.82;\n  const longYield = slotQualitySamples[slot] >= 4 ? slotQualityScores[slot] : Math.max(0.35, Number(region.decodeConfidence) || 0.75);\n  let estimate = fast * 0.72 + longYield * 0.28;\n  const visible = Math.max(0.15, Math.min(1, Number(region.visibleFraction) || 1));\n  estimate *= 0.82 + visible * 0.18;\n  if (temporalBandAvoidUntil[slot] > now) estimate *= 0.16;\n  if ((region.consecutiveMisses || 0) > 0) estimate *= Math.max(0.35, 1 - Math.min(5, region.consecutiveMisses) * 0.10);\n  return Math.max(0.01, Math.min(1, estimate));\n}\nfunction temporalBandMissSlots(auditMode, completion) {'''
)

# Even when the same stripe persists long enough that we stop exempting it from
# long-term weakness learning, keep it as short-term negative scheduling evidence.
replace(
    "receive/main.js",
    '''  // A stripe that stays in the exact same place indefinitely is probably a\n  // genuinely weak/occluded region, not a moving temporal seam. Let normal\n  // weak-slot learning resume after a few consecutive identical detections.\n  if (temporalBandRepeat > TEMPORAL_BAND_MAX_REPEAT) return new Set();\n\n  temporalBandDetections++;\n  for (const slot of misses) {\n    temporalBandSkipThroughSource[slot] = Math.max(\n      temporalBandSkipThroughSource[slot],\n      Math.trunc(sourceSequence) + TEMPORAL_BAND_SKIP_SOURCE_FRAMES\n    );\n  }\n  notePipelineEvent("temporal-band", misses.length);\n  return new Set(misses);''',
    '''  // A stripe that stays in the exact same place indefinitely may be a\n  // genuinely weak/occluded region rather than a moving seam. In that case we\n  // resume normal long-term weakness learning, but it is STILL valuable\n  // short-term evidence that CPU should prefer the other rows/columns.\n  const transientBand = temporalBandRepeat <= TEMPORAL_BAND_MAX_REPEAT;\n  temporalBandDetections++;\n  const avoidUntil = receiverNow() + TEMPORAL_BAND_AVOID_MS;\n  for (const slot of misses) {\n    temporalBandAvoidUntil[slot] = Math.max(temporalBandAvoidUntil[slot], avoidUntil);\n    if (transientBand) {\n      temporalBandSkipThroughSource[slot] = Math.max(\n        temporalBandSkipThroughSource[slot],\n        Math.trunc(sourceSequence) + TEMPORAL_BAND_SKIP_SOURCE_FRAMES\n      );\n    }\n  }\n  notePipelineEvent("temporal-band", misses.length);\n  return transientBand ? new Set(misses) : new Set();'''
)

# Yield/cost scheduler. Auto only engages under actual worker pressure and uses
# Guided's measured sample+decode time as marginal per-track cost. This avoids
# the incorrect assumption that "fewer tracks is always faster/better": fixed
# per-frame work makes a large batch efficient until its low-yield tail stops
# paying for its marginal CPU cost.
replace(
    "receive/main.js",
    '''function adaptiveWeakSlotScheduling(candidates) {''',
    '''function recentTrackPressure(now) {\n  const cutoff = now - 1000;\n  return poolBusyTimes.some((at) => at > cutoff) || pendingLaneReplaceTimes.some((at) => at > cutoff) ||\n    (pool.size > 0 && pool.busyCount >= Math.max(1, pool.size - 1));\n}\nfunction estimatedAutoTrackBudget(candidates, now) {\n  const count = candidates.length;\n  if (count <= TRACK_BUDGET_MIN || strictHotPathActive() || replayRunning || autoOpticsMeasurementSlots?.size) return count;\n  if (!recentTrackPressure(now)) {\n    autoTrackBudgetTarget = count;\n    autoTrackBudgetCandidateCount = count;\n    autoTrackBudgetReason = "CPU headroom";\n    return count;\n  }\n  const cutoff = now - TRACK_BUDGET_WINDOW_MS;\n  const samples = hotJobCompletionSamples.filter((sample) =>\n    !sample.full && sample.at > cutoff && sample.tracks >= 4 &&\n    sample.guidedSampleMs + sample.guidedDecodeMs > 0 && sample.latencyMs > 0\n  );\n  if (samples.length < 3) {\n    autoTrackBudgetTarget = Math.min(autoTrackBudgetTarget || count, count);\n    autoTrackBudgetCandidateCount = count;\n    autoTrackBudgetReason = "measuring cost";\n    return count;\n  }\n  let fixedMs = 0;\n  let variableMs = 0;\n  let variableTracks = 0;\n  for (const sample of samples) {\n    const variable = Math.max(0, sample.guidedSampleMs) + Math.max(0, sample.guidedDecodeMs);\n    variableMs += variable;\n    variableTracks += Math.max(1, sample.tracks);\n    fixedMs += Math.max(0, sample.latencyMs - variable);\n  }\n  fixedMs /= samples.length;\n  const marginalMs = variableTracks ? variableMs / variableTracks : 0;\n  if (!(marginalMs > 0)) {\n    autoTrackBudgetReason = "cost unavailable";\n    return count;\n  }\n\n  const yields = candidates.map((region) => slotSchedulingYield(region, now)).sort((a, b) => b - a);\n  const minimum = Math.min(TRACK_BUDGET_MIN, count);\n  let cumulative = 0;\n  let allScore = 0;\n  let bestScore = -Infinity;\n  let bestCount = count;\n  for (let k = 1; k <= count; k++) {\n    cumulative += yields[k - 1];\n    const score = cumulative / Math.max(0.1, fixedMs + marginalMs * k);\n    if (k === count) allScore = score;\n    if (k >= minimum && score > bestScore) {\n      bestScore = score;\n      bestCount = k;\n    }\n  }\n  if (!(bestScore > allScore * TRACK_BUDGET_IMPROVEMENT)) bestCount = count;\n\n  if (autoTrackBudgetCandidateCount !== count || !Number.isFinite(autoTrackBudgetTarget)) {\n    autoTrackBudgetTarget = count;\n    autoTrackBudgetCandidateCount = count;\n    autoTrackBudgetUpdatedAt = now;\n  }\n  if (now - autoTrackBudgetUpdatedAt >= TRACK_BUDGET_UPDATE_MS) {\n    if (bestCount < autoTrackBudgetTarget) autoTrackBudgetTarget = Math.max(bestCount, autoTrackBudgetTarget - 4);\n    else if (bestCount > autoTrackBudgetTarget) autoTrackBudgetTarget = Math.min(bestCount, autoTrackBudgetTarget + 2);\n    autoTrackBudgetUpdatedAt = now;\n  }\n  autoTrackBudgetTarget = Math.max(minimum, Math.min(count, autoTrackBudgetTarget));\n  const gain = allScore > 0 ? Math.max(0, bestScore / allScore - 1) * 100 : 0;\n  autoTrackBudgetReason = `yield/cost ${bestCount}/${count} +${gain.toFixed(0)}%`;\n  return autoTrackBudgetTarget;\n}\nfunction selectTrackedRegionsForBudget(candidates, sourceSequence, now) {\n  if (candidates.length <= 1 || autoOpticsMeasurementSlots?.size || strictHotPathActive()) {\n    lastTrackBudgetCandidates = candidates.length;\n    lastTrackBudgetSelected = candidates.length;\n    return candidates;\n  }\n  const manualLimit = selectedTracksPerFrameLimit();\n  const budget = Math.max(1, Math.min(\n    candidates.length,\n    Number.isFinite(manualLimit) ? manualLimit : estimatedAutoTrackBudget(candidates, now)\n  ));\n  lastTrackBudgetCandidates = candidates.length;\n  lastTrackBudgetSelected = budget;\n  if (budget >= candidates.length) return candidates;\n\n  const ranked = candidates.map((region) => ({ region, score: slotSchedulingYield(region, now) }))\n    .sort((a, b) => b.score - a.score || Number(a.region.gridSlot) - Number(b.region.gridSlot));\n  const selected = [];\n  const selectedIds = new Set();\n  const add = (entry) => {\n    if (!entry || selectedIds.has(entry.region.id) || selected.length >= budget) return;\n    selected.push(entry);\n    selectedIds.add(entry.region.id);\n  };\n\n  // Preserve a spatially distributed pose basis while spending the remaining\n  // budget entirely on high-yield payload slots. Pick the BEST slot in each\n  // quadrant, not a fixed corner, so a temporal seam can wipe one edge without\n  // forcing us to decode the damaged QR just for geometry.\n  const layout = lastGridSnapshot?.layout;\n  if (layout && budget >= 4 && layout.cols > 1 && layout.rows > 1) {\n    const quadrants = [\n      (c, r) => c < layout.cols / 2 && r < layout.rows / 2,\n      (c, r) => c >= layout.cols / 2 && r < layout.rows / 2,\n      (c, r) => c < layout.cols / 2 && r >= layout.rows / 2,\n      (c, r) => c >= layout.cols / 2 && r >= layout.rows / 2\n    ];\n    for (const contains of quadrants) {\n      add(ranked.find(({ region }) => {\n        const slot = Number(region.gridSlot);\n        if (!Number.isInteger(slot)) return false;\n        return contains(slot % layout.cols, Math.floor(slot / layout.cols));\n      }));\n    }\n  }\n  for (const entry of ranked) add(entry);\n\n  // One low-rate rotating probe prevents the scheduler from creating its own\n  // blind spot. A previously crossed row gets a cheap opportunity to prove it\n  // is clean again and immediately climbs the fast-yield ranking on success.\n  const sequence = Math.trunc(Number(sourceSequence) || 0);\n  if (budget >= 2 && sequence % TRACK_BUDGET_PROBE_EVERY === 0) {\n    const omitted = ranked.filter((entry) => !selectedIds.has(entry.region.id));\n    if (omitted.length) {\n      const probe = omitted[Math.floor(sequence / TRACK_BUDGET_PROBE_EVERY) % omitted.length];\n      const replaceIndex = selected.length - 1;\n      if (replaceIndex >= 0 && probe) {\n        selectedIds.delete(selected[replaceIndex].region.id);\n        selected[replaceIndex] = probe;\n        selectedIds.add(probe.region.id);\n        trackBudgetProbeTracks++;\n      }\n    }\n  }\n  const chosen = selected.map((entry) => entry.region);\n  trackBudgetDroppedTracks += Math.max(0, candidates.length - chosen.length);\n  trackBudgetTemporalAvoided += candidates.reduce((sum, region) => {\n    const slot = Number(region.gridSlot);\n    return sum + Number(Number.isInteger(slot) && temporalBandAvoidUntil[slot] > now && !chosen.includes(region));\n  }, 0);\n  return chosen;\n}\nfunction adaptiveWeakSlotScheduling(candidates) {'''
)

# Store enough phase timing to estimate marginal track cost rather than treating
# all worker time as per-QR work.
replace(
    "receive/main.js",
    '''      guidedMs: completion.guidedMetrics?.totalMs || 0\n    });''',
    '''      guidedMs: completion.guidedMetrics?.totalMs || 0,\n      guidedSampleMs: completion.guidedMetrics?.sampleMs || 0,\n      guidedDecodeMs: completion.guidedMetrics?.decodeMs || 0\n    });'''
)

# Fast yield learns EVERY attempt including temporal erasures; the existing
# long-lived slot metric continues to exempt short-lived coherent bands.
replace(
    "receive/main.js",
    '''    if (!auditMode?.autoOpticsProbe) {\n      const temporalBandMiss = !hit && temporalMisses.has(Number(region.gridSlot));\n      // A coherent rolling-shutter seam is an erasure of this camera frame,''',
    '''    if (!auditMode?.autoOpticsProbe) {\n      const temporalBandMiss = !hit && temporalMisses.has(Number(region.gridSlot));\n      if (region.gridSlot !== void 0) noteSlotFastMetric(region.gridSlot, hit);\n      // A coherent rolling-shutter seam is an erasure of this camera frame,'''
)

# Apply the budget after existing weak-slot and breadth-repair logic so manual
# limits are real caps and Auto can rank the complete set that production would
# otherwise submit.
replace(
    "receive/main.js",
    '''  const batchTracks = batchRegions.map((region) => ({''',
    '''  batchRegions = selectTrackedRegionsForBudget(batchRegions, source.sequence, now);\n  const batchTracks = batchRegions.map((region) => ({'''
)

# Make diagnostics describe the actual CPU budget rather than pretending every
# visible slot is scheduled on every source frame.
replace(
    "receive/main.js",
    '''  const scheduledSlotEquivalent = diagnosticCandidates.reduce((sum, region) =>\n    sum + (diagnosticAdaptiveWeak ? 1 / adaptiveSlotProbeEvery(region) : 1), 0\n  );''',
    '''  const adaptiveScheduledEquivalent = diagnosticCandidates.reduce((sum, region) =>\n    sum + (diagnosticAdaptiveWeak ? 1 / adaptiveSlotProbeEvery(region) : 1), 0\n  );\n  const configuredTrackLimit = selectedTracksPerFrameLimit();\n  const diagnosticTrackBudget = Math.min(\n    diagnosticCandidates.length,\n    Number.isFinite(configuredTrackLimit) ? configuredTrackLimit : Math.max(1, lastTrackBudgetSelected || diagnosticCandidates.length)\n  );\n  const scheduledSlotEquivalent = Math.min(adaptiveScheduledEquivalent, diagnosticTrackBudget);'''
)

replace(
    "receive/main.js",
    '''    `Pressure worker-busy ${workerBusyEventRate.toFixed(1)}/s · latest replacements ${(pendingLaneReplaceTimes.length / (STATS_WINDOW_MS / 1e3)).toFixed(1)}/s · repeat skips ${repeatSkipRate.toFixed(1)}/s · crop recenters ${laneCropRecentersTotal} · avg job ${averageJobMs.toFixed(1)}ms · robust ${averageRobustSearchMs.toFixed(1)}ms/${averageRobustBands.toFixed(1)} bands · guided ${averageGuidedMs.toFixed(1)}ms · native ${averageNativeMs.toFixed(1)}ms · copy ${averageCopyMs.toFixed(1)}ms`,''',
    '''    `Pressure worker-busy ${workerBusyEventRate.toFixed(1)}/s · latest replacements ${(pendingLaneReplaceTimes.length / (STATS_WINDOW_MS / 1e3)).toFixed(1)}/s · repeat skips ${repeatSkipRate.toFixed(1)}/s · crop recenters ${laneCropRecentersTotal} · tracks ${Number.isFinite(selectedTracksPerFrameLimit()) ? `manual ${selectedTracksPerFrameLimit()}` : `auto ${lastTrackBudgetSelected || "—"}/${lastTrackBudgetCandidates || "—"} ${autoTrackBudgetReason}`} · budget drops ${trackBudgetDroppedTracks} · probes ${trackBudgetProbeTracks} · band avoids ${trackBudgetTemporalAvoided} · avg job ${averageJobMs.toFixed(1)}ms · robust ${averageRobustSearchMs.toFixed(1)}ms/${averageRobustBands.toFixed(1)} bands · guided ${averageGuidedMs.toFixed(1)}ms · native ${averageNativeMs.toFixed(1)}ms · copy ${averageCopyMs.toFixed(1)}ms`,'''
)

# Sanity assertions.
receive = Path("receive/main.js").read_text()
html = Path("index.html").read_text()
assert 'id="decode-tracks-per-frame"' in html
assert 'function selectTrackedRegionsForBudget' in receive
assert 'guidedSampleMs:' in receive and 'guidedDecodeMs:' in receive
assert 'noteSlotFastMetric(region.gridSlot, hit)' in receive
assert 'batchRegions = selectTrackedRegionsForBudget(batchRegions, source.sequence, now);' in receive
assert 'TEMPORAL_BAND_AVOID_MS = 500' in receive
assert 'tracks ${Number.isFinite(selectedTracksPerFrameLimit())' in receive
print("v306 rolling-shutter-aware track budget candidate applied")
