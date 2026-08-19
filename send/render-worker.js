import QRCode from "../vendor/qrcode.js";

const WHITE = 0xffffffff;
const BLACK = 0xff000000;

self.onmessage = (event) => {
  const job = event.data;
  if (!job || job.type !== "render-page") return;
  try {
    const version = Number(job.version);
    if (!Number.isInteger(version) || version < 1 || version > 40) throw new Error("Render page needs a QR version");
    let modules = 0;
    let width = 0;
    let height = 0;
    let pixels = null;
    for (const frame of job.frames) {
      const qr = QRCode.create([{ data: new Uint8Array(frame.buffer), mode: "byte" }], {
        errorCorrectionLevel: "L",
        version,
        maskPattern: 4
      });
      if (!modules) {
        modules = qr.modules.size;
        width = modules * job.cols + job.margin * (job.cols + 1);
        height = modules * job.rows + job.margin * (job.rows + 1);
        pixels = new Uint32Array(width * height);
        pixels.fill(WHITE);
      } else if (modules !== qr.modules.size) {
        throw new Error("QR version changed inside sender page");
      }
      const stride = modules + job.margin;
      const ox = frame.slotIndex % job.cols * stride + job.margin;
      const oy = Math.floor(frame.slotIndex / job.cols) * stride + job.margin;
      const data = qr.modules.data;
      for (let y = 0; y < modules; ++y) {
        const dst = (oy + y) * width + ox;
        const src = y * modules;
        for (let x = 0; x < modules; ++x)
          if (data[src + x]) pixels[dst + x] = BLACK;
      }
    }
    if (!pixels) throw new Error("Empty sender page");
    const common = { type: "rendered-page", pageId: job.pageId, version, modules, width, height };
    if (typeof OffscreenCanvas === "function" && typeof ImageData === "function") {
      const canvas = new OffscreenCanvas(width, height);
      canvas.getContext("2d").putImageData(
        new ImageData(new Uint8ClampedArray(pixels.buffer), width, height), 0, 0
      );
      const bitmap = canvas.transferToImageBitmap();
      self.postMessage({ ...common, bitmap }, [bitmap]);
    } else {
      self.postMessage({ ...common, pixels: pixels.buffer }, [pixels.buffer]);
    }
  } catch (error) {
    self.postMessage({
      type: "render-error",
      pageId: job?.pageId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};
