package usb

import (
	"bytes"
	"encoding/binary"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"slaprf/internal/domain"
	"slaprf/internal/firmware"
	"slaprf/internal/ingest"
	"slaprf/internal/slaprf"
	"slaprf/internal/storage"
	"slaprf/internal/tracker"
)

type fakeUSBPort struct {
	mu      sync.Mutex
	rx      bytes.Buffer
	tx      bytes.Buffer
	closed  bool
	dtrHist []bool
	rtsHist []bool
}

func (p *fakeUSBPort) pushRx(data []byte) {
	p.mu.Lock()
	p.rx.Write(data)
	p.mu.Unlock()
}

func (p *fakeUSBPort) txString() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.tx.String()
}

func (p *fakeUSBPort) Read(b []byte) (int, error) {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return 0, errors.New("port closed")
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

func (p *fakeUSBPort) Write(b []byte) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return 0, errors.New("port closed")
	}
	return p.tx.Write(b)
}

func (p *fakeUSBPort) Close() error {
	p.mu.Lock()
	p.closed = true
	p.mu.Unlock()
	return nil
}

func (p *fakeUSBPort) SetDTR(v bool) error {
	p.mu.Lock()
	p.dtrHist = append(p.dtrHist, v)
	p.mu.Unlock()
	return nil
}

func (p *fakeUSBPort) SetRTS(v bool) error {
	p.mu.Lock()
	p.rtsHist = append(p.rtsHist, v)
	p.mu.Unlock()
	return nil
}

func (p *fakeUSBPort) SetReadTimeout(time.Duration) error { return nil }
func (p *fakeUSBPort) ResetInputBuffer() error            { return nil }
func (p *fakeUSBPort) ResetOutputBuffer() error           { return nil }

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
	f[9] = 100
	copy(f[10:34], []byte(label))
	var crc byte
	for i := 0; i < 35; i++ {
		crc ^= f[i]
	}
	f[35] = crc
	return f
}

func buildSingleTelemetryFrame(slot uint8, seq uint8, rssi float32) []byte {
	f := make([]byte, 16)
	f[0] = 0xC5
	f[1] = ingest.FrameMagicSingle
	f[2] = slot
	f[3] = seq
	binary.LittleEndian.PutUint16(f[4:6], 4980)
	var floor int8 = -92
	f[6] = byte(floor)
	code := ingest.EncodeHalfDbm(rssi)
	for ch := 0; ch < 8; ch++ {
		f[7+ch] = code
	}
	var crc byte
	for i := 0; i < 15; i++ {
		crc ^= f[i]
	}
	f[15] = crc
	return f
}

func TestUSBManagerDemuxesHubFramesStatusAndPushesNetChannels(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "test.db")
	store, err := storage.OpenBoltStore(dbPath)
	if err != nil {
		t.Fatalf("OpenBoltStore: %v", err)
	}
	defer store.Close()

	eng := tracker.NewRealEngine()
	hubRx := ingest.NewHubFrameDecoder(eng)

	fp := &fakeUSBPort{}
	fp.pushRx(buildRecordPacket(buildHelloFrame(1, firmware.RoleHubTimer, 0xCAFE1234, "H1-USB")))
	fp.pushRx(buildRecordPacket(buildHelloFrame(2, firmware.RoleSpokeTimer, 0xBEEF5678, "S1-GATE")))
	fp.pushRx(buildRecordPacket(buildSingleTelemetryFrame(2, 7, -58)))

	built, err := firmware.PatchImage(firmware.SyntheticBase(), firmware.TimerConfig{
		Role:        firmware.RoleHubTimer,
		TimerLabel:  "H1-USB",
		Fingerprint: 0xCAFE1234,
	})
	if err != nil {
		t.Fatalf("firmware.PatchImage: %v", err)
	}
	idx := bytes.Index(built.Bytes, []byte("SLAPRF02"))
	fp.pushRx(built.Bytes[idx : idx+160])
	fp.pushRx([]byte("@{\"t\":\"status\",\"fw\":\"0.4.0\",\"role\":1,\"fp\":\"CAFE1234\",\"label\":\"H1-USB\",\"slot\":1,\"channel\":1}\n"))

	tr := NewTransport(Config{
		OpenPort: func(portName string, baud int) (firmware.SerialPort, error) {
			return fp, nil
		},
		ListPorts: func() ([]slaprf.PortInfo, error) {
			return []slaprf.PortInfo{{Name: "COM9", IsUSB: true, VID: "303A", IsEspressif: true}}, nil
		},
	})
	mgr := slaprf.NewManager(slaprf.Config{
		Transport: tr,
		Engine:    eng,
		HubRx:     hubRx,
		Store:     store,
	})
	defer mgr.Close()

	// Reject ble:* targets on the USB transport!
	if _, rejErr := mgr.Connect(0, "ble:CAFE1234"); rejErr == nil {
		t.Fatalf("expected USB transport to reject ble: target")
	}

	var telemetryFrames int
	var telMu sync.Mutex
	eng.Subscribe(&telemetryCounter{onFrame: func() {
		telMu.Lock()
		telemetryFrames++
		telMu.Unlock()
	}})

	snap, err := mgr.Connect(0, "COM9")
	if err != nil {
		t.Fatalf("Connect failed: %v", err)
	}
	if !snap.Connected {
		t.Fatalf("expected slot 0 connected")
	}

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		detected := eng.DetectedTimersSnapshot()
		tx := fp.txString()
		pool := mgr.Snapshot()
		spokeReady := false
		for _, dt := range detected {
			if dt.Fingerprint == "BEEF5678" && dt.BatteryMv == 4980 {
				spokeReady = true
			}
		}
		if len(detected) >= 2 && spokeReady && strings.Contains(tx, "NETCHANNELS ") && pool.Slots[0].LastConfig != nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	detected := eng.DetectedTimersSnapshot()
	if len(detected) < 2 {
		t.Fatalf("expected Hub + Spoke registered in realEngine, got %+v", detected)
	}

	var spokeID uint8
	for _, dt := range detected {
		if dt.Fingerprint == "BEEF5678" {
			spokeID = dt.TimerID
			if dt.BatteryMv != 4980 {
				t.Fatalf("expected Spoke battery 4980mV from telemetry frame, got %d", dt.BatteryMv)
			}
		}
	}
	if spokeID == 0 {
		t.Fatalf("expected Spoke BEEF5678 in DetectedTimers, got %+v", detected)
	}

	if _, err := eng.AddGate("Start / Finish", spokeID); err != nil {
		t.Fatalf("AddGate: %v", err)
	}
	fp.pushRx(buildRecordPacket(buildSingleTelemetryFrame(2, 8, -51)))
	deadline = time.Now().Add(1 * time.Second)
	for time.Now().Before(deadline) {
		telMu.Lock()
		gotTel := telemetryFrames
		telMu.Unlock()
		if gotTel >= 1 {
			break
		}
		time.Sleep(15 * time.Millisecond)
	}

	telMu.Lock()
	if telemetryFrames < 1 {
		t.Fatalf("expected Hub binary frame ingested into realEngine gate, got %d", telemetryFrames)
	}
	telMu.Unlock()

	tx := fp.txString()
	if !strings.Contains(tx, "NETCHANNELS ") {
		t.Fatalf("expected NETCHANNELS command pushed to Hub over USB, got TX: %q", tx)
	}

	pool := mgr.Snapshot()
	if len(pool.KnownTimers) == 0 || pool.KnownTimers[0].FP != "CAFE1234" {
		t.Fatalf("expected CAFE1234 recorded in KnownTimers, got %+v", pool.KnownTimers)
	}
	if pool.Slots[0].LastConfig == nil || pool.Slots[0].LastConfig.TimerLabel != "H1-USB" {
		t.Fatalf("expected SLAPRF02 config parsed on slot 0, got %+v", pool.Slots[0].LastConfig)
	}
}

func TestConnectCancellationClearsConnectingWithoutError(t *testing.T) {
	openStarted := make(chan struct{})
	blockCh := make(chan struct{})
	tr := NewTransport(Config{
		OpenPort: func(string, int) (firmware.SerialPort, error) {
			close(openStarted)
			<-blockCh
			return nil, errors.New("late open error")
		},
	})
	mgr := slaprf.NewManager(slaprf.Config{Transport: tr})
	defer mgr.Close()
	defer close(blockCh)

	errCh := make(chan error, 1)
	go func() {
		_, err := mgr.Connect(0, "/dev/ttyACM0")
		errCh <- err
	}()

	<-openStarted
	mid := mgr.Snapshot().Slots[0]
	if !mid.Connecting || mid.ConnectStatus == "" {
		t.Fatalf("expected live connecting snapshot, got %+v", mid)
	}

	if err := mgr.Disconnect(0); err != nil {
		t.Fatalf("Disconnect (cancel): %v", err)
	}
	select {
	case err := <-errCh:
		if !errors.Is(err, slaprf.ErrConnectCancelled) {
			t.Fatalf("expected ErrConnectCancelled, got %v", err)
		}
	case <-time.After(1 * time.Second):
		t.Fatalf("Connect did not abort promptly on Disconnect")
	}

	after := mgr.Snapshot().Slots[0]
	if after.Connecting || after.Connected || after.LastError != "" || after.PortName != "" {
		t.Fatalf("expected clean idle slot after cancel, got %+v", after)
	}
}

type telemetryCounter struct {
	onFrame func()
}

func (c *telemetryCounter) OnTelemetryFrame(domain.TimerTelemetryFrame) {
	if c.onFrame != nil {
		c.onFrame()
	}
}
func (c *telemetryCounter) OnGateCrossing(domain.GateCrossingEvent)                     {}
func (c *telemetryCounter) OnDetectionFiltered(domain.FilteredDetection)                {}
func (c *telemetryCounter) OnLapCompleted(domain.LapRecord, []domain.PilotTrackSummary) {}
func (c *telemetryCounter) OnConfigUpdated([]domain.PilotSlot, []domain.TrackGate)      {}
