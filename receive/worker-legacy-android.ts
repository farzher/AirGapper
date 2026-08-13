// QR decode worker: the decimen-codec engine (a custom zxing-cpp build)
// compiled to WASM. (Safari has
// never shipped BarcodeDetector — WebKit bug 281848 — so WASM is the only
// portable way.) One frame in flight per worker; the main thread drops frames
// when all workers are busy. Frames are disposable — the fountain doesn't care.
//
// Two decode paths (see ../../decimen-codec/wrapper/decimen_codec.cpp):
//  - readFull: stock acquisition. QR-only, invert/rotate sweeps compiled off,
//    error results carry positions (the receiver's crop-seeding sightings).
//  - readTracked: crops that arrive with a cached quad + module count skip
//    detection entirely — the transform is rebuilt from the quad and the grid
//    is sampled directly. Bench-measured 2.0–2.6× per decode at V40, which is
//    CPU the phone doesn't burn: the custom build exists for throughput AND
//    thermals.
//    Any tracked miss falls back to readFull on the same buffer, which also
//    re-anchors the quad. Tracked is opportunistic, never load-bearing.

import wasmUrl from "./wasm-url-android";
import DecimenCodec, { type DecimenModule, type DecimenQuad } from "../vendor/decimen-codec-android/decimen_codec.js";

const ready: Promise<DecimenModule> = DecimenCodec({
  locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? wasmUrl : prefix + path),
});

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

/** Axis-aligned bounds of a symbol quad, shifted into capture coordinates by
 *  the crop offset — the receiver uses these to crop the next frames. */
function boundsOf(p: DecimenQuad, ox: number, oy: number) {
  const xs = [p.topLeft.x, p.topRight.x, p.bottomRight.x, p.bottomLeft.x];
  const ys = [p.topLeft.y, p.topRight.y, p.bottomRight.y, p.bottomLeft.y];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x: ox + x, y: oy + y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** The full quad in capture coordinates — the tracked path's anchor. */
function shifted(p: DecimenQuad, ox: number, oy: number, scaleX = 1, scaleY = 1): DecimenQuad {
  const s = (pt: { x: number; y: number }) => ({ x: pt.x * scaleX + ox, y: pt.y * scaleY + oy });
  return {
    topLeft: s(p.topLeft),
    topRight: s(p.topRight),
    bottomRight: s(p.bottomRight),
    bottomLeft: s(p.bottomLeft),
  };
}

interface BatchTrack {
  quad: DecimenQuad;
  dim: number;
  crc32?: boolean;
}

ctx.onmessage = async (e: MessageEvent) => {
  const startedAt = performance.now();
  const { id, buf, w = 0, h = 0, ox = 0, oy = 0, scaleX = 1, scaleY = 1, full = true, quad, dim, tracks } = e.data as {
    id: number;
    buf: ArrayBuffer;
    w?: number;
    h?: number;
    ox?: number;
    oy?: number;
    scaleX?: number;
    scaleY?: number;
    full?: boolean;
    quad?: DecimenQuad;
    dim?: number;
    tracks?: BatchTrack[];
  };
  const pixels = new Uint8Array(buf);
  const pw = w;
  const ph = h;
  let zx: DecimenModule | undefined;
  let ptr = 0;
  try {
    zx = await ready;
    ptr = zx._malloc(pw * ph * 4);
    zx.HEAPU8.set(pixels, ptr);
    const symbols: { bytes: Uint8Array; box: object; quad: DecimenQuad; modules: number; tracked: boolean; crc32?: boolean }[] = [];
    const sightings: object[] = [];

    let trackedHit = false;
    const candidates: BatchTrack[] = tracks?.length
      ? tracks
      : quad && dim ? [{ quad, dim }] : [];
    const trackedAttempted = !full && candidates.length > 0;
    if (trackedAttempted) {
      for (const candidate of candidates) {
        const q = candidate.quad;
        const r = zx.readTracked(
          ptr, pw, ph, candidate.dim,
          q.topLeft.x - ox, q.topLeft.y - oy,
          q.topRight.x - ox, q.topRight.y - oy,
          q.bottomRight.x - ox, q.bottomRight.y - oy,
          q.bottomLeft.x - ox, q.bottomLeft.y - oy,
        );
        if (!r.valid || r.bytes.length === 0) continue;
        symbols.push({
          bytes: r.bytes,
          box: boundsOf(r.position, ox, oy),
          quad: shifted(r.position, ox, oy),
          modules: r.modules,
          tracked: true,
          crc32: candidate.crc32,
        });
        trackedHit = true;
      }
    }

    if (full || !trackedAttempted || !trackedHit) {
      // Full scans get returnErrors (sightings live there — error results
      // COUNT against the symbol cap, hence the headroom above 12 codes) and a
      // crop fallback stays in the cheapest configuration. tryHarder stays on
      // everywhere: real marginal captures are where it earns its keep.
      const vec = zx.readFull(ptr, pw, ph, true, full ? 16 : 2, full);
      for (let i = 0; i < vec.size(); i++) {
        const r = vec.get(i);
        if (r.valid && r.bytes.length > 0) {
          symbols.push({
            bytes: r.bytes,
            box: boundsOf(shifted(r.position, ox, oy, scaleX, scaleY), 0, 0),
            quad: shifted(r.position, ox, oy, scaleX, scaleY),
            modules: r.modules,
            tracked: false,
          });
        } else if (full) {
          // A symbol zxing DETECTED but could not decode (glare or noise past
          // the ECC budget) is still a fix on where a code sits — the
          // receiver aims a crop there, and crops decode where full frames
          // fail. Positions stay pixel-accurate through a ChecksumError.
          const box = boundsOf(shifted(r.position, ox, oy, scaleX, scaleY), 0, 0);
          if (box.w > 0 && box.h > 0) sightings.push(box);
        }
      }
      vec.delete();
    }
    ctx.postMessage({
      id, symbols, sightings, full, trackedAttempted, trackedHit,
      fallbackAttempted: !full && !trackedHit,
      latencyMs: performance.now() - startedAt,
    });
  } catch (error) {
    ctx.postMessage({
      id, symbols: [], sightings: [], full,
      latencyMs: performance.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (zx && ptr) zx._free(ptr);
  }
};

// Warm the WASM (instantiation + first-call JIT) so the first real frame
// doesn't pay for it; the pool ignores the {id: -1} ping.
void (async () => {
  try {
    const zx = await ready;
    const ptr = zx._malloc(8 * 8 * 4);
    zx.HEAPU8.set(new Uint8Array(8 * 8 * 4).fill(255), ptr);
    zx.readFull(ptr, 8, 8, false, 1, false).delete();
    zx._free(ptr);
  } catch {
    // a failed warm-up is a slow first frame, not an error
  }
  ctx.postMessage({ id: -1, bytes: null });
})();
