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
    const worker = new Worker(new URL("/receive/worker-temporal.js", location.href), { type: "module" });
    const width = 180;
    const height = 180;
    const scale = 6;
    const dim = 21;
    const origin = 24;
    const quad = {
      topLeft: { x: origin, y: origin },
      topRight: { x: origin + dim * scale, y: origin },
      bottomRight: { x: origin + dim * scale, y: origin + dim * scale },
      bottomLeft: { x: origin, y: origin + dim * scale }
    };
    const replies = [];
    const started = performance.now();
    let phase = "frame 1 production/cache reply";
    let timeout;
    const armTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        worker.terminate();
        reject(new Error(`low-count temporal worker timed out waiting for ${phase}`));
      }, 8_000);
    };
    armTimeout();

    worker.onerror = (event) => {
      clearTimeout(timeout);
      worker.terminate();
      reject(new Error(event.message || "low-count temporal worker failed"));
    };
    worker.onmessage = (event) => {
      if (event.data?.id < 4101 || event.data?.id > 4102) return;
      if (event.data?.preflight) return;
      replies.push({ ...event.data, wallMs: performance.now() - started });
      if (replies.length === 1) {
        phase = "frame 2 temporal seam reply";
        armTimeout();
        post(4102, 2, true);
        return;
      }
      clearTimeout(timeout);
      worker.terminate();
      resolve(replies);
    };

    function makeFrame(invert, sourceSequence) {
      const ySize = width * height;
      const uvSize = width / 2 * (height / 2);
      const bytes = new Uint8Array(ySize + uvSize * 2);
      const y = bytes.subarray(0, ySize);
      y.fill(238);
      bytes.fill(128, ySize);
      for (let my = 0; my < dim; my++) {
        for (let mx = 0; mx < dim; mx++) {
          const dark = ((mx * 7 + my * 11 + (mx ^ my)) & 3) === 0;
          const value = (dark !== invert) ? 22 : 225;
          const x0 = origin + mx * scale;
          const y0 = origin + my * scale;
          for (let yy = 0; yy < scale; yy++) {
            y.fill(value, (y0 + yy) * width + x0, (y0 + yy) * width + x0 + scale);
          }
        }
      }
      return new VideoFrame(bytes, {
        format: "I420",
        codedWidth: width,
        codedHeight: height,
        timestamp: sourceSequence * 33_333
      });
    }

    function post(id, sourceSequence, invert) {
      const frame = makeFrame(invert, sourceSequence);
      worker.postMessage({
        id,
        videoFrame: frame,
        cropX: 0,
        cropY: 0,
        w: width,
        h: height,
        ox: 0,
        oy: 0,
        full: false,
        tracks: [{ slot: 0, dim, quad }],
        pixelFormat: "y8",
        payloadBytes: width * height,
        sourceSequence,
        strictHotPath: false,
        isolated: true
      }, [frame]);
    }

    post(4101, 1, false);
  }));

  if (result.length !== 2) throw new Error(`expected two low-count replies, got ${result.length}`);
  for (const reply of result) {
    if (reply.error) throw new Error(`low-count worker error: ${reply.error}`);
    if (reply.directFrameFailed) throw new Error("low-count VideoFrame was rejected by the production decoder");
    if ((reply.guidedMetrics?.temporalStitchSampled ?? 0) < 1)
      throw new Error(`temporal module sampling did not run: ${JSON.stringify(reply.guidedMetrics)}`);
  }
  if ((result[1].guidedMetrics?.temporalStitchAttempts ?? 0) < 1)
    throw new Error(`second adjacent frame did not attempt temporal seams: ${JSON.stringify(result[1].guidedMetrics)}`);
  if (result[1].wallMs > 5000)
    throw new Error(`low-count temporal sidecar took too long: ${result[1].wallMs.toFixed(1)} ms`);

  console.log("AIRGAPPER_LOW_COUNT_TEMPORAL_WORKER_PASS", JSON.stringify({
    firstSampled: result[0].guidedMetrics.temporalStitchSampled,
    secondAttempts: result[1].guidedMetrics.temporalStitchAttempts,
    secondWallMs: result[1].wallMs
  }));
} finally {
  await browser.close();
}
