import assert from 'node:assert/strict';
import { airGridProfile } from '../shared/airgrid-phy.js';

const width = 2560;
const height = 1440;
const cameraFps = 60;
const baseline = 2_000_000;
const rows = [4, 3.5, 3, 2.5].map(cellPx => {
  const profile = airGridProfile({ projectedWidth: width, projectedHeight: height, cellPx });
  const bytesPerCapture = profile.lanes * profile.payloadBytes;
  const bytesPerSecond = bytesPerCapture * cameraFps;
  return {
    cellPx,
    columns: profile.columns,
    lanes: profile.lanes,
    payloadBytes: profile.payloadBytes,
    bytesPerCapture,
    bytesPerSecond,
    megabytesPerSecond: bytesPerSecond / 1e6,
    requiredEfficiencyToBeatBaseline: baseline / bytesPerSecond
  };
});
const at3 = rows.find(row => row.cellPx === 3);
const at25 = rows.find(row => row.cellPx === 2.5);
assert.ok(at3.bytesPerSecond > baseline, `3 px binary PHY must have enough raw capacity to beat 2 MB/s; got ${at3.bytesPerSecond}`);
assert.ok(at3.requiredEfficiencyToBeatBaseline < 0.8, `3 px profile needs too much perfect-channel efficiency: ${at3.requiredEfficiencyToBeatBaseline}`);
assert.ok(at25.bytesPerSecond > 3_500_000, `2.5 px profile should leave substantial headroom; got ${at25.bytesPerSecond}`);
console.log('AIRGAPPER_AIRGRID_THROUGHPUT_BUDGET_PASS', JSON.stringify({ width, height, cameraFps, baseline, rows }));
