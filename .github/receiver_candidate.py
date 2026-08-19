from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected exactly one match, found {count}: {old[:100]!r}")
    p.write_text(text.replace(old, new, 1))


# Version/cache bump.
replace_once("main.js", 'const APP_BUILD = "v0.5.312";', 'const APP_BUILD = "v0.5.313";')
replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.312";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.313";')
replace_once("send/main.js", 'const SEND_RUNTIME_BUILD = "v0.5.312";', 'const SEND_RUNTIME_BUILD = "v0.5.313";')
replace_once("index.html", '<span class="brand">AirGapper <span class="app-version">v0.5.310</span></span>', '<span class="brand">AirGapper <span class="app-version">v0.5.313</span></span>')
replace_once("index.html", '<script type="module" src="./main.js?build=v0.5.310"></script>', '<script type="module" src="./main.js?build=v0.5.313"></script>')
replace_once("sw.js", 'const CACHE = "airgapper-static-js-v260";', 'const CACHE = "airgapper-static-js-v261";')

# Expose an explicit unlimited mode. Auto remains adaptive; manual numeric
# limits remain hard caps. Unlimited is intentionally distinguishable from Auto
# even though both have no numeric ceiling.
replace_once(
    "receive/main.js",
    '''const TRACKS_PER_FRAME_KEY = "airgapper:tracks-per-frame:v1";
function selectedTracksPerFrameLimit() {
  const value = decodeTracksPerFrame?.value;
  if (!value || value === "auto") return Infinity;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(128, Math.trunc(parsed))) : Infinity;
}''',
    '''const TRACKS_PER_FRAME_KEY = "airgapper:tracks-per-frame:v1";
function tracksPerFrameMode() {
  return decodeTracksPerFrame?.value || "auto";
}
function unlimitedTracksPerFrame() {
  return tracksPerFrameMode() === "all";
}
function selectedTracksPerFrameLimit() {
  const value = tracksPerFrameMode();
  if (value === "auto" || value === "all") return Infinity;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(SLOT_METRIC_COUNT, Math.trunc(parsed))) : Infinity;
}'''
)

# Unlimited bypasses the adaptive track-budget selector entirely.
replace_once(
    "receive/main.js",
    '''function selectTrackedRegionsForBudget(candidates, sourceSequence, now) {
  if (candidates.length <= 1 || autoOpticsMeasurementSlots?.size || strictHotPathActive()) {''',
    '''function selectTrackedRegionsForBudget(candidates, sourceSequence, now) {
  if (candidates.length <= 1 || autoOpticsMeasurementSlots?.size || strictHotPathActive() || unlimitedTracksPerFrame()) {'''
)

# v0.5.312 widened the protocol/lattice/guided decoder to 128 slots, but the
# live scheduler still silently truncated its candidate wall to the first 32.
# Keep only the real experimental 128-slot ceiling.
replace_once(
    "receive/main.js",
    '''  const allBatchCandidates = (gridLattice.active ? visibleGridSlots.filter(isGridDecodeCandidate) : regions.filter((region) => region.observed && region.decoded)).filter((region) => region.quad && region.dim && validTrackedQuad(region, vw, vh)).slice(0, 32);''',
    '''  const allBatchCandidates = (gridLattice.active ? visibleGridSlots.filter(isGridDecodeCandidate) : regions.filter((region) => region.observed && region.decoded)).filter((region) => region.quad && region.dim && validTrackedQuad(region, vw, vh)).slice(0, SLOT_METRIC_COUNT);'''
)

# Unlimited is a diagnostic/experimental brute-force mode: do not quietly
# remove weak slots or predicted rolling-shutter slots before budgeting.
replace_once(
    "receive/main.js",
    '''  const adaptiveWeakSlots = gridLattice.active && !autoOpticsMeasurementSlots?.size && adaptiveWeakSlotScheduling(batchCandidates);''',
    '''  const unlimitedTrackedScan = unlimitedTracksPerFrame();
  const adaptiveWeakSlots = gridLattice.active && !unlimitedTrackedScan && !autoOpticsMeasurementSlots?.size && adaptiveWeakSlotScheduling(batchCandidates);'''
)
replace_once(
    "receive/main.js",
    '''  batchRegions = batchRegions.filter((region) => shouldScheduleTemporalBandSlot(region, source.sequence));''',
    '''  if (!unlimitedTrackedScan)
    batchRegions = batchRegions.filter((region) => shouldScheduleTemporalBandSlot(region, source.sequence));'''
)

# Diagnostics must describe the actual Unlimited scheduling rather than
# mislabeling it as Auto merely because both use Infinity as their numeric cap.
replace_once(
    "receive/main.js",
    '''  const diagnosticAdaptiveWeak = adaptiveWeakSlotScheduling(diagnosticCandidates);''',
    '''  const diagnosticAdaptiveWeak = !unlimitedTracksPerFrame() && adaptiveWeakSlotScheduling(diagnosticCandidates);'''
)
replace_once(
    "receive/main.js",
    '''  const configuredTrackLimit = selectedTracksPerFrameLimit();
  const diagnosticTrackBudget = Math.min(
    diagnosticCandidates.length,
    Number.isFinite(configuredTrackLimit) ? configuredTrackLimit : Math.max(1, lastTrackBudgetSelected || diagnosticCandidates.length)
  );''',
    '''  const configuredTrackLimit = selectedTracksPerFrameLimit();
  const diagnosticTrackBudget = Math.min(
    diagnosticCandidates.length,
    unlimitedTracksPerFrame()
      ? diagnosticCandidates.length
      : Number.isFinite(configuredTrackLimit) ? configuredTrackLimit : Math.max(1, lastTrackBudgetSelected || diagnosticCandidates.length)
  );'''
)
replace_once(
    "receive/main.js",
    '''`Pressure worker-busy ${workerBusyEventRate.toFixed(1)}/s · latest replacements ${(pendingLaneReplaceTimes.length / (STATS_WINDOW_MS / 1e3)).toFixed(1)}/s · repeat skips ${repeatSkipRate.toFixed(1)}/s · crop recenters ${laneCropRecentersTotal} · tracks ${Number.isFinite(selectedTracksPerFrameLimit()) ? `manual ${selectedTracksPerFrameLimit()}` : `auto ${lastTrackBudgetSelected || "—"}/${lastTrackBudgetCandidates || "—"} ${autoTrackBudgetReason}`} · budget drops ${trackBudgetDroppedTracks} · probes ${trackBudgetProbeTracks} · band avoids ${trackBudgetTemporalAvoided} · salvage ${lastGuidedRepairAllowed}/${lastGuidedRepairCandidates} · fences ${guidedRepairTemporalFences} seam/${guidedRepairPressureFences} CPU · avg job ${averageJobMs.toFixed(1)}ms · robust ${averageRobustSearchMs.toFixed(1)}ms/${averageRobustBands.toFixed(1)} bands · guided ${averageGuidedMs.toFixed(1)}ms · native ${averageNativeMs.toFixed(1)}ms · copy ${averageCopyMs.toFixed(1)}ms`,''',
    '''`Pressure worker-busy ${workerBusyEventRate.toFixed(1)}/s · latest replacements ${(pendingLaneReplaceTimes.length / (STATS_WINDOW_MS / 1e3)).toFixed(1)}/s · repeat skips ${repeatSkipRate.toFixed(1)}/s · crop recenters ${laneCropRecentersTotal} · tracks ${unlimitedTracksPerFrame() ? `unlimited ${lastTrackBudgetSelected || "—"}/${lastTrackBudgetCandidates || "—"}` : Number.isFinite(selectedTracksPerFrameLimit()) ? `manual ${selectedTracksPerFrameLimit()}` : `auto ${lastTrackBudgetSelected || "—"}/${lastTrackBudgetCandidates || "—"} ${autoTrackBudgetReason}`} · budget drops ${trackBudgetDroppedTracks} · probes ${trackBudgetProbeTracks} · band avoids ${trackBudgetTemporalAvoided} · salvage ${lastGuidedRepairAllowed}/${lastGuidedRepairCandidates} · fences ${guidedRepairTemporalFences} seam/${guidedRepairPressureFences} CPU · avg job ${averageJobMs.toFixed(1)}ms · robust ${averageRobustSearchMs.toFixed(1)}ms/${averageRobustBands.toFixed(1)} bands · guided ${averageGuidedMs.toFixed(1)}ms · native ${averageNativeMs.toFixed(1)}ms · copy ${averageCopyMs.toFixed(1)}ms`,'''
)

# Receiver developer control. Put Unlimited directly after Auto; saved values
# continue to restore normally through the existing localStorage path.
replace_once(
    "index.html",
    '''<select id="decode-tracks-per-frame"><option value="auto" selected>Auto</option><option value="32">32</option>''',
    '''<select id="decode-tracks-per-frame"><option value="auto" selected>Auto</option><option value="all">Unlimited</option><option value="32">32</option>'''
)
