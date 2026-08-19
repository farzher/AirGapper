package com.airgapper.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.ImageFormat;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.Image;
import android.media.ImageReader;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Range;
import android.util.Size;
import android.webkit.WebView;

import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.Locale;
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

    private static final String APP_ORIGIN = "https://appassets.androidplatform.net";
    private static final String OBJECT_NAME = "AirGapperNativeCamera";
    private static final int[] TEST_FPS = {30, 60};
    private static final Set<String> STANDARD_SIZES = new HashSet<>(Arrays.asList(
            "640x480", "960x720", "1280x720", "1280x960", "1920x1080",
            "2560x1440", "3840x2160"));

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
    private String activeCameraId = "";
    private int activeWidth;
    private int activeHeight;
    private int activeRequestedFps;
    private Range<Integer> activeFpsRange;
    private long activeMinFrameDurationNs;
    private int activeSensorOrientation;

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
        if (!isMainFrame || !APP_ORIGIN.equals(sourceOrigin.toString())) return;
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
            Size[] sizes = map.getOutputSizes(ImageFormat.YUV_420_888);
            if (sizes == null || sizes.length == 0) continue;

            JSONObject camera = new JSONObject();
            camera.put("id", cameraId);
            Integer facing = chars.get(CameraCharacteristics.LENS_FACING);
            camera.put("facing", facingName(facing));
            camera.put("label", "Camera " + cameraId + " · " + facingName(facing));
            Integer orientation = chars.get(CameraCharacteristics.SENSOR_ORIENTATION);
            camera.put("sensorOrientation", orientation == null ? 0 : orientation);
            JSONArray modes = new JSONArray();

            Arrays.sort(sizes, Comparator.comparingLong(size -> (long) size.getWidth() * size.getHeight()));
            for (Size size : sizes) {
                String sizeKey = size.getWidth() + "x" + size.getHeight();
                if (!STANDARD_SIZES.contains(sizeKey)) continue;
                long minDuration = map.getOutputMinFrameDuration(ImageFormat.YUV_420_888, size);
                for (int fps : TEST_FPS) {
                    Range<Integer> range = chooseFpsRange(ranges, fps);
                    if (range == null || !durationAllows(minDuration, fps)) continue;
                    JSONObject mode = new JSONObject();
                    mode.put("key", sizeKey + "@" + fps);
                    mode.put("width", size.getWidth());
                    mode.put("height", size.getHeight());
                    mode.put("fps", fps);
                    mode.put("fixedFps", range.getLower() == fps && range.getUpper() == fps);
                    mode.put("fpsMin", range.getLower());
                    mode.put("fpsMax", range.getUpper());
                    mode.put("minFrameDurationNs", minDuration);
                    modes.put(mode);
                }
            }
            camera.put("modes", modes);
            cameras.put(camera);
        }
        result.put("cameras", cameras);
        return result;
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
        cameraHandler.post(() -> startCamera(requestId, cameraId, width, height, fps));
    }

    @SuppressLint("MissingPermission")
    private void startCamera(int requestId, String cameraId, int width, int height, int fps) {
        stopCameraInternal();
        try {
            if (cameraId.isEmpty()) throw new IllegalArgumentException("No Camera2 camera selected");
            CameraCharacteristics chars = cameraManager.getCameraCharacteristics(cameraId);
            StreamConfigurationMap map = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            Range<Integer>[] ranges = chars.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES);
            if (map == null || ranges == null) throw new IllegalStateException("Camera has no YUV configuration map");

            Size requestedSize = null;
            Size[] sizes = map.getOutputSizes(ImageFormat.YUV_420_888);
            if (sizes != null) {
                for (Size size : sizes) {
                    if (size.getWidth() == width && size.getHeight() == height) {
                        requestedSize = size;
                        break;
                    }
                }
            }
            if (requestedSize == null) throw new IllegalArgumentException(width + "x" + height + " YUV unavailable on camera " + cameraId);
            Range<Integer> range = chooseFpsRange(ranges, fps);
            long minDuration = map.getOutputMinFrameDuration(ImageFormat.YUV_420_888, requestedSize);
            if (range == null || !durationAllows(minDuration, fps)) {
                throw new IllegalArgumentException(width + "x" + height + " @ " + fps + " fps unavailable on camera " + cameraId);
            }

            activeCameraId = cameraId;
            activeWidth = width;
            activeHeight = height;
            activeRequestedFps = fps;
            activeFpsRange = range;
            activeMinFrameDurationNs = minDuration;
            Integer sensorOrientation = chars.get(CameraCharacteristics.SENSOR_ORIENTATION);
            activeSensorOrientation = sensorOrientation == null ? 0 : sensorOrientation;
            frameCredit = false;

            imageReader = ImageReader.newInstance(width, height, ImageFormat.YUV_420_888, 2);
            imageReader.setOnImageAvailableListener(this::onImageAvailable, cameraHandler);
            cameraManager.openCamera(cameraId, new CameraDevice.StateCallback() {
                @Override
                public void onOpened(CameraDevice camera) {
                    cameraDevice = camera;
                    configureSession(requestId, chars);
                }

                @Override
                public void onDisconnected(CameraDevice camera) {
                    camera.close();
                    if (cameraDevice == camera) cameraDevice = null;
                    running = false;
                    replyError(requestId, "Camera2 disconnected");
                }

                @Override
                public void onError(CameraDevice camera, int error) {
                    camera.close();
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

    private void configureSession(int requestId, CameraCharacteristics chars) {
        CameraDevice camera = cameraDevice;
        ImageReader reader = imageReader;
        if (camera == null || reader == null) return;
        try {
            CaptureRequest.Builder request = camera.createCaptureRequest(CameraDevice.TEMPLATE_RECORD);
            request.addTarget(reader.getSurface());
            request.set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO);
            request.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON);
            request.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, activeFpsRange);
            int[] afModes = chars.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES);
            if (contains(afModes, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO)) {
                request.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO);
            } else if (contains(afModes, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)) {
                request.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
            } else if (contains(afModes, CaptureRequest.CONTROL_AF_MODE_AUTO)) {
                request.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_AUTO);
            }

            camera.createCaptureSession(Collections.singletonList(reader.getSurface()), new CameraCaptureSession.StateCallback() {
                @Override
                public void onConfigured(CameraCaptureSession session) {
                    if (cameraDevice != camera) {
                        session.close();
                        return;
                    }
                    captureSession = session;
                    try {
                        session.setRepeatingRequest(request.build(), null, cameraHandler);
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
            }, cameraHandler);
        } catch (CameraAccessException error) {
            stopCameraInternal();
            replyError(requestId, error.getMessage() == null ? error.toString() : error.getMessage());
        }
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
            byte[] y = copyTightY(image);
            frameCredit = false;
            sendFrame(y);
        } catch (Exception ignored) {
            frameCredit = true;
        } finally {
            if (image != null) image.close();
        }
    }

    private static byte[] copyTightY(Image image) {
        int width = image.getWidth();
        int height = image.getHeight();
        Image.Plane plane = image.getPlanes()[0];
        ByteBuffer source = plane.getBuffer();
        int rowStride = plane.getRowStride();
        int pixelStride = plane.getPixelStride();
        int base = source.position();
        byte[] output = new byte[width * height];
        if (pixelStride == 1) {
            ByteBuffer copy = source.duplicate();
            for (int row = 0; row < height; row++) {
                copy.position(base + row * rowStride);
                copy.get(output, row * width, width);
            }
        } else {
            for (int row = 0; row < height; row++) {
                int rowBase = base + row * rowStride;
                int outBase = row * width;
                for (int x = 0; x < width; x++) output[outBase + x] = source.get(rowBase + x * pixelStride);
            }
        }
        return output;
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

    private void stopRequested(int requestId) {
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
        cameraHandler.post(this::stopCameraInternal);
    }

    private void stopCameraInternal() {
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
        activeCameraId = "";
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
