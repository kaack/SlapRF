package app.slaprf;

import android.Manifest;
import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import android.os.SystemClock;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;

/**
 * Bluetooth LE byte-stream shim for the SlapRF Bluetooth Hub firmware (see
 * docs/ble-hub-protocol.md). It mirrors the static API of {@link SlapRFUsbShim}
 * (listPortsJson / openPort / readPort / writePort / closePort) so Go treats a
 * {@code ble:<FP8HEX>} port exactly like a USB serial port. All SlapRF framing,
 * STATUS? probing and hub frame decoding stay in Go.
 */
public final class SlapRFBleShim {
    static final String PORT_PREFIX = "ble:";
    static final UUID SERVICE_UUID = UUID.fromString("5d1a0001-5a7e-4c0b-9e5f-534c41505246");
    static final UUID RX_UUID = UUID.fromString("5d1a0002-5a7e-4c0b-9e5f-534c41505246");
    static final UUID TX_UUID = UUID.fromString("5d1a0003-5a7e-4c0b-9e5f-534c41505246");
    static final UUID CCCD_UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");
    static final int MANUFACTURER_ID = 0xFFFF;

    private static final int REQUESTED_MTU = 247;
    private static final long SCAN_WINDOW_MS = 4000L;
    private static final long SCAN_REFRESH_MS = 8000L;
    private static final long SEEN_TTL_MS = 30000L;
    private static final long FIRST_LIST_WAIT_MS = 1500L;
    private static final long OPEN_SCAN_TIMEOUT_MS = 8000L;
    private static final long CONNECT_TIMEOUT_MS = 10000L;
    private static final long GATT_OP_TIMEOUT_MS = 3000L;
    private static final long PRIORITY_RENEW_MS = 15000L;
    private static final int MAX_BUFFERED_RX = 16384;
    // Handles live in their own range so they can never collide with SlapRFUsbShim handles.
    private static final AtomicInteger nextHandle = new AtomicInteger(0x40000001);

    private static volatile Context appContext;
    private static volatile Runnable permissionRequester;
    private static volatile String lastOpenError = "";
    private static volatile long lastPermissionPromptMs = 0L;
    private static final Handler mainHandler = new Handler(Looper.getMainLooper());

    private static final Object scanLock = new Object();
    private static volatile boolean scanning = false;
    private static volatile long lastScanStartMs = 0L;
    private static ScanCallback activeScanCallback;
    private static final ConcurrentHashMap<String, SeenHub> seen = new ConcurrentHashMap<>();
    private static final ConcurrentHashMap<Integer, Session> sessions = new ConcurrentHashMap<>();

    private static final class SeenHub {
        final String fp;
        final BluetoothDevice device;
        final String name;
        final int role;
        final boolean hasFlags;
        final boolean paired;
        final long seenAtMs;

        SeenHub(String fp, BluetoothDevice device, String name, int role, boolean hasFlags, boolean paired, long seenAtMs) {
            this.fp = fp;
            this.device = device;
            this.name = name;
            this.role = role;
            this.hasFlags = hasFlags;
            this.paired = paired;
            this.seenAtMs = seenAtMs;
        }
    }

    /** One GATT link. Notification bytes are queued in arrival order into rxBuf. */
    private static final class Session extends BluetoothGattCallback {
        final int handle;
        final String fp;
        volatile BluetoothGatt gatt;
        volatile BluetoothGattCharacteristic rxChar;
        volatile BluetoothGattCharacteristic txChar;
        volatile int mtu = 23;
        volatile boolean closed = false;
        volatile boolean ready = false;
        volatile String failure = null;

        final CountDownLatch openLatch = new CountDownLatch(1);
        final Object writeLock = new Object();
        final Object opLock = new Object();
        // Signalled by onCharacteristicWrite / onDescriptorWrite / onMtuChanged.
        volatile boolean opDone = false;
        volatile int opStatus = 0;

        final ReentrantLock rxLock = new ReentrantLock();
        final Condition rxAvail = rxLock.newCondition();
        byte[] rxBuf = new byte[MAX_BUFFERED_RX];
        int rxHead = 0;
        int rxLen = 0;
        volatile long lastPriorityRenewMs = 0L;

        Session(int handle, String fp) {
            this.handle = handle;
            this.fp = fp;
        }

        void fail(String msg) {
            if (failure == null) {
                failure = msg;
            }
            openLatch.countDown();
            wakeReaders();
        }

        void wakeReaders() {
            rxLock.lock();
            try {
                rxAvail.signalAll();
            } finally {
                rxLock.unlock();
            }
        }

        void completeOp(int status) {
            synchronized (opLock) {
                opStatus = status;
                opDone = true;
                opLock.notifyAll();
            }
        }

        void beginOp() {
            synchronized (opLock) {
                opDone = false;
                opStatus = 0;
            }
        }

        boolean awaitOp(long timeoutMs) {
            long deadline = SystemClock.uptimeMillis() + timeoutMs;
            synchronized (opLock) {
                while (!opDone && !closed) {
                    long rem = deadline - SystemClock.uptimeMillis();
                    if (rem <= 0) {
                        return false;
                    }
                    try {
                        opLock.wait(rem);
                    } catch (InterruptedException ie) {
                        Thread.currentThread().interrupt();
                        return false;
                    }
                }
                return opDone && opStatus == BluetoothGatt.GATT_SUCCESS;
            }
        }

        void appendRx(byte[] data) {
            if (data == null || data.length == 0 || closed) {
                return;
            }
            rxLock.lock();
            try {
                if (data.length >= MAX_BUFFERED_RX) {
                    System.arraycopy(data, data.length - MAX_BUFFERED_RX, rxBuf, 0, MAX_BUFFERED_RX);
                    rxHead = 0;
                    rxLen = MAX_BUFFERED_RX;
                    rxAvail.signalAll();
                    return;
                }
                int need = rxLen + data.length;
                if (need > MAX_BUFFERED_RX) {
                    // Reader stalled: drop the oldest bytes so telemetry stays real-time without multi-second lag.
                    int drop = need - MAX_BUFFERED_RX;
                    rxHead = (rxHead + drop) % rxBuf.length;
                    rxLen -= Math.min(drop, rxLen);
                }
                int tail = (rxHead + rxLen) % rxBuf.length;
                int first = Math.min(data.length, rxBuf.length - tail);
                System.arraycopy(data, 0, rxBuf, tail, first);
                if (first < data.length) {
                    System.arraycopy(data, first, rxBuf, 0, data.length - first);
                }
                rxLen += data.length;
                rxAvail.signalAll();
            } finally {
                rxLock.unlock();
            }
        }

        @Override
        @SuppressLint("MissingPermission")
        public void onConnectionStateChange(BluetoothGatt g, int status, int newState) {
            if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                // Request HIGH priority (11.25-15 ms) so packets stream smoothly inside the Hub's
                // 14.6 ms 2.4 GHz window every 20 ms instead of relaxing to sluggish 45 ms bursts.
                try {
                    g.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH);
                } catch (Exception ignored) {
                }
                try {
                    g.setPreferredPhy(BluetoothDevice.PHY_LE_2M_MASK, BluetoothDevice.PHY_LE_2M_MASK, BluetoothDevice.PHY_OPTION_NO_PREFERRED);
                } catch (Exception ignored) {
                }
                // MTU exchange first; service discovery continues in onMtuChanged.
                if (!g.requestMtu(REQUESTED_MTU)) {
                    if (!g.discoverServices()) {
                        fail("Bluetooth service discovery could not start");
                    }
                }
                return;
            }
            if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                boolean wasReady = ready;
                ready = false;
                if (!wasReady) {
                    fail("Bluetooth connection failed (GATT status " + status + ")");
                } else {
                    fail("Bluetooth hub disconnected");
                }
                completeOp(-1);
                // Release the GATT client; Go sees EOF from readPort once buffered bytes drain.
                closeGattQuietly(this);
            }
        }

        @Override
        @SuppressLint("MissingPermission")
        public void onMtuChanged(BluetoothGatt g, int newMtu, int status) {
            if (status == BluetoothGatt.GATT_SUCCESS && newMtu >= 23) {
                mtu = newMtu;
            }
            if (!ready && rxChar == null) {
                if (!g.discoverServices()) {
                    fail("Bluetooth service discovery could not start");
                }
            }
        }

        @Override
        @SuppressLint("MissingPermission")
        public void onServicesDiscovered(BluetoothGatt g, int status) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                fail("Bluetooth service discovery failed (status " + status + ")");
                return;
            }
            // Android AOSP relaxes initial parameters to 45 ms (BALANCED) right when service
            // discovery finishes; re-assert HIGH priority (11.25-15 ms) immediately here.
            try {
                g.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH);
            } catch (Exception ignored) {
            }
            BluetoothGattService svc = g.getService(SERVICE_UUID);
            if (svc == null) {
                fail("SlapRF Hub service not found on device");
                return;
            }
            BluetoothGattCharacteristic rx = svc.getCharacteristic(RX_UUID);
            BluetoothGattCharacteristic tx = svc.getCharacteristic(TX_UUID);
            if (rx == null || tx == null) {
                fail("SlapRF Hub RX/TX characteristics missing");
                return;
            }
            rxChar = rx;
            txChar = tx;
            if (!g.setCharacteristicNotification(tx, true)) {
                fail("Could not enable TX notifications");
                return;
            }
            BluetoothGattDescriptor cccd = tx.getDescriptor(CCCD_UUID);
            if (cccd == null) {
                fail("TX notification descriptor (CCCD) missing");
                return;
            }
            boolean started;
            byte[] enable = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE;
            if (Build.VERSION.SDK_INT >= 33) {
                started = g.writeDescriptor(cccd, enable) == BluetoothGatt.GATT_SUCCESS;
            } else {
                started = legacyWriteDescriptor(g, cccd, enable);
            }
            if (!started) {
                fail("Could not write TX notification descriptor");
            }
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt g, BluetoothGattDescriptor d, int status) {
            if (d != null && CCCD_UUID.equals(d.getUuid()) && !ready) {
                if (status == BluetoothGatt.GATT_SUCCESS) {
                    // Notifications are live: the port is open and the first command may be sent.
                    ready = true;
                    openLatch.countDown();
                } else {
                    fail("Enabling TX notifications failed (status " + status + ")");
                }
            }
        }

        @Override
        public void onCharacteristicWrite(BluetoothGatt g, BluetoothGattCharacteristic c, int status) {
            completeOp(status);
        }

        @Override
        @SuppressLint("MissingPermission")
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c, byte[] value) {
            if (c != null && TX_UUID.equals(c.getUuid())) {
                appendRx(value);
                long nowMs = SystemClock.uptimeMillis();
                if (g != null && nowMs - lastPriorityRenewMs >= PRIORITY_RENEW_MS) {
                    lastPriorityRenewMs = nowMs;
                    try {
                        g.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH);
                    } catch (Exception ignored) {
                    }
                }
            }
        }

        @Override
        @SuppressWarnings("deprecation")
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c) {
            // Pre Android 13 delivery path. On 13+ the byte[] overload above is called instead.
            if (Build.VERSION.SDK_INT < 33 && c != null && TX_UUID.equals(c.getUuid())) {
                byte[] v = c.getValue();
                appendRx(v != null ? v.clone() : null);
            }
        }
    }

    private SlapRFBleShim() {}

    public static void init(Context context) {
        if (context == null) {
            return;
        }
        Context app = context.getApplicationContext();
        appContext = app != null ? app : context;
    }

    /** Registered by SlapRFHost; invoked (once per need) when BLE permissions are missing. */
    public static void setPermissionRequester(Runnable r) {
        permissionRequester = r;
    }

    public static String getLastOpenError() {
        return lastOpenError;
    }

    static String[] requiredPermissions() {
        if (Build.VERSION.SDK_INT >= 31) {
            return new String[]{Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT};
        }
        return new String[]{Manifest.permission.ACCESS_FINE_LOCATION};
    }

    static boolean hasPermissions(Context ctx) {
        if (ctx == null) {
            return false;
        }
        for (String p : requiredPermissions()) {
            if (ctx.checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) {
                return false;
            }
        }
        return true;
    }

    private static boolean ensurePermissions(Context ctx) {
        if (hasPermissions(ctx)) {
            return true;
        }
        Runnable r = permissionRequester;
        long now = SystemClock.uptimeMillis();
        // Port lists refresh often; do not re-prompt more than once a minute after a denial.
        if (r != null && (lastPermissionPromptMs == 0L || now - lastPermissionPromptMs > 60000L)) {
            lastPermissionPromptMs = now;
            mainHandler.post(r);
        }
        return false;
    }

    private static BluetoothAdapter adapter(Context ctx) {
        BluetoothManager mgr = (BluetoothManager) ctx.getSystemService(Context.BLUETOOTH_SERVICE);
        if (mgr == null) {
            return null;
        }
        BluetoothAdapter a = mgr.getAdapter();
        if (a == null || !a.isEnabled()) {
            return null;
        }
        return a;
    }

    static String fingerprintFromRecord(ScanRecord rec) {
        if (rec == null) {
            return null;
        }
        byte[] md = rec.getManufacturerSpecificData(MANUFACTURER_ID);
        if (md == null || md.length < 7 || md[0] != 'S' || md[1] != 'R') {
            return null;
        }
        long fp = (md[2] & 0xFFL) | ((md[3] & 0xFFL) << 8) | ((md[4] & 0xFFL) << 16) | ((md[5] & 0xFFL) << 24);
        return String.format(Locale.US, "%08X", fp);
    }

    @SuppressLint("MissingPermission")
    private static void handleScanResult(ScanResult r) {
        if (r == null || r.getDevice() == null) {
            return;
        }
        ScanRecord rec = r.getScanRecord();
        String fp = fingerprintFromRecord(rec);
        if (fp == null) {
            return;
        }
        String name = rec != null ? rec.getDeviceName() : null;
        SeenHub prev = seen.get(fp);
        if ((name == null || name.trim().isEmpty()) && prev != null) {
            name = prev.name;
        }
        byte[] md = rec.getManufacturerSpecificData(MANUFACTURER_ID);
        int role = md != null && md.length > 6 ? (md[6] & 0xFF) : 0;
        boolean hasFlags = md != null && md.length >= 11;
        boolean paired = hasFlags && (md[10] & 0x01) != 0;
        seen.put(fp, new SeenHub(fp, r.getDevice(), name == null ? "" : name.trim(), role, hasFlags, paired, SystemClock.uptimeMillis()));
    }

    @SuppressLint("MissingPermission")
    private static boolean startScan(Context ctx, long windowMs) {
        synchronized (scanLock) {
            if (scanning) {
                return true;
            }
            BluetoothAdapter a = adapter(ctx);
            if (a == null) {
                return false;
            }
            BluetoothLeScanner scanner = a.getBluetoothLeScanner();
            if (scanner == null) {
                return false;
            }
            List<ScanFilter> filters = Collections.singletonList(
                    new ScanFilter.Builder().setServiceUuid(new ParcelUuid(SERVICE_UUID)).build());
            ScanSettings settings = new ScanSettings.Builder()
                    .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                    .build();
            final ScanCallback cb = new ScanCallback() {
                @Override
                public void onScanResult(int callbackType, ScanResult result) {
                    handleScanResult(result);
                }

                @Override
                public void onBatchScanResults(List<ScanResult> results) {
                    if (results != null) {
                        for (ScanResult r : results) {
                            handleScanResult(r);
                        }
                    }
                }

                @Override
                public void onScanFailed(int errorCode) {
                    synchronized (scanLock) {
                        if (activeScanCallback == this) {
                            activeScanCallback = null;
                            scanning = false;
                        }
                    }
                }
            };
            try {
                scanner.startScan(filters, settings, cb);
            } catch (Exception e) {
                return false;
            }
            activeScanCallback = cb;
            scanning = true;
            lastScanStartMs = SystemClock.uptimeMillis();
            mainHandler.postDelayed(() -> stopScan(cb), windowMs);
            return true;
        }
    }

    @SuppressLint("MissingPermission")
    private static void stopScan(ScanCallback only) {
        synchronized (scanLock) {
            ScanCallback cb = activeScanCallback;
            if (cb == null || (only != null && cb != only)) {
                return;
            }
            activeScanCallback = null;
            scanning = false;
            Context ctx = appContext;
            BluetoothAdapter a = ctx != null ? adapter(ctx) : null;
            if (a != null && a.getBluetoothLeScanner() != null) {
                try {
                    a.getBluetoothLeScanner().stopScan(cb);
                } catch (Exception ignored) {
                }
            }
        }
    }

    private static SeenHub freshSeen(String fp) {
        SeenHub s = seen.get(fp);
        if (s == null || SystemClock.uptimeMillis() - s.seenAtMs > SEEN_TTL_MS) {
            return null;
        }
        return s;
    }

    private static boolean hasFreshOrConnected() {
        for (Session s : sessions.values()) {
            if (!s.closed) {
                return true;
            }
        }
        long now = SystemClock.uptimeMillis();
        for (SeenHub s : seen.values()) {
            if (now - s.seenAtMs <= SEEN_TTL_MS) {
                return true;
            }
        }
        return false;
    }

    /** Lists discovered SlapRF Bluetooth hubs as {@code ble:<FP>} ports (same JSON shape as USB). */
    public static String listPortsJson() {
        Context ctx = appContext;
        if (ctx == null || adapterUnavailable(ctx)) {
            return "[]";
        }
        if (!ensurePermissions(ctx)) {
            return "[]";
        }
        boolean first = lastScanStartMs == 0L;
        boolean cold = !hasFreshOrConnected();
        long now = SystemClock.uptimeMillis();
        // Do not scan while a hub link is up: scanning steals radio time from 10 ms connection events.
        if (sessions.isEmpty()) {
            boolean scanningNow = scanning;
            if (first || cold || now - lastScanStartMs > SCAN_REFRESH_MS) {
                scanningNow = startScan(ctx, SCAN_WINDOW_MS) || scanning;
            }
            if (cold && scanningNow) {
                long until = SystemClock.uptimeMillis() + FIRST_LIST_WAIT_MS;
                while (SystemClock.uptimeMillis() < until && !hasFreshOrConnected()) {
                    SystemClock.sleep(100);
                }
            }
        }
        List<String> connected = new ArrayList<>();
        for (Session s : sessions.values()) {
            if (!s.closed) {
                connected.add(s.fp);
            }
        }
        JSONArray arr = new JSONArray();
        try {
            for (Map.Entry<String, SeenHub> e : seen.entrySet()) {
                SeenHub s = e.getValue();
                boolean isConnected = connected.contains(s.fp);
                if (!isConnected && SystemClock.uptimeMillis() - s.seenAtMs > SEEN_TTL_MS) {
                    continue;
                }
                String label = s.name == null || s.name.isEmpty() ? "SlapRF Hub" : s.name;
                String product = (!isConnected && s.hasFlags && !s.paired)
                        ? (label + " (Bluetooth \u00b7 Pairing mode)")
                        : (label + " (Bluetooth)");
                JSONObject obj = new JSONObject();
                obj.put("name", PORT_PREFIX + s.fp);
                obj.put("isUsb", false);
                obj.put("serialNumber", s.fp);
                obj.put("product", product);
                obj.put("isEspressif", true);
                obj.put("transport", "ble");
                arr.put(obj);
            }
        } catch (Exception ignored) {
        }
        return arr.toString();
    }

    private static boolean adapterUnavailable(Context ctx) {
        try {
            return adapter(ctx) == null;
        } catch (SecurityException se) {
            return true;
        }
    }

    /** Connects to {@code ble:<FP>} and returns a handle once TX notifications are enabled. */
    @SuppressLint("MissingPermission")
    public static int openPort(String portName, int baudRate) {
        lastOpenError = "";
        Context ctx = appContext;
        if (ctx == null) {
            lastOpenError = "Android application context not ready";
            return -1;
        }
        String name = portName == null ? "" : portName.trim();
        if (!name.toLowerCase(Locale.US).startsWith(PORT_PREFIX) || name.length() != PORT_PREFIX.length() + 8) {
            lastOpenError = "Invalid Bluetooth hub port " + name;
            return -1;
        }
        String fp = name.substring(PORT_PREFIX.length()).toUpperCase(Locale.US);
        if (!ensurePermissions(ctx)) {
            lastOpenError = "Bluetooth permission not granted (allow Nearby devices and retry)";
            return -1;
        }
        BluetoothAdapter a;
        try {
            a = adapter(ctx);
        } catch (SecurityException se) {
            a = null;
        }
        if (a == null) {
            lastOpenError = "Bluetooth is off or unavailable";
            return -1;
        }

        SeenHub hub = freshSeen(fp);
        if (hub == null) {
            long deadline = SystemClock.uptimeMillis() + OPEN_SCAN_TIMEOUT_MS;
            while (hub == null && SystemClock.uptimeMillis() < deadline) {
                if (!scanning) {
                    startScan(ctx, Math.max(500L, deadline - SystemClock.uptimeMillis()));
                }
                SystemClock.sleep(100);
                hub = freshSeen(fp);
            }
        }
        stopScan(null);
        if (hub == null) {
            lastOpenError = "Bluetooth hub " + fp + " not found (is it powered and advertising?)";
            return -1;
        }

        // Use the BluetoothDevice from the scan result so the LE address type (public or random)
        // is preserved; getRemoteDevice(String) would assume a public address.
        BluetoothDevice dev = hub.device;
        int handle = nextHandle.getAndIncrement();
        Session s = new Session(handle, fp);
        BluetoothGatt g;
        try {
            g = dev.connectGatt(ctx, false, s, BluetoothDevice.TRANSPORT_LE);
        } catch (SecurityException se) {
            lastOpenError = "Bluetooth connect permission denied";
            return -1;
        }
        if (g == null) {
            lastOpenError = "connectGatt returned null";
            return -1;
        }
        s.gatt = g;
        sessions.put(handle, s);
        boolean signalled;
        try {
            signalled = s.openLatch.await(CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
            signalled = false;
        }
        if (!signalled || !s.ready) {
            lastOpenError = s.failure != null ? s.failure : "Bluetooth connection timed out";
            closePort(handle);
            return -1;
        }
        return handle;
    }

    /** Blocks up to timeoutMs for notification bytes. Returns bytes copied, 0 on timeout, -1 on EOF. */
    public static int readPort(int handle, byte[] rxBuf, int maxLen, int timeoutMs) {
        Session s = sessions.get(handle);
        if (s == null || rxBuf == null || maxLen <= 0) {
            return -1;
        }
        int cap = Math.min(maxLen, rxBuf.length);
        long waitNs = TimeUnit.MILLISECONDS.toNanos(Math.max(15, timeoutMs));
        s.rxLock.lock();
        try {
            while (s.rxLen == 0) {
                if (s.closed || (s.failure != null && !s.ready)) {
                    return -1;
                }
                if (waitNs <= 0L) {
                    return 0;
                }
                try {
                    waitNs = s.rxAvail.awaitNanos(waitNs);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    return 0;
                }
            }
            int n = Math.min(cap, s.rxLen);
            int first = Math.min(n, s.rxBuf.length - s.rxHead);
            System.arraycopy(s.rxBuf, s.rxHead, rxBuf, 0, first);
            if (first < n) {
                System.arraycopy(s.rxBuf, 0, rxBuf, first, n - first);
            }
            s.rxHead = (s.rxHead + n) % s.rxBuf.length;
            s.rxLen -= n;
            return n;
        } finally {
            s.rxLock.unlock();
        }
    }

    /**
     * Writes len bytes to the hub RX characteristic as write-without-response chunks of at most
     * MTU - 3 bytes. Writes are serialized per session and each chunk waits for the stack's
     * onCharacteristicWrite before the next one so GATT operations never overlap.
     */
    @SuppressLint("MissingPermission")
    public static int writePort(int handle, byte[] txData, int len) {
        Session s = sessions.get(handle);
        if (s == null || s.closed || !s.ready || txData == null || len <= 0) {
            return -1;
        }
        BluetoothGatt g = s.gatt;
        BluetoothGattCharacteristic rx = s.rxChar;
        if (g == null || rx == null) {
            return -1;
        }
        int count = Math.min(len, txData.length);
        synchronized (s.writeLock) {
            int off = 0;
            while (off < count) {
                if (s.closed || !s.ready) {
                    return off > 0 ? off : -1;
                }
                int chunkMax = Math.max(20, s.mtu - 3);
                int n = Math.min(chunkMax, count - off);
                byte[] chunk = new byte[n];
                System.arraycopy(txData, off, chunk, 0, n);
                if (!writeChunk(s, g, rx, chunk)) {
                    return off > 0 ? off : -1;
                }
                off += n;
            }
            return count;
        }
    }

    @SuppressLint("MissingPermission")
    @SuppressWarnings("deprecation")
    private static boolean writeChunk(Session s, BluetoothGatt g, BluetoothGattCharacteristic rx, byte[] chunk) {
        // The stack rejects a write while another GATT op is pending; retry briefly on busy.
        long deadline = SystemClock.uptimeMillis() + GATT_OP_TIMEOUT_MS;
        while (SystemClock.uptimeMillis() < deadline && !s.closed) {
            s.beginOp();
            boolean started;
            try {
                if (Build.VERSION.SDK_INT >= 33) {
                    started = g.writeCharacteristic(rx, chunk, BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE)
                            == BluetoothGatt.GATT_SUCCESS;
                } else {
                    rx.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
                    rx.setValue(chunk);
                    started = g.writeCharacteristic(rx);
                }
            } catch (SecurityException se) {
                return false;
            }
            if (started) {
                return s.awaitOp(GATT_OP_TIMEOUT_MS);
            }
            SystemClock.sleep(5);
        }
        return false;
    }

    @SuppressWarnings("deprecation")
    @SuppressLint("MissingPermission")
    private static boolean legacyWriteDescriptor(BluetoothGatt g, BluetoothGattDescriptor d, byte[] value) {
        d.setValue(value);
        return g.writeDescriptor(d);
    }

    /** Bluetooth links have no modem control lines; accepted as a no-op for API parity. */
    public static int setDtrRts(int handle, boolean dtr, boolean rts) {
        Session s = sessions.get(handle);
        return s == null || s.closed ? -1 : 0;
    }

    public static void closePort(int handle) {
        Session s = sessions.remove(handle);
        if (s == null) {
            return;
        }
        s.closed = true;
        s.ready = false;
        s.completeOp(-1);
        s.openLatch.countDown();
        s.wakeReaders();
        closeGattQuietly(s);
    }

    @SuppressLint("MissingPermission")
    private static void closeGattQuietly(Session s) {
        BluetoothGatt g = s.gatt;
        s.gatt = null;
        if (g == null) {
            return;
        }
        try {
            g.disconnect();
        } catch (Exception ignored) {
        }
        try {
            g.close();
        } catch (Exception ignored) {
        }
    }
}
