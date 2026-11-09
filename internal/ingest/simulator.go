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

	status              domain.SimPilotStatus
	landingTargetStatus domain.SimPilotStatus
	batteryPct          float64    // 0..100% (active pack in quad, or 0 when unplugged)
	packPct             [3]float64 // 0..100% for each of the pilot's 3 6S LiPo packs
	activePackIdx       int        // 0..2 when plugged into quad, -1 when quad is unplugged
	stateTimerSec       float64    // countdown for current state machine phase
	turtleForceSuccess  bool       // true when user explicitly clicked "Turtle recover"
	wantPitAtFinish     bool       // true when battery is low and pilot will pit upon crossing Gate 1
	crashesCount        int
	packsFlown          int
}

func (ps *simPilotState) unplugActivePack() {
	if ps.activePackIdx >= 0 && ps.activePackIdx < 3 {
		if ps.packPct[ps.activePackIdx] >= 99.5 {
			ps.packPct[ps.activePackIdx] = 92.0
		}
	}
	ps.activePackIdx = -1
	ps.batteryPct = 0.0
}

func (ps *simPilotState) findReadyPack() int {
	for k := 0; k < 3; k++ {
		if k != ps.activePackIdx && ps.packPct[k] >= 99.5 {
			return k
		}
	}
	return -1
}

func (ps *simPilotState) maxPackPct() float64 {
	best := 0.0
	for k := 0; k < 3; k++ {
		if ps.packPct[k] > best {
			best = ps.packPct[k]
		}
	}
	return best
}

func (ps *simPilotState) plugInReadyOrBestPack() bool {
	if ps.activePackIdx >= 0 && ps.activePackIdx < 3 {
		ps.batteryPct = ps.packPct[ps.activePackIdx]
		return true
	}
	readyIdx := ps.findReadyPack()
	if readyIdx >= 0 {
		ps.activePackIdx = readyIdx
		ps.batteryPct = ps.packPct[readyIdx]
		return true
	}
	bestIdx := 0
	for k := 1; k < 3; k++ {
		if ps.packPct[k] > ps.packPct[bestIdx] {
			bestIdx = k
		}
	}
	if ps.packPct[bestIdx] > 5.0 {
		ps.activePackIdx = bestIdx
		ps.batteryPct = ps.packPct[bestIdx]
		return true
	}
	return false
}

// TrackSimulator generates realistic 50 Hz multi-gate 5.8 GHz SDR telemetry streams
// across all deployed Gate Timers, modeling inverse-square RF path loss, multipath noise,
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

const benchChargeRatePctPerSec = 0.14 // ~10 min to charge a depleted 6S pack from 16% -> 100%

func (s *TrackSimulator) resetPilotsLocked() {
	// Give each pilot slot a distinct pace, sector bottleneck, and staggered initial battery level
	baseConfigs := []struct {
		pos     float64
		speed   float64
		weakSec int
		penalty float64
		battPct float64
	}{
		{350.0, 29.5, 2, 0.77, 84.0}, // Slot 1 (FAERRY): Fast, loses time in Sector 3
		{325.0, 28.4, 3, 0.75, 58.0}, // Slot 2 (MeWo): Loses time in Sector 4
		{295.0, 27.6, 1, 0.80, 34.0}, // Slot 3 (Din): Loses time in Sector 2
		{265.0, 26.8, 2, 0.74, 66.0}, // Slot 4 (BigRamon): Struggles in Sector 3
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
		// Stagger the 2 bench batteries across pilots so some have a 100% READY pack waiting
		// while others have both bench packs still charging (so Waiting for Charge happens naturally).
		pack2 := 100.0
		pack3 := 100.0
		switch i % 4 {
		case 0:
			pack2 = 100.0
			pack3 = 36.0
		case 1:
			pack2 = 72.0
			pack3 = 31.0
		case 2:
			pack2 = 78.0
			pack3 = 40.0
		case 3:
			pack2 = 100.0
			pack3 = 24.0
		}
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
			packPct:         [3]float64{cfg.battPct, pack2, pack3},
			activePackIdx:   0,
			packsFlown:      1,
		}
	}
}

func (s *TrackSimulator) startLandingLocked(ps *simPilotState, target domain.SimPilotStatus) {
	ps.status = domain.SimStatusLanding
	ps.landingTargetStatus = target
	ps.stateTimerSec = 5.0
	ps.wantPitAtFinish = false
	ps.currentSpeedMps = ps.baseSpeedMps * 0.45
	if ps.altitudeMeters > 2.5 {
		ps.altitudeMeters = 2.5
	}
}

func (s *TrackSimulator) enterPitAfterFlightLocked(ps *simPilotState) {
	ps.unplugActivePack()
	ps.altitudeMeters = 0.0
	ps.currentSpeedMps = 0.0
	ps.wantPitAtFinish = false
	ps.trackPosMeters = s.trackLengthMeters - 12.0

	// If all 3 batteries are currently charging (< 100%), pilot must wait for a pack to finish charging
	if ps.findReadyPack() < 0 {
		ps.status = domain.SimStatusChargingWait
		ps.stateTimerSec = 0
		return
	}
	// ~28% of the time after landing, pilot decides to take a break at the bench before strapping the next pack
	if !s.prewarming && s.autoPracticeEvents && s.rng.Float64() < 0.28 {
		ps.status = domain.SimStatusPilotBreak
		ps.stateTimerSec = 45.0 + s.rng.Float64()*45.0
		return
	}
	ps.status = domain.SimStatusPitSwap
	ps.stateTimerSec = 30.0 + s.rng.Float64()*30.0
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
		ps.packPct = [3]float64{100.0, 100.0, 100.0}
		ps.activePackIdx = 0
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
// until the track is cleared; crashed quads stay on the field while being walked out to and move
// to the pit bench once the recovery walk finishes.
func (s *TrackSimulator) SetTrackWalker(active bool) {
	var clearSlots []int
	s.mu.Lock()
	s.trackWalkerActive = active
	if active {
		s.trackWalkerTimerSec = 30.0 + s.rng.Float64()*30.0
		avoidingCount := 0
		for i := range s.pilotStates {
			ps := &s.pilotStates[i]
			switch ps.status {
			case domain.SimStatusFlying:
				// Pilots with lower battery (< 72%) or ~35% chance decide to come back to the bench;
				// pilots with fuller packs stay airborne and fly high until the track is cleared.
				returnToBench := ps.batteryPct < 72.0 || (avoidingCount > 0 && s.rng.Float64() < 0.35)
				if returnToBench {
					s.startLandingLocked(ps, domain.SimStatusPitSwap)
				} else {
					ps.status = domain.SimStatusAvoiding
					ps.altitudeMeters = 14.0
					avoidingCount++
				}
				clearSlots = append(clearSlots, ps.slotIndex)
			case domain.SimStatusCrashedVtxOn,
				domain.SimStatusTurtleRecovery,
				domain.SimStatusTurtleFailed,
				domain.SimStatusCrashedRecovery,
				domain.SimStatusWalkingRecovery:
				// Quad stays on the field in Pit Mode while the pilot walks out on the track to retrieve it
				ps.status = domain.SimStatusWalkingRecovery
				ps.stateTimerSec = s.trackWalkerTimerSec
				ps.turtleForceSuccess = false
				ps.currentSpeedMps = 0.0
				clearSlots = append(clearSlots, ps.slotIndex)
			}
		}
	} else {
		s.trackWalkerTimerSec = 0
		for i := range s.pilotStates {
			ps := &s.pilotStates[i]
			switch ps.status {
			case domain.SimStatusAvoiding:
				ps.status = domain.SimStatusFlying
				ps.altitudeMeters = 1.25
				ps.trackPosMeters = s.trackLengthMeters - 14.0 - float64(i)*4.0
				clearSlots = append(clearSlots, ps.slotIndex)
			case domain.SimStatusCrashedRecovery, domain.SimStatusWalkingRecovery:
				// Recovery walk completed: quad is now back at the pit bench
				s.enterPitAfterFlightLocked(ps)
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
	_, gates, _, _, _ := s.engine.StateSnapshot()
	numGates := len(gates)
	sectorLen := s.trackLengthMeters
	if numGates > 0 {
		sectorLen = s.trackLengthMeters / float64(numGates)
	}

	for i := range s.pilotStates {
		ps := &s.pilotStates[i]
		if ps.slotIndex != slotIndex {
			continue
		}
		switch action {
		case "crash":
			// Snap pilot near the closest gate so their lingering VTX signal illuminates that gate
			if numGates > 0 {
				nearestGateIdx := int(math.Round(ps.trackPosMeters/sectorLen)) % numGates
				ps.trackPosMeters = math.Mod(float64(nearestGateIdx)*sectorLen+2.8, s.trackLengthMeters)
			}
			ps.status = domain.SimStatusCrashedVtxOn
			ps.stateTimerSec = 5.0
			ps.turtleForceSuccess = false
			ps.currentSpeedMps = 0
			ps.altitudeMeters = 0.15
			ps.crashesCount++
		case "recover":
			// Step into TURTLE_RECOVERY state (3.5s countdown spinning motors to flip upright) before resuming FLYING
			ps.status = domain.SimStatusTurtleRecovery
			ps.stateTimerSec = 3.5
			ps.turtleForceSuccess = true
			ps.currentSpeedMps = 0
			ps.altitudeMeters = 0.15
		case "pit":
			if ps.status == domain.SimStatusFlying || ps.status == domain.SimStatusAvoiding || ps.status == domain.SimStatusLanding {
				s.startLandingLocked(ps, domain.SimStatusPitSwap)
			} else {
				ps.unplugActivePack()
				if ps.findReadyPack() < 0 {
					ps.status = domain.SimStatusChargingWait
					ps.stateTimerSec = 0
				} else {
					ps.status = domain.SimStatusPitSwap
					ps.stateTimerSec = 30.0 + s.rng.Float64()*30.0
				}
				ps.currentSpeedMps = 0
				ps.altitudeMeters = 0
				ps.wantPitAtFinish = false
				ps.trackPosMeters = s.trackLengthMeters - 12.0
				clearProgress = true
			}
		case "pause", "break":
			target := domain.SimStatusPaused
			if action == "break" {
				target = domain.SimStatusPilotBreak
			}
			if ps.status == domain.SimStatusFlying || ps.status == domain.SimStatusAvoiding || ps.status == domain.SimStatusLanding {
				s.startLandingLocked(ps, target)
			} else {
				if ps.activePackIdx >= 0 && ps.activePackIdx < 3 {
					ps.batteryPct = ps.packPct[ps.activePackIdx]
				}
				ps.status = target
				if target == domain.SimStatusPilotBreak {
					ps.stateTimerSec = 60.0 + s.rng.Float64()*30.0
				} else {
					ps.stateTimerSec = 0
				}
				ps.currentSpeedMps = 0
				ps.altitudeMeters = 0
				ps.wantPitAtFinish = false
				ps.trackPosMeters = s.trackLengthMeters - 12.0
				clearProgress = true
			}
		case "launch", "resume":
			// Launch with the battery pack currently attached to the quad at its exact current charge;
			// only pick a pack from the bench if the quad currently has no pack plugged in.
			wasUnplugged := ps.activePackIdx < 0
			ps.plugInReadyOrBestPack()
			if wasUnplugged && ps.activePackIdx >= 0 {
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
		case "refill-launch":
			ps.packPct = [3]float64{100.0, 100.0, 100.0}
			if ps.activePackIdx < 0 || ps.activePackIdx >= 3 {
				ps.activePackIdx = 0
				ps.packsFlown++
			}
			ps.batteryPct = 100.0
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
func (s *TrackSimulator) ToggleTimerPower(timerID uint8) bool {
	s.mu.Lock()
	currentlyOff := s.poweredOffTimers[timerID]
	nextOff := !currentlyOff
	if nextOff {
		s.poweredOffTimers[timerID] = true
	} else {
		delete(s.poweredOffTimers, timerID)
	}
	s.mu.Unlock()

	s.engine.SetDetectedTimerOnline(timerID, !nextOff)
	return !nextOff
}

// DeleteTimer removes a simulated hardware timer from the simulation and engine.
func (s *TrackSimulator) DeleteTimer(timerID uint8) error {
	s.mu.Lock()
	delete(s.poweredOffTimers, timerID)
	s.mu.Unlock()
	return s.engine.DeleteDetectedTimer(timerID)
}

// AddTimer creates a new simulated XIAO timer (up to 6 total) running the given firmware profile.
func (s *TrackSimulator) AddTimer(role string, label string, profile string) (uint8, error) {
	id, err := s.engine.AddSimulatedTimer(role, label, profile)
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
	pilots, gates, _, _, _ := s.engine.StateSnapshot()
	detected := s.engine.DetectedTimersSnapshot()

	s.mu.Lock()
	defer s.mu.Unlock()

	numGates := len(gates)
	sectorLen := s.trackLengthMeters
	if numGates > 0 {
		sectorLen = s.trackLengthMeters / float64(numGates)
	}

	simPilots := make([]domain.SimPilotState, 0, len(pilots))
	for i, p := range pilots {
		if i >= len(s.pilotStates) {
			break
		}
		ps := s.pilotStates[i]
		nearestGate := "Start / Finish"
		if numGates > 0 {
			gIdx := int(math.Round(ps.trackPosMeters/sectorLen)) % numGates
			g := gates[gIdx]
			if g.Name != "" {
				nearestGate = g.Name
			} else if g.TimerLabel != "" {
				nearestGate = g.TimerLabel
			} else {
				nearestGate = fmt.Sprintf("Gate %d", gIdx+1)
			}
		}

		vtxActive := p.Enabled && p.Channel > 0 &&
			(ps.status == domain.SimStatusFlying ||
				ps.status == domain.SimStatusAvoiding ||
				ps.status == domain.SimStatusLanding ||
				ps.status == domain.SimStatusCrashedVtxOn ||
				ps.status == domain.SimStatusTurtleRecovery)

		speedMph := 0.0
		if p.Enabled && p.Channel > 0 && (ps.status == domain.SimStatusFlying || ps.status == domain.SimStatusAvoiding || ps.status == domain.SimStatusLanding) {
			speedMph = math.Round(ps.currentSpeedMps*2.23694*10) / 10
		}

		volts := 0.0
		if ps.batteryPct > 0 {
			volts = 21.0 + (ps.batteryPct/100.0)*4.2 // 6S LiPo: 21.0V (3.5V/cell) .. 25.2V (4.2V/cell)
		}
		var packs [3]domain.SimBatteryPack
		for k := 0; k < 3; k++ {
			pct := math.Max(0, math.Min(100, ps.packPct[k]))
			pVolts := 21.0 + (pct/100.0)*4.2
			pState := domain.SimPackCharging
			if k == ps.activePackIdx {
				pState = domain.SimPackInQuad
			} else if pct >= 99.5 {
				pState = domain.SimPackReady
			}
			packs[k] = domain.SimBatteryPack{
				PackIndex: k + 1,
				Pct:       uint8(math.Round(pct)),
				Volts:     math.Round(pVolts*100) / 100,
				State:     pState,
			}
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
			Packs:             packs,
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

	gateByTimer := make(map[uint8]string, len(gates))
	for idx, g := range gates {
		if g.AssignedTimerID > 0 {
			if g.Name != "" {
				gateByTimer[g.AssignedTimerID] = g.Name
			} else {
				gateByTimer[g.AssignedTimerID] = fmt.Sprintf("Gate %d", idx+1)
			}
		}
	}

	simTimers := make([]domain.SimTimerState, 0, len(detected))
	for _, d := range detected {
		poweredOn := !s.poweredOffTimers[d.TimerID]
		fw := d.FirmwareVersion
		if fw == "" {
			fw = domain.LatestFirmwareVersion
		}
		profile := d.FirmwareProfile
		if profile == "" {
			profile = domain.DefaultFirmwareProfile
		}
		simTimers = append(simTimers, domain.SimTimerState{
			TimerID:          d.TimerID,
			TimerLabel:       d.TimerLabel,
			Color:            d.Color,
			IsHub:            d.IsHub,
			FirmwareVersion:  fw,
			FirmwareProfile:  profile,
			Fingerprint:      d.Fingerprint,
			PoweredOn:        poweredOn,
			Online:           d.Online && poweredOn,
			AssignedGateName: gateByTimer[d.TimerID],
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

	pilots, gates, _, _, _ := s.engine.StateSnapshot()
	detected := s.engine.DetectedTimersSnapshot()
	numGates := len(gates)
	nowUs := s.clock()
	s.seqCounter++

	var clearSlots []int

	// Handle automatic track-walker recovery timer
	if s.trackWalkerActive && s.trackWalkerTimerSec > 0 {
		s.trackWalkerTimerSec -= dtSec
		for i := range s.pilotStates {
			if s.pilotStates[i].status == domain.SimStatusWalkingRecovery {
				s.pilotStates[i].stateTimerSec = math.Max(0, s.trackWalkerTimerSec)
			}
		}
		if s.trackWalkerTimerSec <= 0 {
			s.trackWalkerActive = false
			s.trackWalkerTimerSec = 0
			for i := range s.pilotStates {
				ps := &s.pilotStates[i]
				switch ps.status {
				case domain.SimStatusAvoiding:
					ps.status = domain.SimStatusFlying
					ps.altitudeMeters = 1.25
					ps.trackPosMeters = s.trackLengthMeters - 14.0 - float64(i)*4.0
					clearSlots = append(clearSlots, ps.slotIndex)
				case domain.SimStatusCrashedRecovery, domain.SimStatusWalkingRecovery:
					// Walk completed: quad has been carried off the field back to the pit bench
					s.enterPitAfterFlightLocked(ps)
					clearSlots = append(clearSlots, ps.slotIndex)
				}
			}
		}
	}

	if numGates == 0 {
		frames := make([]domain.TimerTelemetryFrame, 0, len(detected))
		for _, d := range detected {
			if s.poweredOffTimers[d.TimerID] {
				continue
			}
			var rssi [domain.MaxPilotPoolSize]float32
			for slotIdx := 0; slotIdx < len(pilots) && slotIdx < domain.MaxPilotPoolSize; slotIdx++ {
				rssi[slotIdx] = d.NoiseFloorDbm + float32((s.rng.Float64()-0.5)*2.0)
			}
			frames = append(frames, domain.TimerTelemetryFrame{
				TimerID:       d.TimerID,
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

	sectorLen := s.trackLengthMeters / float64(numGates)

	// 1. Advance each enabled pilot along the track & update battery/pit/crash state machine
	hasWaitingRecovery := false
	for i := range s.pilotStates {
		if i < len(pilots) && (!pilots[i].Enabled || pilots[i].Channel == 0) {
			continue
		}
		st := s.pilotStates[i].status
		if st == domain.SimStatusCrashedVtxOn ||
			st == domain.SimStatusTurtleRecovery ||
			st == domain.SimStatusTurtleFailed ||
			st == domain.SimStatusCrashedRecovery ||
			st == domain.SimStatusWalkingRecovery {
			hasWaitingRecovery = true
			break
		}
	}

	waitingRecoveryCount := 0
	flyingCount := 0

	for i := range s.pilotStates {
		ps := &s.pilotStates[i]
		if i < len(pilots) && (!pilots[i].Enabled || pilots[i].Channel == 0) {
			continue
		}

		// Continuously charge any bench packs that are not currently plugged into the quad (~0.14%/s)
		if !s.prewarming && s.autoPracticeEvents {
			for k := 0; k < 3; k++ {
				if k != ps.activePackIdx && ps.packPct[k] < 100.0 {
					ps.packPct[k] = math.Min(100.0, ps.packPct[k]+dtSec*benchChargeRatePctPerSec)
				}
			}
		}

		switch ps.status {
		case domain.SimStatusPaused:
			ps.currentSpeedMps = 0
			continue

		case domain.SimStatusCrashedVtxOn:
			ps.currentSpeedMps = 0
			ps.stateTimerSec -= dtSec
			if ps.stateTimerSec <= 0 {
				// Step 1 -> Step 2 of crash state machine: attempt Turtle Mode recovery
				ps.status = domain.SimStatusTurtleRecovery
				ps.stateTimerSec = 4.0
				ps.turtleForceSuccess = false
			}
			continue

		case domain.SimStatusTurtleRecovery:
			ps.currentSpeedMps = 0
			ps.stateTimerSec -= dtSec
			if ps.stateTimerSec <= 0 {
				// Step 2 -> Step 3: Turtle flip either succeeds (resumes FLYING) or fails (enters TURTLE_FAILED)
				if ps.turtleForceSuccess || (s.rng.Float64() < 0.40 && !s.trackWalkerActive) {
					ps.turtleForceSuccess = false
					if ps.activePackIdx >= 0 && ps.activePackIdx < 3 {
						ps.batteryPct = ps.packPct[ps.activePackIdx]
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
				} else {
					ps.turtleForceSuccess = false
					ps.status = domain.SimStatusTurtleFailed
					ps.stateTimerSec = 3.5
				}
			}
			continue

		case domain.SimStatusTurtleFailed:
			ps.currentSpeedMps = 0
			ps.stateTimerSec -= dtSec
			if ps.stateTimerSec <= 0 {
				// Step 3 -> Step 4: Disarm & switch VTX to Pit Mode, then wait on field for a lull in traffic
				if s.trackWalkerActive {
					ps.status = domain.SimStatusWalkingRecovery
					ps.stateTimerSec = s.trackWalkerTimerSec
				} else {
					ps.status = domain.SimStatusCrashedRecovery
					ps.stateTimerSec = 0
					waitingRecoveryCount++
				}
			}
			continue

		case domain.SimStatusCrashedRecovery:
			ps.currentSpeedMps = 0
			waitingRecoveryCount++
			continue

		case domain.SimStatusWalkingRecovery:
			ps.currentSpeedMps = 0
			continue

		case domain.SimStatusLanding:
			ps.stateTimerSec -= dtSec
			rem := math.Max(0, ps.stateTimerSec/5.0)
			ps.currentSpeedMps = ps.baseSpeedMps * 0.40 * rem
			ps.altitudeMeters = math.Max(0.1, 1.25*rem)
			if ps.activePackIdx >= 0 && ps.activePackIdx < 3 {
				ps.packPct[ps.activePackIdx] = math.Max(5.0, ps.packPct[ps.activePackIdx]-dtSec*0.25)
				ps.batteryPct = ps.packPct[ps.activePackIdx]
			}
			if ps.stateTimerSec <= 0 {
				switch ps.landingTargetStatus {
				case domain.SimStatusPilotBreak:
					if ps.activePackIdx >= 0 && ps.activePackIdx < 3 {
						ps.batteryPct = ps.packPct[ps.activePackIdx]
					}
					ps.status = domain.SimStatusPilotBreak
					ps.stateTimerSec = 60.0 + s.rng.Float64()*30.0
					ps.currentSpeedMps = 0
					ps.altitudeMeters = 0
					ps.trackPosMeters = s.trackLengthMeters - 12.0
				case domain.SimStatusPaused:
					if ps.activePackIdx >= 0 && ps.activePackIdx < 3 {
						ps.batteryPct = ps.packPct[ps.activePackIdx]
					}
					ps.status = domain.SimStatusPaused
					ps.stateTimerSec = 0
					ps.currentSpeedMps = 0
					ps.altitudeMeters = 0
					ps.trackPosMeters = s.trackLengthMeters - 12.0
				default:
					s.enterPitAfterFlightLocked(ps)
				}
				clearSlots = append(clearSlots, ps.slotIndex)
			}
			continue

		case domain.SimStatusPilotBreak:
			ps.currentSpeedMps = 0
			if ps.activePackIdx >= 0 && ps.activePackIdx < 3 {
				ps.batteryPct = ps.packPct[ps.activePackIdx]
			} else {
				ps.batteryPct = 0
			}
			ps.stateTimerSec -= dtSec
			if ps.stateTimerSec <= 0 {
				// If the quad still has a non-depleted pack plugged in (from a manual Land),
				// resume flying with that exact pack; otherwise swap to a charged pack.
				if ps.activePackIdx >= 0 && ps.activePackIdx < 3 && ps.packPct[ps.activePackIdx] > 20.0 {
					if hasWaitingRecovery || s.trackWalkerActive {
						ps.status = domain.SimStatusLaunchHold
						ps.stateTimerSec = 0
					} else {
						ps.status = domain.SimStatusFlying
						ps.altitudeMeters = 1.25
						ps.currentSpeedMps = ps.baseSpeedMps
						ps.stateTimerSec = 0
					}
				} else if ps.findReadyPack() >= 0 {
					ps.unplugActivePack()
					ps.status = domain.SimStatusPitSwap
					ps.stateTimerSec = 30.0 + s.rng.Float64()*20.0
				} else {
					ps.unplugActivePack()
					ps.status = domain.SimStatusChargingWait
					ps.stateTimerSec = 0
				}
			}
			continue

		case domain.SimStatusChargingWait:
			ps.currentSpeedMps = 0
			ps.batteryPct = 0
			// Wait on pit bench until at least one of the 3 LiPo packs finishes charging to 100%
			if ps.findReadyPack() >= 0 {
				ps.status = domain.SimStatusPitSwap
				ps.stateTimerSec = 30.0 + s.rng.Float64()*20.0
			} else {
				remPct := math.Max(0, 100.0-ps.maxPackPct())
				ps.stateTimerSec = remPct / benchChargeRatePctPerSec
			}
			continue

		case domain.SimStatusLaunchHold:
			ps.currentSpeedMps = 0
			if ps.activePackIdx < 0 {
				ps.plugInReadyOrBestPack()
			}
			// Pilot is ready on the launch pad with a fresh 100% LiPo plugged in, but holds launch
			// with VTX in Pit Mode (off) so the VTX doesn't overheat while waiting for the crashed
			// pilot to get a lull and recover their quad.
			if hasWaitingRecovery || s.trackWalkerActive {
				if s.trackWalkerActive {
					ps.stateTimerSec = math.Max(0, s.trackWalkerTimerSec)
				} else {
					ps.stateTimerSec = 0
				}
			} else {
				// Recovery is complete and track is clear -> step into 3s arming countdown and launch!
				ps.status = domain.SimStatusPitSwap
				ps.stateTimerSec = 3.0
			}
			continue

		case domain.SimStatusPitSwap:
			ps.currentSpeedMps = 0
			// If all 3 packs are still charging (< 100%), transition to CHARGING_WAIT first
			if ps.activePackIdx < 0 && ps.findReadyPack() < 0 {
				ps.status = domain.SimStatusChargingWait
				remPct := math.Max(0, 100.0-ps.maxPackPct())
				ps.stateTimerSec = remPct / benchChargeRatePctPerSec
				continue
			}
			ps.stateTimerSec -= dtSec
			// Pack is unplugged (0%) while retrieving quad, walking to bench, unstrapping old pack,
			// strapping fresh pack, and walking back to the launch pad; in the final 4 seconds on the
			// launch pad, the pilot plugs in the fresh 100% 6S pack.
			if ps.stateTimerSec <= 4.0 {
				if ps.activePackIdx < 0 {
					ps.plugInReadyOrBestPack()
				}
				// If a crashed pilot is waiting for a lull to recover (or is walking on the track),
				// hold on the launch pad with VTX switched OFF (Pit Mode) to avoid overheating the VTX!
				if hasWaitingRecovery || s.trackWalkerActive {
					ps.status = domain.SimStatusLaunchHold
					if s.trackWalkerActive {
						ps.stateTimerSec = math.Max(0, s.trackWalkerTimerSec)
					} else {
						ps.stateTimerSec = 0
					}
					continue
				}
			} else {
				ps.activePackIdx = -1
				ps.batteryPct = 0.0
			}
			if ps.stateTimerSec <= 0 {
				if ps.activePackIdx < 0 {
					ps.plugInReadyOrBestPack()
				}
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
			// Drain active 6S flight pack (~0.58% per second -> ~2.4 minutes per pack)
			if ps.activePackIdx < 0 || ps.activePackIdx >= 3 {
				ps.activePackIdx = 0
			}
			ps.packPct[ps.activePackIdx] = math.Max(5.0, ps.packPct[ps.activePackIdx]-dtSec*0.58)
			ps.batteryPct = ps.packPct[ps.activePackIdx]
			if ps.batteryPct <= 16.0 {
				ps.wantPitAtFinish = true
			}
		}

		currentSector := int(ps.trackPosMeters/sectorLen) % numGates
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
		// the start/finish gate, if their battery is low, transition into the 5-second LANDING stage
		// heading back to the pit area before disarming and swapping packs.
		if !s.prewarming && ps.wantPitAtFinish && prevPos < 10.0 && ps.trackPosMeters >= 10.0 {
			s.startLandingLocked(ps, domain.SimStatusPitSwap)
		}
	}

	// If a crashed drone is waiting on the field and all other pilots have landed for pit swaps
	// (a natural lull in traffic with 0 pilots flying), the crashed pilot transitions to WALKING_RECOVERY
	// and walks out onto the clear track to recover their quad; once the walk timer finishes, the quad moves to PIT_SWAP.
	if !s.prewarming && waitingRecoveryCount > 0 && flyingCount == 0 && !s.trackWalkerActive {
		s.trackWalkerActive = true
		s.trackWalkerTimerSec = 30.0 + s.rng.Float64()*30.0
		for i := range s.pilotStates {
			ps := &s.pilotStates[i]
			if ps.status == domain.SimStatusCrashedRecovery {
				ps.status = domain.SimStatusWalkingRecovery
				ps.stateTimerSec = s.trackWalkerTimerSec
			}
		}
	}

	// 2. Compute 8-channel 5.8 GHz RSSI at each powered-on Gate Timer and emit frame
	frames := make([]domain.TimerTelemetryFrame, 0, numGates+len(detected))
	assignedSet := make(map[uint8]bool, numGates)
	for gIdx, gate := range gates {
		if gate.AssignedTimerID == 0 {
			continue
		}
		assignedSet[gate.AssignedTimerID] = true
		if s.poweredOffTimers[gate.AssignedTimerID] {
			continue // Simulated timer is switched OFF in the Sim tab
		}
		gatePosMeters := float64(gIdx) * sectorLen
		var rssi [domain.MaxPilotPoolSize]float32

		for slotIdx := 0; slotIdx < len(pilots) && slotIdx < domain.MaxPilotPoolSize && slotIdx < len(s.pilotStates); slotIdx++ {
			noise := float32((s.rng.Float64() - 0.5) * 2.2)
			ps := s.pilotStates[slotIdx]
			vtxOn := pilots[slotIdx].Enabled &&
				pilots[slotIdx].Channel > 0 &&
				(ps.status == domain.SimStatusFlying ||
					ps.status == domain.SimStatusAvoiding ||
					ps.status == domain.SimStatusCrashedVtxOn ||
					ps.status == domain.SimStatusTurtleRecovery)

			if !vtxOn {
				rssi[slotIdx] = gate.NoiseFloorDbm + noise
				continue
			}

			// Shortest circular distance along track loop between drone and gate
			dx := math.Abs(ps.trackPosMeters - gatePosMeters)
			if dx > s.trackLengthMeters/2.0 {
				dx = s.trackLengthMeters - dx
			}

			// 3D Euclidean distance to gate timer on ground (altitude = 1.25m normal, 14.0m when avoiding track walker)
			alt := ps.altitudeMeters
			if alt < 0.8 {
				alt = 0.8
			}
			dist3D := math.Sqrt(dx*dx + alt*alt)

			// Free-space + ground multipath 5.8 GHz RSSI model:
			// Peak inside gate (~1.25m) reaches ~ -26 dBm; drops by ~23.5 dB per decade of distance
			multipathRipple := math.Sin(dx*2.7)*1.8 + math.Cos(dx*1.3)*1.2
			sigDbm := -24.5 - 23.5*math.Log10(dist3D) + multipathRipple + float64(noise)
			if sigDbm < float64(gate.NoiseFloorDbm) {
				sigDbm = float64(gate.NoiseFloorDbm) + float64(noise)*0.5
			}
			if sigDbm > -20.0 {
				sigDbm = -20.0
			}
			rssi[slotIdx] = float32(sigDbm)
		}

		frames = append(frames, domain.TimerTelemetryFrame{
			TimerID:       gate.AssignedTimerID,
			SeqNum:        s.seqCounter,
			TimestampUs:   nowUs,
			RSSI:          rssi,
			BatteryMv:     gate.BatteryMv,
			NoiseFloorDbm: gate.NoiseFloorDbm,
		})
	}
	for _, d := range detected {
		if assignedSet[d.TimerID] || s.poweredOffTimers[d.TimerID] {
			continue
		}
		var rssi [domain.MaxPilotPoolSize]float32
		for slotIdx := 0; slotIdx < len(pilots) && slotIdx < domain.MaxPilotPoolSize; slotIdx++ {
			rssi[slotIdx] = d.NoiseFloorDbm + float32((s.rng.Float64()-0.5)*2.0)
		}
		frames = append(frames, domain.TimerTelemetryFrame{
			TimerID:       d.TimerID,
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
