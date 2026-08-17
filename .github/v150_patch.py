from pathlib import Path

root = Path('.')
main = root / 'receive/main.js'
s = main.read_text()

# v149 changed lattice behavior but accidentally left the public build/cache at
# v148. v150 deliberately rolls both changes into one unambiguous PWA build.
assert 'const RECEIVER_RUNTIME_BUILD = "v0.5.148";' in s
s = s.replace('const RECEIVER_RUNTIME_BUILD = "v0.5.148";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.150";', 1)

old = '''const AUTO_OPTICS_SHUTTER_FRAME_FRACTION = 0.30;\nlet autoOpticsRuntimeState = "ae";'''
new = '''const AUTO_OPTICS_SHUTTER_FRAME_FRACTION = 0.30;\n// After the motion-safe shutter handoff, tune gain against the decoder itself.\n// Hardware AE is inconsistent on an animated emissive QR wall: the same phone\n// has chosen 10 ms / ISO 100 and 10 ms / ISO 200 on adjacent runs, while the\n// latter sustained roughly 2-3x more useful throughput. Keep the shutter fixed\n// for motion, then spend a short one-time window finding the useful gain.\nconst AUTO_OPTICS_GAIN_SETTLE_MS = 340;\nconst AUTO_OPTICS_GAIN_SAMPLE_MS = 520;\nconst AUTO_OPTICS_GAIN_MIN_ATTEMPTS = 12;\nconst AUTO_OPTICS_GAIN_IMPROVEMENT = 1.03;\nlet autoOpticsTuneSummary = "";\nlet autoOpticsRuntimeState = "ae";'''
assert old in s
s = s.replace(old, new, 1)

old = '''  autoOpticsRuntimeState = "ae";\n  autoOpticsMutationRunning = false;\n  autoOpticsLockSince = 0;\n  autoOpticsRetryAt = 0;'''
new = '''  autoOpticsRuntimeState = "ae";\n  autoOpticsMutationRunning = false;\n  autoOpticsLockSince = 0;\n  autoOpticsRetryAt = 0;\n  autoOpticsTuneSummary = "";'''
assert old in s
s = s.replace(old, new, 1)

needle = '''function quantizeCameraRange(value, range) {\n  const clamped = Math.max(range.min, Math.min(range.max, value));\n  if (!range.step || range.step <= 0) return clamped;\n  return Math.max(range.min, Math.min(range.max,\n    range.min + Math.round((clamped - range.min) / range.step) * range.step\n  ));\n}\n'''
assert needle in s
helpers = needle + '''function automaticOpticsSessionAlive(track) {\n  return automaticOptics && !done && track?.readyState === "live" && stream?.getVideoTracks()[0] === track;\n}\nfunction autoOpticsPipelineSnapshot() {\n  return {\n    at: receiverNow(),\n    outputs: Number(livePipeline?.trackedOutputSymbols || 0),\n    attempts: Number(livePipeline?.submittedTracks || 0),\n    jobs: Number(livePipeline?.submittedTracked || 0)\n  };\n}\nasync function waitForAutoOptics(ms, track) {\n  const until = performance.now() + ms;\n  while (performance.now() < until) {\n    if (!automaticOpticsSessionAlive(track)) return false;\n    await new Promise((resolve) => setTimeout(resolve, Math.min(40, Math.max(1, until - performance.now()))));\n  }\n  return automaticOpticsSessionAlive(track);\n}\nasync function measureAutomaticIsoCandidate(track, exposure, requestedIso, isoRange) {\n  if (!automaticOpticsSessionAlive(track)) return null;\n  const iso = quantizeCameraRange(requestedIso, isoRange);\n  const accepted = await applyCameraConstraint(track, {\n    exposureMode: "manual",\n    exposureTime: exposure,\n    iso\n  });\n  if (!accepted || !automaticOpticsSessionAlive(track)) return null;\n\n  // Do not fence/discard worker jobs. Let pre-mutation work finish naturally,\n  // then measure only after roughly a tracked p95 worth of time has elapsed.\n  if (!await waitForAutoOptics(AUTO_OPTICS_GAIN_SETTLE_MS, track)) return null;\n  const before = autoOpticsPipelineSnapshot();\n  if (!await waitForAutoOptics(AUTO_OPTICS_GAIN_SAMPLE_MS, track)) return null;\n  const after = autoOpticsPipelineSnapshot();\n  const elapsed = Math.max(0.001, (after.at - before.at) / 1e3);\n  const outputs = Math.max(0, after.outputs - before.outputs);\n  const attempts = Math.max(0, after.attempts - before.attempts);\n  const jobs = Math.max(0, after.jobs - before.jobs);\n  const rate = outputs / elapsed;\n  const yieldRate = attempts ? outputs / attempts : 0;\n  // Actual throughput is primary. Yield provides a small stabilizer if framing\n  // changes slightly during the short calibration window.\n  const score = rate * (0.8 + 0.2 * Math.max(0, Math.min(1, yieldRate)));\n  const actualIso = Number(track.getSettings().iso);\n  return {\n    iso: Number.isFinite(actualIso) ? actualIso : iso,\n    requestedIso: iso, outputs, attempts, jobs, rate, yieldRate, score,\n    valid: attempts >= AUTO_OPTICS_GAIN_MIN_ATTEMPTS && jobs >= 2\n  };\n}\nfunction describeAutoIsoProbe(probe) {\n  if (!probe) return "—";\n  if (!probe.valid) return `${Math.round(probe.iso)}:insufficient`;\n  return `${Math.round(probe.iso)}:${probe.rate.toFixed(0)}/s ${(probe.yieldRate * 100).toFixed(0)}%`;\n}\nasync function tuneAutomaticQrIso(track, exposure, baseIso, isoRange, maxAutoIso) {\n  if (!automaticIsoAxis || !automaticOpticsSessionAlive(track)) return { iso: baseIso, probes: [] };\n  autoOpticsRuntimeState = "tuning";\n  autoOpticsTuneSummary = "calibrating ISO";\n\n  const cap = Math.max(isoRange.min, Math.min(isoRange.max, maxAutoIso));\n  const base = quantizeCameraRange(Math.min(cap, baseIso), isoRange);\n  const probes = [];\n  const measured = new Set();\n  const probe = async (candidate) => {\n    const requested = quantizeCameraRange(Math.min(cap, Math.max(isoRange.min, candidate)), isoRange);\n    const key = String(requested);\n    if (measured.has(key)) return probes.find((item) => String(item.requestedIso) === key) || null;\n    measured.add(key);\n    const result = await measureAutomaticIsoCandidate(track, exposure, requested, isoRange);\n    if (result) probes.push(result);\n    autoOpticsTuneSummary = probes.map(describeAutoIsoProbe).join(" · ");\n    return result;\n  };\n\n  const baseline = await probe(base);\n  if (!automaticOpticsSessionAlive(track)) return { iso: base, probes };\n  const brighter = await probe(base * 2);\n  if (!automaticOpticsSessionAlive(track)) return { iso: base, probes };\n\n  const baselineScore = baseline?.valid ? baseline.score : 0;\n  const brighterScore = brighter?.valid ? brighter.score : 0;\n  if (brighterScore > baselineScore * AUTO_OPTICS_GAIN_IMPROVEMENT)\n    await probe(base * Math.SQRT2);\n  else\n    await probe(base / Math.SQRT2);\n\n  const valid = probes.filter((item) => item.valid);\n  const best = valid.length\n    ? valid.reduce((winner, item) => item.score > winner.score ? item : winner)\n    : baseline || brighter || { iso: base, requestedIso: base, rate: 0, yieldRate: 0, score: 0 };\n  const finalIso = quantizeCameraRange(Math.min(cap, best.iso || best.requestedIso || base), isoRange);\n  if (automaticOpticsSessionAlive(track)) {\n    const actual = Number(track.getSettings().iso);\n    const step = Number(isoRange.step) || 0;\n    if (!Number.isFinite(actual) || Math.abs(actual - finalIso) > Math.max(step * 0.75, finalIso * 0.02))\n      await applyCameraConstraint(track, { exposureMode: "manual", exposureTime: exposure, iso: finalIso });\n  }\n  autoOpticsTuneSummary = `${probes.map(describeAutoIsoProbe).join(" · ")} → ${Math.round(finalIso)}`;\n  return { iso: finalIso, probes, best };\n}\n'''
s = s.replace(needle, helpers, 1)

old = '''    autoOpticsRuntimeState = "manual";\n    // Automatic optics is intentionally one-way for this camera session.\n    // Continuous AE reacts to the animated QR wall itself and repeatedly moves\n    // a scene that decodes better when held still. Once we have a verified QR\n    // lock, keep this manual exposure through ordinary loss/reacquisition.\n    autoOpticsRetryAt = Infinity;\n    preferredExposureTime = track.getSettings().exposureTime ?? exposure;\n    preferredIso = track.getSettings().iso ?? iso;\n    focusController.adoptAutomaticCameraState("automatic QR exposure settled to motion-safe shutter + ISO");'''
new = '''    const tuned = await tuneAutomaticQrIso(track, exposure, iso, isoRange, maxAutoIso);\n    if (!automaticOpticsSessionAlive(track)) return;\n    autoOpticsRuntimeState = "manual";\n    // Automatic optics is intentionally one-way for this camera session.\n    // Continuous AE reacts to the animated QR wall itself and repeatedly moves\n    // a scene that decodes better when held still. Once we have a verified QR\n    // lock, keep this manual exposure through ordinary loss/reacquisition.\n    autoOpticsRetryAt = Infinity;\n    preferredExposureTime = track.getSettings().exposureTime ?? exposure;\n    preferredIso = track.getSettings().iso ?? tuned.iso ?? iso;\n    saveCameraSettings();\n    focusController.adoptAutomaticCameraState("automatic QR exposure tuned against live tracked decode yield");'''
assert old in s
s = s.replace(old, new, 1)

old = '''    `AutoOptics ${automaticOptics ? autoOpticsRuntimeState : "off"}${autoOpticsRuntimeState === "manual" ? " · locked for session" : autoOpticsRuntimeState === "ae" ? " · bootstrap AE" : ""}`,'''
new = '''    `AutoOptics ${automaticOptics ? autoOpticsRuntimeState : "off"}${autoOpticsRuntimeState === "manual" ? " · locked for session" : autoOpticsRuntimeState === "ae" ? " · bootstrap AE" : autoOpticsRuntimeState === "tuning" ? " · live ISO search" : ""}${autoOpticsTuneSummary ? ` · ${autoOpticsTuneSummary}` : ""}`,'''
assert old in s
s = s.replace(old, new, 1)
main.write_text(s)

for name in ['index.html', 'main.js']:
    p = root / name
    text = p.read_text()
    assert 'v0.5.148' in text, name
    p.write_text(text.replace('v0.5.148', 'v0.5.150'))

sw = root / 'sw.js'
text = sw.read_text()
assert 'airgapper-static-js-v111' in text
sw.write_text(text.replace('airgapper-static-js-v111', 'airgapper-static-js-v112', 1))

# v149's lattice behavior must be part of this cache-visible release.
lattice = (root / 'receive/grid-lattice.js').read_text()
assert 'const OBSERVATION_HISTORY_MS = 2500;' in lattice
assert 'const CURRENT_FIT_MS = 420;' in lattice
assert 'const EXACT_GEOMETRY_MS = 420;' in lattice
