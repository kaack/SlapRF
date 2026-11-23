package app.slaprf.gatecam;

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
import android.os.HandlerThread;
import android.view.Surface;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * HighSpeedGlPipe owns an EGL14 + GLES30 context and an OES SurfaceTexture accepted by Android's
 * CameraConstrainedHighSpeedCaptureSession (120 / 240 fps).
 *
 * Every incoming high-speed sensor frame is packed directly into 640x360 NV21 on the GPU
 * (using a 160x540 GL_RGBA8 FBO = 345,600 bytes) and streamed via 3-stage ping-pong GLES30 PBOs
 * into GateCamShim's ring buffer with zero CPU conversion and non-blocking eglSwapInterval(0).
 */
final class HighSpeedGlPipe implements SurfaceTexture.OnFrameAvailableListener {
    interface FrameSink {
        int getRotationDegrees();
        void onHighSpeedFrameReady(ByteBuffer mappedNv21Pbo, long sensorTimestampNs);
    }

    private static final int EGL_RECORDABLE_ANDROID = 0x3142;
    private static final int EGL_OPENGL_ES3_BIT_KHR = 0x0040;
    private static final int PBO_RING = 3;

    private static final String PREVIEW_VS =
            "attribute vec2 aPos;\n" +
            "attribute vec2 aUv;\n" +
            "uniform mat4 uTexMatrix;\n" +
            "uniform float uRotMode;\n" +
            "uniform float uCropFrac;\n" +
            "varying vec2 vTexCoord;\n" +
            "void main() {\n" +
            "    gl_Position = vec4(aPos, 0.0, 1.0);\n" +
            "    float u = aUv.x;\n" +
            "    float v = 0.5 + (aUv.y - 0.5) * uCropFrac;\n" +
            "    vec2 st;\n" +
            "    if (uRotMode > 0.5 && uRotMode < 1.5) {\n" +
            "        st = vec2(v, u);\n" +
            "    } else if (uRotMode > 1.5 && uRotMode < 2.5) {\n" +
            "        st = vec2(1.0 - v, 1.0 - u);\n" +
            "    } else if (uRotMode > 2.5) {\n" +
            "        st = vec2(1.0 - u, v);\n" +
            "    } else {\n" +
            "        st = vec2(u, 1.0 - v);\n" +
            "    }\n" +
            "    vTexCoord = (uTexMatrix * vec4(st, 0.0, 1.0)).xy;\n" +
            "}\n";

    private static final String PREVIEW_FS =
            "#extension GL_OES_EGL_image_external : require\n" +
            "precision mediump float;\n" +
            "varying vec2 vTexCoord;\n" +
            "uniform samplerExternalOES sTexture;\n" +
            "void main() {\n" +
            "    gl_FragColor = texture2D(sTexture, vTexCoord);\n" +
            "}\n";

    private static final String NV21_VS =
            "attribute vec2 aPos;\n" +
            "void main() {\n" +
            "    gl_Position = vec4(aPos, 0.0, 1.0);\n" +
            "}\n";

    private static final String NV21_FS =
            "#extension GL_OES_EGL_image_external : require\n" +
            "precision highp float;\n" +
            "uniform samplerExternalOES sTexture;\n" +
            "uniform mat4 uTexMatrix;\n" +
            "uniform float uRotMode;\n" +
            "uniform float uCropFrac;\n" +
            "uniform vec2 uOutSize;\n" +
            "vec2 mapUv(float u, float v) {\n" +
            "    float vc = 0.5 + (v - 0.5) * uCropFrac;\n" +
            "    vec2 st;\n" +
            "    if (uRotMode > 0.5 && uRotMode < 1.5) {\n" +
            "        st = vec2(vc, u);\n" +
            "    } else if (uRotMode > 1.5 && uRotMode < 2.5) {\n" +
            "        st = vec2(1.0 - vc, 1.0 - u);\n" +
            "    } else if (uRotMode > 2.5) {\n" +
            "        st = vec2(1.0 - u, vc);\n" +
            "    } else {\n" +
            "        st = vec2(u, 1.0 - vc);\n" +
            "    }\n" +
            "    return (uTexMatrix * vec4(st, 0.0, 1.0)).xy;\n" +
            "}\n" +
            "float rgbToY(vec3 c) {\n" +
            "    return clamp(0.299 * c.r + 0.587 * c.g + 0.114 * c.b, 0.0, 1.0);\n" +
            "}\n" +
            "vec2 rgbToVU(vec3 c) {\n" +
            "    float v = clamp(0.5 + 0.5 * c.r - 0.418688 * c.g - 0.081312 * c.b, 0.0, 1.0);\n" +
            "    float u = clamp(0.5 - 0.168736 * c.r - 0.331264 * c.g + 0.5 * c.b, 0.0, 1.0);\n" +
            "    return vec2(v, u);\n" +
            "}\n" +
            "void main() {\n" +
            "    float row = floor(gl_FragCoord.y);\n" +
            "    float baseX = floor(gl_FragCoord.x) * 4.0;\n" +
            "    if (row < uOutSize.y) {\n" +
            "        float v = (row + 0.5) / uOutSize.y;\n" +
            "        float y0 = rgbToY(texture2D(sTexture, mapUv((baseX + 0.5) / uOutSize.x, v)).rgb);\n" +
            "        float y1 = rgbToY(texture2D(sTexture, mapUv((baseX + 1.5) / uOutSize.x, v)).rgb);\n" +
            "        float y2 = rgbToY(texture2D(sTexture, mapUv((baseX + 2.5) / uOutSize.x, v)).rgb);\n" +
            "        float y3 = rgbToY(texture2D(sTexture, mapUv((baseX + 3.5) / uOutSize.x, v)).rgb);\n" +
            "        gl_FragColor = vec4(y0, y1, y2, y3);\n" +
            "    } else {\n" +
            "        float uvRow = row - uOutSize.y;\n" +
            "        float v = (uvRow * 2.0 + 1.0) / uOutSize.y;\n" +
            "        vec2 vu0 = rgbToVU(texture2D(sTexture, mapUv((baseX + 1.0) / uOutSize.x, v)).rgb);\n" +
            "        vec2 vu1 = rgbToVU(texture2D(sTexture, mapUv((baseX + 3.0) / uOutSize.x, v)).rgb);\n" +
            "        gl_FragColor = vec4(vu0.x, vu0.y, vu1.x, vu1.y);\n" +
            "    }\n" +
            "}\n";

    private final int capW;
    private final int capH;
    private final int outW;
    private final int outH;
    private final int fboW;
    private final int fboH;
    private final int nv21Bytes;
    private final FrameSink sink;

    private HandlerThread glThread;
    private Handler glHandler;

    private EGLDisplay eglDisplay = EGL14.EGL_NO_DISPLAY;
    private EGLContext eglContext = EGL14.EGL_NO_CONTEXT;
    private EGLConfig eglConfig = null;
    private EGLSurface pbufferSurface = EGL14.EGL_NO_SURFACE;
    private EGLSurface windowSurface = EGL14.EGL_NO_SURFACE;
    private Surface boundPreviewSurface = null;

    private int oesTexId = 0;
    private SurfaceTexture camSurfaceTexture = null;
    private Surface camInputSurface = null;

    private int prevProgId = 0;
    private int prevAPosLoc = 0;
    private int prevAUvLoc = 0;
    private int prevUTexMatrixLoc = 0;
    private int prevURotModeLoc = 0;
    private int prevUCropFracLoc = 0;

    private int nv21ProgId = 0;
    private int nv21APosLoc = 0;
    private int nv21UTexMatrixLoc = 0;
    private int nv21URotModeLoc = 0;
    private int nv21UCropFracLoc = 0;
    private int nv21UOutSizeLoc = 0;

    private FloatBuffer screenPosBuf;
    private FloatBuffer uvBuf;
    private final float[] stMatrix = new float[16];

    private int fboId = 0;
    private int fboTexId = 0;
    private final int[] pboIds = new int[PBO_RING];
    private final long[] pboTimestampNs = new long[PBO_RING];
    private int pboFrameCount = 0;
    private long lastPreviewDrawNs = 0;

    private volatile boolean released = false;

    HighSpeedGlPipe(int capW, int capH, int outW, int outH, FrameSink sink) {
        this.capW = capW;
        this.capH = capH;
        this.outW = outW;
        this.outH = outH;
        this.fboW = outW / 4;
        this.fboH = outH + outH / 2;
        this.nv21Bytes = outW * outH * 3 / 2;
        this.sink = sink;
    }

    boolean start(final SurfaceTexture previewSt) {
        glThread = new HandlerThread("GateCamHighSpeedGL");
        glThread.start();
        glHandler = new Handler(glThread.getLooper());

        final CountDownLatch latch = new CountDownLatch(1);
        final boolean[] ok = new boolean[]{false};
        glHandler.post(new Runnable() {
            @Override
            public void run() {
                try {
                    ok[0] = initGlOnThread(previewSt);
                } catch (Throwable ignored) {
                    ok[0] = false;
                } finally {
                    latch.countDown();
                }
            }
        });
        try {
            latch.await(1500, TimeUnit.MILLISECONDS);
        } catch (InterruptedException ignored) {
        }
        if (!ok[0]) {
            release();
            return false;
        }
        return true;
    }

    Surface getCameraInputSurface() {
        return camInputSurface;
    }

    void release() {
        if (released) return;
        released = true;
        final Handler h = glHandler;
        final HandlerThread ht = glThread;
        glHandler = null;
        glThread = null;
        if (h != null) {
            final CountDownLatch latch = new CountDownLatch(1);
            h.post(new Runnable() {
                @Override
                public void run() {
                    try {
                        teardownGlOnThread();
                    } finally {
                        if (ht != null) ht.quitSafely();
                        latch.countDown();
                    }
                }
            });
            try {
                latch.await(500, TimeUnit.MILLISECONDS);
            } catch (InterruptedException ignored) {
            }
        } else if (ht != null) {
            ht.quitSafely();
        }
    }

    private boolean initGlOnThread(SurfaceTexture previewSt) {
        eglDisplay = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY);
        if (eglDisplay == EGL14.EGL_NO_DISPLAY) return false;
        int[] vers = new int[2];
        if (!EGL14.eglInitialize(eglDisplay, vers, 0, vers, 1)) return false;

        int[] attribList = new int[]{
                EGL14.EGL_RED_SIZE, 8,
                EGL14.EGL_GREEN_SIZE, 8,
                EGL14.EGL_BLUE_SIZE, 8,
                EGL14.EGL_ALPHA_SIZE, 8,
                EGL14.EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT_KHR,
                EGL_RECORDABLE_ANDROID, 1,
                EGL14.EGL_NONE
        };
        EGLConfig[] configs = new EGLConfig[1];
        int[] numConfigs = new int[1];
        if (!EGL14.eglChooseConfig(eglDisplay, attribList, 0, configs, 0, 1, numConfigs, 0) || numConfigs[0] <= 0) {
            attribList = new int[]{
                    EGL14.EGL_RED_SIZE, 8,
                    EGL14.EGL_GREEN_SIZE, 8,
                    EGL14.EGL_BLUE_SIZE, 8,
                    EGL14.EGL_ALPHA_SIZE, 8,
                    EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
                    EGL14.EGL_NONE
            };
            if (!EGL14.eglChooseConfig(eglDisplay, attribList, 0, configs, 0, 1, numConfigs, 0) || numConfigs[0] <= 0) {
                return false;
            }
        }
        eglConfig = configs[0];

        int[] ctxAttribs = new int[]{EGL14.EGL_CONTEXT_CLIENT_VERSION, 3, EGL14.EGL_NONE};
        eglContext = EGL14.eglCreateContext(eglDisplay, eglConfig, EGL14.EGL_NO_CONTEXT, ctxAttribs, 0);
        if (eglContext == null || eglContext == EGL14.EGL_NO_CONTEXT) return false;

        int[] pbufAttribs = new int[]{EGL14.EGL_WIDTH, 16, EGL14.EGL_HEIGHT, 16, EGL14.EGL_NONE};
        pbufferSurface = EGL14.eglCreatePbufferSurface(eglDisplay, eglConfig, pbufAttribs, 0);
        if (!EGL14.eglMakeCurrent(eglDisplay, pbufferSurface, pbufferSurface, eglContext)) return false;

        prevProgId = buildProgram(PREVIEW_VS, PREVIEW_FS);
        nv21ProgId = buildProgram(NV21_VS, NV21_FS);
        if (prevProgId == 0 || nv21ProgId == 0) return false;

        prevAPosLoc = GLES20.glGetAttribLocation(prevProgId, "aPos");
        prevAUvLoc = GLES20.glGetAttribLocation(prevProgId, "aUv");
        prevUTexMatrixLoc = GLES20.glGetUniformLocation(prevProgId, "uTexMatrix");
        prevURotModeLoc = GLES20.glGetUniformLocation(prevProgId, "uRotMode");
        prevUCropFracLoc = GLES20.glGetUniformLocation(prevProgId, "uCropFrac");

        nv21APosLoc = GLES20.glGetAttribLocation(nv21ProgId, "aPos");
        nv21UTexMatrixLoc = GLES20.glGetUniformLocation(nv21ProgId, "uTexMatrix");
        nv21URotModeLoc = GLES20.glGetUniformLocation(nv21ProgId, "uRotMode");
        nv21UCropFracLoc = GLES20.glGetUniformLocation(nv21ProgId, "uCropFrac");
        nv21UOutSizeLoc = GLES20.glGetUniformLocation(nv21ProgId, "uOutSize");

        screenPosBuf = makeFloatBuffer(new float[]{
                -1f,  1f,
                -1f, -1f,
                 1f,  1f,
                 1f, -1f
        });
        uvBuf = makeFloatBuffer(new float[]{
                0f, 0f,
                0f, 1f,
                1f, 0f,
                1f, 1f
        });

        int[] tex = new int[2];
        GLES20.glGenTextures(2, tex, 0);
        oesTexId = tex[0];
        fboTexId = tex[1];

        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, oesTexId);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE);

        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, fboTexId);
        GLES20.glTexImage2D(GLES20.GL_TEXTURE_2D, 0, GLES20.GL_RGBA, fboW, fboH, 0, GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, null);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_NEAREST);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_NEAREST);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE);

        int[] fbos = new int[1];
        GLES20.glGenFramebuffers(1, fbos, 0);
        fboId = fbos[0];
        GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, fboId);
        GLES20.glFramebufferTexture2D(GLES20.GL_FRAMEBUFFER, GLES20.GL_COLOR_ATTACHMENT0, GLES20.GL_TEXTURE_2D, fboTexId, 0);
        if (GLES20.glCheckFramebufferStatus(GLES20.GL_FRAMEBUFFER) != GLES20.GL_FRAMEBUFFER_COMPLETE) {
            return false;
        }
        GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0);

        GLES30.glGenBuffers(PBO_RING, pboIds, 0);
        for (int i = 0; i < PBO_RING; i++) {
            GLES30.glBindBuffer(GLES30.GL_PIXEL_PACK_BUFFER, pboIds[i]);
            GLES30.glBufferData(GLES30.GL_PIXEL_PACK_BUFFER, nv21Bytes, null, GLES30.GL_DYNAMIC_READ);
        }
        GLES30.glBindBuffer(GLES30.GL_PIXEL_PACK_BUFFER, 0);

        camSurfaceTexture = new SurfaceTexture(oesTexId);
        camSurfaceTexture.setDefaultBufferSize(capW, capH);
        camSurfaceTexture.setOnFrameAvailableListener(this, glHandler);
        camInputSurface = new Surface(camSurfaceTexture);

        if (previewSt != null) {
            try {
                previewSt.setDefaultBufferSize(outW, outH);
                boundPreviewSurface = new Surface(previewSt);
                int[] surfAttribs = new int[]{EGL14.EGL_NONE};
                windowSurface = EGL14.eglCreateWindowSurface(eglDisplay, eglConfig, boundPreviewSurface, surfAttribs, 0);
                if (windowSurface != EGL14.EGL_NO_SURFACE) {
                    if (EGL14.eglMakeCurrent(eglDisplay, windowSurface, windowSurface, eglContext)) {
                        EGL14.eglSwapInterval(eglDisplay, 0);
                    }
                }
            } catch (Throwable ignored) {
                windowSurface = EGL14.EGL_NO_SURFACE;
                EGL14.eglMakeCurrent(eglDisplay, pbufferSurface, pbufferSurface, eglContext);
            }
        }
        return true;
    }

    @Override
    public void onFrameAvailable(SurfaceTexture surfaceTexture) {
        if (released || eglDisplay == EGL14.EGL_NO_DISPLAY || camSurfaceTexture == null) return;
        try {
            camSurfaceTexture.updateTexImage();
            camSurfaceTexture.getTransformMatrix(stMatrix);
            long tsNs = camSurfaceTexture.getTimestamp();

            int rotDeg = sink.getRotationDegrees();
            boolean stAlreadyRotated = Math.abs(stMatrix[1]) > 0.5f || Math.abs(stMatrix[4]) > 0.5f;
            float rotMode = 0.0f;
            float cropFrac = 1.0f;

            if (rotDeg == 90 || rotDeg == 270) {
                float wantH = (float) capH * ((float) outH / (float) outW);
                cropFrac = Math.min(1.0f, wantH / (float) Math.max(1, capW));
                if (!stAlreadyRotated) {
                    rotMode = (rotDeg == 270) ? 2.0f : 1.0f;
                }
            } else {
                float wantH = (float) capW * ((float) outH / (float) outW);
                cropFrac = Math.min(1.0f, wantH / (float) Math.max(1, capH));
                if (!stAlreadyRotated && rotDeg == 180) {
                    rotMode = 3.0f;
                }
            }

            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, fboId);
            GLES20.glViewport(0, 0, fboW, fboH);
            GLES20.glUseProgram(nv21ProgId);
            GLES20.glActiveTexture(GLES20.GL_TEXTURE0);
            GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, oesTexId);
            GLES20.glUniformMatrix4fv(nv21UTexMatrixLoc, 1, false, stMatrix, 0);
            GLES20.glUniform1f(nv21URotModeLoc, rotMode);
            GLES20.glUniform1f(nv21UCropFracLoc, cropFrac);
            GLES20.glUniform2f(nv21UOutSizeLoc, (float) outW, (float) outH);
            GLES20.glEnableVertexAttribArray(nv21APosLoc);
            GLES20.glVertexAttribPointer(nv21APosLoc, 2, GLES20.GL_FLOAT, false, 0, screenPosBuf);
            GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);

            int writeIdx = pboFrameCount % PBO_RING;
            int readIdx = (pboFrameCount + 1) % PBO_RING;
            pboTimestampNs[writeIdx] = tsNs;

            GLES30.glBindBuffer(GLES30.GL_PIXEL_PACK_BUFFER, pboIds[writeIdx]);
            GLES30.glReadPixels(0, 0, fboW, fboH, GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, 0);

            if (pboFrameCount >= PBO_RING - 1) {
                GLES30.glBindBuffer(GLES30.GL_PIXEL_PACK_BUFFER, pboIds[readIdx]);
                ByteBuffer buf = (ByteBuffer) GLES30.glMapBufferRange(
                        GLES30.GL_PIXEL_PACK_BUFFER, 0, nv21Bytes, GLES30.GL_MAP_READ_BIT);
                if (buf != null) {
                    buf.position(0);
                    sink.onHighSpeedFrameReady(buf, pboTimestampNs[readIdx]);
                    GLES30.glUnmapBuffer(GLES30.GL_PIXEL_PACK_BUFFER);
                }
            }
            GLES30.glBindBuffer(GLES30.GL_PIXEL_PACK_BUFFER, 0);
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0);
            pboFrameCount++;

            if (windowSurface != EGL14.EGL_NO_SURFACE && (tsNs - lastPreviewDrawNs) >= 18_000_000L) {
                lastPreviewDrawNs = tsNs;
                GLES20.glViewport(0, 0, outW, outH);
                GLES20.glUseProgram(prevProgId);
                GLES20.glUniformMatrix4fv(prevUTexMatrixLoc, 1, false, stMatrix, 0);
                GLES20.glUniform1f(prevURotModeLoc, rotMode);
                GLES20.glUniform1f(prevUCropFracLoc, cropFrac);
                GLES20.glEnableVertexAttribArray(prevAPosLoc);
                GLES20.glEnableVertexAttribArray(prevAUvLoc);
                GLES20.glVertexAttribPointer(prevAPosLoc, 2, GLES20.GL_FLOAT, false, 0, screenPosBuf);
                GLES20.glVertexAttribPointer(prevAUvLoc, 2, GLES20.GL_FLOAT, false, 0, uvBuf);
                GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);
                EGL14.eglSwapBuffers(eglDisplay, windowSurface);
            }
        } catch (Throwable ignored) {
        }
    }

    private void teardownGlOnThread() {
        try {
            if (camInputSurface != null) {
                camInputSurface.release();
                camInputSurface = null;
            }
        } catch (Throwable ignored) {}
        try {
            if (camSurfaceTexture != null) {
                camSurfaceTexture.setOnFrameAvailableListener(null);
                camSurfaceTexture.release();
                camSurfaceTexture = null;
            }
        } catch (Throwable ignored) {}

        if (eglDisplay != EGL14.EGL_NO_DISPLAY) {
            EGL14.eglMakeCurrent(eglDisplay, pbufferSurface, pbufferSurface, eglContext);
            if (pboIds[0] != 0) {
                GLES30.glDeleteBuffers(PBO_RING, pboIds, 0);
                for (int i = 0; i < PBO_RING; i++) pboIds[i] = 0;
            }
            if (fboId != 0) {
                GLES20.glDeleteFramebuffers(1, new int[]{fboId}, 0);
                fboId = 0;
            }
            if (oesTexId != 0 || fboTexId != 0) {
                GLES20.glDeleteTextures(2, new int[]{oesTexId, fboTexId}, 0);
                oesTexId = 0;
                fboTexId = 0;
            }
            if (prevProgId != 0) {
                GLES20.glDeleteProgram(prevProgId);
                prevProgId = 0;
            }
            if (nv21ProgId != 0) {
                GLES20.glDeleteProgram(nv21ProgId);
                nv21ProgId = 0;
            }
            EGL14.eglMakeCurrent(eglDisplay, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT);
            if (windowSurface != EGL14.EGL_NO_SURFACE) {
                EGL14.eglDestroySurface(eglDisplay, windowSurface);
                windowSurface = EGL14.EGL_NO_SURFACE;
            }
            if (pbufferSurface != EGL14.EGL_NO_SURFACE) {
                EGL14.eglDestroySurface(eglDisplay, pbufferSurface);
                pbufferSurface = EGL14.EGL_NO_SURFACE;
            }
            if (eglContext != EGL14.EGL_NO_CONTEXT) {
                EGL14.eglDestroyContext(eglDisplay, eglContext);
                eglContext = EGL14.EGL_NO_CONTEXT;
            }
            EGL14.eglTerminate(eglDisplay);
            eglDisplay = EGL14.EGL_NO_DISPLAY;
        }
        try {
            if (boundPreviewSurface != null) {
                boundPreviewSurface.release();
                boundPreviewSurface = null;
            }
        } catch (Throwable ignored) {}
    }

    private static FloatBuffer makeFloatBuffer(float[] arr) {
        ByteBuffer bb = ByteBuffer.allocateDirect(arr.length * 4).order(ByteOrder.nativeOrder());
        FloatBuffer fb = bb.asFloatBuffer();
        fb.put(arr);
        fb.position(0);
        return fb;
    }

    private static int buildProgram(String vsSrc, String fsSrc) {
        int vs = compileShader(GLES20.GL_VERTEX_SHADER, vsSrc);
        int fs = compileShader(GLES20.GL_FRAGMENT_SHADER, fsSrc);
        if (vs == 0 || fs == 0) return 0;
        int prog = GLES20.glCreateProgram();
        GLES20.glAttachShader(prog, vs);
        GLES20.glAttachShader(prog, fs);
        GLES20.glLinkProgram(prog);
        int[] link = new int[1];
        GLES20.glGetProgramiv(prog, GLES20.GL_LINK_STATUS, link, 0);
        GLES20.glDeleteShader(vs);
        GLES20.glDeleteShader(fs);
        if (link[0] == 0) {
            GLES20.glDeleteProgram(prog);
            return 0;
        }
        return prog;
    }

    private static int compileShader(int type, String src) {
        int sh = GLES20.glCreateShader(type);
        GLES20.glShaderSource(sh, src);
        GLES20.glCompileShader(sh);
        int[] ok = new int[1];
        GLES20.glGetShaderiv(sh, GLES20.GL_COMPILE_STATUS, ok, 0);
        if (ok[0] == 0) {
            GLES20.glDeleteShader(sh);
            return 0;
        }
        return sh;
    }
}
