from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    text = p.read_text()
    n = text.count(old)
    if n != count:
        raise SystemExit(f"{path}: expected {count} matches, got {n}: {old[:140]!r}")
    p.write_text(text.replace(old, new))

replace("index.html", "v0.5.53", "v0.5.54")
replace("sw.js", 'airgapper-static-js-v16', 'airgapper-static-js-v17')

# Worker: one diagnostic A/B per worker, isolated from persistent native state.
replace(
    "receive/worker.js",
    'const nativeRefresh = /* @__PURE__ */ new Set();',
    'const nativeRefresh = /* @__PURE__ */ new Set();\nlet directPixelAuditDone = false;'
)

insert_before = 'let qrGeneratorPromise;\n'
helper = r'''function decodeNativeAuditRGBA(zx, ptr, width, height, ox, oy, tracks, stride = width * 4) {
  const count = Math.min(NATIVE_BATCH_MAX_TRACKS, tracks.length);
  if (!count) return null;
  const handle = zx._createTrackedDecoder(count, 177);
  if (!handle) return null;
  const resultsPtr = zx._malloc(count * NATIVE_TRACK_RESULT_BYTES);
  const outputPtr = zx._malloc(NATIVE_BATCH_OUTPUT_BYTES);
  const metricsPtr = zx._malloc(NATIVE_BATCH_METRICS_BYTES);
  try {
    for (let slot = 0; slot < count; slot++) {
      const track = tracks[slot];
      const q = track.quad;
      const id = track.slot ?? track.id;
      if (!zx._setTrackedDecoderTrack(handle, slot, id, track.dim,
        q.topLeft.x - ox, q.topLeft.y - oy,
        q.topRight.x - ox, q.topRight.y - oy,
        q.bottomRight.x - ox, q.bottomRight.y - oy,
        q.bottomLeft.x - ox, q.bottomLeft.y - oy)) return null;
      zx._setTrackedDecoderTrackCRC32(handle, slot, track.crc32 ? 1 : 0);
    }
    zx._setTrackedDecoderFallbackBudget(handle, 0);
    const resultCount = zx._decodeTrackedBatchRGBA(
      handle, ptr, width, height, stride,
      resultsPtr, count, outputPtr, NATIVE_BATCH_OUTPUT_BYTES, metricsPtr
    );
    if (resultCount < 0) return null;
    const view = new DataView(zx.HEAPU8.buffer);
    return {
      tracks: view.getUint32(metricsPtr + 48, true),
      successful: view.getUint32(metricsPtr + 56, true),
      misses: view.getUint32(metricsPtr + 60, true),
      crcFastSuccesses: view.getUint32(metricsPtr + 64, true),
      rsFallbacks: view.getUint32(metricsPtr + 68, true),
      anchorMisses: view.getUint32(metricsPtr + 76, true),
      outOfFrameMisses: view.getUint32(metricsPtr + 84, true),
      bitstreamFailures: view.getUint32(metricsPtr + 88, true),
      crcFailures: view.getUint32(metricsPtr + 92, true)
    };
  } finally {
    zx._destroyTrackedDecoder(handle);
    zx._free(metricsPtr);
    zx._free(outputPtr);
    zx._free(resultsPtr);
  }
}
'''
replace("receive/worker.js", insert_before, helper + insert_before)

# Always do the normal direct Y-plane copy first. Do not silently turn a
# recovery-eligible frame into an RGBA native attempt.
replace(
    "receive/worker.js",
    '''      const copyAsRgba = pixelFormat !== "y8" || robustTrackedRecovery;
      const copyOptions = copyAsRgba ? { rect, format: "RGBA" } : { rect };''',
    '''      const copyAsRgba = pixelFormat !== "y8";
      const copyOptions = copyAsRgba ? { rect, format: "RGBA" } : { rect };'''
)
replace(
    "receive/worker.js",
    '''      ownedVideoFrame.close();
      ownedVideoFrame = null;
    } else {''',
    '''      // Keep a direct Y-plane frame alive until the native attempt finishes.
      // Recovery/diagnostics may need an RGBA copy of this exact same frame.
      if (copyAsRgba || full || !(tracks?.length)) {
        ownedVideoFrame.close();
        ownedVideoFrame = null;
      }
    } else {'''
)

old_native = r'''      const nativeSymbols = native?.symbols ?? [];
      const robustFallback = robustTrackedRecovery && decodePixelFormat === "rgba" && nativeSymbols.length === 0;
      if (!robustFallback && (native || usedDirectFrame)) {
        const directFrameFailed = usedDirectFrame && !native;
        const reply = {
          id,
          symbols: nativeSymbols,
          sightings,
          full: false,
          trackedAttempted: native?.attempted ?? true,
          trackedHit: nativeSymbols.length > 0,
          fallbackAttempted: false,
          fallbackSucceeded: false,
          readFullAttempts: 0,
          workerWaitMs,
          targetedAttempts: 0,
          targetedPixels: 0,
          targetedSuccesses: 0,
          frameCopyMs,
          nativeMetrics: native?.metrics,
          directFrameFailed,
          latencyMs: performance.now() - startedAt
        };
        const transfer = native?.outputBuffer && nativeSymbols.length ? [native.outputBuffer] : [];
        ctx.postMessage(reply, transfer);
        return;
      }
      // Native tracking has repeatedly missed this known crop. Run the robust
      // QR detector only inside the bounded lane crop, then feed its fresh quad
      // back through the normal lattice update. This is deliberately local.
      readFullAttempts++;
      const decoded = zx.readFull(ptr, pw, ph, true, Math.min(16, Math.max(1, tracks.length)), false);'''
new_native = r'''      const nativeSymbols = native?.symbols ?? [];
      let pixelAudit = null;
      let rgbaRecoveryPtr = 0;
      let rgbaRecoveryStride = 0;

      // One-shot developer A/B: after a real Y8 miss, feed the exact same
      // VideoFrame crop to an isolated temporary native decoder as RGBA. Never
      // accept its symbols or mutate persistent tracking. This tells us whether
      // the direct Y plane itself is the difference without rescuing Strict mode.
      if (nativeSymbols.length === 0 && strictHotPath && diagnoseSampler && usedDirectFrame &&
          pixelFormat === "y8" && ownedVideoFrame && !directPixelAuditDone) {
        directPixelAuditDone = true;
        const rect = { x: cropX, y: cropY, width: w, height: h };
        const options = { rect, format: "RGBA" };
        const bytes = ownedVideoFrame.allocationSize(options);
        rgbaRecoveryPtr = inputBuffer(zx, bytes);
        const copyStarted = performance.now();
        const planes = await ownedVideoFrame.copyTo(zx.HEAPU8.subarray(rgbaRecoveryPtr, rgbaRecoveryPtr + bytes), options);
        frameCopyMs += performance.now() - copyStarted;
        rgbaRecoveryStride = planes[0]?.stride ?? w * 4;
        pixelAudit = decodeNativeAuditRGBA(zx, rgbaRecoveryPtr + (planes[0]?.offset ?? 0), pw, ph, ox, oy, tracks, rgbaRecoveryStride);
      }

      const robustFallback = robustTrackedRecovery && nativeSymbols.length === 0;
      if (!robustFallback && (native || usedDirectFrame)) {
        ownedVideoFrame?.close();
        ownedVideoFrame = null;
        const directFrameFailed = usedDirectFrame && !native;
        const reply = {
          id,
          symbols: nativeSymbols,
          sightings,
          full: false,
          trackedAttempted: native?.attempted ?? true,
          trackedHit: nativeSymbols.length > 0,
          fallbackAttempted: false,
          fallbackSucceeded: false,
          readFullAttempts: 0,
          workerWaitMs,
          targetedAttempts: 0,
          targetedPixels: 0,
          targetedSuccesses: 0,
          frameCopyMs,
          nativeMetrics: native?.metrics,
          pixelAudit,
          directFrameFailed,
          latencyMs: performance.now() - startedAt
        };
        const transfer = native?.outputBuffer && nativeSymbols.length ? [native.outputBuffer] : [];
        ctx.postMessage(reply, transfer);
        return;
      }

      // The normal hot path already missed on Y8. Only now copy this exact
      // bounded crop as RGBA for the explicitly counted robust local recovery.
      // Do NOT retry native on RGBA as an unlabelled alternate hot path.
      if (ownedVideoFrame) {
        const rect = { x: cropX, y: cropY, width: w, height: h };
        const options = { rect, format: "RGBA" };
        const bytes = ownedVideoFrame.allocationSize(options);
        ptr = inputBuffer(zx, bytes);
        const copyStarted = performance.now();
        const planes = await ownedVideoFrame.copyTo(zx.HEAPU8.subarray(ptr, ptr + bytes), options);
        frameCopyMs += performance.now() - copyStarted;
        const plane = planes[0];
        if (!plane || plane.stride < w * 4) throw new Error("Camera RGBA recovery stride is invalid");
        ptr += plane.offset;
        inputStride = plane.stride;
        decodePixelFormat = "rgba";
        ownedVideoFrame.close();
        ownedVideoFrame = null;
      }
      // Native tracking has repeatedly missed this known crop. Run the robust
      // QR detector only inside the bounded lane crop, then feed its fresh quad
      // back through the normal lattice update. This is deliberately local.
      readFullAttempts++;
      const decoded = zx.readFull(ptr, pw, ph, true, Math.min(16, Math.max(1, tracks.length)), false);'''
replace("receive/worker.js", old_native, new_native)

# Main audit: aggregate the isolated RGBA-on-Y8-miss diagnostic.
replace(
    "receive/main.js",
    '''  multiSampleRetries: 0,
  localRecoveryAttempts: 0,''',
    '''  multiSampleRetries: 0,
  pixelAuditTracks: 0,
  pixelAuditCrcFast: 0,
  pixelAuditMisses: 0,
  pixelAuditAnchorMisses: 0,
  pixelAuditFrameMisses: 0,
  pixelAuditBitstreamFailures: 0,
  pixelAuditCrcFailures: 0,
  localRecoveryAttempts: 0,'''
)
replace(
    "receive/main.js",
    '''  hotPathAudit.readFullAttempts += completion.readFullAttempts ?? 0;
  if (completion.fallbackAttempted) {''',
    '''  hotPathAudit.readFullAttempts += completion.readFullAttempts ?? 0;
  if (completion.pixelAudit) {
    hotPathAudit.pixelAuditTracks += completion.pixelAudit.tracks ?? 0;
    hotPathAudit.pixelAuditCrcFast += completion.pixelAudit.crcFastSuccesses ?? 0;
    hotPathAudit.pixelAuditMisses += completion.pixelAudit.misses ?? 0;
    hotPathAudit.pixelAuditAnchorMisses += completion.pixelAudit.anchorMisses ?? 0;
    hotPathAudit.pixelAuditFrameMisses += completion.pixelAudit.outOfFrameMisses ?? 0;
    hotPathAudit.pixelAuditBitstreamFailures += completion.pixelAudit.bitstreamFailures ?? 0;
    hotPathAudit.pixelAuditCrcFailures += completion.pixelAudit.crcFailures ?? 0;
  }
  if (completion.fallbackAttempted) {'''
)
replace(
    "receive/main.js",
    '''Threshold local fallback ${hotPathAudit.thresholdFallbacks} · multisample retries ${hotPathAudit.multiSampleRetries}
Generic full''',
    '''Threshold local fallback ${hotPathAudit.thresholdFallbacks} · multisample retries ${hotPathAudit.multiSampleRetries}
Pixel A/B Y8-miss → isolated RGBA CRC ${hotPathAudit.pixelAuditCrcFast}/${hotPathAudit.pixelAuditTracks} · misses ${hotPathAudit.pixelAuditMisses} (anchor ${hotPathAudit.pixelAuditAnchorMisses} · frame ${hotPathAudit.pixelAuditFrameMisses} · bits ${hotPathAudit.pixelAuditBitstreamFailures} · CRC ${hotPathAudit.pixelAuditCrcFailures})
Generic full'''
)

# Ensure successful non-native/full paths also don't leak a retained frame.
replace(
    "receive/worker.js",
    '''    ctx.postMessage({
      id,
      symbols,
      sightings,
      full,
      trackedAttempted,''',
    '''    ownedVideoFrame?.close();
    ownedVideoFrame = null;
    ctx.postMessage({
      id,
      symbols,
      sightings,
      full,
      trackedAttempted,'''
)

# Invariants.
worker = Path("receive/worker.js").read_text()
main = Path("receive/main.js").read_text()
assert 'copyAsRgba = pixelFormat !== "y8";' in worker
assert 'decodeNativeAuditRGBA' in worker
assert 'Do NOT retry native on RGBA' in worker
assert 'pixelAudit' in main
assert 'Pixel A/B Y8-miss' in main
assert 'v0.5.54' in Path("index.html").read_text()
assert 'airgapper-static-js-v17' in Path("sw.js").read_text()
