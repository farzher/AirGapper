from pathlib import Path


def rep(path, old, new):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f'missing anchor {path}: {old[:220]}')
    p.write_text(s.replace(old, new, 1))


# Version/cache.
rep('receive/main.js', 'const RECEIVER_RUNTIME_BUILD = "v0.5.284";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.285";')
rep('send/main.js', 'const SEND_RUNTIME_BUILD = "v0.5.276";', 'const SEND_RUNTIME_BUILD = "v0.5.285";')
rep('main.js', 'const APP_BUILD = "v0.5.284";', 'const APP_BUILD = "v0.5.285";')
rep('index.html', 'main.js?build=v0.5.284', 'main.js?build=v0.5.285')
rep('sw.js', 'airgapper-static-js-v232', 'airgapper-static-js-v233')

# Fullscreen sender: the QR raster is already pure black/white, but empty screen
# area used the warm app background. Make the whole optical transmitter white.
# Besides eliminating a visible border, the extra emitted luminance gives camera
# AE more reason to choose a shorter exposure / lower gain during acquisition.
rep(
    'shared/style.css',
    'body.qr-full { overflow: hidden; }',
    '''body.qr-full { overflow: hidden; background: #fff; }\nbody.qr-full .app,\nbody.qr-full .app-main,\nbody.qr-full #sendView,\nbody.qr-full #stage { background: #fff; }'''
)

# Completion UI: one requestAnimationFrame is not a paint barrier because rAF
# callbacks themselves run before paint. Hold the 100%/Processing state across
# two animation frames so Chromium must get a compositor opportunity before the
# synchronous RaptorQ assembly/hash work starts.
rep('receive/main.js', '  etaLabel.textContent = "Finalizing…";', '  etaLabel.textContent = "Processing…";')
rep(
    'receive/main.js',
    '''async function waitForProgressPaint() {\n  // rAF callbacks run before paint and promise continuations are microtasks, so\n  // a timer task after the rAF gives the compositor an unconditional paint\n  // opportunity before we enter synchronous payload assembly.\n  await new Promise((resolve) => requestAnimationFrame(resolve));\n  await new Promise((resolve) => setTimeout(resolve, 0));\n}''',
    '''async function waitForProgressPaint() {\n  // One rAF is still before paint. Resolve from the following frame: yielding\n  // between the two callbacks gives the browser a guaranteed rendering turn\n  // with the snapped 100% bar and Processing label visible.\n  await new Promise((resolve) =>\n    requestAnimationFrame(() => requestAnimationFrame(resolve))\n  );\n}\nfunction quiesceCompletedTransfer() {\n  // The decoder already has every source symbol it needs. Stop producing and\n  // decoding camera frames before CPU-heavy assembly/verification so completed\n  // work cannot compete with the main-thread finishing path. Keep the last\n  // preview frame mounted until finish() replaces the receive UI.\n  stopFramePump();\n  stream?.getTracks().forEach((track) => track.stop());\n  clearPendingGridLanes();\n  cropAttempts.clear();\n  fullScanJobs.clear();\n  scanCapturedAt.clear();\n  clearInterval(statsTimer);\n  statsTimer = void 0;\n  pool.resize(0);\n}'''
)
rep(
    'receive/main.js',
    '''  freezeCompletionDiagnostics();\n  const payload = completingDecoder.assemble();''',
    '''  freezeCompletionDiagnostics();\n  quiesceCompletedTransfer();\n  const payload = completingDecoder.assemble();'''
)

# Weak-slot CPU policy. v284 proved motion recovery is now driven by coherent
# wall-motion evidence + targeted recovery, so flooding every historically bad
# payload slot during a coverage wobble is unnecessary. Keep weak slots alive as
# probes, but let very persistent ~0% slots back off further. Any CRC-valid hit
# immediately clears the weak flag through noteSlotDecoded().
rep(
    'receive/main.js',
    '''const SLOT_WEAK_PROBE_EVERY = 8;\nconst SLOT_WEAK_MIN_WALL = 6;''',
    '''const SLOT_WEAK_PROBE_EVERY = 8;\nconst SLOT_VERY_WEAK_PROBE_EVERY = 16;\nconst SLOT_VERY_WEAK_SCORE = 0.03;\nconst SLOT_VERY_WEAK_MISSES = 6;\nconst SLOT_WEAK_MIN_WALL = 6;'''
)
rep(
    'receive/main.js',
    '''function shouldScheduleAdaptiveSlot(region, sourceSequence, adaptive) {\n  if (!adaptive) return true;\n  const slot = Number(region.gridSlot);\n  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_METRIC_COUNT || !slotAdaptiveWeak[slot]) return true;\n  const sequence = Number(sourceSequence);\n  if (!Number.isFinite(sequence)) return true;\n  // Stagger weak slots so several bad edge cells do not all consume the same\n  // probe frame. They remain geometrically tracked; only payload decode work is\n  // thinned out. Acquisition/reacquisition is intentionally unaffected.\n  return (Math.trunc(sequence) + slot) % SLOT_WEAK_PROBE_EVERY === 0;\n}''',
    '''function adaptiveSlotProbeEvery(region) {\n  const slot = Number(region?.gridSlot);\n  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_METRIC_COUNT || !slotAdaptiveWeak[slot]) return 1;\n  const veryWeak = slotQualitySamples[slot] >= SLOT_WEAK_MIN_SAMPLES * 2 &&\n    slotQualityScores[slot] < SLOT_VERY_WEAK_SCORE &&\n    (region.consecutiveMisses || 0) >= SLOT_VERY_WEAK_MISSES;\n  return veryWeak ? SLOT_VERY_WEAK_PROBE_EVERY : SLOT_WEAK_PROBE_EVERY;\n}\nfunction shouldScheduleAdaptiveSlot(region, sourceSequence, adaptive) {\n  if (!adaptive) return true;\n  const slot = Number(region.gridSlot);\n  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_METRIC_COUNT || !slotAdaptiveWeak[slot]) return true;\n  const sequence = Number(sourceSequence);\n  if (!Number.isFinite(sequence)) return true;\n  // Stagger weak slots so several bad edge cells do not all consume the same\n  // probe frame. A persistently near-zero slot backs off to ~2 probes/s at a\n  // 30-fps source; one CRC-valid hit immediately restores full scheduling.\n  return (Math.trunc(sequence) + slot) % adaptiveSlotProbeEvery(region) === 0;\n}'''
)
rep(
    'receive/main.js',
    '''  // Weak-slot thinning is a steady-state CPU optimization, not a recovery\n  // policy. While wall breadth is starved, spend the available headroom on all\n  // predicted slots so a repaired pose is recognized on the very next frame.\n  const adaptiveWeakSlots = gridLattice.active && !sustainedCoverageStarvation &&\n    adaptiveWeakSlotScheduling(batchCandidates);''',
    '''  // Payload weakness and wall-pose recovery are separate concerns. Motion\n  // now comes from CRC-valid whole-wall feedback and missing breadth has its own\n  // targeted recovery probe, so do not flood proven-bad payload slots during a\n  // motion wobble. That only lengthens Guided jobs and causes newer frames to be\n  // replaced while workers chew on known failures.\n  const adaptiveWeakSlots = gridLattice.active && adaptiveWeakSlotScheduling(batchCandidates);'''
)

# Diagnostics must describe the *scheduled* opportunity rate after deliberate
# weak-slot thinning, otherwise a healthy scheduler looks artificially 60% full.
rep(
    'receive/main.js',
    '''  const decodableSlotCount = regions.reduce((count, region) => count + Number(\n    region.gridSlot !== void 0 && isGridDecodeCandidate(region) &&\n    validTrackedQuad(region, receiverFrameWidth, receiverFrameHeight)\n  ), 0);\n  const qrOpportunityRate = sourceCaptureRate * decodableSlotCount;''',
    '''  const diagnosticCandidates = regions.filter((region) =>\n    region.gridSlot !== void 0 && isGridDecodeCandidate(region) &&\n    validTrackedQuad(region, receiverFrameWidth, receiverFrameHeight)\n  );\n  const decodableSlotCount = diagnosticCandidates.length;\n  const diagnosticAdaptiveWeak = adaptiveWeakSlotScheduling(diagnosticCandidates);\n  const scheduledSlotEquivalent = diagnosticCandidates.reduce((sum, region) =>\n    sum + (diagnosticAdaptiveWeak ? 1 / adaptiveSlotProbeEvery(region) : 1), 0\n  );\n  const qrOpportunityRate = sourceCaptureRate * scheduledSlotEquivalent;'''
)
rep(
    'receive/main.js',
    '''    `Capacity ${decodableSlotCount || "—"} decodable / ${visibleSlotCount || "—"} visible slots × ${sourceCaptureRate.toFixed(1)} fps = ${qrOpportunityRate.toFixed(1)} QR/s · submitted ${attemptedQrRate.toFixed(1)} (${qrOpportunityRate ? `${(attemptCoverage * 100).toFixed(0)}%` : "—"}) · completed ${completedQrRate.toFixed(1)}`,''',
    '''    `Capacity ${decodableSlotCount || "—"} decodable / ${visibleSlotCount || "—"} visible · ${scheduledSlotEquivalent.toFixed(1)} scheduled/frame × ${sourceCaptureRate.toFixed(1)} fps = ${qrOpportunityRate.toFixed(1)} QR/s · submitted ${attemptedQrRate.toFixed(1)} (${qrOpportunityRate ? `${(attemptCoverage * 100).toFixed(0)}%` : "—"}) · completed ${completedQrRate.toFixed(1)}`,'''
)

# Intent guards.
receive = Path('receive/main.js').read_text()
style = Path('shared/style.css').read_text()
if 'Finalizing…' in receive:
    raise SystemExit('old finalizing label survived')
if 'setTimeout(resolve, 0)' in receive[receive.index('async function waitForProgressPaint'):receive.index('async function finalizeCompletedTransfer')]:
    raise SystemExit('old one-rAF completion paint barrier survived')
if 'gridLattice.active && !sustainedCoverageStarvation' in receive:
    raise SystemExit('starvation disables weak thinning')
if 'background: #fff' not in style[style.index('body.qr-full'):style.index('/* Settings and diagnostics')]:
    raise SystemExit('fullscreen white optical background missing')
