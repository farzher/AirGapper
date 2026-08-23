import assert from 'node:assert/strict';
import { airGridProfile, encodeAirGridLane, makeAirGridPayload } from '../shared/airgrid-phy.js';
import { decodeAirGridY8 } from '../receive/airgrid-sampler.js';

const width = 1920, height = 1080;
const profile = airGridProfile({ projectedWidth: width, projectedHeight: height, cellPx: 4 });
const payloadId = 0x51a7c0de;
const sequences = [200, 201, 202, 203];
const states = sequences.map((sequence) => Array.from({length: profile.lanes}, (_, laneIndex) => {
  const payload = makeAirGridPayload(profile.payloadBytes, payloadId, sequence, laneIndex);
  return { payload, bits: encodeAirGridLane({columns:profile.columns,payloadId,sequence,laneIndex,payload}) };
}));
const y8 = new Uint8Array(width * height);
const cuts = [247, 539, 823];
for (let py = 0; py < height; py++) {
  const stateIndex = cuts.filter(cut => cut < py).length;
  const laneIndex = Math.min(profile.lanes - 1, Math.floor(py / (height / profile.lanes)));
  const lane = states[stateIndex][laneIndex].bits;
  const row = py * width;
  for (let px = 0; px < width; px++) {
    const col = Math.min(profile.columns - 1, Math.floor(px / (width / profile.columns)));
    y8[row + px] = lane[col] ? 24 : 232;
  }
}
// Exposure integration at each refresh boundary destroys a narrow horizontal
// band. Only the logical lane whose sampling center intersects that band should
// be lost; neighboring lanes remain independently decodable.
for (const cut of cuts) {
  for (let py = Math.max(0, cut - 2); py <= Math.min(height - 1, cut + 2); py++) y8.fill(128, py * width, (py + 1) * width);
}
const quad = {
  topLeft:{x:1.5,y:1.5}, topRight:{x:width-2.5,y:1.5},
  bottomRight:{x:width-2.5,y:height-2.5}, bottomLeft:{x:1.5,y:height-2.5}
};
const decoded = decodeAirGridY8({y8,width,height,quad,profile});
assert.ok(decoded.length >= profile.lanes - 6, `expected almost all lanes, got ${decoded.length}`);
const sequenceSet = new Set(decoded.map(l=>l.sequence));
assert.deepEqual([...sequenceSet].sort((a,b)=>a-b), sequences);
for (const lane of decoded) {
  assert.equal(lane.payloadId,payloadId);
  const expected = states[sequences.indexOf(lane.sequence)][lane.laneIndex].payload;
  assert.deepEqual(lane.payload, expected);
}
console.log('AIRGAPPER_AIRGRID_Y8_PASS', JSON.stringify({decoded:decoded.length,lanes:profile.lanes,payloadBytes:profile.payloadBytes,bytesPerCapture:decoded.length*profile.payloadBytes,bytesPerSecond30:decoded.length*profile.payloadBytes*30,sequences:[...sequenceSet].sort((a,b)=>a-b)}));
