import { splitmix32 } from './protocol.js';

const AIRGRID_BLOCK_SYNC = Uint8Array.from([1,1,1,0,1,0,0,0]);
const AIRGRID_BLOCK_CODE_BITS = 72;
const AIRGRID_BLOCK_DATA_BITS = 64;
const AIRGRID_BLOCK_MAX_CODEWORDS = 3;
const AIRGRID_BLOCK_SEQUENCE_MASK = 0x0fff;

function crc12(bytes, sequence, laneIndex, blockIndex) {
  let crc = 0xfff;
  const feedByte = value => {
    for (let bit = 7; bit >= 0; bit--) {
      const input = (value >>> bit) & 1;
      const top = (crc >>> 11) & 1;
      crc = (crc << 1) & 0xfff;
      if (top ^ input) crc ^= 0x80f;
    }
  };
  feedByte(sequence & 255);
  feedByte(sequence >>> 8 & 15);
  feedByte(laneIndex & 255);
  feedByte(laneIndex >>> 8 & 255);
  feedByte(blockIndex & 255);
  feedByte(blockIndex >>> 8 & 255);
  for (const value of bytes) feedByte(value);
  return crc & 0xfff;
}

function byteBits(bytes) {
  const out = new Uint8Array(bytes.length * 8);
  let at = 0;
  for (const value of bytes) for (let bit = 7; bit >= 0; bit--) out[at++] = value >>> bit & 1;
  return out;
}
function bitsBytes(bits) {
  const out = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < out.length; i++) {
    let value = 0;
    for (let bit = 0; bit < 8; bit++) value = value << 1 | bits[i * 8 + bit] & 1;
    out[i] = value;
  }
  return out;
}

function encodeHamming72(data8) {
  if (!(data8 instanceof Uint8Array) || data8.length !== 8) throw new Error('Hamming72 expects 8 bytes');
  const dataBits = byteBits(data8);
  const out = new Uint8Array(AIRGRID_BLOCK_CODE_BITS);
  let dataAt = 0;
  for (let pos = 1; pos <= 71; pos++) {
    if ((pos & (pos - 1)) === 0) continue;
    out[pos - 1] = dataBits[dataAt++];
  }
  for (let parityPos = 1; parityPos <= 64; parityPos <<= 1) {
    let parity = 0;
    for (let pos = 1; pos <= 71; pos++) if ((pos & parityPos) && pos !== parityPos) parity ^= out[pos - 1];
    out[parityPos - 1] = parity;
  }
  let overall = 0;
  for (let i = 0; i < 71; i++) overall ^= out[i];
  out[71] = overall;
  return out;
}

function decodeHamming72(bits72) {
  if (!(bits72 instanceof Uint8Array) || bits72.length !== 72) return { ok:false, reason:'length' };
  const bits = Uint8Array.from(bits72);
  let syndrome = 0;
  for (let parityPos = 1; parityPos <= 64; parityPos <<= 1) {
    let parity = 0;
    for (let pos = 1; pos <= 71; pos++) if (pos & parityPos) parity ^= bits[pos - 1];
    if (parity) syndrome |= parityPos;
  }
  let overall = 0;
  for (let i = 0; i < 72; i++) overall ^= bits[i];
  let corrected = 0;
  if (syndrome) {
    if (!overall || syndrome > 71) return { ok:false, reason:'double', syndrome };
    bits[syndrome - 1] ^= 1;
    corrected = 1;
  } else if (overall) {
    bits[71] ^= 1;
    corrected = 1;
  }
  const dataBits = new Uint8Array(AIRGRID_BLOCK_DATA_BITS);
  let at = 0;
  for (let pos = 1; pos <= 71; pos++) {
    if ((pos & (pos - 1)) === 0) continue;
    dataBits[at++] = bits[pos - 1];
  }
  return { ok:true, bytes:bitsBytes(dataBits), corrected };
}

function blockCells(codewords) {
  return AIRGRID_BLOCK_SYNC.length + codewords * AIRGRID_BLOCK_CODE_BITS;
}
function blockPayloadBytes(codewords) {
  return codewords * 8 - 3;
}

function airGridBlockLayout(columns) {
  const result = [];
  let start = 0;
  let remaining = Math.max(0, Math.floor(columns));
  let blockIndex = 0;
  while (remaining >= blockCells(1)) {
    let codewords = AIRGRID_BLOCK_MAX_CODEWORDS;
    while (codewords > 1 && remaining < blockCells(codewords)) codewords--;
    const cells = blockCells(codewords);
    result.push({ blockIndex, start, cells, codewords, payloadBytes:blockPayloadBytes(codewords) });
    start += cells;
    remaining -= cells;
    blockIndex++;
  }
  return result;
}

function airGridBlockProfile({ projectedWidth, projectedHeight, cellPx = 3 }) {
  const pitch = Math.max(1.5, Number(cellPx) || 3);
  const columns = Math.floor(projectedWidth / pitch);
  const lanes = Math.floor(projectedHeight / pitch);
  return airGridBlockProfileFromGrid(columns, lanes, pitch);
}
function airGridBlockProfileFromGrid(columns, lanes, cellPx = null) {
  const layout = airGridBlockLayout(columns);
  if (lanes < 8 || !layout.length) return null;
  const payloadBytesPerLane = layout.reduce((sum, block) => sum + block.payloadBytes, 0);
  return {
    modulation:'binary',
    blockMode:true,
    bitsPerCell:1,
    cellPx,
    columns,
    lanes,
    layout,
    blocksPerLane:layout.length,
    payloadBytesPerLane,
    payloadBytes:payloadBytesPerLane,
    capacityBytes:payloadBytesPerLane * lanes
  };
}

function makeAirGridBlockPayload(payloadBytes, payloadId, sequence, laneIndex, blockIndex) {
  const seed = (payloadId ^ Math.imul((sequence & AIRGRID_BLOCK_SEQUENCE_MASK) + 1, 0x9e3779b1) ^ Math.imul(laneIndex + 1, 0x85ebca6b) ^ Math.imul(blockIndex + 1, 0xc2b2ae35)) >>> 0;
  const random = splitmix32(seed);
  const out = new Uint8Array(payloadBytes);
  for (let i = 0; i < out.length; i++) out[i] = random() & 255;
  return out;
}

function encodeAirGridBlock({ codewords, sequence, laneIndex, blockIndex, payload }) {
  const payloadBytes = blockPayloadBytes(codewords);
  if (!(payload instanceof Uint8Array) || payload.length !== payloadBytes) throw new Error(`block payload must be ${payloadBytes} bytes`);
  const seq = sequence & AIRGRID_BLOCK_SEQUENCE_MASK;
  const checksum = crc12(payload, seq, laneIndex, blockIndex);
  const packet = new Uint8Array(codewords * 8);
  packet[0] = seq & 255;
  packet[1] = (seq >>> 8 & 15) | (checksum & 15) << 4;
  packet[2] = checksum >>> 4 & 255;
  packet.set(payload, 3);
  const bits = new Uint8Array(blockCells(codewords));
  bits.set(AIRGRID_BLOCK_SYNC, 0);
  for (let cw = 0; cw < codewords; cw++) bits.set(encodeHamming72(packet.subarray(cw * 8, cw * 8 + 8)), AIRGRID_BLOCK_SYNC.length + cw * 72);
  return bits;
}

function decodeAirGridBlockBits(bits, { codewords, laneIndex, blockIndex } = {}) {
  if (!(bits instanceof Uint8Array)) bits = Uint8Array.from(bits ?? []);
  if (bits.length !== blockCells(codewords)) return { ok:false, reason:'length', corrected:0 };
  let syncErrors = 0;
  for (let i = 0; i < AIRGRID_BLOCK_SYNC.length; i++) syncErrors += Number(bits[i] !== AIRGRID_BLOCK_SYNC[i]);
  if (syncErrors > 2) return { ok:false, reason:'sync', syncErrors, corrected:0 };
  const packet = new Uint8Array(codewords * 8);
  let corrected = 0;
  for (let cw = 0; cw < codewords; cw++) {
    const decoded = decodeHamming72(bits.subarray(AIRGRID_BLOCK_SYNC.length + cw * 72, AIRGRID_BLOCK_SYNC.length + (cw + 1) * 72));
    if (!decoded.ok) return { ok:false, reason:'hamming', syncErrors, corrected, codeword:cw };
    packet.set(decoded.bytes, cw * 8);
    corrected += decoded.corrected;
  }
  const sequence = packet[0] | (packet[1] & 15) << 8;
  const expected = packet[1] >>> 4 | packet[2] << 4;
  const payload = packet.slice(3);
  const actual = crc12(payload, sequence, laneIndex, blockIndex);
  if (expected !== actual) return { ok:false, reason:'crc', syncErrors, corrected, expected, actual };
  return { ok:true, syncErrors, corrected, block:{ sequence, laneIndex, blockIndex, payload } };
}

function buildAirGridBlockState({ profile, payloadId, sequence }) {
  const lanes = new Array(profile.lanes);
  for (let laneIndex = 0; laneIndex < profile.lanes; laneIndex++) {
    const row = new Uint8Array(profile.columns);
    let fillerAt = 0;
    for (const block of profile.layout) {
      const payload = makeAirGridBlockPayload(block.payloadBytes, payloadId, sequence, laneIndex, block.blockIndex);
      row.set(encodeAirGridBlock({ codewords:block.codewords, sequence, laneIndex, blockIndex:block.blockIndex, payload }), block.start);
      fillerAt = block.start + block.cells;
    }
    for (let x = fillerAt; x < row.length; x++) row[x] = (x + laneIndex + sequence) & 1;
    lanes[laneIndex] = row;
  }
  return { sequence:sequence & AIRGRID_BLOCK_SEQUENCE_MASK, modulation:'binary', levels:null, lanes };
}

export {
  AIRGRID_BLOCK_CODE_BITS,
  AIRGRID_BLOCK_DATA_BITS,
  AIRGRID_BLOCK_SEQUENCE_MASK,
  AIRGRID_BLOCK_SYNC,
  airGridBlockLayout,
  airGridBlockProfile,
  airGridBlockProfileFromGrid,
  blockCells as airGridBlockCells,
  blockPayloadBytes as airGridBlockPayloadBytes,
  buildAirGridBlockState,
  decodeAirGridBlockBits,
  decodeHamming72,
  encodeAirGridBlock,
  encodeHamming72,
  makeAirGridBlockPayload
};