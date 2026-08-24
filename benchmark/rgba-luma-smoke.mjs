import { compactRgbaGreenInPlace } from "../receive/rgba-luma.js";

let seed = 0x6d2b79f5;
function randomByte() {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return seed >>> 24 & 255;
}

function verify(pixelCount) {
  const rgba = new Uint8Array(pixelCount * 4);
  const expected = new Uint8Array(pixelCount);
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const at = pixel * 4;
    rgba[at] = randomByte();
    rgba[at + 1] = randomByte();
    rgba[at + 2] = randomByte();
    rgba[at + 3] = randomByte();
    expected[pixel] = rgba[at + 1];
  }
  if (!compactRgbaGreenInPlace(rgba.buffer, pixelCount))
    throw new Error(`compaction rejected ${pixelCount} pixels`);
  const result = new Uint8Array(rgba.buffer, 0, pixelCount);
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    if (result[pixel] !== expected[pixel]) {
      throw new Error(`green mismatch at ${pixel}/${pixelCount}: ${result[pixel]} != ${expected[pixel]}`);
    }
  }
}

for (let count = 1; count <= 65; count++) verify(count);
for (const count of [127, 128, 129, 255, 256, 257, 1023, 1024, 1025, 160 * 120]) verify(count);
for (let trial = 0; trial < 100; trial++) verify(1 + (randomByte() * 37 + randomByte()) % 4096);

if (compactRgbaGreenInPlace(null, 10)) throw new Error("invalid buffer was accepted");
if (compactRgbaGreenInPlace(new ArrayBuffer(8), 3)) throw new Error("undersized buffer was accepted");

console.log("AIRGAPPER_RGBA_LUMA_PASS", JSON.stringify({ cases: 175 }));
