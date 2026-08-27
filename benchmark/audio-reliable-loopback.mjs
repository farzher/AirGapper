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
    const stamp = String(Date.now());
    const { modulateUltraFrame } = await import(`/audio/ultra-stream.js?loopback=${stamp}`);
    const payloadId = 0x51a9c3e7;
    const totalLen = 48;
    const mode = "mds";
    const ordinal = 7;
    const block = new Uint8Array(24);
    for (let i = 0; i < block.length; i++) block[i] = (i * 19 + 11) & 255;
    const waveform = modulateUltraFrame(payloadId, totalLen, mode, ordinal, [block]);

    const packet = await new Promise((resolve, reject) => {
      const workerUrl = new URL("/audio/ultra-worker.js", location.href);
      workerUrl.searchParams.set("loopback", stamp);
      const worker = new Worker(workerUrl, { type: "module" });
      const timer = setTimeout(() => {
        worker.terminate();
        reject(new Error("Reliable worker loopback timed out"));
      }, 20_000);
      worker.onerror = (event) => {
        clearTimeout(timer);
        worker.terminate();
        reject(new Error(event.message || "Reliable worker failed"));
      };
      worker.onmessage = (event) => {
        if (event.data?.type === "ready") {
          const leading = new Float32Array(4096);
          const trailing = new Float32Array(16384);
          const samples = new Float32Array(leading.length + waveform.length + trailing.length);
          samples.set(waveform, leading.length);
          for (let offset = 0; offset < samples.length; offset += 997) {
            const chunk = samples.slice(offset, Math.min(samples.length, offset + 997));
            worker.postMessage({ type: "samples", samples: chunk.buffer }, [chunk.buffer]);
          }
          return;
        }
        const decoded = event.data?.packet;
        if (!decoded || !(decoded.block instanceof ArrayBuffer)) return;
        clearTimeout(timer);
        worker.terminate();
        resolve({ ...decoded, block: Array.from(new Uint8Array(decoded.block)) });
      };
    });

    return { packet, expected: Array.from(block), waveformSamples: waveform.length };
  });

  const packet = result.packet;
  if (packet.payloadId !== 0x51a9c3e7 || packet.totalLen !== 48 || packet.mode !== "mds" || packet.encodingId !== 7 || packet.blockSize !== 24) {
    throw new Error(`Reliable metadata mismatch: ${JSON.stringify(packet)}`);
  }
  if (packet.block.length !== result.expected.length || packet.block.some((value, i) => value !== result.expected[i])) {
    throw new Error("Reliable block mismatch");
  }
  console.log("AIRGAPPER_AUDIO_RELIABLE_WORKER_PASS", JSON.stringify({
    waveformSamples: result.waveformSamples,
    decodedBytes: packet.block.length
  }));
} finally {
  await browser.close();
}
