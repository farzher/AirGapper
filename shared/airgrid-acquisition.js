const AIRGRID_ACQ_MAGIC = 0xa671;
const AIRGRID_ACQ_VERSION = 1;
const AIRGRID_ACQ_BYTES = 15;
const AIRGRID_ACQ_COLS = 15;
const AIRGRID_ACQ_ROWS = 8;
const AIRGRID_ACQ_BITS = AIRGRID_ACQ_COLS * AIRGRID_ACQ_ROWS;
// Acquisition is intentionally oversized. It is only shown in short bursts,
// and reliable lock is more valuable than a few percent of temporal overhead.
const AIRGRID_ACQ_MARKER_OFFSET = 0.105;
const AIRGRID_ACQ_MARKER_W = 0.17;
const AIRGRID_ACQ_MARKER_H = 0.17;
const AIRGRID_ACQ_META = Object.freeze({ x0: 0.20, y0: 0.35, x1: 0.80, y1: 0.65 });
const FINDER = Object.freeze([
  '1111111',
  '1000001',
  '1011101',
  '1011101',
  '1011101',
  '1000001',
  '1111111'
]);
const MARKER_NORMALIZED = Object.freeze([
  { x: AIRGRID_ACQ_MARKER_OFFSET, y: AIRGRID_ACQ_MARKER_OFFSET },
  { x: 1 - AIRGRID_ACQ_MARKER_OFFSET, y: AIRGRID_ACQ_MARKER_OFFSET },
  { x: 1 - AIRGRID_ACQ_MARKER_OFFSET, y: 1 - AIRGRID_ACQ_MARKER_OFFSET },
  { x: AIRGRID_ACQ_MARKER_OFFSET, y: 1 - AIRGRID_ACQ_MARKER_OFFSET }
]);

function crc16(bytes) {
  let crc = 0xffff;
  for (const value of bytes) {
    crc ^= value << 8;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}
function encodeAirGridAcquisition({ columns, lanes, modulation = 'binary', senderHz = 60, payloadId = 0x51a7c0de }) {
  if (!Number.isInteger(columns) || columns < 64 || columns > 65535) throw new Error('AirGrid acquisition columns out of range');
  if (!Number.isInteger(lanes) || lanes < 8 || lanes > 65535) throw new Error('AirGrid acquisition lanes out of range');
  const bytes = new Uint8Array(AIRGRID_ACQ_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, AIRGRID_ACQ_MAGIC, true);
  bytes[2] = (AIRGRID_ACQ_VERSION << 4) | (modulation === 'pam4' ? 1 : 0);
  view.setUint16(3, columns, true);
  view.setUint16(5, lanes, true);
  view.setUint16(7, Math.max(1, Math.min(65535, Math.round(senderHz))), true);
  view.setUint32(9, payloadId >>> 0, true);
  view.setUint16(13, crc16(bytes.subarray(0, 13)), true);
  return bytes;
}
function decodeAirGridAcquisition(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = Uint8Array.from(bytes ?? []);
  if (bytes.length !== AIRGRID_ACQ_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0, true) !== AIRGRID_ACQ_MAGIC) return null;
  const version = bytes[2] >>> 4;
  if (version !== AIRGRID_ACQ_VERSION) return null;
  if (view.getUint16(13, true) !== crc16(bytes.subarray(0, 13))) return null;
  const mode = bytes[2] & 15;
  if (mode > 1) return null;
  const columns = view.getUint16(3, true);
  const lanes = view.getUint16(5, true);
  if (columns < 64 || lanes < 8) return null;
  return {
    version,
    modulation: mode === 1 ? 'pam4' : 'binary',
    columns,
    lanes,
    senderHz: view.getUint16(7, true),
    payloadId: view.getUint32(9, true)
  };
}
function acquisitionBits(config) {
  const bytes = encodeAirGridAcquisition(config);
  const bits = new Uint8Array(AIRGRID_ACQ_BITS);
  let at = 0;
  for (const value of bytes) for (let bit = 7; bit >= 0; bit--) bits[at++] = value >>> bit & 1;
  return bits;
}
function bitsToBytes(bits) {
  if (!bits || bits.length < AIRGRID_ACQ_BITS) return null;
  const bytes = new Uint8Array(AIRGRID_ACQ_BYTES);
  let at = 0;
  for (let i = 0; i < bytes.length; i++) {
    let value = 0;
    for (let bit = 0; bit < 8; bit++) value = (value << 1) | (bits[at++] & 1);
    bytes[i] = value;
  }
  return bytes;
}
function finderValue(row, col) { return FINDER[row]?.charCodeAt(col) === 49 ? 1 : 0; }
function acquisitionLumaAt(u, v, config, black = 20, white = 235) {
  for (const center of MARKER_NORMALIZED) {
    const x0 = center.x - AIRGRID_ACQ_MARKER_W * 0.5;
    const y0 = center.y - AIRGRID_ACQ_MARKER_H * 0.5;
    if (u >= x0 && u < x0 + AIRGRID_ACQ_MARKER_W && v >= y0 && v < y0 + AIRGRID_ACQ_MARKER_H) {
      const col = Math.max(0, Math.min(6, Math.floor((u - x0) / AIRGRID_ACQ_MARKER_W * 7)));
      const row = Math.max(0, Math.min(6, Math.floor((v - y0) / AIRGRID_ACQ_MARKER_H * 7)));
      return finderValue(row, col) ? black : white;
    }
  }
  const meta = AIRGRID_ACQ_META;
  if (u >= meta.x0 && u < meta.x1 && v >= meta.y0 && v < meta.y1) {
    const col = Math.max(0, Math.min(AIRGRID_ACQ_COLS - 1, Math.floor((u - meta.x0) / (meta.x1 - meta.x0) * AIRGRID_ACQ_COLS)));
    const row = Math.max(0, Math.min(AIRGRID_ACQ_ROWS - 1, Math.floor((v - meta.y0) / (meta.y1 - meta.y0) * AIRGRID_ACQ_ROWS)));
    return acquisitionBits(config)[row * AIRGRID_ACQ_COLS + col] ? black : white;
  }
  return white;
}

function solveLinear(matrix, rhs) {
  const n = rhs.length;
  const a = matrix.map((row, i) => [...row, rhs[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    if (Math.abs(a[pivot][col]) < 1e-9) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const scale = a[col][col];
    for (let j = col; j <= n; j++) a[col][j] /= scale;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = a[row][col];
      if (!factor) continue;
      for (let j = col; j <= n; j++) a[row][j] -= factor * a[col][j];
    }
  }
  return a.map(row => row[n]);
}
function homographyFromCorrespondences(source, target) {
  const matrix = [], rhs = [];
  for (let i = 0; i < 4; i++) {
    const u = source[i].x, v = source[i].y, x = target[i].x, y = target[i].y;
    matrix.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); rhs.push(x);
    matrix.push([0, 0, 0, u, v, 1, -u * y, -v * y]); rhs.push(y);
  }
  const s = solveLinear(matrix, rhs);
  return s ? { a:s[0], b:s[1], c:s[2], d:s[3], e:s[4], f:s[5], g:s[6], h:s[7] } : null;
}
function projectAirGridAcquisition(h, u, v) {
  const z = h.g * u + h.h * v + 1;
  return { x:(h.a*u + h.b*v + h.c)/z, y:(h.d*u + h.e*v + h.f)/z };
}
function sampleNearest(y8, width, height, x, y) {
  const ix = Math.max(0, Math.min(width - 1, Math.round(x)));
  const iy = Math.max(0, Math.min(height - 1, Math.round(y)));
  return y8[iy * width + ix];
}
function imageThreshold(y8) {
  const step = Math.max(1, Math.floor(y8.length / 8192));
  const values = [];
  for (let i = 0; i < y8.length; i += step) values.push(y8[i]);
  values.sort((a,b)=>a-b);
  if (!values.length) return { threshold:128, separation:0 };
  const lo = values[Math.floor(values.length * 0.05)];
  const hi = values[Math.min(values.length - 1, Math.floor(values.length * 0.95))];
  return { threshold:(lo + hi) * 0.5, separation:hi - lo };
}
function ratioScore(runs) {
  const total = runs.reduce((a,b)=>a+b,0);
  if (total < 5) return 1e9;
  const m = total / 7;
  const expected = [m,m,3*m,m,m];
  let error = 0;
  for (let i=0;i<5;i++) error += Math.abs(runs[i]-expected[i]) / Math.max(0.75, expected[i]);
  return error;
}
function verticalFinderCheck(y8, width, height, x, y, threshold) {
  x = Math.max(0, Math.min(width - 1, Math.round(x)));
  y = Math.max(0, Math.min(height - 1, Math.round(y)));
  const dark = yy => y8[yy * width + x] < threshold;
  if (!dark(y)) return null;
  let up = y, down = y;
  while (up > 0 && dark(up - 1)) up--;
  while (down + 1 < height && dark(down + 1)) down++;
  const center = down - up + 1;
  let p = up - 1, lightTop = 0; while (p >= 0 && !dark(p)) { lightTop++; p--; }
  let darkTop = 0; while (p >= 0 && dark(p)) { darkTop++; p--; }
  p = down + 1; let lightBottom = 0; while (p < height && !dark(p)) { lightBottom++; p++; }
  let darkBottom = 0; while (p < height && dark(p)) { darkBottom++; p++; }
  const runs = [darkTop, lightTop, center, lightBottom, darkBottom];
  const score = ratioScore(runs);
  if (!darkTop || !lightTop || !lightBottom || !darkBottom || score > 2.8) return null;
  return { y:(up + down) * 0.5, module:(runs.reduce((a,b)=>a+b,0) / 7), score };
}
function finderCandidates(y8, width, height, threshold) {
  const clusters = [];
  for (let y = 0; y < height; y++) {
    const runs = [];
    let color = y8[y * width] < threshold;
    let start = 0;
    for (let x = 1; x <= width; x++) {
      const next = x < width ? y8[y * width + x] < threshold : !color;
      if (x < width && next === color) continue;
      runs.push({ color, start, len:x-start });
      if (runs.length > 5) runs.shift();
      if (runs.length === 5 && runs[0].color && !runs[1].color && runs[2].color && !runs[3].color && runs[4].color) {
        const lengths = runs.map(run=>run.len);
        const hScore = ratioScore(lengths);
        if (hScore <= 2.5) {
          const cx = runs[2].start + runs[2].len * 0.5;
          const vertical = verticalFinderCheck(y8,width,height,cx,y,threshold);
          if (vertical) {
            const moduleX = lengths.reduce((a,b)=>a+b,0)/7;
            const aspect = vertical.module / Math.max(0.1,moduleX);
            if (aspect > 0.10 && aspect < 10) {
              const radius = Math.max(4, moduleX * 2.8, vertical.module * 2.8);
              let cluster = clusters.find(c => Math.hypot(c.x-cx,c.y-vertical.y) < radius);
              const weight = 1 / Math.max(0.15, hScore + vertical.score);
              if (!cluster) { cluster = {x:cx,y:vertical.y,moduleX,moduleY:vertical.module,weight:0,hits:0}; clusters.push(cluster); }
              const total = cluster.weight + weight;
              cluster.x = (cluster.x*cluster.weight + cx*weight)/total;
              cluster.y = (cluster.y*cluster.weight + vertical.y*weight)/total;
              cluster.moduleX = (cluster.moduleX*cluster.weight + moduleX*weight)/total;
              cluster.moduleY = (cluster.moduleY*cluster.weight + vertical.module*weight)/total;
              cluster.weight = total; cluster.hits++;
            }
          }
        }
      }
      color = next; start = x;
    }
  }
  return clusters.filter(c=>c.hits>=1).sort((a,b)=>(b.hits+b.weight)-(a.hits+a.weight)).slice(0,18);
}
function polygonArea(points) {
  return Math.abs(points.reduce((sum,p,i)=>{const q=points[(i+1)%points.length];return sum+p.x*q.y-q.x*p.y;},0))*0.5;
}
function cyclicOrders(points) {
  const cx = points.reduce((s,p)=>s+p.x,0)/4;
  const cy = points.reduce((s,p)=>s+p.y,0)/4;
  const ring = [...points].sort((a,b)=>Math.atan2(a.y-cy,a.x-cx)-Math.atan2(b.y-cy,b.x-cx));
  const out = [];
  for (const base of [ring,[...ring].reverse()]) {
    for (let shift=0;shift<4;shift++) out.push([base[shift],base[(shift+1)%4],base[(shift+2)%4],base[(shift+3)%4]]);
  }
  return out;
}
function decodeMetadata(y8,width,height,h,threshold) {
  const bits = new Uint8Array(AIRGRID_ACQ_BITS);
  const meta = AIRGRID_ACQ_META;
  let at = 0;
  for (let row=0;row<AIRGRID_ACQ_ROWS;row++) for (let col=0;col<AIRGRID_ACQ_COLS;col++) {
    const u = meta.x0 + (col + 0.5) / AIRGRID_ACQ_COLS * (meta.x1-meta.x0);
    const v = meta.y0 + (row + 0.5) / AIRGRID_ACQ_ROWS * (meta.y1-meta.y0);
    const p = projectAirGridAcquisition(h,u,v);
    let sum=0,count=0;
    for (let dy=-2;dy<=2;dy++) for (let dx=-2;dx<=2;dx++) { sum += sampleNearest(y8,width,height,p.x+dx,p.y+dy); count++; }
    bits[at++] = sum/count < threshold ? 1 : 0;
  }
  const bytes = bitsToBytes(bits);
  return bytes ? decodeAirGridAcquisition(bytes) : null;
}
function findAirGridAcquisition(y8,width,height,debug = null) {
  if (debug) Object.assign(debug, { reason:'starting', separation:0, threshold:0, candidateCount:0, quadsTried:0, metadataAttempts:0 });
  if (!(y8 instanceof Uint8Array) || y8.length < width*height || width<80 || height<60) {
    if (debug) debug.reason = 'invalid-frame';
    return null;
  }
  const levels = imageThreshold(y8);
  if (debug) Object.assign(debug, { separation:levels.separation, threshold:levels.threshold });
  if (levels.separation < 18) {
    if (debug) debug.reason = 'low-contrast';
    return null;
  }
  const thresholdCandidates = [
    levels.threshold,
    levels.threshold - levels.separation*0.12,
    levels.threshold + levels.separation*0.12,
    levels.threshold - levels.separation*0.22,
    levels.threshold + levels.separation*0.22
  ];
  let bestCandidateCount = 0;
  for (const threshold of thresholdCandidates) {
    const candidates = finderCandidates(y8,width,height,threshold);
    bestCandidateCount = Math.max(bestCandidateCount,candidates.length);
    if (debug) debug.candidateCount = bestCandidateCount;
    if (candidates.length < 4) continue;
    const top = candidates.slice(0,Math.min(14,candidates.length));
    for (let a=0;a<top.length-3;a++) for (let b=a+1;b<top.length-2;b++) for (let c=b+1;c<top.length-1;c++) for (let d=c+1;d<top.length;d++) {
      const set = [top[a],top[b],top[c],top[d]];
      for (const ordered of cyclicOrders(set)) {
        if (polygonArea(ordered) < width*height*0.025) continue;
        const h = homographyFromCorrespondences(MARKER_NORMALIZED, ordered);
        if (!h) continue;
        if (debug) debug.quadsTried++;
        for (const metaThreshold of thresholdCandidates) {
          if (debug) debug.metadataAttempts++;
          const config = decodeMetadata(y8,width,height,h,metaThreshold);
          if (!config) continue;
          const quad = {
            topLeft:projectAirGridAcquisition(h,0,0),
            topRight:projectAirGridAcquisition(h,1,0),
            bottomRight:projectAirGridAcquisition(h,1,1),
            bottomLeft:projectAirGridAcquisition(h,0,1)
          };
          if (debug) debug.reason = 'locked';
          return {
            config,
            quad,
            markers:ordered.map(p=>({x:p.x,y:p.y})),
            threshold:metaThreshold,
            separation:levels.separation,
            candidateCount:candidates.length
          };
        }
      }
    }
  }
  if (debug) debug.reason = bestCandidateCount < 4 ? `finders-${bestCandidateCount}-of-4` : 'metadata-crc';
  return null;
}

export {
  AIRGRID_ACQ_BITS,
  AIRGRID_ACQ_COLS,
  AIRGRID_ACQ_META,
  AIRGRID_ACQ_ROWS,
  AIRGRID_ACQ_MARKER_H,
  AIRGRID_ACQ_MARKER_W,
  FINDER as AIRGRID_ACQ_FINDER,
  MARKER_NORMALIZED as AIRGRID_ACQ_MARKER_CENTERS,
  acquisitionBits,
  acquisitionLumaAt,
  decodeAirGridAcquisition,
  encodeAirGridAcquisition,
  findAirGridAcquisition,
  homographyFromCorrespondences,
  projectAirGridAcquisition
};
