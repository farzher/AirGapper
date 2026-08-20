package com.airgapper.app;

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
        default boolean directFrame() { return false; }
        default void onDirectFrame(ByteBuffer bytes, long timestampNs) {}
        void onFrame(byte[] bytes, long timestampNs);
        void onError(String message);
    }

    private static final int EGL_OPENGL_ES3_BIT_KHR = 0x40;
    private static final float[] QUAD = {
            -1f, -1f, 0f, 1f,
             1f, -1f, 1f, 1f,
            -1f,  1f, 0f, 0f,
             1f,  1f, 1f, 0f
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
    private int samplerLocation;
    private int width;
    private int height;
    private int outputOffset;
    private ByteBuffer readback;
    private byte[] output;
    private boolean closed = true;

    NativeGpuCameraReader(Handler handler, Sink sink) {
        this.handler = handler;
        this.sink = sink;
        quad = ByteBuffer.allocateDirect(QUAD.length * 4)
                .order(ByteOrder.nativeOrder()).asFloatBuffer();
        quad.put(QUAD).position(0);
    }

    Surface open(int width, int height, int outputOffset) {
        close();
        this.width = width;
        this.height = height;
        this.outputOffset = Math.max(0, outputOffset);
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
        GLES20.glPixelStorei(GLES20.GL_PACK_ALIGNMENT, 1);
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
        samplerLocation = GLES20.glGetUniformLocation(program, "uCamera");
        GLES20.glUseProgram(program);
        GLES20.glUniform1i(samplerLocation, 0);
        GLES20.glDisable(GLES20.GL_BLEND);
        GLES20.glDisable(GLES20.GL_DEPTH_TEST);
        GLES20.glDisable(GLES20.GL_DITHER);
        readback = ByteBuffer.allocateDirect(width * height).order(ByteOrder.nativeOrder());
        output = new byte[outputOffset + width * height];
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
            final long timestampNs = surfaceTexture.getTimestamp();
            surfaceTexture.getTransformMatrix(textureMatrix);
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, framebuffer);
            GLES20.glViewport(0, 0, width, height);
            GLES20.glUseProgram(program);
            GLES20.glActiveTexture(GLES20.GL_TEXTURE0);
            GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, cameraTexture);
            GLES20.glUniform1i(samplerLocation, 0);
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
            readback.position(0);
            if (sink.directFrame()) {
                // The v2 decoder consumes this reusable direct buffer before we
                // return to the camera loop. No full-resolution Java/WebView copy.
                sink.onDirectFrame(readback, timestampNs);
            } else {
                readback.get(output, outputOffset, width * height);
                sink.onFrame(output, timestampNs);
            }
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
        output = null;
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
