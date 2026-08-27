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
  const results = await page.evaluate(async () => {
    const stamp = String(Date.now());
    const factory = (await import(`/vendor/ggwave.mjs?diag=${stamp}`)).default;
    const ggwave = await factory();
    ggwave.disableLog?.();
    const normal = ggwave.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_NORMAL;
    const fast = ggwave.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FAST;

    function copyWaveform(encoded) {
      const copy = new ArrayBuffer(encoded.byteLength);
      new encoded.constructor(copy).set(encoded);
      return new Float32Array(copy);
    }

    function makeInstance() {
      const p = ggwave.getDefaultParameters();
      p.sampleRateInp = 48000;
      p.sampleRateOut = 48000;
      return ggwave.init(p);
    }

    function feed(rx, waveform) {
      const leading = 4096;
      const trailing = 16384;
      const stream = new Float32Array(leading + waveform.length + trailing);
      stream.set(waveform, leading);
      for (let offset = 0; offset < stream.length; offset += 1024) {
        const frame = new Float32Array(1024);
        frame.set(stream.subarray(offset, Math.min(stream.length, offset + 1024)));
        const decoded = ggwave.decode(rx, new Int8Array(frame.buffer));
        if (decoded?.length) {
          const out = new Uint8Array(decoded.length);
          out.set(new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength));
          return Array.from(out);
        }
      }
      return null;
    }

    function run(payload, protocol, separate) {
      const tx = makeInstance();
      const rx = separate ? makeInstance() : tx;
      const encoded = ggwave.encode(tx, payload, protocol, 25);
      const waveform = copyWaveform(encoded);
      const decoded = feed(rx, waveform);
      if (separate) ggwave.free(rx);
      ggwave.free(tx);
      return { decoded, samples: waveform.length };
    }

    const binary = new Uint8Array(34);
    for (let i = 0; i < binary.length; i++) binary[i] = i * 7 & 255;
    binary[5] = 0;
    binary[12] = 0;

    return {
      defaults: ggwave.getDefaultParameters(),
      enumTypes: {
        normalType: typeof normal,
        normalValue: normal?.value ?? normal,
        fastValue: fast?.value ?? fast
      },
      sameNormalText: run("hello", normal, false),
      separateNormalText: run("hello", normal, true),
      separateFastText: run("hello", fast, true),
      separateNormalBinary: run(binary, normal, true)
    };
  });
  console.log("GGWAVE_DIAGNOSTIC", JSON.stringify(results));
  if (!results.sameNormalText.decoded && !results.separateNormalText.decoded && !results.separateFastText.decoded) {
    throw new Error("Pinned ggwave cannot clean-loopback stock text in browser diagnostic");
  }
} finally {
  await browser.close();
}
