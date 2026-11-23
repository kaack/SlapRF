package app.slaprf.gatecam;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.SurfaceTexture;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.TextureView;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.opencv.android.OpenCVLoader;

/**
 * GateCamHost renders a zero-copy Camera2 TextureView underneath a transparent full-screen WebView
 * served by the embedded Go verification backend (libgatecam.so on 127.0.0.1:18095).
 */
public final class GateCamHost extends Activity {
    private static final int REQ_CAMERA = 4201;
    private static volatile GateCamHost activeHost;

    static {
        try {
            OpenCVLoader.initLocal();
        } catch (Throwable ignored) {
            try {
                System.loadLibrary("c++_shared");
                System.loadLibrary("opencv_java4");
            } catch (Throwable ignored2) {
            }
        }
        System.loadLibrary("gatecam");
    }

    static native String nativeStartServer(String filesDir, String version);
    static native void nativeStopServer();

    private FrameLayout rootLayout;
    private TextureView previewView;
    private WebView webView;
    private String serverUrl = "";

    @Override
    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        activeHost = this;

        Window win = getWindow();
        if (win != null) {
            win.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            win.setStatusBarColor(0xFF0B0C0F);
            win.setNavigationBarColor(0xFF0B0C0F);
        }

        GateCamShim.init(getApplicationContext(), this);

        rootLayout = new FrameLayout(this);
        rootLayout.setBackgroundColor(0xFF0B0C0F);
        if (Build.VERSION.SDK_INT >= 30 && win != null) {
            win.setDecorFitsSystemWindows(false);
            WindowInsetsController ctrl = win.getInsetsController();
            if (ctrl != null) {
                int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                        | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                ctrl.setSystemBarsAppearance(0, mask);
            }
            rootLayout.setOnApplyWindowInsetsListener((v, insets) -> {
                Insets sysBars = insets.getInsets(
                        WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                if (v.getPaddingLeft() != sysBars.left
                        || v.getPaddingTop() != sysBars.top
                        || v.getPaddingRight() != sysBars.right
                        || v.getPaddingBottom() != sysBars.bottom) {
                    v.setPadding(sysBars.left, sysBars.top, sysBars.right, sysBars.bottom);
                }
                return WindowInsets.CONSUMED;
            });
        }

        previewView = new TextureView(this);
        FrameLayout.LayoutParams pvLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
                Gravity.TOP | Gravity.START);
        rootLayout.addView(previewView, pvLp);

        previewView.setSurfaceTextureListener(new TextureView.SurfaceTextureListener() {
            @Override
            public void onSurfaceTextureAvailable(SurfaceTexture surface, int width, int height) {
                GateCamShim.onPreviewSurfaceAvailable(previewView, width, height);
                ensureCameraStarted();
            }

            @Override
            public void onSurfaceTextureSizeChanged(SurfaceTexture surface, int width, int height) {
                GateCamShim.onPreviewSurfaceSizeChanged(previewView, width, height);
            }

            @Override
            public boolean onSurfaceTextureDestroyed(SurfaceTexture surface) {
                GateCamShim.onPreviewSurfaceDestroyed();
                return true;
            }

            @Override
            public void onSurfaceTextureUpdated(SurfaceTexture surface) {
            }
        });

        WebView.setWebContentsDebuggingEnabled(true);
        webView = new WebView(this);
        webView.setBackgroundColor(Color.TRANSPARENT);
        WebSettings ws = webView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setMediaPlaybackRequiresUserGesture(false);
        ws.setCacheMode(WebSettings.LOAD_NO_CACHE);

        webView.addJavascriptInterface(new JSBridge(), "GateCamAndroid");
        webView.setWebViewClient(new WebViewClient());
        webView.setWebChromeClient(new WebChromeClient());
        webView.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition, String mimetype, long contentLength) {
                try {
                    Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                    startActivity(i);
                } catch (Throwable ignored) {
                }
            }
        });

        rootLayout.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));

        setContentView(rootLayout);

        String ver = "0.1.0";
        try {
            PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
            if (pi != null && pi.versionName != null) {
                ver = pi.versionName;
            }
        } catch (Throwable ignored) {
        }

        serverUrl = nativeStartServer(getFilesDir().getAbsolutePath(), ver);
        if (serverUrl != null && !serverUrl.isEmpty()) {
            webView.loadUrl(serverUrl);
        }

        ensureCameraStarted();
    }

    private void ensureCameraStarted() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAMERA);
                return;
            }
        }
        GateCamShim.startCameraIfReady();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_CAMERA && grantResults != null && grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            GateCamShim.startCameraIfReady();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        GateCamShim.setActivity(this);
        ensureCameraStarted();
    }

    @Override
    protected void onPause() {
        if (activeHost == this) {
            GateCamShim.stopCamera();
        }
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        if (activeHost == this && isFinishing()) {
            GateCamShim.stopCamera();
            nativeStopServer();
            activeHost = null;
        }
        super.onDestroy();
    }

    public final class JSBridge {
        @JavascriptInterface
        public void setPreviewVisible(final boolean visible) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (previewView != null) {
                        previewView.setVisibility(visible ? View.VISIBLE : View.INVISIBLE);
                    }
                }
            });
        }

        @JavascriptInterface
        public void setPreviewBounds(final double leftCss, final double topCss, final double widthCss, final double heightCss, final double dpr) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (previewView == null || widthCss <= 1 || heightCss <= 1) return;
                    double scale = dpr > 0 ? dpr : getResources().getDisplayMetrics().density;
                    int x = (int) Math.round(leftCss * scale);
                    int y = (int) Math.round(topCss * scale);
                    int w = (int) Math.round(widthCss * scale);
                    int h = (int) Math.round(heightCss * scale);
                    FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(w, h, Gravity.TOP | Gravity.START);
                    lp.leftMargin = x;
                    lp.topMargin = y;
                    previewView.setLayoutParams(lp);
                    GateCamShim.onPreviewSurfaceSizeChanged(previewView, w, h);
                }
            });
        }
    }
}
