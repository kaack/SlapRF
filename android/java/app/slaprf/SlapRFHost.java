package app.slaprf;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.graphics.Color;
import android.graphics.Insets;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;
import android.speech.tts.TextToSpeech;
import android.util.Base64;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsAnimation;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.OutputStream;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Native Android host shell for SlapRF:
 * - Boots the embedded Go server (libslaprf.so) inside a ForegroundService so USB/LAN timing
 *   never drops when the screen locks.
 * - Renders the embedded SlapRF SPA inside a full-screen edge-to-edge WebView.
 * - Bridges Android TextToSpeech, Keep-Screen-Awake, LAN Pocket Server toggle, and file import/export.
 */
public final class SlapRFHost extends Activity {
    static {
        System.loadLibrary("slaprf");
    }

    static native String nativeStartServer(String filesDir, String version, boolean lanEnabled);
    static native void nativeStopServer();
    static native String nativeSetLanEnabled(boolean enabled);
    static native String nativeGetLanStatusJson();

    private static final String PREFS_NAME = "slaprf_android_prefs";
    private static final String PREF_LAN_ENABLED = "lan_enabled";
    private static final String ACTION_STOP_ENGINE = "app.slaprf.ACTION_STOP_ENGINE";
    private static final String NOTIF_CHANNEL_ID = "slaprf_engine_channel";
    private static final int NOTIF_ID = 5800;

    private static final int REQ_OPEN_DOCUMENT = 4101;
    private static final int REQ_CREATE_DOCUMENT = 4102;
    private static final int REQ_POST_NOTIF = 4103;
    private static final int REQ_BLE_PERMS = 4104;

    private static final int DARK_BG = 0xFF0B0C0F;
    private static final int LIGHT_BG = 0xFFF3F5F8;

    private static volatile TextToSpeech sharedTts;
    private static volatile boolean ttsReady = false;
    private static final AtomicInteger utteranceSeq = new AtomicInteger(1);
    private static volatile SlapRFHost activeActivity;

    private FrameLayout rootLayout;
    private WebView webView;
    private ValueCallback<Uri[]> pendingFileChooser;
    private byte[] pendingSaveBytes;
    private OnBackInvokedCallback backCallback;
    private volatile long lastMultiTouchMs = 0L;
    private float lastPushedKbCssPx = -1f;
    private int activeImeAnimations = 0;
    private boolean compositorDrivenImeAnim = false;
    private int latestTargetKbPx = 0;
    private boolean latestImeVisible = false;
    private int lastSysBarsBottom = 0;

    private float physicalToCssPx(int kbPhysicalPx) {
        if (kbPhysicalPx <= 0) {
            return 0f;
        }
        float density = getResources().getDisplayMetrics().density;
        return density > 0f ? (kbPhysicalPx / density) : (float) kbPhysicalPx;
    }

    private void dispatchKeyboardOffsetPx(int kbPhysicalPx, long durationMs, boolean showing) {
        if (webView == null) {
            return;
        }
        float cssPx = physicalToCssPx(kbPhysicalPx);
        if (durationMs == 0L && Math.abs(cssPx - lastPushedKbCssPx) < 0.25f) {
            return;
        }
        lastPushedKbCssPx = cssPx;
        String cssStr = String.format(Locale.US, "%.2f", cssPx);
        webView.evaluateJavascript(
                "if(window.__slaprfSetKbOffset)window.__slaprfSetKbOffset("
                        + cssStr + "," + Math.max(0L, durationMs) + "," + (showing ? "true" : "false") + ");",
                null);
    }

    private void settleKeyboardOffsetIfNeeded(int kbPhysicalPx, boolean showing) {
        float cssPx = physicalToCssPx(kbPhysicalPx);
        if (lastPushedKbCssPx >= 0f && Math.abs(cssPx - lastPushedKbCssPx) <= 0.6f) {
            return;
        }
        dispatchKeyboardOffsetPx(kbPhysicalPx, 120L, showing);
    }

    private static final ExecutorService beepExecutor = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "slaprf-beep");
        t.setDaemon(true);
        return t;
    });
    private static AudioTrack sharedBeepTrack;
    private static long lastBeepWriteUptimeMs = 0L;

    private static AudioTrack ensureSharedBeepTrackLocked(int sampleRate) {
        if (sharedBeepTrack != null && sharedBeepTrack.getState() == AudioTrack.STATE_INITIALIZED) {
            if (sharedBeepTrack.getPlayState() != AudioTrack.PLAYSTATE_PLAYING) {
                sharedBeepTrack.play();
            }
            return sharedBeepTrack;
        }
        releaseSharedBeepTrackLocked();
        AudioAttributes.Builder attrBuilder = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC);
        if (Build.VERSION.SDK_INT >= 29) {
            attrBuilder.setAllowedCapturePolicy(AudioAttributes.ALLOW_CAPTURE_BY_ALL);
        }
        AudioFormat fmt = new AudioFormat.Builder()
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setSampleRate(sampleRate)
                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                .build();
        int minBuf = AudioTrack.getMinBufferSize(
                sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
        int targetBufBytes = Math.max(minBuf > 0 ? minBuf : 9600, ((sampleRate * 240) / 1000) * 2);
        AudioTrack.Builder tb = new AudioTrack.Builder()
                .setAudioAttributes(attrBuilder.build())
                .setAudioFormat(fmt)
                .setTransferMode(AudioTrack.MODE_STREAM)
                .setBufferSizeInBytes(targetBufBytes);
        if (Build.VERSION.SDK_INT >= 26) {
            // Standard mixer path guarantees Android AudioPlaybackCapture (screen/phone audio recorders) can tap the stream.
            tb.setPerformanceMode(AudioTrack.PERFORMANCE_MODE_NONE);
        }
        AudioTrack built = tb.build();
        built.play();
        sharedBeepTrack = built;
        return built;
    }

    private static void releaseSharedBeepTrackLocked() {
        if (sharedBeepTrack != null) {
            try {
                sharedBeepTrack.stop();
            } catch (Exception ignored) {
            }
            try {
                sharedBeepTrack.release();
            } catch (Exception ignored) {
            }
            sharedBeepTrack = null;
        }
    }

    private static void shutdownSharedBeepTrack() {
        beepExecutor.execute(SlapRFHost::releaseSharedBeepTrackLocked);
    }

    private static void playCapturableGateBeep(final double freqHz, final int durationMs, final float volume) {
        final double safeFreq = Math.max(220.0, Math.min(8000.0, freqHz));
        final int safeDurMs = Math.max(80, Math.min(500, durationMs));
        final float safeVol = Math.max(0.08f, Math.min(1.0f, volume));
        beepExecutor.execute(() -> {
            final int sampleRate = 48000;
            final long nowUptime = SystemClock.uptimeMillis();
            final boolean wasIdle = (nowUptime - lastBeepWriteUptimeMs) > 350L;
            // Prepend 24 ms silent lead-in after idle lulls so AudioFlinger + AudioPlaybackCapture
            // wake up before the tone attack, and append 60 ms silent flush so the persistent
            // MODE_STREAM track pushes every sample through the screen-recorder AAC encoder.
            final int leadInSamples = wasIdle ? (sampleRate * 24) / 1000 : 0;
            final int toneSamples = Math.max(960, (sampleRate * safeDurMs) / 1000);
            final int tailSamples = (sampleRate * 60) / 1000;
            final int attackSamples = Math.max(1, (sampleRate * 6) / 1000);
            final int releaseSamples = Math.max(1, (sampleRate * 30) / 1000);
            final int sustainEnd = Math.max(attackSamples, toneSamples - releaseSamples);
            final short[] pcm = new short[leadInSamples + toneSamples + tailSamples];
            final double peakAmp = 32767.0 * 0.52 * safeVol;
            for (int i = 0; i < toneSamples; i++) {
                double phase = (i * safeFreq / sampleRate) % 1.0;
                double tri = phase < 0.5 ? (4.0 * phase - 1.0) : (3.0 - 4.0 * phase);
                double env;
                if (i < attackSamples) {
                    env = (double) i / (double) attackSamples;
                } else if (i < sustainEnd) {
                    env = 1.0;
                } else {
                    double relFrac = Math.min(1.0, (double) (i - sustainEnd) / (double) releaseSamples);
                    env = 0.5 * (1.0 + Math.cos(Math.PI * relFrac));
                }
                int val = (int) Math.round(tri * env * peakAmp);
                if (val > 32767) val = 32767;
                else if (val < -32768) val = -32768;
                pcm[leadInSamples + i] = (short) val;
            }

            try {
                AudioTrack track = ensureSharedBeepTrackLocked(sampleRate);
                int written = track.write(pcm, 0, pcm.length, AudioTrack.WRITE_BLOCKING);
                if (written < 0) {
                    releaseSharedBeepTrackLocked();
                    track = ensureSharedBeepTrackLocked(sampleRate);
                    track.write(pcm, 0, pcm.length, AudioTrack.WRITE_BLOCKING);
                }
                lastBeepWriteUptimeMs = SystemClock.uptimeMillis();
            } catch (Exception e) {
                releaseSharedBeepTrackLocked();
            }
        });
    }

    private static synchronized void ensureTtsInitialized(Context context) {
        if (sharedTts != null) {
            return;
        }
        final Context appCtx = context.getApplicationContext();
        sharedTts = new TextToSpeech(appCtx, status -> {
            if (status == TextToSpeech.SUCCESS && sharedTts != null) {
                try {
                    sharedTts.setLanguage(Locale.US);
                    AudioAttributes.Builder ttsAttr = new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH);
                    if (Build.VERSION.SDK_INT >= 29) {
                        ttsAttr.setAllowedCapturePolicy(AudioAttributes.ALLOW_CAPTURE_BY_ALL);
                    }
                    sharedTts.setAudioAttributes(ttsAttr.build());
                } catch (Exception ignored) {
                }
                ttsReady = true;
            }
        });
    }

    private static synchronized void shutdownSharedTts() {
        ttsReady = false;
        if (sharedTts != null) {
            try {
                sharedTts.stop();
                sharedTts.shutdown();
            } catch (Exception ignored) {
            }
            sharedTts = null;
        }
    }

    static String resolveVersionName(Context ctx) {
        try {
            PackageManager pm = ctx.getPackageManager();
            PackageInfo pi = Build.VERSION.SDK_INT >= 33
                    ? pm.getPackageInfo(ctx.getPackageName(), PackageManager.PackageInfoFlags.of(0))
                    : pm.getPackageInfo(ctx.getPackageName(), 0);
            if (pi != null && pi.versionName != null && !pi.versionName.isEmpty()) {
                return "v" + pi.versionName.replaceFirst("^v", "");
            }
        } catch (Exception ignored) {
        }
        return "v0.0.6";
    }

    static boolean isLanPrefEnabled(Context ctx) {
        SharedPreferences sp = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        return sp.getBoolean(PREF_LAN_ENABLED, false);
    }

    static void saveLanPref(Context ctx, boolean enabled) {
        ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .putBoolean(PREF_LAN_ENABLED, enabled)
                .apply();
    }

    @Override
    @SuppressLint("SetJavaScriptEnabled")
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        activeActivity = this;

        SlapRFUsbShim.init(this);
        SlapRFBleShim.init(this);
        // Bluetooth runtime permissions are requested lazily, the first time the Go engine lists
        // or opens a Bluetooth hub port (see SlapRFBleShim.ensurePermissions).
        SlapRFBleShim.setPermissionRequester(SlapRFHost::requestBlePermissionsFromActiveActivity);
        ensureTtsInitialized(this);
        requestNotificationPermissionIfNeeded();

        // Start foreground service so USB/LAN timing survives screen lock & app switching.
        Intent svcIntent = new Intent(this, EngineService.class);
        if (Build.VERSION.SDK_INT >= 26) {
            startForegroundService(svcIntent);
        } else {
            startService(svcIntent);
        }

        String serverUrl = nativeStartServer(
                getFilesDir().getAbsolutePath(),
                resolveVersionName(this),
                isLanPrefEnabled(this));

        rootLayout = new FrameLayout(this);
        rootLayout.setBackgroundColor(DARK_BG);
        configureSystemBarsAndInsets(true);

        webView = new WebView(this);
        webView.setBackgroundColor(DARK_BG);
        WebSettings ws = webView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setDatabaseEnabled(true);
        ws.setMediaPlaybackRequiresUserGesture(false);
        ws.setAllowFileAccess(false);
        ws.setAllowContentAccess(false);
        ws.setSupportZoom(false);
        ws.setBuiltInZoomControls(false);
        ws.setDisplayZoomControls(false);
        ws.setTextZoom(100);
        ws.setCacheMode(WebSettings.LOAD_NO_CACHE);
        webView.clearCache(true);

        webView.addJavascriptInterface(new JsBridge(), "SlapRFAndroid");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (request == null || request.getUrl() == null) {
                    return false;
                }
                Uri uri = request.getUrl();
                String host = uri.getHost() != null ? uri.getHost() : "";
                if ("127.0.0.1".equals(host) || "localhost".equals(host)) {
                    return false;
                }
                try {
                    Intent external = new Intent(Intent.ACTION_VIEW, uri);
                    startActivity(external);
                } catch (Exception ignored) {
                }
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(
                    WebView view,
                    ValueCallback<Uri[]> filePathCallback,
                    FileChooserParams fileChooserParams) {
                if (pendingFileChooser != null) {
                    pendingFileChooser.onReceiveValue(null);
                }
                pendingFileChooser = filePathCallback;
                try {
                    Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    pick.addCategory(Intent.CATEGORY_OPENABLE);
                    pick.setType("*/*");
                    startActivityForResult(Intent.createChooser(pick, "Select Backup File"), REQ_OPEN_DOCUMENT);
                    return true;
                } catch (Exception e) {
                    pendingFileChooser = null;
                    return false;
                }
            }
        });

        rootLayout.addView(
                webView,
                new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(rootLayout);

        if (Build.VERSION.SDK_INT >= 33) {
            backCallback = this::handleBackNavigation;
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, backCallback);
        }

        if (serverUrl != null && !serverUrl.isEmpty()) {
            webView.loadUrl(serverUrl);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        // When a USB timer is plugged in via OTG, Android delivers USB_DEVICE_ATTACHED here;
        // trigger a soft USB port refresh inside the running SPA if mounted.
        if (webView != null) {
            webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('slaprf-usb-attached'));", null);
        }
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= 33) {
            if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_POST_NOTIF);
            }
        }
    }

    /** Called on the main thread by SlapRFBleShim when Bluetooth permissions are missing. */
    static void requestBlePermissionsFromActiveActivity() {
        SlapRFHost act = activeActivity;
        if (act == null || act.isFinishing()) {
            return;
        }
        act.requestBlePermissionsIfNeeded();
    }

    private void requestBlePermissionsIfNeeded() {
        if (SlapRFBleShim.hasPermissions(this)) {
            return;
        }
        requestPermissions(SlapRFBleShim.requiredPermissions(), REQ_BLE_PERMS);
    }

    private void configureSystemBarsAndInsets(boolean darkTheme) {
        Window window = getWindow();
        if (window == null) {
            return;
        }
        int bgColor = darkTheme ? DARK_BG : LIGHT_BG;
        window.setStatusBarColor(bgColor);
        window.setNavigationBarColor(bgColor);
        if (rootLayout != null) {
            rootLayout.setBackgroundColor(bgColor);
        }

        if (Build.VERSION.SDK_INT >= 30) {
            window.setDecorFitsSystemWindows(false);
            WindowInsetsController ctrl = window.getInsetsController();
            if (ctrl != null) {
                int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                        | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                ctrl.setSystemBarsAppearance(darkTheme ? 0 : mask, mask);
            }
            if (rootLayout != null) {
                rootLayout.setOnApplyWindowInsetsListener((v, insets) -> {
                    Insets sysBars = insets.getInsets(
                            WindowInsets.Type.systemBars()
                                    | WindowInsets.Type.displayCutout());
                    if (v.getPaddingLeft() != sysBars.left
                            || v.getPaddingTop() != sysBars.top
                            || v.getPaddingRight() != sysBars.right
                            || v.getPaddingBottom() != sysBars.bottom) {
                        v.setPadding(sysBars.left, sysBars.top, sysBars.right, sysBars.bottom);
                    }
                    lastSysBarsBottom = sysBars.bottom;
                    Insets ime = insets.getInsets(WindowInsets.Type.ime());
                    int kbPx = Math.max(0, ime.bottom - sysBars.bottom);
                    latestTargetKbPx = kbPx;
                    latestImeVisible = insets.isVisible(WindowInsets.Type.ime());
                    // Only apply directly when no IME WindowInsetsAnimation is in flight;
                    // otherwise onApplyWindowInsets fires BEFORE onStart with the post-animation
                    // end state, which would jump the drawer to the target and snap it back.
                    if (activeImeAnimations == 0) {
                        dispatchKeyboardOffsetPx(kbPx, lastPushedKbCssPx < 0f ? 0L : 150L, latestImeVisible);
                    }
                    return WindowInsets.CONSUMED;
                });
                rootLayout.setWindowInsetsAnimationCallback(
                        new WindowInsetsAnimation.Callback(WindowInsetsAnimation.Callback.DISPATCH_MODE_STOP) {
                            @Override
                            public void onPrepare(WindowInsetsAnimation animation) {
                                if ((animation.getTypeMask() & WindowInsets.Type.ime()) != 0) {
                                    activeImeAnimations++;
                                }
                            }

                            @Override
                            public WindowInsetsAnimation.Bounds onStart(
                                    WindowInsetsAnimation animation,
                                    WindowInsetsAnimation.Bounds bounds) {
                                if ((animation.getTypeMask() & WindowInsets.Type.ime()) != 0) {
                                    boolean showing = latestImeVisible;
                                    WindowInsets rw = rootLayout.getRootWindowInsets();
                                    if (rw != null) {
                                        showing = rw.isVisible(WindowInsets.Type.ime());
                                        Insets sb = rw.getInsets(
                                                WindowInsets.Type.systemBars()
                                                        | WindowInsets.Type.displayCutout());
                                        lastSysBarsBottom = sb.bottom;
                                        int rwKb = Math.max(0, rw.getInsets(WindowInsets.Type.ime()).bottom - sb.bottom);
                                        if (showing && rwKb > 0) {
                                            latestTargetKbPx = rwKb;
                                        }
                                    }
                                    int boundUpperKb = Math.max(0, bounds.getUpperBound().bottom - lastSysBarsBottom);
                                    int targetKbPx = showing ? Math.max(latestTargetKbPx, boundUpperKb) : 0;
                                    long durMs = animation.getDurationMillis();
                                    if (durMs > 0L
                                            && animation.getInterpolator() != null
                                            && (!showing || targetKbPx > 0)) {
                                        compositorDrivenImeAnim = true;
                                        dispatchKeyboardOffsetPx(targetKbPx, durMs, showing);
                                    } else {
                                        compositorDrivenImeAnim = false;
                                    }
                                }
                                return bounds;
                            }

                            @Override
                            public WindowInsets onProgress(
                                    WindowInsets insets,
                                    List<WindowInsetsAnimation> runningAnimations) {
                                if (!compositorDrivenImeAnim) {
                                    boolean hasIme = false;
                                    for (WindowInsetsAnimation anim : runningAnimations) {
                                        if ((anim.getTypeMask() & WindowInsets.Type.ime()) != 0) {
                                            hasIme = true;
                                            break;
                                        }
                                    }
                                    if (hasIme) {
                                        Insets sysBars = insets.getInsets(
                                                WindowInsets.Type.systemBars()
                                                        | WindowInsets.Type.displayCutout());
                                        Insets ime = insets.getInsets(WindowInsets.Type.ime());
                                        int kbPx = Math.max(0, ime.bottom - sysBars.bottom);
                                        dispatchKeyboardOffsetPx(kbPx, 0L, kbPx > 0);
                                    }
                                }
                                return insets;
                            }

                            @Override
                            public void onEnd(WindowInsetsAnimation animation) {
                                if ((animation.getTypeMask() & WindowInsets.Type.ime()) != 0) {
                                    activeImeAnimations = Math.max(0, activeImeAnimations - 1);
                                    if (activeImeAnimations == 0) {
                                        compositorDrivenImeAnim = false;
                                        WindowInsets rw = rootLayout.getRootWindowInsets();
                                        if (rw != null) {
                                            Insets sysBars = rw.getInsets(
                                                    WindowInsets.Type.systemBars()
                                                            | WindowInsets.Type.displayCutout());
                                            lastSysBarsBottom = sysBars.bottom;
                                            boolean visible = rw.isVisible(WindowInsets.Type.ime());
                                            Insets ime = rw.getInsets(WindowInsets.Type.ime());
                                            int kbPx = visible ? Math.max(0, ime.bottom - sysBars.bottom) : 0;
                                            latestTargetKbPx = kbPx;
                                            latestImeVisible = visible;
                                            settleKeyboardOffsetIfNeeded(kbPx, visible);
                                        }
                                    }
                                }
                            }
                        });
                rootLayout.requestApplyInsets();
            }
        } else {
            View decor = window.getDecorView();
            int flags = decor.getSystemUiVisibility();
            if (!darkTheme) {
                flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                if (Build.VERSION.SDK_INT >= 26) {
                    flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                }
            } else {
                flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                if (Build.VERSION.SDK_INT >= 26) {
                    flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                }
            }
            decor.setSystemUiVisibility(flags);
        }
    }

    @Override
    public boolean dispatchTouchEvent(MotionEvent ev) {
        if (ev != null && ev.getPointerCount() >= 2) {
            lastMultiTouchMs = SystemClock.uptimeMillis();
        }
        return super.dispatchTouchEvent(ev);
    }

    private void handleBackNavigation() {
        if (SystemClock.uptimeMillis() - lastMultiTouchMs < 800L) {
            return;
        }
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        moveTaskToBack(true);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        handleBackNavigation();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_OPEN_DOCUMENT) {
            ValueCallback<Uri[]> cb = pendingFileChooser;
            pendingFileChooser = null;
            if (cb != null) {
                Uri[] results = null;
                if (resultCode == Activity.RESULT_OK && data != null && data.getData() != null) {
                    results = new Uri[]{data.getData()};
                }
                cb.onReceiveValue(results);
            }
        } else if (requestCode == REQ_CREATE_DOCUMENT) {
            byte[] payload = pendingSaveBytes;
            pendingSaveBytes = null;
            if (resultCode == Activity.RESULT_OK && data != null && data.getData() != null && payload != null) {
                Uri dest = data.getData();
                try (OutputStream out = getContentResolver().openOutputStream(dest)) {
                    if (out != null) {
                        out.write(payload);
                        out.flush();
                    }
                } catch (Exception ignored) {
                }
            }
        }
    }

    @Override
    protected void onDestroy() {
        if (Build.VERSION.SDK_INT >= 33 && backCallback != null) {
            try {
                getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(backCallback);
            } catch (Exception ignored) {
            }
            backCallback = null;
        }
        if (webView != null) {
            rootLayout.removeView(webView);
            webView.destroy();
            webView = null;
        }
        if (activeActivity == this) {
            activeActivity = null;
        }
        super.onDestroy();
    }

    private final class JsBridge {
        @JavascriptInterface
        public boolean isAndroidApp() {
            return true;
        }

        @JavascriptInterface
        public void speak(String text, float rate, float volume, boolean flush) {
            if (text == null || text.trim().isEmpty()) {
                return;
            }
            ensureTtsInitialized(SlapRFHost.this);
            TextToSpeech tts = sharedTts;
            if (tts == null || !ttsReady) {
                return;
            }
            float clampedRate = Math.max(0.5f, Math.min(2.5f, rate));
            float clampedVol = Math.max(0.0f, Math.min(1.0f, volume));
            try {
                tts.setSpeechRate(clampedRate);
                Bundle params = new Bundle();
                params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, clampedVol);
                int queueMode = flush ? TextToSpeech.QUEUE_FLUSH : TextToSpeech.QUEUE_ADD;
                tts.speak(text, queueMode, params, "slaprf-utt-" + utteranceSeq.getAndIncrement());
            } catch (Exception ignored) {
            }
        }

        @JavascriptInterface
        public void stopSpeech() {
            TextToSpeech tts = sharedTts;
            if (tts != null) {
                try {
                    tts.stop();
                } catch (Exception ignored) {
                }
            }
        }

        @JavascriptInterface
        public boolean isSpeaking() {
            TextToSpeech tts = sharedTts;
            try {
                return tts != null && ttsReady && tts.isSpeaking();
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public void playBeep(double freqHz, int durationMs, float volume) {
            playCapturableGateBeep(freqHz, durationMs, volume);
        }

        @JavascriptInterface
        public void setKeepScreenOn(boolean enabled) {
            runOnUiThread(() -> {
                Window w = getWindow();
                if (w == null) {
                    return;
                }
                if (enabled) {
                    w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                } else {
                    w.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            });
        }

        @JavascriptInterface
        public void setThemeMode(String mode) {
            final boolean dark = !"light".equalsIgnoreCase(mode);
            runOnUiThread(() -> configureSystemBarsAndInsets(dark));
        }

        @JavascriptInterface
        public String getLanStatusJson() {
            return nativeGetLanStatusJson();
        }

        @JavascriptInterface
        public String setLanEnabled(boolean enabled) {
            saveLanPref(SlapRFHost.this, enabled);
            String res = nativeSetLanEnabled(enabled);
            EngineService.refreshNotification(SlapRFHost.this);
            return res;
        }

        @JavascriptInterface
        public String getStringPref(String key) {
            if (key == null || key.trim().isEmpty()) {
                return "";
            }
            SharedPreferences sp = SlapRFHost.this.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String v = sp.getString("web_" + key.trim(), "");
            return v != null ? v : "";
        }

        @JavascriptInterface
        public void setStringPref(String key, String value) {
            if (key == null || key.trim().isEmpty()) {
                return;
            }
            SlapRFHost.this.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                    .edit()
                    .putString("web_" + key.trim(), value != null ? value : "")
                    .apply();
        }

        @JavascriptInterface
        public void saveBase64File(String filename, String mimeType, String base64Data) {
            if (base64Data == null || base64Data.isEmpty()) {
                return;
            }
            try {
                pendingSaveBytes = Base64.decode(base64Data, Base64.DEFAULT);
            } catch (IllegalArgumentException e) {
                pendingSaveBytes = null;
                return;
            }
            final String safeName = (filename == null || filename.trim().isEmpty()) ? "slaprf-export.json" : filename.trim();
            final String safeMime = (mimeType == null || mimeType.trim().isEmpty()) ? "application/json" : mimeType.trim();
            runOnUiThread(() -> {
                try {
                    Intent create = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                    create.addCategory(Intent.CATEGORY_OPENABLE);
                    create.setType(safeMime);
                    create.putExtra(Intent.EXTRA_TITLE, safeName);
                    startActivityForResult(create, REQ_CREATE_DOCUMENT);
                } catch (Exception ignored) {
                }
            });
        }
    }

    /**
     * Foreground Service keeping the native Go timing engine, USB OTG serial reader, and optional
     * LAN Wi-Fi server alive while the screen is off or another app is foregrounded.
     */
    public static final class EngineService extends Service {
        private PowerManager.WakeLock wakeLock;
        private WifiManager.WifiLock wifiLock;

        static void refreshNotification(Context ctx) {
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                nm.notify(NOTIF_ID, buildEngineNotification(ctx));
            }
        }

        private static Notification buildEngineNotification(Context ctx) {
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null && Build.VERSION.SDK_INT >= 26) {
                NotificationChannel ch = new NotificationChannel(
                        NOTIF_CHANNEL_ID,
                        "SlapRF Timing Engine",
                        NotificationManager.IMPORTANCE_LOW);
                ch.setDescription("Keeps USB & Wi-Fi race timing active while screen is off");
                ch.setShowBadge(false);
                nm.createNotificationChannel(ch);
            }

            String subtitle = "Local timing engine active";
            try {
                String lanJson = nativeGetLanStatusJson();
                if (lanJson != null && !lanJson.isEmpty()) {
                    JSONObject obj = new JSONObject(lanJson);
                    if (obj.optBoolean("enabled", false)) {
                        JSONArray urls = obj.optJSONArray("urls");
                        if (urls != null && urls.length() > 0) {
                            subtitle = "LAN server: " + urls.optString(0);
                        } else {
                            subtitle = "LAN server active on :" + obj.optInt("port", 8090);
                        }
                    }
                }
            } catch (Exception ignored) {
            }

            int immutableFlags = PendingIntent.FLAG_UPDATE_CURRENT
                    | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);

            Intent openIntent = new Intent(ctx, SlapRFHost.class);
            openIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            PendingIntent contentPi = PendingIntent.getActivity(ctx, 1, openIntent, immutableFlags);

            Intent stopIntent = new Intent(ctx, EngineService.class);
            stopIntent.setAction(ACTION_STOP_ENGINE);
            PendingIntent stopPi = PendingIntent.getService(ctx, 2, stopIntent, immutableFlags);

            Notification.Action stopAction = new Notification.Action.Builder(
                    android.R.drawable.ic_menu_close_clear_cancel,
                    "Stop Server",
                    stopPi).build();

            return new Notification.Builder(ctx, NOTIF_CHANNEL_ID)
                    .setSmallIcon(R.drawable.ic_stat_slaprf)
                    .setContentTitle("SlapRF")
                    .setContentText(subtitle)
                    .setContentIntent(contentPi)
                    .setOngoing(true)
                    .setColor(Color.parseColor("#15181D"))
                    .addAction(stopAction)
                    .build();
        }

        @Override
        public void onCreate() {
            super.onCreate();
            SlapRFUsbShim.init(this);
            SlapRFBleShim.init(this);
            ensureTtsInitialized(this);
            acquireLocks();
        }

        @Override
        public int onStartCommand(Intent intent, int flags, int startId) {
            if (intent != null && ACTION_STOP_ENGINE.equals(intent.getAction())) {
                SlapRFHost act = activeActivity;
                if (act != null) {
                    act.runOnUiThread(act::finishAndRemoveTask);
                }
                nativeStopServer();
                shutdownSharedBeepTrack();
                shutdownSharedTts();
                releaseLocks();
                stopForeground(STOP_FOREGROUND_REMOVE);
                stopSelf();
                return START_NOT_STICKY;
            }

            Notification notif = buildEngineNotification(this);
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else {
                startForeground(NOTIF_ID, notif);
            }

            nativeStartServer(
                    getFilesDir().getAbsolutePath(),
                    resolveVersionName(this),
                    isLanPrefEnabled(this));
            return START_STICKY;
        }

        @SuppressWarnings("deprecation")
        private void acquireLocks() {
            try {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                if (pm != null && wakeLock == null) {
                    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SlapRF::TimingEngineWakeLock");
                    wakeLock.setReferenceCounted(false);
                    wakeLock.acquire();
                }
            } catch (Exception ignored) {
            }
            try {
                WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                if (wm != null && wifiLock == null) {
                    int mode = Build.VERSION.SDK_INT >= 29
                            ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                            : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
                    wifiLock = wm.createWifiLock(mode, "SlapRF::TimingWifiLock");
                    wifiLock.setReferenceCounted(false);
                    wifiLock.acquire();
                }
            } catch (Exception ignored) {
            }
        }

        private void releaseLocks() {
            if (wakeLock != null) {
                try {
                    if (wakeLock.isHeld()) {
                        wakeLock.release();
                    }
                } catch (Exception ignored) {
                }
                wakeLock = null;
            }
            if (wifiLock != null) {
                try {
                    if (wifiLock.isHeld()) {
                        wifiLock.release();
                    }
                } catch (Exception ignored) {
                }
                wifiLock = null;
            }
        }

        @Override
        public void onDestroy() {
            releaseLocks();
            super.onDestroy();
        }

        @Override
        public IBinder onBind(Intent intent) {
            return null;
        }
    }
}
