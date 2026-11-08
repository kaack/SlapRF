package ingest

import (
	"math"
	"math/rand"
	"sync"
	"time"

	"slaprf/internal/domain"
	"slaprf/internal/tracker"
)

type simPilotState struct {
	slotIndex       int
	trackPosMeters  float64 // 0 .. trackLengthMeters
	baseSpeedMps    float64 // ~24..31 m/s (54..70 mph)
	weakSectorIdx   int     // 0-based sector where this pilot has higher variance/slower speed
	weaknessPenalty float64 // speed multiplier in weak sector (e.g. 0.76)
}

// TrackSimulator generates realistic 50 Hz multi-gate 5.8 GHz SDR telemetry streams
// across all deployed Gate Pucks, modeling inverse-square RF path loss, multipath noise,
// and per-sector speed variations.
type TrackSimulator struct {
	mu                sync.Mutex
	engine            *tracker.Engine
	running           bool
	trackLengthMeters float64
	pilotStates       []simPilotState
	seqCounter        uint32
	rng               *rand.Rand
	stopCh            chan struct{}
	clock             func() uint64 // Frame timestamps (engine clock; replaceable in tests)
}

// NewTrackSimulator creates a physics-based multi-gate simulator linked to the timing engine.
func NewTrackSimulator(engine *tracker.Engine) *TrackSimulator {
	s := &TrackSimulator{
		engine:            engine,
		running:           true,
		trackLengthMeters: 360.0, // 360m 4-gate technical race track (~13-15s lap time)
		rng:               rand.New(rand.NewSource(time.Now().UnixNano())),
		stopCh:            make(chan struct{}),
	}
	s.clock = engine.NowUs
	s.resetPilotsLocked()
	return s
}

func (s *TrackSimulator) resetPilotsLocked() {
	// Give each pilot slot a distinct pace and a specific sector bottleneck
	s.pilotStates = []simPilotState{
		{slotIndex: 1, trackPosMeters: 350.0, baseSpeedMps: 29.5, weakSectorIdx: 2, weaknessPenalty: 0.77}, // Fast, loses time in Sector 3 (Split-S)
		{slotIndex: 2, trackPosMeters: 325.0, baseSpeedMps: 28.4, weakSectorIdx: 3, weaknessPenalty: 0.75}, // Loses time in Sector 4 (Corkscrew)
		{slotIndex: 3, trackPosMeters: 295.0, baseSpeedMps: 27.6, weakSectorIdx: 1, weaknessPenalty: 0.80}, // Loses time in Sector 2
		{slotIndex: 4, trackPosMeters: 265.0, baseSpeedMps: 26.8, weakSectorIdx: 2, weaknessPenalty: 0.74}, // Struggles in Sector 3
		{slotIndex: 5, trackPosMeters: 240.0, baseSpeedMps: 28.0, weakSectorIdx: 0, weaknessPenalty: 0.82},
		{slotIndex: 6, trackPosMeters: 215.0, baseSpeedMps: 27.1, weakSectorIdx: 3, weaknessPenalty: 0.78},
		{slotIndex: 7, trackPosMeters: 190.0, baseSpeedMps: 26.4, weakSectorIdx: 1, weaknessPenalty: 0.79},
		{slotIndex: 8, trackPosMeters: 165.0, baseSpeedMps: 25.9, weakSectorIdx: 2, weaknessPenalty: 0.76},
		{slotIndex: 9, trackPosMeters: 140.0, baseSpeedMps: 27.8, weakSectorIdx: 3, weaknessPenalty: 0.77},
		{slotIndex: 10, trackPosMeters: 115.0, baseSpeedMps: 26.9, weakSectorIdx: 1, weaknessPenalty: 0.78},
		{slotIndex: 11, trackPosMeters: 90.0, baseSpeedMps: 27.3, weakSectorIdx: 0, weaknessPenalty: 0.80},
		{slotIndex: 12, trackPosMeters: 65.0, baseSpeedMps: 26.2, weakSectorIdx: 2, weaknessPenalty: 0.75},
		{slotIndex: 13, trackPosMeters: 50.0, baseSpeedMps: 27.0, weakSectorIdx: 3, weaknessPenalty: 0.77},
		{slotIndex: 14, trackPosMeters: 35.0, baseSpeedMps: 26.5, weakSectorIdx: 1, weaknessPenalty: 0.78},
		{slotIndex: 15, trackPosMeters: 20.0, baseSpeedMps: 26.1, weakSectorIdx: 2, weaknessPenalty: 0.76},
		{slotIndex: 16, trackPosMeters: 5.0, baseSpeedMps: 25.8, weakSectorIdx: 0, weaknessPenalty: 0.79},
	}
}

// Prewarm fast-forwards the simulation by `d` at startup so the UI immediately
// displays completed laps, sector splits, and standings as soon as it opens.
func (s *TrackSimulator) Prewarm(d time.Duration) {
	const dtSec = 0.020
	const stepUs = 20_000
	steps := int(d.Seconds() / dtSec)
	if steps <= 0 {
		return
	}
	s.engine.BackdateBootTime(d)
	var simClockUs uint64 = stepUs
	origClock := s.clock
	s.clock = func() uint64 { return simClockUs }
	for i := 0; i < steps; i++ {
		s.step(dtSec)
		simClockUs += stepUs
	}
	s.clock = origClock
}

// Start launches the 50 Hz simulation loop (20 ms tick interval).
func (s *TrackSimulator) Start() {
	go s.loop()
}

// Stop halts the background simulator goroutine.
func (s *TrackSimulator) Stop() {
	close(s.stopCh)
}

// SetRunning enables or pauses simulated telemetry generation.
func (s *TrackSimulator) SetRunning(running bool) {
	s.mu.Lock()
	s.running = running
	s.mu.Unlock()
}

// IsRunning returns true if the simulator is actively generating frames.
func (s *TrackSimulator) IsRunning() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.running
}

// TriggerPackBurst bunches all active pilots tightly right before Gate 1 (Start/Finish)
// to demonstrate 8-channel simultaneous tight-pack crossing resolution.
func (s *TrackSimulator) TriggerPackBurst() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.pilotStates {
		// Space pilots 4.5 meters apart (~150 ms apart at 65 mph) approaching Gate 1 (pos = 0m)
		s.pilotStates[i].trackPosMeters = s.trackLengthMeters - 14.0 - float64(i)*4.8
	}
}

func (s *TrackSimulator) loop() {
	const dtSec = 0.020 // 50 Hz (20 ms per frame)
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-s.stopCh:
			return
		case <-ticker.C:
			s.step(dtSec)
		}
	}
}

func (s *TrackSimulator) step(dtSec float64) {
	s.mu.Lock()
	if !s.running {
		s.mu.Unlock()
		return
	}

	pilots, pucks, _, _, _ := s.engine.StateSnapshot()
	detected := s.engine.DetectedPucksSnapshot()
	numPucks := len(pucks)
	nowUs := s.clock()
	s.seqCounter++

	if numPucks == 0 {
		frames := make([]domain.PuckTelemetryFrame, 0, len(detected))
		for _, d := range detected {
			var rssi [domain.MaxPilotPoolSize]float32
			for slotIdx := 0; slotIdx < len(pilots) && slotIdx < domain.MaxPilotPoolSize; slotIdx++ {
				rssi[slotIdx] = d.NoiseFloorDbm + float32((s.rng.Float64()-0.5)*2.0)
			}
			frames = append(frames, domain.PuckTelemetryFrame{
				PuckID:        d.PuckID,
				SeqNum:        s.seqCounter,
				TimestampUs:   nowUs,
				RSSI:          rssi,
				BatteryMv:     d.BatteryMv,
				NoiseFloorDbm: d.NoiseFloorDbm,
			})
		}
		s.mu.Unlock()
		for _, f := range frames {
			s.engine.IngestTelemetryFrame(f)
		}
		return
	}

	sectorLen := s.trackLengthMeters / float64(numPucks)

	// 1. Advance each enabled pilot along the track
	for i := range s.pilotStates {
		ps := &s.pilotStates[i]
		if i < len(pilots) && (!pilots[i].Enabled || pilots[i].Channel == 0) {
			continue
		}

		currentSector := int(ps.trackPosMeters/sectorLen) % numPucks
		speed := ps.baseSpeedMps

		// Apply realistic cornering / technical sector speed profile
		switch currentSector {
		case 0: // Fast straight + sweeper entry
			speed *= 1.06
		case 1: // High sweeper
			speed *= 0.98
		case 2: // Split-S dive (slower entry, fast vertical exit)
			speed *= 0.89
		case 3: // Technical corkscrew (tightest section on track)
			speed *= 0.83
		}

		// Apply pilot-specific bottleneck & lap-to-lap line variation
		if currentSector == ps.weakSectorIdx {
			jitter := 1.0 + (s.rng.Float64()-0.5)*0.22
			speed *= ps.weaknessPenalty * jitter
		} else {
			jitter := 1.0 + (s.rng.Float64()-0.5)*0.06
			speed *= jitter
		}

		ps.trackPosMeters += speed * dtSec
		if ps.trackPosMeters >= s.trackLengthMeters {
			ps.trackPosMeters -= s.trackLengthMeters
		}
	}

	// 2. Compute 8-channel 5.8 GHz RSSI at each Gate Puck and emit frame
	frames := make([]domain.PuckTelemetryFrame, 0, numPucks+len(detected))
	assignedSet := make(map[uint8]bool, numPucks)
	for pIdx, puck := range pucks {
		if puck.AssignedPuckID == 0 {
			continue
		}
		assignedSet[puck.AssignedPuckID] = true
		gatePosMeters := float64(pIdx) * sectorLen
		var rssi [domain.MaxPilotPoolSize]float32

		for slotIdx := 0; slotIdx < len(pilots) && slotIdx < domain.MaxPilotPoolSize && slotIdx < len(s.pilotStates); slotIdx++ {
			noise := float32((s.rng.Float64() - 0.5) * 2.2)
			if !pilots[slotIdx].Enabled || pilots[slotIdx].Channel == 0 {
				rssi[slotIdx] = puck.NoiseFloorDbm + noise
				continue
			}

			ps := s.pilotStates[slotIdx]
			// Shortest circular distance along track loop between drone and gate
			dx := math.Abs(ps.trackPosMeters - gatePosMeters)
			if dx > s.trackLengthMeters/2.0 {
				dx = s.trackLengthMeters - dx
			}

			// 3D Euclidean distance to gate puck on ground (gate clearance height h = 1.25m)
			dist3D := math.Sqrt(dx*dx + 1.25*1.25)

			// Free-space + ground multipath 5.8 GHz RSSI model:
			// Peak inside gate (~1.25m) reaches ~ -26 dBm; drops by ~22 dB per decade of distance
			multipathRipple := math.Sin(dx*2.7)*1.8 + math.Cos(dx*1.3)*1.2
			sigDbm := -24.5 - 23.5*math.Log10(dist3D) + multipathRipple + float64(noise)
			if sigDbm < float64(puck.NoiseFloorDbm) {
				sigDbm = float64(puck.NoiseFloorDbm) + float64(noise)*0.5
			}
			if sigDbm > -20.0 {
				sigDbm = -20.0
			}
			rssi[slotIdx] = float32(sigDbm)
		}

		frames = append(frames, domain.PuckTelemetryFrame{
			PuckID:        puck.AssignedPuckID,
			SeqNum:        s.seqCounter,
			TimestampUs:   nowUs,
			RSSI:          rssi,
			BatteryMv:     puck.BatteryMv,
			NoiseFloorDbm: puck.NoiseFloorDbm,
		})
	}
	for _, d := range detected {
		if assignedSet[d.PuckID] {
			continue
		}
		var rssi [domain.MaxPilotPoolSize]float32
		for slotIdx := 0; slotIdx < len(pilots) && slotIdx < domain.MaxPilotPoolSize; slotIdx++ {
			rssi[slotIdx] = d.NoiseFloorDbm + float32((s.rng.Float64()-0.5)*2.0)
		}
		frames = append(frames, domain.PuckTelemetryFrame{
			PuckID:        d.PuckID,
			SeqNum:        s.seqCounter,
			TimestampUs:   nowUs,
			RSSI:          rssi,
			BatteryMv:     d.BatteryMv,
			NoiseFloorDbm: d.NoiseFloorDbm,
		})
	}
	s.mu.Unlock()

	for _, f := range frames {
		s.engine.IngestTelemetryFrame(f)
	}
}
