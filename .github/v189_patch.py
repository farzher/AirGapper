from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"replacement not found in {path}: {old[:180]!r}")
    p.write_text(s.replace(old, new, count))


replace("index.html", "v0.5.188", "v0.5.189")
replace("main.js", 'const APP_BUILD = "v0.5.188";', 'const APP_BUILD = "v0.5.189";')
replace("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.188";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.189";')
replace("sw.js", 'const CACHE = "airgapper-static-js-v150";', 'const CACHE = "airgapper-static-js-v151";')

p = Path("receive/main.js")
s = p.read_text()

s = s.replace(
'''// Fine tuning needs comparable geometry, not a nearly complete wall. Two
// tracked slots are enough to compare ISO candidates if the pose itself stays
// stable. Requiring 75% of the wall created a bootstrap deadlock when bad AE
// prevented acquisition in the first place.
const AUTO_OPTICS_MIN_VISIBLE_SLOTS = 2;''',
'''// One stable tracked QR is enough to compare exposure candidates. Requiring
// multiple visible slots makes Auto Optics impossible on a true 1x1 sender.
const AUTO_OPTICS_MIN_VISIBLE_SLOTS = 1;''', 1)

old = '''const AUTO_OPTICS_MEMORY_KEY = "airgapper:auto-optics-memory:v1";
const AUTO_OPTICS_FINE_INTERVAL_MS = 8000;
const AUTO_OPTICS_FINE_SAMPLE_MS = 360;
const AUTO_OPTICS_FINE_SETTLE_MS = 220;
const AUTO_OPTICS_FINE_FACTOR = Math.pow(2, 1 / 6);
const AUTO_OPTICS_FINE_IMPROVEMENT = 1.018;
// A relative winner is meaningless when the whole local ISO neighborhood is
// unusable. Below this per-QR yield, abandon manual tuning and let hardware AE
// re-establish a sane exposure product before trying the motion-safe handoff.
const AUTO_OPTICS_COLLAPSE_YIELD = 0.12;
const AUTO_OPTICS_COLLAPSE_RETRY_MS = 900;
const AUTO_OPTICS_HOLD_SAMPLE_MS = 700;
const AUTO_OPTICS_HOLD_COLLAPSE_MS = 1400;
const AUTO_OPTICS_HOLD_MIN_ATTEMPTS = 40;'''
new = '''const AUTO_OPTICS_MEMORY_KEY = "airgapper:auto-optics-memory:v1";
// A relative winner is meaningless when the whole local ISO neighborhood is
// unusable. Below this per-QR yield, abandon manual tuning and let hardware AE
// re-establish a sane exposure product before trying the motion-safe handoff.
const AUTO_OPTICS_COLLAPSE_YIELD = 0.12;
const AUTO_OPTICS_COLLAPSE_RETRY_MS = 900;
const AUTO_OPTICS_HOLD_SAMPLE_MS = 700;
const AUTO_OPTICS_HOLD_COLLAPSE_MS = 1400;
const AUTO_OPTICS_HOLD_MIN_ATTEMPTS = 40;
// Once a startup winner is found, never poke the camera periodically. Hold it
// until live per-QR yield falls far enough below that measured winner to prove
// the scene/optics changed, then recalibrate from neutral hardware AE.
const AUTO_OPTICS_HOLD_DEGRADE_RATIO = 0.55;'''
if old not in s: raise SystemExit("fine constants block missing")
s = s.replace(old, new, 1)

old = '''let autoOpticsRescueRetryAt = 0;
let autoOpticsFineTuneAt = 0;
let autoOpticsFineTuneDirection = 1;
let autoOpticsHoldSample;
let autoOpticsHoldCollapseSince = 0;'''
new = '''let autoOpticsRescueRetryAt = 0;
let autoOpticsHoldSample;
let autoOpticsHoldCollapseSince = 0;
let autoOpticsHeldYield = 0;'''
if old not in s: raise SystemExit("fine state block missing")
s = s.replace(old, new, 1)

old = '''  autoOpticsAcquisitionSince = 0;
  autoOpticsRescueRetryAt = 0;
  autoOpticsFineTuneAt = 0;
  autoOpticsFineTuneDirection = 1;
  autoOpticsHoldSample = void 0;
  autoOpticsHoldCollapseSince = 0;
  autoOpticsTuneSummary = "";'''
new = '''  autoOpticsAcquisitionSince = 0;
  autoOpticsRescueRetryAt = 0;
  autoOpticsHoldSample = void 0;
  autoOpticsHoldCollapseSince = 0;
  autoOpticsHeldYield = 0;
  autoOpticsTuneSummary = "";'''
if old not in s: raise SystemExit("runtime reset fine state missing")
s = s.replace(old, new, 1)

# Old memory carried a fine-tune direction that no longer has behavioral value.
s = s.replace('''      score: Number.isFinite(score) ? score : 0,\n      direction: autoOpticsFineTuneDirection < 0 ? -1 : 1,\n      at: Date.now()''',
              '''      score: Number.isFinite(score) ? score : 0,\n      at: Date.now()''', 1)

# Startup search remains bounded/darker-first; remove only periodic-probe state.
s = s.replace('''    autoOpticsFineTuneDirection = -1;\n    await probe(darker.requestedIso / Math.SQRT2);''',
              '''    await probe(darker.requestedIso / Math.SQRT2);''', 1)
s = s.replace('''      autoOpticsFineTuneDirection = 1;\n    } else {\n      autoOpticsFineTuneDirection = -1;\n    }''',
              '''    }''', 1)

old = '''    autoOpticsRuntimeState = "manual";
    autoOpticsHoldSample = autoOpticsPipelineSnapshot();
    autoOpticsHoldCollapseSince = 0;
    // Hold the winner, but keep Auto Optics alive as a very low-duty-cycle
    // controller. It may test one nearby ISO later when geometry is stable.
    autoOpticsRetryAt = Infinity;
    autoOpticsFineTuneAt = receiverNow() + AUTO_OPTICS_FINE_INTERVAL_MS;
    const tunedExposure = track.getSettings().exposureTime ?? exposure;
    const tunedIso = track.getSettings().iso ?? tuned.iso ?? iso;'''
new = '''    autoOpticsRuntimeState = "manual";
    autoOpticsHoldSample = autoOpticsPipelineSnapshot();
    autoOpticsHoldCollapseSince = 0;
    autoOpticsHeldYield = tuned.best?.yieldRate ?? 0;
    // A proven winner is held absolutely still. Recalibration is evidence-driven
    // by the live-yield watchdog below, not by periodic brightness probes.
    autoOpticsRetryAt = Infinity;
    const tunedExposure = track.getSettings().exposureTime ?? exposure;
    const tunedIso = track.getSettings().iso ?? tuned.iso ?? iso;'''
if old not in s: raise SystemExit("settle fine scheduling block missing")
s = s.replace(old, new, 1)

# Remove the periodic micro-tuner completely.
start = s.find('async function fineTuneAutomaticQrOptics(track, now) {')
end = s.find('async function releaseAutomaticQrOptics(track, now) {', start)
if start < 0 or end < 0: raise SystemExit("fine tune function boundaries missing")
s = s[:start] + s[end:]

# Recovery clears the baseline that belonged to the now-invalid held setting.
old = '''    autoOpticsHoldSample = void 0;
    autoOpticsHoldCollapseSince = 0;
    autoOpticsTuneSummary = `${reason} ${(yieldRate * 100).toFixed(0)}% · memory cleared · hardware AE reacquire`;
    focusController.adoptAutomaticCameraState("automatic optics live yield collapsed; hardware AE reacquire");'''
new = '''    autoOpticsHoldSample = void 0;
    autoOpticsHoldCollapseSince = 0;
    autoOpticsHeldYield = 0;
    autoOpticsTuneSummary = `${reason} ${(yieldRate * 100).toFixed(0)}% · memory cleared · hardware AE reacquire`;
    focusController.adoptAutomaticCameraState("automatic optics live yield degraded; hardware AE reacquire");'''
if old not in s: raise SystemExit("recovery baseline reset anchor missing")
s = s.replace(old, new, 1)

old = '''          const yieldRate = outputs / attempts;
          if (yieldRate < AUTO_OPTICS_COLLAPSE_YIELD) {
            if (!autoOpticsHoldCollapseSince) autoOpticsHoldCollapseSince = now;
            else if (now - autoOpticsHoldCollapseSince >= AUTO_OPTICS_HOLD_COLLAPSE_MS) {
              void recoverCollapsedAutomaticOptics(track, yieldRate);
              return;
            }
          } else {
            autoOpticsHoldCollapseSince = 0;
          }'''
new = '''          const yieldRate = outputs / attempts;
          const degradationThreshold = Math.max(
            AUTO_OPTICS_COLLAPSE_YIELD,
            autoOpticsHeldYield * AUTO_OPTICS_HOLD_DEGRADE_RATIO
          );
          if (yieldRate < degradationThreshold) {
            if (!autoOpticsHoldCollapseSince) autoOpticsHoldCollapseSince = now;
            else if (now - autoOpticsHoldCollapseSince >= AUTO_OPTICS_HOLD_COLLAPSE_MS) {
              const reason = yieldRate < AUTO_OPTICS_COLLAPSE_YIELD
                ? "held optics collapsed"
                : `held optics degraded from ${(autoOpticsHeldYield * 100).toFixed(0)}%`;
              void recoverCollapsedAutomaticOptics(track, yieldRate, reason);
              return;
            }
          } else {
            autoOpticsHoldCollapseSince = 0;
          }'''
if old not in s: raise SystemExit("hold watchdog old threshold missing")
s = s.replace(old, new, 1)

old = '''    if (now >= autoOpticsFineTuneAt && poseUsable)
      void fineTuneAutomaticQrOptics(track, now);
    return;'''
if old not in s: raise SystemExit("maintain fine invocation missing")
s = s.replace(old, '''    return;''', 1)

# The removed fine state should disappear from hot-path gating too.
s = s.replace('["tuning", "fine", "rescue", "settling"]', '["tuning", "rescue", "settling"]')

# When Optics is off, don't misleadingly append the internal AE runtime state.
old = '''    `AutoOptics ${automaticOptics ? autoOpticsRuntimeState : "off"}${autoOpticsRuntimeState === "manual" ? " · adaptive hold" : autoOpticsRuntimeState === "ae" ? " · bootstrap AE" : autoOpticsRuntimeState === "tuning" ? " · live ISO search" : autoOpticsRuntimeState === "fine" ? " · micro-tuning" : ""}${autoOpticsTuneSummary ? ` · ${autoOpticsTuneSummary}` : ""}`,'''
new = '''    `AutoOptics ${automaticOptics ? `${autoOpticsRuntimeState}${autoOpticsRuntimeState === "manual" ? " · adaptive hold" : autoOpticsRuntimeState === "ae" ? " · bootstrap AE" : autoOpticsRuntimeState === "tuning" ? " · live ISO search" : ""}${autoOpticsTuneSummary ? ` · ${autoOpticsTuneSummary}` : ""}` : "off"}`,'''
if old not in s: raise SystemExit("AutoOptics diagnostic line missing")
s = s.replace(old, new, 1)

# Reset held baseline on explicit session release as well.
old = '''    autoOpticsRetryAt = 0;
    await applyExposureSetting(track);
    autoOpticsRuntimeState = "ae";
    autoOpticsLockSince = 0;'''
new = '''    autoOpticsRetryAt = 0;
    autoOpticsHeldYield = 0;
    await applyExposureSetting(track);
    autoOpticsRuntimeState = "ae";
    autoOpticsLockSince = 0;'''
if old not in s: raise SystemExit("release baseline anchor missing")
s = s.replace(old, new, 1)

p.write_text(s)
