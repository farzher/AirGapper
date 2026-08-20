from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
main = ROOT / "receive/main.js"
text = main.read_text()
if 'RECEIVER_RUNTIME_BUILD = "v0.5.354"' in text:
    print("browser optimization patch already applied")
    raise SystemExit(0)

def once(s, old, new, label):
    count = s.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected 1 match, found {count}")
    return s.replace(old, new, 1)

# Pure policy helpers keep the high-level scheduling choices testable without a camera.
policy = r'''export const ACQUISITION_ESCALATE_MS = 180;
export const TEMPORAL_HARD_SKIP_CONFIDENCE = 0.62;
export const TEMPORAL_HARD_SKIP_RISK = 0.48;

export function acquisitionRacePolicy({
  scanIndex,
  ageMs,
  captureNextScan = false,
  localRecovery = false,
  hasSighting = false
}) {
  if (captureNextScan) return { mode: "thorough", fullFrame: true, targetSighting: false, stalled: false };
  if (localRecovery) return { mode: "recovery", fullFrame: false, targetSighting: false, stalled: false };
  const index = Math.max(1, Math.trunc(Number(scanIndex) || 1));
  const stalled = Number(ageMs) >= ACQUISITION_ESCALATE_MS;
  const fullEvery = stalled ? 2 : 4;
  const fullFrame = (index - 1) % fullEvery === 0;
  if (!fullFrame && hasSighting)
    return { mode: "sighting", fullFrame: false, targetSighting: true, stalled };
  if (fullFrame) {
    // After a short zero-QR stall, keep one complementary error-aware generic
    // finder in the race. The other jobs remain the cheaper dense finder.
    if (stalled && (index - 1) % 4 === 0)
      return { mode: "hunt", fullFrame: true, targetSighting: false, stalled };
    return { mode: index % 13 === 0 ? "deep" : "fast", fullFrame: true, targetSighting: false, stalled };
  }
  return { mode: "seed", fullFrame: false, targetSighting: false, stalled };
}

export function temporalHardSkip({ explicitSkip = false, risk = 0, confidence = 0, measurement = false }) {
  if (measurement) return false;
  if (explicitSkip) return true;
  return Number(confidence) >= TEMPORAL_HARD_SKIP_CONFIDENCE && Number(risk) >= TEMPORAL_HARD_SKIP_RISK;
}

export function legacyTemporalRiskWeight(confidence) {
  return Math.max(0, Math.min(1, 1 - Math.max(0, Number(confidence) || 0) * 1.45));
}

export function automaticOpticsHoldThreshold(heldYield, collapseYield = 0.12) {
  const held = Math.max(0, Math.min(1, Number(heldYield) || 0));
  // A winner should not be abandoned for normal frame noise, but losing roughly
  // 30% of its proven QR yield is meaningful. Keep a modest absolute floor so
  // a mediocre startup winner does not make "bad forever" the new normal.
  return Math.max(Number(collapseYield) || 0, 0.38, Math.min(0.72, held * 0.70));
}
'''
(ROOT / "receive/performance-policy.js").write_text(policy)

test = r'''import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../receive/performance-policy.js", import.meta.url), "utf8");
const policy = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

assert.deepEqual(policy.acquisitionRacePolicy({ scanIndex: 1, ageMs: 0 }),
  { mode: "fast", fullFrame: true, targetSighting: false, stalled: false });
assert.equal(policy.acquisitionRacePolicy({ scanIndex: 2, ageMs: 50 }).mode, "seed");
assert.equal(policy.acquisitionRacePolicy({ scanIndex: 4, ageMs: 250, hasSighting: true }).mode, "sighting");
assert.equal(policy.acquisitionRacePolicy({ scanIndex: 5, ageMs: 250 }).mode, "hunt");
assert.equal(policy.temporalHardSkip({ risk: 0.8, confidence: 0.8 }), true);
assert.equal(policy.temporalHardSkip({ risk: 0.8, confidence: 0.4 }), false);
assert.equal(policy.temporalHardSkip({ risk: 0.8, confidence: 0.8, measurement: true }), false);
assert.equal(policy.temporalHardSkip({ explicitSkip: true }), true);
assert(policy.automaticOpticsHoldThreshold(0.8) > 0.5);
assert(policy.legacyTemporalRiskWeight(0.9) < 0.1);
console.log("AIRGAPPER_BROWSER_POLICY_PASS");
'''
(ROOT / "benchmark/browser-performance-policy-smoke.mjs").write_text(test)

text = once(text,
'import { StaticQrOpticsAnalyzer } from "./qr-optics.js";\n',
'import { StaticQrOpticsAnalyzer } from "./qr-optics.js";\nimport {\n  ACQUISITION_ESCALATE_MS,\n  acquisitionRacePolicy,\n  automaticOpticsHoldThreshold,\n  legacyTemporalRiskWeight,\n  temporalHardSkip\n} from "./performance-policy.js";\n',
"policy import")

# Faster closed-loop automatic optics: learn while weak, then hold a proven setting hard.
text = text.replace('const AUTO_OPTICS_LOCK_SETTLE_MS = 1200;', 'const AUTO_OPTICS_LOCK_SETTLE_MS = 700;')
text = text.replace('const AUTO_OPTICS_ACQUISITION_RESCUE_MS = 1200;', 'const AUTO_OPTICS_ACQUISITION_RESCUE_MS = 850;')
text = text.replace('const AUTO_OPTICS_HOLD_COLLAPSE_MS = 2500;', 'const AUTO_OPTICS_HOLD_COLLAPSE_MS = 1400;')
text = text.replace('const AUTO_OPTICS_HOLD_DEGRADE_RATIO = 0.45;', 'const AUTO_OPTICS_HOLD_DEGRADE_RATIO = 0.70;')
text = once(text,
'const AUTO_OPTICS_HOLD_MIN_ATTEMPTS = 40;\n',
'const AUTO_OPTICS_HOLD_MIN_ATTEMPTS = 40;\nconst AUTO_OPTICS_LOST_RECALIBRATE_MS = 1200;\n',
"lost recalibration constant")

# Rolling shutter: short fallback quarantine, current predicted seam is authoritative.
text = text.replace('const TEMPORAL_BAND_AVOID_MS = 500;', 'const TEMPORAL_BAND_AVOID_MS = 140;')
old_risk = '''function temporalBandRiskForSlot(slot, sourceSequence, now = receiverNow()) {
  const index = Number(slot);
  if (!Number.isInteger(index) || index < 0 || index >= SLOT_METRIC_COUNT) return 0;
  let risk = temporalBandAvoidUntil[index] > now ? 0.98 : 0;
  const model = predictedTemporalBand(sourceSequence, now);
  const layout = lastGridSnapshot?.layout;
  if (!model || !layout || model.confidence < 0.08) return risk;
  const coordinate = model.axis === "c" ? index % layout.cols : Math.floor(index / layout.cols);
  let distance = Math.abs(coordinate - model.position);
  if (model.span > 1) distance = Math.min(distance, model.span - distance);
  const radius = Math.max(0.6, model.width * 0.58 + 0.35);
  const modeled = model.confidence * Math.exp(-0.5 * (distance / radius) ** 2);
  return Math.max(risk, Math.min(1, modeled));
}'''
new_risk = '''function temporalBandRiskForSlot(slot, sourceSequence, now = receiverNow()) {
  const index = Number(slot);
  if (!Number.isInteger(index) || index < 0 || index >= SLOT_METRIC_COUNT) return 0;
  const legacyRisk = temporalBandAvoidUntil[index] > now ? 0.98 : 0;
  const model = predictedTemporalBand(sourceSequence, now);
  const layout = lastGridSnapshot?.layout;
  if (!model || !layout || model.confidence < 0.08) return legacyRisk;
  const coordinate = model.axis === "c" ? index % layout.cols : Math.floor(index / layout.cols);
  let distance = Math.abs(coordinate - model.position);
  if (model.span > 1) distance = Math.min(distance, model.span - distance);
  const radius = Math.max(0.6, model.width * 0.58 + 0.35);
  const modeled = model.confidence * Math.exp(-0.5 * (distance / radius) ** 2);
  // A confident moving seam supersedes the old per-slot timer. As soon as the
  // predicted band moves away, that QR re-enters instead of remaining poisoned
  // for half a second by a historical miss.
  const fallback = legacyRisk * legacyTemporalRiskWeight(model.confidence);
  return Math.max(fallback, Math.min(1, modeled));
}'''
text = once(text, old_risk, new_risk, "temporal risk")

old_sched = '''function shouldScheduleTemporalBandSlot(region, sourceSequence) {
  const slot = Number(region.gridSlot);
  const sequence = Number(sourceSequence);
  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_METRIC_COUNT || !Number.isFinite(sequence)) return true;
  if (sequence > temporalBandSkipThroughSource[slot]) return true;
  temporalBandSkippedTracks++;
  return false;
}'''
new_sched = '''function shouldScheduleTemporalBandSlot(region, sourceSequence, now = receiverNow()) {
  const slot = Number(region.gridSlot);
  const sequence = Number(sourceSequence);
  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_METRIC_COUNT || !Number.isFinite(sequence)) return true;
  const explicitSkip = sequence <= temporalBandSkipThroughSource[slot];
  const model = predictedTemporalBand(sequence, now);
  const risk = temporalBandRiskForSlot(slot, sequence, now);
  if (!temporalHardSkip({
    explicitSkip,
    risk,
    confidence: model?.confidence ?? 0,
    measurement: Boolean(autoOpticsMeasurementSlots?.size)
  })) return true;
  temporalBandSkippedTracks++;
  trackBudgetTemporalAvoided++;
  return false;
}'''
text = once(text, old_sched, new_sched, "temporal scheduling")
text = once(text,
'''  if (!unlimitedTrackedScan)
    batchRegions = batchRegions.filter((region) => shouldScheduleTemporalBandSlot(region, source.sequence));''',
'''  if (!unlimitedTrackedScan && !autoOpticsMeasurementSlots?.size)
    batchRegions = batchRegions.filter((region) => shouldScheduleTemporalBandSlot(region, source.sequence, now));''',
"temporal predecode filter")

# Auto Optics manual hold: no periodic pokes when healthy; quickly re-open the search after real collapse/loss.
old_manual = '''  if (autoOpticsRuntimeState === "manual") {
    const poseUsable = gridLattice.locked && autoOpticsPoseUsable(autoOpticsPoseSnapshot());
    if (!poseUsable) {
      autoOpticsHoldSample = void 0;
      autoOpticsHoldCollapseSince = 0;
      return;
    }
    if (!autoOpticsHoldSample || now - autoOpticsHoldSample.at < AUTO_OPTICS_HOLD_SAMPLE_MS) return;
    const sample = autoOpticsPipelineSnapshot();
    const attempts = Math.max(0, sample.attempts - autoOpticsHoldSample.attempts);
    const outputs = Math.max(0, sample.outputs - autoOpticsHoldSample.outputs);
    autoOpticsHoldSample = sample;
    if (attempts < AUTO_OPTICS_HOLD_MIN_ATTEMPTS) return;

    const yieldRate = outputs / attempts;
    const degradationThreshold = Math.max(AUTO_OPTICS_COLLAPSE_YIELD, autoOpticsHeldYield * AUTO_OPTICS_HOLD_DEGRADE_RATIO);
    const temporal = predictedTemporalBand(latestSourceFrameSequence + 1, now);
    const temporalBusy = Boolean(temporal && temporal.confidence >= 0.45);
    // Rolling-shutter bands and camera motion are not brightness evidence. Do not
    // let them destabilize the sensor controller.
    if (temporalBusy || decoderFreshnessHoldActive) {
      autoOpticsHoldCollapseSince = 0;
      return;
    }
    if (yieldRate >= degradationThreshold) {
      autoOpticsHoldCollapseSince = 0;
      return;
    }
    if (!autoOpticsHoldCollapseSince) {
      autoOpticsHoldCollapseSince = now;
      return;
    }
    if (now - autoOpticsHoldCollapseSince >= AUTO_OPTICS_HOLD_COLLAPSE_MS) {
      const reason = yieldRate < AUTO_OPTICS_COLLAPSE_YIELD
        ? "held optics nearly blind"
        : `held optics persistently degraded from ${(autoOpticsHeldYield * 100).toFixed(0)}%`;
      void recoverCollapsedAutomaticOptics(track, yieldRate, reason);
    }
    return;
  }'''
new_manual = '''  if (autoOpticsRuntimeState === "manual") {
    const poseUsable = gridLattice.locked && autoOpticsPoseUsable(autoOpticsPoseSnapshot());
    const decodeSilenceMs = lastStreamDecodeAt ? Math.max(0, now - lastStreamDecodeAt) : Infinity;
    const temporal = predictedTemporalBand(latestSourceFrameSequence + 1, now);
    const temporalCoverage = temporal?.span ? temporal.width / temporal.span : 0;
    // A narrow rolling-shutter seam is normal and is now filtered before QR CPU.
    // Only a band covering much of the wall is allowed to invalidate an optics
    // measurement; otherwise a permanent small seam would freeze learning forever.
    const temporalDominant = Boolean(temporal && temporal.confidence >= 0.72 && temporalCoverage >= 0.42);
    if (!poseUsable) {
      autoOpticsHoldSample = void 0;
      if (decoderFreshnessHoldActive || temporalDominant || decodeSilenceMs < AUTO_OPTICS_LOST_RECALIBRATE_MS) {
        autoOpticsHoldCollapseSince = 0;
        return;
      }
      if (!autoOpticsHoldCollapseSince) {
        autoOpticsHoldCollapseSince = now;
        autoOpticsTuneSummary = `held winner lost QR · proving scene change`;
        return;
      }
      if (now - autoOpticsHoldCollapseSince >= 450)
        void recoverCollapsedAutomaticOptics(track, 0, "held optics lost QR lock");
      return;
    }
    if (!autoOpticsHoldSample || now - autoOpticsHoldSample.at < AUTO_OPTICS_HOLD_SAMPLE_MS) return;
    const sample = autoOpticsPipelineSnapshot();
    const attempts = Math.max(0, sample.attempts - autoOpticsHoldSample.attempts);
    const outputs = Math.max(0, sample.outputs - autoOpticsHoldSample.outputs);
    autoOpticsHoldSample = sample;
    if (attempts < AUTO_OPTICS_HOLD_MIN_ATTEMPTS) return;

    const yieldRate = outputs / attempts;
    const degradationThreshold = automaticOpticsHoldThreshold(autoOpticsHeldYield, AUTO_OPTICS_COLLAPSE_YIELD);
    // Good locked scan: learn the observed ceiling but DO NOT touch the camera.
    if (yieldRate >= degradationThreshold) {
      autoOpticsHeldYield = Math.max(autoOpticsHeldYield, Math.min(1, yieldRate));
      autoOpticsHoldCollapseSince = 0;
      return;
    }
    // Camera motion and a wall-wide temporal failure are not exposure evidence.
    if (temporalDominant || decoderFreshnessHoldActive) {
      autoOpticsHoldCollapseSince = 0;
      return;
    }
    if (!autoOpticsHoldCollapseSince) {
      autoOpticsHoldCollapseSince = now;
      autoOpticsTuneSummary = `held ${(autoOpticsHeldYield * 100).toFixed(0)}% · live ${(yieldRate * 100).toFixed(0)}% · verifying degradation`;
      return;
    }
    if (now - autoOpticsHoldCollapseSince >= AUTO_OPTICS_HOLD_COLLAPSE_MS) {
      const reason = yieldRate < AUTO_OPTICS_COLLAPSE_YIELD
        ? "held optics nearly blind"
        : `held optics degraded ${(autoOpticsHeldYield * 100).toFixed(0)}→${(yieldRate * 100).toFixed(0)}%`;
      void recoverCollapsedAutomaticOptics(track, yieldRate, reason);
    }
    return;
  }'''
text = once(text, old_manual, new_manual, "automatic optics hold")

# Acquisition race state/counters and more informative diagnostics.
old_acq_constants = '''const ACQUISITION_SCAN_MS = 20;
// The first acquisition frame is global. After that, prefer the much cheaper
// overlapping seed windows; with one-QR lock there is no reason to repeatedly
// scan the whole dense wall while waiting for cross-axis confirmation.
const ACQUISITION_FULL_EVERY = 4;
const ACQUISITION_DEEP_EVERY = 13;'''
new_acq_constants = '''const ACQUISITION_SCAN_MS = 20;
// Before the first valid QR, latency matters more than CPU efficiency. Run a
// complementary race: dense full-frame + cheap tiles immediately, then add one
// error-aware robust finder after a short zero-QR stall. Finder-only sightings
// become next-frame targeted retries instead of being discarded.
let acquisitionRaceStartedAt = 0;
let acquisitionHuntScans = 0;
let acquisitionSightingScans = 0;
let acquisitionSightings = 0;'''
text = once(text, old_acq_constants, new_acq_constants, "acquisition constants")

# Turn acquisition finder-only results into persistent short-lived targets.
needle = '''  const fullJob = fullScanJobs.get(id);
  // A recovery finder pass can fail payload/RS decode while still locating'''
replacement = '''  const fullJob = fullScanJobs.get(id);
  if (fullJob?.acquisition && completion.symbolCount === 0 && completion.sightings?.length) {
    const sightedAt = receiverNow();
    for (const sighting of completion.sightings.slice(0, 3)) noteRegion(sighting, sightedAt, false);
    acquisitionSightings += Math.min(3, completion.sightings.length);
    notePipelineEvent("acquisition-finder-sighting", completion.sightings.length);
  }
  // A recovery finder pass can fail payload/RS decode while still locating'''
text = once(text, needle, replacement, "initial acquisition sightings")

# Track acquisition age and current finder-only target.
needle = '''  const preLatticeDiscovery = !gridLattice.active;
  const acquisitionDiscovery = preLatticeDiscovery;
  const gridNeedsDiscovery = preLatticeDiscovery ||'''
replacement = '''  const preLatticeDiscovery = !gridLattice.active;
  const acquisitionDiscovery = preLatticeDiscovery;
  if (preLatticeDiscovery) {
    if (!acquisitionRaceStartedAt) acquisitionRaceStartedAt = now;
  } else {
    acquisitionRaceStartedAt = 0;
  }
  const acquisitionAgeMs = acquisitionRaceStartedAt ? Math.max(0, now - acquisitionRaceStartedAt) : 0;
  const acquisitionSighting = acquisitionDiscovery && !lastGridSnapshot
    ? regions.filter((region) => !region.decoded && region.gridSlot === void 0 &&
        now - (region.sightedSeen ?? region.seen) < SIGHTING_REGION_TTL_MS)
      .sort((a, b) => (b.sightedSeen ?? b.seen) - (a.sightedSeen ?? a.seen))[0]
    : void 0;
  const gridNeedsDiscovery = preLatticeDiscovery ||'''
text = once(text, needle, replacement, "acquisition race state")

old_mode = '''    const fullFrameSeed = captureNextScan || (fullScans - 1) % ACQUISITION_FULL_EVERY === 0;
    let acquisitionMode = captureNextScan ? "thorough" : fullFrameSeed
      ? fullScans % ACQUISITION_DEEP_EVERY === 0 ? "deep" : "fast"
      : "seed";
    if (localRecoverySeedScan) acquisitionMode = "recovery";
    let scanX = 0, scanY = 0, scanW = vw, scanH = vh;
    if (!captureNextScan && acquisitionDiscovery && !lastGridSnapshot && !fullFrameSeed) {
      const seed = acquisitionSeedWindow(acquisitionTileCursor++, vw, vh);
      scanX = seed.x;
      scanY = seed.y;
      scanW = seed.w;
      scanH = seed.h;
    }'''
new_mode = '''    const acquisitionPolicy = acquisitionRacePolicy({
      scanIndex: fullScans,
      ageMs: acquisitionAgeMs,
      captureNextScan: Boolean(captureNextScan),
      localRecovery: Boolean(localRecoverySeedScan),
      hasSighting: Boolean(acquisitionSighting)
    });
    const fullFrameSeed = acquisitionPolicy.fullFrame;
    let acquisitionMode = acquisitionPolicy.mode;
    if (acquisitionMode === "hunt") acquisitionHuntScans++;
    if (acquisitionMode === "sighting") acquisitionSightingScans++;
    let scanX = 0, scanY = 0, scanW = vw, scanH = vh;
    if (acquisitionPolicy.targetSighting && acquisitionSighting) {
      const edge = Math.max(acquisitionSighting.w, acquisitionSighting.h);
      const pad = Math.max(24, edge * 0.65);
      const quantum = 16;
      scanX = Math.max(0, Math.floor((acquisitionSighting.x - pad) / quantum) * quantum);
      scanY = Math.max(0, Math.floor((acquisitionSighting.y - pad) / quantum) * quantum);
      const right = Math.min(vw, Math.ceil((acquisitionSighting.x + acquisitionSighting.w + pad) / quantum) * quantum);
      const bottom = Math.min(vh, Math.ceil((acquisitionSighting.y + acquisitionSighting.h + pad) / quantum) * quantum);
      scanW = Math.max(32, right - scanX);
      scanH = Math.max(32, bottom - scanY);
    } else if (!captureNextScan && acquisitionDiscovery && !lastGridSnapshot && !fullFrameSeed) {
      const seed = acquisitionSeedWindow(acquisitionTileCursor++, vw, vh);
      scanX = seed.x;
      scanY = seed.y;
      scanW = seed.w;
      scanH = seed.h;
    }'''
text = once(text, old_mode, new_mode, "acquisition race mode")

text = once(text,
'''        reacquire: gridLattice.locked,
        acquisition: !gridLattice.locked
      });''',
'''        reacquire: gridLattice.locked,
        acquisition: !gridLattice.locked,
        acquisitionMode: message.acquisitionMode
      });''',
"full job acquisition mode")

# Reset browser acquisition race with each camera session.
text = once(text,
'''  cameraStartedTs = receiverNow();
  resetLivePipeline(cameraStartedTs);''',
'''  cameraStartedTs = receiverNow();
  acquisitionRaceStartedAt = 0;
  acquisitionHuntScans = 0;
  acquisitionSightingScans = 0;
  acquisitionSightings = 0;
  resetLivePipeline(cameraStartedTs);''',
"acquisition session reset")

# Add one compact diagnostic line so device runs tell us whether escalation/sighting rescue fired.
text = once(text,
'''    `Recovery probes ${geometryRecoveryProbes} · breadth ${geometryBreadthRecoveryProbes} · repair tracks ${geometryCoverageRepairTracks} · temporal bands ${temporalBandDetections}/${temporalBandSkippedTracks} skips · assist ${geometryRecoveryAssistUntil > perfNow ? `${Math.max(0, geometryRecoveryAssistUntil - perfNow).toFixed(0)}ms` : "no"} · motion ${geometryMotionNudges}/${geometryMotionPixels.toFixed(0)}px · similarity ${geometrySimilarityNudges} · sighting nudges ${geometrySightingNudges} · slot self-heals ${geometrySlotCorrectionResets} · resets ${geometryRecoveryResets} · worker restarts ${recoveryWorkerRestarts} · aborted ${recoveryAbortedJobs} jobs/${(recoveryAbortedWorkerMs / 1e3).toFixed(1)} worker-s · hold ${decoderFreshnessHoldActive ? `${Math.max(0, decoderFreshnessHoldUntil - perfNow).toFixed(0)}ms` : "no"} · lattice ${gridLattice.state}${gridLattice.active ? "/active" : "/acquiring"} · mode ${frameModeSync ? `syncing ${frameModeSync.width}×${frameModeSync.height}` : "synced"} · mode drops ${frameModeMismatchDrops} · sync timeouts ${frameModeSyncTimeouts} · ${lastRecoveryReason}`,''',
'''    `Recovery probes ${geometryRecoveryProbes} · breadth ${geometryBreadthRecoveryProbes} · repair tracks ${geometryCoverageRepairTracks} · temporal bands ${temporalBandDetections}/${temporalBandSkippedTracks} skips · assist ${geometryRecoveryAssistUntil > perfNow ? `${Math.max(0, geometryRecoveryAssistUntil - perfNow).toFixed(0)}ms` : "no"} · motion ${geometryMotionNudges}/${geometryMotionPixels.toFixed(0)}px · similarity ${geometrySimilarityNudges} · sighting nudges ${geometrySightingNudges} · slot self-heals ${geometrySlotCorrectionResets} · resets ${geometryRecoveryResets} · worker restarts ${recoveryWorkerRestarts} · aborted ${recoveryAbortedJobs} jobs/${(recoveryAbortedWorkerMs / 1e3).toFixed(1)} worker-s · hold ${decoderFreshnessHoldActive ? `${Math.max(0, decoderFreshnessHoldUntil - perfNow).toFixed(0)}ms` : "no"} · lattice ${gridLattice.state}${gridLattice.active ? "/active" : "/acquiring"} · mode ${frameModeSync ? `syncing ${frameModeSync.width}×${frameModeSync.height}` : "synced"} · mode drops ${frameModeMismatchDrops} · sync timeouts ${frameModeSyncTimeouts} · ${lastRecoveryReason}`,
    `Acquire  ${gridLattice.active ? "done" : `${acquisitionAgeMs.toFixed(0)}ms race`} · robust hunts ${acquisitionHuntScans} · sighting retries ${acquisitionSightingScans} · finder hints ${acquisitionSightings}`,''',
"acquisition diagnostics")

# Runtime version.
text = text.replace('const RECEIVER_RUNTIME_BUILD = "v0.5.353";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.354";')
main.write_text(text)

# Worker: one complementary error-aware acquisition pass and cheap next-frame sighting retries.
worker = ROOT / "receive/worker.js"
w = worker.read_text()
old = '''        if (fullMode === "thorough") {
          readFullAttempts++;
          appendResults(readFull(true, 16, false), false);'''
new = '''        if (fullMode === "hunt") {
          readFullAttempts++;
          appendResults(readFull(true, 8, true), true);
        } else if (fullMode === "sighting") {
          readFullAttempts++;
          appendResults(readFull(true, 1, true), true);
        } else if (fullMode === "thorough") {
          readFullAttempts++;
          appendResults(readFull(true, 16, false), false);'''
w = once(w, old, new, "worker acquisition modes")
worker.write_text(w)

# Version/cache files. Keep the Android package aligned because master release CI
# also packages the same browser assets even though this pass targets Chrome/PWA.
for rel in ["main.js", "send/main.js", "index.html", "sw.js", "android/app/build.gradle"]:
    p = ROOT / rel
    s = p.read_text()
    s = s.replace("v0.5.353", "v0.5.354").replace("0.5.353", "0.5.354")
    if rel == "sw.js": s = s.replace("airgapper-static-js-v353", "airgapper-static-js-v354")
    if rel == "android/app/build.gradle": s = re.sub(r"versionCode\s+353\b", "versionCode 354", s)
    p.write_text(s)

print("browser acquisition/auto-optics optimization patch applied")
