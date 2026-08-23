import { splitmix32 } from './protocol.js';

const AIRGRID_VERSION = 1;
const AIRGRID_MAGIC = 0xa7;
const AIRGRID_PREAMBLE = Uint8Array.from([
  1, 1, 1, 0, 1, 0, 0, 1,
  0, 0, 0, 1, 1, 0, 1, 0
]);
const AIRGRID_HEADER_BYTES = 9;
const AIRGRID_CRC_BITS = 16;
const AIRGRID_MIN_PAYLOAD_BYTES = 8;
const AIRGRID_MAX_SEQUENCE = 0xffffff;

function crc16(bytes, laneIndex = 0) {
  let crc = 0xffff;
  const feed = (value) => {
    crc ^= value << 8;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 0x8000) ? (crc << 1 ^ 0x1021) & 0xffff : crc << 1 & 0xffff;
  };
  feed(laneIndex & 255);
  feed(laneIndex >>> 8 & 255);
  for (const value of bytes) feed(value);
  return crc & 0xffff;
}

function write24(out, offset, value) {
  out[offset] = value & 255;
  out[offset + 1] = value >>> 8 & 255;
  out[offset + 2] = value >>> 16 & 255;
}
function read24(bytes, offset) {
  return bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16;
}
function bytesToBits(bytes, out, offset) {
  for (const value of bytes) {
    for (let bit = 7; bit >= 0; bit--) out[offset++] = value >>> bit & 1;
  }
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
function airGridPayloadBytes(columns) {
  const usableBits = columns - AIRGRID_PREAMBLE.length - AIRGRID_HEADER_BYTES * 8 - AIRGRID_CRC_BITS;
  return Math.floor(usableBits / 8);
}
function airGridProfile({ projectedWidth, projectedHeight, cellPx = 4 }) {
  const pitch = Math.max(2, Number(cellPx) || 4);
  const columns = Math.floor(projectedWidth / pitch);
  const lanes = Math.floor(projectedHeight / pitch);
  const payloadBytes = airGridPayloadBytes(columns);
  if (payloadBytes < AIRGRID_MIN_PAYLOAD_BYTES || lanes < 8) return null;
  return { cellPx: pitch, columns, lanes, payloadBytes };
}
function encodeAirGridLane({ columns, profile = 0, payloadId, sequence, laneIndex, payload }) {
  const payloadBytes = airGridPayloadBytes(columns);
  if (payloadBytes < AIRGRID_MIN_PAYLOAD_BYTES) throw new Error('AirGrid lane is too narrow');
  if (!(payload instanceof Uint8Array) || payload.length !== payloadBytes) throw new Error(`AirGrid payload must be ${payloadBytes} bytes`);
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > AIRGRID_MAX_SEQUENCE) throw new Error('AirGrid sequence exceeds 24 bits');
  if (!Number.isInteger(laneIndex) || laneIndex < 0 || laneIndex > 65535) throw new Error('AirGrid lane index exceeds 16 bits');
  const packet = new Uint8Array(AIRGRID_HEADER_BYTES + payload.length);
  packet[0] = AIRGRID_MAGIC;
  packet[1] = (AIRGRID_VERSION << 4) | (profile & 15);
  new DataView(packet.buffer).setUint32(2, payloadId >>> 0, true);
  write24(packet, 6, sequence);
  packet.set(payload, AIRGRID_HEADER_BYTES);
  const bits = new Uint8Array(columns);
  bits.set(AIRGRID_PREAMBLE, 0);
  let offset = bytesToBits(packet, bits, AIRGRID_PREAMBLE.length);
  const checksum = crc16(packet, laneIndex);
  bits[offset++] = checksum >>> 15 & 1;
  bits[offset++] = checksum >>> 14 & 1;
  bits[offset++] = checksum >>> 13 & 1;
  bits[offset++] = checksum >>> 12 & 1;
  bits[offset++] = checksum >>> 11 & 1;
  bits[offset++] = checksum >>> 10 & 1;
  bits[offset++] = checksum >>> 9 & 1;
  bits[offset++] = checksum >>> 8 & 1;
  bits[offset++] = checksum >>> 7 & 1;
  bits[offset++] = checksum >>> 6 & 1;
  bits[offset++] = checksum >>> 5 & 1;
  bits[offset++] = checksum >>> 4 & 1;
  bits[offset++] = checksum >>> 3 & 1;
  bits[offset++] = checksum >>> 2 & 1;
  bits[offset++] = checksum >>> 1 & 1;
  bits[offset++] = checksum & 1;
  // Fill sub-byte tail cells with a deterministic balanced pattern so every
  // rendered lane keeps transitions all the way to the right edge.
  for (; offset < bits.length; offset++) bits[offset] = (offset + laneIndex + sequence) & 1;
  return bits;
}
function preambleDistance(bits, offset = 0) {
  let distance = 0;
  for (let i = 0; i < AIRGRID_PREAMBLE.length; i++) distance += Number((bits[offset + i] & 1) !== AIRGRID_PREAMBLE[i]);
  return distance;
}
function decodeAirGridLane(bits, { laneIndex, maxPreambleErrors = 2 } = {}) {
  if (!(bits instanceof Uint8Array)) bits = Uint8Array.from(bits ?? []);
  if (bits.length < AIRGRID_PREAMBLE.length + AIRGRID_HEADER_BYTES * 8 + AIRGRID_CRC_BITS) return null;
  if (preambleDistance(bits) > maxPreambleErrors) return null;
  const payloadBytes = airGridPayloadBytes(bits.length);
  if (payloadBytes < AIRGRID_MIN_PAYLOAD_BYTES) return null;
  const packet = bitsToBytes(bits, AIRGRID_PREAMBLE.length, AIRGRID_HEADER_BYTES + payloadBytes);
  if (packet[0] !== AIRGRID_MAGIC || packet[1] >>> 4 !== AIRGRID_VERSION) return null;
  const crcOffset = AIRGRID_PREAMBLE.length + packet.length * 8;
  let expected = 0;
  for (let i = 0; i < AIRGRID_CRC_BITS; i++) expected = expected << 1 | bits[crcOffset + i] & 1;
  if (expected !== crc16(packet, laneIndex)) return null;
  return {
    version: packet[1] >>> 4,
    profile: packet[1] & 15,
    payloadId: new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint32(2, true),
    sequence: read24(packet, 6),
    laneIndex,
    payload: packet.slice(AIRGRID_HEADER_BYTES)
  };
}
function makeAirGridPayload(payloadBytes, payloadId, sequence, laneIndex) {
  const random = splitmix32((payloadId ^ Math.imul(sequence + 1, 0x9e3779b1) ^ Math.imul(laneIndex + 1, 0x85ebca6b)) >>> 0);
  const payload = new Uint8Array(payloadBytes);
  for (let i = 0; i < payload.length; i++) payload[i] = random() & 255;
  return payload;
}

export {
  AIRGRID_CRC_BITS,
  AIRGRID_HEADER_BYTES,
  AIRGRID_MAGIC,
  AIRGRID_PREAMBLE,
  AIRGRID_VERSION,
  airGridPayloadBytes,
  airGridProfile,
  crc16 as airGridCrc16,
  decodeAirGridLane,
  encodeAirGridLane,
  makeAirGridPayload,
  preambleDistance
};
