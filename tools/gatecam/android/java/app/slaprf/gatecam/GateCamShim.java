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
import android.os.Build;
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
    private static final int RING_W = 640;
    private static final int RING_H = 360;
    private static final int NV21_BYTES = RING_W * RING_H * 3 / 2;
    private static final int RING_CAP = 168; // ~58 MB static allocation, zero per-frame GC

    private static Context appCtx;
    private static volatile Activity activeActivity;
    private static volatile TextureView previewTexture;
    private static volatile SurfaceTexture boundSurfaceTexture;
    private static volatile int previewWidth = 1280;
    private static volatile int previewHeight = 720;
    private static volatile int capW = 1280;
    private static volatile int capH = 960;

    private static HandlerThread camThread;
    private static Handler camHandler;
    private static CameraDevice cameraDevice;
    private static CameraCaptureSession captureSession;
    private static ImageReader yuvReader;
    private static Surface previewSurface;

    private static String cameraId = "";
    private static int sensorOrientation = 90;
    private static volatile int lastRotDeg = 90;
    private static volatile int timestampSource = CameraMetadata.SENSOR_INFO_TIMESTAMP_SOURCE_UNKNOWN;
    private static Rect activeArrayRect = new Rect(0, 0, 4032, 3024);
    private static Range<Integer> isoRange = new Range<>(50, 6400);
    private static Range<Integer> boostRange = new Range<>(100, 100);
    private static Range<Long> expRangeNs = new Range<>(50_000L, 33_333_333L);
    private static float minFocusDist = 10.0f;
    private static float minZoomRatio = 1.0f;
    private static float maxZoomRatio = 8.0f;
    private static List<Range<Integer>> availableFpsRanges = new ArrayList<>();
    private static boolean supports120Fps = false;

    // Requested camera configuration
    private static volatile int targetFps = 120;
    private static volatile int shutterUs = 0; // 0=Auto, 4000=1/250s, 2000=1/500s, 1000=1/1000s, 500=1/2000s, 250=1/4000s
    private static volatile float zoomRatio = 1.0f;
    private static volatile String focusMode = "gate"; // "gate" (2.8m), "near" (1.0m), "inf" (0.0), "tap"
    private static volatile Float lockedFocusDist = 0.35f;
    private static volatile boolean oneShotAfActive = false;
    private static volatile MeteringRectangle[] activeAfRegions = null;
    private static volatile String lastError = "";

    // Shutter-Priority (Tv) Auto-ISO state when shutterUs > 0
    private static volatile double lastSceneEvNsIso = 8_000_000.0 * 400.0;
    private static volatile double currentTotalIso = 400.0;
    private static volatile int manualIso = 400;
    private static volatile int manualBoost = 100;
    private static int aeTick = 0;

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
    private static volatile long latestExposureNs = 8_000_000L;
    private static volatile long latestSkewNs = 8_000_000L;
    private static volatile int latestIso = 200;
    private static volatile float latestFocusDiopters = 0.35f;

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

    public static synchronized void onPreviewSurfaceAvailable(TextureView tv, int w, int h) {
        if (cameraDevice != null && tv != null && tv.getSurfaceTexture() != boundSurfaceTexture) {
            stopCamera();
        }
        previewTexture = tv;
        previewWidth = w;
        previewHeight = h;
        applyPreviewTransform(tv, w, h);
    }

    public static synchronized void onPreviewSurfaceSizeChanged(TextureView tv, int w, int h) {
        if (previewTexture != null && previewTexture != tv) {
            return;
        }
        previewTexture = tv;
        previewWidth = w;
        previewHeight = h;
        applyPreviewTransform(tv, w, h);
    }

    public static synchronized void onPreviewSurfaceDestroyed(TextureView tv) {
        if (previewTexture != tv) {
            return;
        }
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
                } else {
                    // Phone is held upright in Portrait (ROTATION_0 / ROTATION_180):
                    // SurfaceTexture presents upright buffer of aspect (uprightW = capH, uprightH = capW).
                    // Center-crop vertically to match our full-width 16:9 landscape viewfinder with 1:1 square pixels.
                    float desiredCropH = Math.max(1f, (float) capH * ((float) viewH / (float) viewW));
                    float scaleY = (float) capW / desiredCropH;
                    m.postScale(1.0f, scaleY, cx, cy);
                    if (Surface.ROTATION_180 == rot) {
                        m.postRotate(180, cx, cy);
                    }
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
            Range<Integer> bRange = cc.get(CameraCharacteristics.CONTROL_POST_RAW_SENSITIVITY_BOOST_RANGE);
            if (bRange != null) boostRange = bRange;
            Range<Long> eRange = cc.get(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE);
            if (eRange != null) expRangeNs = eRange;
            Float mfd = cc.get(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE);
            if (mfd != null && mfd > 0f) minFocusDist = mfd;
            if (Build.VERSION.SDK_INT >= 30) {
                Range<Float> zRange = cc.get(CameraCharacteristics.CONTROL_ZOOM_RATIO_RANGE);
                if (zRange != null) {
                    minZoomRatio = Math.max(0.4f, zRange.getLower());
                    maxZoomRatio = Math.max(1.0f, zRange.getUpper());
                }
            }

            Range<Integer>[] ranges = cc.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES);
            availableFpsRanges.clear();
            supports120Fps = false;
            if (ranges != null) {
                availableFpsRanges.addAll(Arrays.asList(ranges));
                for (Range<Integer> r : ranges) {
                    if (r.getUpper() >= 120) supports120Fps = true;
                }
            }

            // Prefer 1280x960 (4:3 full horizontal sensor width when phone is held upright in Portrait!)
            capW = 1280;
            capH = 720;
            StreamConfigurationMap map = cc.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            if (map != null) {
                Size[] sizes = map.getOutputSizes(ImageFormat.YUV_420_888);
                if (sizes != null) {
                    for (Size s : sizes) {
                        if (s.getWidth() == 1280 && s.getHeight() == 960) {
                            capW = 1280;
                            capH = 960;
                            break;
                        }
                    }
                }
                long minDur = map.getOutputMinFrameDuration(ImageFormat.YUV_420_888, new Size(capW, capH));
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
        boundSurfaceTexture = null;
    }

    private static synchronized void createCapturePipelineLocked() {
        if (cameraDevice == null || previewTexture == null || !previewTexture.isAvailable()) return;
        try {
            SurfaceTexture st = previewTexture.getSurfaceTexture();
            boundSurfaceTexture = st;
            st.setDefaultBufferSize(capW, capH);
            applyPreviewTransform(previewTexture, previewWidth, previewHeight);
            if (previewSurface != null) previewSurface.release();
            previewSurface = new Surface(st);

            if (yuvReader != null) yuvReader.close();
            yuvReader = ImageReader.newInstance(capW, capH, ImageFormat.YUV_420_888, 6);
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

    private static float resolveFixedFocusDiopters() {
        if ("inf".equalsIgnoreCase(focusMode)) {
            return 0.0f;
        }
        if ("near".equalsIgnoreCase(focusMode)) {
            return Math.min(minFocusDist, 1.0f); // ~1.0 m
        }
        if ("tap".equalsIgnoreCase(focusMode) && lockedFocusDist != null) {
            return Math.max(0.0f, Math.min(minFocusDist, lockedFocusDist));
        }
        return Math.min(minFocusDist, 0.35f); // Default "gate": ~2.85 m hyperfocal
    }

    private static void updateManualIsoFromTotal(double totalIso) {
        int isoMin = isoRange.getLower();
        int isoMax = isoRange.getUpper();
        int bMin = boostRange.getLower();
        int bMax = boostRange.getUpper();
        double maxCombined = (double) isoMax * ((double) bMax / 100.0);
        currentTotalIso = Math.max((double) isoMin, Math.min(maxCombined, totalIso));
        if (currentTotalIso <= isoMax) {
            manualIso = Math.max(isoMin, Math.min(isoMax, (int) Math.round(currentTotalIso)));
            manualBoost = bMin;
        } else {
            manualIso = isoMax;
            int b = (int) Math.round(100.0 * currentTotalIso / (double) isoMax);
            manualBoost = Math.max(bMin, Math.min(bMax, b));
        }
    }

    private static synchronized void applyRepeatingRequestLocked() {
        if (cameraDevice == null || captureSession == null || previewSurface == null || yuvReader == null) return;
        try {
            CaptureRequest.Builder b = cameraDevice.createCaptureRequest(CameraDevice.TEMPLATE_RECORD);
            b.addTarget(previewSurface);
            b.addTarget(yuvReader.getSurface());

            Range<Integer> fpsRange = pickBestFpsRange(targetFps);
            b.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, fpsRange);

            if (Build.VERSION.SDK_INT >= 30) {
                float z = Math.max(minZoomRatio, Math.min(maxZoomRatio, zoomRatio));
                b.set(CaptureRequest.CONTROL_ZOOM_RATIO, z);
            }

            if (shutterUs > 0) {
                // Shutter-Priority (Tv) mode: fixed shutter exposure + automatic closed-loop ISO
                long expNs = Math.max(expRangeNs.getLower(), Math.min(expRangeNs.getUpper(), (long) shutterUs * 1000L));
                b.set(CaptureRequest.CONTROL_AE_MODE, CameraMetadata.CONTROL_AE_MODE_OFF);
                b.set(CaptureRequest.SENSOR_EXPOSURE_TIME, expNs);
                long frameDurNs = Math.max(expNs, 1_000_000_000L / Math.max(30, fpsRange.getUpper()));
                b.set(CaptureRequest.SENSOR_FRAME_DURATION, frameDurNs);
                int iso = Math.max(isoRange.getLower(), Math.min(isoRange.getUpper(), manualIso));
                b.set(CaptureRequest.SENSOR_SENSITIVITY, iso);
                int boost = Math.max(boostRange.getLower(), Math.min(boostRange.getUpper(), manualBoost));
                b.set(CaptureRequest.CONTROL_POST_RAW_SENSITIVITY_BOOST, boost);
            } else {
                b.set(CaptureRequest.CONTROL_AE_MODE, CameraMetadata.CONTROL_AE_MODE_ON);
            }

            if (oneShotAfActive) {
                b.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_AUTO);
                if (activeAfRegions != null) {
                    b.set(CaptureRequest.CONTROL_AF_REGIONS, activeAfRegions);
                }
            } else {
                // Fixed / Locked focus — never hunt when hands or drones pass in front of the gate!
                b.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_OFF);
                float dist = resolveFixedFocusDiopters();
                b.set(CaptureRequest.LENS_FOCUS_DISTANCE, dist);
                latestFocusDiopters = dist;
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
            Integer iso = result.get(CaptureResult.SENSOR_SENSITIVITY);
            Integer boost = result.get(CaptureResult.CONTROL_POST_RAW_SENSITIVITY_BOOST);
            Float fd = result.get(CaptureResult.LENS_FOCUS_DISTANCE);

            if (exp != null && exp > 0) latestExposureNs = exp;
            if (skew != null && skew > 0) latestSkewNs = skew;
            if (iso != null && iso > 0) latestIso = iso;
            if (fd != null) latestFocusDiopters = fd;

            if (shutterUs == 0 && exp != null && exp > 0 && iso != null && iso > 0) {
                double bMult = (boost != null && boost > 0) ? (boost / 100.0) : 1.0;
                lastSceneEvNsIso = (double) exp * (double) iso * bMult;
            }

            if (oneShotAfActive) {
                Integer afState = result.get(CaptureResult.CONTROL_AF_STATE);
                if (afState != null && (afState == CaptureResult.CONTROL_AF_STATE_FOCUSED_LOCKED
                        || afState == CaptureResult.CONTROL_AF_STATE_NOT_FOCUSED_LOCKED)) {
                    if (fd != null) {
                        lockedFocusDist = fd;
                    }
                    oneShotAfActive = false;
                    camHandler.post(new Runnable() {
                        @Override
                        public void run() {
                            applyRepeatingRequestLocked();
                        }
                    });
                }
            }

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
        if (srcW < RING_W || srcH < RING_H) return;

        long tsNs = img.getTimestamp();
        if (prevFrameTsNs > 0 && tsNs > prevFrameTsNs) {
            double instFps = 1e9 / (double) (tsNs - prevFrameTsNs);
            if (instFps >= 15.0 && instFps <= 260.0) {
                measuredFps = measuredFps * 0.90 + instFps * 0.10;
            }
        }
        prevFrameTsNs = tsNs;

        int rotDeg = computeSensorToDisplayDegrees();
        lastRotDeg = rotDeg;
        long[] meta = new long[2];
        lookupCaptureMeta(tsNs, meta);

        int slot;
        byte[] dst;
        synchronized (ringLock) {
            slot = ringHead;
            dst = ringNV21[slot];
        }

        downsampleLandscapeWidescreenToNV21(img, dst, rotDeg);

        synchronized (ringLock) {
            ringSensorTsNs[slot] = tsNs;
            ringExposureNs[slot] = meta[0];
            ringSkewNs[slot] = meta[1];
            ringHead = (slot + 1) % RING_CAP;
            if (ringCount < RING_CAP) ringCount++;
        }

        // Closed-loop Shutter-Priority (Tv) Auto-ISO adjustment every 8 frames when shutterUs > 0
        if (shutterUs > 0 && (++aeTick & 7) == 0) {
            int lumaLen = RING_W * RING_H;
            int step = Math.max(1, lumaLen / 256);
            long sumY = 0;
            int cnt = 0;
            for (int idx = step / 2; idx < lumaLen; idx += step) {
                sumY += (dst[idx] & 0xFF);
                cnt++;
            }
            if (cnt > 0) {
                double meanY = (double) sumY / (double) cnt;
                // Keep scene brightness in a comfortable [92 .. 138] target band around 112
                if (meanY < 92.0 || meanY > 138.0) {
                    double ratio = 112.0 / Math.max(10.0, meanY);
                    double damped = Math.max(0.55, Math.min(2.1, Math.pow(ratio, 0.65)));
                    synchronized (GateCamShim.class) {
                        if (shutterUs > 0) {
                            int prevIso = manualIso;
                            int prevBoost = manualBoost;
                            updateManualIsoFromTotal(currentTotalIso * damped);
                            lastSceneEvNsIso = (double) shutterUs * 1000.0 * currentTotalIso;
                            if (Math.abs(manualIso - prevIso) >= Math.max(10, prevIso / 12)
                                    || Math.abs(manualBoost - prevBoost) >= 6) {
                                applyRepeatingRequestLocked();
                            }
                        }
                    }
                }
            }
        }
    }

    /**
     * Converts sensor YUV_420_888 (e.g. 1280x960 4:3) into an upright 640x360 (16:9) Landscape widescreen
     * NV21 frame in a single zero-allocation pass. When the phone is held upright in Portrait (rotDeg=90/270),
     * uses 100% of the sensor's horizontal width (`srcH=960`) and center-crops vertically (`540` of `1280` rows),
     * matching the TextureView preview pixel-for-pixel.
     */
    private static void downsampleLandscapeWidescreenToNV21(Image img, byte[] dst, int rotDeg) {
        Image.Plane[] planes = img.getPlanes();
        ByteBuffer yBuf = planes[0].getBuffer();
        ByteBuffer uBuf = planes[1].getBuffer();
        ByteBuffer vBuf = planes[2].getBuffer();
        int yRowStride = planes[0].getRowStride();
        int yPixStride = planes[0].getPixelStride();
        int uvRowStride = planes[1].getRowStride();
        int uvPixStride = planes[1].getPixelStride();

        int srcW = img.getWidth();  // 1280
        int srcH = img.getHeight(); // 960 (or 720)

        if (rotDeg == 90 || rotDeg == 270) {
            boolean rot270 = (rotDeg == 270);
            int cropH = Math.min(srcW, (srcH * RING_H) / RING_W); // 960 * 360 / 640 = 540
            int uTop = (srcW - cropH) / 2;                        // (1280 - 540) / 2 = 370

            int outIdx = 0;
            for (int dy = 0; dy < RING_H; dy++) {
                int uy = uTop + (dy * cropH) / RING_H;
                int sx = rot270 ? (srcW - 1 - uy) : uy;
                int sxOff = sx * yPixStride;
                for (int dx = 0; dx < RING_W; dx++) {
                    int ux = (dx * srcH) / RING_W;
                    int sy = rot270 ? ux : (srcH - 1 - ux);
                    dst[outIdx++] = yBuf.get(sy * yRowStride + sxOff);
                }
            }

            int uvW = RING_W / 2; // 320
            int uvH = RING_H / 2; // 180
            int srcUvW = srcW / 2; // 640
            int srcUvH = srcH / 2; // 480
            int cropUvH = Math.min(srcUvW, (srcUvH * uvH) / uvW); // 270
            int uUvTop = (srcUvW - cropUvH) / 2;                  // 185
            for (int dy = 0; dy < uvH; dy++) {
                int uy = uUvTop + (dy * cropUvH) / uvH;
                int sx = rot270 ? (srcUvW - 1 - uy) : uy;
                int sxOff = Math.min(srcUvW - 2, Math.max(0, sx)) * uvPixStride;
                for (int dx = 0; dx < uvW; dx++) {
                    int ux = (dx * srcUvH) / uvW;
                    int sy = rot270 ? ux : (srcUvH - 1 - ux);
                    int off = sy * uvRowStride + sxOff;
                    dst[outIdx++] = vBuf.get(off);
                    dst[outIdx++] = uBuf.get(off);
                }
            }
            return;
        }

        // Landscape device hold fallback (rotDeg == 0 or 180)
        boolean rot180 = (rotDeg == 180);
        int cropH = Math.min(srcH, (srcW * RING_H) / RING_W);
        int yTop = (srcH - cropH) / 2;
        int outIdx = 0;
        for (int dy = 0; dy < RING_H; dy++) {
            int sy = yTop + (dy * cropH) / RING_H;
            if (rot180) sy = srcH - 1 - sy;
            int rowBase = sy * yRowStride;
            for (int dx = 0; dx < RING_W; dx++) {
                int sx = (dx * srcW) / RING_W;
                if (rot180) sx = srcW - 1 - sx;
                dst[outIdx++] = yBuf.get(rowBase + sx * yPixStride);
            }
        }
        int uvW = RING_W / 2;
        int uvH = RING_H / 2;
        int srcUvW = srcW / 2;
        int srcUvH = srcH / 2;
        int cropUvH = Math.min(srcUvH, (srcUvW * uvH) / uvW);
        int uvTop = (srcUvH - cropUvH) / 2;
        for (int dy = 0; dy < uvH; dy++) {
            int sy = uvTop + (dy * cropUvH) / uvH;
            if (rot180) sy = srcUvH - 1 - sy;
            int rowBase = sy * uvRowStride;
            for (int dx = 0; dx < uvW; dx++) {
                int sx = Math.min(srcUvW - 2, (dx * srcUvW) / uvW);
                if (rot180) sx = Math.min(srcUvW - 2, srcUvW - 1 - sx);
                int off = rowBase + sx * uvPixStride;
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
            o.put("exposureUs", (int) Math.max(1L, latestExposureNs / 1000L));
            o.put("iso", latestIso * Math.max(100, manualBoost) / 100);
            o.put("zoomRatio", Math.round(zoomRatio * 100.0) / 100.0);
            o.put("minZoomRatio", Math.round(minZoomRatio * 100.0) / 100.0);
            o.put("focusMode", focusMode);
            o.put("focusDistDiopters", Math.round(latestFocusDiopters * 100.0) / 100.0);
            o.put("focusLocked", !oneShotAfActive);
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
            if (o.has("zoomRatio")) {
                double z = o.optDouble("zoomRatio", 1.0);
                if (z > 0.0) {
                    zoomRatio = Math.max(minZoomRatio, Math.min(4.0f, (float) z));
                }
            }
            if (o.has("shutterUs")) {
                int nextShutter = Math.max(0, o.optInt("shutterUs", 0));
                if (nextShutter > 0) {
                    double desiredIso = lastSceneEvNsIso / ((double) nextShutter * 1000.0);
                    updateManualIsoFromTotal(desiredIso);
                } else {
                    manualBoost = 100;
                }
                shutterUs = nextShutter;
            }
            if (o.has("focusMode")) {
                String fm = o.optString("focusMode", "").trim();
                if (!fm.isEmpty()) {
                    focusMode = fm;
                    oneShotAfActive = false;
                }
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
        try {
            // Map upright 16:9 Landscape viewfinder (normX, normY) onto 90 deg CW 4:3 sensor activeArrayRect
            double cropFrac = Math.min(1.0, ((double) capH * (double) RING_H / (double) RING_W) / (double) Math.max(1, capW));
            double topFrac = (1.0 - cropFrac) * 0.5;
            double sxNorm = Math.max(0.0, Math.min(1.0, topFrac + Math.max(0.0, Math.min(1.0, normY)) * cropFrac));
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

            activeAfRegions = new MeteringRectangle[]{mr};
            focusMode = "tap";
            oneShotAfActive = true;
            applyRepeatingRequestLocked();

            CaptureRequest.Builder trig = cameraDevice.createCaptureRequest(CameraDevice.TEMPLATE_RECORD);
            trig.addTarget(previewSurface);
            trig.addTarget(yuvReader.getSurface());
            if (Build.VERSION.SDK_INT >= 30) {
                trig.set(CaptureRequest.CONTROL_ZOOM_RATIO, Math.max(minZoomRatio, Math.min(maxZoomRatio, zoomRatio)));
            }
            if (shutterUs > 0) {
                long expNs = Math.max(expRangeNs.getLower(), Math.min(expRangeNs.getUpper(), (long) shutterUs * 1000L));
                trig.set(CaptureRequest.CONTROL_AE_MODE, CameraMetadata.CONTROL_AE_MODE_OFF);
                trig.set(CaptureRequest.SENSOR_EXPOSURE_TIME, expNs);
                trig.set(CaptureRequest.SENSOR_SENSITIVITY, Math.max(isoRange.getLower(), Math.min(isoRange.getUpper(), manualIso)));
                trig.set(CaptureRequest.CONTROL_POST_RAW_SENSITIVITY_BOOST, Math.max(boostRange.getLower(), Math.min(boostRange.getUpper(), manualBoost)));
            } else {
                trig.set(CaptureRequest.CONTROL_AE_MODE, CameraMetadata.CONTROL_AE_MODE_ON);
            }
            trig.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_AUTO);
            trig.set(CaptureRequest.CONTROL_AF_REGIONS, activeAfRegions);
            trig.set(CaptureRequest.CONTROL_AF_TRIGGER, CameraMetadata.CONTROL_AF_TRIGGER_START);
            captureSession.capture(trig.build(), captureCallback, camHandler);

            // Safety fallback: lock focus after 700 ms even if HAL skips FOCUSED_LOCKED callback
            camHandler.postDelayed(new Runnable() {
                @Override
                public void run() {
                    synchronized (GateCamShim.class) {
                        if (oneShotAfActive) {
                            lockedFocusDist = latestFocusDiopters;
                            oneShotAfActive = false;
                            applyRepeatingRequestLocked();
                        }
                    }
                }
            }, 700);
            return "";
        } catch (Throwable t) {
            oneShotAfActive = false;
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
                    fObj.put("sensorRotDeg", lastRotDeg);

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
