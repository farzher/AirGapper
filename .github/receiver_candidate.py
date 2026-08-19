from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing patch anchor in {path}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))


main = "receive/main.js"
replace_once(main, 'const RECEIVER_RUNTIME_BUILD = "v0.5.337";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.338";')
replace_once(main, 'const AUTO_QR_EV_BIAS = 0;', 'const AUTO_QR_EV_BIAS = -0.75;')
replace_once(main,
    'const AUTO_OPTICS_MEMORY_FRESH_MS = 12 * 60 * 60 * 1000;',
    'const AUTO_OPTICS_MEMORY_FRESH_MS = 7 * 24 * 60 * 60 * 1000;')

old_prime = '''async function primeAutomaticQrOpticsStartup(track) {
  if (!automaticOpticsSessionAlive(track) || autoOpticsMutationRunning) return;
  // Acquisition authority is hardware AE. A stale remembered/manual setting is
  // never allowed to make the camera blind before the first QR proves itself.
  autoOpticsMutationRunning = true;
  try {
    autoOpticsRuntimeState = "ae";
    autoOpticsMemoryBootAt = 0;
    autoOpticsMemoryBoot = void 0;
    autoOpticsHeldYield = 0;
    autoOpticsHoldSample = void 0;
    autoOpticsHoldCollapseSince = 0;
    autoOpticsAeRescueStep = 0;
    autoOpticsAeBias = 0;
    const baseline = await readAutomaticAeBaseline(track);
    if (!automaticOpticsSessionAlive(track)) return;
    autoOpticsAeBaseline = baseline;
    const now = receiverNow();
    autoOpticsAcquisitionSince = now;
    autoOpticsRetryAt = 0;
    autoOpticsRescueRetryAt = now + AUTO_OPTICS_ACQUISITION_RESCUE_MS;
    const settings = track.getSettings();
    autoOpticsTuneSummary = baseline
      ? `hardware AE acquisition · ${formatExposureMs(settings.exposureTime)} · ISO ${Math.round(settings.iso)}`
      : "hardware AE acquisition";
    focusController.adoptAutomaticCameraState("hardware AE owns acquisition until a QR proves the scene");
    notePipelineEvent("auto-optics-ae-acquire");
  } finally {
    autoOpticsMutationRunning = false;
  }
}
'''
new_prime = '''async function applyAutomaticOpticsMemoryBoot(track, saved) {
  if (!saved || !automaticOpticsMemoryHealthy(saved)) return false;
  const caps = track.getCapabilities?.() ?? {};
  const exposureRange = caps.exposureTime;
  const isoRange = caps.iso;
  const canManual = Array.isArray(caps.exposureMode) && caps.exposureMode.includes("manual") && exposureRange && isoRange;
  if (!canManual) return false;
  const exposure = quantizeCameraRange(saved.exposure, exposureRange);
  const iso = quantizeCameraRange(saved.iso, isoRange);
  const beforeSequence = latestSourceFrameSequence;
  const accepted = await applyCameraConstraint(track, {
    exposureMode: "manual",
    exposureTime: exposure,
    iso
  });
  if (!accepted || !automaticOpticsSessionAlive(track)) return false;
  await waitForFreshAutoOpticsFrames(track, beforeSequence, 1, 320);
  if (!automaticOpticsSessionAlive(track)) return false;
  const actual = track.getSettings();
  const now = receiverNow();
  autoOpticsRuntimeState = "memory";
  autoOpticsMemoryBootAt = now;
  autoOpticsMemoryBoot = { ...saved, exposure: Number(actual.exposureTime) || exposure, iso: Number(actual.iso) || iso };
  autoOpticsAeBaseline = void 0;
  autoOpticsLockSince = 0;
  autoOpticsAcquisitionSince = now;
  autoOpticsRetryAt = 0;
  autoOpticsRescueRetryAt = now + AUTO_OPTICS_MEMORY_BOOT_MAX_MS;
  autoOpticsTuneSummary = `remembered QR winner · ${formatExposureMs(autoOpticsMemoryBoot.exposure)} · ISO ${Math.round(autoOpticsMemoryBoot.iso)} · proving`;
  focusController.adoptAutomaticCameraState("recent QR-proven exposure restored before acquisition");
  notePipelineEvent("auto-optics-memory-boot");
  return true;
}
async function primeAutomaticQrOpticsStartup(track) {
  if (!automaticOpticsSessionAlive(track) || autoOpticsMutationRunning) return;
  autoOpticsMutationRunning = true;
  try {
    autoOpticsRuntimeState = "ae";
    autoOpticsMemoryBootAt = 0;
    autoOpticsMemoryBoot = void 0;
    autoOpticsHeldYield = 0;
    autoOpticsHoldSample = void 0;
    autoOpticsHoldCollapseSince = 0;
    autoOpticsAeRescueStep = 0;
    autoOpticsAeBias = 0;

    // The last CRC-proven manual setting is a much better prior for an emissive
    // QR wall than the camera's photographic AE. Try it first and require it to
    // prove itself quickly; a stale scene can never trap acquisition because the
    // memory state has a short deadline and automatically falls through.
    const memory = usableAutomaticOpticsMemory(track);
    if (memory && await applyAutomaticOpticsMemoryBoot(track, memory)) return;

    // No usable memory: consult AE only as a brief light meter, then immediately
    // leave it for a faster, deliberately darker shutter seed. Neutral AE remains
    // the final rescue path, not the default operating point.
    const baseline = await readAutomaticAeBaseline(track);
    if (!automaticOpticsSessionAlive(track)) return;
    if (baseline && await applyAutomaticShortSeed(track, baseline, "fast-dark startup seed")) return;

    autoOpticsAeBaseline = baseline;
    const now = receiverNow();
    autoOpticsRuntimeState = "ae";
    autoOpticsAcquisitionSince = now;
    autoOpticsRetryAt = 0;
    autoOpticsRescueRetryAt = now + AUTO_OPTICS_ACQUISITION_RESCUE_MS;
    const settings = track.getSettings();
    autoOpticsTuneSummary = baseline
      ? `hardware AE fallback · ${formatExposureMs(settings.exposureTime)} · ISO ${Math.round(settings.iso)}`
      : "hardware AE fallback";
    focusController.adoptAutomaticCameraState("fast-dark startup unavailable; hardware AE is rescue authority");
    notePipelineEvent("auto-optics-ae-acquire");
  } finally {
    autoOpticsMutationRunning = false;
  }
}
'''
replace_once(main, old_prime, new_prime)

replace_once(main,
    '  autoOpticsMutationRunning = true;\n  try {\n    const baseline = await readAutomaticAeBaseline(track);',
    '  autoOpticsMutationRunning = true;\n  try {\n    forgetAutomaticOptics(track);\n    const baseline = await readAutomaticAeBaseline(track);')

anchor = '''async function abandonAutomaticOpticsStartupMemory(track, reason = "startup winner produced no QR") {
'''
# Insert seed->AE fallback immediately before the existing memory fallback helper.
insert = '''async function abandonAutomaticShortSeed(track, reason = "fast-dark seed produced no QR") {
  if (autoOpticsMutationRunning || !automaticOpticsSessionAlive(track) || autoOpticsRuntimeState !== "seed") return;
  autoOpticsMutationRunning = true;
  try {
    const baseline = await readAutomaticAeBaseline(track);
    if (!automaticOpticsSessionAlive(track)) return;
    const now = receiverNow();
    autoOpticsAeBaseline = baseline;
    autoOpticsRuntimeState = "ae";
    autoOpticsMemoryBootAt = 0;
    autoOpticsMemoryBoot = void 0;
    autoOpticsLockSince = 0;
    autoOpticsAcquisitionSince = now;
    autoOpticsRetryAt = 0;
    autoOpticsRescueRetryAt = now + 300;
    autoOpticsHoldSample = void 0;
    autoOpticsHoldCollapseSince = 0;
    autoOpticsHeldYield = 0;
    autoOpticsTuneSummary = `${reason} · neutral AE rescue`;
    focusController.adoptAutomaticCameraState("fast-dark startup failed; hardware AE rescue enabled");
    notePipelineEvent("auto-optics-seed-fallback");
  } finally {
    autoOpticsMutationRunning = false;
  }
}
'''
replace_once(main, anchor, insert + anchor)

old_state = '''  if (autoOpticsRuntimeState === "rescue" || autoOpticsRuntimeState === "tuning" || autoOpticsRuntimeState === "settling") return;
  // Old session states from previous controller generations are not authoritative.
  if (autoOpticsRuntimeState === "memory" || autoOpticsRuntimeState === "seed") autoOpticsRuntimeState = "ae";
  if (autoOpticsRuntimeState !== "ae") return;

  if (!gridLattice.locked) {
    autoOpticsLockSince = 0;
    const recentDecode = Boolean(lastStreamDecodeAt && lastStreamDecodeAt >= autoOpticsAcquisitionSince && now - lastStreamDecodeAt < AUTO_OPTICS_RECENT_DECODE_MS);
    if (!recentDecode && now - autoOpticsAcquisitionSince >= AUTO_OPTICS_ACQUISITION_RESCUE_MS && now >= autoOpticsRescueRetryAt)
      void rescueAutomaticQrAcquisition(track, now);
    return;
  }
'''
new_state = '''  if (autoOpticsRuntimeState === "rescue" || autoOpticsRuntimeState === "tuning" || autoOpticsRuntimeState === "settling") return;

  if (autoOpticsRuntimeState === "memory") {
    const recentDecode = Boolean(lastStreamDecodeAt && lastStreamDecodeAt >= autoOpticsAcquisitionSince && now - lastStreamDecodeAt < AUTO_OPTICS_RECENT_DECODE_MS);
    if (gridLattice.locked && recentDecode) {
      const saved = autoOpticsMemoryBoot;
      autoOpticsRuntimeState = "manual";
      autoOpticsHeldYield = Math.max(AUTO_OPTICS_MEMORY_MIN_YIELD, Math.min(1, Number(saved?.yieldRate) || 0.75));
      autoOpticsHoldSample = autoOpticsPipelineSnapshot();
      autoOpticsHoldCollapseSince = 0;
      autoOpticsRetryAt = Infinity;
      autoOpticsTuneSummary = `remembered winner proven · ${formatExposureMs(saved?.exposure)} · ISO ${Math.round(saved?.iso || 0)} · hold ${(autoOpticsHeldYield * 100).toFixed(0)}%`;
      focusController.adoptAutomaticCameraState("remembered QR-proven exposure reacquired immediately and is held");
      notePipelineEvent("auto-optics-memory-proven", Math.round(autoOpticsHeldYield * 100));
      return;
    }
    if (!recentDecode && autoOpticsMemoryBootAt && now - autoOpticsMemoryBootAt >= AUTO_OPTICS_MEMORY_BOOT_MAX_MS)
      void abandonAutomaticOpticsStartupMemory(track);
    return;
  }

  const seededStartup = autoOpticsRuntimeState === "seed";
  if (autoOpticsRuntimeState !== "ae" && !seededStartup) return;

  if (!gridLattice.locked) {
    autoOpticsLockSince = 0;
    const recentDecode = Boolean(lastStreamDecodeAt && lastStreamDecodeAt >= autoOpticsAcquisitionSince && now - lastStreamDecodeAt < AUTO_OPTICS_RECENT_DECODE_MS);
    if (seededStartup) {
      if (!recentDecode && now - autoOpticsAcquisitionSince >= AUTO_OPTICS_ACQUISITION_RESCUE_MS)
        void abandonAutomaticShortSeed(track);
    } else if (!recentDecode && now - autoOpticsAcquisitionSince >= AUTO_OPTICS_ACQUISITION_RESCUE_MS && now >= autoOpticsRescueRetryAt) {
      void rescueAutomaticQrAcquisition(track, now);
    }
    return;
  }
'''
replace_once(main, old_state, new_state)

replace_once("main.js", 'const APP_BUILD = "v0.5.337";', 'const APP_BUILD = "v0.5.338";')
replace_once("sw.js", 'const CACHE = "airgapper-static-js-v285";', 'const CACHE = "airgapper-static-js-v286";')

print("v0.5.338 candidate applied")
