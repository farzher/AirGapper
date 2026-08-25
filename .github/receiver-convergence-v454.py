from pathlib import Path
import re


def replace_once(source, old, new, label):
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    return source.replace(old, new, 1)


def replace_after(source, marker, old, new, label):
    start = source.find(marker)
    if start < 0:
        raise SystemExit(f"{label}: marker missing")
    at = source.find(old, start)
    if at < 0:
        raise SystemExit(f"{label}: target missing")
    return source[:at] + new + source[at + len(old):]


def regex_once(source, pattern, replacement, label):
    source, count = re.subn(pattern, replacement, source, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    return source


runtime_path = Path("receive/runtime.js")
source = runtime_path.read_text()
if "automaticOpticsHoldEligible," not in source:
    source = replace_once(source,
'''import {
  acquisitionRacePolicy,
  automaticOpticsHoldThreshold,
  legacyTemporalRiskWeight
} from "./performance-policy.js";''',
'''import {
  acquisitionRacePolicy,
  automaticOpticsAcquisitionSeed,
  automaticOpticsHasAnotherAcquisitionSeed,
  automaticOpticsHoldEligible,
  automaticOpticsHoldThreshold,
  legacyTemporalRiskWeight,
  lockedRecoveryPolicy
} from "./performance-policy.js";''', "policy imports")

    source = replace_once(source,
'''const AUTO_QR_EV_BIAS = -0.75;
const AUTO_QR_LIGHT_SCALE = Math.pow(2, AUTO_QR_EV_BIAS);''',
'''const AUTO_QR_EV_BIAS = -0.75;''', "fixed light scale")
    source = replace_once(source,
'''const AUTO_OPTICS_SHUTTER_FRAME_FRACTION = 0.10;
const AUTO_OPTICS_MAX_SHORT_EXPOSURE = 35; // 3.5 ms; exposureTime uses 0.1 ms units
// After the motion-safe shutter handoff, tune gain against the decoder itself.''',
'''// After the motion-safe shutter handoff, tune gain against the decoder itself.''', "fixed shutter seed")
    source = replace_once(source,
'''let autoOpticsAeRescueStep = 0;
let autoOpticsAeBias = 0;''',
'''let autoOpticsAeRescueStep = 0;
let autoOpticsSeedAttempt = 0;
let autoOpticsAeBias = 0;''', "seed state")
    source = replace_after(source, "function resetAutomaticOpticsRuntime() {",
'''  autoOpticsAeRescueStep = 0;
  autoOpticsAeBias = 0;''',
'''  autoOpticsAeRescueStep = 0;
  autoOpticsSeedAttempt = 0;
  autoOpticsAeBias = 0;''', "seed runtime reset")
    source = replace_after(source, "async function primeAutomaticQrOpticsStartup(track) {",
'''    autoOpticsAeRescueStep = 0;
    autoOpticsAeBias = 0;''',
'''    autoOpticsAeRescueStep = 0;
    autoOpticsSeedAttempt = 0;
    autoOpticsAeBias = 0;''', "seed startup reset")

    source = replace_once(source,
'''function automaticShortShutterSeed(baseline, exposureRange, isoRange, fps) {
  const aeProduct = baseline.exposure * baseline.iso;
  // readAutomaticAeBaseline() is neutral. Apply AirGapper's deliberate darkness
  // preference exactly once here; remembered/manual winners bypass this meter.
  const targetProduct = Math.max(exposureRange.min * isoRange.min, aeProduct * AUTO_QR_LIGHT_SCALE);
  let exposure = quantizeCameraRange(
    Math.min(exposureRange.max, AUTO_OPTICS_MAX_SHORT_EXPOSURE, 1e4 / fps * AUTO_OPTICS_SHUTTER_FRAME_FRACTION),
    exposureRange
  );''',
'''function automaticShortShutterSeed(baseline, exposureRange, isoRange, fps) {
  const aeProduct = baseline.exposure * baseline.iso;
  const seedPolicy = automaticOpticsAcquisitionSeed(autoOpticsSeedAttempt);
  // Acquisition can explore both sides of the meter, but every seed keeps a
  // short shutter so rolling-shutter safety is never traded away.
  const targetProduct = Math.max(exposureRange.min * isoRange.min, aeProduct * seedPolicy.lightScale);
  let exposure = quantizeCameraRange(
    Math.min(exposureRange.max, seedPolicy.maxExposure, 1e4 / fps * seedPolicy.frameFraction),
    exposureRange
  );''', "seed policy wiring")
    source = replace_once(source,
'''  return { exposure, iso, aeProduct, targetProduct };
}''',
'''  return { exposure, iso, aeProduct, targetProduct, seedPolicy };
}''', "seed metadata")
    source = replace_once(source,
'''  autoOpticsTuneSummary = `${reason} · ${formatExposureMs(actual.exposureTime ?? seed.exposure)} · ISO ${Math.round(actual.iso ?? seed.iso)}`;''',
'''  autoOpticsTuneSummary = `${reason} · ${seed.seedPolicy.label} ${seed.seedPolicy.index + 1}/${seed.seedPolicy.count} · ${formatExposureMs(actual.exposureTime ?? seed.exposure)} · ISO ${Math.round(actual.iso ?? seed.iso)}`;''', "seed diagnostics")

    source = regex_once(source,
        r'''async function abandonAutomaticShortSeed\(track, reason = "fast-dark seed produced no QR"\) \{.*?\n\}\n(?=async function abandonAutomaticOpticsStartupMemory)''',
'''async function advanceAutomaticOpticsAcquisitionSeed(track, reason) {
  if (!automaticOpticsSessionAlive(track) || !autoOpticsAeBaseline ||
      !automaticOpticsHasAnotherAcquisitionSeed(autoOpticsSeedAttempt)) return false;
  autoOpticsSeedAttempt++;
  const next = automaticOpticsAcquisitionSeed(autoOpticsSeedAttempt);
  return applyAutomaticShortSeed(track, autoOpticsAeBaseline, `${reason} · trying ${next.label}`);
}
async function abandonAutomaticShortSeed(track, reason = "short-shutter seed produced no QR") {
  if (autoOpticsMutationRunning || !automaticOpticsSessionAlive(track) || autoOpticsRuntimeState !== "seed") return;
  autoOpticsMutationRunning = true;
  try {
    if (await advanceAutomaticOpticsAcquisitionSeed(track, reason)) return;
    const baseline = await readAutomaticAeBaseline(track);
    if (!automaticOpticsSessionAlive(track)) return;
    const now = receiverNow();
    autoOpticsAeBaseline = baseline;
    autoOpticsSeedAttempt = 0;
    autoOpticsRuntimeState = "ae";
    autoOpticsControllerState = "ACQUIRE";
    autoOpticsMemoryBootAt = 0;
    autoOpticsMemoryBoot = void 0;
    autoOpticsLockSince = 0;
    autoOpticsAcquisitionSince = now;
    autoOpticsRetryAt = Infinity;
    autoOpticsRescueRetryAt = Infinity;
    autoOpticsHoldSample = void 0;
    autoOpticsHoldCollapseSince = 0;
    autoOpticsHeldYield = 0;
    autoOpticsTuneSummary = `${reason} · QR seed ladder exhausted · hardware AE fallback`;
    focusController.adoptAutomaticCameraState("QR-specific short-shutter acquisition exhausted; hardware AE remains in control");
  } finally {
    autoOpticsMutationRunning = false;
  }
}
''', "bounded seed ladder")

    source = regex_once(source,
        r'''(if \(autoOpticsRuntimeState === "memory"\) \{.*?const recentDecode = .*?;\n)    if \(gridLattice\.locked && recentDecode\) \{.*?\n    \}\n(    if \(!recentDecode)''',
        r'''\1    if (gridLattice.locked && recentDecode) {
      autoOpticsTuneSummary = "remembered winner reacquired · validating live QR cohort";
      autoOpticsLockSince = now - AUTO_OPTICS_LOCK_SETTLE_MS;
      autoOpticsRetryAt = 0;
      void settleAutomaticQrOptics(track, now);
      return;
    }
\2''', "memory validation")
    source = replace_once(source,
'''async function settleAutomaticQrOptics(track, now) {
  if (autoOpticsMutationRunning || !automaticOptics || now < autoOpticsRetryAt) return;''',
'''async function settleAutomaticQrOptics(track, now) {
  if (autoOpticsMutationRunning || !automaticOptics || now < autoOpticsRetryAt) return;
  const startedFromMemory = autoOpticsRuntimeState === "memory";''', "settle source")

    source = regex_once(source,
        r'''    const cohortSize = beginAutomaticOpticsMeasurementCohort\(\);\n    if \(!cohortSize\) \{.*?\n      return;\n    \}\n\n    const baseline = await sampleAutomaticOpticsQuality''',
'''    const cohortSize = beginAutomaticOpticsMeasurementCohort();
    if (!cohortSize) {
      autoOpticsMeasurementSlots = void 0;
      const fallback = await readAutomaticAeBaseline(track);
      if (!automaticOpticsSessionAlive(track)) return;
      autoOpticsAeBaseline = fallback;
      autoOpticsRuntimeState = "ae";
      autoOpticsControllerState = "ACQUIRE";
      autoOpticsLockSince = 0;
      autoOpticsAcquisitionSince = receiverNow();
      autoOpticsRetryAt = Infinity;
      autoOpticsRescueRetryAt = Infinity;
      autoOpticsHeldYield = 0;
      autoOpticsHoldSample = void 0;
      autoOpticsTuneSummary = "QR geometry not measurable · hardware AE fallback; no HOLD";
      focusController.adoptAutomaticCameraState("no measurable QR cohort; unproven manual exposure was not held");
      return;
    }

    const baseline = await sampleAutomaticOpticsQuality''', "no cohort HOLD")
    source = regex_once(source,
        r'''    if \(!baseline \|\| baseline\.unstable \|\| !baseline\.valid\) \{.*?\n      return;\n    \}''',
'''    if (!baseline || baseline.unstable || !baseline.valid) {
      autoOpticsMeasurementSlots = void 0;
      const fallback = await readAutomaticAeBaseline(track);
      if (!automaticOpticsSessionAlive(track)) return;
      autoOpticsAeBaseline = fallback;
      autoOpticsRuntimeState = "ae";
      autoOpticsControllerState = "ACQUIRE";
      autoOpticsLockSince = 0;
      autoOpticsAcquisitionSince = receiverNow();
      autoOpticsRetryAt = Infinity;
      autoOpticsRescueRetryAt = Infinity;
      autoOpticsHeldYield = 0;
      autoOpticsHoldSample = void 0;
      autoOpticsTuneSummary = "QR optics measurement inconclusive · hardware AE fallback; no HOLD";
      focusController.adoptAutomaticCameraState("QR optics evidence was incomplete; unproven manual exposure was not held");
      return;
    }''', "invalid baseline HOLD")
    source = replace_once(source,
'''    const winnerExposure = quantizeCameraRange(best.exposure || frozenExposure, exposureRange);
    const winnerIso = quantizeCameraRange(best.iso || frozenIso, isoRange);
    await applyCameraConstraint(track, {''',
'''    if (!automaticOpticsHoldEligible(best)) {
      const measuredYield = Math.max(0, Number(best.yieldRate) || 0);
      const measuredBreadth = Math.max(0, Number(best.breadth) || 0);
      const reason = `QR bracket unproven ${(measuredYield * 100).toFixed(0)}% · breadth ${(measuredBreadth * 100).toFixed(0)}%`;
      if (startedFromMemory) forgetAutomaticOptics(track);
      autoOpticsMeasurementSlots = void 0;
      if (await advanceAutomaticOpticsAcquisitionSeed(track, reason)) return;
      const fallback = await readAutomaticAeBaseline(track);
      if (!automaticOpticsSessionAlive(track)) return;
      autoOpticsAeBaseline = fallback;
      autoOpticsRuntimeState = "ae";
      autoOpticsControllerState = "ACQUIRE";
      autoOpticsLockSince = 0;
      autoOpticsAcquisitionSince = receiverNow();
      autoOpticsRetryAt = Infinity;
      autoOpticsRescueRetryAt = Infinity;
      autoOpticsHeldYield = 0;
      autoOpticsHoldSample = void 0;
      autoOpticsHoldCollapseSince = 0;
      autoOpticsTuneSummary = `${reason} · hardware AE fallback; no HOLD`;
      focusController.adoptAutomaticCameraState("no QR-tested optics candidate met HOLD quality; hardware AE remains in control");
      return;
    }

    const winnerExposure = quantizeCameraRange(best.exposure || frozenExposure, exposureRange);
    const winnerIso = quantizeCameraRange(best.iso || frozenIso, isoRange);
    await applyCameraConstraint(track, {''', "HOLD evidence gate")
    source = replace_once(source,
'''    autoOpticsHeldYield = Math.max(0.01, Number(best.yieldRate) || Number(baseline.yieldRate) || 0.5);''',
'''    autoOpticsHeldYield = Math.max(0.01, Number(best.yieldRate) || 0);''', "synthetic HOLD yield")

    source = replace_once(source,
'''            if (geometryEligible && recoveryNow >= slotGeometryRetryAt[slot]) {
              const healed = gridLattice.dropSlotCorrection(slot);
              resetSlotSchedulingHistory(slot, recoveryNow);
              slotGeometryProbeUntil[slot] = recoveryNow + 900;
              slotGeometryRetryAt[slot] = recoveryNow + 3000;
              region.consecutiveMisses = 0;
              region.decodeConfidence = Math.max(region.decodeConfidence, 0.65);
              resetTrackBudgetController();
              geometrySlotCorrectionResets++;
              if (healed) syncGrid(healed, recoveryNow);
              const refreshed = regions.find((item) => Number(item.gridSlot) === slot);
              if (refreshed) {
                refreshed.consecutiveMisses = 0;
                refreshed.decodeConfidence = Math.max(refreshed.decodeConfidence, 0.65);
              }
              lastRecoveryReason = `slot s${slot} geometry self-heal reprobe (${geometrySlotCorrectionResets})`;
            }''',
'''            if (geometryEligible && recoveryNow >= slotGeometryRetryAt[slot]) {
              const healed = gridLattice.dropSlotCorrection(slot);
              slotGeometryRetryAt[slot] = recoveryNow + 3000;
              if (healed) {
                resetSlotSchedulingHistory(slot, recoveryNow);
                slotGeometryProbeUntil[slot] = recoveryNow + 900;
                region.consecutiveMisses = 0;
                region.decodeConfidence = Math.max(region.decodeConfidence, 0.65);
                resetTrackBudgetController();
                geometrySlotCorrectionResets++;
                syncGrid(healed, recoveryNow);
                const refreshed = regions.find((item) => Number(item.gridSlot) === slot);
                if (refreshed) {
                  refreshed.consecutiveMisses = 0;
                  refreshed.decodeConfidence = Math.max(refreshed.decodeConfidence, 0.65);
                }
                lastRecoveryReason = `slot s${slot} geometry self-heal reprobe (${geometrySlotCorrectionResets})`;
              }
            }''', "no-op self heal")

    source = replace_once(source,
'''  const allLockedCandidatesCold = lockedGeometryTrusted && recentLockedHits === 0 &&
    lockedGeometryCandidates.every((region) => region.consecutiveMisses >= GEOMETRY_COLD_MISSES);
  // Three tracked misses are evidence for a rescue probe, not evidence that the
  // wall geometry vanished. Previously this destroyed a good lattice after
  // roughly 0.9 s of optical misses and forced dense generic reacquisition.
  // Preserve the hot geometry while rescue scans run in parallel; only abandon
  // it after sustained decoder silence.
  // A proven lattice is sticky for the life of this receive session.
  // `allLockedCandidatesCold` escalates to bounded full-frame recovery below,
  // but ordinary decoder silence must never destroy stream identity/geometry.
  // A newly found CRC-valid QR will reject stale pose anchors and re-anchor the
  // existing wall in place, even when only that one QR is visible.''',
'''  const allLockedCandidatesCold = lockedGeometryTrusted && recentLockedHits === 0 &&
    lockedGeometryCandidates.every((region) => region.consecutiveMisses >= GEOMETRY_COLD_MISSES);
  const lockedRecovery = lockedRecoveryPolicy({
    geometryProbeDue,
    allCandidatesCold: allLockedCandidatesCold,
    decodeSilenceMs: lockedDecodeSilenceMs,
    globalSilenceMs: GEOMETRY_PROBE_SILENCE_MS,
    hasCandidates: lockedGeometryCandidates.length > 0
  });
  // Cold slots are a local known-grid repair signal. Only real payload silence
  // can promote recovery to the generic whole-frame finder.''', "recovery policy")
    source = replace_once(source,
'''  const needsRecoveryScan = strictLockedAudit ? false : preLatticeDiscovery ? true : lockedGeometryTrusted
    ? geometryProbeDue || allLockedCandidatesCold
    : live === 0 || live < expectedRegions || trackingUnhealthy || gridNeedsDiscovery;''',
'''  const needsRecoveryScan = strictLockedAudit ? false : preLatticeDiscovery ? true : lockedGeometryTrusted
    ? lockedRecovery.needsRecovery
    : live === 0 || live < expectedRegions || trackingUnhealthy || gridNeedsDiscovery;''', "recovery scheduling")
    source = replace_once(source,
'''  const globalRecoverySeedScan = fullScanDue && !captureNextScan && !autoOpticsMeasurementSlots?.size && gridLattice.locked &&
    (allLockedCandidatesCold || lockedDecodeSilenceMs >= GEOMETRY_PROBE_SILENCE_MS);
  const localRecoverySeedScan = fullScanDue && !captureNextScan && !autoOpticsMeasurementSlots?.size && gridLattice.locked &&
    geometryProbeDue && !globalRecoverySeedScan && lockedGeometryCandidates.length > 0;''',
'''  const globalRecoverySeedScan = fullScanDue && !captureNextScan && !autoOpticsMeasurementSlots?.size && gridLattice.locked &&
    lockedRecovery.globalRecovery;
  const localRecoverySeedScan = fullScanDue && !captureNextScan && !autoOpticsMeasurementSlots?.size && gridLattice.locked &&
    lockedRecovery.localRecovery;''', "local/global recovery")
    source = replace_once(source,
'''  geometryRecoveryProbes = 0;
  geometryRecoveryResets = 0;
  geometryMotionNudges = 0;''',
'''  geometryRecoveryProbes = 0;
  geometryRecoveryResets = 0;
  geometrySlotCorrectionResets = 0;
  geometrySightingNudges = 0;
  geometryMotionNudges = 0;''', "diagnostic reset")

    # A newly-tried short-shutter setting can be bad while the old lattice stays
    # locked. Do not let that stale lock prevent the seed ladder from advancing.
    source = replace_once(source,
'''  if (!gridLattice.locked) {
    autoOpticsLockSince = 0;
    const recentDecode = Boolean(lastStreamDecodeAt && lastStreamDecodeAt >= autoOpticsAcquisitionSince && now - lastStreamDecodeAt < AUTO_OPTICS_RECENT_DECODE_MS);''',
'''  if (seededStartup && gridLattice.locked) {
    const recentSeedDecode = Boolean(lastStreamDecodeAt && lastStreamDecodeAt >= autoOpticsAcquisitionSince && now - lastStreamDecodeAt < AUTO_OPTICS_RECENT_DECODE_MS);
    if (!recentSeedDecode && now - autoOpticsAcquisitionSince >= AUTO_OPTICS_ACQUISITION_RESCUE_MS) {
      void abandonAutomaticShortSeed(track);
      return;
    }
  }

  if (!gridLattice.locked) {
    autoOpticsLockSince = 0;
    const recentDecode = Boolean(lastStreamDecodeAt && lastStreamDecodeAt >= autoOpticsAcquisitionSince && now - lastStreamDecodeAt < AUTO_OPTICS_RECENT_DECODE_MS);''', "locked seed liveness")

    runtime_path.write_text(source)


guard_path = Path("receive/worker-capacity-guard.js")
guard = guard_path.read_text()
if "function copyStageTimeout(meta)" not in guard:
    needle = '''function activeNativeCopies(pool) {
  let count = 0;
  for (const meta of pool.activeMeta ?? []) {
    if (meta?.__airgapperNativeFrameCopy && !meta.__airgapperCopyComplete) count++;
  }
  return count;
}
'''
    replacement = needle + '''
function copyStageTimeout(meta) {
  const normal = Math.max(1, Number(meta?.timeoutMs) || 1);
  return Math.max(250, Math.min(600, normal * 0.20));
}
'''
    guard = replace_once(guard, needle, replacement, "copy timeout helper")
    guard = replace_once(guard,
'''  const configureWorker = function(slot, worker) {
    baseConfigureWorker.call(this, slot, worker);
    const baseOnMessage = worker.onmessage;''',
'''  const configureWorker = function(slot, worker) {
    baseConfigureWorker.call(this, slot, worker);
    worker.__airgapperCameraCopyWarm = false;
    const baseOnMessage = worker.onmessage;''', "worker warm state")
    guard = replace_once(guard,
'''      if (message?.__airgapperCameraCopyComplete) {
        if (activeMeta && activeMeta.id === message.id) {
          activeMeta.__airgapperCopyComplete = true;
          activeMeta.__airgapperPreflight = true;
        }
        return;
      }''',
'''      if (message?.__airgapperCameraCopyComplete) {
        if (activeMeta && activeMeta.id === message.id) {
          activeMeta.__airgapperCopyComplete = true;
          activeMeta.__airgapperPreflight = true;
          // Same watchdog, next stage: the native camera buffer is released,
          // so the decoder gets its normal remaining budget.
          activeMeta.deadlineAt = performance.now() + Math.max(1, Number(activeMeta.timeoutMs) || 1);
          worker.__airgapperCameraCopyWarm = true;
        }
        return;
      }''', "copy complete deadline")
    guard = replace_once(guard,
'''    const cameraLive = liveReceiveCamera();
    const native = nativeFrame(message?.videoFrame);''',
'''    const cameraLive = liveReceiveCamera();
    const native = nativeFrame(message?.videoFrame);
    const worker = this.workers?.[slot];''', "submit worker")
    guard = replace_once(guard,
'''      if (native) {
        meta.__airgapperNativeFrameCopy = true;
        meta.__airgapperCopyComplete = false;
      }''',
'''      if (native) {
        meta.__airgapperNativeFrameCopy = true;
        meta.__airgapperCopyComplete = false;
        // Keep the first camera job on a newly-created decoder conservative.
        // After one proven copy, a later 250-600 ms copy stall is a wedged
        // camera buffer and the pool's existing watchdog can reclaim it.
        if (worker?.__airgapperCameraCopyWarm) {
          meta.deadlineAt = Math.min(meta.deadlineAt, meta.startedAt + copyStageTimeout(meta));
        }
      }''', "copy stage deadline")
    guard_path.write_text(guard)


worker_path = Path("receive/worker.js")
worker = worker_path.read_text()
if "Local recovery deliberately stops here" not in worker:
    worker = replace_after(worker, 'else if (fullMode === "recovery") {',
'''          if (symbols.length === 0) acquireWithScaleFallback(1);''',
'''          // Local recovery deliberately stops here. A miss is not permission
          // to wake the generic whole-frame finder; sustained payload silence
          // is the runtime's sole global-recovery trigger.''', "local recovery fallback")
    worker_path.write_text(worker)


version_path = Path("version.js")
version = version_path.read_text()
if 'APP_VERSION = "0.5.453"' in version:
    version_path.write_text(version.replace('APP_VERSION = "0.5.453"', 'APP_VERSION = "0.5.454"', 1))
elif 'APP_VERSION = "0.5.454"' not in version:
    raise SystemExit("unexpected version")
