import { encodeTransferQr, transferQrRasterLayout } from "./transfer-qr.js";

const WHITE = 0xffffffff;
const BLACK = 0xff000000;

let rasterWidth = 0;
let rasterHeight = 0;
let rasterPixels = null;
let rasterImage = null;
let rasterCanvas = null;
let rasterCtx = null;
let rasterLayoutKey = "";
let rasterLayout = null;

function ensureRaster(width, height) {
  if (rasterPixels && rasterWidth === width && rasterHeight === height) return;
  rasterWidth = width;
  rasterHeight = height;
  rasterPixels = new Uint32Array(width * height);
  rasterImage = null;
  rasterCanvas = null;
  rasterCtx = null;
  rasterLayoutKey = "";
  rasterLayout = null;
  if (typeof OffscreenCanvas === "function" && typeof ImageData === "function") {
    rasterImage = new ImageData(new Uint8ClampedArray(rasterPixels.buffer), width, height);
    rasterCanvas = new OffscreenCanvas(width, height);
    rasterCtx = rasterCanvas.getContext("2d");
  }
}

function ensureStaticQrWall(version, cols, rows, margin, width, height) {
  const key = `${version}:${cols}:${rows}:${margin}:${width}:${height}`;
  if (rasterLayoutKey === key && rasterLayout) return rasterLayout;

  const layout = transferQrRasterLayout(version, width);
  const template = layout.template;
  const modules = template.size;
  const stride = modules + margin;
  const fixed = template.staticModules;
  const pixels = rasterPixels;
  pixels.fill(WHITE);

  for (let slot = 0; slot < cols * rows; ++slot) {
    const ox = slot % cols * stride + margin;
    const oy = Math.floor(slot / cols) * stride + margin;
    for (let y = 0; y < modules; ++y) {
      const dst = (oy + y) * width + ox;
      const src = y * modules;
      for (let x = 0; x < modules; ++x)
        pixels[dst + x] = fixed[src + x] ? BLACK : WHITE;
    }
  }

  rasterLayoutKey = key;
  rasterLayout = layout;
  return layout;
}

self.onmessage = (event) => {
  const job = event.data;
  if (!job || job.type !== "render-page") return;
  try {
    const version = Number(job.version);
    if (!Number.isInteger(version) || version < 1 || version > 40) throw new Error("Render page needs a QR version");
    const modules = 17 + 4 * version;
    const width = modules * job.cols + job.margin * (job.cols + 1);
    const height = modules * job.rows + job.margin * (job.rows + 1);
    ensureRaster(width, height);
    const layout = ensureStaticQrWall(version, job.cols, job.rows, job.margin, width, height);
    const template = layout.template;
    const positions = template.positions;
    const offsets = layout.offsets;
    const pixels = rasterPixels;
    const stride = modules + job.margin;

    // Every page contains exactly one fresh frame for every slot. The fixed QR
    // geometry was painted once above; from now on only data/remainder modules
    // can change, so do not rewrite finder/timing/alignment pixels each page.
    for (const frame of job.frames) {
      const encoded = encodeTransferQr(new Uint8Array(frame.buffer), version);
      if (encoded !== template) throw new Error("Transfer QR workspace changed inside sender page");
      const ox = frame.slotIndex % job.cols * stride + job.margin;
      const oy = Math.floor(frame.slotIndex / job.cols) * stride + job.margin;
      const base = oy * width + ox;
      const data = template.modules;
      for (let i = 0; i < positions.length; ++i)
        pixels[base + offsets[i]] = data[positions[i]] ? BLACK : WHITE;
    }

    const startOrdinal = Number(job.startOrdinal);
    const common = {
      type: "rendered-page",
      pageId: job.pageId,
      startOrdinal,
      endOrdinal: startOrdinal + job.frames.length,
      version,
      modules,
      width,
      height
    };
    if (rasterCanvas && rasterCtx && rasterImage) {
      rasterCtx.putImageData(rasterImage, 0, 0);
      const bitmap = rasterCanvas.transferToImageBitmap();
      self.postMessage({ ...common, bitmap }, [bitmap]);
    } else {
      const copy = pixels.slice();
      self.postMessage({ ...common, pixels: copy.buffer }, [copy.buffer]);
    }
  } catch (error) {
    self.postMessage({
      type: "render-error",
      pageId: job?.pageId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};
