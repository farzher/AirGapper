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
    const ggwaveFactory = (await import("/vendor/ggwave.mjs")).default;
    const ggwave = await ggwaveFactory();
    ggwave.disableLog?.();

    const RX = 1 << 1;
    const TX = 1 << 2;
    const DSS = 1 << 4;
    const F32 = ggwave.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32;
    const IO_RATE = 48000;
    const MODEM_RATE = 36000;
    const SPF = 1024;
    const FREQ_START = 32;
    const protocol = ggwave.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FASTEST;
    const protocolValue = Number(protocol?.value ?? protocol);

    for (const [name, id] of Object.entries(ggwave.ProtocolId)) {
      if (!name.startsWith("GGWAVE_PROTOCOL_")) continue;
      const enabled = Number(id?.value ?? id) === protocolValue ? 1 : 0;
      ggwave.rxToggleProtocol(id, enabled);
      ggwave.txToggleProtocol(id, enabled);
    }
    ggwave.rxProtocolSetFreqStart(protocol, FREQ_START);
    ggwave.txProtocolSetFreqStart(protocol, FREQ_START);

    function params(mode, len) {
      const p = ggwave.getDefaultParameters();
      p.payloadLength = len;
      p.sampleRateInp = IO_RATE;
      p.sampleRateOut = IO_RATE;
      p.sampleRate = MODEM_RATE;
      p.samplesPerFrame = SPF;
      p.sampleFormatInp = F32;
      p.sampleFormatOut = F32;
      p.operatingMode = mode | DSS;
      return p;
    }

    function copyWave(encoded) {
      const bytes = new Uint8Array(encoded.byteLength);
      bytes.set(new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength));
      return new Float32Array(bytes.buffer);
    }

    function makePayload(len, id = 1) {
      const payload = new Uint8Array(len);
      payload[0] = id;
      payload[1] = id ^ 0xa5;
      for (let i = 2; i < payload.length; i++) payload[i] = (i * 73 + id * 19 + 7) & 255;
      return payload;
    }

    function decodeStream(rx, samples) {
      const ids = [];
      for (let offset = 0; offset < samples.length; offset += SPF) {
        const chunk = samples.subarray(offset, Math.min(samples.length, offset + SPF));
        const input = new Int8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        const out = ggwave.decode(rx, input);
        if (!out?.length) continue;
        const bytes = new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
        ids.push(bytes[0]);
      }
      return ids;
    }

    const sizes = [];
    for (const len of [34, 44, 54, 64]) {
      const tx = ggwave.init(params(TX, len));
      const rx = ggwave.init(params(RX, len));
      try {
        const payload = makePayload(len, 23);
        const wave = copyWave(ggwave.encode(tx, payload, protocol, 100));
        const leading = new Float32Array(4096 + 137);
        const trailing = new Float32Array(32768);
        const samples = new Float32Array(leading.length + wave.length + trailing.length);
        samples.set(wave, leading.length);
        const ids = decodeStream(rx, samples);
        const ok = ids.includes(23);
        const signalMs = wave.length / IO_RATE * 1000;
        const usefulBytes = len - 14;
        sizes.push({
          len,
          ok,
          signalMs: Number(signalMs.toFixed(1)),
          frameMs180: Number((signalMs + 180).toFixed(1)),
          usefulBytes,
          usefulBps180: Number((usefulBytes / ((signalMs + 180) / 1000)).toFixed(2)),
          rawEvents: ids.length
        });
      } finally {
        ggwave.free(tx);
        ggwave.free(rx);
      }
    }

    const guards = [];
    const len = 44;
    for (const guardMs of [0, 20, 50, 100, 180]) {
      const tx = ggwave.init(params(TX, len));
      const rx = ggwave.init(params(RX, len));
      try {
        const waves = [];
        const expected = [];
        let total = 4096 + 137 + 32768;
        const guardSamples = Math.round(IO_RATE * guardMs / 1000);
        for (let id = 1; id <= 12; id++) {
          const wave = copyWave(ggwave.encode(tx, makePayload(len, id), protocol, 100));
          waves.push(wave);
          expected.push(id);
          total += wave.length + guardSamples;
        }
        const samples = new Float32Array(total);
        let cursor = 4096 + 137;
        for (const wave of waves) {
          samples.set(wave, cursor);
          cursor += wave.length + guardSamples;
        }
        const ids = decodeStream(rx, samples);
        const unique = [];
        for (const id of ids) {
          if (!unique.includes(id)) unique.push(id);
        }
        const matched = expected.filter((id) => unique.includes(id));
        guards.push({ guardMs, decoded: matched.length, expected: expected.length, unique, rawEvents: ids.length });
      } finally {
        ggwave.free(tx);
        ggwave.free(rx);
      }
    }

    return { sizes, guards };
  });

  console.log("AIRGAPPER_RELIABLE_SPEED_MATRIX", JSON.stringify(result));
  if (!result.sizes.every((row) => row.ok)) throw new Error("A Reliable frame size failed clean loopback");
  if (!result.guards.some((row) => row.decoded === row.expected)) throw new Error("No tested guard decoded every consecutive frame");
} finally {
  await browser.close();
}
