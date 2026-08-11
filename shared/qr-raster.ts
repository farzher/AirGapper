// Paint a QR module matrix into a pixel buffer, quiet zone included.
//
// Pure so it can be golden-tested in Node, where ImageData does not exist:
// the pixels are RGBA bytes viewed as one little-endian u32 per pixel, which
// is exactly an ImageData buffer — the sender wraps the result with
// `new ImageData(new Uint8ClampedArray(pixels.buffer), width, height)` at no
// copy.

const WHITE = 0xffffffff;
const BLACK = 0xff000000; // opaque black: alpha in the high byte, little-endian

export interface QrRaster {
  /** Pixels per side: moduleCount + 2 × margin. One module = one pixel — the
   *  sender scales up with imageSmoothingEnabled off. */
  size: number;
  /** `<ArrayBuffer>` because ImageData refuses an ArrayBufferLike-backed view. */
  pixels: Uint32Array<ArrayBuffer>;
}

/** `modules` is row-major, truthy = dark — the qrcode lib's `qr.modules.data`. */
export function rasterizeQr(
  moduleCount: number,
  modules: ArrayLike<number>,
  margin: number,
): QrRaster {
  const size = moduleCount + 2 * margin;
  const pixels = new Uint32Array(size * size);
  pixels.fill(WHITE);
  for (let y = 0; y < moduleCount; y++) {
    const row = (y + margin) * size + margin;
    const src = y * moduleCount;
    for (let x = 0; x < moduleCount; x++) {
      if (modules[src + x]) pixels[row + x] = BLACK;
    }
  }
  return { size, pixels };
}

export interface QrGridRaster {
  /** Pixels across / down: cols (rows) × (moduleCount + 2 × margin). */
  width: number;
  height: number;
  pixels: Uint32Array<ArrayBuffer>;
}

/** Grid shape for a code count: as square as possible, taller before wider —
 *  the sender is typically a portrait phone screen, and a stack uses that
 *  height where a row would shrink every code to fit the narrow edge.
 *  The count must fill the rectangle exactly — 1 (1×1), 2 (1×2), 4 (2×2),
 *  6 (2×3), 9 (3×3)… — a part-empty grid would silently waste the channel. */
export function gridDims(count: number): { cols: number; rows: number } {
  const cols = Math.floor(Math.sqrt(count));
  const rows = Math.ceil(count / Math.max(1, cols));
  if (count < 1 || cols * rows !== count) {
    throw new Error(`grid needs a count that fills its rows (1, 2, 4, 6, 9…), got ${count}`);
  }
  return { cols, rows };
}

/**
 * Same-version module matrices tiled into a grid (shape per gridDims), each
 * code keeping its own quiet zone (adjacent zones merge into 2×margin of
 * white). A grid of one is exactly rasterizeQr.
 */
export function rasterizeQrGrid(
  moduleCount: number,
  matrices: readonly ArrayLike<number>[],
  margin: number,
): QrGridRaster {
  const { cols, rows } = gridDims(matrices.length);
  const cell = moduleCount + 2 * margin;
  const width = cols * cell;
  const height = rows * cell;
  const pixels = new Uint32Array(width * height);
  pixels.fill(WHITE);
  matrices.forEach((modules, i) => {
    const ox = (i % cols) * cell + margin;
    const oy = Math.floor(i / cols) * cell + margin;
    for (let y = 0; y < moduleCount; y++) {
      const row = (y + oy) * width + ox;
      const src = y * moduleCount;
      for (let x = 0; x < moduleCount; x++) {
        if (modules[src + x]) pixels[row + x] = BLACK;
      }
    }
  });
  return { width, height, pixels };
}
