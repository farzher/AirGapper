from pathlib import Path


def replace_exact(path, old, new, count=1):
    p = Path(path)
    text = p.read_text()
    actual = text.count(old)
    if actual != count:
        raise SystemExit(f"{path}: expected {count} matches, found {actual}")
    p.write_text(text.replace(old, new, count))


old = '''      if (guidedDecode && decodePixelFormat === "y8" && tracks.length >= 6) {
        const guided = decodeGuidedBatch(zx, ptr + inputOffset, pw, ph, inputStride, ox, oy, tracks);
        if (guided) symbols.push(...guided.symbols);
        mapOutputToDisplay();
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
          pixelPath: "y8-guided",
          guidedError: guided?.error,
          latencyMs: performance.now() - startedAt
        });
        return;
      }
'''
new = '''      if (guidedDecode && decodePixelFormat === "y8" && tracks.length >= 6) {
        // The persistent sampler is extremely cheap when its cached geometry is
        // still correct, but stale geometry used to make it a poor primary
        // decoder. Use it only as a CRC-gated optimistic front-end to the
        // current-frame guided decoder: verified native hits are accepted, and
        // every miss still gets the proven finder-guided path below.
        const nativeTracks = tracks.filter((track) => Boolean(track.crc32));
        const native = nativeTracks.length
          ? decodeNativeBatch(zx, ptr + inputOffset, pw, ph, ox, oy, nativeTracks, "y8", inputStride)
          : null;
        const nativeSymbols = native?.symbols ?? [];
        if (nativeSymbols.length) symbols.push(...nativeSymbols);
        const nativeSlots = new Set(nativeSymbols.flatMap((symbol) =>
          Number.isInteger(symbol.header?.slotIndex) ? [symbol.header.slotIndex] : []
        ));
        const guidedTracks = nativeSlots.size
          ? tracks.filter((track) => !nativeSlots.has(track.slot))
          : tracks;
        const guided = guidedTracks.length
          ? decodeGuidedBatch(zx, ptr + inputOffset, pw, ph, inputStride, ox, oy, guidedTracks)
          : null;
        if (guided) symbols.push(...guided.symbols);
        mapOutputToDisplay();
        const reply = {
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
          nativeMetrics: native?.metrics,
          guidedMetrics: guided?.metrics,
          nativeAssistTracks: nativeTracks.length,
          nativeAssistHits: nativeSymbols.length,
          guidedAssistTracks: guidedTracks.length,
          pixelPath: nativeTracks.length ? "y8-native+guided" : "y8-guided",
          guidedError: guided?.error,
          latencyMs: performance.now() - startedAt
        };
        const transfer = native?.outputBuffer && nativeSymbols.length ? [native.outputBuffer] : [];
        ctx.postMessage(reply, transfer);
        return;
      }
'''

replace_exact('receive/worker.js', old, new)
replace_exact('index.html', 'v0.5.137', 'v0.5.138')
replace_exact('main.js', 'v0.5.137', 'v0.5.138')
replace_exact('receive/main.js', 'v0.5.137', 'v0.5.138')
replace_exact('sw.js', 'airgapper-static-js-v100', 'airgapper-static-js-v101')
