//go:build !android && !ios && !nobluetooth && (windows || linux || (darwin && cgo))

package bluetooth

import (
	"context"
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
	"slaprf/internal/serialport"
	"slaprf/internal/slaprf"
)

const (
	bleScanWindow       = 4 * time.Second
	bleScanRefreshEvery = 8 * time.Second
	bleSeenTTL          = 30 * time.Second
	bleFirstListWait    = 2200 * time.Millisecond
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
	fp          string
	dev         bluetooth.Device
	rx          bluetooth.DeviceCharacteristic
	tx          bluetooth.DeviceCharacteristic
	port        *BLEStreamPort
	stopCh      chan struct{}
	closeNotify func()

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
	if mtu, err := c.rx.GetMTU(); err == nil && mtu > 0 {
		if runtime.GOOS == "darwin" {
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
	c.mu.Lock()
	closed := c.closed
	c.mu.Unlock()
	if closed {
		return
	}
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
	closeNotify := c.closeNotify
	c.closeNotify = nil
	c.mu.Unlock()
	if stopCh != nil {
		close(stopCh)
	}
	bleHost.unregister(c)
	if closeNotify != nil {
		closeNotify()
	} else if runtime.GOOS == "linux" {
		_ = c.tx.EnableNotifications(nil)
	}
	err := c.dev.Disconnect()
	if runtime.GOOS == "linux" {
		addrStr := c.dev.Address.String()
		addrUpper := strings.ToUpper(strings.TrimSpace(addrStr))
		bleHost.mu.Lock()
		adapterID := bleHost.adapterID
		delete(bleHost.seen, c.fp)
		if addrUpper != "" {
			bleHost.dedupeSeenByAddrLocked("", addrUpper)
		}
		bleHost.mu.Unlock()
		deadline := time.Now().Add(600 * time.Millisecond)
		for time.Now().Before(deadline) {
			if !isBLEDeviceStillConnected(adapterID, addrStr) {
				break
			}
			time.Sleep(40 * time.Millisecond)
		}
	}
	return err
}

type bleDesktopHost struct {
	openMu        sync.Mutex
	mu            sync.Mutex
	adapter       *bluetooth.Adapter
	adapterID     string
	enabled       bool
	enableErr     error
	enableAt      time.Time
	seen          map[string]bleSeenHub
	addrFP        map[string]string
	scanning      bool
	scanDone      chan struct{}
	stopScanFn    func()
	lastScanStart time.Time
	lastScanStop  time.Time
	opening       int
	conns         map[string]*bleDesktopConn

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
	addrRaw := c.dev.Address.String()
	if h.conns[addrRaw] != c {
		return
	}
	addrKey := strings.ToUpper(strings.TrimSpace(addrRaw))
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
		stopFn()
		if runtime.GOOS == "linux" {
			if time.Since(scanStarted) < 250*time.Millisecond {
				time.Sleep(80 * time.Millisecond)
			}
			ensureBLEDiscoveryStopped(adapterID)
		}
		h.mu.Lock()
		h.scanning = false
		h.stopScanFn = nil
		h.lastScanStop = time.Now()
		h.mu.Unlock()
		close(done)
	}()
	return done
}

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
	s, ok := h.seen[fp]
	adapterID := h.adapterID
	if !ok || time.Since(s.at) > bleSeenTTL {
		h.mu.Unlock()
		return bleSeenHub{}, false
	}
	h.mu.Unlock()
	if runtime.GOOS == "linux" && !isBLEDeviceKnown(adapterID, s.addr.String()) {
		h.mu.Lock()
		delete(h.seen, fp)
		h.mu.Unlock()
		return bleSeenHub{}, false
	}
	return s, true
}

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

func bleListPorts() ([]slaprf.PortInfo, error) {
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
		foundResolved := false
		for time.Now().Before(deadline) {
			h.mu.Lock()
			resolved := h.hasFreshResolvedOrConnectedLocked()
			anyFresh := h.hasFreshOrConnectedLocked()
			h.mu.Unlock()
			if resolved && time.Since(waitStart) >= 350*time.Millisecond {
				foundResolved = true
				break
			}
			if anyFresh && time.Since(waitStart) >= 650*time.Millisecond {
				foundResolved = true
				break
			}
			select {
			case <-waitCh:
				deadline = time.Time{}
			case <-time.After(100 * time.Millisecond):
			}
		}
		if foundResolved {
			// Stop discovery as soon as the Hub is found so the radio and BlueZ hci_sync queue
			// have already settled before the user clicks Connect in the picker modal.
			go h.stopScan()
		}
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	connectedFP := make(map[string]bool, len(h.conns))
	for _, c := range h.conns {
		connectedFP[c.fp] = true
	}
	out := make([]slaprf.PortInfo, 0, len(h.seen))
	for fp, s := range h.seen {
		if !connectedFP[fp] && time.Since(s.at) > bleSeenTTL {
			continue
		}
		info := s.info
		if connectedFP[fp] {
			info.Paired = true
		}
		out = append(out, BLEPortInfoFor(info, s.name))
	}
	serialport.SortPorts(out)
	return out, nil
}

func bleOpenPort(portName string, baud int) (firmware.SerialPort, error) {
	return bleOpenPortContext(context.Background(), portName, baud, nil)
}

func sleepWithContext(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return ctx.Err() == nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

func bleOpenPortContext(
	ctx context.Context,
	portName string,
	_ int,
	onProgress func(string),
) (firmware.SerialPort, error) {
	if err := ctx.Err(); err != nil {
		return nil, slaprf.ErrConnectCancelled
	}
	if bleDisabledByEnv() {
		return nil, errors.New("Bluetooth disabled by SLAPRF_NO_BLE")
	}
	fp, ok := ParseBLEPortName(portName)
	if !ok {
		return nil, fmt.Errorf("invalid Bluetooth hub port %q (expected ble:<8 hex fingerprint>)", portName)
	}
	report := func(msg string) {
		if onProgress != nil && ctx.Err() == nil {
			onProgress(msg)
		}
	}
	h := bleHost
	h.openMu.Lock()
	defer h.openMu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, slaprf.ErrConnectCancelled
	}
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
		report(fmt.Sprintf("Scanning for Bluetooth Hub %s…", fp))
		scanStart := time.Now()
		deadline := scanStart.Add(bleOpenScanTimeout)
		h.mu.Lock()
		done := h.startScanLocked(bleOpenScanTimeout)
		h.mu.Unlock()
		for !found && time.Now().Before(deadline) {
			select {
			case <-ctx.Done():
				h.stopScan()
				return nil, slaprf.ErrConnectCancelled
			case <-done:
				if !sleepWithContext(ctx, 250*time.Millisecond) {
					h.stopScan()
					return nil, slaprf.ErrConnectCancelled
				}
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
			if found && runtime.GOOS == "linux" && time.Since(scanStart) < 400*time.Millisecond {
				if !sleepWithContext(ctx, 400*time.Millisecond-time.Since(scanStart)) {
					h.stopScan()
					return nil, slaprf.ErrConnectCancelled
				}
			}
		}
		if !found {
			seen, found = h.lookupUnresolvedSingle()
		}
	}
	stoppedActiveScan := h.stopScan()
	if runtime.GOOS == "linux" {
		// BlueZ 5.82+ runs `SetDiscoveryFilter({})` + `hci_update_passive_scan_sync` asynchronously
		// right after `StopDiscovery`; ensure at least 750 ms have elapsed since any scan ended.
		h.mu.Lock()
		sinceStop := time.Since(h.lastScanStop)
		hasStopped := !h.lastScanStop.IsZero()
		h.mu.Unlock()
		var waitRem time.Duration
		if stoppedActiveScan {
			waitRem = 750 * time.Millisecond
		} else if hasStopped && sinceStop < 750*time.Millisecond {
			waitRem = 750*time.Millisecond - sinceStop
		}
		if waitRem > 0 && !sleepWithContext(ctx, waitRem) {
			return nil, slaprf.ErrConnectCancelled
		}
	} else if stoppedActiveScan {
		if !sleepWithContext(ctx, 150*time.Millisecond) {
			return nil, slaprf.ErrConnectCancelled
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, slaprf.ErrConnectCancelled
	}
	if !found {
		return nil, fmt.Errorf("Bluetooth hub %s not found (is it powered and advertising?)", fp)
	}

	maxAttempts := 3
	if runtime.GOOS == "linux" {
		maxAttempts = 5
	}
	h.mu.Lock()
	adapterID := h.adapterID
	h.mu.Unlock()
	if runtime.GOOS == "linux" && ensureBLEDiscoveryStopped(adapterID) {
		if !sleepWithContext(ctx, 750*time.Millisecond) {
			return nil, slaprf.ErrConnectCancelled
		}
	}

	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return nil, slaprf.ErrConnectCancelled
		}
		if attempt == 0 {
			report("Waiting for Bluetooth LE connection…")
		} else {
			if runtime.GOOS == "linux" && attempt%2 == 1 {
				report(fmt.Sprintf("Retrying Bluetooth connection (attempt %d of %d) · scanning…", attempt+1, maxAttempts))
				refreshSince := time.Now()
				h.mu.Lock()
				scanDone := h.startScanLocked(900 * time.Millisecond)
				h.mu.Unlock()
				waitEnd := refreshSince.Add(900 * time.Millisecond)
				for time.Now().Before(waitEnd) {
					if refreshed, ok := h.lookup(fp); ok && refreshed.at.After(refreshSince) && time.Since(refreshSince) >= 450*time.Millisecond {
						seen = refreshed
						break
					}
					select {
					case <-ctx.Done():
						h.stopScan()
						return nil, slaprf.ErrConnectCancelled
					case <-scanDone:
						waitEnd = time.Time{}
					case <-time.After(80 * time.Millisecond):
					}
				}
				if refreshed, ok := h.lookup(fp); ok && refreshed.at.After(refreshSince) {
					seen = refreshed
				}
				h.stopScan()
				ensureBLEDiscoveryStopped(adapterID)
				if !sleepWithContext(ctx, 750*time.Millisecond) {
					return nil, slaprf.ErrConnectCancelled
				}
			} else {
				if !sleepWithContext(ctx, time.Duration(250+attempt*110)*time.Millisecond) {
					return nil, slaprf.ErrConnectCancelled
				}
			}
			report(fmt.Sprintf("Retrying Bluetooth connection (attempt %d of %d)…", attempt+1, maxAttempts))
		}

		attemptDone := make(chan struct{})
		if runtime.GOOS == "linux" {
			addrStr := seen.addr.String()
			go func() {
				select {
				case <-ctx.Done():
					cancelBLEPendingConnect(adapterID, addrStr)
				case <-attemptDone:
				}
			}()
		}
		dev, err := h.adapter.Connect(seen.addr, bluetooth.ConnectionParams{
			ConnectionTimeout: bluetooth.NewDuration(bleConnectTimeout),
		})
		close(attemptDone)
		if ctx.Err() != nil {
			if err == nil {
				_ = dev.Disconnect()
			} else if runtime.GOOS == "linux" {
				cancelBLEPendingConnect(adapterID, seen.addr.String())
			}
			return nil, slaprf.ErrConnectCancelled
		}
		if err != nil {
			lastErr = fmt.Errorf("Bluetooth hub %s connect failed: %w", fp, err)
			continue
		}
		report("Subscribing to Hub telemetry…")
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
		if ctx.Err() != nil {
			_ = dev.Disconnect()
			return nil, slaprf.ErrConnectCancelled
		}

		stopCh := make(chan struct{})
		conn := &bleDesktopConn{fp: fp, dev: dev, rx: *rx, tx: *tx, stopCh: stopCh}
		port := NewBLEStreamPort(conn)
		conn.port = port
		h.mu.Lock()
		h.conns[dev.Address.String()] = conn
		h.mu.Unlock()

		var notifErr error
		if closeNotify, acquired := acquireBLENotifySocket(adapterID, dev.Address.String(), BLETxCharUUID, stopCh, func(buf []byte) { port.Deliver(buf) }); acquired {
			conn.closeNotify = closeNotify
		} else {
			notifErr = conn.tx.EnableNotifications(func(buf []byte) { port.Deliver(buf) })
			if notifErr != nil && runtime.GOOS == "linux" {
				_ = conn.tx.EnableNotifications(nil)
				if !sleepWithContext(ctx, 150*time.Millisecond) {
					close(stopCh)
					conn.stopCh = nil
					h.unregister(conn)
					_ = dev.Disconnect()
					return nil, slaprf.ErrConnectCancelled
				}
				notifErr = conn.tx.EnableNotifications(func(buf []byte) { port.Deliver(buf) })
			}
		}
		if notifErr != nil {
			close(stopCh)
			conn.stopCh = nil
			if conn.closeNotify != nil {
				conn.closeNotify()
				conn.closeNotify = nil
			} else if runtime.GOOS == "linux" {
				_ = conn.tx.EnableNotifications(nil)
			}
			h.unregister(conn)
			_ = dev.Disconnect()
			lastErr = fmt.Errorf("Bluetooth hub %s enabling notifications failed: %w", fp, notifErr)
			continue
		}
		if runtime.GOOS == "linux" {
			if !sleepWithContext(ctx, 300*time.Millisecond) {
				close(stopCh)
				conn.stopCh = nil
				if conn.closeNotify != nil {
					conn.closeNotify()
					conn.closeNotify = nil
				} else {
					_ = conn.tx.EnableNotifications(nil)
				}
				h.unregister(conn)
				_ = dev.Disconnect()
				return nil, slaprf.ErrConnectCancelled
			}
			if !isBLEDeviceStillConnected(adapterID, dev.Address.String()) {
				close(stopCh)
				conn.stopCh = nil
				if conn.closeNotify != nil {
					conn.closeNotify()
					conn.closeNotify = nil
				} else {
					_ = conn.tx.EnableNotifications(nil)
				}
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
