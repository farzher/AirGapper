import { chromium } from "playwright";

const baseUrl = process.env.AIRGAPPER_URL || "http://127.0.0.1:8080/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] });

try {
  const page = await browser.newPage();
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const result = await page.evaluate(async () => {
    const ggwaveFactory = (await import("/vendor/ggwave.mjs")).default;
    const ggwave = await ggwaveFactory();
    ggwave.disableLog?.();
    const RX = 1 << 1, TX = 1 << 2, DSS = 1 << 4;
    const F32 = ggwave.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32;
    const IO_RATE = 48000, SPF = 1024, LEN = 34, GUARD_MS = 20;
    const protocol = ggwave.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FASTEST;
    const protocolValue = Number(protocol?.value ?? protocol);
    const configs = [
      { rate: 36000, start: 32 },
      { rate: 38000, start: 30 },
      { rate: 40000, start: 28 },
      { rate: 42000, start: 27 }
    ];

    function selectProtocol(start) {
      for (const [name, id] of Object.entries(ggwave.ProtocolId)) {
        if (!name.startsWith("GGWAVE_PROTOCOL_")) continue;
        const enabled = Number(id?.value ?? id) === protocolValue ? 1 : 0;
        ggwave.rxToggleProtocol(id, enabled);
        ggwave.txToggleProtocol(id, enabled);
      }
      ggwave.rxProtocolSetFreqStart(protocol, start);
      ggwave.txProtocolSetFreqStart(protocol, start);
    }
    function params(mode, rate) {
      const p = ggwave.getDefaultParameters();
      p.payloadLength = LEN;
      p.sampleRateInp = IO_RATE;
      p.sampleRateOut = IO_RATE;
      p.sampleRate = rate;
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
    function payload(id) {
      const out = new Uint8Array(LEN);
      out[0] = id;
      out[1] = id ^ 0xa5;
      for (let i = 2; i < out.length; i++) out[i] = (i * 73 + id * 19 + 7) & 255;
      return out;
    }
    function decode(rx, samples) {
      const ids = [];
      for (let offset = 0; offset < samples.length; offset += SPF) {
        const chunk = samples.subarray(offset, Math.min(samples.length, offset + SPF));
        const out = ggwave.decode(rx, new Int8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        if (out?.length) ids.push(new Uint8Array(out.buffer, out.byteOffset, out.byteLength)[0]);
      }
      return ids;
    }

    const rows = [];
    for (const config of configs) {
      selectProtocol(config.start);
      const tx = ggwave.init(params(TX, config.rate));
      const rx = ggwave.init(params(RX, config.rate));
      try {
        const waves = [];
        let total = 4096 + 137 + 32768;
        const guardSamples = Math.round(IO_RATE * GUARD_MS / 1000);
        for (let id = 1; id <= 12; id++) {
          const wave = copyWave(ggwave.encode(tx, payload(id), protocol, 100));
          waves.push(wave);
          total += wave.length + guardSamples;
        }
        const samples = new Float32Array(total);
        let cursor = 4096 + 137;
        for (const wave of waves) {
          samples.set(wave, cursor);
          cursor += wave.length + guardSamples;
        }
        const rawIds = decode(rx, samples);
        const unique = [...new Set(rawIds)];
        const decoded = Array.from({ length: 12 }, (_, i) => i + 1).filter((id) => unique.includes(id)).length;
        const signalMs = waves[0].length / IO_RATE * 1000;
        const frameMs = signalMs + GUARD_MS;
        const binHz = config.rate / SPF;
        rows.push({
          ...config,
          decoded,
          expected: 12,
          rawEvents: rawIds.length,
          signalMs: Number(signalMs.toFixed(1)),
          frameMs: Number(frameMs.toFixed(1)),
          usefulBps: Number((20 / (frameMs / 1000)).toFixed(2)),
          lowHz: Math.round(config.start * binHz),
          highHz: Math.round((config.start + 96) * binHz)
        });
      } finally {
        ggwave.free(tx);
        ggwave.free(rx);
      }
    }
    return rows;
  });
  console.log("AIRGAPPER_RELIABLE_CLOCK_MATRIX", JSON.stringify(result));
  if (!result.every((row) => row.decoded === row.expected)) throw new Error("A Reliable clock dropped a clean consecutive packet");
} finally {
  await browser.close();
}
