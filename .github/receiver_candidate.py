from pathlib import Path


def rep(path, old, new):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"missing anchor {path}: {old[:240]}")
    p.write_text(s.replace(old, new, 1))


# Build/cache bump.
rep('receive/main.js', 'const RECEIVER_RUNTIME_BUILD = "v0.5.294";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.295";')
rep('send/main.js', 'const SEND_RUNTIME_BUILD = "v0.5.294";', 'const SEND_RUNTIME_BUILD = "v0.5.295";')
rep('main.js', 'const APP_BUILD = "v0.5.294";', 'const APP_BUILD = "v0.5.295";')
rep('index.html', 'main.js?build=v0.5.294', 'main.js?build=v0.5.295')
rep('index.html', '<span class="brand">AirGapper <span class="app-version">v0.5.294</span></span>', '<span class="brand">AirGapper <span class="app-version">v0.5.295</span></span>')
rep('sw.js', 'airgapper-static-js-v242', 'airgapper-static-js-v243')

# Close-up acquisition: v294 intended to keep every fourth acquisition attempt
# full-frame, but the constant was still 10. A large v40 QR can occupy roughly
# half the camera width, so most 3x3 seed crops can cut the only QR in half.
rep('receive/main.js', 'const ACQUISITION_FULL_EVERY = 10;', 'const ACQUISITION_FULL_EVERY = 4;')
rep('receive/main.js', '  const padX = cellW * 0.28;\n  const padY = cellH * 0.28;', '  const padX = cellW * 0.42;\n  const padY = cellH * 0.42;')

# A narrow FOV is not evidence that a proven wall vanished. With one or two
# visible cells, a short miss burst makes *all* visible tracks cold by definition.
# Keep the lattice identity/transform around while full-frame recovery looks for
# any same-stream QR and can re-anchor it without a destructive reacquire.
rep(
    'receive/main.js',
    'const GEOMETRY_HARD_RESET_MS = 2800;\nconst CAMERA_MUTATION_SETTLE_MS = 350;',
    'const GEOMETRY_HARD_RESET_MS = 2800;\nconst GEOMETRY_NARROW_FOV_HARD_RESET_MS = 8000;\nconst CAMERA_MUTATION_SETTLE_MS = 350;'
)
rep(
    'receive/main.js',
    '''  const hardGeometryResetDue = allLockedCandidatesCold &&
    lockedDecodeSilenceMs >= GEOMETRY_HARD_RESET_MS;''',
    '''  const declaredLockedSlots = liveGridLayout ? liveGridLayout.cols * liveGridLayout.rows : lockedGeometryCandidates.length;
  const narrowFovLock = declaredLockedSlots > 3 && lockedGeometryCandidates.length <= 3;
  const hardResetSilenceMs = narrowFovLock ? GEOMETRY_NARROW_FOV_HARD_RESET_MS : GEOMETRY_HARD_RESET_MS;
  const hardGeometryResetDue = allLockedCandidatesCold &&
    lockedDecodeSilenceMs >= hardResetSilenceMs;'''
)

# One successful QR is enough to estimate translation, even though it is not
# enough to estimate rotation/scale. v294 required >=2 successful tracks both in
# the worker and again on the main thread, so a close-up single-QR view could not
# move the lattice with normal hand motion. Restore a conservative CRC-backed
# single-track translation path, bounded by the same <=4.5 px limit as v279.
rep(
    'receive/worker.js',
    '''  if (wallMotionSamples.length >= 2) {
    const median = (values) => {''',
    '''  if (wallMotionSamples.length === 1) {
    const item = wallMotionSamples[0];
    const shift = Math.hypot(item.dx, item.dy);
    if (shift >= 0.08 && shift <= 4.5) {
      const wallMotion = {
        kind: "translation",
        a: 1, b: 0, tx: item.dx, ty: item.dy,
        dx: item.dx, dy: item.dy,
        samples: 1,
        residual: 0,
        maxShift: shift
      };
      for (const symbol of symbols) symbol.wallMotion = wallMotion;
    }
  }
  if (wallMotionSamples.length >= 2) {
    const median = (values) => {'''
)
rep(
    'receive/main.js',
    '''    if (Number.isFinite(sourceSequence) && sourceSequence > geometryMotionLastSourceSequence &&
        motion && Number(motion.samples) >= 2 && Number.isFinite(motion.dx) && Number.isFinite(motion.dy)) {''',
    '''    const motionSamples = Number(motion?.samples) || 0;
    const motionEvidenceEnough = motion?.kind === "translation" ? motionSamples >= 1 : motionSamples >= 2;
    if (Number.isFinite(sourceSequence) && sourceSequence > geometryMotionLastSourceSequence &&
        motion && motionEvidenceEnough && Number.isFinite(motion.dx) && Number.isFinite(motion.dy)) {'''
)

# Auto Optics should not optimize a 4x7 wall while the camera sees a tiny moving
# fragment of it. That sample is not representative of wall throughput and the
# extrapolated whole-wall pose is hypersensitive in close-up. Wait for broader
# visibility; true 1x1/1xN layouts remain eligible.
rep(
    'receive/main.js',
    'const AUTO_OPTICS_POSE_STABLE_MS = 140;\nconst AUTO_OPTICS_POSE_WAIT_MS = 700;',
    'const AUTO_OPTICS_POSE_STABLE_MS = 300;\nconst AUTO_OPTICS_POSE_WAIT_MS = 700;\nconst AUTO_OPTICS_NARROW_FOV_MAX_VISIBLE = 3;\nconst AUTO_OPTICS_NARROW_FOV_RETRY_MS = 1800;'
)
rep(
    'receive/main.js',
    '''  const fps = Math.max(12, Math.min(120, Number(settings.frameRate) || 30));
  const savedAe = autoOpticsAeBaseline && receiverNow() - autoOpticsAeBaseline.at < 9000 ? autoOpticsAeBaseline : void 0;''',
    '''  const fps = Math.max(12, Math.min(120, Number(settings.frameRate) || 30));
  const declaredAutoLayout = lastGridSnapshot?.layout;
  const declaredAutoSlots = declaredAutoLayout ? declaredAutoLayout.cols * declaredAutoLayout.rows : 0;
  const visibleAutoSlots = autoOpticsVisibleSlots();
  if (declaredAutoSlots > AUTO_OPTICS_NARROW_FOV_MAX_VISIBLE && visibleAutoSlots <= AUTO_OPTICS_NARROW_FOV_MAX_VISIBLE) {
    autoOpticsLockSince = 0;
    autoOpticsRetryAt = now + AUTO_OPTICS_NARROW_FOV_RETRY_MS;
    autoOpticsTuneSummary = `narrow FOV ${visibleAutoSlots}/${declaredAutoSlots} · holding current optics`;
    return;
  }
  const savedAe = autoOpticsAeBaseline && receiverNow() - autoOpticsAeBaseline.at < 9000 ? autoOpticsAeBaseline : void 0;'''
)

# If a comparison is invalidated after several camera writes, restore exactly the
# sensor state that was active before the sweep. v294 returned from a deferred
# sweep without restoration, which is why diagnostics could say committed ISO100
# while the camera was actually left at ISO400 and then immediately retry again.
rep(
    'receive/main.js',
    '''  const settings = track.getSettings();
  if (!Array.isArray(caps.exposureMode) || !caps.exposureMode.includes("manual") ||''',
    '''  const settings = track.getSettings();
  const preTuneExposure = Number(settings.exposureTime);
  const preTuneIso = Number(settings.iso);
  if (!Array.isArray(caps.exposureMode) || !caps.exposureMode.includes("manual") ||'''
)
rep(
    'receive/main.js',
    '''    if (tuned.deferred) {
      autoOpticsRuntimeState = "ae";
      autoOpticsLockSince = 0;
      autoOpticsRetryAt = receiverNow() + Math.max(350, Number(tuned.retryMs) || 0);''',
    '''    if (tuned.deferred) {
      if (Number.isFinite(preTuneExposure) && preTuneExposure > 0 && Number.isFinite(preTuneIso) && preTuneIso > 0) {
        await applyCameraConstraint(track, {
          exposureMode: "manual",
          exposureTime: quantizeCameraRange(preTuneExposure, exposureRange),
          iso: quantizeCameraRange(preTuneIso, isoRange)
        });
        if (!automaticOpticsSessionAlive(track)) return;
      }
      autoOpticsRuntimeState = "ae";
      autoOpticsLockSince = 0;
      autoOpticsRetryAt = receiverNow() + Math.max(AUTO_OPTICS_NARROW_FOV_RETRY_MS, Number(tuned.retryMs) || 0);'''
)

# Static invariants catch the exact regressions this patch is intended to prevent.
main = Path('receive/main.js').read_text()
worker = Path('receive/worker.js').read_text()
for needle in [
    'const RECEIVER_RUNTIME_BUILD = "v0.5.295";',
    'const ACQUISITION_FULL_EVERY = 4;',
    'GEOMETRY_NARROW_FOV_HARD_RESET_MS = 8000',
    'motionEvidenceEnough',
    'AUTO_OPTICS_NARROW_FOV_MAX_VISIBLE = 3',
    'narrow FOV ${visibleAutoSlots}/${declaredAutoSlots}',
    'quantizeCameraRange(preTuneIso, isoRange)'
]:
    if needle not in main:
        raise SystemExit(f'missing v295 invariant: {needle}')
for needle in [
    'wallMotionSamples.length === 1',
    'samples: 1',
    'shift <= 4.5'
]:
    if needle not in worker:
        raise SystemExit(f'missing v295 worker invariant: {needle}')
