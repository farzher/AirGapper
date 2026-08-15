from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    text = p.read_text()
    n = text.count(old)
    if n != count:
        raise SystemExit(f"{path}: expected {count} matches, got {n}: {old[:100]!r}")
    p.write_text(text.replace(old, new, count))

# Version/cache.
replace("index.html", "v0.5.54", "v0.5.55")
replace("sw.js", "airgapper-static-js-v17", "airgapper-static-js-v18")
replace("vendor/decimen-codec/source/VERSION", "0.1.2", "0.1.3")

# The anchor is a cheap geometry refinement, not a validity oracle. A low
# finder score must not reject a known tracked QR before the sampled matrix +
# CRC gets a chance to validate it. Preserve the last trusted translation when
# refinement is not confident, sample anyway, and count whether bypassed
# anchors subsequently CRC-validate.
replace(
    "vendor/decimen-codec/source/wrapper/decimen_codec.h",
    "\tuint32_t multiSampleRetries;\n};",
    "\tuint32_t multiSampleRetries;\n\tuint32_t anchorBypassAttempts;\n\tuint32_t anchorBypassSuccesses;\n};"
)

cpp = Path("vendor/decimen-codec/source/wrapper/decimen_codec.cpp")
text = cpp.read_text()
old = '''\t\tAnchorReading anchor;\n\t\tdouble started = emscripten_get_now();\n\t\tbool anchored = refineAnchor(track, lumAt, anchor);\n\t\tmeasured.anchorMs += emscripten_get_now() - started;\n\t\tif (!anchored) {\n\t\t\t++track.consecutiveMisses;\n\t\t\t++measured.misses;\n\t\t\t++measured.anchorMisses;\n\t\t\tresult.consecutiveMisses = track.consecutiveMisses;\n\t\t\tresult.framesSinceReacquire = track.framesSinceReacquire;\n\t\t\tcontinue;\n\t\t}\n\n\t\t++measured.anchorSuccesses;\n'''
new = '''\t\tAnchorReading anchor;\n\t\tconst float trustedDx = track.dx, trustedDy = track.dy;\n\t\tdouble started = emscripten_get_now();\n\t\tconst bool anchored = refineAnchor(track, lumAt, anchor);\n\t\tmeasured.anchorMs += emscripten_get_now() - started;\n\t\tif (anchored) {\n\t\t\t++measured.anchorSuccesses;\n\t\t} else {\n\t\t\t// Finder scoring is only a cheap motion/refinement heuristic. The\n\t\t\t// cached geometry can still be exact even when raw camera luminance\n\t\t\t// makes the 7x7 finder template score poorly. Do not reject the QR\n\t\t\t// before sampling it; restore the last trusted translation and let\n\t\t\t// the no-RS bitstream + CRC be the correctness oracle.\n\t\t\t++measured.anchorMisses;\n\t\t\t++measured.anchorBypassAttempts;\n\t\t\ttrack.dx = trustedDx;\n\t\t\ttrack.dy = trustedDy;\n\t\t}\n'''
if text.count(old) != 1:
    raise SystemExit("anchor rejection block not found")
text = text.replace(old, new)
old2 = '''\t\tif (packet.empty()) {\n\t\t\t++track.consecutiveMisses;'''
new2 = '''\t\tif (!packet.empty() && !anchored)\n\t\t\t++measured.anchorBypassSuccesses;\n\n\t\tif (packet.empty()) {\n\t\t\t++track.consecutiveMisses;'''
if text.count(old2) != 1:
    raise SystemExit("packet miss block not found")
text = text.replace(old2, new2)
cpp.write_text(text)

# WASM metrics struct grew by 8 bytes. Echo bypass counters into JS.
replace("receive/worker.js", "const NATIVE_BATCH_METRICS_BYTES = 104;", "const NATIVE_BATCH_METRICS_BYTES = 112;")
replace(
    "receive/worker.js",
    '''    crcFailures: view.getUint32(nativeMetricsPtr + 92, true),\n    multiSampleRetries: view.getUint32(nativeMetricsPtr + 96, true)\n''',
    '''    crcFailures: view.getUint32(nativeMetricsPtr + 92, true),\n    multiSampleRetries: view.getUint32(nativeMetricsPtr + 96, true),\n    anchorBypassAttempts: view.getUint32(nativeMetricsPtr + 100, true),\n    anchorBypassSuccesses: view.getUint32(nativeMetricsPtr + 104, true)\n'''
)
replace(
    "receive/worker.js",
    '''  const metricsPtr = zx._malloc(NATIVE_BATCH_METRICS_BYTES);''',
    '''  const metricsPtr = zx._malloc(NATIVE_BATCH_METRICS_BYTES);'''
)
# Audit RGBA metric reader needs no new fields for the one-shot A/B.

main = Path("receive/main.js")
text = main.read_text()
# Keep audit counters from jobs submitted under a previous toggle state out of
# the freshly-reset audit. This fixes LIVE jobs completing after Strict is
# checked and repopulating Strict counters.
old3 = '''let strictHotPathEnabled = false;\nlet strictHotPathLockSeen = false;\nstrictHotPathToggle.addEventListener("change", () => {\n  strictHotPathEnabled = strictHotPathToggle.checked;\n  strictHotPathLockSeen = false;\n  resetHotPathAudit();\n});'''
new3 = '''let strictHotPathEnabled = false;\nlet strictHotPathLockSeen = false;\nlet hotPathAuditGeneration = 0;\nconst hotPathJobMode = new Map();\nstrictHotPathToggle.addEventListener("change", () => {\n  strictHotPathEnabled = strictHotPathToggle.checked;\n  strictHotPathLockSeen = false;\n  hotPathAuditGeneration++;\n  resetHotPathAudit();\n});'''
if text.count(old3) != 1:
    raise SystemExit("strict toggle block not found")
text = text.replace(old3, new3)

old4 = '''function submitReceiverJob(message, transfer, kind, trace, sourceSequence, trackedRegions = [], fixedAttempts = 0, sourceOpticsEpoch, preferredWorker) {\n  const accepted = preferredWorker === void 0 ? pool.submit(message, transfer) : pool.submitTo(preferredWorker, message, transfer);\n  if (accepted) {'''
new4 = '''function submitReceiverJob(message, transfer, kind, trace, sourceSequence, trackedRegions = [], fixedAttempts = 0, sourceOpticsEpoch, preferredWorker) {\n  const auditMode = { generation: hotPathAuditGeneration, strict: Boolean(message.strictHotPath) };\n  const accepted = preferredWorker === void 0 ? pool.submit(message, transfer) : pool.submitTo(preferredWorker, message, transfer);\n  if (accepted) {\n    hotPathJobMode.set(message.id, auditMode);'''
if text.count(old4) != 1:
    raise SystemExit("submitReceiverJob header not found")
text = text.replace(old4, new4)

# Capture mode before maps are deleted, and only accumulate the live audit for
# jobs submitted in the current generation/mode.
old5 = '''function noteDecodeCompleted(id, completion) {\n  var _a;\n  const benchmarkTrace = benchmarkJobFrames.get(id);'''
new5 = '''function noteDecodeCompleted(id, completion) {\n  var _a;\n  const auditMode = hotPathJobMode.get(id);\n  hotPathJobMode.delete(id);\n  const auditThisCompletion = Boolean(\n    auditMode &&\n    auditMode.generation === hotPathAuditGeneration &&\n    auditMode.strict === strictHotPathEnabled\n  );\n  const benchmarkTrace = benchmarkJobFrames.get(id);'''
if text.count(old5) != 1:
    raise SystemExit("noteDecodeCompleted header not found")
text = text.replace(old5, new5)

# Wrap the live hotPathAudit updates as a single mode-consistent section.
start = '''  if (completion.nativeMetrics) {\n    lastNativeMetrics = { ...completion.nativeMetrics, frameCopyMs: completion.frameCopyMs };\n    hotPathAudit.trackedJobs++;'''
if text.count(start) != 1:
    raise SystemExit("native audit accumulation start not found")
text = text.replace(start, '''  if (completion.nativeMetrics) {\n    lastNativeMetrics = { ...completion.nativeMetrics, frameCopyMs: completion.frameCopyMs };\n  }\n  if (auditThisCompletion && completion.nativeMetrics) {\n    hotPathAudit.trackedJobs++;''', 1)
# local/full/readFull/pixel audit updates sit after the native block. Guard the
# independent completion-level audit section as well by inserting conditions.
text = text.replace('''  if (completion.pixelAudit) {\n    hotPathAudit.pixelAuditTracks''', '''  if (auditThisCompletion && completion.pixelAudit) {\n    hotPathAudit.pixelAuditTracks''', 1)
text = text.replace('''  if (completion.fallbackAttempted) {\n    hotPathAudit.localRecoveryAttempts++;''', '''  if (auditThisCompletion && completion.fallbackAttempted) {\n    hotPathAudit.localRecoveryAttempts++;''', 1)
text = text.replace('''  if (completion.full) {\n    hotPathAudit.fullScanJobs++;''', '''  if (auditThisCompletion && completion.full) {\n    hotPathAudit.fullScanJobs++;''', 1)
# readFull can be updated separately.
text = text.replace('''  hotPathAudit.readFullAttempts += completion.readFullAttempts ?? 0;''', '''  if (auditThisCompletion) hotPathAudit.readFullAttempts += completion.readFullAttempts ?? 0;''', 1)

# Add bypass counters to audit state/accumulation/UI.
text = text.replace('''  multiSampleRetries: 0,\n  pixelAuditTracks:''', '''  multiSampleRetries: 0,\n  anchorBypassAttempts: 0,\n  anchorBypassSuccesses: 0,\n  pixelAuditTracks:''', 1)
text = text.replace('''    hotPathAudit.multiSampleRetries += completion.nativeMetrics.multiSampleRetries ?? 0;''', '''    hotPathAudit.multiSampleRetries += completion.nativeMetrics.multiSampleRetries ?? 0;\n    hotPathAudit.anchorBypassAttempts += completion.nativeMetrics.anchorBypassAttempts ?? 0;\n    hotPathAudit.anchorBypassSuccesses += completion.nativeMetrics.anchorBypassSuccesses ?? 0;''', 1)
text = text.replace('''Threshold local fallback ${hotPathAudit.thresholdFallbacks} · multisample retries ${hotPathAudit.multiSampleRetries}''', '''Threshold local fallback ${hotPathAudit.thresholdFallbacks} · multisample retries ${hotPathAudit.multiSampleRetries}\nAnchor bypass CRC ${hotPathAudit.anchorBypassSuccesses}/${hotPathAudit.anchorBypassAttempts}''', 1)
main.write_text(text)
