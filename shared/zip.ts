// Minimal ZIP writer for sending several selected files as one broadly
// supported download. Entries are stored (not recompressed); packFile may
// still gzip the finished archive when that is worthwhile.

const encoder = new TextEncoder();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}
function u32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

export function makeZip(entries: readonly ZipEntry[]): Uint8Array {
  const prepared = entries.map((entry) => {
    const name = encoder.encode(entry.name.replaceAll("\\", "/").replace(/^\/+/, "") || "file");
    return { ...entry, name, crc: crc32(entry.bytes) };
  });
  const localSize = prepared.reduce((sum, entry) => sum + 30 + entry.name.length + entry.bytes.length, 0);
  const centralSize = prepared.reduce((sum, entry) => sum + 46 + entry.name.length, 0);
  const output = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(output.buffer);
  let offset = 0;
  const localOffsets: number[] = [];

  for (const entry of prepared) {
    localOffsets.push(offset);
    u32(view, offset, 0x04034b50);
    u16(view, offset + 4, 20);
    u16(view, offset + 6, 0x0800); // UTF-8 names
    u16(view, offset + 8, 0); // stored
    u32(view, offset + 10, 0); // deterministic DOS time/date
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
    u32(view, offset, 0x02014b50);
    u16(view, offset + 4, 20);
    u16(view, offset + 6, 20);
    u16(view, offset + 8, 0x0800);
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
    u32(view, offset + 42, localOffsets[index]!);
    output.set(entry.name, offset + 46);
    offset += 46 + entry.name.length;
  });

  u32(view, offset, 0x06054b50);
  u16(view, offset + 4, 0);
  u16(view, offset + 6, 0);
  u16(view, offset + 8, prepared.length);
  u16(view, offset + 10, prepared.length);
  u32(view, offset + 12, centralSize);
  u32(view, offset + 16, centralOffset);
  u16(view, offset + 20, 0);
  return output;
}
