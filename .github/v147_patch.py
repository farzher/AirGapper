from pathlib import Path

root = Path('.')
main = root / 'receive/main.js'

s = main.read_text()
assert 'const RECEIVER_RUNTIME_BUILD = "v0.5.145";' in s
s = s.replace('const RECEIVER_RUNTIME_BUILD = "v0.5.145";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.147";', 1)

old = '''const GUIDED_MIN_TRACKS = 6;\nconst guidedRollout = {\n  state: "warmup",\n  inFlight: 0,\n  failures: 0,\n  rampGood: 0,\n  badStreak: 0,\n  robustSinceRetry: 0,\n  robustLatencies: []\n};'''
new = '''const GUIDED_MIN_TRACKS = 6;\nconst GUIDED_ROBUST_SCOUT_EVERY = 12;\nconst GUIDED_ROBUST_SCOUT_BAD_EVERY = 4;\nconst guidedRollout = {\n  state: "active",\n  inFlight: 0,\n  failures: 0,\n  rampGood: 0,\n  badStreak: 0,\n  robustSinceRetry: 0,\n  jobsSinceRobust: 0,\n  robustLatencies: []\n};'''
assert old in s
s = s.replace(old, new, 1)

old = '''function resetGuidedRollout() {\n  guidedRollout.state = "warmup";\n  guidedRollout.inFlight = 0;\n  guidedRollout.failures = 0;\n  guidedRollout.rampGood = 0;\n  guidedRollout.badStreak = 0;\n  guidedRollout.robustSinceRetry = 0;\n  guidedRollout.robustLatencies.length = 0;\n}'''
new = '''function resetGuidedRollout() {\n  guidedRollout.state = "active";\n  guidedRollout.inFlight = 0;\n  guidedRollout.failures = 0;\n  guidedRollout.rampGood = 0;\n  guidedRollout.badStreak = 0;\n  guidedRollout.robustSinceRetry = 0;\n  guidedRollout.jobsSinceRobust = 0;\n  guidedRollout.robustLatencies.length = 0;\n}'''
assert old in s
s = s.replace(old, new, 1)

start = s.index('function chooseGuidedStage(message) {')
end = s.index('\nfunction noteGuidedRobustBaseline', start)
old = s[start:end]
new = '''function chooseGuidedStage(message) {\n  if (message.full || message.strictHotPath || message.pixelFormat !== "y8" || !Array.isArray(message.tracks) || message.tracks.length < GUIDED_MIN_TRACKS)\n    return "";\n\n  // On the OP12R production trace, guided decoded 326 symbols in 56 jobs while\n  // consuming only ~3.3 worker-seconds; dense robust consumed ~100 worker-\n  // seconds. Guided is the production decoder now, not a speculative rollout.\n  // Keep one occasional dense scout for independent recovery/evidence, and\n  // increase that scout cadence only after several zero-output guided frames.\n  const robustInFlight = pool.activeJobs.reduce((count, job) => {\n    if (job.id === void 0) return count;\n    const mode = hotPathJobMode.get(job.id);\n    return count + Number(mode && !mode.full && !mode.guided);\n  }, 0);\n  const scoutEvery = guidedRollout.badStreak >= 3\n    ? GUIDED_ROBUST_SCOUT_BAD_EVERY\n    : GUIDED_ROBUST_SCOUT_EVERY;\n  guidedRollout.jobsSinceRobust++;\n  if (guidedRollout.jobsSinceRobust >= scoutEvery && robustInFlight === 0) {\n    guidedRollout.jobsSinceRobust = 0;\n    return "";\n  }\n\n  guidedRollout.state = "active";\n  guidedRollout.inFlight++;\n  message.guidedDecode = true;\n  return "active";\n}'''
s = s[:start] + new + s[end:]

start = s.index('function noteGuidedCompletion(stage, outputSymbols, tracks, latencyMs) {')
end = s.index('\nconst livePipeline = {', start)
old = s[start:end]
new = '''function noteGuidedCompletion(stage, outputSymbols, tracks, latencyMs) {\n  guidedRollout.inFlight = Math.max(0, guidedRollout.inFlight - 1);\n  if (!stage) return;\n  // Do not demote a low-latency decoder merely because one animated display\n  // frame produced few symbols. A zero-output guided frame is cheap (~10-60ms\n  // in the measured run); dense robust frames are the expensive 0.2-2s events.\n  // Generic lattice recovery plus the single robust scout provide the escape\n  // hatch, while normal camera frames stay on the bounded guided path.\n  if (outputSymbols > 0) {\n    guidedRollout.badStreak = 0;\n    guidedRollout.rampGood++;\n  } else {\n    guidedRollout.badStreak++;\n    guidedRollout.failures++;\n  }\n  guidedRollout.state = "active";\n}'''
s = s[:start] + new + s[end:]
main.write_text(s)

# Product build labels.
for name in ['index.html', 'main.js']:
    p = root / name
    text = p.read_text()
    assert 'v0.5.146' in text, name
    p.write_text(text.replace('v0.5.146', 'v0.5.147'))

sw = root / 'sw.js'
text = sw.read_text()
assert 'airgapper-static-js-v109' in text
sw.write_text(text.replace('airgapper-static-js-v109', 'airgapper-static-js-v110', 1))

# The previous v146 product patch intentionally changed worker.js; v147 changes
# scheduling only and leaves that bounded robust implementation intact.
worker = (root / 'receive/worker.js').read_text()
assert 'const ROBUST_BATCH_MAX_RESULTS = 8;' in worker
assert 'if (guidedDecode && decodePixelFormat === "y8" && tracks.length >= 6)' in worker
