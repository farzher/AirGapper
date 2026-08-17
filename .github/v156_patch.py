from pathlib import Path

root = Path('.')
p = root / 'receive/main.js'
s = p.read_text()

assert 'const RECEIVER_RUNTIME_BUILD = "v0.5.155";' in s
s = s.replace('const RECEIVER_RUNTIME_BUILD = "v0.5.155";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.156";', 1)

old = '''const AUTO_OPTICS_GAIN_SETTLE_MS = 340;
const AUTO_OPTICS_GAIN_SAMPLE_MS = 520;
const AUTO_OPTICS_GAIN_MIN_ATTEMPTS = 12;
const AUTO_OPTICS_GAIN_IMPROVEMENT = 1.03;
const AUTO_OPTICS_GAIN_MAX_PROBES = 5;
let autoOpticsTuneSummary = "";'''
new = '''const AUTO_OPTICS_GAIN_SETTLE_MS = 340;
const AUTO_OPTICS_GAIN_SAMPLE_MS = 520;
const AUTO_OPTICS_GAIN_MIN_ATTEMPTS = 12;
const AUTO_OPTICS_GAIN_IMPROVEMENT = 1.03;
const AUTO_OPTICS_GAIN_MAX_PROBES = 5;
const AUTO_OPTICS_POSE_STABLE_MS = 260;
const AUTO_OPTICS_POSE_WAIT_MS = 1800;
const AUTO_OPTICS_POSE_MAX_CENTER_DRIFT = 0.035;
const AUTO_OPTICS_POSE_MAX_SCALE_LOG2 = 0.10;
const AUTO_OPTICS_MIN_VISIBLE_FRACTION = 0.75;
const AUTO_OPTICS_MEMORY_KEY = "airgapper:auto-optics-memory:v1";
let autoOpticsTuneSummary = "";'''
assert old in s
s = s.replace(old, new, 1)

anchor = '''function automaticOpticsSessionAlive(track) {
  return automaticOptics && !done && track?.readyState === "live" && stream?.getVideoTracks()[0] === track;
}
function autoOpticsPipelineSnapshot() {'''
replacement = '''function automaticOpticsSessionAlive(track) {
  return automaticOptics && !done && track?.readyState === "live" && stream?.getVideoTracks()[0] === track;
}
function autoOpticsVisibleSlots() {
  return regions.reduce((count, region) => count + Number(region.gridSlot !== void 0 && region.slotState !== "OFFSCREEN"), 0);
}
function autoOpticsPoseSnapshot() {
  const geometry = focusGeometry();
  const visible = autoOpticsVisibleSlots();
  const expected = Math.max(visible, Number(expectedRegions) || 0);
  return {
    at: receiverNow(),
    locked: Boolean(gridLattice.locked),
    visible,
    expected,
    x: Number(geometry?.x),
    y: Number(geometry?.y),
    scale: Number(geometry?.scale)
  };
}
function autoOpticsPoseUsable(pose) {
  if (!pose?.locked || !Number.isFinite(pose.x) || !Number.isFinite(pose.y) || !(pose.scale > 0)) return false;
  const expected = Math.max(1, pose.expected || pose.visible || 1);
  const minimumVisible = expected <= 2 ? expected : Math.max(2, Math.ceil(expected * AUTO_OPTICS_MIN_VISIBLE_FRACTION));
  return pose.visible >= minimumVisible;
}
function autoOpticsPoseDrift(a, b) {
  if (!autoOpticsPoseUsable(a) || !autoOpticsPoseUsable(b)) return { center: Infinity, scale: Infinity };
  return {
    center: Math.hypot(b.x - a.x, b.y - a.y),
    scale: Math.abs(Math.log2(b.scale / a.scale))
  };
}
async function waitForStableAutoOpticsPose(track, timeoutMs = AUTO_OPTICS_POSE_WAIT_MS) {
  const started = performance.now();
  let stableSince = 0;
  let anchorPose;
  while (performance.now() - started < timeoutMs) {
    if (!automaticOpticsSessionAlive(track)) return false;
    const pose = autoOpticsPoseSnapshot();
    if (!autoOpticsPoseUsable(pose)) {
      stableSince = 0;
      anchorPose = void 0;
    } else if (!anchorPose) {
      anchorPose = pose;
      stableSince = performance.now();
    } else {
      const drift = autoOpticsPoseDrift(anchorPose, pose);
      if (drift.center > AUTO_OPTICS_POSE_MAX_CENTER_DRIFT || drift.scale > AUTO_OPTICS_POSE_MAX_SCALE_LOG2) {
        anchorPose = pose;
        stableSince = performance.now();
      } else if (performance.now() - stableSince >= AUTO_OPTICS_POSE_STABLE_MS) {
        return true;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 45));
  }
  return false;
}
function autoOpticsMemoryKey(track) {
  const settings = track?.getSettings?.() ?? {};
  return String(settings.deviceId || track?.label || settings.facingMode || "default");
}
function loadAutomaticOpticsMemory(track, exposure, isoRange, cap) {
  try {
    const all = JSON.parse(localStorage.getItem(AUTO_OPTICS_MEMORY_KEY) || "{}");
    const saved = all?.[autoOpticsMemoryKey(track)];
    if (!saved || !Number.isFinite(saved.iso) || !Number.isFinite(saved.exposure) || saved.iso <= 0 || saved.exposure <= 0) return void 0;
    // Preserve the remembered exposure product if camera FPS changed. A prior
    // 10ms/ISO200 winner therefore starts near 5ms/ISO400 at 60fps instead of
    // blindly reusing gain from a different shutter.
    const adjusted = saved.iso * saved.exposure / Math.max(1e-6, exposure);
    return quantizeCameraRange(Math.min(cap, Math.max(isoRange.min, adjusted)), isoRange);
  } catch {
    return void 0;
  }
}
function rememberAutomaticOptics(track, exposure, iso) {
  if (!Number.isFinite(exposure) || !Number.isFinite(iso) || exposure <= 0 || iso <= 0) return;
  try {
    const all = JSON.parse(localStorage.getItem(AUTO_OPTICS_MEMORY_KEY) || "{}");
    all[autoOpticsMemoryKey(track)] = { exposure, iso, at: Date.now() };
    const entries = Object.entries(all).sort((a, b) => Number(b[1]?.at || 0) - Number(a[1]?.at || 0)).slice(0, 8);
    localStorage.setItem(AUTO_OPTICS_MEMORY_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
  }
}
function autoOpticsPipelineSnapshot() {'''
assert anchor in s
s = s.replace(anchor, replacement, 1)

old = '''  // Do not fence/discard worker jobs. Let pre-mutation work finish naturally,
  // then measure only after roughly a tracked p95 worth of time has elapsed.
  if (!await waitForAutoOptics(AUTO_OPTICS_GAIN_SETTLE_MS, track)) return null;
  const before = autoOpticsPipelineSnapshot();
  if (!await waitForAutoOptics(AUTO_OPTICS_GAIN_SAMPLE_MS, track)) return null;
  const after = autoOpticsPipelineSnapshot();
  const elapsed = Math.max(0.001, (after.at - before.at) / 1e3);
  const outputs = Math.max(0, after.outputs - before.outputs);
  const attempts = Math.max(0, after.attempts - before.attempts);
  const jobs = Math.max(0, after.jobs - before.jobs);
  const rate = outputs / elapsed;
  const yieldRate = attempts ? outputs / attempts : 0;
  // Actual throughput is primary. Yield provides a small stabilizer if framing
  // changes slightly during the short calibration window.
  const score = rate * (0.8 + 0.2 * Math.max(0, Math.min(1, yieldRate)));
  const actualIso = Number(track.getSettings().iso);
  return {
    iso: Number.isFinite(actualIso) ? actualIso : iso,
    requestedIso: iso, outputs, attempts, jobs, rate, yieldRate, score,
    valid: attempts >= AUTO_OPTICS_GAIN_MIN_ATTEMPTS && jobs >= 2
  };'''
new = '''  // Do not fence/discard worker jobs. Let pre-mutation work finish naturally,
  // then measure only after roughly a tracked p95 worth of time has elapsed.
  if (!await waitForAutoOptics(AUTO_OPTICS_GAIN_SETTLE_MS, track)) return null;

  // Decoder yield is only an optics oracle while the scene itself is comparable.
  // If the user is moving the phone or has only part of the QR wall framed,
  // wait rather than teaching Auto Optics that the current ISO was bad.
  if (!await waitForStableAutoOpticsPose(track)) {
    const actualIso = Number(track.getSettings().iso);
    return {
      iso: Number.isFinite(actualIso) ? actualIso : iso,
      requestedIso: iso, outputs: 0, attempts: 0, jobs: 0, rate: 0, yieldRate: 0, score: 0,
      valid: false, unstable: true
    };
  }

  const before = autoOpticsPipelineSnapshot();
  const poseAnchor = autoOpticsPoseSnapshot();
  let minVisible = poseAnchor.visible;
  let maxCenterDrift = 0;
  let maxScaleDrift = 0;
  let poseStable = autoOpticsPoseUsable(poseAnchor);
  const sampleUntil = performance.now() + AUTO_OPTICS_GAIN_SAMPLE_MS;
  while (performance.now() < sampleUntil) {
    if (!automaticOpticsSessionAlive(track)) return null;
    await new Promise((resolve) => setTimeout(resolve, Math.min(40, Math.max(1, sampleUntil - performance.now()))));
    const pose = autoOpticsPoseSnapshot();
    minVisible = Math.min(minVisible, pose.visible);
    const drift = autoOpticsPoseDrift(poseAnchor, pose);
    maxCenterDrift = Math.max(maxCenterDrift, drift.center);
    maxScaleDrift = Math.max(maxScaleDrift, drift.scale);
    if (!autoOpticsPoseUsable(pose) || drift.center > AUTO_OPTICS_POSE_MAX_CENTER_DRIFT || drift.scale > AUTO_OPTICS_POSE_MAX_SCALE_LOG2)
      poseStable = false;
  }
  const after = autoOpticsPipelineSnapshot();
  const elapsed = Math.max(0.001, (after.at - before.at) / 1e3);
  const outputs = Math.max(0, after.outputs - before.outputs);
  const attempts = Math.max(0, after.attempts - before.attempts);
  const jobs = Math.max(0, after.jobs - before.jobs);
  const rate = outputs / elapsed;
  const yieldRate = attempts ? outputs / attempts : 0;
  const tracksPerJob = jobs ? attempts / jobs : 0;
  // Actual throughput is primary. Yield provides a small stabilizer if framing
  // changes slightly during the short calibration window.
  const score = rate * (0.8 + 0.2 * Math.max(0, Math.min(1, yieldRate)));
  const actualIso = Number(track.getSettings().iso);
  return {
    iso: Number.isFinite(actualIso) ? actualIso : iso,
    requestedIso: iso, outputs, attempts, jobs, rate, yieldRate, tracksPerJob, score,
    minVisible, maxCenterDrift, maxScaleDrift, unstable: !poseStable,
    valid: poseStable && attempts >= AUTO_OPTICS_GAIN_MIN_ATTEMPTS && jobs >= 2
  };'''
assert old in s
s = s.replace(old, new, 1)

old = '''function describeAutoIsoProbe(probe) {
  if (!probe) return "—";
  if (!probe.valid) return `${Math.round(probe.iso)}:insufficient`;
  return `${Math.round(probe.iso)}:${probe.rate.toFixed(0)}/s ${(probe.yieldRate * 100).toFixed(0)}%`;
}'''
new = '''function describeAutoIsoProbe(probe) {
  if (!probe) return "—";
  if (probe.unstable) return `${Math.round(probe.iso)}:move/reframe`;
  if (!probe.valid) return `${Math.round(probe.iso)}:insufficient`;
  return `${Math.round(probe.iso)}:${probe.rate.toFixed(0)}/s ${(probe.yieldRate * 100).toFixed(0)}%`;
}'''
assert old in s
s = s.replace(old, new, 1)

start = s.index('async function tuneAutomaticQrIso(')
end = s.index('\nasync function settleAutomaticQrOptics', start)
old_func = s[start:end]
new_func = r'''async function tuneAutomaticQrIso(track, exposure, aeBaseIso, isoRange, maxAutoIso, rememberedIso) {
  // The per-axis Auto flags belong to manual Optics mode. When the top-level
  // Optics controller is Auto, it owns exposure + gain for its one-time camera
  // calibration. A previously hand-pinned ISO must not silently disable this
  // search while the manual controls are hidden. Preserve the pin for the next
  // time the user explicitly switches Optics off, but ignore it here.
  if (!automaticOpticsSessionAlive(track)) return { iso: aeBaseIso, probes: [] };
  autoOpticsRuntimeState = "tuning";
  autoOpticsTuneSummary = rememberedIso ? `memory ${Math.round(rememberedIso)} · calibrating ISO` : "calibrating ISO";

  const cap = Math.max(isoRange.min, Math.min(isoRange.max, maxAutoIso));
  const aeBase = quantizeCameraRange(Math.min(cap, aeBaseIso), isoRange);
  const remembered = Number.isFinite(rememberedIso)
    ? quantizeCameraRange(Math.min(cap, Math.max(isoRange.min, rememberedIso)), isoRange)
    : void 0;
  const base = remembered ?? aeBase;
  const probes = [];
  const measured = new Set();
  const probe = async (candidate) => {
    const requested = quantizeCameraRange(Math.min(cap, Math.max(isoRange.min, candidate)), isoRange);
    const key = String(requested);
    if (measured.has(key)) return probes.find((item) => String(item.requestedIso) === key) || null;
    if (measured.size >= AUTO_OPTICS_GAIN_MAX_PROBES) return null;
    measured.add(key);
    let result = null;
    // One bad half-second because the user moved the camera must not poison a
    // candidate. Retry the same ISO once after pose stability returns; unique
    // ISO probe budget is unchanged.
    for (let window = 0; window < 2 && automaticOpticsSessionAlive(track); window++) {
      result = await measureAutomaticIsoCandidate(track, exposure, requested, isoRange);
      if (!result?.unstable) break;
      autoOpticsTuneSummary = `${probes.map(describeAutoIsoProbe).join(" · ")}${probes.length ? " · " : ""}${Math.round(requested)}:hold framing`;
    }
    if (result) probes.push(result);
    autoOpticsTuneSummary = `${remembered ? `memory ${Math.round(remembered)} · ` : ""}${probes.map(describeAutoIsoProbe).join(" · ")}`;
    return result;
  };
  const scoreOf = (item) => item?.valid ? item.score : 0;
  const better = (candidate, incumbent) => scoreOf(candidate) > scoreOf(incumbent) * AUTO_OPTICS_GAIN_IMPROVEMENT;
  const geometricMidpoint = (a, b) => Math.sqrt(Math.max(isoRange.min, a) * Math.max(isoRange.min, b));

  let baseline = await probe(base);
  if (!automaticOpticsSessionAlive(track)) return { iso: base, probes };

  if (remembered !== void 0) {
    // Reload path: validate the remembered winner against the fresh hardware-AE
    // estimate, then search locally on both sides of whichever one actually
    // wins. This makes memory a head start, never an assumption about lighting.
    if (Math.abs(Math.log2(Math.max(1e-6, aeBase) / Math.max(1e-6, remembered))) > 0.08)
      await probe(aeBase);
    if (!automaticOpticsSessionAlive(track)) return { iso: base, probes };
    const validInitial = probes.filter((item) => item.valid);
    const center = validInitial.length
      ? validInitial.reduce((winner, item) => item.score > winner.score ? item : winner)
      : baseline;
    const centerIso = center?.requestedIso ?? base;
    await probe(centerIso / Math.SQRT2);
    if (!automaticOpticsSessionAlive(track)) return { iso: base, probes };
    await probe(centerIso * Math.SQRT2);
    if (!automaticOpticsSessionAlive(track)) return { iso: base, probes };

    const local = probes.filter((item) => item.valid).sort((a, b) => a.requestedIso - b.requestedIso);
    if (local.length >= 2 && measured.size < AUTO_OPTICS_GAIN_MAX_PROBES) {
      const bestNow = local.reduce((winner, item) => item.score > winner.score ? item : winner);
      const index = local.indexOf(bestNow);
      const neighbors = [local[index - 1], local[index + 1]].filter(Boolean);
      if (neighbors.length) {
        const rival = neighbors.reduce((winner, item) => item.score > winner.score ? item : winner);
        await probe(geometricMidpoint(bestNow.requestedIso, rival.requestedIso));
      }
    }
  } else {
    // First use on a camera keeps the proven v152 coarse search: establish a
    // broad brightness bracket, continue uphill if necessary, then refine it.
    const brighter = await probe(base * 2);
    if (!automaticOpticsSessionAlive(track)) return { iso: base, probes };

    if (better(brighter, baseline)) {
      const upper = await probe(base * 2 * Math.SQRT2);
      if (!automaticOpticsSessionAlive(track)) return { iso: base, probes };
      if (better(upper, brighter)) {
        const far = await probe(base * 4);
        if (!automaticOpticsSessionAlive(track)) return { iso: base, probes };
        if (far && upper && !better(far, upper))
          await probe(geometricMidpoint(upper.requestedIso, far.requestedIso));
      } else if (upper && brighter) {
        await probe(geometricMidpoint(brighter.requestedIso, upper.requestedIso));
      }
    } else {
      const darker = await probe(base / Math.SQRT2);
      if (!automaticOpticsSessionAlive(track)) return { iso: base, probes };
      const validNow = [baseline, brighter, darker].filter((item) => item?.valid).sort((a, b) => a.requestedIso - b.requestedIso);
      if (validNow.length >= 2) {
        const bestNow = validNow.reduce((winner, item) => item.score > winner.score ? item : winner);
        const bestIndex = validNow.indexOf(bestNow);
        const neighbors = [validNow[bestIndex - 1], validNow[bestIndex + 1]].filter(Boolean);
        if (neighbors.length) {
          const rival = neighbors.reduce((winner, item) => item.score > winner.score ? item : winner);
          await probe(geometricMidpoint(bestNow.requestedIso, rival.requestedIso));
        }
      }
    }
  }

  const valid = probes.filter((item) => item.valid);
  if (!valid.length) {
    autoOpticsTuneSummary = `${remembered ? `memory ${Math.round(remembered)} · ` : ""}${probes.map(describeAutoIsoProbe).join(" · ")} · deferred: reframe`;
    return { iso: base, probes, deferred: true };
  }
  const best = valid.reduce((winner, item) => item.score > winner.score ? item : winner);
  const finalIso = quantizeCameraRange(Math.min(cap, best.iso || best.requestedIso || base), isoRange);
  if (automaticOpticsSessionAlive(track)) {
    const actual = Number(track.getSettings().iso);
    const step = Number(isoRange.step) || 0;
    if (!Number.isFinite(actual) || Math.abs(actual - finalIso) > Math.max(step * 0.75, finalIso * 0.02))
      await applyCameraConstraint(track, { exposureMode: "manual", exposureTime: exposure, iso: finalIso });
  }
  autoOpticsTuneSummary = `${remembered ? `memory ${Math.round(remembered)} · ` : ""}${probes.map(describeAutoIsoProbe).join(" · ")} → ${Math.round(finalIso)}`;
  return { iso: finalIso, probes, best };
}'''
s = s[:start] + new_func + s[end:]

old = '''    const tuned = await tuneAutomaticQrIso(track, exposure, iso, isoRange, maxAutoIso);
    if (!automaticOpticsSessionAlive(track)) return;
    autoOpticsRuntimeState = "manual";'''
new = '''    const rememberedIso = loadAutomaticOpticsMemory(track, exposure, isoRange, maxAutoIso);
    const tuned = await tuneAutomaticQrIso(track, exposure, iso, isoRange, maxAutoIso, rememberedIso);
    if (!automaticOpticsSessionAlive(track)) return;
    if (tuned.deferred) {
      // The camera moved or framing collapsed during every useful measurement.
      // Restore hardware AE and try again only after a fresh stable QR lock;
      // never commit a random ISO winner from incomparable scene geometry.
      await applyExposureSetting(track);
      autoOpticsRuntimeState = "ae";
      autoOpticsLockSince = 0;
      autoOpticsRetryAt = receiverNow() + 800;
      return;
    }
    autoOpticsRuntimeState = "manual";'''
assert old in s
s = s.replace(old, new, 1)

old = '''    preferredExposureTime = track.getSettings().exposureTime ?? exposure;
    preferredIso = track.getSettings().iso ?? tuned.iso ?? iso;
    saveCameraSettings();'''
new = '''    preferredExposureTime = track.getSettings().exposureTime ?? exposure;
    preferredIso = track.getSettings().iso ?? tuned.iso ?? iso;
    if (tuned.best?.valid) rememberAutomaticOptics(track, preferredExposureTime, preferredIso);
    saveCameraSettings();'''
assert old in s
s = s.replace(old, new, 1)

old = '''  if (!gridLattice.locked) {
    autoOpticsLockSince = 0;
    return;
  }
  if (!autoOpticsLockSince) autoOpticsLockSince = now;'''
new = '''  if (!gridLattice.locked || !autoOpticsPoseUsable(autoOpticsPoseSnapshot())) {
    // Do not even start the tuning clock on a partial/moving wall. Optics is
    // judged only after enough of the expected layout is framed and tracked.
    autoOpticsLockSince = 0;
    return;
  }
  if (!autoOpticsLockSince) autoOpticsLockSince = now;'''
assert old in s
s = s.replace(old, new, 1)

p.write_text(s)

for name in ['index.html', 'main.js']:
    p = root / name
    text = p.read_text()
    assert 'v0.5.155' in text, name
    p.write_text(text.replace('v0.5.155', 'v0.5.156'))

sw = root / 'sw.js'
text = sw.read_text()
assert 'airgapper-static-js-v117' in text
sw.write_text(text.replace('airgapper-static-js-v117', 'airgapper-static-js-v118', 1))
