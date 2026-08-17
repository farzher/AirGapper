from pathlib import Path

p = Path("receive/main.js")
s = p.read_text()

old = '''let autoOpticsHoldSample;
let autoOpticsHoldCollapseSince = 0;
let autoOpticsHeldYield = 0;'''
new = '''let autoOpticsHoldSample;
let autoOpticsHoldCollapseSince = 0;
let autoOpticsHeldYield = 0;
let autoOpticsAeBaseline;'''
if old not in s: raise SystemExit("v189 held state anchor missing")
s = s.replace(old, new, 1)

old = '''  autoOpticsHoldSample = void 0;
  autoOpticsHoldCollapseSince = 0;
  autoOpticsHeldYield = 0;
  autoOpticsTuneSummary = "";'''
new = '''  autoOpticsHoldSample = void 0;
  autoOpticsHoldCollapseSince = 0;
  autoOpticsHeldYield = 0;
  autoOpticsAeBaseline = void 0;
  autoOpticsTuneSummary = "";'''
if old not in s: raise SystemExit("v189 reset baseline anchor missing")
s = s.replace(old, new, 1)

# settleAutomaticQrOptics must use the neutral AE snapshot if a successful cold
# rescue is currently holding a manual setting. Otherwise it would mistake that
# rescue candidate for hardware AE and apply the darkness bias a second time.
old = '''  const fps = Math.max(12, Math.min(120, Number(settings.frameRate) || 30));
  // exposureTime is reported in 0.1 ms units on Chromium camera controls.
  // 30% of a frame is 10 ms at 30 fps / 5 ms at 60 fps: short enough to cut
  // handheld/display-transition blur without demanding extreme gain.
  const motionSafeExposure = 1e4 / fps * AUTO_OPTICS_SHUTTER_FRAME_FRACTION;
  const aeExposureProduct = settings.exposureTime * settings.iso;
  const exposureProduct = aeExposureProduct * AUTO_QR_LIGHT_SCALE;
  const maxAutoIso = Math.min(isoRange.max, Math.max(isoRange.min, settings.iso * 4));
  let exposure = quantizeCameraRange(Math.min(settings.exposureTime, motionSafeExposure), exposureRange);'''
new = '''  const fps = Math.max(12, Math.min(120, Number(settings.frameRate) || 30));
  // exposureTime is reported in 0.1 ms units on Chromium camera controls.
  // 30% of a frame is 10 ms at 30 fps / 5 ms at 60 fps: short enough to cut
  // handheld/display-transition blur without demanding extreme gain.
  const motionSafeExposure = 1e4 / fps * AUTO_OPTICS_SHUTTER_FRAME_FRACTION;
  const savedAe = autoOpticsAeBaseline && receiverNow() - autoOpticsAeBaseline.at < 9000
    ? autoOpticsAeBaseline
    : void 0;
  const aeExposure = savedAe?.exposure ?? settings.exposureTime;
  const aeIso = savedAe?.iso ?? settings.iso;
  const aeExposureProduct = aeExposure * aeIso;
  const exposureProduct = aeExposureProduct * AUTO_QR_LIGHT_SCALE;
  const maxAutoIso = Math.min(isoRange.max, Math.max(isoRange.min, aeIso * 4));
  let exposure = quantizeCameraRange(Math.min(aeExposure, motionSafeExposure), exposureRange);'''
if old not in s: raise SystemExit("v189 settle AE product anchor missing")
s = s.replace(old, new, 1)

# Once normal post-lock tuning has taken over, the bootstrap AE snapshot has
# served its purpose.
old = '''    autoOpticsRuntimeState = "manual";
    autoOpticsHoldSample = autoOpticsPipelineSnapshot();'''
new = '''    autoOpticsRuntimeState = "manual";
    autoOpticsAeBaseline = void 0;
    autoOpticsHoldSample = autoOpticsPipelineSnapshot();'''
if old not in s: raise SystemExit("v189 settle clear baseline anchor missing")
s = s.replace(old, new, 1)

start = s.find('async function rescueAutomaticQrAcquisition(track, now) {')
end = s.find('\nfunction maintainAutomaticQrOptics(now) {', start)
if start < 0 or end < 0: raise SystemExit("v189 cold rescue boundaries missing")
new_func = r'''async function rescueAutomaticQrAcquisition(track, now) {
  if (autoOpticsMutationRunning || !automaticOptics || gridLattice.locked || now < autoOpticsRescueRetryAt) return;
  const caps = track.getCapabilities?.() ?? {};
  const exposureRange = caps.exposureTime;
  const isoRange = caps.iso;
  const settings = track.getSettings();
  if (!Array.isArray(caps.exposureMode) || !caps.exposureMode.includes("manual") || !exposureRange || !isoRange ||
      !Number.isFinite(settings.exposureTime) || !Number.isFinite(settings.iso) || settings.exposureTime <= 0 || settings.iso <= 0) {
    autoOpticsRescueRetryAt = now + AUTO_OPTICS_RESCUE_RETRY_MS;
    return;
  }

  const fps = Math.max(12, Math.min(120, Number(settings.frameRate) || 30));
  const motionSafeExposure = 1e4 / fps * AUTO_OPTICS_SHUTTER_FRAME_FRACTION;
  const aeBaseline = {
    exposure: settings.exposureTime,
    iso: settings.iso,
    at: receiverNow()
  };
  const aeProduct = aeBaseline.exposure * aeBaseline.iso;
  const baseExposure = quantizeCameraRange(Math.min(aeBaseline.exposure, motionSafeExposure), exposureRange);
  const scales = [AUTO_QR_LIGHT_SCALE, 1, Math.pow(2, 0.7), 2];
  const candidates = [];
  const seen = new Set();
  for (const scale of scales) {
    let exposure = baseExposure;
    let iso = quantizeCameraRange(aeProduct * scale / Math.max(exposureRange.min, exposure), isoRange);
    // If gain clips at the camera limit, recover as much of the requested light
    // product as possible without exceeding the motion-safe shutter.
    if (iso >= isoRange.max && aeProduct * scale / Math.max(isoRange.max, 1) > exposure) {
      exposure = quantizeCameraRange(
        Math.min(motionSafeExposure, aeProduct * scale / Math.max(isoRange.max, 1)),
        exposureRange
      );
      iso = quantizeCameraRange(aeProduct * scale / Math.max(exposureRange.min, exposure), isoRange);
    }
    const key = `${exposure.toFixed(4)}/${iso.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ exposure, iso, scale });
  }
  if (!candidates.length) {
    autoOpticsRescueRetryAt = now + AUTO_OPTICS_RESCUE_RETRY_MS;
    return;
  }

  autoOpticsMutationRunning = true;
  autoOpticsRuntimeState = "rescue";
  autoOpticsAeBaseline = aeBaseline;
  notePipelineEvent("auto-optics-cold-search");
  try {
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      autoOpticsTuneSummary = `cold search ${index + 1}/${candidates.length} · ${formatExposureMs(candidate.exposure)} · ISO ${Math.round(candidate.iso)} · ${Math.log2(candidate.scale).toFixed(1)}EV vs AE`;
      const accepted = await applyCameraConstraint(track, {
        exposureMode: "manual",
        exposureTime: candidate.exposure,
        iso: candidate.iso
      });
      if (!accepted || !automaticOpticsSessionAlive(track)) return;
      if (!await waitForAutoOptics(AUTO_OPTICS_RESCUE_SETTLE_MS, track)) return;
      const evidenceStart = receiverNow();
      if (!await waitForAutoOptics(Math.min(AUTO_OPTICS_RESCUE_SAMPLE_MS, 560), track)) return;
      const framedDecode = lastStreamDecodeAt >= evidenceStart;
      if (gridLattice.active || framedDecode) {
        // Keep the successful acquisition setting instead of immediately
        // flashing back to AE. Once geometry locks, settleAutomaticQrOptics()
        // uses autoOpticsAeBaseline above for the real bounded -0.7 EV search.
        autoOpticsRuntimeState = "ae";
        autoOpticsLockSince = 0;
        autoOpticsAcquisitionSince = receiverNow();
        autoOpticsRescueRetryAt = receiverNow() + 5000;
        autoOpticsTuneSummary = `cold search found QR · ${formatExposureMs(candidate.exposure)} · ISO ${Math.round(candidate.iso)} · awaiting lock`;
        focusController.adoptAutomaticCameraState("cold acquisition optics found AirGapper QR");
        notePipelineEvent("auto-optics-cold-search-hit");
        return;
      }
    }

    autoOpticsAeBaseline = void 0;
    await applyExposureSetting(track);
    autoOpticsRuntimeState = "ae";
    autoOpticsLockSince = 0;
    autoOpticsAcquisitionSince = receiverNow();
    autoOpticsRescueRetryAt = receiverNow() + AUTO_OPTICS_RESCUE_RETRY_MS;
    autoOpticsTuneSummary = "cold search missed · hardware AE restored";
    focusController.adoptAutomaticCameraState("cold acquisition optics search missed; hardware AE restored");
    notePipelineEvent("auto-optics-cold-search-miss");
  } finally {
    autoOpticsMutationRunning = false;
  }
}
'''
s = s[:start] + new_func + s[end:]

# Explicit session release/collapse must never retain a stale neutral-AE snapshot.
s = s.replace('''    autoOpticsHeldYield = 0;
    await applyExposureSetting(track);''',
              '''    autoOpticsHeldYield = 0;
    autoOpticsAeBaseline = void 0;
    await applyExposureSetting(track);''')

p.write_text(s)
