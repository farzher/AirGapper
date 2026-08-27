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

    const received = await new Promise((resolve, reject) => {
      const workerUrl = new URL("/audio/ultra-worker.js", location.href);
      workerUrl.searchParams.set("loopback", stamp);
      const worker = new Worker(workerUrl, { type: "module" });
      const timer = setTimeout(() => {
        worker.terminate();
        reject(new Error("Reliable ggwave worker loopback timed out"));
      }, 20_000);
      worker.onerror = (event) => {
        clearTimeout(timer);
        worker.terminate();
        reject(new Error(event.message || "Reliable ggwave worker failed"));
      };
      worker.onmessage = (event) => {
        const packet = event.data?.packet;
        if (!packet || !(packet.block instanceof ArrayBuffer)) return;
        clearTimeout(timer);
        worker.terminate();
        resolve({ ...packet, block: Array.from(new Uint8Array(packet.block)) });
      };

      const leading = new Float32Array(4096);
      const trailing = new Float32Array(16384);
      const samples = new Float32Array(leading.length + waveform.length + trailing.length);
      samples.set(waveform, leading.length);
      let offset = 0;
      while (offset < samples.length) {
        const end = Math.min(samples.length, offset + 997);
        const chunk = samples.slice(offset, end);
        worker.postMessage({ type: "samples", samples: chunk.buffer }, [chunk.buffer]);
        offset = end;
      }
    });

    return {
      ...received,
      expectedBlock: Array.from(block),
      waveformSamples: waveform.length
    };
  });

  if (result.payloadId !== 0x51a9c3e7) throw new Error(`Reliable payload id mismatch: ${result.payloadId}`);
  if (result.totalLen !== 48 || result.mode !== "mds" || result.encodingId !== 7 || result.blockSize !== 24) {
    throw new Error(`Reliable metadata mismatch: ${JSON.stringify(result)}`);
  }
  if (result.block.length !== result.expectedBlock.length || result.block.some((value, i) => value !== result.expectedBlock[i])) {
    throw new Error("Reliable block mismatch");
  }
  console.log("AIRGAPPER_AUDIO_RELIABLE_GGWAVE_PASS", JSON.stringify({
    waveformSamples: result.waveformSamples,
    decodedBytes: result.block.length
  }));
} finally {
  await browser.close();
}
