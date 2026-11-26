package tracker

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"slaprf/internal/domain"
)

const maxTimers = 7 // One Hub plus up to 6 Spokes

var (
	ErrUnknownGate       = errors.New("unknown gate")
	ErrInvalidTimerID    = errors.New("timer ID must be between 1 and 7")
	ErrGateNameTooLong   = errors.New("gate name is too long")
	ErrInvalidGateRole   = errors.New("unknown gate role")
	ErrMinOneGate        = errors.New("at least one gate must remain on the course")
	ErrHubExists         = errors.New("a Hub is already registered (one Hub per course)")
	ErrTimerStillActive  = errors.New("timer is active; disconnect it before removing")
)

// ProvisionRequest describes a timer that was just flashed (or registered) by the flasher.
type ProvisionRequest struct {
	Role         string // "hub" or "spoke"
	Label        string // Flashed timer name (e.g. "H1", "T1")
	Fingerprint  string // 8-hex-digit board fingerprint; empty = unknown
	FromHubHello bool   // True when announced over 2.4 GHz via Hub HELLO rather than direct USB provision
}

// ProvisionGate registers a newly flashed or discovered timer (hub or spoke):
//   - A "hub" is a USB collector dongle: it gets a timer entry (ID 1) but is never placed on a
//     gate automatically (see provisionCollectorHubLocked).
//   - A known fingerprint updates that same physical timer in place, keeping its color and gate.
//   - A newly discovered or flashed hardware timer (with a fingerprint) is always registered in
//     `e.detected` as an unassigned timer (never auto-assigned to a gate).
func (e *Engine) ProvisionGate(req ProvisionRequest) (uint8, error) {
	role := req.Role
	timerLabel := strings.TrimSpace(req.Label)
	if utf8.RuneCountInString(timerLabel) > domain.MaxGateNameLen {
		return 0, ErrGateNameTooLong
	}
	fingerprint := strings.ToUpper(strings.TrimSpace(req.Fingerprint))
	if fingerprint != "" && !domain.IsValidSlapRFFingerprint(fingerprint) {
		return 0, fmt.Errorf("invalid 8-hex timer fingerprint %q", fingerprint)
	}
	ver := domain.LatestFirmwareVersion

	e.mu.Lock()
	if fingerprint != "" {
		if !req.FromHubHello {
			if e.deletedSpokeFp != nil {
				delete(e.deletedSpokeFp, fingerprint)
			}
			if timerLabel != "" {
				if e.usbLabels == nil {
					e.usbLabels = make(map[string]string)
				}
				e.usbLabels[fingerprint] = timerLabel
			}
		} else if e.usbLabels != nil {
			if usbLabel, ok := e.usbLabels[fingerprint]; ok && usbLabel != "" {
				timerLabel = usbLabel
			}
		}
	}

	if role == "hub" {
		if req.FromHubHello {
			d1, ok1 := e.detected[1]
			hasDupHub := false
			for tid, d := range e.detected {
				if tid != 1 && (d.IsHub || (fingerprint != "" && d.Fingerprint == fingerprint)) {
					hasDupHub = true
					break
				}
			}
			needsPrimaryHubGate := domain.IsSlapRFPrimaryGateHubMode(e.timingHardwareMode) && len(e.gates) == 0
			if ok1 && d1.IsHub && !hasDupHub && !needsPrimaryHubGate &&
				(fingerprint == "" || d1.Fingerprint == fingerprint) &&
				(timerLabel == "" || d1.TimerLabel == timerLabel) &&
				d1.FirmwareVersion == ver {
				d1.Online = true
				d1.LastSeenAt = time.Now()
				e.mu.Unlock()
				return 1, nil
			}
		}
		id := e.provisionCollectorHubLocked(fingerprint, timerLabel, ver)
		pSnap, rSnap := e.syncTrackToOpenSessionsAndRacesLocked()
		pilots := append([]domain.PilotSlot(nil), e.pilots...)
		gates := append([]domain.TrackGate(nil), e.gates...)
		subs := append([]EventSubscriber(nil), e.subscribers...)
		e.mu.Unlock()
		for _, s := range subs {
			s.OnConfigUpdated(pilots, gates)
		}
		e.dispatchTrackSnapshotUpdates(pSnap, rSnap, subs)
		return id, nil
	}
	if req.FromHubHello && fingerprint != "" && e.deletedSpokeFp != nil && e.deletedSpokeFp[fingerprint] {
		e.mu.Unlock()
		return 0, nil
	}
	var targetIdx = -1

	// 0. Same physical board re-flashed (fingerprint kept): update it in place.
	if fingerprint != "" {
		for id, d := range e.detected {
			if d.Fingerprint == fingerprint {
				if id == 1 && role != "hub" {
					// Board was previously at Hub slot 1 and is now a Spoke: free slot 1
					// so it gets allocated a proper Spoke slot (2..7) below.
					delete(e.detected, 1)
					for i := range e.gates {
						if e.gates[i].AssignedTimerID == 1 {
							e.gates[i].AssignedTimerID = 0
						}
					}
					break
				}
				if req.FromHubHello && !d.IsHub &&
					(timerLabel == "" || d.TimerLabel == timerLabel) &&
					d.FirmwareVersion == ver {
					d.Online = true
					d.LastSeenAt = time.Now()
					e.mu.Unlock()
					return id, nil
				}
				if timerLabel != "" {
					d.TimerLabel = timerLabel
				}
				d.FirmwareVersion = ver
				d.IsHub = role == "hub"
				if !req.FromHubHello {
					d.Online = true
					d.LastSeenAt = time.Now()
				}
				for i := range e.gates {
					if e.gates[i].AssignedTimerID == id {
						if timerLabel != "" {
							e.gates[i].TimerLabel = timerLabel
						}
						e.gates[i].FirmwareVersion = ver
					}
				}
				pSnap, rSnap := e.syncTrackToOpenSessionsAndRacesLocked()
				pilots := append([]domain.PilotSlot(nil), e.pilots...)
				gates := append([]domain.TrackGate(nil), e.gates...)
				subs := append([]EventSubscriber(nil), e.subscribers...)
				e.mu.Unlock()
				for _, s := range subs {
					s.OnConfigUpdated(pilots, gates)
				}
				e.dispatchTrackSnapshotUpdates(pSnap, rSnap, subs)
				return id, nil
			}
		}
	}

	// Legacy simulator fallback when no hardware fingerprint is provided:
	if fingerprint == "" {
		if timerLabel != "" {
			for i := range e.gates {
				if strings.EqualFold(strings.TrimSpace(e.gates[i].TimerLabel), timerLabel) {
					targetIdx = i
					break
				}
			}
		}
		if targetIdx < 0 {
			ordered := e.orderedGatesLocked()
			for _, og := range ordered {
				canClaim := og.AssignedTimerID == 0 || (og.Role == domain.GateRoleSectorGate && strings.TrimSpace(og.TimerLabel) == "")
				if canClaim && strings.TrimSpace(og.TimerLabel) == "" {
					targetIdx = indexOfGate(e.gates, og.GateID)
					break
				}
			}
		}
	}

	var assignedID uint8
	if targetIdx < 0 {
		for id := uint8(2); id <= maxTimers; id++ {
			if _, exists := e.detected[id]; !exists {
				assignedID = id
				break
			}
		}
		// If all 6 Spoke slots (2..7) are occupied, reuse an offline Spoke slot (preferring
		// unassigned slots first) so reflashing or replacing hardware never fails with 400.
		if assignedID == 0 {
			for id := uint8(2); id <= maxTimers; id++ {
				d := e.detected[id]
				if d != nil && !d.IsHub && !d.Online {
					assigned := false
					for i := range e.gates {
						if e.gates[i].AssignedTimerID == id {
							assigned = true
							break
						}
					}
					if !assigned {
						assignedID = id
						delete(e.detected, id)
						break
					}
				}
			}
		}
		if assignedID == 0 {
			for id := uint8(2); id <= maxTimers; id++ {
				d := e.detected[id]
				if d != nil && !d.IsHub && (!d.Online || d.LastSeenAt.IsZero() || time.Since(d.LastSeenAt) >= timerOfflineAfter) {
					assignedID = id
					delete(e.detected, id)
					break
				}
			}
		}
		if assignedID == 0 && !req.FromHubHello {
			// When flashing over USB, if all 6 Spoke slots were seen recently, evict the oldest Spoke slot.
			var oldestID uint8
			var oldestTime time.Time
			for id := uint8(2); id <= maxTimers; id++ {
				d := e.detected[id]
				if d != nil && !d.IsHub {
					if oldestID == 0 || d.LastSeenAt.Before(oldestTime) {
						oldestID = id
						oldestTime = d.LastSeenAt
					}
				}
			}
			if oldestID > 0 {
				assignedID = oldestID
				delete(e.detected, oldestID)
			}
		}
		if assignedID == 0 {
			e.mu.Unlock()
			return 0, ErrInvalidTimerID
		}
		// Ensure no stale/orphaned gate holds this newly allocated timer ID.
		for i := range e.gates {
			if e.gates[i].AssignedTimerID == assignedID {
				e.gates[i].AssignedTimerID = 0
				e.gates[i].TimerLabel = ""
				e.gates[i].Online = false
				e.gates[i].LastSeenAt = time.Time{}
			}
		}
	} else {
		if e.gates[targetIdx].AssignedTimerID == 0 {
			e.gates[targetIdx].AssignedTimerID = e.gates[targetIdx].GateID
		}
		if timerLabel != "" {
			e.gates[targetIdx].TimerLabel = timerLabel
		}
		assignedID = e.gates[targetIdx].AssignedTimerID
		if assignedID == 0 {
			assignedID = e.gates[targetIdx].GateID
		}
	}

	now := time.Now()
	d, ok := e.detected[assignedID]
	if !ok {
		d = &domain.DetectedTimer{
			TimerID:       assignedID,
			Color:         domain.DefaultTimerColor(assignedID),
			BatteryMv:     4100,
			BatteryPct:    domain.ComputeBatteryPct(4100),
			NoiseFloorDbm: -92.0,
		}
		e.detected[assignedID] = d
	} else if d.Color == "" {
		d.Color = domain.DefaultTimerColor(assignedID)
	}
	if targetIdx >= 0 {
		e.gates[targetIdx].Color = d.Color
		e.gates[targetIdx].FirmwareVersion = ver
	}
	d.FirmwareVersion = ver
	if fingerprint != "" {
		d.Fingerprint = fingerprint
	} else if d.Fingerprint == "" {
		d.Fingerprint = newFingerprintHex()
	}
	if timerLabel != "" {
		d.TimerLabel = timerLabel
	}
	if !req.FromHubHello {
		d.Online = true
		d.LastSeenAt = now
	}

	pSnap, rSnap := e.syncTrackToOpenSessionsAndRacesLocked()
	pilots := append([]domain.PilotSlot(nil), e.pilots...)
	gates := append([]domain.TrackGate(nil), e.gates...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilots, gates)
	}
	e.dispatchTrackSnapshotUpdates(pSnap, rSnap, subs)
	return assignedID, nil
}

// provisionCollectorHubLocked registers the Hub (a USB collector dongle) as a timer. It is never
// placed on a gate automatically, but the user may drag it onto one: a Hub tied to a gate also
// sweeps 5.8 GHz and times that gate (the browser tells the Hub over USB). It keeps timer ID 1
// (or its existing ID if this board is already known).
func (e *Engine) provisionCollectorHubLocked(fingerprint, label, ver string) uint8 {
	// Ensure the Hub always occupies slot 1 (and move any non-Hub accidentally in slot 1 to 2..7).
	if d1, ok := e.detected[1]; ok && !d1.IsHub && (fingerprint == "" || d1.Fingerprint != fingerprint) {
		var movedID uint8
		for id := uint8(2); id <= maxTimers; id++ {
			if _, exists := e.detected[id]; !exists {
				movedID = id
				break
			}
		}
		if movedID != 0 {
			d1.TimerID = movedID
			e.detected[movedID] = d1
			for i := range e.gates {
				if e.gates[i].AssignedTimerID == 1 {
					e.gates[i].AssignedTimerID = movedID
				}
			}
		}
		delete(e.detected, 1)
	}
	// Remove any duplicate Hub entry at tid > 1 when provisioning Hub at slot 1.
	for tid, d := range e.detected {
		if tid != 1 && (d.IsHub || (fingerprint != "" && d.Fingerprint == fingerprint)) {
			delete(e.detected, tid)
			for i := range e.gates {
				if e.gates[i].AssignedTimerID == tid {
					e.gates[i].AssignedTimerID = 1
				}
			}
		}
	}
	const id uint8 = 1
	d, ok := e.detected[id]
	if !ok {
		d = &domain.DetectedTimer{
			TimerID:       id,
			Color:         domain.DefaultTimerColor(id),
			BatteryMv:     4100,
			BatteryPct:    domain.ComputeBatteryPct(4100),
			NoiseFloorDbm: -92.0,
		}
		e.detected[id] = d
	}
	d.IsHub = true
	d.FirmwareVersion = ver
	if fingerprint != "" {
		d.Fingerprint = fingerprint
	} else if d.Fingerprint == "" {
		d.Fingerprint = newFingerprintHex()
	}
	if label != "" {
		d.TimerLabel = label
	}
	now := time.Now()
	d.Online = true
	d.LastSeenAt = now
	if domain.IsSlapRFPrimaryGateHubMode(e.timingHardwareMode) && len(e.gates) == 0 {
		gateLabel := d.TimerLabel
		if gateLabel == "" {
			gateLabel = domain.DefaultSimHubLabel
		}
		e.gates = []domain.TrackGate{
			{
				GateID:          1,
				AssignedTimerID: id,
				TimerLabel:      gateLabel,
				FirmwareVersion: d.FirmwareVersion,
				Color:           d.Color,
				Role:            domain.GateRoleStartFinish,
				TrackOrder:      0,
				MapX:            0.50,
				MapY:            0.50,
				BatteryMv:       d.BatteryMv,
				BatteryPct:      d.BatteryPct,
				NoiseFloorDbm:   d.NoiseFloorDbm,
				LastRSSI:        d.LastRSSI,
				Online:          true,
				LastSeenAt:      now,
			},
		}
		e.initDetectorsLocked()
	}
	return id
}

// MarkTimerSeen refreshes a timer's online status. Used for the collector Hub, which sends no
// telemetry of its own, only periodic HELLO announcements.
func (e *Engine) MarkTimerSeen(timerID uint8) {
	e.mu.Lock()
	if d, ok := e.detected[timerID]; ok {
		d.Online = true
		d.LastSeenAt = time.Now()
	}
	e.mu.Unlock()
}

// AddGate appends or inserts a new logical gate onto the course.
func (e *Engine) AddGate(name string, assignedTimerID uint8, trackOrder ...int) (domain.TrackGate, error) {
	name = strings.TrimSpace(name)
	if utf8.RuneCountInString(name) > domain.MaxGateNameLen {
		return domain.TrackGate{}, ErrGateNameTooLong
	}
	if assignedTimerID > maxTimers {
		return domain.TrackGate{}, ErrInvalidTimerID
	}

	e.mu.Lock()
	var maxID uint8
	for _, g := range e.gates {
		if g.GateID > maxID {
			maxID = g.GateID
		}
	}
	nextID := maxID + 1
	if nextID < 1 {
		nextID = 1
	}
	if nextID > maxTimers {
		// Find first unused gate ID in 1..6
		used := make(map[uint8]bool, len(e.gates))
		for _, g := range e.gates {
			used[g.GateID] = true
		}
		nextID = 0
		for id := uint8(1); id <= maxTimers; id++ {
			if !used[id] {
				nextID = id
				break
			}
		}
		if nextID == 0 {
			e.mu.Unlock()
			return domain.TrackGate{}, ErrInvalidTimerID
		}
	}

	if assignedTimerID > 0 {
		for i := range e.gates {
			if e.gates[i].AssignedTimerID == assignedTimerID {
				e.gates[i].AssignedTimerID = 0
				e.gates[i].TimerLabel = ""
				e.gates[i].Color = ""
				e.gates[i].Online = false
				e.gates[i].BatteryMv = 0
				e.gates[i].BatteryPct = 0
			}
		}
	}

	newGate := domain.TrackGate{
		GateID:          nextID,
		AssignedTimerID: assignedTimerID,
		Name:            name,
		Role:            domain.GateRoleSectorGate,
		TrackOrder:      len(e.gates),
		MapX:            0.5,
		MapY:            0.5,
		NoiseFloorDbm:   -92.0,
	}
	if assignedTimerID > 0 {
		if d, ok := e.detected[assignedTimerID]; ok {
			newGate.TimerLabel = d.TimerLabel
			newGate.Color = d.Color
			newGate.BatteryMv = d.BatteryMv
			newGate.BatteryPct = d.BatteryPct
			newGate.NoiseFloorDbm = d.NoiseFloorDbm
			newGate.LastSeenAt = d.LastSeenAt
			newGate.Online = !d.LastSeenAt.IsZero() && time.Since(d.LastSeenAt) < timerOfflineAfter
		}
		if newGate.Color == "" {
			newGate.Color = domain.DefaultTimerColor(assignedTimerID)
		}
	}

	e.gates = append(e.gates, newGate)
	if len(trackOrder) > 0 {
		e.moveGateLocked(nextID, trackOrder[0])
	}
	e.ensureStartGateLocked()
	e.initDetectorsLocked()
	e.progress = make(map[int]*pilotProgress)

	createdIdx := indexOfGate(e.gates, nextID)
	created := e.gates[createdIdx]
	pSnap, rSnap := e.syncTrackToOpenSessionsAndRacesLocked()
	pilots := append([]domain.PilotSlot(nil), e.pilots...)
	gates := append([]domain.TrackGate(nil), e.gates...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilots, gates)
	}
	e.dispatchTrackSnapshotUpdates(pSnap, rSnap, subs)
	return created, nil
}

// RemoveGate deletes a gate from the course (any physical timer tied to it remains in
// `e.detected` and becomes unassigned).
func (e *Engine) RemoveGate(gateID uint8) error {
	e.mu.Lock()
	idx := indexOfGate(e.gates, gateID)
	if idx < 0 {
		e.mu.Unlock()
		return ErrUnknownGate
	}
	e.gates = append(e.gates[:idx], e.gates[idx+1:]...)
	ordered := e.orderedGatesLocked()
	e.applyOrderLocked(ordered)
	e.ensureStartGateLocked()
	e.progress = make(map[int]*pilotProgress)

	pSnap, rSnap := e.syncTrackToOpenSessionsAndRacesLocked()
	pilots := append([]domain.PilotSlot(nil), e.pilots...)
	gates := append([]domain.TrackGate(nil), e.gates...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilots, gates)
	}
	e.dispatchTrackSnapshotUpdates(pSnap, rSnap, subs)
	return nil
}

// SetTimerColor updates the physical color of a discovered XIAO ESP32-C5 timer and propagates
// it to any gate currently tied to that timer.
func (e *Engine) SetTimerColor(timerID uint8, color string) error {
	color = strings.TrimSpace(color)
	if timerID == 0 || timerID > maxTimers || color == "" {
		return ErrInvalidTimerID
	}

	e.mu.Lock()
	d, ok := e.detected[timerID]
	if !ok {
		d = &domain.DetectedTimer{
			TimerID:       timerID,
			Color:         color,
			BatteryMv:     4080,
			BatteryPct:    domain.ComputeBatteryPct(4080),
			NoiseFloorDbm: -92.0,
		}
		e.detected[timerID] = d
	} else {
		d.Color = color
	}
	for i := range e.gates {
		if e.gates[i].AssignedTimerID == timerID {
			e.gates[i].Color = color
		}
	}
	pSnap, rSnap := e.propagateTimerColorToTracksLocked(timerID, color)
	pilots := append([]domain.PilotSlot(nil), e.pilots...)
	gates := append([]domain.TrackGate(nil), e.gates...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilots, gates)
	}
	e.dispatchTrackSnapshotUpdates(pSnap, rSnap, subs)
	return nil
}

// UpdateGate renames a gate, moves it around the track, or assigns/unassigns a physical timer.
// An empty name clears the custom name, so the gate is shown as "Gate N" by its position.
//
// The first gate in track order is always the start / finish line, so the role is derived
// from the order rather than stored independently:
//   - u.TrackOrder (when set) moves the gate to that position; moving it to 0 makes it
//     start / finish. Without it the gate stays where it is.
//   - u.Role == START_FINISH on a gate that isn't first rotates the course so it becomes
//     first while every other gate keeps its place in the loop (G1 G2 G3 G4 -> G3 G4 G1 G2).
//
// Changing the layout restarts in-progress laps, since sections are defined by gate order.
func (e *Engine) UpdateGate(u domain.GateUpdate) error {
	name := strings.TrimSpace(u.Name)
	if utf8.RuneCountInString(name) > domain.MaxGateNameLen {
		return ErrGateNameTooLong
	}
	if u.Role != domain.GateRoleStartFinish && u.Role != domain.GateRoleSectorGate {
		return ErrInvalidGateRole
	}
	if u.AssignedTimerID != nil && *u.AssignedTimerID > maxTimers {
		return ErrInvalidTimerID
	}

	e.mu.Lock()
	idx := -1
	for i := range e.gates {
		if e.gates[i].GateID == u.GateID {
			idx = i
			break
		}
	}
	if idx < 0 {
		e.mu.Unlock()
		return ErrUnknownGate
	}
	e.gates[idx].Name = name
	if c := strings.TrimSpace(u.Color); c != "" {
		e.gates[idx].Color = c
		if tid := e.gates[idx].AssignedTimerID; tid > 0 {
			if d, ok := e.detected[tid]; ok {
				d.Color = c
			}
		}
	}

	if u.AssignedTimerID != nil {
		wantTimer := *u.AssignedTimerID
		e.gates[idx].AssignedTimerID = wantTimer
		if wantTimer == 0 {
			e.gates[idx].TimerLabel = ""
			e.gates[idx].Color = ""
			e.gates[idx].Online = false
			e.gates[idx].BatteryMv = 0
			e.gates[idx].BatteryPct = 0
		} else {
			// Unassign any other gate that was tied to this physical timer.
			for j := range e.gates {
				if j != idx && e.gates[j].AssignedTimerID == wantTimer {
					e.gates[j].AssignedTimerID = 0
					e.gates[j].TimerLabel = ""
					e.gates[j].Color = ""
					e.gates[j].Online = false
					e.gates[j].BatteryMv = 0
					e.gates[j].BatteryPct = 0
				}
			}
			if d, ok := e.detected[wantTimer]; ok {
				e.gates[idx].TimerLabel = d.TimerLabel
				if d.Color != "" {
					e.gates[idx].Color = d.Color
				} else {
					e.gates[idx].Color = domain.DefaultTimerColor(wantTimer)
				}
				e.gates[idx].BatteryMv = d.BatteryMv
				e.gates[idx].BatteryPct = d.BatteryPct
				e.gates[idx].NoiseFloorDbm = d.NoiseFloorDbm
				e.gates[idx].LastSeenAt = d.LastSeenAt
				e.gates[idx].Online = !d.LastSeenAt.IsZero() && time.Since(d.LastSeenAt) < timerOfflineAfter
			} else {
				e.gates[idx].Color = domain.DefaultTimerColor(wantTimer)
			}
		}
	}

	var layoutChanged bool
	if u.Role == domain.GateRoleStartFinish && e.gates[idx].Role != domain.GateRoleStartFinish {
		for j := range e.gates {
			if j == idx {
				e.gates[j].Role = domain.GateRoleStartFinish
			} else {
				e.gates[j].Role = domain.GateRoleSectorGate
			}
		}
		layoutChanged = true
	}
	if u.TrackOrder != nil {
		if e.moveGateLocked(u.GateID, *u.TrackOrder) {
			layoutChanged = true
		}
	}
	e.ensureStartGateLocked()
	if layoutChanged {
		// In-progress laps were measured against the old layout.
		e.progress = make(map[int]*pilotProgress)
	}

	pSnap, rSnap := e.syncTrackToOpenSessionsAndRacesLocked()
	pilots := append([]domain.PilotSlot(nil), e.pilots...)
	gates := append([]domain.TrackGate(nil), e.gates...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilots, gates)
	}
	e.dispatchTrackSnapshotUpdates(pSnap, rSnap, subs)
	return nil
}

// moveGateLocked places a gate at `position` in track order. Reports whether the order changed.
func (e *Engine) moveGateLocked(gateID uint8, position int) bool {
	ordered := e.orderedGatesLocked()
	from := indexOfGate(ordered, gateID)
	if from < 0 {
		return false
	}
	if position < 0 {
		position = 0
	}
	if position > len(ordered)-1 {
		position = len(ordered) - 1
	}
	moved := ordered[from]
	ordered = append(ordered[:from], ordered[from+1:]...)
	ordered = append(ordered[:position], append([]domain.TrackGate{moved}, ordered[position:]...)...)
	return e.applyOrderLocked(ordered)
}

// rotateToFrontLocked rotates the loop so `gateID` is first, keeping the cyclic order.
func (e *Engine) rotateToFrontLocked(gateID uint8) bool {
	ordered := e.orderedGatesLocked()
	at := indexOfGate(ordered, gateID)
	if at <= 0 {
		return false
	}
	rotated := append(append([]domain.TrackGate(nil), ordered[at:]...), ordered[:at]...)
	return e.applyOrderLocked(rotated)
}

// applyOrderLocked renumbers every gate 0..n-1 following `ordered`. Reports whether it changed.
func (e *Engine) applyOrderLocked(ordered []domain.TrackGate) bool {
	newOrder := make(map[uint8]int, len(ordered))
	for i, g := range ordered {
		newOrder[g.GateID] = i
	}
	changed := false
	for i := range e.gates {
		if e.gates[i].TrackOrder != newOrder[e.gates[i].GateID] {
			changed = true
		}
		e.gates[i].TrackOrder = newOrder[e.gates[i].GateID]
	}
	sort.SliceStable(e.gates, func(i, j int) bool { return e.gates[i].TrackOrder < e.gates[j].TrackOrder })
	return changed
}

// ensureStartGateLocked ensures exactly one gate has Role == START_FINISH without tying it to TrackOrder == 0.
func (e *Engine) ensureStartGateLocked() {
	if len(e.gates) == 0 {
		return
	}
	found := false
	for i := range e.gates {
		if e.gates[i].Role == domain.GateRoleStartFinish {
			if !found {
				found = true
			} else {
				e.gates[i].Role = domain.GateRoleSectorGate
			}
		} else {
			e.gates[i].Role = domain.GateRoleSectorGate
		}
	}
	if !found {
		e.gates[0].Role = domain.GateRoleStartFinish
	}
}

func indexOfGate(gates []domain.TrackGate, id uint8) int {
	for i, g := range gates {
		if g.GateID == id {
			return i
		}
	}
	return -1
}

// gateLabelFromGates formats how a gate is named in events, summaries, and section splits.
// When `detected` is nil (frozen historical TrackSnapshot), labels are derived strictly from `ordered`.
func gateLabelFromGates(ordered []domain.TrackGate, detected map[uint8]*domain.DetectedTimer, gateID uint8) string {
	at := indexOfGate(ordered, gateID)
	if at < 0 {
		return fmt.Sprintf("T%d", gateID)
	}
	g := ordered[at]
	if name := strings.TrimSpace(g.Name); name != "" {
		return name
	}
	if lbl := strings.TrimSpace(g.TimerLabel); lbl != "" {
		return lbl
	}
	tid := g.AssignedTimerID
	if tid > 0 {
		if detected != nil {
			if d, ok := detected[tid]; ok {
				if lbl := strings.TrimSpace(d.TimerLabel); lbl != "" {
					return lbl
				}
				return domain.DefaultTimerLabel(tid, d.IsHub)
			}
		}
		return domain.DefaultTimerLabel(tid, tid == domain.SimHubTimerID)
	}
	return fmt.Sprintf("T%d", at+1)
}

func sectionLabelFromGates(ordered []domain.TrackGate, detected map[uint8]*domain.DetectedTimer, fromGateID, toGateID uint8) string {
	return gateLabelFromGates(ordered, detected, fromGateID) + " → " + gateLabelFromGates(ordered, detected, toGateID)
}

// gateLabelLocked is how a timer on the track is named in events and section splits:
// its custom Name if set, otherwise its flashed TimerLabel (e.g. "T1", "H1"), or
// DefaultTimerLabel by hardware timer ID. Mirrors gateLabel() in web/src/state/selectors.ts.
func (e *Engine) gateLabelLocked(gateID uint8) string {
	return gateLabelFromGates(e.orderedGatesLocked(), e.detected, gateID)
}

// sectionLabelLocked names the stretch of track between two gates, e.g. "Gate 2 → Split-S".
func (e *Engine) sectionLabelLocked(fromGateID, toGateID uint8) string {
	return sectionLabelFromGates(e.orderedGatesLocked(), e.detected, fromGateID, toGateID)
}

// snapshotOrderedGatesLocked returns a self-contained deep copy of the current ordered track gates
// enriched with their assigned timer's label, firmware version, and color so historical Practice
// Sessions and completed Races preserve exact gate identities even if timers are later re-flashed,
// recolored, unassigned, or deleted.
func (e *Engine) snapshotOrderedGatesLocked() []domain.TrackGate {
	ordered := e.orderedGatesLocked()
	out := make([]domain.TrackGate, len(ordered))
	for i, g := range ordered {
		cp := g
		cp.TrackOrder = i
		if cp.AssignedTimerID > 0 {
			if d, ok := e.detected[cp.AssignedTimerID]; ok && d != nil {
				if strings.TrimSpace(d.TimerLabel) != "" {
					cp.TimerLabel = strings.TrimSpace(d.TimerLabel)
				}
				if d.FirmwareVersion != "" {
					cp.FirmwareVersion = d.FirmwareVersion
				}
				if strings.TrimSpace(d.Color) != "" {
					cp.Color = strings.TrimSpace(d.Color)
				}
				cp.BatteryMv = d.BatteryMv
				cp.BatteryPct = d.BatteryPct
				cp.NoiseFloorDbm = d.NoiseFloorDbm
			}
			if strings.TrimSpace(cp.Color) == "" {
				cp.Color = domain.DefaultTimerColor(cp.AssignedTimerID)
			}
			if strings.TrimSpace(cp.TimerLabel) == "" {
				cp.TimerLabel = domain.DefaultTimerLabel(cp.AssignedTimerID, cp.AssignedTimerID == domain.SimHubTimerID)
			}
		}
		out[i] = cp
	}
	return out
}

func isRaceTrackEditable(r *domain.RaceTournamentState) bool {
	return r != nil &&
		r.RaceID != "" &&
		r.Lifecycle != domain.LifecycleCompleted &&
		r.Lifecycle != domain.LifecycleScrapped &&
		!r.IsComplete
}

// syncTrackToOpenSessionsAndRacesLocked syncs `e.gates` strictly to the currently active Practice
// session (`s.Active == true`) or currently loaded editable Race (`e.raceState.RaceID`), never
// touching stopped Practice sessions or any other Race in `e.eventState.Races`.
func (e *Engine) syncTrackToOpenSessionsAndRacesLocked() (*domain.PracticeManagerState, *domain.RaceTournamentState) {
	snap := e.snapshotOrderedGatesLocked()

	practiceTouched := false
	hasActivePractice := false
	if (e.practiceState.Initialized || len(e.practiceState.Sessions) > 0) && !e.isLiveRaceHeatActiveLocked() {
		for i := range e.practiceState.Sessions {
			s := &e.practiceState.Sessions[i]
			if s.Active {
				hasActivePractice = true
				s.TrackInitialized = true
				s.TrackSnapshot = cloneTrackGates(snap)
				s.Summaries = e.computePracticeSessionSummariesLocked(s)
				practiceTouched = true
			}
		}
	}

	raceTouched := false
	if isRaceOngoing(&e.raceState) || (!hasActivePractice && isRaceTrackEditable(&e.raceState)) {
		e.raceState.TrackInitialized = true
		e.raceState.TrackSnapshot = cloneTrackGates(snap)
		raceTouched = true
		for i := range e.eventState.Races {
			if e.eventState.Races[i].RaceID == e.raceState.RaceID && isRaceTrackEditable(&e.eventState.Races[i]) {
				e.eventState.Races[i].TrackInitialized = true
				e.eventState.Races[i].TrackSnapshot = cloneTrackGates(snap)
			}
		}
	}

	var pOut *domain.PracticeManagerState
	if practiceTouched {
		cp := clonePracticeManagerState(e.practiceState)
		pOut = &cp
	}
	var rOut *domain.RaceTournamentState
	if raceTouched {
		cp := cloneRaceState(e.raceState)
		rOut = &cp
	}
	return pOut, rOut
}

func (e *Engine) dispatchTrackSnapshotUpdates(
	pSnap *domain.PracticeManagerState,
	rSnap *domain.RaceTournamentState,
	subs []EventSubscriber,
) {
	if len(subs) == 0 {
		return
	}
	if pSnap != nil {
		e.notifyPracticeUpdated(*pSnap, subs)
	}
	if rSnap != nil {
		e.notifyRaceUpdated(*rSnap, nil, subs)
	}
}

// ClearPilotProgress resets in-progress lap/sector tracking for a single pilot (e.g. when a
// simulated pilot lands in the pits for a battery swap or is recovered after a crash) so their
// next pass through the Start/Finish gate cleanly starts a fresh lap.
func (e *Engine) ClearPilotProgress(slotIndex int) {
	e.mu.Lock()
	delete(e.progress, slotIndex)
	e.mu.Unlock()
}

// HasDetectedTimer reports whether a physical/provisioned timer with `timerID` exists in `e.detected`.
func (e *Engine) HasDetectedTimer(timerID uint8) bool {
	e.mu.RLock()
	defer e.mu.RUnlock()
	_, ok := e.detected[timerID]
	return ok
}

// HasDetectedTimerFingerprint reports whether `timerID` exists in `e.detected` AND still belongs
// to the board with `fingerprint` (case-insensitive). Checking `timerID` alone is insufficient
// across storage wipes, imports, or timer deletions where a freed `timerID` can be reassigned to a
// different Spoke board.
func (e *Engine) HasDetectedTimerFingerprint(timerID uint8, fingerprint string) bool {
	e.mu.RLock()
	defer e.mu.RUnlock()
	d, ok := e.detected[timerID]
	if !ok || d == nil {
		return false
	}
	return strings.EqualFold(strings.TrimSpace(d.Fingerprint), strings.TrimSpace(fingerprint))
}

// SetDetectedTimerOnline immediately marks a physical/simulated timer online or offline.
func (e *Engine) SetDetectedTimerOnline(timerID uint8, online bool) {
	e.mu.Lock()
	now := time.Now()
	if d, ok := e.detected[timerID]; ok {
		d.Online = online
		if online {
			d.LastSeenAt = now
		} else {
			d.LastSeenAt = time.Time{}
		}
	}
	for i := range e.gates {
		if e.gates[i].AssignedTimerID == timerID {
			e.gates[i].Online = online
			if online {
				e.gates[i].LastSeenAt = now
			} else {
				e.gates[i].LastSeenAt = time.Time{}
			}
		}
	}
	pilots := append([]domain.PilotSlot(nil), e.pilots...)
	gates := append([]domain.TrackGate(nil), e.gates...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilots, gates)
	}
}

// SetAllTimersOffline clears the online status of all detected timers and gates until live Hub frames arrive.
func (e *Engine) SetAllTimersOffline() {
	e.mu.Lock()
	for _, d := range e.detected {
		d.Online = false
		d.LastSeenAt = time.Time{}
	}
	for i := range e.gates {
		e.gates[i].Online = false
		e.gates[i].LastSeenAt = time.Time{}
	}
	pilots := append([]domain.PilotSlot(nil), e.pilots...)
	gates := append([]domain.TrackGate(nil), e.gates...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilots, gates)
	}
}

// IsDeletedSpokeFingerprint reports whether a Spoke fingerprint was explicitly deleted by the user.
func (e *Engine) IsDeletedSpokeFingerprint(fingerprint string) bool {
	fp := strings.ToUpper(strings.TrimSpace(fingerprint))
	if fp == "" {
		return false
	}
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.deletedSpokeFp != nil && e.deletedSpokeFp[fp]
}

// ClearDeletedSpokeFingerprint clears the deleted marker once a Spoke transmits live telemetry frames.
func (e *Engine) ClearDeletedSpokeFingerprint(fingerprint string) {
	fp := strings.ToUpper(strings.TrimSpace(fingerprint))
	if fp == "" {
		return
	}
	e.mu.Lock()
	if e.deletedSpokeFp != nil {
		delete(e.deletedSpokeFp, fp)
	}
	e.mu.Unlock()
}

// IsTimerActivelyOnline reports whether `timerID` is currently registered and actively online.
func (e *Engine) IsTimerActivelyOnline(timerID uint8) bool {
	e.mu.RLock()
	defer e.mu.RUnlock()
	d, ok := e.detected[timerID]
	if !ok || !d.Online {
		return false
	}
	if !e.isSimEngine && !d.IsHub && d.FirmwareVersion != "LapRF" && d.FirmwareVersion != "RotorHazard" && !d.LastSeenAt.IsZero() && time.Since(d.LastSeenAt) > 6*time.Second {
		return false
	}
	return true
}

// DeleteDetectedTimer removes a timer from `e.detected` and deletes any gate assigned to it from the track.
func (e *Engine) DeleteDetectedTimer(timerID uint8) error {
	if timerID == 0 || timerID > maxTimers {
		return ErrInvalidTimerID
	}
	e.mu.Lock()
	if d, ok := e.detected[timerID]; ok {
		if fp := strings.ToUpper(strings.TrimSpace(d.Fingerprint)); fp != "" && !d.IsHub {
			if e.deletedSpokeFp == nil {
				e.deletedSpokeFp = make(map[string]bool)
			}
			e.deletedSpokeFp[fp] = true
		}
	}
	delete(e.detected, timerID)
	kept := e.gates[:0]
	for _, g := range e.gates {
		if g.AssignedTimerID != timerID {
			kept = append(kept, g)
		}
	}
	e.gates = kept
	ordered := e.orderedGatesLocked()
	e.applyOrderLocked(ordered)
	e.ensureStartGateLocked()
	e.initDetectorsLocked()
	e.progress = make(map[int]*pilotProgress)
	pSnap, rSnap := e.propagateTimerRemovalToTracksLocked(timerID, true)
	pilots := append([]domain.PilotSlot(nil), e.pilots...)
	gates := append([]domain.TrackGate(nil), e.gates...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilots, gates)
	}
	e.dispatchTrackSnapshotUpdates(pSnap, rSnap, subs)
	return nil
}

// UnprovisionTimer removes a timer's flashed firmware identity from `e.detected` (e.g. when a
// simulated board is erased back to factory-blank) and unassigns any gate bound to it without
// deleting the gate from the course.
func (e *Engine) UnprovisionTimer(timerID uint8) error {
	if timerID == 0 || timerID > maxTimers {
		return ErrInvalidTimerID
	}
	e.mu.Lock()
	delete(e.detected, timerID)
	for i := range e.gates {
		if e.gates[i].AssignedTimerID == timerID {
			e.gates[i].AssignedTimerID = 0
			e.gates[i].TimerLabel = ""
			e.gates[i].Online = false
			e.gates[i].LastSeenAt = time.Time{}
		}
	}
	e.initDetectorsLocked()
	e.progress = make(map[int]*pilotProgress)
	pSnap, rSnap := e.propagateTimerRemovalToTracksLocked(timerID, false)
	pilots := append([]domain.PilotSlot(nil), e.pilots...)
	gates := append([]domain.TrackGate(nil), e.gates...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilots, gates)
	}
	e.dispatchTrackSnapshotUpdates(pSnap, rSnap, subs)
	return nil
}

// FlashSimBoard programs or updates a simulated XIAO ESP32-C5 board (`timerID` 1..7) with the
// given role, label, fingerprint, and firmware version.
func (e *Engine) FlashSimBoard(timerID uint8, isHub bool, label, fingerprint, fwVersion, color string) error {
	if timerID == 0 || timerID > maxTimers {
		return ErrInvalidTimerID
	}
	label = strings.TrimSpace(label)
	if utf8.RuneCountInString(label) > domain.MaxGateNameLen {
		return ErrGateNameTooLong
	}
	fingerprint = strings.ToUpper(strings.TrimSpace(fingerprint))
	if fwVersion == "" {
		fwVersion = domain.LatestFirmwareVersion
	}

	e.mu.Lock()
	if fingerprint != "" && e.deletedSpokeFp != nil {
		delete(e.deletedSpokeFp, fingerprint)
	}
	d, ok := e.detected[timerID]
	if !ok {
		if color == "" {
			color = domain.DefaultTimerColor(timerID)
		}
		d = &domain.DetectedTimer{
			TimerID:       timerID,
			Color:         color,
			BatteryMv:     4120,
			BatteryPct:    domain.ComputeBatteryPct(4120),
			NoiseFloorDbm: -92.0,
		}
		e.detected[timerID] = d
	} else if color != "" && d.Color == "" {
		d.Color = color
	}
	if fingerprint == "" {
		if d.Fingerprint != "" {
			fingerprint = d.Fingerprint
		} else {
			fingerprint = fmt.Sprintf("53494D%02X", timerID)
		}
	}
	if label == "" {
		label = domain.DefaultTimerLabel(timerID, isHub)
	}
	d.IsHub = isHub
	d.TimerLabel = label
	d.Fingerprint = fingerprint
	d.FirmwareVersion = fwVersion
	if isHub {
		d.BatteryMv = 4200
		d.BatteryPct = 100
		// A newly flashed Hub is an off-track USB collector dongle; unbind any gate it previously held as a Spoke.
		for i := range e.gates {
			if e.gates[i].AssignedTimerID == timerID {
				e.gates[i].AssignedTimerID = 0
				e.gates[i].TimerLabel = ""
				e.gates[i].Online = false
				e.gates[i].LastSeenAt = time.Time{}
			}
		}
	} else {
		alreadyOnGate := false
		for i := range e.gates {
			if e.gates[i].AssignedTimerID == timerID {
				e.gates[i].TimerLabel = label
				e.gates[i].FirmwareVersion = fwVersion
				e.gates[i].Color = d.Color
				alreadyOnGate = true
			}
		}
		if !alreadyOnGate {
			ordered := e.orderedGatesLocked()
			for _, og := range ordered {
				if og.AssignedTimerID == 0 {
					idx := indexOfGate(e.gates, og.GateID)
					if idx >= 0 {
						e.gates[idx].AssignedTimerID = timerID
						e.gates[idx].TimerLabel = label
						e.gates[idx].FirmwareVersion = fwVersion
						e.gates[idx].Color = d.Color
						e.gates[idx].BatteryMv = d.BatteryMv
						e.gates[idx].BatteryPct = d.BatteryPct
						e.gates[idx].NoiseFloorDbm = d.NoiseFloorDbm
						break
					}
				}
			}
		}
	}
	e.initDetectorsLocked()
	pSnap, rSnap := e.syncTrackToOpenSessionsAndRacesLocked()
	pilots := append([]domain.PilotSlot(nil), e.pilots...)
	gates := append([]domain.TrackGate(nil), e.gates...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilots, gates)
	}
	e.dispatchTrackSnapshotUpdates(pSnap, rSnap, subs)
	return nil
}

// AddSimulatedTimer creates a new simulated XIAO timer in `e.detected`, following the same Hub/Spoke model as real hardware:
//   - "hub": the simulated USB collector dongle (one per course, timer ID 1 when free). It is
//     registered without a gate; dragging it onto a gate later makes it sweep that gate.
//   - "spoke": takes the first free timer ID from 2 up and binds to the first gate without a
//     timer, or appends a new gate for it.
//
// An empty label defaults to "H1" for the Hub (Spokes may stay unnamed, shown by gate position).
func (e *Engine) AddSimulatedTimer(role string, label string) (uint8, error) {
	label = strings.TrimSpace(label)
	if utf8.RuneCountInString(label) > domain.MaxGateNameLen {
		return 0, ErrGateNameTooLong
	}
	fwVersion := domain.LatestFirmwareVersion
	isHub := role == "hub"

	e.mu.Lock()
	if isHub {
		for _, d := range e.detected {
			if d.IsHub {
				e.mu.Unlock()
				return 0, ErrHubExists
			}
		}
	}
	var nextID uint8
	if isHub {
		if _, taken := e.detected[domain.SimHubTimerID]; !taken {
			nextID = domain.SimHubTimerID
		}
	}
	for id := uint8(2); nextID == 0 && id <= maxTimers; id++ {
		if _, exists := e.detected[id]; !exists {
			nextID = id
		}
	}
	if nextID == 0 {
		e.mu.Unlock()
		return 0, ErrInvalidTimerID
	}
	if label == "" {
		label = domain.DefaultTimerLabel(nextID, isHub)
	}

	now := time.Now()
	d := &domain.DetectedTimer{
		TimerID:         nextID,
		TimerLabel:      label,
		Color:           domain.DefaultTimerColor(nextID),
		IsHub:           isHub,
		FirmwareVersion: fwVersion,
		Fingerprint:     newFingerprintHex(),
		BatteryMv:       4120,
		BatteryPct:      domain.ComputeBatteryPct(4120),
		NoiseFloorDbm:   -92.0,
		Online:          true,
		LastSeenAt:      now,
	}
	if isHub {
		d.Color = domain.DefaultGateColors[4%len(domain.DefaultGateColors)]
		d.BatteryMv = 4200 // USB powered
		d.BatteryPct = 100
	}
	e.detected[nextID] = d

	// A Spoke binds to an existing gate without a timer, or (if fewer than maxTimers gates
	// exist) gets a new gate appended. The Hub never takes a gate on its own.
	bound := isHub
	for i := range e.gates {
		if bound {
			break
		}
		if e.gates[i].AssignedTimerID == 0 {
			e.gates[i].AssignedTimerID = nextID
			e.gates[i].TimerLabel = label
			e.gates[i].FirmwareVersion = fwVersion
			e.gates[i].Color = d.Color
			e.gates[i].BatteryMv = d.BatteryMv
			e.gates[i].BatteryPct = d.BatteryPct
			e.gates[i].NoiseFloorDbm = d.NoiseFloorDbm
			e.gates[i].Online = true
			e.gates[i].LastSeenAt = now
			bound = true
			break
		}
	}
	if !bound && len(e.gates) < maxTimers {
		var gateID uint8
		usedGate := make(map[uint8]bool, len(e.gates))
		for _, g := range e.gates {
			usedGate[g.GateID] = true
		}
		for id := uint8(1); id <= maxTimers; id++ {
			if !usedGate[id] {
				gateID = id
				break
			}
		}
		if gateID > 0 {
			var defaultRssi [domain.MaxPilotPoolSize]float32
			for k := range defaultRssi {
				defaultRssi[k] = -92
			}
			e.gates = append(e.gates, domain.TrackGate{
				GateID:          gateID,
				AssignedTimerID: nextID,
				TimerLabel:      label,
				FirmwareVersion: fwVersion,
				Color:           d.Color,
				Role:            domain.GateRoleSectorGate,
				TrackOrder:      len(e.gates),
				MapX:            0.5,
				MapY:            0.5,
				BatteryMv:       d.BatteryMv,
				BatteryPct:      d.BatteryPct,
				NoiseFloorDbm:   d.NoiseFloorDbm,
				LastRSSI:        defaultRssi,
				Online:          true,
				LastSeenAt:      now,
			})
			e.ensureStartGateLocked()
			e.initDetectorsLocked()
			e.progress = make(map[int]*pilotProgress)
		}
	}

	pSnap, rSnap := e.syncTrackToOpenSessionsAndRacesLocked()
	pilots := append([]domain.PilotSlot(nil), e.pilots...)
	gates := append([]domain.TrackGate(nil), e.gates...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilots, gates)
	}
	e.dispatchTrackSnapshotUpdates(pSnap, rSnap, subs)
	return nextID, nil
}
