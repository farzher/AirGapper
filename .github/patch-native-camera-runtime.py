from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one match, found {count}: {old[:100]!r}")
    p.write_text(text.replace(old, new, 1))


def replace_all(path, old, new, minimum=1):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count < minimum:
        raise SystemExit(f"{path}: expected at least {minimum} matches, found {count}: {old!r}")
    p.write_text(text.replace(old, new))


# Version bump.
for path in ["index.html", "main.js", "receive/main.js", "send/main.js", ".github/workflows/build-apk.yml"]:
    replace_all(path, "v0.5.351", "v0.5.352")
replace_once("android/app/build.gradle", 'versionCode 351\n        versionName "0.5.351"', 'versionCode 352\n        versionName "0.5.352"')
replace_once("sw.js", 'airgapper-static-js-v351', 'airgapper-static-js-v352')

# Native bridge command adds the chosen native source pipeline.
replace_once(
    "shared/native-camera.js",
    'async function startNativeCamera({ cameraId, width, height, fps }) {\n  return request("start", { cameraId, width, height, fps }, 12000);\n}',
    'async function startNativeCamera({ cameraId, width, height, fps, pipeline }) {\n  return request("start", { cameraId, width, height, fps, pipeline }, 15000);\n}'
)

# Native Camera2 Java bridge: enumerate YUV and PRIVATE/SurfaceTexture modes,
# serialize lifecycle callbacks, and feed either source into the same byte[] sink.
p = Path("android/app/src/main/java/com/airgapper/app/NativeCameraBridge.java")
text = p.read_text()
text = text.replace('import android.graphics.ImageFormat;\n', 'import android.graphics.ImageFormat;\nimport android.graphics.SurfaceTexture;\n')
text = text.replace('import android.util.Size;\n', 'import android.util.Size;\nimport android.view.Surface;\n')
text = text.replace(
    '    private CameraDevice cameraDevice;\n    private CameraCaptureSession captureSession;\n    private ImageReader imageReader;\n',
    '    private CameraDevice cameraDevice;\n    private CameraCaptureSession captureSession;\n    private ImageReader imageReader;\n    private NativeGpuCameraReader gpuReader;\n    private Surface captureSurface;\n    private long cameraGeneration;\n'
)
text = text.replace(
    '    private int activeSensorOrientation;\n',
    '    private int activeSensorOrientation;\n    private String activeFacing = "unknown";\n    private String activePipeline = "yuv";\n'
)
old_catalog = '''            Size[] sizes = map.getOutputSizes(ImageFormat.YUV_420_888);
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
            cameras.put(camera);'''
new_catalog = '''            Size[] yuvSizes = map.getOutputSizes(ImageFormat.YUV_420_888);
            Size[] gpuSizes = map.getOutputSizes(SurfaceTexture.class);
            if ((yuvSizes == null || yuvSizes.length == 0) && (gpuSizes == null || gpuSizes.length == 0)) continue;

            JSONObject camera = new JSONObject();
            camera.put("id", cameraId);
            Integer facing = chars.get(CameraCharacteristics.LENS_FACING);
            camera.put("facing", facingName(facing));
            camera.put("label", "Camera " + cameraId + " · " + facingName(facing));
            Integer orientation = chars.get(CameraCharacteristics.SENSOR_ORIENTATION);
            camera.put("sensorOrientation", orientation == null ? 0 : orientation);
            JSONArray aeRanges = new JSONArray();
            for (Range<Integer> range : ranges) aeRanges.put(range.getLower() + "-" + range.getUpper());
            camera.put("aeRanges", aeRanges);
            JSONArray modes = new JSONArray();

            Set<String> sizeKeys = new HashSet<>();
            if (yuvSizes != null) for (Size size : yuvSizes) sizeKeys.add(size.getWidth() + "x" + size.getHeight());
            if (gpuSizes != null) for (Size size : gpuSizes) sizeKeys.add(size.getWidth() + "x" + size.getHeight());
            String[] orderedKeys = sizeKeys.stream().filter(STANDARD_SIZES::contains).toArray(String[]::new);
            Arrays.sort(orderedKeys, Comparator.comparingLong(NativeCameraBridge::sizeArea));
            for (String sizeKey : orderedKeys) {
                Size yuvSize = findSize(yuvSizes, sizeKey);
                Size gpuSize = findSize(gpuSizes, sizeKey);
                long yuvDuration = yuvSize == null ? Long.MAX_VALUE : map.getOutputMinFrameDuration(ImageFormat.YUV_420_888, yuvSize);
                long gpuDuration = gpuSize == null ? Long.MAX_VALUE : map.getOutputMinFrameDuration(SurfaceTexture.class, gpuSize);
                for (int fps : TEST_FPS) {
                    Range<Integer> range = chooseFpsRange(ranges, fps);
                    if (range == null) continue;
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
                    Size size = pipeline.equals("yuv") ? yuvSize : gpuSize;
                    JSONObject mode = new JSONObject();
                    mode.put("key", sizeKey + "@" + fps + ":" + pipeline);
                    mode.put("width", size.getWidth());
                    mode.put("height", size.getHeight());
                    mode.put("fps", fps);
                    mode.put("pipeline", pipeline);
                    mode.put("fixedFps", range.getLower() == fps && range.getUpper() == fps);
                    mode.put("fpsMin", range.getLower());
                    mode.put("fpsMax", range.getUpper());
                    mode.put("minFrameDurationNs", minDuration);
                    mode.put("yuvMinFrameDurationNs", yuvSize == null ? 0 : yuvDuration);
                    mode.put("gpuMinFrameDurationNs", gpuSize == null ? 0 : gpuDuration);
                    modes.put(mode);
                }
            }
            camera.put("modes", modes);
            cameras.put(camera);'''
if text.count(old_catalog) != 1:
    raise SystemExit("NativeCameraBridge: catalog block mismatch")
text = text.replace(old_catalog, new_catalog, 1)
text = text.replace(
    '    private static boolean durationAllows(long minDurationNs, int fps) {',
    '''    private static long sizeArea(String key) {
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

    private static boolean durationAllows(long minDurationNs, int fps) {''',
    1
)
text = text.replace(
    '        final int fps = command.optInt("fps");\n        cameraHandler.post(() -> startCamera(requestId, cameraId, width, height, fps));',
    '        final int fps = command.optInt("fps");\n        final String pipeline = command.optString("pipeline", "yuv");\n        cameraHandler.post(() -> startCamera(requestId, cameraId, width, height, fps, pipeline));'
)
old_start_sig = '    private void startCamera(int requestId, String cameraId, int width, int height, int fps) {\n        stopCameraInternal();'
if text.count(old_start_sig) != 1:
    raise SystemExit("NativeCameraBridge: start signature mismatch")
text = text.replace(old_start_sig, '    private void startCamera(int requestId, String cameraId, int width, int height, int fps, String pipeline) {\n        stopCameraInternal();\n        final long generation = cameraGeneration;', 1)
old_validation = '''            Size requestedSize = null;
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
            }, cameraHandler);'''
new_validation = '''            boolean gpu = "gpu".equals(pipeline);
            Size[] sizes = gpu ? map.getOutputSizes(SurfaceTexture.class) : map.getOutputSizes(ImageFormat.YUV_420_888);
            Size requestedSize = findSize(sizes, width + "x" + height);
            if (requestedSize == null) throw new IllegalArgumentException(width + "x" + height + " " + (gpu ? "PRIVATE/GPU" : "YUV") + " unavailable on camera " + cameraId);
            Range<Integer> range = chooseFpsRange(ranges, fps);
            long minDuration = gpu
                    ? map.getOutputMinFrameDuration(SurfaceTexture.class, requestedSize)
                    : map.getOutputMinFrameDuration(ImageFormat.YUV_420_888, requestedSize);
            if (range == null || !durationAllows(minDuration, fps)) {
                throw new IllegalArgumentException(width + "x" + height + " @ " + fps + " fps unavailable on camera " + cameraId + " via " + pipeline);
            }

            activeCameraId = cameraId;
            activeWidth = width;
            activeHeight = height;
            activeRequestedFps = fps;
            activeFpsRange = range;
            activeMinFrameDurationNs = minDuration;
            activePipeline = gpu ? "gpu" : "yuv";
            Integer sensorOrientation = chars.get(CameraCharacteristics.SENSOR_ORIENTATION);
            activeSensorOrientation = sensorOrientation == null ? 0 : sensorOrientation;
            activeFacing = facingName(chars.get(CameraCharacteristics.LENS_FACING));
            frameCredit = false;

            if (gpu) {
                gpuReader = new NativeGpuCameraReader(cameraHandler, new NativeGpuCameraReader.Sink() {
                    @Override
                    public boolean takeFrameCredit() {
                        if (!running || !frameCredit || generation != cameraGeneration) return false;
                        frameCredit = false;
                        return true;
                    }

                    @Override
                    public void onFrame(byte[] bytes) {
                        sendFrame(bytes);
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
            }, cameraHandler);'''
if text.count(old_validation) != 1:
    raise SystemExit("NativeCameraBridge: validation/open block mismatch")
text = text.replace(old_validation, new_validation, 1)
text = text.replace(
    '    private void configureSession(int requestId, CameraCharacteristics chars) {\n        CameraDevice camera = cameraDevice;\n        ImageReader reader = imageReader;\n        if (camera == null || reader == null) return;',
    '    private void configureSession(int requestId, CameraCharacteristics chars, long generation) {\n        CameraDevice camera = cameraDevice;\n        Surface target = captureSurface;\n        if (camera == null || target == null || generation != cameraGeneration) return;'
)
text = text.replace('            builder.addTarget(reader.getSurface());', '            builder.addTarget(target);', 1)
text = text.replace(
    '                    if (cameraDevice != camera) {',
    '                    if (cameraDevice != camera || generation != cameraGeneration) {',
    1
)
text = text.replace(
    '                        started.put("sensorOrientation", activeSensorOrientation);\n                        started.put("sessionParameters", Build.VERSION.SDK_INT >= Build.VERSION_CODES.P);',
    '                        started.put("sensorOrientation", activeSensorOrientation);\n                        started.put("facing", activeFacing);\n                        started.put("pipeline", activePipeline);\n                        started.put("sessionParameters", Build.VERSION.SDK_INT >= Build.VERSION_CODES.P);'
)
text = text.replace('                createSessionApi28(camera, reader, request, callback);', '                createSessionApi28(camera, target, request, callback);', 1)
text = text.replace('                camera.createCaptureSession(Collections.singletonList(reader.getSurface()), callback, cameraHandler);', '                camera.createCaptureSession(Collections.singletonList(target), callback, cameraHandler);', 1)
text = text.replace(
    '            ImageReader reader,\n            CaptureRequest request,',
    '            Surface target,\n            CaptureRequest request,'
)
text = text.replace('        OutputConfiguration output = new OutputConfiguration(reader.getSurface());', '        OutputConfiguration output = new OutputConfiguration(target);', 1)
# Cancel permission-held starts on activity pause / JS stop so resume cannot race them.
text = text.replace(
    '    private void stopRequested(int requestId) {\n        cameraHandler.post(() -> {',
    '''    private void cancelPendingPermissionStart() {
        JSONObject pending = pendingPermissionStart;
        pendingPermissionStart = null;
        if (pending != null) replyError(pending.optInt("requestId"), "Camera start cancelled");
    }

    private void stopRequested(int requestId) {
        cancelPendingPermissionStart();
        cameraHandler.post(() -> {'''
)
text = text.replace(
    '    void stop() {\n        cameraHandler.post(this::stopCameraInternal);\n    }',
    '    void stop() {\n        cancelPendingPermissionStart();\n        cameraHandler.post(this::stopCameraInternal);\n    }'
)
text = text.replace(
    '    private void stopCameraInternal() {\n        running = false;',
    '    private void stopCameraInternal() {\n        cameraGeneration++;\n        running = false;'
)
text = text.replace(
    '        imageReader = null;\n        activeCameraId = "";',
    '''        imageReader = null;
        try {
            if (gpuReader != null) gpuReader.close();
        } catch (Exception ignored) {
        }
        gpuReader = null;
        captureSurface = null;
        activeCameraId = "";
        activePipeline = "yuv";'''
)
p.write_text(text)

# Add GPU PRIVATE -> R8 reader. SurfaceTexture is a Camera2 PRIVATE output; an
# offscreen GLES3 pass extracts one 8-bit luminance channel before the existing
# WebMessage ArrayBuffer bridge.
gpu = r'''package com.airgapper.app;

import android.graphics.SurfaceTexture;
import android.opengl.EGL14;
import android.opengl.EGLConfig;
import android.opengl.EGLContext;
import android.opengl.EGLDisplay;
import android.opengl.EGLSurface;
import android.opengl.GLES11Ext;
import android.opengl.GLES20;
import android.opengl.GLES30;
import android.os.Handler;
import android.view.Surface;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;

final class NativeGpuCameraReader implements AutoCloseable {
    interface Sink {
        boolean takeFrameCredit();
        void onFrame(byte[] bytes);
        void onError(String message);
    }

    private static final int EGL_OPENGL_ES3_BIT_KHR = 0x40;
    private static final float[] QUAD = {
            -1f, -1f, 0f, 0f,
             1f, -1f, 1f, 0f,
            -1f,  1f, 0f, 1f,
             1f,  1f, 1f, 1f
    };
    private static final String VERTEX =
            "attribute vec2 aPosition;\n" +
            "attribute vec2 aTexCoord;\n" +
            "uniform mat4 uTexMatrix;\n" +
            "varying vec2 vTexCoord;\n" +
            "void main(){ gl_Position=vec4(aPosition,0.0,1.0); vTexCoord=(uTexMatrix*vec4(aTexCoord,0.0,1.0)).xy; }\n";
    private static final String FRAGMENT =
            "#extension GL_OES_EGL_image_external : require\n" +
            "precision mediump float;\n" +
            "uniform samplerExternalOES uCamera;\n" +
            "varying vec2 vTexCoord;\n" +
            "void main(){ vec3 rgb=texture2D(uCamera,vTexCoord).rgb; float y=dot(rgb,vec3(0.2126,0.7152,0.0722)); gl_FragColor=vec4(y,0.0,0.0,1.0); }\n";

    private final Handler handler;
    private final Sink sink;
    private final FloatBuffer quad;
    private final float[] textureMatrix = new float[16];

    private EGLDisplay eglDisplay = EGL14.EGL_NO_DISPLAY;
    private EGLContext eglContext = EGL14.EGL_NO_CONTEXT;
    private EGLSurface eglSurface = EGL14.EGL_NO_SURFACE;
    private SurfaceTexture surfaceTexture;
    private Surface surface;
    private int cameraTexture;
    private int outputTexture;
    private int framebuffer;
    private int program;
    private int positionLocation;
    private int texCoordLocation;
    private int matrixLocation;
    private int width;
    private int height;
    private ByteBuffer readback;
    private boolean closed = true;

    NativeGpuCameraReader(Handler handler, Sink sink) {
        this.handler = handler;
        this.sink = sink;
        quad = ByteBuffer.allocateDirect(QUAD.length * 4)
                .order(ByteOrder.nativeOrder()).asFloatBuffer();
        quad.put(QUAD).position(0);
    }

    Surface open(int width, int height) {
        close();
        this.width = width;
        this.height = height;
        initEgl();
        initGl();
        surfaceTexture = new SurfaceTexture(cameraTexture);
        surfaceTexture.setDefaultBufferSize(width, height);
        surfaceTexture.setOnFrameAvailableListener(this::onFrameAvailable, handler);
        surface = new Surface(surfaceTexture);
        closed = false;
        return surface;
    }

    private void initEgl() {
        eglDisplay = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY);
        if (eglDisplay == EGL14.EGL_NO_DISPLAY) throw new IllegalStateException("Could not get EGL display");
        int[] versions = new int[2];
        if (!EGL14.eglInitialize(eglDisplay, versions, 0, versions, 1)) throw new IllegalStateException("Could not initialize EGL");
        int[] configAttrs = {
                EGL14.EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT_KHR,
                EGL14.EGL_SURFACE_TYPE, EGL14.EGL_PBUFFER_BIT,
                EGL14.EGL_RED_SIZE, 8,
                EGL14.EGL_GREEN_SIZE, 8,
                EGL14.EGL_BLUE_SIZE, 8,
                EGL14.EGL_ALPHA_SIZE, 8,
                EGL14.EGL_NONE
        };
        EGLConfig[] configs = new EGLConfig[1];
        int[] count = new int[1];
        if (!EGL14.eglChooseConfig(eglDisplay, configAttrs, 0, configs, 0, 1, count, 0) || count[0] == 0) {
            throw new IllegalStateException("No GLES3 EGL config");
        }
        int[] contextAttrs = {EGL14.EGL_CONTEXT_CLIENT_VERSION, 3, EGL14.EGL_NONE};
        eglContext = EGL14.eglCreateContext(eglDisplay, configs[0], EGL14.EGL_NO_CONTEXT, contextAttrs, 0);
        if (eglContext == null || eglContext == EGL14.EGL_NO_CONTEXT) throw new IllegalStateException("Could not create GLES3 context");
        int[] surfaceAttrs = {EGL14.EGL_WIDTH, 1, EGL14.EGL_HEIGHT, 1, EGL14.EGL_NONE};
        eglSurface = EGL14.eglCreatePbufferSurface(eglDisplay, configs[0], surfaceAttrs, 0);
        if (eglSurface == null || eglSurface == EGL14.EGL_NO_SURFACE) throw new IllegalStateException("Could not create EGL pbuffer");
        makeCurrent();
    }

    private void makeCurrent() {
        if (!EGL14.eglMakeCurrent(eglDisplay, eglSurface, eglSurface, eglContext)) {
            throw new IllegalStateException("Could not make Camera2 EGL context current");
        }
    }

    private void initGl() {
        int[] ids = new int[1];
        GLES20.glGenTextures(1, ids, 0);
        cameraTexture = ids[0];
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, cameraTexture);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE);

        GLES20.glGenTextures(1, ids, 0);
        outputTexture = ids[0];
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, outputTexture);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_NEAREST);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_NEAREST);
        GLES30.glTexImage2D(GLES20.GL_TEXTURE_2D, 0, GLES30.GL_R8, width, height, 0, GLES30.GL_RED, GLES20.GL_UNSIGNED_BYTE, null);

        GLES20.glGenFramebuffers(1, ids, 0);
        framebuffer = ids[0];
        GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, framebuffer);
        GLES20.glFramebufferTexture2D(GLES20.GL_FRAMEBUFFER, GLES20.GL_COLOR_ATTACHMENT0, GLES20.GL_TEXTURE_2D, outputTexture, 0);
        if (GLES20.glCheckFramebufferStatus(GLES20.GL_FRAMEBUFFER) != GLES20.GL_FRAMEBUFFER_COMPLETE) {
            throw new IllegalStateException("Camera2 luminance framebuffer incomplete");
        }

        program = linkProgram(VERTEX, FRAGMENT);
        positionLocation = GLES20.glGetAttribLocation(program, "aPosition");
        texCoordLocation = GLES20.glGetAttribLocation(program, "aTexCoord");
        matrixLocation = GLES20.glGetUniformLocation(program, "uTexMatrix");
        readback = ByteBuffer.allocateDirect(width * height).order(ByteOrder.nativeOrder());
    }

    private static int compileShader(int type, String source) {
        int shader = GLES20.glCreateShader(type);
        GLES20.glShaderSource(shader, source);
        GLES20.glCompileShader(shader);
        int[] status = new int[1];
        GLES20.glGetShaderiv(shader, GLES20.GL_COMPILE_STATUS, status, 0);
        if (status[0] == 0) {
            String log = GLES20.glGetShaderInfoLog(shader);
            GLES20.glDeleteShader(shader);
            throw new IllegalStateException("Camera2 GPU shader compile failed: " + log);
        }
        return shader;
    }

    private static int linkProgram(String vertex, String fragment) {
        int vs = compileShader(GLES20.GL_VERTEX_SHADER, vertex);
        int fs = compileShader(GLES20.GL_FRAGMENT_SHADER, fragment);
        int program = GLES20.glCreateProgram();
        GLES20.glAttachShader(program, vs);
        GLES20.glAttachShader(program, fs);
        GLES20.glLinkProgram(program);
        GLES20.glDeleteShader(vs);
        GLES20.glDeleteShader(fs);
        int[] status = new int[1];
        GLES20.glGetProgramiv(program, GLES20.GL_LINK_STATUS, status, 0);
        if (status[0] == 0) {
            String log = GLES20.glGetProgramInfoLog(program);
            GLES20.glDeleteProgram(program);
            throw new IllegalStateException("Camera2 GPU program link failed: " + log);
        }
        return program;
    }

    private void onFrameAvailable(SurfaceTexture ignored) {
        if (closed || surfaceTexture == null) return;
        try {
            makeCurrent();
            surfaceTexture.updateTexImage();
            if (!sink.takeFrameCredit()) return;
            surfaceTexture.getTransformMatrix(textureMatrix);
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, framebuffer);
            GLES20.glViewport(0, 0, width, height);
            GLES20.glUseProgram(program);
            GLES20.glActiveTexture(GLES20.GL_TEXTURE0);
            GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, cameraTexture);
            int sampler = GLES20.glGetUniformLocation(program, "uCamera");
            GLES20.glUniform1i(sampler, 0);
            GLES20.glUniformMatrix4fv(matrixLocation, 1, false, textureMatrix, 0);
            quad.position(0);
            GLES20.glEnableVertexAttribArray(positionLocation);
            GLES20.glVertexAttribPointer(positionLocation, 2, GLES20.GL_FLOAT, false, 16, quad);
            quad.position(2);
            GLES20.glEnableVertexAttribArray(texCoordLocation);
            GLES20.glVertexAttribPointer(texCoordLocation, 2, GLES20.GL_FLOAT, false, 16, quad);
            GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);
            readback.clear();
            GLES30.glReadPixels(0, 0, width, height, GLES30.GL_RED, GLES20.GL_UNSIGNED_BYTE, readback);
            byte[] output = new byte[width * height];
            for (int row = 0; row < height; row++) {
                readback.position((height - 1 - row) * width);
                readback.get(output, row * width, width);
            }
            sink.onFrame(output);
        } catch (Exception error) {
            sink.onError(error.getMessage() == null ? error.toString() : error.getMessage());
        }
    }

    @Override
    public void close() {
        closed = true;
        if (surfaceTexture != null) surfaceTexture.setOnFrameAvailableListener(null);
        if (surface != null) {
            try { surface.release(); } catch (Exception ignored) {}
        }
        surface = null;
        if (surfaceTexture != null) {
            try { surfaceTexture.release(); } catch (Exception ignored) {}
        }
        surfaceTexture = null;
        if (eglDisplay != EGL14.EGL_NO_DISPLAY && eglContext != EGL14.EGL_NO_CONTEXT && eglSurface != EGL14.EGL_NO_SURFACE) {
            try {
                makeCurrent();
                int[] one = new int[1];
                if (framebuffer != 0) { one[0] = framebuffer; GLES20.glDeleteFramebuffers(1, one, 0); }
                if (cameraTexture != 0) { one[0] = cameraTexture; GLES20.glDeleteTextures(1, one, 0); }
                if (outputTexture != 0) { one[0] = outputTexture; GLES20.glDeleteTextures(1, one, 0); }
                if (program != 0) GLES20.glDeleteProgram(program);
            } catch (Exception ignored) {}
        }
        framebuffer = 0;
        cameraTexture = 0;
        outputTexture = 0;
        program = 0;
        readback = null;
        if (eglDisplay != EGL14.EGL_NO_DISPLAY) {
            try { EGL14.eglMakeCurrent(eglDisplay, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT); } catch (Exception ignored) {}
            if (eglSurface != EGL14.EGL_NO_SURFACE) try { EGL14.eglDestroySurface(eglDisplay, eglSurface); } catch (Exception ignored) {}
            if (eglContext != EGL14.EGL_NO_CONTEXT) try { EGL14.eglDestroyContext(eglDisplay, eglContext); } catch (Exception ignored) {}
            try { EGL14.eglTerminate(eglDisplay); } catch (Exception ignored) {}
        }
        eglDisplay = EGL14.EGL_NO_DISPLAY;
        eglContext = EGL14.EGL_NO_CONTEXT;
        eglSurface = EGL14.EGL_NO_SURFACE;
    }
}
'''
Path("android/app/src/main/java/com/airgapper/app/NativeGpuCameraReader.java").write_text(gpu)

# JS mode labels, orientation-correct preview/overlay, stale-start handling, and
# source selection. Raw decode coordinates stay in sensor orientation; only the
# tiny preview and overlay are rotated, avoiding a full-frame CPU rotate.
p = Path("receive/main.js")
text = p.read_text()
text = text.replace(
    'function nativeModeLabel(mode) {\n  if (mode.fixedFps) return formatCameraMode(mode.width, mode.height, mode.fps);\n  return `${mode.width}×${mode.height} · ${mode.fps} fps target · AE ${mode.fpsMin}–${mode.fpsMax}`;\n}',
    '''function nativeModeLabel(mode) {
  const path = mode.pipeline === "gpu" ? " · GPU" : "";
  if (mode.fixedFps) return `${formatCameraMode(mode.width, mode.height, mode.fps)}${path}`;
  return `${mode.width}×${mode.height} · ${mode.fps} fps target · AE ${mode.fpsMin}–${mode.fpsMax}${path}`;
}
function nativePreviewRotation(info = nativeCameraInfo ?? selectedNativeCamera()) {
  if (!info) return 0;
  const sensor = Number(info.sensorOrientation) || 0;
  const device = Number(screen.orientation?.angle ?? window.orientation ?? 0) || 0;
  const sign = info.facing === "front" ? 1 : -1;
  return ((sensor - device * sign) % 360 + 360) % 360;
}
function syncNativePreviewAspect(width = requestedWidth, height = requestedHeight, info = nativeCameraInfo ?? selectedNativeCamera()) {
  const rotation = nativePreviewRotation(info);
  cameraBox.style.aspectRatio = rotation === 90 || rotation === 270 ? `${height} / ${width}` : `${width} / ${height}`;
}'''
)
text = text.replace(
    '  cameraBox.style.aspectRatio = `${requestedWidth} / ${requestedHeight}`;\n}',
    '  syncNativePreviewAspect(requestedWidth, requestedHeight, camera);\n}',
    1
)
# showRequestedCameraSettings has another aspect assignment; keep browser behavior.
needle = '  cameraBox.style.aspectRatio = `${requestedWidth} / ${requestedHeight}`;\n}\npopulateCameraOptions();'
if needle not in text:
    raise SystemExit("receive/main.js: showRequestedCameraSettings aspect block missing")
text = text.replace(needle, '  if (nativeCamera2) syncNativePreviewAspect();\n  else cameraBox.style.aspectRatio = `${requestedWidth} / ${requestedHeight}`;\n}\npopulateCameraOptions();', 1)
old_preview = '''function drawNativePreview(source) {
  if (!nativePreviewCtx || !source.nativeY || !source.width || !source.height) return;
  const now = performance.now();
  if (now - nativePreviewLastAt < 80) return;
  nativePreviewLastAt = now;
  const outWidth = Math.min(480, source.width);
  const outHeight = Math.max(1, Math.round(source.height * outWidth / source.width));
  if (nativePreview.width !== outWidth || nativePreview.height !== outHeight) {
    nativePreview.width = outWidth;
    nativePreview.height = outHeight;
  }
  const rgba = nativePreviewCtx.createImageData(outWidth, outHeight);
  const sx = source.width / outWidth;
  const sy = source.height / outHeight;
  for (let y = 0; y < outHeight; y++) {
    const sourceRow = Math.min(source.height - 1, Math.floor((y + 0.5) * sy)) * source.width;
    for (let x = 0; x < outWidth; x++) {
      const luma = source.nativeY[sourceRow + Math.min(source.width - 1, Math.floor((x + 0.5) * sx))];
      const at = (y * outWidth + x) * 4;
      rgba.data[at] = luma;
      rgba.data[at + 1] = luma;
      rgba.data[at + 2] = luma;
      rgba.data[at + 3] = 255;
    }
  }
  nativePreviewCtx.putImageData(rgba, 0, 0);
}'''
new_preview = '''function drawNativePreview(source) {
  if (!nativePreviewCtx || !source.nativeY || !source.width || !source.height) return;
  const now = performance.now();
  if (now - nativePreviewLastAt < 80) return;
  nativePreviewLastAt = now;
  const rotation = nativePreviewRotation();
  const rotated = rotation === 90 || rotation === 270;
  const displayWidth = rotated ? source.height : source.width;
  const displayHeight = rotated ? source.width : source.height;
  const outWidth = Math.min(480, displayWidth);
  const outHeight = Math.max(1, Math.round(displayHeight * outWidth / displayWidth));
  if (nativePreview.width !== outWidth || nativePreview.height !== outHeight) {
    nativePreview.width = outWidth;
    nativePreview.height = outHeight;
  }
  const rgba = nativePreviewCtx.createImageData(outWidth, outHeight);
  for (let y = 0; y < outHeight; y++) {
    const dy = Math.min(displayHeight - 1, Math.floor((y + 0.5) * displayHeight / outHeight));
    for (let x = 0; x < outWidth; x++) {
      const dx = Math.min(displayWidth - 1, Math.floor((x + 0.5) * displayWidth / outWidth));
      let sx = dx, sy = dy;
      if (rotation === 90) { sx = dy; sy = source.height - 1 - dx; }
      else if (rotation === 180) { sx = source.width - 1 - dx; sy = source.height - 1 - dy; }
      else if (rotation === 270) { sx = source.width - 1 - dy; sy = dx; }
      const luma = source.nativeY[sy * source.width + sx];
      const at = (y * outWidth + x) * 4;
      rgba.data[at] = luma;
      rgba.data[at + 1] = luma;
      rgba.data[at + 2] = luma;
      rgba.data[at + 3] = 255;
    }
  }
  nativePreviewCtx.putImageData(rgba, 0, 0);
}'''
if text.count(old_preview) != 1:
    raise SystemExit("receive/main.js: native preview block mismatch")
text = text.replace(old_preview, new_preview, 1)
# Start no longer arms the JS frame handler until the native session has replied;
# native credit remains false, so no frame can race this setup.
text = text.replace(
    '  cameraBox.style.aspectRatio = `${requestedWidth} / ${requestedHeight}`;\n  cameraActual.textContent = `${nativeModeLabel(selectedMode)} · Camera2`;',
    '  syncNativePreviewAspect(requestedWidth, requestedHeight, camera);\n  cameraActual.textContent = `${nativeModeLabel(selectedMode)} · Camera2`;'
)
text = text.replace(
    '  const futureGen = captureGen + 1;\n  setNativeCameraFrameHandler((buffer) => nativeSourceFrame(buffer, requestedWidth, requestedHeight, futureGen));\n  let started;',
    '  const futureGen = captureGen + 1;\n  setNativeCameraFrameHandler();\n  let started;'
)
text = text.replace(
    '        fps: requestedFps\n      }),',
    '        fps: requestedFps,\n        pipeline: selectedMode.pipeline\n      }),',
    1
)
text = text.replace(
    '  } catch (error) {\n    setNativeCameraFrameHandler();\n    void stopNativeCamera();\n    if (startAttempt === cameraStartGen) pool.resize(0);\n    offerRetry(`Native Camera2: ${error instanceof Error ? error.message : String(error)}`);\n    return;\n  }',
    '''  } catch (error) {
    setNativeCameraFrameHandler();
    void stopNativeCamera();
    if (startAttempt !== cameraStartGen || receiverPaused) return;
    pool.resize(0);
    offerRetry(`Native Camera2: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }''',
    1
)
text = text.replace(
    '  stream = nativeStreamShim;\n  nativeCameraRunning = true;\n  nativeCameraInfo = started;\n  preview.classList.remove("camera-loading");',
    '''  stream = nativeStreamShim;
  nativeCameraInfo = started;
  nativeCameraRunning = true;
  syncNativePreviewAspect(started.width ?? requestedWidth, started.height ?? requestedHeight, started);
  setNativeCameraFrameHandler((buffer) => nativeSourceFrame(buffer, started.width ?? requestedWidth, started.height ?? requestedHeight, futureGen));
  preview.classList.remove("camera-loading");'''
)
text = text.replace(
    '  framePumpMode = "Camera2 Y8";',
    '  framePumpMode = started.pipeline === "gpu" ? "Camera2 GPU Y8" : "Camera2 Y8";',
    1
)
# Diagnostics name the actual native source, not always YUV.
text = text.replace(
    '    ? `Camera2 ${nativeCameraInfo.cameraId} · YUV ${nativeCameraInfo.width}×${nativeCameraInfo.height} · target ${nativeCameraInfo.fps} fps · AE ${nativeCameraInfo.fpsMin}–${nativeCameraInfo.fpsMax}${nativeCameraInfo.fixedFps ? " fixed" : " variable"} · capture ${receiverFrameWidth || "—"}×${receiverFrameHeight || "—"}@${sourceCaptureRate.toFixed(1)} · pump Camera2 Y8 · sensor ${nativeCameraInfo.sensorOrientation ?? "—"}°`',
    '    ? `Camera2 ${nativeCameraInfo.cameraId} · ${nativeCameraInfo.pipeline === "gpu" ? "PRIVATE→GPU Y8" : "YUV"} ${nativeCameraInfo.width}×${nativeCameraInfo.height} · target ${nativeCameraInfo.fps} fps · AE ${nativeCameraInfo.fpsMin}–${nativeCameraInfo.fpsMax}${nativeCameraInfo.fixedFps ? " fixed" : " variable"} · capture ${receiverFrameWidth || "—"}×${receiverFrameHeight || "—"}@${sourceCaptureRate.toFixed(1)} · pump ${framePumpMode} · sensor ${nativeCameraInfo.sensorOrientation ?? "—"}°`'
)
# Rotate the overlay canvas as a whole into the same display orientation as the
# downsampled preview. Drawing still uses raw sensor coordinates.
old_overlay_head = '''  const dpr = window.devicePixelRatio || 1;
  const pw = Math.round(cw * dpr);
  const ph = Math.round(ch * dpr);
  if (overlay.width !== pw || overlay.height !== ph) {
    overlay.width = pw;
    overlay.height = ph;
  }
  overlayCtx.clearRect(0, 0, pw, ph);
  const scale = Math.min(pw / vw, ph / vh);'''
new_overlay_head = '''  const dpr = window.devicePixelRatio || 1;
  const physicalPw = Math.round(cw * dpr);
  const physicalPh = Math.round(ch * dpr);
  if (overlay.width !== physicalPw || overlay.height !== physicalPh) {
    overlay.width = physicalPw;
    overlay.height = physicalPh;
  }
  overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
  overlayCtx.clearRect(0, 0, physicalPw, physicalPh);
  const rotation = nativeCameraRunning ? nativePreviewRotation() : 0;
  let pw = physicalPw;
  let ph = physicalPh;
  overlayCtx.save();
  if (rotation === 90) {
    overlayCtx.translate(physicalPw, 0);
    overlayCtx.rotate(Math.PI / 2);
    pw = physicalPh; ph = physicalPw;
  } else if (rotation === 180) {
    overlayCtx.translate(physicalPw, physicalPh);
    overlayCtx.rotate(Math.PI);
  } else if (rotation === 270) {
    overlayCtx.translate(0, physicalPh);
    overlayCtx.rotate(-Math.PI / 2);
    pw = physicalPh; ph = physicalPw;
  }
  const scale = Math.min(pw / vw, ph / vh);'''
if text.count(old_overlay_head) != 1:
    raise SystemExit("receive/main.js: overlay head mismatch")
text = text.replace(old_overlay_head, new_overlay_head, 1)
text = text.replace(
    '  overlayCtx.globalAlpha = 1;\n  overlayCtx.shadowBlur = 0;\n  overlayCtx.setLineDash([]);\n}\nfunction focusGeometry()',
    '  overlayCtx.globalAlpha = 1;\n  overlayCtx.shadowBlur = 0;\n  overlayCtx.setLineDash([]);\n  overlayCtx.restore();\n}\nfunction focusGeometry()',
    1
)
# Re-sync preview layout when device orientation changes without restarting the decoder.
insert = 'window.addEventListener("airgapper:enter-receive", () => {\n  if (!stream && !startBtn.disabled) void start();\n});\n'
if insert not in text:
    raise SystemExit("receive/main.js: enter receive listener missing")
text = text.replace(insert, insert + 'screen.orientation?.addEventListener?.("change", () => { if (nativeCamera2) { syncNativePreviewAspect(); queueOverlayDraw(); } });\n', 1)
p.write_text(text)

print("native camera runtime patch applied")
