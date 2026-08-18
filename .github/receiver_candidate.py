from pathlib import Path

def rep(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"missing anchor {path}: {old[:140]!r}")
    p.write_text(s.replace(old, new, count))

# Version/cache.
for path, old, new in [
    ('receive/main.js','const RECEIVER_RUNTIME_BUILD = "v0.5.303";','const RECEIVER_RUNTIME_BUILD = "v0.5.304";'),
    ('send/main.js','const SEND_RUNTIME_BUILD = "v0.5.303";','const SEND_RUNTIME_BUILD = "v0.5.304";'),
    ('main.js','const APP_BUILD = "v0.5.303";','const APP_BUILD = "v0.5.304";'),
    ('index.html','main.js?build=v0.5.303','main.js?build=v0.5.304'),
    ('index.html','<span class="brand">AirGapper <span class="app-version">v0.5.303</span></span>','<span class="brand">AirGapper <span class="app-version">v0.5.304</span></span>'),
    ('sw.js','airgapper-static-js-v251','airgapper-static-js-v252'),
]: rep(path, old, new)

# Sender UI: explicit temporal presentation pattern. Default stays current v303
# behavior so this build is an A/B/C test rather than a silent policy switch.
rep('index.html',
'''            <label><span>Layout</span><select id="cfg-layout"><option value="auto">Auto</option><option value="single" selected>1:1</option><option value="one-two">1:2</option><option value="two-two">2:2</option><option value="two-three">2:3</option><option value="four-three">3:4</option><option value="three-five">3:5</option><option value="three-six">3:6</option><option value="four-six">4:6</option><option value="four-seven">4:7</option><option value="four-eight">4:8</option></select></label>
            <label><span>Orientation</span>''',
'''            <label><span>Layout</span><select id="cfg-layout"><option value="auto">Auto</option><option value="single" selected>1:1</option><option value="one-two">1:2</option><option value="two-two">2:2</option><option value="two-three">2:3</option><option value="four-three">3:4</option><option value="three-five">3:5</option><option value="three-six">3:6</option><option value="four-six">4:6</option><option value="four-seven">4:7</option><option value="four-eight">4:8</option></select></label>
            <label><span>Update</span><select id="cfg-update-pattern"><option value="synchronous">Synchronous</option><option value="fixed">Fixed phased</option><option value="dispersed" selected>Dispersed</option></select></label>
            <label><span>Orientation</span>''')

send = Path('send/main.js').read_text()
old = '''const cfgScaling = document.getElementById("cfg-scaling");
const cfgLayout = document.getElementById("cfg-layout");
const cfgOrientation = document.getElementById("cfg-orientation");'''
new = '''const cfgScaling = document.getElementById("cfg-scaling");
const cfgLayout = document.getElementById("cfg-layout");
const cfgUpdatePattern = document.getElementById("cfg-update-pattern");
const cfgOrientation = document.getElementById("cfg-orientation");'''
if old not in send: raise SystemExit('missing sender controls anchor')
send = send.replace(old, new, 1)

old = '''function selectedFps() {
  const value = cfgFps.value === "custom" ? Number(cfgFpsCustom.value) : Number(cfgFps.value);
  return Number.isFinite(value) ? Math.max(1, Math.min(480, Math.round(value))) : 15;
}
function selectFps(fps) {'''
new = '''function selectedFps() {
  const value = cfgFps.value === "custom" ? Number(cfgFpsCustom.value) : Number(cfgFps.value);
  return Number.isFinite(value) ? Math.max(1, Math.min(480, Math.round(value))) : 15;
}
function selectedUpdatePattern() {
  const value = cfgUpdatePattern?.value;
  return value === "synchronous" || value === "fixed" || value === "dispersed" ? value : "dispersed";
}
function selectFps(fps) {'''
if old not in send: raise SystemExit('missing sender selectedFps anchor')
send = send.replace(old, new, 1)

old = '''    if (saved.scaling === "integer" || saved.scaling === "fit") cfgScaling.value = saved.scaling;
    if (saved.layout === "auto" || saved.layout === "single" || saved.layout === "one-two" || saved.layout === "two-two" || saved.layout === "two-three" || saved.layout === "four-three" || saved.layout === "three-five" || saved.layout === "three-six" || saved.layout === "four-six" || saved.layout === "four-seven" || saved.layout === "four-eight") {'''
new = '''    if (saved.scaling === "integer" || saved.scaling === "fit") cfgScaling.value = saved.scaling;
    if (saved.updatePattern === "synchronous" || saved.updatePattern === "fixed" || saved.updatePattern === "dispersed") cfgUpdatePattern.value = saved.updatePattern;
    if (saved.layout === "auto" || saved.layout === "single" || saved.layout === "one-two" || saved.layout === "two-two" || saved.layout === "two-three" || saved.layout === "four-three" || saved.layout === "three-five" || saved.layout === "three-six" || saved.layout === "four-six" || saved.layout === "four-seven" || saved.layout === "four-eight") {'''
if old not in send: raise SystemExit('missing sender restore anchor')
send = send.replace(old, new, 1)

old = '''      sizeLevel: Number(cfgSize.value),
      scaling: cfgScaling.value,
      layout: cfgLayout.value,
      orientation: selectedOrientation()'''
new = '''      sizeLevel: Number(cfgSize.value),
      scaling: cfgScaling.value,
      layout: cfgLayout.value,
      updatePattern: selectedUpdatePattern(),
      orientation: selectedOrientation()'''
if old not in send: raise SystemExit('missing sender save anchor')
send = send.replace(old, new, 1)

old = '''  for (const el of [cfgSize, cfgScaling, cfgLayout, cfgOrientation]) {'''
new = '''  for (const el of [cfgSize, cfgScaling, cfgLayout, cfgUpdatePattern, cfgOrientation]) {'''
if old not in send: raise SystemExit('missing sender settings listener anchor')
send = send.replace(old, new, 1)

old = '''  const { cols: gridCols, rows: gridRows, codes: gridCodes } = resolvedGrid;
  const gridMargin = gridCodes === 1 ? 4 : GRID_MARGIN;
  const temporalOrder = spatiallyDispersedOrder(gridCols, gridRows);
  const phaseStep = temporalPhaseStep(gridCodes);
  const temporalSourceOffset = (pageId, phase) => {
    if (gridCodes <= 1) return 0;
    const rotation = pageId * phaseStep % gridCodes;
    let index = (phase + rotation) % gridCodes;
    if (pageId & 1) index = gridCodes - 1 - index;
    return temporalOrder[index];
  };
  const describeGrid = () => {
    if (!autoGrid || staticStream) return "";
    const fallback = autoGrid.constrained ? "" : " · fallback constraints";
    return `Auto Grid · ${gridCols}×${gridRows} · ${gridCodes} QR · v${transport.qrVersion} · ${formatBytes(transport.frameBytes)}/QR · ${autoGrid.moduleScale.toFixed(2)} display px/module · ${txFps} fps · ${Math.round(autoGrid.refreshHz)} Hz display · ${autoGrid.changesPerRefresh.toFixed(2)} QR changes/refresh · dispersed rotating phases${fallback}`;
  };'''
new = '''  const { cols: gridCols, rows: gridRows, codes: gridCodes } = resolvedGrid;
  const gridMargin = gridCodes === 1 ? 4 : GRID_MARGIN;
  const updatePattern = selectedUpdatePattern();
  const synchronousUpdates = updatePattern === "synchronous";
  const temporalOrder = spatiallyDispersedOrder(gridCols, gridRows);
  const phaseStep = temporalPhaseStep(gridCodes);
  const temporalSourceOffset = (pageId, phase) => {
    if (gridCodes <= 1 || updatePattern === "fixed" || updatePattern === "synchronous") return phase;
    const rotation = pageId * phaseStep % gridCodes;
    let index = (phase + rotation) % gridCodes;
    if (pageId & 1) index = gridCodes - 1 - index;
    return temporalOrder[index];
  };
  const updatePatternLabel = updatePattern === "synchronous" ? "synchronous wall" : updatePattern === "fixed" ? "fixed phased" : "dispersed rotating phases";
  const describeGrid = () => {
    if (staticStream) return "";
    if (!autoGrid) return `Update ${updatePatternLabel}`;
    const fallback = autoGrid.constrained ? "" : " · fallback constraints";
    return `Auto Grid · ${gridCols}×${gridRows} · ${gridCodes} QR · v${transport.qrVersion} · ${formatBytes(transport.frameBytes)}/QR · ${autoGrid.moduleScale.toFixed(2)} display px/module · ${txFps} fps · ${Math.round(autoGrid.refreshHz)} Hz display · ${autoGrid.changesPerRefresh.toFixed(2)} QR changes/refresh · ${updatePatternLabel}${fallback}`;
  };'''
if old not in send: raise SystemExit('missing sender temporal order anchor')
send = send.replace(old, new, 1)

old = '''    let pageInterval = 1e3 / txFps;
    let cellInterval = pageInterval / gridCodes;
    let nextCellAt = 0;
    activeSendFpsSetter = (fps) => {
      pageInterval = 1e3 / Math.max(1, fps);
      cellInterval = pageInterval / gridCodes;'''
new = '''    let pageInterval = 1e3 / txFps;
    let cellInterval = synchronousUpdates ? pageInterval : pageInterval / gridCodes;
    let nextCellAt = 0;
    activeSendFpsSetter = (fps) => {
      pageInterval = 1e3 / Math.max(1, fps);
      cellInterval = synchronousUpdates ? pageInterval : pageInterval / gridCodes;'''
if old not in send: raise SystemExit('missing sender parallel clock anchor')
send = send.replace(old, new, 1)

old = '''      let painted = 0;
      while (currentPage && now + 0.25 >= nextCellAt && painted < gridCodes) {
        try {
          drawPageCell(currentPage, temporalSourceOffset(currentPage.pageId, currentCellOffset));'''
new = '''      if (synchronousUpdates) {
        if (now + 0.25 < nextCellAt) return;
        try {
          // Commit one already-rendered wall in one compositor-facing paint.
          // The physical display scanout may still create one rolling-shutter
          // transition stripe, but JS never creates many independent QR seams.
          drawPage(currentPage);
        } catch (error) {
          closePage(currentPage);
          currentPage = null;
          fail(error);
          return;
        }
        closePage(currentPage);
        currentPage = null;
        currentCellOffset = 0;
        nextPresentPageId++;
        scheduleDispatch();
        nextCellAt += pageInterval;
        // Never repay missed wall frames as a burst of whole-screen changes.
        if (now - nextCellAt > pageInterval) nextCellAt = now + pageInterval;
        return;
      }

      let painted = 0;
      while (currentPage && now + 0.25 >= nextCellAt && painted < gridCodes) {
        try {
          drawPageCell(currentPage, temporalSourceOffset(currentPage.pageId, currentCellOffset));'''
if old not in send: raise SystemExit('missing sender phased paint anchor')
send = send.replace(old, new, 1)

Path('send/main.js').write_text(send)

# Receiver: preserve the existing mature weak-slot scheduler, but recognize a
# short coherent row/column miss band as temporal display/camera damage. Such a
# miss does not poison persistent slot quality, and can be skipped for at most
# one immediately following source frame when completion latency is low enough.
recv = Path('receive/main.js').read_text()
old = '''const SLOT_WEAK_MIN_WALL = 6;
const SLOT_WEAK_MIN_HEALTHY = 4;
const slotAttemptCounts = new Uint32Array(SLOT_METRIC_COUNT);'''
new = '''const SLOT_WEAK_MIN_WALL = 6;
const SLOT_WEAK_MIN_HEALTHY = 4;
const TEMPORAL_BAND_MIN_TRACKS = 6;
const TEMPORAL_BAND_MIN_HITS = 3;
const TEMPORAL_BAND_MIN_MISSES = 2;
const TEMPORAL_BAND_MAX_REPEAT = 3;
const TEMPORAL_BAND_SKIP_SOURCE_FRAMES = 1;
const temporalBandSkipThroughSource = new Int32Array(SLOT_METRIC_COUNT);
temporalBandSkipThroughSource.fill(-1);
let temporalBandDetections = 0;
let temporalBandSkippedTracks = 0;
let temporalBandLastKey = "";
let temporalBandLastSource = -1;
let temporalBandRepeat = 0;
const slotAttemptCounts = new Uint32Array(SLOT_METRIC_COUNT);'''
if old not in recv: raise SystemExit('missing receiver weak-slot constants anchor')
recv = recv.replace(old, new, 1)

# Insert band classifier immediately before adaptive weak scheduling so it can
# use the same slot metric/layout state.
old = '''function adaptiveWeakSlotScheduling(candidates) {'''
new = '''function temporalBandMissSlots(auditMode, completion) {
  const layout = lastGridSnapshot?.layout;
  const sourceSequence = Number(auditMode?.sourceSequence);
  if (!layout || auditMode?.full || auditMode?.autoOpticsProbe || !Number.isFinite(sourceSequence)) return new Set();
  const submitted = [...new Set((auditMode.trackSlots ?? []).map(Number).filter((slot) =>
    Number.isInteger(slot) && slot >= 0 && slot < layout.cols * layout.rows
  ))];
  if (submitted.length < TEMPORAL_BAND_MIN_TRACKS) return new Set();
  const output = new Set((completion.symbols ?? []).map((symbol) => Number(symbol.header?.slotIndex)).filter(Number.isInteger));
  const hits = submitted.filter((slot) => output.has(slot));
  const misses = submitted.filter((slot) => !output.has(slot));
  if (hits.length < TEMPORAL_BAND_MIN_HITS || misses.length < TEMPORAL_BAND_MIN_MISSES || misses.length > submitted.length * 0.45) return new Set();

  const uniqueSorted = (values) => [...new Set(values)].sort((a, b) => a - b);
  const adjacent = (values) => values.length > 0 && values.length <= 2 && values[values.length - 1] - values[0] <= 1;
  const missCols = uniqueSorted(misses.map((slot) => slot % layout.cols));
  const missRows = uniqueSorted(misses.map((slot) => Math.floor(slot / layout.cols)));
  const colSet = new Set(missCols);
  const rowSet = new Set(missRows);
  const columnBand = adjacent(missCols) && hits.some((slot) => !colSet.has(slot % layout.cols));
  const rowBand = adjacent(missRows) && hits.some((slot) => !rowSet.has(Math.floor(slot / layout.cols)));
  if (!columnBand && !rowBand) return new Set();
  const useColumn = columnBand && (!rowBand || missCols.length <= missRows.length);
  const key = `${useColumn ? "c" : "r"}:${(useColumn ? missCols : missRows).join(",")}`;

  if (sourceSequence >= temporalBandLastSource) {
    if (key === temporalBandLastKey && sourceSequence - temporalBandLastSource <= 2) temporalBandRepeat++;
    else temporalBandRepeat = 1;
    temporalBandLastKey = key;
    temporalBandLastSource = sourceSequence;
  }
  // A stripe that stays in the exact same place indefinitely is probably a
  // genuinely weak/occluded region, not a moving temporal seam. Let normal
  // weak-slot learning resume after a few consecutive identical detections.
  if (temporalBandRepeat > TEMPORAL_BAND_MAX_REPEAT) return new Set();

  temporalBandDetections++;
  for (const slot of misses) {
    temporalBandSkipThroughSource[slot] = Math.max(
      temporalBandSkipThroughSource[slot],
      Math.trunc(sourceSequence) + TEMPORAL_BAND_SKIP_SOURCE_FRAMES
    );
  }
  notePipelineEvent("temporal-band", misses.length);
  return new Set(misses);
}
function shouldScheduleTemporalBandSlot(region, sourceSequence) {
  const slot = Number(region.gridSlot);
  const sequence = Number(sourceSequence);
  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_METRIC_COUNT || !Number.isFinite(sequence)) return true;
  if (sequence > temporalBandSkipThroughSource[slot]) return true;
  temporalBandSkippedTracks++;
  return false;
}
function adaptiveWeakSlotScheduling(candidates) {'''
if old not in recv: raise SystemExit('missing receiver adaptive scheduler anchor')
recv = recv.replace(old, new, 1)

old = '''  const attempts = cropAttempts.get(id);
  cropAttempts.delete(id);
  optimizerAttributionComplete(id);
  if (!attempts || completion.repeatSkipped) return;
  for (const attempt of attempts) {'''
new = '''  const attempts = cropAttempts.get(id);
  cropAttempts.delete(id);
  optimizerAttributionComplete(id);
  if (!attempts || completion.repeatSkipped) return;
  const temporalMisses = !auditMode?.autoOpticsProbe ? temporalBandMissSlots(auditMode, completion) : new Set();
  for (const attempt of attempts) {'''
if old not in recv: raise SystemExit('missing receiver completion attempts anchor')
recv = recv.replace(old, new, 1)

old = '''    if (!auditMode?.autoOpticsProbe) {
      if (region.gridSlot !== void 0) noteSlotMetric(region.gridSlot, hit);
      region.decodeConfidence = region.decodeConfidence * 0.82 + Number(hit) * 0.18;
      if (!hit && ((_a = region.lastHitScanId) != null ? _a : -1) <= id) {
        region.consecutiveMisses++;
        if (region.consecutiveMisses >= 3) region.decoded = false;
      }
    }'''
new = '''    if (!auditMode?.autoOpticsProbe) {
      const temporalBandMiss = !hit && temporalMisses.has(Number(region.gridSlot));
      // A coherent rolling-shutter seam is an erasure of this camera frame,
      // not evidence that the physical QR slot is intrinsically weak. Keep
      // successful slots training normally, but quarantine seam misses from
      // the long-lived weak-slot/confidence model.
      if (!temporalBandMiss) {
        if (region.gridSlot !== void 0) noteSlotMetric(region.gridSlot, hit);
        region.decodeConfidence = region.decodeConfidence * 0.82 + Number(hit) * 0.18;
        if (!hit && ((_a = region.lastHitScanId) != null ? _a : -1) <= id) {
          region.consecutiveMisses++;
          if (region.consecutiveMisses >= 3) region.decoded = false;
        }
      }
    }'''
if old not in recv: raise SystemExit('missing receiver completion training anchor')
recv = recv.replace(old, new, 1)

old = '''  let batchRegions = adaptiveWeakSlots
    ? batchCandidates.filter((region) => shouldScheduleAdaptiveSlot(region, source.sequence, true))
    : batchCandidates;

  // Weak-slot throttling is good when a few QRs are genuinely poor, but it can'''
new = '''  let batchRegions = adaptiveWeakSlots
    ? batchCandidates.filter((region) => shouldScheduleAdaptiveSlot(region, source.sequence, true))
    : batchCandidates;
  // If a just-completed tracked frame showed a narrow coherent temporal stripe,
  // avoid spending the immediately following source frame on those same slots.
  // With normal worker latency this often expires before scheduling and costs
  // nothing; on a fast worker it saves work while the stripe is still nearby.
  // The slot automatically re-enters on the next source frame after that.
  batchRegions = batchRegions.filter((region) => shouldScheduleTemporalBandSlot(region, source.sequence));

  // Weak-slot throttling is good when a few QRs are genuinely poor, but it can'''
if old not in recv: raise SystemExit('missing receiver batch scheduler anchor')
recv = recv.replace(old, new, 1)

old = '''`Recovery probes ${geometryRecoveryProbes} · breadth ${geometryBreadthRecoveryProbes} · repair tracks ${geometryCoverageRepairTracks} · assist ${geometryRecoveryAssistUntil > perfNow ? `${Math.max(0, geometryRecoveryAssistUntil - perfNow).toFixed(0)}ms` : "no"} · motion'''
new = '''`Recovery probes ${geometryRecoveryProbes} · breadth ${geometryBreadthRecoveryProbes} · repair tracks ${geometryCoverageRepairTracks} · temporal bands ${temporalBandDetections}/${temporalBandSkippedTracks} skips · assist ${geometryRecoveryAssistUntil > perfNow ? `${Math.max(0, geometryRecoveryAssistUntil - perfNow).toFixed(0)}ms` : "no"} · motion'''
if old not in recv: raise SystemExit('missing receiver diagnostics recovery anchor')
recv = recv.replace(old, new, 1)

Path('receive/main.js').write_text(recv)

# Candidate invariants.
checks = {
    'index.html': ['id="cfg-update-pattern"', 'value="synchronous"', 'value="fixed"', 'value="dispersed"'],
    'send/main.js': ['selectedUpdatePattern()', 'synchronousUpdates', 'drawPage(currentPage);', 'updatePattern === "fixed"'],
    'receive/main.js': ['temporalBandMissSlots', 'shouldScheduleTemporalBandSlot', 'temporalBandMiss =', 'temporal bands ${temporalBandDetections}/${temporalBandSkippedTracks} skips'],
}
for path, needles in checks.items():
    text = Path(path).read_text()
    for needle in needles:
        if needle not in text:
            raise SystemExit(f'missing v304 invariant {path}: {needle}')
