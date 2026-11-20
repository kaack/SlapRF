package usb

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"slaprf/internal/domain"
	"slaprf/internal/firmware"
	"slaprf/internal/ingest"
	"slaprf/internal/storage"
	"slaprf/internal/tracker"
)

type fakeBLETransport struct {
	mu       sync.Mutex
	maxWrite int
	writes   [][]byte
	inFlight int
	overlap  bool
	writeErr error
	closed   int
	delay    time.Duration
}

func (f *fakeBLETransport) WriteWithoutResponse(p []byte) error {
	f.mu.Lock()
	f.inFlight++
	if f.inFlight > 1 {
		f.overlap = true
	}
	if len(p) > f.maxWrite {
		f.mu.Unlock()
		return errors.New("chunk larger than MTU")
	}
	err := f.writeErr
	f.mu.Unlock()
	if f.delay > 0 {
		time.Sleep(f.delay)
	}
	f.mu.Lock()
	f.writes = append(f.writes, append([]byte(nil), p...))
	f.inFlight--
	f.mu.Unlock()
	return err
}

func (f *fakeBLETransport) MaxWriteLen() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.maxWrite
}

func (f *fakeBLETransport) Close() error {
	f.mu.Lock()
	f.closed++
	f.mu.Unlock()
	return nil
}

func readAll(t *testing.T, p *BLEStreamPort, want int) []byte {
	t.Helper()
	var out []byte
	buf := make([]byte, 7) // small buffer to exercise partial reads
	deadline := time.Now().Add(2 * time.Second)
	for len(out) < want && time.Now().Before(deadline) {
		n, err := p.Read(buf)
		if err != nil {
			t.Fatalf("read error after %d bytes: %v", len(out), err)
		}
		out = append(out, buf[:n]...)
	}
	return out
}

func TestBLEStreamPortPreservesByteOrder(t *testing.T) {
	p := NewBLEStreamPort(&fakeBLETransport{maxWrite: 20})
	_ = p.SetReadTimeout(50 * time.Millisecond)

	// A status line split across notifications, then a hub frame record sharing one notification
	// with the start of the next line.
	parts := [][]byte{
		[]byte(`@{"type":"sta`),
		[]byte(`tus","ok":true}` + "\n" + "\x1e\x04\xc5\x5a\x01"),
		[]byte("\x02@{\"type\":\"ok\"}\n"),
	}
	var want []byte
	go func() {
		for _, part := range parts {
			p.Deliver(part)
			time.Sleep(2 * time.Millisecond)
		}
	}()
	for _, part := range parts {
		want = append(want, part...)
	}
	got := readAll(t, p, len(want))
	if !bytes.Equal(got, want) {
		t.Fatalf("stream mismatch\n got %q\nwant %q", got, want)
	}
}

func TestBLEStreamPortDeliverCopiesInput(t *testing.T) {
	p := NewBLEStreamPort(&fakeBLETransport{maxWrite: 20})
	src := []byte("abc")
	p.Deliver(src)
	src[0] = 'X'
	buf := make([]byte, 8)
	n, err := p.Read(buf)
	if err != nil || string(buf[:n]) != "abc" {
		t.Fatalf("got %q, %v", buf[:n], err)
	}
}

func TestBLEStreamPortReadTimeoutReturnsZero(t *testing.T) {
	p := NewBLEStreamPort(&fakeBLETransport{maxWrite: 20})
	_ = p.SetReadTimeout(30 * time.Millisecond)
	start := time.Now()
	n, err := p.Read(make([]byte, 16))
	if n != 0 || err != nil {
		t.Fatalf("expected 0, nil on timeout; got %d, %v", n, err)
	}
	if el := time.Since(start); el < 20*time.Millisecond || el > time.Second {
		t.Fatalf("unexpected timeout duration %v", el)
	}
}

func TestBLEStreamPortWriteChunksToMTU(t *testing.T) {
	ft := &fakeBLETransport{maxWrite: BLEWritePayloadForMTU(23)}
	p := NewBLEStreamPort(ft)
	cmd := []byte("NETCHANNELS 5658 5695 5732 5769 5806 5843 5880 5917\n")
	n, err := p.Write(cmd)
	if err != nil || n != len(cmd) {
		t.Fatalf("write = %d, %v", n, err)
	}
	var joined []byte
	for i, w := range ft.writes {
		if len(w) > 20 {
			t.Fatalf("chunk %d has %d bytes, want <= 20", i, len(w))
		}
		joined = append(joined, w...)
	}
	if !bytes.Equal(joined, cmd) {
		t.Fatalf("chunks reassemble to %q", joined)
	}
	if want := (len(cmd) + 19) / 20; len(ft.writes) != want {
		t.Fatalf("got %d chunks, want %d", len(ft.writes), want)
	}

	// After an MTU exchange to 247 the same command fits in one write.
	ft.mu.Lock()
	ft.maxWrite = BLEWritePayloadForMTU(247)
	ft.writes = nil
	ft.mu.Unlock()
	if _, err := p.Write(cmd); err != nil {
		t.Fatal(err)
	}
	if len(ft.writes) != 1 {
		t.Fatalf("expected 1 chunk at MTU 247, got %d", len(ft.writes))
	}
}

func TestBLEStreamPortConcurrentWritesNeverInterleave(t *testing.T) {
	ft := &fakeBLETransport{maxWrite: 20, delay: time.Millisecond}
	p := NewBLEStreamPort(ft)
	a := bytes.Repeat([]byte("A"), 45)
	b := bytes.Repeat([]byte("B"), 45)
	var wg sync.WaitGroup
	for _, cmd := range [][]byte{a, b} {
		wg.Add(1)
		go func(c []byte) {
			defer wg.Done()
			if _, err := p.Write(c); err != nil {
				t.Error(err)
			}
		}(cmd)
	}
	wg.Wait()
	if ft.overlap {
		t.Fatal("transport writes overlapped")
	}
	var joined []byte
	for _, w := range ft.writes {
		joined = append(joined, w...)
	}
	s := string(joined)
	if s != string(a)+string(b) && s != string(b)+string(a) {
		t.Fatalf("writes interleaved: %q", s)
	}
}

func TestBLEStreamPortWriteErrorPropagates(t *testing.T) {
	ft := &fakeBLETransport{maxWrite: 20, writeErr: errors.New("gatt busy")}
	p := NewBLEStreamPort(ft)
	if _, err := p.Write([]byte("STATUS?\n")); err == nil {
		t.Fatal("expected write error")
	}
}

func TestBLEStreamPortCloseUnblocksReadAndIsIdempotent(t *testing.T) {
	ft := &fakeBLETransport{maxWrite: 20}
	p := NewBLEStreamPort(ft)
	_ = p.SetReadTimeout(5 * time.Second)
	errCh := make(chan error, 1)
	go func() {
		_, err := p.Read(make([]byte, 8))
		errCh <- err
	}()
	time.Sleep(20 * time.Millisecond)
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-errCh:
		if !errors.Is(err, io.EOF) {
			t.Fatalf("expected EOF after close, got %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Read did not unblock on Close")
	}
	_ = p.Close()
	if ft.closed != 1 {
		t.Fatalf("transport closed %d times, want 1", ft.closed)
	}
	if _, err := p.Write([]byte("x")); !errors.Is(err, io.ErrClosedPipe) {
		t.Fatalf("write after close = %v", err)
	}
	p.Deliver([]byte("late"))
	if n, err := p.Read(make([]byte, 8)); n != 0 || !errors.Is(err, io.EOF) {
		t.Fatalf("read after close = %d, %v", n, err)
	}
}

func TestBLEStreamPortDisconnectDrainsThenEOF(t *testing.T) {
	p := NewBLEStreamPort(&fakeBLETransport{maxWrite: 20})
	_ = p.SetReadTimeout(5 * time.Second)
	p.Deliver([]byte("tail\n"))
	p.Disconnected(errors.New("link lost"))
	buf := make([]byte, 16)
	n, err := p.Read(buf)
	if err != nil || string(buf[:n]) != "tail\n" {
		t.Fatalf("expected buffered bytes before EOF, got %q, %v", buf[:n], err)
	}
	if n, err := p.Read(buf); n != 0 || !errors.Is(err, io.EOF) {
		t.Fatalf("expected EOF after drain, got %d, %v", n, err)
	}
	if _, err := p.Write([]byte("STATUS?\n")); !errors.Is(err, io.ErrClosedPipe) {
		t.Fatalf("write after disconnect = %v", err)
	}
}

func TestBLEStreamPortModemLinesAreNoops(t *testing.T) {
	p := NewBLEStreamPort(&fakeBLETransport{maxWrite: 20})
	if p.SetDTR(true) != nil || p.SetRTS(true) != nil {
		t.Fatal("DTR/RTS must be accepted as no-ops")
	}
	// Reboot helpers toggle DTR/RTS; they must not fail or write on a Bluetooth port.
	firmware.RebootESP32C5IntoApp(p)
}

func TestBLEPortNameHelpers(t *testing.T) {
	if got := BLEPortName(0xBE7C0001); got != "ble:BE7C0001" {
		t.Fatalf("BLEPortName = %q", got)
	}
	cases := map[string]string{
		"ble:BE7C0001":   "BE7C0001",
		" BLE:be7c0001 ": "BE7C0001",
	}
	for in, want := range cases {
		if got, ok := ParseBLEPortName(in); !ok || got != want {
			t.Fatalf("ParseBLEPortName(%q) = %q, %v", in, got, ok)
		}
	}
	for _, bad := range []string{"COM3", "/dev/ttyACM0", "ble:", "ble:XYZ00001", "ble:BE7C00011"} {
		if _, ok := ParseBLEPortName(bad); ok {
			t.Fatalf("ParseBLEPortName(%q) should fail", bad)
		}
	}
	if IsBLEPortName("COM9") || IsBLEPortName("/dev/bus/usb/001/002") || !IsBLEPortName("ble:00000001") {
		t.Fatal("IsBLEPortName misclassified a port")
	}
}

func TestParseBLEManufacturerData(t *testing.T) {
	data := []byte{'S', 'R', 0x01, 0x00, 0x7C, 0xBE, 1, 0, 0, 7}
	info, ok := ParseBLEManufacturerData(0xFFFF, data)
	if !ok || info.Fingerprint != 0xBE7C0001 || info.Role != 1 || info.FwPatch != 7 || info.HasFlags || info.Paired {
		t.Fatalf("got %+v, %v", info, ok)
	}
	if _, ok := ParseBLEManufacturerData(0x02E5, data); ok {
		t.Fatal("wrong company ID must be rejected")
	}
	if _, ok := ParseBLEManufacturerData(0xFFFF, []byte{'X', 'R', 1, 2, 3, 4, 1}); ok {
		t.Fatal("wrong signature must be rejected")
	}
	if _, ok := ParseBLEManufacturerData(0xFFFF, data[:6]); ok {
		t.Fatal("short data must be rejected")
	}
	pi := BLEPortInfoFor(info, "SlapRF H1")
	if pi.Name != "ble:BE7C0001" || pi.Product != "SlapRF H1 (Bluetooth)" || !pi.IsEspressif || pi.IsUSB || pi.Transport != "ble" {
		t.Fatalf("unexpected PortInfo %+v", pi)
	}

	// Byte 10 flags: 0x00 = open Pairing Mode, 0x01 = Paired.
	unpairedAdv := append(append([]byte(nil), data...), 0x00)
	unpairedInfo, ok := ParseBLEManufacturerData(0xFFFF, unpairedAdv)
	if !ok || !unpairedInfo.HasFlags || unpairedInfo.Paired {
		t.Fatalf("expected HasFlags=true Paired=false, got %+v, %v", unpairedInfo, ok)
	}
	unpairedPort := BLEPortInfoFor(unpairedInfo, "SlapRF H1")
	if unpairedPort.Product != "SlapRF H1 (Bluetooth · Pairing mode)" {
		t.Fatalf("expected Pairing mode product label, got %q", unpairedPort.Product)
	}

	pairedAdv := append(append([]byte(nil), data...), 0x01)
	pairedInfo, ok := ParseBLEManufacturerData(0xFFFF, pairedAdv)
	if !ok || !pairedInfo.HasFlags || !pairedInfo.Paired {
		t.Fatalf("expected HasFlags=true Paired=true, got %+v, %v", pairedInfo, ok)
	}
	pairedPort := BLEPortInfoFor(pairedInfo, "SlapRF H1")
	if pairedPort.Product != "SlapRF H1 (Bluetooth)" {
		t.Fatalf("expected Paired product label, got %q", pairedPort.Product)
	}
}

func TestBLEWritePayloadForMTU(t *testing.T) {
	for mtu, want := range map[int]int{0: 20, 23: 20, 100: 97, 247: 244, 517: 244} {
		if got := BLEWritePayloadForMTU(mtu); got != want {
			t.Fatalf("BLEWritePayloadForMTU(%d) = %d, want %d", mtu, got, want)
		}
	}
}

func TestDispatchBLEOpenerRoutesByPrefix(t *testing.T) {
	var usbCalls, bleCalls []string
	usbOpen := func(name string, _ int) (firmware.SerialPort, error) {
		usbCalls = append(usbCalls, name)
		return &fakeUSBPort{}, nil
	}
	bleOpen := func(name string, _ int) (firmware.SerialPort, error) {
		bleCalls = append(bleCalls, name)
		return NewBLEStreamPort(&fakeBLETransport{maxWrite: 20}), nil
	}
	open := DispatchBLEOpener(usbOpen, bleOpen)
	for _, n := range []string{"COM9", "/dev/ttyACM0", "/dev/bus/usb/001/004", "auto:espressif"} {
		if _, err := open(n, 115200); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := open(" ble:BE7C0001", 115200); err != nil {
		t.Fatal(err)
	}
	if len(usbCalls) != 4 || len(bleCalls) != 1 || bleCalls[0] != "ble:BE7C0001" {
		t.Fatalf("usb=%v ble=%v", usbCalls, bleCalls)
	}
	if _, err := DispatchBLEOpener(usbOpen, nil)("ble:BE7C0001", 0); !errors.Is(err, ErrBLEUnsupported) {
		t.Fatalf("expected ErrBLEUnsupported, got %v", err)
	}
}

func TestMergeBLEPorts(t *testing.T) {
	usbList := func() ([]PortInfo, error) {
		return []PortInfo{{Name: "COM9", IsUSB: true, VID: "303A", IsEspressif: true}}, nil
	}
	bleList := func() ([]PortInfo, error) {
		return []PortInfo{BLEPortInfoFor(BLEAdvertInfo{Fingerprint: 0xBE7C0001, Role: 1}, "SlapRF H1")}, nil
	}
	ports, err := MergeBLEPorts(usbList, bleList)()
	if err != nil || len(ports) != 2 || ports[0].Name != "COM9" || ports[1].Name != "ble:BE7C0001" {
		t.Fatalf("got %+v, %v", ports, err)
	}

	// Bluetooth failures never hide USB ports.
	failing := func() ([]PortInfo, error) { return nil, errors.New("no adapter") }
	ports, err = MergeBLEPorts(usbList, failing)()
	if err != nil || len(ports) != 1 {
		t.Fatalf("got %+v, %v", ports, err)
	}
	// USB enumeration failure still surfaces Bluetooth hubs.
	ports, err = MergeBLEPorts(failing, bleList)()
	if err != nil || len(ports) != 1 || ports[0].Transport != BLETransportName {
		t.Fatalf("got %+v, %v", ports, err)
	}
	if _, err = MergeBLEPorts(failing, failing)(); err == nil {
		t.Fatal("expected USB error when nothing is found")
	}
}

// Manager filters ports strictly by transport mode (USB-only vs BLE-only), while ListUSBPorts
// always lists USB ports for the Flasher without triggering BLE scans.
func TestManagerListsBLEHubPorts(t *testing.T) {
	var bleScanCalls int
	m := NewManager(ManagerConfig{
		ListPorts: func() ([]PortInfo, error) {
			ports := []PortInfo{
				{Name: "COM1"},
				{Name: "COM9", IsUSB: true, VID: "303A", IsEspressif: true},
			}
			if BLEScanEnabled() {
				bleScanCalls++
				ports = append(ports, BLEPortInfoFor(BLEAdvertInfo{Fingerprint: 1, HasFlags: true, Paired: false}, "SlapRF H1"))
			}
			return ports, nil
		},
		OpenPort: func(string, int) (firmware.SerialPort, error) { return nil, errors.New("unused") },
	})
	defer m.Close()

	// Default mode (SlapRF USB): BLE scan is disabled and only Espressif USB ports are returned.
	usbPorts, err := m.ListPorts(false)
	if err != nil || len(usbPorts) != 1 || usbPorts[0].Name != "COM9" {
		t.Fatalf("expected only COM9 in USB mode, got %+v, %v", usbPorts, err)
	}
	if bleScanCalls != 0 {
		t.Fatalf("expected 0 BLE scan calls in USB mode, got %d", bleScanCalls)
	}

	// Switching to SlapRF Bluetooth mode (`bleOnly == true`) enables BLE scanning and returns only `ble:` ports.
	m.SetTransportMode(true)
	blePorts, err := m.ListPorts(false)
	if err != nil || len(blePorts) != 1 || blePorts[0].Name != "ble:00000001" {
		t.Fatalf("expected only ble:00000001 in BLE mode, got %+v, %v", blePorts, err)
	}
	if bleScanCalls != 1 {
		t.Fatalf("expected 1 BLE scan call in BLE mode, got %d", bleScanCalls)
	}

	// Flasher (`ListUSBPorts`) still sees COM9 in Bluetooth mode without triggering an extra BLE scan!
	flashPorts, err := m.ListUSBPorts(false)
	if err != nil || len(flashPorts) != 1 || flashPorts[0].Name != "COM9" {
		t.Fatalf("expected Flasher ListUSBPorts to see COM9 in BLE mode, got %+v, %v", flashPorts, err)
	}
	if bleScanCalls != 1 {
		t.Fatalf("expected ListUSBPorts not to trigger BLE scan, bleScanCalls=%d", bleScanCalls)
	}
}

// echoHubTransport emulates a Bluetooth hub: it reassembles RX writes into lines and answers
// STATUS? with a HELLO record plus a status line, split into 20-byte notifications.
type echoHubTransport struct {
	fakeBLETransport
	port   *BLEStreamPort
	lineMu sync.Mutex
	line   []byte
	lines  []string
}

func (e *echoHubTransport) WriteWithoutResponse(p []byte) error {
	if err := e.fakeBLETransport.WriteWithoutResponse(p); err != nil {
		return err
	}
	e.lineMu.Lock()
	defer e.lineMu.Unlock()
	for _, c := range p {
		if c != '\n' {
			e.line = append(e.line, c)
			continue
		}
		l := string(e.line)
		e.line = nil
		e.lines = append(e.lines, l)
		if l == "STATUS?" {
			var reply []byte
			reply = append(reply, buildRecordPacket(buildHelloFrame(1, firmware.RoleHubTimer, 0xCAFE1234, "H1-BLE"))...)
			reply = append(reply, []byte("@{\"t\":\"status\",\"fw\":\"0.4.0\",\"role\":1,\"fp\":\"CAFE1234\",\"label\":\"H1-BLE\",\"slot\":1,\"channel\":1,\"transport\":\"ble\"}\n")...)
			go func(b []byte) {
				for len(b) > 0 {
					n := 20
					if n > len(b) {
						n = len(b)
					}
					e.port.Deliver(b[:n])
					b = b[n:]
				}
			}(reply)
		}
	}
	return nil
}

func (e *echoHubTransport) seenLines() []string {
	e.lineMu.Lock()
	defer e.lineMu.Unlock()
	return append([]string(nil), e.lines...)
}

func TestManagerConnectsOverBLEStreamPort(t *testing.T) {
	eng := tracker.NewRealEngine()
	hubRx := ingest.NewHubFrameDecoder(eng)
	tr := &echoHubTransport{fakeBLETransport: fakeBLETransport{maxWrite: 20}}
	var opened []string
	open := DispatchBLEOpener(
		func(name string, _ int) (firmware.SerialPort, error) {
			t.Errorf("USB opener must not be used for %q", name)
			return nil, errors.New("unexpected USB open")
		},
		func(name string, _ int) (firmware.SerialPort, error) {
			opened = append(opened, name)
			p := NewBLEStreamPort(tr)
			tr.port = p
			return p, nil
		},
	)
	mgr := NewManager(ManagerConfig{Engine: eng, HubRx: hubRx, OpenPort: open,
		ListPorts: func() ([]PortInfo, error) { return nil, nil }})
	defer mgr.Close()

	snap, err := mgr.Connect(0, "ble:CAFE1234")
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	if !snap.Connected || snap.PortName != "ble:CAFE1234" || len(opened) != 1 {
		t.Fatalf("unexpected snapshot %+v (opened %v)", snap, opened)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && mgr.Snapshot().Slots[0].LastStatus == nil {
		time.Sleep(10 * time.Millisecond)
	}
	st := mgr.Snapshot().Slots[0].LastStatus
	if st == nil || st["transport"] != "ble" {
		t.Fatalf("expected status over BLE, got %+v", st)
	}
	foundStatus := false
	lines := tr.seenLines()
	if len(lines) == 0 || !strings.HasPrefix(lines[0], "AUTH ") || len(strings.TrimPrefix(lines[0], "AUTH ")) != 32 {
		t.Fatalf("expected first line over BLE to be AUTH <32-hex>, got lines=%q", lines)
	}
	if lines[0] != "AUTH "+mgr.BLEHostKey() {
		t.Fatalf("expected AUTH key %s, got %q", mgr.BLEHostKey(), lines[0])
	}
	for _, l := range lines {
		if l == "STATUS?" {
			foundStatus = true
		}
	}
	if !foundStatus {
		t.Fatalf("STATUS? not received by hub, lines=%q", lines)
	}
	tr.mu.Lock()
	for i, w := range tr.writes {
		if len(w) > 20 {
			tr.mu.Unlock()
			t.Fatalf("write %d exceeded MTU payload: %d bytes", i, len(w))
		}
	}
	tr.mu.Unlock()

	if err := mgr.Disconnect(0); err != nil {
		t.Fatalf("Disconnect: %v", err)
	}
	tr.mu.Lock()
	closed := tr.closed
	tr.mu.Unlock()
	if closed != 1 {
		t.Fatalf("expected BLE transport closed once on Disconnect, got %d", closed)
	}
}

type authRejectTransport struct {
	fakeBLETransport
	port   *BLEStreamPort
	lineMu sync.Mutex
	line   []byte
}

func (a *authRejectTransport) WriteWithoutResponse(p []byte) error {
	if err := a.fakeBLETransport.WriteWithoutResponse(p); err != nil {
		return err
	}
	a.lineMu.Lock()
	defer a.lineMu.Unlock()
	for _, c := range p {
		if c != '\n' {
			a.line = append(a.line, c)
			continue
		}
		l := string(a.line)
		a.line = nil
		if strings.HasPrefix(l, "AUTH ") {
			pRef := a.port
			go func() {
				pRef.Deliver([]byte(`@{"t":"err","code":"auth_mismatch","msg":"Hub is paired to another device. Hold BOOT for 3 s on the Hub to pair with this device."}` + "\n"))
				time.Sleep(30 * time.Millisecond)
				pRef.Disconnected(errors.New("remote terminated"))
			}()
		}
	}
	return nil
}

func TestBLEAuthMismatchStopsAutoReconnectAndClearsPersistedTarget(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "ble_auth.db")
	store, err := storage.OpenBoltStore(dbPath)
	if err != nil {
		t.Fatalf("OpenBoltStore: %v", err)
	}
	defer store.Close()

	var openCount int
	var openMu sync.Mutex
	mgr := NewManager(ManagerConfig{
		Store: store,
		OpenPort: func(name string, _ int) (firmware.SerialPort, error) {
			openMu.Lock()
			openCount++
			openMu.Unlock()
			tr := &authRejectTransport{fakeBLETransport: fakeBLETransport{maxWrite: 244}}
			p := NewBLEStreamPort(tr)
			tr.port = p
			return p, nil
		},
		ListPorts: func() ([]PortInfo, error) {
			return []PortInfo{BLEPortInfoFor(BLEAdvertInfo{Fingerprint: 0xDEADBEEF, HasFlags: true, Paired: true}, "SlapRF H1")}, nil
		},
	})
	defer mgr.Close()
	mgr.SetTransportMode(true)

	// Verify 32-hex host key was generated and persisted to BoltStore.
	var persistedKey string
	if ok, gErr := store.GetJSON(kvBLEHostKey, &persistedKey); gErr != nil || !ok || persistedKey != mgr.BLEHostKey() || len(persistedKey) != 32 {
		t.Fatalf("expected persisted 32-hex ble_host_key %q, got ok=%v key=%q err=%v", mgr.BLEHostKey(), ok, persistedKey, gErr)
	}

	var errEvents []string
	var evMu sync.Mutex
	mgr.Subscribe(func(ev USBEvent) {
		if ev.Type == "error" {
			evMu.Lock()
			errEvents = append(errEvents, ev.Error)
			evMu.Unlock()
		}
	})

	snap, connErr := mgr.Connect(0, "ble:DEADBEEF")
	if connErr == nil || !strings.Contains(connErr.Error(), "paired to another device") {
		t.Fatalf("expected auth_mismatch error from Connect, got snap=%+v err=%v", snap, connErr)
	}
	if snap.Connected || snap.Reconnecting || !snap.ReconnectFailed || !strings.Contains(snap.LastError, "Hold BOOT for 3 s") {
		t.Fatalf("unexpected slot state after auth_mismatch: %+v", snap)
	}

	// Wait past the 1.2s reconnect backoff window to confirm no auto-reconnect loop started!
	time.Sleep(1400 * time.Millisecond)
	openMu.Lock()
	opens := openCount
	openMu.Unlock()
	if opens != 1 {
		t.Fatalf("expected exactly 1 open attempt (no auto-reconnect on auth_mismatch), got %d", opens)
	}

	evMu.Lock()
	gotErrEvents := len(errEvents)
	evMu.Unlock()
	if gotErrEvents == 0 {
		t.Fatalf("expected error USBEvent emitted for auth_mismatch")
	}

	var savedBLE map[string]string
	_, _ = store.GetJSON(kvBLETargetsKey, &savedBLE)
	if len(savedBLE) != 0 {
		t.Fatalf("expected rejected Hub removed from hw.ble_targets, got %+v", savedBLE)
	}
}

func TestManagerSeparatesUSBAndBLETargetsAcrossReconcile(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "targets.db")
	store, err := storage.OpenBoltStore(dbPath)
	if err != nil {
		t.Fatalf("OpenBoltStore: %v", err)
	}
	defer store.Close()

	eng := tracker.NewRealEngine()
	hubRx := ingest.NewHubFrameDecoder(eng)

	usbPort := &fakeUSBPort{}
	usbPort.pushRx([]byte("@{\"t\":\"status\",\"fw\":\"0.4.0\",\"role\":1,\"fp\":\"11112222\",\"label\":\"H1-USB\",\"slot\":1,\"channel\":1}\n"))

	newBLEPort := func() firmware.SerialPort {
		tr := &echoHubTransport{fakeBLETransport: fakeBLETransport{maxWrite: 244}}
		p := NewBLEStreamPort(tr)
		tr.port = p
		return p
	}

	mgr := NewManager(ManagerConfig{
		Engine: eng,
		HubRx:  hubRx,
		Store:  store,
		OpenPort: func(name string, _ int) (firmware.SerialPort, error) {
			if IsBLEPortName(name) {
				return newBLEPort(), nil
			}
			usbPort.mu.Lock()
			usbPort.closed = false
			usbPort.rx.Reset()
			usbPort.rx.WriteString("@{\"t\":\"status\",\"fw\":\"0.4.0\",\"role\":1,\"fp\":\"11112222\",\"label\":\"H1-USB\",\"slot\":1,\"channel\":1}\n")
			usbPort.mu.Unlock()
			return usbPort, nil
		},
		ListPorts: func() ([]PortInfo, error) {
			return []PortInfo{
				{Name: "COM7", IsUSB: true, VID: "303A", IsEspressif: true},
				BLEPortInfoFor(BLEAdvertInfo{Fingerprint: 0xCAFE1234, Role: 1, HasFlags: true, Paired: true}, "SlapRF H1"),
			}, nil
		},
	})
	defer mgr.Close()

	mgr.Reconcile(false, domain.HardwareModeSlapRF)
	if _, err := mgr.Connect(0, "COM7"); err != nil {
		t.Fatalf("Connect COM7: %v", err)
	}

	// Switch engine to SlapRF (Bluetooth): COM7 closes and slot 0 is free for BLE.
	eng.SetTimingHardwareMode(domain.HardwareModeSlapRFBLE, false)
	mgr.Reconcile(false, eng.TimingHardwareMode())
	if mgr.Snapshot().Slots[0].Connected {
		t.Fatalf("expected COM7 closed when switching to slaprf_ble")
	}

	if _, err := mgr.Connect(0, "ble:CAFE1234"); err != nil {
		t.Fatalf("Connect ble:CAFE1234: %v", err)
	}
	// Single-gate Bluetooth Hub auto-provisions Gate 1 (Start/Finish) in slaprf_ble mode.
	_, gates, _, _, _ := eng.StateSnapshot()
	if len(gates) != 1 || gates[0].AssignedTimerID != 1 || gates[0].Role != domain.GateRoleStartFinish {
		t.Fatalf("expected auto-bound Gate 1 on Hub in slaprf_ble mode, got %+v", gates)
	}

	var usbSaved, bleSaved map[string]string
	_, _ = store.GetJSON(kvUSBTargetsKey, &usbSaved)
	_, _ = store.GetJSON(kvBLETargetsKey, &bleSaved)
	if usbSaved["0"] != "COM7" || bleSaved["0"] != "ble:CAFE1234" {
		t.Fatalf("expected independent persistence usb=%+v ble=%+v", usbSaved, bleSaved)
	}

	// Switch back to SlapRF (USB): BLE closes and COM7 auto-restores!
	eng.SetTimingHardwareMode(domain.HardwareModeSlapRF, false)
	mgr.Reconcile(false, eng.TimingHardwareMode())
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		s0 := mgr.Snapshot().Slots[0]
		if s0.Connected && s0.PortName == "COM7" {
			break
		}
		time.Sleep(15 * time.Millisecond)
	}
	if s0 := mgr.Snapshot().Slots[0]; !s0.Connected || s0.PortName != "COM7" {
		t.Fatalf("expected COM7 auto-restored when switching back to slaprf, got %+v", s0)
	}

	// Switch again to SlapRF (Bluetooth): COM7 closes and ble:CAFE1234 auto-restores!
	eng.SetTimingHardwareMode(domain.HardwareModeSlapRFBLE, false)
	mgr.Reconcile(false, eng.TimingHardwareMode())
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		s0 := mgr.Snapshot().Slots[0]
		if s0.Connected && s0.PortName == "ble:CAFE1234" {
			break
		}
		time.Sleep(15 * time.Millisecond)
	}
	if s0 := mgr.Snapshot().Slots[0]; !s0.Connected || s0.PortName != "ble:CAFE1234" {
		t.Fatalf("expected ble:CAFE1234 auto-restored when switching to slaprf_ble, got %+v", s0)
	}
	_ = fmt.Sprint()
}

func TestBLEUnwrapWindowSamplesLive2ZeroGaps(t *testing.T) {
	slot := &usbSlot{
		portName:    "ble:BE7C0001",
		bleLiveMode: 2,
		blePeak:     [8]int{-127, -127, -127, -127, -127, -127, -127, -127},
	}
	makeWindow := func(seqs []uint8, code byte) []byte {
		frame := make([]byte, 7+len(seqs)*9+1)
		frame[0] = 0xC5
		frame[1] = 0x60
		frame[2] = 1
		frame[3] = byte(len(seqs))
		floorByte := int8(-92)
		frame[6] = byte(floorByte)
		for i, sq := range seqs {
			off := 7 + i*9
			frame[off] = sq
			for ch := 0; ch < 8; ch++ {
				frame[off+1+ch] = code
			}
		}
		var crc byte
		for i := 0; i < len(frame)-1; i++ {
			crc ^= frame[i]
		}
		frame[len(frame)-1] = crc
		return frame
	}

	// Overlapping 4-sample windows sent every 2 sweeps: [10,11,12,13] then [12,13,14,15].
	ev1 := unwrapBLEWindowSamplesLocked(slot, makeWindow([]uint8{10, 11, 12, 13}, 70), 4)
	ev2 := unwrapBLEWindowSamplesLocked(slot, makeWindow([]uint8{12, 13, 14, 15}, 72), 4)
	// Transient all-zero radio-free sample [14,15,16,17] with code=0 must be filtered out without gaps.
	evBlank := unwrapBLEWindowSamplesLocked(slot, makeWindow([]uint8{16, 17}, 0), 2)

	if len(ev1) != 4 || len(ev2) != 2 || len(evBlank) != 0 {
		t.Fatalf("expected 4 + 2 + 0 live events, got %d, %d, %d", len(ev1), len(ev2), len(evBlank))
	}
	all := append(ev1, ev2...)
	for idx, ev := range all {
		wantN := uint64(idx + 1)
		if gotN, _ := ev["n"].(uint64); gotN != wantN {
			t.Fatalf("event %d expected n=%d, got %v", idx, wantN, ev["n"])
		}
	}
}
