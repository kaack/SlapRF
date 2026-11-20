package usb

import (
	"bytes"
	"errors"
	"io"
	"sync"
	"testing"
	"time"

	"slaprf/internal/firmware"
	"slaprf/internal/ingest"
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
	if !ok || info.Fingerprint != 0xBE7C0001 || info.Role != 1 || info.FwPatch != 7 {
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

// The manager lists Bluetooth hubs in its default (Espressif only) port filter.
func TestManagerListsBLEHubPorts(t *testing.T) {
	m := NewManager(ManagerConfig{
		ListPorts: MergeBLEPorts(
			func() ([]PortInfo, error) { return []PortInfo{{Name: "COM1"}}, nil },
			func() ([]PortInfo, error) {
				return []PortInfo{BLEPortInfoFor(BLEAdvertInfo{Fingerprint: 1}, "")}, nil
			},
		),
		OpenPort: func(string, int) (firmware.SerialPort, error) { return nil, errors.New("unused") },
	})
	ports, err := m.ListPorts(false)
	if err != nil || len(ports) != 1 || ports[0].Name != "ble:00000001" {
		t.Fatalf("got %+v, %v", ports, err)
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
	for _, l := range tr.seenLines() {
		if l == "STATUS?" {
			foundStatus = true
		}
	}
	if !foundStatus {
		t.Fatalf("STATUS? not received by hub, lines=%q", tr.seenLines())
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
