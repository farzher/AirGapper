import assert from 'node:assert/strict';
import { acquisitionLumaAt, findAirGridAcquisition } from '../shared/airgrid-acquisition.js';

const width = 360, height = 203;
const config = { columns: 853, lanes: 480, modulation: 'pam4', senderHz: 60, payloadId: 0x51a7c0de };
const y8 = new Uint8Array(width * height);
for (let y=0; y<height; y++) for (let x=0; x<width; x++) {
  // Mild deterministic camera noise keeps the proof from depending on exact
  // 0/255 values while retaining a clean acquisition image.
  const base = acquisitionLumaAt((x+0.5)/width,(y+0.5)/height,config,24,231);
  const noise = ((x*17 + y*29) % 7) - 3;
  y8[y*width+x] = Math.max(0,Math.min(255,base+noise));
}
const found = findAirGridAcquisition(y8,width,height);
assert.ok(found,'automatic acquisition frame was not found');
assert.deepEqual(found.config,config);
assert.ok(Math.abs(found.quad.topLeft.x) < 15 && Math.abs(found.quad.topLeft.y) < 15,`bad TL ${JSON.stringify(found.quad.topLeft)}`);
assert.ok(Math.abs(found.quad.bottomRight.x-width) < 15 && Math.abs(found.quad.bottomRight.y-height) < 15,`bad BR ${JSON.stringify(found.quad.bottomRight)}`);
console.log('AIRGAPPER_AIRGRID_ACQUISITION_PASS',JSON.stringify({config:found.config,threshold:found.threshold,separation:found.separation,quad:found.quad}));
