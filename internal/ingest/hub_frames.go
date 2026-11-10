package ingest

import (
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"strings"
	"sync"

	"slaprf/internal/domain"
	"slaprf/internal/firmware"
	"slaprf/internal/tracker"
)

const (
	FrameMagic0        byte = 0xC5
	FrameMagicSingle   byte = 0x58 // 16-byte single-sample frame
	FrameMagicWindow   byte = 0x59 // Variable-length sliding-window recorder frame
	FrameMagicHello    byte = 0x5A // 36-byte timer announcement (fingerprint, name, sweep rate)
	FrameMagicChannels byte = 0x5E // 19-byte active pilot channel table (0 = disabled slot)

	SingleFrameLen    int = 16
	HelloFrameLen     int = 36
	ChannelsFrameLen  int = 19 // magic0, magic1, 8 x uint16 LE freqs, crc8
	windowHeaderLen   int = 7  // magic0, magic1, slot, sample_count, battery_mv (2), noise_floor
	SlidingWindowSize int = 4  // Firmware window; frames may carry up to MaxWindowSamples
	MaxWindowSamples  int = firmware.MaxWindowSamples
	RawSampleBytes    int = 1 + domain.MaxPilotSlots // 1-byte seq_num + 8 x int8 rssi_dbm = 9 bytes

	// WindowFrameLen is the size of a default 4-sample window frame (kept for reference).
	WindowFrameLen int = windowHeaderLen + SlidingWindowSize*RawSampleBytes + 1

	SampleIntervalUs uint64 = 1_000_000 / firmware.SweepHz // Firmware sweep interval (a Hello's sweep_hz overrides it)
)

// WindowFrameLenFor returns the byte length of a window frame carrying `samples` sweeps.
func WindowFrameLenFor(samples int) int {
	return windowHeaderLen + samples*RawSampleBytes + 1
}

// slotInfo is what the decoder learned about a Hub TDMA slot from its Hello frame.
type slotInfo struct {
	fingerprint uint32
	timerID     uint8  // Stable app-side timer ID (engine)
	intervalUs  uint64 // Sweep interval reported in this timer's Hello
}

// HubFrameDecoder decodes binary Hub frames (2.4 GHz sliding-window recorder frames, Hellos)
// forwarded over USB serial by the Hub dongle and reconstructs a gapless telemetry stream per
// timer. Outbound frames (the active channel table) are handed to the sender registered with
// SetOutboundSender, which writes them back to the Hub over the same USB link.
//
// Frames identify a timer by the short slot number the Hub assigned at join time; Hello frames
// map each slot to the board's stable fingerprint, which the engine maps to the app's timer ID.
// Frames from a slot that hasn't announced itself yet are dropped (the Hub replays cached HELLOs
// on connect and repeats every HELLO every 2 s), so no anonymous placeholder timers appear.
type HubFrameDecoder struct {
	mu          sync.Mutex
	engine      *tracker.Engine
	outFn       func([]byte)
	lastChanHex string
	slots       map[uint8]slotInfo
	seenSeq     map[uint8]uint8  // timerID -> last ingested 8-bit sample seq_num
	hasSeq      map[uint8]bool   // timerID -> true once at least one sample has been ingested
	lastTs      map[uint8]uint64 // timerID -> last reconstructed sample TimestampUs
	lastArrival map[uint8]uint64 // timerID -> arrival time (nowUs) of its last telemetry frame
	timelines   map[uint8]*tsTracker
}

// NewHubFrameDecoder creates a Hub frame decoder feeding `engine`.
func NewHubFrameDecoder(engine *tracker.Engine) *HubFrameDecoder {
	r := &HubFrameDecoder{
		engine:      engine,
		slots:       make(map[uint8]slotInfo),
		seenSeq:     make(map[uint8]uint8),
		hasSeq:      make(map[uint8]bool),
		lastTs:      make(map[uint8]uint64),
		lastArrival: make(map[uint8]uint64),
		timelines:   make(map[uint8]*tsTracker),
	}
	if engine != nil {
		engine.Subscribe(r)
	}
	return r
}

// OnTelemetryFrame implements tracker.EventSubscriber.
func (r *HubFrameDecoder) OnTelemetryFrame(domain.TimerTelemetryFrame) {}

// OnGateCrossing implements tracker.EventSubscriber.
func (r *HubFrameDecoder) OnGateCrossing(domain.GateCrossingEvent) {}

// OnDetectionFiltered implements tracker.EventSubscriber.
func (r *HubFrameDecoder) OnDetectionFiltered(domain.FilteredDetection) {}

// OnLapCompleted implements tracker.EventSubscriber.
func (r *HubFrameDecoder) OnLapCompleted(domain.LapRecord, []domain.PilotTrackSummary) {}

// OnConfigUpdated pushes the active pilot channel table to the Hub Timer whenever pilots are
// enabled/disabled or their channels change.
func (r *HubFrameDecoder) OnConfigUpdated(pilots []domain.PilotSlot, _ []domain.TrackGate) {
	freqs, _ := tracker.ComputeActivePilotChannels(pilots)
	r.sendChannelsToHub(freqs)
}

func (r *HubFrameDecoder) pushActiveChannelsToHub() {
	if r.engine == nil {
		return
	}
	freqs, _ := r.engine.ActivePilotChannels()
	r.sendChannelsToHub(freqs, true)
}

// PushActiveChannels immediately pushes the current active pilot channel table to the Hub.
func (r *HubFrameDecoder) PushActiveChannels() {
	r.pushActiveChannelsToHub()
}

// SetOutboundSender registers the callback that delivers outbound Hub frames (the browser WASM
// bridge writes them to the Hub over USB serial).
func (r *HubFrameDecoder) SetOutboundSender(fn func([]byte)) {
	r.mu.Lock()
	r.outFn = fn
	r.mu.Unlock()
}

func (r *HubFrameDecoder) sendChannelsToHub(freqs [domain.MaxPilotSlots]uint16, force ...bool) {
	pkt := EncodeChannelsFrame(freqs)
	hexStr := strings.ToUpper(hex.EncodeToString(pkt))
	forced := len(force) > 0 && force[0]

	r.mu.Lock()
	if !forced && r.lastChanHex == hexStr {
		r.mu.Unlock()
		return
	}
	r.lastChanHex = hexStr
	outFn := r.outFn
	r.mu.Unlock()

	if outFn != nil {
		outFn(pkt)
	}
}

// IngestPacket handles one binary Hub packet: Hello frames register the timer, telemetry frames are
// decoded, deduplicated, and forwarded in chronological order to the timing engine.
func (r *HubFrameDecoder) IngestPacket(raw []byte, nowUs uint64) int {
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
//	[0] 0xC5 [1] 0x5A [2] slot [3] role [4..7] fingerprint (LE) [8] reserved (0)
//	[9] sweep_hz [10..33] timer_label (24) [34] reserved [35] crc8
func (r *HubFrameDecoder) handleHello(raw []byte) {
	if len(raw) < HelloFrameLen || !validCRC8(raw[:HelloFrameLen]) {
		return
	}
	slot := raw[2]
	fp := binary.LittleEndian.Uint32(raw[4:8])
	if slot == 0 || fp == 0 {
		return
	}
	r.mu.Lock()
	if cur, ok := r.slots[slot]; ok && cur.fingerprint == fp && (r.engine == nil || r.engine.HasDetectedTimer(cur.timerID)) {
		r.mu.Unlock()
		if r.engine != nil {
			r.engine.MarkTimerSeen(cur.timerID) // Keeps the collector Hub (HELLO-only) online
		}
		return // Already registered
	}
	r.mu.Unlock()

	label := cString(raw[10:34])
	timerID, err := r.engine.RegisterTimerHello(fmt.Sprintf("%08X", fp), raw[3] == firmware.RoleHubTimer, label)
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
	delete(r.lastArrival, timerID)
	delete(r.timelines, timerID)
	r.mu.Unlock()
	r.pushActiveChannelsToHub()
}

// resolveSlotLocked returns the stable timer ID and sweep interval for a Hub slot, or ok=false if
// that slot hasn't sent a HELLO yet (unless the slot's timer ID was already provisioned).
func (r *HubFrameDecoder) resolveSlotLocked(slot uint8) (uint8, uint64, bool) {
	if info, ok := r.slots[slot]; ok {
		return info.timerID, info.intervalUs, true
	}
	if r.engine != nil && r.engine.HasDetectedTimer(slot) {
		r.slots[slot] = slotInfo{timerID: slot, intervalUs: SampleIntervalUs}
		return slot, SampleIntervalUs, true
	}
	return 0, 0, false
}

const (
	// maxSeqRunSamples bounds the sequence gap still bridged by the seq-predicted timeline
	// (640 ms at 100 Hz); longer gaps re-seed from the arrival time.
	maxSeqRunSamples = 64
	// staleSeqSamples: after this many sample intervals without a frame from a timer, its 8-bit
	// sequence number may have wrapped half-way (128), so dedupe/timeline state is reset instead of
	// silently dropping fresh samples as "old" (1 s at 100 Hz, 2 s at 50 Hz).
	staleSeqSamples = 100
	// lateToleranceUs: how late (USB batching, a busy browser main thread, radio retries) a frame may
	// arrive and still be placed on the seq-predicted timeline rather than re-seeding from arrival.
	lateToleranceUs = 1_000_000
	// earlyToleranceUs: how far ahead of arrival a prediction may drift before re-seeding.
	earlyToleranceUs = 120_000
	// latencyWindowUs: the timeline is advanced by the smallest lateness seen over each window
	// (the true offset: clock drift / sweep-rate mismatch), never by burst latency.
	latencyWindowUs = 1_000_000
)

// tsTracker is the per-timer state of the lower-envelope timestamp reconstruction.
type tsTracker struct {
	winStartUs uint64 // arrival time the current latency window started
	minLateUs  uint64 // smallest (arrival - predicted) seen in the window
	pendingUs  uint64 // correction still to spread over the next samples
}

func (r *HubFrameDecoder) trackerLocked(timerID uint8, nowUs uint64) *tsTracker {
	tr := r.timelines[timerID]
	if tr == nil {
		tr = &tsTracker{winStartUs: nowUs, minLateUs: ^uint64(0)}
		r.timelines[timerID] = tr
	}
	return tr
}

// expireStaleSeqLocked forgets a timer's sequence/timeline state when it has been silent long enough
// for its 8-bit sequence counter to wrap past the dedupe window.
func (r *HubFrameDecoder) expireStaleSeqLocked(timerID uint8, intervalUs, nowUs uint64) {
	if last, ok := r.lastArrival[timerID]; ok && nowUs > last && nowUs-last > staleSeqSamples*intervalUs {
		delete(r.hasSeq, timerID)
		delete(r.lastTs, timerID)
		delete(r.timelines, timerID)
	}
	r.lastArrival[timerID] = nowUs
}

// sampleTimestampLocked reconstructs a sample's capture time from its frame's arrival time
// (`nowUs`, minus `age` sweeps for older samples in the window) and its sequence number.
//
// Arrival time = capture time + latency, and latency is never negative, so the timeline follows
// the lower envelope of arrivals: consecutive samples are spaced exactly `seqDelta × interval`
// (no bunching or stretching when frames arrive in bursts — 4-sample windows every 20 ms, a whole
// USB read at once, a stalled main thread), a sample arriving *earlier* than predicted pulls the
// timeline back toward its arrival (staying monotonic), and the smallest lateness seen over each
// second is spread forward over the following samples (clock drift, sweep-rate mismatch).
func (r *HubFrameDecoder) sampleTimestampLocked(timerID uint8, hadPrev bool, seqDelta uint8, age int, intervalUs, nowUs uint64) uint64 {
	ageUs := uint64(age) * intervalUs
	rawTs := nowUs
	if nowUs > ageUs {
		rawTs = nowUs - ageUs
	}
	last, ok := r.lastTs[timerID]
	if !ok || !hadPrev || seqDelta < 1 || int(seqDelta) > maxSeqRunSamples {
		delete(r.timelines, timerID)
		return rawTs
	}
	tr := r.trackerLocked(timerID, nowUs)
	predicted := last + uint64(seqDelta)*intervalUs
	if rawTs < predicted {
		early := predicted - rawTs
		if early > earlyToleranceUs {
			delete(r.timelines, timerID)
			return rawTs // timeline ran away (e.g. wrong sweep rate): re-seed
		}
		tr.pendingUs = 0
		tr.minLateUs = 0
		ts := rawTs
		if minTs := last + intervalUs/2; ts < minTs {
			ts = minTs // stay strictly monotonic
		}
		return ts
	}
	late := rawTs - predicted
	if late > lateToleranceUs {
		delete(r.timelines, timerID)
		return rawTs
	}
	if late < tr.minLateUs {
		tr.minLateUs = late
	}
	if nowUs >= tr.winStartUs+latencyWindowUs {
		tr.pendingUs = tr.minLateUs
		tr.minLateUs = ^uint64(0)
		tr.winStartUs = nowUs
	}
	ts := predicted
	if tr.pendingUs > 0 {
		step := tr.pendingUs
		if maxStep := intervalUs / 10; step > maxStep {
			step = maxStep
		}
		ts += step
		tr.pendingUs -= step
	}
	return ts
}

// DecodePacket parses a binary packet and returns only the newly recovered frames in
// chronological order. Corrupted packets (CRC8 mismatch) or duplicate overlap samples are ignored.
func (r *HubFrameDecoder) DecodePacket(raw []byte, nowUs uint64) []domain.TimerTelemetryFrame {
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
		r.expireStaleSeqLocked(timerID, intervalUs, nowUs)

		out := make([]domain.TimerTelemetryFrame, 0, sampleCount)
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
			sampleTs := r.sampleTimestampLocked(timerID, hadPrev, seq-prevSeq, sampleCount-1-idx, intervalUs, nowUs)
			r.lastTs[timerID] = sampleTs
			out = append(out, domain.TimerTelemetryFrame{
				TimerID:       timerID,
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
		timerID, intervalUs, known := r.resolveSlotLocked(slot)
		if !known {
			r.mu.Unlock()
			return nil
		}
		r.expireStaleSeqLocked(timerID, intervalUs, nowUs)
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
		return []domain.TimerTelemetryFrame{{
			TimerID:       timerID,
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
func EncodeWindowFrame(slot uint8, battMv uint16, noiseFloorDbm int8, samples []domain.TimerTelemetryFrame) []byte {
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
func EncodeHelloFrame(slot uint8, role uint8, fingerprint uint32, sweepHz uint8, label string) []byte {
	pkt := make([]byte, HelloFrameLen)
	pkt[0] = FrameMagic0
	pkt[1] = FrameMagicHello
	pkt[2] = slot
	pkt[3] = role
	binary.LittleEndian.PutUint32(pkt[4:8], fingerprint)
	pkt[9] = sweepHz
	copy(pkt[10:34], []byte(label))
	pkt[HelloFrameLen-1] = xorCRC(pkt[:HelloFrameLen-1])
	return pkt
}

// EncodeChannelsFrame builds the 19-byte active pilot channel table frame (0xC5 0x5E) sent to
// the Hub Timer over USB serial so timers only sweep enabled pilot channels.
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
