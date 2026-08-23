import assert from 'node:assert/strict';
import { airGridBlockProfile, buildAirGridBlockState, makeAirGridBlockPayload } from '../shared/airgrid-block.js';
import { decodeAirGridBlockY8Detailed } from '../receive/airgrid-block-sampler.js';

const width = 960;
const height = 540;
const profile = airGridBlockProfile({ projectedWidth: width, projectedHeight: height, cellPx: 3 });
assert(profile);
const payloadId = 0x51a7c0de;
const sequence = 321;
const state = buildAirGridBlockState({ profile, payloadId, sequence });
const y8 = new Uint8Array(width * height);

for (let lane = 0; lane < profile.lanes; lane++) {
  const y0 = Math.floor(lane * height / profile.lanes);
  const y1 = Math.floor((lane + 1) * height / profile.lanes);
  for (let column = 0; column < profile.columns; column++) {
    const x0 = Math.floor(column * width / profile.columns);
    const x1 = Math.floor((column + 1) * width / profile.columns);
    const value = state.lanes[lane][column] ? 0 : 255;
    for (let y = y0; y < y1; y++) y8.fill(value, y * width + x0, y * width + x1);
  }
}

const quad = {
  topLeft: { x: 0, y: 0 },
  topRight: { x: width, y: 0 },
  bottomRight: { x: width, y: height },
  bottomLeft: { x: 0, y: height }
};
const result = decodeAirGridBlockY8Detailed({ y8, width, height, quad, profile, minSeparation: 14 });
const expectedBlocks = profile.lanes * profile.blocksPerLane;
assert.equal(result.lanes.length, expectedBlocks, `expected all ${expectedBlocks} blocks, got ${result.lanes.length}`);
for (const unit of result.lanes) {
  const expected = makeAirGridBlockPayload(unit.payload.length, payloadId, unit.sequence, unit.laneIndex, unit.blockIndex);
  assert.deepEqual(unit.payload, expected);
}
assert.equal(result.diagnostics.decode.validLaneRate, 1);
console.log(JSON.stringify({
  ok: true,
  width,
  height,
  profile: { columns: profile.columns, lanes: profile.lanes, blocksPerLane: profile.blocksPerLane },
  decodedBlocks: result.lanes.length,
  phase: [result.diagnostics.frame.phaseX, result.diagnostics.frame.phaseY]
}, null, 2));
