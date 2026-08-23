import QRCode from "../vendor/qrcode.js";

const WHITE = 0xffffffff;
const BLACK = 0xff000000;

let rasterWidth = 0;
let rasterHeight = 0;
let rasterPixels = null;
let rasterImage = null;
let rasterCanvas = null;
let rasterCtx = null;

function ensureRaster(width, height) {
  if (rasterPixels && rasterWidth === width && rasterHeight === height) return;
  rasterWidth = width;
  rasterHeight = height;
  rasterPixels = new Uint32Array(width * height);
  rasterPixels.fill(WHITE);
  rasterImage = null;
  rasterCanvas = null;
  rasterCtx = null;
  if (typeof OffscreenCanvas === "function" && typeof ImageData === "function") {
    rasterImage = new ImageData(new Uint8ClampedArray(rasterPixels.buffer), width, height);
    rasterCanvas = new OffscreenCanvas(width, height);
    rasterCtx = rasterCanvas.getContext("2d");
  }
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
    const pixels = rasterPixels;
    const stride = modules + job.margin;

    for (const frame of job.frames) {
      const qr = QRCode.create([{ data: new Uint8Array(frame.buffer), mode: "byte" }], {
        errorCorrectionLevel: "L",
        version,
        maskPattern: 4
      });
      if (modules !== qr.modules.size) throw new Error("QR version changed inside sender page");
      const ox = frame.slotIndex % job.cols * stride + job.margin;
      const oy = Math.floor(frame.slotIndex / job.cols) * stride + job.margin;
      const data = qr.modules.data;
      for (let y = 0; y < modules; ++y) {
        const dst = (oy + y) * width + ox;
        const src = y * modules;
        for (let x = 0; x < modules; ++x)
          pixels[dst + x] = data[src + x] ? BLACK : WHITE;
      }
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
