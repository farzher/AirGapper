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
    // This is a correctness smoke, not a cold-start performance benchmark. A
    // hosted CI runner can spend tens of seconds compiling/instantiating the
    // first SIMD WASM module and starve page timers while Chrome does so.
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error("direct Y8 worker smoke test timed out"));
    }, 90_000);
    worker.onerror = (event) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(event.message || "direct Y8 worker failed"));
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
    // Add harmless contrast so this also exercises the full-frame Y scanner,
    // not just an all-white early exit.
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
