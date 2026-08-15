from pathlib import Path


def replace(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, got {count}: {old[:100]!r}")
    p.write_text(text.replace(old, new))


replace("receive/worker.js", '''    const usedDirectFrame = Boolean(ownedVideoFrame);
    let frameCopyMs = 0;
    let inputOffset = pixelFormat === "y8" ? messageYOffset : 0;
    let inputStride = pixelFormat === "y8" ? messageYStride || w : w * 4;
    let decodePixelFormat = pixelFormat;
    let pixels;
    const zx = await ready;
    let ptr;
    if (ownedVideoFrame) {
      const rect = { x: cropX, y: cropY, width: w, height: h };
      const copyOptions = pixelFormat === "y8" ? { rect } : { rect, format: "RGBA" };
      const allocationBytes = ownedVideoFrame.allocationSize(copyOptions);
      ptr = inputBuffer(zx, allocationBytes);
      const copyStarted = performance.now();
      const planes = await ownedVideoFrame.copyTo(zx.HEAPU8.subarray(ptr, ptr + allocationBytes), copyOptions);
      frameCopyMs = performance.now() - copyStarted;
      const plane = planes[0];
      if (!plane) throw new Error("Camera frame has no usable pixel plane");
      inputOffset = plane.offset;
      inputStride = plane.stride;
      decodePixelFormat = pixelFormat === "y8" ? "y8" : "rgba";
''', '''    const usedDirectFrame = Boolean(ownedVideoFrame);
    // A persistent native miss is a local decoder problem, not a reason to
    // wait for a whole-grid recovery scan. After two misses, copy this same
    // bounded crop as RGBA so the robust stock decoder can rescue/re-anchor it.
    const robustTrackedRecovery = !full && Array.isArray(tracks) && tracks.some((track) => (track.misses ?? 0) >= 2);
    let frameCopyMs = 0;
    let inputOffset = pixelFormat === "y8" ? messageYOffset : 0;
    let inputStride = pixelFormat === "y8" ? messageYStride || w : w * 4;
    let decodePixelFormat = pixelFormat;
    let pixels;
    const zx = await ready;
    let ptr;
    if (ownedVideoFrame) {
      const rect = { x: cropX, y: cropY, width: w, height: h };
      const copyAsRgba = pixelFormat !== "y8" || robustTrackedRecovery;
      const copyOptions = copyAsRgba ? { rect, format: "RGBA" } : { rect };
      const allocationBytes = ownedVideoFrame.allocationSize(copyOptions);
      ptr = inputBuffer(zx, allocationBytes);
      const copyStarted = performance.now();
      const planes = await ownedVideoFrame.copyTo(zx.HEAPU8.subarray(ptr, ptr + allocationBytes), copyOptions);
      frameCopyMs = performance.now() - copyStarted;
      const plane = planes[0];
      if (!plane) throw new Error("Camera frame has no usable pixel plane");
      inputOffset = plane.offset;
      inputStride = plane.stride;
      decodePixelFormat = copyAsRgba ? "rgba" : "y8";
''')

replace("receive/worker.js", '''    if (!full && (tracks == null ? void 0 : tracks.length)) {
      const trackedVisual = strictTracked ? null : sampleTrackedVisual(zx, ptr + inputOffset, pw, ph, ox, oy, tracks, decodePixelFormat, inputStride);
''', '''    if (!full && (tracks == null ? void 0 : tracks.length)) {
      // Never let the unchanged-frame gate suppress a requested recovery.
      const trackedVisual = strictTracked || robustTrackedRecovery ? null : sampleTrackedVisual(zx, ptr + inputOffset, pw, ph, ox, oy, tracks, decodePixelFormat, inputStride);
''')

replace("receive/worker.js", '''      if (native || usedDirectFrame) {
        const nativeSymbols = native?.symbols ?? [];
        if (nativeSymbols.length > 0 && trackedVisual) rememberTrackedVisual(trackedVisual, performance.now());
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
      readFullAttempts++;
''', '''      const nativeSymbols = native?.symbols ?? [];
      if (nativeSymbols.length > 0 && trackedVisual) rememberTrackedVisual(trackedVisual, performance.now());
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
''')

replace("index.html", 'AirGapper <span class="app-version">v0.5.47</span>', 'AirGapper <span class="app-version">v0.5.48</span>')
replace("sw.js", 'const CACHE = "airgapper-static-js-v10";', 'const CACHE = "airgapper-static-js-v11";')
