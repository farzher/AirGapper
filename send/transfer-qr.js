// AirGapper transfer frames always use standard QR-L, one byte segment,
// an explicit version, and mask 4. Keep this hot path independent from the
// general-purpose QR library so repeated pages reuse geometry and coding
// scratch instead of rebuilding identical QR structure hundreds of times/sec.

const TOTAL_CODEWORDS = new Uint16Array([
  0,
  26, 44, 70, 100, 134, 172, 196, 242, 292, 346,
  404, 466, 532, 581, 655, 733, 815, 901, 991, 1085,
  1156, 1258, 1364, 1474, 1588, 1706, 1828, 1921, 2051, 2185,
  2323, 2465, 2611, 2761, 2876, 3034, 3196, 3362, 3532, 3706
]);

const EC_CODEWORDS_L = new Uint16Array([
  0,
  7, 10, 15, 20, 26, 36, 40, 48, 60, 72,
  80, 96, 104, 120, 132, 144, 168, 180, 196, 224,
  224, 252, 270, 300, 312, 336, 360, 390, 420, 450,
  480, 510, 540, 570, 570, 600, 630, 660, 720, 750
]);

const EC_BLOCKS_L = new Uint8Array([
  0,
  1, 1, 1, 1, 1, 2, 2, 2, 2, 4,
  4, 4, 4, 4, 6, 6, 6, 6, 7, 8,
  8, 9, 9, 10, 12, 12, 12, 13, 14, 15,
  16, 17, 18, 19, 19, 20, 21, 22, 24, 25
]);

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let value = 1;
  for (let i = 0; i < 255; ++i) {
    GF_EXP[i] = value;
    GF_LOG[value] = i;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let i = 255; i < GF_EXP.length; ++i) GF_EXP[i] = GF_EXP[i - 255];
}

// RS encoding performs many repeated GF multiplications. One 64 KiB table per
// render worker replaces two logarithm lookups plus an exponent lookup in the
// inner parity loop. This is sender-only scratch and stays fixed for the worker.
const GF_MUL = new Uint8Array(256 * 256);
for (let a = 1; a < 256; ++a) {
  const logA = GF_LOG[a];
  const row = a << 8;
  for (let b = 1; b < 256; ++b) GF_MUL[row | b] = GF_EXP[logA + GF_LOG[b]];
}

const generatorCache = new Map();
const templateCache = new Map();

function gfMul(a, b) {
  return GF_MUL[a << 8 | b];
}

function generatorPolynomial(degree) {
  let cached = generatorCache.get(degree);
  if (cached) return cached;
  let poly = new Uint8Array([1]);
  for (let root = 0; root < degree; ++root) {
    const next = new Uint8Array(poly.length + 1);
    const factor = GF_EXP[root];
    for (let i = 0; i < poly.length; ++i) {
      next[i] ^= poly[i];
      next[i + 1] ^= gfMul(poly[i], factor);
    }
    poly = next;
  }
  generatorCache.set(degree, poly);
  return poly;
}

function bchDigit(value) {
  let digits = 0;
  while (value !== 0) {
    ++digits;
    value >>>= 1;
  }
  return digits;
}

function versionBits(version) {
  const polynomial = 0x1f25;
  const polynomialBits = bchDigit(polynomial);
  let remainder = version << 12;
  while (bchDigit(remainder) - polynomialBits >= 0)
    remainder ^= polynomial << (bchDigit(remainder) - polynomialBits);
  return version << 12 | remainder;
}

function formatBits() {
  // QR-L has EC level bits 01; AirGapper transfer QRs always use mask 4.
  const data = (1 << 3) | 4;
  const polynomial = 0x537;
  const polynomialBits = bchDigit(polynomial);
  let remainder = data << 10;
  while (bchDigit(remainder) - polynomialBits >= 0)
    remainder ^= polynomial << (bchDigit(remainder) - polynomialBits);
  return (data << 10 | remainder) ^ 0x5412;
}

function setReserved(modules, reserved, size, row, col, value) {
  const index = row * size + col;
  modules[index] = value ? 1 : 0;
  reserved[index] = 1;
}

function setupFinderPatterns(modules, reserved, size) {
  const origins = [[0, 0], [size - 7, 0], [0, size - 7]];
  for (const [row, col] of origins) {
    for (let r = -1; r <= 7; ++r) {
      if (row + r < 0 || row + r >= size) continue;
      for (let c = -1; c <= 7; ++c) {
        if (col + c < 0 || col + c >= size) continue;
        const dark =
          r >= 0 && r <= 6 && (c === 0 || c === 6) ||
          c >= 0 && c <= 6 && (r === 0 || r === 6) ||
          r >= 2 && r <= 4 && c >= 2 && c <= 4;
        setReserved(modules, reserved, size, row + r, col + c, dark);
      }
    }
  }
}

function setupTimingPatterns(modules, reserved, size) {
  for (let i = 8; i < size - 8; ++i) {
    const dark = (i & 1) === 0;
    setReserved(modules, reserved, size, i, 6, dark);
    setReserved(modules, reserved, size, 6, i, dark);
  }
}

function alignmentPositions(version, size) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const interval = size === 145 ? 26 : Math.ceil((size - 13) / (2 * count - 2)) * 2;
  const positions = [size - 7];
  for (let i = 1; i < count - 1; ++i) positions.push(positions[i - 1] - interval);
  positions.push(6);
  positions.reverse();
  return positions;
}

function setupAlignmentPatterns(modules, reserved, version, size) {
  const positions = alignmentPositions(version, size);
  const last = positions.length - 1;
  for (let y = 0; y < positions.length; ++y) {
    for (let x = 0; x < positions.length; ++x) {
      if ((y === 0 && x === 0) || (y === 0 && x === last) || (y === last && x === 0)) continue;
      const row = positions[y];
      const col = positions[x];
      for (let r = -2; r <= 2; ++r) {
        for (let c = -2; c <= 2; ++c) {
          const dark = r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0);
          setReserved(modules, reserved, size, row + r, col + c, dark);
        }
      }
    }
  }
}

function setupVersionInfo(modules, reserved, version, size) {
  if (version < 7) return;
  const bits = versionBits(version);
  for (let i = 0; i < 18; ++i) {
    const row = Math.floor(i / 3);
    const col = i % 3 + size - 11;
    const dark = ((bits >>> i) & 1) !== 0;
    setReserved(modules, reserved, size, row, col, dark);
    setReserved(modules, reserved, size, col, row, dark);
  }
}

function setupFormatInfo(modules, reserved, size) {
  const bits = formatBits();
  for (let i = 0; i < 15; ++i) {
    const dark = ((bits >>> i) & 1) !== 0;
    if (i < 6) setReserved(modules, reserved, size, i, 8, dark);
    else if (i < 8) setReserved(modules, reserved, size, i + 1, 8, dark);
    else setReserved(modules, reserved, size, size - 15 + i, 8, dark);

    if (i < 8) setReserved(modules, reserved, size, 8, size - i - 1, dark);
    else if (i < 9) setReserved(modules, reserved, size, 8, 15 - i, dark);
    else setReserved(modules, reserved, size, 8, 15 - i - 1, dark);
  }
  setReserved(modules, reserved, size, size - 8, 8, true);
}

function buildDataTraversal(reserved, size) {
  const positions = [];
  const masks = [];
  let row = size - 1;
  let direction = -1;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) --col;
    while (true) {
      for (let c = 0; c < 2; ++c) {
        const actualCol = col - c;
        const index = row * size + actualCol;
        if (!reserved[index]) {
          positions.push(index);
          masks.push(((Math.floor(row / 2) + Math.floor(actualCol / 3)) & 1) === 0 ? 1 : 0);
        }
      }
      row += direction;
      if (row < 0 || row >= size) {
        row -= direction;
        direction = -direction;
        break;
      }
    }
  }
  return {
    positions: Uint32Array.from(positions),
    masks: Uint8Array.from(masks)
  };
}

function buildTemplate(version) {
  if (!Number.isInteger(version) || version < 1 || version > 40) throw new Error("Invalid transfer QR version");
  const size = 17 + version * 4;
  const modules = new Uint8Array(size * size);
  const reserved = new Uint8Array(size * size);
  setupFinderPatterns(modules, reserved, size);
  setupTimingPatterns(modules, reserved, size);
  setupAlignmentPatterns(modules, reserved, version, size);
  setupFormatInfo(modules, reserved, size);
  setupVersionInfo(modules, reserved, version, size);
  const staticModules = modules.slice();

  const totalCodewords = TOTAL_CODEWORDS[version];
  const ecTotalCodewords = EC_CODEWORDS_L[version];
  const dataTotalCodewords = totalCodewords - ecTotalCodewords;
  const blockCount = EC_BLOCKS_L[version];
  const group2 = totalCodewords % blockCount;
  const group1 = blockCount - group2;
  const totalInGroup1 = Math.floor(totalCodewords / blockCount);
  const dataInGroup1 = Math.floor(dataTotalCodewords / blockCount);
  const dataInGroup2 = dataInGroup1 + 1;
  const ecPerBlock = totalInGroup1 - dataInGroup1;
  const blockOffsets = new Uint16Array(blockCount);
  const blockSizes = new Uint16Array(blockCount);
  let offset = 0;
  let maxDataBlock = 0;
  for (let block = 0; block < blockCount; ++block) {
    const length = block < group1 ? dataInGroup1 : dataInGroup2;
    blockOffsets[block] = offset;
    blockSizes[block] = length;
    offset += length;
    if (length > maxDataBlock) maxDataBlock = length;
  }
  if (offset !== dataTotalCodewords) throw new Error("Invalid QR-L block layout");

  const traversal = buildDataTraversal(reserved, size);
  if (traversal.positions.length < totalCodewords * 8) throw new Error("Invalid QR data traversal");

  return {
    version,
    size,
    modules,
    staticModules,
    positions: traversal.positions,
    masks: traversal.masks,
    rasterLayouts: new Map(),
    totalCodewords,
    dataTotalCodewords,
    blockCount,
    blockOffsets,
    blockSizes,
    maxDataBlock,
    ecPerBlock,
    generator: generatorPolynomial(ecPerBlock),
    dataBytes: new Uint8Array(dataTotalCodewords),
    codewords: new Uint8Array(totalCodewords),
    parity: new Uint8Array(blockCount * ecPerBlock),
    rsScratch: new Uint8Array(maxDataBlock + ecPerBlock)
  };
}

function templateFor(version) {
  let template = templateCache.get(version);
  if (!template) {
    template = buildTemplate(version);
    templateCache.set(version, template);
  }
  return template;
}

function transferQrRasterLayout(version, rasterWidth) {
  const template = templateFor(version);
  let layout = template.rasterLayouts.get(rasterWidth);
  if (layout) return layout;
  const offsets = new Uint32Array(template.positions.length);
  for (let i = 0; i < offsets.length; ++i) {
    const position = template.positions[i];
    const row = Math.floor(position / template.size);
    offsets[i] = row * rasterWidth + position - row * template.size;
  }
  layout = {
    template,
    offsets
  };
  template.rasterLayouts.set(rasterWidth, layout);
  return layout;
}

function putBits(out, bitOffset, value, width) {
  for (let bit = width - 1; bit >= 0; --bit) {
    if ((value >>> bit) & 1) out[bitOffset >>> 3] |= 0x80 >>> (bitOffset & 7);
    ++bitOffset;
  }
  return bitOffset;
}

function putBytes(out, bitOffset, bytes) {
  const used = bitOffset & 7;
  let dst = bitOffset >>> 3;
  if (used === 0) {
    out.set(bytes, dst);
    return bitOffset + bytes.length * 8;
  }
  for (let i = 0; i < bytes.length; ++i) {
    const value = bytes[i];
    out[dst] |= value >>> used;
    out[++dst] = (value << (8 - used)) & 0xff;
  }
  return bitOffset + bytes.length * 8;
}

function buildDataBytes(template, payload) {
  const out = template.dataBytes;
  out.fill(0);
  const countBits = template.version < 10 ? 8 : 16;
  const capacityBits = out.length * 8;
  const requiredBits = 4 + countBits + payload.length * 8;
  if (requiredBits > capacityBits) throw new Error("Transfer frame exceeds QR-L capacity");

  let bit = putBits(out, 0, 4, 4); // byte mode
  bit = putBits(out, bit, payload.length, countBits);
  bit = putBytes(out, bit, payload);
  bit += Math.min(4, capacityBits - bit); // zero terminator
  bit = Math.min(capacityBits, (bit + 7) & ~7); // zero byte alignment
  let pad = 0;
  while (bit < capacityBits) {
    out[bit >>> 3] = pad++ & 1 ? 0x11 : 0xec;
    bit += 8;
  }
}

function encodeParity(template, dataOffset, dataLength, parityOffset) {
  const scratch = template.rsScratch;
  const used = dataLength + template.ecPerBlock;
  scratch.fill(0, 0, used);
  for (let i = 0; i < dataLength; ++i) scratch[i] = template.dataBytes[dataOffset + i];
  const generator = template.generator;
  for (let i = 0; i < dataLength; ++i) {
    const factor = scratch[i];
    if (factor === 0) continue;
    const mulRow = factor << 8;
    for (let j = 0; j < generator.length; ++j)
      scratch[i + j] ^= GF_MUL[mulRow | generator[j]];
  }
  for (let i = 0; i < template.ecPerBlock; ++i)
    template.parity[parityOffset + i] = scratch[dataLength + i];
}

function buildCodewords(template) {
  for (let block = 0; block < template.blockCount; ++block) {
    encodeParity(
      template,
      template.blockOffsets[block],
      template.blockSizes[block],
      block * template.ecPerBlock
    );
  }

  let out = 0;
  for (let i = 0; i < template.maxDataBlock; ++i) {
    for (let block = 0; block < template.blockCount; ++block) {
      if (i < template.blockSizes[block])
        template.codewords[out++] = template.dataBytes[template.blockOffsets[block] + i];
    }
  }
  for (let i = 0; i < template.ecPerBlock; ++i) {
    for (let block = 0; block < template.blockCount; ++block)
      template.codewords[out++] = template.parity[block * template.ecPerBlock + i];
  }
  if (out !== template.totalCodewords) throw new Error("Invalid QR codeword interleave");
}

function writeMaskedModules(template) {
  const codewords = template.codewords;
  const dataBits = codewords.length * 8;
  for (let i = 0; i < template.positions.length; ++i) {
    const bit = i < dataBits ? (codewords[i >>> 3] >>> (7 - (i & 7))) & 1 : 0;
    template.modules[template.positions[i]] = bit ^ template.masks[i];
  }
}

function encodeTransferQr(payload, version) {
  if (!(payload instanceof Uint8Array)) payload = new Uint8Array(payload);
  const template = templateFor(version);
  buildDataBytes(template, payload);
  buildCodewords(template);
  writeMaskedModules(template);
  return template;
}

export { encodeTransferQr, transferQrRasterLayout };
