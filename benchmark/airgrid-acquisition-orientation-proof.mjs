import assert from 'node:assert/strict';
import { acquisitionLumaAt, findAirGridAcquisition } from '../shared/airgrid-acquisition.js';

const config = { columns:853, lanes:480, modulation:'pam4', senderHz:60, payloadId:0x51a7c0de };

function canonical(width,height) {
  const out = new Uint8Array(width*height);
  for (let y=0;y<height;y++) for (let x=0;x<width;x++) {
    const base = acquisitionLumaAt((x+.5)/width,(y+.5)/height,config,28,225);
    out[y*width+x] = Math.max(0,Math.min(255,base + ((x*13+y*31)%11)-5));
  }
  return out;
}
function rotate90(src,width,height) {
  const out = new Uint8Array(width*height);
  const rw=height,rh=width;
  const rotated = new Uint8Array(rw*rh);
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) rotated[x*rw+(height-1-y)] = src[y*width+x];
  return {data:rotated,width:rw,height:rh};
}

const landscape = canonical(360,203);
const direct = findAirGridAcquisition(landscape,360,203);
assert.ok(direct,'landscape acquisition failed');
assert.deepEqual(direct.config,config);

const rotated = rotate90(landscape,360,203);
const foundRotated = findAirGridAcquisition(rotated.data,rotated.width,rotated.height);
assert.ok(foundRotated,'90-degree camera orientation acquisition failed');
assert.deepEqual(foundRotated.config,config);

console.log('AIRGAPPER_AIRGRID_ACQUISITION_ORIENTATION_PASS', JSON.stringify({
  directCandidates:direct.candidateCount,
  rotatedCandidates:foundRotated.candidateCount,
  rotatedSize:[rotated.width,rotated.height]
}));
