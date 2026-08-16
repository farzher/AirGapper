from pathlib import Path

root = Path('.')
main = root / 'receive/main.js'
worker = root / 'receive/worker.js'

s = main.read_text()
old = '''  autoOpticsMutationRunning = true;\n  autoOpticsRuntimeState = "settling";\n  holdDecoderForCameraMutation("automatic QR optics settling", 280);\n  try {'''
new = '''  autoOpticsMutationRunning = true;\n  autoOpticsRuntimeState = "settling";\n  // Exposure changes do not invalidate already captured QR payloads or lattice\n  // geometry. Keep decoding through the one-time AE -> manual handoff instead\n  // of throwing away work and restarting every worker. The HAL may emit a few\n  // transitional frames; those are ordinary erasures and RaptorQ can absorb\n  // them without an artificial receiver blackout.\n  notePipelineEvent("auto-optics-seamless-handoff");\n  try {'''
assert old in s
s = s.replace(old, new, 1)

old = '''  const minOutput = Math.max(2, Math.ceil(Math.max(1, tracks) / 3));'''
new = '''  // Guided decode is dramatically cheaper than dense robust search. Requiring\n  // one third of a large wall made a 4/15 guided result fail rollout even when\n  // it completed in a few tens of milliseconds. Four fresh symbols per frame\n  // is already a strong throughput contribution; let the fast path stay active.\n  const minOutput = Math.max(2, Math.ceil(Math.max(1, tracks) / 4));'''
assert old in s
s = s.replace(old, new, 1)

# Version bumps.
for name in ['index.html', 'main.js', 'receive/main.js']:
    p = root / name
    text = p.read_text()
    assert 'v0.5.145' in text, name
    p.write_text(text.replace('v0.5.145', 'v0.5.146'))
main.write_text(s)

w = worker.read_text()
# Dense robust search beyond eight symbols has poor marginal value at 30 fps:\n# eight useful QRs/frame is already ~240 QR/s and roughly the observed 0.7 MB/s\n# ceiling, while 15-18-symbol searches create 0.5-2.7 s latency tails.
w = w.replace('const NATIVE_BATCH_MAX_TRACKS = 18;', 'const NATIVE_BATCH_MAX_TRACKS = 18;\nconst ROBUST_BATCH_MAX_RESULTS = 8;', 1)
old = '''      const robustMax = Math.min(NATIVE_BATCH_MAX_TRACKS, Math.max(1, tracks.length));'''
new = '''      const robustMax = Math.min(ROBUST_BATCH_MAX_RESULTS, Math.max(1, tracks.length));'''
assert old in w
w = w.replace(old, new, 1)
old = '''      const recoveryMax = Math.min(NATIVE_BATCH_MAX_TRACKS, Math.max(1, tracks.length));'''
new = '''      const recoveryMax = Math.min(ROBUST_BATCH_MAX_RESULTS, Math.max(1, tracks.length));'''
assert old in w
w = w.replace(old, new, 1)
worker.write_text(w)

sw = root / 'sw.js'
text = sw.read_text()
assert 'airgapper-static-js-v107' in text
sw.write_text(text.replace('airgapper-static-js-v107', 'airgapper-static-js-v108', 1))
