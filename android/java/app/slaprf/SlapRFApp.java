package app.slaprf;

import android.app.ActivityManager;
import android.app.Application;
import android.app.ApplicationExitInfo;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.content.pm.InstallSourceInfo;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;

/**
 * Pure-Java Application entrypoint and startup/crash diagnostic logger.
 *
 * Intentionally avoids loading any JNI libraries so it initializes before {@link SlapRFHost}
 * or {@code libslaprf.so}, installs a global uncaught-throwable handler, inspects Android 11+
 * {@link ApplicationExitInfo} records from prior native/Java crashes, and writes diagnostic
 * logs to {@code Downloads/slaprf-startup-log.txt} (via {@link MediaStore.Downloads}, requiring
 * zero storage permissions on Android 10–17+) whenever a launch failure occurs or when built
 * with {@code -boot-log-downloads}.
 */
public final class SlapRFApp extends Application {
    public static final String TAG = "SlapRFBoot";
    public static final String BOOT_LOG_FILENAME = "slaprf-startup-log.txt";

    private static final Object LOCK = new Object();
    private static final StringBuilder BOOT_BUF = new StringBuilder(8192);
    private static final long PROC_START_ELAPSED_MS = SystemClock.elapsedRealtime();

    private static volatile Context appCtx;
    private static volatile boolean handlerInstalled = false;
    private static volatile boolean headerWritten = false;
    private static volatile boolean forceDownloadsExport = false;
    private static volatile Uri cachedDownloadUri;
    private static volatile String lastDownloadsStatus = "not_exported";

    @Override
    protected void attachBaseContext(Context base) {
        super.attachBaseContext(base);
        appCtx = base;
        installGlobalCrashHandler();
        ensureHeader(base);
        step(base, "SlapRFApp.attachBaseContext completed");
    }

    @Override
    public void onCreate() {
        super.onCreate();
        appCtx = getApplicationContext() != null ? getApplicationContext() : this;
        installGlobalCrashHandler();
        ensureHeader(appCtx);
        recordHistoricalExitReasons(appCtx);
        step(appCtx, "SlapRFApp.onCreate completed");
    }

    static void installGlobalCrashHandler() {
        if (handlerInstalled) {
            return;
        }
        synchronized (LOCK) {
            if (handlerInstalled) {
                return;
            }
            final Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
            Thread.setDefaultUncaughtExceptionHandler((thread, throwable) -> {
                try {
                    String tName = thread != null ? thread.getName() : "unknown";
                    recordError(appCtx, "UNCAUGHT THROWABLE on thread [" + tName + "]", throwable, true);
                } catch (Throwable ignored) {
                }
                if (prev != null) {
                    prev.uncaughtException(thread, throwable);
                }
            });
            handlerInstalled = true;
        }
    }

    private static void ensureHeader(Context ctx) {
        if (headerWritten) {
            return;
        }
        synchronized (LOCK) {
            if (headerWritten) {
                return;
            }
            headerWritten = true;
            BOOT_BUF.append("=== SlapRF Android Startup Diagnostic Log ===\n");
            BOOT_BUF.append("timeUtc: ").append(nowUtcIso()).append('\n');
            if (ctx != null) {
                BOOT_BUF.append("package: ").append(ctx.getPackageName()).append('\n');
                BOOT_BUF.append("appVersion: ").append(SlapRFHost.resolveVersionName(ctx)).append('\n');
                BOOT_BUF.append("installSource: ").append(resolveInstallSource(ctx)).append('\n');
            }
            BOOT_BUF.append("androidRelease: ").append(Build.VERSION.RELEASE)
                    .append(" (sdk=").append(Build.VERSION.SDK_INT)
                    .append(", codename=").append(Build.VERSION.CODENAME).append(")\n");
            BOOT_BUF.append("device: ").append(Build.MANUFACTURER).append(' ').append(Build.MODEL)
                    .append(" (").append(Build.PRODUCT).append(")\n");
            BOOT_BUF.append("fingerprint: ").append(Build.FINGERPRINT).append('\n');
            BOOT_BUF.append("supportedAbis: ").append(Arrays.toString(Build.SUPPORTED_ABIS)).append('\n');
            BOOT_BUF.append("alwaysExportDownloads: ").append(BootLogConfig.ALWAYS_EXPORT_BOOT_LOG).append('\n');
            BOOT_BUF.append("---------------------------------------------\n");
        }
    }

    private static String resolveInstallSource(Context ctx) {
        try {
            PackageManager pm = ctx.getPackageManager();
            if (Build.VERSION.SDK_INT >= 30) {
                InstallSourceInfo isi = pm.getInstallSourceInfo(ctx.getPackageName());
                return "installing=" + isi.getInstallingPackageName()
                        + ", initiating=" + isi.getInitiatingPackageName()
                        + ", originating=" + isi.getOriginatingPackageName();
            }
            @SuppressWarnings("deprecation")
            String src = pm.getInstallerPackageName(ctx.getPackageName());
            return String.valueOf(src);
        } catch (Throwable t) {
            return "unavailable (" + t.getClass().getSimpleName() + ")";
        }
    }

    private static void recordHistoricalExitReasons(Context ctx) {
        if (ctx == null || Build.VERSION.SDK_INT < 30) {
            return;
        }
        try {
            ActivityManager am = (ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
            if (am == null) {
                return;
            }
            List<ApplicationExitInfo> exits = am.getHistoricalProcessExitReasons(ctx.getPackageName(), 0, 5);
            if (exits == null || exits.isEmpty()) {
                appendLineLocked("priorExits: none recorded by ActivityManager");
                return;
            }
            synchronized (LOCK) {
                BOOT_BUF.append("priorExits (most recent first, count=").append(exits.size()).append("):\n");
                for (int i = 0; i < exits.size(); i++) {
                    ApplicationExitInfo info = exits.get(i);
                    int reason = info.getReason();
                    if (i == 0 && isCrashExitReason(reason)) {
                        forceDownloadsExport = true;
                    }
                    BOOT_BUF.append("  [").append(i).append("] time=").append(formatEpochMs(info.getTimestamp()))
                            .append(" reason=").append(exitReasonName(reason)).append('(').append(reason).append(')')
                            .append(" status=").append(info.getStatus())
                            .append(" importance=").append(info.getImportance())
                            .append(" desc=").append(info.getDescription())
                            .append('\n');
                    if (i == 0 && isCrashExitReason(reason)) {
                        String traceSnippet = readExitTraceSnippet(info, 4096);
                        if (!traceSnippet.isEmpty()) {
                            BOOT_BUF.append("  [0] trace:\n").append(traceSnippet).append('\n');
                        }
                    }
                }
            }
        } catch (Throwable t) {
            appendLineLocked("priorExits check failed: " + t);
        }
    }

    private static boolean isCrashExitReason(int reason) {
        return reason == ApplicationExitInfo.REASON_CRASH
                || reason == ApplicationExitInfo.REASON_CRASH_NATIVE
                || reason == ApplicationExitInfo.REASON_ANR
                || reason == ApplicationExitInfo.REASON_INITIALIZATION_FAILURE;
    }

    private static String exitReasonName(int reason) {
        switch (reason) {
            case ApplicationExitInfo.REASON_EXIT_SELF: return "EXIT_SELF";
            case ApplicationExitInfo.REASON_SIGNALED: return "SIGNALED";
            case ApplicationExitInfo.REASON_LOW_MEMORY: return "LOW_MEMORY";
            case ApplicationExitInfo.REASON_CRASH: return "CRASH_JAVA";
            case ApplicationExitInfo.REASON_CRASH_NATIVE: return "CRASH_NATIVE";
            case ApplicationExitInfo.REASON_ANR: return "ANR";
            case ApplicationExitInfo.REASON_INITIALIZATION_FAILURE: return "INIT_FAILURE";
            case ApplicationExitInfo.REASON_PERMISSION_CHANGE: return "PERMISSION_CHANGE";
            case ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE: return "EXCESSIVE_RESOURCE";
            case ApplicationExitInfo.REASON_USER_REQUESTED: return "USER_REQUESTED";
            case ApplicationExitInfo.REASON_USER_STOPPED: return "USER_STOPPED";
            case ApplicationExitInfo.REASON_DEPENDENCY_DIED: return "DEPENDENCY_DIED";
            case ApplicationExitInfo.REASON_OTHER: return "OTHER";
            default: return "REASON_" + reason;
        }
    }

    private static String readExitTraceSnippet(ApplicationExitInfo info, int maxBytes) {
        if (Build.VERSION.SDK_INT < 30) {
            return "";
        }
        try (InputStream in = info.getTraceInputStream()) {
            if (in == null) {
                return "";
            }
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[1024];
            int remaining = maxBytes;
            while (remaining > 0) {
                int n = in.read(buf, 0, Math.min(buf.length, remaining));
                if (n <= 0) {
                    break;
                }
                out.write(buf, 0, n);
                remaining -= n;
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8).trim();
        } catch (Throwable ignored) {
            return "";
        }
    }

    public static void step(Context ctx, String message) {
        Context effective = resolveCtx(ctx);
        ensureHeader(effective);
        String line = formatStepPrefix() + message;
        Log.i(TAG, message);
        appendLineLocked(line);
        persistLogs(effective, BootLogConfig.ALWAYS_EXPORT_BOOT_LOG || forceDownloadsExport);
    }

    public static void recordError(Context ctx, String stage, Throwable t, boolean fatal) {
        Context effective = resolveCtx(ctx);
        ensureHeader(effective);
        String stack = formatThrowable(t);
        String prefix = fatal ? "FATAL " : "WARN ";
        Log.e(TAG, prefix + stage, t);
        synchronized (LOCK) {
            if (fatal) {
                forceDownloadsExport = true;
            }
            BOOT_BUF.append(formatStepPrefix()).append(prefix).append(stage).append('\n');
            if (!stack.isEmpty()) {
                BOOT_BUF.append(stack);
                if (!stack.endsWith("\n")) {
                    BOOT_BUF.append('\n');
                }
            }
        }
        persistLogs(effective, fatal || BootLogConfig.ALWAYS_EXPORT_BOOT_LOG || forceDownloadsExport);
    }

    public static void appendGoLogSnapshot(Context ctx) {
        Context effective = resolveCtx(ctx);
        persistLogs(effective, BootLogConfig.ALWAYS_EXPORT_BOOT_LOG || forceDownloadsExport);
    }

    public static String exportNowToDownloads(Context ctx) {
        Context effective = resolveCtx(ctx);
        forceDownloadsExport = true;
        persistLogs(effective, true);
        return lastDownloadsStatus;
    }

    public static String snapshotText(Context ctx) {
        Context effective = resolveCtx(ctx);
        ensureHeader(effective);
        return composeFullReport(effective, true);
    }

    private static String composeFullReport(Context ctx, boolean includeExportFooter) {
        StringBuilder out;
        synchronized (LOCK) {
            out = new StringBuilder(BOOT_BUF.length() + 4608);
            out.append(BOOT_BUF);
        }
        appendGoEngineLogTail(out, ctx, 4096);
        if (includeExportFooter) {
            out.append("\ndownloadsExport: ").append(lastDownloadsStatus).append('\n');
        }
        return out.toString();
    }

    private static void appendLineLocked(String line) {
        synchronized (LOCK) {
            BOOT_BUF.append(line).append('\n');
        }
    }

    private static void appendGoEngineLogTail(StringBuilder target, Context ctx, int maxBytes) {
        if (ctx == null) {
            return;
        }
        try {
            File goLog = new File(ctx.getFilesDir(), "slaprf.log");
            if (!goLog.isFile() || goLog.length() <= 0) {
                return;
            }
            long len = goLog.length();
            int toRead = (int) Math.min((long) maxBytes, len);
            byte[] data = new byte[toRead];
            try (FileInputStream fis = new FileInputStream(goLog)) {
                long skip = len - toRead;
                while (skip > 0) {
                    long s = fis.skip(skip);
                    if (s <= 0) {
                        break;
                    }
                    skip -= s;
                }
                int off = 0;
                while (off < toRead) {
                    int n = fis.read(data, off, toRead - off);
                    if (n <= 0) {
                        break;
                    }
                    off += n;
                }
                String tail = new String(data, 0, off, StandardCharsets.UTF_8).trim();
                if (!tail.isEmpty()) {
                    target.append("--- slaprf.log tail (").append(off).append(" bytes) ---\n")
                            .append(tail).append("\n--- end slaprf.log ---\n");
                }
            }
        } catch (Throwable ignored) {
        }
    }

    private static void persistLogs(Context ctx, boolean includeDownloads) {
        if (ctx == null) {
            return;
        }
        byte[] payload = composeFullReport(ctx, false).getBytes(StandardCharsets.UTF_8);
        writeFileQuietly(new File(ctx.getFilesDir(), BOOT_LOG_FILENAME), payload);
        try {
            File extDir = ctx.getExternalFilesDir(null);
            if (extDir != null) {
                writeFileQuietly(new File(extDir, BOOT_LOG_FILENAME), payload);
            }
        } catch (Throwable ignored) {
        }
        if (includeDownloads) {
            writeToMediaStoreDownloads(ctx, payload);
        }
    }

    private static void writeFileQuietly(File target, byte[] payload) {
        if (target == null) {
            return;
        }
        try {
            File parent = target.getParentFile();
            if (parent != null && !parent.exists()) {
                //noinspection ResultOfMethodCallIgnored
                parent.mkdirs();
            }
            try (FileOutputStream fos = new FileOutputStream(target, false)) {
                fos.write(payload);
                fos.flush();
                fos.getFD().sync();
            }
        } catch (Throwable ignored) {
        }
    }

    private static void writeToMediaStoreDownloads(Context ctx, byte[] payload) {
        if (Build.VERSION.SDK_INT < 29) {
            try {
                @SuppressWarnings("deprecation")
                File dl = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                File out = new File(dl, BOOT_LOG_FILENAME);
                writeFileQuietly(out, payload);
                lastDownloadsStatus = out.getAbsolutePath();
            } catch (Throwable t) {
                lastDownloadsStatus = "legacy_downloads_error: " + t.getMessage();
            }
            return;
        }
        try {
            ContentResolver cr = ctx.getContentResolver();
            Uri uri = cachedDownloadUri;
            if (uri == null) {
                uri = findExistingDownloadUri(cr);
                cachedDownloadUri = uri;
            }
            if (uri != null && writeUriBytes(cr, uri, payload)) {
                lastDownloadsStatus = "Downloads/" + BOOT_LOG_FILENAME + " (" + uri + ")";
                return;
            }
            if (uri != null) {
                try {
                    cr.delete(uri, null, null);
                } catch (Throwable ignored) {
                }
                cachedDownloadUri = null;
            }
            ContentValues cv = new ContentValues();
            cv.put(MediaStore.MediaColumns.DISPLAY_NAME, BOOT_LOG_FILENAME);
            cv.put(MediaStore.MediaColumns.MIME_TYPE, "text/plain");
            cv.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/");
            Uri created = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
            if (created != null && writeUriBytes(cr, created, payload)) {
                cachedDownloadUri = created;
                lastDownloadsStatus = "Downloads/" + BOOT_LOG_FILENAME + " (" + created + ")";
            } else {
                lastDownloadsStatus = "mediastore_insert_failed";
            }
        } catch (Throwable t) {
            lastDownloadsStatus = "mediastore_error: " + t.getClass().getSimpleName() + ": " + t.getMessage();
        }
    }

    private static Uri findExistingDownloadUri(ContentResolver cr) {
        if (Build.VERSION.SDK_INT < 29) {
            return null;
        }
        try (Cursor c = cr.query(
                MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                new String[]{MediaStore.MediaColumns._ID},
                MediaStore.MediaColumns.DISPLAY_NAME + "=?",
                new String[]{BOOT_LOG_FILENAME},
                MediaStore.MediaColumns.DATE_MODIFIED + " DESC")) {
            if (c != null && c.moveToFirst()) {
                long id = c.getLong(0);
                return ContentUris.withAppendedId(MediaStore.Downloads.EXTERNAL_CONTENT_URI, id);
            }
        } catch (Throwable ignored) {
        }
        return null;
    }

    private static boolean writeUriBytes(ContentResolver cr, Uri uri, byte[] payload) {
        for (String mode : new String[]{"rwt", "wt", "w"}) {
            try (OutputStream out = cr.openOutputStream(uri, mode)) {
                if (out != null) {
                    out.write(payload);
                    out.flush();
                    return true;
                }
            } catch (Throwable ignored) {
            }
        }
        return false;
    }

    private static Context resolveCtx(Context ctx) {
        if (ctx != null) {
            Context app = ctx.getApplicationContext();
            return app != null ? app : ctx;
        }
        return appCtx;
    }

    private static String formatStepPrefix() {
        long dtMs = Math.max(0L, SystemClock.elapsedRealtime() - PROC_START_ELAPSED_MS);
        return String.format(Locale.US, "[+%6dms %s] ", dtMs, nowUtcIso());
    }

    private static String nowUtcIso() {
        return formatEpochMs(System.currentTimeMillis());
    }

    private static String formatEpochMs(long epochMs) {
        SimpleDateFormat sdf = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        sdf.setTimeZone(TimeZone.getTimeZone("UTC"));
        return sdf.format(new Date(epochMs));
    }

    public static String formatThrowable(Throwable t) {
        if (t == null) {
            return "";
        }
        StringWriter sw = new StringWriter();
        PrintWriter pw = new PrintWriter(sw);
        t.printStackTrace(pw);
        pw.flush();
        return sw.toString();
    }
}
