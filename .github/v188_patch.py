from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"replacement not found in {path}: {old[:160]!r}")
    p.write_text(s.replace(old, new, count))


replace("index.html", "v0.5.187", "v0.5.188")
replace("main.js", 'const APP_BUILD = "v0.5.187";', 'const APP_BUILD = "v0.5.188";')
replace("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.187";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.188";')
replace("sw.js", 'const CACHE = "airgapper-static-js-v149";', 'const CACHE = "airgapper-static-js-v150";')

p = Path("receive/main.js")
s = p.read_text()

anchor = '''function formatSlotMetric(slot) {'''
insert = '''const CPU_TRACK_BUDGET_WINDOW_MS = 900;
const CPU_TRACK_BUDGET_MIN_SAMPLES = 6;
const CPU_TRACK_BUDGET_HEADROOM = 0.90;
const CPU_TRACK_BUDGET_MIN_FRACTION = 0.55;
let cpuTrackBudgetActive = false;
let cpuTrackBudget = 0;
let cpuTrackBudgetCandidates = 0;
let cpuTrackWindowCount = 1;
function cpuBudgetTrackedRegions(candidates, sourceSequence, now) {
  cpuTrackBudgetActive = false;
  cpuTrackBudget = candidates.length;
  cpuTrackBudgetCandidates = candidates.length;
  cpuTrackWindowCount = 1;
  if (strictHotPathActive() || replayRunning || optimizerPipelineActive ||
      ["tuning", "fine", "rescue", "settling"].includes(autoOpticsRuntimeState) ||
      candidates.length < 8 || pool.size < 2) return candidates;

  const costs = [];
  const cutoff = now - CPU_TRACK_BUDGET_WINDOW_MS;
  for (let i = hotJobCompletionSamples.length - 1; i >= 0; i--) {
    const sample = hotJobCompletionSamples[i];
    if (sample.at <= cutoff) break;
    if (sample.full || !(sample.tracks >= 4) || !(sample.latencyMs > 0)) continue;
    costs.push(sample.latencyMs / sample.tracks);
  }
  if (costs.length < CPU_TRACK_BUDGET_MIN_SAMPLES) return candidates;
  costs.sort((a, b) => a - b);
  const msPerTrack = costs[costs.length >> 1];
  if (!(msPerTrack > 0)) return candidates;

  const settings = stream?.getVideoTracks()[0]?.getSettings?.() ?? {};
  const fps = Math.max(12, Math.min(60, Number(settings.frameRate) || 30));
  const targetJobMs = pool.size * 1000 / fps * CPU_TRACK_BUDGET_HEADROOM;
  const minimum = Math.min(candidates.length, Math.max(6, Math.ceil(candidates.length * CPU_TRACK_BUDGET_MIN_FRACTION)));
  const budget = Math.max(minimum, Math.min(candidates.length, Math.floor(targetJobMs / msPerTrack)));
  if (budget >= candidates.length - 1) return candidates;

  const located = candidates.map((region) => {
    const bounds = trackedQuadBounds(region.quad);
    return {
      region,
      x: bounds ? (bounds.left + bounds.right) * 0.5 : region.x + region.w * 0.5,
      y: bounds ? (bounds.top + bounds.bottom) * 0.5 : region.y + region.h * 0.5
    };
  });
  const xs = located.map((item) => item.x);
  const ys = located.map((item) => item.y);
  const vertical = Math.max(...ys) - Math.min(...ys) >= Math.max(...xs) - Math.min(...xs);
  located.sort((a, b) => vertical ? a.y - b.y || a.x - b.x : a.x - b.x || a.y - b.y);

  const windows = Math.max(2, Math.ceil(candidates.length / budget));
  const sequence = Number.isFinite(Number(sourceSequence)) ? Math.abs(Math.trunc(Number(sourceSequence))) : cropRotate;
  const windowIndex = sequence % windows;
  const maxStart = candidates.length - budget;
  const start = windows <= 1 ? 0 : Math.round(maxStart * windowIndex / (windows - 1));
  cpuTrackBudgetActive = true;
  cpuTrackBudget = budget;
  cpuTrackWindowCount = windows;
  return located.slice(start, start + budget).map((item) => item.region);
}
function formatSlotMetric(slot) {'''
if anchor not in s:
    raise SystemExit("slot metric anchor missing")
s = s.replace(anchor, insert, 1)

old = '''  const adaptiveWeakSlots = gridLattice.active && adaptiveWeakSlotScheduling(batchCandidates);
  const batchRegions = adaptiveWeakSlots
    ? batchCandidates.filter((region) => shouldScheduleAdaptiveSlot(region, source.sequence, true))
    : batchCandidates;
  const batchTracks = batchRegions.map((region) => ({'''
new = '''  const adaptiveWeakSlots = gridLattice.active && adaptiveWeakSlotScheduling(batchCandidates);
  const weakFilteredRegions = adaptiveWeakSlots
    ? batchCandidates.filter((region) => shouldScheduleAdaptiveSlot(region, source.sequence, true))
    : batchCandidates;
  const batchRegions = gridLattice.active
    ? cpuBudgetTrackedRegions(weakFilteredRegions, source.sequence, now)
    : weakFilteredRegions;
  const batchTracks = batchRegions.map((region) => ({'''
if old not in s:
    raise SystemExit("batch scheduling anchor missing")
s = s.replace(old, new, 1)

old = '''    `Pressure worker-busy ${workerBusyEventRate.toFixed(1)}/s · latest replacements ${(pendingLaneReplaceTimes.length / (STATS_WINDOW_MS / 1e3)).toFixed(1)}/s · repeat skips ${repeatSkipRate.toFixed(1)}/s · crop recenters ${laneCropRecentersTotal} · avg job ${averageJobMs.toFixed(1)}ms · robust ${averageRobustSearchMs.toFixed(1)}ms/${averageRobustBands.toFixed(1)} bands · guided ${averageGuidedMs.toFixed(1)}ms · native ${averageNativeMs.toFixed(1)}ms · copy ${averageCopyMs.toFixed(1)}ms`,'''
new = '''    `Pressure worker-busy ${workerBusyEventRate.toFixed(1)}/s · latest replacements ${(pendingLaneReplaceTimes.length / (STATS_WINDOW_MS / 1e3)).toFixed(1)}/s · repeat skips ${repeatSkipRate.toFixed(1)}/s · crop recenters ${laneCropRecentersTotal} · track budget ${cpuTrackBudgetActive ? `${cpuTrackBudget}/${cpuTrackBudgetCandidates} · ${cpuTrackWindowCount} spatial bands` : "full"} · avg job ${averageJobMs.toFixed(1)}ms · robust ${averageRobustSearchMs.toFixed(1)}ms/${averageRobustBands.toFixed(1)} bands · guided ${averageGuidedMs.toFixed(1)}ms · native ${averageNativeMs.toFixed(1)}ms · copy ${averageCopyMs.toFixed(1)}ms`,'''
if old not in s:
    raise SystemExit("pressure diagnostic anchor missing")
s = s.replace(old, new, 1)

old = '''  activeDecodeBudget = 0;
  expectedRegions = 0;'''
new = '''  activeDecodeBudget = 0;
  cpuTrackBudgetActive = false;
  cpuTrackBudget = 0;
  cpuTrackBudgetCandidates = 0;
  cpuTrackWindowCount = 1;
  expectedRegions = 0;'''
if old not in s:
    raise SystemExit("reset budget anchor missing")
s = s.replace(old, new, 1)

p.write_text(s)
