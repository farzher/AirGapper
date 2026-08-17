from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"replacement not found in {path}: {old[:180]!r}")
    p.write_text(s.replace(old, new, count))


replace("index.html", "v0.5.189", "v0.5.190")
replace("main.js", 'const APP_BUILD = "v0.5.189";', 'const APP_BUILD = "v0.5.190";')
replace("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.189";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.190";')
replace("sw.js", 'const CACHE = "airgapper-static-js-v151";', 'const CACHE = "airgapper-static-js-v152";')

p = Path("receive/main.js")
s = p.read_text()

# Remove the unproven v188 CPU spatial-band scheduler completely. The user's
# improvement came from physically moving closer (more pixels/module), which a
# scheduling-only crop cannot reproduce. Keep the proven weak-slot scheduler.
start = s.find('const CPU_TRACK_BUDGET_WINDOW_MS = 900;')
end = s.find('function formatSlotMetric(slot) {', start)
if start < 0 or end < 0: raise SystemExit("v188 CPU budget block missing")
s = s[:start] + s[end:]

old = '''  const adaptiveWeakSlots = gridLattice.active && adaptiveWeakSlotScheduling(batchCandidates);
  const weakFilteredRegions = adaptiveWeakSlots
    ? batchCandidates.filter((region) => shouldScheduleAdaptiveSlot(region, source.sequence, true))
    : batchCandidates;
  const batchRegions = gridLattice.active
    ? cpuBudgetTrackedRegions(weakFilteredRegions, source.sequence, now)
    : weakFilteredRegions;
  const batchTracks = batchRegions.map((region) => ({'''
new = '''  const adaptiveWeakSlots = gridLattice.active && adaptiveWeakSlotScheduling(batchCandidates);
  const batchRegions = adaptiveWeakSlots
    ? batchCandidates.filter((region) => shouldScheduleAdaptiveSlot(region, source.sequence, true))
    : batchCandidates;
  const batchTracks = batchRegions.map((region) => ({'''
if old not in s: raise SystemExit("v188 batch budget integration missing")
s = s.replace(old, new, 1)

old = '''    `Pressure worker-busy ${workerBusyEventRate.toFixed(1)}/s · latest replacements ${(pendingLaneReplaceTimes.length / (STATS_WINDOW_MS / 1e3)).toFixed(1)}/s · repeat skips ${repeatSkipRate.toFixed(1)}/s · crop recenters ${laneCropRecentersTotal} · track budget ${cpuTrackBudgetActive ? `${cpuTrackBudget}/${cpuTrackBudgetCandidates} · ${cpuTrackWindowCount} spatial bands` : "full"} · avg job ${averageJobMs.toFixed(1)}ms · robust ${averageRobustSearchMs.toFixed(1)}ms/${averageRobustBands.toFixed(1)} bands · guided ${averageGuidedMs.toFixed(1)}ms · native ${averageNativeMs.toFixed(1)}ms · copy ${averageCopyMs.toFixed(1)}ms`,'''
new = '''    `Pressure worker-busy ${workerBusyEventRate.toFixed(1)}/s · latest replacements ${(pendingLaneReplaceTimes.length / (STATS_WINDOW_MS / 1e3)).toFixed(1)}/s · repeat skips ${repeatSkipRate.toFixed(1)}/s · crop recenters ${laneCropRecentersTotal} · avg job ${averageJobMs.toFixed(1)}ms · robust ${averageRobustSearchMs.toFixed(1)}ms/${averageRobustBands.toFixed(1)} bands · guided ${averageGuidedMs.toFixed(1)}ms · native ${averageNativeMs.toFixed(1)}ms · copy ${averageCopyMs.toFixed(1)}ms`,'''
if old not in s: raise SystemExit("v188 pressure diagnostic missing")
s = s.replace(old, new, 1)

old = '''  activeDecodeBudget = 0;
  cpuTrackBudgetActive = false;
  cpuTrackBudget = 0;
  cpuTrackBudgetCandidates = 0;
  cpuTrackWindowCount = 1;
  expectedRegions = 0;'''
new = '''  activeDecodeBudget = 0;
  expectedRegions = 0;'''
if old not in s: raise SystemExit("v188 reset state missing")
s = s.replace(old, new, 1)

# Auto Optics memory should remember a camera-independent *relationship* to the
# current scene's hardware AE, not just an absolute ISO that goes stale when
# screen/ambient brightness changes.
old = '''const AUTO_OPTICS_MEMORY_KEY = "airgapper:auto-optics-memory:v1";
// A relative winner is meaningless when the whole local ISO neighborhood is'''
new = '''const AUTO_OPTICS_MEMORY_KEY = "airgapper:auto-optics-memory:v1";
const AUTO_OPTICS_MEMORY_FRESH_MS = 12 * 60 * 60 * 1000;
const AUTO_OPTICS_MEMORY_MIN_SCALE = 0.25;
const AUTO_OPTICS_MEMORY_MAX_SCALE = 2.25;
// A relative winner is meaningless when the whole local ISO neighborhood is'''
if old not in s: raise SystemExit("auto optics memory constants anchor missing")
s = s.replace(old, new, 1)

# More proactive evidence-driven recalibration, still with zero camera writes
# while the held winner remains healthy.
s = s.replace('const AUTO_OPTICS_HOLD_DEGRADE_RATIO = 0.55;', 'const AUTO_OPTICS_HOLD_DEGRADE_RATIO = 0.70;', 1)

old = '''function loadAutomaticOpticsMemory(track, exposure, isoRange, cap) {
  const saved = readAutomaticOpticsMemory(track);
  if (!saved) return void 0;
  const adjusted = saved.iso * saved.exposure / Math.max(1e-6, exposure);
  return quantizeCameraRange(Math.min(cap, Math.max(isoRange.min, adjusted)), isoRange);
}
function rememberAutomaticOptics(track, exposure, iso, score = 0) {
  if (!Number.isFinite(exposure) || !Number.isFinite(iso) || exposure <= 0 || iso <= 0) return;
  try {
    const all = JSON.parse(localStorage.getItem(AUTO_OPTICS_MEMORY_KEY) || "{}");
    all[autoOpticsMemoryKey(track)] = {
      exposure,
      iso,
      score: Number.isFinite(score) ? score : 0,
      at: Date.now()
    };
    const entries = Object.entries(all).sort((a, b) => Number(b[1]?.at || 0) - Number(a[1]?.at || 0)).slice(0, 8);
    localStorage.setItem(AUTO_OPTICS_MEMORY_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
  }
}'''
new = '''function usableAutomaticOpticsMemory(track) {
  const saved = readAutomaticOpticsMemory(track);
  if (!saved || Date.now() - Number(saved.at || 0) > AUTO_OPTICS_MEMORY_FRESH_MS) return void 0;
  const scale = Number(saved.lightScale);
  if (Number.isFinite(scale) && scale >= AUTO_OPTICS_MEMORY_MIN_SCALE && scale <= AUTO_OPTICS_MEMORY_MAX_SCALE)
    return saved;
  // Old v1 entries remain useful for post-lock comparison, but never get the
  // high-confidence cold-start treatment because they lack an AE-relative scale.
  return saved;
}
function loadAutomaticOpticsMemory(track, exposure, isoRange, cap, aeProduct) {
  const saved = usableAutomaticOpticsMemory(track);
  if (!saved) return void 0;
  const scale = Number(saved.lightScale);
  const adjusted = Number.isFinite(scale) && Number.isFinite(aeProduct) && aeProduct > 0
    ? aeProduct * scale / Math.max(1e-6, exposure)
    : saved.iso * saved.exposure / Math.max(1e-6, exposure);
  return quantizeCameraRange(Math.min(cap, Math.max(isoRange.min, adjusted)), isoRange);
}
function rememberAutomaticOptics(track, exposure, iso, score = 0, yieldRate = 0, aeProduct = 0) {
  if (!Number.isFinite(exposure) || !Number.isFinite(iso) || exposure <= 0 || iso <= 0) return;
  const lightScale = Number.isFinite(aeProduct) && aeProduct > 0 ? exposure * iso / aeProduct : void 0;
  try {
    const all = JSON.parse(localStorage.getItem(AUTO_OPTICS_MEMORY_KEY) || "{}");
    all[autoOpticsMemoryKey(track)] = {
      exposure,
      iso,
      score: Number.isFinite(score) ? score : 0,
      yieldRate: Number.isFinite(yieldRate) ? yieldRate : 0,
      ...(Number.isFinite(lightScale) ? { lightScale } : {}),
      at: Date.now()
    };
    const entries = Object.entries(all).sort((a, b) => Number(b[1]?.at || 0) - Number(a[1]?.at || 0)).slice(0, 8);
    localStorage.setItem(AUTO_OPTICS_MEMORY_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
  }
}'''
if old not in s: raise SystemExit("memory functions block missing")
s = s.replace(old, new, 1)

# Post-lock tuning reuses the remembered AE-relative light scale for today's
# neutral AE measurement instead of blindly reusing yesterday's absolute ISO.
old = '''    const rememberedIso = loadAutomaticOpticsMemory(track, exposure, isoRange, maxAutoIso);
    const tuned = await tuneAutomaticQrIso(track, exposure, iso, isoRange, maxAutoIso, rememberedIso);'''
new = '''    const rememberedIso = loadAutomaticOpticsMemory(track, exposure, isoRange, maxAutoIso, aeExposureProduct);
    const tuned = await tuneAutomaticQrIso(track, exposure, iso, isoRange, maxAutoIso, rememberedIso);'''
if old not in s: raise SystemExit("post-lock memory load missing")
s = s.replace(old, new, 1)

# Save memory before clearing the neutral AE baseline, including measured yield
# and the winner's exposure product relative to that neutral AE product.
old = '''    autoOpticsRuntimeState = "manual";
    autoOpticsAeBaseline = void 0;
    autoOpticsHoldSample = autoOpticsPipelineSnapshot();
    autoOpticsHoldCollapseSince = 0;
    autoOpticsHeldYield = tuned.best?.yieldRate ?? 0;
    // A proven winner is held absolutely still. Recalibration is evidence-driven
    // by the live-yield watchdog below, not by periodic brightness probes.
    autoOpticsRetryAt = Infinity;
    const tunedExposure = track.getSettings().exposureTime ?? exposure;
    const tunedIso = track.getSettings().iso ?? tuned.iso ?? iso;
    if (tuned.best?.valid && tuned.best.yieldRate >= AUTO_OPTICS_MEMORY_MIN_YIELD)
      rememberAutomaticOptics(track, tunedExposure, tunedIso, tuned.best.score);
    focusController.adoptAutomaticCameraState("automatic QR exposure tuned against live tracked decode yield");'''
new = '''    autoOpticsRuntimeState = "manual";
    autoOpticsHoldSample = autoOpticsPipelineSnapshot();
    autoOpticsHoldCollapseSince = 0;
    autoOpticsHeldYield = tuned.best?.yieldRate ?? 0;
    // A proven winner is held absolutely still. Recalibration is evidence-driven
    // by the live-yield watchdog below, not by periodic brightness probes.
    autoOpticsRetryAt = Infinity;
    const tunedExposure = track.getSettings().exposureTime ?? exposure;
    const tunedIso = track.getSettings().iso ?? tuned.iso ?? iso;
    if (tuned.best?.valid && tuned.best.yieldRate >= AUTO_OPTICS_MEMORY_MIN_YIELD)
      rememberAutomaticOptics(track, tunedExposure, tunedIso, tuned.best.score, tuned.best.yieldRate, aeExposureProduct);
    autoOpticsAeBaseline = void 0;
    focusController.adoptAutomaticCameraState("automatic QR exposure tuned against live tracked decode yield");'''
if old not in s: raise SystemExit("memory save/clear ordering missing")
s = s.replace(old, new, 1)

# Cold acquisition gets one high-value remembered candidate before the bounded
# AE-relative ladder. It is only trusted if recent, AE-relative, and previously
# measured healthy. Failure immediately falls through to the ordinary search.
old = '''  const aeProduct = aeBaseline.exposure * aeBaseline.iso;
  const baseExposure = quantizeCameraRange(Math.min(aeBaseline.exposure, motionSafeExposure), exposureRange);
  const scales = [AUTO_QR_LIGHT_SCALE, 1, Math.pow(2, 0.7), 2];
  const candidates = [];
  const seen = new Set();'''
new = '''  const aeProduct = aeBaseline.exposure * aeBaseline.iso;
  const baseExposure = quantizeCameraRange(Math.min(aeBaseline.exposure, motionSafeExposure), exposureRange);
  const memory = usableAutomaticOpticsMemory(track);
  const memoryScale = Number(memory?.lightScale);
  const memoryHealthy = Number(memory?.yieldRate || 0) >= AUTO_OPTICS_MEMORY_MIN_YIELD &&
    Number.isFinite(memoryScale) && memoryScale >= AUTO_OPTICS_MEMORY_MIN_SCALE && memoryScale <= AUTO_OPTICS_MEMORY_MAX_SCALE;
  const scales = [
    ...(memoryHealthy ? [memoryScale] : []),
    AUTO_QR_LIGHT_SCALE,
    1,
    Math.pow(2, 0.7),
    2
  ];
  const candidates = [];
  const seen = new Set();'''
if old not in s: raise SystemExit("cold search scales anchor missing")
s = s.replace(old, new, 1)

old = '''      autoOpticsTuneSummary = `cold search ${index + 1}/${candidates.length} · ${formatExposureMs(candidate.exposure)} · ISO ${Math.round(candidate.iso)} · ${Math.log2(candidate.scale).toFixed(1)}EV vs AE`;'''
new = '''      const remembered = memoryHealthy && Math.abs(candidate.scale - memoryScale) < 1e-6;
      autoOpticsTuneSummary = `cold search ${index + 1}/${candidates.length}${remembered ? " · recent winner" : ""} · ${formatExposureMs(candidate.exposure)} · ISO ${Math.round(candidate.iso)} · ${Math.log2(candidate.scale).toFixed(1)}EV vs AE`;'''
if old not in s: raise SystemExit("cold search summary anchor missing")
s = s.replace(old, new, 1)

# Make the stable-hold diagnostic expose the baseline it is defending.
old = '''    `AutoOptics ${automaticOptics ? `${autoOpticsRuntimeState}${autoOpticsRuntimeState === "manual" ? " · adaptive hold" : autoOpticsRuntimeState === "ae" ? " · bootstrap AE" : autoOpticsRuntimeState === "tuning" ? " · live ISO search" : ""}${autoOpticsTuneSummary ? ` · ${autoOpticsTuneSummary}` : ""}` : "off"}`,'''
new = '''    `AutoOptics ${automaticOptics ? `${autoOpticsRuntimeState}${autoOpticsRuntimeState === "manual" ? ` · hold ${(autoOpticsHeldYield * 100).toFixed(0)}%` : autoOpticsRuntimeState === "ae" ? " · bootstrap AE" : autoOpticsRuntimeState === "tuning" ? " · live ISO search" : ""}${autoOpticsTuneSummary ? ` · ${autoOpticsTuneSummary}` : ""}` : "off"}`,'''
if old not in s: raise SystemExit("AutoOptics hold diagnostic missing")
s = s.replace(old, new, 1)

p.write_text(s)
