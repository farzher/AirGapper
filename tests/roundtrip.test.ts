import assert from "node:assert/strict";
import test from "node:test";
import { LTDecoder, LTEncoder } from "../shared/fountain.ts";
import { fnv1a, packFile, packFrame, parseFrame, streamIdentity, unpackFile, verifyFile } from "../shared/protocol.ts";

test("automated file round trip survives missing and reordered QR frames", async () => {
  const source = new TextEncoder().encode("AirGapper protocol round trip\n".repeat(2500));
  const packed = await packFile("round-trip.txt", "text/plain", source);
  const blockLen = 1445;
  const sessionId = 4242;
  const encoder = new LTEncoder(packed.container, blockLen, sessionId);
  const frames: Uint8Array[] = [];
  for (let seq = 0; seq < encoder.k * 4; seq++) {
    if (seq % 5 === 1) continue; // deterministic erasures
    frames.push(packFrame({
      sessionId,
      seq,
      k: encoder.k,
      blockLen,
      totalLen: packed.container.length,
      payloadFnv: fnv1a(packed.container),
    }, encoder.encode(seq)));
  }
  frames.reverse();

  let decoder: LTDecoder | undefined;
  let identity = "";
  let expectedFnv = 0;
  for (const frame of frames) {
    const parsed = parseFrame(frame);
    assert.ok(parsed);
    const nextIdentity = streamIdentity(parsed.header);
    if (!decoder) {
      identity = nextIdentity;
      expectedFnv = parsed.header.payloadFnv;
      decoder = new LTDecoder(parsed.header.k, parsed.header.blockLen, parsed.header.sessionId, parsed.header.totalLen);
    }
    assert.equal(nextIdentity, identity);
    decoder.addFrame(parsed.header.seq, parsed.block);
    if (decoder.isComplete) break;
  }

  assert.ok(decoder?.isComplete, "fountain decoder did not recover after loss/reordering");
  const container = decoder.assemble()!;
  assert.equal(fnv1a(container), expectedFnv);
  const file = await unpackFile(container);
  assert.equal(await verifyFile(file), true, "output must pass SHA-256 before acceptance");
  assert.equal(file.name, "round-trip.txt");
  assert.equal(file.type, "text/plain");
  assert.deepEqual(file.bytes, source);
});
