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
  const rows = await page.evaluate(async () => {
    const ggwaveFactory = (await import("/vendor/ggwave.mjs")).default;
    const ggwave = await ggwaveFactory();
    ggwave.disableLog?.();

    const RX = 1 << 1;
    const TX = 1 << 2;
    const DSS = 1 << 4;
    const F32 = ggwave.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32;
    const IO_RATE = 48000;
    const SPF = 1024;

    const configs = [
      { name: "current-dt34-v50", protocol: "GGWAVE_PROTOCOL_DT_FASTEST", rate: 48000, freqStart: 24, len: 34, volume: 50, widthBins: 32 },
      { name: "safe-dt64-v100", protocol: "GGWAVE_PROTOCOL_DT_FASTEST", rate: 48000, freqStart: 24, len: 64, volume: 100, widthBins: 32 },
      { name: "aud64-48k-f24", protocol: "GGWAVE_PROTOCOL_AUDIBLE_FASTEST", rate: 48000, freqStart: 24, len: 64, volume: 100, widthBins: 96 },
      { name: "aud64-36k-f32", protocol: "GGWAVE_PROTOCOL_AUDIBLE_FASTEST", rate: 36000, freqStart: 32, len: 64, volume: 100, widthBins: 96 },
      { name: "aud64-32k-f32", protocol: "GGWAVE_PROTOCOL_AUDIBLE_FASTEST", rate: 32000, freqStart: 32, len: 64, volume: 100, widthBins: 96 },
      { name: "aud64-32k-f28", protocol: "GGWAVE_PROTOCOL_AUDIBLE_FASTEST", rate: 32000, freqStart: 28, len: 64, volume: 100, widthBins: 96 },
      { name: "aud64-28k-f36", protocol: "GGWAVE_PROTOCOL_AUDIBLE_FASTEST", rate: 28000, freqStart: 36, len: 64, volume: 100, widthBins: 96 },
      { name: "aud64-28k-f32", protocol: "GGWAVE_PROTOCOL_AUDIBLE_FASTEST", rate: 28000, freqStart: 32, len: 64, volume: 100, widthBins: 96 },
      { name: "aud64-24k-f40", protocol: "GGWAVE_PROTOCOL_AUDIBLE_FASTEST", rate: 24000, freqStart: 40, len: 64, volume: 100, widthBins: 96 },
      { name: "aud64-24k-f36", protocol: "GGWAVE_PROTOCOL_AUDIBLE_FASTEST", rate: 24000, freqStart: 36, len: 64, volume: 100, widthBins: 96 }
    ];

    function protocolValue(id) {
      return Number(id?.value ?? id);
    }

    function setOnlyProtocol(protocolName, freqStart) {
      const wanted = ggwave.ProtocolId[protocolName];
      const wantedValue = protocolValue(wanted);
      for (const [name, id] of Object.entries(ggwave.ProtocolId)) {
        if (!name.startsWith("GGWAVE_PROTOCOL_")) continue;
        const enabled = protocolValue(id) === wantedValue ? 1 : 0;
        ggwave.rxToggleProtocol(id, enabled);
        ggwave.txToggleProtocol(id, enabled);
      }
      ggwave.rxProtocolSetFreqStart(wanted, freqStart);
      ggwave.txProtocolSetFreqStart(wanted, freqStart);
      return wanted;
    }

    function makeParams(mode, config) {
      const p = ggwave.getDefaultParameters();
      p.payloadLength = config.len;
      p.sampleRateInp = IO_RATE;
      p.sampleRateOut = IO_RATE;
      p.sampleRate = config.rate;
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

    async function run(config) {
      const protocol = setOnlyProtocol(config.protocol, config.freqStart);
      const tx = ggwave.init(makeParams(TX, config));
      const rx = ggwave.init(makeParams(RX, config));
      try {
        const payload = new Uint8Array(config.len);
        for (let i = 0; i < payload.length; i++) payload[i] = (i * 73 + 19) & 255;
        const encoded = ggwave.encode(tx, payload, protocol, config.volume);
        if (!encoded?.byteLength) throw new Error(`${config.name}: encode failed`);
        const wave = copyWave(encoded);
        let peak = 0;
        let sumSq = 0;
        for (const x of wave) {
          peak = Math.max(peak, Math.abs(x));
          sumSq += x * x;
        }
        const rms = Math.sqrt(sumSq / Math.max(1, wave.length));

        const leading = new Float32Array(4096 + 137);
        const trailing = new Float32Array(32768);
        const samples = new Float32Array(leading.length + wave.length + trailing.length);
        samples.set(wave, leading.length);
        let decoded = null;
        let rawEvents = 0;
        for (let offset = 0; offset < samples.length; offset += 1024) {
          const chunk = samples.subarray(offset, Math.min(samples.length, offset + 1024));
          const input = new Int8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
          const out = ggwave.decode(rx, input);
          if (!out?.length) continue;
          rawEvents++;
          if (!decoded) {
            decoded = new Uint8Array(out.length);
            decoded.set(new Uint8Array(out.buffer, out.byteOffset, out.byteLength));
          }
        }
        const ok = decoded?.length === payload.length && decoded.every((v, i) => v === payload[i]);
        const duration = wave.length / IO_RATE;
        const usefulBytes = Math.max(0, config.len - 14);
        const binHz = config.rate / SPF;
        return {
          ...config,
          ok,
          rawEvents,
          waveSamples: wave.length,
          ms: Math.round(duration * 1000),
          usefulBps: Number((usefulBytes / duration).toFixed(2)),
          peak: Number(peak.toFixed(4)),
          rms: Number(rms.toFixed(4)),
          lowHz: Math.round(config.freqStart * binHz),
          highHz: Math.round((config.freqStart + config.widthBins) * binHz)
        };
      } finally {
        ggwave.free(tx);
        ggwave.free(rx);
      }
    }

    const out = [];
    for (const config of configs) {
      try {
        out.push(await run(config));
      } catch (error) {
        out.push({ ...config, ok: false, error: error?.message || String(error) });
      }
    }
    return out;
  });

  console.log("AIRGAPPER_GGWAVE_MATRIX", JSON.stringify(rows));
  if (!rows.some((row) => row.name === "current-dt34-v50" && row.ok)) throw new Error("Current DT baseline failed");
} finally {
  await browser.close();
}
