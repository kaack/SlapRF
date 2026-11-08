package ingest

import (
	"fmt"
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
	currentSpeedMps float64
	altitudeMeters  float64
	weakSectorIdx   int     // 0-based sector where this pilot has higher variance/slower speed
	weaknessPenalty float64 // speed multiplier in weak sector (e.g. 0.76)

	status          domain.SimPilotStatus
	batteryPct      float64 // 0..100%
	stateTimerSec   float64 // countdown for CRASHED_VTX_ON or PIT_SWAP
	wantPitAtFinish bool    // true when battery is low and pilot will pit upon crossing Gate 1
	crashesCount    int
	packsFlown      int
}

// TrackSimulator generates realistic 50 Hz multi-gate 5.8 GHz SDR telemetry streams
// across all deployed Gate Pucks, modeling inverse-square RF path loss, multipath noise,
// per-sector speed variations, drone battery drain, pit pack swaps, crashes with lingering
// VTX signals, and track-walk high-altitude avoidance.
type TrackSimulator struct {
	mu                  sync.Mutex
	engine              *tracker.Engine
	running             bool
	autoPracticeEvents  bool
	prewarming          bool
	trackWalkerActive   bool
	trackWalkerTimerSec float64
	trackLengthMeters   float64
	pilotStates         []simPilotState
	poweredOffTimers    map[uint8]bool
	seqCounter          uint32
	rng                 *rand.Rand
	stopCh              chan struct{}
	clock               func() uint64 // Frame timestamps (engine clock; replaceable in tests)
}

// NewTrackSimulator creates a physics-based multi-gate simulator linked to the timing engine.
func NewTrackSimulator(engine *tracker.Engine) *TrackSimulator {
	s := &TrackSimulator{
		engine:             engine,
		running:            true,
		autoPracticeEvents: true,
		trackLengthMeters:  360.0, // 360m 4-gate technical race track (~13-15s lap time)
		poweredOffTimers:   make(map[uint8]bool),
		rng:                rand.New(rand.NewSource(time.Now().UnixNano())),
		stopCh:             make(chan struct{}),
	}
	s.clock = engine.NowUs
	s.resetPilotsLocked()
	return s
}

func (s *TrackSimulator) resetPilotsLocked() {
	// Give each pilot slot a distinct pace, sector bottleneck, and staggered initial battery level
	baseConfigs := []struct {
		pos     float64
		speed   float64
		weakSec int
		penalty float64
		battPct float64
	}{
		{350.0, 29.5, 2, 0.77, 94.0}, // Slot 1 (FAERRY): Fast, loses time in Sector 3
		{325.0, 28.4, 3, 0.75, 81.0}, // Slot 2 (MeWo): Loses time in Sector 4
		{295.0, 27.6, 1, 0.80, 68.0}, // Slot 3 (Din): Loses time in Sector 2
		{265.0, 26.8, 2, 0.74, 55.0}, // Slot 4 (BigRamon): Struggles in Sector 3
		{240.0, 28.0, 0, 0.82, 90.0},
		{215.0, 27.1, 3, 0.78, 76.0},
		{190.0, 26.4, 1, 0.79, 84.0},
		{165.0, 25.9, 2, 0.76, 62.0},
		{140.0, 27.8, 3, 0.77, 88.0},
		{115.0, 26.9, 1, 0.78, 72.0},
		{90.0, 27.3, 0, 0.80, 95.0},
		{65.0, 26.2, 2, 0.75, 80.0},
		{50.0, 27.0, 3, 0.77, 85.0},
		{35.0, 26.5, 1, 0.78, 77.0},
		{20.0, 26.1, 2, 0.76, 91.0},
		{5.0, 25.8, 0, 0.79, 70.0},
	}

	s.pilotStates = make([]simPilotState, len(baseConfigs))
	for i, cfg := range baseConfigs {
		s.pilotStates[i] = simPilotState{
			slotIndex:       i + 1,
			trackPosMeters:  cfg.pos,
			baseSpeedMps:    cfg.speed,
			currentSpeedMps: cfg.speed,
			altitudeMeters:  1.25,
			weakSectorIdx:   cfg.weakSec,
			weaknessPenalty: cfg.penalty,
			status:          domain.SimStatusFlying,
			batteryPct:      cfg.battPct,
			packsFlown:      1,
		}
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
	s.mu.Lock()
	s.prewarming = true
	s.mu.Unlock()
	for i := 0; i < steps; i++ {
		s.step(dtSec)
		simClockUs += stepUs
	}
	s.mu.Lock()
	s.prewarming = false
	s.mu.Unlock()
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
// and puts them in the air at 100% battery to demonstrate 8-channel pack crossing resolution.
func (s *TrackSimulator) TriggerPackBurst() {
	s.mu.Lock()
	s.trackWalkerActive = false
	s.trackWalkerTimerSec = 0
	for i := range s.pilotStates {
		ps := &s.pilotStates[i]
		ps.status = domain.SimStatusFlying
		ps.batteryPct = 100.0
		ps.wantPitAtFinish = false
		ps.stateTimerSec = 0
		ps.altitudeMeters = 1.25
		ps.currentSpeedMps = ps.baseSpeedMps
		// Space pilots 4.5 meters apart (~150 ms apart at 65 mph) approaching Gate 1 (pos = 0m)
		ps.trackPosMeters = s.trackLengthMeters - 14.0 - float64(i)*4.8
	}
	s.mu.Unlock()
}

// SetTrackWalker activates or clears a simulated person walking on the track (e.g. quad recovery).
// While active, some airborne pilots return to the pit bench while others fly high (AVOIDING)
// until the track is cleared, and crashed quads are recovered to the bench.
func (s *TrackSimulator) SetTrackWalker(active bool) {
	var clearSlots []int
	s.mu.Lock()
	s.trackWalkerActive = active
	if active {
		s.trackWalkerTimerSec = 15.0
		avoidingCount := 0
		for i := range s.pilotStates {
			ps := &s.pilotStates[i]
			switch ps.status {
			case domain.SimStatusFlying:
				// Pilots with lower battery (< 72%) or ~35% chance decide to come back to the bench;
				// pilots with fuller packs stay airborne and fly high until the track is cleared.
				returnToBench := ps.batteryPct < 72.0 || (avoidingCount > 0 && s.rng.Float64() < 0.35)
				if returnToBench {
					ps.status = domain.SimStatusPitSwap
					ps.stateTimerSec = 30.0 + s.rng.Float64()*30.0
					ps.batteryPct = 0.0
					ps.altitudeMeters = 0.0
					ps.currentSpeedMps = 0.0
					ps.trackPosMeters = s.trackLengthMeters - 12.0
				} else {
					ps.status = domain.SimStatusAvoiding
					ps.altitudeMeters = 14.0
					avoidingCount++
				}
				clearSlots = append(clearSlots, ps.slotIndex)
			case domain.SimStatusCrashedVtxOn, domain.SimStatusCrashedRecovery:
				ps.status = domain.SimStatusPitSwap
				ps.stateTimerSec = 30.0 + s.rng.Float64()*20.0
				ps.batteryPct = 0.0
				ps.altitudeMeters = 0.0
				ps.currentSpeedMps = 0.0
				ps.trackPosMeters = s.trackLengthMeters - 12.0
				clearSlots = append(clearSlots, ps.slotIndex)
			}
		}
	} else {
		s.trackWalkerTimerSec = 0
		for i := range s.pilotStates {
			ps := &s.pilotStates[i]
			if ps.status == domain.SimStatusAvoiding {
				ps.status = domain.SimStatusFlying
				ps.altitudeMeters = 1.25
				ps.trackPosMeters = s.trackLengthMeters - 14.0 - float64(i)*4.0
				clearSlots = append(clearSlots, ps.slotIndex)
			}
		}
	}
	s.mu.Unlock()

	for _, slot := range clearSlots {
		s.engine.ClearPilotProgress(slot)
	}
}

// TriggerPilotAction executes an interactive pilot simulation command from the Sim tab:
// "crash", "recover", "walk-recover", "pit", "launch", "pause", or "resume".
func (s *TrackSimulator) TriggerPilotAction(slotIndex int, action string) {
	if action == "walk-recover" {
		s.SetTrackWalker(true)
		return
	}
	var clearProgress bool
	s.mu.Lock()
	_, pucks, _, _, _ := s.engine.StateSnapshot()
	numPucks := len(pucks)
	sectorLen := s.trackLengthMeters
	if numPucks > 0 {
		sectorLen = s.trackLengthMeters / float64(numPucks)
	}

	for i := range s.pilotStates {
		ps := &s.pilotStates[i]
		if ps.slotIndex != slotIndex {
			continue
		}
		switch action {
		case "crash":
			// Snap pilot near the closest gate so their lingering VTX signal illuminates that gate
			if numPucks > 0 {
				nearestGateIdx := int(math.Round(ps.trackPosMeters/sectorLen)) % numPucks
				ps.trackPosMeters = math.Mod(float64(nearestGateIdx)*sectorLen+2.8, s.trackLengthMeters)
			}
			ps.status = domain.SimStatusCrashedVtxOn
			ps.stateTimerSec = 8.0
			ps.currentSpeedMps = 0
			ps.altitudeMeters = 0.15
			ps.crashesCount++
		case "recover":
			// Turtle mode / field recovery: resume flying from current position (or launch if battery empty)
			if ps.batteryPct < 15.0 {
				ps.batteryPct = 100.0
				ps.packsFlown++
				ps.trackPosMeters = s.trackLengthMeters - 12.0
				clearProgress = true
			}
			if s.trackWalkerActive {
				ps.status = domain.SimStatusAvoiding
				ps.altitudeMeters = 14.0
			} else {
				ps.status = domain.SimStatusFlying
				ps.altitudeMeters = 1.25
			}
			ps.stateTimerSec = 0
			ps.currentSpeedMps = ps.baseSpeedMps
		case "pit":
			ps.status = domain.SimStatusPitSwap
			ps.stateTimerSec = 30.0 + s.rng.Float64()*30.0
			ps.batteryPct = 0
			ps.currentSpeedMps = 0
			ps.altitudeMeters = 0
			ps.wantPitAtFinish = false
			ps.trackPosMeters = s.trackLengthMeters - 12.0
			clearProgress = true
		case "pause":
			ps.status = domain.SimStatusPaused
			ps.stateTimerSec = 0
			ps.currentSpeedMps = 0
			ps.altitudeMeters = 0
			ps.wantPitAtFinish = false
			ps.trackPosMeters = s.trackLengthMeters - 12.0
			clearProgress = true
		case "launch", "resume":
			if ps.batteryPct < 25.0 || ps.status == domain.SimStatusPitSwap {
				ps.batteryPct = 100.0
				ps.packsFlown++
			}
			ps.wantPitAtFinish = false
			ps.stateTimerSec = 0
			ps.trackPosMeters = s.trackLengthMeters - 12.0
			if s.trackWalkerActive {
				ps.status = domain.SimStatusAvoiding
				ps.altitudeMeters = 14.0
			} else {
				ps.status = domain.SimStatusFlying
				ps.altitudeMeters = 1.25
			}
			ps.currentSpeedMps = ps.baseSpeedMps
			clearProgress = true
		}
		break
	}
	s.mu.Unlock()

	if clearProgress {
		s.engine.ClearPilotProgress(slotIndex)
	}
}

// ToggleTimerPower turns a simulated XIAO timer (T1..T6) off or back on.
func (s *TrackSimulator) ToggleTimerPower(puckID uint8) bool {
	s.mu.Lock()
	currentlyOff := s.poweredOffTimers[puckID]
	nextOff := !currentlyOff
	if nextOff {
		s.poweredOffTimers[puckID] = true
	} else {
		delete(s.poweredOffTimers, puckID)
	}
	s.mu.Unlock()

	s.engine.SetDetectedPuckOnline(puckID, !nextOff)
	return !nextOff
}

// DeleteTimer removes a simulated hardware timer from the simulation and engine.
func (s *TrackSimulator) DeleteTimer(puckID uint8) error {
	s.mu.Lock()
	delete(s.poweredOffTimers, puckID)
	s.mu.Unlock()
	return s.engine.DeleteDetectedPuck(puckID)
}

// AddTimer creates a new simulated XIAO timer (up to 6 total).
func (s *TrackSimulator) AddTimer(role string, label string, fwVersion string) (uint8, error) {
	id, err := s.engine.AddSimulatedPuck(role, label, fwVersion)
	if err != nil {
		return 0, err
	}
	s.mu.Lock()
	delete(s.poweredOffTimers, id)
	s.mu.Unlock()
	return id, nil
}

// Snapshot returns the current `domain.SimState` for the Sim UI view.
func (s *TrackSimulator) Snapshot() domain.SimState {
	pilots, pucks, _, _, _ := s.engine.StateSnapshot()
	detected := s.engine.DetectedPucksSnapshot()

	s.mu.Lock()
	defer s.mu.Unlock()

	numPucks := len(pucks)
	sectorLen := s.trackLengthMeters
	if numPucks > 0 {
		sectorLen = s.trackLengthMeters / float64(numPucks)
	}

	simPilots := make([]domain.SimPilotState, 0, len(pilots))
	for i, p := range pilots {
		if i >= len(s.pilotStates) {
			break
		}
		ps := s.pilotStates[i]
		nearestGate := "Start / Finish"
		if numPucks > 0 {
			gIdx := int(math.Round(ps.trackPosMeters/sectorLen)) % numPucks
			g := pucks[gIdx]
			if g.Name != "" {
				nearestGate = g.Name
			} else if g.PuckLabel != "" {
				nearestGate = g.PuckLabel
			} else {
				nearestGate = fmt.Sprintf("Gate %d", gIdx+1)
			}
		}

		vtxActive := p.Enabled && p.Channel > 0 &&
			(ps.status == domain.SimStatusFlying ||
				ps.status == domain.SimStatusAvoiding ||
				ps.status == domain.SimStatusCrashedVtxOn)

		speedMph := 0.0
		if p.Enabled && p.Channel > 0 && (ps.status == domain.SimStatusFlying || ps.status == domain.SimStatusAvoiding) {
			speedMph = math.Round(ps.currentSpeedMps*2.23694*10) / 10
		}

		volts := 0.0
		if ps.batteryPct > 0 {
			volts = 21.0 + (ps.batteryPct/100.0)*4.2 // 6S LiPo: 21.0V (3.5V/cell) .. 25.2V (4.2V/cell)
		}
		simPilots = append(simPilots, domain.SimPilotState{
			SlotIndex:         p.SlotIndex,
			Callsign:          p.Callsign,
			Color:             p.Color,
			Channel:           p.Channel,
			FrequencyMHz:      p.FrequencyMHz,
			Enabled:           p.Enabled,
			Status:            ps.status,
			BatteryPct:        uint8(math.Round(math.Max(0, math.Min(100, ps.batteryPct)))),
			BatteryVolts:      math.Round(volts*100) / 100,
			TrackProgress:     math.Round((ps.trackPosMeters/s.trackLengthMeters)*1000) / 1000,
			SpeedMph:          speedMph,
			AltitudeMeters:    ps.altitudeMeters,
			VtxActive:         vtxActive,
			NearestGateLabel:  nearestGate,
			StateRemainingSec: math.Round(math.Max(0, ps.stateTimerSec)*10) / 10,
			CrashesCount:      ps.crashesCount,
			PacksFlown:        ps.packsFlown,
		})
	}

	gateByPuck := make(map[uint8]string, len(pucks))
	for idx, g := range pucks {
		if g.AssignedPuckID > 0 {
			if g.Name != "" {
				gateByPuck[g.AssignedPuckID] = g.Name
			} else {
				gateByPuck[g.AssignedPuckID] = fmt.Sprintf("Gate %d", idx+1)
			}
		}
	}

	simTimers := make([]domain.SimTimerState, 0, len(detected))
	for _, d := range detected {
		poweredOn := !s.poweredOffTimers[d.PuckID]
		fw := d.FirmwareVersion
		if fw == "" {
			fw = domain.LatestFirmwareVersion
		}
		simTimers = append(simTimers, domain.SimTimerState{
			PuckID:           d.PuckID,
			PuckLabel:        d.PuckLabel,
			Color:            d.Color,
			IsHub:            d.IsHub,
			FirmwareVersion:  fw,
			PoweredOn:        poweredOn,
			Online:           d.Online && poweredOn,
			AssignedGateName: gateByPuck[d.PuckID],
			BatteryMv:        d.BatteryMv,
			BatteryPct:       d.BatteryPct,
			NoiseFloorDbm:    d.NoiseFloorDbm,
		})
	}

	return domain.SimState{
		Running:            s.running,
		TrackWalkerActive:  s.trackWalkerActive,
		AutoPracticeEvents: s.autoPracticeEvents,
		TrackWalkerSecLeft: math.Round(math.Max(0, s.trackWalkerTimerSec)*10) / 10,
		Pilots:             simPilots,
		Timers:             simTimers,
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

	var clearSlots []int

	// Handle automatic track-walker recovery timer
	if s.trackWalkerActive && s.trackWalkerTimerSec > 0 {
		s.trackWalkerTimerSec -= dtSec
		if s.trackWalkerTimerSec <= 0 {
			s.trackWalkerActive = false
			s.trackWalkerTimerSec = 0
			for i := range s.pilotStates {
				ps := &s.pilotStates[i]
				if ps.status == domain.SimStatusAvoiding {
					ps.status = domain.SimStatusFlying
					ps.altitudeMeters = 1.25
					ps.trackPosMeters = s.trackLengthMeters - 14.0 - float64(i)*4.0
					clearSlots = append(clearSlots, ps.slotIndex)
				}
			}
		}
	}

	if numPucks == 0 {
		frames := make([]domain.PuckTelemetryFrame, 0, len(detected))
		for _, d := range detected {
			if s.poweredOffTimers[d.PuckID] {
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
		return
	}

	sectorLen := s.trackLengthMeters / float64(numPucks)

	// 1. Advance each enabled pilot along the track & update battery/pit/crash state machine
	waitingRecoveryCount := 0
	flyingCount := 0

	for i := range s.pilotStates {
		ps := &s.pilotStates[i]
		if i < len(pilots) && (!pilots[i].Enabled || pilots[i].Channel == 0) {
			continue
		}

		switch ps.status {
		case domain.SimStatusPaused:
			ps.currentSpeedMps = 0
			continue

		case domain.SimStatusCrashedVtxOn:
			ps.currentSpeedMps = 0
			ps.stateTimerSec -= dtSec
			if ps.stateTimerSec <= 0 {
				// 35% chance pilot flips over with turtle mode and keeps flying; otherwise enters Pit Mode waiting for recovery
				if s.rng.Float64() < 0.35 && !s.trackWalkerActive {
					ps.status = domain.SimStatusFlying
					ps.altitudeMeters = 1.25
					ps.stateTimerSec = 0
				} else {
					ps.status = domain.SimStatusCrashedRecovery
					ps.stateTimerSec = 0
				}
			}
			continue

		case domain.SimStatusCrashedRecovery:
			ps.currentSpeedMps = 0
			waitingRecoveryCount++
			continue

		case domain.SimStatusPitSwap:
			ps.currentSpeedMps = 0
			ps.stateTimerSec -= dtSec
			// Pack is unplugged (0%) while retrieving quad, walking to bench, unstrapping old pack,
			// strapping fresh pack, and walking back to the launch pad; in the final 4 seconds on the
			// launch pad, the pilot plugs in the fresh 100% 6S pack, sits down, arms, and takes off.
			if ps.stateTimerSec <= 4.0 && ps.stateTimerSec > 0 {
				ps.batteryPct = 100.0
			} else if ps.stateTimerSec > 4.0 {
				ps.batteryPct = 0.0
			}
			if ps.stateTimerSec <= 0 {
				ps.batteryPct = 100.0
				ps.packsFlown++
				ps.wantPitAtFinish = false
				ps.stateTimerSec = 0
				ps.trackPosMeters = s.trackLengthMeters - 10.0
				if s.trackWalkerActive {
					ps.status = domain.SimStatusAvoiding
					ps.altitudeMeters = 14.0
				} else {
					ps.status = domain.SimStatusFlying
					ps.altitudeMeters = 1.25
				}
				clearSlots = append(clearSlots, ps.slotIndex)
			}
			continue
		}

		// Pilot is airborne (FLYING or AVOIDING)
		flyingCount++
		if !s.prewarming && s.autoPracticeEvents {
			// Drain 6S flight pack (~0.58% per second -> ~2.4 minutes per pack)
			ps.batteryPct = math.Max(5.0, ps.batteryPct-dtSec*0.58)
			if ps.batteryPct <= 16.0 {
				ps.wantPitAtFinish = true
			}
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

		ps.currentSpeedMps = speed
		prevPos := ps.trackPosMeters
		ps.trackPosMeters += speed * dtSec
		if ps.trackPosMeters >= s.trackLengthMeters {
			ps.trackPosMeters -= s.trackLengthMeters
		}

		// Once the pilot finishes their lap through Gate 1 (pos wraps past 0) and is ~10m past
		// the start/finish gate, if their battery is low, pull into the pits and unplug the pack.
		// Unplugging drops VTX RSSI to noise floor so Gate 1's detector immediately exits and
		// scores the completed lap; ClearPilotProgress is then called when launching the next pack.
		if !s.prewarming && ps.wantPitAtFinish && prevPos < 10.0 && ps.trackPosMeters >= 10.0 {
			ps.status = domain.SimStatusPitSwap
			ps.stateTimerSec = 30.0 + s.rng.Float64()*30.0
			ps.batteryPct = 0
			ps.currentSpeedMps = 0
			ps.altitudeMeters = 0
			ps.wantPitAtFinish = false
		}
	}

	// If a crashed drone is waiting on the track and all other pilots have landed for pit swaps,
	// automatically trigger a brief track walk to recover the crashed drone!
	if !s.prewarming && waitingRecoveryCount > 0 && flyingCount == 0 && !s.trackWalkerActive {
		s.trackWalkerActive = true
		s.trackWalkerTimerSec = 8.0
		for i := range s.pilotStates {
			ps := &s.pilotStates[i]
			if ps.status == domain.SimStatusCrashedRecovery {
				ps.status = domain.SimStatusPitSwap
				ps.stateTimerSec = 8.0
				ps.trackPosMeters = s.trackLengthMeters - 10.0
				clearSlots = append(clearSlots, ps.slotIndex)
			}
		}
	}

	// 2. Compute 8-channel 5.8 GHz RSSI at each powered-on Gate Puck and emit frame
	frames := make([]domain.PuckTelemetryFrame, 0, numPucks+len(detected))
	assignedSet := make(map[uint8]bool, numPucks)
	for pIdx, puck := range pucks {
		if puck.AssignedPuckID == 0 {
			continue
		}
		assignedSet[puck.AssignedPuckID] = true
		if s.poweredOffTimers[puck.AssignedPuckID] {
			continue // Simulated timer is switched OFF in the Sim tab
		}
		gatePosMeters := float64(pIdx) * sectorLen
		var rssi [domain.MaxPilotPoolSize]float32

		for slotIdx := 0; slotIdx < len(pilots) && slotIdx < domain.MaxPilotPoolSize && slotIdx < len(s.pilotStates); slotIdx++ {
			noise := float32((s.rng.Float64() - 0.5) * 2.2)
			ps := s.pilotStates[slotIdx]
			vtxOn := pilots[slotIdx].Enabled &&
				pilots[slotIdx].Channel > 0 &&
				(ps.status == domain.SimStatusFlying ||
					ps.status == domain.SimStatusAvoiding ||
					ps.status == domain.SimStatusCrashedVtxOn)

			if !vtxOn {
				rssi[slotIdx] = puck.NoiseFloorDbm + noise
				continue
			}

			// Shortest circular distance along track loop between drone and gate
			dx := math.Abs(ps.trackPosMeters - gatePosMeters)
			if dx > s.trackLengthMeters/2.0 {
				dx = s.trackLengthMeters - dx
			}

			// 3D Euclidean distance to gate puck on ground (altitude = 1.25m normal, 14.0m when avoiding track walker)
			alt := ps.altitudeMeters
			if alt < 0.8 {
				alt = 0.8
			}
			dist3D := math.Sqrt(dx*dx + alt*alt)

			// Free-space + ground multipath 5.8 GHz RSSI model:
			// Peak inside gate (~1.25m) reaches ~ -26 dBm; drops by ~23.5 dB per decade of distance
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
		if assignedSet[d.PuckID] || s.poweredOffTimers[d.PuckID] {
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

	for _, slot := range clearSlots {
		s.engine.ClearPilotProgress(slot)
	}
	for _, f := range frames {
		s.engine.IngestTelemetryFrame(f)
	}
}
