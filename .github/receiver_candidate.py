from pathlib import Path
import re


def rep(path, old, new):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"missing anchor {path}: {old[:220]}")
    p.write_text(s.replace(old, new, 1))


def sub(path, pattern, replacement):
    p = Path(path)
    s = p.read_text()
    out, count = re.subn(pattern, replacement, s, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f"regex anchor count {count} in {path}: {pattern[:180]}")
    p.write_text(out)


# Version/cache.
rep('receive/main.js', 'const RECEIVER_RUNTIME_BUILD = "v0.5.288";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.289";')
rep('send/main.js', 'const SEND_RUNTIME_BUILD = "v0.5.288";', 'const SEND_RUNTIME_BUILD = "v0.5.289";')
rep('main.js', 'const APP_BUILD = "v0.5.288";', 'const APP_BUILD = "v0.5.289";')
rep('index.html', 'main.js?build=v0.5.288', 'main.js?build=v0.5.289')
rep('index.html', '<span class="brand">AirGapper <span class="app-version">v0.5.288</span></span>', '<span class="brand">AirGapper <span class="app-version">v0.5.289</span></span>')
rep('sw.js', 'airgapper-static-js-v236', 'airgapper-static-js-v237')

# Startup optics must be quick enough to rescue a bad initial exposure before the
# user concludes Receive is stuck. A QR-proven remembered setting gets the first
# shot; if it produces no QR quickly, meter the current scene briefly and move on.
rep('receive/main.js', 'const AUTO_OPTICS_ACQUISITION_RESCUE_MS = 2500;', 'const AUTO_OPTICS_ACQUISITION_RESCUE_MS = 650;')
rep('receive/main.js', 'const AUTO_OPTICS_RESCUE_RETRY_MS = 12000;', 'const AUTO_OPTICS_RESCUE_RETRY_MS = 3000;')
rep('receive/main.js', 'const AUTO_OPTICS_MEMORY_BOOT_MAX_MS = 1600;', 'const AUTO_OPTICS_MEMORY_BOOT_MAX_MS = 650;')

# The developer Optimize button had the same photography-oriented shutter bug as
# old Auto: at 30 fps its ceiling was ~26.7 ms, so 85/72/60% probes never reached
# the manually-proven ~3 ms region. Cap the search seed to 18% of one frame; its
# existing downward probes now cover roughly 5.1, 4.3 and 3.6 ms at 30 fps.
rep('receive/focus-controller.js', 'const frameSafeMax = 8e3 / observedFps;', 'const frameSafeMax = 1e4 / observedFps * 0.18;')

# Shared pre-lock helper. Hardware AE is useful as a LIGHT METER, not as the
# final QR policy. Convert its exposure product immediately into a <=3.5 ms
# shutter and enough gain to preserve the deliberately dark (-0.8 EV) QR target.
# If minimum ISO is already too bright, shorten the shutter further rather than
# accepting an overexposed image.
rep('receive/main.js', '''function cameraSettingNear(value, target, range) {
  if (!Number.isFinite(value) || !Number.isFinite(target)) return false;
  const step = Number(range?.step) || 0;
  return Math.abs(value - target) <= Math.max(step * 0.75, Math.abs(target) * 0.02, 1e-6);
}
async function primeAutomaticQrOpticsStartup(track) {''', '''function cameraSettingNear(value, target, range) {
  if (!Number.isFinite(value) || !Number.isFinite(target)) return false;
  const step = Number(range?.step) || 0;
  return Math.abs(value - target) <= Math.max(step * 0.75, Math.abs(target) * 0.02, 1e-6);
}
function automaticShortShutterSeed(baseline, exposureRange, isoRange, fps) {
  const aeProduct = baseline.exposure * baseline.iso;
  const targetProduct = Math.max(exposureRange.min * isoRange.min, aeProduct * AUTO_QR_LIGHT_SCALE);
  let exposure = quantizeCameraRange(
    Math.min(exposureRange.max, AUTO_OPTICS_MAX_SHORT_EXPOSURE, 1e4 / fps * AUTO_OPTICS_SHUTTER_FRAME_FRACTION),
    exposureRange
  );
  if (targetProduct / Math.max(exposureRange.min, exposure) < isoRange.min) {
    exposure = quantizeCameraRange(
      Math.max(exposureRange.min, Math.min(exposure, targetProduct / isoRange.min)),
      exposureRange
    );
  }
  const iso = quantizeCameraRange(
    Math.max(isoRange.min, Math.min(isoRange.max, targetProduct / Math.max(exposureRange.min, exposure))),
    isoRange
  );
  return { exposure, iso, aeProduct, targetProduct };
}
async function readAutomaticAeBaseline(track) {
  const beforeSequence = latestSourceFrameSequence;
  await applyExposureSetting(track);
  if (!automaticOpticsSessionAlive(track)) return void 0;
  await waitForFreshAutoOpticsFrames(track, beforeSequence, 2, 500);
  if (!automaticOpticsSessionAlive(track)) return void 0;
  const settings = track.getSettings();
  const exposure = Number(settings.exposureTime);
  const iso = Number(settings.iso);
  if (!(exposure > 0) || !(iso > 0)) return void 0;
  return { exposure, iso, at: receiverNow() };
}
async function applyAutomaticShortSeed(track, baseline, reason) {
  const caps = track.getCapabilities?.() ?? {};
  const exposureRange = caps.exposureTime;
  const isoRange = caps.iso;
  if (!baseline || !exposureRange || !isoRange) return false;
  const settings = track.getSettings();
  const fps = Math.max(12, Math.min(120, Number(settings.frameRate) || 30));
  const seed = automaticShortShutterSeed(baseline, exposureRange, isoRange, fps);
  const accepted = await applyCameraConstraint(track, {
    exposureMode: "manual",
    exposureTime: seed.exposure,
    iso: seed.iso
  });
  if (!accepted || !automaticOpticsSessionAlive(track)) return false;
  const actual = track.getSettings();
  autoOpticsAeBaseline = { ...baseline, at: receiverNow() };
  autoOpticsRuntimeState = "seed";
  autoOpticsMemoryBootAt = 0;
  autoOpticsMemoryBoot = void 0;
  autoOpticsLockSince = 0;
  autoOpticsAcquisitionSince = receiverNow();
  autoOpticsRetryAt = 0;
  autoOpticsRescueRetryAt = autoOpticsAcquisitionSince + AUTO_OPTICS_ACQUISITION_RESCUE_MS;
  autoOpticsTuneSummary = `${reason} · ${formatExposureMs(actual.exposureTime ?? seed.exposure)} · ISO ${Math.round(actual.iso ?? seed.iso)}`;
  focusController.adoptAutomaticCameraState("short-shutter automatic optics bootstrap active before QR lock");
  notePipelineEvent("auto-optics-short-seed");
  return true;
}
async function primeAutomaticQrOpticsStartup(track) {''')

# Memory is a fast first guess, not an assumption. Restore a sufficiently recent
# QR-proven winner immediately. This makes repeat scans start at the previous good
# camera state instead of waiting for photography AE. If the HAL rejects it, or
# no memory exists, take a brief AE meter reading and immediately hand off to the
# short-shutter seed before acquisition has to find a QR.
sub('receive/main.js',
    r'async function primeAutomaticQrOpticsStartup\(track\) \{.*?\n\}\nasync function abandonAutomaticOpticsStartupMemory',
'''async function primeAutomaticQrOpticsStartup(track) {
  if (!automaticOpticsSessionAlive(track) || autoOpticsMutationRunning) return;
  const caps = track.getCapabilities?.() ?? {};
  const exposureRange = caps.exposureTime;
  const isoRange = caps.iso;
  const saved = usableAutomaticOpticsMemory(track) ?? bestAutomaticOpticsHistory(track);
  const canManual = Array.isArray(caps.exposureMode) && caps.exposureMode.includes("manual") && exposureRange && isoRange;

  if (canManual && automaticOpticsMemoryHealthy(saved)) {
    const exposure = quantizeCameraRange(saved.exposure, exposureRange);
    const iso = quantizeCameraRange(saved.iso, isoRange);
    autoOpticsMutationRunning = true;
    try {
      const accepted = await applyCameraConstraint(track, { exposureMode: "manual", exposureTime: exposure, iso });
      if (!automaticOpticsSessionAlive(track)) return;
      const actual = track.getSettings();
      const restored = accepted && actual.exposureMode === "manual" &&
        cameraSettingNear(actual.exposureTime, exposure, exposureRange) &&
        cameraSettingNear(actual.iso, iso, isoRange);
      if (restored) {
        const now = receiverNow();
        autoOpticsRuntimeState = "memory";
        autoOpticsMemoryBootAt = now;
        autoOpticsMemoryBoot = {
          exposure: Number(actual.exposureTime) || exposure,
          iso: Number(actual.iso) || iso,
          yieldRate: Number(saved.yieldRate) || 0
        };
        autoOpticsAcquisitionSince = now;
        autoOpticsRetryAt = Infinity;
        autoOpticsRescueRetryAt = 0;
        autoOpticsHeldYield = autoOpticsMemoryBoot.yieldRate;
        autoOpticsTuneSummary = `recent winner · ${formatExposureMs(autoOpticsMemoryBoot.exposure)} · ISO ${Math.round(autoOpticsMemoryBoot.iso)} · validating`;
        focusController.adoptAutomaticCameraState("restored recent QR-proven automatic optics before acquisition");
        notePipelineEvent("auto-optics-memory-start");
        return;
      }
    } finally {
      autoOpticsMutationRunning = false;
    }
  }

  autoOpticsRuntimeState = "ae";
  autoOpticsMemoryBootAt = 0;
  autoOpticsMemoryBoot = void 0;
  autoOpticsRetryAt = 0;
  autoOpticsRescueRetryAt = 0;
  const baseline = await readAutomaticAeBaseline(track);
  if (!automaticOpticsSessionAlive(track)) return;
  if (canManual && baseline && await applyAutomaticShortSeed(track, baseline, "AE-metered seed")) return;
  autoOpticsRuntimeState = "ae";
  autoOpticsAcquisitionSince = receiverNow();
  autoOpticsTuneSummary = "hardware AE · manual exposure unavailable";
}
async function abandonAutomaticOpticsStartupMemory''')

# A failed memory trial means the scene changed, not that memory was a bad idea.
# Briefly enable AE only to measure today's light product, then immediately return
# to a short manual shutter. Do not invalidate the saved winner just because focus
# or framing happened to be poor during this one startup.
sub('receive/main.js',
    r'async function abandonAutomaticOpticsStartupMemory\(track, reason = "startup winner produced no QR"\) \{.*?\n\}\nfunction rememberAutomaticOptics',
'''async function abandonAutomaticOpticsStartupMemory(track, reason = "startup winner produced no QR") {
  if (autoOpticsMutationRunning || !automaticOpticsSessionAlive(track) || autoOpticsRuntimeState !== "memory") return;
  autoOpticsMutationRunning = true;
  try {
    const baseline = await readAutomaticAeBaseline(track);
    if (!automaticOpticsSessionAlive(track)) return;
    if (baseline && await applyAutomaticShortSeed(track, baseline, `${reason} · AE re-metered`)) return;
    const now = receiverNow();
    autoOpticsRuntimeState = "ae";
    autoOpticsMemoryBootAt = 0;
    autoOpticsMemoryBoot = void 0;
    autoOpticsLockSince = 0;
    autoOpticsAcquisitionSince = now;
    autoOpticsRetryAt = 0;
    autoOpticsRescueRetryAt = now + AUTO_OPTICS_ACQUISITION_RESCUE_MS;
    autoOpticsHoldSample = void 0;
    autoOpticsHoldCollapseSince = 0;
    autoOpticsHeldYield = 0;
    autoOpticsTuneSummary = `${reason} · hardware AE fallback`;
    focusController.adoptAutomaticCameraState("recent automatic optics unconfirmed; hardware AE fallback");
    notePipelineEvent("auto-optics-memory-fallback");
  } finally {
    autoOpticsMutationRunning = false;
  }
}
function rememberAutomaticOptics''')

# Pre-lock acquisition search: deterministic, short-shutter, and centered on the
# current AE light meter. Learned alternatives are tried first, then darker /
# brighter brackets around the physics-derived seed, one faster equivalent-light
# candidate, one bounded 5 ms low-light escape, and finally raw AE. No randomized
# candidate order means identical conditions produce identical startup behavior.
sub('receive/main.js',
    r'function shuffleAutomaticOpticsCandidates\(items\) \{.*?\n\}\nfunction buildAutomaticOpticsAcquisitionCandidates\(track, aeBaseline, exposureRange, isoRange, fps\) \{.*?\n\}\nasync function measureAutomaticAcquisitionCandidate',
'''function buildAutomaticOpticsAcquisitionCandidates(track, aeBaseline, exposureRange, isoRange, fps) {
  const seed = automaticShortShutterSeed(aeBaseline, exposureRange, isoRange, fps);
  const current = track.getSettings();
  const currentKey = Number.isFinite(current.exposureTime) && Number.isFinite(current.iso)
    ? autoOpticsHistoryConfigKey(current.exposureTime, current.iso)
    : "";
  const candidates = [];
  const seen = new Set();
  const add = (exposureRaw, isoRaw, label, allowCurrent = false) => {
    const exposure = quantizeCameraRange(exposureRaw, exposureRange);
    const iso = quantizeCameraRange(isoRaw, isoRange);
    const key = autoOpticsHistoryConfigKey(exposure, iso);
    if (seen.has(key) || !allowCurrent && key === currentKey) return;
    seen.add(key);
    candidates.push({ exposure, iso, label });
  };

  for (const item of readAutomaticOpticsHistory(track).slice(0, 2))
    add(item.exposure, item.iso, "learned");
  const memory = usableAutomaticOpticsMemory(track);
  if (memory) add(memory.exposure, memory.iso, "recent winner");
  add(seed.exposure, seed.iso / Math.SQRT2, "darker");
  add(seed.exposure, seed.iso * Math.SQRT2, "brighter");
  add(seed.exposure, seed.iso * 2, "bright rescue");
  const fasterExposure = quantizeCameraRange(Math.max(exposureRange.min, seed.exposure / Math.SQRT2), exposureRange);
  add(fasterExposure, seed.targetProduct / Math.max(exposureRange.min, fasterExposure), "faster");
  const lowLightExposure = quantizeCameraRange(
    Math.min(exposureRange.max, AUTO_OPTICS_FALLBACK_EXPOSURE, 1e4 / fps * 0.18),
    exposureRange
  );
  if (lowLightExposure > seed.exposure * 1.08)
    add(lowLightExposure, seed.targetProduct / Math.max(exposureRange.min, lowLightExposure), "low-light");
  add(aeBaseline.exposure, aeBaseline.iso, "hardware AE", true);
  return candidates;
}
async function measureAutomaticAcquisitionCandidate''')

# The rescue race already existed but was unreachable. Preserve the actual AE
# baseline even while the camera is holding a manual short seed, and on a miss
# keep the short seed rather than whichever stale history item happened to be
# first. Return to `seed`, not logical AE, so the maintenance state machine can
# retry without lying about camera ownership.
rep('receive/main.js', '''  const fps = Math.max(12, Math.min(120, Number(settings.frameRate) || 30));
  const aeBaseline = { exposure: settings.exposureTime, iso: settings.iso, at: receiverNow() };
  const candidates = buildAutomaticOpticsAcquisitionCandidates(track, aeBaseline, exposureRange, isoRange, fps);''', '''  const fps = Math.max(12, Math.min(120, Number(settings.frameRate) || 30));
  const savedAe = autoOpticsAeBaseline && receiverNow() - autoOpticsAeBaseline.at < 10000
    ? autoOpticsAeBaseline
    : void 0;
  const aeBaseline = savedAe ?? { exposure: settings.exposureTime, iso: settings.iso, at: receiverNow() };
  const candidates = buildAutomaticOpticsAcquisitionCandidates(track, aeBaseline, exposureRange, isoRange, fps);''')
rep('receive/main.js', '''    const hold = candidates[0];
    await applyCameraConstraint(track, {
      exposureMode: "manual",
      exposureTime: hold.exposure,
      iso: hold.iso
    });
    const actual = track.getSettings();
    autoOpticsRuntimeState = "ae";
    autoOpticsLockSince = 0;
    autoOpticsAcquisitionSince = receiverNow();
    autoOpticsRescueRetryAt = receiverNow() + AUTO_OPTICS_RESCUE_RETRY_MS;''', '''    const seed = automaticShortShutterSeed(aeBaseline, exposureRange, isoRange, fps);
    const hold = { exposure: seed.exposure, iso: seed.iso, label: "short-shutter seed" };
    await applyCameraConstraint(track, {
      exposureMode: "manual",
      exposureTime: hold.exposure,
      iso: hold.iso
    });
    const actual = track.getSettings();
    autoOpticsRuntimeState = "seed";
    autoOpticsLockSince = 0;
    autoOpticsAcquisitionSince = receiverNow();
    autoOpticsRescueRetryAt = receiverNow() + AUTO_OPTICS_RESCUE_RETRY_MS;''')

# Movement invalidates a comparison; it is not evidence that short manual optics
# failed. Keep the current short-shutter candidate and retry after framing settles
# instead of flashing back to photography AE every time the user moves the phone.
rep('receive/main.js', '''    if (tuned.deferred || tuned.collapsed || !tuned.best?.valid) {
      const why = tuned.deferred ? "comparison invalidated; hold framing" : "short shutter too dark";
      await applyExposureSetting(track);
      if (!automaticOpticsSessionAlive(track)) return;
      autoOpticsRuntimeState = "ae";
      autoOpticsLockSince = 0;
      autoOpticsAcquisitionSince = receiverNow();
      autoOpticsRetryAt = receiverNow() + (tuned.deferred ? 500 : AUTO_OPTICS_COLLAPSE_RETRY_MS);
      autoOpticsTuneSummary = `${why} · hardware AE until clean retry`;
      if (tuned.collapsed) forgetAutomaticOptics(track);
      focusController.adoptAutomaticCameraState("automatic optics comparison invalid; hardware AE retained until clean retry");
      return;
    }''', '''    if (tuned.deferred) {
      autoOpticsRuntimeState = "ae";
      autoOpticsLockSince = 0;
      autoOpticsRetryAt = receiverNow() + 350;
      autoOpticsTuneSummary = "comparison invalidated by movement · holding short shutter";
      focusController.adoptAutomaticCameraState("automatic optics comparison deferred; current short-shutter setting held until framing stabilizes");
      return;
    }
    if (tuned.collapsed || !tuned.best?.valid) {
      await applyExposureSetting(track);
      if (!automaticOpticsSessionAlive(track)) return;
      autoOpticsRuntimeState = "ae";
      autoOpticsLockSince = 0;
      autoOpticsAcquisitionSince = receiverNow();
      autoOpticsRetryAt = receiverNow() + AUTO_OPTICS_COLLAPSE_RETRY_MS;
      autoOpticsTuneSummary = "short shutter too dark · hardware AE until clean retry";
      if (tuned.collapsed) forgetAutomaticOptics(track);
      focusController.adoptAutomaticCameraState("bounded short-shutter search failed; hardware AE retained until clean retry");
      return;
    }''')

# Complete the state machine. v288 had a full acquisition rescue implementation
# but the normal pre-lock branch returned without ever calling it. Memory now has
# a short validation deadline; any real QR extends that deadline while grid
# geometry finishes. A confirmed remembered setting becomes the held winner
# immediately. The short seed gets the same treatment: if it sees QR payloads,
# don't mutate exposure while the lattice is finishing lock; otherwise race the
# deterministic alternatives after 650 ms.
rep('receive/main.js', '''  if (autoOpticsRuntimeState !== "ae") return;

  // Cold acquisition stays on hardware AE. Remembered manual exposure can be
  // badly wrong when ambient/screen brightness changed since the last session;
  // applying it before the first QR used to create multi-second startup stalls.
  // Remembered ISO is deliberately not used before first lock; memory is reused
  // only after acquisition for the normal motion-safe shutter/ISO tuning pass.
  if (!gridLattice.locked) {
    autoOpticsLockSince = 0;
    return;
  }
  if (!autoOpticsPoseUsable(autoOpticsPoseSnapshot())) {''', '''  if (autoOpticsRuntimeState === "memory") {
    const bootAt = autoOpticsMemoryBootAt || autoOpticsAcquisitionSince || now;
    const decodedOnMemory = lastStreamDecodeAt >= bootAt;
    if (gridLattice.locked) {
      autoOpticsRuntimeState = "manual";
      autoOpticsHoldSample = autoOpticsPipelineSnapshot();
      autoOpticsHoldCollapseSince = 0;
      autoOpticsHeldYield = Math.max(AUTO_OPTICS_MEMORY_MIN_YIELD, Number(autoOpticsMemoryBoot?.yieldRate) || autoOpticsHeldYield || 0);
      autoOpticsRetryAt = Infinity;
      autoOpticsTuneSummary = `recent winner confirmed · hold ${(autoOpticsHeldYield * 100).toFixed(0)}%`;
      autoOpticsMemoryBootAt = 0;
      autoOpticsMemoryBoot = void 0;
      focusController.adoptAutomaticCameraState("remembered automatic optics produced live QR and were confirmed");
      notePipelineEvent("auto-optics-memory-confirmed");
      return;
    }
    if (decodedOnMemory) {
      // Payload validity already proves the optics. Give lattice geometry time to
      // finish without changing camera state underneath acquisition.
      autoOpticsMemoryBootAt = now;
      return;
    }
    if (now - bootAt >= AUTO_OPTICS_MEMORY_BOOT_MAX_MS)
      void abandonAutomaticOpticsStartupMemory(track);
    return;
  }

  if (autoOpticsRuntimeState === "seed") {
    const seedDecoded = lastStreamDecodeAt >= autoOpticsAcquisitionSince;
    if (gridLattice.locked) {
      // Preserve the current manual seed, but hand the post-lock state machine
      // the AE product that created it so normal robustness-boundary tuning can
      // refine ISO after framing settles.
      autoOpticsRuntimeState = "ae";
      autoOpticsLockSince = now;
      autoOpticsRetryAt = 0;
      return;
    }
    if (seedDecoded) {
      autoOpticsAcquisitionSince = now;
      return;
    }
    if (now - autoOpticsAcquisitionSince >= AUTO_OPTICS_ACQUISITION_RESCUE_MS && now >= autoOpticsRescueRetryAt)
      void rescueAutomaticQrAcquisition(track, now);
    return;
  }

  if (autoOpticsRuntimeState === "rescue" || autoOpticsRuntimeState === "tuning" || autoOpticsRuntimeState === "settling") return;
  if (autoOpticsRuntimeState !== "ae") return;

  if (!gridLattice.locked) {
    autoOpticsLockSince = 0;
    if (now - autoOpticsAcquisitionSince >= AUTO_OPTICS_ACQUISITION_RESCUE_MS && now >= autoOpticsRescueRetryAt)
      void rescueAutomaticQrAcquisition(track, now);
    return;
  }
  if (!autoOpticsPoseUsable(autoOpticsPoseSnapshot())) {''')

# Make diagnostics truthful about what owns the sensor before lock.
rep('receive/main.js', '''autoOpticsRuntimeState === "memory" ? " · restoring recent winner" : autoOpticsRuntimeState === "ae" ? " · bootstrap AE" : autoOpticsRuntimeState === "tuning" ? " · live ISO search" : ""''', '''autoOpticsRuntimeState === "memory" ? " · validating recent winner" : autoOpticsRuntimeState === "seed" ? " · short-shutter bootstrap" : autoOpticsRuntimeState === "rescue" ? " · acquisition exposure search" : autoOpticsRuntimeState === "ae" ? " · AE meter/fallback" : autoOpticsRuntimeState === "tuning" ? " · live ISO search" : ""''')

# Intent guards.
main = Path('receive/main.js').read_text()
focus = Path('receive/focus-controller.js').read_text()
for needle in [
    'const RECEIVER_RUNTIME_BUILD = "v0.5.289";',
    'restored recent QR-proven automatic optics before acquisition',
    'autoOpticsRuntimeState = "seed";',
    'void rescueAutomaticQrAcquisition(track, now);',
    'automaticShortShutterSeed',
    'comparison invalidated by movement · holding short shutter',
    'recent winner confirmed',
    'acquisition exposure search'
]:
    if needle not in main:
        raise SystemExit(f'missing v289 invariant: {needle}')
if main.count('void rescueAutomaticQrAcquisition(track, now);') < 2:
    raise SystemExit('pre-lock rescue is still not wired into both seed and AE fallback states')
if 'shuffleAutomaticOpticsCandidates' in main:
    raise SystemExit('randomized acquisition exposure ordering survived')
if 'const frameSafeMax = 1e4 / observedFps * 0.18;' not in focus:
    raise SystemExit('manual Optimize still cannot reach short-shutter regime')
