from pathlib import Path

path = Path("receive/runtime.js")
source = path.read_text()


def replace_once(old, new, label):
    global source
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    source = source.replace(old, new, 1)


def replace_after(marker, old, new, label):
    global source
    start = source.find(marker)
    if start < 0:
        raise SystemExit(f"{label}: marker missing")
    at = source.find(old, start)
    if at < 0:
        raise SystemExit(f"{label}: target missing")
    source = source[:at] + new + source[at + len(old):]


replace_once(
    'const AUTO_OPTICS_AE_RESCUE_RETRY_MS = 3000;\nconst AUTO_OPTICS_SHORT_EXPOSURE_TRIGGER = 55; // 5.5 ms',
    'const AUTO_OPTICS_AE_RESCUE_RETRY_MS = 3000;\nconst AUTO_OPTICS_AE_VALIDATION_RETRY_MS = 4000;\nconst AUTO_OPTICS_SHORT_EXPOSURE_TRIGGER = 55; // 5.5 ms',
    "AE validation retry constant"
)

replace_after(
    'async function abandonAutomaticShortSeed(track, reason = "short-shutter seed produced no QR") {',
    '''    autoOpticsAeBaseline = baseline;\n    autoOpticsSeedAttempt = 0;\n    autoOpticsRuntimeState = "ae";''',
    '''    autoOpticsAeBaseline = baseline;\n    autoOpticsRuntimeState = "ae";''',
    "preserve exhausted seed position"
)
replace_after(
    'async function abandonAutomaticShortSeed(track, reason = "short-shutter seed produced no QR") {',
    '''    autoOpticsRetryAt = Infinity;\n    autoOpticsRescueRetryAt = Infinity;''',
    '''    autoOpticsRetryAt = now + AUTO_OPTICS_LOCK_SETTLE_MS;\n    autoOpticsRescueRetryAt = now + AUTO_OPTICS_AE_RESCUE_RETRY_MS;''',
    "observe AE after seed ladder"
)

helper = r'''async function validateAutomaticAeHold(track, now, exposureRange, isoRange) {
  autoOpticsMutationRunning = true;
  autoOpticsRuntimeState = "settling";
  autoOpticsControllerState = "LEARN";
  try {
    const cohortSize = beginAutomaticOpticsMeasurementCohort();
    if (!cohortSize) {
      autoOpticsRuntimeState = "ae";
      autoOpticsControllerState = "ACQUIRE";
      autoOpticsRetryAt = receiverNow() + AUTO_OPTICS_AE_VALIDATION_RETRY_MS;
      autoOpticsTuneSummary = "hardware AE · waiting for measurable QR cohort";
      return;
    }

    const before = track.getSettings();
    const beforeExposure = Number(before.exposureTime);
    const beforeIso = Number(before.iso);
    if (!(beforeExposure > 0) || !(beforeIso > 0)) {
      autoOpticsRuntimeState = "ae";
      autoOpticsControllerState = "ACQUIRE";
      autoOpticsRetryAt = receiverNow() + AUTO_OPTICS_AE_VALIDATION_RETRY_MS;
      autoOpticsTuneSummary = "hardware AE · waiting for stable sensor readback";
      return;
    }

    const sample = await sampleAutomaticOpticsQuality(
      track, beforeIso, latestSourceFrameSequence + 1, AUTO_OPTICS_BASELINE_SAMPLE_MS
    );
    if (!automaticOpticsSessionAlive(track)) return;
    const after = track.getSettings();
    const afterExposure = Number(after.exposureTime);
    const afterIso = Number(after.iso);
    const beforeProduct = beforeExposure * beforeIso;
    const afterProduct = afterExposure * afterIso;
    const aeDrift = beforeProduct > 0 && afterProduct > 0
      ? Math.abs(Math.log2(afterProduct / beforeProduct))
      : Infinity;

    if (!sample || aeDrift > 0.25 || !automaticOpticsHoldEligible(sample)) {
      const measuredYield = Math.max(0, Number(sample?.yieldRate) || 0);
      const measuredBreadth = Math.max(0, Number(sample?.breadth) || 0);
      const measuredTail = Math.max(0, Number(sample?.tailYield) || 0);
      autoOpticsRuntimeState = "ae";
      autoOpticsControllerState = "ACQUIRE";
      autoOpticsRetryAt = receiverNow() + AUTO_OPTICS_AE_VALIDATION_RETRY_MS;
      autoOpticsHeldYield = 0;
      autoOpticsHoldSample = void 0;
      autoOpticsTuneSummary = aeDrift > 0.25
        ? `hardware AE still settling · ${aeDrift.toFixed(2)} EV drift`
        : `hardware AE unproven ${(measuredYield * 100).toFixed(0)}% · breadth ${(measuredBreadth * 100).toFixed(0)}% · tail ${(measuredTail * 100).toFixed(0)}%`;
      return;
    }

    const winnerExposure = quantizeCameraRange(afterExposure, exposureRange);
    const winnerIso = quantizeCameraRange(afterIso, isoRange);
    const accepted = await applyCameraConstraint(track, {
      exposureMode: "manual",
      exposureTime: winnerExposure,
      iso: winnerIso
    });
    if (!accepted || !automaticOpticsSessionAlive(track)) {
      autoOpticsRuntimeState = "ae";
      autoOpticsControllerState = "ACQUIRE";
      autoOpticsRetryAt = receiverNow() + AUTO_OPTICS_AE_VALIDATION_RETRY_MS;
      autoOpticsTuneSummary = "hardware AE proven but manual freeze rejected";
      return;
    }

    autoOpticsRuntimeState = "manual";
    autoOpticsControllerState = "HOLD";
    autoOpticsHeldYield = Math.max(0.01, Number(sample.yieldRate) || 0);
    autoOpticsHoldSample = autoOpticsPipelineSnapshot();
    autoOpticsHoldCollapseSince = 0;
    autoOpticsRetryAt = Infinity;
    autoOpticsAeBaseline = { exposure: winnerExposure, iso: winnerIso, at: receiverNow(), neutral: true };
    if (autoOpticsHeldYield >= AUTO_OPTICS_MEMORY_MIN_YIELD)
      rememberAutomaticOptics(track, winnerExposure, winnerIso, Number(sample.score) || 0,
        autoOpticsHeldYield, winnerExposure * winnerIso, Number(sample.tailYield) || 0);
    autoOpticsTuneSummary = `hardware AE proven · ${formatExposureMs(winnerExposure)} · ISO ${Math.round(winnerIso)} · hold ${(autoOpticsHeldYield * 100).toFixed(0)}%`;
    focusController.adoptAutomaticCameraState("QR-proven hardware AE values frozen; automatic optics now held");
  } finally {
    autoOpticsMeasurementSlots = void 0;
    autoOpticsMutationRunning = false;
  }
}
'''
replace_once(
    'async function settleAutomaticQrOptics(track, now) {',
    helper + 'async function settleAutomaticQrOptics(track, now) {',
    "AE observation helper"
)
replace_once(
    '''async function settleAutomaticQrOptics(track, now) {\n  if (autoOpticsMutationRunning || !automaticOptics || now < autoOpticsRetryAt) return;\n  const startedFromMemory = autoOpticsRuntimeState === "memory";''',
    '''async function settleAutomaticQrOptics(track, now) {\n  if (autoOpticsMutationRunning || !automaticOptics || now < autoOpticsRetryAt) return;\n  const startedFromMemory = autoOpticsRuntimeState === "memory";\n  const startedFromAe = autoOpticsRuntimeState === "ae";''',
    "AE settle source"
)
replace_once(
    '''  if (!await waitForStableAutoOpticsPose(track, AUTO_OPTICS_POSE_WAIT_MS)) {\n    autoOpticsLockSince = now;\n    autoOpticsRetryAt = now + 600;\n    autoOpticsTuneSummary = "hardware AE · waiting for stable QR geometry";\n    return;\n  }\n\n  autoOpticsMutationRunning = true;''',
    '''  if (!await waitForStableAutoOpticsPose(track, AUTO_OPTICS_POSE_WAIT_MS)) {\n    autoOpticsLockSince = now;\n    autoOpticsRetryAt = now + 600;\n    autoOpticsTuneSummary = "hardware AE · waiting for stable QR geometry";\n    return;\n  }\n  if (startedFromAe) {\n    await validateAutomaticAeHold(track, now, exposureRange, isoRange);\n    return;\n  }\n\n  autoOpticsMutationRunning = true;''',
    "observe AE before manual freeze"
)

for marker in [
    'autoOpticsTuneSummary = "QR geometry not measurable · hardware AE fallback; no HOLD";',
    'autoOpticsTuneSummary = "QR optics measurement inconclusive · hardware AE fallback; no HOLD";',
    'autoOpticsTuneSummary = `${reason} · hardware AE fallback; no HOLD`;'
]:
    start = source.find(marker)
    if start < 0:
        raise SystemExit(f"fallback marker missing: {marker}")
    block_start = source.rfind('autoOpticsRetryAt = Infinity;', 0, start)
    rescue_start = source.find('autoOpticsRescueRetryAt = Infinity;', block_start, start)
    if block_start < 0 or rescue_start < 0:
        raise SystemExit(f"fallback retry pair missing: {marker}")
    source = source[:block_start] + 'autoOpticsRetryAt = receiverNow() + AUTO_OPTICS_LOCK_SETTLE_MS;' + source[block_start + len('autoOpticsRetryAt = Infinity;'):]
    rescue_start = source.find('autoOpticsRescueRetryAt = Infinity;', block_start, source.find(marker, block_start))
    source = source[:rescue_start] + 'autoOpticsRescueRetryAt = receiverNow() + AUTO_OPTICS_AE_RESCUE_RETRY_MS;' + source[rescue_start + len('autoOpticsRescueRetryAt = Infinity;'):]

path.write_text(source)

version_path = Path("version.js")
version = version_path.read_text()
if 'APP_VERSION = "0.5.456"' not in version:
    raise SystemExit("expected v0.5.456 before bump")
version_path.write_text(version.replace('APP_VERSION = "0.5.456"', 'APP_VERSION = "0.5.457"', 1))
