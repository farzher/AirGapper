from pathlib import Path

root = Path('.')
main = root / 'receive/main.js'
s = main.read_text()

assert 'const RECEIVER_RUNTIME_BUILD = "v0.5.152";' in s
s = s.replace('const RECEIVER_RUNTIME_BUILD = "v0.5.152";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.153";', 1)

# Preserve the camera source sequence through the worker pool. DecodeWorkerPool
# already records these fields, but submitReceiverJob never put them on the
# message, leaving all duplicate attribution in the unknown bucket.
old = '''  message.jobKind = kind;\n  message.trackCount = auditMode.tracks;\n  const accepted = preferredWorker === void 0 ? pool.submit(message, transfer) : pool.submitTo(preferredWorker, message, transfer);'''
new = '''  message.jobKind = kind;\n  message.trackCount = auditMode.tracks;\n  message.sourceSequence = sourceSequence;\n  if (sourceOpticsEpoch !== void 0) message.opticsEpoch = sourceOpticsEpoch;\n  const accepted = preferredWorker === void 0 ? pool.submit(message, transfer) : pool.submitTo(preferredWorker, message, transfer);'''
assert old in s
s = s.replace(old, new, 1)

# When all workers are momentarily occupied, keep exactly one newest direct
# VideoFrame instead of dropping every camera opportunity. The existing
# pending-lane holder already has the desired ownership semantics: replacing a
# pending frame closes the older clone, and worker availability drains it. In
# normal production we use lane 0 with laneCount=1, so any free worker can take
# it and queue depth can never exceed one.
old = '''      if (healthyGrid && freeWorkers === 0) {\n        poolBusyTimes.push(now);\n        if (trace) trace.decision = "not scheduled: workers busy";\n        activeBenchmarkFrame = void 0;\n        return;\n      }'''
new = '''      if (healthyGrid && freeWorkers === 0) {\n        const bufferedLatest = !strictHotPathActive() && queuePendingGridLane(0, source, {\n          x, y, w, h,\n          tracks: batchTracks,\n          regions: batchRegions,\n          sourceSequence: source.sequence,\n          laneCount: 1,\n          strictHotPath: false\n        });\n        poolBusyTimes.push(now);\n        if (bufferedLatest) notePipelineEvent("latest-frame-buffered", source.sequence);\n        if (trace) trace.decision = bufferedLatest ? "latest frame buffered: workers busy" : "not scheduled: workers busy";\n        activeBenchmarkFrame = void 0;\n        return;\n      }'''
assert old in s
s = s.replace(old, new, 1)

# The same replacement counter now also covers the production latest-frame
# reservoir, so give the diagnostic a mode-neutral name.
s = s.replace('lane replacements', 'latest replacements')

main.write_text(s)

for name in ['index.html', 'main.js']:
    p = root / name
    text = p.read_text()
    assert 'v0.5.152' in text, name
    p.write_text(text.replace('v0.5.152', 'v0.5.153'))

sw = root / 'sw.js'
text = sw.read_text()
assert 'airgapper-static-js-v114' in text
sw.write_text(text.replace('airgapper-static-js-v114', 'airgapper-static-js-v115', 1))
