// Compact the green byte of an owned RGBA frame into the front of the same
// ArrayBuffer. AirGapper's QR sender is achromatic, so one channel is the exact
// luminance input the decoder wants; no RGB weighting is necessary.
//
// Pack four source pixels into one destination Uint32 word. This cuts the hot
// Safari/rVFC compaction loop to ~1/4 as many iterations and destination stores
// without allocating a second multi-megabyte frame. The forward overwrite is
// safe because destination word n is always before source words 4n..4n+3, and
// all four source words are loaded before the destination write.

const endianProbeWord = new Uint32Array(1);
endianProbeWord[0] = 0x01020304;
const LITTLE_ENDIAN = new Uint8Array(endianProbeWord.buffer)[0] === 0x04;
const GREEN_SHIFT = LITTLE_ENDIAN ? 8 : 16;

function greenByte(word) {
  return word >>> GREEN_SHIFT & 0xff;
}

function compactRgbaGreenInPlace(buffer, pixelCount) {
  if (!(buffer instanceof ArrayBuffer)) return null;
  const count = Math.max(0, Math.trunc(Number(pixelCount) || 0));
  if (!count || buffer.byteLength < count * 4) return null;

  const words = new Uint32Array(buffer, 0, count);
  const bytes = new Uint8Array(buffer);
  const groups = count >> 2;
  for (let group = 0; group < groups; group++) {
    const source = group << 2;
    // Load every source word before writing the compact destination word. The
    // first group aliases word zero; this ordering is what makes it safe.
    const g0 = greenByte(words[source]);
    const g1 = greenByte(words[source + 1]);
    const g2 = greenByte(words[source + 2]);
    const g3 = greenByte(words[source + 3]);
    words[group] = LITTLE_ENDIAN
      ? (g0 | g1 << 8 | g2 << 16 | g3 << 24) >>> 0
      : (g0 << 24 | g1 << 16 | g2 << 8 | g3) >>> 0;
  }

  // At most three pixels remain. Their source words are still far ahead of the
  // compact destination bytes, so scalar cleanup preserves the same overlap rule.
  for (let pixel = groups << 2; pixel < count; pixel++) {
    bytes[pixel] = greenByte(words[pixel]);
  }
  return bytes.subarray(0, count);
}

export { compactRgbaGreenInPlace };
