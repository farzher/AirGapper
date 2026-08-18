from pathlib import Path


def rep(path, old, new):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"missing anchor {path}: {old[:260]}")
    p.write_text(s.replace(old, new, 1))


# Build/cache bump.
rep('receive/main.js', 'const RECEIVER_RUNTIME_BUILD = "v0.5.295";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.296";')
rep('send/main.js', 'const SEND_RUNTIME_BUILD = "v0.5.295";', 'const SEND_RUNTIME_BUILD = "v0.5.296";')
rep('main.js', 'const APP_BUILD = "v0.5.295";', 'const APP_BUILD = "v0.5.296";')
rep('index.html', 'main.js?build=v0.5.295', 'main.js?build=v0.5.296')
rep('index.html', '<span class="brand">AirGapper <span class="app-version">v0.5.295</span></span>', '<span class="brand">AirGapper <span class="app-version">v0.5.296</span></span>')
rep('sw.js', 'airgapper-static-js-v243', 'airgapper-static-js-v244')

# A CRC-proven wall is durable session identity, not a 3.2-second cache entry.
# v295 still had an older GridLattice.tick() timeout that independently erased
# the candidate/observations after 3200 ms of silence. That bypassed all newer
# close-up retention logic and forced SEARCH/REACQUIRE + Auto Optics rescue.
# Keep the homography and identity indefinitely inside the current receive
# session; silence only marks it PARTIAL_LOSS. Any later verified QR is already
# capable of rejecting stale anchors and rebuilding the homography from its four
# corners, so retaining the candidate is exactly what lets one QR recover pose.
rep(
    'receive/grid-lattice.js',
    '''  tick(now) {
    if (this.candidate && now - this.lastHitAt > WHOLE_GRID_LOSS_MS) {
      this.transition("REACQUIRE", "whole lattice expired without a valid packet", now);
      this.candidate = void 0;
      this.observations = [];
      this.slotCorrections.clear();
      return null;
    }
    // Provisional geometry remains publishable for overlays, visibility,
    // cropping and exact observed-slot tracking. Only `active` means the whole
    // predicted wall is trusted enough to replace acquisition.
    return this.candidate ? this.snapshot() : null;
  }''',
    '''  tick(now) {
    if (this.candidate && now - this.lastHitAt > WHOLE_GRID_LOSS_MS) {
      // Never erase a CRC-proven wall merely because the camera moved away from
      // its predicted quads. Keeping identity + homography lets bounded global
      // recovery accept any later same-stream QR and re-anchor the whole wall
      // from that QR's four measured corners. Session/camera changes still call
      // reset/reacquire explicitly when the identity really must be discarded.
      this.transition("PARTIAL_LOSS", "whole lattice stale; retaining proven wall for QR re-anchor", now);
    }
    // Stale geometry remains a recovery prior, not an acquisition blocker.
    return this.candidate ? this.snapshot() : null;
  }'''
)

# main.js had a second destructive timeout (2.8 s normally / 8 s in the very
# narrow-FOV special case). Remove it too. `globalRecoverySeedScan` below already
# performs bounded full-frame recovery every LOCKED_RECOVERY_SCAN_MS while every
# predicted slot is cold. Keeping the lock prevents hundreds of acquisition jobs,
# worker restarts and Auto Optics exposure races while still searching globally.
rep(
    'receive/main.js',
    '''  const declaredLockedSlots = liveGridLayout ? liveGridLayout.cols * liveGridLayout.rows : lockedGeometryCandidates.length;
  const narrowFovLock = declaredLockedSlots > 3 && lockedGeometryCandidates.length <= 3;
  const hardResetSilenceMs = narrowFovLock ? GEOMETRY_NARROW_FOV_HARD_RESET_MS : GEOMETRY_HARD_RESET_MS;
  const hardGeometryResetDue = allLockedCandidatesCold &&
    lockedDecodeSilenceMs >= hardResetSilenceMs;
  if (hardGeometryResetDue) {
    enterGeometryRecovery("tracked lattice silent too long; fresh acquisition", now, true);
    if (trace) trace.stateAfter = gridLattice.state;
    activeBenchmarkFrame = void 0;
    return;
  }''',
    '''  // A proven lattice is sticky for the life of this receive session.
  // `allLockedCandidatesCold` escalates to bounded full-frame recovery below,
  // but ordinary decoder silence must never destroy stream identity/geometry.
  // A newly found CRC-valid QR will reject stale pose anchors and re-anchor the
  // existing wall in place, even when only that one QR is visible.'''
)
rep(
    'receive/main.js',
    'const GEOMETRY_HARD_RESET_MS = 2800;\nconst GEOMETRY_NARROW_FOV_HARD_RESET_MS = 8000;\n',
    ''
)

# Lock the regression around the exact failure: after many seconds with no valid
# packet, the wall must remain active/locked and a single QR at a radically new
# pose must re-anchor it instead of entering cold acquisition.
rep(
    'benchmark/grid-lattice-regression.mjs',
    '''snapshot = lattice.accept(detection(0, 1460, { dx: 154, dy: 98 }), frameWidth, frameHeight);
assert(snapshot, "measured geometry after a coherent frame nudge must remain usable");
assert.equal(lattice.locked, true);
assert.equal(snapshot.distributedFit, true);

console.log("grid-lattice regression: ok");''',
    '''snapshot = lattice.accept(detection(0, 1460, { dx: 154, dy: 98 }), frameWidth, frameHeight);
assert(snapshot, "measured geometry after a coherent frame nudge must remain usable");
assert.equal(lattice.locked, true);
assert.equal(snapshot.distributedFit, true);

// Close-up regression: decode silence must never erase a CRC-proven wall. The
// old 3200 ms tick timeout forced REACQUIRE, which in turn woke expensive cold
// acquisition and Auto Optics races. Retain the stale wall as PARTIAL_LOSS.
snapshot = lattice.tick(12000);
assert(snapshot, "a proven wall must survive long decoder silence");
assert.equal(lattice.locked, true, "silence must keep the lattice locked for bounded recovery");
assert.equal(lattice.active, true, "silence must not fall back to cold acquisition");
assert.equal(lattice.state, "PARTIAL_LOSS");

// One CRC-valid QR at a radically different camera pose has four measured
// corners, enough to rebuild the full projective wall transform immediately.
snapshot = lattice.accept(detection(10, 12020, { dx: -260, dy: 310, scale: 1.75 }), frameWidth, frameHeight);
assert(snapshot, "one verified QR must re-anchor a stale wall");
assert.equal(lattice.locked, true);
assert.equal(lattice.state, "TRACK");
assert.equal(snapshot.distributedFit, false, "one-QR re-anchor is local until cross-axis evidence returns");
assert.equal(snapshot.fitSlots, 1, "stale old-pose anchors must be discarded on the new pose");

console.log("grid-lattice regression: ok");'''
)

main = Path('receive/main.js').read_text()
lattice = Path('receive/grid-lattice.js').read_text()
test = Path('benchmark/grid-lattice-regression.mjs').read_text()
for needle in [
    'const RECEIVER_RUNTIME_BUILD = "v0.5.296";',
    'ordinary decoder silence must never destroy stream identity/geometry',
    'globalRecoverySeedScan'
]:
    if needle not in main:
        raise SystemExit(f'missing v296 main invariant: {needle}')
for needle in [
    'whole lattice stale; retaining proven wall for QR re-anchor',
    'this.transition("PARTIAL_LOSS"',
]:
    if needle not in lattice:
        raise SystemExit(f'missing v296 lattice invariant: {needle}')
if 'whole lattice expired without a valid packet' in lattice:
    raise SystemExit('v296 invariant failed: destructive lattice timeout remains')
for needle in [
    'lattice.tick(12000)',
    'one verified QR must re-anchor a stale wall',
    'snapshot.fitSlots, 1'
]:
    if needle not in test:
        raise SystemExit(f'missing v296 regression invariant: {needle}')
