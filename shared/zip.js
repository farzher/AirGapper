const encoder = new TextEncoder();
function crc32(bytes) {
  let crc = 4294967295;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ 3988292384 & -(crc & 1);
  }
  return (crc ^ 4294967295) >>> 0;
}
function u16(view, offset, value) {
  view.setUint16(offset, value, true);
}
function u32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}
function makeZip(entries) {
  const prepared = entries.map((entry) => {
    const name = encoder.encode(entry.name.replaceAll("\\", "/").replace(/^\/+/, "") || "file");
    return { ...entry, name, crc: crc32(entry.bytes) };
  });
  const localSize = prepared.reduce((sum, entry) => sum + 30 + entry.name.length + entry.bytes.length, 0);
  const centralSize = prepared.reduce((sum, entry) => sum + 46 + entry.name.length, 0);
  const output = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(output.buffer);
  let offset = 0;
  const localOffsets = [];
  for (const entry of prepared) {
    localOffsets.push(offset);
    u32(view, offset, 67324752);
    u16(view, offset + 4, 20);
    u16(view, offset + 6, 2048);
    u16(view, offset + 8, 0);
    u32(view, offset + 10, 0);
    u32(view, offset + 14, entry.crc);
    u32(view, offset + 18, entry.bytes.length);
    u32(view, offset + 22, entry.bytes.length);
    u16(view, offset + 26, entry.name.length);
    u16(view, offset + 28, 0);
    output.set(entry.name, offset + 30);
    output.set(entry.bytes, offset + 30 + entry.name.length);
    offset += 30 + entry.name.length + entry.bytes.length;
  }
  const centralOffset = offset;
  prepared.forEach((entry, index) => {
    u32(view, offset, 33639248);
    u16(view, offset + 4, 20);
    u16(view, offset + 6, 20);
    u16(view, offset + 8, 2048);
    u16(view, offset + 10, 0);
    u32(view, offset + 12, 0);
    u32(view, offset + 16, entry.crc);
    u32(view, offset + 20, entry.bytes.length);
    u32(view, offset + 24, entry.bytes.length);
    u16(view, offset + 28, entry.name.length);
    u16(view, offset + 30, 0);
    u16(view, offset + 32, 0);
    u16(view, offset + 34, 0);
    u16(view, offset + 36, 0);
    u32(view, offset + 38, 0);
    u32(view, offset + 42, localOffsets[index]);
    output.set(entry.name, offset + 46);
    offset += 46 + entry.name.length;
  });
  u32(view, offset, 101010256);
  u16(view, offset + 4, 0);
  u16(view, offset + 6, 0);
  u16(view, offset + 8, prepared.length);
  u16(view, offset + 10, prepared.length);
  u32(view, offset + 12, centralSize);
  u32(view, offset + 16, centralOffset);
  u16(view, offset + 20, 0);
  return output;
}
function readStoredZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16at = (offset2) => view.getUint16(offset2, true);
  const u32at = (offset2) => view.getUint32(offset2, true);
  const requireRange = (offset2, length) => {
    if (offset2 < 0 || length < 0 || offset2 + length > bytes.length) throw new Error("The received ZIP is incomplete.");
  };
  let eocd = -1;
  for (let offset2 = bytes.length - 22; offset2 >= Math.max(0, bytes.length - 65557); offset2--) {
    if (u32at(offset2) === 101010256) {
      eocd = offset2;
      break;
    }
  }
  if (eocd < 0) throw new Error("The received ZIP has no directory.");
  requireRange(eocd, 22);
  if (u16at(eocd + 4) !== 0 || u16at(eocd + 6) !== 0) throw new Error("Multi-disk ZIPs are not supported.");
  const count = u16at(eocd + 10);
  if (u16at(eocd + 8) !== count || count === 0) throw new Error("The received ZIP directory is invalid.");
  const centralSize = u32at(eocd + 12);
  const centralOffset = u32at(eocd + 16);
  requireRange(centralOffset, centralSize);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries = [];
  let offset = centralOffset;
  for (let index = 0; index < count; index++) {
    requireRange(offset, 46);
    if (u32at(offset) !== 33639248) throw new Error("The received ZIP directory is invalid.");
    const flags = u16at(offset + 8);
    const method = u16at(offset + 10);
    const expectedCrc = u32at(offset + 16);
    const compressedSize = u32at(offset + 20);
    const size = u32at(offset + 24);
    const nameLength = u16at(offset + 28);
    const extraLength = u16at(offset + 30);
    const commentLength = u16at(offset + 32);
    const localOffset = u32at(offset + 42);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    requireRange(offset, recordLength);
    if ((flags & 1) !== 0 || method !== 0 || compressedSize !== size) {
      throw new Error("The received ZIP uses an unsupported entry format.");
    }
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    requireRange(localOffset, 30);
    if (u32at(localOffset) !== 67324752) throw new Error("The received ZIP entry is invalid.");
    if ((u16at(localOffset + 6) & 1) !== 0 || u16at(localOffset + 8) !== method || u32at(localOffset + 18) !== compressedSize || u32at(localOffset + 22) !== size) {
      throw new Error("The received ZIP uses an unsupported entry format.");
    }
    const localNameLength = u16at(localOffset + 26);
    const localExtraLength = u16at(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    requireRange(dataOffset, size);
    const entryBytes = bytes.slice(dataOffset, dataOffset + size);
    if (crc32(entryBytes) !== expectedCrc) throw new Error(`ZIP entry ${name} failed its checksum.`);
    if (!name.endsWith("/")) entries.push({ name, bytes: entryBytes });
    offset += recordLength;
  }
  if (offset !== centralOffset + centralSize) throw new Error("The received ZIP directory length is invalid.");
  return entries;
}
export {
  makeZip,
  readStoredZip
};
