from pathlib import Path


def read(path):
    return Path(path).read_text(encoding="utf-8")


def write(path, text):
    Path(path).write_text(text, encoding="utf-8")


def once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


# MainActivity: instantiate/own the native Camera2 bridge without changing the
# existing WebView/PWA bridge or browser camera permission path.
p = "android/app/src/main/java/com/airgapper/app/MainActivity.java"
s = read(p)
s = once(s,
'''    private WebView webView;\n    private PermissionRequest cameraRequest;''',
'''    private WebView webView;\n    private NativeCameraBridge nativeCameraBridge;\n    private PermissionRequest cameraRequest;''',
"MainActivity field")
s = once(s,
'''        webView.addJavascriptInterface(new AndroidBridge(), "AirGapperAndroid");\n        webView.setWebViewClient(new LocalWebViewClient());''',
'''        webView.addJavascriptInterface(new AndroidBridge(), "AirGapperAndroid");\n        nativeCameraBridge = new NativeCameraBridge(this, webView);\n        webView.setWebViewClient(new LocalWebViewClient());''',
"MainActivity create bridge")
s = once(s,
'''        super.onRequestPermissionsResult(requestCode, permissions, results);\n        if (requestCode != CAMERA_REQUEST) return;''',
'''        super.onRequestPermissionsResult(requestCode, permissions, results);\n        if (nativeCameraBridge != null && nativeCameraBridge.onRequestPermissionsResult(requestCode, results)) return;\n        if (requestCode != CAMERA_REQUEST) return;''',
"MainActivity permission")
s = once(s,
'''    protected void onPause() {\n        webView.evaluateJavascript(''',
'''    protected void onPause() {\n        if (nativeCameraBridge != null) nativeCameraBridge.stop();\n        webView.evaluateJavascript(''',
"MainActivity pause")
s = once(s,
'''    protected void onDestroy() {\n        discardPendingDownload();''',
'''    protected void onDestroy() {\n        if (nativeCameraBridge != null) {\n            nativeCameraBridge.close();\n            nativeCameraBridge = null;\n        }\n        discardPendingDownload();''',
"MainActivity destroy")
write(p, s)


# Native Camera2: do not release the first frame until JS has completed its
# receiver initialization and explicitly grants one frame of credit.
p = "android/app/src/main/java/com/airgapper/app/NativeCameraBridge.java"
s = read(p)
s = s.replace("            frameCredit = true;\n\n            imageReader = ImageReader.newInstance", "            frameCredit = false;\n\n            imageReader = ImageReader.newInstance", 1)
s = s.replace("                        running = true;\n                        frameCredit = true;", "                        running = true;\n                        frameCredit = false;", 1)
write(p, s)


# Web app markup/CSS: native Camera2 uses the same preview card/overlay. The
# canvas is only a low-rate framing preview; decoding still consumes full Y8.
p = "index.html"
s = read(p)
s = s.replace("v0.5.350", "v0.5.351")
s = once(s,
'''            <video id="video" muted playsinline></video><canvas id="detect-overlay" class="detect-overlay" aria-hidden="true"></canvas>''',
'''            <video id="video" muted playsinline></video><canvas id="native-camera-preview" class="native-camera-preview" aria-hidden="true" hidden></canvas><canvas id="detect-overlay" class="detect-overlay" aria-hidden="true"></canvas>''',
"native preview markup")
write(p, s)

p = "shared/style.css"
s = read(p)
s = once(s,
'''.preview video { position: relative; z-index: 0; width: 100%; height: 100%; display: block; object-fit: contain; background: transparent; }\n.detect-overlay''',
'''.preview video, .native-camera-preview { position: relative; z-index: 0; width: 100%; height: 100%; display: block; object-fit: contain; background: transparent; }\n.native-camera-preview { image-rendering: auto; }\n.detect-overlay''',
"native preview style")
write(p, s)


# Worker: an ArrayBuffer in the existing direct-frame field is a native Camera2
# Y plane. It follows the same Y8 decoder path as a copied VideoFrame but skips
# VideoFrame allocationSize/copyTo entirely.
p = "receive/worker.js"
s = read(p)
s = once(s,
'''    const usedDirectFrame = Boolean(ownedVideoFrame);''',
'''    const usedDirectFrame = Boolean(ownedVideoFrame);\n    const usedNativeYBuffer = ownedVideoFrame instanceof ArrayBuffer;''',
"worker native buffer marker")
s = once(s,
'''    if (ownedVideoFrame) {\n      const rect = { x: cropX, y: cropY, width: w, height: h };''',
'''    if (usedNativeYBuffer) {\n      const byteLength = Math.min(\n        ownedVideoFrame.byteLength,\n        payloadBytes || inputOffset + Math.max(0, h - 1) * inputStride + w\n      );\n      pixels = new Uint8Array(ownedVideoFrame, 0, byteLength);\n      ptr = inputBuffer(zx, pixels.byteLength);\n      if (!ptr) throw new Error("Could not allocate WASM native Y input buffer");\n      zx.HEAPU8.set(pixels, ptr);\n      decodePixelFormat = "y8";\n      if (inputStride < w) throw new Error("Native camera Y stride is invalid");\n      ownedVideoFrame = null;\n    } else if (ownedVideoFrame) {\n      const rect = { x: cropX, y: cropY, width: w, height: h };''',
"worker native direct branch")
write(p, s)


# Receiver imports/state.
p = "receive/main.js"
s = read(p)
s = s.replace('const RECEIVER_RUNTIME_BUILD = "v0.5.350";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.351";', 1)
s = once(s,
'''import { readStoredZip } from "../shared/zip.js";''',
'''import { readStoredZip } from "../shared/zip.js";\nimport {\n  ackNativeCameraFrame,\n  listNativeCameras,\n  nativeCameraAvailable,\n  setNativeCameraFrameHandler,\n  startNativeCamera,\n  stopNativeCamera\n} from "../shared/native-camera.js";''',
"native camera import")
s = once(s,
'''const video = document.getElementById("video");\nconst preview = document.getElementById("preview");''',
'''const video = document.getElementById("video");\nconst nativePreview = document.getElementById("native-camera-preview");\nconst nativePreviewCtx = nativePreview?.getContext("2d");\nconst preview = document.getElementById("preview");''',
"native preview elements")
s = once(s,
'''let requestedWidth = 1280;\nlet requestedHeight = 720;\nlet requestedFps = 60;''',
'''let requestedWidth = 1280;\nlet requestedHeight = 720;\nlet requestedFps = 60;\nconst nativeCamera2 = isAndroidApp() && nativeCameraAvailable();\nconst nativeStreamShim = Object.freeze({\n  __airgapperNativeCamera: true,\n  getTracks: () => [],\n  getVideoTracks: () => []\n});\nlet nativeCameraCatalog;\nlet nativeCameraInfo;\nlet nativeCameraRunning = false;\nlet nativeCameraUnsupportedReason = "";\nlet nativePreviewLastAt = -Infinity;''',
"native state")

# Native Camera2 catalog shares the existing Camera/Mode controls. Keep the
# browser mode implementation intact for the website/PWA.
anchor = '''function browserModeSuffix(key) {\n  return browserModeResults[key] === true ? "" : browserModeResults[key] === false ? " · Retry" : " · Try";\n}\n'''
insert = anchor + '''function nativeModeLabel(mode) {\n  if (mode.fixedFps) return formatCameraMode(mode.width, mode.height, mode.fps);\n  return `${mode.width}×${mode.height} · ${mode.fps} fps target · AE ${mode.fpsMin}–${mode.fpsMax}`;\n}\nfunction selectedNativeCamera() {\n  const cameras = nativeCameraCatalog?.cameras ?? [];\n  if (preferredCameraDeviceId) {\n    const explicit = cameras.find((camera) => camera.id === preferredCameraDeviceId);\n    if (explicit) return explicit;\n  }\n  return cameras.find((camera) => camera.facing === "rear" && camera.modes?.length)\n    ?? cameras.find((camera) => camera.modes?.length)\n    ?? cameras[0];\n}\nfunction nativeAutoMode(camera) {\n  const modes = camera?.modes ?? [];\n  const exact = (width, height, fps) => modes.find((mode) =>\n    mode.width === width && mode.height === height && mode.fps === fps && mode.fixedFps);\n  return exact(1280, 720, 60)\n    ?? exact(1920, 1080, 60)\n    ?? modes.find((mode) => mode.fps === 60 && mode.fixedFps)\n    ?? modes.find((mode) => mode.fps === 60)\n    ?? exact(1280, 720, 30)\n    ?? modes[modes.length - 1];\n}\nfunction populateNativeCameraModes() {\n  if (!nativeCamera2 || !nativeCameraCatalog) return;\n  const camera = selectedNativeCamera();\n  const prior = cameraResolution.value;\n  browserModes = (camera?.modes ?? []).map((mode) => ({ ...mode, label: nativeModeLabel(mode) }))\n    .sort((a, b) => a.width - b.width || a.height - b.height || a.fps - b.fps);\n  cameraResolution.replaceChildren(\n    new Option("Auto", "auto"),\n    ...browserModes.map((mode) => new Option(mode.label, mode.key))\n  );\n  cameraResolution.value = browserModes.some((mode) => mode.key === prior) ? prior : "auto";\n  const automatic = nativeAutoMode(camera);\n  const selected = browserModes.find((mode) => mode.key === cameraResolution.value) ?? automatic;\n  if (selected) {\n    requestedWidth = selected.width;\n    requestedHeight = selected.height;\n    requestedFps = selected.fps;\n  }\n  cameraResolutionLabel.textContent = "Mode";\n  cameraExposureControl.hidden = true;\n  cameraOpticsManual.hidden = true;\n  opticsAutoActions.hidden = true;\n  cameraBox.style.aspectRatio = `${requestedWidth} / ${requestedHeight}`;\n}\nasync function refreshNativeCameraDevices() {\n  if (!nativeCamera2) return false;\n  const catalog = await listNativeCameras();\n  if (!catalog.supported) {\n    nativeCameraUnsupportedReason = catalog.reason || "Native Camera2 binary bridge unavailable";\n    nativeCameraCatalog = catalog;\n    return false;\n  }\n  nativeCameraUnsupportedReason = "";\n  nativeCameraCatalog = catalog;\n  const cameras = catalog.cameras ?? [];\n  const options = [new Option("Rear camera (auto)", "")];\n  for (const camera of cameras) options.push(new Option(camera.label || `Camera ${camera.id}`, camera.id));\n  cameraDevice.replaceChildren(...options);\n  if (preferredCameraDeviceId && cameras.some((camera) => camera.id === preferredCameraDeviceId)) {\n    cameraDevice.value = preferredCameraDeviceId;\n  } else {\n    preferredCameraDeviceId = "";\n    cameraDevice.value = "";\n  }\n  cameraDevice.disabled = cameras.length <= 1;\n  populateNativeCameraModes();\n  return true;\n}\n'''
s = once(s, anchor, insert, "native mode helpers")

# Initialization keeps synchronous browser defaults, then replaces them with
# the real Camera2 catalog as soon as the native bridge responds.
s = once(s,
'''populateCameraOptions();\nrestoreCameraSettings();\nshowRequestedCameraSettings();''',
'''populateCameraOptions();\nrestoreCameraSettings();\nshowRequestedCameraSettings();\nif (nativeCamera2) void refreshNativeCameraDevices().catch((error) => {\n  nativeCameraUnsupportedReason = error instanceof Error ? error.message : String(error);\n});''',
"native catalog initialization")

# Preview visibility/settings.
s = once(s,
'''  decodeWorkersControl.hidden = legacyAndroidApp;\n  video.hidden = false;\n  cameraBox.style.aspectRatio = `${requestedWidth} / ${requestedHeight}`;''',
'''  decodeWorkersControl.hidden = legacyAndroidApp;\n  video.hidden = nativeCamera2;\n  if (nativePreview) nativePreview.hidden = !nativeCamera2;\n  cameraBox.style.aspectRatio = `${requestedWidth} / ${requestedHeight}`;''',
"show native preview")

# Native mode changes reopen Camera2 instead of asking MediaStreamTrack for
# constraints. Browser/PWA behavior below is unchanged.
s = once(s,
'''const changeCameraSettings = async () => {\n  var _a, _b;\n  showRequestedCameraSettings();\n  saveCameraSettings();\n  const track = stream == null ? void 0 : stream.getVideoTracks()[0];''',
'''const changeCameraSettings = async () => {\n  var _a, _b;\n  showRequestedCameraSettings();\n  saveCameraSettings();\n  if (nativeCamera2) {\n    populateNativeCameraModes();\n    if (!stream || done) return;\n    stopReceiver();\n    await start();\n    return;\n  }\n  const track = stream == null ? void 0 : stream.getVideoTracks()[0];''',
"native mode change")
s = once(s,
'''cameraDevice?.addEventListener("change", () => {\n  preferredCameraDeviceId = cameraDevice.value;\n  automaticCameraUpgradeAttempted = false;\n  if (!preferredCameraDeviceId) automaticCameraDeviceId = learnedAutomaticCameraId();\n  saveCameraSettings();''',
'''cameraDevice?.addEventListener("change", () => {\n  preferredCameraDeviceId = cameraDevice.value;\n  automaticCameraUpgradeAttempted = false;\n  if (nativeCamera2) {\n    populateNativeCameraModes();\n  } else if (!preferredCameraDeviceId) automaticCameraDeviceId = learnedAutomaticCameraId();\n  saveCameraSettings();''',
"native camera change")
s = once(s,
'''navigator.mediaDevices?.addEventListener?.("devicechange", () => {\n  void refreshCameraDevices(stream?.getVideoTracks()[0]);\n});''',
'''if (!nativeCamera2) navigator.mediaDevices?.addEventListener?.("devicechange", () => {\n  void refreshCameraDevices(stream?.getVideoTracks()[0]);\n});''',
"browser devicechange only")

# Native source lifecycle and framing preview.
insert_before_status = '''const { setStatus, showError } = statusLine(stats);'''
native_lifecycle = '''function stopNativeReceiverSource() {\n  if (!nativeCamera2) return;\n  nativeCameraRunning = false;\n  nativeCameraInfo = void 0;\n  setNativeCameraFrameHandler();\n  void stopNativeCamera();\n  if (nativePreview) {\n    nativePreview.hidden = true;\n    nativePreview.width = 0;\n    nativePreview.height = 0;\n  }\n}\nfunction drawNativePreview(source) {\n  if (!nativePreviewCtx || !source.nativeY || !source.width || !source.height) return;\n  const now = performance.now();\n  if (now - nativePreviewLastAt < 80) return;\n  nativePreviewLastAt = now;\n  const outWidth = Math.min(480, source.width);\n  const outHeight = Math.max(1, Math.round(source.height * outWidth / source.width));\n  if (nativePreview.width !== outWidth || nativePreview.height !== outHeight) {\n    nativePreview.width = outWidth;\n    nativePreview.height = outHeight;\n  }\n  const rgba = nativePreviewCtx.createImageData(outWidth, outHeight);\n  const sx = source.width / outWidth;\n  const sy = source.height / outHeight;\n  for (let y = 0; y < outHeight; y++) {\n    const sourceRow = Math.min(source.height - 1, Math.floor((y + 0.5) * sy)) * source.width;\n    for (let x = 0; x < outWidth; x++) {\n      const luma = source.nativeY[sourceRow + Math.min(source.width - 1, Math.floor((x + 0.5) * sx))];\n      const at = (y * outWidth + x) * 4;\n      rgba.data[at] = luma;\n      rgba.data[at + 1] = luma;\n      rgba.data[at + 2] = luma;\n      rgba.data[at + 3] = 255;\n    }\n  }\n  nativePreviewCtx.putImageData(rgba, 0, 0);\n}\nfunction nativeSourceFrame(buffer, width, height, gen) {\n  if (!nativeCameraRunning || done || gen !== captureGen) {\n    ackNativeCameraFrame();\n    return;\n  }\n  const callbackTime = performance.now();\n  const sequence = benchmarkRecordingSequence++;\n  latestSourceFrameSequence = sequence;\n  if (!framePumpFirstFrameAt) framePumpFirstFrameAt = receiverNow();\n  framePumpProcessorTotal++;\n  processSourceFrame({\n    sequence,\n    opticsEpoch: void 0,\n    width,\n    height,\n    callbackTimeMs: callbackTime,\n    mediaTimeMs: callbackTime,\n    presentationTimeMs: callbackTime,\n    expectedDisplayTimeMs: callbackTime,\n    nativeY: new Uint8Array(buffer),\n    nativeBuffer: buffer,\n    nativeAck: ackNativeCameraFrame\n  }, gen);\n}\nasync function startNativeReceiver(startAttempt, transportReady) {\n  let catalogReady = Boolean(nativeCameraCatalog?.supported);\n  if (!catalogReady) {\n    try {\n      catalogReady = await refreshNativeCameraDevices();\n    } catch (error) {\n      nativeCameraUnsupportedReason = error instanceof Error ? error.message : String(error);\n    }\n  }\n  if (startAttempt !== cameraStartGen || receiverPaused) return;\n  if (!catalogReady) {\n    pool.resize(0);\n    offerRetry(`Native Camera2: ${nativeCameraUnsupportedReason || "camera bridge unavailable"}`);\n    return;\n  }\n  const camera = selectedNativeCamera();\n  const selectedMode = browserModes.find((mode) => mode.key === cameraResolution.value) ?? nativeAutoMode(camera);\n  if (!camera || !selectedMode) {\n    pool.resize(0);\n    offerRetry("Native Camera2: no supported YUV camera mode found");\n    return;\n  }\n  requestedWidth = selectedMode.width;\n  requestedHeight = selectedMode.height;\n  requestedFps = selectedMode.fps;\n  cameraBox.style.aspectRatio = `${requestedWidth} / ${requestedHeight}`;\n  cameraActual.textContent = `${nativeModeLabel(selectedMode)} · Camera2`;\n  startBtn.disabled = true;\n  startBtn.style.display = "none";\n  video.srcObject = null;\n  video.hidden = true;\n  if (nativePreview) nativePreview.hidden = false;\n\n  const futureGen = captureGen + 1;\n  setNativeCameraFrameHandler((buffer) => nativeSourceFrame(buffer, requestedWidth, requestedHeight, futureGen));\n  let started;\n  let transportError;\n  try {\n    [started, transportError] = await Promise.all([\n      startNativeCamera({\n        cameraId: camera.id,\n        width: requestedWidth,\n        height: requestedHeight,\n        fps: requestedFps\n      }),\n      transportReady\n    ]);\n  } catch (error) {\n    setNativeCameraFrameHandler();\n    void stopNativeCamera();\n    if (startAttempt === cameraStartGen) pool.resize(0);\n    offerRetry(`Native Camera2: ${error instanceof Error ? error.message : String(error)}`);\n    return;\n  }\n  if (transportError) {\n    setNativeCameraFrameHandler();\n    void stopNativeCamera();\n    if (startAttempt === cameraStartGen) pool.resize(0);\n    offerRetry(`Transport: ${transportError instanceof Error ? transportError.message : String(transportError)}`);\n    return;\n  }\n  if (startAttempt !== cameraStartGen || receiverPaused) {\n    setNativeCameraFrameHandler();\n    void stopNativeCamera();\n    return;\n  }\n\n  stream = nativeStreamShim;\n  nativeCameraRunning = true;\n  nativeCameraInfo = started;\n  preview.classList.remove("camera-loading");\n  setStatus("");\n  cameraStartedTs = receiverNow();\n  resetLivePipeline(cameraStartedTs);\n  captureGen = futureGen;\n  framePumpMode = "Camera2 Y8";\n  framePumpStartedAt = receiverNow();\n  framePumpFirstFrameAt = 0;\n  framePumpProcessorTotal = 0;\n  framePumpProcessorDiscarded = 0;\n  statsTimer = setInterval(updateStats, STATS_TICK_MS);\n  ackNativeCameraFrame();\n  await requestScreenWakeLock();\n}\n'''
s = once(s, insert_before_status, native_lifecycle + insert_before_status, "native lifecycle")

# Stop/pause native source alongside browser source.
s = once(s,
'''  stopFramePump();\n  stream == null ? void 0 : stream.getTracks().forEach((track) => track.stop());''',
'''  stopFramePump();\n  stopNativeReceiverSource();\n  stream == null ? void 0 : stream.getTracks().forEach((track) => track.stop());''',
"stop native source")
s = once(s,
'''  stopFramePump();\n  stream == null ? void 0 : stream.getTracks().forEach((track) => track.stop());\n  stream = null;\n  video.srcObject = null;\n  clearInterval(statsTimer);''',
'''  stopFramePump();\n  stopNativeReceiverSource();\n  stream == null ? void 0 : stream.getTracks().forEach((track) => track.stop());\n  stream = null;\n  video.srcObject = null;\n  clearInterval(statsTimer);''',
"pause native source")

# Native branch of start() is before browser getUserMedia capability checks.
s = once(s,
'''  showRequestedCameraSettings();\n  if (!((_a = navigator.mediaDevices) == null ? void 0 : _a.getUserMedia)) {''',
'''  showRequestedCameraSettings();\n  if (nativeCamera2) {\n    await startNativeReceiver(startAttempt, transportReady);\n    return;\n  }\n  if (!((_a = navigator.mediaDevices) == null ? void 0 : _a.getUserMedia)) {''',
"native start branch")

# Exactly-once release: native Camera2 credit is returned when a source frame is
# scheduled/dropped, analogous to closing a TrackProcessor VideoFrame.
s = once(s,
'''function processSourceFrame(frame, gen) {\n  if (done || gen !== captureGen) {\n    frame.videoFrame?.close();\n    return;\n  }''',
'''function releaseSourceFrame(frame) {\n  frame.videoFrame?.close();\n  if (frame.nativeAck) {\n    const ack = frame.nativeAck;\n    frame.nativeAck = void 0;\n    ack();\n  }\n}\nfunction processSourceFrame(frame, gen) {\n  if (done || gen !== captureGen) {\n    releaseSourceFrame(frame);\n    return;\n  }''',
"release native source")
s = s.replace("      frame.videoFrame?.close();\n      return;", "      releaseSourceFrame(frame);\n      return;", 1)
s = s.replace("    frame.videoFrame?.close();\n    queueOverlayDraw();", "    releaseSourceFrame(frame);\n    queueOverlayDraw();", 1)
s = s.replace("    frame.videoFrame?.close();\n    if (done || gen !== captureGen) return;", "    releaseSourceFrame(frame);\n    if (done || gen !== captureGen) return;", 1)

# Native debug scan and low-rate preview happen before the ArrayBuffer is
# transferred/detached into a worker.
s = once(s,
'''  if (captureNextScan && !pendingScanCapture && source.videoFrame && !source.image) await captureDirectSourceScan(source);\n  const now = receiverNow();\n  void maintainManualOptics(now);\n  maintainAcquisitionAutofocus(now);\n  maintainAutomaticQrOptics(now);''',
'''  if (captureNextScan && !pendingScanCapture && source.videoFrame && !source.image) await captureDirectSourceScan(source);\n  if (captureNextScan && !pendingScanCapture && source.nativeY && !source.image) {\n    pendingScanCapture = {\n      image: yToImageData(source.nativeY.slice(), source.width, source.height),\n      ox: 0, oy: 0, full: !gridLattice.locked,\n      tracks: gridLattice.locked ? regions.filter((region) => validQuadObject(region.quad)).map((region) => region.quad) : [],\n      scaleX: 1, scaleY: 1, rawY: true\n    };\n    scanDialogStatus.textContent = `Captured exact native Camera2 Y frame ${source.width}×${source.height} · waiting for decoder…`;\n  }\n  if (source.nativeY) drawNativePreview(source);\n  const now = receiverNow();\n  if (!source.nativeY) {\n    void maintainManualOptics(now);\n    maintainAcquisitionAutofocus(now);\n    maintainAutomaticQrOptics(now);\n  }''',
"native capture entry")

# Native Y can be materialized to RGBA only for rare debug/preview helpers. It
# is never used for production decoding.
s = once(s,
'''    if (source.image) {\n      if (replaySourceCanvas.width !== source.width || replaySourceCanvas.height !== source.height) {''',
'''    if (source.nativeY) {\n      const crop = new Uint8ClampedArray((right - sx) * (bottom - sy) * 4);\n      let out = 0;\n      for (let row = sy; row < bottom; row++) {\n        const rowBase = row * source.width;\n        for (let col = sx; col < right; col++) {\n          const luma = source.nativeY[rowBase + col];\n          crop[out++] = luma; crop[out++] = luma; crop[out++] = luma; crop[out++] = 255;\n        }\n      }\n      const cropCanvas = document.createElement("canvas");\n      cropCanvas.width = right - sx;\n      cropCanvas.height = bottom - sy;\n      cropCanvas.getContext("2d").putImageData(new ImageData(crop, cropCanvas.width, cropCanvas.height), 0, 0);\n      ctx.drawImage(cropCanvas, sx - x, sy - y);\n    } else if (source.image) {\n      if (replaySourceCanvas.width !== source.width || replaySourceCanvas.height !== source.height) {''',
"native bounded crop")

# Native ArrayBuffer direct frame mapping. No crop copy: worker receives the
# entire tight Y plane plus offset/stride describing the useful crop.
s = once(s,
'''function mappedDirectTrackedFrame(source, x, y, w, h, tracks) {\n  // A lattice slot may lose its quad before the surrounding scheduler has\n  // finished retiring that slot. Missing geometry is a normal erasure during\n  // target loss, never a reason to throw from the camera loop.\n  if (tracks.some((track) => !track || !validQuadObject(track.quad) || !track.dim)) return null;''',
'''function mappedDirectTrackedFrame(source, x, y, w, h, tracks) {\n  // A lattice slot may lose its quad before the surrounding scheduler has\n  // finished retiring that slot. Missing geometry is a normal erasure during\n  // target loss, never a reason to throw from the camera loop.\n  if (tracks.some((track) => !track || !validQuadObject(track.quad) || !track.dim)) return null;\n  if (source.nativeY && source.nativeBuffer instanceof ArrayBuffer && source.nativeBuffer.byteLength) {\n    const cropX = Math.max(0, Math.min(source.width, Math.floor(x)));\n    const cropY = Math.max(0, Math.min(source.height, Math.floor(y)));\n    const cropRight = Math.max(cropX, Math.min(source.width, Math.ceil(x + w)));\n    const cropBottom = Math.max(cropY, Math.min(source.height, Math.ceil(y + h)));\n    const cropWidth = cropRight - cropX;\n    const cropHeight = cropBottom - cropY;\n    if (cropWidth < 2 || cropHeight < 2) return null;\n    return {\n      frame: source.nativeBuffer,\n      cropX: 0, cropY: 0,\n      w: cropWidth, h: cropHeight,\n      ox: cropX, oy: cropY,\n      tracks,\n      pixelFormat: "y8",\n      yOffset: cropY * source.width + cropX,\n      yStride: source.width,\n      payloadBytes: source.nativeBuffer.byteLength\n    };\n  }''',
"native mapped direct")

# Acquisition/recovery recognizes native Y as a direct camera source.
s = once(s,
'''    const directFull = source.videoFrame && !source.image\n      ? mappedDirectTrackedFrame(source, scanX, scanY, scanW, scanH, recoveryTracks)\n      : null;''',
'''    const directFull = (source.videoFrame || source.nativeY) && !source.image\n      ? mappedDirectTrackedFrame(source, scanX, scanY, scanW, scanH, recoveryTracks)\n      : null;''',
"native direct recovery")
s = once(s,
'''          pixelFormat: "y8",\n          outputMap: directFull.outputMap,\n          tracks: directFull.tracks,''',
'''          pixelFormat: "y8",\n          yOffset: directFull.yOffset,\n          yStride: directFull.yStride,\n          payloadBytes: directFull.payloadBytes,\n          outputMap: directFull.outputMap,\n          tracks: directFull.tracks,''',
"native recovery metadata")
s = once(s,
'''      )) directFull.frame.close();''',
'''      )) directFull.frame.close?.();''',
"native recovery close")
s = once(s,
'''    if (source.videoFrame && !source.image) {\n      notePipelineEvent("direct-recovery-y8-unavailable");''',
'''    if ((source.videoFrame || source.nativeY) && !source.image) {\n      notePipelineEvent("direct-recovery-y8-unavailable");''',
"native recovery fallback fence")

# Strict-mode spatial lanes would try to transfer the same native ArrayBuffer
# more than once. Native Camera2 stays one job per physical camera frame.
s = once(s,
'''const laneCount = strictHotPathActive() && lockedLayout''',
'''const laneCount = !source.nativeY && strictHotPathActive() && lockedLayout''',
"native single lane")

# Shared production tracked job forwards native Y offset/stride into worker.
s = once(s,
'''          ? { id: id2, videoFrame: sharedDirect.frame, cropX: sharedDirect.cropX, cropY: sharedDirect.cropY, w: sharedDirect.w, h: sharedDirect.h, ox: sharedDirect.ox, oy: sharedDirect.oy, full: false, tracks: sharedDirect.tracks, pixelFormat: sharedDirect.pixelFormat, outputMap: sharedDirect.outputMap, strictHotPath: strictHotPathActive() }''',
'''          ? { id: id2, videoFrame: sharedDirect.frame, cropX: sharedDirect.cropX, cropY: sharedDirect.cropY, w: sharedDirect.w, h: sharedDirect.h, ox: sharedDirect.ox, oy: sharedDirect.oy, full: false, tracks: sharedDirect.tracks, pixelFormat: sharedDirect.pixelFormat, yOffset: sharedDirect.yOffset, yStride: sharedDirect.yStride, payloadBytes: sharedDirect.payloadBytes, outputMap: sharedDirect.outputMap, strictHotPath: strictHotPathActive() }''',
"native shared metadata")
s = s.replace("          sharedDirect?.frame.close();", "          sharedDirect?.frame.close?.();", 1)

# Never buffer a native frame waiting for workers: Camera2 credit backpressure
# already guarantees the next delivered frame is the freshest one.
s = once(s,
'''        const bufferedLatest = !strictHotPathActive() && queuePendingGridLane(0, source, {''',
'''        const bufferedLatest = !source.nativeY && !strictHotPathActive() && queuePendingGridLane(0, source, {''',
"no native pending lane")

# Individual path also forwards native Y metadata and stops after one successful
# job because transferring the ArrayBuffer detaches it.
s = once(s,
'''      ? { id, videoFrame: direct.frame, cropX: direct.cropX, cropY: direct.cropY, w: direct.w, h: direct.h, ox: direct.ox, oy: direct.oy, full: false, tracks: direct.tracks, pixelFormat: "y8", outputMap: direct.outputMap, strictHotPath: strictHotPathActive() }''',
'''      ? { id, videoFrame: direct.frame, cropX: direct.cropX, cropY: direct.cropY, w: direct.w, h: direct.h, ox: direct.ox, oy: direct.oy, full: false, tracks: direct.tracks, pixelFormat: "y8", yOffset: direct.yOffset, yStride: direct.yStride, payloadBytes: direct.payloadBytes, outputMap: direct.outputMap, strictHotPath: strictHotPathActive() }''',
"native individual metadata")
s = s.replace("      direct?.frame.close();", "      direct?.frame.close?.();", 1)
s = once(s,
'''    submitted = true;\n  }\n  if (!submitted && scheduledRegions.length > 0) {''',
'''    submitted = true;\n    if (source.nativeY) break;\n  }\n  if (!submitted && scheduledRegions.length > 0) {''',
"native one individual job")

# Native overlay uses source dimensions rather than HTMLVideoElement metadata.
s = once(s,
'''  const vw = video.videoWidth;\n  const vh = video.videoHeight;\n  if (!cw || !ch || !vw || !vh) return;''',
'''  const vw = nativeCameraRunning ? receiverFrameWidth : video.videoWidth;\n  const vh = nativeCameraRunning ? receiverFrameHeight : video.videoHeight;\n  if (!cw || !ch || !vw || !vh) return;''',
"native overlay dimensions")

# Diagnostics clearly state Camera2, target AE range and measured delivery FPS.
s = once(s,
'''  const sourceLine = sourceSettings ? `${sourceTrack?.label || "camera"} · id ${(sourceSettings.deviceId || "—").slice(0, 8)} · track ${sourceSettings.width ?? "—"}×${sourceSettings.height ?? "—"}@${sourceSettings.frameRate ? Number(sourceSettings.frameRate).toFixed(1) : "—"} · video ${video.videoWidth || "—"}×${video.videoHeight || "—"} · capture ${receiverFrameWidth || "—"}×${receiverFrameHeight || "—"}@${sourceCaptureRate.toFixed(1)} · pump ${pumpDetail} · VideoFrame ${lastVideoFrameInfo ?? "—"}` : "camera inactive";''',
'''  const sourceLine = nativeCameraInfo\n    ? `Camera2 ${nativeCameraInfo.cameraId} · YUV ${nativeCameraInfo.width}×${nativeCameraInfo.height} · target ${nativeCameraInfo.fps} fps · AE ${nativeCameraInfo.fpsMin}–${nativeCameraInfo.fpsMax}${nativeCameraInfo.fixedFps ? " fixed" : " variable"} · capture ${receiverFrameWidth || "—"}×${receiverFrameHeight || "—"}@${sourceCaptureRate.toFixed(1)} · pump Camera2 Y8 · sensor ${nativeCameraInfo.sensorOrientation ?? "—"}°`\n    : sourceSettings ? `${sourceTrack?.label || "camera"} · id ${(sourceSettings.deviceId || "—").slice(0, 8)} · track ${sourceSettings.width ?? "—"}×${sourceSettings.height ?? "—"}@${sourceSettings.frameRate ? Number(sourceSettings.frameRate).toFixed(1) : "—"} · video ${video.videoWidth || "—"}×${video.videoHeight || "—"} · capture ${receiverFrameWidth || "—"}×${receiverFrameHeight || "—"}@${sourceCaptureRate.toFixed(1)} · pump ${pumpDetail} · VideoFrame ${lastVideoFrameInfo ?? "—"}` : "camera inactive";''',
"native source diagnostics")
write(p, s)


# Version/cache/publisher bumps. Android Gradle was already changed to 351.
for p in ["main.js", "send/main.js", "sw.js", ".github/workflows/build-apk.yml"]:
    s = read(p)
    if "v0.5.350" in s:
        s = s.replace("v0.5.350", "v0.5.351")
    if p == ".github/workflows/build-apk.yml":
        s = s.replace("AirGapper-v0.5.350", "AirGapper-v0.5.351")
        s = s.replace("build AirGapper.apk v0.5.350", "build AirGapper.apk v0.5.351")
    write(p, s)

print("native Camera2 patch applied")
