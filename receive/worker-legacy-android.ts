// Isolated compatibility decoder for old 32-bit Android WebViews.
//
// This is the proven APK scanner: one native-size RGBA frame in, one thorough
// scalar ZXing scan out. It deliberately does not share the modern tracking,
// batching, reduced-frame, or SIMD paths.

import wasmUrl from "./wasm-url-android";
import DecimenCodec, { type DecimenModule, type DecimenQuad } from "../vendor/decimen-codec-android/decimen_codec.js";

const ready: Promise<DecimenModule> = DecimenCodec({
  locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? wasmUrl : prefix + path),
});

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(msg: unknown): void;
};

function plainQuad(quad: DecimenQuad): DecimenQuad {
  const point = (value: { x: number; y: number }) => ({ x: value.x, y: value.y });
  return {
    topLeft: point(quad.topLeft),
    topRight: point(quad.topRight),
    bottomRight: point(quad.bottomRight),
    bottomLeft: point(quad.bottomLeft),
  };
}

function boundsOf(quad: DecimenQuad) {
  const xs = [quad.topLeft.x, quad.topRight.x, quad.bottomRight.x, quad.bottomLeft.x];
  const ys = [quad.topLeft.y, quad.topRight.y, quad.bottomRight.y, quad.bottomLeft.y];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

ctx.onmessage = async (event: MessageEvent) => {
  const startedAt = performance.now();
  const { id, buf, w, h } = event.data as { id: number; buf: ArrayBuffer; w: number; h: number };
  let zx: DecimenModule | undefined;
  let ptr = 0;
  try {
    zx = await ready;
    const pixels = new Uint8Array(buf);
    ptr = zx._malloc(pixels.byteLength);
    zx.HEAPU8.set(pixels, ptr);
    const results = zx.readFull(ptr, w, h, true, 16, true);
    const symbols: { bytes: Uint8Array; box: object; quad: DecimenQuad; modules: number; tracked: false }[] = [];
    const sightings: object[] = [];
    try {
      for (let index = 0; index < results.size(); index++) {
        const result = results.get(index);
        if (result.valid && result.bytes.length > 0) {
          // Copy every embind value while the result is alive. Keeping the
          // position proxy after results.delete() produced wild overlay quads
          // and poisoned tracking on old WebViews.
          const quad = plainQuad(result.position);
          symbols.push({
            bytes: Uint8Array.from(result.bytes),
            box: boundsOf(quad),
            quad,
            modules: result.modules,
            tracked: false,
          });
        } else {
          const box = boundsOf(result.position);
          if (box.w > 0 && box.h > 0) sightings.push(box);
        }
      }
    } finally {
      results.delete();
    }
    ctx.postMessage({
      id, symbols, sightings, full: true,
      latencyMs: performance.now() - startedAt,
    });
  } catch (error) {
    ctx.postMessage({
      id, symbols: [], sightings: [], full: true,
      latencyMs: performance.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (zx && ptr) zx._free(ptr);
  }
};

void ready.then((zx) => {
  const ptr = zx._malloc(8 * 8 * 4);
  try {
    zx.HEAPU8.fill(255, ptr, ptr + 8 * 8 * 4);
    zx.readFull(ptr, 8, 8, false, 1, false).delete();
  } finally {
    zx._free(ptr);
  }
  ctx.postMessage({ id: -1 });
}).catch(() => ctx.postMessage({ id: -1 }));
