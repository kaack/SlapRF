package laprf

import (
	"encoding/binary"
	"io"
	"log"
	"math"
	"net"
	"sync"
	"time"

	"slaprf/internal/domain"
	"slaprf/internal/tracker"
)

// StatusInterval is the period of the STATUS (0xDA0A) heartbeat sent to every LiveTime session.
const StatusInterval = 100 * time.Millisecond // 10 Hz, as expected by LiveTime

// writeTimeout bounds every write to a session so one stalled peer can never block the engine.
const writeTimeout = 250 * time.Millisecond

// LiveTimeStatus is the diagnostic snapshot of the LapRF emulation (MultiGP LiveTime link).
//
// Whether the integration is enabled is a browser UI preference (the relay connection), not
// engine state, so it is intentionally not part of this struct.
type LiveTimeStatus struct {
	ConnectedClients int       `json:"connectedClients"`
	DetectionsSent   uint64    `json:"detectionsSent"`
	StatusFramesSent uint64    `json:"statusFramesSent"`
	LastRFSetupSync  time.Time `json:"lastRfSetupSync"`
	RaceArmedByHost  bool      `json:"raceArmedByHost"`
}

// Server emulates an ImmersionRC LapRF 8-Way Event Timer for MultiGP LiveTime.
//
// It does not own a network listener: each LiveTime connection is handed to ServeConn as an
// arbitrary byte stream. In the browser that stream is a net.Pipe bridged to the slaprf-relay
// WebSocket (cmd/slaprf-relay copies LiveTime's TCP :5403 bytes 1:1); in tests it is a net.Pipe
// or a TCP socket.
type Server struct {
	mu               sync.RWMutex
	engine           *tracker.Engine
	resolve          func() *tracker.Engine
	subscribed       map[*tracker.Engine]bool
	sessions         map[*session]struct{}
	detectionsSent   uint64
	statusFramesSent uint64
	lastRFSetupSync  time.Time
}

// session is one LiveTime connection (one virtual LapRF device link).
type session struct {
	conn    net.Conn
	writeMu sync.Mutex
}

func (c *session) write(wire []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_ = c.conn.SetWriteDeadline(time.Now().Add(writeTimeout))
	_, err := c.conn.Write(wire)
	return err
}

type engineCrossingForwarder struct {
	server *Server
	engine *tracker.Engine
}

func (f *engineCrossingForwarder) OnTelemetryFrame(_ domain.TimerTelemetryFrame) {}
func (f *engineCrossingForwarder) OnGateCrossing(ev domain.GateCrossingEvent) {
	if f.server.activeEngine() == f.engine {
		f.server.OnGateCrossing(ev)
	}
}
func (f *engineCrossingForwarder) OnLapCompleted(_ domain.LapRecord, _ []domain.PilotTrackSummary) {}
func (f *engineCrossingForwarder) OnDetectionFiltered(_ domain.FilteredDetection)                  {}
func (f *engineCrossingForwarder) OnConfigUpdated(_ []domain.PilotSlot, _ []domain.TrackGate)      {}

// NewServer creates a LapRF emulator backed by the given timing engine.
func NewServer(engine *tracker.Engine) *Server {
	s := &Server{
		subscribed: make(map[*tracker.Engine]bool),
		sessions:   make(map[*session]struct{}),
	}
	s.SetEngine(engine)
	return s
}

// SetEngine pins the timing engine (simulated vs real-world) that backs the LiveTime link.
// It clears any resolver installed by Follow.
func (s *Server) SetEngine(engine *tracker.Engine) {
	if engine == nil {
		return
	}
	s.mu.Lock()
	s.engine = engine
	s.resolve = nil
	s.mu.Unlock()
	s.subscribe(engine)
}

// Follow makes the server track whichever engine resolve() returns at the moment of each
// request, detection, or heartbeat (e.g. the simulation engine while Simulation is on, the
// real-world engine otherwise). Every engine resolve can return must be listed in engines so
// its start/finish crossings are forwarded.
func (s *Server) Follow(resolve func() *tracker.Engine, engines ...*tracker.Engine) {
	for _, e := range engines {
		s.subscribe(e)
	}
	s.mu.Lock()
	s.resolve = resolve
	s.mu.Unlock()
}

func (s *Server) subscribe(engine *tracker.Engine) {
	if engine == nil {
		return
	}
	s.mu.Lock()
	already := s.subscribed[engine]
	s.subscribed[engine] = true
	s.mu.Unlock()
	if !already {
		engine.Subscribe(&engineCrossingForwarder{server: s, engine: engine})
	}
}

func (s *Server) activeEngine() *tracker.Engine {
	s.mu.RLock()
	resolve, eng := s.resolve, s.engine
	s.mu.RUnlock()
	if resolve != nil {
		if e := resolve(); e != nil {
			return e
		}
	}
	return eng
}

// Status returns the current LiveTime bridge diagnostics.
func (s *Server) Status() LiveTimeStatus {
	eng := s.activeEngine()
	s.mu.RLock()
	defer s.mu.RUnlock()
	return LiveTimeStatus{
		ConnectedClients: len(s.sessions),
		DetectionsSent:   s.detectionsSent,
		StatusFramesSent: s.statusFramesSent,
		LastRFSetupSync:  s.lastRFSetupSync,
		RaceArmedByHost:  eng.IsRaceArmed(),
	}
}

// ServeConn runs one LapRF protocol session over conn (any full-duplex byte stream: a TCP
// socket, or a net.Pipe bridged to the browser's relay WebSocket). It answers LiveTime's
// requests (RF setup 0xDA01, time sync 0xDA02, state control 0xDA08, settings 0xDA07), streams
// the 10 Hz STATUS heartbeat, and forwards start/finish detections until conn is closed or a
// read fails. ServeConn blocks; it always closes conn before returning.
func (s *Server) ServeConn(conn net.Conn) {
	sess := &session{conn: conn}
	s.mu.Lock()
	s.sessions[sess] = struct{}{}
	s.mu.Unlock()
	log.Printf("[LapRF/LiveTime] Session opened (%s)", conn.RemoteAddr())

	done := make(chan struct{})
	go s.heartbeat(sess, done)

	defer func() {
		close(done)
		s.mu.Lock()
		delete(s.sessions, sess)
		s.mu.Unlock()
		_ = conn.Close()
		log.Printf("[LapRF/LiveTime] Session closed (%s)", conn.RemoteAddr())
	}()

	buf := make([]byte, 4096)
	var frameBuf []byte
	inFrame := false

	for {
		n, err := conn.Read(buf)
		for i := 0; i < n; i++ {
			b := buf[i]
			if b == ByteSOR {
				inFrame = true
				frameBuf = append(frameBuf[:0], ByteSOR)
			} else if inFrame {
				frameBuf = append(frameBuf, b)
				if b == ByteEOR {
					inFrame = false
					if pkt, decErr := DecodeFrame(frameBuf); decErr == nil {
						s.handleIncomingPacket(sess, pkt)
					}
				}
			}
		}
		if err != nil {
			if err != io.EOF && err != io.ErrClosedPipe {
				log.Printf("[LapRF/LiveTime] Read error: %v", err)
			}
			return
		}
	}
}

func (s *Server) heartbeat(sess *session, done <-chan struct{}) {
	ticker := time.NewTicker(StatusInterval)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case <-ticker.C:
			if err := sess.write(s.buildStatusPacket().Encode()); err == nil {
				s.mu.Lock()
				s.statusFramesSent++
				s.mu.Unlock()
			}
		}
	}
}

func (s *Server) handleIncomingPacket(sess *session, pkt *Packet) {
	eng := s.activeEngine()
	switch pkt.Type {
	case RecordTime:
		// LiveTime RTC clock sync query: reply with our engine microsecond clock
		reply := &Packet{Type: RecordTime}
		reply.AppendUint64(0x02, eng.NowUs())
		_ = sess.write(reply.Encode())

	case RecordRFSetup:
		// LiveTime reads or writes 8-slot pilot frequencies, bands, thresholds, and gains
		s.applyRFSetupFromLiveTime(pkt)
		reply := s.buildRFSetupReplyPacket()
		_ = sess.write(reply.Encode())

	case RecordStateCtrl:
		// LiveTime starts or stops race staging/timing (0x20 = 1 armed, 0 stopped)
		for _, f := range pkt.Fields {
			if f.Signature == 0x20 && len(f.Data) >= 1 {
				armed := f.Data[0] != 0
				eng.SetRaceArmed(armed)
				log.Printf("[LapRF/LiveTime] Race state set by LiveTime: Armed=%v", armed)
			}
		}

	case RecordSettings:
		reply := &Packet{Type: RecordSettings}
		reply.AppendUint16(0x22, uint16(StatusInterval/time.Millisecond)) // status interval in ms
		_ = sess.write(reply.Encode())
	}
}

func (s *Server) applyRFSetupFromLiveTime(pkt *Packet) {
	eng := s.activeEngine()
	pilots, _, _, _, _ := eng.StateSnapshot()
	slotMap := make(map[int]domain.PilotSlot)
	for _, p := range pilots {
		slotMap[p.SlotIndex] = p
	}

	currentSlot := 0
	modified := false

	for _, f := range pkt.Fields {
		switch f.Signature {
		case 0x01: // Pilot Slot index (1..8)
			if len(f.Data) >= 1 {
				currentSlot = int(f.Data[0])
			}
		case 0x20: // Enabled (uint16 or uint8)
			if currentSlot >= 1 && currentSlot <= domain.MaxPilotSlots && len(f.Data) >= 1 {
				slot := slotMap[currentSlot]
				slot.Enabled = f.Data[0] != 0
				slotMap[currentSlot] = slot
				modified = true
			}
		case 0x21: // Channel (1..8)
			if currentSlot >= 1 && currentSlot <= domain.MaxPilotSlots && len(f.Data) >= 2 {
				slot := slotMap[currentSlot]
				slot.Channel = uint8(binary.LittleEndian.Uint16(f.Data))
				slotMap[currentSlot] = slot
				modified = true
			}
		case 0x22: // Band
			if currentSlot >= 1 && currentSlot <= domain.MaxPilotSlots && len(f.Data) >= 2 {
				slot := slotMap[currentSlot]
				slot.Band = domain.Band(binary.LittleEndian.Uint16(f.Data))
				slotMap[currentSlot] = slot
				modified = true
			}
		case 0x23: // Threshold (float32 in LapRF scale ~400..3500, or dBm if negative)
			if currentSlot >= 1 && currentSlot <= domain.MaxPilotSlots && len(f.Data) >= 4 {
				val := math.Float32frombits(binary.LittleEndian.Uint32(f.Data))
				slot := slotMap[currentSlot]
				if val < 0 {
					slot.EnterThreshold = val
				} else {
					// Map LapRF 400..3500 scale to -85..-25 dBm
					slot.EnterThreshold = (val / 46.0) - 95.0
				}
				slot.ExitThreshold = slot.EnterThreshold - 10.0
				slotMap[currentSlot] = slot
				modified = true
			}
		case 0x24: // Gain / Attenuation (uint16)
			if currentSlot >= 1 && currentSlot <= domain.MaxPilotSlots && len(f.Data) >= 2 {
				slot := slotMap[currentSlot]
				slot.AttenuationGain = binary.LittleEndian.Uint16(f.Data)
				slotMap[currentSlot] = slot
				modified = true
			}
		case 0x25: // Frequency in MHz (uint16)
			if currentSlot >= 1 && currentSlot <= domain.MaxPilotSlots && len(f.Data) >= 2 {
				freq := binary.LittleEndian.Uint16(f.Data)
				if freq >= 5000 && freq <= 6000 {
					slot := slotMap[currentSlot]
					slot.FrequencyMHz = freq
					slotMap[currentSlot] = slot
					modified = true
				}
			}
		}
	}

	if modified {
		for idx := 1; idx <= domain.MaxPilotSlots; idx++ {
			eng.UpdatePilotSlot(slotMap[idx])
		}
		s.mu.Lock()
		s.lastRFSetupSync = time.Now()
		s.mu.Unlock()
		log.Printf("[LapRF/LiveTime] Synced 8-Slot Pilot RF Configuration from LiveTime")
	}
}

func (s *Server) buildRFSetupReplyPacket() *Packet {
	pilots, _, _, _, _ := s.activeEngine().StateSnapshot()
	pkt := &Packet{Type: RecordRFSetup}
	for _, p := range pilots {
		pkt.AppendUint8(0x01, uint8(p.SlotIndex))
		var en uint16
		if p.Enabled {
			en = 1
		}
		pkt.AppendUint16(0x20, en)
		pkt.AppendUint16(0x21, uint16(p.Channel))
		pkt.AppendUint16(0x22, uint16(p.Band))
		laprfThresh := (p.EnterThreshold + 95.0) * 46.0
		pkt.AppendFloat32(0x23, laprfThresh)
		pkt.AppendUint16(0x24, p.AttenuationGain)
		pkt.AppendUint16(0x25, p.FrequencyMHz)
	}
	return pkt
}

func (s *Server) buildStatusPacket() *Packet {
	eng := s.activeEngine()
	_, gates, _, crossings, _ := eng.StateSnapshot()
	var startGate domain.TrackGate
	if len(gates) > 0 {
		startGate = gates[0]
		for _, g := range gates {
			if g.Role == domain.GateRoleStartFinish {
				startGate = g
				break
			}
		}
	}

	pkt := &Packet{Type: RecordStatus}
	pkt.AppendUint16(0x03, startGate.BatteryMv) // Battery voltage in mV
	pkt.AppendUint16(0x01, 0)                   // Status flags
	var gateState uint8
	if eng.IsRaceArmed() {
		gateState = 1
	}
	pkt.AppendUint8(0x23, gateState)
	pkt.AppendUint32(0x22, uint32(len(crossings)))

	for i := 0; i < domain.MaxPilotSlots; i++ {
		pkt.AppendUint8(0x01, uint8(i+1))
		rssiHeight := float32(math.Max(300, float64(startGate.LastRSSI[i]+95.0)*46.0))
		pkt.AppendFloat32(0x21, rssiHeight)
	}
	return pkt
}

// broadcastDetection writes wire to every open session (outside the server lock, so a slow
// session can never stall Status() or the engine's subscriber fan-out for long).
func (s *Server) broadcastDetection(wire []byte) {
	s.mu.RLock()
	targets := make([]*session, 0, len(s.sessions))
	for c := range s.sessions {
		targets = append(targets, c)
	}
	s.mu.RUnlock()
	if len(targets) == 0 {
		return
	}
	sent := false
	for _, c := range targets {
		if c.write(wire) == nil {
			sent = true
		}
	}
	if sent {
		s.mu.Lock()
		s.detectionsSent++
		s.mu.Unlock()
	}
}

// --- tracker.EventSubscriber implementation ---

func (s *Server) OnTelemetryFrame(_ domain.TimerTelemetryFrame) {}

func (s *Server) OnGateCrossing(ev domain.GateCrossingEvent) {
	// Only crossings at the Start/Finish Gate Timer are sent to MultiGP LiveTime!
	// Intermediate sector gate crossings are handled by our companion Sector Dashboard.
	if !ev.IsStartFinish {
		return
	}
	pkt := BuildDetectionPacket(
		uint8(ev.SlotIndex),
		ev.TimestampUs,
		ev.PassingNumber,
		ev.LapRFPeakHeight,
	)
	s.broadcastDetection(pkt.Encode())
}

func (s *Server) OnLapCompleted(_ domain.LapRecord, _ []domain.PilotTrackSummary) {}

// Filtered detections are never reported to LiveTime — only accepted start/finish crossings.
func (s *Server) OnDetectionFiltered(_ domain.FilteredDetection) {}

func (s *Server) OnConfigUpdated(_ []domain.PilotSlot, _ []domain.TrackGate) {}
