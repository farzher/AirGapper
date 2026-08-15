const WHITE = 4294967295;
const BLACK = 4278190080;
function rasterizeQr(moduleCount, modules, margin) {
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
function gridDims(count) {
  const cols = Math.floor(Math.sqrt(count));
  const rows = Math.ceil(count / Math.max(1, cols));
  if (count < 1 || cols * rows !== count) {
    throw new Error(`grid needs a count that fills its rows (1, 2, 4, 6, 9, 12…), got ${count}`);
  }
  return { cols, rows };
}
function rasterizeQrGrid(moduleCount, matrices, margin) {
  const { cols, rows } = gridDims(matrices.length);
  const stride = moduleCount + margin;
  const width = cols * moduleCount + (cols + 1) * margin;
  const height = rows * moduleCount + (rows + 1) * margin;
  const pixels = new Uint32Array(width * height);
  pixels.fill(WHITE);
  matrices.forEach((modules, i) => {
    const ox = i % cols * stride + margin;
    const oy = Math.floor(i / cols) * stride + margin;
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
export {
  gridDims,
  rasterizeQr,
  rasterizeQrGrid
};
