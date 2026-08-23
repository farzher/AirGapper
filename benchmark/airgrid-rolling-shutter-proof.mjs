import assert from 'node:assert/strict';
import {
  airGridProfile,
  decodeAirGridLane,
  encodeAirGridLane,
  makeAirGridPayload
} from '../shared/airgrid-phy.js';

const profile = airGridProfile({ projectedWidth: 1920, projectedHeight: 1080, cellPx: 4 });
assert.ok(profile);
assert.equal(profile.columns, 480);
assert.equal(profile.lanes, 270);
assert.equal(profile.payloadBytes, 47);

const payloadId = 0x51a7c0de;
const sequences = [100, 101, 102, 103];
const states = sequences.map((sequence) => Array.from({ length: profile.lanes }, (_, laneIndex) => {
  const payload = makeAirGridPayload(profile.payloadBytes, payloadId, sequence, laneIndex);
  return {
    payload,
    bits: encodeAirGridLane({
      columns: profile.columns,
      payloadId,
      sequence,
      laneIndex,
      payload
    })
  };
}));

// One 30 fps camera frame can span several display refreshes. Model horizontal
// rolling-shutter boundaries at arbitrary sensor rows: every intact logical lane
// belongs to exactly one refresh, while the three lanes hit by a refresh boundary
// are deliberately destroyed. The decoder must retain every other lane without
// reconstructing a whole display frame.
const cuts = [61, 133, 204];
const captured = new Array(profile.lanes);
let stateIndex = 0;
for (let lane = 0; lane < profile.lanes; lane++) {
  if (cuts.includes(lane)) {
    const a = states[stateIndex][lane].bits;
    const b = states[Math.min(stateIndex + 1, states.length - 1)][lane].bits;
    const mixed = a.slice();
    // Force a physically impossible-to-trust boundary lane to fail CRC rather
    // than contaminating neighboring lanes. Real soft sampling will mark this
    // lane low-confidence; the outer fountain/MDS layer simply replaces it.
    for (let bit = 0; bit < mixed.length; bit += 5) mixed[bit] = b[bit] ^ 1;
    captured[lane] = mixed;
    stateIndex++;
  } else {
    captured[lane] = states[stateIndex][lane].bits;
  }
}

let recovered = 0;
const recoveredSequences = new Set();
for (let lane = 0; lane < captured.length; lane++) {
  const decoded = decodeAirGridLane(captured[lane], { laneIndex: lane });
  if (cuts.includes(lane)) {
    assert.equal(decoded, null, `boundary lane ${lane} must be discarded`);
    continue;
  }
  assert.ok(decoded, `intact lane ${lane} should decode`);
  assert.equal(decoded.payloadId, payloadId);
  const expectedState = cuts.filter((cut) => cut < lane).length;
  assert.equal(decoded.sequence, sequences[expectedState]);
  assert.deepEqual(decoded.payload, states[expectedState][lane].payload);
  recoveredSequences.add(decoded.sequence);
  recovered++;
}
assert.equal(recovered, profile.lanes - cuts.length);
assert.deepEqual([...recoveredSequences], sequences);

const rawPayloadPerCapture = recovered * profile.payloadBytes;
console.log('AIRGAPPER_AIRGRID_RS_PASS', JSON.stringify({
  cellPx: profile.cellPx,
  columns: profile.columns,
  lanes: profile.lanes,
  payloadBytesPerLane: profile.payloadBytes,
  recovered,
  droppedBoundaryLanes: cuts.length,
  rawPayloadPerCapture,
  rawPayloadAt30Fps: rawPayloadPerCapture * 30
}));
