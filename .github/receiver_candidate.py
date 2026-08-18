from pathlib import Path


def rep(path, old, new):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"missing anchor {path}: {old[:220]}")
    p.write_text(s.replace(old, new, 1))


rep('receive/main.js', 'const RECEIVER_RUNTIME_BUILD = "v0.5.287";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.288";')
rep('send/main.js', 'const SEND_RUNTIME_BUILD = "v0.5.287";', 'const SEND_RUNTIME_BUILD = "v0.5.288";')
rep('main.js', 'const APP_BUILD = "v0.5.287";', 'const APP_BUILD = "v0.5.288";')
rep('index.html', 'main.js?build=v0.5.287', 'main.js?build=v0.5.288')
rep('index.html', '<span class="brand">AirGapper <span class="app-version">v0.5.281</span></span>', '<span class="brand">AirGapper <span class="app-version">v0.5.288</span></span>')
rep('sw.js', 'airgapper-static-js-v235', 'airgapper-static-js-v236')

rep('receive/main.js', '''let geometryCoverageStarvedSince = 0;
let geometryBreadthRecoveryProbes = 0;
let geometryCoverageCollapseStreak = 0;''', '''let geometryCoverageStarvedSince = 0;
let geometryBreadthRecoveryProbes = 0;
let geometryCoverageRepairTracks = 0;
let geometryCoverageCollapseStreak = 0;''')
rep('receive/main.js', '''  geometryCoverageStarvedSince = 0;
  geometryBreadthRecoveryProbes = 0;
  geometryCoverageCollapseStreak = 0;''', '''  geometryCoverageStarvedSince = 0;
  geometryBreadthRecoveryProbes = 0;
  geometryCoverageRepairTracks = 0;
  geometryCoverageCollapseStreak = 0;''')

rep('receive/main.js', '''  const adaptiveWeakSlots = gridLattice.active && adaptiveWeakSlotScheduling(batchCandidates);
  const batchRegions = adaptiveWeakSlots
    ? batchCandidates.filter((region) => shouldScheduleAdaptiveSlot(region, source.sequence, true))
    : batchCandidates;
  const batchTracks = batchRegions.map((region) => ({''', '''  const adaptiveWeakSlots = gridLattice.active && adaptiveWeakSlotScheduling(batchCandidates);
  let batchRegions = adaptiveWeakSlots
    ? batchCandidates.filter((region) => shouldScheduleAdaptiveSlot(region, source.sequence, true))
    : batchCandidates;

  // Weak-slot throttling is good when a few QRs are genuinely poor, but it can
  // self-lock a partially stale wall: stale geometry misses, becomes weak, then
  // gets too few attempts to produce the CRC-valid hit that would refresh it.
  // Keep the normal CPU-saving throttle and reserve only ONE extra track while
  // breadth starvation is sustained. Prefer missing rows/columns, then the
  // stalest successful geometry, with a sequence-rotated tie break for fairness.
  if (adaptiveWeakSlots && sustainedCoverageStarvation && batchRegions.length < batchCandidates.length) {
    const scheduledIds = new Set(batchRegions.map((region) => region.id));
    const cols = Math.max(1, Number(liveGridLayout?.cols) || 1);
    const phase = Math.trunc(Number(source.sequence) || 0);
    const repairCandidates = batchCandidates
      .filter((region) => !scheduledIds.has(region.id))
      .sort((a, b) => {
        const aSlot = Number(a.gridSlot);
        const bSlot = Number(b.gridSlot);
        const aCol = Number.isInteger(aSlot) ? aSlot % cols : 0;
        const bCol = Number.isInteger(bSlot) ? bSlot % cols : 0;
        const aRow = Number.isInteger(aSlot) ? Math.floor(aSlot / cols) : 0;
        const bRow = Number.isInteger(bSlot) ? Math.floor(bSlot / cols) : 0;
        const aBreadth = Number(!freshCols.has(aCol)) + Number(!freshRows.has(aRow));
        const bBreadth = Number(!freshCols.has(bCol)) + Number(!freshRows.has(bRow));
        if (aBreadth !== bBreadth) return bBreadth - aBreadth;
        const aSeen = Number.isFinite(a.decodedSeen) ? a.decodedSeen : -1e15;
        const bSeen = Number.isFinite(b.decodedSeen) ? b.decodedSeen : -1e15;
        if (aSeen !== bSeen) return aSeen - bSeen;
        const aRotate = Number.isInteger(aSlot) ? (aSlot - phase + SLOT_METRIC_COUNT * 4) % SLOT_METRIC_COUNT : SLOT_METRIC_COUNT;
        const bRotate = Number.isInteger(bSlot) ? (bSlot - phase + SLOT_METRIC_COUNT * 4) % SLOT_METRIC_COUNT : SLOT_METRIC_COUNT;
        return aRotate - bRotate;
      });
    const repair = repairCandidates[0];
    if (repair) {
      batchRegions = [...batchRegions, repair];
      geometryCoverageRepairTracks++;
      notePipelineEvent("coverage-repair-track", Number(repair.gridSlot) || 0);
    }
  }
  const batchTracks = batchRegions.map((region) => ({''')

rep('receive/main.js', '''`Recovery probes ${geometryRecoveryProbes} · breadth ${geometryBreadthRecoveryProbes} · assist ${geometryRecoveryAssistUntil > perfNow ? `${Math.max(0, geometryRecoveryAssistUntil - perfNow).toFixed(0)}ms` : "no"} · motion ${geometryMotionNudges}/${geometryMotionPixels.toFixed(0)}px''', '''`Recovery probes ${geometryRecoveryProbes} · breadth ${geometryBreadthRecoveryProbes} · repair tracks ${geometryCoverageRepairTracks} · assist ${geometryRecoveryAssistUntil > perfNow ? `${Math.max(0, geometryRecoveryAssistUntil - perfNow).toFixed(0)}ms` : "no"} · motion ${geometryMotionNudges}/${geometryMotionPixels.toFixed(0)}px''')

receive = Path('receive/main.js').read_text()
for needle in [
    'const RECEIVER_RUNTIME_BUILD = "v0.5.288";',
    'geometryCoverageRepairTracks++',
    'coverage-repair-track',
    'repair tracks ${geometryCoverageRepairTracks}'
]:
    if needle not in receive:
        raise SystemExit(f'missing v288 invariant: {needle}')
