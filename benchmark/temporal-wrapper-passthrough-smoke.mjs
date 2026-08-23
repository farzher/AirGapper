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
    const worker = new Worker(new URL("/receive/worker-reconstruct-bootstrap.js", location.href), { type: "module" });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error("reconstruction bootstrap passthrough timed out"));
    }, 15_000);
    worker.onerror = (event) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(event.message || "reconstruction bootstrap failed"));
    };
    worker.onmessage = (event) => {
      if (event.data?.id !== jobId) return;
      clearTimeout(timer);
      worker.terminate();
      resolve(event.data);
    };

    const width = 160;
    const height = 120;
    const y = new Uint8Array(width * height);
    y.fill(235);
    for (let row = 32; row < 88; row++) {
      for (let col = 48; col < 112; col++) y[row * width + col] = (row + col) & 1 ? 24 : 220;
    }
    const frame = y.buffer;
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
  }));

  if (result?.id !== 991352) throw new Error(`unexpected wrapper reply id: ${result?.id}`);
  if (result?.error) throw new Error(`wrapper passthrough error: ${result.error}`);
  if (result?.directFrameFailed) throw new Error("wrapper rejected native Y8 acquisition buffer");
  if (!Array.isArray(result?.symbols)) throw new Error("wrapper passthrough reply has no symbols array");
  if (result?.temporalMetrics) throw new Error("full acquisition must not enter temporal reconstruction logic");
  console.log("AIRGAPPER_TEMPORAL_WRAPPER_PASSTHROUGH_PASS", JSON.stringify({
    symbols: result.symbols.length,
    readFullAttempts: result.readFullAttempts,
    latencyMs: result.latencyMs
  }));
} finally {
  await browser.close();
}
