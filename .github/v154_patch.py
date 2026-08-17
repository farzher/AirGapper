from pathlib import Path

root = Path('.')

# ---- shared/worker-pool.js -------------------------------------------------
p = root / 'shared/worker-pool.js'
s = p.read_text()
s = s.replace(
'''  constructor(create, onDecoded, onSighted, onTrackedAttempt, onCompleted, onAvailable) {
    this.create = create;
    this.onDecoded = onDecoded;
    this.onSighted = onSighted;
    this.onTrackedAttempt = onTrackedAttempt;
    this.onCompleted = onCompleted;
    this.onAvailable = onAvailable;''',
'''  constructor(create, onDecoded, onSighted, onTrackedAttempt, onCompleted, onAvailable, onFrameSignature) {
    this.create = create;
    this.onDecoded = onDecoded;
    this.onSighted = onSighted;
    this.onTrackedAttempt = onTrackedAttempt;
    this.onCompleted = onCompleted;
    this.onAvailable = onAvailable;
    this.onFrameSignature = onFrameSignature;''', 1)
old = '''      if (message.id === -1) return;
      if (this.activeIds[slot] !== message.id) return;
      const symbols = (_a = message.symbols) != null ? _a : [];'''
new = '''      if (message.id === -1) return;
      if (this.activeIds[slot] !== message.id) return;
      // A worker publishes its tiny page signature immediately after copying
      // Y8, before the expensive QR decode. Keep the worker busy; this is only
      // a preflight notification used by the next camera frame.
      if (message.preflight) {
        this.onFrameSignature?.({
          id: message.id,
          sourceSequence: message.sourceSequence,
          signature: message.frameSignature
        });
        return;
      }
      const symbols = (_a = message.symbols) != null ? _a : [];'''
assert old in s
s = s.replace(old, new, 1)
old = '''          directFrameFailed: Boolean(message.directFrameFailed),
          symbols,
          sightings,
          error: message.error'''
new = '''          directFrameFailed: Boolean(message.directFrameFailed),
          repeatSkipped: Boolean(message.repeatSkipped),
          repeatDistance: Number(message.repeatDistance),
          symbols,
          sightings,
          error: message.error'''
assert old in s
s = s.replace(old, new, 1)
p.write_text(s)

# ---- receive/worker.js ------------------------------------------------------
p = root / 'receive/worker.js'
s = p.read_text()
anchor = '''function projectedNeighbor(q, dx, dy, stride) {'''
idx = s.index(anchor)
handler = s.index('ctx.onmessage = async (e) => {', idx)
helpers = r'''
const REPEAT_SIGNATURE_X = 8;
const REPEAT_SIGNATURE_Y = 6;
const REPEAT_SIGNATURE_TRACKS = 3;
const REPEAT_SIGNATURE_MAX_BITS = 6;

function repeatPageSignature(heap, yPtr, width, height, stride, ox, oy, tracks) {
  if (!Array.isArray(tracks) || tracks.length < 2 || stride < width) return null;
  const ordered = tracks
    .filter((track) => validQuad(track.quad) && Number.isFinite(track.dim) && track.dim >= 21)
    .sort((a, b) => (a.slot ?? a.id ?? 0) - (b.slot ?? b.id ?? 0));
  if (ordered.length < 2) return null;
  const pickIndices = [];
  for (let i = 1; i <= REPEAT_SIGNATURE_TRACKS; i++) {
    const index = Math.round((ordered.length - 1) * i / (REPEAT_SIGNATURE_TRACKS + 1));
    if (!pickIndices.includes(index)) pickIndices.push(index);
  }
  const selected = pickIndices.map((index) => ordered[index]).filter(Boolean);
  if (selected.length < 2) return null;

  const bits = new Uint8Array(Math.ceil(selected.length * REPEAT_SIGNATURE_X * REPEAT_SIGNATURE_Y / 8));
  let bitIndex = 0;
  const keys = [];
  const project = (q, u, v) => ({
    x: (1 - u) * (1 - v) * q.topLeft.x + u * (1 - v) * q.topRight.x + u * v * q.bottomRight.x + (1 - u) * v * q.bottomLeft.x - ox,
    y: (1 - u) * (1 - v) * q.topLeft.y + u * (1 - v) * q.topRight.y + u * v * q.bottomRight.y + (1 - u) * v * q.bottomLeft.y - oy
  });

  for (const track of selected) {
    const values = [];
    const dim = Math.round(track.dim);
    keys.push(`${track.slot ?? track.id ?? 0}:${dim}`);
    for (let gy = 0; gy < REPEAT_SIGNATURE_Y; gy++) {
      for (let gx = 0; gx < REPEAT_SIGNATURE_X; gx++) {
        // Interior module centers avoid the three fixed finder patterns. The
        // exact samples need not decode QR; they only need to change strongly
        // when the sender paints a different random-looking data matrix.
        const mx = Math.max(0, Math.min(dim - 1, Math.round(dim * (0.20 + (gx + 0.5) / REPEAT_SIGNATURE_X * 0.60))));
        const my = Math.max(0, Math.min(dim - 1, Math.round(dim * (0.20 + (gy + 0.5) / REPEAT_SIGNATURE_Y * 0.60))));
        const p = project(track.quad, (mx + 0.5) / dim, (my + 0.5) / dim);
        const x = Math.round(p.x), y = Math.round(p.y);
        if (x < 0 || y < 0 || x >= width || y >= height) return null;
        values.push(heap[yPtr + y * stride + x]);
      }
    }
    const ranked = [...values].sort((a, b) => a - b);
    const lo = ranked[Math.floor(ranked.length * 0.12)];
    const hi = ranked[Math.floor(ranked.length * 0.88)];
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi - lo < 36) return null;
    const threshold = (lo + hi) * 0.5;
    for (const value of values) {
      if (value < threshold) bits[bitIndex >> 3] |= 1 << (bitIndex & 7);
      bitIndex++;
    }
  }
  return { key: keys.join('|'), bits: Array.from(bits), bitCount: bitIndex };
}

function repeatSignatureDistance(current, previous) {
  if (!current || !previous || current.key !== previous.key || current.bitCount !== previous.bitCount ||
      !Array.isArray(current.bits) || !Array.isArray(previous.bits) || current.bits.length !== previous.bits.length) return null;
  let different = 0;
  for (let i = 0; i < current.bits.length; i++) {
    let value = (current.bits[i] ^ previous.bits[i]) & 255;
    while (value) {
      value &= value - 1;
      different++;
    }
  }
  return { different, fraction: different / Math.max(1, current.bitCount) };
}

'''
s = s[:handler] + helpers + s[handler:]
old = '''  const { id, buf, videoFrame, cropX = 0, cropY = 0, w = 0, h = 0, ox = 0, oy = 0, full = true, quad, dim, tracks, isolated = false, oracle = false, oracleSeeds = [], sentAt, pixelFormat = "rgba", yOffset: messageYOffset = 0, yStride: messageYStride = 0, payloadBytes = 0, strictHotPath = false, outputMap, thorough = false, acquisitionMode, guidedDecode = false } = e.data;'''
new = '''  const { id, buf, videoFrame, cropX = 0, cropY = 0, w = 0, h = 0, ox = 0, oy = 0, full = true, quad, dim, tracks, isolated = false, oracle = false, oracleSeeds = [], sentAt, pixelFormat = "rgba", yOffset: messageYOffset = 0, yStride: messageYStride = 0, payloadBytes = 0, strictHotPath = false, outputMap, thorough = false, acquisitionMode, guidedDecode = false, sourceSequence, repeatFilter = false, previousFrameSignature } = e.data;'''
assert old in s
s = s.replace(old, new, 1)
old = '''    const pw = w;
    const ph = h;
    const symbols = [];'''
new = '''    const pw = w;
    const ph = h;
    // Adjacent-camera duplicates are expensive because the 30 fps receiver can
    // photograph one 20-ish fps sender page twice. After the Y plane copy, a
    // 144-bit signature costs only a handful of reads from known QR interiors.
    // Publish it immediately so the next worker can compare against it. Only a
    // near-identical whole-page match exits early; rolling transitions keep
    // decoding because their signature changes substantially.
    if (repeatFilter && decodePixelFormat === "y8" && !full && guidedDecode && tracks?.length >= 2) {
      const frameSignature = repeatPageSignature(zx.HEAPU8, ptr + inputOffset, pw, ph, inputStride, ox, oy, tracks);
      if (frameSignature) {
        ctx.postMessage({ id, preflight: true, sourceSequence, frameSignature });
        const distance = repeatSignatureDistance(frameSignature, previousFrameSignature);
        if (distance && distance.different <= REPEAT_SIGNATURE_MAX_BITS) {
          ctx.postMessage({
            id,
            sourceSequence,
            symbols: [],
            sightings: [],
            full: false,
            trackedAttempted: false,
            trackedHit: false,
            fallbackAttempted: false,
            fallbackSucceeded: false,
            readFullAttempts: 0,
            workerWaitMs,
            frameCopyMs,
            repeatSkipped: true,
            repeatDistance: distance.fraction,
            pixelPath: "y8-repeat",
            latencyMs: performance.now() - startedAt
          });
          return;
        }
      }
    }
    const symbols = [];'''
assert old in s
s = s.replace(old, new, 1)
p.write_text(s)

# ---- receive/main.js --------------------------------------------------------
p = root / 'receive/main.js'
s = p.read_text()
assert 'const RECEIVER_RUNTIME_BUILD = "v0.5.153";' in s
s = s.replace('const RECEIVER_RUNTIME_BUILD = "v0.5.153";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.154";', 1)

old = '''function clearPendingGridLanes() {
  for (let index = 0; index < pendingGridLanes.length; index++) discardPendingGridLane(index);
  clearLockedLaneCrops();
}'''
new = '''function clearPendingGridLanes() {
  for (let index = 0; index < pendingGridLanes.length; index++) discardPendingGridLane(index);
  clearLockedLaneCrops();
  latestRepeatSignature = undefined;
}'''
assert old in s
s = s.replace(old, new, 1)

old = '''const pool = new DecodeWorkerPool(
  createDecodeWorker,'''
new = '''let latestRepeatSignature;
const repeatSkipTimes = [];
const pool = new DecodeWorkerPool(
  createDecodeWorker,'''
assert old in s
s = s.replace(old, new, 1)
old = '''  (id, completion) => noteDecodeCompleted(id, completion),
  (slot) => drainPendingGridLane(slot)
);'''
new = '''  (id, completion) => noteDecodeCompleted(id, completion),
  (slot) => drainPendingGridLane(slot),
  ({ sourceSequence, signature }) => {
    const sequence = Number(sourceSequence);
    if (!Number.isFinite(sequence) || !signature) return;
    if (!latestRepeatSignature || sequence > latestRepeatSignature.sourceSequence) {
      latestRepeatSignature = { sourceSequence: sequence, signature };
    }
  }
);'''
assert old in s
s = s.replace(old, new, 1)

old = '''  message.jobKind = kind;
  message.trackCount = auditMode.tracks;
  message.sourceSequence = sourceSequence;
  if (sourceOpticsEpoch !== void 0) message.opticsEpoch = sourceOpticsEpoch;
  const accepted = preferredWorker === void 0 ? pool.submit(message, transfer) : pool.submitTo(preferredWorker, message, transfer);'''
new = '''  message.jobKind = kind;
  message.trackCount = auditMode.tracks;
  message.sourceSequence = sourceSequence;
  if (sourceOpticsEpoch !== void 0) message.opticsEpoch = sourceOpticsEpoch;
  const repeatEligible = Boolean(
    guidedStage && !auditMode.full && auditMode.tracks >= 2 && message.pixelFormat === "y8" &&
    !replayRunning && !optimizerPipelineActive && autoOpticsRuntimeState !== "tuning" && !captureNextScan
  );
  message.repeatFilter = repeatEligible;
  if (repeatEligible && latestRepeatSignature?.sourceSequence === sourceSequence - 1) {
    message.previousFrameSignature = latestRepeatSignature.signature;
  }
  const accepted = preferredWorker === void 0 ? pool.submit(message, transfer) : pool.submitTo(preferredWorker, message, transfer);'''
assert old in s
s = s.replace(old, new, 1)

old = '''  if (completion.pixelPath) lastDirectPixelPath = completion.pixelPath;
  if (auditThisCompletion && completion.nativeMetrics) {'''
new = '''  if (completion.pixelPath) lastDirectPixelPath = completion.pixelPath;
  if (completion.repeatSkipped) {
    repeatSkipTimes.push(receiverNow());
    notePipelineEvent("repeat-frame-skip", Number.isFinite(completion.repeatDistance) ? completion.repeatDistance : 0);
  }
  if (auditThisCompletion && completion.nativeMetrics) {'''
assert old in s
s = s.replace(old, new, 1)

old = '''  optimizerAttributionComplete(id);
  if (!attempts) return;
  for (const attempt of attempts) {'''
new = '''  optimizerAttributionComplete(id);
  if (!attempts || completion.repeatSkipped) return;
  for (const attempt of attempts) {'''
assert old in s
s = s.replace(old, new, 1)

old = '''  while (pendingLaneReplaceTimes.length && pendingLaneReplaceTimes[0] <= windowStart) pendingLaneReplaceTimes.shift();
  const trackedSubmits = hotJobSubmitSamples.filter((sample) => !sample.full);'''
new = '''  while (pendingLaneReplaceTimes.length && pendingLaneReplaceTimes[0] <= windowStart) pendingLaneReplaceTimes.shift();
  while (repeatSkipTimes.length && repeatSkipTimes[0] <= windowStart) repeatSkipTimes.shift();
  const repeatSkipRate = repeatSkipTimes.length / (STATS_WINDOW_MS / 1e3);
  const trackedSubmits = hotJobSubmitSamples.filter((sample) => !sample.full);'''
assert old in s
s = s.replace(old, new, 1)
old = '''`Pressure worker-busy ${workerBusyEventRate.toFixed(1)}/s · latest replacements ${(pendingLaneReplaceTimes.length / (STATS_WINDOW_MS / 1e3)).toFixed(1)}/s · crop recenters ${laneCropRecentersTotal} · avg job ${averageJobMs.toFixed(1)}ms'''
new = '''`Pressure worker-busy ${workerBusyEventRate.toFixed(1)}/s · latest replacements ${(pendingLaneReplaceTimes.length / (STATS_WINDOW_MS / 1e3)).toFixed(1)}/s · repeat skips ${repeatSkipRate.toFixed(1)}/s · crop recenters ${laneCropRecentersTotal} · avg job ${averageJobMs.toFixed(1)}ms'''
assert old in s
s = s.replace(old, new, 1)

old = '''  duplicateQrTimes.length = 0;
  resetDuplicateAttribution();
  poolBusyTimes.length = 0;'''
new = '''  duplicateQrTimes.length = 0;
  resetDuplicateAttribution();
  repeatSkipTimes.length = 0;
  latestRepeatSignature = undefined;
  poolBusyTimes.length = 0;'''
assert old in s
s = s.replace(old, new, 1)
p.write_text(s)

# ---- version/cache ----------------------------------------------------------
for name in ['index.html', 'main.js']:
    p = root / name
    text = p.read_text()
    assert 'v0.5.153' in text, name
    p.write_text(text.replace('v0.5.153', 'v0.5.154'))

sw = root / 'sw.js'
text = sw.read_text()
assert 'airgapper-static-js-v115' in text
sw.write_text(text.replace('airgapper-static-js-v115', 'airgapper-static-js-v116', 1))
