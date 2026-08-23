import assert from 'node:assert/strict';
import {
  AIRGRID_QR_CENTERS,
  AIRGRID_QR_ORDER,
  airGridQrConfigKey,
  encodeAirGridQrAcquisition,
  parseAirGridQrAcquisition
} from '../shared/airgrid-qr-acquisition.js';

const config = { modulation:'binary', columns:853, lanes:480, senderHz:60, payloadId:0x51a7c0de };
const decoded = [];
for (const corner of AIRGRID_QR_ORDER) {
  const text = encodeAirGridQrAcquisition(config, corner);
  const parsed = parseAirGridQrAcquisition(text);
  assert.ok(parsed, `failed to parse ${corner}`);
  assert.equal(parsed.corner, corner);
  assert.equal(airGridQrConfigKey(parsed), airGridQrConfigKey(config));
  decoded.push(parsed);
}
assert.deepEqual(AIRGRID_QR_ORDER, ['TL','TR','BR','BL']);
assert.equal(AIRGRID_QR_CENTERS.TL.x, 0.13);
assert.equal(AIRGRID_QR_CENTERS.BR.y, 0.87);
assert.equal(new Set(decoded.map(airGridQrConfigKey)).size, 1);
assert.equal(parseAirGridQrAcquisition('garbage'), null);
console.log('AIRGAPPER_AIRGRID_QR_ACQUISITION_PASS', JSON.stringify({ key:airGridQrConfigKey(config), corners:AIRGRID_QR_ORDER }));
