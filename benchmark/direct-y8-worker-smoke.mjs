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
    const jobId = 991351;
    const worker = new Worker(new URL("/receive/worker.js", location.href), { type: "module" });
    let timer;
    const armTimeout = (phase, milliseconds) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        worker.terminate();
        reject(new Error(`direct Y8 worker smoke timed out during ${phase}`));
      }, milliseconds);
    };
    armTimeout("WASM readiness", 30_000);

    worker.onerror = (event) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(event.message || "direct Y8 worker failed"));
    };
    worker.onmessage = (event) => {
      if (event.data?.id === -1) {
        // Production DecodeWorkerPool does not submit until this exact ready
        // handshake arrives. The standalone smoke must obey the same contract.
        const width = 160;
        const height = 120;
        const y = new Uint8Array(width * height);
        y.fill(235);
        // Ordinary low-frequency contrast exercises full-frame Y8 transport and
        // scanning without manufacturing a pathological finder-pattern workload.
        for (let row = 38; row < 82; row++) {
          for (let col = 50; col < 110; col++) y[row * width + col] = 28;
        }
        const frame = y.buffer;
        armTimeout("direct Y8 decode", 15_000);
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
          pixelFormat: "y8",
          yOffset: 0,
          yStride: width,
          payloadBytes: frame.byteLength,
          acquisitionMode: "fast"
        }, [frame]);
        return;
      }
      if (event.data?.id !== jobId) return;
      clearTimeout(timer);
      worker.terminate();
      resolve(event.data);
    };
  }));

  if (result?.id !== 991351) throw new Error(`unexpected worker reply id: ${result?.id}`);
  if (result?.error) throw new Error(`direct Y8 worker error: ${result.error}`);
  if (result?.directFrameFailed) throw new Error("direct Y8 ArrayBuffer was rejected as a direct frame");
  if (!Array.isArray(result?.symbols)) throw new Error("direct Y8 worker reply has no symbols array");
  console.log("AIRGAPPER_DIRECT_Y8_WORKER_PASS", JSON.stringify({
    symbols: result.symbols.length,
    readFullAttempts: result.readFullAttempts,
    latencyMs: result.latencyMs
  }));
} finally {
  await browser.close();
}
