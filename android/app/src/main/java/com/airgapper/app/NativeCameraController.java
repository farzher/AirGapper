package com.airgapper.app;

import android.Manifest;
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
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.Image;
import android.media.ImageReader;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Range;
import android.util.Size;
import android.view.Surface;
import android.view.TextureView;
import android.view.View;
import android.widget.FrameLayout;

import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.ResultPoint;
import com.google.zxing.BarcodeFormat;
import com.google.zxing.common.HybridBinarizer;
import com.google.zxing.multi.GenericMultipleBarcodeReader;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;

/** One bounded Camera2 owner. Frames stay as Y luminance and only decoded QR payloads cross into JS. */
final class NativeCameraController {
    interface Listener {
        void onQr(byte[] bytes, float[] points, long timestampNs);
        void onStatus(String status, String detail, String modeJson);
    }

    private final Activity activity;
    private final FrameLayout root;
    private final TextureView preview;
    private final CameraManager manager;
    private final Listener listener;
    private final AtomicBoolean decoding = new AtomicBoolean();
    private final Map<String, Mode> modes = new HashMap<>();
    private HandlerThread cameraThread;
    private Handler cameraHandler;
    private HandlerThread decodeThread;
    private Handler decodeHandler;
    private CameraDevice device;
    private CameraCaptureSession session;
    private ImageReader reader;
    private Surface previewSurface;
    private CaptureRequest.Builder repeatingBuilder;
    private boolean torchEnabled;
    private int exposureCompensation;
    private int generation;
    private int attempts;
    private Mode requestedMode;
    private Mode activeMode;
    private boolean paused;
    private long frameCount;

    NativeCameraController(Activity activity, FrameLayout root, Listener listener) {
        this.activity = activity;
        this.root = root;
        this.listener = listener;
        manager = (CameraManager) activity.getSystemService(Context.CAMERA_SERVICE);
        preview = new TextureView(activity);
        preview.setOpaque(true);
        preview.setVisibility(View.GONE);
        root.addView(preview, new FrameLayout.LayoutParams(1, 1));
    }

    String capabilitiesJson() {
        JSONArray cameras = new JSONArray();
        JSONArray allModes = new JSONArray();
        modes.clear();
        try {
            for (String id : manager.getCameraIdList()) {
                CameraCharacteristics c = manager.getCameraCharacteristics(id);
                Integer facing = c.get(CameraCharacteristics.LENS_FACING);
                if (facing == null || facing != CameraCharacteristics.LENS_FACING_BACK) continue;
                StreamConfigurationMap map = c.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
                if (map == null) continue;
                JSONObject camera = describeCamera(id, c);
                JSONArray cameraModes = new JSONArray();
                addNormalModes(id, c, map, cameraModes, allModes);
                addHighSpeedModes(id, c, map, cameraModes, allModes);
                camera.put("modes", cameraModes);
                cameras.put(camera);
            }
        } catch (Exception e) {
            try { return new JSONObject().put("decoderAvailable", true).put("error", safe(e)).put("cameras", cameras)
                    .put("modes", allModes).toString(); }
            catch (Exception ignored) { return "{\"decoderAvailable\":true,\"modes\":[]}"; }
        }
        try { return new JSONObject().put("decoderAvailable", true).put("cameras", cameras).put("modes", allModes).toString(); }
        catch (Exception ignored) { return "{\"decoderAvailable\":true,\"modes\":[]}"; }
    }

    private JSONObject describeCamera(String id, CameraCharacteristics c) throws Exception {
        JSONObject out = new JSONObject();
        out.put("id", id);
        Integer level = c.get(CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL);
        out.put("hardwareLevel", levelName(level));
        Rect active = c.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE);
        if (active != null) out.put("activeArray", new JSONArray(Arrays.asList(active.width(), active.height())));
        out.put("capabilities", ints(c.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES)));
        out.put("autofocusModes", ints(c.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES)));
        out.put("exposureCompensation", range(c.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_RANGE)));
        out.put("sensitivity", range(c.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE)));
        out.put("exposureTime", range(c.get(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE)));
        out.put("flash", Boolean.TRUE.equals(c.get(CameraCharacteristics.FLASH_INFO_AVAILABLE)));
        out.put("videoStabilizationModes", ints(c.get(CameraCharacteristics.CONTROL_AVAILABLE_VIDEO_STABILIZATION_MODES)));
        out.put("opticalStabilizationModes", ints(c.get(CameraCharacteristics.LENS_INFO_AVAILABLE_OPTICAL_STABILIZATION)));
        return out;
    }

    private void addNormalModes(String id, CameraCharacteristics c, StreamConfigurationMap map,
                                JSONArray cameraModes, JSONArray allModes) throws Exception {
        Size[] texture = map.getOutputSizes(SurfaceTexture.class);
        Size[] yuv = map.getOutputSizes(ImageFormat.YUV_420_888);
        if (texture == null || yuv == null) return;
        Set<String> analysable = new HashSet<>();
        for (Size size : yuv) analysable.add(size.getWidth() + "x" + size.getHeight());
        @SuppressWarnings("unchecked")
        Range<Integer>[] ranges = c.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES);
        if (ranges == null || ranges.length == 0) ranges = new Range[]{new Range<>(15, 30)};
        Arrays.sort(texture, Comparator.comparingLong(s -> -(long) s.getWidth() * s.getHeight()));
        for (Size size : texture) {
            if (!analysable.contains(size.getWidth() + "x" + size.getHeight())) continue;
            long duration = map.getOutputMinFrameDuration(ImageFormat.YUV_420_888, size);
            int maxForSize = duration > 0 ? (int) Math.floor(1_000_000_000d / duration) : 30;
            for (Range<Integer> fps : ranges) {
                if (fps.getUpper() > maxForSize + 1 || fps.getUpper() > 60) continue;
                addMode(new Mode(id, size, fps, false, true,
                        contains(c.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES), CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO),
                        Boolean.TRUE.equals(c.get(CameraCharacteristics.FLASH_INFO_AVAILABLE)),
                        contains(c.get(CameraCharacteristics.CONTROL_AVAILABLE_VIDEO_STABILIZATION_MODES), CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE_ON),
                        exposureLower(c), exposureUpper(c)), cameraModes, allModes);
            }
        }
    }

    private void addHighSpeedModes(String id, CameraCharacteristics c, StreamConfigurationMap map,
                                   JSONArray cameraModes, JSONArray allModes) throws Exception {
        if (!contains(c.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES),
                CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_CONSTRAINED_HIGH_SPEED_VIDEO)) return;
        Size[] sizes;
        try { sizes = map.getHighSpeedVideoSizes(); } catch (Exception ignored) { return; }
        if (sizes == null) return;
        for (Size size : sizes) {
            Range<Integer>[] ranges;
            try { ranges = map.getHighSpeedVideoFpsRangesFor(size); } catch (Exception ignored) { continue; }
            for (Range<Integer> fps : ranges) addMode(new Mode(id, size, fps, true, false,
                    contains(c.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES), CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO),
                    Boolean.TRUE.equals(c.get(CameraCharacteristics.FLASH_INFO_AVAILABLE)),
                    contains(c.get(CameraCharacteristics.CONTROL_AVAILABLE_VIDEO_STABILIZATION_MODES), CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE_ON),
                    exposureLower(c), exposureUpper(c)), cameraModes, allModes);
        }
    }

    private void addMode(Mode mode, JSONArray cameraModes, JSONArray allModes) throws Exception {
        if (modes.containsKey(mode.key)) return;
        modes.put(mode.key, mode);
        JSONObject json = mode.json();
        cameraModes.put(json);
        allModes.put(json);
    }

    void setBounds(int left, int top, int width, int height) {
        activity.runOnUiThread(() -> {
            FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) preview.getLayoutParams();
            lp.leftMargin = Math.max(0, left);
            lp.topMargin = Math.max(0, top);
            lp.width = Math.max(1, width);
            lp.height = Math.max(1, height);
            preview.setLayoutParams(lp);
        });
    }

    void start(String modeKey) {
        activity.runOnUiThread(() -> {
            paused = false;
            if (modes.isEmpty()) capabilitiesJson();
            Mode chosen = modes.get(modeKey);
            if (chosen == null) chosen = safestMode();
            requestedMode = chosen;
            attempts = 0;
            beginAttempt(chosen);
        });
    }

    private void beginAttempt(Mode mode) {
        stopInternal(false);
        if (mode == null) { fail("No usable rear Camera2 mode"); return; }
        activeMode = mode;
        frameCount = 0;
        final int token = ++generation;
        ensureThreads();
        preview.setVisibility(View.VISIBLE);
        preview.setSurfaceTextureListener(new TextureView.SurfaceTextureListener() {
            public void onSurfaceTextureAvailable(SurfaceTexture texture, int width, int height) { if (token == generation) open(texture, token); }
            public void onSurfaceTextureSizeChanged(SurfaceTexture texture, int width, int height) {}
            public boolean onSurfaceTextureDestroyed(SurfaceTexture texture) { if (token == generation) stopInternal(false); return true; }
            public void onSurfaceTextureUpdated(SurfaceTexture texture) {}
        });
        if (preview.isAvailable()) open(preview.getSurfaceTexture(), token);
        listener.onStatus("starting", "Native Camera2", mode.json().toString());
    }

    private void open(SurfaceTexture texture, int token) {
        if (device != null || token != generation) return;
        try {
            texture.setDefaultBufferSize(activeMode.size.getWidth(), activeMode.size.getHeight());
            previewSurface = new Surface(texture);
            Size analysis = analysisSize(activeMode.cameraId, activeMode.size);
            reader = ImageReader.newInstance(analysis.getWidth(), analysis.getHeight(), ImageFormat.YUV_420_888, 2);
            reader.setOnImageAvailableListener(r -> onImage(r, token), cameraHandler);
            if (activity.checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                fail("Camera permission is required"); return;
            }
            manager.openCamera(activeMode.cameraId, new CameraDevice.StateCallback() {
                public void onOpened(CameraDevice camera) { if (token != generation) camera.close(); else { device = camera; configure(token); } }
                public void onDisconnected(CameraDevice camera) { camera.close(); if (token == generation) retry("Camera disconnected"); }
                public void onError(CameraDevice camera, int error) { camera.close(); if (token == generation) retry("Camera open error " + error); }
            }, cameraHandler);
        } catch (Exception e) { retry("Camera open failed: " + safe(e)); }
    }

    private void configure(int token) {
        if (device == null || reader == null || previewSurface == null) return;
        List<Surface> surfaces = Arrays.asList(previewSurface, reader.getSurface());
        CameraCaptureSession.StateCallback callback = new CameraCaptureSession.StateCallback() {
            public void onConfigured(CameraCaptureSession configured) {
                if (token != generation || device == null) { configured.close(); return; }
                session = configured;
                try {
                    repeatingBuilder = device.createCaptureRequest(CameraDevice.TEMPLATE_RECORD);
                    for (Surface surface : surfaces) repeatingBuilder.addTarget(surface);
                    applyControls(repeatingBuilder, activeMode);
                    submitRepeating();
                    listener.onStatus("active", "Native Camera2", activeMode.json().toString());
                    cameraHandler.postDelayed(() -> { if (token == generation && frameCount == 0) retry("Native camera produced no frames"); }, 4000);
                } catch (Exception e) { retry("Capture request failed: " + safe(e)); }
            }
            public void onConfigureFailed(CameraCaptureSession failed) { if (token == generation) retry("Camera surfaces rejected"); }
        };
        try {
            if (activeMode.highSpeed) device.createConstrainedHighSpeedCaptureSession(surfaces, callback, cameraHandler);
            else device.createCaptureSession(surfaces, callback, cameraHandler);
        } catch (Exception e) { retry("Session failed: " + safe(e)); }
    }

    private void applyControls(CaptureRequest.Builder b, Mode mode) throws CameraAccessException {
        b.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, mode.fps);
        if (mode.autofocus) b.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO);
        b.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON);
        if (mode.stabilization) b.set(CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE, CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE_ON);
        if (mode.torch && torchEnabled) b.set(CaptureRequest.FLASH_MODE, CaptureRequest.FLASH_MODE_TORCH);
        Range<Integer> exposure = manager.getCameraCharacteristics(mode.cameraId).get(CameraCharacteristics.CONTROL_AE_COMPENSATION_RANGE);
        if (exposure != null) b.set(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION,
                Math.max(exposure.getLower(), Math.min(exposure.getUpper(), exposureCompensation)));
    }

    private void submitRepeating() throws CameraAccessException {
        if (session == null || repeatingBuilder == null) return;
        if (activeMode.highSpeed && session instanceof CameraConstrainedHighSpeedCaptureSession) {
            session.setRepeatingBurst(((CameraConstrainedHighSpeedCaptureSession) session)
                    .createHighSpeedRequestList(repeatingBuilder.build()), null, cameraHandler);
        } else session.setRepeatingRequest(repeatingBuilder.build(), null, cameraHandler);
    }

    void setTorch(boolean enabled) {
        torchEnabled = enabled;
        if (cameraHandler != null) cameraHandler.post(() -> {
            if (repeatingBuilder == null || activeMode == null || !activeMode.torch) return;
            try { repeatingBuilder.set(CaptureRequest.FLASH_MODE, enabled ? CaptureRequest.FLASH_MODE_TORCH : CaptureRequest.FLASH_MODE_OFF); submitRepeating(); }
            catch (Exception ignored) {}
        });
    }

    void setExposure(int value) {
        exposureCompensation = value;
        if (cameraHandler != null) cameraHandler.post(() -> {
            if (repeatingBuilder == null || activeMode == null) return;
            try { applyControls(repeatingBuilder, activeMode); submitRepeating(); } catch (Exception ignored) {}
        });
    }

    private void onImage(ImageReader source, int token) {
        Image image = null;
        try {
            image = source.acquireLatestImage();
            if (image == null || token != generation) return;
            frameCount++;
            if (!decoding.compareAndSet(false, true)) return;
            Image.Plane plane = image.getPlanes()[0];
            int width = image.getWidth(), height = image.getHeight(), stride = plane.getRowStride();
            ByteBuffer buffer = plane.getBuffer();
            byte[] y = new byte[width * height];
            for (int row = 0; row < height; row++) {
                buffer.position(row * stride);
                buffer.get(y, row * width, width);
            }
            long timestamp = image.getTimestamp();
            decodeHandler.post(() -> decode(y, width, height, timestamp, token));
        } catch (Exception ignored) {
            decoding.set(false);
        } finally {
            if (image != null) image.close();
        }
    }

    private void decode(byte[] y, int width, int height, long timestamp, int token) {
        try {
            PlanarYUVLuminanceSource source = new PlanarYUVLuminanceSource(y, width, height, 0, 0, width, height, false);
            BinaryBitmap bitmap = new BinaryBitmap(new HybridBinarizer(source));
            Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
            hints.put(DecodeHintType.POSSIBLE_FORMATS, Collections.singletonList(BarcodeFormat.QR_CODE));
            hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
            MultiFormatReader base = new MultiFormatReader();
            base.setHints(hints);
            Result[] results = decodeBitmap(base, bitmap, hints);
            if (results.length == 0 && source.isRotateSupported()) {
                results = decodeBitmap(base, new BinaryBitmap(new HybridBinarizer(source.rotateCounterClockwise())), hints);
            }
            if (token == generation) for (Result result : results) {
                ResultPoint[] rp = result.getResultPoints();
                float[] points = new float[(rp == null ? 0 : rp.length) * 2];
                if (rp != null) for (int i = 0; i < rp.length; i++) { points[i * 2] = rp[i].getX(); points[i * 2 + 1] = rp[i].getY(); }
                listener.onQr(result.getRawBytes(), points, timestamp);
            }
        } finally { decoding.set(false); }
    }

    private static Result[] decodeBitmap(MultiFormatReader base, BinaryBitmap bitmap, Map<DecodeHintType, Object> hints) {
        try { return new GenericMultipleBarcodeReader(base).decodeMultiple(bitmap, hints); }
        catch (Exception first) {
            try { base.reset(); base.setHints(hints); return new Result[]{base.decodeWithState(bitmap)}; }
            catch (Exception ignored) { return new Result[0]; }
        }
    }

    private void retry(String reason) {
        activity.runOnUiThread(() -> {
            if (paused) return;
            Mode next = null;
            if (attempts++ == 0 && activeMode != null && activeMode.highSpeed) next = bestNormal(activeMode.cameraId, activeMode.size);
            if (next == null && attempts <= 2) next = safestMode();
            if (next != null && next != activeMode) {
                listener.onStatus("downgrading", reason, next.json().toString());
                beginAttempt(next);
            } else fail(reason);
        });
    }

    private void fail(String reason) {
        stopInternal(true);
        listener.onStatus("fallback", reason, "null");
    }

    void stop() { activity.runOnUiThread(() -> stopInternal(true)); }
    void pause() { paused = true; stop(); }
    void destroy() { paused = true; stopInternal(true); root.removeView(preview); }

    private void stopInternal(boolean hide) {
        generation++;
        decoding.set(false);
        try { if (session != null) session.close(); } catch (Exception ignored) {}
        try { if (device != null) device.close(); } catch (Exception ignored) {}
        try { if (reader != null) reader.close(); } catch (Exception ignored) {}
        try { if (previewSurface != null) previewSurface.release(); } catch (Exception ignored) {}
        session = null; device = null; reader = null; previewSurface = null; repeatingBuilder = null;
        if (hide) preview.setVisibility(View.GONE);
        preview.setSurfaceTextureListener(null);
    }

    private void ensureThreads() {
        if (cameraThread == null) { cameraThread = new HandlerThread("AirGapperCamera"); cameraThread.start(); cameraHandler = new Handler(cameraThread.getLooper()); }
        if (decodeThread == null) { decodeThread = new HandlerThread("AirGapperDecode"); decodeThread.start(); decodeHandler = new Handler(decodeThread.getLooper()); }
    }

    private Mode safestMode() {
        Mode best = null;
        for (Mode mode : modes.values()) {
            if (mode.highSpeed) continue;
            if (best == null || legacyPenalty(mode) < legacyPenalty(best) ||
                    (legacyPenalty(mode) == legacyPenalty(best) && (long) mode.size.getWidth() * mode.size.getHeight() > (long) best.size.getWidth() * best.size.getHeight())) best = mode;
        }
        return best;
    }

    private int legacyPenalty(Mode m) {
        int pixels = m.size.getWidth() * m.size.getHeight();
        if (pixels <= 1280 * 960 && m.fps.getUpper() <= 30) return 0;
        if (pixels <= 1920 * 1080 && m.fps.getUpper() <= 30) return 1;
        return 2;
    }

    private Mode bestNormal(String cameraId, Size near) {
        Mode best = null;
        long bestDistance = Long.MAX_VALUE;
        for (Mode mode : modes.values()) {
            if (mode.highSpeed || !mode.cameraId.equals(cameraId)) continue;
            long distance = Math.abs((long) mode.size.getWidth() * mode.size.getHeight() - (long) near.getWidth() * near.getHeight());
            if (distance < bestDistance) { best = mode; bestDistance = distance; }
        }
        return best == null ? safestMode() : best;
    }

    private Size analysisSize(String cameraId, Size selected) throws CameraAccessException {
        Size[] sizes = manager.getCameraCharacteristics(cameraId).get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
                .getOutputSizes(ImageFormat.YUV_420_888);
        Size best = sizes[sizes.length - 1];
        long bestDifference = Long.MAX_VALUE;
        for (Size size : sizes) {
            if (size.getWidth() > 1280 || size.getHeight() > 1280) continue;
            long difference = Math.abs((long) size.getWidth() * selected.getHeight() - (long) size.getHeight() * selected.getWidth());
            if (difference < bestDifference) { best = size; bestDifference = difference; }
        }
        return best;
    }

    private static final class Mode {
        final String cameraId; final Size size; final Range<Integer> fps; final boolean highSpeed; final boolean analysis;
        final boolean autofocus; final boolean torch; final boolean stabilization; final int exposureMin; final int exposureMax; final String key;
        Mode(String cameraId, Size size, Range<Integer> fps, boolean highSpeed, boolean analysis,
             boolean autofocus, boolean torch, boolean stabilization, int exposureMin, int exposureMax) {
            this.cameraId = cameraId; this.size = size; this.fps = fps; this.highSpeed = highSpeed; this.analysis = analysis;
            this.autofocus = autofocus; this.torch = torch; this.stabilization = stabilization;
            this.exposureMin = exposureMin; this.exposureMax = exposureMax;
            key = cameraId + ":" + size.getWidth() + "x" + size.getHeight() + ":" + fps.getLower() + "-" + fps.getUpper() + ":" + (highSpeed ? "hs" : "normal");
        }
        JSONObject json() {
            JSONObject out = new JSONObject();
            try {
                out.put("key", key).put("cameraId", cameraId).put("width", size.getWidth()).put("height", size.getHeight())
                        .put("fpsMin", fps.getLower()).put("fpsMax", fps.getUpper()).put("highSpeed", highSpeed)
                        .put("preview", true).put("analysis", analysis).put("autofocus", autofocus).put("torch", torch).put("stabilization", stabilization)
                        .put("exposureMin", exposureMin).put("exposureMax", exposureMax);
            } catch (Exception ignored) {}
            return out;
        }
    }

    private static int exposureLower(CameraCharacteristics c) { Range<Integer> r = c.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_RANGE); return r == null ? 0 : r.getLower(); }
    private static int exposureUpper(CameraCharacteristics c) { Range<Integer> r = c.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_RANGE); return r == null ? 0 : r.getUpper(); }
    private static JSONArray ints(int[] values) { JSONArray out = new JSONArray(); if (values != null) for (int v : values) out.put(v); return out; }
    private static JSONArray range(Range<?> value) { return value == null ? new JSONArray() : new JSONArray(Arrays.asList(value.getLower(), value.getUpper())); }
    private static boolean contains(int[] values, int sought) { if (values != null) for (int v : values) if (v == sought) return true; return false; }
    private static String levelName(Integer level) {
        if (level == null) return "UNKNOWN";
        if (level == CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_LEGACY) return "LEGACY";
        if (level == CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_LIMITED) return "LIMITED";
        if (level == CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_FULL) return "FULL";
        if (level == CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_3) return "LEVEL_3";
        if (level == CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_EXTERNAL) return "EXTERNAL";
        return String.valueOf(level);
    }
    private static String safe(Exception e) { return e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage(); }
}
