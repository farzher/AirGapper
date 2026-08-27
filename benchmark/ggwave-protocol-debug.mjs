import { chromium } from "playwright";

const baseUrl = process.env.AIRGAPPER_URL || "http://127.0.0.1:8080/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] });

try {
  const page = await browser.newPage();
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const results = await page.evaluate(async () => {
    const { default: ggwaveFactory } = await import("/vendor/ggwave.mjs");
    const GGWAVE_RX = 1 << 1;
    const GGWAVE_TX = 1 << 2;
    const GGWAVE_DSS = 1 << 4;

    async function run(protocolName, fixedLength, dataLength, dss = false) {
      const ggwave = await ggwaveFactory();
      ggwave.disableLog?.();
      const protocol = ggwave.ProtocolId[protocolName];
      const protocolValue = Number(protocol?.value ?? protocol);
      for (const [name, id] of Object.entries(ggwave.ProtocolId)) {
        if (!name.startsWith("GGWAVE_PROTOCOL_")) continue;
        ggwave.rxToggleProtocol(id, Number(id?.value ?? id) === protocolValue ? 1 : 0);
      }

      const txp = ggwave.getDefaultParameters();
      txp.payloadLength = fixedLength ?? -1;
      txp.sampleRateInp = txp.sampleRateOut = txp.sampleRate = 48000;
      txp.sampleFormatInp = txp.sampleFormatOut = ggwave.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32;
      txp.operatingMode = GGWAVE_TX | (dss ? GGWAVE_DSS : 0);
      const tx = ggwave.init(txp);
      const payload = new Uint8Array(dataLength);
      for (let i = 0; i < payload.length; i++) payload[i] = (i * 29 + 17) & 255;
      const encoded = ggwave.encode(tx, payload, protocol, 50);
      const waveformBytes = new Uint8Array(encoded.byteLength);
      waveformBytes.set(new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength));
      ggwave.free(tx);

      const rxp = ggwave.getDefaultParameters();
      rxp.payloadLength = fixedLength ?? -1;
      rxp.sampleRateInp = rxp.sampleRateOut = rxp.sampleRate = 48000;
      rxp.sampleFormatInp = rxp.sampleFormatOut = ggwave.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32;
      rxp.operatingMode = GGWAVE_RX | (dss ? GGWAVE_DSS : 0);
      const rx = ggwave.init(rxp);
      const decoded = ggwave.decode(rx, new Int8Array(waveformBytes.buffer));
      const out = decoded?.length ? Array.from(new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength)) : [];
      ggwave.free(rx);
      return {
        protocolName,
        fixedLength,
        dataLength,
        dss,
        waveformSamples: waveformBytes.byteLength / 4,
        decodedLength: out.length,
        exact: out.length === payload.length && out.every((v, i) => v === payload[i])
      };
    }

    const cases = [
      ["GGWAVE_PROTOCOL_AUDIBLE_NORMAL", null, 8, false],
      ["GGWAVE_PROTOCOL_DT_FASTEST", null, 8, false],
      ["GGWAVE_PROTOCOL_DT_FASTEST", null, 33, false],
      ["GGWAVE_PROTOCOL_DT_FASTEST", 8, 8, false],
      ["GGWAVE_PROTOCOL_DT_FASTEST", 34, 34, false],
      ["GGWAVE_PROTOCOL_DT_FASTEST", 34, 34, true]
    ];
    const results = [];
    for (const args of cases) results.push(await run(...args));
    return results;
  });

  console.log("AIRGAPPER_GGWAVE_PROTOCOL_MATRIX", JSON.stringify(results));
  if (!results[0].exact || !results[1].exact) process.exitCode = 1;
} finally {
  await browser.close();
}
