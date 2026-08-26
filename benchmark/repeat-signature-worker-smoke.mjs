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
  const result = await page.evaluate(async () => {
    const width = 192;
    const height = 96;
    const tracks = [
      {
        id: 0, slot: 0, misses: 0, dim: 21, crc32: true,
        quad: {
          topLeft: { x: 8, y: 12 }, topRight: { x: 84, y: 12 },
          bottomRight: { x: 84, y: 84 }, bottomLeft: { x: 8, y: 84 }
        }
      },
      {
        id: 1, slot: 1, misses: 0, dim: 21, crc32: true,
        quad: {
          topLeft: { x: 108, y: 12 }, topRight: { x: 184, y: 12 },
          bottomRight: { x: 184, y: 84 }, bottomLeft: { x: 108, y: 84 }
        }
      }
    ];

    function makeFrame() {
      const y = new Uint8Array(width * height);
      y.fill(236);
      // A deterministic high-contrast texture is enough for the repeat filter;
      // this test intentionally does not need to contain a decodable QR.
      for (let row = 8; row < height - 8; row++) {
        for (let col = 4; col < width - 4; col++) {
          const cell = ((col >> 2) + (row >> 2)) & 1;
          y[row * width + col] = cell ? 26 : 228;
        }
      }
      return y.buffer;
    }

    function workerUrl() {
      return new URL("/receive/worker.js", location.href);
    }

    function runWorker({ id, sourceSequence, previousFrameSignature, preflight }) {
      return new Promise((resolve, reject) => {
        const worker = new Worker(workerUrl(), { type: "module" });
        let timer;
        const armTimeout = (phase, milliseconds) => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            worker.terminate();
            reject(new Error(`repeat signature ${phase} timed out`));
          }, milliseconds);
        };
        armTimeout("WASM readiness", 30_000);
        worker.onerror = (event) => {
          clearTimeout(timer);
          worker.terminate();
          reject(new Error(event.message || "repeat signature worker failed"));
        };
        worker.onmessage = (event) => {
          const message = event.data;
          if (message?.id === -1) {
            // Match DecodeWorkerPool: jobs are legal only after worker.js emits
            // its WASM-ready handshake.
            const frame = makeFrame();
            armTimeout(preflight ? "preflight" : "duplicate test", 15_000);
            worker.postMessage({
              id,
              videoFrame: frame,
              w: width,
              h: height,
              ox: 0,
              oy: 0,
              full: false,
              tracks,
              pixelFormat: "y8",
              yOffset: 0,
              yStride: width,
              payloadBytes: frame.byteLength,
              guidedDecode: true,
              repeatFilter: true,
              sourceSequence,
              previousFrameSignature
            }, [frame]);
            return;
          }
          if (message?.id !== id || Boolean(message.preflight) !== preflight) return;
          clearTimeout(timer);
          worker.terminate();
          resolve(preflight ? message.frameSignature : message);
        };
      });
    }

    const firstSignature = await runWorker({
      id: 71001,
      sourceSequence: 10,
      previousFrameSignature: undefined,
      preflight: true
    });

    if (!firstSignature || !(firstSignature.bits instanceof Uint8Array) ||
        !(firstSignature.bitCount > 0) || !firstSignature.key) {
      throw new Error("worker did not return a typed repeat signature");
    }

    const second = await runWorker({
      id: 71002,
      sourceSequence: 11,
      previousFrameSignature: firstSignature,
      preflight: false
    });

    return {
      bitCount: firstSignature.bitCount,
      byteCount: firstSignature.bits.byteLength,
      skipped: second.repeatSkipped === true,
      distance: second.repeatDistance,
      pixelPath: second.pixelPath
    };
  });

  if (!result.skipped) throw new Error("identical second frame was not repeat-skipped");
  if (result.distance !== 0) throw new Error(`identical repeat distance was ${result.distance}, expected 0`);
  if (result.pixelPath !== "y8-repeat") throw new Error(`unexpected repeat pixel path: ${result.pixelPath}`);
  console.log("AIRGAPPER_REPEAT_SIGNATURE_PASS", JSON.stringify(result));
} finally {
  await browser.close();
}
