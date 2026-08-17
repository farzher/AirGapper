from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"replacement not found in {path}: {old[:180]!r}")
    p.write_text(s.replace(old, new, count))


def replace_span(path, start, end, new):
    p = Path(path)
    s = p.read_text()
    a = s.find(start)
    if a < 0:
        raise SystemExit(f"start marker missing in {path}: {start!r}")
    b = s.find(end, a)
    if b < 0:
        raise SystemExit(f"end marker missing in {path}: {end!r}")
    p.write_text(s[:a] + new + s[b:])


# Version/cache bump.
replace("index.html", "v0.5.193", "v0.5.194")
replace("main.js", 'const APP_BUILD = "v0.5.193";', 'const APP_BUILD = "v0.5.194";')
replace("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.193";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.194";')
replace("sw.js", 'const CACHE = "airgapper-static-js-v155";', 'const CACHE = "airgapper-static-js-v156";')

# ---------------------------------------------------------------------------
# Startup optics: a saved manual profile is currently applied only after the
# preview has started. Prime it immediately after getUserMedia returns so the
# user never has to stare at the camera's bright AE startup frames.
# ---------------------------------------------------------------------------
replace(
    "receive/main.js",
    '''  stream = acquiredStream;\n  startBtn.style.display = "none";''',
    '''  stream = acquiredStream;\n  const startupOpticsTrack = stream.getVideoTracks()[0];\n  if (startupOpticsTrack && !automaticOptics) {\n    seedDesiredCamera(startupOpticsTrack);\n    await applyExposureSetting(startupOpticsTrack);\n  }\n  startBtn.style.display = "none";'''
)

# The HAL can overwrite the first manual write while the camera pipeline comes
# alive. Reassert after the first fresh source frame rather than waiting for
# three frames / up to 1.2 s.
replace(
    "receive/main.js",
    '''      (latestSourceFrameSequence - firstSequence < 3 || frameModeSync) &&\n      performance.now() - startedAt < 1200) {''',
    '''      (latestSourceFrameSequence - firstSequence < 1 || frameModeSync) &&\n      performance.now() - startedAt < 450) {'''
)

# ---------------------------------------------------------------------------
# Adaptive cached-module decoder.
# The native persistent decoder already stores distortion-corrected module
# centers and can decode from direct Y samples + CRC. It was removed from the
# production pre-pass after the old camera produced only ~2.7% CRC hits. Probe
# it again per worker, but make it self-disabling when the current camera/pose
# does not support it. Guided only receives the slots the cache missed.
# ---------------------------------------------------------------------------
replace(
    "receive/worker.js",
    '''const nativeRefresh = /* @__PURE__ */ new Set();''',
    '''const nativeRefresh = /* @__PURE__ */ new Set();\nlet nativeGuidedSamples = 0;\nlet nativeGuidedHitEwma = 0;\nlet nativeGuidedCooldown = 0;\nlet nativeGuidedProbeDelay = Math.floor(Math.random() * 4);\nconst NATIVE_GUIDED_BAD_RATIO = 0.20;\nconst NATIVE_GUIDED_COOLDOWN_JOBS = 12;'''
)

start = '''      if (guidedDecode && decodePixelFormat === "y8" && tracks.length >= 2) {'''
end = '''      readFullAttempts++;'''
new = r'''      if (guidedDecode && decodePixelFormat === "y8" && tracks.length >= 2) {
        // The high-quality camera changes the economics of the old native
        // tracker. When geometry is healthy and every lane carries AirGapper's
        // CRC, give the persistent cached-module decoder a bounded canary. A
        // calibrated hit bypasses finder search, alignment search and normal QR
        // RS; Guided is invoked only for the lanes that missed.
        const cacheEligible = tracks.every((track) => track.crc32 && (track.misses ?? 0) <= 2);
        if (nativeGuidedProbeDelay > 0) nativeGuidedProbeDelay--;
        if (nativeGuidedCooldown > 0) nativeGuidedCooldown--;
        const tryNative = cacheEligible && nativeGuidedProbeDelay <= 0 && nativeGuidedCooldown <= 0;
        let native;
        let nativeSymbols = [];
        if (tryNative) {
          native = decodeNativeBatch(
            zx,
            ptr + inputOffset,
            pw,
            ph,
            ox,
            oy,
            tracks,
            decodePixelFormat,
            inputStride
          );
          nativeSymbols = native?.symbols ?? [];
          const hitRatio = nativeSymbols.length / Math.max(1, tracks.length);
          nativeGuidedHitEwma = nativeGuidedSamples
            ? nativeGuidedHitEwma * 0.72 + hitRatio * 0.28
            : hitRatio;
          nativeGuidedSamples++;
          // A bad camera/pose pays for at most two calibration probes before
          // backing off. Periodic retries let a later focus/pose improvement
          // reactivate the cache without a worker restart.
          if (nativeGuidedSamples >= 2 && nativeGuidedHitEwma < NATIVE_GUIDED_BAD_RATIO)
            nativeGuidedCooldown = NATIVE_GUIDED_COOLDOWN_JOBS;
          else if (nativeGuidedSamples >= 2 && hitRatio === 0)
            nativeGuidedCooldown = 4;
        }

        const nativeSlots = new Set(nativeSymbols.flatMap((symbol) =>
          symbol.header?.slotIndex === void 0 ? [] : [symbol.header.slotIndex]
        ));
        const remaining = [];
        let remainingFallbackMask = 0;
        for (let index = 0; index < tracks.length; index++) {
          const track = tracks[index];
          if (track.slot !== void 0 && nativeSlots.has(track.slot)) continue;
          const nextIndex = remaining.length;
          remaining.push(track);
          if ((guidedFallbackMask >>> index) & 1) remainingFallbackMask |= 1 << nextIndex;
        }

        let guided;
        if (remaining.length) {
          guided = decodeGuidedBatch(
            zx, ptr + inputOffset, pw, ph, inputStride, ox, oy, remaining, remainingFallbackMask >>> 0
          );
        }
        symbols.push(...nativeSymbols);
        if (guided) symbols.push(...guided.symbols);
        mapOutputToDisplay();
        const cachedOnly = tryNative && nativeSymbols.length === tracks.length;
        ctx.postMessage({
          id,
          symbols,
          sightings,
          full: false,
          trackedAttempted: true,
          trackedHit: symbols.length > 0,
          fallbackAttempted: false,
          fallbackSucceeded: false,
          readFullAttempts: 0,
          workerWaitMs,
          frameCopyMs,
          guidedMetrics: guided?.metrics,
          nativeMetrics: native?.metrics,
          nativeAssistTracks: tryNative ? tracks.length : 0,
          nativeAssistHits: nativeSymbols.length,
          guidedAssistTracks: remaining.length,
          pixelPath: cachedOnly ? "y8-cached" : nativeSymbols.length ? "y8-cached+guided" : "y8-guided",
          guidedError: guided?.error,
          latencyMs: performance.now() - startedAt
        });
        return;
      }
'''
replace_span("receive/worker.js", start, end, new)
