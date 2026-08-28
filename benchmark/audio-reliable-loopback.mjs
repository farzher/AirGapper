import fs from "node:fs/promises";
import { chromium } from "playwright";

const audioMainSource = await fs.readFile(new URL("../audio/main.js", import.meta.url), "utf8");
const requiredUiSource = [
  "const STATS_WINDOW_MS = 1000;",
  "speedValue.textContent = \"👂\";",
  "speedValue.textContent = `${kbs.toFixed(2)} KB/s`;",
  "session.usefulFrameTimes.push(now)"
];
for (const source of requiredUiSource) {
  if (!audioMainSource.includes(source)) throw new Error(`Audio receive UI behavior regressed: missing ${source}`);
}
if (audioMainSource.includes('idleLabel = "Waiting"') || audioMainSource.includes('idleLabel = "Listening"')) {
  throw new Error("Audio receive UI must not replace the rolling KB/s display with Waiting/Listening labels");
}

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
    const { ULTRA_AUDIO_BLOCK_SIZE, buildUltraMessage, parseUltraMessage } = await import("/audio/ultra-format.js");
    const { ULTRA_FRAME_MS, modulateUltraFrame } = await import("/audio/ultra-stream.js");
    const { prepareRaptorQ } = await import("/shared/raptorq.js");
    const { TransportEncoder, scheduledEncodingId } = await import("/shared/transport.js");
    const { RAPTOR_PACKET_ID_BYTES, raptorPacketEsi } = await import("/shared/coding-mode.js");

    const payloadId = 0x51a9c3e7;
    const mdsBlock = new Uint8Array(ULTRA_AUDIO_BLOCK_SIZE);
    for (let i = 0; i < mdsBlock.length; i++) mdsBlock[i] = (i * 19 + 11) & 255;
    const mdsMessage = buildUltraMessage(payloadId, ULTRA_AUDIO_BLOCK_SIZE * 2, "mds", 7, [mdsBlock]);
    const mds = parseUltraMessage(mdsMessage);
    if (!mds) throw new Error("Reliable MDS envelope did not round-trip");

    await prepareRaptorQ();
    const payload = new Uint8Array(1000);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 29 + 17) & 255;
    const encoder = new TransportEncoder(payload, ULTRA_AUDIO_BLOCK_SIZE, "raptorq");
    const requestId = scheduledEncodingId(encoder.k, 0);
    const raptorBlock = encoder.encode(requestId);
    const embeddedEsi = raptorPacketEsi(raptorBlock);
    const raptorMessage = buildUltraMessage(payloadId, payload.length, "raptorq", 0, [raptorBlock]);
    const raptorEnvelope = parseUltraMessage(raptorMessage);
    if (!raptorEnvelope) throw new Error("Reliable RaptorQ envelope did not round-trip");

    const waveform = modulateUltraFrame(payloadId, payload.length, "raptorq", 0, [raptorBlock]);
    let peak = 0;
    for (const sample of waveform) peak = Math.max(peak, Math.abs(sample));
    const usefulBps = (ULTRA_AUDIO_BLOCK_SIZE - RAPTOR_PACKET_ID_BYTES) / (ULTRA_FRAME_MS / 1000);
    const received = await new Promise((resolve, reject) => {
      const worker = new Worker("/audio/ultra-worker.js", { type: "module" });
      const packets = [];
      let finishTimer = 0;
      const timer = setTimeout(() => {
        worker.terminate();
        reject(new Error("Reliable responsive ggwave worker loopback timed out"));
      }, 20_000);
      const finish = () => {
        if (finishTimer) return;
        finishTimer = setTimeout(() => {
          clearTimeout(timer);
          worker.terminate();
          resolve(packets);
        }, 500);
      };
      worker.onerror = (event) => {
        clearTimeout(timer);
        clearTimeout(finishTimer);
        worker.terminate();
        reject(new Error(event.message || "Reliable ggwave worker failed"));
      };
      worker.onmessage = async (event) => {
        if (event.data?.type === "ready") {
          const leading = new Float32Array(4096);
          const trailing = new Float32Array(16384);
          const samples = new Float32Array(leading.length + waveform.length + trailing.length);
          samples.set(waveform, leading.length);
          let offset = 0;
          let posted = 0;
          while (offset < samples.length) {
            const end = Math.min(samples.length, offset + 1024);
            const chunk = samples.slice(offset, end);
            worker.postMessage({ type: "samples", samples: chunk.buffer }, [chunk.buffer]);
            offset = end;
            if (++posted % 8 === 0) await new Promise((done) => setTimeout(done, 0));
          }
          return;
        }
        const packet = event.data?.packet;
        if (!packet || !(packet.block instanceof ArrayBuffer)) return;
        packets.push({ ...packet, block: Array.from(new Uint8Array(packet.block)) });
        finish();
      };
    });
    encoder.free();

    if (!received.length) throw new Error("Reliable worker emitted no packet");
    return {
      blockSize: ULTRA_AUDIO_BLOCK_SIZE,
      frameMs: ULTRA_FRAME_MS,
      usefulBps,
      peak,
      mds: { encodingId: mds.encodingId, messageBytes: mdsMessage.length },
      raptor: {
        requestId,
        embeddedEsi,
        envelopeEncodingId: raptorEnvelope.encodingId,
        encodingId: received[0].encodingId,
        emittedPackets: received.length,
        block: received[0].block,
        expectedBlock: Array.from(raptorBlock),
        messageBytes: raptorMessage.length,
        waveformSamples: waveform.length
      }
    };
  });

  if (result.blockSize !== 24 || result.mds.encodingId !== 7 || result.mds.messageBytes !== 34) {
    throw new Error(`Reliable fixed frame mismatch: ${JSON.stringify(result)}`);
  }
  if (result.frameMs < 1150 || result.frameMs > 1350) {
    throw new Error(`Reliable frame is no longer responsive: ${result.frameMs} ms`);
  }
  if (result.usefulBps < 15 || result.usefulBps > 17) {
    throw new Error(`Reliable useful rate moved outside expected range: ${result.usefulBps} B/s`);
  }
  if (result.peak < 0.95 || result.peak > 1.01) {
    throw new Error(`Reliable waveform is not using near-full-scale output: peak ${result.peak}`);
  }
  if (result.raptor.embeddedEsi <= result.raptor.requestId) {
    throw new Error(`Expected RaptorQ ESI to include the source-symbol offset: ${JSON.stringify(result.raptor)}`);
  }
  if (result.raptor.envelopeEncodingId !== result.raptor.embeddedEsi || result.raptor.encodingId !== result.raptor.embeddedEsi) {
    throw new Error(`Reliable RaptorQ id mismatch: ${JSON.stringify(result.raptor)}`);
  }
  if (result.raptor.emittedPackets !== 1) {
    throw new Error(`Reliable worker emitted one acoustic packet ${result.raptor.emittedPackets} times`);
  }
  if (result.raptor.block.length !== result.raptor.expectedBlock.length || result.raptor.block.some((value, i) => value !== result.raptor.expectedBlock[i])) {
    throw new Error("Reliable RaptorQ waveform block mismatch");
  }

  console.log("AIRGAPPER_AUDIO_RELIABLE_RESPONSIVE_PASS", JSON.stringify({
    requestId: result.raptor.requestId,
    embeddedEsi: result.raptor.embeddedEsi,
    emittedPackets: result.raptor.emittedPackets,
    messageBytes: result.raptor.messageBytes,
    blockSize: result.blockSize,
    frameMs: Number(result.frameMs.toFixed(1)),
    usefulBps: Number(result.usefulBps.toFixed(2)),
    peak: Number(result.peak.toFixed(3)),
    waveformSamples: result.raptor.waveformSamples
  }));
} finally {
  await browser.close();
}
