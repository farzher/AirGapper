import assert from "node:assert/strict";
import test from "node:test";
import { gridDims, rasterizeQr, rasterizeQrGrid } from "../shared/qr-raster.ts";

const WHITE = 0xffffffff;
const BLACK = 0xff000000;

test("a single dark module with no margin is one black pixel", () => {
  const { size, pixels } = rasterizeQr(1, [1], 0);
  assert.equal(size, 1);
  assert.deepEqual([...pixels], [BLACK]);
});

test("the margin surrounds the modules with white on every side", () => {
  const { size, pixels } = rasterizeQr(1, [1], 2);
  assert.equal(size, 5);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const expected = x === 2 && y === 2 ? BLACK : WHITE;
      assert.equal(pixels[y * size + x], expected, `pixel (${x},${y})`);
    }
  }
});

test("modules map row-major and truthy means dark", () => {
  // ▓░ / ░▓ checkerboard
  const { size, pixels } = rasterizeQr(2, [1, 0, 0, 1], 0);
  assert.equal(size, 2);
  assert.deepEqual([...pixels], [BLACK, WHITE, WHITE, BLACK]);
});

test("an all-light matrix rasterizes to all white", () => {
  const { size, pixels } = rasterizeQr(3, new Uint8Array(9), 1);
  assert.equal(size, 5);
  assert.ok([...pixels].every((p) => p === WHITE));
});

test("every offered layout gets an as-square-as-possible grid, taller first", () => {
  assert.deepEqual(gridDims(1), { cols: 1, rows: 1 });
  assert.deepEqual(gridDims(2), { cols: 1, rows: 2 });
  assert.deepEqual(gridDims(4), { cols: 2, rows: 2 });
  assert.deepEqual(gridDims(6), { cols: 2, rows: 3 });
  assert.deepEqual(gridDims(9), { cols: 3, rows: 3 });
});

test("a 2×2 grid tiles four matrices, each inside its own quiet zone", () => {
  // Single-module codes with margin 1: cells are 3×3, dark centers at
  // (1,1), (4,1), (1,4), (4,4) for the codes that have a dark module.
  const { width, height, pixels } = rasterizeQrGrid(1, [[1], [0], [0], [1]], 1);
  assert.equal(width, 6);
  assert.equal(height, 6);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dark = (x === 1 && y === 1) || (x === 4 && y === 4);
      assert.equal(pixels[y * width + x], dark ? BLACK : WHITE, `pixel (${x},${y})`);
    }
  }
});

test("a 2-code grid stacks in a single column", () => {
  // Cells are 3×3: dark centers at (1,1) and (1,4), nothing beside them.
  const { width, height, pixels } = rasterizeQrGrid(1, [[1], [1]], 1);
  assert.equal(width, 3);
  assert.equal(height, 6);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dark = x === 1 && (y === 1 || y === 4);
      assert.equal(pixels[y * width + x], dark ? BLACK : WHITE, `pixel (${x},${y})`);
    }
  }
});

test("a 6-code grid fills two columns by three rows", () => {
  // Margin 0, single-module codes: the raster IS the layout, row-major.
  const { width, height, pixels } = rasterizeQrGrid(1, [[1], [0], [1], [0], [1], [0]], 0);
  assert.equal(width, 2);
  assert.equal(height, 3);
  assert.deepEqual([...pixels], [BLACK, WHITE, BLACK, WHITE, BLACK, WHITE]);
});

test("a grid of one is exactly the plain raster", () => {
  const grid = rasterizeQrGrid(2, [[1, 0, 0, 1]], 2);
  const plain = rasterizeQr(2, [1, 0, 0, 1], 2);
  assert.equal(grid.width, plain.size);
  assert.equal(grid.height, plain.size);
  assert.deepEqual([...grid.pixels], [...plain.pixels]);
});

test("a code count that cannot fill its rows is refused", () => {
  assert.throws(() => rasterizeQrGrid(1, [[1], [1], [1], [1], [1]], 1), /fills its rows/);
  assert.throws(() => gridDims(5), /fills its rows/);
  assert.throws(() => gridDims(7), /fills its rows/);
  assert.throws(() => gridDims(0), /fills its rows/);
});

test("pixel values are the RGBA bytes an ImageData buffer expects", () => {
  const { pixels } = rasterizeQr(1, [1], 1);
  const bytes = new Uint8Array(pixels.buffer);
  // little-endian u32 0xff000000 → R,G,B = 0 and A = 255
  const center = 4 * (1 * 3 + 1);
  assert.deepEqual([...bytes.slice(center, center + 4)], [0, 0, 0, 255]);
  // and the white corner is R,G,B,A all 255
  assert.deepEqual([...bytes.slice(0, 4)], [255, 255, 255, 255]);
});
