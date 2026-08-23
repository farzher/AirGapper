import assert from 'node:assert/strict';
import {
  airGridBlockProfile,
  buildAirGridBlockState,
  decodeAirGridBlockBits,
  decodeHamming72,
  encodeAirGridBlock,
  encodeHamming72,
  makeAirGridBlockPayload
} from '../shared/airgrid-block.js';

const bytes = Uint8Array.from([0x00,0x11,0x22,0x33,0x44,0x55,0xaa,0xff]);
const encoded = encodeHamming72(bytes);
assert.equal(encoded.length, 72);
assert.deepEqual(decodeHamming72(encoded).bytes, bytes);
for (let bit = 0; bit < 72; bit++) {
  const damaged = Uint8Array.from(encoded);
  damaged[bit] ^= 1;
  const decoded = decodeHamming72(damaged);
  assert.equal(decoded.ok, true, `single-bit ${bit} must correct`);
  assert.deepEqual(decoded.bytes, bytes, `single-bit ${bit} payload`);
}
{
  const damaged = Uint8Array.from(encoded);
  damaged[10] ^= 1;
  damaged[20] ^= 1;
  assert.equal(decodeHamming72(damaged).ok, false, 'double-bit damage must reject');
}

for (const pitch of [3, 2.5, 2.25, 2, 1.75]) {
  const profile = airGridBlockProfile({ projectedWidth:2560, projectedHeight:1440, cellPx:pitch });
  assert(profile);
  assert(profile.layout.length > 0);
  assert.equal(profile.capacityBytes, profile.payloadBytesPerLane * profile.lanes);
  const used = profile.layout.at(-1).start + profile.layout.at(-1).cells;
  assert(used <= profile.columns);
}

const profile = airGridBlockProfile({ projectedWidth:2560, projectedHeight:1440, cellPx:3 });
const sequence = 1234;
for (const laneIndex of [0, Math.floor(profile.lanes / 2), profile.lanes - 1]) {
  for (const block of profile.layout) {
    const payload = makeAirGridBlockPayload(block.payloadBytes, 0x51a7c0de, sequence, laneIndex, block.blockIndex);
    const bits = encodeAirGridBlock({ codewords:block.codewords, sequence, laneIndex, blockIndex:block.blockIndex, payload });
    const decoded = decodeAirGridBlockBits(bits, { codewords:block.codewords, laneIndex, blockIndex:block.blockIndex });
    assert.equal(decoded.ok, true);
    assert.equal(decoded.block.sequence, sequence & 0xfff);
    assert.deepEqual(decoded.block.payload, payload);
  }
}

const state = buildAirGridBlockState({ profile, payloadId:0x51a7c0de, sequence });
assert.equal(state.lanes.length, profile.lanes);
assert(state.lanes.every(row => row.length === profile.columns));

console.log(JSON.stringify({
  ok:true,
  profile:{ columns:profile.columns, lanes:profile.lanes, blocksPerLane:profile.blocksPerLane, payloadBytesPerLane:profile.payloadBytesPerLane, capacityBytes:profile.capacityBytes }
}, null, 2));
