import { chromium } from "playwright";

const baseUrl = process.env.AIRGAPPER_URL || "http://127.0.0.1:8080/";
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
});

try {
  const page = await browser.newPage();
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const result = await page.evaluate(() => new Promise((resolve, reject) => {
    const jobId = 991352;
    const worker = new Worker(new URL("/receive/worker-rvfc.js", location.href), { type: "module" });
    let timer;
    const armTimeout = (phase, milliseconds) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        worker.terminate();
        reject(new Error(`rVFC wrapper smoke timed out during ${phase}`));
      }, milliseconds);
    };
    armTimeout("WASM readiness", 30_000);
    worker.onerror = (event) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(event.message || "rVFC wrapper worker failed"));
    };
    worker.onmessage = (event) => {
      if (event.data?.id === -1) {
        const width = 160;
        const height = 120;
        const rgba = new Uint8Array(width * height * 4);
        for (let pixel = 0; pixel < width * height; pixel++) {
          const at = pixel * 4;
          rgba[at] = 235;
          rgba[at + 1] = 235;
          rgba[at + 2] = 235;
          rgba[at + 3] = 255;
        }
        // Add ordinary low-frequency contrast specifically in the green plane.
        // worker-rvfc.js compacts green into the front of this transferred RGBA
        // allocation in-place before handing the Y8 buffer to worker-core.
        for (let row = 38; row < 82; row++) {
          for (let col = 50; col < 110; col++) rgba[(row * width + col) * 4 + 1] = 28;
        }
        const frame = rgba.buffer;
        armTimeout("RGBA-to-Y8 decode", 15_000);
        worker.postMessage({
          id: jobId,
          videoFrame: frame,
          cropX: 0,
          cropY: 0,
          w: width,
          h: height,
          ox: 0,
          oy: 0,
          full: true,
          tracks: [],
          pixelFormat: "rgba",
          payloadBytes: width * height,
          acquisitionMode: "fast",
          __airgapperWorkerLumaFromRgba: true
        }, [frame]);
        return;
      }
      if (event.data?.id !== jobId) return;
      clearTimeout(timer);
      worker.terminate();
      resolve(event.data);
    };
  }));

  if (result?.id !== 991352) throw new Error(`unexpected rVFC wrapper reply id: ${result?.id}`);
  if (result?.error) throw new Error(`rVFC wrapper worker error: ${result.error}`);
  if (result?.directFrameFailed) throw new Error("rVFC wrapper Y8 buffer was rejected as a direct frame");
  if (!Array.isArray(result?.symbols)) throw new Error("rVFC wrapper reply has no symbols array");
  console.log("AIRGAPPER_RVFC_WRAPPER_PASS", JSON.stringify({
    symbols: result.symbols.length,
    readFullAttempts: result.readFullAttempts,
    latencyMs: result.latencyMs
  }));
} finally {
  await browser.close();
}
