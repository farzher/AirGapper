from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing patch anchor in {path}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))


# Version/cache.
for path in ["index.html", "main.js", "receive/main.js"]:
    p = Path(path)
    text = p.read_text()
    if "v0.5.175" not in text:
        raise SystemExit(f"expected v0.5.175 in {path}")
    p.write_text(text.replace("v0.5.175", "v0.5.176"))
replace_once("sw.js", 'airgapper-static-js-v137', 'airgapper-static-js-v138')

# Cold acquisition: repeated hardware AF sweeps while there is still no usable
# decoder evidence. Once QR payloads are flowing or optics already look sharp,
# the camera is left alone.
replace_once(
    "receive/focus-controller.js",
    '  maxStabilizingAfRetries: 2,\n  recoverySamples: 3,',
    '  maxStabilizingAfRetries: 2,\n  seekingAfRetryMs: 850,\n  seekingAfSlowRetryMs: 1500,\n  seekingAfFastRetries: 5,\n  seekingAfGoodFocus: 0.58,\n  recoverySamples: 3,'
)
replace_once(
    "receive/focus-controller.js",
    '''    /** Automatic focus is configured at most once per camera track. After that,\n     *  AirGapper treats focus as read-only: exposure optimization, acquisition,\n     *  target loss, and decoder recovery are forbidden from touching the lens. */\n    __publicField(this, "automaticFocusConfigured", false);\n    __publicField(this, "waiter");''',
    '''    /** Initial AF mode configuration is one-time. While acquisition has no\n     *  usable QR evidence, bounded single-shot sweeps may be retriggered; any\n     *  fresh decode or convincingly sharp optical target stops those retries. */\n    __publicField(this, "automaticFocusConfigured", false);\n    __publicField(this, "seekingAfRetries", 0);\n    __publicField(this, "lastSeekingAfAt", -Infinity);\n    __publicField(this, "seekingAfRunning", false);\n    __publicField(this, "waiter");'''
)
replace_once(
    "receive/focus-controller.js",
    '''    this.targetMissingSince = 0;\n    this.automaticFocusConfigured = false;\n    this.optimizeMovementSince = 0;''',
    '''    this.targetMissingSince = 0;\n    this.automaticFocusConfigured = false;\n    this.seekingAfRetries = 0;\n    this.lastSeekingAfAt = -Infinity;\n    this.seekingAfRunning = false;\n    this.optimizeMovementSince = 0;'''
)
replace_once(
    "receive/focus-controller.js",
    '      this.transition("SEEKING", "camera track changed; one hardware AF sweep, then focus held by camera");',
    '      this.transition("SEEKING", "camera track changed; hardware AF acquisition retries armed until QR decode");'
)
replace_once(
    "receive/focus-controller.js",
    '      this.transition("SEEKING", "automatic focus selected; one hardware AF sweep + hardware AE");',
    '      this.transition("SEEKING", "automatic focus selected; hardware AF retries + hardware AE");'
)
replace_once(
    "receive/focus-controller.js",
    '''    if (!this.isAcquiring()) return;\n    if (!this.stableGeometry || this.geometryChanged(geometry, this.stableGeometry)) {''',
    '''    if (!this.isAcquiring()) return;\n    void this.maybeRetrySeekingAutofocus(now, metrics);\n    if (!this.stableGeometry || this.geometryChanged(geometry, this.stableGeometry)) {'''
)
replace_once(
    "receive/focus-controller.js",
    '''      this.transition("SEEKING", "target absent; camera state retained while decoding continues");\n    }\n    this.changed();\n  }\n  diagnostics() {''',
    '''      this.transition("SEEKING", "target absent; camera state retained while decoding continues");\n    }\n    if (this.isAcquiring()) void this.maybeRetrySeekingAutofocus(now);\n    this.changed();\n  }\n  diagnostics() {'''
)
replace_once(
    "receive/focus-controller.js",
    '''      focusProbes: this.focusProbes,\n      exposureProbes: this.exposureProbes,''',
    '''      focusProbes: this.focusProbes,\n      seekingAfRetries: this.seekingAfRetries,\n      exposureProbes: this.exposureProbes,'''
)
replace_once(
    "receive/focus-controller.js",
    '''  async configureInitialHardwareFocusOnce() {\n    if (this.automaticFocusConfigured || this.strategy !== "auto") return;''',
    '''  async maybeRetrySeekingAutofocus(now = performance.now(), metrics) {\n    if (this.seekingAfRunning || this.strategy !== "auto" || !this.isAcquiring() || this.isOptimizing()) return;\n    const track = this.track;\n    if (!track || track.readyState !== "live" || !this.focusModes().includes("single-shot")) return;\n    const silence = this.decodeSilence(now);\n    if (this.validDecodesInGeneration > 0 && silence < 2200) return;\n    if (metrics && metrics.confidence >= 0.78 && metrics.focusScore >= CAMERA_TUNING.seekingAfGoodFocus) return;\n    const interval = this.seekingAfRetries < CAMERA_TUNING.seekingAfFastRetries\n      ? CAMERA_TUNING.seekingAfRetryMs\n      : CAMERA_TUNING.seekingAfSlowRetryMs;\n    if (now - this.lastSeekingAfAt < interval) return;\n\n    const generation = this.generation;\n    this.seekingAfRunning = true;\n    this.lastSeekingAfAt = now;\n    this.requestedMode = "single-shot";\n    this.focusProbes++;\n    this.focusRefinementCount++;\n    try {\n      const accepted = await this.apply(track, { focusMode: "single-shot" });\n      if (accepted && this.current(generation)) {\n        this.seekingAfRetries++;\n        const actual = this.settings();\n        this.committedFocusMode = actual.focusMode;\n        this.committedFocusDistance = actual.focusDistance;\n        this.lastReason = `acquisition autofocus retry ${this.seekingAfRetries}; hardware AE retained`;\n        this.changed();\n      }\n    } finally {\n      this.seekingAfRunning = false;\n    }\n  }\n  async configureInitialHardwareFocusOnce() {\n    if (this.automaticFocusConfigured || this.strategy !== "auto") return;'''
)
replace_once(
    "receive/focus-controller.js",
    '    this.lastReason = "single hardware autofocus sweep requested; no automatic refocuses will follow";',
    '    this.lastReason = "initial hardware autofocus sweep requested; acquisition retries remain armed until QR decode";'
)

# Exact sender FPS estimate from the QR sequence clock and capture timestamps.
# For a fixed slot, seq advances by the wall cell count once per sender frame.
replace_once(
    "receive/main.js",
    '''function noteSequence(region, seq, now) {\n  pruneSequenceSamples(region, now);\n  if (!region.sequenceSamples.some((sample) => sample.seq === seq)) {\n    region.sequenceSamples.push({ seq, at: now });\n    region.sequenceSamples.sort((a, b) => a.at - b.at);\n  }\n}\nfunction noteDecodeCompleted(id, completion) {''',
    '''function noteSequence(region, seq, now) {\n  pruneSequenceSamples(region, now);\n  if (!region.sequenceSamples.some((sample) => sample.seq === seq)) {\n    region.sequenceSamples.push({ seq, at: now });\n    region.sequenceSamples.sort((a, b) => a.at - b.at);\n  }\n}\nfunction estimateSenderFrameRate(now = receiverNow()) {\n  if (!decoder || decoder.mode === "direct" || !lastGridSnapshot) return void 0;\n  const gridCodes = lastGridSnapshot.layout.cols * lastGridSnapshot.layout.rows;\n  if (!(gridCodes > 0)) return void 0;\n  const modulus = decoder.mode === "mds" ? 256 : 16711680;\n  const estimates = [];\n  const maxGapMs = decoder.mode === "mds" ? 350 : 1200;\n  for (const region of regions) {\n    if (region.gridSlot === void 0) continue;\n    pruneSequenceSamples(region, now);\n    const samples = region.sequenceSamples;\n    for (let i = 1; i < samples.length; i++) {\n      const a = samples[i - 1];\n      const b = samples[i];\n      const dt = b.at - a.at;\n      if (!(dt >= 12 && dt <= maxGapMs)) continue;\n      const delta = (b.seq - a.seq + modulus) % modulus;\n      if (!delta || delta % gridCodes) continue;\n      const senderFrames = delta / gridCodes;\n      if (!(senderFrames >= 1 && senderFrames <= 60)) continue;\n      const fps = senderFrames * 1e3 / dt;\n      if (fps >= 1 && fps <= 500) estimates.push(fps);\n    }\n  }\n  if (estimates.length < 6) return void 0;\n  estimates.sort((a, b) => a - b);\n  const raw = estimates[estimates.length >> 1];\n  const common = [5, 10, 12, 15, 20, 24, 25, 30, 40, 48, 50, 60, 72, 90, 100, 120, 144, 165, 180, 200, 240, 300, 360, 480];\n  const nearest = common.reduce((best, fps) => Math.abs(fps - raw) < Math.abs(best - raw) ? fps : best);\n  const snapped = Math.abs(nearest - raw) / nearest <= 0.10;\n  return { fps: snapped ? nearest : raw, raw, samples: estimates.length, snapped };\n}\nfunction noteDecodeCompleted(id, completion) {'''
)
replace_once(
    "receive/main.js",
    '  if (decodedRegion) noteSequence(decodedRegion, header.seq, decodedAt);',
    '  if (decodedRegion) noteSequence(decodedRegion, header.seq, info?.scanId === void 0 ? decodedAt : scanCapturedAt.get(info.scanId) ?? decodedAt);'
)
replace_once(
    "receive/main.js",
    '''  const duplicateQrRate = duplicateQrTimes.reduce((count, at) => count + Number(at > windowStart), 0) / (STATS_WINDOW_MS / 1e3);\n  const workerBusyEventRate = poolBusyTimes.reduce((count, at) => count + Number(at > windowStart), 0) / (STATS_WINDOW_MS / 1e3);''',
    '''  const duplicateQrRate = duplicateQrTimes.reduce((count, at) => count + Number(at > windowStart), 0) / (STATS_WINDOW_MS / 1e3);\n  const senderRateEstimate = estimateSenderFrameRate(perfNow);\n  const workerBusyEventRate = poolBusyTimes.reduce((count, at) => count + Number(at > windowStart), 0) / (STATS_WINDOW_MS / 1e3);'''
)
replace_once(
    "receive/main.js",
    '''    `Output   valid ${validQrRate.toFixed(1)} · unique ${uniqueQrRate.toFixed(1)} · duplicate ${duplicateQrRate.toFixed(1)} QR/s · useful ${liveGoodputKbs(perfNow).toFixed(1)} KB/s`,\n    cornerSlotMetrics(),''',
    '''    `Output   valid ${validQrRate.toFixed(1)} · unique ${uniqueQrRate.toFixed(1)} · duplicate ${duplicateQrRate.toFixed(1)} QR/s · useful ${liveGoodputKbs(perfNow).toFixed(1)} KB/s`,\n    senderRateEstimate ? `Sender   ~${senderRateEstimate.fps.toFixed(senderRateEstimate.snapped ? 0 : 1)} fps · ${senderRateEstimate.samples} sequence intervals` : "",\n    cornerSlotMetrics(),'''
)
replace_once(
    "receive/main.js",
    '''    `Counts   full AF+AE ${diagnostic.fullResetCount} · focus-only ${diagnostic.focusRefinementCount} · exposure-only ${diagnostic.exposureRefinementCount}`,''',
    '''    `Counts   full AF+AE ${diagnostic.fullResetCount} · focus-only ${diagnostic.focusRefinementCount} (${diagnostic.seekingAfRetries} acquisition AF) · exposure-only ${diagnostic.exposureRefinementCount}`,'''
)

# Build trees are generated output, not source.
replace_once(
    "vendor/decimen-codec/source/.gitignore",
    'build/\ndist/\nemsdk/\nthird_party/',
    'build/\nbuild-scalar/\nbuild-simd/\ndist/\nemsdk/\nthird_party/'
)
replace_once(
    ".gitignore",
    '!AirGapper.apk',
    '!AirGapper.apk\nvendor/decimen-codec/source/build-scalar/\nvendor/decimen-codec/source/build-simd/'
)
