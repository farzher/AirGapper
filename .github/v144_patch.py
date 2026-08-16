from pathlib import Path
import re

root = Path('.')
main = root / 'receive/main.js'
s = main.read_text()

old = '''const AUTO_OPTICS_LOCK_SETTLE_MS = 1800;\nconst AUTO_OPTICS_RELEASE_SILENCE_MS = 2400;\nconst AUTO_OPTICS_RECENT_DECODE_MS = 900;\nconst AUTO_OPTICS_MIN_STRUGGLING_QR_PER_SECOND = 5;\nconst AUTO_OPTICS_MAX_STRUGGLING_QR_PER_SECOND = 45;\nconst AUTO_OPTICS_SHUTTER_FRAME_FRACTION = 0.30;\nconst AUTO_OPTICS_VALIDATE_MS = 900;'''
new = '''const AUTO_OPTICS_LOCK_SETTLE_MS = 1400;\nconst AUTO_OPTICS_RECENT_DECODE_MS = 900;\nconst AUTO_OPTICS_MIN_SETTLE_QR_PER_SECOND = 12;\nconst AUTO_OPTICS_SHUTTER_FRAME_FRACTION = 0.30;'''
assert old in s
s = s.replace(old, new, 1)

old = '''let autoOpticsRetryAt = 0;\nlet autoOpticsValidationAt = 0;\nlet autoOpticsBaselineQrRate = 0;'''
new = '''let autoOpticsRetryAt = 0;'''
assert old in s
s = s.replace(old, new, 1)

old = '''  autoOpticsRetryAt = 0;\n  autoOpticsValidationAt = 0;\n  autoOpticsBaselineQrRate = 0;'''
new = '''  autoOpticsRetryAt = 0;'''
assert old in s
s = s.replace(old, new, 1)

old = '''    autoOpticsRuntimeState = "manual";\n    autoOpticsRetryAt = receiverNow() + 1500;\n    autoOpticsValidationAt = receiverNow() + AUTO_OPTICS_VALIDATE_MS;\n    preferredExposureTime = track.getSettings().exposureTime ?? exposure;'''
new = '''    autoOpticsRuntimeState = "manual";\n    // Automatic optics is intentionally one-way for this camera session.\n    // Continuous AE reacts to the animated QR wall itself and repeatedly moves\n    // a scene that decodes better when held still. Once we have a verified QR\n    // lock, keep this manual exposure through ordinary loss/reacquisition.\n    autoOpticsRetryAt = Infinity;\n    preferredExposureTime = track.getSettings().exposureTime ?? exposure;'''
assert old in s
s = s.replace(old, new, 1)

start = s.index('async function releaseAutomaticQrOptics(track, now) {')
end = s.index('\nfunction maintainAutomaticQrOptics(now) {', start)
s = s[:start] + '''async function releaseAutomaticQrOptics(track, now) {\n  // Kept for explicit/session-level resets only. Normal target loss must not\n  // bounce the camera back into continuous AE.\n  if (autoOpticsMutationRunning || !automaticOptics) return;\n  autoOpticsMutationRunning = true;\n  autoOpticsRuntimeState = "settling";\n  holdDecoderForCameraMutation("automatic optics session reset", 280);\n  try {\n    autoOpticsRetryAt = 0;\n    await applyExposureSetting(track);\n    autoOpticsRuntimeState = "ae";\n    autoOpticsLockSince = 0;\n    focusController.adoptAutomaticCameraState("hardware AE restored for new optics session");\n  } finally {\n    autoOpticsMutationRunning = false;\n  }\n}''' + s[end:]

start = s.index('function maintainAutomaticQrOptics(now) {')
end = s.index('\n\nfunction populateBrowserCapabilities(track) {', start)
new_maintain = '''function maintainAutomaticQrOptics(now) {\n  if (!automaticOptics || replayRunning || optimizerPipelineActive || optimizeRunning || autoOpticsMutationRunning) return;\n  const track = stream?.getVideoTracks()[0];\n  if (!track || track.readyState !== "live") return;\n\n  // Auto optics is a bootstrap, not a continuously active controller. Hardware\n  // AE gets enough time to establish scene brightness; a verified QR lock then\n  // lets us convert that brightness to a shorter manual shutter + compensating\n  // ISO exactly once. The manual state survives target/lattice loss.\n  if (autoOpticsRuntimeState !== "ae") return;\n  if (!gridLattice.locked) {\n    autoOpticsLockSince = 0;\n    return;\n  }\n  if (!autoOpticsLockSince) autoOpticsLockSince = now;\n  if (now - autoOpticsLockSince < AUTO_OPTICS_LOCK_SETTLE_MS || now < autoOpticsRetryAt) return;\n\n  const settings = track.getSettings();\n  const recentDecodes = qrReadTimes.reduce((count, at) => count + Number(at > now - AUTO_OPTICS_RECENT_DECODE_MS), 0);\n  const recentQrRate = recentDecodes / (AUTO_OPTICS_RECENT_DECODE_MS / 1e3);\n  const captureWindowMs = 800;\n  const recentCaptureRate = captureTimes.reduce((count, at) => count + Number(at > now - captureWindowMs), 0) / (captureWindowMs / 1e3);\n  const nominalFps = Math.max(12, Math.min(120, Number(settings.frameRate) || 30));\n  const decodeFresh = Boolean(lastStreamDecodeAt && now - lastStreamDecodeAt < AUTO_OPTICS_RECENT_DECODE_MS);\n\n  if (decodeFresh && recentQrRate >= AUTO_OPTICS_MIN_SETTLE_QR_PER_SECOND && recentCaptureRate >= nominalFps * 0.78) {\n    void settleAutomaticQrOptics(track, now);\n  }\n}'''
s = s[:start] + new_maintain + s[end:]

# Diagnostics wording makes the one-way behavior obvious.
s = s.replace(
    'autoOpticsRuntimeState === "manual" ? " · QR exposure held" : autoOpticsRuntimeState === "ae" ? " · hardware AE" : ""',
    'autoOpticsRuntimeState === "manual" ? " · locked for session" : autoOpticsRuntimeState === "ae" ? " · bootstrap AE" : ""',
    1
)

main.write_text(s)

for name in ['index.html', 'main.js', 'receive/main.js']:
    p = root / name
    text = p.read_text()
    assert 'v0.5.143' in text, name
    p.write_text(text.replace('v0.5.143', 'v0.5.144'))

sw = root / 'sw.js'
text = sw.read_text()
m = re.search(r'airgapper-static-js-v(\d+)', text)
assert m
text = text[:m.start(1)] + str(int(m.group(1)) + 1) + text[m.end(1):]
sw.write_text(text)
