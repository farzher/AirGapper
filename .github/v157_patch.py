from pathlib import Path
import subprocess

root = Path('.')
V154 = '356b52b2f3d076b610c7edde3f22b62100231725'

# The v155 guided-seeded native cache was decisively negative on the OP12R:
# 63.3 worker-s for 6/4932 useful native hits, doubling full-wall job latency.
# Restore the known-good v154 guided-only codec/worker implementation exactly,
# including the cheap adjacent-page repeat filter added in v154.
restore = [
    'receive/worker.js',
    'vendor/decimen-codec/decimen_codec.js',
    'vendor/decimen-codec/decimen_codec.wasm',
    'vendor/decimen-codec/source/CMakeLists.txt',
    'vendor/decimen-codec/source/wrapper/decimen_codec.cpp',
    'vendor/decimen-codec/source/wrapper/decimen_codec.h',
]
subprocess.run(['git', 'checkout', V154, '--', *restore], check=True)

p = root / 'receive/main.js'
s = p.read_text()
assert 'const RECEIVER_RUNTIME_BUILD = "v0.5.156";' in s
s = s.replace('const RECEIVER_RUNTIME_BUILD = "v0.5.156";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.157";', 1)

old = '''const AUTO_OPTICS_POSE_STABLE_MS = 260;
const AUTO_OPTICS_POSE_WAIT_MS = 1800;
const AUTO_OPTICS_POSE_MAX_CENTER_DRIFT = 0.035;
const AUTO_OPTICS_POSE_MAX_SCALE_LOG2 = 0.10;
const AUTO_OPTICS_MIN_VISIBLE_FRACTION = 0.75;
const AUTO_OPTICS_MEMORY_KEY = "airgapper:auto-optics-memory:v1";'''
new = '''const AUTO_OPTICS_POSE_STABLE_MS = 260;
const AUTO_OPTICS_POSE_WAIT_MS = 1800;
const AUTO_OPTICS_POSE_MAX_CENTER_DRIFT = 0.035;
const AUTO_OPTICS_POSE_MAX_SCALE_LOG2 = 0.10;
// Fine tuning needs comparable geometry, not a nearly complete wall. Two
// tracked slots are enough to compare ISO candidates if the pose itself stays
// stable. Requiring 75% of the wall created a bootstrap deadlock when bad AE
// prevented acquisition in the first place.
const AUTO_OPTICS_MIN_VISIBLE_SLOTS = 2;
const AUTO_OPTICS_ACQUISITION_RESCUE_MS = 1600;
const AUTO_OPTICS_RESCUE_SETTLE_MS = 280;
const AUTO_OPTICS_RESCUE_SAMPLE_MS = 720;
const AUTO_OPTICS_RESCUE_RETRY_MS = 5000;
const AUTO_OPTICS_MEMORY_KEY = "airgapper:auto-optics-memory:v1";'''
assert old in s
s = s.replace(old, new, 1)

old = '''let autoOpticsMutationRunning = false;
let autoOpticsLockSince = 0;
let autoOpticsRetryAt = 0;
let preferredExposureTime;'''
new = '''let autoOpticsMutationRunning = false;
let autoOpticsLockSince = 0;
let autoOpticsRetryAt = 0;
let autoOpticsAcquisitionSince = 0;
let autoOpticsRescueRetryAt = 0;
let preferredExposureTime;'''
assert old in s
s = s.replace(old, new, 1)

old = '''function resetAutomaticOpticsRuntime() {
  autoOpticsRuntimeState = "ae";
  autoOpticsMutationRunning = false;
  autoOpticsLockSince = 0;
  autoOpticsRetryAt = 0;
  autoOpticsTuneSummary = "";
}'''
new = '''function resetAutomaticOpticsRuntime() {
  autoOpticsRuntimeState = "ae";
  autoOpticsMutationRunning = false;
  autoOpticsLockSince = 0;
  autoOpticsRetryAt = 0;
  autoOpticsAcquisitionSince = 0;
  autoOpticsRescueRetryAt = 0;
  autoOpticsTuneSummary = "";
}'''
assert old in s
s = s.replace(old, new, 1)

old = '''function autoOpticsPoseUsable(pose) {
  if (!pose?.locked || !Number.isFinite(pose.x) || !Number.isFinite(pose.y) || !(pose.scale > 0)) return false;
  const expected = Math.max(1, pose.expected || pose.visible || 1);
  const minimumVisible = expected <= 2 ? expected : Math.max(2, Math.ceil(expected * AUTO_OPTICS_MIN_VISIBLE_FRACTION));
  return pose.visible >= minimumVisible;
}'''
new = '''function autoOpticsPoseUsable(pose) {
  if (!pose?.locked || !Number.isFinite(pose.x) || !Number.isFinite(pose.y) || !(pose.scale > 0)) return false;
  const expected = Math.max(1, pose.expected || pose.visible || 1);
  return pose.visible >= Math.min(expected, AUTO_OPTICS_MIN_VISIBLE_SLOTS);
}'''
assert old in s
s = s.replace(old, new, 1)

anchor = '''function maintainAutomaticQrOptics(now) {'''
assert anchor in s
rescue = r'''async function rescueAutomaticQrAcquisition(track, now) {
  if (autoOpticsMutationRunning || !automaticOptics || gridLattice.locked || now < autoOpticsRescueRetryAt) return;
  const caps = track.getCapabilities?.() ?? {};
  const exposureRange = caps.exposureTime;
  const isoRange = caps.iso;
  const settings = track.getSettings();
  if (!Array.isArray(caps.exposureMode) || !caps.exposureMode.includes("manual") ||
      !exposureRange || !isoRange || !Number.isFinite(settings.exposureTime) ||
      !Number.isFinite(settings.iso) || settings.exposureTime <= 0 || settings.iso <= 0) {
    autoOpticsRescueRetryAt = now + AUTO_OPTICS_RESCUE_RETRY_MS;
    return;
  }

  // This is deliberately only an acquisition rescue. With no QR lock there is
  // no trustworthy decoder-yield objective, so test a tiny reversible set of
  // plausible brightnesses until QR evidence appears. Precise optimization is
  // still deferred until tracked geometry exists.
  const fps = Math.max(12, Math.min(120, Number(settings.frameRate) || 30));
  const motionSafeExposure = 1e4 / fps * AUTO_OPTICS_SHUTTER_FRAME_FRACTION;
  const exposureProduct = settings.exposureTime * settings.iso;
  const exposure = quantizeCameraRange(Math.min(settings.exposureTime, motionSafeExposure), exposureRange);
  const aeIso = quantizeCameraRange(exposureProduct / Math.max(exposureRange.min, exposure), isoRange);
  const maxAutoIso = Math.min(isoRange.max, Math.max(isoRange.min, settings.iso * 4));
  const remembered = loadAutomaticOpticsMemory(track, exposure, isoRange, maxAutoIso);
  const candidates = [];
  const add = (value) => {
    if (!Number.isFinite(value)) return;
    const candidate = quantizeCameraRange(Math.min(maxAutoIso, Math.max(isoRange.min, value)), isoRange);
    if (!candidates.some((prior) => Math.abs(prior - candidate) <= Math.max(Number(isoRange.step) || 0, candidate * 0.01)))
      candidates.push(candidate);
  };
  // Memory is the strongest prior on reload. Fresh AE remains represented, and
  // both a brighter and darker alternative keep first-use rescue symmetric.
  add(remembered);
  add(aeIso);
  add(aeIso * 2);
  add(aeIso / 2);

  autoOpticsMutationRunning = true;
  autoOpticsRuntimeState = "rescue";
  notePipelineEvent("auto-optics-acquisition-rescue");
  try {
    for (const candidate of candidates) {
      if (!automaticOpticsSessionAlive(track)) return;
      autoOpticsTuneSummary = `acquisition rescue · ISO ${Math.round(candidate)}`;
      const accepted = await applyCameraConstraint(track, {
        exposureMode: "manual",
        exposureTime: exposure,
        iso: candidate
      });
      if (!accepted || !automaticOpticsSessionAlive(track)) continue;
      if (!await waitForAutoOptics(AUTO_OPTICS_RESCUE_SETTLE_MS, track)) return;
      const evidenceStart = receiverNow();
      if (!await waitForAutoOptics(AUTO_OPTICS_RESCUE_SAMPLE_MS, track)) return;
      const freshDecodes = qrReadTimes.reduce((count, at) => count + Number(at >= evidenceStart), 0);
      if (gridLattice.locked || freshDecodes >= 2) {
        // Leave the helpful reversible setting in place long enough to acquire
        // the lattice. Once locked, the normal quality-gated tuner validates it
        // against memory/fresh AE and commits a real winner.
        autoOpticsRuntimeState = "ae";
        autoOpticsLockSince = 0;
        autoOpticsAcquisitionSince = receiverNow();
        autoOpticsRescueRetryAt = receiverNow() + 2500;
        autoOpticsTuneSummary = `acquisition rescue · ISO ${Math.round(candidate)} found QR`;
        return;
      }
    }

    // No candidate produced QR evidence. Do not freeze a guess: return camera
    // ownership to hardware AE and permit another rescue only after a cooldown.
    await applyExposureSetting(track);
    autoOpticsRuntimeState = "ae";
    autoOpticsLockSince = 0;
    autoOpticsAcquisitionSince = receiverNow();
    autoOpticsRescueRetryAt = receiverNow() + AUTO_OPTICS_RESCUE_RETRY_MS;
    autoOpticsTuneSummary = "acquisition rescue deferred";
  } finally {
    autoOpticsMutationRunning = false;
  }
}

'''
s = s.replace(anchor, rescue + anchor, 1)

old = '''  // Auto optics is a bootstrap, not a continuously active controller. Hardware
  // AE gets enough time to establish scene brightness; a verified QR lock then
  // lets us convert that brightness to a shorter manual shutter + compensating
  // ISO exactly once. The manual state survives target/lattice loss.
  if (autoOpticsRuntimeState !== "ae") return;
  if (!gridLattice.locked || !autoOpticsPoseUsable(autoOpticsPoseSnapshot())) {
    // Do not even start the tuning clock on a partial/moving wall. Optics is
    // judged only after enough of the expected layout is framed and tracked.
    autoOpticsLockSince = 0;
    return;
  }
  if (!autoOpticsLockSince) autoOpticsLockSince = now;'''
new = '''  // Auto optics has two bootstrap layers. If AE is so poor that no lattice can
  // be acquired, a tiny reversible rescue search may expose enough QR signal to
  // get started. Once a lattice exists, precise decoder-yield tuning still
  // requires stable pose, but no longer requires most of the wall to be visible.
  if (autoOpticsRuntimeState !== "ae") return;
  if (!autoOpticsAcquisitionSince) autoOpticsAcquisitionSince = now;
  if (!gridLattice.locked) {
    autoOpticsLockSince = 0;
    if (now - autoOpticsAcquisitionSince >= AUTO_OPTICS_ACQUISITION_RESCUE_MS && now >= autoOpticsRescueRetryAt)
      void rescueAutomaticQrAcquisition(track, now);
    return;
  }
  if (!autoOpticsPoseUsable(autoOpticsPoseSnapshot())) {
    autoOpticsLockSince = 0;
    return;
  }
  if (!autoOpticsLockSince) autoOpticsLockSince = now;'''
assert old in s
s = s.replace(old, new, 1)
p.write_text(s)

# Public version/cache bookkeeping.
for name in ['index.html', 'main.js']:
    p = root / name
    text = p.read_text()
    assert 'v0.5.156' in text, name
    p.write_text(text.replace('v0.5.156', 'v0.5.157'))

p = root / 'sw.js'
text = p.read_text()
assert 'airgapper-static-js-v118' in text
p.write_text(text.replace('airgapper-static-js-v118', 'airgapper-static-js-v119', 1))
