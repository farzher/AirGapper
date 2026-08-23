import assert from 'node:assert/strict';
import { airGridProfile } from '../shared/airgrid-phy.js';
import { airGridPam4Profile } from '../shared/airgrid-pam4.js';

const width = 2560;
const height = 1440;
const cameraFps = 30;
const baseline = 2_000_000;
const target = 2_500_000;
function row(modulation, cellPx) {
  const profile = modulation === 'pam4'
    ? airGridPam4Profile({ projectedWidth: width, projectedHeight: height, cellPx })
    : airGridProfile({ projectedWidth: width, projectedHeight: height, cellPx });
  const bytesPerCapture = profile.lanes * profile.payloadBytes;
  const bytesPerSecond = bytesPerCapture * cameraFps;
  return {
    modulation,
    cellPx,
    columns: profile.columns,
    lanes: profile.lanes,
    payloadBytes: profile.payloadBytes,
    bytesPerCapture,
    bytesPerSecond,
    megabytesPerSecond: bytesPerSecond / 1e6,
    requiredEfficiencyToBeatBaseline: baseline / bytesPerSecond,
    requiredEfficiencyToHitTarget: target / bytesPerSecond
  };
}
const rows = [
  row('binary', 3), row('binary', 2.5), row('binary', 2.25), row('binary', 2),
  row('pam4', 3.5), row('pam4', 3), row('pam4', 2.5), row('pam4', 2.25), row('pam4', 2)
];
const binary25 = rows.find(r => r.modulation === 'binary' && r.cellPx === 2.5);
const binary225 = rows.find(r => r.modulation === 'binary' && r.cellPx === 2.25);
const binary2 = rows.find(r => r.modulation === 'binary' && r.cellPx === 2);
const pam3 = rows.find(r => r.modulation === 'pam4' && r.cellPx === 3);
const pam25 = rows.find(r => r.modulation === 'pam4' && r.cellPx === 2.5);
assert.ok(binary25.bytesPerSecond < baseline, '2.5 px binary should correctly expose that it cannot beat 2 MB/s at 30 fps with current framing');
assert.ok(binary225.bytesPerSecond > baseline, `2.25 px binary must clear the 2 MB/s floor; got ${binary225.bytesPerSecond}`);
assert.ok(binary2.bytesPerSecond > target, `2 px binary should have enough capacity for the 2.5 MB/s milestone; got ${binary2.bytesPerSecond}`);
assert.ok(pam3.bytesPerSecond > target, `3 px PAM4 must have enough capacity for 2.5 MB/s at 30 fps; got ${pam3.bytesPerSecond}`);
assert.ok(pam3.requiredEfficiencyToBeatBaseline < 0.72, `3 px PAM4 needs too much efficiency to beat QR: ${pam3.requiredEfficiencyToBeatBaseline}`);
assert.ok(pam25.bytesPerSecond > 4_000_000, `2.5 px PAM4 should leave >4 MB/s raw payload headroom; got ${pam25.bytesPerSecond}`);
console.log('AIRGAPPER_AIRGRID_THROUGHPUT_BUDGET_PASS', JSON.stringify({ width, height, cameraFps, baseline, target, rows }));
