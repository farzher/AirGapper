package com.airgapper.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.annotation.TargetApi;
import android.app.Activity;
import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.ImageFormat;
import android.graphics.Rect;
import android.graphics.SurfaceTexture;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.CaptureResult;
import android.hardware.camera2.TotalCaptureResult;
import android.hardware.camera2.params.MeteringRectangle;
import android.hardware.camera2.params.OutputConfiguration;
import android.hardware.camera2.params.SessionConfiguration;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.Image;
import android.media.ImageReader;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Range;
import android.util.Rational;
import android.util.Size;
import android.view.Surface;
import android.webkit.WebView;

import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/**
 * Thin native camera source for the WebView receiver.
 *
 * Camera2 owns camera mode negotiation and emits tightly packed Y8 frames.
 * JavaScript keeps all AirGapper geometry, scheduling, decoding and transfer
 * logic. A one-frame credit protocol prevents WebView message queues from
 * accumulating full-resolution camera buffers.
 */
final class NativeCameraBridge {
    static final int CAMERA_PERMISSION_REQUEST = 13;

    private static final String APP_HOST = "appassets.androidplatform.net";
    private static final String APP_ORIGIN = "https://" + APP_HOST;
    private static final String OBJECT_NAME = "AirGapperNativeCamera";
    private static final int[] TEST_FPS = {30, 60};
    private static final Set<String> STANDARD_SIZES = new HashSet<>(Arrays.asList(
            "640x480", "960x720", "1280x720", "1280x960", "1920x1080",
            "2560x1440", "3840x2160"));
    private static final int FRAME_MAGIC = 0x32594741;
    private static final int FRAME_HEADER_BYTES = 88;

    private static final class FrameMetadata {
        long frameNumber;
        long timestampNs;
        long exposureNs;
        long frameDurationNs;
        long rollingShutterSkewNs;
        float focusDistance = Float.NaN;
        int iso;
        int afState = -1;
        int aeState = -1;
        int settingsEpoch;
    }

    private final Activity activity;
    private final CameraManager cameraManager;
    private final HandlerThread cameraThread;
    private final Handler cameraHandler;

    private volatile JavaScriptReplyProxy replyProxy;
    private volatile boolean frameCredit;
    private volatile boolean running;
    private JSONObject pendingPermissionStart;

    private CameraDevice cameraDevice;
    private CameraCaptureSession captureSession;
    private ImageReader imageReader;
    private NativeGpuCameraReader gpuReader;
    private Surface captureSurface;
    private long cameraGeneration;
    private String activeCameraId = "";
    private int activeWidth;
    private int activeHeight;
    private int activeRequestedFps;
    private Range<Integer> activeFpsRange;
    private long activeMinFrameDurationNs;
    private int activeSensorOrientation;
    private String activeFacing = "unknown";
    private String activePipeline = "yuv";
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
    private int activeSettingsEpoch = 1;
    private int lastReportedAfState = -1;
    private int lastReportedAeState = -1;
    private final LinkedHashMap<Long, FrameMetadata> metadataByTimestamp = new LinkedHashMap<Long, FrameMetadata>() {
        @Override
        protected boolean removeEldestEntry(Map.Entry<Long, FrameMetadata> eldest) {
            return size() > 12;
        }
    };

    NativeCameraBridge(Activity activity, WebView webView) {
        this.activity = activity;
        cameraManager = (CameraManager) activity.getSystemService(Context.CAMERA_SERVICE);
        cameraThread = new HandlerThread("AirGapperCamera2");
        cameraThread.start();
        cameraHandler = new Handler(cameraThread.getLooper());

        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;
        WebViewCompat.addWebMessageListener(
                webView,
                OBJECT_NAME,
                Collections.singleton(APP_ORIGIN),
                this::onWebMessage);
    }

    private void onWebMessage(
            WebView view,
            WebMessageCompat message,
            android.net.Uri sourceOrigin,
            boolean isMainFrame,
            JavaScriptReplyProxy proxy) {
        if (!isMainFrame
                || !"https".equals(sourceOrigin.getScheme())
                || !APP_HOST.equals(sourceOrigin.getHost())) return;
        replyProxy = proxy;
        final String data = message.getData();
        if (data == null) return;
        try {
            JSONObject command = new JSONObject(data);
            String op = command.optString("op", "");
            switch (op) {
                case "list":
                    reply(command.optInt("requestId"), cameraCatalog());
                    break;
                case "start":
                    startRequested(command);
                    break;
                case "stop":
                    stopRequested(command.optInt("requestId"));
                    break;
                case "ack":
                    frameCredit = true;
                    break;
                case "apply":
                    applyRequested(command);
                    break;
                default:
                    replyError(command.optInt("requestId"), "Unknown native camera command: " + op);
                    break;
            }
        } catch (Exception error) {
            replyError(0, error.getMessage() == null ? error.toString() : error.getMessage());
        }
    }

    boolean onRequestPermissionsResult(int requestCode, int[] results) {
        if (requestCode != CAMERA_PERMISSION_REQUEST) return false;
        JSONObject pending = pendingPermissionStart;
        pendingPermissionStart = null;
        boolean granted = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
        if (!granted) {
            if (pending != null) replyError(pending.optInt("requestId"), "Camera permission denied");
            return true;
        }
        if (pending != null) startRequested(pending);
        return true;
    }

    boolean supported() {
        return WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
                && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER);
    }

    private JSONObject cameraCatalog() throws Exception {
        JSONObject result = new JSONObject();
        result.put("supported", supported());
        JSONArray cameras = new JSONArray();
        if (!supported()) {
            result.put("cameras", cameras);
            result.put("reason", "This Android System WebView does not support binary ArrayBuffer messages");
            return result;
        }

        for (String cameraId : cameraManager.getCameraIdList()) {
            CameraCharacteristics chars = cameraManager.getCameraCharacteristics(cameraId);
            StreamConfigurationMap map = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            Range<Integer>[] ranges = chars.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES);
            if (map == null || ranges == null) continue;
            Size[] yuvSizes = map.getOutputSizes(ImageFormat.YUV_420_888);
            Size[] gpuSizes = map.getOutputSizes(SurfaceTexture.class);
            if ((yuvSizes == null || yuvSizes.length == 0) && (gpuSizes == null || gpuSizes.length == 0)) continue;

            JSONObject camera = new JSONObject();
            camera.put("id", cameraId);
            Integer facing = chars.get(CameraCharacteristics.LENS_FACING);
            camera.put("facing", facingName(facing));
            camera.put("label", "Camera " + cameraId + " · " + facingName(facing));
            Integer orientation = chars.get(CameraCharacteristics.SENSOR_ORIENTATION);
            camera.put("sensorOrientation", orientation == null ? 0 : orientation);
            camera.put("capabilities", cameraCapabilities(chars));
            boolean manualSensor = hasCapability(chars, CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR);
            JSONArray aeRanges = new JSONArray();
            for (Range<Integer> range : ranges) aeRanges.put(range.getLower() + "-" + range.getUpper());
            camera.put("aeRanges", aeRanges);
            JSONArray modes = new JSONArray();

            Set<String> sizeKeys = new HashSet<>();
            if (yuvSizes != null) for (Size size : yuvSizes) sizeKeys.add(size.getWidth() + "x" + size.getHeight());
            if (gpuSizes != null) for (Size size : gpuSizes) sizeKeys.add(size.getWidth() + "x" + size.getHeight());
            String[] orderedKeys = sizeKeys.toArray(new String[0]);
            Arrays.sort(orderedKeys, Comparator.comparingLong(NativeCameraBridge::sizeArea));
            for (String sizeKey : orderedKeys) {
                long area = sizeArea(sizeKey);
                if (area < 640L * 480L || area > 4096L * 2160L) continue;
                Size yuvSize = findSize(yuvSizes, sizeKey);
                Size gpuSize = findSize(gpuSizes, sizeKey);
                long yuvDuration = yuvSize == null ? Long.MAX_VALUE : map.getOutputMinFrameDuration(ImageFormat.YUV_420_888, yuvSize);
                long gpuDuration = gpuSize == null ? Long.MAX_VALUE : map.getOutputMinFrameDuration(SurfaceTexture.class, gpuSize);
                for (int fps : TEST_FPS) {
                    // Keep the 30 fps menu compact, but never hide a usable native
                    // 60 fps mode merely because it is not in our old browser-size list.
                    if (fps != 60 && !STANDARD_SIZES.contains(sizeKey)) continue;
                    Range<Integer> range = chooseFpsRange(ranges, fps);
                    String pipeline = null;
                    long minDuration = Long.MAX_VALUE;
                    if (yuvSize != null && durationAllows(yuvDuration, fps)) {
                        pipeline = "yuv";
                        minDuration = yuvDuration;
                    } else if (gpuSize != null && durationAllows(gpuDuration, fps)) {
                        pipeline = "gpu";
                        minDuration = gpuDuration;
                    }
                    if (pipeline == null) continue;
                    String fpsControl = range != null ? "ae" : manualSensor && fps == 60 ? "manual" : "";
                    if (fpsControl.isEmpty()) continue;
                    Size size = pipeline.equals("yuv") ? yuvSize : gpuSize;
                    JSONObject mode = new JSONObject();
                    mode.put("key", sizeKey + "@" + fps + ":" + pipeline + ":" + fpsControl);
                    mode.put("width", size.getWidth());
                    mode.put("height", size.getHeight());
                    mode.put("fps", fps);
                    mode.put("pipeline", pipeline);
                    mode.put("fpsControl", fpsControl);
                    mode.put("fixedFps", range == null || range.getLower() == fps && range.getUpper() == fps);
                    mode.put("fpsMin", range == null ? fps : range.getLower());
                    mode.put("fpsMax", range == null ? fps : range.getUpper());
                    mode.put("minFrameDurationNs", minDuration);
                    mode.put("yuvMinFrameDurationNs", yuvSize == null ? 0 : yuvDuration);
                    mode.put("gpuMinFrameDurationNs", gpuSize == null ? 0 : gpuDuration);
                    modes.put(mode);
                }
            }
            camera.put("modes", modes);
            cameras.put(camera);
        }
        result.put("cameras", cameras);
        return result;
    }

    private static long sizeArea(String key) {
        int split = key.indexOf('x');
        if (split <= 0) return Long.MAX_VALUE;
        try {
            return (long) Integer.parseInt(key.substring(0, split)) * Integer.parseInt(key.substring(split + 1));
        } catch (NumberFormatException ignored) {
            return Long.MAX_VALUE;
        }
    }

    private static Size findSize(Size[] sizes, String key) {
        if (sizes == null) return null;
        for (Size size : sizes) {
            if ((size.getWidth() + "x" + size.getHeight()).equals(key)) return size;
        }
        return null;
    }

    private static boolean durationAllows(long minDurationNs, int fps) {
        if (minDurationNs <= 0) return true;
        return minDurationNs <= Math.round(1_000_000_000.0 / fps * 1.01);
    }

    private static Range<Integer> chooseFpsRange(Range<Integer>[] ranges, int fps) {
        Range<Integer> best = null;
        for (Range<Integer> range : ranges) {
            if (range.getLower() == fps && range.getUpper() == fps) return range;
            if (range.getUpper() < fps || range.getLower() > fps) continue;
            if (best == null
                    || range.getUpper() < best.getUpper()
                    || range.getUpper().equals(best.getUpper()) && range.getLower() > best.getLower()) {
                best = range;
            }
        }
        return best;
    }

    private static String facingName(Integer facing) {
        if (facing == null) return "unknown";
        if (facing == CameraCharacteristics.LENS_FACING_BACK) return "rear";
        if (facing == CameraCharacteristics.LENS_FACING_FRONT) return "front";
        if (facing == CameraCharacteristics.LENS_FACING_EXTERNAL) return "external";
        return "unknown";
    }

    private void startRequested(JSONObject command) {
        final int requestId = command.optInt("requestId");
        if (!supported()) {
            replyError(requestId, "Native binary camera bridge unavailable in this Android System WebView");
            return;
        }
        if (activity.checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            pendingPermissionStart = command;
            activity.requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA_PERMISSION_REQUEST);
            return;
        }
        final String cameraId = command.optString("cameraId", "");
        final int width = command.optInt("width");
        final int height = command.optInt("height");
        final int fps = command.optInt("fps");
        final String pipeline = command.optString("pipeline", "yuv");
        final String fpsControl = command.optString("fpsControl", "ae");
        cameraHandler.post(() -> startCamera(requestId, cameraId, width, height, fps, pipeline, fpsControl));
    }

    @SuppressLint("MissingPermission")
    private void startCamera(int requestId, String cameraId, int width, int height, int fps, String pipeline, String fpsControl) {
        stopCameraInternal();
        final long generation = cameraGeneration;
        try {
            if (cameraId.isEmpty()) throw new IllegalArgumentException("No Camera2 camera selected");
            CameraCharacteristics chars = cameraManager.getCameraCharacteristics(cameraId);
            StreamConfigurationMap map = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            Range<Integer>[] ranges = chars.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES);
            if (map == null || ranges == null) throw new IllegalStateException("Camera has no YUV configuration map");

            boolean gpu = "gpu".equals(pipeline);
            Size[] sizes = gpu ? map.getOutputSizes(SurfaceTexture.class) : map.getOutputSizes(ImageFormat.YUV_420_888);
            Size requestedSize = findSize(sizes, width + "x" + height);
            if (requestedSize == null) throw new IllegalArgumentException(width + "x" + height + " " + (gpu ? "PRIVATE/GPU" : "YUV") + " unavailable on camera " + cameraId);
            Range<Integer> range = chooseFpsRange(ranges, fps);
            boolean manualFps = "manual".equals(fpsControl);
            long minDuration = gpu
                    ? map.getOutputMinFrameDuration(SurfaceTexture.class, requestedSize)
                    : map.getOutputMinFrameDuration(ImageFormat.YUV_420_888, requestedSize);
            if (!durationAllows(minDuration, fps) || !manualFps && range == null) {
                throw new IllegalArgumentException(width + "x" + height + " @ " + fps + " fps unavailable on camera " + cameraId + " via " + pipeline);
            }
            if (manualFps && !hasCapability(chars, CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR)) {
                throw new IllegalArgumentException("Manual sensor FPS control unavailable on camera " + cameraId);
            }

            activeCameraId = cameraId;
            activeWidth = width;
            activeHeight = height;
            activeRequestedFps = fps;
            activeFpsRange = range != null ? range : new Range<>(fps, fps);
            activeMinFrameDurationNs = minDuration;
            activePipeline = gpu ? "gpu" : "yuv";
            activeFpsControl = manualFps ? "manual" : "ae";
            activeFrameDurationNs = Math.max(minDuration, Math.round(1_000_000_000.0 / fps));
            activeCharacteristics = chars;
            Integer sensorOrientation = chars.get(CameraCharacteristics.SENSOR_ORIENTATION);
            activeSensorOrientation = sensorOrientation == null ? 0 : sensorOrientation;
            activeFacing = facingName(chars.get(CameraCharacteristics.LENS_FACING));
            frameCredit = false;
            metadataByTimestamp.clear();
            activeSettingsEpoch = 1;
            lastReportedAfState = -1;
            lastReportedAeState = -1;

            if (gpu) {
                gpuReader = new NativeGpuCameraReader(cameraHandler, new NativeGpuCameraReader.Sink() {
                    @Override
                    public boolean takeFrameCredit() {
                        if (!running || !frameCredit || generation != cameraGeneration) return false;
                        frameCredit = false;
                        return true;
                    }

                    @Override
                    public void onFrame(byte[] bytes, long timestampNs) {
                        FrameMetadata metadata = metadataByTimestamp.remove(timestampNs);
                        if (metadata == null) {
                            frameCredit = true;
                            return;
                        }
                        sendFrame(packFrame(bytes, width, height, width, metadata, 1));
                    }

                    @Override
                    public void onError(String message) {
                        frameCredit = true;
                    }
                });
                captureSurface = gpuReader.open(width, height);
            } else {
                imageReader = ImageReader.newInstance(width, height, ImageFormat.YUV_420_888, 2);
                imageReader.setOnImageAvailableListener(this::onImageAvailable, cameraHandler);
                captureSurface = imageReader.getSurface();
            }
            cameraManager.openCamera(cameraId, new CameraDevice.StateCallback() {
                @Override
                public void onOpened(CameraDevice camera) {
                    if (generation != cameraGeneration) {
                        camera.close();
                        return;
                    }
                    cameraDevice = camera;
                    configureSession(requestId, chars, generation);
                }

                @Override
                public void onDisconnected(CameraDevice camera) {
                    camera.close();
                    if (generation != cameraGeneration) return;
                    if (cameraDevice == camera) cameraDevice = null;
                    running = false;
                    replyError(requestId, "Camera2 disconnected");
                }

                @Override
                public void onError(CameraDevice camera, int error) {
                    camera.close();
                    if (generation != cameraGeneration) return;
                    if (cameraDevice == camera) cameraDevice = null;
                    running = false;
                    replyError(requestId, "Camera2 open error " + error);
                }
            }, cameraHandler);
        } catch (Exception error) {
            stopCameraInternal();
            replyError(requestId, error.getMessage() == null ? error.toString() : error.getMessage());
        }
    }

    private void configureSession(int requestId, CameraCharacteristics chars, long generation) {
        CameraDevice camera = cameraDevice;
        Surface target = captureSurface;
        if (camera == null || target == null || generation != cameraGeneration) return;
        try {
            CaptureRequest.Builder builder = camera.createCaptureRequest(CameraDevice.TEMPLATE_RECORD);
            activeBuilder = builder;
            builder.addTarget(target);
            builder.set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO);
            int[] videoStabilization = chars.get(CameraCharacteristics.CONTROL_AVAILABLE_VIDEO_STABILIZATION_MODES);
            if (contains(videoStabilization, CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE_OFF))
                builder.set(CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE, CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE_OFF);
            int[] opticalStabilization = chars.get(CameraCharacteristics.LENS_INFO_AVAILABLE_OPTICAL_STABILIZATION);
            if (contains(opticalStabilization, CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE_OFF))
                builder.set(CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE, CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE_OFF);
            int[] edgeModes = chars.get(CameraCharacteristics.EDGE_AVAILABLE_EDGE_MODES);
            if (contains(edgeModes, CaptureRequest.EDGE_MODE_FAST)) builder.set(CaptureRequest.EDGE_MODE, CaptureRequest.EDGE_MODE_FAST);
            int[] noiseModes = chars.get(CameraCharacteristics.NOISE_REDUCTION_AVAILABLE_NOISE_REDUCTION_MODES);
            if (contains(noiseModes, CaptureRequest.NOISE_REDUCTION_MODE_FAST))
                builder.set(CaptureRequest.NOISE_REDUCTION_MODE, CaptureRequest.NOISE_REDUCTION_MODE_FAST);
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
            builder.setTag(activeSettingsEpoch);
            CaptureRequest request = builder.build();

            CameraCaptureSession.StateCallback callback = new CameraCaptureSession.StateCallback() {
                @Override
                public void onConfigured(CameraCaptureSession session) {
                    if (cameraDevice != camera || generation != cameraGeneration) {
                        session.close();
                        return;
                    }
                    captureSession = session;
                    try {
                        session.setRepeatingRequest(request, captureCallback, cameraHandler);
                        running = true;
                        frameCredit = false;
                        JSONObject started = new JSONObject();
                        started.put("cameraId", activeCameraId);
                        started.put("width", activeWidth);
                        started.put("height", activeHeight);
                        started.put("fps", activeRequestedFps);
                        started.put("fpsMin", activeFpsRange.getLower());
                        started.put("fpsMax", activeFpsRange.getUpper());
                        started.put("fixedFps", activeFpsRange.getLower().equals(activeFpsRange.getUpper()));
                        started.put("minFrameDurationNs", activeMinFrameDurationNs);
                        started.put("sensorOrientation", activeSensorOrientation);
                        started.put("facing", activeFacing);
                        started.put("pipeline", activePipeline);
                        started.put("fpsControl", activeFpsControl);
                        started.put("capabilities", cameraCapabilities(chars));
                        started.put("settings", currentSettingsJson());
                        started.put("sessionParameters", Build.VERSION.SDK_INT >= Build.VERSION_CODES.P);
                        reply(requestId, started);
                    } catch (Exception error) {
                        stopCameraInternal();
                        replyError(requestId, error.getMessage() == null ? error.toString() : error.getMessage());
                    }
                }

                @Override
                public void onConfigureFailed(CameraCaptureSession session) {
                    session.close();
                    stopCameraInternal();
                    replyError(requestId, "Camera2 capture session configuration failed");
                }
            };

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                createSessionApi28(camera, target, request, callback);
            } else {
                camera.createCaptureSession(Collections.singletonList(target), callback, cameraHandler);
            }
        } catch (CameraAccessException error) {
            stopCameraInternal();
            replyError(requestId, error.getMessage() == null ? error.toString() : error.getMessage());
        }
    }

    @TargetApi(Build.VERSION_CODES.P)
    private void createSessionApi28(
            CameraDevice camera,
            Surface target,
            CaptureRequest request,
            CameraCaptureSession.StateCallback callback) throws CameraAccessException {
        OutputConfiguration output = new OutputConfiguration(target);
        SessionConfiguration session = new SessionConfiguration(
                SessionConfiguration.SESSION_REGULAR,
                Collections.singletonList(output),
                command -> cameraHandler.post(command),
                callback);
        session.setSessionParameters(request);
        camera.createCaptureSession(session);
    }

    private final CameraCaptureSession.CaptureCallback captureCallback = new CameraCaptureSession.CaptureCallback() {
        @Override
        public void onCaptureCompleted(CameraCaptureSession session, CaptureRequest request, TotalCaptureResult result) {
            Long exposure = result.get(CaptureResult.SENSOR_EXPOSURE_TIME);
            Integer iso = result.get(CaptureResult.SENSOR_SENSITIVITY);
            Float focus = result.get(CaptureResult.LENS_FOCUS_DISTANCE);
            Integer afMode = result.get(CaptureResult.CONTROL_AF_MODE);
            Integer aeMode = result.get(CaptureResult.CONTROL_AE_MODE);
            Integer afState = result.get(CaptureResult.CONTROL_AF_STATE);
            Integer aeState = result.get(CaptureResult.CONTROL_AE_STATE);
            Integer comp = result.get(CaptureResult.CONTROL_AE_EXPOSURE_COMPENSATION);
            Long timestamp = result.get(CaptureResult.SENSOR_TIMESTAMP);
            Long frameDuration = result.get(CaptureResult.SENSOR_FRAME_DURATION);
            Long rollingSkew = result.get(CaptureResult.SENSOR_ROLLING_SHUTTER_SKEW);
            if (exposure != null) currentExposureTimeNs = exposure;
            if (iso != null) currentIso = iso;
            if (focus != null) currentFocusDistance = focus;
            if (afMode != null) currentFocusMode = focusModeName(afMode);
            if (aeMode != null) currentExposureMode = aeMode == CaptureRequest.CONTROL_AE_MODE_OFF ? "manual" : "continuous";
            if (afState != null) lastReportedAfState = afState;
            if (aeState != null) lastReportedAeState = aeState;
            if (timestamp != null) {
                FrameMetadata metadata = new FrameMetadata();
                metadata.frameNumber = result.getFrameNumber();
                metadata.timestampNs = timestamp;
                metadata.exposureNs = exposure == null ? 0 : exposure;
                metadata.frameDurationNs = frameDuration == null ? 0 : frameDuration;
                metadata.rollingShutterSkewNs = rollingSkew == null ? 0 : rollingSkew;
                metadata.focusDistance = focus == null ? Float.NaN : focus;
                metadata.iso = iso == null ? 0 : iso;
                metadata.afState = afState == null ? -1 : afState;
                metadata.aeState = aeState == null ? -1 : aeState;
                Object tag = request.getTag();
                metadata.settingsEpoch = tag instanceof Integer ? (Integer) tag : activeSettingsEpoch;
                metadataByTimestamp.put(timestamp, metadata);
            }
            if (comp != null && activeCharacteristics != null) {
                Rational step = activeCharacteristics.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_STEP);
                currentExposureCompensationEv = comp * (step == null ? 1.0 : step.doubleValue());
            }
            long now = System.nanoTime();
            if (now - lastSettingsEventNs >= 1_000_000_000L) {
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
        Integer maxAfRegions = chars.get(CameraCharacteristics.CONTROL_MAX_REGIONS_AF);
        Integer maxAeRegions = chars.get(CameraCharacteristics.CONTROL_MAX_REGIONS_AE);
        caps.put("pointsOfInterest", (maxAfRegions != null && maxAfRegions > 0) ||
                (maxAeRegions != null && maxAeRegions > 0));

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
        settings.put("afState", lastReportedAfState);
        settings.put("aeState", lastReportedAeState);
        settings.put("settingsEpoch", activeSettingsEpoch);
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
                if (patch.has("pointsOfInterest")) applyMeteringRegions(builder, patch.optJSONArray("pointsOfInterest"));
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
                    } else if ("manual".equals(activeFpsControl)) {
                        // This stream can sustain the requested frame duration,
                        // but the HAL did not advertise a matching hardware-AE
                        // FPS range. Keep sensor timing manual rather than asking
                        // AE for an unsupported range. AutoOptics can still read
                        // the current exposure/ISO as its baseline and then tune
                        // the same manual sensor controls.
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

                activeSettingsEpoch++;
                builder.setTag(activeSettingsEpoch);
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

    private void applyMeteringRegions(CaptureRequest.Builder builder, JSONArray points) throws Exception {
        if (points == null || points.length() == 0 || activeCharacteristics == null) return;
        JSONObject point = points.optJSONObject(0);
        if (point == null) return;
        double nx = Math.max(0, Math.min(1, point.optDouble("x", 0.5)));
        double ny = Math.max(0, Math.min(1, point.optDouble("y", 0.5)));
        Rect active = activeCharacteristics.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE);
        Rect crop = builder.get(CaptureRequest.SCALER_CROP_REGION);
        Rect bounds = crop != null ? crop : active;
        if (bounds == null || bounds.width() <= 0 || bounds.height() <= 0) return;

        // Decoder geometry is expressed in the unrotated Camera2 output buffer,
        // which shares sensor active-array axes. Preview rotation is visual only.
        int cx = bounds.left + (int) Math.round(nx * bounds.width());
        int cy = bounds.top + (int) Math.round(ny * bounds.height());
        int half = Math.max(24, Math.min(bounds.width(), bounds.height()) / 12);
        int left = Math.max(bounds.left, cx - half);
        int top = Math.max(bounds.top, cy - half);
        int right = Math.min(bounds.right, cx + half);
        int bottom = Math.min(bounds.bottom, cy + half);
        MeteringRectangle region = new MeteringRectangle(
                new Rect(left, top, Math.max(left + 1, right), Math.max(top + 1, bottom)),
                MeteringRectangle.METERING_WEIGHT_MAX);
        Integer maxAf = activeCharacteristics.get(CameraCharacteristics.CONTROL_MAX_REGIONS_AF);
        Integer maxAe = activeCharacteristics.get(CameraCharacteristics.CONTROL_MAX_REGIONS_AE);
        if (maxAf != null && maxAf > 0) builder.set(CaptureRequest.CONTROL_AF_REGIONS, new MeteringRectangle[]{region});
        if (maxAe != null && maxAe > 0) builder.set(CaptureRequest.CONTROL_AE_REGIONS, new MeteringRectangle[]{region});
    }

    private static boolean contains(int[] values, int wanted) {
        if (values == null) return false;
        for (int value : values) if (value == wanted) return true;
        return false;
    }

    private void onImageAvailable(ImageReader reader) {
        Image image = null;
        try {
            image = reader.acquireLatestImage();
            if (image == null || !running || !frameCredit) return;
            FrameMetadata metadata = metadataByTimestamp.remove(image.getTimestamp());
            if (metadata == null) return;
            byte[] frame = copyFrame(image, metadata);
            frameCredit = false;
            sendFrame(frame);
        } catch (Exception ignored) {
            frameCredit = true;
        } finally {
            if (image != null) image.close();
        }
    }

    private byte[] copyFrame(Image image, FrameMetadata metadata) {
        int width = image.getWidth();
        int height = image.getHeight();
        Image.Plane plane = image.getPlanes()[0];
        ByteBuffer source = plane.getBuffer();
        int rowStride = plane.getRowStride();
        int pixelStride = plane.getPixelStride();
        int base = source.position();
        byte[] output = new byte[FRAME_HEADER_BYTES + width * height];
        writeFrameHeader(output, width, height, width, metadata, 0);
        if (pixelStride == 1 && rowStride == width) {
            ByteBuffer copy = source.duplicate();
            copy.position(base);
            copy.get(output, FRAME_HEADER_BYTES, width * height);
        } else if (pixelStride == 1) {
            ByteBuffer copy = source.duplicate();
            for (int row = 0; row < height; row++) {
                copy.position(base + row * rowStride);
                copy.get(output, FRAME_HEADER_BYTES + row * width, width);
            }
        } else {
            for (int row = 0; row < height; row++) {
                int rowBase = base + row * rowStride;
                int outBase = FRAME_HEADER_BYTES + row * width;
                for (int x = 0; x < width; x++) output[outBase + x] = source.get(rowBase + x * pixelStride);
            }
        }
        return output;
    }

    private byte[] packFrame(byte[] y, int width, int height, int stride, FrameMetadata metadata, int pipeline) {
        byte[] output = new byte[FRAME_HEADER_BYTES + y.length];
        writeFrameHeader(output, width, height, stride, metadata, pipeline);
        System.arraycopy(y, 0, output, FRAME_HEADER_BYTES, y.length);
        return output;
    }

    private void writeFrameHeader(byte[] output, int width, int height, int stride,
                                  FrameMetadata metadata, int pipeline) {
        ByteBuffer header = ByteBuffer.wrap(output).order(ByteOrder.LITTLE_ENDIAN);
        header.putInt(FRAME_MAGIC);
        header.putShort((short) FRAME_HEADER_BYTES);
        header.putShort((short) 1);
        header.putInt(width);
        header.putInt(height);
        header.putInt(stride);
        header.putInt(activeSensorOrientation);
        header.putLong(metadata.frameNumber);
        header.putLong(metadata.timestampNs);
        header.putLong(metadata.exposureNs);
        header.putLong(metadata.frameDurationNs);
        header.putLong(metadata.rollingShutterSkewNs);
        header.putFloat(metadata.focusDistance);
        header.putInt(metadata.iso);
        header.putInt(metadata.afState);
        header.putInt(metadata.aeState);
        header.putInt(metadata.settingsEpoch);
        header.putInt(pipeline);
    }

    private void sendFrame(byte[] bytes) {
        activity.runOnUiThread(() -> {
            JavaScriptReplyProxy proxy = replyProxy;
            if (!running || proxy == null) {
                frameCredit = true;
                return;
            }
            try {
                proxy.postMessage(bytes);
            } catch (Exception ignored) {
                frameCredit = true;
            }
        });
    }

    private void cancelPendingPermissionStart() {
        JSONObject pending = pendingPermissionStart;
        pendingPermissionStart = null;
        if (pending != null) replyError(pending.optInt("requestId"), "Camera start cancelled");
    }

    private void stopRequested(int requestId) {
        cancelPendingPermissionStart();
        cameraHandler.post(() -> {
            stopCameraInternal();
            try {
                reply(requestId, new JSONObject().put("stopped", true));
            } catch (Exception error) {
                replyError(requestId, error.toString());
            }
        });
    }

    void stop() {
        cancelPendingPermissionStart();
        cameraHandler.post(this::stopCameraInternal);
    }

    private void stopCameraInternal() {
        cameraGeneration++;
        running = false;
        frameCredit = false;
        try {
            if (captureSession != null) captureSession.close();
        } catch (Exception ignored) {
        }
        captureSession = null;
        try {
            if (cameraDevice != null) cameraDevice.close();
        } catch (Exception ignored) {
        }
        cameraDevice = null;
        try {
            if (imageReader != null) imageReader.close();
        } catch (Exception ignored) {
        }
        imageReader = null;
        try {
            if (gpuReader != null) gpuReader.close();
        } catch (Exception ignored) {
        }
        gpuReader = null;
        captureSurface = null;
        activeCameraId = "";
        activePipeline = "yuv";
        activeFpsControl = "ae";
        activeCharacteristics = null;
        activeBuilder = null;
        currentFocusDistance = null;
        currentExposureTimeNs = null;
        currentIso = null;
        lastSettingsEventNs = 0;
        lastReportedAfState = -1;
        lastReportedAeState = -1;
        metadataByTimestamp.clear();
    }

    void close() {
        stopCameraInternal();
        cameraThread.quitSafely();
    }

    private void reply(int requestId, JSONObject payload) {
        try {
            payload.put("requestId", requestId);
            payload.put("ok", true);
            postString(payload.toString());
        } catch (Exception error) {
            replyError(requestId, error.toString());
        }
    }

    private void replyError(int requestId, String message) {
        try {
            JSONObject payload = new JSONObject();
            payload.put("requestId", requestId);
            payload.put("ok", false);
            payload.put("error", message == null ? "Native camera error" : message);
            postString(payload.toString());
        } catch (Exception ignored) {
        }
    }

    private void postString(String value) {
        activity.runOnUiThread(() -> {
            JavaScriptReplyProxy proxy = replyProxy;
            if (proxy == null) return;
            try {
                proxy.postMessage(value);
            } catch (Exception ignored) {
            }
        });
    }
}
