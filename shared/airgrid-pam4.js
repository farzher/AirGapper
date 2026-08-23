import { airGridCrc16 } from './airgrid-phy.js';

const AIRGRID_PAM4_VERSION = 2;
const AIRGRID_PAM4_MAGIC = 0xa8;
const AIRGRID_PAM4_HEADER_BYTES = 9;
const AIRGRID_PAM4_CRC_BITS = 16;
const AIRGRID_PAM4_MIN_PAYLOAD_BYTES = 8;
const AIRGRID_PAM4_MAX_SEQUENCE = 0xffffff;
// Four training symbols of every level, deliberately scrambled so the
// calibration rail also exercises rapid adjacent-level transitions.
const AIRGRID_PAM4_PREAMBLE = Uint8Array.from([
  0, 3, 1, 2, 3, 0, 2, 1,
  1, 2, 0, 3, 2, 1, 3, 0
]);
// Canvas values are sRGB code values. These are chosen so a normal sRGB-like
// display produces roughly spaced physical luminances while retaining full
// dark/bright anchors. The receiver never assumes these numeric spacings: it
// learns all four camera-domain cluster centers independently in every lane.
const AIRGRID_PAM4_LEVELS = Uint8Array.from([0, 156, 213, 255]);
const BITS_TO_GRAY_SYMBOL = Uint8Array.from([0, 1, 3, 2]); // 00,01,10,11 -> 0,1,3,2
const GRAY_SYMBOL_TO_BITS = Uint8Array.from([0b00, 0b01, 0b11, 0b10]);

function write24(out, offset, value) {
  out[offset] = value & 255;
  out[offset + 1] = value >>> 8 & 255;
  out[offset + 2] = value >>> 16 & 255;
}
function read24(bytes, offset) {
  return bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16;
}
function bytesToBits(bytes, out, offset) {
  for (const value of bytes) for (let bit = 7; bit >= 0; bit--) out[offset++] = value >>> bit & 1;
  return offset;
}
function bitsToBytes(bits, offset, byteLength) {
  const out = new Uint8Array(byteLength);
  for (let index = 0; index < byteLength; index++) {
    let value = 0;
    for (let bit = 0; bit < 8; bit++) value = value << 1 | bits[offset++] & 1;
    out[index] = value;
  }
  return out;
}
function airGridPam4PayloadBytes(columns) {
  const usableBits = (columns - AIRGRID_PAM4_PREAMBLE.length) * 2 - AIRGRID_PAM4_HEADER_BYTES * 8 - AIRGRID_PAM4_CRC_BITS;
  return Math.floor(usableBits / 8);
}
function airGridPam4Profile({ projectedWidth, projectedHeight, cellPx = 4 }) {
  const pitch = Math.max(1.5, Number(cellPx) || 4);
  const columns = Math.floor(projectedWidth / pitch);
  const lanes = Math.floor(projectedHeight / pitch);
  const payloadBytes = airGridPam4PayloadBytes(columns);
  if (payloadBytes < AIRGRID_PAM4_MIN_PAYLOAD_BYTES || lanes < 8) return null;
  return { modulation: 'pam4', bitsPerCell: 2, cellPx: pitch, columns, lanes, payloadBytes };
}
function encodeAirGridPam4Lane({ columns, profile = 1, payloadId, sequence, laneIndex, payload }) {
  const payloadBytes = airGridPam4PayloadBytes(columns);
  if (payloadBytes < AIRGRID_PAM4_MIN_PAYLOAD_BYTES) throw new Error('AirGrid PAM4 lane is too narrow');
  if (!(payload instanceof Uint8Array) || payload.length !== payloadBytes) throw new Error(`AirGrid PAM4 payload must be ${payloadBytes} bytes`);
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > AIRGRID_PAM4_MAX_SEQUENCE) throw new Error('AirGrid PAM4 sequence exceeds 24 bits');
  if (!Number.isInteger(laneIndex) || laneIndex < 0 || laneIndex > 65535) throw new Error('AirGrid PAM4 lane index exceeds 16 bits');

  const packet = new Uint8Array(AIRGRID_PAM4_HEADER_BYTES + payload.length);
  packet[0] = AIRGRID_PAM4_MAGIC;
  packet[1] = (AIRGRID_PAM4_VERSION << 4) | (profile & 15);
  new DataView(packet.buffer).setUint32(2, payloadId >>> 0, true);
  write24(packet, 6, sequence);
  packet.set(payload, AIRGRID_PAM4_HEADER_BYTES);

  const dataBits = new Uint8Array(packet.length * 8 + AIRGRID_PAM4_CRC_BITS);
  let bitOffset = bytesToBits(packet, dataBits, 0);
  const checksum = airGridCrc16(packet, laneIndex);
  for (let bit = 15; bit >= 0; bit--) dataBits[bitOffset++] = checksum >>> bit & 1;

  const symbols = new Uint8Array(columns);
  symbols.set(AIRGRID_PAM4_PREAMBLE, 0);
  let symbol = AIRGRID_PAM4_PREAMBLE.length;
  for (let bit = 0; bit < dataBits.length; bit += 2) {
    const pair = (dataBits[bit] << 1) | dataBits[bit + 1];
    symbols[symbol++] = BITS_TO_GRAY_SYMBOL[pair];
  }
  // Keep transitions alive through any remainder without carrying data.
  const tail = AIRGRID_PAM4_PREAMBLE;
  for (; symbol < symbols.length; symbol++) symbols[symbol] = tail[(symbol + laneIndex + sequence) % tail.length];
  return symbols;
}
function pam4PreambleDistance(symbols) {
  let errors = 0;
  for (let i = 0; i < AIRGRID_PAM4_PREAMBLE.length; i++) errors += Number((symbols[i] & 3) !== AIRGRID_PAM4_PREAMBLE[i]);
  return errors;
}
function inspectAirGridPam4Lane(symbols, { laneIndex, maxPreambleErrors = 2 } = {}) {
  if (!(symbols instanceof Uint8Array)) symbols = Uint8Array.from(symbols ?? []);
  const minimumSymbols = AIRGRID_PAM4_PREAMBLE.length + Math.ceil((AIRGRID_PAM4_HEADER_BYTES * 8 + AIRGRID_PAM4_CRC_BITS) / 2);
  if (symbols.length < minimumSymbols) return { ok: false, reason: 'short', preambleErrors: AIRGRID_PAM4_PREAMBLE.length };
  const preambleErrors = pam4PreambleDistance(symbols);
  if (preambleErrors > maxPreambleErrors) return { ok: false, reason: 'preamble', preambleErrors };
  const payloadBytes = airGridPam4PayloadBytes(symbols.length);
  if (payloadBytes < AIRGRID_PAM4_MIN_PAYLOAD_BYTES) return { ok: false, reason: 'short', preambleErrors };

  const bitLength = (AIRGRID_PAM4_HEADER_BYTES + payloadBytes) * 8 + AIRGRID_PAM4_CRC_BITS;
  const bits = new Uint8Array(bitLength);
  let at = 0;
  for (let i = AIRGRID_PAM4_PREAMBLE.length; at < bitLength; i++) {
    const pair = GRAY_SYMBOL_TO_BITS[symbols[i] & 3];
    bits[at++] = pair >>> 1 & 1;
    if (at < bitLength) bits[at++] = pair & 1;
  }
  const packet = bitsToBytes(bits, 0, AIRGRID_PAM4_HEADER_BYTES + payloadBytes);
  if (packet[0] !== AIRGRID_PAM4_MAGIC) return { ok: false, reason: 'magic', preambleErrors };
  if (packet[1] >>> 4 !== AIRGRID_PAM4_VERSION) return { ok: false, reason: 'version', preambleErrors };
  let expected = 0;
  const crcOffset = packet.length * 8;
  for (let bit = 0; bit < AIRGRID_PAM4_CRC_BITS; bit++) expected = expected << 1 | bits[crcOffset + bit];
  const actual = airGridCrc16(packet, laneIndex);
  if (expected !== actual) return { ok: false, reason: 'crc', preambleErrors, expectedCrc: expected, actualCrc: actual };
  return {
    ok: true,
    reason: 'ok',
    preambleErrors,
    lane: {
      version: packet[1] >>> 4,
      profile: packet[1] & 15,
      modulation: 'pam4',
      payloadId: new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint32(2, true),
      sequence: read24(packet, 6),
      laneIndex,
      payload: packet.slice(AIRGRID_PAM4_HEADER_BYTES)
    }
  };
}
function decodeAirGridPam4Lane(symbols, options = {}) {
  const inspected = inspectAirGridPam4Lane(symbols, options);
  return inspected.ok ? inspected.lane : null;
}

export {
  AIRGRID_PAM4_CRC_BITS,
  AIRGRID_PAM4_HEADER_BYTES,
  AIRGRID_PAM4_LEVELS,
  AIRGRID_PAM4_MAGIC,
  AIRGRID_PAM4_PREAMBLE,
  AIRGRID_PAM4_VERSION,
  airGridPam4PayloadBytes,
  airGridPam4Profile,
  decodeAirGridPam4Lane,
  encodeAirGridPam4Lane,
  inspectAirGridPam4Lane,
  pam4PreambleDistance
};
