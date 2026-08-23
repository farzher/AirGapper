import { encodeAirGridLane } from '../shared/airgrid-phy.js';
import { AIRGRID_PAM4_LEVELS, encodeAirGridPam4Lane } from '../shared/airgrid-pam4.js';

function buildAirGridState({ profile, payloadId, sequence, profileId = 0, payloadForLane, modulation = profile?.modulation ?? 'binary' }) {
  const lanes = new Array(profile.lanes);
  const pam4 = modulation === 'pam4';
  for (let laneIndex = 0; laneIndex < profile.lanes; laneIndex++) {
    const payload = payloadForLane(laneIndex, profile.payloadBytes);
    lanes[laneIndex] = pam4
      ? encodeAirGridPam4Lane({ columns: profile.columns, profile: profileId, payloadId, sequence, laneIndex, payload })
      : encodeAirGridLane({ columns: profile.columns, profile: profileId, payloadId, sequence, laneIndex, payload });
  }
  return { sequence, modulation: pam4 ? 'pam4' : 'binary', levels: pam4 ? AIRGRID_PAM4_LEVELS : null, lanes };
}

function symbolLuma(state, symbol) {
  return state.levels ? state.levels[symbol & 3] : (symbol ? 0 : 255);
}
function renderAirGridState(ctx, state, width, height) {
  const lanes = state.lanes;
  const laneCount = lanes.length;
  const columns = lanes[0]?.length ?? 0;
  if (!laneCount || !columns) throw new Error('AirGrid state is empty');
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  for (let laneIndex = 0; laneIndex < laneCount; laneIndex++) {
    const y0 = Math.floor(laneIndex * height / laneCount);
    const y1 = Math.floor((laneIndex + 1) * height / laneCount);
    const symbols = lanes[laneIndex];
    let runStart = 0;
    let runValue = symbols[0];
    for (let column = 1; column <= columns; column++) {
      const value = column < columns ? symbols[column] : -1;
      if (value === runValue) continue;
      const x0 = Math.floor(runStart * width / columns);
      const x1 = Math.floor(column * width / columns);
      const luma = symbolLuma(state, runValue);
      ctx.fillStyle = `rgb(${luma} ${luma} ${luma})`;
      ctx.fillRect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
      runStart = column;
      runValue = value;
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
      const symbols = lanes[laneIndex];
      for (let column = 0; column < columns; column++) {
        const luma = symbolLuma(state, symbols[column]);
        this.pixels32[at++] = (0xff000000 | luma << 16 | luma << 8 | luma) >>> 0;
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
