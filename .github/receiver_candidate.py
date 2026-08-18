from pathlib import Path


def replace_once(text, old, new, label):
    if old not in text:
        raise SystemExit(f"{label} anchor missing")
    return text.replace(old, new, 1)

# One verified AirGapper QR contains enough information to determine the entire
# declared wall: layout, slot index, QR dimension, and four measured corners.
p = Path('receive/grid-lattice.js')
s = p.read_text()
old = '''function lockReady(layout, observations) {
  const count = layout.cols * layout.rows;
  if (count <= 1) return true;
  const slots = [...new Set(observations.map((observation) => observation.slotIndex))];
  if (slots.length < 2) return false;
  // A one-dimensional grid needs observations from both positions before the
  // lattice may replace measured geometry with a predicted neighbor.
  if (layout.cols === 1 || layout.rows === 1) return true;
  // For a two-dimensional wall, require evidence along both axes. Two
  // diagonally separated QRs are sufficient; two QRs from one row/column are
  // still only a provisional seed and acquisition must continue.
  const cols = new Set(slots.map((slot) => slot % layout.cols));
  const rows = new Set(slots.map((slot) => Math.floor(slot / layout.cols)));
  return cols.size >= 2 && rows.size >= 2;
}
'''
new = '''function lockReady(layout, observations) {
  // One CRC-verified AirGapper QR is a complete geometric seed. The packet
  // declares the wall layout and this QR's slot; its measured four-corner quad
  // provides the eight constraints needed for the wall homography. Additional
  // QRs improve the fit / learn lens residuals, but must never delay acquisition.
  return observations.length > 0;
}
'''
s = replace_once(s, old, new, 'single-QR lock rule')
s = replace_once(
    s,
    '''      // One QR is enough to create a provisional homography but not enough to
      // trust a multi-QR wall. Stay in SEARCH/REACQUIRE so full acquisition
      // continues until distinct observed slots constrain the declared grid.
      if (lockReady(declaredLayout, this.candidate.observations)) {
        this.transition("GRID_LOCK", "multi-slot geometry confirmed", detection.at);
      }
''',
    '''      // A single CRC-backed packet immediately activates the declared wall.
      // Subsequent packets continuously refine this initial projective seed.
      if (lockReady(declaredLayout, this.candidate.observations)) {
        this.transition("GRID_LOCK", "verified QR seeded declared grid", detection.at);
      }
''',
    'single-QR transition comment'
)
p.write_text(s)

p = Path('receive/main.js')
s = p.read_text()

# Do not let post-permission camera enumeration interrupt a receiver that has
# already begun finding AirGapper packets.
old = '''    if (activeId && automaticCameraDeviceId && activeId !== automaticCameraDeviceId &&
        !automaticCameraUpgradeAttempted && stream && !done) {
      automaticCameraUpgradeAttempted = true;
      setTimeout(() => {
        if (!stream || done || preferredCameraDeviceId) return;
        stopReceiver();
        void start();
      }, 0);
    }
'''
new = '''    if (activeId && automaticCameraDeviceId && activeId !== automaticCameraDeviceId &&
        !automaticCameraUpgradeAttempted && stream && !done) {
      automaticCameraUpgradeAttempted = true;
      const upgradeTrack = activeTrack;
      // enumerateDevices() completes after decoding has already started. Never
      // tear down a camera that proved it can see AirGapper; that looked like a
      // random startup freeze. Give the current camera a short acquisition race,
      // and only reopen if it still has not produced one valid packet.
      setTimeout(() => {
        if (!stream || done || preferredCameraDeviceId || stream.getVideoTracks()[0] !== upgradeTrack) return;
        if (gridLattice.identity || lastStreamDecodeAt >= cameraStartedTs) {
          notePipelineEvent("camera-upgrade-skipped-after-qr");
          return;
        }
        stopReceiver();
        void start();
      }, 700);
    }
'''
s = replace_once(s, old, new, 'defer automatic camera upgrade')

old = '''const ACQUISITION_SCAN_MS = 45;
const ACQUISITION_FULL_EVERY = 4;
const ACQUISITION_DEEP_EVERY = 13;
const FULL_SCAN_DEGRADED_MS = 250;
const LOCKED_RECOVERY_SCAN_MS = 220;
const GEOMETRY_PROBE_SILENCE_MS = 650;
const GEOMETRY_COLD_MISSES = 3;
'''
new = '''const ACQUISITION_SCAN_MS = 20;
// The first acquisition frame is global. After that, prefer the much cheaper
// overlapping seed windows; with one-QR lock there is no reason to repeatedly
// scan the whole dense wall while waiting for cross-axis confirmation.
const ACQUISITION_FULL_EVERY = 10;
const ACQUISITION_DEEP_EVERY = 13;
const FULL_SCAN_DEGRADED_MS = 250;
// Recovery probes exist only when a proven wall stops producing packets. They
// therefore cannot consume CPU in the healthy LOCKED throughput path.
const LOCKED_RECOVERY_SCAN_MS = 90;
const GEOMETRY_FAST_HIT_MS = 220;
const GEOMETRY_FAST_PROBE_SILENCE_MS = 180;
const GEOMETRY_PROBE_SILENCE_MS = 500;
const GEOMETRY_COLD_MISSES = 3;
'''
s = replace_once(s, old, new, 'acquisition/recovery timing constants')

old = '''  const recentLockedHits = lockedGeometryCandidates.reduce((count, region) =>
    count + Number(now - (region.decodedSeen ?? -Infinity) < 900), 0
  );
  const lockedDecodeSilenceMs = gridLattice.locked && lastStreamDecodeAt ? now - lastStreamDecodeAt : 0;
  const geometryProbeDue = lockedGeometryTrusted && recentLockedHits === 0 &&
    lockedDecodeSilenceMs >= GEOMETRY_PROBE_SILENCE_MS;
'''
new = '''  const recentLockedHits = lockedGeometryCandidates.reduce((count, region) =>
    count + Number(now - (region.decodedSeen ?? -Infinity) < 900), 0
  );
  const freshLockedHits = lockedGeometryCandidates.reduce((count, region) =>
    count + Number(now - (region.decodedSeen ?? -Infinity) < GEOMETRY_FAST_HIT_MS), 0
  );
  const lockedDecodeSilenceMs = gridLattice.locked && lastStreamDecodeAt ? now - lastStreamDecodeAt : 0;
  // The old 900 ms recent-hit gate made a small camera bump look frozen for
  // roughly a second. A short silence now starts a cheap predicted-slot probe;
  // full-frame recovery remains a later escalation.
  const geometryProbeDue = lockedGeometryTrusted && freshLockedHits === 0 &&
    lockedDecodeSilenceMs >= GEOMETRY_FAST_PROBE_SILENCE_MS;
'''
s = replace_once(s, old, new, 'fast recovery eligibility')

s = replace_once(
    s,
    '  const acquisitionLimit = captureHasTrackedWork ? 1 : 2;\n',
    '  const acquisitionLimit = captureHasTrackedWork ? 1 : 3;\n',
    'three cold acquisition workers'
)

old = '''  const acquisitionSeedScan = fullScanDue && !captureNextScan && !gridLattice.active;
  const globalRecoverySeedScan = fullScanDue && !captureNextScan && gridLattice.locked && geometryProbeDue;
'''
new = '''  const acquisitionSeedScan = fullScanDue && !captureNextScan && !gridLattice.active;
  const globalRecoverySeedScan = fullScanDue && !captureNextScan && gridLattice.locked &&
    (allLockedCandidatesCold || lockedDecodeSilenceMs >= GEOMETRY_PROBE_SILENCE_MS);
  const localRecoverySeedScan = fullScanDue && !captureNextScan && gridLattice.locked &&
    geometryProbeDue && !globalRecoverySeedScan && lockedGeometryCandidates.length > 0;
'''
s = replace_once(s, old, new, 'local vs global recovery stages')

old = '''    let acquisitionMode = captureNextScan ? "thorough" : fullFrameSeed
      ? fullScans % ACQUISITION_DEEP_EVERY === 0 ? "deep" : "fast"
      : "seed";
'''
new = '''    let acquisitionMode = captureNextScan ? "thorough" : fullFrameSeed
      ? fullScans % ACQUISITION_DEEP_EVERY === 0 ? "deep" : "fast"
      : "seed";
    if (localRecoverySeedScan) acquisitionMode = "seed";
'''
s = replace_once(s, old, new, 'cheap local recovery decode mode')

old = '''    let boundedScanCandidates = lockedGeometryCandidates;
    if (provisionalCrop) {
      const target = provisionalUnknownVisible[acquisitionTileCursor++ % provisionalUnknownVisible.length];
      boundedScanCandidates = target ? [target] : [];
    }
    if (!captureNextScan && boundedScanCandidates.length && (provisionalCrop || lockedGeometryTrusted && gridLattice.locked && !geometryProbeDue && !allLockedCandidatesCold)) {
'''
new = '''    let boundedScanCandidates = lockedGeometryCandidates;
    if (provisionalCrop) {
      const target = provisionalUnknownVisible[acquisitionTileCursor++ % provisionalUnknownVisible.length];
      boundedScanCandidates = target ? [target] : [];
    } else if (localRecoverySeedScan) {
      // A small bump moves the rigid wall coherently. Probe one central predicted
      // QR at a time instead of rescanning the whole wall; the first CRC-valid
      // packet re-homographies every slot. Rotate a few central choices so an
      // occluded/transitioning code cannot stall reacquisition.
      const cx = vw / 2, cy = vh / 2;
      const ranked = [...lockedGeometryCandidates].sort((a, b) => {
        const ad = Math.hypot(a.x + a.w / 2 - cx, a.y + a.h / 2 - cy);
        const bd = Math.hypot(b.x + b.w / 2 - cx, b.y + b.h / 2 - cy);
        return ad - bd;
      });
      const poolSize = Math.min(5, ranked.length);
      const target = ranked[acquisitionTileCursor++ % poolSize];
      boundedScanCandidates = target ? [target] : [];
      geometryRecoveryProbes++;
      notePipelineEvent("local-recovery-probe", geometryRecoveryProbes);
    }
    if (!captureNextScan && boundedScanCandidates.length && (provisionalCrop || localRecoverySeedScan || lockedGeometryTrusted && gridLattice.locked && !geometryProbeDue && !allLockedCandidatesCold)) {
'''
s = replace_once(s, old, new, 'rotating local recovery target')

old = '      const pad = Math.max(24, Math.round(typicalEdge * (provisionalCrop ? 0.9 : 0.7)));\n'
new = '      const pad = Math.max(24, Math.round(typicalEdge * (provisionalCrop ? 0.9 : localRecoverySeedScan ? 1.0 : 0.7)));\n'
s = replace_once(s, old, new, 'local recovery crop padding')

# Version/cache bump. No locked decoder or codec source is changed in this candidate.
s = replace_once(s, 'const RECEIVER_RUNTIME_BUILD = "v0.5.270";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.271";', 'receiver runtime version')
p.write_text(s)

p = Path('main.js')
s = p.read_text()
s = replace_once(s, 'const APP_BUILD = "v0.5.270";', 'const APP_BUILD = "v0.5.271";', 'app version')
p.write_text(s)

p = Path('index.html')
s = p.read_text()
if s.count('v0.5.270') < 2:
    raise SystemExit('index v0.5.270 anchors missing')
s = s.replace('v0.5.270', 'v0.5.271')
p.write_text(s)

p = Path('sw.js')
s = p.read_text()
s = replace_once(s, 'airgapper-static-js-v218', 'airgapper-static-js-v219', 'service worker cache')
p.write_text(s)
