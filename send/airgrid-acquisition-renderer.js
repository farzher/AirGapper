import {
  AIRGRID_ACQ_COLS,
  AIRGRID_ACQ_FINDER,
  AIRGRID_ACQ_MARKER_CENTERS,
  AIRGRID_ACQ_MARKER_H,
  AIRGRID_ACQ_MARKER_W,
  AIRGRID_ACQ_META,
  AIRGRID_ACQ_ROWS,
  acquisitionBits
} from '../shared/airgrid-acquisition.js';

function renderFinder(ctx, width, height, center) {
  const x0 = (center.x - AIRGRID_ACQ_MARKER_W * 0.5) * width;
  const y0 = (center.y - AIRGRID_ACQ_MARKER_H * 0.5) * height;
  const mw = AIRGRID_ACQ_MARKER_W * width / 7;
  const mh = AIRGRID_ACQ_MARKER_H * height / 7;
  for (let row=0; row<7; row++) for (let col=0; col<7; col++) {
    ctx.fillStyle = AIRGRID_ACQ_FINDER[row][col] === '1' ? '#000' : '#fff';
    const xa = Math.floor(x0 + col * mw);
    const xb = Math.ceil(x0 + (col + 1) * mw);
    const ya = Math.floor(y0 + row * mh);
    const yb = Math.ceil(y0 + (row + 1) * mh);
    ctx.fillRect(xa, ya, Math.max(1, xb-xa), Math.max(1, yb-ya));
  }
}

function renderAirGridAcquisition(ctx, width, height, config) {
  const bits = acquisitionBits(config);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.globalCompositeOperation = 'copy';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0,0,width,height);
  for (const center of AIRGRID_ACQ_MARKER_CENTERS) renderFinder(ctx,width,height,center);

  const meta = AIRGRID_ACQ_META;
  const cellW = (meta.x1-meta.x0) * width / AIRGRID_ACQ_COLS;
  const cellH = (meta.y1-meta.y0) * height / AIRGRID_ACQ_ROWS;
  for (let row=0; row<AIRGRID_ACQ_ROWS; row++) for (let col=0; col<AIRGRID_ACQ_COLS; col++) {
    const bit = bits[row * AIRGRID_ACQ_COLS + col];
    ctx.fillStyle = bit ? '#000' : '#fff';
    const x0 = Math.floor((meta.x0 * width) + col * cellW);
    const x1 = Math.ceil((meta.x0 * width) + (col + 1) * cellW);
    const y0 = Math.floor((meta.y0 * height) + row * cellH);
    const y1 = Math.ceil((meta.y0 * height) + (row + 1) * cellH);
    ctx.fillRect(x0,y0,Math.max(1,x1-x0),Math.max(1,y1-y0));
  }
  ctx.restore();
}

export { renderAirGridAcquisition };
