from pathlib import Path


def replace_once(path, old, new, label):
    source = path.read_text()
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    path.write_text(source.replace(old, new, 1))


def replace_all(path, old, new, expected, label):
    source = path.read_text()
    count = source.count(old)
    if count != expected:
        raise SystemExit(f"{label}: expected {expected} matches, found {count}")
    path.write_text(source.replace(old, new))

runtime = Path("receive/runtime.js")
worker = Path("receive/worker.js")
overlay = Path("receive/user-overlay.js")
coord = Path("receive/overlay-coordinate-guard.js")
version = Path("version.js")

# Auto Optics: motion is not ordinary exposure evidence, but a HOLD must not
# survive indefinitely when the finder still sees the wall and payload is dead.
replace_once(
    runtime,
    '''const AUTO_OPTICS_HOLD_SAMPLE_MS = 700;\nconst AUTO_OPTICS_HOLD_COLLAPSE_MS = 2500;\nconst AUTO_OPTICS_HOLD_MIN_ATTEMPTS = 40;''',
    '''const AUTO_OPTICS_HOLD_SAMPLE_MS = 700;\nconst AUTO_OPTICS_HOLD_COLLAPSE_MS = 2500;\nconst AUTO_OPTICS_HOLD_MIN_ATTEMPTS = 40;\nconst AUTO_OPTICS_HOLD_EMERGENCY_SILENCE_MS = 3000;\nconst AUTO_OPTICS_HOLD_FINDER_EVIDENCE_MS = 1800;''',
    "emergency HOLD constants"
)
replace_once(
    runtime,
    '''let acquisitionHuntScans = 0;\nlet acquisitionSightingScans = 0;\nlet acquisitionSightings = 0;''',
    '''let acquisitionHuntScans = 0;\nlet acquisitionSightingScans = 0;\nlet acquisitionSightings = 0;\nlet lastFinderEvidenceAt = -Infinity;''',
    "finder evidence state"
)
replace_once(
    runtime,
    '''  const fullJob = fullScanJobs.get(id);\n  const capturedAt = scanCapturedAt.get(id) ?? receiverNow();\n  if (fullJob?.acquisition && !gridLattice.active && completion.symbolCount === 0 && completion.sightings?.length) {''',
    '''  const fullJob = fullScanJobs.get(id);\n  const capturedAt = scanCapturedAt.get(id) ?? receiverNow();\n  if (completion.sightings?.length) lastFinderEvidenceAt = receiverNow();\n  if (fullJob?.acquisition && !gridLattice.active && completion.symbolCount === 0 && completion.sightings?.length) {''',
    "record recent finder evidence"
)
replace_once(
    runtime,
    '''    const temporalDominant = Boolean(temporal && temporal.confidence >= 0.72 && temporalCoverage >= 0.42);\n    if (!poseStable) {\n      // Losing a page, moving the camera, or seeing too little of the wall is\n      // not optical evidence. HOLD keeps its verified rollback point and makes\n      // no camera mutation until the wall has actually been stationary again.\n      autoOpticsHoldSample = void 0;\n      autoOpticsHoldCollapseSince = 0;\n      return;\n    }''',
    '''    const temporalDominant = Boolean(temporal && temporal.confidence >= 0.72 && temporalCoverage >= 0.42);\n    const payloadSilenceMs = lastStreamDecodeAt ? Math.max(0, now - lastStreamDecodeAt) : Infinity;\n    const finderEvidenceFresh = now - lastFinderEvidenceAt <= AUTO_OPTICS_HOLD_FINDER_EVIDENCE_MS;\n    if (!poseStable) {\n      // Motion is not ordinary exposure evidence, but finder/body evidence plus\n      // several seconds of zero CRC payload is different: the wall is still in\n      // view and this held sensor state is no longer doing its job. Escape to\n      // neutral hardware AE instead of allowing motion to protect a blind HOLD\n      // forever. Merely pointing the camera away produces no finder evidence and\n      // therefore preserves the proven HOLD.\n      if (payloadSilenceMs >= AUTO_OPTICS_HOLD_EMERGENCY_SILENCE_MS && finderEvidenceFresh) {\n        autoOpticsHoldSample = void 0;\n        autoOpticsHoldCollapseSince = 0;\n        void recoverCollapsedAutomaticOptics(track, 0, "held optics blind despite live finder evidence");\n        return;\n      }\n      autoOpticsHoldSample = void 0;\n      autoOpticsHoldCollapseSince = 0;\n      return;\n    }''',
    "motion-safe emergency HOLD escape"
)

# Recovery worker: preserve finder-only evidence from a targeted local search.
# This does not widen or repeat recovery; it only returns evidence the decoder
# already computed so runtime/overlay can distinguish temporal decode failure
# from a complete geometry miss.
replace_once(
    worker,
    '''              appendResults(\n                zx.readDenseY(ptr + inputOffset + ry * inputStride + rx, rw, rh, inputStride, 4),\n                false, ox + rx, oy + ry, expectedSlot\n              );''',
    '''              appendResults(\n                zx.readDenseY(ptr + inputOffset + ry * inputStride + rx, rw, rh, inputStride, 4),\n                true, ox + rx, oy + ry, expectedSlot\n              );''',
    "recovery finder-only sightings"
)

# Publish the actual decoder display space for overlays which draw independently
# of runtime's detect-overlay canvas.
replace_once(
    coord,
    '''let decodeWidth = 0;\nlet decodeHeight = 0;''',
    '''let decodeWidth = 0;\nlet decodeHeight = 0;\nglobalThis.__airgapperDecoderDisplaySize = () => ({ width: decodeWidth, height: decodeHeight });''',
    "decoder display size bridge"
)

# User overlay: actual recovery probes only, three useful outcomes, and an
# orientation-independent wall hull rather than assuming logical slot 0 is
# physically top-left.
replace_once(
    overlay,
    '''const MISS_FADE_MS = 520;\nconst JOB_TTL_MS = 4000;\nconst DRAW_INTERVAL_MS = 50;''',
    '''const PROBE_FADE_MS = Object.freeze({ success: 360, sighting: 680, miss: 520 });\nconst JOB_TTL_MS = 4000;\nconst DRAW_INTERVAL_MS = 50;''',
    "probe fade colors"
)
replace_once(
    overlay,
    '''function activityFor(slot) {\n  let value = slotActivity.get(slot);\n  if (!value) {\n    value = { missAt: -Infinity };\n    slotActivity.set(slot, value);\n  }\n  return value;\n}''',
    '''function activityFor(slot) {\n  let value = slotActivity.get(slot);\n  if (!value) {\n    value = { at: -Infinity, kind: "miss" };\n    slotActivity.set(slot, value);\n  }\n  return value;\n}\n\nfunction sightingNearSlot(slot, sightings) {\n  const target = snapshot?.slots?.find((item) => item.index === slot);\n  const q = target?.quad;\n  if (!validQuad(q) || !Array.isArray(sightings) || !sightings.length) return false;\n  const xs = [q.topLeft.x, q.topRight.x, q.bottomRight.x, q.bottomLeft.x];\n  const ys = [q.topLeft.y, q.topRight.y, q.bottomRight.y, q.bottomLeft.y];\n  const left = Math.min(...xs), right = Math.max(...xs);\n  const top = Math.min(...ys), bottom = Math.max(...ys);\n  const pad = Math.max(12, Math.max(right - left, bottom - top) * 0.55);\n  return sightings.some((box) => {\n    const x = Number(box?.x) + Number(box?.w) * 0.5;\n    const y = Number(box?.y) + Number(box?.h) * 0.5;\n    return Number.isFinite(x) && Number.isFinite(y) &&\n      x >= left - pad && x <= right + pad && y >= top - pad && y <= bottom + pad;\n  });\n}''',
    "probe activity model"
)
replace_once(
    overlay,
    '''  const at = now();\n  const successes = packedSuccessSlots(message);\n  for (const slot of job.slots) activityFor(slot).missAt = successes.has(slot) ? -Infinity : at;''',
    '''  const at = now();\n  const successes = packedSuccessSlots(message);\n  for (const slot of job.slots) {\n    const activity = activityFor(slot);\n    activity.at = at;\n    activity.kind = successes.has(slot)\n      ? "success"\n      : sightingNearSlot(slot, message?.sightings) ? "sighting" : "miss";\n  }''',
    "classify actual recovery outcome"
)
replace_once(
    overlay,
    '''function outerQuad(value) {\n  const cols = Number(value?.layout?.cols);\n  const rows = Number(value?.layout?.rows);\n  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return null;\n  const quad = {\n    topLeft: value.slots?.[0]?.quad?.topLeft,\n    topRight: value.slots?.[cols - 1]?.quad?.topRight,\n    bottomLeft: value.slots?.[(rows - 1) * cols]?.quad?.bottomLeft,\n    bottomRight: value.slots?.[rows * cols - 1]?.quad?.bottomRight\n  };\n  return validQuad(quad) ? quad : null;\n}''',
    '''function outerQuad(value) {\n  const points = [];\n  for (const slot of value?.slots || []) {\n    if (!validQuad(slot?.quad)) continue;\n    points.push(slot.quad.topLeft, slot.quad.topRight, slot.quad.bottomRight, slot.quad.bottomLeft);\n  }\n  if (points.length < 4) return null;\n  const by = (score, preferMin) => points.reduce((best, point) => {\n    if (!best) return point;\n    return (preferMin ? score(point) < score(best) : score(point) > score(best)) ? point : best;\n  }, null);\n  const quad = {\n    topLeft: by((p) => p.x + p.y, true),\n    topRight: by((p) => p.x - p.y, false),\n    bottomRight: by((p) => p.x + p.y, false),\n    bottomLeft: by((p) => p.x - p.y, true)\n  };\n  return validQuad(quad) ? quad : null;\n}''',
    "orientation independent wall quad"
)
replace_once(
    overlay,
    '''  const vw = video.videoWidth;\n  const vh = video.videoHeight;\n  if (!cw || !ch || !vw || !vh) return;''',
    '''  const decoderSize = globalThis.__airgapperDecoderDisplaySize?.();\n  const vw = Number(decoderSize?.width) || video.videoWidth;\n  const vh = Number(decoderSize?.height) || video.videoHeight;\n  if (!cw || !ch || !vw || !vh) return;''',
    "decoder coordinate space"
)
replace_once(
    overlay,
    '''  for (const slot of value.slots) {\n    const missAt = slotActivity.get(slot.index)?.missAt ?? -Infinity;\n    const missAge = at - missAt;\n    if (missAge < 0 || missAge >= MISS_FADE_MS || !validQuad(slot.quad)) continue;\n    const t = 1 - missAge / MISS_FADE_MS;\n    ctx.save();\n    pathQuad(slot.quad, scale, offX, offY);\n    ctx.fillStyle = `rgba(255, 48, 64, ${0.025 + 0.085 * t})`;\n    ctx.strokeStyle = `rgba(255, 56, 72, ${0.12 + 0.42 * t})`;\n    ctx.lineWidth = Math.max(1, (1 + 0.45 * t) * dpr);\n    ctx.fill();\n    ctx.stroke();\n    ctx.restore();\n  }''',
    '''  for (const slot of value.slots) {\n    const activity = slotActivity.get(slot.index);\n    const kind = activity?.kind || "miss";\n    const fade = PROBE_FADE_MS[kind] || PROBE_FADE_MS.miss;\n    const age = at - (activity?.at ?? -Infinity);\n    if (age < 0 || age >= fade || !validQuad(slot.quad)) continue;\n    const t = 1 - age / fade;\n    const palette = kind === "success"\n      ? { fill: [41, 197, 105], stroke: [38, 211, 111] }\n      : kind === "sighting"\n        ? { fill: [255, 177, 43], stroke: [255, 180, 45] }\n        : { fill: [255, 48, 64], stroke: [255, 56, 72] };\n    ctx.save();\n    pathQuad(slot.quad, scale, offX, offY);\n    ctx.fillStyle = `rgba(${palette.fill.join(",")}, ${0.025 + 0.085 * t})`;\n    ctx.strokeStyle = `rgba(${palette.stroke.join(",")}, ${0.14 + 0.48 * t})`;\n    ctx.lineWidth = Math.max(1, (1 + 0.5 * t) * dpr);\n    ctx.fill();\n    ctx.stroke();\n    ctx.restore();\n  }''',
    "colored recovery outcomes"
)

current = version.read_text()
if 'APP_VERSION = "0.5.461"' not in current:
    raise SystemExit("expected v0.5.461 before bump")
version.write_text(current.replace('APP_VERSION = "0.5.461"', 'APP_VERSION = "0.5.462"', 1))
