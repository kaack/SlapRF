package app.slaprf;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.os.Build;

import com.hoho.android.usbserial.driver.CdcAcmSerialDriver;
import com.hoho.android.usbserial.driver.UsbSerialDriver;
import com.hoho.android.usbserial.driver.UsbSerialPort;
import com.hoho.android.usbserial.driver.UsbSerialProber;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Thin USB serial byte-stream shim backed strictly by Android's official public
 * {@link android.hardware.usb.UsbManager} / {@link android.hardware.usb.UsbDeviceConnection}
 * APIs and pure-Java {@code usb-serial-for-android}.
 *
 * All SlapRF protocol framing, SLAPRF02 parsing, watchdogs, and reconnect state machines
 * live in Go (internal/usb).
 */
public final class SlapRFUsbShim {
    private static final int ESPRESSIF_VID = 0x303A;
    private static final int USB_RT_ACM = 0x21; // Host-to-device | Class | Interface
    private static final int USB_REQ_SET_CONTROL_LINE_STATE = 0x22;

    private static volatile Context appContext;
    private static final AtomicBoolean receiverRegistered = new AtomicBoolean(false);
    private static final AtomicInteger nextHandle = new AtomicInteger(1);
    private static final AtomicInteger nextPermSeq = new AtomicInteger(1);
    private static final ConcurrentHashMap<Integer, PortSession> sessions = new ConcurrentHashMap<>();
    private static final ConcurrentHashMap<String, String> lastSerialByPath = new ConcurrentHashMap<>();
    private static volatile String lastOpenError = "";

    private static final class PortSession {
        final int handle;
        final String deviceName;
        final UsbDevice device;
        final UsbDeviceConnection connection;
        final UsbSerialPort port;
        final boolean isCdcAcm;
        final int ctrlInterfaceId;
        final Object writeLock = new Object();
        volatile boolean closed = false;

        PortSession(
                int handle,
                String deviceName,
                UsbDevice device,
                UsbDeviceConnection connection,
                UsbSerialPort port,
                boolean isCdcAcm,
                int ctrlInterfaceId) {
            this.handle = handle;
            this.deviceName = deviceName;
            this.device = device;
            this.connection = connection;
            this.port = port;
            this.isCdcAcm = isCdcAcm;
            this.ctrlInterfaceId = ctrlInterfaceId;
        }
    }

    private SlapRFUsbShim() {}

    public static void init(Context context) {
        if (context == null) {
            return;
        }
        Context app = context.getApplicationContext();
        appContext = app != null ? app : context;
        if (receiverRegistered.compareAndSet(false, true)) {
            IntentFilter detachFilter = new IntentFilter(UsbManager.ACTION_USB_DEVICE_DETACHED);
            BroadcastReceiver detachReceiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context ctx, Intent intent) {
                    if (intent == null || !UsbManager.ACTION_USB_DEVICE_DETACHED.equals(intent.getAction())) {
                        return;
                    }
                    UsbDevice detached = extractUsbDevice(intent);
                    if (detached == null) {
                        return;
                    }
                    String devName = detached.getDeviceName();
                    for (PortSession s : sessions.values()) {
                        if (s.deviceName.equals(devName)) {
                            closePort(s.handle);
                        }
                    }
                }
            };
            if (Build.VERSION.SDK_INT >= 33) {
                appContext.registerReceiver(detachReceiver, detachFilter, Context.RECEIVER_NOT_EXPORTED);
            } else {
                appContext.registerReceiver(detachReceiver, detachFilter);
            }
        }
    }

    @SuppressWarnings("deprecation")
    private static UsbDevice extractUsbDevice(Intent intent) {
        if (Build.VERSION.SDK_INT >= 33) {
            return intent.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice.class);
        }
        return intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
    }

    private static UsbSerialDriver resolveDriver(UsbDevice dev) {
        if (dev == null) {
            return null;
        }
        UsbSerialDriver drv = UsbSerialProber.getDefaultProber().probeDevice(dev);
        if (drv == null && (dev.getVendorId() == ESPRESSIF_VID || CdcAcmSerialDriver.probe(dev))) {
            drv = new CdcAcmSerialDriver(dev);
        }
        return drv;
    }

    private static int findCdcControlInterfaceId(UsbDevice dev) {
        if (dev == null) {
            return -1;
        }
        int count = dev.getInterfaceCount();
        for (int i = 0; i < count; i++) {
            UsbInterface intf = dev.getInterface(i);
            if (intf != null && intf.getInterfaceClass() == UsbConstants.USB_CLASS_COMM) {
                return intf.getId();
            }
        }
        return count > 0 ? dev.getInterface(0).getId() : -1;
    }

    public static String getLastOpenError() {
        return lastOpenError;
    }

    public static String listPortsJson() {
        Context ctx = appContext;
        if (ctx == null) {
            return "[]";
        }
        UsbManager usbMgr = (UsbManager) ctx.getSystemService(Context.USB_SERVICE);
        if (usbMgr == null) {
            return "[]";
        }
        JSONArray arr = new JSONArray();
        try {
            Map<String, UsbDevice> devList = usbMgr.getDeviceList();
            if (devList == null || devList.isEmpty()) {
                return "[]";
            }
            for (UsbDevice dev : devList.values()) {
                UsbSerialDriver drv = resolveDriver(dev);
                if (drv == null) {
                    continue;
                }
                List<UsbSerialPort> ports = drv.getPorts();
                int portCount = (ports != null && !ports.isEmpty()) ? ports.size() : 1;
                int vidNum = dev.getVendorId();
                int pidNum = dev.getProductId();
                boolean isEsp = (vidNum == ESPRESSIF_VID);
                String vidHex = String.format(Locale.US, "%04X", vidNum);
                String pidHex = String.format(Locale.US, "%04X", pidNum);

                String prod = "";
                try {
                    if (dev.getProductName() != null) {
                        prod = dev.getProductName().trim();
                    }
                } catch (Exception ignored) {
                }
                if (isEsp && (prod.isEmpty() || prod.toLowerCase(Locale.US).startsWith("usb jtag") || prod.toLowerCase(Locale.US).contains("seeed xiao") || prod.toLowerCase(Locale.US).contains("esp32-c5"))) {
                    prod = "ESP32-C5";
                }

                String serial = "";
                if (usbMgr.hasPermission(dev)) {
                    try {
                        if (dev.getSerialNumber() != null) {
                            serial = dev.getSerialNumber().trim();
                        }
                    } catch (SecurityException ignored) {
                    }
                }
                if (isEsp && !serial.isEmpty()) {
                    lastSerialByPath.put(dev.getDeviceName(), serial);
                }

                for (int pIdx = 0; pIdx < portCount; pIdx++) {
                    String portName = pIdx == 0 ? dev.getDeviceName() : (dev.getDeviceName() + "#" + pIdx);
                    JSONObject obj = new JSONObject();
                    obj.put("name", portName);
                    obj.put("isUsb", true);
                    obj.put("vid", vidHex);
                    obj.put("pid", pidHex);
                    if (!serial.isEmpty()) {
                        obj.put("serialNumber", serial);
                    }
                    if (!prod.isEmpty()) {
                        obj.put("product", portCount > 1 ? (prod + " #" + (pIdx + 1)) : prod);
                    }
                    obj.put("isEspressif", isEsp);
                    arr.put(obj);
                }
            }
        } catch (Exception ignored) {
        }
        return arr.toString();
    }

    public static int openPort(String portName, int baudRate) {
        lastOpenError = "";
        Context ctx = appContext;
        if (ctx == null) {
            lastOpenError = "Android application context not ready";
            return -1;
        }
        if (portName == null || portName.trim().isEmpty()) {
            lastOpenError = "Missing USB port name";
            return -1;
        }
        UsbManager usbMgr = (UsbManager) ctx.getSystemService(Context.USB_SERVICE);
        if (usbMgr == null) {
            lastOpenError = "Android UsbManager unavailable";
            return -1;
        }

        String rawDevName = portName.trim();
        int portIdx = 0;
        int hashPos = rawDevName.indexOf('#');
        if (hashPos > 0) {
            try {
                portIdx = Integer.parseInt(rawDevName.substring(hashPos + 1));
            } catch (NumberFormatException ignored) {
                portIdx = 0;
            }
            rawDevName = rawDevName.substring(0, hashPos);
        }

        Map<String, UsbDevice> devList = usbMgr.getDeviceList();
        UsbDevice targetDev = devList != null ? devList.get(rawDevName) : null;
        if (targetDev == null && devList != null) {
            for (UsbDevice candidate : devList.values()) {
                if (rawDevName.equals(candidate.getDeviceName())) {
                    targetDev = candidate;
                    break;
                }
            }
        }
        // When an ESP32-C5 reboots over USB-C OTG (e.g. during flashing or post-flash verification),
        // Android/Linux increments /dev/bus/usb/001/<devnum>. Match by hardware eFuse MAC serial first,
        // or fall back to the sole unopened Espressif (0x303A) device attached to the phone.
        if (targetDev == null && devList != null) {
            String knownSerial = lastSerialByPath.get(rawDevName);
            if (knownSerial != null && !knownSerial.isEmpty()) {
                for (UsbDevice candidate : devList.values()) {
                    if (candidate.getVendorId() == ESPRESSIF_VID && usbMgr.hasPermission(candidate)) {
                        try {
                            String candSerial = candidate.getSerialNumber();
                            if (candSerial != null && knownSerial.equalsIgnoreCase(candSerial.trim())) {
                                targetDev = candidate;
                                break;
                            }
                        } catch (SecurityException ignored) {
                        }
                    }
                }
            }
            if (targetDev == null && ("auto:espressif".equalsIgnoreCase(rawDevName) || rawDevName.startsWith("/dev/bus/usb/"))) {
                UsbDevice soleEsp = null;
                int espCount = 0;
                for (UsbDevice candidate : devList.values()) {
                    if (candidate.getVendorId() != ESPRESSIF_VID) {
                        continue;
                    }
                    boolean alreadyOpen = false;
                    for (PortSession s : sessions.values()) {
                        if (!s.closed && s.deviceName.equals(candidate.getDeviceName())) {
                            alreadyOpen = true;
                            break;
                        }
                    }
                    if (!alreadyOpen) {
                        soleEsp = candidate;
                        espCount++;
                    }
                }
                if (espCount == 1) {
                    targetDev = soleEsp;
                }
            }
        }
        if (targetDev == null) {
            lastOpenError = "USB device not found: " + rawDevName;
            return -1;
        }

        if (!usbMgr.hasPermission(targetDev)) {
            boolean granted = requestPermissionBlocking(ctx, usbMgr, targetDev, 30_000L);
            if (!granted) {
                lastOpenError = "USB permission denied by user";
                return -1;
            }
        }
        if (targetDev.getVendorId() == ESPRESSIF_VID) {
            try {
                String ser = targetDev.getSerialNumber();
                if (ser != null && !ser.trim().isEmpty()) {
                    lastSerialByPath.put(targetDev.getDeviceName(), ser.trim());
                    lastSerialByPath.put(rawDevName, ser.trim());
                }
            } catch (SecurityException ignored) {
            }
        }

        UsbSerialDriver drv = resolveDriver(targetDev);
        if (drv == null || drv.getPorts() == null || drv.getPorts().isEmpty()) {
            lastOpenError = "Unsupported USB serial device";
            return -1;
        }
        if (portIdx < 0 || portIdx >= drv.getPorts().size()) {
            portIdx = 0;
        }
        UsbSerialPort serialPort = drv.getPorts().get(portIdx);

        UsbDeviceConnection conn = usbMgr.openDevice(targetDev);
        if (conn == null) {
            lastOpenError = "UsbManager.openDevice returned null";
            return -1;
        }

        int baud = baudRate > 0 ? baudRate : 115200;
        try {
            serialPort.open(conn);
            serialPort.setParameters(baud, UsbSerialPort.DATABITS_8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE);
        } catch (Exception e) {
            try {
                serialPort.close();
            } catch (Exception ignored) {
            }
            try {
                conn.close();
            } catch (Exception ignored) {
            }
            lastOpenError = "Failed to initialize USB serial port: " + e.getMessage();
            return -1;
        }

        boolean isCdc = (drv instanceof CdcAcmSerialDriver);
        int ctrlIfId = isCdc ? findCdcControlInterfaceId(targetDev) : -1;
        int handle = nextHandle.getAndIncrement();
        PortSession session = new PortSession(handle, targetDev.getDeviceName(), targetDev, conn, serialPort, isCdc, ctrlIfId);
        sessions.put(handle, session);
        return handle;
    }

    private static boolean requestPermissionBlocking(Context ctx, UsbManager usbMgr, UsbDevice dev, long timeoutMs) {
        final String action = ctx.getPackageName() + ".USB_PERMISSION." + nextPermSeq.getAndIncrement();
        final CountDownLatch latch = new CountDownLatch(1);
        final AtomicBoolean granted = new AtomicBoolean(false);

        BroadcastReceiver permReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context c, Intent intent) {
                if (intent != null && action.equals(intent.getAction())) {
                    boolean ok = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false) || usbMgr.hasPermission(dev);
                    granted.set(ok);
                    latch.countDown();
                }
            }
        };

        IntentFilter filter = new IntentFilter(action);
        if (Build.VERSION.SDK_INT >= 33) {
            ctx.registerReceiver(permReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            ctx.registerReceiver(permReceiver, filter);
        }

        try {
            Intent permIntent = new Intent(action);
            permIntent.setPackage(ctx.getPackageName());
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= 31) {
                flags |= PendingIntent.FLAG_MUTABLE;
            }
            PendingIntent pi = PendingIntent.getBroadcast(ctx, 0, permIntent, flags);
            usbMgr.requestPermission(dev, pi);
            latch.await(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
        } catch (Exception ignored) {
        } finally {
            try {
                ctx.unregisterReceiver(permReceiver);
            } catch (Exception ignored) {
            }
        }
        return granted.get() || usbMgr.hasPermission(dev);
    }

    public static int readPort(int handle, byte[] rxBuf, int maxLen, int timeoutMs) {
        PortSession s = sessions.get(handle);
        if (s == null || s.closed || rxBuf == null || maxLen <= 0) {
            return -1;
        }
        int cap = Math.min(maxLen, rxBuf.length);
        int tmo = Math.max(15, timeoutMs);
        try {
            return s.port.read(rxBuf, cap, tmo);
        } catch (IOException | RuntimeException e) {
            if (s.closed) {
                return -1;
            }
            closePort(handle);
            return -1;
        }
    }

    public static int writePort(int handle, byte[] txData, int len) {
        PortSession s = sessions.get(handle);
        if (s == null || s.closed || txData == null || len <= 0) {
            return -1;
        }
        int count = Math.min(len, txData.length);
        try {
            synchronized (s.writeLock) {
                s.port.write(txData, count, 5000);
            }
            return count;
        } catch (IOException | RuntimeException e) {
            if (!s.closed) {
                closePort(handle);
            }
            return -1;
        }
    }

    public static int setDtrRts(int handle, boolean dtr, boolean rts) {
        PortSession s = sessions.get(handle);
        if (s == null || s.closed) {
            return -1;
        }
        try {
            synchronized (s.writeLock) {
                if (s.isCdcAcm && s.ctrlInterfaceId >= 0) {
                    int lineMask = (rts ? 0x02 : 0x00) | (dtr ? 0x01 : 0x00);
                    int rc = s.connection.controlTransfer(
                            USB_RT_ACM,
                            USB_REQ_SET_CONTROL_LINE_STATE,
                            lineMask,
                            s.ctrlInterfaceId,
                            null,
                            0,
                            500);
                    return rc >= 0 ? 0 : -1;
                }
                s.port.setRTS(rts);
                s.port.setDTR(dtr);
                return 0;
            }
        } catch (IOException | RuntimeException e) {
            return -1;
        }
    }

    public static void closePort(int handle) {
        PortSession s = sessions.remove(handle);
        if (s == null) {
            return;
        }
        s.closed = true;
        try {
            s.port.close();
        } catch (Exception ignored) {
        }
        try {
            s.connection.close();
        } catch (Exception ignored) {
        }
    }
}
