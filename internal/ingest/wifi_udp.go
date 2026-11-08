package ingest

import (
	"encoding/binary"
	"log"
	"net"
	"sync"

	"slaprf/internal/domain"
	"slaprf/internal/tracker"
)

const (
	FrameMagic0         byte   = 0xC5
	FrameMagicSingle    byte   = 0x58
	FrameMagicWindow    byte   = 0x59
	SingleFrameLen      int    = 16
	WindowFrameLen      int    = 44
	SlidingWindowSize   int    = 4
	RawSampleBytes      int    = 1 + domain.MaxPilotSlots // 1-byte seq_num + 8 x int8 rssi_dbm = 9 bytes
	SampleIntervalUs    uint64 = 20_000                   // 50 Hz (20 ms between consecutive samples)
	DefaultWiFiUDPAddr  string = ":5404"
)

// WiFiUDPReceiver receives 2.4 GHz LR sliding-window recorder frames forwarded over Wi-Fi UDP
// by the Hub Timer (T1) and reconstructs a gapless 50 Hz telemetry stream per timer.
type WiFiUDPReceiver struct {
	mu      sync.Mutex
	addr    string
	engine  *tracker.Engine
	conn    *net.UDPConn
	seenSeq map[uint8]uint8 // timerID -> last ingested 8-bit sample seq_num
	hasSeq  map[uint8]bool  // timerID -> true once at least one sample has been ingested
	stopCh  chan struct{}
}

// NewWiFiUDPReceiver creates a Wi-Fi UDP telemetry receiver bound to `addr` (e.g. ":5404").
func NewWiFiUDPReceiver(addr string, engine *tracker.Engine) *WiFiUDPReceiver {
	if addr == "" {
		addr = DefaultWiFiUDPAddr
	}
	return &WiFiUDPReceiver{
		addr:    addr,
		engine:  engine,
		seenSeq: make(map[uint8]uint8),
		hasSeq:  make(map[uint8]bool),
		stopCh:  make(chan struct{}),
	}
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
		n, _, err := r.conn.ReadFromUDP(buf[:])
		if err != nil {
			select {
			case <-r.stopCh:
				return
			default:
				continue
			}
		}
		if n > 0 {
			r.IngestPacket(buf[:n], r.engine.NowUs())
		}
	}
}

// IngestPacket validates and unpacks either a 44-byte 4-sample sliding-window frame (0xC5 0x59)
// or a 16-byte single-sample frame (0xC5 0x58), deduplicating overlapping samples by `seq_num`
// and forwarding new samples in chronological order to the timing engine.
func (r *WiFiUDPReceiver) IngestPacket(raw []byte, nowUs uint64) int {
	frames := r.DecodePacket(raw, nowUs)
	for _, f := range frames {
		r.engine.IngestTelemetryFrame(f)
	}
	return len(frames)
}

// DecodePacket parses a binary packet and returns only the newly recovered 50 Hz frames in
// chronological order. Corrupted packets (CRC8 mismatch) or duplicate overlap samples are ignored.
func (r *WiFiUDPReceiver) DecodePacket(raw []byte, nowUs uint64) []domain.PuckTelemetryFrame {
	if len(raw) < SingleFrameLen || raw[0] != FrameMagic0 {
		return nil
	}

	switch raw[1] {
	case FrameMagicWindow:
		if len(raw) < WindowFrameLen || !validCRC8(raw[:WindowFrameLen]) {
			return nil
		}
		timerID := raw[2]
		sampleCount := int(raw[3])
		if timerID == 0 || sampleCount <= 0 {
			return nil
		}
		if sampleCount > SlidingWindowSize {
			sampleCount = SlidingWindowSize
		}
		battMv := binary.LittleEndian.Uint16(raw[4:6])
		noiseFloor := float32(int8(raw[6]))

		r.mu.Lock()
		defer r.mu.Unlock()

		out := make([]domain.PuckTelemetryFrame, 0, sampleCount)
		for idx := 0; idx < sampleCount; idx++ {
			off := 7 + idx*RawSampleBytes
			seq := raw[off]
			if r.hasSeq[timerID] && !isNewerSeq(seq, r.seenSeq[timerID]) {
				continue // Already received in an earlier overlapping burst
			}
			r.seenSeq[timerID] = seq
			r.hasSeq[timerID] = true

			var rssi [domain.MaxPilotPoolSize]float32
			for ch := 0; ch < domain.MaxPilotSlots; ch++ {
				rssi[ch] = float32(int8(raw[off+1+ch]))
			}
			// Reconstruct each sample's 20 ms timestamp relative to the newest sample in the window
			ageUs := uint64(sampleCount-1-idx) * SampleIntervalUs
			sampleTs := nowUs
			if nowUs > ageUs {
				sampleTs = nowUs - ageUs
			}
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
		if len(raw) < SingleFrameLen || !validCRC8(raw[:SingleFrameLen]) {
			return nil
		}
		timerID := raw[2]
		seq := raw[3]
		if timerID == 0 {
			return nil
		}
		battMv := binary.LittleEndian.Uint16(raw[4:6])
		noiseFloor := float32(int8(raw[6]))

		r.mu.Lock()
		if r.hasSeq[timerID] && !isNewerSeq(seq, r.seenSeq[timerID]) {
			r.mu.Unlock()
			return nil
		}
		r.seenSeq[timerID] = seq
		r.hasSeq[timerID] = true
		r.mu.Unlock()

		var rssi [domain.MaxPilotPoolSize]float32
		for ch := 0; ch < domain.MaxPilotSlots; ch++ {
			rssi[ch] = float32(int8(raw[7+ch]))
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

// EncodeWindowFrame packs up to 4 consecutive 20 ms sweeps (oldest -> newest) into a 44-byte
// `timer_window_frame_t` matching `firmware/xiao_c5_timer/main.c`.
func EncodeWindowFrame(timerID uint8, battMv uint16, noiseFloorDbm int8, samples [] domain.PuckTelemetryFrame) [WindowFrameLen]byte {
	var pkt [WindowFrameLen]byte
	pkt[0] = FrameMagic0
	pkt[1] = FrameMagicWindow
	pkt[2] = timerID
	count := len(samples)
	if count > SlidingWindowSize {
		samples = samples[count-SlidingWindowSize:]
		count = SlidingWindowSize
	}
	pkt[3] = uint8(count)
	binary.LittleEndian.PutUint16(pkt[4:6], battMv)
	pkt[6] = byte(noiseFloorDbm)

	for idx := 0; idx < count; idx++ {
		off := 7 + idx*RawSampleBytes
		pkt[off] = uint8(samples[idx].SeqNum)
		for ch := 0; ch < domain.MaxPilotSlots; ch++ {
			pkt[off+1+ch] = byte(int8(samples[idx].RSSI[ch]))
		}
	}
	var crc byte
	for i := 0; i < WindowFrameLen-1; i++ {
		crc ^= pkt[i]
	}
	pkt[WindowFrameLen-1] = crc
	return pkt
}

// isNewerSeq returns true if `candidate` is strictly newer than `last` in 8-bit modular arithmetic.
func isNewerSeq(candidate, last uint8) bool {
	diff := candidate - last
	return diff > 0 && diff < 128
}

func validCRC8(frame []byte) bool {
	if len(frame) < 2 {
		return false
	}
	var crc byte
	for i := 0; i < len(frame)-1; i++ {
		crc ^= frame[i]
	}
	return crc == frame[len(frame)-1]
}
