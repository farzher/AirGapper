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
    const payloadId = 0x51a7c0de;
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
        mode: "mds",
        k,
        seq,
        layoutId: 0,
        slotIndex: 0,
        blockLen,
        totalLen,
        payloadId
      }, block(seed));
    }

    const packets = [packet(17, 0x11111111), packet(18, 0x22222222), packet(19, 0x33333333)];
    const qrs = packets.map((bytes) => QRCode.create([{ data: bytes, mode: "byte" }], { version: 40, errorCorrectionLevel: "L" }));
    if (!qrs.every((qr) => qr.modules.size === dim)) throw new Error("proof did not generate v40 QR matrices");

    const quad = {
      topLeft: { x: origin, y: origin },
      topRight: { x: origin + dim * scale, y: origin },
      bottomRight: { x: origin + dim * scale, y: origin + dim * scale },
      bottomLeft: { x: origin, y: origin + dim * scale }
    };

    function hybridFrame(topQr, bottomQr, splitRow, sourceSequence) {
      const ySize = width * height;
      const uvSize = (width >> 1) * (height >> 1);
      const bytes = new Uint8Array(ySize + uvSize * 2);
      const y = bytes.subarray(0, ySize);
      y.fill(238);
      bytes.fill(128, ySize);
      for (let my = 0; my < dim; my++) {
        const qr = my < splitRow ? topQr : bottomQr;
        const row = my * dim;
        for (let mx = 0; mx < dim; mx++) {
          const value = qr.modules.data[row + mx] ? 18 : 238;
          const x0 = origin + mx * scale;
          const y0 = origin + my * scale;
          for (let sy = 0; sy < scale; sy++) {
            y.fill(value, (y0 + sy) * width + x0, (y0 + sy) * width + x0 + scale);
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

    const previousSpec = { top: qrs[0], bottom: qrs[1], split: 80, sequence: 100 };
    const currentSpec = { top: qrs[1], bottom: qrs[2], split: 96, sequence: 101 };

    async function normalDecode(spec, id) {
      const worker = new Worker(new URL("/receive/worker.js?raw=1", location.href), { type: "module" });
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { worker.terminate(); reject(new Error("normal proof decode timed out")); }, 45_000);
        worker.onerror = (event) => { clearTimeout(timeout); worker.terminate(); reject(new Error(event.message || "normal worker failed")); };
        worker.onmessage = (event) => {
          if (event.data?.id !== id || event.data?.preflight) return;
          clearTimeout(timeout);
          worker.terminate();
          resolve(event.data);
        };
        const frame = hybridFrame(spec.top, spec.bottom, spec.split, spec.sequence);
        worker.postMessage({
          id,
          videoFrame: frame,
          cropX: 0, cropY: 0, w: width, h: height, ox: 0, oy: 0,
          full: false,
          tracks: [{ slot: 0, dim, quad }],
          pixelFormat: "y8",
          payloadBytes: width * height,
          sourceSequence: spec.sequence
        }, [frame]);
      });
    }

    const normalPrevious = await normalDecode(previousSpec, 7001);
    const normalCurrent = await normalDecode(currentSpec, 7002);
    if ((normalPrevious.symbols?.length ?? 0) !== 0 || (normalCurrent.symbols?.length ?? 0) !== 0) {
      throw new Error(`hybrid proof frame decoded without stitching: ${normalPrevious.symbols?.length}/${normalCurrent.symbols?.length}`);
    }

    const worker = new Worker(new URL("/receive/worker-temporal-v2.js", location.href), { type: "module" });
    let token = 0;
    const waiters = new Map();
    worker.onerror = (event) => {
      for (const reject of waiters.values()) reject(new Error(event.message || "temporal proof worker failed"));
      waiters.clear();
    };
    worker.onmessage = (event) => {
      const data = event.data;
      if (!data?.temporalV2) return;
      const waiter = waiters.get(data.token);
      if (waiter) { waiters.delete(data.token); waiter(data); }
    };
    const command = (payload, transfer = [], timeoutMs = 45_000) => new Promise((resolve, reject) => {
      const commandToken = ++token;
      const timer = setTimeout(() => { waiters.delete(commandToken); reject(new Error(`temporal proof ${payload.action} timed out`)); }, timeoutMs);
      waiters.set(commandToken, (data) => { clearTimeout(timer); resolve(data); });
      worker.postMessage({ ...payload, token: commandToken, generation: 1 }, transfer);
    });

    async function sample(spec, id) {
      const frame = hybridFrame(spec.top, spec.bottom, spec.split, spec.sequence);
      const started = performance.now();
      const reply = await command({
        action: "sample",
        id,
        videoFrame: frame,
        cropX: 0, cropY: 0, w: width, h: height, ox: 0, oy: 0,
        full: false,
        tracks: [{ slot: 0, dim, quad }],
        pixelFormat: "y8",
        payloadBytes: width * height,
        sourceSequence: spec.sequence
      }, [frame]);
      return { reply, wallMs: performance.now() - started };
    }

    const first = await sample(previousSpec, 7101);
    const second = await sample(currentSpec, 7102);
    const recoverStarted = performance.now();
    const recovered = await command({
      action: "recover",
      id: 7102,
      sourceSequence: currentSpec.sequence,
      missingSlots: [0]
    });
    const recoverWallMs = performance.now() - recoverStarted;
    worker.terminate();

    if ((recovered.symbols?.length ?? 0) !== 1) {
      throw new Error(`cross-frame reconstruction produced ${recovered.symbols?.length ?? 0} packets after ${recovered.guidedMetrics?.temporalStitchAttempts ?? 0} attempts`);
    }
    const actual = new Uint8Array(recovered.symbols[0].bytes);
    const target = packets[1];
    if (actual.length !== target.length || !actual.every((value, index) => value === target[index])) {
      throw new Error("cross-frame reconstruction decoded the wrong packet");
    }
    const parsed = parseFrame(actual);
    if (!parsed || parsed.header.seq !== 18 || parsed.header.slotIndex !== 0 || parsed.header.payloadId !== payloadId) {
      throw new Error("reconstructed packet failed AirGapper CRC/header verification");
    }

    return {
      dim,
      bytes: actual.length,
      normalPreviousSymbols: normalPrevious.symbols?.length ?? 0,
      normalCurrentSymbols: normalCurrent.symbols?.length ?? 0,
      firstSampleWallMs: first.wallMs,
      firstSampleWorkerMs: first.reply.guidedMetrics?.temporalSampleMs,
      secondSampleWallMs: second.wallMs,
      secondSampleWorkerMs: second.reply.guidedMetrics?.temporalSampleMs,
      copyMs: second.reply.guidedMetrics?.temporalCopyMs,
      attempts: recovered.guidedMetrics?.temporalStitchAttempts,
      hits: recovered.guidedMetrics?.temporalStitchHits,
      seam: recovered.guidedMetrics?.temporalStitchSeam,
      orientation: recovered.guidedMetrics?.temporalStitchOrientation,
      delta: recovered.guidedMetrics?.temporalStitchSourceDelta,
      recoverWorkerMs: recovered.guidedMetrics?.temporalRecoverMs,
      recoverWallMs,
      seq: parsed.header.seq
    };
  });

  if (result.hits !== 1 || result.delta !== 1 || result.seq !== 18)
    throw new Error(`cross-frame proof did not produce the intended adjacent packet: ${JSON.stringify(result)}`);
  console.log("AIRGAPPER_TEMPORAL_CROSS_FRAME_PROOF_PASS", JSON.stringify(result));
} finally {
  await browser.close();
}
