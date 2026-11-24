package app.slaprf.gatecam;

import android.media.Image;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;
import android.util.Log;
import android.view.Surface;

import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;

/**
 * HighSpeedCodecRing owns a hardware H.264/AVC MediaCodec encoder with a USAGE_VIDEO_ENCODE input
 * Surface — the FIFO consumer required by Android's CameraConstrainedHighSpeedCaptureSession to
 * deliver 100% of 120.0 / 240.0 fps bursts with zero dropped frames.
 *
 * Compressed NAL packets (~10-15 MB total for 4+ seconds at 240 fps) are retained in a circular
 * packet ring with frequent IDR sync frames (~every 30 frames). Whenever a SlapRF gate crossing
 * arrives, only the [startSensorNs, endSensorNs] slice (plus its preceding IDR pre-roll) is
 * hardware-decoded on demand into upright 640x360 NV21 frames for OpenCV analysis.
 */
final class HighSpeedCodecRing {
    private static final String TAG = "GateCamCodec";

    interface FrameConverter {
        void yuvImageToNV21(Image img, byte[] dstNv21, int rotDeg);
    }

    interface TimestampResolver {
        long resolveSensorTimestampNs(long presentationTimeUs);
    }

    static final class DecodedFrame {
        final byte[] nv21;
        final long sensorTsNs;

        DecodedFrame(byte[] nv21, long sensorTsNs) {
            this.nv21 = nv21;
            this.sensorTsNs = sensorTsNs;
        }
    }

    private static final int PKT_CAP = 1024; // ~4.26s @ 240 fps, ~8.53s @ 120 fps

    private final int width;
    private final int height;
    private final int targetFps;
    private final int outW;
    private final int outH;
    private final int nv21Bytes;
    private final TimestampResolver tsResolver;

    private HandlerThread codecThread;
    private Handler codecHandler;
    private MediaCodec encoder;
    private Surface inputSurface;
    private volatile boolean released = false;

    private final Object ringLock = new Object();
    private final byte[][] pktData = new byte[PKT_CAP][];
    private final long[] pktPtsUs = new long[PKT_CAP];
    private final long[] pktSensorNs = new long[PKT_CAP];
    private final int[] pktFlags = new int[PKT_CAP];
    private int pktHead = 0;
    private int pktCount = 0;
    private int totalEncoded = 0;
    private int keyframeCount = 0;
    private boolean loggedFirstPacket = false;
    private MediaFormat outputFormat = null;
    private byte[] fallbackCsd0 = null;

    HighSpeedCodecRing(
            int width,
            int height,
            int targetFps,
            int outW,
            int outH,
            TimestampResolver tsResolver) {
        this.width = width;
        this.height = height;
        this.targetFps = targetFps;
        this.outW = outW;
        this.outH = outH;
        this.nv21Bytes = outW * outH * 3 / 2;
        this.tsResolver = tsResolver;
    }

    boolean start() {
        try {
            codecThread = new HandlerThread("GateCamHsEncoder");
            codecThread.start();
            codecHandler = new Handler(codecThread.getLooper());

            encoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC);
            MediaCodec.Callback cb = new MediaCodec.Callback() {
                @Override
                public void onInputBufferAvailable(MediaCodec mc, int index) {
                    // Surface input mode: unused
                }

                @Override
                public void onOutputBufferAvailable(MediaCodec mc, int index, MediaCodec.BufferInfo info) {
                    if (released) return;
                    try {
                        ByteBuffer buf = mc.getOutputBuffer(index);
                        if (buf != null && info.size > 0) {
                            buf.position(info.offset);
                            buf.limit(info.offset + info.size);
                            byte[] copy = new byte[info.size];
                            buf.get(copy);

                            if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
                                synchronized (ringLock) {
                                    fallbackCsd0 = copy;
                                }
                            } else {
                                long sensorNs = tsResolver != null
                                        ? tsResolver.resolveSensorTimestampNs(info.presentationTimeUs)
                                        : (info.presentationTimeUs * 1000L);
                                synchronized (ringLock) {
                                    pktData[pktHead] = copy;
                                    pktPtsUs[pktHead] = info.presentationTimeUs;
                                    pktSensorNs[pktHead] = sensorNs;
                                    pktFlags[pktHead] = info.flags;
                                    pktHead = (pktHead + 1) % PKT_CAP;
                                    if (pktCount < PKT_CAP) pktCount++;
                                }
                                if (!loggedFirstPacket) {
                                    loggedFirstPacket = true;
                                    Log.i(TAG, "First H.264 FIFO packet: targetFps=" + targetFps
                                            + " size=" + info.size
                                            + " ptsUs=" + info.presentationTimeUs
                                            + " sensorNs=" + sensorNs);
                                }
                                totalEncoded++;
                                if ((info.flags & MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0) {
                                    keyframeCount++;
                                    if (keyframeCount == 2) {
                                        Log.i(TAG, "Second H.264 IDR keyframe at frame #" + totalEncoded);
                                    }
                                }
                            }
                        }
                    } catch (Throwable ignored) {
                    } finally {
                        try {
                            mc.releaseOutputBuffer(index, false);
                        } catch (Throwable ignored) {
                        }
                    }
                }

                @Override
                public void onError(MediaCodec mc, MediaCodec.CodecException e) {
                    Log.e(TAG, "Encoder onError: " + e.getMessage());
                }

                @Override
                public void onOutputFormatChanged(MediaCodec mc, MediaFormat format) {
                    synchronized (ringLock) {
                        outputFormat = format;
                    }
                }
            };

            encoder.setCallback(cb, codecHandler);
            int bitrate = targetFps >= 200 ? 14_000_000 : 10_000_000;
            try {
                MediaFormat fmt = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height);
                fmt.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
                fmt.setInteger(MediaFormat.KEY_BIT_RATE, bitrate);
                fmt.setInteger(MediaFormat.KEY_FRAME_RATE, targetFps);
                fmt.setInteger(MediaFormat.KEY_OPERATING_RATE, targetFps);
                fmt.setInteger(MediaFormat.KEY_PRIORITY, 0);
                fmt.setFloat(MediaFormat.KEY_I_FRAME_INTERVAL, 0.25f);
                if (Build.VERSION.SDK_INT >= 29) {
                    fmt.setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0);
                }
                encoder.configure(fmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            } catch (Throwable cfgErr) {
                Log.w(TAG, "Primary H.264 configure fallback (" + cfgErr.getMessage() + "), retrying with base format");
                try { encoder.reset(); } catch (Throwable ignored) {}
                encoder.setCallback(cb, codecHandler);
                MediaFormat fallbackFmt = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height);
                fallbackFmt.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
                fallbackFmt.setInteger(MediaFormat.KEY_BIT_RATE, bitrate);
                fallbackFmt.setInteger(MediaFormat.KEY_FRAME_RATE, 30);
                fallbackFmt.setInteger(MediaFormat.KEY_OPERATING_RATE, targetFps);
                fallbackFmt.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1);
                encoder.configure(fallbackFmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            }

            inputSurface = encoder.createInputSurface();
            encoder.start();
            Log.i(TAG, "Started H.264 FIFO encoder " + width + "x" + height + " @ " + targetFps + " fps (" + encoder.getName() + ")");
            return true;
        } catch (Throwable t) {
            Log.e(TAG, "Failed to start HighSpeedCodecRing: " + t.getMessage(), t);
            release();
            return false;
        }
    }

    Surface getInputSurface() {
        return inputSurface;
    }

    int getCapacity() {
        return PKT_CAP;
    }

    /**
     * Populates [filledCount, spanMs, actualFps] directly from the hardware-encoded FIFO ring.
     */
    void getStats(double[] outFilledSpanMsFps) {
        synchronized (ringLock) {
            outFilledSpanMsFps[0] = pktCount;
            outFilledSpanMsFps[1] = 0.0;
            outFilledSpanMsFps[2] = targetFps;
            if (pktCount >= 2) {
                int newest = (pktHead - 1 + PKT_CAP) % PKT_CAP;
                int oldest = (pktHead - pktCount + PKT_CAP) % PKT_CAP;
                long spanNs = pktSensorNs[newest] - pktSensorNs[oldest];
                if (spanNs > 0) {
                    outFilledSpanMsFps[1] = spanNs / 1e6;
                }
                int win = Math.min(pktCount - 1, 64);
                int winOld = (pktHead - 1 - win + PKT_CAP) % PKT_CAP;
                long winNs = pktSensorNs[newest] - pktSensorNs[winOld];
                if (winNs > 0) {
                    outFilledSpanMsFps[2] = (win * 1e9) / (double) winNs;
                }
            }
        }
    }

    byte[] decodeLatestFrameNV21(int rotDeg, FrameConverter converter) {
        long newestNs;
        synchronized (ringLock) {
            if (pktCount == 0) return null;
            int newest = (pktHead - 1 + PKT_CAP) % PKT_CAP;
            newestNs = pktSensorNs[newest];
        }
        List<DecodedFrame> frames = decodeWindowToNV21(newestNs - 2_000_000L, newestNs + 2_000_000L, 1, rotDeg, converter);
        if (frames.isEmpty()) return null;
        return frames.get(frames.size() - 1).nv21;
    }

    /**
     * Snapshots packets covering [startSensorNs, endSensorNs] (starting at the nearest preceding IDR
     * sync frame) and hardware-decodes all frames inside the target window into 640x360 NV21.
     */
    List<DecodedFrame> decodeWindowToNV21(
            long startSensorNs,
            long endSensorNs,
            int maxFrames,
            int rotDeg,
            FrameConverter converter) {
        List<DecodedFrame> out = new ArrayList<>();

        MediaFormat encFmt;
        byte[] csd0;
        List<byte[]> sliceData = new ArrayList<>();
        List<Long> slicePtsUs = new ArrayList<>();
        List<Long> sliceSensorNs = new ArrayList<>();
        List<Integer> sliceFlags = new ArrayList<>();
        long winStartPtsUs;
        long winEndPtsUs;

        synchronized (ringLock) {
            if (pktCount == 0 || (outputFormat == null && fallbackCsd0 == null)) {
                return out;
            }
            encFmt = outputFormat;
            csd0 = fallbackCsd0;

            int oldest = (pktHead - pktCount + PKT_CAP) % PKT_CAP;
            int firstInWindowOffset = -1;
            int lastInWindowOffset = -1;
            for (int i = 0; i < pktCount; i++) {
                int idx = (oldest + i) % PKT_CAP;
                long tsNs = pktSensorNs[idx];
                if (tsNs >= startSensorNs && tsNs <= endSensorNs) {
                    if (firstInWindowOffset < 0) firstInWindowOffset = i;
                    lastInWindowOffset = i;
                }
            }
            if (firstInWindowOffset < 0) {
                return out;
            }

            // Symmetrically bound window before decoding so excess trailing frames aren't decoded needlessly
            while (maxFrames > 0 && (lastInWindowOffset - firstInWindowOffset + 1) > maxFrames) {
                lastInWindowOffset--;
                if ((lastInWindowOffset - firstInWindowOffset + 1) > maxFrames) {
                    firstInWindowOffset++;
                }
            }

            winStartPtsUs = pktPtsUs[(oldest + firstInWindowOffset) % PKT_CAP];
            winEndPtsUs = pktPtsUs[(oldest + lastInWindowOffset) % PKT_CAP];

            // Walk backward from firstInWindowOffset to locate the nearest IDR keyframe
            int keyOffset = -1;
            for (int i = firstInWindowOffset; i >= 0; i--) {
                int idx = (oldest + i) % PKT_CAP;
                if ((pktFlags[idx] & MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0) {
                    keyOffset = i;
                    break;
                }
            }
            if (keyOffset < 0) {
                for (int i = firstInWindowOffset; i <= lastInWindowOffset; i++) {
                    int idx = (oldest + i) % PKT_CAP;
                    if ((pktFlags[idx] & MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0) {
                        keyOffset = i;
                        break;
                    }
                }
            }
            if (keyOffset < 0) {
                return out;
            }

            for (int i = keyOffset; i <= lastInWindowOffset; i++) {
                int idx = (oldest + i) % PKT_CAP;
                sliceData.add(pktData[idx]);
                slicePtsUs.add(pktPtsUs[idx]);
                sliceSensorNs.add(pktSensorNs[idx]);
                sliceFlags.add(pktFlags[idx]);
            }
        }

        MediaCodec decoder = null;
        long t0Ms = SystemClock.uptimeMillis();
        try {
            MediaFormat decFmt = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height);
            decFmt.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible);
            decFmt.setInteger(MediaFormat.KEY_OPERATING_RATE, 480);
            decFmt.setInteger(MediaFormat.KEY_PRIORITY, 0);
            if (encFmt != null) {
                ByteBuffer b0 = encFmt.getByteBuffer("csd-0");
                if (b0 != null) {
                    ByteBuffer dup0 = ByteBuffer.allocate(b0.remaining());
                    dup0.put(b0.duplicate());
                    dup0.flip();
                    decFmt.setByteBuffer("csd-0", dup0);
                }
                ByteBuffer b1 = encFmt.getByteBuffer("csd-1");
                if (b1 != null) {
                    ByteBuffer dup1 = ByteBuffer.allocate(b1.remaining());
                    dup1.put(b1.duplicate());
                    dup1.flip();
                    decFmt.setByteBuffer("csd-1", dup1);
                }
            } else if (csd0 != null) {
                decFmt.setByteBuffer("csd-0", ByteBuffer.wrap(csd0));
            }

            decoder = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_VIDEO_AVC);
            decoder.configure(decFmt, null, null, 0);
            decoder.start();

            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            int feedIdx = 0;
            int ptsMatchHint = 0;
            boolean inputDone = false;
            boolean outputDone = false;
            long deadlineMs = t0Ms + 3000L;

            while (!outputDone && SystemClock.uptimeMillis() < deadlineMs) {
                boolean progressed = false;

                // 1. Queue as many compressed packets as input buffers immediately allow (timeoutUs = 0)
                while (!inputDone) {
                    int inBufIdx = decoder.dequeueInputBuffer(0);
                    if (inBufIdx < 0) break;
                    progressed = true;
                    if (feedIdx < sliceData.size()) {
                        ByteBuffer inBuf = decoder.getInputBuffer(inBufIdx);
                        byte[] nal = sliceData.get(feedIdx);
                        long pts = slicePtsUs.get(feedIdx);
                        int flg = sliceFlags.get(feedIdx) & MediaCodec.BUFFER_FLAG_KEY_FRAME;
                        if (inBuf != null) {
                            inBuf.clear();
                            inBuf.put(nal);
                        }
                        decoder.queueInputBuffer(inBufIdx, 0, nal.length, pts, flg);
                        feedIdx++;
                    } else {
                        decoder.queueInputBuffer(inBufIdx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                        inputDone = true;
                    }
                }

                // 2. Drain all ready decoded YUV420 images (blocking briefly only when no input/output progressed)
                long waitUs = progressed ? 0L : 2000L;
                while (!outputDone) {
                    int outBufIdx = decoder.dequeueOutputBuffer(info, waitUs);
                    waitUs = 0L;
                    if (outBufIdx < 0) break;
                    progressed = true;
                    boolean eos = (info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0;
                    try {
                        if (info.size > 0 && info.presentationTimeUs >= winStartPtsUs && info.presentationTimeUs <= winEndPtsUs) {
                            Image img = decoder.getOutputImage(outBufIdx);
                            if (img != null) {
                                try {
                                    byte[] nv21 = new byte[nv21Bytes];
                                    converter.yuvImageToNV21(img, nv21, rotDeg);
                                    long exactSensorNs = info.presentationTimeUs * 1000L;
                                    for (int k = ptsMatchHint; k < slicePtsUs.size(); k++) {
                                        if (slicePtsUs.get(k) == info.presentationTimeUs) {
                                            exactSensorNs = sliceSensorNs.get(k);
                                            ptsMatchHint = k + 1;
                                            break;
                                        }
                                    }
                                    out.add(new DecodedFrame(nv21, exactSensorNs));
                                } finally {
                                    img.close();
                                }
                            }
                        }
                    } finally {
                        decoder.releaseOutputBuffer(outBufIdx, false);
                    }
                    if (eos) {
                        outputDone = true;
                    }
                }
            }
            Log.i(TAG, "Decoded burst slice: packets=" + sliceData.size()
                    + " framesInWindow=" + out.size()
                    + " elapsedMs=" + (SystemClock.uptimeMillis() - t0Ms));
        } catch (Throwable t) {
            Log.e(TAG, "decodeWindowToNV21 failed: " + t.getMessage(), t);
        } finally {
            if (decoder != null) {
                try { decoder.stop(); } catch (Throwable ignored) {}
                try { decoder.release(); } catch (Throwable ignored) {}
            }
        }

        while (maxFrames > 0 && out.size() > maxFrames) {
            out.remove(out.size() - 1);
            if (out.size() > maxFrames) {
                out.remove(0);
            }
        }
        return out;
    }

    void release() {
        if (released) return;
        released = true;
        try {
            if (encoder != null) {
                try { encoder.stop(); } catch (Throwable ignored) {}
                try { encoder.release(); } catch (Throwable ignored) {}
                encoder = null;
            }
        } catch (Throwable ignored) {}
        try {
            if (inputSurface != null) {
                inputSurface.release();
                inputSurface = null;
            }
        } catch (Throwable ignored) {}
        if (codecThread != null) {
            codecThread.quitSafely();
            codecThread = null;
        }
        codecHandler = null;
    }
}
