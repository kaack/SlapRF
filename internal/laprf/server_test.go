package laprf

import (
	"encoding/binary"
	"math"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"slaprf/internal/domain"
	"slaprf/internal/tracker"
)

// pipeClient is the "LiveTime" end of a net.Pipe whose other end is served by Server.ServeConn.
type pipeClient struct {
	t      *testing.T
	conn   net.Conn
	frames chan *Packet
}

func startSession(t *testing.T, srv *Server) *pipeClient {
	t.Helper()
	serverSide, clientSide := net.Pipe()
	done := make(chan struct{})
	go func() {
		srv.ServeConn(serverSide)
		close(done)
	}()
	c := &pipeClient{t: t, conn: clientSide, frames: make(chan *Packet, 256)}
	go c.readLoop()
	t.Cleanup(func() {
		_ = clientSide.Close()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Errorf("ServeConn did not return after the client closed")
		}
	})
	return c
}

func (c *pipeClient) readLoop() {
	defer close(c.frames)
	buf := make([]byte, 4096)
	var frame []byte
	in := false
	for {
		n, err := c.conn.Read(buf)
		for _, b := range buf[:n] {
			switch {
			case b == ByteSOR:
				in = true
				frame = append(frame[:0], b)
			case in:
				frame = append(frame, b)
				if b == ByteEOR {
					in = false
					if pkt, err := DecodeFrame(frame); err == nil {
						c.frames <- pkt
					}
				}
			}
		}
		if err != nil {
			return
		}
	}
}

func (c *pipeClient) send(p *Packet) {
	c.t.Helper()
	if _, err := c.conn.Write(p.Encode()); err != nil {
		c.t.Fatalf("write: %v", err)
	}
}

// waitFor returns the next packet of type rt, skipping others (e.g. 10 Hz STATUS frames).
func (c *pipeClient) waitFor(rt RecordType) *Packet {
	c.t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case p, ok := <-c.frames:
			if !ok {
				c.t.Fatalf("session closed while waiting for 0x%04X", uint16(rt))
			}
			if p.Type == rt {
				return p
			}
		case <-deadline:
			c.t.Fatalf("timed out waiting for 0x%04X", uint16(rt))
		}
	}
}

func field(p *Packet, sig uint8) []byte {
	for _, f := range p.Fields {
		if f.Signature == sig {
			return f.Data
		}
	}
	return nil
}

func TestServeConnTimeSyncAndSettings(t *testing.T) {
	eng := tracker.NewEngine()
	srv := NewServer(eng)
	c := startSession(t, srv)

	before := eng.NowUs()
	c.send(&Packet{Type: RecordTime})
	reply := c.waitFor(RecordTime)
	us := binary.LittleEndian.Uint64(field(reply, 0x02))
	if us < before || us > eng.NowUs() {
		t.Fatalf("time reply %d outside [%d, %d]", us, before, eng.NowUs())
	}

	c.send(&Packet{Type: RecordSettings})
	settings := c.waitFor(RecordSettings)
	if got := binary.LittleEndian.Uint16(field(settings, 0x22)); got != 100 {
		t.Fatalf("status interval = %d ms, want 100", got)
	}
}

func TestServeConnStatusHeartbeat(t *testing.T) {
	srv := NewServer(tracker.NewEngine())
	c := startSession(t, srv)
	start := time.Now()
	for i := 0; i < 3; i++ {
		c.waitFor(RecordStatus)
	}
	if el := time.Since(start); el < 2*StatusInterval {
		t.Fatalf("3 status frames in %v; heartbeat faster than 10 Hz", el)
	}
	eventually(t, func() bool { got := srv.Status(); return got.ConnectedClients == 1 && got.StatusFramesSent >= 3 })
}

func TestServeConnRFSetupUpdatesAllSlots(t *testing.T) {
	eng := tracker.NewRealEngine()
	srv := NewServer(eng)
	c := startSession(t, srv)

	req := &Packet{Type: RecordRFSetup}
	freqs := []uint16{5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917}
	for i, f := range freqs {
		req.AppendUint8(0x01, uint8(i+1))
		req.AppendUint16(0x20, 1)
		req.AppendUint16(0x21, uint16(i+1))
		req.AppendUint16(0x22, uint16(domain.BandRaceband))
		req.AppendFloat32(0x23, 2300) // LapRF scale -> -45 dBm
		req.AppendUint16(0x24, 3)
		req.AppendUint16(0x25, f)
	}
	c.send(req)
	reply := c.waitFor(RecordRFSetup)

	pilots, _, _, _, _ := eng.StateSnapshot()
	got := map[int]domain.PilotSlot{}
	for _, p := range pilots {
		got[p.SlotIndex] = p
	}
	for i, f := range freqs {
		p := got[i+1]
		if !p.Enabled || p.FrequencyMHz != f || p.Channel != uint8(i+1) {
			t.Fatalf("slot %d not applied: %+v", i+1, p)
		}
		if math.Abs(float64(p.EnterThreshold+45)) > 0.01 {
			t.Fatalf("slot %d threshold = %v, want -45", i+1, p.EnterThreshold)
		}
	}
	// The reply echoes the engine's slots (8 x 0x25 frequency fields).
	n := 0
	for _, f := range reply.Fields {
		if f.Signature == 0x25 {
			n++
		}
	}
	if n != domain.MaxPilotSlots {
		t.Fatalf("RF setup reply has %d frequency fields, want %d", n, domain.MaxPilotSlots)
	}
	if srv.Status().LastRFSetupSync.IsZero() {
		t.Fatalf("LastRFSetupSync not recorded")
	}
}

func TestServeConnStateCtrlArmsActiveEngine(t *testing.T) {
	eng := tracker.NewEngine()
	srv := NewServer(eng)
	c := startSession(t, srv)

	for _, armed := range []bool{false, true} {
		p := &Packet{Type: RecordStateCtrl}
		var v uint8
		if armed {
			v = 1
		}
		p.AppendUint8(0x20, v)
		c.send(p)
		// StateCtrl has no reply; a time-sync round trip proves it was processed.
		c.send(&Packet{Type: RecordTime})
		c.waitFor(RecordTime)
		if eng.IsRaceArmed() != armed {
			t.Fatalf("armed = %v, want %v", eng.IsRaceArmed(), armed)
		}
	}
}

func TestDetectionsFollowActiveEngine(t *testing.T) {
	simEng, realEng := tracker.NewEngine(), tracker.NewRealEngine()
	var simActive atomic.Bool
	simActive.Store(true)
	srv := NewServer(simEng)
	srv.Follow(func() *tracker.Engine {
		if simActive.Load() {
			return simEng
		}
		return realEng
	}, simEng, realEng)
	c := startSession(t, srv)
	eventually(t, func() bool { return srv.Status().ConnectedClients == 1 })

	realFwd := &engineCrossingForwarder{server: srv, engine: realEng}
	simFwd := &engineCrossingForwarder{server: srv, engine: simEng}

	// Sector crossing: never forwarded.
	simFwd.OnGateCrossing(domain.GateCrossingEvent{SlotIndex: 2, IsStartFinish: false})
	// Real-engine crossing while simulation is active: ignored.
	realFwd.OnGateCrossing(domain.GateCrossingEvent{SlotIndex: 3, IsStartFinish: true, PassingNumber: 9})
	// Active (sim) start/finish crossing: forwarded.
	simFwd.OnGateCrossing(domain.GateCrossingEvent{SlotIndex: 4, IsStartFinish: true, PassingNumber: 1, TimestampUs: 123})
	d := c.waitFor(RecordDetection)
	if field(d, 0x01)[0] != 4 || binary.LittleEndian.Uint64(field(d, 0x02)) != 123 {
		t.Fatalf("unexpected detection %+v", d)
	}

	// Switch to real hardware: now real crossings are forwarded.
	simActive.Store(false)
	realFwd.OnGateCrossing(domain.GateCrossingEvent{SlotIndex: 5, IsStartFinish: true, PassingNumber: 2})
	d = c.waitFor(RecordDetection)
	if field(d, 0x01)[0] != 5 {
		t.Fatalf("expected slot 5 detection from real engine, got %+v", d)
	}
	eventually(t, func() bool { return srv.Status().DetectionsSent == 2 })
}

func TestServeConnSessionsAreIndependent(t *testing.T) {
	srv := NewServer(tracker.NewEngine())
	a := startSession(t, srv)
	b := startSession(t, srv)
	eventually(t, func() bool { return srv.Status().ConnectedClients == 2 })
	a.send(&Packet{Type: RecordTime})
	a.waitFor(RecordTime)
	b.send(&Packet{Type: RecordTime})
	b.waitFor(RecordTime)

	_ = a.conn.Close()
	eventually(t, func() bool { return srv.Status().ConnectedClients == 1 })
	b.send(&Packet{Type: RecordTime})
	b.waitFor(RecordTime)
}

func eventually(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("condition not met within 2s")
		}
		time.Sleep(5 * time.Millisecond)
	}
}
