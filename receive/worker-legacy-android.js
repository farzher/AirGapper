import DecimenCodec from "../vendor/decimen-codec-android/decimen_codec.js";
const ready = DecimenCodec();
const ctx = self;
function plainQuad(quad) {
  const point = (value) => ({ x: value.x, y: value.y });
  return {
    topLeft: point(quad.topLeft),
    topRight: point(quad.topRight),
    bottomRight: point(quad.bottomRight),
    bottomLeft: point(quad.bottomLeft)
  };
}
function boundsOf(quad) {
  const xs = [quad.topLeft.x, quad.topRight.x, quad.bottomRight.x, quad.bottomLeft.x];
  const ys = [quad.topLeft.y, quad.topRight.y, quad.bottomRight.y, quad.bottomLeft.y];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
ctx.onmessage = async (event) => {
  const startedAt = performance.now();
  const { id, buf, w, h } = event.data;
  let zx;
  let ptr = 0;
  try {
    zx = await ready;
    const pixels = new Uint8Array(buf);
    ptr = zx._malloc(pixels.byteLength);
    zx.HEAPU8.set(pixels, ptr);
    const symbols = [];
    const sightings = [];
    const appendResults = (results, includeErrors) => {
      try {
        for (let index = 0; index < results.size(); index++) {
          const result = results.get(index);
          if (result.valid && result.bytes.length > 0) {
            const quad = plainQuad(result.position);
            symbols.push({
              bytes: Uint8Array.from(result.bytes),
              box: boundsOf(quad),
              quad,
              modules: result.modules,
              tracked: false
            });
          } else if (includeErrors) {
            const quad = plainQuad(result.position);
            const box = boundsOf(quad);
            if (box.w > 0 && box.h > 0) sightings.push({
              ...box,
              quad,
              modules: result.modules || void 0
            });
          }
        }
      } finally {
        results.delete();
      }
    };
    appendResults(zx.readFull(ptr, w, h, false, 1, false), false);
    if (symbols.length === 0) appendResults(zx.readFull(ptr, w, h, true, 1, false), false);
    ctx.postMessage({
      id,
      symbols,
      sightings,
      full: true,
      latencyMs: performance.now() - startedAt
    });
  } catch (error) {
    ctx.postMessage({
      id,
      symbols: [],
      sightings: [],
      full: true,
      latencyMs: performance.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
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
