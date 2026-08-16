from pathlib import Path


def replace_once(text, old, new, label):
    if old not in text:
        raise SystemExit(f"missing {label}")
    return text.replace(old, new, 1)

# Version/cache bumps.
p = Path('index.html')
s = p.read_text()
s = replace_once(s, 'v0.5.140', 'v0.5.141', 'index version')
p.write_text(s)

p = Path('main.js')
s = p.read_text()
s = replace_once(s, 'v0.5.140', 'v0.5.141', 'app version')
p.write_text(s)

p = Path('sw.js')
s = p.read_text()
s = replace_once(s, 'airgapper-static-js-v103', 'airgapper-static-js-v104', 'cache version')
p.write_text(s)

p = Path('receive/main.js')
s = p.read_text()
s = replace_once(s, 'const RECEIVER_RUNTIME_BUILD = "v0.5.140";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.141";', 'receiver version')

# Make acquisition more eager and add a rotating seed-window search. Full-wall
# multi-QR finder scans are retained regularly, but most pre-lock attempts see
# only a small overlapping part of the image so ZXing is not asked to untangle
# dozens of finder patterns at once.
s = replace_once(
    s,
    'const ACQUISITION_SCAN_MS = 100;\nconst FULL_SCAN_DEGRADED_MS = 250;',
    'const ACQUISITION_SCAN_MS = 45;\nconst ACQUISITION_FULL_EVERY = 4;\nconst ACQUISITION_DEEP_EVERY = 13;\nconst FULL_SCAN_DEGRADED_MS = 250;',
    'acquisition constants'
)
s = replace_once(
    s,
    'let totalDecodes = 0;\nlet fullScans = 0;\nlet peakRegions = 0;',
    'let totalDecodes = 0;\nlet fullScans = 0;\nlet acquisitionTileCursor = 0;\nlet peakRegions = 0;',
    'acquisition cursor declaration'
)
s = replace_once(
    s,
    '  totalDecodes = 0;\n  fullScans = 0;\n  peakRegions = 0;',
    '  totalDecodes = 0;\n  fullScans = 0;\n  acquisitionTileCursor = 0;\n  peakRegions = 0;',
    'acquisition cursor reset'
)

anchor = '''function cloneDirectDecodeFrame(source) {
  if (optimizerPipelineActive || source.image || captureNextScan || opticalSampleDue(source) || typeof VideoFrame !== "function") return null;
  return cloneVideoFrame(source, false);
}
'''
insert = '''function cloneDirectDecodeFrame(source) {
  if (optimizerPipelineActive || source.image || captureNextScan || opticalSampleDue(source) || typeof VideoFrame !== "function") return null;
  return cloneVideoFrame(source, false);
}
function acquisitionSeedWindow(index, width, height) {
  // 3x3 overlapping windows work for both portrait 3xN and landscape Nx3 QR
  // walls. A window is deliberately larger than one cell so a QR that lands on
  // a tile boundary is still whole in a neighboring attempt.
  const cols = 3, rows = 3;
  const col = index % cols;
  const row = Math.floor(index / cols) % rows;
  const cellW = width / cols;
  const cellH = height / rows;
  const padX = cellW * 0.28;
  const padY = cellH * 0.28;
  const quantum = 16;
  const x = Math.max(0, Math.floor((col * cellW - padX) / quantum) * quantum);
  const y = Math.max(0, Math.floor((row * cellH - padY) / quantum) * quantum);
  const right = Math.min(width, Math.ceil(((col + 1) * cellW + padX) / quantum) * quantum);
  const bottom = Math.min(height, Math.ceil(((row + 1) * cellH + padY) / quantum) * quantum);
  return { x, y, w: Math.max(32, right - x), h: Math.max(32, bottom - y) };
}
'''
s = replace_once(s, anchor, insert, 'seed window helper')

old = '''    // Seven cheap seed attempts for every deep tryHarder attempt. Never run a
    // cheap miss and a deep retry on the same frame: the next camera frame is
    // fresher and avoids the old multi-second double scan.
    const acquisitionMode = captureNextScan ? "thorough" : fullScans % 8 === 0 ? "deep" : "fast";
    let scanX = 0, scanY = 0, scanW = vw, scanH = vh;
'''
new = '''    // A dense 18-QR wall can present 54 finder patterns to the generic
    // detector. That is a bad acquisition problem even when every QR is sharp.
    // Keep the first and every fourth attempt full-frame (important for 1-QR
    // senders), but rotate the intervening attempts through overlapping 3x3
    // seed windows. Any verified packet declares layout + slot and immediately
    // gives the lattice useful provisional geometry.
    const fullFrameSeed = captureNextScan || (fullScans - 1) % ACQUISITION_FULL_EVERY === 0;
    let acquisitionMode = captureNextScan ? "thorough" : fullFrameSeed
      ? fullScans % ACQUISITION_DEEP_EVERY === 0 ? "deep" : "fast"
      : "seed";
    let scanX = 0, scanY = 0, scanW = vw, scanH = vh;
    if (!captureNextScan && preLatticeDiscovery && !lastGridSnapshot && !fullFrameSeed) {
      const seed = acquisitionSeedWindow(acquisitionTileCursor++, vw, vh);
      scanX = seed.x;
      scanY = seed.y;
      scanW = seed.w;
      scanH = seed.h;
    }
'''
s = replace_once(s, old, new, 'acquisition scheduling')

# Automatic optics runtime: hardware AE gets us a good brightness for initial
# acquisition. After sustained verified decoding, freeze the same exposure
# value into a shorter shutter + compensating ISO to reduce hand/display motion
# blur. If the target is truly lost, release back to AE for reacquisition.
old = '''let automaticOptics = true;
let automaticExposureAxis = true;
let automaticIsoAxis = true;
let preferredExposureTime;
'''
new = '''let automaticOptics = true;
let automaticExposureAxis = true;
let automaticIsoAxis = true;
const AUTO_OPTICS_LOCK_SETTLE_MS = 650;
const AUTO_OPTICS_RELEASE_SILENCE_MS = 2400;
const AUTO_OPTICS_RECENT_DECODE_MS = 700;
const AUTO_OPTICS_MIN_RECENT_DECODES = 4;
const AUTO_OPTICS_SHUTTER_FRAME_FRACTION = 0.30;
let autoOpticsRuntimeState = "ae";
let autoOpticsMutationRunning = false;
let autoOpticsLockSince = 0;
let autoOpticsRetryAt = 0;
let preferredExposureTime;
'''
s = replace_once(s, old, new, 'auto optics state')

# Insert the runtime controller immediately after applyExposureSetting so it can
# reuse the existing camera quirk handling and exposure constraint path.
needle = '''async function applyExposureSetting(track) {
'''
start = s.index(needle)
end_marker = '\nfunction populateBrowserCapabilities(track) {'
end = s.index(end_marker, start)
block = s[start:end]
auto_helpers = r'''
function resetAutomaticOpticsRuntime() {
  autoOpticsRuntimeState = "ae";
  autoOpticsMutationRunning = false;
  autoOpticsLockSince = 0;
  autoOpticsRetryAt = 0;
}
function quantizeCameraRange(value, range) {
  const clamped = Math.max(range.min, Math.min(range.max, value));
  if (!range.step || range.step <= 0) return clamped;
  return Math.max(range.min, Math.min(range.max,
    range.min + Math.round((clamped - range.min) / range.step) * range.step
  ));
}
async function settleAutomaticQrOptics(track, now) {
  if (autoOpticsMutationRunning || !automaticOptics || now < autoOpticsRetryAt) return;
  const caps = track.getCapabilities?.() ?? {};
  const exposureRange = caps.exposureTime;
  const isoRange = caps.iso;
  const settings = track.getSettings();
  if (!Array.isArray(caps.exposureMode) || !caps.exposureMode.includes("manual") ||
      !exposureRange || !isoRange || !Number.isFinite(settings.exposureTime) ||
      !Number.isFinite(settings.iso) || settings.exposureTime <= 0 || settings.iso <= 0) {
    autoOpticsRetryAt = now + 2500;
    return;
  }
  const fps = Math.max(12, Math.min(120, Number(settings.frameRate) || 30));
  // exposureTime is reported in 0.1 ms units on Chromium camera controls.
  // 30% of a frame is 10 ms at 30 fps / 5 ms at 60 fps: short enough to cut
  // handheld/display-transition blur without demanding extreme gain.
  const motionSafeExposure = 1e4 / fps * AUTO_OPTICS_SHUTTER_FRAME_FRACTION;
  const exposureProduct = settings.exposureTime * settings.iso;
  const maxAutoIso = Math.min(isoRange.max, Math.max(isoRange.min, settings.iso * 4));
  let exposure = quantizeCameraRange(Math.min(settings.exposureTime, motionSafeExposure), exposureRange);
  let iso = quantizeCameraRange(exposureProduct / Math.max(exposureRange.min, exposure), isoRange);
  if (iso > maxAutoIso) {
    iso = quantizeCameraRange(maxAutoIso, isoRange);
    exposure = quantizeCameraRange(exposureProduct / Math.max(isoRange.min, iso), exposureRange);
  }
  // Re-quantize gain after shutter quantization so brightness remains close to
  // the hardware-AE baseline rather than accidentally changing EV.
  iso = quantizeCameraRange(exposureProduct / Math.max(exposureRange.min, exposure), isoRange);
  autoOpticsMutationRunning = true;
  autoOpticsRuntimeState = "settling";
  holdDecoderForCameraMutation("automatic QR optics settling", 280);
  try {
    const accepted = await applyCameraConstraint(track, {
      exposureMode: "manual",
      exposureTime: exposure,
      iso
    });
    if (!accepted || track.readyState !== "live") {
      autoOpticsRuntimeState = "ae";
      autoOpticsRetryAt = receiverNow() + 2200;
      return;
    }
    autoOpticsRuntimeState = "manual";
    autoOpticsRetryAt = receiverNow() + 1500;
    preferredExposureTime = track.getSettings().exposureTime ?? exposure;
    preferredIso = track.getSettings().iso ?? iso;
    focusController.adoptAutomaticCameraState("automatic QR exposure settled to motion-safe shutter + ISO");
  } finally {
    autoOpticsMutationRunning = false;
  }
}
async function releaseAutomaticQrOptics(track, now) {
  if (autoOpticsMutationRunning || !automaticOptics || now < autoOpticsRetryAt) return;
  autoOpticsMutationRunning = true;
  autoOpticsRuntimeState = "settling";
  holdDecoderForCameraMutation("automatic optics returning to hardware AE", 280);
  try {
    await applyExposureSetting(track);
    autoOpticsRuntimeState = "ae";
    autoOpticsLockSince = 0;
    autoOpticsRetryAt = receiverNow() + 900;
    focusController.adoptAutomaticCameraState("target lost; hardware AE restored for reacquisition");
  } finally {
    autoOpticsMutationRunning = false;
  }
}
function maintainAutomaticQrOptics(now) {
  if (!automaticOptics || replayRunning || optimizerPipelineActive || optimizeRunning || autoOpticsMutationRunning) return;
  const track = stream?.getVideoTracks()[0];
  if (!track || track.readyState !== "live") return;
  if (gridLattice.locked) {
    if (!autoOpticsLockSince) autoOpticsLockSince = now;
    const recentDecodes = qrReadTimes.reduce((count, at) => count + Number(at > now - AUTO_OPTICS_RECENT_DECODE_MS), 0);
    const decodeFresh = Boolean(lastStreamDecodeAt && now - lastStreamDecodeAt < AUTO_OPTICS_RECENT_DECODE_MS);
    if (autoOpticsRuntimeState === "ae" && decodeFresh && recentDecodes >= AUTO_OPTICS_MIN_RECENT_DECODES &&
        now - autoOpticsLockSince >= AUTO_OPTICS_LOCK_SETTLE_MS && now >= autoOpticsRetryAt) {
      void settleAutomaticQrOptics(track, now);
    }
    return;
  }
  autoOpticsLockSince = 0;
  if (autoOpticsRuntimeState === "manual" &&
      (!lastStreamDecodeAt || now - lastStreamDecodeAt >= AUTO_OPTICS_RELEASE_SILENCE_MS) &&
      now >= autoOpticsRetryAt) {
    void releaseAutomaticQrOptics(track, now);
  }
}
'''
s = s[:end] + auto_helpers + s[end:]

s = replace_once(
    s,
    'function populateBrowserCapabilities(track) {\n  var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m;\n  seedDesiredCamera(track);',
    'function populateBrowserCapabilities(track) {\n  var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m;\n  resetAutomaticOpticsRuntime();\n  seedDesiredCamera(track);',
    'auto optics camera reset'
)

s = replace_once(
    s,
    '  const now = receiverNow();\n  const trace = replayRunning ? {',
    '  const now = receiverNow();\n  maintainAutomaticQrOptics(now);\n  const trace = replayRunning ? {',
    'auto optics capture maintenance'
)

# Reset runtime whenever the Auto checkbox is changed; the existing handler
# then applies the requested camera mode.
s = replace_once(
    s,
    'cameraExposureAuto.addEventListener("change", () => {\n  automaticOptics = cameraExposureAuto.checked;\n  clearTimeout(exposureApplyTimer);',
    'cameraExposureAuto.addEventListener("change", () => {\n  automaticOptics = cameraExposureAuto.checked;\n  resetAutomaticOpticsRuntime();\n  clearTimeout(exposureApplyTimer);',
    'auto optics toggle reset'
)

# Surface the state so future field diagnostics immediately tell us whether AE
# is still acquiring brightness or the QR-specific manual shutter has settled.
s = replace_once(
    s,
    '    `ISO      committed ${(_k = diagnostic.committedIso) != null ? _k : "—"} · requested ${(_l = diagnostic.candidateIso) != null ? _l : "—"} · actual ${(_m = diagnostic.actualIso) != null ? _m : "—"}`,\n',
    '    `ISO      committed ${(_k = diagnostic.committedIso) != null ? _k : "—"} · requested ${(_l = diagnostic.candidateIso) != null ? _l : "—"} · actual ${(_m = diagnostic.actualIso) != null ? _m : "—"}`,\n    `AutoOptics ${automaticOptics ? autoOpticsRuntimeState : "off"}${autoOpticsRuntimeState === "manual" ? " · QR exposure held" : autoOpticsRuntimeState === "ae" ? " · hardware AE" : ""}`,\n',
    'auto optics diagnostics'
)

p.write_text(s)

# Worker: seed windows use tryHarder, but on a much smaller crop and only ask
# for two symbols. This is the independent fast path that the whole-wall scan
# was missing.
p = Path('receive/worker.js')
s = p.read_text()
old = '''        if (fullMode === "thorough") {
          readFullAttempts++;
          appendResults(readFull(true, 16, false), false);
          if (symbols.length === 0) {
            readFullAttempts++;
            appendResults(readFull(true, 24, true), true);
          }
        } else {
          readFullAttempts++;
          appendResults(readFull(fullMode === "deep", 4, false), false);
        }
'''
new = '''        if (fullMode === "thorough") {
          readFullAttempts++;
          appendResults(readFull(true, 16, false), false);
          if (symbols.length === 0) {
            readFullAttempts++;
            appendResults(readFull(true, 24, true), true);
          }
        } else if (fullMode === "seed") {
          readFullAttempts++;
          appendResults(readFull(true, 2, false), false);
        } else {
          readFullAttempts++;
          appendResults(readFull(fullMode === "deep", 4, false), false);
        }
'''
s = replace_once(s, old, new, 'worker seed mode')
p.write_text(s)

# Focus controller: camera mutations performed by the automatic QR optics
# controller need to fence stale decode evidence and update committed settings.
p = Path('receive/focus-controller.js')
s = p.read_text()
needle = '''  noteUsefulDecode(scanId, now = performance.now()) {
    if (scanId !== void 0 && scanId >= this.decodeBoundary) this.lastUsefulDecodeAt = now;
  }
'''
replacement = '''  noteUsefulDecode(scanId, now = performance.now()) {
    if (scanId !== void 0 && scanId >= this.decodeBoundary) this.lastUsefulDecodeAt = now;
  }
  adoptAutomaticCameraState(reason) {
    this.commitSettings(this.settings());
    this.beginDecodeGeneration();
    this.lastReason = reason;
    this.changed();
  }
'''
s = replace_once(s, needle, replacement, 'focus camera state adoption')
p.write_text(s)

print('v0.5.141 patch applied')
