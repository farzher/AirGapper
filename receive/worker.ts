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

import wasmUrl from "./wasm-url";
import { shouldRunFullDecode } from "../shared/decode-policy";
import DecimenCodec, { type DecimenModule, type DecimenQuad } from "../vendor/decimen-codec/decimen_codec.js";

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
function shifted(p: DecimenQuad, ox: number, oy: number): DecimenQuad {
  const s = (pt: { x: number; y: number }) => ({ x: pt.x + ox, y: pt.y + oy });
  return {
    topLeft: s(p.topLeft),
    topRight: s(p.topRight),
    bottomRight: s(p.bottomRight),
    bottomLeft: s(p.bottomLeft),
  };
}

// Reused for bitmap captures: the GPU-cropped ImageBitmap is drawn here and
// read back on THIS thread — the whole point of the bitmap path is that the
// main thread never touches pixels.
let offscreen: OffscreenCanvas | undefined;

/** Pixels from either capture mode: a transferred ArrayBuffer (readback
 *  fallback) or an ImageBitmap (GPU-side crop, Safari 17+/modern engines). */
function pixelsOf(buf: ArrayBuffer | undefined, bitmap: ImageBitmap | undefined, w: number, h: number) {
  if (bitmap) {
    const bw = bitmap.width;
    const bh = bitmap.height;
    if (!offscreen || offscreen.width !== bw || offscreen.height !== bh) {
      offscreen = new OffscreenCanvas(bw, bh);
    }
    const octx = offscreen.getContext("2d", { willReadFrequently: true })!;
    octx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const img = octx.getImageData(0, 0, bw, bh);
    return { data: img.data, w: bw, h: bh };
  }
  return { data: new Uint8Array(buf!), w, h };
}

ctx.onmessage = async (e: MessageEvent) => {
  const { id, buf, bitmap, w = 0, h = 0, ox = 0, oy = 0, full = true, quad, dim } = e.data as {
    id: number;
    /** Readback-fallback capture: raw RGBA. */
    buf?: ArrayBuffer;
    /** Bitmap capture: GPU-cropped, pixels read on this thread. */
    bitmap?: ImageBitmap;
    w?: number;
    h?: number;
    /** Crop origin within the capture, for mapping positions back. */
    ox?: number;
    oy?: number;
    /** Full-frame scan (up to a 3×4 grid) vs a single-code crop. */
    full?: boolean;
    /** The region's last decoded quad, capture coordinates — tracked path. */
    quad?: DecimenQuad;
    /** The stream's QR dimension in modules — tracked path. */
    dim?: number;
  };
  const pixels = pixelsOf(buf, bitmap, w, h);
  const { w: pw, h: ph } = pixels;
  let zx: DecimenModule | undefined;
  let ptr = 0;
  try {
    zx = await ready;
    ptr = zx._malloc(pw * ph * 4);
    zx.HEAPU8.set(
      pixels.data instanceof Uint8Array ? pixels.data : new Uint8Array(pixels.data.buffer),
      ptr,
    );
    const symbols: { bytes: Uint8Array; box: object; quad: DecimenQuad; modules: number; tracked: boolean }[] = [];
    const sightings: object[] = [];

    let trackedHit = false;
    let trackedAttempted = false;
    if (!full && quad && dim) {
      trackedAttempted = true;
      const r = zx.readTracked(
        ptr, pw, ph, dim,
        quad.topLeft.x - ox, quad.topLeft.y - oy,
        quad.topRight.x - ox, quad.topRight.y - oy,
        quad.bottomRight.x - ox, quad.bottomRight.y - oy,
        quad.bottomLeft.x - ox, quad.bottomLeft.y - oy,
      );
      if (r.valid && r.bytes.length > 0) {
        symbols.push({
          bytes: r.bytes,
          box: boundsOf(r.position, ox, oy),
          quad: shifted(r.position, ox, oy),
          modules: r.modules,
          tracked: true,
        });
        trackedHit = true;
      }
    }

    if (shouldRunFullDecode(full, trackedAttempted, trackedHit)) {
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
            box: boundsOf(r.position, ox, oy),
            quad: shifted(r.position, ox, oy),
            modules: r.modules,
            tracked: false,
          });
        } else if (full) {
          // A symbol zxing DETECTED but could not decode (glare or noise past
          // the ECC budget) is still a fix on where a code sits — the
          // receiver aims a crop there, and crops decode where full frames
          // fail. Positions stay pixel-accurate through a ChecksumError.
          const box = boundsOf(r.position, ox, oy);
          if (box.w > 0 && box.h > 0) sightings.push(box);
        }
      }
      vec.delete();
    }
    ctx.postMessage({ id, symbols, sightings, trackedAttempted });
  } catch {
    ctx.postMessage({ id, symbols: [], sightings: [] });
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
