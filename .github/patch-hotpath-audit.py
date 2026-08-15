from pathlib import Path
import re


def replace(path, old, new, count=1):
    p = Path(path)
    text = p.read_text()
    n = text.count(old)
    if n != count:
        raise SystemExit(f"{path}: expected {count} matches, got {n}: {old[:140]!r}")
    p.write_text(text.replace(old, new))


def sub(path, pattern, repl, count=1, flags=0, label="pattern"):
    p = Path(path)
    text = p.read_text()
    new, n = re.subn(pattern, repl, text, count=count, flags=flags)
    if n != count:
        raise SystemExit(f"{path}: expected {count} {label}, got {n}")
    p.write_text(new)

# index.html ---------------------------------------------------------------
replace("index.html", "v0.5.50", "v0.5.51")
replace(
    "index.html",
    '<label id="decode-workers-control"><span>Workers</span><select id="decode-workers"><option value="auto" selected>Auto</option></select></label>',
    '<label id="decode-workers-control"><span>Workers</span><select id="decode-workers"><option value="auto" selected>Auto</option></select></label>\n              <label class="setting-toggle" id="strict-hot-path-control"><input id="strict-hot-path" type="checkbox" /><span>Strict hot path</span></label>'
)
replace(
    "index.html",
    '<option value="correctness">Correctness</option>',
    '<option value="correctness">Correctness · strict hot path</option>'
)

# receive/worker.js --------------------------------------------------------
replace("receive/worker.js", 'let nativeFallbackBudget = 1;\n', '')
replace(
    "receive/worker.js",
    '  zx._setTrackedDecoderFallbackBudget(nativeBatchHandle, nativeFallbackBudget);',
    '  zx._setTrackedDecoderFallbackBudget(nativeBatchHandle, 0);'
)
replace(
    "receive/worker.js",
    'function decodeNativeBatch(zx, ptr, width, height, ox, oy, tracks, pixelFormat = "rgba", stride = width * 4, strictTracked = false) {',
    'function decodeNativeBatch(zx, ptr, width, height, ox, oy, tracks, pixelFormat = "rgba", stride = width * 4) {'
)
replace(
    "receive/worker.js",
    '''  const appliedFallbackBudget = strictTracked ? tracks.length : nativeFallbackBudget;\n  zx._setTrackedDecoderFallbackBudget(nativeBatchHandle, appliedFallbackBudget);''',
    '''  // The tracked hot path never spends CPU rescuing a QR with QR-level\n  // Reed-Solomon. AirGapper's RaptorQ transport is designed to tolerate whole\n  // packet loss; a sampled matrix that cannot pass the cheap CRC path is a miss.\n  zx._setTrackedDecoderFallbackBudget(nativeBatchHandle, 0);'''
)
sub(
    "receive/worker.js",
    r'\n  if \(!strictTracked\) \{\n\s*const crcTracks = tracks\.reduce\(\(count2, track\) => count2 \+ Number\(Boolean\(track\.crc32\)\), 0\);\n\s*const fastEnough = crcTracks > 0 && metrics\.crcFastSuccesses >= Math\.ceil\(crcTracks \* 0\.8\);\n\s*nativeFallbackBudget = fastEnough \? 0 : 1;\n\s*\}',
    '',
    label="adaptive native RS block"
)
replace(
    "receive/worker.js",
    'payloadBytes = 0, strictTracked = false, diagnoseSampler = false } = e.data;',
    'payloadBytes = 0, strictHotPath = false, diagnoseSampler = false } = e.data;'
)
replace(
    "receive/worker.js",
    'const robustTrackedRecovery = !full && Array.isArray(tracks) && tracks.some((track) => (track.misses ?? 0) >= 2);',
    'const robustTrackedRecovery = !strictHotPath && !full && Array.isArray(tracks) && tracks.some((track) => (track.misses ?? 0) >= 2);'
)
replace(
    "receive/worker.js",
    '''        decodePixelFormat,\n        inputStride,\n        strictTracked\n      );''',
    '''        decodePixelFormat,\n        inputStride\n      );'''
)
replace(
    "receive/worker.js",
    '    if (shouldRunFullDecode(full, trackedAttempted, trackedHit)) {',
    '    if (!strictHotPath && shouldRunFullDecode(full, trackedAttempted, trackedHit)) {'
)

# receive/main.js ----------------------------------------------------------
replace(
    "receive/main.js",
    'const decodeWorkersControl = document.getElementById("decode-workers-control");',
    'const decodeWorkersControl = document.getElementById("decode-workers-control");\nconst strictHotPathToggle = document.getElementById("strict-hot-path");'
)
replace(
    "receive/main.js",
    '''function selectedWorkerCount() {\n  return decodeWorkers.value === "auto" ? autoWorkerCount : Math.max(1, Math.min(hardwareThreadCount, Number(decodeWorkers.value) || autoWorkerCount));\n}''',
    '''function selectedWorkerCount() {\n  return decodeWorkers.value === "auto" ? autoWorkerCount : Math.max(1, Math.min(hardwareThreadCount, Number(decodeWorkers.value) || autoWorkerCount));\n}\nlet strictHotPathEnabled = false;\nstrictHotPathToggle.addEventListener("change", () => {\n  strictHotPathEnabled = strictHotPathToggle.checked;\n  resetHotPathAudit();\n});\nfunction strictHotPathActive() {\n  return strictHotPathEnabled || replayRunning && replayMode.value === "correctness";\n}'''
)
replace(
    "receive/main.js",
    '''let decodeExceptions = 0;\nlet lastDecodeError = "";\nlet lastNativeMetrics;\nlet lastSamplerDiagnostics = [];\nlet trackingInvalidations = 0;''',
    '''let decodeExceptions = 0;\nlet lastDecodeError = "";\nlet lastNativeMetrics;\nlet lastSamplerDiagnostics = [];\nconst hotPathAudit = {\n  trackedJobs: 0,\n  nativeTracks: 0,\n  nativeSuccessful: 0,\n  crcFastSuccesses: 0,\n  nativeMisses: 0,\n  rsFallbacks: 0,\n  localRecoveryAttempts: 0,\n  localRecoverySuccesses: 0,\n  fullScanJobs: 0,\n  fullScanSuccesses: 0,\n  acquisitionFullScans: 0,\n  reacquireFullScans: 0,\n  readFullAttempts: 0\n};\nfunction resetHotPathAudit() {\n  for (const key of Object.keys(hotPathAudit)) hotPathAudit[key] = 0;\n  lastSamplerDiagnostics = [];\n}\nlet trackingInvalidations = 0;'''
)
# Benchmark job retains the exact mechanisms that produced its results.
replace(
    "receive/main.js",
    '''    benchmarkJob.readFullAttempts = completion.readFullAttempts;\n    benchmarkJob.fallbackAttempts = Number(completion.fallbackAttempted);\n    benchmarkJob.fallbackSuccesses = Number(completion.fallbackSucceeded);''',
    '''    benchmarkJob.readFullAttempts = completion.readFullAttempts;\n    benchmarkJob.fallbackAttempts = Number(completion.fallbackAttempted);\n    benchmarkJob.fallbackSuccesses = Number(completion.fallbackSucceeded);\n    benchmarkJob.nativeMetrics = completion.nativeMetrics ? { ...completion.nativeMetrics } : null;'''
)
# Audit completion before any early-return handling.
replace(
    "receive/main.js",
    '''  workerLatencyMaxMs = Math.max(workerLatencyMaxMs, completion.latencyMs);\n  if (completion.nativeMetrics) lastNativeMetrics = { ...completion.nativeMetrics, frameCopyMs: completion.frameCopyMs };\n  if (completion.samplerDiagnostics?.length) lastSamplerDiagnostics = completion.samplerDiagnostics;\n  if (fullJob) {\n  }''',
    '''  workerLatencyMaxMs = Math.max(workerLatencyMaxMs, completion.latencyMs);\n  if (completion.nativeMetrics) {\n    lastNativeMetrics = { ...completion.nativeMetrics, frameCopyMs: completion.frameCopyMs };\n    hotPathAudit.trackedJobs++;\n    hotPathAudit.nativeTracks += completion.nativeMetrics.tracks ?? 0;\n    hotPathAudit.nativeSuccessful += completion.nativeMetrics.successful ?? 0;\n    hotPathAudit.crcFastSuccesses += completion.nativeMetrics.crcFastSuccesses ?? 0;\n    hotPathAudit.nativeMisses += completion.nativeMetrics.misses ?? 0;\n    hotPathAudit.rsFallbacks += completion.nativeMetrics.rsFallbacks ?? 0;\n  }\n  hotPathAudit.readFullAttempts += completion.readFullAttempts ?? 0;\n  if (completion.fallbackAttempted) {\n    hotPathAudit.localRecoveryAttempts++;\n    if (completion.fallbackSucceeded) hotPathAudit.localRecoverySuccesses++;\n  }\n  if (completion.full) {\n    hotPathAudit.fullScanJobs++;\n    if (completion.symbolCount > 0) hotPathAudit.fullScanSuccesses++;\n    if (fullJob?.reacquire) hotPathAudit.reacquireFullScans++;\n    else if (fullJob?.acquisition) hotPathAudit.acquisitionFullScans++;\n  }\n  if (completion.samplerDiagnostics?.length) lastSamplerDiagnostics = completion.samplerDiagnostics;'''
)
# All full jobs, including DIRECT FULL FRAME, are classified.
replace(
    "receive/main.js",
    '''    if (kind === "FULL FRAME") {\n      fullScanIds.add(message.id);\n      fullScanJobs.set(message.id, { thorough: false, native: true, reacquire: gridLattice.state === "REACQUIRE" });\n    }''',
    '''    if (message.full) {\n      fullScanIds.add(message.id);\n      fullScanJobs.set(message.id, {\n        thorough: Boolean(message.thorough),\n        native: true,\n        reacquire: gridLattice.state === "REACQUIRE",\n        acquisition: !gridLattice.active\n      });\n    }'''
)
# Trace whether a benchmark job is full, and keep job kinds visible.
replace(
    "receive/main.js",
    '''      tracks: trackedRegions.map((region) => {\n        var _a;\n        return (_a = region.gridSlot) != null ? _a : region.id;\n      }),\n      submittedAt: receiverNow()''',
    '''      tracks: trackedRegions.map((region) => {\n        var _a;\n        return (_a = region.gridSlot) != null ? _a : region.id;\n      }),\n      full: Boolean(message.full),\n      submittedAt: receiverNow()'''
)
# Every tracked batch gets explicit strict semantics. Raw replay is no longer a
# hidden signal that changes decoder behavior.
text = Path("receive/main.js").read_text()
text = text.replace('strictTracked: false, diagnoseSampler:', 'strictHotPath: strictHotPathActive(), diagnoseSampler:')
text = text.replace('strictTracked: Boolean(source.image), diagnoseSampler:', 'strictHotPath: strictHotPathActive(), diagnoseSampler:')
Path("receive/main.js").write_text(text)
# Individual fallback path was malformed; use the same native tracked batch.
old = '''    if (!submitReceiverJob(\n      [img.data.buffer],\n      "INDIVIDUAL TRACKED CROP",\n      trace,\n      source.sequence,\n      [r]\n    )) {'''
new = '''    const individualTrack = {\n      id: r.id,\n      slot: r.gridSlot,\n      misses: r.consecutiveMisses,\n      quad: r.quad,\n      dim: r.dim,\n      crc32: Boolean(r.crc32)\n    };\n    if (!submitReceiverJob(\n      { id, buf: img.data.buffer, w, h, ox: x, oy: y, full: false, tracks: [individualTrack], strictHotPath: strictHotPathActive(), diagnoseSampler: !receiverDevActions.hidden },\n      [img.data.buffer],\n      "INDIVIDUAL TRACKED CROP",\n      trace,\n      source.sequence,\n      [r]\n    )) {'''
replace("receive/main.js", old, new)
# Sampler status is never silently absent in Developer Settings.
replace(
    "receive/main.js",
    '''    lastSamplerDiagnostics.length ? `Sampler  ${lastSamplerDiagnostics.map((item) => item.error\n      ? `s${item.slot ?? "?"} error ${item.error}`\n      : `s${item.slot} ${item.classification} · cache ${item.cached.mismatches}/${item.cached.total} (${item.cached.percent.toFixed(2)}%) Δ${item.cachedDeltaPx?.toFixed(2) ?? "?"}px · lattice ${item.current.mismatches}/${item.current.total} (${item.current.percent.toFixed(2)}%) Δ${item.currentDeltaPx?.toFixed(2) ?? "?"}px · fresh ${item.fresh.mismatches}/${item.fresh.total} (${item.fresh.percent.toFixed(2)}%)`\n    ).join(" | ")}` : "",''',
    '''    lastSamplerDiagnostics.length ? `Sampler  ${lastSamplerDiagnostics.map((item) => item.error\n      ? `s${item.slot ?? "?"} error ${item.error}`\n      : `s${item.slot} ${item.classification} · cache ${item.cached.mismatches}/${item.cached.total} (${item.cached.percent.toFixed(2)}%) Δ${item.cachedDeltaPx?.toFixed(2) ?? "?"}px · lattice ${item.current.mismatches}/${item.current.total} (${item.current.percent.toFixed(2)}%) Δ${item.currentDeltaPx?.toFixed(2) ?? "?"}px · fresh ${item.fresh.mismatches}/${item.fresh.total} (${item.fresh.percent.toFixed(2)}%)`\n    ).join(" | ")}` : "Sampler  no matrix-oracle recovery event",'''
)
# Reset audit with receiver/session resets.
replace(
    "receive/main.js",
    '''  lastNativeMetrics = void 0;\n  lastSamplerDiagnostics = [];\n  trackingInvalidations = 0;''',
    '''  lastNativeMetrics = void 0;\n  resetHotPathAudit();\n  trackingInvalidations = 0;'''
)
replace(
    "receive/main.js",
    '''  usefulFrameTimes.length = 0;\n  lastDistinctArrivalAt = 0;''',
    '''  usefulFrameTimes.length = 0;\n  resetHotPathAudit();\n  lastDistinctArrivalAt = 0;'''
)
# Developer transport block becomes a complete hot-path audit.
old = '''  transportDiagnostics.textContent = `Transport\nUnique ${uniqueRate.toFixed(1)} QR/s · duplicate ${duplicateRate.toFixed(1)} QR/s (${duplicatePercent.toFixed(0)}%)\nUseful ${usefulRate.toFixed(1)} QR/s · ${liveGoodputKbs(now).toFixed(1)} KB/s\n${totals}`;'''
new = '''  const fastPercent = hotPathAudit.nativeTracks ? hotPathAudit.crcFastSuccesses / hotPathAudit.nativeTracks * 100 : 0;\n  const samplerLine = lastSamplerDiagnostics.length\n    ? lastSamplerDiagnostics.map((item) => item.error\n      ? `s${item.slot ?? "?"} error ${item.error}`\n      : `s${item.slot} ${item.classification} · cache ${item.cached.mismatches}/${item.cached.total} · lattice ${item.current.mismatches}/${item.current.total} · fresh ${item.fresh.mismatches}/${item.fresh.total}`\n    ).join(" | ")\n    : "no matrix-oracle recovery event";\n  transportDiagnostics.textContent = `Transport\nUnique ${uniqueRate.toFixed(1)} QR/s · duplicate ${duplicateRate.toFixed(1)} QR/s (${duplicatePercent.toFixed(0)}%)\nUseful ${usefulRate.toFixed(1)} QR/s · ${liveGoodputKbs(now).toFixed(1)} KB/s\n${totals}\n\nHot path ${strictHotPathActive() ? "STRICT" : "LIVE"}\nNative CRC ${hotPathAudit.crcFastSuccesses}/${hotPathAudit.nativeTracks} (${fastPercent.toFixed(1)}%) · successful ${hotPathAudit.nativeSuccessful} · misses ${hotPathAudit.nativeMisses}\nQR-RS ${hotPathAudit.rsFallbacks} · local robust ${hotPathAudit.localRecoverySuccesses}/${hotPathAudit.localRecoveryAttempts} · readFull ${hotPathAudit.readFullAttempts}\nGeneric full ${hotPathAudit.fullScanSuccesses}/${hotPathAudit.fullScanJobs} · acquisition ${hotPathAudit.acquisitionFullScans} · reacquire ${hotPathAudit.reacquireFullScans}\nSampler ${samplerLine}`;'''
replace("receive/main.js", old, new)
# Benchmark output explicitly reports hot-path mechanisms.
needle = '''    const workerCpuSeconds = Math.max(1e-3, decodeLatencies.reduce((sum, value) => sum + value, 0) / 1e3);\n    const processedPixels = jobs.reduce((sum, job) => {'''
replacement = '''    const workerCpuSeconds = Math.max(1e-3, decodeLatencies.reduce((sum, value) => sum + value, 0) / 1e3);\n    const benchmarkNative = jobs.flatMap((job) => job.nativeMetrics ? [job.nativeMetrics] : []);\n    const benchmarkNativeTracks = benchmarkNative.reduce((sum, metrics) => sum + (metrics.tracks ?? 0), 0);\n    const benchmarkCrcFast = benchmarkNative.reduce((sum, metrics) => sum + (metrics.crcFastSuccesses ?? 0), 0);\n    const benchmarkNativeMisses = benchmarkNative.reduce((sum, metrics) => sum + (metrics.misses ?? 0), 0);\n    const benchmarkRsFallbacks = benchmarkNative.reduce((sum, metrics) => sum + (metrics.rsFallbacks ?? 0), 0);\n    const benchmarkFallbackAttempts = jobs.reduce((sum, job) => sum + (job.fallbackAttempts ?? 0), 0);\n    const benchmarkFallbackSuccesses = jobs.reduce((sum, job) => sum + (job.fallbackSuccesses ?? 0), 0);\n    const hotPath = {\n      strict: replayMode.value === "correctness",\n      nativeTracks: benchmarkNativeTracks,\n      crcFastSuccesses: benchmarkCrcFast,\n      crcFastPercent: benchmarkNativeTracks ? benchmarkCrcFast / benchmarkNativeTracks * 100 : 0,\n      nativeMisses: benchmarkNativeMisses,\n      qrRsFallbacks: benchmarkRsFallbacks,\n      localRecoveryAttempts: benchmarkFallbackAttempts,\n      localRecoverySuccesses: benchmarkFallbackSuccesses,\n      readFullAttempts: jobs.reduce((sum, job) => sum + (job.readFullAttempts ?? 0), 0),\n      fullScanJobs: jobs.reduce((sum, job) => sum + Number(Boolean(job.full)), 0)\n    };\n    const processedPixels = jobs.reduce((sum, job) => {'''
replace("receive/main.js", needle, replacement)
replace(
    "receive/main.js",
    '''      performance: { frameDropPercent: benchmarkTraces.length ? capturesDropped / benchmarkTraces.length * 100 : 0, workerBusyPercent: benchmarkTraces.length ? benchmarkTraces.reduce((sum, trace) => sum + trace.workerBusyFraction, 0) / benchmarkTraces.length * 100 : 0, pixelsPerSecond: jobs.reduce((sum, job) => sum + job.pixels, 0) / durationSeconds, processedPixelsPerSecond: processedPixels / durationSeconds, bytesRead: jobs.reduce((sum, job) => sum + job.bytes, 0), uniqueUsefulQrPerCpuSecond: uniqueUseful / workerCpuSeconds, uniqueUsefulBytesPerCpuSecond: uniqueUsefulBytes / workerCpuSeconds, uniqueUsefulQrPerMegapixel: uniqueUseful / Math.max(1e-3, processedPixels / 1e6), uniqueUsefulBytesPerMegapixel: uniqueUsefulBytes / Math.max(1e-3, processedPixels / 1e6), decodeP50Ms: percentile(decodeLatencies, 0.5), decodeP95Ms: percentile(decodeLatencies, 0.95), oracleP50Ms: percentile(oracleLatencies, 0.5), workerBusyDrops: capturesDropped, byKind },\n      transitions,''',
    '''      performance: { frameDropPercent: benchmarkTraces.length ? capturesDropped / benchmarkTraces.length * 100 : 0, workerBusyPercent: benchmarkTraces.length ? benchmarkTraces.reduce((sum, trace) => sum + trace.workerBusyFraction, 0) / benchmarkTraces.length * 100 : 0, pixelsPerSecond: jobs.reduce((sum, job) => sum + job.pixels, 0) / durationSeconds, processedPixelsPerSecond: processedPixels / durationSeconds, bytesRead: jobs.reduce((sum, job) => sum + job.bytes, 0), uniqueUsefulQrPerCpuSecond: uniqueUseful / workerCpuSeconds, uniqueUsefulBytesPerCpuSecond: uniqueUsefulBytes / workerCpuSeconds, uniqueUsefulQrPerMegapixel: uniqueUseful / Math.max(1e-3, processedPixels / 1e6), uniqueUsefulBytesPerMegapixel: uniqueUsefulBytes / Math.max(1e-3, processedPixels / 1e6), decodeP50Ms: percentile(decodeLatencies, 0.5), decodeP95Ms: percentile(decodeLatencies, 0.95), oracleP50Ms: percentile(oracleLatencies, 0.5), workerBusyDrops: capturesDropped, byKind },\n      hotPath,\n      transitions,'''
)
replace(
    "receive/main.js",
    '''verified KB/s ${(benchmarkVerifiedBytes / 1024 / durationSeconds).toFixed(1)}\ndecode p50/95 ${percentile(decodeLatencies, 0.5).toFixed(1)} / ${percentile(decodeLatencies, 0.95).toFixed(1)} ms\nbusy drops    ${capturesDropped}''',
    '''verified KB/s ${(benchmarkVerifiedBytes / 1024 / durationSeconds).toFixed(1)}\nhot CRC       ${hotPath.crcFastSuccesses}/${hotPath.nativeTracks} (${hotPath.crcFastPercent.toFixed(1)}%)\nQR-RS/local   ${hotPath.qrRsFallbacks} / ${hotPath.localRecoverySuccesses}/${hotPath.localRecoveryAttempts}\ndecode p50/95 ${percentile(decodeLatencies, 0.5).toFixed(1)} / ${percentile(decodeLatencies, 0.95).toFixed(1)} ms\nbusy drops    ${capturesDropped}'''
)

# sw.js --------------------------------------------------------------------
replace("sw.js", 'const CACHE = "airgapper-static-js-v13";', 'const CACHE = "airgapper-static-js-v14";')

# Hard assertions ----------------------------------------------------------
worker = Path("receive/worker.js").read_text()
main = Path("receive/main.js").read_text()
index = Path("index.html").read_text()
assert "nativeFallbackBudget" not in worker
assert "strictTracked" not in worker
assert "strictTracked" not in main
assert "_setTrackedDecoderFallbackBudget(nativeBatchHandle, 0)" in worker
assert "strictHotPath: strictHotPathActive()" in main
assert "Hot path ${strictHotPathActive()" in main
assert "Correctness · strict hot path" in index
assert "v0.5.51" in index
