package laprf

import (
	"encoding/binary"
	"fmt"
	"math"
	"net"
	"strings"
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

	before := (eng.NowUs() / 1000) * 1000
	c.send(&Packet{Type: RecordTime})
	reply := c.waitFor(RecordTime)
	us := binary.LittleEndian.Uint64(field(reply, 0x02))
	after := (eng.NowUs()/1000 + 1) * 1000
	if us%1000 != 0 || us < before || us > after {
		t.Fatalf("time reply %d not millisecond-quantized in [%d, %d]", us, before, after)
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
		req.AppendFloat32(0x23, 800) // LapRF Standard5Inch preset -> -58 dBm
		req.AppendUint16(0x24, 59)
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
		if math.Abs(float64(p.EnterThreshold+58)) > 0.01 {
			t.Fatalf("slot %d threshold = %v, want -58", i+1, p.EnterThreshold)
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
		c.send(&Packet{Type: RecordTime})
		c.waitFor(RecordTime)
		if srv.Status().RaceArmedByHost != armed {
			t.Fatalf("RaceArmedByHost = %v, want %v", srv.Status().RaceArmedByHost, armed)
		}
		if !eng.IsRaceArmed() {
			t.Fatalf("SlapRF local engine must remain armed even when LapRF host disarms between heats")
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

func TestFPVTracksideEndToEndFlow(t *testing.T) {
	eng := tracker.NewEngine()
	srv := NewServer(eng)
	c := startSession(t, srv)

	// 1. FPVTrackside SetListeningFrequencies: sends 0x01, 0x20, 0x23 (800), 0x24 (59), 0x25 (freq) without 0x21/0x22.
	rfReq := &Packet{Type: RecordRFSetup}
	heatFreqs := []uint16{5658, 5732, 5806, 5917, 0, 0, 0, 0}
	for i, f := range heatFreqs {
		rfReq.AppendUint8(0x01, uint8(i+1))
		var en uint16
		if f > 0 {
			en = 1
		}
		rfReq.AppendUint16(0x20, en)
		rfReq.AppendFloat32(0x23, 800)
		rfReq.AppendUint16(0x24, 59)
		rfReq.AppendUint16(0x25, f)
	}
	c.send(rfReq)
	rfReply := c.waitFor(RecordRFSetup)
	for _, f := range rfReply.Fields {
		if f.Signature == 0x23 {
			t.Fatalf("RFSetup reply must not include 0x23 float threshold (breaks LapRFProtocol.cs stream alignment)")
		}
	}

	// 2. FPVTrackside StartDetection: SetMinLapTime -> RequestRTCTime (2x) -> StartRace (0xDA04, 0x20=1).
	settingsReq := &Packet{Type: RecordSettings}
	settingsReq.AppendUint32(0x26, 1000)
	c.send(settingsReq)
	settingsReply := c.waitFor(RecordSettings)
	if got := binary.LittleEndian.Uint32(field(settingsReply, 0x26)); got != 1000 {
		t.Fatalf("minLapTime echo = %d, want 1000", got)
	}

	var rtcSamples [2]uint64
	var respTimes [2]time.Time
	for i := 0; i < 2; i++ {
		timeReq := &Packet{Type: RecordTime}
		timeReq.Fields = append(timeReq.Fields, TLVField{Signature: 0x02, Data: nil})
		c.send(timeReq)
		timeReply := c.waitFor(RecordTime)
		respTimes[i] = time.Now()
		rtcSamples[i] = binary.LittleEndian.Uint64(field(timeReply, 0x02))
		if !strings.HasSuffix(fmt.Sprintf("%d", rtcSamples[i]), "000") {
			t.Fatalf("RTC sample %d (%d) must end with '000' for FPVTrackside divideBy1000 heuristic", i, rtcSamples[i])
		}
	}
	epoch0 := respTimes[0].Add(-time.Duration(rtcSamples[0]) * time.Microsecond)
	epoch1 := respTimes[1].Add(-time.Duration(rtcSamples[1]) * time.Microsecond)
	rtcEpoch := epoch0.Add(epoch1.Sub(epoch0) / 2)

	startReq := &Packet{Type: RecordStateCtrl}
	startReq.AppendUint8(0x20, 1)
	c.send(startReq)
	statusReply := c.waitFor(RecordStatus)
	if volt := binary.LittleEndian.Uint16(field(statusReply, 0x21)); volt < 11500 {
		t.Fatalf("status voltage = %d mV, want >= 11500 mV", volt)
	}

	// 3. Simulate a pilot crossing the Start/Finish gate (Gate 1) and verify the passing record.
	nowUs := eng.NowUs()
	for step := uint64(0); step < 40; step++ {
		rssi := float32(-85.0)
		if step >= 10 && step <= 25 {
			rssi = -38.0
		}
		var frame domain.TimerTelemetryFrame
		frame.TimerID = 2 // Start/Finish gate in DefaultTrackGates has AssignedTimerID = 2
		frame.TimestampUs = nowUs + step*25_000
		for k := range frame.RSSI {
			frame.RSSI[k] = -85.0
		}
		frame.RSSI[0] = rssi // Slot 1 (5658 MHz)
		eng.IngestTelemetryFrame(frame)
	}

	det := c.waitFor(RecordDetection)
	if len(det.Fields) < 4 || det.Fields[len(det.Fields)-1].Signature != 0x02 {
		t.Fatalf("detection record must have 0x02 (RTC_TIME) as final field, got %+v", det.Fields)
	}
	slotID := field(det, 0x01)[0]
	rtcTimeUs := binary.LittleEndian.Uint64(field(det, 0x02))
	peak := binary.LittleEndian.Uint16(field(det, 0x22))
	if slotID != 1 || peak == 0 {
		t.Fatalf("unexpected detection slot=%d peak=%d", slotID, peak)
	}
	detectionWallTime := rtcEpoch.Add(time.Duration(float64(rtcTimeUs)/1000.0) * time.Millisecond)
	if diff := time.Since(detectionWallTime).Abs(); diff > 5*time.Second {
		t.Fatalf("FPVTrackside computed detectionTime %v is %v from Now (exceeds 30s sanity window)", detectionWallTime, diff)
	}
}

func TestFPVTracksideIMD6AndModeSwitchMidRace(t *testing.T) {
	simEng, realEng := tracker.NewEngine(), tracker.NewRealEngine()
	// Simulate Restored states with hours-apart ElapsedUs (matching real browser IndexedDB state: 29,852s vs 16,014s).
	realEng.RestoreState(tracker.PersistedEngineState{ElapsedUs: 29_852_991_000, RaceArmed: true}, false)
	simEng.RestoreState(tracker.PersistedEngineState{
		ElapsedUs: 16_014_748_000,
		RaceArmed: true,
		Pilots:    domain.DefaultPilotSlots(),
		Gates:     domain.DefaultTrackGates(),
	}, true)

	var simActive atomic.Bool
	simActive.Store(false) // Start in Real mode when FPVTrackside stages the race
	srv := NewServer(simEng)
	srv.Follow(func() *tracker.Engine {
		if simActive.Load() {
			return simEng
		}
		return realEng
	}, simEng, realEng)

	c := startSession(t, srv)

	// 1. FPVTrackside sends its default 6-channel IMD6c list: R1 (5658), R2 (5695), F2 (5760), F4 (5800), R7 (5880), R8 (5917).
	rfReq := &Packet{Type: RecordRFSetup}
	imd6Freqs := []uint16{5658, 5695, 5760, 5800, 5880, 5917, 0, 0}
	for i, f := range imd6Freqs {
		rfReq.AppendUint8(0x01, uint8(i+1))
		var en uint16
		if f > 0 {
			en = 1
		}
		rfReq.AppendUint16(0x20, en)
		rfReq.AppendFloat32(0x23, 800)
		rfReq.AppendUint16(0x24, 59)
		rfReq.AppendUint16(0x25, f)
	}
	c.send(rfReq)
	c.waitFor(RecordRFSetup)

	// 2. FPVTrackside syncs RTC while still in Real mode.
	c.send(&Packet{Type: RecordTime})
	rtcReply := c.waitFor(RecordTime)
	rtcUs := binary.LittleEndian.Uint64(field(rtcReply, 0x02))
	rtcEpoch := time.Now().Add(-time.Duration(rtcUs) * time.Microsecond)

	// 3. User switches the app to Simulation mode mid-race!
	simActive.Store(true)

	// Verify simEng received all 6 IMD6c frequencies with exact Band + Channel (no R2/F2 or R8 collision blanking).
	wantBands := []domain.Band{domain.BandRaceband, domain.BandRaceband, domain.BandFatshark, domain.BandFatshark, domain.BandRaceband, domain.BandRaceband}
	wantChannels := []uint8{1, 2, 2, 4, 7, 8}
	simPilots, _, _, _, _ := simEng.StateSnapshot()
	for i := 0; i < 6; i++ {
		p := simPilots[i]
		if !p.Enabled || p.FrequencyMHz != imd6Freqs[i] || p.Band != wantBands[i] || p.Channel != wantChannels[i] {
			t.Fatalf("simEng slot %d mismatch: got Enabled=%v Band=%d Ch=%d Freq=%d, want Enabled=true Band=%d Ch=%d Freq=%d",
				i+1, p.Enabled, p.Band, p.Channel, p.FrequencyMHz, wantBands[i], wantChannels[i], imd6Freqs[i])
		}
	}
	for i := 6; i < 8; i++ {
		p := simPilots[i]
		if p.Enabled || p.FrequencyMHz != 0 || p.Channel != 0 {
			t.Fatalf("simEng slot %d should be disabled: %+v", i+1, p)
		}
	}

	// 4. Emit a crossing from simEng and verify its timestamp aligns with the RTCEpoch captured in Real mode.
	nowUs := simEng.NowUs()
	for step := uint64(0); step < 40; step++ {
		rssi := float32(-85.0)
		if step >= 10 && step <= 25 {
			rssi = -38.0
		}
		var frame domain.TimerTelemetryFrame
		frame.TimerID = 2
		frame.TimestampUs = nowUs + step*25_000
		for k := range frame.RSSI {
			frame.RSSI[k] = -85.0
		}
		frame.RSSI[1] = rssi // Slot 2 (R2 5695 MHz)
		simEng.IngestTelemetryFrame(frame)
	}

	det := c.waitFor(RecordDetection)
	detSlot := field(det, 0x01)[0]
	detRtcUs := binary.LittleEndian.Uint64(field(det, 0x02))
	if detSlot != 2 {
		t.Fatalf("expected detection on slot 2, got %d", detSlot)
	}
	detectionWallTime := rtcEpoch.Add(time.Duration(float64(detRtcUs)/1000.0) * time.Millisecond)
	if diff := time.Since(detectionWallTime).Abs(); diff > 5*time.Second {
		t.Fatalf("detection after mode switch is Out of Time Range: diff=%v (rtcUs=%d, detRtcUs=%d)", diff, rtcUs, detRtcUs)
	}
}

func TestLapRFPassthroughWhenLocalTimingOff(t *testing.T) {
	eng := tracker.NewEngine()
	srv := NewServer(eng)
	c := startSession(t, srv)

	// Enable Slot 1 (R1 5658 MHz) via LiveTime RF_SETUP just like a real LapRF client session.
	rfReq := &Packet{Type: RecordRFSetup}
	rfReq.AppendUint8(0x01, 1)
	rfReq.AppendUint16(0x20, 1)
	rfReq.AppendFloat32(0x23, 800)
	rfReq.AppendUint16(0x24, 59)
	rfReq.AppendUint16(0x25, 5658)
	c.send(rfReq)
	c.waitFor(RecordRFSetup)

	feedStartCrossing := func(baseUs uint64) {
		for step := uint64(0); step < 40; step++ {
			rssi := float32(-85.0)
			if step >= 10 && step <= 25 {
				rssi = -36.0
			}
			var frame domain.TimerTelemetryFrame
			frame.TimerID = 2 // Start/Finish gate
			frame.TimestampUs = baseUs + step*25_000
			for k := range frame.RSSI {
				frame.RSSI[k] = -85.0
			}
			frame.RSSI[0] = rssi // Slot 1
			eng.IngestTelemetryFrame(frame)
		}
	}

	// Mode 1: Pure passthrough mode ("Timing off" in SlapRF).
	// No local laps or crossings are recorded in SlapRF, but LapRF client still receives 0xDA09 passing records.
	eng.SetRaceArmed(false)
	t0 := eng.NowUs()
	feedStartCrossing(t0)
	det1 := c.waitFor(RecordDetection)
	if gotSlot := field(det1, 0x01)[0]; gotSlot != 1 {
		t.Fatalf("passthrough detection #1 slot = %d, want 1", gotSlot)
	}
	if passNum := binary.LittleEndian.Uint32(field(det1, 0x21)); passNum != 1 {
		t.Fatalf("passthrough detection #1 passingNumber = %d, want 1", passNum)
	}

	feedStartCrossing(t0 + 15_000_000)
	det2 := c.waitFor(RecordDetection)
	if passNum := binary.LittleEndian.Uint32(field(det2, 0x21)); passNum != 2 {
		t.Fatalf("passthrough detection #2 passingNumber = %d, want 2", passNum)
	}

	_, _, laps, crossings, _ := eng.StateSnapshot()
	if len(laps) != 0 || len(crossings) != 0 {
		t.Fatalf("expected 0 local laps and 0 local crossings in passthrough mode, got %d laps and %d crossings", len(laps), len(crossings))
	}

	// Mode 2: Normal companion mode ("Timing on" in SlapRF).
	// Both SlapRF local timing and LapRF 0xDA09 passing records are active.
	eng.SetRaceArmed(true)
	feedStartCrossing(t0 + 30_000_000)
	c.waitFor(RecordDetection)
	feedStartCrossing(t0 + 45_000_000)
	c.waitFor(RecordDetection)

	_, _, laps, crossings, _ = eng.StateSnapshot()
	if len(crossings) != 2 || len(laps) != 1 {
		t.Fatalf("expected 2 local crossings and 1 completed lap in companion mode, got %d crossings and %d laps", len(crossings), len(laps))
	}
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
