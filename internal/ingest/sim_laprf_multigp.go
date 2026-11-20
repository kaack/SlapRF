package ingest

import (
	"errors"
	"fmt"
	"math"
	"strings"

	"slaprf/internal/domain"
	"slaprf/internal/multigp"
	"slaprf/internal/tracker"
)

type simLapRFCrossingTracker struct {
	inPeak      bool
	peakRSSI    float32
	peakTsUs    uint64
	lastCrossUs uint64
	passCount   uint32
}

type simLapRFUnitState struct {
	domain.SimLapRFUnit
	slots [domain.MaxPilotSlots]simLapRFCrossingTracker
}

// SimLapRFActionRequest mutates simulated ImmersionRC LapRF 8-Way pucks in Simulation Mode.
type SimLapRFActionRequest struct {
	Action    string `json:"action"` // "toggle-power" | "toggle-connect" | "connect-host" | "disconnect" | "update" | "add" | "delete" | "reset"
	TimerID   uint8  `json:"timerId,omitempty"`
	Label     string `json:"label,omitempty"`
	Host      string `json:"host,omitempty"`
	Port      int    `json:"port,omitempty"`
	VoltageMv uint16 `json:"voltageMv,omitempty"`
}

func normalizeSimLapRFLabel(label string, timerID uint8) string {
	unitNum := int(timerID) - 1
	if unitNum < 1 {
		unitNum = 1
	}
	clean := strings.TrimSpace(label)
	if clean == "" || strings.HasPrefix(strings.ToLower(clean), "laprf #") {
		return fmt.Sprintf("L%d", unitNum)
	}
	return clean
}

func defaultSimLapRFUnits() []simLapRFUnitState {
	baseRSSI := [domain.MaxPilotSlots]float32{315, 318, 312, 320, 314, 316, 311, 319}
	return []simLapRFUnitState{
		{
			SimLapRFUnit: domain.SimLapRFUnit{
				TimerID:    2,
				Label:      "L1",
				Host:       "192.168.1.2",
				Port:       5403,
				VoltageMv:  12200,
				PoweredOn:  true,
				Connected:  true,
				Online:     true,
				GateArmed:  true,
				RTCDeltaMs: 0,
				SlotRSSI:   baseRSSI,
			},
		},
		{
			SimLapRFUnit: domain.SimLapRFUnit{
				TimerID:    3,
				Label:      "L2",
				Host:       "192.168.1.3",
				Port:       5403,
				VoltageMv:  12100,
				PoweredOn:  true,
				Connected:  false,
				Online:     false,
				GateArmed:  true,
				RTCDeltaMs: 0,
				SlotRSSI:   baseRSSI,
			},
		},
	}
}

func (s *TrackSimulator) ensureLapRFAndMultiGPLocked() {
	if len(s.laprfUnits) == 0 {
		s.laprfUnits = defaultSimLapRFUnits()
	}
	if len(s.rhUnits) == 0 {
		s.rhUnits = defaultSimRHUnits()
	}
	if s.mgpBackend == nil {
		s.mgpBackend = multigp.NewSimBackend()
	}
}

// MultiGPBackend returns the simulated MultiGP chapter & WebService backend for Simulation Mode.
func (s *TrackSimulator) MultiGPBackend() *multigp.SimBackend {
	s.mu.Lock()
	s.ensureLapRFAndMultiGPLocked()
	b := s.mgpBackend
	s.mu.Unlock()
	return b
}

// SyncMultiGPPilotPool syncs the active simulation engine's pilot roster into the simulated MultiGP pool.
func (s *TrackSimulator) SyncMultiGPPilotPool() {
	b := s.MultiGPBackend()
	pilots, _, _, _, _ := s.engine.StateSnapshot()
	b.SyncPoolWithEnginePilots(pilots)
}

// SetSlapRFModeSyncHook registers a callback invoked whenever SyncHardwareMode switches back to SlapRF.
func (s *TrackSimulator) SetSlapRFModeSyncHook(fn func()) {
	s.mu.Lock()
	s.onSlapRFModeSync = fn
	s.mu.Unlock()
}

// SyncHardwareMode synchronizes simulated SlapRF, LapRF, or RotorHazard units with the timing engine
// whenever hardware mode changes, resetting simulated boards back to their clean default state.
func (s *TrackSimulator) SyncHardwareMode() {
	mode := s.engine.TimingHardwareMode()
	s.mu.Lock()
	s.poweredOffTimers = make(map[uint8]bool)
	s.unflashedBoards = make(map[uint8]SimBoardBlankState)
	s.timerRuntimes = make(map[uint8]*simTimerRuntime)
	s.laprfUnits = defaultSimLapRFUnits()
	s.rhUnits = defaultSimRHUnitsForMode(mode)
	s.hellosSent = false
	hook := s.onSlapRFModeSync
	var laprfCopy []domain.SimLapRFUnit
	if mode == domain.HardwareModeLapRF {
		laprfCopy = make([]domain.SimLapRFUnit, len(s.laprfUnits))
		for i := range s.laprfUnits {
			laprfCopy[i] = s.laprfUnits[i].SimLapRFUnit
		}
	}
	var rhCopy []domain.SimRotorHazardUnit
	if domain.IsRotorHazardMode(mode) {
		rhCopy = make([]domain.SimRotorHazardUnit, len(s.rhUnits))
		for i := range s.rhUnits {
			rhCopy[i] = s.rhUnits[i].SimRotorHazardUnit
		}
	}
	s.mu.Unlock()

	if domain.IsSlapRFMode(mode) {
		if hook != nil {
			hook()
		}
		return
	}
	if mode == domain.HardwareModeLapRF {
		for idx, u := range laprfCopy {
			s.engine.EnsureLapRFTimerRegistered(u.TimerID, u.Label, u.VoltageMv, idx == 0 && u.Connected && u.PoweredOn)
			s.engine.SetDetectedTimerOnline(u.TimerID, u.PoweredOn && u.Connected)
		}
		return
	}
	if domain.IsRotorHazardMode(mode) {
		for idx, u := range rhCopy {
			s.engine.EnsureRHTimerRegistered(u.TimerID, u.Label, idx == 0 && u.Connected && u.PoweredOn)
			s.engine.SetDetectedTimerOnline(u.TimerID, u.PoweredOn && u.Connected)
		}
		s.SyncRHNodesNow()
	}
}

func (s *TrackSimulator) snapshotLapRFUnitsLocked(
	gateByTimer map[uint8]string,
	pilots []domain.PilotSlot,
	gates []domain.TrackGate,
) []domain.SimLapRFUnit {
	s.ensureLapRFAndMultiGPLocked()
	freqs, slotToPilot := tracker.ComputeActivePilotChannels(pilots)
	boundGateByTimer := make(map[uint8]*domain.TrackGate, len(gates))
	for idx := range gates {
		if gates[idx].AssignedTimerID > 0 {
			boundGateByTimer[gates[idx].AssignedTimerID] = &gates[idx]
		}
	}

	out := make([]domain.SimLapRFUnit, len(s.laprfUnits))
	for i, u := range s.laprfUnits {
		cp := u.SimLapRFUnit
		cp.Online = cp.PoweredOn && cp.Connected
		cp.AssignedGateName = gateByTimer[cp.TimerID]
		if !cp.PoweredOn {
			cp.SlotRSSI = [domain.MaxPilotSlots]float32{}
		}
		if cp.PoweredOn && cp.Connected {
			boundGate := boundGateByTimer[cp.TimerID]
			for ch := 0; ch < domain.MaxPilotSlots; ch++ {
				pIdx := slotToPilot[ch]
				if freqs[ch] == 0 || pIdx < 0 || pIdx >= len(pilots) {
					continue
				}
				p := pilots[pIdx]
				thr := p.LapRFThreshold
				if thr < domain.MinLapRFThreshold || thr > domain.MaxLapRFThreshold {
					thr = domain.DefaultLapRFThreshold
				}
				if boundGate != nil && pIdx < len(boundGate.LapRFThresholds) {
					gThr := boundGate.LapRFThresholds[pIdx]
					if gThr >= domain.MinLapRFThreshold && gThr <= domain.MaxLapRFThreshold {
						thr = gThr
					}
				}
				cp.SlotFreqsMHz[ch] = freqs[ch]
				cp.SlotThresholds[ch] = thr
			}
		}
		out[i] = cp
	}
	return out
}

// DiscoverSimLapRFUnits returns powered-on simulated LapRF units on the virtual LAN for `Scan LAN` in Sim mode.
func (s *TrackSimulator) DiscoverSimLapRFUnits() []domain.SimLapRFUnit {
	_, gates, _, _, _ := s.engine.StateSnapshot()
	gateByTimer := make(map[uint8]string, len(gates))
	for idx, g := range gates {
		if g.AssignedTimerID > 0 {
			gateByTimer[g.AssignedTimerID] = fmt.Sprintf("#%d", idx+1)
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensureLapRFAndMultiGPLocked()
	var found []domain.SimLapRFUnit
	for _, u := range s.laprfUnits {
		if !u.PoweredOn {
			continue
		}
		cp := u.SimLapRFUnit
		cp.AssignedGateName = gateByTimer[cp.TimerID]
		found = append(found, cp)
	}
	return found
}

// ApplyLapRFAction mutates simulated ImmersionRC LapRF 8-Way timers and syncs the engine's detected list.
func (s *TrackSimulator) ApplyLapRFAction(req SimLapRFActionRequest) ([]domain.SimLapRFUnit, error) {
	act := strings.ToLower(strings.TrimSpace(req.Action))

	s.mu.Lock()
	s.ensureLapRFAndMultiGPLocked()

	findIdx := func(id uint8) int {
		for i := range s.laprfUnits {
			if s.laprfUnits[i].TimerID == id {
				return i
			}
		}
		return -1
	}

	switch act {
	case "reset":
		s.laprfUnits = defaultSimLapRFUnits()
		unitsCopy := make([]domain.SimLapRFUnit, len(s.laprfUnits))
		for i := range s.laprfUnits {
			unitsCopy[i] = s.laprfUnits[i].SimLapRFUnit
		}
		s.mu.Unlock()
		if s.engine.TimingHardwareMode() == domain.HardwareModeLapRF {
			s.engine.ResetTrackToDefault(true)
			for idx, u := range unitsCopy {
				s.engine.EnsureLapRFTimerRegistered(u.TimerID, u.Label, u.VoltageMv, idx == 0)
				s.engine.SetDetectedTimerOnline(u.TimerID, u.PoweredOn && u.Connected)
			}
		}
		return s. Snapshot().LapRFUnits, nil

	case "toggle-power":
		idx := findIdx(req.TimerID)
		if idx < 0 {
			s.mu.Unlock()
			return nil, tracker.ErrInvalidTimerID
		}
		s.laprfUnits[idx].PoweredOn = !s.laprfUnits[idx].PoweredOn
		u := s.laprfUnits[idx].SimLapRFUnit
		s.mu.Unlock()
		if s.engine.TimingHardwareMode() == domain.HardwareModeLapRF {
			s.engine.SetDetectedTimerOnline(u.TimerID, u.PoweredOn && u.Connected)
		}
		return s.Snapshot().LapRFUnits, nil

	case "connect":
		idx := findIdx(req.TimerID)
		if idx < 0 {
			s.mu.Unlock()
			return nil, tracker.ErrInvalidTimerID
		}
		s.laprfUnits[idx].Connected = true
		s.laprfUnits[idx].GateArmed = true
		s.laprfUnits[idx].Online = s.laprfUnits[idx].PoweredOn
		u := s.laprfUnits[idx].SimLapRFUnit
		s.mu.Unlock()
		if s.engine.TimingHardwareMode() == domain.HardwareModeLapRF {
			s.engine.EnsureLapRFTimerRegistered(u.TimerID, u.Label, u.VoltageMv, true)
			s.engine.SetDetectedTimerOnline(u.TimerID, u.PoweredOn && u.Connected)
		}
		return s.Snapshot().LapRFUnits, nil

	case "toggle-connect":
		idx := findIdx(req.TimerID)
		if idx < 0 {
			s.mu.Unlock()
			return nil, tracker.ErrInvalidTimerID
		}
		s.laprfUnits[idx].Connected = !s.laprfUnits[idx].Connected
		if s.laprfUnits[idx].Connected {
			s.laprfUnits[idx].GateArmed = true
			s.laprfUnits[idx].Online = s.laprfUnits[idx].PoweredOn
		}
		u := s.laprfUnits[idx].SimLapRFUnit
		s.mu.Unlock()
		if s.engine.TimingHardwareMode() == domain.HardwareModeLapRF {
			if u.Connected {
				s.engine.EnsureLapRFTimerRegistered(u.TimerID, u.Label, u.VoltageMv, true)
			}
			s.engine.SetDetectedTimerOnline(u.TimerID, u.PoweredOn && u.Connected)
		}
		return s.Snapshot().LapRFUnits, nil

	case "disconnect":
		idx := findIdx(req.TimerID)
		if idx < 0 {
			s.mu.Unlock()
			return nil, tracker.ErrInvalidTimerID
		}
		s.laprfUnits[idx].Connected = false
		u := s.laprfUnits[idx].SimLapRFUnit
		s.mu.Unlock()
		if s.engine.TimingHardwareMode() == domain.HardwareModeLapRF {
			s.engine.SetDetectedTimerOnline(u.TimerID, false)
		}
		return s.Snapshot().LapRFUnits, nil

	case "connect-host":
		host := strings.TrimSpace(req.Host)
		if host == "" {
			host = "192.168.1.2"
		}
		port := req.Port
		if port <= 0 {
			port = 5403
		}
		targetIdx := -1
		for i := range s.laprfUnits {
			if strings.EqualFold(s.laprfUnits[i].Host, host) && s.laprfUnits[i].Port == port {
				targetIdx = i
				break
			}
		}
		if targetIdx < 0 {
			s.mu.Unlock()
			return nil, fmt.Errorf("no simulated LapRF timer listening on %s:%d (check Simulated LapRF timers in #/sim)", host, port)
		}
		if !s.laprfUnits[targetIdx].PoweredOn {
			s.mu.Unlock()
			return nil, fmt.Errorf("simulated LapRF timer at %s:%d is powered off", host, port)
		}
		s.laprfUnits[targetIdx].Connected = true
		s.laprfUnits[targetIdx].Online = true
		s.laprfUnits[targetIdx].GateArmed = true
		u := s.laprfUnits[targetIdx].SimLapRFUnit
		s.mu.Unlock()
		if s.engine.TimingHardwareMode() == domain.HardwareModeLapRF {
			s.engine.EnsureLapRFTimerRegistered(u.TimerID, u.Label, u.VoltageMv, true)
			s.engine.SetDetectedTimerOnline(u.TimerID, true)
		}
		return s.Snapshot().LapRFUnits, nil

	case "update":
		idx := findIdx(req.TimerID)
		if idx < 0 {
			s.mu.Unlock()
			return nil, tracker.ErrInvalidTimerID
		}
		if lbl := strings.TrimSpace(req.Label); lbl != "" {
			s.laprfUnits[idx].Label = lbl
		}
		if host := strings.TrimSpace(req.Host); host != "" {
			s.laprfUnits[idx].Host = host
		}
		if req.Port > 0 && req.Port <= 65535 {
			s.laprfUnits[idx].Port = req.Port
		}
		if req.VoltageMv >= 5000 && req.VoltageMv <= 30000 {
			s.laprfUnits[idx].VoltageMv = req.VoltageMv
		}
		u := s.laprfUnits[idx].SimLapRFUnit
		s.mu.Unlock()
		if s.engine.TimingHardwareMode() == domain.HardwareModeLapRF {
			s.engine.EnsureLapRFTimerRegistered(u.TimerID, u.Label, u.VoltageMv, false)
			s.engine.SetDetectedTimerOnline(u.TimerID, u.PoweredOn && u.Connected)
		}
		return s.Snapshot().LapRFUnits, nil

	case "add":
		used := make(map[uint8]bool, len(s.laprfUnits))
		for _, u := range s.laprfUnits {
			used[u.TimerID] = true
		}
		var nextID uint8
		for id := uint8(2); id <= 7; id++ {
			if !used[id] {
				nextID = id
				break
			}
		}
		if nextID == 0 {
			s.mu.Unlock()
			return nil, errors.New("maximum of 6 simulated LapRF timers reached")
		}
		lbl := normalizeSimLapRFLabel(req.Label, nextID)
		host := strings.TrimSpace(req.Host)
		if host == "" {
			host = fmt.Sprintf("192.168.1.%d", nextID)
		}
		port := req.Port
		if port <= 0 {
			port = 5403
		}
		volt := req.VoltageMv
		if volt == 0 {
			volt = 12200
		}
		nu := simLapRFUnitState{
			SimLapRFUnit: domain.SimLapRFUnit{
				TimerID:   nextID,
				Label:     lbl,
				Host:      host,
				Port:      port,
				VoltageMv: volt,
				PoweredOn:  true,
				Connected:  true,
				Online:     true,
				GateArmed:  true,
				RTCDeltaMs: 0,
				SlotRSSI:   [domain.MaxPilotSlots]float32{315, 315, 315, 315, 315, 315, 315, 315},
			},
		}
		s.laprfUnits = append(s.laprfUnits, nu)
		s.mu.Unlock()
		if s.engine.TimingHardwareMode() == domain.HardwareModeLapRF {
			s.engine.EnsureLapRFTimerRegistered(nextID, lbl, volt, true)
			s.engine.SetDetectedTimerOnline(nextID, true)
		}
		return s.Snapshot().LapRFUnits, nil

	case "delete":
		idx := findIdx(req.TimerID)
		if idx < 0 {
			s.mu.Unlock()
			return nil, tracker.ErrInvalidTimerID
		}
		delID := s.laprfUnits[idx].TimerID
		s.laprfUnits = append(s.laprfUnits[:idx], s.laprfUnits[idx+1:]...)
		s.mu.Unlock()
		if s.engine.TimingHardwareMode() == domain.HardwareModeLapRF {
			_ = s.engine.DeleteDetectedTimer(delID)
		}
		return s.Snapshot().LapRFUnits, nil

	default:
		s.mu.Unlock()
		return nil, fmt.Errorf("unknown LapRF sim action %q", req.Action)
	}
}

type pendingLapRFStatus struct {
	timerID   uint8
	label     string
	voltageMv uint16
	slotRSSI  [domain.MaxPilotSlots]float32
}

type pendingLapRFCrossing struct {
	timerID    uint8
	hwSlotIdx  int
	peakTsUs   uint64
	peakHeight float32
	passNum    uint32
}

// stepLapRFLocked advances simulated ImmersionRC LapRF 8-Way RSSI (300..3200) and hardware peak
// detection for all powered-on & connected simulated LapRF pucks. Caller holds `s.mu` and unlocks
// before invoking the returned engine dispatch callbacks.
func (s *TrackSimulator) stepLapRFLocked(
	nowUs uint64,
	pilots []domain.PilotSlot,
	gates []domain.TrackGate,
	sectorLen float64,
) ([]pendingLapRFStatus, []pendingLapRFCrossing) {
	s.ensureLapRFAndMultiGPLocked()

	_, slotToPilot := tracker.ComputeActivePilotChannels(pilots)
	gateIdxByTimer := make(map[uint8]int, len(gates))
	gateByTimer := make(map[uint8]*domain.TrackGate, len(gates))
	for idx := range gates {
		tid := gates[idx].AssignedTimerID
		if tid > 0 {
			gateIdxByTimer[tid] = idx
			gateByTimer[tid] = &gates[idx]
		}
	}

	var statuses []pendingLapRFStatus
	var crossings []pendingLapRFCrossing
	emitStatus := !s.prewarming && (s.seqCounter%2 == 0)

	for uIdx := range s.laprfUnits {
		u := &s.laprfUnits[uIdx]
		if !u.PoweredOn || !u.Connected {
			continue
		}

		gatePosMeters := 0.0
		if gIdx, ok := gateIdxByTimer[u.TimerID]; ok {
			gatePosMeters = float64(gIdx) * sectorLen
		}
		boundGate := gateByTimer[u.TimerID]

		for ch := 0; ch < domain.MaxPilotSlots; ch++ {
			noise := (s.rng.Float64() - 0.5) * 28.0
			pIdx := slotToPilot[ch]
			val := 315.0 + noise
			enabledSlot := false
			thr := float32(domain.DefaultLapRFThreshold)
			gain := uint16(domain.DefaultLapRFGain)

			if pIdx >= 0 && pIdx < len(pilots) && pIdx < len(s.pilotStates) {
				p := pilots[pIdx]
				enabledSlot = p.Enabled && p.Channel > 0
				if p.LapRFThreshold >= domain.MinLapRFThreshold && p.LapRFThreshold <= domain.MaxLapRFThreshold {
					thr = p.LapRFThreshold
				}
				if boundGate != nil && pIdx < len(boundGate.LapRFThresholds) {
					gThr := boundGate.LapRFThresholds[pIdx]
					if gThr >= domain.MinLapRFThreshold && gThr <= domain.MaxLapRFThreshold {
						thr = gThr
					}
				}
				if p.AttenuationGain > 0 && p.AttenuationGain <= 63 {
					gain = p.AttenuationGain
				}

				ps := s.pilotStates[pIdx]
				vtxOn := enabledSlot &&
					(ps.status == domain.SimStatusFlying ||
						ps.status == domain.SimStatusAvoiding ||
						ps.status == domain.SimStatusCrashedVtxOn ||
						ps.status == domain.SimStatusTurtleRecovery)

				if vtxOn {
					dx := math.Abs(ps.trackPosMeters - gatePosMeters)
					if dx > s.trackLengthMeters/2.0 {
						dx = s.trackLengthMeters - dx
					}
					alt := ps.altitudeMeters
					if alt < 0.8 {
						alt = 0.8
					}
					dist3D := math.Sqrt(dx*dx + alt*alt)
					multipathRipple := math.Sin(dx*2.7)*1.8 + math.Cos(dx*1.3)*1.2
					sigDbm := -24.5 - 23.5*math.Log10(dist3D) + multipathRipple
					gainDelta := (float64(gain) - 59.0) * 18.0
					// LapRF 8-Way shielded patch + RF attenuator (~59) rejects distant VTX energy (< -72 dBm)
					// onto the ~315 baseline and peaks ~2760 at the gate apex (default threshold 800, exit 680).
					aboveFloor := (sigDbm + 72.0) * 54.0
					if aboveFloor > 0 {
						val = 315.0 + aboveFloor + gainDelta + noise
					}
				}
			}

			if val < 280 {
				val = 280
			} else if val > 3350 {
				val = 3350
			}
			u.SlotRSSI[ch] = float32(math.Round(val))

			trk := &u.slots[ch]
			exitThr := math.Max(340.0, float64(thr)-120.0)
			if !trk.inPeak {
				if enabledSlot && val >= float64(thr) && (trk.lastCrossUs == 0 || nowUs-trk.lastCrossUs >= 600_000) {
					trk.inPeak = true
					trk.peakRSSI = float32(val)
					trk.peakTsUs = nowUs
				}
			} else {
				if float32(val) > trk.peakRSSI {
					trk.peakRSSI = float32(val)
					trk.peakTsUs = nowUs
				}
				if val <= exitThr || !enabledSlot {
					trk.passCount++
					trk.lastCrossUs = trk.peakTsUs
					crossings = append(crossings, pendingLapRFCrossing{
						timerID:    u.TimerID,
						hwSlotIdx:  ch + 1,
						peakTsUs:   trk.peakTsUs,
						peakHeight: trk.peakRSSI,
						passNum:    trk.passCount,
					})
					trk.inPeak = false
				}
			}
		}

		if emitStatus {
			statuses = append(statuses, pendingLapRFStatus{
				timerID:   u.TimerID,
				label:     u.Label,
				voltageMv: u.VoltageMv,
				slotRSSI:  u.SlotRSSI,
			})
		}
	}

	return statuses, crossings
}
