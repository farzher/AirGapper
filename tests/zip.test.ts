import assert from "node:assert/strict";
import test from "node:test";
import { makeZip, readStoredZip } from "../shared/zip.ts";

const encoder = new TextEncoder();

test("multi-file ZIP entries round-trip with Unicode names", () => {
  const entries = [
    { name: "photo one.jpg", bytes: new Uint8Array([0xff, 0xd8, 0xff]) },
    { name: "résumé.txt", bytes: encoder.encode("hello") },
  ];

  assert.deepEqual(readStoredZip(makeZip(entries)), entries);
});

test("ZIP entry checksum changes are rejected", () => {
  const archive = makeZip([{ name: "one.txt", bytes: encoder.encode("hello") }]);
  archive[31 + "one.txt".length] ^= 1;
  assert.throws(() => readStoredZip(archive), /checksum/);
});

test("compressed ZIP entries are rejected", () => {
  const archive = makeZip([{ name: "one.txt", bytes: encoder.encode("hello") }]);
  new DataView(archive.buffer).setUint16(8, 8, true);
  assert.throws(() => readStoredZip(archive), /unsupported entry format/);
});
