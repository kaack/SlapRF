package ingest

import (
	"encoding/binary"
	"fmt"
	"log"
	"net"
	"sync"

	"slaprf/internal/domain"
	"slaprf/internal/firmware"
	"slaprf/internal/tracker"
)

const (
	FrameMagic0        byte = 0xC5
	FrameMagicSingle   byte = 0x58 // 16-byte single-sample frame
	FrameMagicWindow   byte = 0x59 // Variable-length sliding-window recorder frame
	FrameMagicHello    byte = 0x5A // 36-byte timer announcement (fingerprint, name, profile)
	FrameMagicChannels byte = 0x5E // 19-byte laptop -> Hub active pilot channel table (0 = disabled slot)

	SingleFrameLen    int = 16
	HelloFrameLen     int = 36
	ChannelsFrameLen  int = 19 // magic0, magic1, 8 x uint16 LE freqs, crc8
	windowHeaderLen   int = 7  // magic0, magic1, slot, sample_count, battery_mv (2), noise_floor
	SlidingWindowSize int = 4  // Default ("open-ground") window; frames may carry up to MaxWindowSamples
	MaxWindowSamples  int = firmware.MaxWindowSamples
	RawSampleBytes    int = 1 + domain.MaxPilotSlots // 1-byte seq_num + 8 x int8 rssi_dbm = 9 bytes

	// WindowFrameLen is the size of a default 4-sample window frame (kept for reference).
	WindowFrameLen int = windowHeaderLen + SlidingWindowSize*RawSampleBytes + 1

	SampleIntervalUs   uint64 = 20_000 // Default 50 Hz sweep (until a Hello reports the profile)
	DefaultWiFiUDPAddr string = ":5404"
	HubUDPPort         int    = 5404
)

// WindowFrameLenFor returns the byte length of a window frame carrying `samples` sweeps.
func WindowFrameLenFor(samples int) int {
	return windowHeaderLen + samples*RawSampleBytes + 1
}

// slotInfo is what the receiver learned about a Hub TDMA slot from its Hello frame.
type slotInfo struct {
	fingerprint uint32
	timerID     uint8  // Stable app-side timer ID (engine)
	intervalUs  uint64 // Sweep interval for this timer's firmware profile
}

// WiFiUDPReceiver receives 2.4 GHz sliding-window recorder frames forwarded over Wi-Fi UDP by
// the Hub timer and reconstructs a gapless telemetry stream per timer.
//
// Frames identify a timer by the short slot number the Hub assigned at join time; Hello frames
// map each slot to the board's stable fingerprint, which the engine maps to the app's timer ID.
// Frames from a slot that hasn't announced itself yet are dropped (the Hub repeats every HELLO
// every 2 s), so no anonymous placeholder timers appear before the real identity is known.
type WiFiUDPReceiver struct {
	mu      sync.Mutex
	addr    string
	engine  *tracker.Engine
	conn    *net.UDPConn
	hubIP   net.IP
	slots   map[uint8]slotInfo
	seenSeq map[uint8]uint8  // timerID -> last ingested 8-bit sample seq_num
	hasSeq  map[uint8]bool   // timerID -> true once at least one sample has been ingested
	lastTs  map[uint8]uint64 // timerID -> last reconstructed sample TimestampUs
	stopCh  chan struct{}
}

// NewWiFiUDPReceiver creates a Wi-Fi UDP telemetry receiver bound to `addr` (e.g. ":5404").
func NewWiFiUDPReceiver(addr string, engine *tracker.Engine) *WiFiUDPReceiver {
	if addr == "" {
		addr = DefaultWiFiUDPAddr
	}
	r := &WiFiUDPReceiver{
		addr:    addr,
		engine:  engine,
		slots:   make(map[uint8]slotInfo),
		seenSeq: make(map[uint8]uint8),
		hasSeq:  make(map[uint8]bool),
		lastTs:  make(map[uint8]uint64),
		stopCh:  make(chan struct{}),
	}
	if engine != nil {
		engine.Subscribe(r)
	}
	return r
}

// OnTelemetryFrame implements tracker.EventSubscriber.
func (r *WiFiUDPReceiver) OnTelemetryFrame(domain.PuckTelemetryFrame) {}

// OnGateCrossing implements tracker.EventSubscriber.
func (r *WiFiUDPReceiver) OnGateCrossing(domain.GateCrossingEvent) {}

// OnDetectionFiltered implements tracker.EventSubscriber.
func (r *WiFiUDPReceiver) OnDetectionFiltered(domain.FilteredDetection) {}

// OnLapCompleted implements tracker.EventSubscriber.
func (r *WiFiUDPReceiver) OnLapCompleted(domain.LapRecord, []domain.PilotTrackSummary) {}

// OnConfigUpdated pushes the active pilot channel table to the Hub Timer whenever pilots are
// enabled/disabled or their channels change.
func (r *WiFiUDPReceiver) OnConfigUpdated(pilots []domain.PilotSlot, _ []domain.GatePuck) {
	freqs, _ := tracker.ComputeActivePilotChannels(pilots)
	r.sendChannelsToHub(freqs)
}

func (r *WiFiUDPReceiver) pushActiveChannelsToHub() {
	if r.engine == nil {
		return
	}
	freqs, _ := r.engine.ActivePilotChannels()
	r.sendChannelsToHub(freqs)
}

func (r *WiFiUDPReceiver) sendChannelsToHub(freqs [domain.MaxPilotSlots]uint16) {
	r.mu.Lock()
	conn := r.conn
	hubIP := r.hubIP
	r.mu.Unlock()
	if conn == nil || len(hubIP) == 0 {
		return
	}
	pkt := EncodeChannelsFrame(freqs)
	dst := &net.UDPAddr{IP: hubIP, Port: HubUDPPort}
	_, _ = conn.WriteToUDP(pkt, dst)
}

// Start binds the UDP socket and begins ingesting frames from the Hub Timer in the background.
func (r *WiFiUDPReceiver) Start() error {
	udpAddr, err := net.ResolveUDPAddr("udp", r.addr)
	if err != nil {
		return err
	}
	conn, err := net.ListenUDP("udp", udpAddr)
	if err != nil {
		return err
	}
	r.conn = conn
	log.Printf("[Wi-Fi Hub Bridge] Listening on UDP %s (LR Sliding-Window Recorder stream)", r.addr)
	go r.readLoop()
	return nil
}

// Stop closes the UDP listener socket.
func (r *WiFiUDPReceiver) Stop() {
	close(r.stopCh)
	if r.conn != nil {
		_ = r.conn.Close()
	}
}

func (r *WiFiUDPReceiver) readLoop() {
	var buf [512]byte
	for {
		n, srcAddr, err := r.conn.ReadFromUDP(buf[:])
		if err != nil {
			select {
			case <-r.stopCh:
				return
			default:
				continue
			}
		}
		if srcAddr != nil && len(srcAddr.IP) > 0 && !srcAddr.IP.IsLoopback() {
			r.mu.Lock()
			r.hubIP = append(net.IP(nil), srcAddr.IP...)
			r.mu.Unlock()
		}
		if n > 0 {
			if n == ChannelsFrameLen && buf[0] == FrameMagic0 && buf[1] == FrameMagicChannels {
				continue // Ignore our own outbound channel-table frame if received via broadcast
			}
			r.IngestPacket(buf[:n], r.engine.NowUs())
		}
	}
}

// IngestPacket handles one UDP datagram: Hello frames register the timer, telemetry frames are
// decoded, deduplicated, and forwarded in chronological order to the timing engine.
func (r *WiFiUDPReceiver) IngestPacket(raw []byte, nowUs uint64) int {
	if len(raw) >= 2 && raw[0] == FrameMagic0 && raw[1] == FrameMagicHello {
		r.handleHello(raw)
		return 0
	}
	frames := r.DecodePacket(raw, nowUs)
	for _, f := range frames {
		r.engine.IngestTelemetryFrame(f)
	}
	return len(frames)
}

// handleHello maps a Hub slot to the board's stable timer ID.
//
//	[0] 0xC5 [1] 0x5A [2] slot [3] role [4..7] fingerprint (LE) [8] profile code
//	[9] sweep_hz [10..33] timer_label (24) [34] reserved [35] crc8
func (r *WiFiUDPReceiver) handleHello(raw []byte) {
	if len(raw) < HelloFrameLen || !validCRC8(raw[:HelloFrameLen]) {
		return
	}
	slot := raw[2]
	fp := binary.LittleEndian.Uint32(raw[4:8])
	if slot == 0 || fp == 0 {
		return
	}
	r.mu.Lock()
	if cur, ok := r.slots[slot]; ok && cur.fingerprint == fp {
		r.mu.Unlock()
		r.pushActiveChannelsToHub()
		return // Already registered
	}
	r.mu.Unlock()

	profile := firmware.ProfileByCode(raw[8])
	label := cString(raw[10:34])
	timerID, err := r.engine.RegisterTimerHello(fmt.Sprintf("%08X", fp), raw[3] == firmware.RoleHubTimer, profile.ID, label)
	if err != nil || timerID == 0 {
		return
	}
	interval := SampleIntervalUs
	if hz := raw[9]; hz > 0 {
		interval = 1_000_000 / uint64(hz)
	}
	r.mu.Lock()
	r.slots[slot] = slotInfo{fingerprint: fp, timerID: timerID, intervalUs: interval}
	delete(r.hasSeq, timerID)
	delete(r.lastTs, timerID)
	r.mu.Unlock()
	r.pushActiveChannelsToHub()
}

// resolveSlotLocked returns the stable timer ID and sweep interval for a Hub slot, or ok=false if
// that slot hasn't sent a HELLO yet.
func (r *WiFiUDPReceiver) resolveSlotLocked(slot uint8) (uint8, uint64, bool) {
	info, ok := r.slots[slot]
	return info.timerID, info.intervalUs, ok
}

// DecodePacket parses a binary packet and returns only the newly recovered frames in
// chronological order. Corrupted packets (CRC8 mismatch) or duplicate overlap samples are ignored.
func (r *WiFiUDPReceiver) DecodePacket(raw []byte, nowUs uint64) []domain.PuckTelemetryFrame {
	if len(raw) < SingleFrameLen || raw[0] != FrameMagic0 {
		return nil
	}

	var slotToPilot [domain.MaxPilotSlots]int
	for ch := 0; ch < domain.MaxPilotSlots; ch++ {
		slotToPilot[ch] = ch
	}
	if r.engine != nil {
		_, slotToPilot = r.engine.ActivePilotChannels()
	}

	switch raw[1] {
	case FrameMagicWindow:
		slot := raw[2]
		sampleCount := int(raw[3])
		if slot == 0 || sampleCount <= 0 || sampleCount > MaxWindowSamples {
			return nil
		}
		frameLen := WindowFrameLenFor(sampleCount)
		if len(raw) < frameLen || !validCRC8(raw[:frameLen]) {
			return nil
		}
		battMv := binary.LittleEndian.Uint16(raw[4:6])
		noiseFloor := float32(int8(raw[6]))

		r.mu.Lock()
		defer r.mu.Unlock()
		timerID, intervalUs, known := r.resolveSlotLocked(slot)
		if !known {
			return nil
		}

		out := make([]domain.PuckTelemetryFrame, 0, sampleCount)
		for idx := 0; idx < sampleCount; idx++ {
			off := windowHeaderLen + idx*RawSampleBytes
			seq := raw[off]
			prevSeq := r.seenSeq[timerID]
			hadPrev := r.hasSeq[timerID]
			if hadPrev && !isNewerSeq(seq, prevSeq) {
				continue // Already received in an earlier overlapping burst
			}
			r.seenSeq[timerID] = seq
			r.hasSeq[timerID] = true

			var rssi [domain.MaxPilotPoolSize]float32
			for ch := 0; ch < domain.MaxPilotSlots; ch++ {
				val := float32(int8(raw[off+1+ch]))
				rssi[ch] = val
				if pIdx := slotToPilot[ch]; pIdx >= 0 && pIdx < domain.MaxPilotPoolSize {
					rssi[pIdx] = val
				}
			}
			// Reconstruct each sample's timestamp relative to the newest sample in the window,
			// advancing monotonically by seqDelta * intervalUs when consecutive samples arrive so
			// Wi-Fi UDP arrival jitter doesn't bunch or stretch samples on the signal chart.
			ageUs := uint64(sampleCount-1-idx) * intervalUs
			rawTs := nowUs
			if nowUs > ageUs {
				rawTs = nowUs - ageUs
			}
			sampleTs := rawTs
			if hadPrev {
				seqDelta := uint64(seq - prevSeq)
				if seqDelta >= 1 && seqDelta <= 16 {
					predicted := r.lastTs[timerID] + seqDelta*intervalUs
					var diff uint64
					if rawTs > predicted {
						diff = rawTs - predicted
					} else {
						diff = predicted - rawTs
					}
					if diff <= 120_000 {
						// Gently slew toward wall-clock (1/8th step) while keeping monotonic spacing
						sampleTs = uint64(int64(predicted) + (int64(rawTs)-int64(predicted))/8)
						if sampleTs <= r.lastTs[timerID] {
							sampleTs = r.lastTs[timerID] + intervalUs/2
						}
					}
				}
			}
			r.lastTs[timerID] = sampleTs
			out = append(out, domain.PuckTelemetryFrame{
				PuckID:        timerID,
				SeqNum:        uint32(seq),
				TimestampUs:   sampleTs,
				RSSI:          rssi,
				BatteryMv:     battMv,
				NoiseFloorDbm: noiseFloor,
			})
		}
		return out

	case FrameMagicSingle:
		if !validCRC8(raw[:SingleFrameLen]) {
			return nil
		}
		slot := raw[2]
		seq := raw[3]
		if slot == 0 {
			return nil
		}
		battMv := binary.LittleEndian.Uint16(raw[4:6])
		noiseFloor := float32(int8(raw[6]))

		r.mu.Lock()
		timerID, _, known := r.resolveSlotLocked(slot)
		if !known {
			r.mu.Unlock()
			return nil
		}
		if r.hasSeq[timerID] && !isNewerSeq(seq, r.seenSeq[timerID]) {
			r.mu.Unlock()
			return nil
		}
		r.seenSeq[timerID] = seq
		r.hasSeq[timerID] = true
		r.mu.Unlock()

		var rssi [domain.MaxPilotPoolSize]float32
		for ch := 0; ch < domain.MaxPilotSlots; ch++ {
			val := float32(int8(raw[7+ch]))
			rssi[ch] = val
			if pIdx := slotToPilot[ch]; pIdx >= 0 && pIdx < domain.MaxPilotPoolSize {
				rssi[pIdx] = val
			}
		}
		return []domain.PuckTelemetryFrame{{
			PuckID:        timerID,
			SeqNum:        uint32(seq),
			TimestampUs:   nowUs,
			RSSI:          rssi,
			BatteryMv:     battMv,
			NoiseFloorDbm: noiseFloor,
		}}
	}
	return nil
}

// EncodeWindowFrame packs up to MaxWindowSamples consecutive sweeps (oldest -> newest) into a
// sliding-window frame matching `timer_window_frame_t` in `firmware/xiao_c5_timer/main.c`.
func EncodeWindowFrame(slot uint8, battMv uint16, noiseFloorDbm int8, samples []domain.PuckTelemetryFrame) []byte {
	count := len(samples)
	if count > MaxWindowSamples {
		samples = samples[count-MaxWindowSamples:]
		count = MaxWindowSamples
	}
	pkt := make([]byte, WindowFrameLenFor(count))
	pkt[0] = FrameMagic0
	pkt[1] = FrameMagicWindow
	pkt[2] = slot
	pkt[3] = uint8(count)
	binary.LittleEndian.PutUint16(pkt[4:6], battMv)
	pkt[6] = byte(noiseFloorDbm)
	for idx := 0; idx < count; idx++ {
		off := windowHeaderLen + idx*RawSampleBytes
		pkt[off] = uint8(samples[idx].SeqNum)
		for ch := 0; ch < domain.MaxPilotSlots; ch++ {
			pkt[off+1+ch] = byte(int8(samples[idx].RSSI[ch]))
		}
	}
	pkt[len(pkt)-1] = xorCRC(pkt[:len(pkt)-1])
	return pkt
}

// EncodeHelloFrame builds the 36-byte announcement the Hub forwards when a timer joins.
func EncodeHelloFrame(slot uint8, role uint8, fingerprint uint32, profileCode uint8, sweepHz uint8, label string) []byte {
	pkt := make([]byte, HelloFrameLen)
	pkt[0] = FrameMagic0
	pkt[1] = FrameMagicHello
	pkt[2] = slot
	pkt[3] = role
	binary.LittleEndian.PutUint32(pkt[4:8], fingerprint)
	pkt[8] = profileCode
	pkt[9] = sweepHz
	copy(pkt[10:34], []byte(label))
	pkt[HelloFrameLen-1] = xorCRC(pkt[:HelloFrameLen-1])
	return pkt
}

// EncodeChannelsFrame builds the 19-byte active pilot channel table frame (0xC5 0x5E) sent from
// the laptop to the Hub Timer over UDP so timers only sweep enabled pilot channels.
func EncodeChannelsFrame(freqs [domain.MaxPilotSlots]uint16) []byte {
	pkt := make([]byte, ChannelsFrameLen)
	pkt[0] = FrameMagic0
	pkt[1] = FrameMagicChannels
	for i := 0; i < domain.MaxPilotSlots; i++ {
		binary.LittleEndian.PutUint16(pkt[2+i*2:4+i*2], freqs[i])
	}
	pkt[ChannelsFrameLen-1] = xorCRC(pkt[:ChannelsFrameLen-1])
	return pkt
}

// isNewerSeq returns true if `candidate` is strictly newer than `last` in 8-bit modular arithmetic.
func isNewerSeq(candidate, last uint8) bool {
	diff := candidate - last
	return diff > 0 && diff < 128
}

func xorCRC(b []byte) byte {
	var crc byte
	for _, x := range b {
		crc ^= x
	}
	return crc
}

func validCRC8(frame []byte) bool {
	if len(frame) < 2 {
		return false
	}
	return xorCRC(frame[:len(frame)-1]) == frame[len(frame)-1]
}

func cString(b []byte) string {
	for i, c := range b {
		if c == 0 {
			return string(b[:i])
		}
	}
	return string(b)
}
