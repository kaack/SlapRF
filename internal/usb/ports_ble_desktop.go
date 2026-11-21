//go:build !android && !nobluetooth && (windows || linux || (darwin && cgo))

package usb

import (
	"errors"
	"fmt"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"

	"tinygo.org/x/bluetooth"

	"slaprf/internal/firmware"
)

// Desktop Bluetooth LE backend for SlapRF hubs (tinygo.org/x/bluetooth):
//   - Windows: WinRT (no cgo).
//   - Linux: BlueZ over D-Bus (no cgo).
//   - macOS: CoreBluetooth (requires cgo; CGO_ENABLED=0 builds use the stub).
// Set SLAPRF_NO_BLE=1 to disable Bluetooth discovery entirely.

const (
	bleScanWindow       = 4 * time.Second
	bleScanRefreshEvery = 8 * time.Second
	bleSeenTTL          = 30 * time.Second
	bleFirstListWait    = 1500 * time.Millisecond
	bleOpenScanTimeout  = 8 * time.Second
	bleConnectTimeout   = 8 * time.Second
	bleEnableRetryAfter = 30 * time.Second
)

type bleSeenHub struct {
	addr bluetooth.Address
	name string
	info BLEAdvertInfo
	at   time.Time
}

type bleDesktopConn struct {
	fp   string
	dev  bluetooth.Device
	rx   bluetooth.DeviceCharacteristic
	tx   bluetooth.DeviceCharacteristic
	port *BLEStreamPort

	mu      sync.Mutex
	payload int
	closed  bool
}

func (c *bleDesktopConn) WriteWithoutResponse(p []byte) error {
	_, err := c.rx.WriteWithoutResponse(p)
	return err
}

func (c *bleDesktopConn) MaxWriteLen() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	// The ATT MTU exchange can finish after the link is up, so refresh it on every write.
	if mtu, err := c.rx.GetMTU(); err == nil && mtu > 0 {
		if runtime.GOOS == "darwin" {
			// CoreBluetooth reports the maximum write length (already ATT_MTU - 3).
			c.payload = BLEWritePayloadForMTU(int(mtu) + 3)
		} else {
			c.payload = BLEWritePayloadForMTU(int(mtu))
		}
	}
	if c.payload <= 0 {
		c.payload = BLEMinWritePayload
	}
	return c.payload
}

func (c *bleDesktopConn) Close() error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil
	}
	c.closed = true
	c.mu.Unlock()
	bleHost.unregister(c)
	if runtime.GOOS == "linux" {
		// Release the BlueZ D-Bus PropertiesChanged signal channel and goroutine started by EnableNotifications.
		_ = c.tx.EnableNotifications(nil)
	}
	return c.dev.Disconnect()
}

type bleDesktopHost struct {
	mu            sync.Mutex
	adapter       *bluetooth.Adapter
	enabled       bool
	enableErr     error
	enableAt      time.Time
	seen          map[string]bleSeenHub // key: fingerprint hex
	scanning      bool
	scanDone      chan struct{}
	stopScanFn    func()
	lastScanStart time.Time
	opening       int
	conns         map[string]*bleDesktopConn // key: address string

	svcUUID, rxUUID, txUUID bluetooth.UUID
}

var bleHost = &bleDesktopHost{
	seen:  make(map[string]bleSeenHub),
	conns: make(map[string]*bleDesktopConn),
}

func bleDisabledByEnv() bool {
	v := strings.TrimSpace(strings.ToLower(os.Getenv("SLAPRF_NO_BLE")))
	return v != "" && v != "0" && v != "false"
}

func (h *bleDesktopHost) ensureEnabled() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.enabled {
		return nil
	}
	if h.enableErr != nil && time.Since(h.enableAt) < bleEnableRetryAfter {
		return h.enableErr
	}
	h.enableAt = time.Now()
	var err error
	if h.svcUUID, err = bluetooth.ParseUUID(BLEServiceUUID); err != nil {
		h.enableErr = err
		return err
	}
	h.rxUUID, _ = bluetooth.ParseUUID(BLERxCharUUID)
	h.txUUID, _ = bluetooth.ParseUUID(BLETxCharUUID)
	adapter := selectBLEAdapter()
	if err = adapter.Enable(); err != nil {
		h.enableErr = fmt.Errorf("Bluetooth adapter unavailable: %w", err)
		return h.enableErr
	}
	h.adapter = adapter
	h.adapter.SetConnectionStateHandler(h.onConnectionState)
	h.enabled = true
	h.enableErr = nil
	return nil
}

func (h *bleDesktopHost) onConnectionState(d bluetooth.Device, st bluetooth.ConnectionState) {
	if st.Connected {
		return
	}
	h.mu.Lock()
	c := h.conns[d.Address.String()]
	delete(h.conns, d.Address.String())
	h.mu.Unlock()
	if c != nil && c.port != nil {
		err := st.Err
		if err == nil {
			err = errors.New("Bluetooth hub disconnected")
		}
		c.port.Disconnected(err)
	}
}

func (h *bleDesktopHost) unregister(c *bleDesktopConn) {
	h.mu.Lock()
	key := c.dev.Address.String()
	if h.conns[key] == c {
		delete(h.conns, key)
	}
	h.mu.Unlock()
}

func (h *bleDesktopHost) onScanResult(_ *bluetooth.Adapter, r bluetooth.ScanResult) {
	if r.AdvertisementPayload == nil {
		return
	}
	for _, md := range r.ManufacturerData() {
		info, ok := ParseBLEManufacturerData(md.CompanyID, md.Data)
		if !ok {
			continue
		}
		// Manufacturer data with the SR signature is SlapRF specific; the service UUID check is a
		// second filter when the platform delivered the advertising packet too.
		if svc := r.ServiceUUIDs(); len(svc) > 0 && !r.HasServiceUUID(h.svcUUID) {
			return
		}
		fp := info.FingerprintHex()
		h.mu.Lock()
		prev := h.seen[fp]
		name := strings.TrimSpace(r.LocalName())
		if name == "" {
			name = prev.name
		}
		h.seen[fp] = bleSeenHub{addr: r.Address, name: name, info: info, at: time.Now()}
		h.mu.Unlock()
		return
	}
}

// startScanLocked begins a scan of `window` if none is running and returns its done channel.
func (h *bleDesktopHost) startScanLocked(window time.Duration) chan struct{} {
	if h.scanning {
		return h.scanDone
	}
	h.scanning = true
	done := make(chan struct{})
	h.scanDone = done
	h.lastScanStart = time.Now()
	var stopOnce sync.Once
	stopFn := func() {
		stopOnce.Do(func() {
			_ = h.adapter.StopScan()
		})
	}
	h.stopScanFn = stopFn
	stopTimer := time.AfterFunc(window, stopFn)
	go func() {
		_ = h.adapter.Scan(h.onScanResult)
		stopTimer.Stop()
		h.mu.Lock()
		h.scanning = false
		h.stopScanFn = nil
		h.mu.Unlock()
		close(done)
	}()
	return done
}

// stopScan stops a running scan and waits briefly for it to finish (connecting while scanning
// is unreliable on several stacks). Returns true when an active scan was stopped.
func (h *bleDesktopHost) stopScan() bool {
	h.mu.Lock()
	scanning, done, stopFn := h.scanning, h.scanDone, h.stopScanFn
	h.mu.Unlock()
	if !scanning || done == nil {
		return false
	}
	if stopFn != nil {
		stopFn()
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
	}
	return true
}

func (h *bleDesktopHost) hasFreshOrConnectedLocked() bool {
	if len(h.conns) > 0 {
		return true
	}
	for _, s := range h.seen {
		if time.Since(s.at) <= bleSeenTTL {
			return true
		}
	}
	return false
}

func (h *bleDesktopHost) lookup(fp string) (bleSeenHub, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	s, ok := h.seen[fp]
	if !ok || time.Since(s.at) > bleSeenTTL {
		return bleSeenHub{}, false
	}
	return s, true
}

func bleListPorts() ([]PortInfo, error) {
	if bleDisabledByEnv() {
		return nil, nil
	}
	h := bleHost
	if err := h.ensureEnabled(); err != nil {
		return nil, nil
	}
	h.mu.Lock()
	first := h.lastScanStart.IsZero()
	cold := !h.hasFreshOrConnectedLocked()
	var waitCh chan struct{}
	// Avoid scanning while a hub link is up or opening: scanning steals radio time from the
	// 10 ms connection events that carry the RSSI stream.
	if len(h.conns) == 0 && h.opening == 0 {
		if first || cold || time.Since(h.lastScanStart) > bleScanRefreshEvery {
			waitCh = h.startScanLocked(bleScanWindow)
		} else if h.scanning {
			waitCh = h.scanDone
		}
	}
	h.mu.Unlock()
	if cold && waitCh != nil {
		deadline := time.Now().Add(bleFirstListWait)
		for time.Now().Before(deadline) {
			h.mu.Lock()
			warm := h.hasFreshOrConnectedLocked()
			h.mu.Unlock()
			if warm {
				break
			}
			select {
			case <-waitCh:
				deadline = time.Time{}
			case <-time.After(100 * time.Millisecond):
			}
		}
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	connectedFP := make(map[string]bool, len(h.conns))
	for _, c := range h.conns {
		connectedFP[c.fp] = true
	}
	out := make([]PortInfo, 0, len(h.seen))
	for fp, s := range h.seen {
		// A connected hub stops advertising, so keep listing it while its link is up.
		if !connectedFP[fp] && time.Since(s.at) > bleSeenTTL {
			continue
		}
		info := s.info
		if connectedFP[fp] {
			info.Paired = true
		}
		out = append(out, BLEPortInfoFor(info, s.name))
	}
	return out, nil
}

func bleOpenPort(portName string, _ int) (firmware.SerialPort, error) {
	if bleDisabledByEnv() {
		return nil, errors.New("Bluetooth disabled by SLAPRF_NO_BLE")
	}
	fp, ok := ParseBLEPortName(portName)
	if !ok {
		return nil, fmt.Errorf("invalid Bluetooth hub port %q (expected ble:<8 hex fingerprint>)", portName)
	}
	h := bleHost
	if err := h.ensureEnabled(); err != nil {
		return nil, err
	}
	h.mu.Lock()
	h.opening++
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		h.opening--
		h.mu.Unlock()
	}()

	seen, found := h.lookup(fp)
	if !found {
		deadline := time.Now().Add(bleOpenScanTimeout)
		h.mu.Lock()
		done := h.startScanLocked(bleOpenScanTimeout)
		h.mu.Unlock()
		for !found && time.Now().Before(deadline) {
			select {
			case <-done:
				// The scan window ended (or failed to start); pause briefly before retrying so
				// a radio that is off does not cause a busy loop.
				time.Sleep(250 * time.Millisecond)
				h.mu.Lock()
				if rem := time.Until(deadline); rem > 0 {
					done = h.startScanLocked(rem)
				}
				h.mu.Unlock()
			case <-time.After(100 * time.Millisecond):
			}
			seen, found = h.lookup(fp)
		}
	}
	if h.stopScan() {
		// WinRT's advertisement watcher transitions asynchronously to Stopped; opening a GATT
		// session in the same millisecond can return Unreachable (code 1) before radio handoff.
		time.Sleep(150 * time.Millisecond)
	}
	if !found {
		return nil, fmt.Errorf("Bluetooth hub %s not found (is it powered and advertising?)", fp)
	}

	// Do not force a connection interval or priority: the hub requests 10 ms (falling back to
	// 20 or 30 ms) right after connect so its connection events line up with the 100 Hz sweep
	// schedule; the host just accepts that update.
	var (
		dev  bluetooth.Device
		svcs []bluetooth.DeviceService
		err  error
	)
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			time.Sleep(300 * time.Millisecond)
		}
		dev, err = h.adapter.Connect(seen.addr, bluetooth.ConnectionParams{
			ConnectionTimeout: bluetooth.NewDuration(bleConnectTimeout),
		})
		if err != nil {
			continue
		}
		svcs, err = dev.DiscoverServices([]bluetooth.UUID{h.svcUUID})
		if err == nil && len(svcs) > 0 {
			break
		}
		_ = dev.Disconnect()
	}
	if err != nil {
		return nil, fmt.Errorf("Bluetooth hub %s service discovery failed: %w", fp, err)
	}
	fail := func(stage string, err error) (firmware.SerialPort, error) {
		_ = dev.Disconnect()
		return nil, fmt.Errorf("Bluetooth hub %s %s: %w", fp, stage, err)
	}
	if len(svcs) == 0 {
		return fail("service discovery failed", errors.New("SlapRF Hub service not found"))
	}
	chars, err := svcs[0].DiscoverCharacteristics([]bluetooth.UUID{h.rxUUID, h.txUUID})
	if err != nil {
		return fail("characteristic discovery failed", err)
	}
	var rx, tx *bluetooth.DeviceCharacteristic
	for i := range chars {
		switch chars[i].UUID() {
		case h.rxUUID:
			rx = &chars[i]
		case h.txUUID:
			tx = &chars[i]
		}
	}
	if rx == nil || tx == nil {
		return fail("characteristic discovery failed", errors.New("RX/TX characteristics missing"))
	}

	conn := &bleDesktopConn{fp: fp, dev: dev, rx: *rx, tx: *tx}
	port := NewBLEStreamPort(conn)
	conn.port = port
	h.mu.Lock()
	h.conns[dev.Address.String()] = conn
	h.mu.Unlock()

	// Notifications must be live before the first command (STATUS?) is written.
	if err := conn.tx.EnableNotifications(func(buf []byte) { port.Deliver(buf) }); err != nil {
		h.unregister(conn)
		return fail("enabling notifications failed", err)
	}
	_ = conn.MaxWriteLen()
	return port, nil
}
