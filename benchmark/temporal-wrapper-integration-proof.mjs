import { chromium } from "playwright";

const baseUrl = process.env.AIRGAPPER_URL || "http://127.0.0.1:8080/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] });

try {
  const page = await browser.newPage();
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const result = await page.evaluate(async () => {
    const [{ packFrame, parseFrame }, { default: QRCode }] = await Promise.all([
      import("/shared/protocol.js"),
      import("/vendor/qrcode.js")
    ]);
    const dim = 177, scale = 4, origin = 30, width = 768, height = 768;
    const payloadId = 0x6a17cafe, blockLen = 1800, totalLen = 4000, k = 3;
    const makeBlock = (seed) => {
      const out = new Uint8Array(blockLen); let x = seed >>> 0;
      for (let i = 0; i < out.length; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; out[i] = x & 255; }
      return out;
    };
    const packet = (seq, seed) => packFrame({ mode: "mds", k, seq, layoutId: 0, slotIndex: 0, blockLen, totalLen, payloadId }, makeBlock(seed));
    const packets = [packet(70, 0x11111111), packet(71, 0x22222222), packet(72, 0x33333333)];
    const qrs = packets.map((bytes) => QRCode.create([{ data: bytes, mode: "byte" }], { version: 40, errorCorrectionLevel: "L", maskPattern: 4 }));
    const quad = {
      topLeft: { x: origin, y: origin }, topRight: { x: origin + dim * scale, y: origin },
      bottomRight: { x: origin + dim * scale, y: origin + dim * scale }, bottomLeft: { x: origin, y: origin + dim * scale }
    };
    const cut = (x, center, tilt) => center + tilt * ((x + 0.5) / dim - 0.5);
    const frame = (top, bottom, center, tilt, sequence) => {
      const ySize = width * height, uvSize = (width >> 1) * (height >> 1);
      const bytes = new Uint8Array(ySize + uvSize * 2); const y = bytes.subarray(0, ySize);
      y.fill(238); bytes.fill(128, ySize);
      for (let my = 0; my < dim; my++) for (let mx = 0; mx < dim; mx++) {
        const qr = my + 0.5 < cut(mx, center, tilt) ? top : bottom;
        const value = qr.modules.data[my * dim + mx] ? 18 : 238;
        const x0 = origin + mx * scale, y0 = origin + my * scale;
        for (let sy = 0; sy < scale; sy++) y.fill(value, (y0 + sy) * width + x0, (y0 + sy) * width + x0 + scale);
      }
      return new VideoFrame(bytes, { format: "I420", codedWidth: width, codedHeight: height, timestamp: sequence * 33_333 });
    };

    const worker = new Worker(new URL("/receive/worker-reconstruct-bootstrap.js", location.href), { type: "module" });
    const run = (id, videoFrame, sourceSequence) => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`wrapper job ${id} timeout`)), 45_000);
      const listener = (event) => {
        if (event.data?.id !== id || event.data?.preflight) return;
        worker.removeEventListener("message", listener); clearTimeout(timeout); resolve(event.data);
      };
      worker.addEventListener("message", listener);
      worker.postMessage({
        id, videoFrame, cropX: 0, cropY: 0, w: width, h: height, ox: 0, oy: 0,
        full: false, tracks: [{ slot: 0, dim, quad }], pixelFormat: "y8",
        payloadBytes: width * height, sourceSequence
      }, [videoFrame]);
    });

    const first = await run(9101, frame(qrs[0], qrs[1], 72, -22, 200), 200);
    const completions = [
      await run(9102, frame(qrs[1], qrs[2], 106, -18, 201), 201)
    ];

    const findTarget = () => {
      for (let i = 0; i < completions.length; i++) {
        const symbol = (completions[i].symbols ?? []).find((candidate) =>
          candidate.decodePath === "temporal-generalized" && Number(candidate.header?.seq) === 71);
        if (symbol) return { completion: completions[i], symbol, index: i };
      }
      return null;
    };

    // Recovery is intentionally not allowed to hold the hot camera worker past
    // its small response budget. If it finishes later, the valid sender packet
    // must roll into one of the next low-count completions instead.
    if (!findTarget()) completions.push(
      await run(9103, frame(qrs[2], qrs[0], 78, -14, 202), 202)
    );
    if (!findTarget()) completions.push(
      await run(9104, frame(qrs[0], qrs[1], 96, -10, 203), 203)
    );

    const target = findTarget();
    worker.terminate();
    if (!target) {
      throw new Error(`wrapper produced no temporal packet 71: ${JSON.stringify(completions.map((item) => item.temporalMetrics))}`);
    }

    const { completion: carrier, symbol: temporal, index: carrierIndex } = target;
    const actual = new Uint8Array(temporal.bytes);
    const expected = packets[1];
    if (actual.length !== expected.length || !actual.every((value, index) => value === expected[index]))
      throw new Error("wrapper recovered wrong packet");
    const parsed = parseFrame(actual);
    if (!parsed || parsed.header.seq !== 71 || parsed.header.payloadId !== payloadId)
      throw new Error("wrapper temporal symbol failed CRC/header validation");
    if (!(carrier.temporalMetrics?.merged >= 1)) throw new Error("wrapper did not report merged temporal recovery");
    if (carrierIndex > 0 && !(carrier.temporalMetrics?.lateMerged >= 1) && !(temporal.temporalLag > 0))
      throw new Error(`late recovery was not reported as late: ${JSON.stringify(carrier.temporalMetrics)}`);
    if (Number(temporal.temporalLag ?? 0) > 2)
      throw new Error(`temporal recovery rolled forward too far: ${temporal.temporalLag}`);

    return {
      firstSymbols: first.symbols?.length ?? 0,
      carrierJob: 9102 + carrierIndex,
      carrierSymbols: carrier.symbols?.length ?? 0,
      decodePath: temporal.decodePath,
      temporalLag: temporal.temporalLag ?? 0,
      seq: parsed.header.seq,
      latencyMs: carrier.latencyMs,
      temporal: carrier.temporalMetrics
    };
  });
  console.log("AIRGAPPER_TEMPORAL_WRAPPER_INTEGRATION_PASS", JSON.stringify(result));
} finally {
  await browser.close();
}
