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
//    Tracked misses stay cheap. The scheduler requests a bounded detector crop
//    only after repeated misses, so one bad frame cannot start a fallback storm.

import wasmUrl from "./wasm-url";
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
function shifted(p: DecimenQuad, ox: number, oy: number, scaleX = 1, scaleY = 1): DecimenQuad {
  const s = (pt: { x: number; y: number }) => ({ x: pt.x * scaleX + ox, y: pt.y * scaleY + oy });
  return {
    topLeft: s(p.topLeft),
    topRight: s(p.topRight),
    bottomRight: s(p.bottomRight),
    bottomLeft: s(p.bottomLeft),
  };
}

// Keep one input allocation for this worker's lifetime. Camera crops are
// similarly sized from frame to frame; malloc/free on every decode only adds
// allocator churn to the hottest path.
let inputPtr = 0;
let inputCapacity = 0;
let batchDecoder = 0;
let batchResultsPtr = 0;
let batchOutputPtr = 0;
let batchMetricsPtr = 0;
let batchCapacity = 0;
const batchTrackKeys: string[] = [];

function inputBuffer(zx: DecimenModule, bytes: number): number {
  if (bytes <= inputCapacity) return inputPtr;
  if (inputPtr) zx._free(inputPtr);
  inputPtr = zx._malloc(bytes);
  inputCapacity = bytes;
  return inputPtr;
}

interface BatchTrack {
  id: number;
  quad: DecimenQuad;
  dim: number;
  crc32: boolean;
}

function batchBuffers(zx: DecimenModule, count: number): void {
  if (!batchDecoder) {
    batchDecoder = zx._createTrackedDecoder(15, 177);
    zx._setTrackedDecoderFallbackBudget(batchDecoder, 2);
  }
  if (count <= batchCapacity) return;
  if (batchResultsPtr) zx._free(batchResultsPtr);
  if (batchOutputPtr) zx._free(batchOutputPtr);
  batchResultsPtr = zx._malloc(count * 32);
  batchOutputPtr = zx._malloc(count * 3000);
  if (!batchMetricsPtr) batchMetricsPtr = zx._malloc(72);
  batchCapacity = count;
}

function trackKey(track: BatchTrack, ox: number, oy: number): string {
  const q = track.quad;
  return [track.id, track.dim, Number(track.crc32), ox, oy,
    q.topLeft.x, q.topLeft.y, q.topRight.x, q.topRight.y,
    q.bottomRight.x, q.bottomRight.y, q.bottomLeft.x, q.bottomLeft.y].join(":");
}

function moved(q: DecimenQuad, dx: number, dy: number): DecimenQuad {
  const point = (p: { x: number; y: number }) => ({ x: p.x + dx, y: p.y + dy });
  return {
    topLeft: point(q.topLeft), topRight: point(q.topRight),
    bottomRight: point(q.bottomRight), bottomLeft: point(q.bottomLeft),
  };
}

ctx.onmessage = async (e: MessageEvent) => {
  const startedAt = performance.now();
  const { id, buf, w = 0, h = 0, ox = 0, oy = 0, scaleX = 1, scaleY = 1, full = true, thorough = true, reacquire = false, quad, dim, tracks } = e.data as {
    id: number;
    buf: ArrayBuffer;
    w?: number;
    h?: number;
    ox?: number;
    oy?: number;
    scaleX?: number;
    scaleY?: number;
    full?: boolean;
    thorough?: boolean;
    reacquire?: boolean;
    quad?: DecimenQuad;
    dim?: number;
    tracks?: BatchTrack[];
  };
  try {
    const pixels = new Uint8Array(buf);
    const zx = await ready;
    const ptr = inputBuffer(zx, pixels.byteLength);
    zx.HEAPU8.set(pixels, ptr);
    const pw = w;
    const ph = h;
    const symbols: { bytes: Uint8Array; box: object; quad: DecimenQuad; modules: number; tracked: boolean; crc32?: boolean }[] = [];
    const sightings: { x: number; y: number; w: number; h: number; quad?: DecimenQuad; modules?: number }[] = [];

    if (!full && tracks?.length) {
      batchBuffers(zx, tracks.length);
      const byId = new Map(tracks.map((track) => [track.id, track]));
      for (let slot = 0; slot < tracks.length; slot++) {
        const track = tracks[slot]!;
        const key = trackKey(track, ox, oy);
        if (batchTrackKeys[slot] === key) continue;
        const q = moved(track.quad, -ox, -oy);
        zx._setTrackedDecoderTrack(
          batchDecoder, slot, track.id, track.dim,
          q.topLeft.x, q.topLeft.y, q.topRight.x, q.topRight.y,
          q.bottomRight.x, q.bottomRight.y, q.bottomLeft.x, q.bottomLeft.y,
        );
        zx._setTrackedDecoderTrackCRC32(batchDecoder, slot, Number(track.crc32));
        batchTrackKeys[slot] = key;
      }
      for (let slot = tracks.length; slot < batchTrackKeys.length; slot++) {
        zx._clearTrackedDecoderTrack(batchDecoder, slot);
        batchTrackKeys[slot] = "";
      }
      const count = zx._decodeTrackedBatchRGBA(
        batchDecoder, ptr, pw, ph, pw * 4, batchResultsPtr, tracks.length,
        batchOutputPtr, tracks.length * 3000, batchMetricsPtr,
      );
      const view = new DataView(zx.HEAPU8.buffer);
      for (let index = 0; index < count; index++) {
        const base = batchResultsPtr + index * 32;
        if (view.getInt32(base + 4, true) !== 1) continue;
        const track = byId.get(view.getInt32(base, true));
        if (!track) continue;
        const byteOffset = view.getInt32(base + 8, true);
        const byteLength = view.getInt32(base + 12, true);
        const updatedQuad = moved(
          track.quad, view.getFloat32(base + 24, true), view.getFloat32(base + 28, true),
        );
        symbols.push({
          bytes: zx.HEAPU8.slice(batchOutputPtr + byteOffset, batchOutputPtr + byteOffset + byteLength),
          box: boundsOf(updatedQuad, 0, 0), quad: updatedQuad, modules: track.dim,
          tracked: true, crc32: track.crc32,
        });
      }
      // Never run the generic detector over the union of several neighboring
      // tracks. That recreates the dense finder-pattern ambiguity tracking was
      // designed to avoid, and its error quad can pull the whole lattice onto
      // the wrong QR. Per-slot native detector crops are scheduled after three
      // misses; those contain exactly one expected symbol and can safely
      // re-anchor the grid even before payload decoding succeeds.
      ctx.postMessage({
        id, symbols, sightings, full: false, trackedAttempted: true,
        trackedHit: symbols.some((symbol) => symbol.tracked), fallbackAttempted: false,
        latencyMs: performance.now() - startedAt,
      });
      return;
    }

    let trackedHit = false;
    let trackedAttempted = false;
    let fallbackAttempted = false;
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

    if (full || reacquire || (trackedAttempted && !trackedHit)) {
      fallbackAttempted = !full;
      const appendResults = (vec: ReturnType<DecimenModule["readFull"]>, includeErrors: boolean) => {
        try {
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
            } else if (includeErrors) {
              // A symbol zxing DETECTED but could not decode (glare or noise
              // past ECC) still supplies the geometry needed to move an
              // already-identified lattice before data decoding catches up.
              const resultQuad = shifted(r.position, ox, oy, scaleX, scaleY);
              const box = boundsOf(resultQuad, 0, 0);
              if (box.w > 0 && box.h > 0) sightings.push({
                ...box, quad: resultQuad, modules: r.modules || undefined,
              });
            }
          }
        } finally {
          vec.delete();
        }
      };
      if (full) {
        // Acquisition needs one packet, not an inventory of the whole dense
        // lattice: that packet declares every slot. A high multi-symbol limit
        // makes ZXing combine finder patterns across neighboring QRs and can
        // turn an obvious frame into seconds of false candidates. Try the
        // cheap single-symbol reader first, then the exhaustive variant only
        // when this is the deliberately infrequent thorough job.
        appendResults(zx.readFull(ptr, pw, ph, false, 1, false), false);
        if (symbols.length === 0 && thorough) {
          appendResults(zx.readFull(ptr, pw, ph, true, 1, false), false);
        }
      } else {
        // A local detector crop may decode a packet, but error positions are
        // not correspondence evidence and can never move the lattice.
        appendResults(zx.readFull(ptr, pw, ph, true, 1, false), false);
      }
    }
    ctx.postMessage({
      id, symbols, sightings, full, trackedAttempted, trackedHit, fallbackAttempted,
      latencyMs: performance.now() - startedAt,
    });
  } catch (error) {
    ctx.postMessage({
      id, symbols: [], sightings: [], full,
      latencyMs: performance.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
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
