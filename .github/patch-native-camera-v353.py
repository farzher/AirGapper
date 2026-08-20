from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one match, found {count}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))


def replace_all(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count < 1:
        raise SystemExit(f"{path}: no matches for {old!r}")
    p.write_text(text.replace(old, new))


# Version bump. The release workflow is changed separately through the GitHub
# connector because Actions tokens cannot modify workflow files.
for path in ["index.html", "main.js", "receive/main.js", "send/main.js"]:
    replace_all(path, "v0.5.352", "v0.5.353")
replace_once(
    "android/app/build.gradle",
    'versionCode 352\n        versionName "0.5.352"',
    'versionCode 353\n        versionName "0.5.353"'
)
replace_once("sw.js", 'airgapper-static-js-v352', 'airgapper-static-js-v353')


# ---------------------------------------------------------------------------
# JS/native transport
# ---------------------------------------------------------------------------
p = Path("shared/native-camera.js")
text = p.read_text()
old = '''    if (data instanceof ArrayBuffer) {
      if (frameHandler) {
        try {
          frameHandler(data);
        } catch (error) {
          console.error("Native camera frame handler failed", error);
          ackNativeCameraFrame();
        }
      } else {
        ackNativeCameraFrame();
      }
      return;
    }'''
new = '''    if (data instanceof ArrayBuffer) {
      // The bytes are JS-owned once WebView delivered this ArrayBuffer. Release
      // Camera2 immediately so camera delivery overlaps asynchronous receiver
      // and worker work exactly like MediaStreamTrackProcessor. v0.5.352 waited
      // for captureFrame() to finish and accidentally serialized the camera to
      // roughly one source frame per full receive pass.
      ackNativeCameraFrame();
      if (frameHandler) {
        try {
          frameHandler(data);
        } catch (error) {
          console.error("Native camera frame handler failed", error);
        }
      }
      return;
    }'''
if text.count(old) != 1:
    raise SystemExit("shared/native-camera.js: frame delivery block mismatch")
text = text.replace(old, new, 1)

text = text.replace(
    'let frameHandler;\nconst pending = new Map();',
    '''let frameHandler;
let activeTrack;
const pending = new Map();

function scalarConstraint(value) {
  if (value && typeof value === "object") {
    if ("exact" in value) return value.exact;
    if ("ideal" in value) return value.ideal;
  }
  return value;
}

function flattenConstraints(constraints = {}) {
  const source = constraints.advanced?.[0] ?? constraints;
  const patch = {};
  for (const key of [
    "focusMode", "focusDistance", "pointsOfInterest",
    "exposureMode", "exposureTime", "iso", "exposureCompensation"
  ]) {
    if (source[key] !== undefined) patch[key] = scalarConstraint(source[key]);
  }
  return patch;
}

function makeNativeTrack(started) {
  let ended = false;
  const capabilities = started.capabilities ?? {};
  const settings = {
    deviceId: String(started.cameraId ?? ""),
    width: Number(started.width) || undefined,
    height: Number(started.height) || undefined,
    frameRate: Number(started.fps) || undefined,
    focusMode: started.settings?.focusMode,
    focusDistance: started.settings?.focusDistance,
    exposureMode: started.settings?.exposureMode,
    exposureTime: started.settings?.exposureTime,
    iso: started.settings?.iso,
    exposureCompensation: started.settings?.exposureCompensation
  };
  const track = {
    id: `camera2:${settings.deviceId}`,
    kind: "video",
    label: `Camera2 ${settings.deviceId}`,
    get readyState() { return ended ? "ended" : "live"; },
    getCapabilities() { return capabilities; },
    getSettings() { return { ...settings }; },
    async applyConstraints(constraints = {}) {
      if (ended) throw new Error("Native Camera2 track ended");
      const patch = flattenConstraints(constraints);
      if (!Object.keys(patch).length) return;
      const result = await request("apply", { patch }, 3500);
      if (result.settings) Object.assign(settings, result.settings);
    },
    stop() { ended = true; },
    _update(next) { if (!ended && next) Object.assign(settings, next); }
  };
  return track;
}

function nativeCameraTrack() {
  return activeTrack;
}''',
    1
)

old = '''    const requestId = Number(message?.requestId);
    const request = pending.get(requestId);'''
new = '''    if (message?.event === "settings") {
      activeTrack?._update(message.settings);
      return;
    }
    const requestId = Number(message?.requestId);
    const request = pending.get(requestId);'''
if text.count(old) != 1:
    raise SystemExit("shared/native-camera.js: response dispatch mismatch")
text = text.replace(old, new, 1)

old = '''async function startNativeCamera({ cameraId, width, height, fps, pipeline }) {
  return request("start", { cameraId, width, height, fps, pipeline }, 15000);
}'''
new = '''async function startNativeCamera({ cameraId, width, height, fps, pipeline, fpsControl }) {
  activeTrack?.stop();
  activeTrack = undefined;
  const started = await request("start", { cameraId, width, height, fps, pipeline, fpsControl }, 15000);
  activeTrack = makeNativeTrack(started);
  return started;
}'''
if text.count(old) != 1:
    raise SystemExit("shared/native-camera.js: start function mismatch")
text = text.replace(old, new, 1)

old = '''async function stopNativeCamera() {
  if (!install()) return;
  try {
    await request("stop", {}, 3000);'''
new = '''async function stopNativeCamera() {
  activeTrack?.stop();
  activeTrack = undefined;
  if (!install()) return;
  try {
    await request("stop", {}, 3000);'''
if text.count(old) != 1:
    raise SystemExit("shared/native-camera.js: stop function mismatch")
text = text.replace(old, new, 1)

old = '''  listNativeCameras,
  nativeCameraAvailable,
  setNativeCameraFrameHandler,'''
new = '''  listNativeCameras,
  nativeCameraAvailable,
  nativeCameraTrack,
  setNativeCameraFrameHandler,'''
if text.count(old) != 1:
    raise SystemExit("shared/native-camera.js: export block mismatch")
text = text.replace(old, new, 1)
p.write_text(text)


# ---------------------------------------------------------------------------
# Camera2 bridge
# ---------------------------------------------------------------------------
p = Path("android/app/src/main/java/com/airgapper/app/NativeCameraBridge.java")
text = p.read_text()
text = text.replace(
    'import android.hardware.camera2.CaptureRequest;\n',
    'import android.hardware.camera2.CaptureRequest;\nimport android.hardware.camera2.CaptureResult;\nimport android.hardware.camera2.TotalCaptureResult;\n',
    1
)
text = text.replace('import android.util.Range;\n', 'import android.util.Range;\nimport android.util.Rational;\n', 1)

old = '''                case "ack":
                    frameCredit = true;
                    break;'''
new = '''                case "ack":
                    frameCredit = true;
                    break;
                case "apply":
                    applyRequested(command);
                    break;'''
if text.count(old) != 1:
    raise SystemExit("NativeCameraBridge: command switch mismatch")
text = text.replace(old, new, 1)

old = '    private String activePipeline = "yuv";\n'
new = '''    private String activePipeline = "yuv";
    private String activeFpsControl = "ae";
    private CameraCharacteristics activeCharacteristics;
    private CaptureRequest.Builder activeBuilder;
    private long activeFrameDurationNs;
    private String currentFocusMode = "continuous";
    private String currentExposureMode = "continuous";
    private Float currentFocusDistance;
    private Long currentExposureTimeNs;
    private Integer currentIso;
    private double currentExposureCompensationEv;
    private long lastSettingsEventNs;
'''
if text.count(old) != 1:
    raise SystemExit("NativeCameraBridge: state insertion mismatch")
text = text.replace(old, new, 1)

# Describe the controls that Camera2 itself exposes so the existing web
# FocusController/AutoOptics UI can operate on a Camera2-backed track shim.
old = '''            camera.put("sensorOrientation", orientation == null ? 0 : orientation);
            JSONArray aeRanges = new JSONArray();'''
new = '''            camera.put("sensorOrientation", orientation == null ? 0 : orientation);
            camera.put("capabilities", cameraCapabilities(chars));
            boolean manualSensor = hasCapability(chars, CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR);
            JSONArray aeRanges = new JSONArray();'''
if text.count(old) != 1:
    raise SystemExit("NativeCameraBridge: catalog capabilities mismatch")
text = text.replace(old, new, 1)

# Do not use the AE target-range table as proof that a stream cannot run at
# 60fps. If stream timing permits 60 and MANUAL_SENSOR is available, expose a
# manual-sensor 60fps mode even when hardware AE only advertises 30.
old = '''                    Range<Integer> range = chooseFpsRange(ranges, fps);
                    if (range == null) continue;
                    String pipeline = null;'''
new = '''                    Range<Integer> range = chooseFpsRange(ranges, fps);
                    String pipeline = null;'''
if text.count(old) != 1:
    raise SystemExit("NativeCameraBridge: catalog AE range mismatch")
text = text.replace(old, new, 1)

old = '''                    if (pipeline == null) continue;
                    Size size = pipeline.equals("yuv") ? yuvSize : gpuSize;
                    JSONObject mode = new JSONObject();
                    mode.put("key", sizeKey + "@" + fps + ":" + pipeline);'''
new = '''                    if (pipeline == null) continue;
                    String fpsControl = range != null ? "ae" : manualSensor && fps == 60 ? "manual" : "";
                    if (fpsControl.isEmpty()) continue;
                    Size size = pipeline.equals("yuv") ? yuvSize : gpuSize;
                    JSONObject mode = new JSONObject();
                    mode.put("key", sizeKey + "@" + fps + ":" + pipeline + ":" + fpsControl);'''
if text.count(old) != 1:
    raise SystemExit("NativeCameraBridge: catalog mode construction mismatch")
text = text.replace(old, new, 1)

old = '''                    mode.put("pipeline", pipeline);
                    mode.put("fixedFps", range.getLower() == fps && range.getUpper() == fps);
                    mode.put("fpsMin", range.getLower());
                    mode.put("fpsMax", range.getUpper());'''
new = '''                    mode.put("pipeline", pipeline);
                    mode.put("fpsControl", fpsControl);
                    mode.put("fixedFps", range == null || range.getLower() == fps && range.getUpper() == fps);
                    mode.put("fpsMin", range == null ? fps : range.getLower());
                    mode.put("fpsMax", range == null ? fps : range.getUpper());'''
if text.count(old) != 1:
    raise SystemExit("NativeCameraBridge: catalog FPS metadata mismatch")
text = text.replace(old, new, 1)

old = '''        final String pipeline = command.optString("pipeline", "yuv");
        cameraHandler.post(() -> startCamera(requestId, cameraId, width, height, fps, pipeline));'''
new = '''        final String pipeline = command.optString("pipeline", "yuv");
        final String fpsControl = command.optString("fpsControl", "ae");
        cameraHandler.post(() -> startCamera(requestId, cameraId, width, height, fps, pipeline, fpsControl));'''
if text.count(old) != 1:
    raise SystemExit("NativeCameraBridge: startRequested mismatch")
text = text.replace(old, new, 1)

old = '    private void startCamera(int requestId, String cameraId, int width, int height, int fps, String pipeline) {'
new = '    private void startCamera(int requestId, String cameraId, int width, int height, int fps, String pipeline, String fpsControl) {'
if text.count(old) != 1:
    raise SystemExit("NativeCameraBridge: startCamera signature mismatch")
text = text.replace(old, new, 1)

old = '''            Range<Integer> range = chooseFpsRange(ranges, fps);
            long minDuration = gpu'''
new = '''            Range<Integer> range = chooseFpsRange(ranges, fps);
            boolean manualFps = "manual".equals(fpsControl);
            long minDuration = gpu'''
if text.count(old) != 1:
    raise SystemExit("NativeCameraBridge: start FPS setup mismatch")
text = text.replace(old, new, 1)

old = '''            if (range == null || !durationAllows(minDuration, fps)) {
                throw new IllegalArgumentException(width + "x" + height + " @ " + fps + " fps unavailable on camera " + cameraId + " via " + pipeline);
            }'''
new = '''            if (!durationAllows(minDuration, fps) || !manualFps && range == null) {
                throw new IllegalArgumentException(width + "x" + height + " @ " + fps + " fps unavailable on camera " + cameraId + " via " + pipeline);
            }
            if (manualFps && !hasCapability(chars, CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR)) {
                throw new IllegalArgumentException("Manual sensor FPS control unavailable on camera " + cameraId);
            }'''
if text.count(old) != 1:
    raise SystemExit("NativeCameraBridge: start FPS validation mismatch")
text = text.replace(old, new, 1)

old = '''            activeFpsRange = range;
            activeMinFrameDurationNs = minDuration;
            activePipeline = gpu ? "gpu" : "yuv";'''
new = '''            activeFpsRange = range != null ? range : new Range<>(fps, fps);
            activeMinFrameDurationNs = minDuration;
            activePipeline = gpu ? "gpu" : "yuv";
            activeFpsControl = manualFps ? "manual" : "ae";
            activeFrameDurationNs = Math.max(minDuration, Math.round(1_000_000_000.0 / fps));
            activeCharacteristics = chars;'''
if text.count(old) != 1:
    raise SystemExit("NativeCameraBridge: active FPS state mismatch")
text = text.replace(old, new, 1)

old = '''            CaptureRequest.Builder builder = camera.createCaptureRequest(CameraDevice.TEMPLATE_RECORD);
            builder.addTarget(target);
            builder.set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO);
            builder.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON);
            builder.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, activeFpsRange);
            int[] afModes = chars.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES);
            if (contains(afModes, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO)) {
                builder.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO);
            } else if (contains(afModes, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)) {
                builder.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
            } else if (contains(afModes, CaptureRequest.CONTROL_AF_MODE_AUTO)) {
                builder.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_AUTO);
            }
            CaptureRequest request = builder.build();'''
new = '''            CaptureRequest.Builder builder = camera.createCaptureRequest(CameraDevice.TEMPLATE_RECORD);
            activeBuilder = builder;
            builder.addTarget(target);
            builder.set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO);
            if ("manual".equals(activeFpsControl)) {
                builder.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_OFF);
                Range<Long> exposureRange = chars.get(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE);
                Range<Integer> isoRange = chars.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE);
                long seedExposure = clampLong(3_500_000L, exposureRange);
                int seedIso = clampInt(200, isoRange);
                builder.set(CaptureRequest.SENSOR_FRAME_DURATION, activeFrameDurationNs);
                builder.set(CaptureRequest.SENSOR_EXPOSURE_TIME, Math.min(seedExposure, Math.max(1, activeFrameDurationNs - 100_000L)));
                builder.set(CaptureRequest.SENSOR_SENSITIVITY, seedIso);
                currentExposureMode = "manual";
                currentExposureTimeNs = seedExposure;
                currentIso = seedIso;
            } else {
                builder.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON);
                builder.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, activeFpsRange);
                currentExposureMode = "continuous";
            }
            int[] afModes = chars.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES);
            if (contains(afModes, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO)) {
                builder.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO);
                currentFocusMode = "continuous";
            } else if (contains(afModes, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)) {
                builder.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
                currentFocusMode = "continuous";
            } else if (contains(afModes, CaptureRequest.CONTROL_AF_MODE_AUTO)) {
                builder.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_AUTO);
                currentFocusMode = "single-shot";
            } else {
                builder.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_OFF);
                currentFocusMode = "manual";
            }
            CaptureRequest request = builder.build();'''
if text.count(old) != 1:
    raise SystemExit("NativeCameraBridge: initial request block mismatch")
text = text.replace(old, new, 1)

old = '                        session.setRepeatingRequest(request, null, cameraHandler);'
new = '                        session.setRepeatingRequest(request, captureCallback, cameraHandler);'
if text.count(old) != 1:
    raise SystemExit("NativeCameraBridge: repeating request mismatch")
text = text.replace(old, new, 1)

old = '''                        started.put("pipeline", activePipeline);
                        started.put("sessionParameters", Build.VERSION.SDK_INT >= Build.VERSION_CODES.P);'''
new = '''                        started.put("pipeline", activePipeline);
                        started.put("fpsControl", activeFpsControl);
                        started.put("capabilities", cameraCapabilities(chars));
                        started.put("settings", currentSettingsJson());
                        started.put("sessionParameters", Build.VERSION.SDK_INT >= Build.VERSION_CODES.P);'''
if text.count(old) != 1:
    raise SystemExit("NativeCameraBridge: start reply mismatch")
text = text.replace(old, new, 1)

marker = '    private static boolean contains(int[] values, int wanted) {'
helpers = r'''    private final CameraCaptureSession.CaptureCallback captureCallback = new CameraCaptureSession.CaptureCallback() {
        @Override
        public void onCaptureCompleted(CameraCaptureSession session, CaptureRequest request, TotalCaptureResult result) {
            Long exposure = result.get(CaptureResult.SENSOR_EXPOSURE_TIME);
            Integer iso = result.get(CaptureResult.SENSOR_SENSITIVITY);
            Float focus = result.get(CaptureResult.LENS_FOCUS_DISTANCE);
            Integer af = result.get(CaptureResult.CONTROL_AF_MODE);
            Integer ae = result.get(CaptureResult.CONTROL_AE_MODE);
            Integer comp = result.get(CaptureResult.CONTROL_AE_EXPOSURE_COMPENSATION);
            if (exposure != null) currentExposureTimeNs = exposure;
            if (iso != null) currentIso = iso;
            if (focus != null) currentFocusDistance = focus;
            if (af != null) currentFocusMode = focusModeName(af);
            if (ae != null) currentExposureMode = ae == CaptureRequest.CONTROL_AE_MODE_OFF ? "manual" : "continuous";
            if (comp != null && activeCharacteristics != null) {
                Rational step = activeCharacteristics.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_STEP);
                currentExposureCompensationEv = comp * (step == null ? 1.0 : step.doubleValue());
            }
            long now = System.nanoTime();
            if (now - lastSettingsEventNs >= 200_000_000L) {
                lastSettingsEventNs = now;
                try {
                    JSONObject event = new JSONObject();
                    event.put("event", "settings");
                    event.put("settings", currentSettingsJson());
                    postString(event.toString());
                } catch (Exception ignored) {}
            }
        }
    };

    private static boolean hasCapability(CameraCharacteristics chars, int wanted) {
        int[] values = chars.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES);
        return contains(values, wanted);
    }

    private static long clampLong(long value, Range<Long> range) {
        if (range == null) return value;
        return Math.max(range.getLower(), Math.min(range.getUpper(), value));
    }

    private static int clampInt(int value, Range<Integer> range) {
        if (range == null) return value;
        return Math.max(range.getLower(), Math.min(range.getUpper(), value));
    }

    private static String focusModeName(int mode) {
        if (mode == CaptureRequest.CONTROL_AF_MODE_OFF) return "manual";
        if (mode == CaptureRequest.CONTROL_AF_MODE_AUTO || mode == CaptureRequest.CONTROL_AF_MODE_MACRO) return "single-shot";
        return "continuous";
    }

    private JSONObject cameraCapabilities(CameraCharacteristics chars) throws Exception {
        JSONObject caps = new JSONObject();
        JSONArray focusModes = new JSONArray();
        int[] af = chars.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES);
        if (contains(af, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO) || contains(af, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)) focusModes.put("continuous");
        if (contains(af, CaptureRequest.CONTROL_AF_MODE_AUTO) || contains(af, CaptureRequest.CONTROL_AF_MODE_MACRO)) focusModes.put("single-shot");
        Float minFocus = chars.get(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE);
        if (minFocus != null && minFocus > 0 && contains(af, CaptureRequest.CONTROL_AF_MODE_OFF)) {
            focusModes.put("manual");
            caps.put("focusDistance", new JSONObject().put("min", 0).put("max", minFocus).put("step", Math.max(0.001, minFocus / 200.0)));
        }
        caps.put("focusMode", focusModes);
        caps.put("pointsOfInterest", false);

        JSONArray exposureModes = new JSONArray();
        exposureModes.put("continuous");
        Range<Long> exposure = chars.get(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE);
        Range<Integer> iso = chars.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE);
        if (hasCapability(chars, CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR) && exposure != null && iso != null) {
            exposureModes.put("manual");
            caps.put("exposureTime", new JSONObject()
                    .put("min", exposure.getLower() / 100_000.0)
                    .put("max", exposure.getUpper() / 100_000.0)
                    .put("step", 0.1));
            caps.put("iso", new JSONObject().put("min", iso.getLower()).put("max", iso.getUpper()).put("step", 1));
        }
        caps.put("exposureMode", exposureModes);
        Range<Integer> compensation = chars.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_RANGE);
        Rational compensationStep = chars.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_STEP);
        if (compensation != null && compensationStep != null && compensationStep.doubleValue() > 0) {
            double step = compensationStep.doubleValue();
            caps.put("exposureCompensation", new JSONObject()
                    .put("min", compensation.getLower() * step)
                    .put("max", compensation.getUpper() * step)
                    .put("step", step));
        }
        return caps;
    }

    private JSONObject currentSettingsJson() throws Exception {
        JSONObject settings = new JSONObject();
        settings.put("deviceId", activeCameraId);
        settings.put("width", activeWidth);
        settings.put("height", activeHeight);
        settings.put("frameRate", activeRequestedFps);
        settings.put("focusMode", currentFocusMode);
        if (currentFocusDistance != null) settings.put("focusDistance", currentFocusDistance);
        settings.put("exposureMode", currentExposureMode);
        if (currentExposureTimeNs != null) settings.put("exposureTime", currentExposureTimeNs / 100_000.0);
        if (currentIso != null) settings.put("iso", currentIso);
        settings.put("exposureCompensation", currentExposureCompensationEv);
        return settings;
    }

    private void applyRequested(JSONObject command) {
        final int requestId = command.optInt("requestId");
        final JSONObject patch = command.optJSONObject("patch");
        cameraHandler.post(() -> {
            try {
                if (!running || captureSession == null || activeBuilder == null || activeCharacteristics == null)
                    throw new IllegalStateException("Native Camera2 is not running");
                if (patch == null) throw new IllegalArgumentException("Missing native optics patch");
                CaptureRequest.Builder builder = activeBuilder;

                boolean triggerSingleAf = false;
                if (patch.has("focusMode")) {
                    String mode = patch.optString("focusMode", "continuous");
                    int[] af = activeCharacteristics.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES);
                    if ("manual".equals(mode)) {
                        if (!contains(af, CaptureRequest.CONTROL_AF_MODE_OFF)) throw new IllegalArgumentException("Manual focus unavailable");
                        builder.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_OFF);
                        builder.set(CaptureRequest.CONTROL_AF_TRIGGER, CaptureRequest.CONTROL_AF_TRIGGER_IDLE);
                        currentFocusMode = "manual";
                    } else if ("single-shot".equals(mode)) {
                        if (!contains(af, CaptureRequest.CONTROL_AF_MODE_AUTO)) throw new IllegalArgumentException("Single-shot AF unavailable");
                        builder.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_AUTO);
                        builder.set(CaptureRequest.CONTROL_AF_TRIGGER, CaptureRequest.CONTROL_AF_TRIGGER_START);
                        currentFocusMode = "single-shot";
                        triggerSingleAf = true;
                    } else {
                        int selected = contains(af, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO)
                                ? CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO
                                : CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE;
                        if (!contains(af, selected)) throw new IllegalArgumentException("Continuous AF unavailable");
                        builder.set(CaptureRequest.CONTROL_AF_MODE, selected);
                        builder.set(CaptureRequest.CONTROL_AF_TRIGGER, CaptureRequest.CONTROL_AF_TRIGGER_CANCEL);
                        currentFocusMode = "continuous";
                    }
                }
                if (patch.has("focusDistance")) {
                    Float max = activeCharacteristics.get(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE);
                    if (max == null || max <= 0) throw new IllegalArgumentException("Manual focus distance unavailable");
                    float value = (float) Math.max(0, Math.min(max, patch.optDouble("focusDistance")));
                    builder.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_OFF);
                    builder.set(CaptureRequest.LENS_FOCUS_DISTANCE, value);
                    builder.set(CaptureRequest.CONTROL_AF_TRIGGER, CaptureRequest.CONTROL_AF_TRIGGER_IDLE);
                    currentFocusMode = "manual";
                    currentFocusDistance = value;
                }

                if (patch.has("exposureMode")) {
                    String mode = patch.optString("exposureMode", "continuous");
                    if ("manual".equals(mode)) {
                        if (!hasCapability(activeCharacteristics, CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR))
                            throw new IllegalArgumentException("Manual exposure unavailable");
                        builder.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_OFF);
                        builder.set(CaptureRequest.SENSOR_FRAME_DURATION, activeFrameDurationNs);
                        currentExposureMode = "manual";
                    } else {
                        builder.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON);
                        if (activeFpsRange != null) builder.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, activeFpsRange);
                        currentExposureMode = "continuous";
                    }
                }
                if (patch.has("exposureTime")) {
                    Range<Long> range = activeCharacteristics.get(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE);
                    long ns = clampLong(Math.round(patch.optDouble("exposureTime") * 100_000.0), range);
                    ns = Math.min(ns, Math.max(1, activeFrameDurationNs - 100_000L));
                    builder.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_OFF);
                    builder.set(CaptureRequest.SENSOR_FRAME_DURATION, activeFrameDurationNs);
                    builder.set(CaptureRequest.SENSOR_EXPOSURE_TIME, ns);
                    currentExposureMode = "manual";
                    currentExposureTimeNs = ns;
                }
                if (patch.has("iso")) {
                    Range<Integer> range = activeCharacteristics.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE);
                    int iso = clampInt((int) Math.round(patch.optDouble("iso")), range);
                    builder.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_OFF);
                    builder.set(CaptureRequest.SENSOR_FRAME_DURATION, activeFrameDurationNs);
                    builder.set(CaptureRequest.SENSOR_SENSITIVITY, iso);
                    currentExposureMode = "manual";
                    currentIso = iso;
                }
                if (patch.has("exposureCompensation")) {
                    Range<Integer> range = activeCharacteristics.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_RANGE);
                    Rational step = activeCharacteristics.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_STEP);
                    if (range != null && step != null && step.doubleValue() > 0) {
                        int value = clampInt((int) Math.round(patch.optDouble("exposureCompensation") / step.doubleValue()), range);
                        builder.set(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION, value);
                        currentExposureCompensationEv = value * step.doubleValue();
                    }
                }

                if (triggerSingleAf) {
                    captureSession.capture(builder.build(), captureCallback, cameraHandler);
                    builder.set(CaptureRequest.CONTROL_AF_TRIGGER, CaptureRequest.CONTROL_AF_TRIGGER_IDLE);
                }
                CaptureRequest repeat = builder.build();
                captureSession.setRepeatingRequest(repeat, captureCallback, cameraHandler);
                JSONObject result = new JSONObject();
                result.put("settings", currentSettingsJson());
                reply(requestId, result);
            } catch (Exception error) {
                replyError(requestId, error.getMessage() == null ? error.toString() : error.getMessage());
            }
        });
    }

'''
if text.count(marker) != 1:
    raise SystemExit("NativeCameraBridge: helper insertion marker mismatch")
text = text.replace(marker, helpers + marker, 1)

old = '''        activeCameraId = "";
        activePipeline = "yuv";'''
new = '''        activeCameraId = "";
        activePipeline = "yuv";
        activeFpsControl = "ae";
        activeCharacteristics = null;
        activeBuilder = null;
        currentFocusDistance = null;
        currentExposureTimeNs = null;
        currentIso = null;
        lastSettingsEventNs = 0;'''
if text.count(old) != 1:
    raise SystemExit("NativeCameraBridge: stop state mismatch")
text = text.replace(old, new, 1)
p.write_text(text)


# ---------------------------------------------------------------------------
# Receiver: make Camera2 look like the camera abstraction we already optimized.
# ---------------------------------------------------------------------------
p = Path("receive/main.js")
text = p.read_text()
old = '''  listNativeCameras,
  nativeCameraAvailable,
  setNativeCameraFrameHandler,'''
new = '''  listNativeCameras,
  nativeCameraAvailable,
  nativeCameraTrack,
  setNativeCameraFrameHandler,'''
if text.count(old) != 1:
    raise SystemExit("receive/main.js: native import mismatch")
text = text.replace(old, new, 1)

old = '''const nativeStreamShim = Object.freeze({
  __airgapperNativeCamera: true,
  getTracks: () => [],
  getVideoTracks: () => []
});'''
new = '''const nativeStreamShim = Object.freeze({
  __airgapperNativeCamera: true,
  getTracks: () => nativeCameraTrack() ? [nativeCameraTrack()] : [],
  getVideoTracks: () => nativeCameraTrack() ? [nativeCameraTrack()] : []
});'''
if text.count(old) != 1:
    raise SystemExit("receive/main.js: native stream shim mismatch")
text = text.replace(old, new, 1)

old = '''  const path = mode.pipeline === "gpu" ? " · GPU" : "";
  if (mode.fixedFps) return `${formatCameraMode(mode.width, mode.height, mode.fps)}${path}`;
  return `${mode.width}×${mode.height} · ${mode.fps} fps target · AE ${mode.fpsMin}–${mode.fpsMax}${path}`;'''
new = '''  const path = mode.pipeline === "gpu" ? " · GPU" : "";
  const control = mode.fpsControl === "manual" ? " · manual sensor" : "";
  if (mode.fixedFps) return `${formatCameraMode(mode.width, mode.height, mode.fps)}${path}${control}`;
  return `${mode.width}×${mode.height} · ${mode.fps} fps target · AE ${mode.fpsMin}–${mode.fpsMax}${path}${control}`;'''
if text.count(old) != 1:
    raise SystemExit("receive/main.js: native mode label mismatch")
text = text.replace(old, new, 1)

# Native capability UI is populated from the Camera2-backed track after the
# session starts; do not permanently hide the optics surface merely because the
# source is native.
old = '''  cameraExposureControl.hidden = true;
  cameraOpticsManual.hidden = true;
  opticsAutoActions.hidden = true;
  syncNativePreviewAspect(requestedWidth, requestedHeight, camera);'''
new = '''  cameraExposureControl.hidden = true;
  cameraOpticsManual.hidden = true;
  opticsAutoActions.hidden = true;
  syncNativePreviewAspect(requestedWidth, requestedHeight, camera);'''
# Intentionally unchanged here. populateBrowserCapabilities(nativeTrack) below
# owns visibility once real Camera2 capabilities exist.
if text.count(old) != 1:
    raise SystemExit("receive/main.js: native capability placeholder mismatch")

old = '''        fps: requestedFps,
        pipeline: selectedMode.pipeline'''
new = '''        fps: requestedFps,
        pipeline: selectedMode.pipeline,
        fpsControl: selectedMode.fpsControl'''
if text.count(old) != 1:
    raise SystemExit("receive/main.js: native start payload mismatch")
text = text.replace(old, new, 1)

old = '''  stream = nativeStreamShim;
  nativeCameraInfo = started;
  nativeCameraRunning = true;
  syncNativePreviewAspect(started.width ?? requestedWidth, started.height ?? requestedHeight, started);'''
new = '''  stream = nativeStreamShim;
  nativeCameraInfo = started;
  nativeCameraRunning = true;
  const nativeTrack = nativeCameraTrack();
  if (nativeTrack) {
    populateBrowserCapabilities(nativeTrack);
    attachCameraController(nativeTrack);
    if (!automaticOptics) void reapplyManualOpticsAfterFreshFrames(nativeTrack, "native camera started");
  }
  syncNativePreviewAspect(started.width ?? requestedWidth, started.height ?? requestedHeight, started);'''
if text.count(old) != 1:
    raise SystemExit("receive/main.js: native track attach mismatch")
text = text.replace(old, new, 1)

old = '''    nativeY: new Uint8Array(buffer),
    nativeBuffer: buffer,
    nativeAck: ackNativeCameraFrame
  }, gen);'''
new = '''    nativeY: new Uint8Array(buffer),
    nativeBuffer: buffer
  }, gen);'''
if text.count(old) != 1:
    raise SystemExit("receive/main.js: native frame ownership mismatch")
text = text.replace(old, new, 1)

# The native bridge now owns frame-credit ACK at the JS transport boundary.
# Keep the import only if some other path uses it; this is expected to be the
# final receive-side reference.
text = text.replace('''  ackNativeCameraFrame,
  listNativeCameras,''', '''  listNativeCameras,''', 1)

# Diagnostics should distinguish manual-sensor FPS mode from hardware-AE mode.
old = '''? `Camera2 ${nativeCameraInfo.cameraId} · ${nativeCameraInfo.pipeline === "gpu" ? "PRIVATE→GPU Y8" : "YUV"} ${nativeCameraInfo.width}×${nativeCameraInfo.height} · target ${nativeCameraInfo.fps} fps · AE ${nativeCameraInfo.fpsMin}–${nativeCameraInfo.fpsMax}${nativeCameraInfo.fixedFps ? " fixed" : " variable"} · capture ${receiverFrameWidth || "—"}×${receiverFrameHeight || "—"}@${sourceCaptureRate.toFixed(1)} · pump ${framePumpMode} · sensor ${nativeCameraInfo.sensorOrientation ?? "—"}°`'''
new = '''? `Camera2 ${nativeCameraInfo.cameraId} · ${nativeCameraInfo.pipeline === "gpu" ? "PRIVATE→GPU Y8" : "YUV"} ${nativeCameraInfo.width}×${nativeCameraInfo.height} · target ${nativeCameraInfo.fps} fps · ${nativeCameraInfo.fpsControl === "manual" ? "manual sensor FPS" : `AE ${nativeCameraInfo.fpsMin}–${nativeCameraInfo.fpsMax}${nativeCameraInfo.fixedFps ? " fixed" : " variable"}`} · capture ${receiverFrameWidth || "—"}×${receiverFrameHeight || "—"}@${sourceCaptureRate.toFixed(1)} · pump ${framePumpMode} · sensor ${nativeCameraInfo.sensorOrientation ?? "—"}°`'''
if text.count(old) != 1:
    raise SystemExit("receive/main.js: native diagnostics source line mismatch")
text = text.replace(old, new, 1)
p.write_text(text)

print("native Camera2 v0.5.353 patch applied")
