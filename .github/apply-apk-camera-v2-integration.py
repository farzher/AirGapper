from pathlib import Path


def text(path):
    return Path(path).read_text(encoding="utf-8")


def write(path, value):
    Path(path).write_text(value, encoding="utf-8")


def replace_once(path, old, new):
    value = text(path)
    count = value.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one match, found {count}: {old[:120]!r}")
    write(path, value.replace(old, new, 1))


def replace_all(path, old, new, minimum=1):
    value = text(path)
    count = value.count(old)
    if count < minimum:
        raise SystemExit(f"{path}: expected at least {minimum} matches, found {count}: {old!r}")
    write(path, value.replace(old, new))


# ---------------------------------------------------------------------------
# Android native build: compile the exact AirGapper QR core under the NDK.
# ---------------------------------------------------------------------------
replace_once(
    "android/app/src/main/cpp/CMakeLists.txt",
    'set(ZXING_EXPERIMENTAL_API OFF CACHE BOOL "" FORCE)\nset(ZXING_EXPERIMENTAL_API OFF CACHE BOOL "" FORCE)\nset(ZXING_READERS_QR_CODE ON CACHE BOOL "" FORCE)\nset(ZXING_READERS_AZTEC OFF CACHE BOOL "" FORCE)\nset(ZXING_READERS_DATA_MATRIX OFF CACHE BOOL "" FORCE)\nset(ZXING_READERS_MAXICODE OFF CACHE BOOL "" FORCE)\nset(ZXING_READERS_PDF417 OFF CACHE BOOL "" FORCE)\nset(ZXING_READERS_MICRO_QR_CODE OFF CACHE BOOL "" FORCE)\nset(ZXING_READERS_RMQR_CODE OFF CACHE BOOL "" FORCE)\nset(ZXING_READERS_ONE_D OFF CACHE BOOL "" FORCE)\n',
    'set(ZXING_EXPERIMENTAL_API OFF CACHE BOOL "" FORCE)\nset(ZXING_ENABLE_1D OFF CACHE BOOL "" FORCE)\nset(ZXING_ENABLE_AZTEC OFF CACHE BOOL "" FORCE)\nset(ZXING_ENABLE_DATAMATRIX OFF CACHE BOOL "" FORCE)\nset(ZXING_ENABLE_MAXICODE OFF CACHE BOOL "" FORCE)\nset(ZXING_ENABLE_PDF417 OFF CACHE BOOL "" FORCE)\nset(ZXING_ENABLE_QRCODE ON CACHE BOOL "" FORCE)\n'
)
replace_once(
    "android/app/src/main/cpp/CMakeLists.txt",
    'target_include_directories(airgapper_native PRIVATE\n    "${AIRGAPPER_CODEC_DIR}"\n    "${zxing_SOURCE_DIR}/core/src"\n)\n',
    'target_include_directories(airgapper_native PRIVATE\n    "${CMAKE_CURRENT_LIST_DIR}"\n    "${AIRGAPPER_CODEC_DIR}"\n    "${zxing_SOURCE_DIR}/core/src"\n)\n'
)
replace_once(
    "android/app/src/main/cpp/CMakeLists.txt",
    'target_compile_options(airgapper_native PRIVATE -O3 -ffast-math)\n',
    'target_compile_options(airgapper_native PRIVATE -O3)\n'
)

# ---------------------------------------------------------------------------
# GLES PRIVATE reader: v2 consumes the reusable direct R8 buffer synchronously
# instead of copying a full frame into a Java byte[]. Legacy users keep the
# byte[] callback through default interface methods.
# ---------------------------------------------------------------------------
replace_once(
    "android/app/src/main/java/com/airgapper/app/NativeGpuCameraReader.java",
    '    interface Sink {\n        boolean takeFrameCredit();\n        void onFrame(byte[] bytes, long timestampNs);\n        void onError(String message);\n    }\n',
    '    interface Sink {\n        boolean takeFrameCredit();\n        default boolean directFrame() { return false; }\n        default void onDirectFrame(ByteBuffer bytes, long timestampNs) {}\n        void onFrame(byte[] bytes, long timestampNs);\n        void onError(String message);\n    }\n'
)
replace_once(
    "android/app/src/main/java/com/airgapper/app/NativeGpuCameraReader.java",
    '            readback.clear();\n            GLES30.glReadPixels(0, 0, width, height, GLES30.GL_RED, GLES20.GL_UNSIGNED_BYTE, readback);\n            readback.position(0);\n            readback.get(output, outputOffset, width * height);\n            sink.onFrame(output, timestampNs);\n',
    '            readback.clear();\n            GLES30.glReadPixels(0, 0, width, height, GLES30.GL_RED, GLES20.GL_UNSIGNED_BYTE, readback);\n            readback.position(0);\n            if (sink.directFrame()) {\n                // The v2 decoder consumes this reusable direct buffer before we\n                // return to the camera loop. No full-resolution Java/WebView copy.\n                sink.onDirectFrame(readback, timestampNs);\n            } else {\n                readback.get(output, outputOffset, width * height);\n                sink.onFrame(output, timestampNs);\n            }\n'
)

# ---------------------------------------------------------------------------
# Camera2 v2: publish a lightweight sensor tick at the requested decode rate.
# JS schedules policy from these timestamps; pixel ownership stays native.
# ---------------------------------------------------------------------------
replace_once(
    "android/app/src/main/java/com/airgapper/app/NativeCameraV2Bridge.java",
    '    private long lastSensorTimestampNs;\n    private double measuredFrameDurationNs;\n',
    '    private long lastSensorTimestampNs;\n    private long lastFrameEventTimestampNs;\n    private double measuredFrameDurationNs;\n'
)
replace_once(
    "android/app/src/main/java/com/airgapper/app/NativeCameraV2Bridge.java",
    '            lastSensorTimestampNs = 0;\n            measuredFrameDurationNs = 0;\n',
    '            lastSensorTimestampNs = 0;\n            lastFrameEventTimestampNs = 0;\n            measuredFrameDurationNs = 0;\n'
)
replace_once(
    "android/app/src/main/java/com/airgapper/app/NativeCameraV2Bridge.java",
    '                synchronized (metadataByTimestamp) { metadataByTimestamp.put(timestamp, metadata); }\n            }\n',
    '                synchronized (metadataByTimestamp) { metadataByTimestamp.put(timestamp, metadata); }\n                maybePostFrameEvent(metadata);\n            }\n'
)
replace_once(
    "android/app/src/main/java/com/airgapper/app/NativeCameraV2Bridge.java",
    '    private void onImageAvailable(ImageReader reader, long generation) {\n',
    '''    private void maybePostFrameEvent(FrameMetadata metadata) {\n        if (!running || metadata == null || metadata.timestampNs <= 0) return;\n        long interval = Math.max(1L, Math.round(1_000_000_000.0 / Math.max(1, activeDecodeFps)));\n        if (lastFrameEventTimestampNs > 0 &&\n                metadata.timestampNs - lastFrameEventTimestampNs < Math.round(interval * 0.80)) return;\n        lastFrameEventTimestampNs = metadata.timestampNs;\n        try {\n            JSONObject event = new JSONObject();\n            event.put("event", "frame");\n            event.put("width", activeWidth); event.put("height", activeHeight);\n            event.put("frameNumber", metadata.frameNumber);\n            event.put("timestampNs", metadata.timestampNs);\n            event.put("exposureTimeNs", metadata.exposureNs);\n            event.put("frameDurationNs", metadata.frameDurationNs);\n            event.put("rollingShutterSkewNs", metadata.rollingShutterSkewNs);\n            if (Float.isFinite(metadata.focusDistance)) event.put("focusDistance", metadata.focusDistance);\n            event.put("iso", metadata.iso);\n            event.put("settingsEpoch", metadata.settingsEpoch);\n            event.put("orientation", activeSensorOrientation);\n            event.put("sensorFps", activeSensorFps);\n            event.put("measuredFps", measuredFps);\n            event.put("settings", currentSettingsJson());\n            postString(event.toString());\n        } catch (Exception ignored) {}\n    }\n\n    private void onImageAvailable(ImageReader reader, long generation) {\n'''
)

# ---------------------------------------------------------------------------
# Activity lifecycle / permission routing for both camera implementations.
# Browser getUserMedia permission handling is intentionally untouched.
# ---------------------------------------------------------------------------
replace_once(
    "android/app/src/main/java/com/airgapper/app/MainActivity.java",
    '    private NativeCameraBridge nativeCameraBridge;\n',
    '    private NativeCameraBridge nativeCameraBridge;\n    private NativeCameraV2Bridge nativeCameraV2Bridge;\n'
)
replace_once(
    "android/app/src/main/java/com/airgapper/app/MainActivity.java",
    '        nativeCameraBridge = new NativeCameraBridge(this, webView);\n',
    '        nativeCameraBridge = new NativeCameraBridge(this, webView);\n        nativeCameraV2Bridge = new NativeCameraV2Bridge(this, webView);\n'
)
replace_once(
    "android/app/src/main/java/com/airgapper/app/MainActivity.java",
    '        if (nativeCameraBridge != null && nativeCameraBridge.onRequestPermissionsResult(requestCode, results)) return;\n',
    '        if (nativeCameraV2Bridge != null && nativeCameraV2Bridge.onRequestPermissionsResult(requestCode, results)) return;\n        if (nativeCameraBridge != null && nativeCameraBridge.onRequestPermissionsResult(requestCode, results)) return;\n'
)
replace_once(
    "android/app/src/main/java/com/airgapper/app/MainActivity.java",
    '        if (nativeCameraBridge != null) nativeCameraBridge.stop();\n',
    '        if (nativeCameraV2Bridge != null) nativeCameraV2Bridge.stop();\n        if (nativeCameraBridge != null) nativeCameraBridge.stop();\n'
)
replace_once(
    "android/app/src/main/java/com/airgapper/app/MainActivity.java",
    '        if (nativeCameraBridge != null) {\n            nativeCameraBridge.close();\n            nativeCameraBridge = null;\n        }\n',
    '        if (nativeCameraV2Bridge != null) {\n            nativeCameraV2Bridge.close();\n            nativeCameraV2Bridge = null;\n        }\n        if (nativeCameraBridge != null) {\n            nativeCameraBridge.close();\n            nativeCameraBridge = null;\n        }\n'
)

# ---------------------------------------------------------------------------
# Receiver UI: APK defaults to the proven browser camera path. Native Camera2
# decode is an explicit backend, so it can be compared on the same phone.
# ---------------------------------------------------------------------------
replace_once(
    "index.html",
    '<label id="camera-device-control"><span>Camera</span><select id="camera-device"><option value="">Default camera</option></select></label>',
    '<label id="camera-backend-control"><span>Backend</span><select id="camera-backend"><option value="browser">Browser / WebView</option><option value="native-v2">Camera2 · Native decode</option></select></label><label id="camera-device-control"><span>Camera</span><select id="camera-device"><option value="">Default camera</option></select></label>'
)
replace_all("index.html", "v0.5.357", "v0.5.358")
replace_all("main.js", 'const APP_BUILD = "v0.5.357";', 'const APP_BUILD = "v0.5.358";')
replace_all(".github/workflows/build-apk.yml", "v0.5.357", "v0.5.358")
replace_all("sw.js", 'const CACHE = "airgapper-static-js-v357";', 'const CACHE = "airgapper-static-js-v358";')
replace_once(
    "sw.js",
    '    "./shared/native-camera.js",\n',
    '    "./shared/native-camera.js",\n    "./shared/native-camera-v2.js",\n'
)

# ---------------------------------------------------------------------------
# Receiver integration.
# ---------------------------------------------------------------------------
r = "receive/main.js"
replace_all(r, 'const RECEIVER_RUNTIME_BUILD = "v0.5.357";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.358";')
replace_once(
    r,
    '''import {\n  ackNativeCameraFrame,\n  listNativeCameras,\n  nativeCameraAvailable,\n  nativeCameraTrack,\n  setNativeCameraFrameHandler,\n  startNativeCamera,\n  stopNativeCamera\n} from "../shared/native-camera.js";\n''',
    '''import {\n  ackNativeCameraFrame,\n  listNativeCameras,\n  nativeCameraAvailable,\n  nativeCameraTrack,\n  setNativeCameraFrameHandler,\n  startNativeCamera,\n  stopNativeCamera\n} from "../shared/native-camera.js";\nimport {\n  listNativeCamerasV2,\n  nativeCameraV2Available,\n  nativeCameraV2Track,\n  setNativeCameraV2FrameHandler,\n  setNativeCameraV2PreviewHandler,\n  setNativeCameraV2ResultHandler,\n  startNativeCameraV2,\n  stopNativeCameraV2,\n  submitNativeCameraV2Plan\n} from "../shared/native-camera-v2.js";\n'''
)
replace_once(
    r,
    'const cameraDeviceControl = document.getElementById("camera-device-control");\n',
    'const cameraDeviceControl = document.getElementById("camera-device-control");\nconst cameraBackendControl = document.getElementById("camera-backend-control");\nconst cameraBackend = document.getElementById("camera-backend");\n'
)
replace_once(
    r,
    '''const nativeCamera2 = isAndroidApp() && nativeCameraAvailable();\nconst nativeStreamShim = Object.freeze({\n  __airgapperNativeCamera: true,\n  getTracks: () => nativeCameraTrack() ? [nativeCameraTrack()] : [],\n  getVideoTracks: () => nativeCameraTrack() ? [nativeCameraTrack()] : []\n});\n''',
    '''const CAMERA_BACKEND_KEY = "airgapper:apk-camera-backend:v1";\nlet cameraBackendMode = "browser";\nif (cameraBackend) {\n  cameraBackendControl.hidden = !isAndroidApp();\n  const nativeOption = cameraBackend.querySelector('option[value="native-v2"]');\n  const nativeAvailable = isAndroidApp() && nativeCameraV2Available();\n  if (nativeOption) nativeOption.disabled = !nativeAvailable;\n  if (isAndroidApp()) {\n    try {\n      const saved = localStorage.getItem(CAMERA_BACKEND_KEY);\n      if (saved === "native-v2" && nativeAvailable) cameraBackendMode = saved;\n    } catch {}\n  }\n  cameraBackend.value = cameraBackendMode;\n}\nlet nativeCamera2 = isAndroidApp() && cameraBackendMode === "native-v2" && nativeCameraV2Available();\nlet nativeCameraV2Running = false;\nlet nativeV2ActiveJob;\nfunction currentNativeTrack() {\n  return nativeCameraV2Running ? nativeCameraV2Track() : nativeCameraTrack();\n}\nconst nativeStreamShim = Object.freeze({\n  __airgapperNativeCamera: true,\n  getTracks: () => currentNativeTrack() ? [currentNativeTrack()] : [],\n  getVideoTracks: () => currentNativeTrack() ? [currentNativeTrack()] : []\n});\n'''
)
replace_once(
    r,
    '''function nativeModeLabel(mode) {\n  const path = mode.pipeline === "gpu" ? " · GPU" : "";\n  const control = mode.fpsControl === "manual" ? " · manual sensor" : "";\n  if (mode.fixedFps) return `${formatCameraMode(mode.width, mode.height, mode.fps)}${path}${control}`;\n  return `${mode.width}×${mode.height} · ${mode.fps} fps target · AE ${mode.fpsMin}–${mode.fpsMax}${path}${control}`;\n}\n''',
    '''function nativeModeLabel(mode) {\n  if (mode.highSpeed) return `${formatCameraMode(mode.width, mode.height, mode.fps)} · sensor ${mode.sensorFps} fps HFR · NDK`;\n  const path = mode.pipeline === "gpu" ? " · PRIVATE" : " · YUV";\n  const control = mode.fpsControl === "manual" ? " · manual sensor" : "";\n  if (mode.fixedFps) return `${formatCameraMode(mode.width, mode.height, mode.fps)}${path}${control} · NDK`;\n  return `${mode.width}×${mode.height} · ${mode.fps} fps target · AE ${mode.fpsMin}–${mode.fpsMax}${path}${control} · NDK`;\n}\n'''
)
replace_once(r, '  const catalog = await listNativeCameras();\n', '  const catalog = cameraBackendMode === "native-v2" ? await listNativeCamerasV2() : await listNativeCameras();\n')
replace_once(
    r,
    '''cameraDevice?.addEventListener("change", () => {\n''',
    '''cameraBackend?.addEventListener("change", () => {\n  const next = cameraBackend.value === "native-v2" && nativeCameraV2Available() ? "native-v2" : "browser";\n  if (next === cameraBackendMode) return;\n  stopReceiver();\n  cameraBackendMode = next;\n  nativeCamera2 = isAndroidApp() && cameraBackendMode === "native-v2";\n  nativeCameraCatalog = void 0;\n  preferredCameraDeviceId = "";\n  try { localStorage.setItem(CAMERA_BACKEND_KEY, cameraBackendMode); } catch {}\n  populateCameraOptions();\n  showRequestedCameraSettings();\n  if (nativeCamera2) void refreshNativeCameraDevices().finally(() => { if (!stream && !done) void start(); });\n  else void start();\n});\ncameraDevice?.addEventListener("change", () => {\n'''
)
replace_once(
    r,
    '''function stopNativeReceiverSource() {\n  if (!nativeCamera2) return;\n  nativeCameraRunning = false;\n  nativeCameraInfo = void 0;\n  setNativeCameraFrameHandler();\n  void stopNativeCamera();\n  if (nativePreview) {\n''',
    '''function stopNativeReceiverSource() {\n  if (nativeCameraV2Running) {\n    nativeCameraV2Running = false;\n    nativeV2ActiveJob = void 0;\n    setNativeCameraV2FrameHandler();\n    setNativeCameraV2ResultHandler();\n    setNativeCameraV2PreviewHandler();\n    void stopNativeCameraV2();\n  }\n  if (nativeCameraRunning) {\n    nativeCameraRunning = false;\n    setNativeCameraFrameHandler();\n    void stopNativeCamera();\n  }\n  nativeCameraInfo = void 0;\n  if (nativePreview) {\n'''
)

# Native-v2 helpers are function declarations so submitReceiverJob may call
# them even though this block lives beside the camera bridge code later.
replace_once(
    r,
    'function nativeSourceFrame(frame, gen) {\n',
    r'''function nativeV2PreviewBounds(quad) {\n  if (!validQuadObject(quad)) return null;\n  const points = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];\n  const left = Math.min(...points.map((point) => point.x));\n  const top = Math.min(...points.map((point) => point.y));\n  const right = Math.max(...points.map((point) => point.x));\n  const bottom = Math.max(...points.map((point) => point.y));\n  const w = right - left, h = bottom - top;\n  return w > 0 && h > 0 ? { x: left, y: top, w, h } : null;\n}\nfunction nativeV2TrackModuleSize(track) {\n  if (!track?.dim || !validQuadObject(track.quad)) return 0;\n  const points = [track.quad.topLeft, track.quad.topRight, track.quad.bottomRight, track.quad.bottomLeft];\n  return Math.min(...points.map((point, index) => {\n    const next = points[(index + 1) % points.length];\n    return Math.hypot(next.x - point.x, next.y - point.y);\n  })) / track.dim;\n}\nfunction nativeV2WallMotion(samples) {\n  if (!samples.length) return null;\n  const median = (values) => {\n    const sorted = [...values].sort((a, b) => a - b);\n    const mid = sorted.length >> 1;\n    return sorted.length & 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;\n  };\n  if (samples.length >= 2) {\n    const meanX = samples.reduce((sum, item) => sum + item.x, 0) / samples.length;\n    const meanY = samples.reduce((sum, item) => sum + item.y, 0) / samples.length;\n    const meanQx = samples.reduce((sum, item) => sum + item.x + item.dx, 0) / samples.length;\n    const meanQy = samples.reduce((sum, item) => sum + item.y + item.dy, 0) / samples.length;\n    let denom = 0, real = 0, imag = 0;\n    for (const item of samples) {\n      const px = item.x - meanX, py = item.y - meanY;\n      const qx = item.x + item.dx - meanQx, qy = item.y + item.dy - meanQy;\n      denom += px * px + py * py;\n      real += px * qx + py * qy;\n      imag += px * qy - py * qx;\n    }\n    if (denom > 1) {\n      const a = real / denom, b = imag / denom;\n      const motion = {\n        a, b,\n        tx: meanQx - a * meanX + b * meanY,\n        ty: meanQy - b * meanX - a * meanY\n      };\n      const scale = Math.hypot(a, b);\n      const rotation = Math.atan2(b, a);\n      const residuals = samples.map((item) => {\n        const x = a * item.x - b * item.y + motion.tx;\n        const y = b * item.x + a * item.y + motion.ty;\n        return Math.hypot(x - item.x - item.dx, y - item.y - item.dy);\n      });\n      const shifts = samples.map((item) => {\n        const x = a * item.x - b * item.y + motion.tx;\n        const y = b * item.x + a * item.y + motion.ty;\n        return Math.hypot(x - item.x, y - item.y);\n      });\n      if (scale >= 0.975 && scale <= 1.025 && Math.abs(rotation) <= 0.035 &&\n          Math.max(...residuals) <= 1.05 && Math.max(...shifts) <= 5.1) {\n        return {\n          kind: "similarity", ...motion,\n          dx: samples.reduce((sum, item) => sum + item.dx, 0) / samples.length,\n          dy: samples.reduce((sum, item) => sum + item.dy, 0) / samples.length,\n          samples: samples.length,\n          residual: Math.sqrt(residuals.reduce((sum, value) => sum + value * value, 0) / residuals.length),\n          maxShift: Math.max(...shifts)\n        };\n      }\n    }\n  }\n  const dx = median(samples.map((item) => item.dx));\n  const dy = median(samples.map((item) => item.dy));\n  const coherent = samples.filter((item) => Math.hypot(item.dx - dx, item.dy - dy) <= 0.75);\n  if (coherent.length >= Math.max(1, Math.ceil(samples.length * 0.6)) && Math.hypot(dx, dy) <= 4.5) {\n    return {\n      kind: "translation", a: 1, b: 0, tx: dx, ty: dy, dx, dy,\n      samples: coherent.length,\n      residual: Math.max(0, ...coherent.map((item) => Math.hypot(item.dx - dx, item.dy - dy))),\n      maxShift: Math.hypot(dx, dy)\n    };\n  }\n  return null;\n}\nfunction drawNativeV2Preview(packet) {\n  if (!nativePreviewCtx || !packet?.y || !packet.width || !packet.height) return;\n  const rotation = nativePreviewRotation({ sensorOrientation: packet.orientation, facing: nativeCameraInfo?.facing });\n  const rotated = rotation === 90 || rotation === 270;\n  const outWidth = rotated ? packet.height : packet.width;\n  const outHeight = rotated ? packet.width : packet.height;\n  if (nativePreview.width !== outWidth || nativePreview.height !== outHeight) {\n    nativePreview.width = outWidth;\n    nativePreview.height = outHeight;\n    nativePreviewImage = void 0;\n  }\n  const rgba = nativePreviewImage ?? nativePreviewCtx.createImageData(outWidth, outHeight);\n  nativePreviewImage = rgba;\n  for (let y = 0; y < outHeight; y++) {\n    for (let x = 0; x < outWidth; x++) {\n      let sx = x, sy = y;\n      if (rotation === 90) { sx = y; sy = packet.height - 1 - x; }\n      else if (rotation === 180) { sx = packet.width - 1 - x; sy = packet.height - 1 - y; }\n      else if (rotation === 270) { sx = packet.width - 1 - y; sy = x; }\n      const luma = packet.y[sy * packet.width + sx];\n      const at = (y * outWidth + x) * 4;\n      rgba.data[at] = luma; rgba.data[at + 1] = luma; rgba.data[at + 2] = luma; rgba.data[at + 3] = 255;\n    }\n  }\n  nativePreviewCtx.putImageData(rgba, 0, 0);\n}\nfunction nativeV2SourceFrame(frame, gen) {\n  if (!nativeCameraV2Running || done || gen !== captureGen || !frame) return;\n  const callbackTime = performance.now();\n  const sequence = sourceFrameSequence++;\n  latestSourceFrameSequence = sequence;\n  latestNativeSettingsEpoch = Math.max(latestNativeSettingsEpoch, Number(frame.settingsEpoch) || 0);\n  if (!framePumpFirstFrameAt) framePumpFirstFrameAt = receiverNow();\n  framePumpProcessorTotal++;\n  processSourceFrame({\n    nativeV2: true,\n    sequence,\n    cameraSequence: frame.frameNumber,\n    cameraSettingsEpoch: frame.settingsEpoch,\n    opticsEpoch: activeOptimizerEpoch?.collecting ? activeOptimizerEpoch.id : void 0,\n    width: frame.width || nativeCameraInfo?.width || requestedWidth,\n    height: frame.height || nativeCameraInfo?.height || requestedHeight,\n    callbackTimeMs: callbackTime,\n    mediaTimeMs: frame.timestampNs > 0 ? frame.timestampNs / 1e6 : callbackTime,\n    presentationTimeMs: callbackTime,\n    expectedDisplayTimeMs: callbackTime,\n    cameraMetadata: {\n      timestampNs: frame.timestampNs,\n      frameNumber: frame.frameNumber,\n      exposureTimeNs: frame.exposureTimeNs,\n      frameDurationNs: frame.frameDurationNs,\n      rollingShutterSkewNs: frame.rollingShutterSkewNs,\n      focusDistance: frame.focusDistance,\n      iso: frame.iso,\n      settingsEpoch: frame.settingsEpoch,\n      orientation: frame.orientation\n    }\n  }, gen);\n}\nfunction submitNativeV2Job(message, sourceSequence, sourceCapturedAt) {\n  if (!nativeCameraV2Running || nativeV2ActiveJob) return false;\n  const tracks = Array.isArray(message.tracks) ? message.tracks : [];\n  const guided = !message.full && Boolean(message.guidedDecode) && tracks.length > 0;\n  const plan = {\n    mode: guided ? "guided" : "full",\n    jobId: message.id,\n    sourceSequence: Number(sourceSequence) || 0,\n    cropX: Math.max(0, Math.round(Number(message.ox) || 0)),\n    cropY: Math.max(0, Math.round(Number(message.oy) || 0)),\n    cropWidth: Math.max(0, Math.round(Number(message.w) || 0)),\n    cropHeight: Math.max(0, Math.round(Number(message.h) || 0)),\n    tryHarder: Boolean(message.full ? message.acquisitionMode !== "fast" : true),\n    tryDownscale: Boolean(message.full && message.acquisitionMode === "thorough"),\n    returnErrors: Boolean(message.full),\n    maxSymbols: guided ? tracks.length : Math.min(8, Math.max(1, tracks.length || (message.full ? 1 : 4))),\n    fallbackMask: Number(message.guidedFallbackMask ?? 0xffffffff) >>> 0,\n    repairMask: Number(message.guidedRepairMask ?? 0xffffffff) >>> 0\n  };\n  if (guided) {\n    plan.tracks = tracks.map((track, index) => ({\n      id: Number(track.id ?? track.slot ?? index),\n      slot: Number(track.slot ?? track.id ?? index),\n      dim: Number(track.dim),\n      quad: [\n        track.quad.topLeft.x, track.quad.topLeft.y,\n        track.quad.topRight.x, track.quad.topRight.y,\n        track.quad.bottomRight.x, track.quad.bottomRight.y,\n        track.quad.bottomLeft.x, track.quad.bottomLeft.y\n      ]\n    }));\n  }\n  if (!submitNativeCameraV2Plan(plan)) return false;\n  nativeV2ActiveJob = {\n    id: message.id, message, sourceSequence, sourceCapturedAt,\n    opticsEpoch: message.opticsEpoch,\n    submittedAt: performance.now()\n  };\n  return true;\n}\nfunction completeNativeV2Job(packet) {\n  const job = nativeV2ActiveJob;\n  if (!job) return;\n  if (packet?.type === "decode" && packet.jobId !== job.id) return;\n  nativeV2ActiveJob = void 0;\n  const message = job.message;\n  if (packet?.type === "error") {\n    noteDecodeCompleted(job.id, {\n      full: Boolean(message.full), symbolCount: 0, sightingCount: 0,\n      trackedAttempted: !message.full, trackedHit: false, fallbackAttempted: false, fallbackSucceeded: false,\n      readFullAttempts: Number(Boolean(message.full)), workerWaitMs: 0, targetedAttempts: 0, targetedPixels: 0,\n      targetedSuccesses: 0, latencyMs: performance.now() - job.submittedAt, frameCopyMs: 0,\n      symbols: [], sightings: [], error: packet.detail || "Native Camera2 NDK decode failed"\n    });\n    return;\n  }\n  const metrics = packet.guidedMetrics;\n  const tracks = Array.isArray(message.tracks) ? message.tracks : [];\n  if (metrics && tracks.length) {\n    const sizes = tracks.map(nativeV2TrackModuleSize).filter((value) => value > 0 && Number.isFinite(value));\n    metrics.moduleSizeMin = sizes.length ? Math.min(...sizes) : 0;\n    metrics.moduleSizeMax = sizes.length ? Math.max(...sizes) : 0;\n    metrics.moduleSizeAvg = sizes.length ? sizes.reduce((sum, value) => sum + value, 0) / sizes.length : 0;\n  }\n  const expectedSlots = new Set(tracks.map((track) => Number(track.slot ?? track.id)).filter(Number.isInteger));\n  const acceptedSlots = new Set();\n  const symbols = [];\n  const sightings = [];\n  const motionSamples = [];\n  for (const record of packet.records ?? []) {\n    const box = nativeV2PreviewBounds(record.quad);\n    if ((record.status !== 1 && record.status !== 3) || !record.bytes?.length) {\n      if (message.full && box) sightings.push(box);\n      continue;\n    }\n    const parsed = parseFrame(record.bytes);\n    const slot = parsed?.header?.slotIndex;\n    if (!parsed || (expectedSlots.size && !expectedSlots.has(slot)) || acceptedSlots.has(slot)) continue;\n    acceptedSlots.add(slot);\n    const lane = tracks.findIndex((track) => Number(track.slot ?? track.id) === slot);\n    const bit = lane >= 0 && lane < 32 ? (1 << lane) >>> 0 : 0;\n    const decodePath = message.full ? "acquire"\n      : packet.mode === 1\n        ? bit && metrics && (metrics.fallbackSuccessMask & bit) ? "fallback"\n          : bit && metrics && (metrics.sparseSuccessMask & bit) ? "sparse" : "hot"\n        : "robust";\n    const symbol = {\n      bytes: record.bytes, box, quad: record.quad, modules: record.dimension,\n      tracked: !message.full, geometryMeasured: record.status === 1, decodePath, crc32: true,\n      verifiedPayload: true, header: parsed.header\n    };\n    symbols.push(symbol);\n    if (!message.full && lane >= 0 && validQuadObject(tracks[lane]?.quad)) {\n      const input = tracks[lane].quad;\n      const names = ["topLeft", "topRight", "bottomRight", "bottomLeft"];\n      const dx = names.reduce((sum, name) => sum + record.quad[name].x - input[name].x, 0) / names.length;\n      const dy = names.reduce((sum, name) => sum + record.quad[name].y - input[name].y, 0) / names.length;\n      if (Number.isFinite(dx) && Number.isFinite(dy) && Math.hypot(dx, dy) <= 5.1) {\n        const points = names.map((name) => input[name]);\n        motionSamples.push({\n          dx, dy,\n          x: points.reduce((sum, point) => sum + point.x, 0) / points.length,\n          y: points.reduce((sum, point) => sum + point.y, 0) / points.length\n        });\n      }\n    }\n  }\n  const wallMotion = nativeV2WallMotion(motionSamples);\n  if (wallMotion) for (const symbol of symbols) symbol.wallMotion = wallMotion;\n  const auditMode = hotPathJobMode.get(job.id);\n  if (auditMode) {\n    auditMode.cameraTimestampNs = packet.timestampNs;\n    auditMode.rollingShutterSkewNs = packet.rollingShutterSkewNs;\n    auditMode.cameraOrientation = packet.orientation;\n    auditMode.cameraSettingsEpoch = packet.settingsEpoch;\n  }\n  for (const symbol of symbols) {\n    onDecoded(symbol.bytes, symbol.box, {\n      scanId: job.id, sourceSequence: job.sourceSequence, opticsEpoch: job.opticsEpoch,\n      quad: symbol.quad, modules: symbol.modules, tracked: symbol.tracked,\n      geometryMeasured: symbol.geometryMeasured, wallMotion: symbol.wallMotion, decodePath: symbol.decodePath,\n      crc32: symbol.crc32, verifiedPayload: true, header: symbol.header\n    });\n  }\n  if (!gridLattice.active) for (const sighting of sightings.slice(0, 3)) noteRegion(sighting, receiverNow(), false);\n  const latencyMs = performance.now() - job.submittedAt;\n  noteDecodeCompleted(job.id, {\n    full: Boolean(message.full), symbolCount: symbols.length, sightingCount: sightings.length,\n    trackedAttempted: !message.full, trackedHit: !message.full && symbols.length > 0,\n    fallbackAttempted: !message.full && packet.mode === 0, fallbackSucceeded: !message.full && packet.mode === 0 && symbols.length > 0,\n    readFullAttempts: Number(packet.mode === 0), workerWaitMs: 0, targetedAttempts: 0, targetedPixels: 0,\n    targetedSuccesses: 0, latencyMs, frameCopyMs: 0, nativeMs: metrics?.totalMs ?? 0,\n    guidedMetrics: metrics, pixelPath: packet.mode === 1 ? "ndk-guided" : "ndk-full",\n    symbols, sightings\n  });\n}\nasync function startNativeV2Receiver(startAttempt, transportReady) {\n  let catalogReady = Boolean(nativeCameraCatalog?.supported);\n  if (!catalogReady) {\n    try { catalogReady = await refreshNativeCameraDevices(); }\n    catch (error) { nativeCameraUnsupportedReason = error instanceof Error ? error.message : String(error); }\n  }\n  if (startAttempt !== cameraStartGen || receiverPaused) return;\n  if (!catalogReady) {\n    pool.resize(0);\n    offerRetry(`Native Camera2 NDK: ${nativeCameraUnsupportedReason || "camera bridge unavailable"}`);\n    return;\n  }\n  const camera = selectedNativeCamera();\n  const selectedMode = browserModes.find((mode) => mode.key === cameraResolution.value) ?? nativeAutoMode(camera);\n  if (!camera || !selectedMode) {\n    pool.resize(0);\n    offerRetry("Native Camera2 NDK: no supported mode found");\n    return;\n  }\n  requestedWidth = selectedMode.width; requestedHeight = selectedMode.height; requestedFps = selectedMode.fps;\n  syncNativePreviewAspect(requestedWidth, requestedHeight, camera);\n  cameraActual.textContent = `${nativeModeLabel(selectedMode)} · native decode`;\n  startBtn.disabled = true; startBtn.style.display = "none";\n  video.srcObject = null; video.hidden = true;\n  if (nativePreview) nativePreview.hidden = false;\n  const futureGen = captureGen + 1;\n  let started, transportError;\n  try {\n    [started, transportError] = await Promise.all([\n      startNativeCameraV2({\n        cameraId: camera.id, width: requestedWidth, height: requestedHeight, fps: requestedFps,\n        sensorFps: selectedMode.sensorFps ?? requestedFps, pipeline: selectedMode.pipeline,\n        fpsControl: selectedMode.fpsControl, highSpeed: selectedMode.highSpeed\n      }),\n      transportReady\n    ]);\n  } catch (error) {\n    void stopNativeCameraV2();\n    if (startAttempt !== cameraStartGen || receiverPaused) return;\n    pool.resize(0);\n    offerRetry(`Native Camera2 NDK: ${error instanceof Error ? error.message : String(error)}`);\n    return;\n  }\n  if (transportError) {\n    void stopNativeCameraV2(); pool.resize(0);\n    offerRetry(`Transport: ${transportError instanceof Error ? transportError.message : String(transportError)}`);\n    return;\n  }\n  if (startAttempt !== cameraStartGen || receiverPaused) { void stopNativeCameraV2(); return; }\n  stream = nativeStreamShim;\n  nativeCameraInfo = { ...started, nativeDecode: true };\n  nativeCameraV2Running = true; nativeCameraRunning = false; nativeV2ActiveJob = void 0;\n  latestNativeSettingsEpoch = 0;\n  const nativeTrack = nativeCameraV2Track();\n  if (nativeTrack) {\n    populateBrowserCapabilities(nativeTrack);\n    attachCameraController(nativeTrack);\n    if (!automaticOptics) void reapplyManualOpticsAfterFreshFrames(nativeTrack, "native NDK camera started");\n  }\n  syncNativePreviewAspect(started.width ?? requestedWidth, started.height ?? requestedHeight, started);\n  setNativeCameraV2PreviewHandler(drawNativeV2Preview);\n  setNativeCameraV2ResultHandler(completeNativeV2Job);\n  setNativeCameraV2FrameHandler((frame) => nativeV2SourceFrame(frame, futureGen));\n  preview.classList.remove("camera-loading"); setStatus("");\n  cameraStartedTs = receiverNow();\n  acquisitionRaceStartedAt = 0; acquisitionHuntScans = 0; acquisitionSightingScans = 0; acquisitionSightings = 0;\n  resetLivePipeline(cameraStartedTs);\n  captureGen = futureGen;\n  framePumpMode = "Camera2 NDK"; framePumpStartedAt = receiverNow(); framePumpFirstFrameAt = 0;\n  framePumpProcessorTotal = 0; framePumpProcessorDiscarded = 0;\n  statsTimer = setInterval(updateStats, STATS_TICK_MS);\n  await requestScreenWakeLock();\n}\n\nfunction nativeSourceFrame(frame, gen) {\n'''
)
replace_once(
    r,
    '''async function startNativeReceiver(startAttempt, transportReady) {\n''',
    '''async function startNativeReceiver(startAttempt, transportReady) {\n  if (cameraBackendMode === "native-v2") return startNativeV2Receiver(startAttempt, transportReady);\n'''
)
replace_once(
    r,
    '  pool.resize(selectedWorkerCount());\n  const transportReady = prepareRaptorQ().then(() => null, (error) => error);\n',
    '  pool.resize(nativeCamera2 ? 1 : selectedWorkerCount());\n  const transportReady = prepareRaptorQ().then(() => null, (error) => error);\n'
)
replace_once(
    r,
    '  const accepted = preferredWorker === void 0 ? pool.submit(message, transfer) : pool.submitTo(preferredWorker, message, transfer);\n',
    '  const accepted = nativeCameraV2Running\n    ? submitNativeV2Job(message, sourceSequence, sourceCapturedAt)\n    : preferredWorker === void 0 ? pool.submit(message, transfer) : pool.submitTo(preferredWorker, message, transfer);\n'
)
replace_once(
    r,
    'function captureOptimizerOpticalSample(source) {\n  const epoch = activeOptimizerEpoch;\n',
    'function captureOptimizerOpticalSample(source) {\n  if (source.nativeV2) return;\n  const epoch = activeOptimizerEpoch;\n'
)
replace_once(
    r,
    '''function mappedDirectTrackedFrame(source, x, y, w, h, tracks) {\n  // A lattice slot may lose its quad before the surrounding scheduler has\n  // finished retiring that slot. Missing geometry is a normal erasure during\n  // target loss, never a reason to throw from the camera loop.\n  if (tracks.some((track) => !track || !validQuadObject(track.quad) || !track.dim)) return null;\n  if (source.nativeY && source.nativeBuffer instanceof ArrayBuffer && source.nativeBuffer.byteLength) {\n''',
    '''function mappedDirectTrackedFrame(source, x, y, w, h, tracks) {\n  // A lattice slot may lose its quad before the surrounding scheduler has\n  // finished retiring that slot. Missing geometry is a normal erasure during\n  // target loss, never a reason to throw from the camera loop.\n  if (tracks.some((track) => !track || !validQuadObject(track.quad) || !track.dim)) return null;\n  if (source.nativeV2) {\n    const cropX = Math.max(0, Math.min(source.width, Math.floor(x)));\n    const cropY = Math.max(0, Math.min(source.height, Math.floor(y)));\n    const cropRight = Math.max(cropX, Math.min(source.width, Math.ceil(x + w)));\n    const cropBottom = Math.max(cropY, Math.min(source.height, Math.ceil(y + h)));\n    if (cropRight - cropX < 2 || cropBottom - cropY < 2) return null;\n    return {\n      frame: { close() {} }, cropX: 0, cropY: 0,\n      w: cropRight - cropX, h: cropBottom - cropY, ox: cropX, oy: cropY, tracks,\n      pixelFormat: "native-v2", payloadBytes: 0,\n      cameraTimestampNs: source.cameraMetadata?.timestampNs,\n      rollingShutterSkewNs: source.cameraMetadata?.rollingShutterSkewNs,\n      cameraOrientation: source.cameraMetadata?.orientation,\n      cameraSettingsEpoch: source.cameraSettingsEpoch\n    };\n  }\n  if (source.nativeY && source.nativeBuffer instanceof ArrayBuffer && source.nativeBuffer.byteLength) {\n'''
)
replace_once(
    r,
    '  if (captureNextScan && !pendingScanCapture && source.nativeY && !source.image) {\n',
    '''  if (captureNextScan && !pendingScanCapture && source.nativeV2 && !source.image) {\n    scanDialogStatus.textContent = "Raw full-frame capture is unavailable in Camera2 native-decode mode. Switch Backend to Browser / WebView for a lossless raw capture.";\n    cancelScanCapture();\n  }\n  if (captureNextScan && !pendingScanCapture && source.nativeY && !source.image) {\n'''
)
replace_all(r, '(source.videoFrame || source.nativeY) && !source.image', '(source.videoFrame || source.nativeY || source.nativeV2) && !source.image', minimum=2)
replace_all(r, 'if ((source.videoFrame || source.nativeY) && !source.image)', 'if ((source.videoFrame || source.nativeY || source.nativeV2) && !source.image)', minimum=1)
replace_all(r, 'if (source.nativeY) break;', 'if (source.nativeY || source.nativeV2) break;', minimum=1)
replace_all(r, '!source.nativeY && !strictHotPathActive() && queuePendingGridLane', '!source.nativeY && !source.nativeV2 && !strictHotPathActive() && queuePendingGridLane', minimum=1)

# Source diagnostics expose the real sensor cadence measured from SENSOR_TIMESTAMP.
replace_once(
    r,
    '''  const sourceLine = nativeCameraInfo\n    ? `Camera2 ${nativeCameraInfo.cameraId} · ${nativeCameraInfo.pipeline === "gpu" ? "PRIVATE→GPU Y8" : "YUV"} ${nativeCameraInfo.width}×${nativeCameraInfo.height} · target ${nativeCameraInfo.fps} fps · ${nativeCameraInfo.fpsControl === "manual" ? "manual sensor FPS" : `AE ${nativeCameraInfo.fpsMin}–${nativeCameraInfo.fpsMax}${nativeCameraInfo.fixedFps ? " fixed" : " variable"}`} · capture ${receiverFrameWidth || "—"}×${receiverFrameHeight || "—"}@${sourceCaptureRate.toFixed(1)} · pump ${framePumpMode} · sensor ${nativeCameraInfo.sensorOrientation ?? "—"}°`\n''',
    '''  const sourceLine = nativeCameraInfo\n    ? nativeCameraInfo.nativeDecode\n      ? `Camera2 NDK ${nativeCameraInfo.cameraId} · ${nativeCameraInfo.pipeline === "gpu" ? "PRIVATE→GPU Y8" : "YUV Y8"} ${nativeCameraInfo.width}×${nativeCameraInfo.height} · decode ${nativeCameraInfo.fps} fps · sensor target ${nativeCameraInfo.sensorFps ?? nativeCameraInfo.fps} fps${sourceTrack?.getSettings?.().measuredFps ? ` · measured ${Number(sourceTrack.getSettings().measuredFps).toFixed(1)}` : ""} · scheduler ${sourceCaptureRate.toFixed(1)}/s · sensor ${nativeCameraInfo.sensorOrientation ?? "—"}°`\n      : `Camera2 ${nativeCameraInfo.cameraId} · ${nativeCameraInfo.pipeline === "gpu" ? "PRIVATE→GPU Y8" : "YUV"} ${nativeCameraInfo.width}×${nativeCameraInfo.height} · target ${nativeCameraInfo.fps} fps · ${nativeCameraInfo.fpsControl === "manual" ? "manual sensor FPS" : `AE ${nativeCameraInfo.fpsMin}–${nativeCameraInfo.fpsMax}${nativeCameraInfo.fixedFps ? " fixed" : " variable"}`} · capture ${receiverFrameWidth || "—"}×${receiverFrameHeight || "—"}@${sourceCaptureRate.toFixed(1)} · pump ${framePumpMode} · sensor ${nativeCameraInfo.sensorOrientation ?? "—"}°`\n'''
)

print("APK_CAMERA_V2_INTEGRATION_PATCH_OK")
