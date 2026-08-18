from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f'{path}: patch anchor missing')
    p.write_text(text.replace(old, new, 1))

# Startup timings must be one-shot timestamps. The rolling 1-second metric arrays
# are intentionally pruned, so their index 0 cannot represent session startup.
replace_once(
    'receive/main.js',
    'const captureTimes = [];\nconst qrReadTimes = [];',
    'const captureTimes = [];\nlet startupFirstCaptureAt = 0;\nlet startupFirstJobAt = 0;\nlet startupFirstQrAt = 0;\nconst qrReadTimes = [];'
)
replace_once(
    'receive/main.js',
    '  captureTimes.push(now);\n  workerLoadSamples.push({ at: now, busy: pool.busyCount, size: pool.size });',
    '  if (!startupFirstCaptureAt) startupFirstCaptureAt = now;\n  captureTimes.push(now);\n  workerLoadSamples.push({ at: now, busy: pool.busyCount, size: pool.size });'
)
replace_once(
    'receive/main.js',
    '    const submittedAt = receiverNow();\n    if (!replayRunning && livePipeline.startedAt) {',
    '    const submittedAt = receiverNow();\n    if (!startupFirstJobAt) startupFirstJobAt = submittedAt;\n    if (!replayRunning && livePipeline.startedAt) {'
)
replace_once(
    'receive/main.js',
    '  const decodedAt = receiverNow();\n  if (done) return;\n  qrReadTimes.push(decodedAt);',
    '  const decodedAt = receiverNow();\n  if (done) return;\n  if (!startupFirstQrAt) startupFirstQrAt = decodedAt;\n  qrReadTimes.push(decodedAt);'
)
replace_once(
    'receive/main.js',
    'function resetLivePipeline(now = receiverNow()) {\n  Object.assign(livePipeline, {',
    'function resetLivePipeline(now = receiverNow()) {\n  startupFirstCaptureAt = 0;\n  startupFirstJobAt = 0;\n  startupFirstQrAt = 0;\n  Object.assign(livePipeline, {'
)
replace_once(
    'receive/main.js',
    '  const startupBase = framePumpStartedAt || cameraStartedTs;\n  const firstCaptureAt = captureTimes[0] ?? 0;\n  const firstJobAt = hotJobSubmitSamples[0]?.at ?? 0;\n  const firstQrAt = qrReadTimes[0] ?? 0;\n  const startupMs = (at) => startupBase && at ? Math.max(0, at - startupBase) : null;',
    '  const startupBase = framePumpStartedAt || cameraStartedTs;\n  const firstCaptureAt = startupFirstCaptureAt;\n  const firstJobAt = startupFirstJobAt;\n  const firstQrAt = startupFirstQrAt;\n  const startupMs = (at) => startupBase && at ? Math.max(0, at - startupBase) : null;'
)

for path in ['main.js', 'receive/main.js', 'index.html']:
    replace_once(path, 'v0.5.253', 'v0.5.254')
replace_once('sw.js', 'airgapper-static-js-v209', 'airgapper-static-js-v210')
