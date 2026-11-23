package app.slaprf.gatecam;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.graphics.ImageFormat;
import android.graphics.Matrix;
import android.graphics.Rect;
import android.graphics.SurfaceTexture;
import android.graphics.YuvImage;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CameraMetadata;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.CaptureResult;
import android.hardware.camera2.TotalCaptureResult;
import android.hardware.camera2.params.MeteringRectangle;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.Image;
import android.media.ImageReader;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;
import android.util.Range;
import android.util.Size;
import android.view.Surface;
import android.view.TextureView;
import android.view.WindowManager;

import org.json.JSONArray;
import org.json.JSONObject;
import org.opencv.android.OpenCVLoader;
import org.opencv.core.Core;
import org.opencv.core.CvType;
import org.opencv.core.Mat;
import org.opencv.core.MatOfByte;
import org.opencv.core.MatOfFloat;
import org.opencv.core.MatOfInt;
import org.opencv.core.MatOfPoint;
import org.opencv.core.MatOfPoint2f;
import org.opencv.core.Point;
import org.opencv.core.Scalar;
import org.opencv.imgcodecs.Imgcodecs;
import org.opencv.imgproc.Imgproc;
import org.opencv.video.BackgroundSubtractor;
import org.opencv.video.Video;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * GateCamShim manages Camera2 60/120 fps capture, the pre-allocated 168-slot zero-GC 640x360 NV21
 * circular ring buffer, and retrospective OpenCV 4.12 motion/optical-flow lookback analysis.
 */
public final class GateCamShim {
    private static final int RING_W = 360;
    private static final int RING_H = 640;
    private static final int NV21_BYTES = RING_W * RING_H * 3 / 2;
    private static final int RING_CAP = 168; // ~58 MB static allocation, zero per-frame GC

    private static Context appCtx;
    private static volatile Activity activeActivity;
    private static volatile TextureView previewTexture;
    private static volatile int previewWidth = 1280;
    private static volatile int previewHeight = 720;

    private static HandlerThread camThread;
    private static Handler camHandler;
    private static CameraDevice cameraDevice;
    private static CameraCaptureSession captureSession;
    private static ImageReader yuvReader;
    private static Surface previewSurface;

    private static String cameraId = "";
    private static int sensorOrientation = 90;
    private static volatile int timestampSource = CameraMetadata.SENSOR_INFO_TIMESTAMP_SOURCE_UNKNOWN;
    private static Rect activeArrayRect = new Rect(0, 0, 1280, 720);
    private static Range<Integer> isoRange = new Range<>(100, 3200);
    private static List<Range<Integer>> availableFpsRanges = new ArrayList<>();
    private static boolean supports120Fps = false;

    // Requested camera configuration
    private static volatile int targetFps = 120;
    private static volatile int shutterUs = 500; // 0=Auto, 1000=1/1000s, 500=1/2000s, 250=1/4000s
    private static volatile boolean focusLocked = false;
    private static volatile Float lockedFocusDist = null;
    private static volatile String lastError = "";

    // Zero-GC Circular Frame + Metadata Ring Buffer
    private static final Object ringLock = new Object();
    private static final byte[][] ringNV21 = new byte[RING_CAP][NV21_BYTES];
    private static final long[] ringSensorTsNs = new long[RING_CAP];
    private static final long[] ringExposureNs = new long[RING_CAP];
    private static final long[] ringSkewNs = new long[RING_CAP];
    private static int ringHead = 0;
    private static int ringCount = 0;
    private static volatile double measuredFps = 60.0;
    private static long prevFrameTsNs = 0;

    // Recent CaptureResult metadata cache (keyed by SENSOR_TIMESTAMP, 32-entry ring)
    private static final Object metaLock = new Object();
    private static final long[] metaTsKey = new long[32];
    private static final long[] metaExpNs = new long[32];
    private static final long[] metaSkewNs = new long[32];
    private static int metaHead = 0;
    private static volatile long latestExposureNs = 500_000L;
    private static volatile long latestSkewNs = 8_000_000L;

    // Transient extracted burst JPEG cache retrieved by Go over JNI
    private static final class BurstBuffers {
        final byte[][] colorJpegs;
        final byte[][] maskJpegs;
        BurstBuffers(int n) {
            this.colorJpegs = new byte[n][];
            this.maskJpegs = new byte[n][];
        }
    }
    private static final AtomicInteger nextBurstId = new AtomicInteger(1);
    private static final ConcurrentHashMap<Integer, BurstBuffers> activeBursts = new ConcurrentHashMap<>();

    private GateCamShim() {}

    public static synchronized void init(Context ctx, Activity act) {
        appCtx = ctx.getApplicationContext();
        activeActivity = act;
        ensureThread();
    }

    public static void setActivity(Activity act) {
        activeActivity = act;
    }

    private static synchronized void ensureThread() {
        if (camThread == null) {
            camThread = new HandlerThread("GateCamCamera2");
            camThread.start();
            camHandler = new Handler(camThread.getLooper());
        }
    }

    public static void onPreviewSurfaceAvailable(TextureView tv, int w, int h) {
        previewTexture = tv;
        previewWidth = w;
        previewHeight = h;
        applyPreviewTransform(tv, w, h);
    }

    public static void onPreviewSurfaceSizeChanged(TextureView tv, int w, int h) {
        previewTexture = tv;
        previewWidth = w;
        previewHeight = h;
        applyPreviewTransform(tv, w, h);
    }

    public static void onPreviewSurfaceDestroyed() {
        stopCamera();
        previewTexture = null;
    }

    private static int getDisplayRotation() {
        Activity act = activeActivity;
        if (act != null) {
            WindowManager wm = act.getWindowManager();
            if (wm != null && wm.getDefaultDisplay() != null) {
                return wm.getDefaultDisplay().getRotation();
            }
        }
        return Surface.ROTATION_0;
    }

    private static int computeSensorToDisplayDegrees() {
        int rot = getDisplayRotation();
        int deg = 0;
        switch (rot) {
            case Surface.ROTATION_0: deg = 0; break;
            case Surface.ROTATION_90: deg = 90; break;
            case Surface.ROTATION_180: deg = 180; break;
            case Surface.ROTATION_270: deg = 270; break;
        }
        return (sensorOrientation - deg + 360) % 360;
    }

    private static void applyPreviewTransform(final TextureView tv, final int viewW, final int viewH) {
        if (tv == null || viewW <= 0 || viewH <= 0) return;
        tv.post(new Runnable() {
            @Override
            public void run() {
                int rot = getDisplayRotation();
                Matrix m = new Matrix();
                float cx = viewW * 0.5f;
                float cy = viewH * 0.5f;
                if (Surface.ROTATION_90 == rot || Surface.ROTATION_270 == rot) {
                    m.postScale((float) viewH / (float) viewW, (float) viewW / (float) viewH, cx, cy);
                    m.postRotate(90 * (rot - 2), cx, cy);
                } else if (Surface.ROTATION_180 == rot) {
                    m.postRotate(180, cx, cy);
                }
                tv.setTransform(m);
            }
        });
    }

    @SuppressLint("MissingPermission")
    public static synchronized void startCameraIfReady() {
        if (appCtx == null || previewTexture == null || !previewTexture.isAvailable() || cameraDevice != null) {
            return;
        }
        ensureThread();
        try {
            CameraManager cm = (CameraManager) appCtx.getSystemService(Context.CAMERA_SERVICE);
            if (cm == null) return;

            String chosen = null;
            for (String id : cm.getCameraIdList()) {
                CameraCharacteristics cc = cm.getCameraCharacteristics(id);
                Integer facing = cc.get(CameraCharacteristics.LENS_FACING);
                if (facing != null && facing == CameraCharacteristics.LENS_FACING_BACK) {
                    chosen = id;
                    break;
                }
                if (chosen == null) chosen = id;
            }
            if (chosen == null) {
                lastError = "No camera found";
                return;
            }
            cameraId = chosen;
            CameraCharacteristics cc = cm.getCameraCharacteristics(cameraId);
            Integer so = cc.get(CameraCharacteristics.SENSOR_ORIENTATION);
            if (so != null) sensorOrientation = so;
            Integer tsSrc = cc.get(CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE);
            if (tsSrc != null) timestampSource = tsSrc;
            Rect aa = cc.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE);
            if (aa != null) activeArrayRect = aa;
            Range<Integer> sensRange = cc.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE);
            if (sensRange != null) isoRange = sensRange;

            Range<Integer>[] ranges = cc.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES);
            availableFpsRanges.clear();
            supports120Fps = false;
            if (ranges != null) {
                availableFpsRanges.addAll(Arrays.asList(ranges));
                for (Range<Integer> r : ranges) {
                    if (r.getUpper() >= 120) supports120Fps = true;
                }
            }
            StreamConfigurationMap map = cc.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            if (map != null) {
                long minDur = map.getOutputMinFrameDuration(ImageFormat.YUV_420_888, new Size(1280, 720));
                if (minDur > 0 && minDur <= 9_000_000L) {
                    supports120Fps = true;
                }
            }

            applyPreviewTransform(previewTexture, previewWidth, previewHeight);

            cm.openCamera(cameraId, new CameraDevice.StateCallback() {
                @Override
                public void onOpened(CameraDevice camera) {
                    synchronized (GateCamShim.class) {
                        cameraDevice = camera;
                        lastError = "";
                        createCapturePipelineLocked();
                    }
                }

                @Override
                public void onDisconnected(CameraDevice camera) {
                    camera.close();
                    synchronized (GateCamShim.class) {
                        cameraDevice = null;
                    }
                }

                @Override
                public void onError(CameraDevice camera, int error) {
                    camera.close();
                    synchronized (GateCamShim.class) {
                        cameraDevice = null;
                        lastError = "CameraDevice error " + error;
                    }
                }
            }, camHandler);
        } catch (Throwable t) {
            lastError = String.valueOf(t.getMessage());
        }
    }

    public static synchronized void stopCamera() {
        try {
            if (captureSession != null) {
                captureSession.close();
                captureSession = null;
            }
        } catch (Throwable ignored) {}
        try {
            if (cameraDevice != null) {
                cameraDevice.close();
                cameraDevice = null;
            }
        } catch (Throwable ignored) {}
        try {
            if (yuvReader != null) {
                yuvReader.close();
                yuvReader = null;
            }
        } catch (Throwable ignored) {}
        try {
            if (previewSurface != null) {
                previewSurface.release();
                previewSurface = null;
            }
        } catch (Throwable ignored) {}
    }

    private static synchronized void createCapturePipelineLocked() {
        if (cameraDevice == null || previewTexture == null || !previewTexture.isAvailable()) return;
        try {
            SurfaceTexture st = previewTexture.getSurfaceTexture();
            st.setDefaultBufferSize(1280, 720);
            if (previewSurface != null) previewSurface.release();
            previewSurface = new Surface(st);

            if (yuvReader != null) yuvReader.close();
            yuvReader = ImageReader.newInstance(1280, 720, ImageFormat.YUV_420_888, 6);
            yuvReader.setOnImageAvailableListener(new ImageReader.OnImageAvailableListener() {
                @Override
                public void onImageAvailable(ImageReader reader) {
                    Image img = null;
                    try {
                        img = reader.acquireLatestImage();
                        if (img != null) {
                            ingestYuvFrame(img);
                        }
                    } catch (Throwable ignored) {
                    } finally {
                        if (img != null) img.close();
                    }
                }
            }, camHandler);

            List<Surface> targets = Arrays.asList(previewSurface, yuvReader.getSurface());
            cameraDevice.createCaptureSession(targets, new CameraCaptureSession.StateCallback() {
                @Override
                public void onConfigured(CameraCaptureSession session) {
                    synchronized (GateCamShim.class) {
                        captureSession = session;
                        applyRepeatingRequestLocked();
                    }
                }

                @Override
                public void onConfigureFailed(CameraCaptureSession session) {
                    lastError = "CameraCaptureSession configuration failed";
                }
            }, camHandler);
        } catch (Throwable t) {
            lastError = String.valueOf(t.getMessage());
        }
    }

    private static Range<Integer> pickBestFpsRange(int desiredFps) {
        Range<Integer> best = null;
        for (Range<Integer> r : availableFpsRanges) {
            if (r.getUpper() == desiredFps && r.getLower() == desiredFps) {
                return r;
            }
            if (r.getUpper() <= desiredFps) {
                if (best == null || r.getUpper() > best.getUpper()
                        || (r.getUpper().equals(best.getUpper()) && r.getLower() > best.getLower())) {
                    best = r;
                }
            }
        }
        if (best != null) return best;
        return availableFpsRanges.isEmpty() ? new Range<>(30, 60) : availableFpsRanges.get(availableFpsRanges.size() - 1);
    }

    private static synchronized void applyRepeatingRequestLocked() {
        if (cameraDevice == null || captureSession == null || previewSurface == null || yuvReader == null) return;
        try {
            CaptureRequest.Builder b = cameraDevice.createCaptureRequest(CameraDevice.TEMPLATE_RECORD);
            b.addTarget(previewSurface);
            b.addTarget(yuvReader.getSurface());

            Range<Integer> fpsRange = pickBestFpsRange(targetFps);
            b.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, fpsRange);

            if (shutterUs > 0) {
                // Manual fast shutter for razor-sharp high-speed drone edges + boosted ISO
                b.set(CaptureRequest.CONTROL_AE_MODE, CameraMetadata.CONTROL_AE_MODE_OFF);
                b.set(CaptureRequest.SENSOR_EXPOSURE_TIME, (long) shutterUs * 1000L);
                long frameDurNs = 1_000_000_000L / Math.max(30, fpsRange.getUpper());
                b.set(CaptureRequest.SENSOR_FRAME_DURATION, frameDurNs);
                int targetIso = shutterUs <= 250 ? 1200 : (shutterUs <= 500 ? 700 : 400);
                targetIso = Math.max(isoRange.getLower(), Math.min(isoRange.getUpper(), targetIso));
                b.set(CaptureRequest.SENSOR_SENSITIVITY, targetIso);
            } else {
                b.set(CaptureRequest.CONTROL_AE_MODE, CameraMetadata.CONTROL_AE_MODE_ON);
            }

            if (focusLocked) {
                b.set(CaptureRequest.CONTROL_AWB_LOCK, true);
                if (lockedFocusDist != null) {
                    b.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_OFF);
                    b.set(CaptureRequest.LENS_FOCUS_DISTANCE, lockedFocusDist);
                }
            } else {
                b.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_VIDEO);
                b.set(CaptureRequest.CONTROL_AWB_LOCK, false);
            }

            captureSession.setRepeatingRequest(b.build(), captureCallback, camHandler);
        } catch (CameraAccessException e) {
            lastError = String.valueOf(e.getMessage());
        }
    }

    private static final CameraCaptureSession.CaptureCallback captureCallback = new CameraCaptureSession.CaptureCallback() {
        @Override
        public void onCaptureCompleted(CameraCaptureSession session, CaptureRequest request, TotalCaptureResult result) {
            Long ts = result.get(CaptureResult.SENSOR_TIMESTAMP);
            Long exp = result.get(CaptureResult.SENSOR_EXPOSURE_TIME);
            Long skew = result.get(CaptureResult.SENSOR_ROLLING_SHUTTER_SKEW);
            Float fd = result.get(CaptureResult.LENS_FOCUS_DISTANCE);
            if (fd != null && focusLocked && lockedFocusDist == null) {
                lockedFocusDist = fd;
            }
            if (exp != null && exp > 0) latestExposureNs = exp;
            if (skew != null && skew > 0) latestSkewNs = skew;
            if (ts != null) {
                synchronized (metaLock) {
                    metaTsKey[metaHead] = ts;
                    metaExpNs[metaHead] = latestExposureNs;
                    metaSkewNs[metaHead] = latestSkewNs;
                    metaHead = (metaHead + 1) & 31;
                }
            }
        }
    };

    private static void lookupCaptureMeta(long tsNs, long[] outExpAndSkew) {
        outExpAndSkew[0] = latestExposureNs;
        outExpAndSkew[1] = latestSkewNs;
        synchronized (metaLock) {
            for (int i = 0; i < 32; i++) {
                if (metaTsKey[i] == tsNs) {
                    outExpAndSkew[0] = metaExpNs[i];
                    outExpAndSkew[1] = metaSkewNs[i];
                    return;
                }
            }
        }
    }

    private static void ingestYuvFrame(Image img) {
        if (img.getFormat() != ImageFormat.YUV_420_888) return;
        int srcW = img.getWidth();
        int srcH = img.getHeight();
        if (srcW < RING_H || srcH < RING_W) return;

        long tsNs = img.getTimestamp();
        if (prevFrameTsNs > 0 && tsNs > prevFrameTsNs) {
            double instFps = 1e9 / (double) (tsNs - prevFrameTsNs);
            if (instFps >= 15.0 && instFps <= 260.0) {
                measuredFps = measuredFps * 0.90 + instFps * 0.10;
            }
        }
        prevFrameTsNs = tsNs;

        int rotDeg = computeSensorToDisplayDegrees();
        long[] meta = new long[2];
        lookupCaptureMeta(tsNs, meta);

        int slot;
        byte[] dst;
        synchronized (ringLock) {
            slot = ringHead;
            dst = ringNV21[slot];
        }

        downsamplePortraitYuv420ToNV21(img, dst, rotDeg);

        synchronized (ringLock) {
            ringSensorTsNs[slot] = tsNs;
            ringExposureNs[slot] = meta[0];
            ringSkewNs[slot] = meta[1];
            ringHead = (slot + 1) % RING_CAP;
            if (ringCount < RING_CAP) ringCount++;
        }
    }

    /**
     * Rotates 1280x720 landscape sensor YUV_420_888 by 90 deg CW (or 270 deg CW) and downsamples 2x
     * into upright 360x640 Portrait NV21 in a single zero-allocation pass.
     */
    private static void downsamplePortraitYuv420ToNV21(Image img, byte[] dst, int rotDeg) {
        Image.Plane[] planes = img.getPlanes();
        ByteBuffer yBuf = planes[0].getBuffer();
        ByteBuffer uBuf = planes[1].getBuffer();
        ByteBuffer vBuf = planes[2].getBuffer();
        int yRowStride = planes[0].getRowStride();
        int yPixStride = planes[0].getPixelStride();
        int uvRowStride = planes[1].getRowStride();
        int uvPixStride = planes[1].getPixelStride();

        int srcW = img.getWidth();   // 1280
        int srcH = img.getHeight();  // 720
        int stepAlongW = srcW / RING_H; // 1280 / 640 = 2
        int stepAlongH = srcH / RING_W; // 720 / 360 = 2
        boolean rot270 = (rotDeg == 270);

        // 1. Luma Y plane (360 wide x 640 tall)
        int outIdx = 0;
        for (int dy = 0; dy < RING_H; dy++) {
            int sx = rot270 ? (srcW - 1 - dy * stepAlongW) : (dy * stepAlongW);
            int sxOff = sx * yPixStride;
            for (int dx = 0; dx < RING_W; dx++) {
                int sy = rot270 ? (dx * stepAlongH) : (srcH - 1 - dx * stepAlongH);
                dst[outIdx++] = yBuf.get(sy * yRowStride + sxOff);
            }
        }

        // 2. Interleaved VU plane for NV21 (180 wide x 320 tall pairs)
        int uvH = RING_H / 2; // 320
        int uvW = RING_W / 2; // 180
        int srcUvW = srcW / 2; // 640
        int srcUvH = srcH / 2; // 360
        int uvStepW = Math.max(1, srcUvW / uvH);
        int uvStepH = Math.max(1, srcUvH / uvW);
        for (int dy = 0; dy < uvH; dy++) {
            int sx = rot270 ? (srcUvW - 1 - dy * uvStepW) : (dy * uvStepW);
            int sxOff = sx * uvPixStride;
            for (int dx = 0; dx < uvW; dx++) {
                int sy = rot270 ? (dx * uvStepH) : (srcUvH - 1 - dx * uvStepH);
                int off = sy * uvRowStride + sxOff;
                dst[outIdx++] = vBuf.get(off);
                dst[outIdx++] = uBuf.get(off);
            }
        }
    }

    // --- Static Methods Invoked by Go via JNI ---

    public static long currentSensorClockNs() {
        if (timestampSource == CameraMetadata.SENSOR_INFO_TIMESTAMP_SOURCE_REALTIME) {
            return SystemClock.elapsedRealtimeNanos();
        }
        return System.nanoTime();
    }

    public static String statusJson() {
        try {
            int filled;
            double spanMs = 0.0;
            synchronized (ringLock) {
                filled = ringCount;
                if (ringCount >= 2) {
                    int newest = (ringHead - 1 + RING_CAP) % RING_CAP;
                    int oldest = (ringHead - ringCount + RING_CAP) % RING_CAP;
                    long dtNs = ringSensorTsNs[newest] - ringSensorTsNs[oldest];
                    if (dtNs > 0) spanMs = dtNs / 1e6;
                }
            }
            JSONObject o = new JSONObject();
            o.put("active", cameraDevice != null && captureSession != null);
            o.put("frameWidth", RING_W);
            o.put("frameHeight", RING_H);
            o.put("actualFps", Math.round(measuredFps * 10.0) / 10.0);
            JSONArray fpsArr = new JSONArray();
            fpsArr.put(60);
            if (supports120Fps) fpsArr.put(120);
            o.put("supportedFps", fpsArr);
            o.put("shutterUs", shutterUs);
            o.put("focusLocked", focusLocked);
            o.put("ringCapacity", RING_CAP);
            o.put("ringFilled", filled);
            o.put("ringSpanMs", Math.round(spanMs * 10.0) / 10.0);
            o.put("timestampSource", timestampSource);
            o.put("opencvVersion", OpenCVLoader.OPENCV_VERSION);
            if (lastError != null && !lastError.isEmpty()) {
                o.put("lastError", lastError);
            }
            return o.toString();
        } catch (Throwable t) {
            return "{}";
        }
    }

    public static synchronized String configureJson(String cfgJson) {
        try {
            JSONObject o = new JSONObject(cfgJson);
            if (o.has("targetFps")) {
                int want = o.optInt("targetFps", 120);
                targetFps = (want >= 120 && supports120Fps) ? 120 : 60;
            }
            if (o.has("shutterUs")) {
                shutterUs = Math.max(0, o.optInt("shutterUs", 500));
            }
            if (o.has("focusLocked") && !o.optBoolean("focusLocked", false)) {
                focusLocked = false;
                lockedFocusDist = null;
            }
            applyRepeatingRequestLocked();
        } catch (Throwable t) {
            lastError = String.valueOf(t.getMessage());
        }
        return statusJson();
    }

    public static synchronized String triggerFocusLock(double normX, double normY) {
        if (cameraDevice == null || captureSession == null || previewSurface == null || yuvReader == null) {
            return "Camera is not active";
        }
        if (focusLocked) {
            // Toggle off if already locked
            focusLocked = false;
            lockedFocusDist = null;
            applyRepeatingRequestLocked();
            return "";
        }
        try {
            // Map upright Portrait (normX, normY) back to 90 deg CW landscape sensor activeArrayRect
            double sxNorm = Math.max(0.0, Math.min(1.0, normY));
            double syNorm = Math.max(0.0, Math.min(1.0, 1.0 - normX));
            int cx = activeArrayRect.left + (int) Math.round(sxNorm * activeArrayRect.width());
            int cy = activeArrayRect.top + (int) Math.round(syNorm * activeArrayRect.height());
            int half = Math.max(60, activeArrayRect.width() / 16);
            Rect r = new Rect(
                    Math.max(activeArrayRect.left, cx - half),
                    Math.max(activeArrayRect.top, cy - half),
                    Math.min(activeArrayRect.right, cx + half),
                    Math.min(activeArrayRect.bottom, cy + half));
            MeteringRectangle mr = new MeteringRectangle(r, MeteringRectangle.METERING_WEIGHT_MAX - 1);

            CaptureRequest.Builder trig = cameraDevice.createCaptureRequest(CameraDevice.TEMPLATE_RECORD);
            trig.addTarget(previewSurface);
            trig.addTarget(yuvReader.getSurface());
            trig.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_AUTO);
            trig.set(CaptureRequest.CONTROL_AF_REGIONS, new MeteringRectangle[]{mr});
            trig.set(CaptureRequest.CONTROL_AF_TRIGGER, CameraMetadata.CONTROL_AF_TRIGGER_START);
            captureSession.capture(trig.build(), captureCallback, camHandler);

            focusLocked = true;
            camHandler.postDelayed(new Runnable() {
                @Override
                public void run() {
                    synchronized (GateCamShim.class) {
                        applyRepeatingRequestLocked();
                    }
                }
            }, 450);
            return "";
        } catch (Throwable t) {
            return String.valueOf(t.getMessage());
        }
    }

    public static byte[] latestPreviewJpeg() {
        byte[] copy = null;
        synchronized (ringLock) {
            if (ringCount > 0) {
                int newest = (ringHead - 1 + RING_CAP) % RING_CAP;
                copy = Arrays.copyOf(ringNV21[newest], NV21_BYTES);
            }
        }
        if (copy == null) return null;
        return encodeNV21ToJpeg(copy, 75);
    }

    private static byte[] encodeNV21ToJpeg(byte[] nv21, int quality) {
        try {
            YuvImage yuv = new YuvImage(nv21, ImageFormat.NV21, RING_W, RING_H, null);
            ByteArrayOutputStream out = new ByteArrayOutputStream(28672);
            yuv.compressToJpeg(new Rect(0, 0, RING_W, RING_H), quality, out);
            return out.toByteArray();
        } catch (Throwable t) {
            return null;
        }
    }

    public static byte[] getBurstFrameJpeg(int burstId, int frameIdx, boolean isMask) {
        BurstBuffers b = activeBursts.get(burstId);
        if (b == null) return null;
        byte[][] arr = isMask ? b.maskJpegs : b.colorJpegs;
        if (frameIdx < 0 || frameIdx >= arr.length) return null;
        return arr[frameIdx];
    }

    public static void releaseBurst(int burstId) {
        activeBursts.remove(burstId);
    }

    /**
     * Slices buffered frames inside [startSensorNs, endSensorNs] and runs OpenCV 4.12
     * BackgroundSubtractorMOG2/KNN (shadow rejection) + morphologyEx + connectedComponentsWithStats
     * + Pyramidal Lucas-Kanade optical flow inside the Gate Plane corridor.
     */
    public static String extractAndAnalyzeJson(String reqJson) {
        try {
            JSONObject req = new JSONObject(reqJson);
            long startNs = req.optLong("startSensorNs", 0);
            long endNs = req.optLong("endSensorNs", 0);
            String model = req.optString("motionModel", "mog2");
            double sens = req.optDouble("sensitivity", 16.0);
            JSONObject gateObj = req.optJSONObject("gate");
            double p1x = gateObj != null ? gateObj.optDouble("p1x", 0.5) : 0.5;
            double p1y = gateObj != null ? gateObj.optDouble("p1y", 0.14) : 0.14;
            double p2x = gateObj != null ? gateObj.optDouble("p2x", 0.5) : 0.5;
            double p2y = gateObj != null ? gateObj.optDouble("p2y", 0.86) : 0.86;
            double bandNorm = gateObj != null ? gateObj.optDouble("bandHalfWidthNorm", 0.18) : 0.18;

            // 1. Copy matching ring slots under lock in < 1 ms so live Camera2 capture never stalls
            List<byte[]> slicedNV21 = new ArrayList<>();
            List<Long> slicedTs = new ArrayList<>();
            List<Long> slicedExp = new ArrayList<>();
            List<Long> slicedSkew = new ArrayList<>();

            synchronized (ringLock) {
                int oldest = (ringHead - ringCount + RING_CAP) % RING_CAP;
                for (int i = 0; i < ringCount; i++) {
                    int idx = (oldest + i) % RING_CAP;
                    long ts = ringSensorTsNs[idx];
                    if (ts >= startNs && ts <= endNs) {
                        slicedNV21.add(Arrays.copyOf(ringNV21[idx], NV21_BYTES));
                        slicedTs.add(ts);
                        slicedExp.add(ringExposureNs[idx]);
                        slicedSkew.add(ringSkewNs[idx]);
                    }
                }
            }

            int n = slicedNV21.size();
            int burstId = nextBurstId.getAndIncrement();
            BurstBuffers burst = new BurstBuffers(n);
            activeBursts.put(burstId, burst);

            if (n == 0) {
                JSONObject empty = new JSONObject();
                empty.put("burstId", burstId);
                empty.put("frames", new JSONArray());
                return empty.toString();
            }

            // 2. Build Gate corridor mask (only pixels within ±bandPx of segment P1-P2 are evaluated)
            Mat corridorMask = Mat.zeros(RING_H, RING_W, CvType.CV_8UC1);
            int gx1 = (int) Math.round(p1x * RING_W);
            int gy1 = (int) Math.round(p1y * RING_H);
            int gx2 = (int) Math.round(p2x * RING_W);
            int gy2 = (int) Math.round(p2y * RING_H);
            int thickness = Math.max(48, (int) Math.round(bandNorm * RING_W * 2.0));
            Imgproc.line(corridorMask, new Point(gx1, gy1), new Point(gx2, gy2), new Scalar(255), thickness);

            BackgroundSubtractor bgSub = "knn".equalsIgnoreCase(model)
                    ? Video.createBackgroundSubtractorKNN(60, Math.max(100.0, sens * 25.0), true)
                    : Video.createBackgroundSubtractorMOG2(60, Math.max(4.0, sens), true);

            Mat kOpen = Imgproc.getStructuringElement(Imgproc.MORPH_ELLIPSE, new org.opencv.core.Size(3, 3));
            Mat kClose = Imgproc.getStructuringElement(Imgproc.MORPH_ELLIPSE, new org.opencv.core.Size(9, 9));
            Mat gray = new Mat(RING_H, RING_W, CvType.CV_8UC1);
            Mat prevGray = new Mat();
            Mat fgRaw = new Mat();
            Mat fgBin = new Mat();
            Mat fgCorridor = new Mat();
            Mat labels = new Mat();
            Mat stats = new Mat();
            Mat centroids = new Mat();
            MatOfInt jpgParams = new MatOfInt(Imgcodecs.IMWRITE_JPEG_QUALITY, 74);

            JSONArray framesJson = new JSONArray();
            try {
                // Warm up OpenCV background subtractor across 6 evenly spaced anchor frames
                int step = Math.max(1, n / 6);
                for (int pass = 0; pass < 2; pass++) {
                    for (int k = 0; k < n; k += step) {
                        gray.put(0, 0, Arrays.copyOfRange(slicedNV21.get(k), 0, RING_W * RING_H));
                        bgSub.apply(gray, fgRaw, 0.25);
                    }
                }

                for (int i = 0; i < n; i++) {
                    byte[] nv21 = slicedNV21.get(i);
                    burst.colorJpegs[i] = encodeNV21ToJpeg(nv21, 78);

                    gray.put(0, 0, Arrays.copyOfRange(nv21, 0, RING_W * RING_H));
                    // Freeze learning rate low (0.01) during sequential scan so slow drones don't absorb into bg
                    bgSub.apply(gray, fgRaw, 0.01);

                    // Strip MOG2/KNN cast shadows (127 -> 0, keeping 255 foreground)
                    Imgproc.threshold(fgRaw, fgBin, 200, 255, Imgproc.THRESH_BINARY);
                    Core.bitwise_and(fgBin, corridorMask, fgCorridor);
                    Imgproc.morphologyEx(fgCorridor, fgCorridor, Imgproc.MORPH_OPEN, kOpen);
                    Imgproc.morphologyEx(fgCorridor, fgCorridor, Imgproc.MORPH_CLOSE, kClose);

                    // Encode clean MOG2 foreground mask JPEG for Inspector's [MOG2 Mask] toggle
                    MatOfByte maskBuf = new MatOfByte();
                    if (Imgcodecs.imencode(".jpg", fgCorridor, maskBuf, jpgParams)) {
                        burst.maskJpegs[i] = maskBuf.toArray();
                    }
                    maskBuf.release();

                    int numLabels = Imgproc.connectedComponentsWithStats(fgCorridor, labels, stats, centroids);
                    int bestLabel = -1;
                    int bestArea = 0;
                    int[] statRow = new int[5];
                    for (int lbl = 1; lbl < numLabels; lbl++) {
                        stats.get(lbl, 0, statRow);
                        int area = statRow[4];
                        // Reject tiny speckle (<28 px) and global camera shake (>35% of frame)
                        if (area >= 28 && area <= (RING_W * RING_H * 35 / 100) && area > bestArea) {
                            bestArea = area;
                            bestLabel = lbl;
                        }
                    }

                    JSONObject fObj = new JSONObject();
                    fObj.put("index", i);
                    fObj.put("sensorTimestampNs", slicedTs.get(i));
                    fObj.put("exposureTimeNs", slicedExp.get(i));
                    fObj.put("rollingShutterSkewNs", slicedSkew.get(i));
                    fObj.put("frameWidth", RING_W);
                    fObj.put("frameHeight", RING_H);

                    if (bestLabel > 0) {
                        stats.get(bestLabel, 0, statRow);
                        double[] cent = centroids.get(bestLabel, 0);
                        double cx = cent[0];
                        double cy = cent[1];

                        double flowVx = 0.0;
                        double flowVy = 0.0;
                        if (!prevGray.empty()) {
                            double[] fv = computeBlobOpticalFlow(prevGray, gray, statRow[0], statRow[1], statRow[2], statRow[3]);
                            flowVx = fv[0];
                            flowVy = fv[1];
                        }

                        fObj.put("hasBlob", true);
                        fObj.put("blobCx", cx / RING_W);
                        fObj.put("blobCy", cy / RING_H);
                        fObj.put("blobBoxX", (double) statRow[0] / RING_W);
                        fObj.put("blobBoxY", (double) statRow[1] / RING_H);
                        fObj.put("blobBoxW", (double) statRow[2] / RING_W);
                        fObj.put("blobBoxH", (double) statRow[3] / RING_H);
                        fObj.put("blobAreaPx", bestArea);
                        fObj.put("flowVx", flowVx);
                        fObj.put("flowVy", flowVy);
                    } else {
                        fObj.put("hasBlob", false);
                    }

                    gray.copyTo(prevGray);
                    framesJson.put(fObj);
                }
            } finally {
                corridorMask.release();
                kOpen.release();
                kClose.release();
                gray.release();
                prevGray.release();
                fgRaw.release();
                fgBin.release();
                fgCorridor.release();
                labels.release();
                stats.release();
                centroids.release();
                jpgParams.release();
            }

            JSONObject res = new JSONObject();
            res.put("burstId", burstId);
            res.put("frames", framesJson);
            return res.toString();
        } catch (Throwable t) {
            try {
                JSONObject err = new JSONObject();
                err.put("error", String.valueOf(t.getMessage()));
                err.put("frames", new JSONArray());
                return err.toString();
            } catch (Throwable ignored) {
                return "{\"frames\":[]}";
            }
        }
    }

    private static double[] computeBlobOpticalFlow(Mat prevGray, Mat curGray, int bx, int by, int bw, int bh) {
        Mat roiMask = Mat.zeros(RING_H, RING_W, CvType.CV_8UC1);
        MatOfPoint corners = new MatOfPoint();
        MatOfPoint2f prevPts = new MatOfPoint2f();
        MatOfPoint2f nextPts = new MatOfPoint2f();
        MatOfByte status = new MatOfByte();
        MatOfFloat err = new MatOfFloat();
        try {
            int x0 = Math.max(0, bx - 8);
            int y0 = Math.max(0, by - 8);
            int x1 = Math.min(RING_W - 1, bx + bw + 8);
            int y1 = Math.min(RING_H - 1, by + bh + 8);
            Imgproc.rectangle(roiMask, new Point(x0, y0), new Point(x1, y1), new Scalar(255), -1);

            Imgproc.goodFeaturesToTrack(curGray, corners, 16, 0.08, 4.0, roiMask);
            Point[] pts = corners.toArray();
            if (pts.length == 0) return new double[]{0.0, 0.0};

            // Track backwards curGray -> prevGray and negate to get forward velocity (prev -> cur)
            nextPts.fromArray(pts);
            Video.calcOpticalFlowPyrLK(curGray, prevGray, nextPts, prevPts, status, err);
            Point[] pPrev = prevPts.toArray();
            byte[] st = status.toArray();
            double sumVx = 0.0;
            double sumVy = 0.0;
            int valid = 0;
            for (int i = 0; i < st.length && i < pts.length && i < pPrev.length; i++) {
                if (st[i] == 1) {
                    sumVx += (pts[i].x - pPrev[i].x);
                    sumVy += (pts[i].y - pPrev[i].y);
                    valid++;
                }
            }
            if (valid == 0) return new double[]{0.0, 0.0};
            return new double[]{sumVx / valid, sumVy / valid};
        } catch (Throwable t) {
            return new double[]{0.0, 0.0};
        } finally {
            roiMask.release();
            corners.release();
            prevPts.release();
            nextPts.release();
            status.release();
            err.release();
        }
    }
}
