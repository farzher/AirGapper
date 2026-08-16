from pathlib import Path

p = Path('receive/main.js')
s = p.read_text()

old = '''const pendingGridLanes = [null, null, null];
function discardPendingGridLane(groupIndex) {
  const pending = pendingGridLanes[groupIndex];
  if (!pending) return;
  pending.direct.frame.close();
  pendingGridLanes[groupIndex] = null;
}
function clearPendingGridLanes() {
  for (let index = 0; index < pendingGridLanes.length; index++) discardPendingGridLane(index);
}
function queuePendingGridLane(groupIndex, source, geometry) {'''
new = '''const pendingGridLanes = [null, null, null];
const lockedLaneCrops = [null, null, null];
let laneCropRecentersTotal = 0;
function discardPendingGridLane(groupIndex) {
  const pending = pendingGridLanes[groupIndex];
  if (!pending) return;
  pending.direct.frame.close();
  pendingGridLanes[groupIndex] = null;
}
function clearLockedLaneCrops() {
  lockedLaneCrops.fill(null);
  laneCropRecentersTotal = 0;
}
function clearPendingGridLanes() {
  for (let index = 0; index < pendingGridLanes.length; index++) discardPendingGridLane(index);
  clearLockedLaneCrops();
}
function stableLockedLaneCrop(groupIndex, key, laneCount, vw, vh, minX, minY, maxX, maxY, typicalEdge) {
  const cropQuantum = 16;
  const guard = Math.max(8, Math.round(typicalEdge * 0.06));
  const pad = Math.max(16, Math.round(typicalEdge * 0.24));
  const current = lockedLaneCrops[groupIndex];
  if (current && current.key === key && current.laneCount === laneCount && current.vw === vw && current.vh === vh) {
    const leftGuard = current.x === 0 ? 0 : guard;
    const topGuard = current.y === 0 ? 0 : guard;
    const rightGuard = current.x + current.w === vw ? 0 : guard;
    const bottomGuard = current.y + current.h === vh ? 0 : guard;
    if (
      minX >= current.x + leftGuard && minY >= current.y + topGuard &&
      maxX <= current.x + current.w - rightGuard &&
      maxY <= current.y + current.h - bottomGuard
    ) return current;
  }
  const x = Math.max(0, Math.floor((minX - pad) / cropQuantum) * cropQuantum);
  const y = Math.max(0, Math.floor((minY - pad) / cropQuantum) * cropQuantum);
  const right = Math.min(vw, Math.ceil((maxX + pad) / cropQuantum) * cropQuantum);
  const bottom = Math.min(vh, Math.ceil((maxY + pad) / cropQuantum) * cropQuantum);
  const next = { key, laneCount, vw, vh, x, y, w: right - x, h: bottom - y };
  if (!current || current.x !== next.x || current.y !== next.y || current.w !== next.w || current.h !== next.h || current.key !== key)
    laneCropRecentersTotal++;
  lockedLaneCrops[groupIndex] = next;
  return next;
}
function queuePendingGridLane(groupIndex, source, geometry) {'''
if old not in s:
    raise SystemExit('pending lane block not found')
s = s.replace(old, new, 1)

old = '''      const typicalEdge = Math.max(...group.regions.map((region) => Math.max(region.w, region.h)));
      const worstMisses = Math.max(...group.regions.map((region) => region.consecutiveMisses));
      const pad = Math.max(8, Math.round(typicalEdge * (0.08 + Math.min(0.16, worstMisses * 0.03))));
      const cropQuantum = 16;
      const x = Math.max(0, Math.floor((minX - pad) / cropQuantum) * cropQuantum);
      const y = Math.max(0, Math.floor((minY - pad) / cropQuantum) * cropQuantum);
      const right = Math.min(vw, Math.ceil((maxX + pad) / cropQuantum) * cropQuantum);
      const bottom = Math.min(vh, Math.ceil((maxY + pad) / cropQuantum) * cropQuantum);
      const w = right - x;
      const h = bottom - y;'''
new = '''      const typicalEdge = Math.max(...group.regions.map((region) => Math.max(region.w, region.h)));
      const cropKey = `${lockedLayout.id}:${group.tracks.map((track) => track.slot).join(",")}`;
      const stableCrop = stableLockedLaneCrop(
        groupIndex, cropKey, laneCount, vw, vh, minX, minY, maxX, maxY, typicalEdge
      );
      const { x, y, w, h } = stableCrop;'''
if old not in s:
    raise SystemExit('dynamic lane crop block not found')
s = s.replace(old, new, 1)

old = '''`Pressure worker-busy ${workerBusyEventRate.toFixed(1)}/s · lane replacements ${(pendingLaneReplaceTimes.length / (STATS_WINDOW_MS / 1e3)).toFixed(1)}/s · avg job ${averageJobMs.toFixed(1)}ms · native ${averageNativeMs.toFixed(1)}ms · copy ${averageCopyMs.toFixed(1)}ms`,'''
new = '''`Pressure worker-busy ${workerBusyEventRate.toFixed(1)}/s · lane replacements ${(pendingLaneReplaceTimes.length / (STATS_WINDOW_MS / 1e3)).toFixed(1)}/s · crop recenters ${laneCropRecentersTotal} · avg job ${averageJobMs.toFixed(1)}ms · native ${averageNativeMs.toFixed(1)}ms · copy ${averageCopyMs.toFixed(1)}ms`,'''
if old not in s:
    raise SystemExit('pressure diagnostics line not found')
s = s.replace(old, new, 1)

s = s.replace('v0.5.81', 'v0.5.82')
p.write_text(s)

for name in ('index.html', 'main.js'):
    q = Path(name)
    t = q.read_text()
    if 'v0.5.81' not in t:
        raise SystemExit(f'v0.5.81 missing from {name}')
    q.write_text(t.replace('v0.5.81', 'v0.5.82'))

q = Path('sw.js')
t = q.read_text()
if 'airgapper-static-js-v44' not in t:
    raise SystemExit('service worker cache v44 missing')
q.write_text(t.replace('airgapper-static-js-v44', 'airgapper-static-js-v45'))
