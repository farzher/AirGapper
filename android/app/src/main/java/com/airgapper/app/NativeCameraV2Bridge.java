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
import android.hardware.camera2.CameraConstrainedHighSpeedCaptureSession;
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
import android.media.MediaCodec;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Base64;
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
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Camera2 v2 backend.
 *
 * Unlike the legacy bridge, full-resolution pixels never cross WebView. JS owns
 * AirGapper policy and sends tiny decode plans; Camera2 feeds the same C++ codec
 * through JNI and only compact QR results/metrics return to JS.
 */
final class NativeCameraV2Bridge {
    static final int CAMERA_PERMISSION_REQUEST = 14;

    private static final String APP_HOST = "appassets.androidplatform.net";
    private static final String APP_ORIGIN = "https://" + APP_HOST;
    private static final String OBJECT_NAME = "AirGapperNativeCameraV2";
    private static final int[] REGULAR_TEST_FPS = {30, 60};
    private static final Set<String> STANDARD_SIZES = new HashSet<>(Arrays.asList(
            "640x480", "960x720", "1280x720", "1280x960", "1920x1080",
            "2560x1440", "3840x2160"));
    private static final int PREVIEW_MAGIC = 0x32565041; // APV2
    private static final int PREVIEW_HEADER_BYTES = 28;
    private static final long PREVIEW_INTERVAL_NS = 33_333_333L;
    private static final long PREVIEW_FALLBACK_INTERVAL_NS = 100_000_000L;
    private static final long BINARY_ACK_GRACE_NS = 350_000_000L;

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

    private static final class DecodePlan {
        static final int MODE_FULL = 0;
        static final int MODE_GUIDED = 1;

        int mode;
        int jobId;
        int sourceSequence;
        int cropX;
        int cropY;
        int cropWidth;
        int cropHeight;
        boolean tryHarder = true;
        boolean tryDownscale;
        boolean returnErrors = true;
        int maxSymbols = 8;
        int[] ids = new int[0];
        int[] dimensions = new int[0];
        float[] quads = new float[0];
        int fallbackMask;
        int repairMask;

        static DecodePlan parse(JSONObject value) throws Exception {
            if (value == null) throw new IllegalArgumentException("Missing native decode plan");
            DecodePlan plan = new DecodePlan();
            String mode = value.optString("mode", "full");
            plan.mode = "guided".equals(mode) ? MODE_GUIDED : MODE_FULL;
            plan.jobId = value.getInt("jobId");
            plan.sourceSequence = value.optInt("sourceSequence", plan.jobId);
            plan.cropX = Math.max(0, value.optInt("cropX", 0));
            plan.cropY = Math.max(0, value.optInt("cropY", 0));
            plan.cropWidth = Math.max(0, value.optInt("cropWidth", 0));
            plan.cropHeight = Math.max(0, value.optInt("cropHeight", 0));
            plan.tryHarder = value.optBoolean("tryHarder", true);
            plan.tryDownscale = value.optBoolean("tryDownscale", false);
            plan.returnErrors = value.optBoolean("returnErrors", true);
            plan.maxSymbols = Math.max(1, Math.min(32, value.optInt("maxSymbols", 8)));
            plan.fallbackMask = value.optInt("fallbackMask", -1);
            plan.repairMask = value.optInt("repairMask", -1);
            if (plan.mode == MODE_GUIDED) {
                JSONArray tracks = value.optJSONArray("tracks");
                int count = tracks == null ? 0 : Math.min(32, tracks.length());
                if (count <= 0) throw new IllegalArgumentException("Guided native plan has no tracks");
                plan.ids = new int[count];
                plan.dimensions = new int[count];
                plan.quads = new float[count * 8];
                for (int i = 0; i < count; i++) {
                    JSONObject track = tracks.getJSONObject(i);
                    plan.ids[i] = track.optInt("slot", track.optInt("id", i));
                    plan.dimensions[i] = track.getInt("dim");
                    JSONArray quad = track.getJSONArray("quad");
                    if (quad.length() != 8) throw new IllegalArgumentException("Native track quad must contain 8 numbers");
                    for (int j = 0; j < 8; j++) plan.quads[i * 8 + j] = (float) quad.getDouble(j);
                }
            }
            return plan;
        }
    }

    private final Activity activity;
    private final CameraManager cameraManager;
    private final HandlerThread cameraThread = new HandlerThread("AirGapperCamera2V2");
    private final HandlerThread decodeThread = new HandlerThread("AirGapperNativeDecode");
    private final Handler cameraHandler;
    private final Handler decodeHandler;
    private final Object planLock = new Object();

    private volatile JavaScriptReplyProxy replyProxy;
    private volatile boolean binaryTransportAcked;
    private volatile boolean binaryFallbackActive;
    private volatile long firstBinaryPostNs;
    private volatile boolean running;
    private volatile boolean decodeBusy;
    private DecodePlan pendingPlan;
    private DecodePlan reservedGpuPlan;
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
    private int activeDecodeFps;
    private int activeSensorFps;
    private boolean activeHighSpeed;
    private Range<Integer> activeFpsRange;
    private long activeMinFrameDurationNs;
    private long activeFrameDurationNs;
    private int activeSensorOrientation;
    private String activeFacing = "unknown";
    private String activePipeline = "yuv";
    private String activeFpsControl = "ae";
    private CameraCharacteristics activeCharacteristics;
    private CaptureRequest.Builder activeBuilder;
    private String currentFocusMode = "continuous";
    private String currentExposureMode = "continuous";
    private Float currentFocusDistance;
    private Long currentExposureTimeNs;
    private Integer currentIso;
    private double currentExposureCompensationEv;
    private int activeSettingsEpoch = 1;
    private int lastReportedAfState = -1;
    private int lastReportedAeState = -1;
    private long lastSettingsEventNs;
    private long lastPreviewNs;
    private long lastSensorTimestampNs;
    private long lastFrameEventTimestampNs;
    private double measuredFrameDurationNs;
    private double measuredFps;
    private boolean pixelStrideWarningSent;

    private final LinkedHashMap<Long, FrameMetadata> metadataByTimestamp = new LinkedHashMap<Long, FrameMetadata>() {
        @Override protected boolean removeEldestEntry(Map.Entry<Long, FrameMetadata> eldest) { return size() > 32; }
    };

    NativeCameraV2Bridge(Activity activity, WebView webView) {
        this.activity = activity;
        cameraManager = (CameraManager) activity.getSystemService(Context.CAMERA_SERVICE);
        cameraThread.start();
        decodeThread.start();
        cameraHandler = new Handler(cameraThread.getLooper());
        decodeHandler = new Handler(decodeThread.getLooper());
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;
        WebViewCompat.addWebMessageListener(webView, OBJECT_NAME, Collections.singleton(APP_ORIGIN), this::onWebMessage);
    }

    boolean supported() {
        return WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
                && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER);
    }

    private void onWebMessage(WebView view, WebMessageCompat message, android.net.Uri sourceOrigin,
                              boolean isMainFrame, JavaScriptReplyProxy proxy) {
        if (!isMainFrame || !"https".equals(sourceOrigin.getScheme()) || !APP_HOST.equals(sourceOrigin.getHost())) return;
        replyProxy = proxy;
        String data = message.getData();
        if (data == null) return;
        try {
            JSONObject command = new JSONObject(data);
            String op = command.optString("op", "");
            switch (op) {
                case "list": reply(command.optInt("requestId"), cameraCatalog()); break;
                case "start": startRequested(command); break;
                case "stop": stopRequested(command.optInt("requestId")); break;
                case "apply": applyRequested(command); break;
                case "plan": setDecodePlan(DecodePlan.parse(command.optJSONObject("plan"))); break;
                case "binaryAck": binaryTransportAcked = true; binaryFallbackActive = false; break;
                default: replyError(command.optInt("requestId"), "Unknown Camera2 v2 command: " + op); break;
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

    private void setDecodePlan(DecodePlan plan) {
        synchronized (planLock) { pendingPlan = plan; }
    }

    private DecodePlan claimPlan() {
        synchronized (planLock) {
            if (decodeBusy || pendingPlan == null) return null;
            DecodePlan plan = pendingPlan;
            pendingPlan = null;
            decodeBusy = true;
            return plan;
        }
    }

    private void releaseDecode() {
        synchronized (planLock) { decodeBusy = false; }
    }

    private JSONObject cameraCatalog() throws Exception {
        JSONObject result = new JSONObject();
        result.put("supported", supported());
        JSONArray cameras = new JSONArray();
        result.put("cameras", cameras);
        if (!supported()) {
            result.put("reason", "Android System WebView does not support binary ArrayBuffer messages");
            return result;
        }

        for (String cameraId : cameraManager.getCameraIdList()) {
            CameraCharacteristics chars = cameraManager.getCameraCharacteristics(cameraId);
            StreamConfigurationMap map = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            Range<Integer>[] aeRanges = chars.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES);
            if (map == null || aeRanges == null) continue;
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
            Integer level = chars.get(CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL);
            camera.put("hardwareLevel", hardwareLevelName(level));
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                JSONArray physical = new JSONArray();
                for (String id : chars.getPhysicalCameraIds()) physical.put(id);
                camera.put("physicalCameraIds", physical);
            }
            camera.put("capabilities", cameraCapabilities(chars, false));
            boolean manualSensor = hasCapability(chars, CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR);
            boolean constrainedHighSpeed = hasCapability(chars, CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_CONSTRAINED_HIGH_SPEED_VIDEO);
            camera.put("manualSensor", manualSensor);
            camera.put("constrainedHighSpeed", constrainedHighSpeed);
            JSONArray rangesJson = new JSONArray();
            for (Range<Integer> range : aeRanges) rangesJson.put(range.getLower() + "-" + range.getUpper());
            camera.put("aeRanges", rangesJson);

            JSONObject outputs = new JSONObject();
            outputs.put("yuv", imageFormatOutputCatalog(map, ImageFormat.YUV_420_888));
            outputs.put("surfaceTexture", classOutputCatalog(map, SurfaceTexture.class));
            outputs.put("mediaRecorder", classOutputCatalog(map, MediaRecorder.class));
            outputs.put("mediaCodec", classOutputCatalog(map, MediaCodec.class));
            camera.put("outputs", outputs);

            JSONArray modes = new JSONArray();
            Set<String> sizeKeys = new HashSet<>();
            if (yuvSizes != null) for (Size size : yuvSizes) sizeKeys.add(sizeKey(size));
            if (gpuSizes != null) for (Size size : gpuSizes) sizeKeys.add(sizeKey(size));
            String[] ordered = sizeKeys.toArray(new String[0]);
            Arrays.sort(ordered, Comparator.comparingLong(NativeCameraV2Bridge::sizeArea));
            for (String key : ordered) {
                long area = sizeArea(key);
                if (area < 640L * 480L || area > 4096L * 2160L) continue;
                Size yuv = findSize(yuvSizes, key);
                Size gpu = findSize(gpuSizes, key);
                long yuvDuration = yuv == null ? Long.MAX_VALUE : map.getOutputMinFrameDuration(ImageFormat.YUV_420_888, yuv);
                long gpuDuration = gpu == null ? Long.MAX_VALUE : map.getOutputMinFrameDuration(SurfaceTexture.class, gpu);
                for (int fps : REGULAR_TEST_FPS) {
                    if (fps != 60 && !STANDARD_SIZES.contains(key)) continue;
                    Range<Integer> range = chooseFpsRange(aeRanges, fps);
                    String pipeline = null;
                    long minDuration = Long.MAX_VALUE;
                    Size size = null;
                    if (yuv != null && durationAllows(yuvDuration, fps)) {
                        pipeline = "yuv"; minDuration = yuvDuration; size = yuv;
                    } else if (gpu != null && durationAllows(gpuDuration, fps)) {
                        pipeline = "gpu"; minDuration = gpuDuration; size = gpu;
                    }
                    if (pipeline == null) continue;
                    String fpsControl = range != null ? "ae" : manualSensor ? "manual" : "";
                    if (fpsControl.isEmpty()) continue;
                    JSONObject mode = new JSONObject();
                    mode.put("key", key + "@" + fps + ":" + pipeline + ":" + fpsControl);
                    mode.put("width", size.getWidth()); mode.put("height", size.getHeight());
                    mode.put("fps", fps); mode.put("sensorFps", fps);
                    mode.put("pipeline", pipeline); mode.put("fpsControl", fpsControl);
                    mode.put("highSpeed", false);
                    mode.put("fixedFps", range == null || range.getLower() == fps && range.getUpper() == fps);
                    mode.put("fpsMin", range == null ? fps : range.getLower());
                    mode.put("fpsMax", range == null ? fps : range.getUpper());
                    mode.put("minFrameDurationNs", minDuration);
                    modes.put(mode);
                }
            }

            JSONArray highSpeedJson = new JSONArray();
            if (constrainedHighSpeed && gpuSizes != null) {
                Size[] highSpeedSizes;
                try { highSpeedSizes = map.getHighSpeedVideoSizes(); }
                catch (Exception ignored) { highSpeedSizes = new Size[0]; }
                if (highSpeedSizes != null) {
                    for (Size size : highSpeedSizes) {
                        Range<Integer>[] hsRanges;
                        try { hsRanges = map.getHighSpeedVideoFpsRangesFor(size); }
                        catch (Exception ignored) { continue; }
                        for (Range<Integer> range : hsRanges) {
                            JSONObject hs = new JSONObject();
                            hs.put("width", size.getWidth()); hs.put("height", size.getHeight());
                            hs.put("fpsMin", range.getLower()); hs.put("fpsMax", range.getUpper());
                            highSpeedJson.put(hs);
                        }
                        Range<Integer> best = bestHighSpeedRange(hsRanges);
                        if (best == null || best.getUpper() < 120) continue;
                        Size gpu = findSize(gpuSizes, sizeKey(size));
                        if (gpu == null) continue;
                        JSONObject mode = new JSONObject();
                        mode.put("key", sizeKey(size) + "@60:hfr:" + best.getLower() + "-" + best.getUpper());
                        mode.put("width", size.getWidth()); mode.put("height", size.getHeight());
                        mode.put("fps", 60); mode.put("sensorFps", best.getUpper());
                        mode.put("pipeline", "gpu"); mode.put("fpsControl", "high-speed");
                        mode.put("highSpeed", true); mode.put("fixedFps", best.getLower().equals(best.getUpper()));
                        mode.put("fpsMin", best.getLower()); mode.put("fpsMax", best.getUpper());
                        mode.put("minFrameDurationNs", 1_000_000_000L / Math.max(1, best.getUpper()));
                        modes.put(mode);
                    }
                }
            }
            camera.put("highSpeed", highSpeedJson);
            camera.put("modes", modes);
            cameras.put(camera);
        }
        return result;
    }

    private static JSONArray imageFormatOutputCatalog(StreamConfigurationMap map, int format) {
        JSONArray out = new JSONArray();
        try {
            Size[] sizes = map.getOutputSizes(format);
            if (sizes == null) return out;
            for (Size size : sizes) {
                JSONObject item = new JSONObject();
                item.put("width", size.getWidth()); item.put("height", size.getHeight());
                item.put("minFrameDurationNs", map.getOutputMinFrameDuration(format, size));
                out.put(item);
            }
        } catch (Exception ignored) {}
        return out;
    }

    private static JSONArray classOutputCatalog(StreamConfigurationMap map, Class<?> klass) {
        JSONArray out = new JSONArray();
        try {
            Size[] sizes = map.getOutputSizes(klass);
            if (sizes == null) return out;
            for (Size size : sizes) {
                JSONObject item = new JSONObject();
                item.put("width", size.getWidth()); item.put("height", size.getHeight());
                item.put("minFrameDurationNs", map.getOutputMinFrameDuration(klass, size));
                out.put(item);
            }
        } catch (Exception ignored) {}
        return out;
    }

    private void startRequested(JSONObject command) {
        int requestId = command.optInt("requestId");
        if (!supported()) { replyError(requestId, "Camera2 v2 binary bridge unavailable"); return; }
        if (activity.checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            pendingPermissionStart = command;
            activity.requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA_PERMISSION_REQUEST);
            return;
        }
        String cameraId = command.optString("cameraId", "");
        int width = command.optInt("width");
        int height = command.optInt("height");
        int decodeFps = command.optInt("fps", 30);
        int sensorFps = command.optInt("sensorFps", decodeFps);
        String pipeline = command.optString("pipeline", "yuv");
        String fpsControl = command.optString("fpsControl", "ae");
        boolean highSpeed = command.optBoolean("highSpeed", false);
        cameraHandler.post(() -> startCamera(requestId, cameraId, width, height, decodeFps, sensorFps, pipeline, fpsControl, highSpeed));
    }

    @SuppressLint("MissingPermission")
    private void startCamera(int requestId, String cameraId, int width, int height, int decodeFps, int sensorFps,
                             String pipeline, String fpsControl, boolean highSpeed) {
        stopCameraInternal();
        final long generation = cameraGeneration;
        try {
            if (cameraId.isEmpty()) throw new IllegalArgumentException("No Camera2 camera selected");
            CameraCharacteristics chars = cameraManager.getCameraCharacteristics(cameraId);
            StreamConfigurationMap map = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            Range<Integer>[] ranges = chars.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES);
            if (map == null || ranges == null) throw new IllegalStateException("Camera has no stream configuration map");
            boolean gpu = "gpu".equals(pipeline) || highSpeed;
            Size[] sizes = gpu ? map.getOutputSizes(SurfaceTexture.class) : map.getOutputSizes(ImageFormat.YUV_420_888);
            Size requested = findSize(sizes, width + "x" + height);
            if (requested == null) throw new IllegalArgumentException(width + "x" + height + " unavailable via " + (gpu ? "PRIVATE" : "YUV"));

            Range<Integer> range;
            long minDuration;
            if (highSpeed) {
                if (!hasCapability(chars, CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_CONSTRAINED_HIGH_SPEED_VIDEO))
                    throw new IllegalArgumentException("Constrained high-speed video unavailable on camera " + cameraId);
                range = chooseHighSpeedRange(map.getHighSpeedVideoFpsRangesFor(requested), sensorFps);
                if (range == null) throw new IllegalArgumentException("Requested HFR range unavailable");
                minDuration = 1_000_000_000L / Math.max(1, range.getUpper());
            } else {
                range = chooseFpsRange(ranges, sensorFps);
                minDuration = gpu ? map.getOutputMinFrameDuration(SurfaceTexture.class, requested)
                        : map.getOutputMinFrameDuration(ImageFormat.YUV_420_888, requested);
                boolean manualFps = "manual".equals(fpsControl);
                if (!durationAllows(minDuration, sensorFps) || !manualFps && range == null)
                    throw new IllegalArgumentException(width + "x" + height + " @ " + sensorFps + " fps unavailable via " + pipeline);
                if (manualFps && !hasCapability(chars, CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR))
                    throw new IllegalArgumentException("Manual sensor FPS unavailable");
                if (range == null) range = new Range<>(sensorFps, sensorFps);
            }

            activeCameraId = cameraId;
            activeWidth = width; activeHeight = height;
            activeDecodeFps = decodeFps; activeSensorFps = sensorFps;
            activeHighSpeed = highSpeed;
            activeFpsRange = range;
            activeMinFrameDurationNs = minDuration;
            activeFrameDurationNs = Math.max(minDuration, Math.round(1_000_000_000.0 / Math.max(1, sensorFps)));
            activePipeline = gpu ? "gpu" : "yuv";
            activeFpsControl = highSpeed ? "high-speed" : fpsControl;
            activeCharacteristics = chars;
            Integer sensorOrientation = chars.get(CameraCharacteristics.SENSOR_ORIENTATION);
            activeSensorOrientation = sensorOrientation == null ? 0 : sensorOrientation;
            activeFacing = facingName(chars.get(CameraCharacteristics.LENS_FACING));
            activeSettingsEpoch = 1;
            lastSensorTimestampNs = 0;
            lastFrameEventTimestampNs = 0;
            measuredFrameDurationNs = 0;
            measuredFps = 0;
            lastPreviewNs = 0;
            pixelStrideWarningSent = false;
            synchronized (metadataByTimestamp) { metadataByTimestamp.clear(); }
            synchronized (planLock) { pendingPlan = null; decodeBusy = false; reservedGpuPlan = null; }

            if (gpu) {
                imageReader = null;
                gpuReader = new NativeGpuCameraReader(cameraHandler, new NativeGpuCameraReader.Sink() {
                    @Override public boolean takeFrameCredit() {
                        if (!running || generation != cameraGeneration) return false;
                        DecodePlan plan = claimPlan();
                        if (plan != null) { reservedGpuPlan = plan; return true; }
                        return previewDue();
                    }
                    @Override public boolean directFrame() { return true; }
                    @Override public void onDirectFrame(ByteBuffer bytes, long timestampNs) {
                        FrameMetadata metadata = metadataForTimestamp(timestampNs);
                        maybeSendPreview(bytes, 0, width, height, width, timestampNs);
                        DecodePlan plan = reservedGpuPlan;
                        reservedGpuPlan = null;
                        if (plan == null) return;
                        try {
                            byte[] packet = decodePlan(plan, bytes, 0, width, height, width, metadata, 3);
                            if (packet != null) postBinary(packet);
                            else postEvent("decodeError", "Native GPU decode failed");
                        } finally { releaseDecode(); }
                    }
                    @Override public void onFrame(byte[] bytes, long timestampNs) { }
                    @Override public void onError(String message) {
                        reservedGpuPlan = null;
                        releaseDecode();
                        postEvent("decodeError", message);
                    }
                });
                captureSurface = gpuReader.open(width, height, 0);
            } else {
                gpuReader = null;
                imageReader = ImageReader.newInstance(width, height, ImageFormat.YUV_420_888, 3);
                imageReader.setOnImageAvailableListener(reader -> onImageAvailable(reader, generation), cameraHandler);
                captureSurface = imageReader.getSurface();
            }

            cameraManager.openCamera(cameraId, new CameraDevice.StateCallback() {
                @Override public void onOpened(CameraDevice camera) {
                    if (generation != cameraGeneration) { camera.close(); return; }
                    cameraDevice = camera;
                    configureSession(requestId, chars, generation);
                }
                @Override public void onDisconnected(CameraDevice camera) {
                    camera.close(); if (generation != cameraGeneration) return;
                    running = false; replyError(requestId, "Camera2 v2 disconnected");
                }
                @Override public void onError(CameraDevice camera, int error) {
                    camera.close(); if (generation != cameraGeneration) return;
                    running = false; replyError(requestId, "Camera2 v2 open error " + error);
                }
            }, cameraHandler);
        } catch (Exception error) {
            stopCameraInternal();
            replyError(requestId, message(error));
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
            disableStabilizationAndHeavyProcessing(builder, chars);
            if (activeHighSpeed) {
                builder.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON);
                builder.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, activeFpsRange);
                currentExposureMode = "continuous";
            } else if ("manual".equals(activeFpsControl)) {
                builder.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_OFF);
                Range<Long> exposureRange = chars.get(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE);
                Range<Integer> isoRange = chars.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE);
                long exposure = clampLong(3_500_000L, exposureRange);
                int iso = clampInt(200, isoRange);
                builder.set(CaptureRequest.SENSOR_FRAME_DURATION, activeFrameDurationNs);
                builder.set(CaptureRequest.SENSOR_EXPOSURE_TIME, Math.min(exposure, Math.max(1, activeFrameDurationNs - 100_000L)));
                builder.set(CaptureRequest.SENSOR_SENSITIVITY, iso);
                currentExposureMode = "manual"; currentExposureTimeNs = exposure; currentIso = iso;
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
            } else if (!activeHighSpeed && contains(afModes, CaptureRequest.CONTROL_AF_MODE_AUTO)) {
                builder.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_AUTO);
                currentFocusMode = "single-shot";
            } else {
                builder.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_OFF);
                currentFocusMode = "manual";
            }
            builder.setTag(activeSettingsEpoch);
            CaptureRequest request = builder.build();

            CameraCaptureSession.StateCallback callback = new CameraCaptureSession.StateCallback() {
                @Override public void onConfigured(CameraCaptureSession session) {
                    if (cameraDevice != camera || generation != cameraGeneration) { session.close(); return; }
                    captureSession = session;
                    try {
                        setRepeating(builder);
                        running = true;
                        JSONObject started = new JSONObject();
                        started.put("cameraId", activeCameraId);
                        started.put("width", activeWidth); started.put("height", activeHeight);
                        started.put("fps", activeDecodeFps); started.put("sensorFps", activeSensorFps);
                        started.put("fpsMin", activeFpsRange.getLower()); started.put("fpsMax", activeFpsRange.getUpper());
                        started.put("fixedFps", activeFpsRange.getLower().equals(activeFpsRange.getUpper()));
                        started.put("minFrameDurationNs", activeMinFrameDurationNs);
                        started.put("sensorOrientation", activeSensorOrientation);
                        started.put("facing", activeFacing); started.put("pipeline", activePipeline);
                        started.put("fpsControl", activeFpsControl); started.put("highSpeed", activeHighSpeed);
                        started.put("capabilities", cameraCapabilities(chars, activeHighSpeed));
                        started.put("settings", currentSettingsJson());
                        reply(requestId, started);
                    } catch (Exception error) { stopCameraInternal(); replyError(requestId, message(error)); }
                }
                @Override public void onConfigureFailed(CameraCaptureSession session) {
                    session.close(); stopCameraInternal(); replyError(requestId, "Camera2 v2 session configuration failed");
                }
            };

            if (activeHighSpeed) {
                camera.createConstrainedHighSpeedCaptureSession(Collections.singletonList(target), callback, cameraHandler);
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                createRegularSessionApi28(camera, target, request, callback);
            } else {
                camera.createCaptureSession(Collections.singletonList(target), callback, cameraHandler);
            }
        } catch (Exception error) {
            stopCameraInternal(); replyError(requestId, message(error));
        }
    }

    private void setRepeating(CaptureRequest.Builder builder) throws CameraAccessException {
        if (captureSession == null) return;
        builder.setTag(activeSettingsEpoch);
        CaptureRequest request = builder.build();
        if (activeHighSpeed && captureSession instanceof CameraConstrainedHighSpeedCaptureSession) {
            CameraConstrainedHighSpeedCaptureSession high = (CameraConstrainedHighSpeedCaptureSession) captureSession;
            List<CaptureRequest> burst = high.createHighSpeedRequestList(request);
            high.setRepeatingBurst(burst, captureCallback, cameraHandler);
        } else {
            captureSession.setRepeatingRequest(request, captureCallback, cameraHandler);
        }
    }

    @TargetApi(Build.VERSION_CODES.P)
    private void createRegularSessionApi28(CameraDevice camera, Surface target, CaptureRequest request,
                                           CameraCaptureSession.StateCallback callback) throws CameraAccessException {
        OutputConfiguration output = new OutputConfiguration(target);
        SessionConfiguration session = new SessionConfiguration(
                SessionConfiguration.SESSION_REGULAR,
                Collections.singletonList(output),
                command -> cameraHandler.post(command), callback);
        session.setSessionParameters(request);
        camera.createCaptureSession(session);
    }

    private final CameraCaptureSession.CaptureCallback captureCallback = new CameraCaptureSession.CaptureCallback() {
        @Override public void onCaptureCompleted(CameraCaptureSession session, CaptureRequest request, TotalCaptureResult result) {
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
                if (lastSensorTimestampNs > 0 && timestamp > lastSensorTimestampNs) {
                    long delta = timestamp - lastSensorTimestampNs;
                    measuredFrameDurationNs = measuredFrameDurationNs > 0 ? measuredFrameDurationNs * 0.86 + delta * 0.14 : delta;
                    measuredFps = 1_000_000_000.0 / Math.max(1.0, measuredFrameDurationNs);
                }
                lastSensorTimestampNs = timestamp;
                FrameMetadata metadata = new FrameMetadata();
                metadata.frameNumber = result.getFrameNumber(); metadata.timestampNs = timestamp;
                metadata.exposureNs = exposure == null ? 0 : exposure;
                metadata.frameDurationNs = frameDuration == null ? 0 : frameDuration;
                metadata.rollingShutterSkewNs = rollingSkew == null ? 0 : rollingSkew;
                metadata.focusDistance = focus == null ? Float.NaN : focus;
                metadata.iso = iso == null ? 0 : iso;
                metadata.afState = afState == null ? -1 : afState; metadata.aeState = aeState == null ? -1 : aeState;
                Object tag = request.getTag();
                metadata.settingsEpoch = tag instanceof Integer ? (Integer) tag : activeSettingsEpoch;
                synchronized (metadataByTimestamp) { metadataByTimestamp.put(timestamp, metadata); }
                maybePostFrameEvent(metadata);
            }
            if (comp != null && activeCharacteristics != null) {
                Rational step = activeCharacteristics.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_STEP);
                currentExposureCompensationEv = comp * (step == null ? 1.0 : step.doubleValue());
            }
            long now = System.nanoTime();
            if (now - lastSettingsEventNs >= 500_000_000L) {
                lastSettingsEventNs = now;
                try { JSONObject event = new JSONObject(); event.put("event", "settings"); event.put("settings", currentSettingsJson()); postString(event.toString()); }
                catch (Exception ignored) {}
            }
        }
    };

    private void maybePostFrameEvent(FrameMetadata metadata) {
        if (!running || metadata == null || metadata.timestampNs <= 0) return;
        long interval = Math.max(1L, Math.round(1_000_000_000.0 / Math.max(1, activeDecodeFps)));
        if (lastFrameEventTimestampNs > 0 &&
                metadata.timestampNs - lastFrameEventTimestampNs < Math.round(interval * 0.80)) return;
        lastFrameEventTimestampNs = metadata.timestampNs;
        try {
            JSONObject event = new JSONObject();
            event.put("event", "frame");
            event.put("width", activeWidth); event.put("height", activeHeight);
            event.put("frameNumber", metadata.frameNumber);
            event.put("timestampNs", metadata.timestampNs);
            event.put("exposureTimeNs", metadata.exposureNs);
            event.put("frameDurationNs", metadata.frameDurationNs);
            event.put("rollingShutterSkewNs", metadata.rollingShutterSkewNs);
            if (Float.isFinite(metadata.focusDistance)) event.put("focusDistance", metadata.focusDistance);
            event.put("iso", metadata.iso);
            event.put("settingsEpoch", metadata.settingsEpoch);
            event.put("orientation", activeSensorOrientation);
            event.put("sensorFps", activeSensorFps);
            event.put("measuredFps", measuredFps);
            event.put("settings", currentSettingsJson());
            postString(event.toString());
        } catch (Exception ignored) {}
    }

    private void onImageAvailable(ImageReader reader, long generation) {
        Image image = null;
        try {
            image = reader.acquireLatestImage();
            if (image == null || generation != cameraGeneration || !running) return;
            Image.Plane plane = image.getPlanes()[0];
            if (plane.getPixelStride() != 1) {
                if (!pixelStrideWarningSent) { pixelStrideWarningSent = true; postEvent("decodeError", "Camera Y plane pixelStride != 1; use the GPU native mode"); }
                return;
            }
            ByteBuffer buffer = plane.getBuffer().duplicate();
            int offset = buffer.position();
            FrameMetadata metadata = metadataForTimestamp(image.getTimestamp());
            DecodePlan plan = claimPlan();
            if (plan == null) {
                maybeSendYuvPreview(image);
                return;
            }
            Image owned = image;
            image = null;
            decodeHandler.post(() -> {
                try {
                    byte[] packet = decodePlan(plan, buffer, offset, owned.getWidth(), owned.getHeight(), plane.getRowStride(), metadata, 2);
                    maybeSendYuvPreview(owned);
                    if (packet != null) postBinary(packet); else postEvent("decodeError", "Native YUV decode failed");
                } catch (Exception error) { postEvent("decodeError", message(error)); }
                finally { owned.close(); releaseDecode(); }
            });
        } catch (Exception error) {
            postEvent("decodeError", message(error));
            releaseDecode();
        } finally {
            if (image != null) image.close();
        }
    }

    private byte[] decodePlan(DecodePlan plan, ByteBuffer buffer, int offset, int width, int height, int stride,
                              FrameMetadata metadata, int pipeline) {
        if (plan.mode == DecodePlan.MODE_GUIDED) {
            return NativeDecoder.decodeGuided(buffer, offset, width, height, stride,
                    plan.ids, plan.dimensions, plan.quads, plan.fallbackMask, plan.repairMask,
                    plan.jobId, plan.sourceSequence, metadata.frameNumber, metadata.timestampNs,
                    metadata.exposureNs, metadata.frameDurationNs, metadata.rollingShutterSkewNs,
                    metadata.focusDistance, metadata.iso, metadata.settingsEpoch, activeSensorOrientation, pipeline);
        }
        int cropWidth = plan.cropWidth > 0 ? plan.cropWidth : width;
        int cropHeight = plan.cropHeight > 0 ? plan.cropHeight : height;
        return NativeDecoder.decodeFull(buffer, offset, width, height, stride,
                plan.cropX, plan.cropY, cropWidth, cropHeight,
                plan.tryHarder, plan.tryDownscale, plan.maxSymbols, plan.returnErrors,
                plan.jobId, plan.sourceSequence, metadata.frameNumber, metadata.timestampNs,
                metadata.exposureNs, metadata.frameDurationNs, metadata.rollingShutterSkewNs,
                metadata.focusDistance, metadata.iso, metadata.settingsEpoch, activeSensorOrientation, pipeline);
    }

    private FrameMetadata metadataForTimestamp(long timestampNs) {
        synchronized (metadataByTimestamp) {
            FrameMetadata exact = metadataByTimestamp.remove(timestampNs);
            if (exact != null) return exact;
            FrameMetadata nearest = null;
            long best = Long.MAX_VALUE;
            for (Map.Entry<Long, FrameMetadata> entry : metadataByTimestamp.entrySet()) {
                long distance = Math.abs(entry.getKey() - timestampNs);
                if (distance < best) { best = distance; nearest = entry.getValue(); }
            }
            if (nearest != null && best <= 5_000_000L) return nearest;
        }
        FrameMetadata fallback = new FrameMetadata();
        fallback.timestampNs = timestampNs;
        fallback.exposureNs = currentExposureTimeNs == null ? 0 : currentExposureTimeNs;
        fallback.frameDurationNs = measuredFrameDurationNs > 0 ? Math.round(measuredFrameDurationNs) : activeFrameDurationNs;
        fallback.focusDistance = currentFocusDistance == null ? Float.NaN : currentFocusDistance;
        fallback.iso = currentIso == null ? 0 : currentIso;
        fallback.afState = lastReportedAfState; fallback.aeState = lastReportedAeState;
        fallback.settingsEpoch = activeSettingsEpoch;
        return fallback;
    }

    private long previewIntervalNs() {
        return binaryFallbackActive && !binaryTransportAcked ? PREVIEW_FALLBACK_INTERVAL_NS : PREVIEW_INTERVAL_NS;
    }

    private boolean previewDue() { return System.nanoTime() - lastPreviewNs >= previewIntervalNs(); }

    private static void samplePreviewPlane(Image.Plane plane, int sourceWidth, int sourceHeight,
                                           byte[] packet, int outputOffset, int outputWidth, int outputHeight) {
        ByteBuffer buffer = plane.getBuffer().duplicate();
        int base = buffer.position();
        int limit = buffer.limit();
        int rowStride = plane.getRowStride();
        int pixelStride = plane.getPixelStride();
        for (int y = 0; y < outputHeight; y++) {
            int sy = Math.min(sourceHeight - 1, (int) ((y + 0.5f) * sourceHeight / outputHeight));
            int row = base + sy * rowStride;
            for (int x = 0; x < outputWidth; x++) {
                int sx = Math.min(sourceWidth - 1, (int) ((x + 0.5f) * sourceWidth / outputWidth));
                int at = row + sx * pixelStride;
                packet[outputOffset + y * outputWidth + x] = at >= base && at < limit ? buffer.get(at) : 0;
            }
        }
    }

    private void maybeSendYuvPreview(Image image) {
        long now = System.nanoTime();
        if (image == null || now - lastPreviewNs < previewIntervalNs()) return;
        Image.Plane[] planes = image.getPlanes();
        if (planes == null || planes.length < 3 || image.getWidth() <= 0 || image.getHeight() <= 0) return;
        int width = image.getWidth();
        int height = image.getHeight();
        int outWidth = Math.min(320, width);
        int outHeight = Math.max(2, Math.round(height * (outWidth / (float) width)));
        outWidth &= ~1;
        outHeight &= ~1;
        if (outWidth < 2 || outHeight < 2) return;
        int chromaWidth = outWidth / 2;
        int chromaHeight = outHeight / 2;
        int yBytes = outWidth * outHeight;
        int chromaBytes = chromaWidth * chromaHeight;
        byte[] packet = new byte[PREVIEW_HEADER_BYTES + yBytes + chromaBytes * 2];
        ByteBuffer header = ByteBuffer.wrap(packet).order(ByteOrder.LITTLE_ENDIAN);
        header.putInt(PREVIEW_MAGIC); header.putShort((short) PREVIEW_HEADER_BYTES); header.putShort((short) 2);
        header.putInt(outWidth); header.putInt(outHeight); header.putInt(activeSensorOrientation);
        header.putInt(width); header.putInt(height);
        samplePreviewPlane(planes[0], width, height, packet, PREVIEW_HEADER_BYTES, outWidth, outHeight);
        samplePreviewPlane(planes[1], (width + 1) / 2, (height + 1) / 2,
                packet, PREVIEW_HEADER_BYTES + yBytes, chromaWidth, chromaHeight);
        samplePreviewPlane(planes[2], (width + 1) / 2, (height + 1) / 2,
                packet, PREVIEW_HEADER_BYTES + yBytes + chromaBytes, chromaWidth, chromaHeight);
        lastPreviewNs = now;
        postBinary(packet);
    }

    private void maybeSendPreview(ByteBuffer plane, int offset, int width, int height, int stride, long timestampNs) {
        long now = System.nanoTime();
        if (now - lastPreviewNs < previewIntervalNs() || plane == null || width <= 0 || height <= 0) return;
        lastPreviewNs = now;
        int outWidth = Math.min(320, width);
        int outHeight = Math.max(1, Math.round(height * (outWidth / (float) width)));
        byte[] packet = new byte[PREVIEW_HEADER_BYTES + outWidth * outHeight];
        ByteBuffer header = ByteBuffer.wrap(packet).order(ByteOrder.LITTLE_ENDIAN);
        header.putInt(PREVIEW_MAGIC); header.putShort((short) PREVIEW_HEADER_BYTES); header.putShort((short) 1);
        header.putInt(outWidth); header.putInt(outHeight); header.putInt(activeSensorOrientation);
        header.putInt(width); header.putInt(height);
        int base = plane.position() + offset - plane.position();
        for (int y = 0; y < outHeight; y++) {
            int sy = Math.min(height - 1, (int) ((y + 0.5f) * height / outHeight));
            int row = base + sy * stride;
            for (int x = 0; x < outWidth; x++) {
                int sx = Math.min(width - 1, (int) ((x + 0.5f) * width / outWidth));
                packet[PREVIEW_HEADER_BYTES + y * outWidth + x] = plane.get(row + sx);
            }
        }
        postBinary(packet);
    }

    private void applyRequested(JSONObject command) {
        int requestId = command.optInt("requestId");
        JSONObject patch = command.optJSONObject("patch");
        cameraHandler.post(() -> {
            try {
                if (!running || captureSession == null || activeBuilder == null || activeCharacteristics == null)
                    throw new IllegalStateException("Camera2 v2 is not running");
                if (patch == null) throw new IllegalArgumentException("Missing optics patch");
                CaptureRequest.Builder builder = activeBuilder;
                if (activeHighSpeed && (patch.has("exposureTime") || patch.has("iso") ||
                        "manual".equals(patch.optString("exposureMode")) || patch.has("focusDistance") ||
                        "manual".equals(patch.optString("focusMode")) || "single-shot".equals(patch.optString("focusMode"))))
                    throw new IllegalArgumentException("Manual/single-shot optics are unavailable in constrained high-speed mode");

                if (patch.has("pointsOfInterest")) applyMeteringRegions(builder, patch.optJSONArray("pointsOfInterest"));
                if (patch.has("focusMode")) {
                    String mode = patch.optString("focusMode", "continuous");
                    int[] af = activeCharacteristics.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES);
                    if ("manual".equals(mode)) {
                        if (!contains(af, CaptureRequest.CONTROL_AF_MODE_OFF)) throw new IllegalArgumentException("Manual focus unavailable");
                        builder.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_OFF);
                        currentFocusMode = "manual";
                    } else if ("single-shot".equals(mode)) {
                        if (!contains(af, CaptureRequest.CONTROL_AF_MODE_AUTO)) throw new IllegalArgumentException("Single-shot AF unavailable");
                        builder.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_AUTO);
                        builder.set(CaptureRequest.CONTROL_AF_TRIGGER, CaptureRequest.CONTROL_AF_TRIGGER_START);
                        currentFocusMode = "single-shot";
                    } else {
                        int selected = contains(af, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO)
                                ? CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO : CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE;
                        if (!contains(af, selected)) throw new IllegalArgumentException("Continuous AF unavailable");
                        builder.set(CaptureRequest.CONTROL_AF_MODE, selected);
                        builder.set(CaptureRequest.CONTROL_AF_TRIGGER, CaptureRequest.CONTROL_AF_TRIGGER_CANCEL);
                        currentFocusMode = "continuous";
                    }
                }
                if (patch.has("focusDistance")) {
                    Float max = activeCharacteristics.get(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE);
                    if (max == null || max <= 0) throw new IllegalArgumentException("Manual focus unavailable");
                    float value = (float) Math.max(0, Math.min(max, patch.optDouble("focusDistance")));
                    builder.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_OFF);
                    builder.set(CaptureRequest.LENS_FOCUS_DISTANCE, value);
                    currentFocusMode = "manual"; currentFocusDistance = value;
                }
                if (patch.has("exposureMode")) {
                    String mode = patch.optString("exposureMode", "continuous");
                    if ("manual".equals(mode) || "manual".equals(activeFpsControl)) {
                        if (!hasCapability(activeCharacteristics, CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR))
                            throw new IllegalArgumentException("Manual exposure unavailable");
                        builder.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_OFF);
                        builder.set(CaptureRequest.SENSOR_FRAME_DURATION, activeFrameDurationNs);
                        currentExposureMode = "manual";
                    } else {
                        builder.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON);
                        builder.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, activeFpsRange);
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
                    currentExposureMode = "manual"; currentExposureTimeNs = ns;
                }
                if (patch.has("iso")) {
                    Range<Integer> range = activeCharacteristics.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE);
                    int iso = clampInt((int) Math.round(patch.optDouble("iso")), range);
                    builder.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_OFF);
                    builder.set(CaptureRequest.SENSOR_FRAME_DURATION, activeFrameDurationNs);
                    builder.set(CaptureRequest.SENSOR_SENSITIVITY, iso);
                    currentExposureMode = "manual"; currentIso = iso;
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
                setRepeating(builder);
                JSONObject response = new JSONObject(); response.put("settings", currentSettingsJson());
                reply(requestId, response);
            } catch (Exception error) { replyError(requestId, message(error)); }
        });
    }

    private JSONObject cameraCapabilities(CameraCharacteristics chars, boolean highSpeed) throws Exception {
        JSONObject caps = new JSONObject();
        JSONArray focusModes = new JSONArray();
        int[] af = chars.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES);
        if (contains(af, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO) || contains(af, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)) focusModes.put("continuous");
        if (!highSpeed && (contains(af, CaptureRequest.CONTROL_AF_MODE_AUTO) || contains(af, CaptureRequest.CONTROL_AF_MODE_MACRO))) focusModes.put("single-shot");
        Float minFocus = chars.get(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE);
        if (!highSpeed && minFocus != null && minFocus > 0 && contains(af, CaptureRequest.CONTROL_AF_MODE_OFF)) {
            focusModes.put("manual");
            caps.put("focusDistance", new JSONObject().put("min", 0).put("max", minFocus).put("step", Math.max(0.001, minFocus / 200.0)));
        }
        caps.put("focusMode", focusModes);
        Integer maxAf = chars.get(CameraCharacteristics.CONTROL_MAX_REGIONS_AF);
        Integer maxAe = chars.get(CameraCharacteristics.CONTROL_MAX_REGIONS_AE);
        caps.put("pointsOfInterest", (maxAf != null && maxAf > 0) || (maxAe != null && maxAe > 0));
        JSONArray exposureModes = new JSONArray(); exposureModes.put("continuous");
        Range<Long> exposure = chars.get(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE);
        Range<Integer> iso = chars.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE);
        if (!highSpeed && hasCapability(chars, CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR) && exposure != null && iso != null) {
            exposureModes.put("manual");
            caps.put("exposureTime", new JSONObject().put("min", exposure.getLower() / 100_000.0).put("max", exposure.getUpper() / 100_000.0).put("step", 0.1));
            caps.put("iso", new JSONObject().put("min", iso.getLower()).put("max", iso.getUpper()).put("step", 1));
        }
        caps.put("exposureMode", exposureModes);
        Range<Integer> compensation = chars.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_RANGE);
        Rational compensationStep = chars.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_STEP);
        if (compensation != null && compensationStep != null && compensationStep.doubleValue() > 0) {
            double step = compensationStep.doubleValue();
            caps.put("exposureCompensation", new JSONObject().put("min", compensation.getLower() * step).put("max", compensation.getUpper() * step).put("step", step));
        }
        return caps;
    }

    private JSONObject currentSettingsJson() throws Exception {
        JSONObject settings = new JSONObject();
        settings.put("deviceId", activeCameraId); settings.put("width", activeWidth); settings.put("height", activeHeight);
        settings.put("frameRate", activeDecodeFps); settings.put("sensorFrameRate", activeSensorFps);
        if (measuredFps > 0) settings.put("measuredFps", measuredFps);
        if (measuredFrameDurationNs > 0) settings.put("measuredFrameDurationNs", measuredFrameDurationNs);
        settings.put("focusMode", currentFocusMode); if (currentFocusDistance != null) settings.put("focusDistance", currentFocusDistance);
        settings.put("exposureMode", currentExposureMode); if (currentExposureTimeNs != null) settings.put("exposureTime", currentExposureTimeNs / 100_000.0);
        if (currentIso != null) settings.put("iso", currentIso);
        settings.put("exposureCompensation", currentExposureCompensationEv);
        settings.put("afState", lastReportedAfState); settings.put("aeState", lastReportedAeState);
        settings.put("settingsEpoch", activeSettingsEpoch); settings.put("highSpeed", activeHighSpeed);
        return settings;
    }

    private void applyMeteringRegions(CaptureRequest.Builder builder, JSONArray points) throws Exception {
        if (points == null || points.length() == 0 || activeCharacteristics == null) return;
        JSONObject point = points.optJSONObject(0); if (point == null) return;
        double nx = Math.max(0, Math.min(1, point.optDouble("x", 0.5)));
        double ny = Math.max(0, Math.min(1, point.optDouble("y", 0.5)));
        Rect active = activeCharacteristics.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE);
        Rect crop = builder.get(CaptureRequest.SCALER_CROP_REGION);
        Rect bounds = crop != null ? crop : active;
        if (bounds == null || bounds.width() <= 0 || bounds.height() <= 0) return;
        int cx = bounds.left + (int) Math.round(nx * bounds.width());
        int cy = bounds.top + (int) Math.round(ny * bounds.height());
        int half = Math.max(24, Math.min(bounds.width(), bounds.height()) / 12);
        Rect rect = new Rect(Math.max(bounds.left, cx - half), Math.max(bounds.top, cy - half),
                Math.min(bounds.right, cx + half), Math.min(bounds.bottom, cy + half));
        MeteringRectangle region = new MeteringRectangle(rect, MeteringRectangle.METERING_WEIGHT_MAX);
        Integer maxAf = activeCharacteristics.get(CameraCharacteristics.CONTROL_MAX_REGIONS_AF);
        Integer maxAe = activeCharacteristics.get(CameraCharacteristics.CONTROL_MAX_REGIONS_AE);
        if (maxAf != null && maxAf > 0) builder.set(CaptureRequest.CONTROL_AF_REGIONS, new MeteringRectangle[]{region});
        if (maxAe != null && maxAe > 0) builder.set(CaptureRequest.CONTROL_AE_REGIONS, new MeteringRectangle[]{region});
    }

    private void disableStabilizationAndHeavyProcessing(CaptureRequest.Builder builder, CameraCharacteristics chars) {
        int[] video = chars.get(CameraCharacteristics.CONTROL_AVAILABLE_VIDEO_STABILIZATION_MODES);
        if (contains(video, CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE_OFF)) builder.set(CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE, CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE_OFF);
        int[] optical = chars.get(CameraCharacteristics.LENS_INFO_AVAILABLE_OPTICAL_STABILIZATION);
        if (contains(optical, CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE_OFF)) builder.set(CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE, CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE_OFF);
        int[] edge = chars.get(CameraCharacteristics.EDGE_AVAILABLE_EDGE_MODES);
        if (contains(edge, CaptureRequest.EDGE_MODE_FAST)) builder.set(CaptureRequest.EDGE_MODE, CaptureRequest.EDGE_MODE_FAST);
        int[] noise = chars.get(CameraCharacteristics.NOISE_REDUCTION_AVAILABLE_NOISE_REDUCTION_MODES);
        if (contains(noise, CaptureRequest.NOISE_REDUCTION_MODE_FAST)) builder.set(CaptureRequest.NOISE_REDUCTION_MODE, CaptureRequest.NOISE_REDUCTION_MODE_FAST);
    }

    private void stopRequested(int requestId) {
        pendingPermissionStart = null;
        cameraHandler.post(() -> { stopCameraInternal(); try { reply(requestId, new JSONObject().put("stopped", true)); } catch (Exception ignored) {} });
    }

    void stop() { pendingPermissionStart = null; cameraHandler.post(this::stopCameraInternal); }

    void close() {
        pendingPermissionStart = null;
        cameraHandler.post(this::stopCameraInternal);
        cameraThread.quitSafely(); decodeThread.quitSafely();
    }

    private void stopCameraInternal() {
        cameraGeneration++;
        running = false;
        synchronized (planLock) { pendingPlan = null; reservedGpuPlan = null; decodeBusy = false; }
        try { if (captureSession != null) captureSession.close(); } catch (Exception ignored) {}
        captureSession = null; activeBuilder = null;
        try { if (cameraDevice != null) cameraDevice.close(); } catch (Exception ignored) {}
        cameraDevice = null;
        if (imageReader != null) { try { imageReader.close(); } catch (Exception ignored) {} }
        imageReader = null;
        if (gpuReader != null) { try { gpuReader.close(); } catch (Exception ignored) {} }
        gpuReader = null; captureSurface = null; activeCharacteristics = null;
    }

    private void postBinary(byte[] bytes) {
        if (bytes == null) return;
        activity.runOnUiThread(() -> {
            JavaScriptReplyProxy proxy = replyProxy;
            if (proxy == null) return;
            long now = System.nanoTime();
            if (!binaryTransportAcked && firstBinaryPostNs > 0 && now - firstBinaryPostNs >= BINARY_ACK_GRACE_NS)
                binaryFallbackActive = true;
            if (binaryFallbackActive && !binaryTransportAcked) {
                postBinaryFallback(proxy, bytes);
                return;
            }
            try {
                proxy.postMessage(bytes);
                if (firstBinaryPostNs == 0) firstBinaryPostNs = now;
            } catch (Exception error) {
                binaryFallbackActive = true;
                postBinaryFallback(proxy, bytes);
            }
        });
    }

    private void postBinaryFallback(JavaScriptReplyProxy proxy, byte[] bytes) {
        try {
            JSONObject value = new JSONObject();
            value.put("event", "binaryFallback");
            value.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
            proxy.postMessage(value.toString());
        } catch (Exception error) {
            postEvent("decodeError", "Camera2 v2 binary bridge failed: " + message(error));
        }
    }

    private void postString(String text) {
        activity.runOnUiThread(() -> { JavaScriptReplyProxy proxy = replyProxy; if (proxy != null) try { proxy.postMessage(text); } catch (Exception ignored) {} });
    }

    private void postEvent(String event, String detail) {
        try { JSONObject value = new JSONObject(); value.put("event", event); value.put("detail", detail == null ? "" : detail); postString(value.toString()); }
        catch (Exception ignored) {}
    }

    private void reply(int requestId, JSONObject payload) {
        try { payload.put("requestId", requestId); payload.put("ok", true); postString(payload.toString()); }
        catch (Exception error) { replyError(requestId, message(error)); }
    }

    private void replyError(int requestId, String error) {
        try { JSONObject payload = new JSONObject(); payload.put("requestId", requestId); payload.put("ok", false); payload.put("error", error); postString(payload.toString()); }
        catch (Exception ignored) {}
    }

    private static String message(Throwable error) { return error.getMessage() == null ? error.toString() : error.getMessage(); }
    private static boolean contains(int[] values, int wanted) { if (values == null) return false; for (int value : values) if (value == wanted) return true; return false; }
    private static boolean hasCapability(CameraCharacteristics chars, int wanted) { return contains(chars.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES), wanted); }
    private static long clampLong(long value, Range<Long> range) { return range == null ? value : Math.max(range.getLower(), Math.min(range.getUpper(), value)); }
    private static int clampInt(int value, Range<Integer> range) { return range == null ? value : Math.max(range.getLower(), Math.min(range.getUpper(), value)); }
    private static String sizeKey(Size size) { return size.getWidth() + "x" + size.getHeight(); }
    private static long sizeArea(String key) { int split = key.indexOf('x'); if (split <= 0) return Long.MAX_VALUE; try { return (long) Integer.parseInt(key.substring(0, split)) * Integer.parseInt(key.substring(split + 1)); } catch (Exception ignored) { return Long.MAX_VALUE; } }
    private static Size findSize(Size[] sizes, String key) { if (sizes != null) for (Size size : sizes) if (sizeKey(size).equals(key)) return size; return null; }
    private static boolean durationAllows(long ns, int fps) { return ns <= 0 || ns <= Math.round(1_000_000_000.0 / fps * 1.01); }
    private static Range<Integer> chooseFpsRange(Range<Integer>[] ranges, int fps) {
        Range<Integer> best = null; if (ranges == null) return null;
        for (Range<Integer> range : ranges) {
            if (range.getLower() == fps && range.getUpper() == fps) return range;
            if (range.getUpper() < fps || range.getLower() > fps) continue;
            if (best == null || range.getUpper() < best.getUpper() || range.getUpper().equals(best.getUpper()) && range.getLower() > best.getLower()) best = range;
        }
        return best;
    }
    private static Range<Integer> chooseHighSpeedRange(Range<Integer>[] ranges, int sensorFps) {
        if (ranges == null) return null;
        Range<Integer> best = null;
        for (Range<Integer> range : ranges) {
            if (range.getUpper() != sensorFps) continue;
            if (best == null || range.getLower() > best.getLower()) best = range;
        }
        return best;
    }
    private static Range<Integer> bestHighSpeedRange(Range<Integer>[] ranges) {
        if (ranges == null) return null;
        Range<Integer> best = null;
        for (Range<Integer> range : ranges) if (best == null || range.getUpper() > best.getUpper() || range.getUpper().equals(best.getUpper()) && range.getLower() > best.getLower()) best = range;
        return best;
    }
    private static String facingName(Integer facing) {
        if (facing == null) return "unknown";
        if (facing == CameraCharacteristics.LENS_FACING_BACK) return "rear";
        if (facing == CameraCharacteristics.LENS_FACING_FRONT) return "front";
        if (facing == CameraCharacteristics.LENS_FACING_EXTERNAL) return "external";
        return "unknown";
    }
    private static String hardwareLevelName(Integer level) {
        if (level == null) return "unknown";
        if (level == CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_LEGACY) return "legacy";
        if (level == CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_LIMITED) return "limited";
        if (level == CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_FULL) return "full";
        if (level == CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_3) return "level3";
        if (level == CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_EXTERNAL) return "external";
        return String.valueOf(level);
    }
    private static String focusModeName(int mode) {
        if (mode == CaptureRequest.CONTROL_AF_MODE_OFF) return "manual";
        if (mode == CaptureRequest.CONTROL_AF_MODE_AUTO || mode == CaptureRequest.CONTROL_AF_MODE_MACRO) return "single-shot";
        return "continuous";
    }
}
