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
    const { buildUltraMessage, parseUltraMessage } = await import(`/audio/ultra-format.js?loopback=${stamp}`);
    const { prepareRaptorQ } = await import(`/shared/raptorq.js?loopback=${stamp}`);
    const { TransportEncoder, scheduledEncodingId } = await import(`/shared/transport.js?loopback=${stamp}`);
    const { raptorPacketEsi } = await import(`/shared/coding-mode.js?loopback=${stamp}`);

    const payloadId = 0x51a9c3e7;
    const mdsBlock = new Uint8Array(24);
    for (let i = 0; i < mdsBlock.length; i++) mdsBlock[i] = (i * 19 + 11) & 255;
    const mdsMessage = buildUltraMessage(payloadId, 48, "mds", 7, [mdsBlock]);
    const mds = parseUltraMessage(mdsMessage);
    if (!mds) throw new Error("Reliable MDS envelope did not round-trip");

    await prepareRaptorQ();
    const payload = new Uint8Array(1000);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 29 + 17) & 255;
    const encoder = new TransportEncoder(payload, 24, "raptorq");
    const requestId = scheduledEncodingId(encoder.k, 0);
    const raptorBlock = encoder.encode(requestId);
    const embeddedEsi = raptorPacketEsi(raptorBlock);
    const raptorMessage = buildUltraMessage(payloadId, payload.length, "raptorq", 0, [raptorBlock]);
    const raptor = parseUltraMessage(raptorMessage);
    encoder.free();
    if (!raptor) throw new Error("Reliable RaptorQ envelope did not round-trip");

    return {
      mds: {
        encodingId: mds.encodingId,
        block: Array.from(mds.block)
      },
      raptor: {
        requestId,
        embeddedEsi,
        encodingId: raptor.encodingId,
        block: Array.from(raptor.block),
        expectedBlock: Array.from(raptorBlock),
        messageBytes: raptorMessage.length
      }
    };
  });

  if (result.mds.encodingId !== 7) throw new Error(`Reliable MDS id mismatch: ${result.mds.encodingId}`);
  if (result.raptor.embeddedEsi <= result.raptor.requestId) {
    throw new Error(`Expected RaptorQ ESI to include the source-symbol offset: ${JSON.stringify(result.raptor)}`);
  }
  if (result.raptor.encodingId !== result.raptor.embeddedEsi) {
    throw new Error(`Reliable RaptorQ id mismatch: ${JSON.stringify(result.raptor)}`);
  }
  if (result.raptor.block.length !== result.raptor.expectedBlock.length || result.raptor.block.some((value, i) => value !== result.raptor.expectedBlock[i])) {
    throw new Error("Reliable RaptorQ block mismatch");
  }
  if (result.raptor.messageBytes !== 33) throw new Error(`Reliable RaptorQ envelope still carries a redundant id: ${result.raptor.messageBytes} bytes`);

  console.log("AIRGAPPER_AUDIO_RELIABLE_RAPTORQ_PASS", JSON.stringify({
    requestId: result.raptor.requestId,
    embeddedEsi: result.raptor.embeddedEsi,
    messageBytes: result.raptor.messageBytes
  }));
} finally {
  await browser.close();
}
