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
export { buildAirGridState, renderAirGridState };
