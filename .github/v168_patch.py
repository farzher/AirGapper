from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing anchor in {path}: {old[:180]!r}")
    p.write_text(text.replace(old, new, 1))


replace_once("index.html", "v0.5.167", "v0.5.168")
replace_once("main.js", 'const APP_BUILD = "v0.5.167";', 'const APP_BUILD = "v0.5.168";')
replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.167";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.168";')
replace_once("sw.js", 'airgapper-static-js-v129', 'airgapper-static-js-v130')

p = Path("receive/main.js")
text = p.read_text()

old = '''const SLOT_METRIC_COUNT = 64;\nconst slotAttemptCounts = new Uint32Array(SLOT_METRIC_COUNT);\nconst slotHitCounts = new Uint32Array(SLOT_METRIC_COUNT);\nfunction resetSlotMetrics() {\n  slotAttemptCounts.fill(0);\n  slotHitCounts.fill(0);\n}\nfunction noteSlotMetric(slot, hit) {\n  const index = Number(slot);\n  if (!Number.isInteger(index) || index < 0 || index >= SLOT_METRIC_COUNT) return;\n  slotAttemptCounts[index]++;\n  if (hit) slotHitCounts[index]++;\n}\nfunction formatSlotMetric(slot) {\n  const attempts = slotAttemptCounts[slot] || 0;\n  const hits = slotHitCounts[slot] || 0;\n  return `s${slot} ${hits}/${attempts}${attempts ? ` ${(hits / attempts * 100).toFixed(0)}%` : ""}`;\n}\n'''
new = '''const SLOT_METRIC_COUNT = 64;\nconst SLOT_WEAK_MIN_SAMPLES = 32;\nconst SLOT_WEAK_ENTER_SCORE = 0.08;\nconst SLOT_WEAK_RECOVERY_SCORE = 0.25;\nconst SLOT_WEAK_PROBE_EVERY = 8;\nconst SLOT_WEAK_MIN_WALL = 6;\nconst SLOT_WEAK_MIN_HEALTHY = 4;\nconst slotAttemptCounts = new Uint32Array(SLOT_METRIC_COUNT);\nconst slotHitCounts = new Uint32Array(SLOT_METRIC_COUNT);\nconst slotQualitySamples = new Uint16Array(SLOT_METRIC_COUNT);\nconst slotQualityScores = new Float32Array(SLOT_METRIC_COUNT);\nconst slotAdaptiveWeak = new Uint8Array(SLOT_METRIC_COUNT);\nfunction resetSlotMetrics() {\n  slotAttemptCounts.fill(0);\n  slotHitCounts.fill(0);\n  slotQualitySamples.fill(0);\n  slotQualityScores.fill(0.5);\n  slotAdaptiveWeak.fill(0);\n}\nfunction noteSlotDecoded(slot) {\n  const index = Number(slot);\n  if (!Number.isInteger(index) || index < 0 || index >= SLOT_METRIC_COUNT || !slotAdaptiveWeak[index]) return;\n  slotAdaptiveWeak[index] = 0;\n  slotQualityScores[index] = Math.max(slotQualityScores[index], SLOT_WEAK_RECOVERY_SCORE);\n}\nfunction noteSlotMetric(slot, hit) {\n  const index = Number(slot);\n  if (!Number.isInteger(index) || index < 0 || index >= SLOT_METRIC_COUNT) return;\n  slotAttemptCounts[index]++;\n  if (hit) {\n    slotHitCounts[index]++;\n    // A weak-slot probe that succeeds is real CRC-backed evidence. Restore it\n    // immediately, then let the EWMA decide again only after another sustained\n    // miss run instead of making one lucky/failed frame flap the scheduler.\n    noteSlotDecoded(index);\n  }\n  slotQualitySamples[index] = Math.min(65535, slotQualitySamples[index] + 1);\n  slotQualityScores[index] = slotQualityScores[index] * 0.9 + Number(hit) * 0.1;\n  if (!slotAdaptiveWeak[index] && slotQualitySamples[index] >= SLOT_WEAK_MIN_SAMPLES &&\n      slotQualityScores[index] < SLOT_WEAK_ENTER_SCORE) {\n    slotAdaptiveWeak[index] = 1;\n  }\n}\nfunction adaptiveWeakSlotScheduling(candidates) {\n  if (strictHotPathActive() || candidates.length < SLOT_WEAK_MIN_WALL) return false;\n  let healthy = 0;\n  for (const region of candidates) {\n    const slot = Number(region.gridSlot);\n    if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_METRIC_COUNT) continue;\n    if (slotQualitySamples[slot] >= SLOT_WEAK_MIN_SAMPLES / 2 &&\n        !slotAdaptiveWeak[slot] && slotQualityScores[slot] >= SLOT_WEAK_RECOVERY_SCORE) healthy++;\n  }\n  // Only suppress a local outlier. If focus/exposure/motion makes the entire\n  // wall bad, there are not enough healthy peers and every slot stays active.\n  return healthy >= SLOT_WEAK_MIN_HEALTHY;\n}\nfunction shouldScheduleAdaptiveSlot(region, sourceSequence, adaptive) {\n  if (!adaptive) return true;\n  const slot = Number(region.gridSlot);\n  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_METRIC_COUNT || !slotAdaptiveWeak[slot]) return true;\n  const sequence = Number(sourceSequence);\n  if (!Number.isFinite(sequence)) return true;\n  // Stagger weak slots so several bad edge cells do not all consume the same\n  // probe frame. They remain geometrically tracked; only payload decode work is\n  // thinned out. Acquisition/reacquisition is intentionally unaffected.\n  return (Math.trunc(sequence) + slot) % SLOT_WEAK_PROBE_EVERY === 0;\n}\nfunction formatSlotMetric(slot) {\n  const attempts = slotAttemptCounts[slot] || 0;\n  const hits = slotHitCounts[slot] || 0;\n  const state = slotAdaptiveWeak[slot] ? " [weak]" : "";\n  return `s${slot} ${hits}/${attempts}${attempts ? ` ${(hits / attempts * 100).toFixed(0)}%` : ""}${state}`;\n}\n'''
if old not in text:
    raise SystemExit("slot metrics block missing")
text = text.replace(old, new, 1)

old = '''      r.seen = now;\n      r.decoded = true;\n      r.decodedSeen = now;\n'''
new = '''      r.seen = now;\n      r.decoded = true;\n      if (r.gridSlot !== void 0) noteSlotDecoded(r.gridSlot);\n      r.decodedSeen = now;\n'''
if old not in text:
    raise SystemExit("decoded region recovery anchor missing")
text = text.replace(old, new, 1)

old = '''  const batchRegions = (gridLattice.active ? visibleGridSlots.filter(isGridDecodeCandidate) : regions.filter((region) => region.observed && region.decoded)).filter((region) => region.quad && region.dim && validTrackedQuad(region, vw, vh)).slice(0, 18);\n  const batchTracks = batchRegions.map((region) => ({\n'''
new = '''  const batchCandidates = (gridLattice.active ? visibleGridSlots.filter(isGridDecodeCandidate) : regions.filter((region) => region.observed && region.decoded)).filter((region) => region.quad && region.dim && validTrackedQuad(region, vw, vh)).slice(0, 18);\n  const adaptiveWeakSlots = gridLattice.active && adaptiveWeakSlotScheduling(batchCandidates);\n  const batchRegions = adaptiveWeakSlots\n    ? batchCandidates.filter((region) => shouldScheduleAdaptiveSlot(region, source.sequence, true))\n    : batchCandidates;\n  const batchTracks = batchRegions.map((region) => ({\n'''
if old not in text:
    raise SystemExit("batch scheduler anchor missing")
text = text.replace(old, new, 1)

p.write_text(text)
