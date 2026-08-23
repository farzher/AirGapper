import assert from 'node:assert/strict';
import { AirGridDiagnostics, boundaryFailureLanes } from '../shared/airgrid-diagnostics.js';
import { airGridProfile, encodeAirGridLane, inspectAirGridLane, makeAirGridPayload } from '../shared/airgrid-phy.js';
import { decodeAirGridY8Detailed } from '../receive/airgrid-sampler.js';
import { AirGridPresentationDiagnostics } from '../send/airgrid-present-diagnostics.js';

const width = 1280, height = 720;
const profile = airGridProfile({ projectedWidth: width, projectedHeight: height, cellPx: 4 });
const payloadId = 0x421177aa;
const sequences = [80, 81];
const states = sequences.map(sequence => Array.from({ length: profile.lanes }, (_, laneIndex) => {
  const payload = makeAirGridPayload(profile.payloadBytes, payloadId, sequence, laneIndex);
  return encodeAirGridLane({ columns: profile.columns, payloadId, sequence, laneIndex, payload });
}));
const y8 = new Uint8Array(width * height);
const cut = 359;
for (let py = 0; py < height; py++) {
  const state = py <= cut ? 0 : 1;
  const laneIndex = Math.min(profile.lanes - 1, Math.floor(py / (height / profile.lanes)));
  const bits = states[state][laneIndex];
  const row = py * width;
  for (let px = 0; px < width; px++) {
    const col = Math.min(profile.columns - 1, Math.floor(px / (width / profile.columns)));
    y8[row + px] = bits[col] ? 20 : 235;
  }
}
for (let py = cut - 4; py <= cut + 4; py++) y8.fill(128, py * width, (py + 1) * width);
const quad = {
  topLeft: { x: 1.5, y: 1.5 }, topRight: { x: width - 2.5, y: 1.5 },
  bottomRight: { x: width - 2.5, y: height - 2.5 }, bottomLeft: { x: 1.5, y: height - 2.5 }
};
const { lanes, diagnostics } = decodeAirGridY8Detailed({ y8, width, height, quad, profile });
assert.ok(lanes.length >= profile.lanes - 5, `unexpected lane loss: ${lanes.length}/${profile.lanes}`);
assert.deepEqual(diagnostics.rollingShutter.sequences, sequences);
assert.ok(diagnostics.decode.failures.lowContrast >= 1, 'blurred refresh boundary should classify as low optical contrast');
assert.ok(boundaryFailureLanes(diagnostics.rollingShutter.runs) >= 1, 'failure between two display sequences should classify as a rolling-shutter boundary loss');
assert.ok(diagnostics.optics.separationP50 > 150, `clean optical separation should stay large: ${diagnostics.optics.separationP50}`);
assert.ok(diagnostics.optics.snrP10 > 5, `clean lanes should have strong SNR: ${diagnostics.optics.snrP10}`);
assert.ok(diagnostics.frame.pxPerCellX > 3.9 && diagnostics.frame.pxPerCellX < 4.1);

const payload = makeAirGridPayload(profile.payloadBytes, payloadId, 99, 0);
const corrupted = encodeAirGridLane({ columns: profile.columns, payloadId, sequence: 99, laneIndex: 0, payload });
corrupted[120] ^= 1;
assert.equal(inspectAirGridLane(corrupted, { laneIndex: 0 }).reason, 'crc', 'payload corruption should be distinguishable from optical/preamble loss');

const gray = new Uint8Array(width * height).fill(128);
const bad = decodeAirGridY8Detailed({ y8: gray, width, height, quad, profile });
assert.equal(bad.lanes.length, 0);
assert.equal(bad.diagnostics.decode.failures.lowContrast, profile.lanes, 'flat image should diagnose optical contrast, not generic decode failure');

const monitor = new AirGridDiagnostics({ targetBytesPerSecond: 2_000_000 });
for (let i = 0; i < 12; i++) monitor.observeNative({
  timestampNs: i * 1e9 / 60,
  exposureTimeNs: 1_100_000,
  frameDurationNs: 1e9 / 60,
  rollingShutterSkewNs: 11_800_000,
  iso: 320
}, diagnostics, { copyMs: 0.2, queueMs: 0.1, senderHz: 60 });
const snapshot = monitor.snapshot();
assert.ok(snapshot.capture.fps > 59 && snapshot.capture.fps < 61, `capture FPS telemetry wrong: ${snapshot.capture.fps}`);
assert.equal(snapshot.capture.exposureUs, 1100);
assert.equal(snapshot.rollingShutter.sensorReadoutMs, 11.8);
assert.ok(snapshot.channel.validLaneRate > 0.97);

const present = new AirGridPresentationDiagnostics();
for (let i = 0; i < 20; i++) present.noteFrame({ sequence: i, requestedHz: 60, presentedAtMs: i * 1000 / 60, renderMs: 1.2 });
const sender = present.snapshot();
assert.ok(sender.actualHz > 59 && sender.actualHz < 61);
assert.equal(sender.missedIntervals, 0);
assert.ok(sender.renderBudgetP95 < 0.1);

console.log('AIRGAPPER_AIRGRID_DIAGNOSTICS_PASS', JSON.stringify({
  valid: lanes.length,
  total: profile.lanes,
  failures: diagnostics.decode.failures,
  separationP50: diagnostics.optics.separationP50,
  snrP10: diagnostics.optics.snrP10,
  captureFps: snapshot.capture.fps,
  exposureUs: snapshot.capture.exposureUs,
  sensorReadoutMs: snapshot.rollingShutter.sensorReadoutMs,
  senderHz: sender.actualHz
}));
