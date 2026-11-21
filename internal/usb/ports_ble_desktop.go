//go:build !android && !nobluetooth && (windows || linux || (darwin && cgo))

package usb

import (
	"errors"
	"fmt"
	"hash/fnv"
	"os"
	"runtime"
	"strconv"
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
	addr       bluetooth.Address
	name       string
	info       BLEAdvertInfo
	hasMfgData bool
	at         time.Time
}

type bleDesktopConn struct {
	fp     string
	dev    bluetooth.Device
	rx     bluetooth.DeviceCharacteristic
	tx     bluetooth.DeviceCharacteristic
	port   *BLEStreamPort
	stopCh chan struct{}

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

func (c *bleDesktopConn) NoteConnectedFingerprint(fpHex string) {
	fp, ok := ParseBLEPortName(BLEPortPrefix + fpHex)
	if !ok {
		return
	}
	v, err := strconv.ParseUint(fp, 16, 32)
	if err != nil {
		return
	}
	bleHost.noteResolvedFP(c, fp, uint32(v))
}

func (c *bleDesktopConn) Close() error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil
	}
	c.closed = true
	stopCh := c.stopCh
	c.stopCh = nil
	c.mu.Unlock()
	if stopCh != nil {
		close(stopCh)
	}
	bleHost.unregister(c)
	if runtime.GOOS == "linux" {
		// Release the BlueZ D-Bus PropertiesChanged signal channel and goroutine started by EnableNotifications.
		_ = c.tx.EnableNotifications(nil)
	}
	return c.dev.Disconnect()
}

type bleDesktopHost struct {
	openMu        sync.Mutex
	mu            sync.Mutex
	adapter       *bluetooth.Adapter
	adapterID     string
	enabled       bool
	enableErr     error
	enableAt      time.Time
	seen          map[string]bleSeenHub // key: fingerprint hex
	addrFP        map[string]string     // key: upper-case address -> resolved 8-hex fingerprint
	scanning      bool
	scanDone      chan struct{}
	stopScanFn    func()
	lastScanStart time.Time
	opening       int
	conns         map[string]*bleDesktopConn // key: address string

	svcUUID, rxUUID, txUUID bluetooth.UUID
}

var bleHost = &bleDesktopHost{
	seen:   make(map[string]bleSeenHub),
	addrFP: make(map[string]string),
	conns:  make(map[string]*bleDesktopConn),
}

func bleDisabledByEnv() bool {
	v := strings.TrimSpace(strings.ToLower(os.Getenv("SLAPRF_NO_BLE")))
	return v != "" && v != "0" && v != "false"
}

func (h *bleDesktopHost) ensureEnabled() error {
	h.mu.Lock()
	if h.enabled {
		adapterID := h.adapterID
		h.mu.Unlock()
		return ensureBLEAdapterPowered(adapterID)
	}
	if h.enableErr != nil && time.Since(h.enableAt) < bleEnableRetryAfter {
		err := h.enableErr
		h.mu.Unlock()
		return err
	}
	h.enableAt = time.Now()
	svcUUID, err := bluetooth.ParseUUID(BLEServiceUUID)
	if err != nil {
		h.enableErr = err
		h.mu.Unlock()
		return err
	}
	rxUUID, _ := bluetooth.ParseUUID(BLERxCharUUID)
	txUUID, _ := bluetooth.ParseUUID(BLETxCharUUID)
	h.mu.Unlock()

	adapter, adapterID := selectBLEAdapter()
	if pErr := ensureBLEAdapterPowered(adapterID); pErr != nil {
		h.mu.Lock()
		h.enableErr = pErr
		h.mu.Unlock()
		return pErr
	}
	if err = adapter.Enable(); err != nil {
		wrapped := fmt.Errorf("Bluetooth adapter unavailable: %w", err)
		h.mu.Lock()
		h.enableErr = wrapped
		h.mu.Unlock()
		return wrapped
	}

	h.mu.Lock()
	if !h.enabled {
		h.svcUUID = svcUUID
		h.rxUUID = rxUUID
		h.txUUID = txUUID
		h.adapter = adapter
		h.adapterID = adapterID
		h.adapter.SetConnectionStateHandler(h.onConnectionState)
		h.enabled = true
		h.enableErr = nil
	}
	h.mu.Unlock()
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

func bleFallbackFPFromAddress(addrKey string) uint32 {
	h := fnv.New32a()
	_, _ = h.Write([]byte(addrKey))
	v := h.Sum32()
	if v == 0 {
		return 1
	}
	return v
}

func (h *bleDesktopHost) dedupeSeenByAddrLocked(keepFP, addrKey string) {
	if addrKey == "" {
		return
	}
	for k, existing := range h.seen {
		if k != keepFP && strings.EqualFold(strings.TrimSpace(existing.addr.String()), addrKey) {
			delete(h.seen, k)
		}
	}
}

func (h *bleDesktopHost) noteResolvedFP(c *bleDesktopConn, fp string, fpVal uint32) {
	h.mu.Lock()
	defer h.mu.Unlock()
	addrKey := strings.ToUpper(strings.TrimSpace(c.dev.Address.String()))
	oldFP := c.fp
	c.fp = fp
	if addrKey != "" {
		h.dedupeSeenByAddrLocked(fp, addrKey)
		h.addrFP[addrKey] = fp
	}
	var base bleSeenHub
	if s, ok := h.seen[fp]; ok {
		base = s
	} else if oldFP != "" {
		if s, ok := h.seen[oldFP]; ok {
			base = s
		}
		if oldFP != fp {
			delete(h.seen, oldFP)
		}
	}
	base.addr = c.dev.Address
	base.info.Fingerprint = fpVal
	if base.info.Role == 0 {
		base.info.Role = 1
	}
	base.hasMfgData = true
	base.at = time.Now()
	h.seen[fp] = base
}

func (h *bleDesktopHost) onScanResult(_ *bluetooth.Adapter, r bluetooth.ScanResult) {
	if r.AdvertisementPayload == nil {
		return
	}
	addrKey := strings.ToUpper(strings.TrimSpace(r.Address.String()))
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
		if addrKey != "" {
			h.dedupeSeenByAddrLocked(fp, addrKey)
			h.addrFP[addrKey] = fp
		}
		prev := h.seen[fp]
		name := strings.TrimSpace(r.LocalName())
		if name == "" {
			name = prev.name
		}
		h.seen[fp] = bleSeenHub{addr: r.Address, name: name, info: info, hasMfgData: true, at: time.Now()}
		h.mu.Unlock()
		return
	}

	// BlueZ 5.82+ / Linux 6.x skips active SCAN_REQ once a peripheral's Name is cached in
	// /var/lib/bluetooth/<adapter>/cache/<mac>, delivering ADV_IND (with SlapRF's 128-bit service
	// UUID and cached LocalName) without SCAN_RSP ManufacturerData. Record the hub by its known
	// or deterministic address-derived ID; STATUS? resolves the authoritative fingerprint on connect.
	if !r.HasServiceUUID(h.svcUUID) || addrKey == "" {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	fp := h.addrFP[addrKey]
	var fpVal uint32
	hasMfg := false
	if fp != "" {
		if v, err := strconv.ParseUint(fp, 16, 32); err == nil {
			fpVal = uint32(v)
			hasMfg = true
		} else {
			fp = ""
		}
	}
	if fp == "" {
		fpVal = bleFallbackFPFromAddress(addrKey)
		fp = fmt.Sprintf("%08X", fpVal)
	}
	prev, hadPrev := h.seen[fp]
	name := strings.TrimSpace(r.LocalName())
	if name == "" {
		name = prev.name
	}
	info := BLEAdvertInfo{Fingerprint: fpVal, Role: 1}
	if hadPrev && prev.hasMfgData {
		info = prev.info
		hasMfg = true
	}
	h.dedupeSeenByAddrLocked(fp, addrKey)
	h.seen[fp] = bleSeenHub{addr: r.Address, name: name, info: info, hasMfgData: hasMfg, at: time.Now()}
}

// startScanLocked begins a scan of `window` if none is running and returns its done channel.
func (h *bleDesktopHost) startScanLocked(window time.Duration) chan struct{} {
	if h.scanning {
		return h.scanDone
	}
	h.scanning = true
	done := make(chan struct{})
	h.scanDone = done
	scanStarted := time.Now()
	h.lastScanStart = scanStarted
	adapterID := h.adapterID
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
		// tinygo.org/x/bluetooth on Linux leaves scanCancelChan non-nil if SetDiscoveryFilter or
		// GetManagedObjects returns an early error, permanently failing future Scan calls with
		// errScanning unless StopScan clears it.
		stopFn()
		if runtime.GOOS == "linux" {
			// If StopScan fired while tinygo's async StartDiscovery D-Bus call was still in flight,
			// give StartDiscovery a brief beat to settle and ensure StopDiscovery clears it.
			if time.Since(scanStarted) < 250*time.Millisecond {
				time.Sleep(80 * time.Millisecond)
			}
			ensureBLEDiscoveryStopped(adapterID)
		}
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

func (h *bleDesktopHost) hasFreshResolvedOrConnectedLocked() bool {
	if len(h.conns) > 0 {
		return true
	}
	for _, s := range h.seen {
		if s.hasMfgData && time.Since(s.at) <= bleSeenTTL {
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

// lookupUnresolvedSingle returns the sole fresh unconnected SlapRF hub whose advertisement lacked
// SCAN_RSP manufacturer data (so its authoritative fingerprint will be confirmed via STATUS? + AUTH).
func (h *bleDesktopHost) lookupUnresolvedSingle() (bleSeenHub, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	var match bleSeenHub
	count := 0
	for _, s := range h.seen {
		if s.hasMfgData || time.Since(s.at) > bleSeenTTL {
			continue
		}
		if _, busy := h.conns[s.addr.String()]; busy {
			continue
		}
		match = s
		count++
	}
	if count == 1 {
		return match, true
	}
	return bleSeenHub{}, false
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
		waitStart := time.Now()
		deadline := waitStart.Add(bleFirstListWait)
		for time.Now().Before(deadline) {
			h.mu.Lock()
			resolved := h.hasFreshResolvedOrConnectedLocked()
			anyFresh := h.hasFreshOrConnectedLocked()
			h.mu.Unlock()
			// Wait up to 600 ms after ADV_IND for BlueZ/WinRT to deliver the follow-up SCAN_RSP
			// ManufacturerData before falling back to an address-derived provisional ID.
			if resolved || (anyFresh && time.Since(waitStart) >= 600*time.Millisecond) {
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
	h.openMu.Lock()
	defer h.openMu.Unlock()
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
		scanStart := time.Now()
		deadline := scanStart.Add(bleOpenScanTimeout)
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
			if !found && time.Since(scanStart) >= 600*time.Millisecond {
				seen, found = h.lookupUnresolvedSingle()
			}
		}
		if !found {
			seen, found = h.lookupUnresolvedSingle()
		}
	}
	if h.stopScan() {
		// WinRT and BlueZ transition out of active discovery asynchronously; opening a GATT
		// session immediately can return Unreachable (WinRT) or le-connection-abort-by-local (BlueZ).
		if runtime.GOOS == "linux" {
			time.Sleep(350 * time.Millisecond)
		} else {
			time.Sleep(150 * time.Millisecond)
		}
	}
	if !found {
		return nil, fmt.Errorf("Bluetooth hub %s not found (is it powered and advertising?)", fp)
	}

	// Do not force a connection interval or priority: the hub requests 10 ms (falling back to
	// 20 or 30 ms) right after connect so its connection events line up with the 100 Hz sweep
	// schedule; the host just accepts that update.
	maxAttempts := 3
	if runtime.GOOS == "linux" {
		maxAttempts = 5
	}
	h.mu.Lock()
	adapterID := h.adapterID
	h.mu.Unlock()
	if runtime.GOOS == "linux" && ensureBLEDiscoveryStopped(adapterID) {
		time.Sleep(350 * time.Millisecond)
	}

	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		if attempt > 0 {
			if runtime.GOOS == "linux" && attempt%2 == 1 {
				// After a failed LE Create Connection (`le-connection-abort-by-local`), BlueZ can
				// evict the peer from the controller whitelist if h.seen came from an older cache
				// entry (e.g. while another host was still disconnecting). Refresh with a brief scan.
				refreshSince := time.Now()
				h.mu.Lock()
				scanDone := h.startScanLocked(900 * time.Millisecond)
				h.mu.Unlock()
				waitEnd := refreshSince.Add(900 * time.Millisecond)
				for time.Now().Before(waitEnd) {
					if refreshed, ok := h.lookup(fp); ok && refreshed.at.After(refreshSince) {
						seen = refreshed
						break
					}
					select {
					case <-scanDone:
						waitEnd = time.Time{}
					case <-time.After(80 * time.Millisecond):
					}
				}
				h.stopScan()
				ensureBLEDiscoveryStopped(adapterID)
				time.Sleep(350 * time.Millisecond)
			} else {
				time.Sleep(time.Duration(250+attempt*110) * time.Millisecond)
			}
		}
		dev, err := h.adapter.Connect(seen.addr, bluetooth.ConnectionParams{
			ConnectionTimeout: bluetooth.NewDuration(bleConnectTimeout),
		})
		if err != nil {
			if runtime.GOOS == "linux" {
				cancelBLEPendingConnect(adapterID, seen.addr.String())
			}
			lastErr = fmt.Errorf("Bluetooth hub %s connect failed: %w", fp, err)
			continue
		}
		svcs, err := dev.DiscoverServices([]bluetooth.UUID{h.svcUUID})
		if err != nil {
			_ = dev.Disconnect()
			lastErr = fmt.Errorf("Bluetooth hub %s service discovery failed: %w", fp, err)
			continue
		}
		if len(svcs) == 0 {
			_ = dev.Disconnect()
			lastErr = fmt.Errorf("Bluetooth hub %s service discovery failed: SlapRF Hub service not found", fp)
			continue
		}
		chars, err := svcs[0].DiscoverCharacteristics([]bluetooth.UUID{h.rxUUID, h.txUUID})
		if err != nil {
			_ = dev.Disconnect()
			lastErr = fmt.Errorf("Bluetooth hub %s characteristic discovery failed: %w", fp, err)
			continue
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
			_ = dev.Disconnect()
			lastErr = fmt.Errorf("Bluetooth hub %s characteristic discovery failed: RX/TX characteristics missing", fp)
			continue
		}

		stopCh := make(chan struct{})
		conn := &bleDesktopConn{fp: fp, dev: dev, rx: *rx, tx: *tx, stopCh: stopCh}
		port := NewBLEStreamPort(conn)
		conn.port = port
		h.mu.Lock()
		h.conns[dev.Address.String()] = conn
		h.mu.Unlock()

		// Notifications must be live before the first command (STATUS?) is written.
		// On shared 2.4 GHz Wi-Fi + BLE radios (e.g. Raspberry Pi CYW43455), the initial CCCD
		// write can collide with post-connect interval/MTU negotiation (ATT 0x0e); retry cleanly.
		notifErr := conn.tx.EnableNotifications(func(buf []byte) { port.Deliver(buf) })
		if notifErr != nil && runtime.GOOS == "linux" {
			_ = conn.tx.EnableNotifications(nil)
			time.Sleep(150 * time.Millisecond)
			notifErr = conn.tx.EnableNotifications(func(buf []byte) { port.Deliver(buf) })
		}
		if notifErr != nil {
			close(stopCh)
			conn.stopCh = nil
			if runtime.GOOS == "linux" {
				_ = conn.tx.EnableNotifications(nil)
			}
			h.unregister(conn)
			_ = dev.Disconnect()
			lastErr = fmt.Errorf("Bluetooth hub %s enabling notifications failed: %w", fp, notifErr)
			continue
		}
		if runtime.GOOS == "linux" {
			// Verify the ACL link survived the initial 6-event establishment window (`0x3e`) when
			// BlueZ resolved GATT attributes instantaneously from its local cache.
			time.Sleep(300 * time.Millisecond)
			if !isBLEDeviceStillConnected(adapterID, dev.Address.String()) {
				close(stopCh)
				conn.stopCh = nil
				_ = conn.tx.EnableNotifications(nil)
				h.unregister(conn)
				_ = dev.Disconnect()
				lastErr = fmt.Errorf("Bluetooth hub %s link dropped during establishment (2.4 GHz interference or range)", fp)
				continue
			}
			watchBLEDeviceDisconnect(adapterID, dev.Address.String(), stopCh, func(dErr error) {
				h.unregister(conn)
				port.Disconnected(dErr)
			})
		}
		_ = conn.MaxWriteLen()
		return port, nil
	}
	return nil, lastErr
}
