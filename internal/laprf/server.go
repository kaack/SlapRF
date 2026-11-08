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

// LiveTimeStatus represents the current connection state of the MultiGP LiveTime TCP bridge.
type LiveTimeStatus struct {
	ListenAddr       string    `json:"listenAddr"`
	ConnectedClients int       `json:"connectedClients"`
	DetectionsSent   uint64    `json:"detectionsSent"`
	StatusFramesSent uint64    `json:"statusFramesSent"`
	LastRFSetupSync  time.Time `json:"lastRfSetupSync"`
	RaceArmedByHost  bool      `json:"raceArmedByHost"`
}

// Server emulates an ImmersionRC LapRF 8-Way Event Timer on TCP port 5403 for MultiGP LiveTime.
type Server struct {
	addr             string
	engine           *tracker.Engine
	subscribed       map[*tracker.Engine]bool
	listener         net.Listener
	mu               sync.RWMutex
	clients          map[net.Conn]struct{}
	detectionsSent   uint64
	statusFramesSent uint64
	lastRFSetupSync  time.Time
	stopCh           chan struct{}
}

type engineCrossingForwarder struct {
	server *Server
	engine *tracker.Engine
}

func (f *engineCrossingForwarder) OnTelemetryFrame(_ domain.PuckTelemetryFrame) {}
func (f *engineCrossingForwarder) OnGateCrossing(ev domain.GateCrossingEvent) {
	if f.server.activeEngine() == f.engine {
		f.server.OnGateCrossing(ev)
	}
}
func (f *engineCrossingForwarder) OnLapCompleted(_ domain.LapRecord, _ []domain.PilotTrackSummary) {}
func (f *engineCrossingForwarder) OnDetectionFiltered(_ domain.FilteredDetection)                  {}
func (f *engineCrossingForwarder) OnConfigUpdated(_ []domain.PilotSlot, _ []domain.GatePuck)       {}

// NewServer creates a new LapRF TCP bridge bound to the given address (default ":5403").
func NewServer(addr string, engine *tracker.Engine) *Server {
	s := &Server{
		addr:       addr,
		engine:     engine,
		subscribed: make(map[*tracker.Engine]bool),
		clients:    make(map[net.Conn]struct{}),
		stopCh:     make(chan struct{}),
	}
	s.SetEngine(engine)
	return s
}

// SetEngine switches which timing engine (simulated vs real-world) backs the LiveTime bridge.
func (s *Server) SetEngine(engine *tracker.Engine) {
	if engine == nil {
		return
	}
	s.mu.Lock()
	s.engine = engine
	already := s.subscribed[engine]
	if !already {
		s.subscribed[engine] = true
	}
	s.mu.Unlock()
	if !already {
		engine.Subscribe(&engineCrossingForwarder{server: s, engine: engine})
	}
}

func (s *Server) activeEngine() *tracker.Engine {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.engine
}

// Start begins listening for MultiGP LiveTime TCP connections and starts the 10 Hz STATUS heartbeat loop.
func (s *Server) Start() error {
	ln, err := net.Listen("tcp", s.addr)
	if err != nil {
		return err
	}
	s.listener = ln
	log.Printf("[LapRF/LiveTime] Listening on TCP %s (ImmersionRC LapRF 8-Way Emulation)", s.addr)

	go s.acceptLoop()
	go s.statusHeartbeatLoop()
	return nil
}

// Stop closes the listener and all active LiveTime client connections.
func (s *Server) Stop() {
	close(s.stopCh)
	if s.listener != nil {
		_ = s.listener.Close()
	}
	s.mu.Lock()
	for c := range s.clients {
		_ = c.Close()
	}
	s.mu.Unlock()
}

// Status returns the current LiveTime bridge diagnostics.
func (s *Server) Status() LiveTimeStatus {
	eng := s.activeEngine()
	s.mu.RLock()
	defer s.mu.RUnlock()
	return LiveTimeStatus{
		ListenAddr:       s.addr,
		ConnectedClients: len(s.clients),
		DetectionsSent:   s.detectionsSent,
		StatusFramesSent: s.statusFramesSent,
		LastRFSetupSync:  s.lastRFSetupSync,
		RaceArmedByHost:  eng.IsRaceArmed(),
	}
}

func (s *Server) acceptLoop() {
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			select {
			case <-s.stopCh:
				return
			default:
				continue
			}
		}
		log.Printf("[LapRF/LiveTime] Client connected from %s", conn.RemoteAddr())
		s.mu.Lock()
		s.clients[conn] = struct{}{}
		s.mu.Unlock()

		go s.handleClient(conn)
	}
}

func (s *Server) handleClient(conn net.Conn) {
	defer func() {
		s.mu.Lock()
		delete(s.clients, conn)
		s.mu.Unlock()
		_ = conn.Close()
		log.Printf("[LapRF/LiveTime] Client disconnected: %s", conn.RemoteAddr())
	}()

	buf := make([]byte, 4096)
	var frameBuf []byte
	inFrame := false

	for {
		n, err := conn.Read(buf)
		if err != nil {
			if err != io.EOF {
				log.Printf("[LapRF/LiveTime] Read error: %v", err)
			}
			return
		}
		for i := 0; i < n; i++ {
			b := buf[i]
			if b == ByteSOR {
				inFrame = true
				frameBuf = frameBuf[:0]
				frameBuf = append(frameBuf, ByteSOR)
			} else if inFrame {
				frameBuf = append(frameBuf, b)
				if b == ByteEOR {
					inFrame = false
					pkt, decErr := DecodeFrame(frameBuf)
					if decErr == nil {
						s.handleIncomingPacket(conn, pkt)
					}
				}
			}
		}
	}
}

func (s *Server) handleIncomingPacket(conn net.Conn, pkt *Packet) {
	eng := s.activeEngine()
	switch pkt.Type {
	case RecordTime:
		// LiveTime RTC clock sync query: reply with our engine microsecond clock
		reply := &Packet{Type: RecordTime}
		reply.AppendUint64(0x02, eng.NowUs())
		_, _ = conn.Write(reply.Encode())

	case RecordRFSetup:
		// LiveTime reads or writes 8-slot pilot frequencies, bands, thresholds, and gains
		s.applyRFSetupFromLiveTime(pkt)
		reply := s.buildRFSetupReplyPacket()
		_, _ = conn.Write(reply.Encode())

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
		reply.AppendUint16(0x22, 100) // 100ms status interval
		_, _ = conn.Write(reply.Encode())
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

func (s *Server) statusHeartbeatLoop() {
	ticker := time.NewTicker(100 * time.Millisecond) // 10 Hz status frames as expected by LiveTime
	defer ticker.Stop()

	for {
		select {
		case <-s.stopCh:
			return
		case <-ticker.C:
			s.broadcastStatusFrame()
		}
	}
}

func (s *Server) broadcastStatusFrame() {
	s.mu.RLock()
	numClients := len(s.clients)
	s.mu.RUnlock()
	if numClients == 0 {
		return
	}

	eng := s.activeEngine()
	_, pucks, _, crossings, _ := eng.StateSnapshot()
	var startPuck domain.GatePuck
	if len(pucks) > 0 {
		startPuck = pucks[0]
		for _, p := range pucks {
			if p.Role == domain.PuckRoleStartFinish {
				startPuck = p
				break
			}
		}
	}

	pkt := &Packet{Type: RecordStatus}
	pkt.AppendUint16(0x03, startPuck.BatteryMv) // Battery voltage in mV
	pkt.AppendUint16(0x01, 0)                   // Status flags
	var gateState uint8
	if eng.IsRaceArmed() {
		gateState = 1
	}
	pkt.AppendUint8(0x23, gateState)
	pkt.AppendUint32(0x22, uint32(len(crossings)))

	for i := 0; i < domain.MaxPilotSlots; i++ {
		pkt.AppendUint8(0x01, uint8(i+1))
		rssiHeight := float32(math.Max(300, float64(startPuck.LastRSSI[i]+95.0)*46.0))
		pkt.AppendFloat32(0x21, rssiHeight)
	}

	wire := pkt.Encode()
	s.broadcastWire(wire, false)
}

func (s *Server) broadcastWire(wire []byte, isDetection bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.clients) == 0 {
		return
	}
	for c := range s.clients {
		_ = c.SetWriteDeadline(time.Now().Add(150 * time.Millisecond))
		_, _ = c.Write(wire)
	}
	if isDetection {
		s.detectionsSent++
	} else {
		s.statusFramesSent++
	}
}

// --- tracker.EventSubscriber implementation ---

func (s *Server) OnTelemetryFrame(_ domain.PuckTelemetryFrame) {}

func (s *Server) OnGateCrossing(ev domain.GateCrossingEvent) {
	// Only crossings at the Start/Finish Gate Puck are sent to MultiGP LiveTime!
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
	s.broadcastWire(pkt.Encode(), true)
}

func (s *Server) OnLapCompleted(_ domain.LapRecord, _ []domain.PilotTrackSummary) {}

// Filtered detections are never reported to LiveTime — only accepted start/finish crossings.
func (s *Server) OnDetectionFiltered(_ domain.FilteredDetection) {}

func (s *Server) OnConfigUpdated(_ []domain.PilotSlot, _ []domain.GatePuck) {}
