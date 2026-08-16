from pathlib import Path


def replace_once(path, old, new, label):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 match, found {count}")
    p.write_text(text.replace(old, new, 1))


main = Path("receive/main.js")
text = main.read_text()

text = text.replace(
    'const startBtn = document.getElementById("start");\nconst cameraResolution = document.getElementById("camera-resolution");',
    'const startBtn = document.getElementById("start");\nconst cameraDevice = document.getElementById("camera-device");\nconst cameraResolution = document.getElementById("camera-resolution");',
    1,
)

text = text.replace(
    'let browserModes = [];\nlet automaticBrowserMode;',
    'let browserModes = [];\nlet automaticBrowserMode;\nlet preferredCameraDeviceId = "";',
    1,
)

text = text.replace(
    '    if (!saved) return;\n    if (saved.resolution && [...cameraResolution.options].some((option) => option.value === saved.resolution)) {',
    '    if (!saved) return;\n    if (typeof saved.deviceId === "string") preferredCameraDeviceId = saved.deviceId;\n    if (saved.resolution && [...cameraResolution.options].some((option) => option.value === saved.resolution)) {',
    1,
)

text = text.replace(
    '    localStorage.setItem(CAMERA_SETTINGS_KEY, JSON.stringify({\n      resolution: cameraResolution.value,',
    '    localStorage.setItem(CAMERA_SETTINGS_KEY, JSON.stringify({\n      deviceId: preferredCameraDeviceId,\n      resolution: cameraResolution.value,',
    1,
)

needle = '''function readRequestedCameraSettings() {
  const browserMode = browserModes.find((mode) => mode.key === cameraResolution.value);
'''
insert = '''async function refreshCameraDevices(activeTrack) {
  if (!cameraDevice || !navigator.mediaDevices?.enumerateDevices) return;
  let devices = [];
  try {
    devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "videoinput");
  } catch {
    return;
  }
  const activeId = activeTrack?.getSettings?.().deviceId ?? "";
  const options = [new Option("Default camera", "")];
  devices.forEach((device, index) => options.push(new Option(device.label || `Camera ${index + 1}`, device.deviceId)));
  cameraDevice.replaceChildren(...options);
  const preferredExists = preferredCameraDeviceId && devices.some((device) => device.deviceId === preferredCameraDeviceId);
  const activeExists = activeId && devices.some((device) => device.deviceId === activeId);
  if (preferredExists) {
    cameraDevice.value = preferredCameraDeviceId;
  } else if (activeExists) {
    // Once Chrome has granted a concrete camera, pin that exact device for the
    // rest of the session. Desktop facingMode is only a preference and can
    // otherwise select a different camera when constraints are retried.
    preferredCameraDeviceId = activeId;
    cameraDevice.value = activeId;
    saveCameraSettings();
  } else {
    preferredCameraDeviceId = "";
    cameraDevice.value = "";
  }
  cameraDevice.disabled = devices.length <= 1;
}
function cameraDeviceConstraint() {
  return preferredCameraDeviceId
    ? { deviceId: { exact: preferredCameraDeviceId } }
    : { facingMode: "environment" };
}
function readRequestedCameraSettings() {
  const browserMode = browserModes.find((mode) => mode.key === cameraResolution.value);
'''
if needle not in text:
    raise SystemExit("readRequestedCameraSettings insertion point missing")
text = text.replace(needle, insert, 1)

# Harden every tracked-quad consumer at the central geometry boundary.
text = text.replace(
    'function trackedQuadBounds(quad) {\n  const points = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];\n  if (points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return null;',
    '''function validQuadObject(quad) {
  if (!quad) return false;
  const points = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];
  return points.every((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y));
}
function trackedQuadBounds(quad) {
  if (!validQuadObject(quad)) return null;
  const points = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];''',
    1,
)

text = text.replace(
    '  if (!region.quad || !region.dim || region.dim >= MAX_QR_MODULES) return false;',
    '  if (!validQuadObject(region.quad) || !region.dim || region.dim >= MAX_QR_MODULES) return false;',
    1,
)

text = text.replace(
    '  for (const slot of snapshot.slots) {\n    let region = regions.find((candidate) => candidate.gridSlot === slot.index);',
    '  for (const slot of snapshot.slots) {\n    if (!slot?.box || !validQuadObject(slot.quad)) continue;\n    let region = regions.find((candidate) => candidate.gridSlot === slot.index);',
    1,
)

old_focus = '''function focusGeometry() {
  const snapshot = lastGridSnapshot;
  if (!snapshot || !receiverFrameWidth || !receiverFrameHeight || !snapshot.slots.length) return void 0;
  const points = snapshot.slots.flatMap((slot) => [slot.quad.topLeft, slot.quad.topRight, slot.quad.bottomRight, slot.quad.bottomLeft]);
  const left = Math.min(...points.map((point) => point.x));
  const right = Math.max(...points.map((point) => point.x));
  const top = Math.min(...points.map((point) => point.y));
  const bottom = Math.max(...points.map((point) => point.y));
  const tracked = regions.filter((region) => region.gridSlot !== void 0);
  const quality = tracked.length ? tracked.reduce((sum, region) => sum + region.decodeConfidence, 0) / tracked.length : snapshot.confidence;
  const representative = snapshot.slots[Math.floor(snapshot.slots.length / 2)].quad;
'''
new_focus = '''function focusGeometry() {
  const snapshot = lastGridSnapshot;
  if (!snapshot || !receiverFrameWidth || !receiverFrameHeight || !snapshot.slots.length) return void 0;
  const validSlots = snapshot.slots.filter((slot) => slot && validQuadObject(slot.quad));
  if (!validSlots.length) return void 0;
  const points = validSlots.flatMap((slot) => [slot.quad.topLeft, slot.quad.topRight, slot.quad.bottomRight, slot.quad.bottomLeft]);
  const left = Math.min(...points.map((point) => point.x));
  const right = Math.max(...points.map((point) => point.x));
  const top = Math.min(...points.map((point) => point.y));
  const bottom = Math.max(...points.map((point) => point.y));
  const tracked = regions.filter((region) => region.gridSlot !== void 0 && validQuadObject(region.quad));
  const quality = tracked.length ? tracked.reduce((sum, region) => sum + region.decodeConfidence, 0) / tracked.length : snapshot.confidence;
  const representative = validSlots[Math.floor(validSlots.length / 2)].quad;
'''
if old_focus not in text:
    raise SystemExit("focusGeometry block missing")
text = text.replace(old_focus, new_focus, 1)

text = text.replace(
    '  optimizerFixedTargets = regions.filter((region) => region.decoded && region.quad && region.dim && region.visibleFraction >= 0.85).slice(0, 15).map((region) => ({',
    '  optimizerFixedTargets = regions.filter((region) => region.decoded && validQuadObject(region.quad) && region.dim && region.visibleFraction >= 0.85).slice(0, 15).map((region) => ({',
    1,
)

# Camera selector restart is a true receiver-session boundary.
text = text.replace(
    'cameraResolution.addEventListener("change", () => void changeCameraSettings());',
    '''cameraResolution.addEventListener("change", () => void changeCameraSettings());
cameraDevice?.addEventListener("change", () => {
  preferredCameraDeviceId = cameraDevice.value;
  saveCameraSettings();
  if (!stream || done) return;
  stopReceiver();
  void start();
});
navigator.mediaDevices?.addEventListener?.("devicechange", () => {
  void refreshCameraDevices(stream?.getVideoTracks()[0]);
});''',
    1,
)

text = text.replace(
    '  stream == null ? void 0 : stream.getTracks().forEach((track) => track.stop());\n  stream = null;\n  clearInterval(statsTimer);',
    '  stream == null ? void 0 : stream.getTracks().forEach((track) => track.stop());\n  stream = null;\n  video.srcObject = null;\n  clearInterval(statsTimer);',
    1,
)

text = text.replace(
    '  scanOutcomes.clear();\n  captureTimes.length = 0;',
    '  scanOutcomes.clear();\n  hotPathJobMode.clear();\n  scanCandidateEpoch.clear();\n  optimizerJobIds.clear();\n  optimizerValidEvents.clear();\n  benchmarkJobFrames.clear();\n  captureTimes.length = 0;',
    1,
)

# Make the source diagnostic identify the physical camera too.
old_source = '  const sourceLine = sourceSettings ? `track ${sourceSettings.width ?? "—"}×${sourceSettings.height ?? "—"}@${sourceSettings.frameRate ? Number(sourceSettings.frameRate).toFixed(1) : "—"} · video ${video.videoWidth || "—"}×${video.videoHeight || "—"} · capture ${receiverFrameWidth || "—"}×${receiverFrameHeight || "—"}@${sourceCaptureRate.toFixed(1)} · VideoFrame ${lastVideoFrameInfo ?? "—"}` : "camera inactive";'
new_source = '  const sourceLine = sourceSettings ? `${sourceTrack?.label || "camera"} · id ${(sourceSettings.deviceId || "—").slice(0, 8)} · track ${sourceSettings.width ?? "—"}×${sourceSettings.height ?? "—"}@${sourceSettings.frameRate ? Number(sourceSettings.frameRate).toFixed(1) : "—"} · video ${video.videoWidth || "—"}×${video.videoHeight || "—"} · capture ${receiverFrameWidth || "—"}×${receiverFrameHeight || "—"}@${sourceCaptureRate.toFixed(1)} · VideoFrame ${lastVideoFrameInfo ?? "—"}` : "camera inactive";'
if old_source not in text:
    raise SystemExit("source diagnostic line missing")
text = text.replace(old_source, new_source, 1)

# Scope camera-constraint edits to start() only.
start_at = text.index('async function start() {')
end_at = text.index('const CORPUS_DEVICE_NAMES', start_at)
start_block = text[start_at:end_at]
start_block = start_block.replace(
    '''  const base = {
    facingMode: "environment",
    width: { exact: captureWidth },
    height: { exact: captureHeight }
  };''',
    '''  const cameraChoice = cameraDeviceConstraint();
  const base = {
    ...cameraChoice,
    width: { exact: captureWidth },
    height: { exact: captureHeight }
  };''',
    1,
)
start_block = start_block.replace('video: {\n          facingMode: "environment",\n          width: { ideal: captureWidth },', 'video: {\n          ...cameraChoice,\n          width: { ideal: captureWidth },', 1)
start_block = start_block.replace('video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } }', 'video: { ...cameraChoice, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } }', 1)
start_block = start_block.replace('video: { facingMode: "environment", width: { ideal: captureWidth }, height: { ideal: captureHeight }, frameRate: { ideal: captureFps } }', 'video: { ...cameraChoice, width: { ideal: captureWidth }, height: { ideal: captureHeight }, frameRate: { ideal: captureFps } }')
if 'facingMode: "environment"' in start_block:
    raise SystemExit("start() still contains an unscoped facingMode fallback")
start_block = start_block.replace(
    '''  const activeTrack = stream.getVideoTracks()[0];
  if (activeTrack) {
    populateBrowserCapabilities(activeTrack);''',
    '''  const activeTrack = stream.getVideoTracks()[0];
  if (activeTrack) {
    await refreshCameraDevices(activeTrack);
    populateBrowserCapabilities(activeTrack);''',
    1,
)
text = text[:start_at] + start_block + text[end_at:]
main.write_text(text)

# Grid-lattice must never emit or dereference a malformed quad.
grid = Path("receive/grid-lattice.js")
g = grid.read_text()
g = g.replace(
    '''function corners(quad) {
  return [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];
}
function validGeometry(detection) {
  if (detection.modules < 21 || detection.modules > 177 || detection.modules % 4 !== 1) return false;
  const points = corners(detection.quad);
  if (points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return false;''',
    '''function corners(quad) {
  return quad ? [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft] : [];
}
function validPoints(points) {
  return points.length === 4 && points.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
}
function validGeometry(detection) {
  if (!detection || detection.modules < 21 || detection.modules > 177 || detection.modules % 4 !== 1) return false;
  const points = corners(detection.quad);
  if (!validPoints(points)) return false;''',
    1,
)
g = g.replace(
    '''function bounds(quad) {
  const points = corners(quad);
  const left = Math.min(...points.map((p) => p.x));''',
    '''function bounds(quad) {
  const points = corners(quad);
  if (!validPoints(points)) return null;
  const left = Math.min(...points.map((p) => p.x));''',
    1,
)
g = g.replace(
    '''      const quad = { topLeft: points[0], topRight: points[1], bottomRight: points[2], bottomLeft: points[3] };
      slots.push({ index, quad, box: bounds(quad), decoded: decoded.has(index) });''',
    '''      const quad = { topLeft: points[0], topRight: points[1], bottomRight: points[2], bottomLeft: points[3] };
      const box = bounds(quad);
      if (!box) return null;
      slots.push({ index, quad, box, decoded: decoded.has(index) });''',
    1,
)
grid.write_text(g)

# UI and cache/version bump.
index = Path("index.html")
i = index.read_text()
i = i.replace(
    '<div class="row">\n            <label id="camera-resolution-control">',
    '<div class="row">\n            <label id="camera-device-control"><span>Camera</span><select id="camera-device"><option value="">Default camera</option></select></label>\n            <label id="camera-resolution-control">',
    1,
)
if 'v0.5.57' not in i:
    raise SystemExit("index version v0.5.57 missing")
i = i.replace('v0.5.57', 'v0.5.58', 1)
index.write_text(i)

sw = Path("sw.js")
s = sw.read_text()
if 'airgapper-static-js-v20' not in s:
    raise SystemExit("service worker cache v20 missing")
s = s.replace('airgapper-static-js-v20', 'airgapper-static-js-v21', 1)
sw.write_text(s)
