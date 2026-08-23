import assert from 'node:assert/strict';
import { makeAirGridPayload } from '../shared/airgrid-phy.js';
import { AIRGRID_PAM4_LEVELS, airGridPam4Profile, encodeAirGridPam4Lane } from '../shared/airgrid-pam4.js';
import { decodeAirGridPam4Y8Detailed } from '../receive/airgrid-pam4-sampler.js';

const width = 1280, height = 720;
const profile = airGridPam4Profile({ projectedWidth: width, projectedHeight: height, cellPx: 4 });
const payloadId = 0x51a7c0de;
const sequences = [300, 301];
const states = sequences.map(sequence => Array.from({ length: profile.lanes }, (_, laneIndex) => {
  const payload = makeAirGridPayload(profile.payloadBytes, payloadId, sequence, laneIndex);
  return { payload, symbols: encodeAirGridPam4Lane({ columns: profile.columns, payloadId, sequence, laneIndex, payload }) };
}));
const y8 = new Uint8Array(width * height);
const cut = 357;
for (let py = 0; py < height; py++) {
  const stateIndex = py <= cut ? 0 : 1;
  const laneIndex = Math.min(profile.lanes - 1, Math.floor(py / (height / profile.lanes)));
  const symbols = states[stateIndex][laneIndex].symbols;
  const row = py * width;
  for (let px = 0; px < width; px++) {
    const col = Math.min(profile.columns - 1, Math.floor(px / (width / profile.columns)));
    const base = AIRGRID_PAM4_LEVELS[symbols[col]];
    // Small deterministic sensor noise while keeping the four clusters clean.
    const noise = ((px * 17 + py * 13) % 7) - 3;
    y8[row + px] = Math.max(0, Math.min(255, base + noise));
  }
}
// Simulate exposure integration directly at the rolling-shutter state boundary.
for (let py = cut - 2; py <= cut + 2; py++) y8.fill(128, py * width, (py + 1) * width);
const quad = {
  topLeft: { x: 1.5, y: 1.5 }, topRight: { x: width - 2.5, y: 1.5 },
  bottomRight: { x: width - 2.5, y: height - 2.5 }, bottomLeft: { x: 1.5, y: height - 2.5 }
};
const { lanes, diagnostics } = decodeAirGridPam4Y8Detailed({ y8, width, height, quad, profile, minSeparation: 8 });
assert.ok(lanes.length >= profile.lanes - 5, `expected almost all PAM4 lanes, got ${lanes.length}/${profile.lanes}`);
assert.deepEqual(diagnostics.rollingShutter.sequences, sequences);
assert.ok(diagnostics.decode.failures.lowContrast >= 1, 'boundary should lose at least one PAM4 lane');
assert.ok(diagnostics.optics.separationP10 > 20, `PAM4 adjacent cluster gap too small: ${diagnostics.optics.separationP10}`);
assert.ok(diagnostics.optics.evmP90 < 0.25, `PAM4 synthetic EVM too high: ${diagnostics.optics.evmP90}`);
for (const lane of lanes) {
  assert.equal(lane.payloadId, payloadId);
  const expected = states[sequences.indexOf(lane.sequence)][lane.laneIndex].payload;
  assert.deepEqual(lane.payload, expected);
}
console.log('AIRGAPPER_AIRGRID_PAM4_Y8_PASS', JSON.stringify({
  decoded: lanes.length,
  lanes: profile.lanes,
  payloadBytes: profile.payloadBytes,
  bytesPerCapture: lanes.length * profile.payloadBytes,
  bytesPerSecond30: lanes.length * profile.payloadBytes * 30,
  separationP10: diagnostics.optics.separationP10,
  evmP90: diagnostics.optics.evmP90,
  centers: diagnostics.optics.clusterCentersP50
}));
