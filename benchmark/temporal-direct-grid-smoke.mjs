import { chromium } from "playwright";

const baseUrl = process.env.AIRGAPPER_URL || "http://127.0.0.1:8080/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] });

try {
  const page = await browser.newPage();
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const result = await page.evaluate(async () => {
    const [{ packFrame, parseFrame }, { default: QRCode }, { default: AirGapperCodec }] = await Promise.all([
      import("/shared/protocol.js"),
      import("/vendor/qrcode.js"),
      import("/codec/airgapper_codec.js")
    ]);
    const blockLen = 1800, totalLen = 4000, k = 3, payloadId = 0x77112233;
    const block = new Uint8Array(blockLen);
    for (let i = 0; i < block.length; i++) block[i] = (i * 73 + 19) & 255;
    const packet = packFrame({
      mode: "mds", k, seq: 123, layoutId: 0, slotIndex: 0,
      blockLen, totalLen, payloadId
    }, block);
    const qr = QRCode.create([{ data: packet, mode: "byte" }], {
      version: 40, errorCorrectionLevel: "L", maskPattern: 4
    });
    const dim = qr.modules.size;
    if (dim !== 177) throw new Error(`expected v40/177, got ${dim}`);

    const zx = await AirGapperCodec();
    if (typeof zx._decodeModuleGrid !== "function") throw new Error("codec does not export _decodeModuleGrid");
    if (typeof zx._decodeModuleGridErasures !== "function") throw new Error("codec does not export _decodeModuleGridErasures");
    const grid = new Uint8Array(dim * dim);
    for (let i = 0; i < grid.length; i++) grid[i] = qr.modules.data[i] ? 0 : 255;
    const gridPtr = zx._malloc(grid.length);
    const erasurePtr = zx._malloc(grid.length);
    const outCapacity = 16 * 1024;
    const outPtr = zx._malloc(outCapacity);

    zx.HEAPU8.set(grid, gridPtr);
    const started = performance.now();
    const length = zx._decodeModuleGrid(gridPtr, dim, outPtr, outCapacity);
    const decodeMs = performance.now() - started;
    const actual = length > 0 ? zx.HEAPU8.slice(outPtr, outPtr + length) : new Uint8Array();
    if (length !== packet.length) throw new Error(`direct grid decode length ${length}, expected ${packet.length}`);
    if (!actual.every((value, index) => value === packet[index])) throw new Error("direct grid decode returned wrong bytes");
    const parsed = parseFrame(actual);
    if (!parsed || parsed.header.seq !== 123 || parsed.header.payloadId !== payloadId)
      throw new Error("direct grid decode failed AirGapper CRC/header verification");

    // Destroy a 20-module horizontal strip. This is intentionally beyond what
    // ordinary unknown-error QR-L correction should reliably survive, but every
    // affected codeword is explicitly identified to the erasure decoder.
    const corrupted = grid.slice();
    const erasures = new Uint8Array(grid.length);
    const bandTop = 78, bandBottom = 98;
    for (let y = bandTop; y < bandBottom; y++) {
      for (let x = 0; x < dim; x++) {
        const index = y * dim + x;
        corrupted[index] = corrupted[index] ? 0 : 255;
        erasures[index] = 1;
      }
    }
    zx.HEAPU8.set(corrupted, gridPtr);
    const hardLength = zx._decodeModuleGrid(gridPtr, dim, outPtr, outCapacity);
    if (hardLength > 0)
      throw new Error(`corrupted grid unexpectedly decoded without erasures (${hardLength} bytes)`);

    zx.HEAPU8.set(erasures, erasurePtr);
    const erasureStarted = performance.now();
    const erasureLength = zx._decodeModuleGridErasures(
      gridPtr, erasurePtr, dim, outPtr, outCapacity
    );
    const erasureMs = performance.now() - erasureStarted;
    const repaired = erasureLength > 0
      ? zx.HEAPU8.slice(outPtr, outPtr + erasureLength)
      : new Uint8Array();

    zx._free(gridPtr);
    zx._free(erasurePtr);
    zx._free(outPtr);

    if (erasureLength !== packet.length)
      throw new Error(`erasure grid decode length ${erasureLength}, expected ${packet.length}`);
    if (!repaired.every((value, index) => value === packet[index]))
      throw new Error("erasure grid decode returned wrong bytes");
    const repairedParsed = parseFrame(repaired);
    if (!repairedParsed || repairedParsed.header.seq !== 123 || repairedParsed.header.payloadId !== payloadId)
      throw new Error("erasure grid decode failed AirGapper CRC/header verification");

    return {
      dim,
      bytes: actual.length,
      decodeMs,
      erasureMs,
      erasedRows: bandBottom - bandTop,
      seq: parsed.header.seq
    };
  });
  console.log("AIRGAPPER_TEMPORAL_DIRECT_GRID_PASS", JSON.stringify(result));
} finally {
  await browser.close();
}
