import { encodeAirGridLane } from '../shared/airgrid-phy.js';

function buildAirGridState({ profile, payloadId, sequence, profileId = 0, payloadForLane }) {
  const lanes = new Array(profile.lanes);
  for (let laneIndex = 0; laneIndex < profile.lanes; laneIndex++) {
    const payload = payloadForLane(laneIndex, profile.payloadBytes);
    lanes[laneIndex] = encodeAirGridLane({
      columns: profile.columns,
      profile: profileId,
      payloadId,
      sequence,
      laneIndex,
      payload
    });
  }
  return { sequence, lanes };
}

function renderAirGridState(ctx, state, width, height) {
  const lanes = state.lanes;
  const laneCount = lanes.length;
  const columns = lanes[0]?.length ?? 0;
  if (!laneCount || !columns) throw new Error('AirGrid state is empty');
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#000';
  for (let laneIndex = 0; laneIndex < laneCount; laneIndex++) {
    const y0 = Math.floor(laneIndex * height / laneCount);
    const y1 = Math.floor((laneIndex + 1) * height / laneCount);
    const bits = lanes[laneIndex];
    let start = -1;
    for (let column = 0; column <= columns; column++) {
      const dark = column < columns && bits[column] === 1;
      if (dark && start < 0) start = column;
      if ((!dark || column === columns) && start >= 0) {
        const x0 = Math.floor(start * width / columns);
        const x1 = Math.floor(column * width / columns);
        ctx.fillRect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
        start = -1;
      }
    }
  }
  ctx.restore();
}

class AirGridRasterRenderer {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.imageData = null;
    this.pixels32 = null;
    this.columns = 0;
    this.lanes = 0;
  }
  ensure(columns, lanes) {
    if (columns === this.columns && lanes === this.lanes && this.imageData) return;
    this.columns = columns;
    this.lanes = lanes;
    this.canvas.width = columns;
    this.canvas.height = lanes;
    this.imageData = this.ctx.createImageData(columns, lanes);
    this.pixels32 = new Uint32Array(this.imageData.data.buffer);
  }
  render(targetCtx, state, width, height) {
    const lanes = state.lanes;
    const laneCount = lanes.length;
    const columns = lanes[0]?.length ?? 0;
    if (!laneCount || !columns) throw new Error('AirGrid state is empty');
    this.ensure(columns, laneCount);
    let at = 0;
    for (let laneIndex = 0; laneIndex < laneCount; laneIndex++) {
      const bits = lanes[laneIndex];
      for (let column = 0; column < columns; column++) {
        this.pixels32[at++] = bits[column] ? 0xff000000 : 0xffffffff;
      }
    }
    this.ctx.putImageData(this.imageData, 0, 0);
    targetCtx.save();
    targetCtx.imageSmoothingEnabled = false;
    targetCtx.globalCompositeOperation = 'copy';
    targetCtx.drawImage(this.canvas, 0, 0, width, height);
    targetCtx.restore();
  }
}

export { AirGridRasterRenderer, buildAirGridState, renderAirGridState };
