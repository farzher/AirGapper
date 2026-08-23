from pathlib import Path
import re

p = Path("receive/runtime.js")
s = p.read_text()


def replace_one(old, new, label):
    global s
    if old not in s:
        raise SystemExit(f"missing {label}")
    s = s.replace(old, new, 1)


def sub_one(pattern, repl, label, flags=0):
    global s
    s2, count = re.subn(pattern, repl, s, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f"missing {label}")
    s = s2


def remove_function(name):
    global s
    match = re.search(rf"(?:async\s+)?function\s+{re.escape(name)}\s*\(", s)
    if not match:
        raise SystemExit(f"missing function {name}")
    brace = s.find("{", match.end())
    if brace < 0:
        raise SystemExit(f"missing body for {name}")
    i = brace
    depth = 0
    quote = None
    line_comment = False
    block_comment = False
    escaped = False
    while i < len(s):
        ch = s[i]
        nxt = s[i + 1] if i + 1 < len(s) else ""
        if line_comment:
            if ch == "\n": line_comment = False
        elif block_comment:
            if ch == "*" and nxt == "/":
                block_comment = False
                i += 1
        elif quote:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == quote:
                quote = None
        else:
            if ch == "/" and nxt == "/":
                line_comment = True
                i += 1
            elif ch == "/" and nxt == "*":
                block_comment = True
                i += 1
            elif ch in "'\"`":
                quote = ch
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    end = i + 1
                    while end < len(s) and s[end] in " \t": end += 1
                    if end < len(s) and s[end] == "\n": end += 1
                    s = s[:match.start()] + s[end:]
                    return
        i += 1
    raise SystemExit(f"unterminated function {name}")

replace_one(
    'import { applyAdvancedConstraint, isAndroid, isIOS } from "../shared/platform.js";',
    'import { isAndroid, isIOS } from "../shared/platform.js";\nimport { applyAdvancedConstraint } from "./camera-constraints.js";',
    "camera constraint import",
)
sub_one(r'import \{\n  ackNativeCameraFrame,[\s\S]*?\} from "\.\./shared/native-camera\.js";\n', '', "legacy native import")
sub_one(r'import \{\n  listNativeCamerasV2,[\s\S]*?\} from "\.\./shared/native-camera-v2\.js";\n', '', "native v2 import")
for line, label in [
    ('const cameraBackendControl = document.getElementById("camera-backend-control");\n', "backend control"),
    ('const cameraBackend = document.getElementById("camera-backend");\n', "backend select"),
    ('const nativePreview = document.getElementById("native-camera-preview");\n', "native preview"),
    ('const nativePreviewCtx = nativePreview?.getContext("2d");\n', "native preview context"),
]:
    replace_one(line, '', label)
sub_one(r'const CAMERA_BACKEND_KEY = "airgapper:apk-camera-backend:v1";[\s\S]*?let nativePreviewImage;\n', '', "native backend state")
for name in [
    "currentNativeTrack", "nativeModeLabel", "nativePreviewRotation", "syncNativePreviewAspect",
    "selectedNativeCamera", "nativeAutoMode", "populateNativeCameraModes", "refreshNativeCameraDevices",
    "stopNativeReceiverSource", "drawNativePreview", "drawNativeV2Preview", "nativeV2PreviewBounds",
    "nativeV2TrackModuleSize", "nativeV2WallMotion", "nativeV2SourceFrame", "submitNativeV2Job",
    "completeNativeV2Job", "startNativeV2Receiver", "startNativeReceiver", "nativeSourceFrame",
]:
    remove_function(name)
replace_one(
    '''  video.hidden = nativeCamera2;\n  if (nativePreview) nativePreview.hidden = !nativeCamera2;\n  if (nativeCamera2) syncNativePreviewAspect();\n  else cameraBox.style.aspectRatio = `${requestedWidth} / ${requestedHeight}`;\n''',
    '''  video.hidden = false;\n  cameraBox.style.aspectRatio = `${requestedWidth} / ${requestedHeight}`;\n''',
    "requested camera UI",
)
sub_one(r'if \(nativeCamera2\) void refreshNativeCameraDevices\(\)\.catch\(\(error\) => \{[\s\S]*?\}\);\n', '', "initial native refresh")
sub_one(r'  if \(nativeCamera2\) \{\n    populateNativeCameraModes\(\);\n    if \(!stream \|\| done\) return;\n    stopReceiver\(\);\n    await start\(\);\n    return;\n  \}\n', '', "native settings restart")
sub_one(r'cameraBackend\?\.addEventListener\("change", \(\) => \{[\s\S]*?\n\}\);\ncameraDevice\?\.addEventListener', 'cameraDevice?.addEventListener', "backend listener")
replace_one(
    '''  if (nativeCamera2) {\n    populateNativeCameraModes();\n  } else if (!preferredCameraDeviceId) automaticCameraDeviceId = learnedAutomaticCameraId();\n''',
    '''  if (!preferredCameraDeviceId) automaticCameraDeviceId = learnedAutomaticCameraId();\n''',
    "camera device native branch",
)
replace_one('if (!nativeCamera2) navigator.mediaDevices?.addEventListener?.("devicechange", () => {', 'navigator.mediaDevices?.addEventListener?.("devicechange", () => {', "devicechange native guard")
sub_one(r'screen\.orientation\?\.addEventListener\?\.\("change", \(\) => \{ if \(nativeCamera2\) \{ syncNativePreviewAspect\(\); queueOverlayDraw\(\); \} \}\);\n', '', "native orientation listener")
s = s.replace('  stopNativeReceiverSource();\n', '')
replace_one('  pool.resize(nativeCamera2 ? 1 : selectedWorkerCount());', '  pool.resize(selectedWorkerCount());', "native worker count")
sub_one(r'  if \(nativeCamera2\) \{\n    await startNativeReceiver\(startAttempt, transportReady\);\n    return;\n  \}\n', '', "native start branch")
replace_one(
    '''  const accepted = nativeCameraV2Running\n    ? submitNativeV2Job(message, sourceSequence, sourceCapturedAt)\n    : preferredWorker === void 0 ? pool.submit(message, transfer) : pool.submitTo(preferredWorker, message, transfer);''',
    '''  const accepted = preferredWorker === void 0\n    ? pool.submit(message, transfer)\n    : pool.submitTo(preferredWorker, message, transfer);''',
    "native submit bridge",
)
replace_one('    settings.pipeline || (nativeCameraRunning ? "camera2" : "browser"),', '    settings.pipeline || "browser",', "camera memory pipeline")
replace_one('  const requestedEpoch = Number(track?.getSettings?.().settingsEpoch) || 0;\n', '', "native settings epoch request")
replace_one('    const epochActive = !nativeCameraRunning || !requestedEpoch || latestNativeSettingsEpoch >= requestedEpoch;\n    if (epochActive && latestSourceFrameSequence >= target) return true;', '    if (latestSourceFrameSequence >= target) return true;', "native settings epoch wait")
replace_one('let latestNativeSettingsEpoch = 0;\n', '', "native settings epoch state")
replace_one('  const vw = nativeCameraRunning ? receiverFrameWidth : video.videoWidth;', '  const vw = video.videoWidth;', "native overlay width")
replace_one('  const vh = nativeCameraRunning ? receiverFrameHeight : video.videoHeight;', '  const vh = video.videoHeight;', "native overlay height")
replace_one('  const rotation = nativeCameraRunning ? nativePreviewRotation() : 0;', '  const rotation = 0;', "native overlay rotation")
sub_one(
    r'  const sourceLine = nativeCameraInfo[\s\S]*?  const cameraLine = \(value\) => \{',
    '''  const sourceLine = sourceSettings ? `${sourceTrack?.label || "camera"} · id ${(sourceSettings.deviceId || "—").slice(0, 8)} · track ${sourceSettings.width ?? "—"}×${sourceSettings.height ?? "—"}@${sourceSettings.frameRate ? Number(sourceSettings.frameRate).toFixed(1) : "—"} · video ${video.videoWidth || "—"}×${video.videoHeight || "—"} · capture ${receiverFrameWidth || "—"}×${receiverFrameHeight || "—"}@${sourceCaptureRate.toFixed(1)} · pump ${pumpDetail} · VideoFrame ${lastVideoFrameInfo ?? "—"}` : "camera inactive";\n  const cameraLine = (value) => {''',
    "native diagnostics source",
)
sub_one(r'  if \(captureNextScan && !pendingScanCapture && source\.nativeV2 && !source\.image\) \{[\s\S]*?\n  \}\n  if \(captureNextScan && !pendingScanCapture && source\.nativeY && !source\.image\) \{[\s\S]*?\n  \}\n  if \(source\.nativeY\) drawNativePreview\(source\);\n', '', "native scan capture blocks")
replace_one('    const directFull = (source.videoFrame || source.nativeY || source.nativeV2) && !source.image', '    const directFull = source.videoFrame && !source.image', "native direct recovery condition")
replace_one('    if ((source.videoFrame || source.nativeY || source.nativeV2) && !source.image) {', '    if (source.videoFrame && !source.image) {', "native direct recovery drop")
replace_one('const laneCount = !source.nativeY && strictHotPathActive() && lockedLayout', 'const laneCount = strictHotPathActive() && lockedLayout', "native lane guard")
replace_one('        const bufferedLatest = !source.nativeY && !source.nativeV2 && !strictHotPathActive() && queuePendingGridLane(0, source, {', '        const bufferedLatest = !strictHotPathActive() && queuePendingGridLane(0, source, {', "native buffered lane guard")
replace_one('    if (source.nativeY || source.nativeV2) break;\n', '', "native lane break")
replace_one('  if (source.nativeV2) return;\n', '', "native optimizer skip")
sub_one(
    r'(function mappedDirectTrackedFrame\(source, x, y, w, h, tracks\) \{\n  //[\s\S]*?\n  if \(tracks\.some\([^\n]+\) return null;\n)[\s\S]*?(  if \(source\.videoFrame\) \{)',
    r'\1\2',
    "native direct frame branches",
)
sub_one(r'\nconst pipelineEvents = \[\];\nconst PIPELINE_EVENT_LIMIT = 80;\nfunction notePipelineEvent\(kind, value = 0\) \{[\s\S]*?\n\}\n', '\n', "pipeline telemetry declaration")
s = s.replace('  pipelineEvents.length = 0;\n', '')
s = re.sub(r'^\s*notePipelineEvent\([^\n;]*\);\s*\n', '', s, flags=re.MULTILINE)
for token in [
    "../shared/native-camera.js", "../shared/native-camera-v2.js", "cameraBackend", "nativeCamera2",
    "nativeCameraRunning", "nativeCameraV2", "nativeV2ActiveJob", "nativeCameraInfo", "nativeCameraCatalog",
    "nativeCameraUnsupportedReason", "nativePreview", "nativeStreamShim", "nativeSourceFrame", "source.nativeY",
    "source.nativeV2", "latestNativeSettingsEpoch", "notePipelineEvent(", "pipelineEvents",
]:
    if token in s:
        raise SystemExit(f"retired runtime token remains: {token}")
p.write_text(s)
# retrigger
