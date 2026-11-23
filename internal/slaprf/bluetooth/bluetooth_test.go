package bluetooth

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"slaprf/internal/domain"
	"slaprf/internal/firmware"
	"slaprf/internal/ingest"
	"slaprf/internal/slaprf"
	slaprfusb "slaprf/internal/slaprf/usb"
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

func buildRecordPacket(frame []byte) []byte {
	out := make([]byte, 2+len(frame))
	out[0] = 0x1E
	out[1] = byte(len(frame))
	copy(out[2:], frame)
	return out
}

func buildHelloFrame(slot uint8, role uint8, fp uint32, label string) []byte {
	f := make([]byte, 36)
	f[0] = 0xC5
	f[1] = 0x5A
	f[2] = slot
	f[3] = role
	binary.LittleEndian.PutUint32(f[4:8], fp)
	f[9] = 50
	copy(f[10:34], []byte(label))
	var crc byte
	for i := 0; i < 35; i++ {
		crc ^= f[i]
	}
	f[35] = crc
	return f
}

func readAll(t *testing.T, p *BLEStreamPort, want int) []byte {
	t.Helper()
	var out []byte
	buf := make([]byte, 7)
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

func TestBLEStreamPortWriteChunksToMTUAndConcurrentWritesNeverInterleave(t *testing.T) {
	ft := &fakeBLETransport{maxWrite: BLEWritePayloadForMTU(23), delay: time.Millisecond}
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
		if len(w) > 20 {
			t.Fatalf("chunk exceeded 20 bytes: %d", len(w))
		}
		joined = append(joined, w...)
	}
	s := string(joined)
	if s != string(a)+string(b) && s != string(b)+string(a) {
		t.Fatalf("writes interleaved: %q", s)
	}
}

func TestBLEStreamPortCloseAndDisconnect(t *testing.T) {
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

func TestBLEPortNameAndManufacturerData(t *testing.T) {
	tr := NewTransport(Config{})
	norm, err := tr.ValidateTarget("BE7C0001")
	if err != nil || norm != "ble:BE7C0001" {
		t.Fatalf("ValidateTarget bare FP = %q, %v", norm, err)
	}
	if _, err := tr.ValidateTarget("/dev/ttyACM0"); err == nil {
		t.Fatalf("ValidateTarget should reject USB serial port")
	}

	data := []byte{'S', 'R', 0x01, 0x00, 0x7C, 0xBE, 1, 0, 0, 7, 0x00}
	info, ok := ParseBLEManufacturerData(0xFFFF, data)
	if !ok || info.Fingerprint != 0xBE7C0001 || !info.HasFlags || info.Paired {
		t.Fatalf("unexpected BLEAdvertInfo %+v, %v", info, ok)
	}
	pi := BLEPortInfoFor(info, "SlapRF H1")
	if pi.Product != "SlapRF H1 (Bluetooth · Pairing mode)" || pi.Transport != "ble" {
		t.Fatalf("unexpected PortInfo %+v", pi)
	}
}

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

func TestManagerConnectsOverBLETransport(t *testing.T) {
	eng := tracker.NewRealEngine()
	hubRx := ingest.NewHubFrameDecoder(eng)
	gatt := &echoHubTransport{fakeBLETransport: fakeBLETransport{maxWrite: 20}}
	var opened []string
	bleTr := NewTransport(Config{
		OpenPort: func(name string, _ int) (firmware.SerialPort, error) {
			opened = append(opened, name)
			p := NewBLEStreamPort(gatt)
			gatt.port = p
			return p, nil
		},
		ListPorts: func() ([]slaprf.PortInfo, error) {
			return []slaprf.PortInfo{BLEPortInfoFor(BLEAdvertInfo{Fingerprint: 0xCAFE1234, Role: 1}, "H1")}, nil
		},
	})
	mgr := slaprf.NewManager(slaprf.Config{Transport: bleTr, Engine: eng, HubRx: hubRx})
	defer mgr.Close()

	ports, err := mgr.ListPorts(context.Background(), false)
	if err != nil || len(ports) != 1 || ports[0].Name != "ble:CAFE1234" {
		t.Fatalf("expected ble:CAFE1234 port, got %+v, %v", ports, err)
	}

	snap, err := mgr.Connect(0, "ble:CAFE1234")
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	if !snap.Connected || snap.PortName != "ble:CAFE1234" || len(opened) != 1 {
		t.Fatalf("unexpected snapshot %+v (opened %v)", snap, opened)
	}
	lines := gatt.seenLines()
	if len(lines) == 0 || lines[0] != "AUTH "+mgr.HostAuthKey() {
		t.Fatalf("expected AUTH <key> first line, got %q", lines)
	}
	if err := mgr.Disconnect(0); err != nil {
		t.Fatalf("Disconnect: %v", err)
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
	bleTr := NewTransport(Config{
		OpenPort: func(_ string, _ int) (firmware.SerialPort, error) {
			openMu.Lock()
			openCount++
			openMu.Unlock()
			tr := &authRejectTransport{fakeBLETransport: fakeBLETransport{maxWrite: 244}}
			p := NewBLEStreamPort(tr)
			tr.port = p
			return p, nil
		},
		ListPorts: func() ([]slaprf.PortInfo, error) {
			return []slaprf.PortInfo{BLEPortInfoFor(BLEAdvertInfo{Fingerprint: 0xDEADBEEF, HasFlags: true, Paired: true}, "SlapRF H1")}, nil
		},
	})
	mgr := slaprf.NewManager(slaprf.Config{Transport: bleTr, Store: store})
	defer mgr.Close()

	snap, connErr := mgr.Connect(0, "ble:DEADBEEF")
	if connErr == nil || !strings.Contains(connErr.Error(), "paired to another device") {
		t.Fatalf("expected auth_mismatch error from Connect, got snap=%+v err=%v", snap, connErr)
	}
	if snap.Connected || snap.Reconnecting || !snap.ReconnectFailed {
		t.Fatalf("unexpected slot state after auth_mismatch: %+v", snap)
	}

	time.Sleep(1400 * time.Millisecond)
	openMu.Lock()
	opens := openCount
	openMu.Unlock()
	if opens != 1 {
		t.Fatalf("expected 1 open attempt (no auto-reconnect on auth_mismatch), got %d", opens)
	}

	var savedBLE map[string]string
	_, _ = store.GetJSON("hw.ble_targets", &savedBLE)
	if len(savedBLE) != 0 {
		t.Fatalf("expected rejected Hub removed from hw.ble_targets, got %+v", savedBLE)
	}
}

type simpleUSBPort struct {
	mu     sync.Mutex
	rx     bytes.Buffer
	closed bool
}

func (p *simpleUSBPort) Read(b []byte) (int, error) {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return 0, io.EOF
	}
	if p.rx.Len() > 0 {
		n, err := p.rx.Read(b)
		p.mu.Unlock()
		return n, err
	}
	p.mu.Unlock()
	time.Sleep(15 * time.Millisecond)
	return 0, errors.New("read timeout")
}
func (p *simpleUSBPort) Write(b []byte) (int, error)          { return len(b), nil }
func (p *simpleUSBPort) Close() error                         { p.mu.Lock(); p.closed = true; p.mu.Unlock(); return nil }
func (p *simpleUSBPort) SetDTR(bool) error                    { return nil }
func (p *simpleUSBPort) SetRTS(bool) error                    { return nil }
func (p *simpleUSBPort) SetReadTimeout(time.Duration) error   { return nil }
func (p *simpleUSBPort) ResetInputBuffer() error              { return nil }
func (p *simpleUSBPort) ResetOutputBuffer() error             { return nil }

func TestDedicatedUSBAndBluetoothManagersSwitchCleanly(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "dual.db")
	store, err := storage.OpenBoltStore(dbPath)
	if err != nil {
		t.Fatalf("OpenBoltStore: %v", err)
	}
	defer store.Close()

	eng := tracker.NewRealEngine()
	hubRx := ingest.NewHubFrameDecoder(eng)
	timers := slaprf.NewKnownTimerRegistry(store)

	usbMgr := slaprf.NewManager(slaprf.Config{
		Transport: slaprfusb.NewTransport(slaprfusb.Config{
			OpenPort: func(string, int) (firmware.SerialPort, error) {
				up := &simpleUSBPort{}
				up.rx.WriteString("@{\"t\":\"status\",\"fw\":\"0.4.0\",\"role\":1,\"fp\":\"11112222\",\"label\":\"H1-USB\",\"slot\":1,\"channel\":1}\n")
				return up, nil
			},
			ListPorts: func() ([]slaprf.PortInfo, error) {
				return []slaprf.PortInfo{{Name: "COM7", IsUSB: true, VID: "303A", IsEspressif: true}}, nil
			},
		}),
		Timers:          timers,
		Engine:          eng,
		HubRx:           hubRx,
		SkipHubOutbound: true,
		Store:           store,
	})
	defer usbMgr.Close()

	bleMgr := slaprf.NewManager(slaprf.Config{
		Transport: NewTransport(Config{
			OpenPort: func(string, int) (firmware.SerialPort, error) {
				tr := &echoHubTransport{fakeBLETransport: fakeBLETransport{maxWrite: 244}}
				p := NewBLEStreamPort(tr)
				tr.port = p
				return p, nil
			},
			ListPorts: func() ([]slaprf.PortInfo, error) {
				return []slaprf.PortInfo{BLEPortInfoFor(BLEAdvertInfo{Fingerprint: 0xCAFE1234, Role: 1, HasFlags: true, Paired: true}, "SlapRF H1")}, nil
			},
		}),
		Timers:          timers,
		Engine:          eng,
		HubRx:           hubRx,
		SkipHubOutbound: true,
		Store:           store,
	})
	defer bleMgr.Close()

	hubRx.SetOutboundSender(func(pkt []byte) {
		if eng.TimingHardwareMode() == domain.HardwareModeSlapRFBLE {
			bleMgr.SendNetChannelsFrame(pkt)
		} else {
			usbMgr.SendNetChannelsFrame(pkt)
		}
	})

	usbMgr.SetActive(true, false)
	bleMgr.SetActive(false, false)
	if _, err := usbMgr.Connect(0, "COM7"); err != nil {
		t.Fatalf("usbMgr.Connect COM7: %v", err)
	}

	// Switch to Bluetooth mode: USB suspends, BLE activates.
	eng.SetTimingHardwareMode(domain.HardwareModeSlapRFBLE, false)
	usbMgr.SetActive(false, false)
	bleMgr.SetActive(true, false)
	if usbMgr.Snapshot().Slots[0].Connected {
		t.Fatalf("expected USB slot closed when switching to Bluetooth")
	}
	if _, err := bleMgr.Connect(0, "ble:CAFE1234"); err != nil {
		t.Fatalf("bleMgr.Connect ble:CAFE1234: %v", err)
	}

	// Switch back to USB mode: BLE suspends, USB auto-restores COM7!
	eng.SetTimingHardwareMode(domain.HardwareModeSlapRF, false)
	bleMgr.SetActive(false, false)
	usbMgr.SetActive(true, false)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && !usbMgr.Snapshot().Slots[0].Connected {
		time.Sleep(15 * time.Millisecond)
	}
	if s0 := usbMgr.Snapshot().Slots[0]; !s0.Connected || s0.PortName != "COM7" {
		t.Fatalf("expected COM7 auto-restored on usbMgr, got %+v", s0)
	}
	if bleMgr.Snapshot().Slots[0].Connected {
		t.Fatalf("expected bleMgr disconnected while in USB mode")
	}
}

func TestBLEMultiGateAndSynthesizedLive2(t *testing.T) {
	eng := tracker.NewRealEngine()
	eng.SetTimingHardwareMode(domain.HardwareModeSlapRFBLE, false)
	_ = eng.UpdatePilotSlot(domain.PilotSlot{
		SlotIndex: 1,
		Callsign:  "OneEye",
		Band:      domain.BandRaceband,
		Channel:   8,
		Enabled:   true,
	})
	hubRx := ingest.NewHubFrameDecoder(eng)

	var activeStream *BLEStreamPort
	var activeTransport *echoHubTransport
	var trMu sync.Mutex

	bleTr := NewTransport(Config{
		OpenPort: func(_ string, _ int) (firmware.SerialPort, error) {
			tr := &echoHubTransport{fakeBLETransport: fakeBLETransport{maxWrite: 244}}
			p := NewBLEStreamPort(tr)
			tr.port = p
			trMu.Lock()
			activeTransport = tr
			activeStream = p
			trMu.Unlock()
			return p, nil
		},
	})
	mgr := slaprf.NewManager(slaprf.Config{Transport: bleTr, Engine: eng, HubRx: hubRx})
	defer mgr.Close()

	if _, err := mgr.Connect(0, "ble:CAFE1234"); err != nil {
		t.Fatalf("Connect ble:CAFE1234: %v", err)
	}

	var liveEvents int
	var liveMu sync.Mutex
	mgr.Subscribe(func(ev slaprf.Event) {
		if ev.Type == "live" {
			liveMu.Lock()
			liveEvents++
			liveMu.Unlock()
		}
	})

	if err := mgr.SendCommand(0, "LIVE 2"); err != nil {
		t.Fatalf("SendCommand LIVE 2: %v", err)
	}

	makeWinRec := func(slot, seq, ch0Code byte) []byte {
		f := make([]byte, 7+9+1)
		f[0] = 0xC5
		f[1] = 0x60
		f[2] = slot
		f[3] = 1
		nf := int8(-91)
		f[6] = byte(nf)
		f[7] = seq
		f[8] = ch0Code
		for ch := 1; ch < 8; ch++ {
			f[8+ch] = 74
		}
		var crc byte
		for i := 0; i < len(f)-1; i++ {
			crc ^= f[i]
		}
		f[len(f)-1] = crc
		return append([]byte{0x1E, byte(len(f))}, f...)
	}

	trMu.Lock()
	stream := activeStream
	_ = activeTransport
	trMu.Unlock()
	stream.Deliver(makeWinRec(1, 10, 82))
	stream.Deliver(makeWinRec(1, 11, 84))

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		liveMu.Lock()
		got := liveEvents
		liveMu.Unlock()
		if got >= 2 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	liveMu.Lock()
	gotLive := liveEvents
	liveMu.Unlock()
	if gotLive < 2 {
		t.Fatalf("expected synthesized LIVE 2 events from 0xC5 0x60 windows, got %d", gotLive)
	}
}

func TestBLESpokeSlotBoundFromStatusWithoutBinaryHello(t *testing.T) {
	eng := tracker.NewRealEngine()
	eng.SetTimingHardwareMode(domain.HardwareModeSlapRFBLE, false)
	_ = eng.UpdatePilotSlot(domain.PilotSlot{
		SlotIndex: 1,
		Callsign:  "OneEye",
		Band:      domain.BandRaceband,
		Channel:   7,
		Enabled:   true,
	})
	hubRx := ingest.NewHubFrameDecoder(eng)

	var activeStream *BLEStreamPort
	var trMu sync.Mutex

	bleTr := NewTransport(Config{
		OpenPort: func(_ string, _ int) (firmware.SerialPort, error) {
			tr := &echoHubTransport{fakeBLETransport: fakeBLETransport{maxWrite: 244}}
			p := NewBLEStreamPort(tr)
			tr.port = p
			trMu.Lock()
			activeStream = p
			trMu.Unlock()
			return p, nil
		},
	})
	mgr := slaprf.NewManager(slaprf.Config{Transport: bleTr, Engine: eng, HubRx: hubRx})
	defer mgr.Close()

	if _, err := mgr.Connect(0, "ble:CAFE1234"); err != nil {
		t.Fatalf("Connect ble:CAFE1234: %v", err)
	}

	trMu.Lock()
	stream := activeStream
	trMu.Unlock()

	// Deliver Hub 1 Hz STATUS? announcing Spoke T3 in TDMA slot 4 (53E049F7) WITHOUT sending a
	// binary 0xC5 0x5A HELLO frame for slot 4.
	statusLine := `@{"t":"status","fw":"v0.1.6","role":1,"fp":"CAFE1234","label":"H1","sweepHz":50,"slot":1,"spokes":[{"slot":2,"fp":"7B1C4D9C","label":"T2","msAgo":6,"frames":100,"seq":10},{"slot":3,"fp":"D3FEDE5D","label":"T1","msAgo":5,"frames":100,"seq":20},{"slot":4,"fp":"53E049F7","label":"T3","msAgo":4,"frames":100,"seq":30}]}` + "\n"
	stream.Deliver([]byte(statusLine))

	var t3TimerID uint8
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		for _, dt := range eng.DetectedTimersSnapshot() {
			if dt.Fingerprint == "53E049F7" {
				t3TimerID = dt.TimerID
				break
			}
		}
		if t3TimerID != 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if t3TimerID == 0 {
		t.Fatalf("expected Spoke T3 (53E049F7) registered from STATUS?, got %+v", eng.DetectedTimersSnapshot())
	}

	// Assign T3 to Sector Gate #2 on the active track.
	if _, err := eng.AddGate("", t3TimerID); err != nil {
		t.Fatalf("AddGate(T3): %v", err)
	}

	makeWin4 := func(slot byte, baseSeq byte, ch0Dbm float32) []byte {
		samples := make([]domain.TimerTelemetryFrame, 4)
		for i := 0; i < 4; i++ {
			samples[i] = domain.TimerTelemetryFrame{
				SeqNum: uint32(baseSeq + byte(i)),
				RSSI:   [domain.MaxPilotPoolSize]float32{ch0Dbm, -127, -127, -127, -127, -127, -127, -127},
			}
		}
		pkt := ingest.EncodeWindowFrame(slot, 4100, -91, samples)
		return append([]byte{0x1E, byte(len(pkt))}, pkt...)
	}

	// Stream two overlapping 4-sample windows on slot 4 (seqs 40..43, then 42..45 -> 6 unique samples).
	stream.Deliver(makeWin4(4, 40, -54.5))
	// Push another 1 Hz STATUS? mid-stream to ensure BindSlotHello is idempotent and never resets seq dedupe.
	stream.Deliver([]byte(statusLine))
	stream.Deliver(makeWin4(4, 42, -52.0))

	var gotFrames uint64
	deadline = time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		for _, dt := range eng.DetectedTimersSnapshot() {
			if dt.TimerID == t3TimerID {
				gotFrames = dt.FramesRxCount
			}
		}
		if gotFrames >= 6 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if gotFrames != 6 {
		t.Fatalf("expected exactly 6 unique Engine RX samples for T3 (slot 4), got %d", gotFrames)
	}

	_, gates, _, _, _ := eng.StateSnapshot()
	var gate2Frames uint64
	var gate2Rssi float32
	for _, g := range gates {
		if g.AssignedTimerID == t3TimerID {
			gate2Frames = g.FramesRxCount
			gate2Rssi = g.LastRSSI[0]
		}
	}
	if gate2Frames != 6 || gate2Rssi < -60 {
		t.Fatalf("expected Gate bound to T3 to receive 6 samples with live RSSI, got frames=%d rssi=%.1f", gate2Frames, gate2Rssi)
	}
}

type selectiveAuthHubTransport struct {
	fakeBLETransport
	port        *BLEStreamPort
	expectedKey string
	authed      bool
	lineMu      sync.Mutex
	line        []byte
}

func (s *selectiveAuthHubTransport) WriteWithoutResponse(p []byte) error {
	if err := s.fakeBLETransport.WriteWithoutResponse(p); err != nil {
		return err
	}
	s.lineMu.Lock()
	defer s.lineMu.Unlock()
	for _, c := range p {
		if c != '\n' {
			s.line = append(s.line, c)
			continue
		}
		l := strings.TrimSpace(string(s.line))
		s.line = nil
		switch {
		case strings.HasPrefix(l, "AUTH "):
			got := strings.TrimSpace(strings.TrimPrefix(l, "AUTH "))
			pRef := s.port
			if got == s.expectedKey {
				s.authed = true
				go pRef.Deliver([]byte(`@{"t":"ok","cmd":"auth","paired":true,"claimed":false}` + "\n"))
			} else {
				go func() {
					pRef.Deliver([]byte(`@{"t":"err","code":"auth_mismatch","msg":"Hub is paired to another device."}` + "\n"))
					time.Sleep(25 * time.Millisecond)
					pRef.Disconnected(errors.New("remote terminated"))
				}()
			}
		case l == "STATUS?" && s.authed:
			pRef := s.port
			go pRef.Deliver([]byte(`@{"t":"status","fw":"v0.1.6","role":1,"fp":"EFE44224","label":"H1","sweepHz":50,"slot":1}` + "\n"))
		}
	}
	return nil
}

func TestBLEHistoricalHostKeyAutoRecoveryOnAuthMismatch(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "ble_recover.db")
	store, err := storage.OpenBoltStore(dbPath)
	if err != nil {
		t.Fatalf("OpenBoltStore: %v", err)
	}
	defer store.Close()

	const oldHubKey = "DEADBEEF0123456789ABCDEF01234567"
	const wrongNewKey = "FFFFFFFF000000001122334455667788"
	if err := store.PutJSON(storage.KeyBLEHostKey, wrongNewKey); err != nil {
		t.Fatalf("seed wrong key: %v", err)
	}
	f, err := os.OpenFile(dbPath, os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatalf("open db for historical page simulation: %v", err)
	}
	_, _ = f.WriteString(`hw.ble_host_key"` + oldHubKey + `"`)
	_ = f.Close()

	bleTr := NewTransport(Config{
		OpenPort: func(_ string, _ int) (firmware.SerialPort, error) {
			tr := &selectiveAuthHubTransport{
				fakeBLETransport: fakeBLETransport{maxWrite: 244},
				expectedKey:      oldHubKey,
			}
			p := NewBLEStreamPort(tr)
			tr.port = p
			return p, nil
		},
	})
	mgr := slaprf.NewManager(slaprf.Config{Transport: bleTr, Store: store})
	defer mgr.Close()

	snap, err := mgr.Connect(0, "ble:EFE44224")
	if err != nil {
		t.Fatalf("expected Connect to recover historical host key, got err: %v", err)
	}
	if !snap.Connected || mgr.HostAuthKey() != oldHubKey {
		t.Fatalf("expected connected=true and HostAuthKey=%s, got snap=%+v key=%s", oldHubKey, snap, mgr.HostAuthKey())
	}
}
