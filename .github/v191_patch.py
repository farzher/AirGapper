from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"replacement not found in {path}: {old[:180]!r}")
    p.write_text(s.replace(old, new, count))

replace("index.html", "v0.5.190", "v0.5.191")
replace("main.js", 'const APP_BUILD = "v0.5.190";', 'const APP_BUILD = "v0.5.191";')
replace("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.190";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.191";')
replace("sw.js", 'const CACHE = "airgapper-static-js-v152";', 'const CACHE = "airgapper-static-js-v153";')

p = Path("receive/main.js")
s = p.read_text()

s = s.replace('const AUTO_OPTICS_RESCUE_RETRY_MS = 7000;', 'const AUTO_OPTICS_RESCUE_RETRY_MS = 12000;', 1)
s = s.replace('const AUTO_OPTICS_MEMORY_MAX_SCALE = 2.25;', 'const AUTO_OPTICS_MEMORY_MAX_SCALE = 1;', 1)

# No post-lock candidate may be brighter than neutral hardware AE. With a
# shorter motion-safe shutter this can still mean ISO > AE ISO, but the total
# exposure product exposure*ISO never exceeds the AE product.
old = '''  const aeExposureProduct = aeExposure * aeIso;
  const exposureProduct = aeExposureProduct * AUTO_QR_LIGHT_SCALE;
  const maxAutoIso = Math.min(isoRange.max, Math.max(isoRange.min, aeIso * 4));
  let exposure = quantizeCameraRange(Math.min(aeExposure, motionSafeExposure), exposureRange);
  let iso = quantizeCameraRange(exposureProduct / Math.max(exposureRange.min, exposure), isoRange);'''
new = '''  const aeExposureProduct = aeExposure * aeIso;
  const exposureProduct = aeExposureProduct * AUTO_QR_LIGHT_SCALE;
  let exposure = quantizeCameraRange(Math.min(aeExposure, motionSafeExposure), exposureRange);
  const maxAutoIso = Math.min(
    isoRange.max,
    Math.max(isoRange.min, aeExposureProduct / Math.max(exposureRange.min, exposure))
  );
  let iso = quantizeCameraRange(exposureProduct / Math.max(exposureRange.min, exposure), isoRange);'''
if old not in s: raise SystemExit("post-lock AE cap block missing")
s = s.replace(old, new, 1)

# The cold ladder is deliberately darker-only. Neutral AE has already had 2.5s
# to work before this rescue runs; manually retesting it is wasted mutation, and
# testing above it is actively wrong for an emissive QR wall. The deep final
# probe handles phones whose AE meters dark surroundings and pegs ISO very high.
old = '''  const scales = [
    ...(memoryHealthy ? [memoryScale] : []),
    AUTO_QR_LIGHT_SCALE,
    1,
    Math.pow(2, 0.7),
    2
  ];'''
new = '''  const scales = [
    ...(memoryHealthy ? [memoryScale] : []),
    AUTO_QR_LIGHT_SCALE,
    Math.pow(2, -1.7),
    Math.pow(2, -3),
    Math.pow(2, -4.5)
  ];'''
if old not in s: raise SystemExit("cold scale ladder missing")
s = s.replace(old, new, 1)

# Make the invariant explicit even if a future scale list changes: cold search
# can never construct an exposure product above the neutral AE baseline.
old = '''  for (const scale of scales) {
    let exposure = baseExposure;
    let iso = quantizeCameraRange(aeProduct * scale / Math.max(exposureRange.min, exposure), isoRange);'''
new = '''  for (const scaleRaw of scales) {
    const scale = Math.min(1, Math.max(AUTO_OPTICS_MEMORY_MIN_SCALE / 8, scaleRaw));
    let exposure = baseExposure;
    let iso = quantizeCameraRange(aeProduct * scale / Math.max(exposureRange.min, exposure), isoRange);'''
if old not in s: raise SystemExit("cold scale loop missing")
s = s.replace(old, new, 1)

# AF retries must not depend on already having QR geometry. The controller itself
# owns capability/state/interval checks; this heartbeat simply guarantees it is
# called while the camera is delivering frames but acquisition is still cold.
anchor = '''function maintainAutomaticQrOptics(now) {
  if (!automaticOptics || replayRunning || optimizerPipelineActive || optimizeRunning || autoOpticsMutationRunning) return;'''
insert = '''function maintainAcquisitionAutofocus(now) {
  if (replayRunning || optimizerPipelineActive || optimizeRunning || autoOpticsMutationRunning || gridLattice.locked) return;
  const track = stream?.getVideoTracks()[0];
  if (!track || track.readyState !== "live") return;
  void focusController.maybeRetrySeekingAutofocus(now);
}

function maintainAutomaticQrOptics(now) {
  if (!automaticOptics || replayRunning || optimizerPipelineActive || optimizeRunning || autoOpticsMutationRunning) return;'''
if anchor not in s: raise SystemExit("maintain auto optics anchor missing")
s = s.replace(anchor, insert, 1)

old = '''  const now = receiverNow();
  void maintainManualOptics(now);
  maintainAutomaticQrOptics(now);'''
new = '''  const now = receiverNow();
  void maintainManualOptics(now);
  maintainAcquisitionAutofocus(now);
  maintainAutomaticQrOptics(now);'''
if old not in s: raise SystemExit("frame maintenance callsite missing")
s = s.replace(old, new, 1)

# Clarify diagnostics while cold: expose the hard AE ceiling so an accidental
# brighter candidate is immediately visible in copied traces.
old = '''      autoOpticsTuneSummary = `cold search ${index + 1}/${candidates.length}${remembered ? " · recent winner" : ""} · ${formatExposureMs(candidate.exposure)} · ISO ${Math.round(candidate.iso)} · ${Math.log2(candidate.scale).toFixed(1)}EV vs AE`;'''
new = '''      autoOpticsTuneSummary = `cold dark search ${index + 1}/${candidates.length}${remembered ? " · recent winner" : ""} · ${formatExposureMs(candidate.exposure)} · ISO ${Math.round(candidate.iso)} · ${Math.log2(candidate.scale).toFixed(1)}EV vs AE`;'''
if old not in s: raise SystemExit("cold diagnostic label missing")
s = s.replace(old, new, 1)

p.write_text(s)

p = Path("receive/focus-controller.js")
s = p.read_text()
# Five quick retries are useful during initial acquisition. After that, repeated
# lens sweeps become disruptive, so keep checking but at a lower duty cycle.
s = s.replace('seekingAfSlowRetryMs: 1500,', 'seekingAfSlowRetryMs: 3000,', 1)
p.write_text(s)
