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
    const [{ packFrame, parseFrame }, { default: QRCode }] = await Promise.all([
      import("/shared/protocol.js"),
      import("/vendor/qrcode.js")
    ]);

    const dim = 177;
    const scale = 4;
    const origin = 30;
    const width = 768;
    const height = 768;
    const payloadId = 0x71a7c0de;
    const blockLen = 1800;
    const totalLen = 4000;
    const k = Math.ceil(totalLen / blockLen);

    function block(seed) {
      const out = new Uint8Array(blockLen);
      let x = seed >>> 0;
      for (let i = 0; i < out.length; i++) {
        x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
        out[i] = x & 255;
      }
      return out;
    }

    function packet(seq, seed) {
      return packFrame({
        mode: "mds", k, seq, layoutId: 0, slotIndex: 0,
        blockLen, totalLen, payloadId
      }, block(seed));
    }

    const packets = [
      packet(41, 0x11111111), packet(42, 0x22222222), packet(43, 0x33333333),
      packet(44, 0x44444444), packet(45, 0x55555555), packet(46, 0x66666666)
    ];
    const qrs = packets.map((bytes) => QRCode.create(
      [{ data: bytes, mode: "byte" }],
      { version: 40, errorCorrectionLevel: "L", maskPattern: 4 }
    ));
    if (!qrs.every((qr) => qr.modules.size === dim)) throw new Error("proof did not generate v40 matrices");

    const quad = {
      topLeft: { x: origin, y: origin },
      topRight: { x: origin + dim * scale, y: origin },
      bottomRight: { x: origin + dim * scale, y: origin + dim * scale },
      bottomLeft: { x: origin, y: origin + dim * scale }
    };

    const cutAt = (x, center, tilt) => center + tilt * ((x + 0.5) / dim - 0.5);
    const moduleDark = (qr, x, y) => Boolean(qr.modules.data[y * dim + x]);

    function hybridSoft(topQr, bottomQr, center, tilt, sequence) {
      const luma = new Uint8Array(dim * dim);
      for (let y = 0; y < dim; y++) {
        for (let x = 0; x < dim; x++) {
          const qr = y + 0.5 < cutAt(x, center, tilt) ? topQr : bottomQr;
          const dark = moduleDark(qr, x, y);
          const noise = ((x * 17 + y * 31 + sequence * 7) % 9) - 4;
          luma[y * dim + x] = Math.max(0, Math.min(255, (dark ? 20 : 236) + noise));
        }
      }
      return {
        slot: 0, dim, luma, threshold: 128, low: 20, high: 236,
        separation: 216,
        quad,
        sourceSequence: sequence
      };
    }

    function hybridFrame(topQr, bottomQr, center, tilt, sequence) {
      const ySize = width * height;
      const uvSize = (width >> 1) * (height >> 1);
      const bytes = new Uint8Array(ySize + uvSize * 2);
      const yPlane = bytes.subarray(0, ySize);
      yPlane.fill(238);
      bytes.fill(128, ySize);
      for (let my = 0; my < dim; my++) {
        for (let mx = 0; mx < dim; mx++) {
          const qr = my + 0.5 < cutAt(mx, center, tilt) ? topQr : bottomQr;
          const value = moduleDark(qr, mx, my) ? 18 : 238;
          const x0 = origin + mx * scale;
          const y0 = origin + my * scale;
          for (let sy = 0; sy < scale; sy++)
            yPlane.fill(value, (y0 + sy) * width + x0, (y0 + sy) * width + x0 + scale);
        }
      }
      return new VideoFrame(bytes, {
        format: "I420", codedWidth: width, codedHeight: height,
        timestamp: sequence * 33_333
      });
    }

    async function normalDecode(topQr, bottomQr, center, tilt, sequence, id) {
      const worker = new Worker(new URL("/receive/worker.js?raw=1", location.href), { type: "module" });
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { worker.terminate(); reject(new Error("raw decode timeout")); }, 45_000);
        worker.onerror = (event) => { clearTimeout(timeout); worker.terminate(); reject(new Error(event.message || "raw worker failed")); };
        worker.onmessage = (event) => {
          if (event.data?.id !== id || event.data?.preflight) return;
          clearTimeout(timeout);
          worker.terminate();
          resolve(event.data);
        };
        const frame = hybridFrame(topQr, bottomQr, center, tilt, sequence);
        worker.postMessage({
          id, videoFrame: frame,
          cropX: 0, cropY: 0, w: width, h: height, ox: 0, oy: 0,
          full: false, tracks: [{ slot: 0, dim, quad }], pixelFormat: "y8",
          payloadBytes: width * height, sourceSequence: sequence
        }, [frame]);
      });
    }

    // Overlap case: both physical camera frames are individually corrupt but
    // together contain a complete latent middle sender page.
    const firstRaw = await normalDecode(qrs[0], qrs[1], 73, -24, 100, 8101);
    const secondRaw = await normalDecode(qrs[1], qrs[2], 105, -20, 101, 8102);
    if ((firstRaw.symbols?.length ?? 0) !== 0 || (secondRaw.symbols?.length ?? 0) !== 0)
      throw new Error(`diagonal overlap hybrids decoded individually: ${firstRaw.symbols?.length}/${secondRaw.symbols?.length}`);

    // Gap case: the transition moved backwards. Between the two lines neither
    // camera frame contains B at all (previous has A, current has C). This is
    // the case that requires explicit QR erasures rather than a perfect splice.
    const gapPreviousRaw = await normalDecode(qrs[0], qrs[1], 96, 24.5, 120, 8121);
    const gapCurrentRaw = await normalDecode(qrs[1], qrs[2], 81, 24.5, 121, 8122);
    if ((gapPreviousRaw.symbols?.length ?? 0) !== 0 || (gapCurrentRaw.symbols?.length ?? 0) !== 0)
      throw new Error(`diagonal gap hybrids decoded individually: ${gapPreviousRaw.symbols?.length}/${gapCurrentRaw.symbols?.length}`);

    const worker = new Worker(new URL("/receive/worker-temporal-generalized.js", location.href), { type: "module" });
    let token = 0;
    const call = (payload, transfer = []) => new Promise((resolve, reject) => {
      const t = ++token;
      const timeout = setTimeout(() => reject(new Error("generalized recovery timeout")), 45_000);
      const listener = (event) => {
        if (!event.data?.temporalGeneralized || event.data.token !== t) return;
        worker.removeEventListener("message", listener);
        clearTimeout(timeout);
        resolve(event.data);
      };
      worker.addEventListener("message", listener);
      worker.postMessage({ ...payload, token: t }, transfer);
    });

    const cases = [
      { a: 0, b: 1, c: 2, prev: [73, -24], curr: [105, -20], seq: 101, target: 1 },
      { a: 1, b: 2, c: 3, prev: [91, 18], curr: [111, 23], seq: 102, target: 2 },
      { a: 2, b: 3, c: 4, prev: [58, 29], curr: [87, 24], seq: 103, target: 3 },
      { a: 3, b: 4, c: 5, prev: [101, -31], curr: [130, -27], seq: 104, target: 4 },
      { a: 4, b: 5, c: 0, prev: [46, 10], curr: [78, 15], seq: 105, target: 5 },
      { a: 5, b: 0, c: 1, prev: [112, 7], curr: [143, 3], seq: 106, target: 0 },
      // Backwards seam motion creates a true unobserved strip. The midlines are
      // chosen at broad-search positions, while the diagonal slopes differ
      // slightly to exercise the erasure margin rather than a hand-perfect cut.
      { a: 0, b: 1, c: 2, prev: [96, 24.5], curr: [81, 23.0], seq: 107, target: 1, requireErasures: true },
      { a: 2, b: 3, c: 4, prev: [141, -24.0], curr: [124.5, -26.0], seq: 108, target: 3, requireErasures: true }
    ];

    const summaries = [];
    let erasureProofs = 0;
    for (const spec of cases) {
      const previous = hybridSoft(qrs[spec.a], qrs[spec.b], spec.prev[0], spec.prev[1], spec.seq - 1);
      const current = hybridSoft(qrs[spec.b], qrs[spec.c], spec.curr[0], spec.curr[1], spec.seq);
      const response = await call({
        action: "recover", sourceSequence: spec.seq, maxMs: 150,
        pairs: [{ slot: 0, previous, current }]
      }, [previous.luma.buffer, current.luma.buffer]);
      if ((response.symbols?.length ?? 0) !== 1)
        throw new Error(`case ${spec.seq} failed after ${response.metrics?.attempts ?? 0} attempts: ${JSON.stringify(response.metrics)}`);
      const actual = new Uint8Array(response.symbols[0].bytes);
      const expected = packets[spec.target];
      if (actual.length !== expected.length || !actual.every((value, index) => value === expected[index]))
        throw new Error(`case ${spec.seq} reconstructed wrong packet`);
      const parsed = parseFrame(actual);
      if (!parsed || parsed.header.seq !== 41 + spec.target || parsed.header.payloadId !== payloadId)
        throw new Error(`case ${spec.seq} failed AirGapper CRC/header validation`);
      if (spec.requireErasures) {
        if (!(response.metrics?.erasureHits > 0) || !response.symbols[0].usedErasures)
          throw new Error(`case ${spec.seq} did not prove erasure recovery: ${JSON.stringify(response.metrics)}`);
        erasureProofs++;
      }
      summaries.push({
        seq: spec.seq,
        attempts: response.metrics.attempts,
        erasureAttempts: response.metrics.erasureAttempts,
        erasureHits: response.metrics.erasureHits,
        fastAttempts: response.metrics.fastAttempts,
        ms: response.metrics.recoverMs,
        center: response.metrics.centerRow,
        tilt: response.metrics.tiltRows,
        source: response.metrics.candidateSource,
        usedErasures: response.metrics.usedErasures
      });
    }
    worker.terminate();

    if (erasureProofs !== 2) throw new Error(`expected 2 erasure proofs, got ${erasureProofs}`);
    return {
      rawOverlap: [firstRaw.symbols?.length ?? 0, secondRaw.symbols?.length ?? 0],
      rawGap: [gapPreviousRaw.symbols?.length ?? 0, gapCurrentRaw.symbols?.length ?? 0],
      erasureProofs,
      cases: summaries
    };
  });

  console.log("AIRGAPPER_TEMPORAL_GENERALIZED_PROOF_PASS", JSON.stringify(result));
} finally {
  await browser.close();
}
