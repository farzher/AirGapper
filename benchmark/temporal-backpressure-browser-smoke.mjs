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
    const worker = new Worker(new URL("/receive/worker-temporal-v2.js", location.href), { type: "module" });
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
    const started = performance.now();
    const replies = [];
    let timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error("two-stage temporal companion smoke timed out"));
    }, 8000);

    worker.onerror = (event) => {
      clearTimeout(timeout);
      worker.terminate();
      reject(new Error(event.message || "temporal v2 worker failed"));
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

    function sample(id, sourceSequence, invert, token) {
      const frame = makeFrame(invert, sourceSequence);
      worker.postMessage({
        action: "sample",
        token,
        generation: 1,
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
        sourceSequence
      }, [frame]);
    }

    worker.onmessage = (event) => {
      const message = event.data;
      if (!message?.temporalV2) return;
      replies.push({ ...message, wallMs: performance.now() - started });
      if (message.phase === "sample" && message.id === 4101) {
        sample(4102, 2, true, 2);
        return;
      }
      if (message.phase === "sample" && message.id === 4102) {
        worker.postMessage({
          action: "recover",
          token: 3,
          generation: 1,
          id: 4102,
          sourceSequence: 2,
          missingSlots: [0]
        });
        return;
      }
      if (message.phase === "recover" && message.id === 4102) {
        clearTimeout(timeout);
        worker.terminate();
        resolve(replies);
      }
    };

    sample(4101, 1, false, 1);
  }));

  const samples = result.filter((item) => item.phase === "sample");
  const recovery = result.find((item) => item.phase === "recover");
  if (samples.length !== 2) throw new Error(`expected two sample replies, got ${samples.length}`);
  if (!recovery) throw new Error("missing recovery reply");
  for (const sample of samples) {
    if ((sample.guidedMetrics?.temporalStitchSampled ?? 0) < 1)
      throw new Error(`sample stage did not cache modules: ${JSON.stringify(sample.guidedMetrics)}`);
  }
  if ((recovery.guidedMetrics?.temporalStitchAttempts ?? 0) < 1)
    throw new Error(`recovery did not try seams: ${JSON.stringify(recovery.guidedMetrics)}`);
  if (samples[0].wallMs > 1500 || samples[1].wallMs > 2000)
    throw new Error(`sample stage blocked too long: ${samples.map((item) => item.wallMs.toFixed(1)).join(", ")} ms`);
  if (recovery.wallMs > 5000)
    throw new Error(`recovery took too long: ${recovery.wallMs.toFixed(1)} ms`);

  console.log("AIRGAPPER_TEMPORAL_BACKPRESSURE_BROWSER_PASS", JSON.stringify({
    firstSampleMs: samples[0].wallMs,
    secondSampleMs: samples[1].wallMs,
    recoveryAttempts: recovery.guidedMetrics.temporalStitchAttempts,
    recoveryMs: recovery.wallMs
  }));
} finally {
  await browser.close();
}
