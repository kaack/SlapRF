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

const maxTimers = 6

var (
	ErrUnknownGate     = errors.New("unknown gate")
	ErrInvalidTimerID  = errors.New("timer ID must be between 1 and 6")
	ErrGateNameTooLong = errors.New("gate name is too long")
	ErrInvalidGateRole = errors.New("unknown gate role")
	ErrMinOneGate      = errors.New("at least one gate must remain on the course")
)

// ProvisionRequest describes a timer that was just flashed (or registered) by the flasher.
type ProvisionRequest struct {
	Role        string // "hub" or "spoke"
	Label       string // Flashed timer name (e.g. "H1", "S3")
	Profile     string // Firmware profile ID; empty = domain.DefaultFirmwareProfile
	Fingerprint string // 8-hex-digit board fingerprint; empty = unknown
}

// ProvisionGate registers a newly flashed timer (hub or spoke).
//   - A known fingerprint updates that same physical timer in place, keeping its color and gate.
//   - Otherwise a timer with the same label is updated (a replacement board takes over its gate).
//   - Otherwise a "hub" claims the start/finish gate and a "spoke" the next unlabelled sector
//     gate, creating a new gate (up to the timer limit) if every gate is already labelled.
func (e *Engine) ProvisionGate(req ProvisionRequest) (uint8, error) {
	role := req.Role
	timerLabel := strings.TrimSpace(req.Label)
	if utf8.RuneCountInString(timerLabel) > domain.MaxGateNameLen {
		return 0, ErrGateNameTooLong
	}
	profile := strings.TrimSpace(req.Profile)
	if profile == "" {
		profile = domain.DefaultFirmwareProfile
	}
	fingerprint := strings.ToUpper(strings.TrimSpace(req.Fingerprint))
	ver := domain.LatestFirmwareVersion

	e.mu.Lock()
	if role == "hub" && e.hubIsCollector {
		id := e.provisionCollectorHubLocked(fingerprint, timerLabel, profile, ver)
		pilots := append([]domain.PilotSlot(nil), e.pilots...)
		gates := append([]domain.TrackGate(nil), e.gates...)
		subs := append([]EventSubscriber(nil), e.subscribers...)
		e.mu.Unlock()
		for _, s := range subs {
			s.OnConfigUpdated(pilots, gates)
		}
		return id, nil
	}
	var targetIdx = -1

	// 0. Same physical board re-flashed (fingerprint kept): update it in place.
	if fingerprint != "" {
		for id, d := range e.detected {
			if d.Fingerprint == fingerprint {
				if timerLabel != "" {
					d.TimerLabel = timerLabel
				}
				d.FirmwareVersion = ver
				d.FirmwareProfile = profile
				d.IsHub = role == "hub"
				d.Online = true
				d.LastSeenAt = time.Now()
				for i := range e.gates {
					if e.gates[i].AssignedTimerID == id {
						if timerLabel != "" {
							e.gates[i].TimerLabel = timerLabel
						}
						e.gates[i].FirmwareVersion = ver
					}
				}
				pilots := append([]domain.PilotSlot(nil), e.pilots...)
				gates := append([]domain.TrackGate(nil), e.gates...)
				subs := append([]EventSubscriber(nil), e.subscribers...)
				e.mu.Unlock()
				for _, s := range subs {
					s.OnConfigUpdated(pilots, gates)
				}
				return id, nil
			}
		}
	}

	// 1. If a gate already has this exact TimerLabel, update that one.
	if timerLabel != "" {
		for i := range e.gates {
			if strings.EqualFold(strings.TrimSpace(e.gates[i].TimerLabel), timerLabel) {
				targetIdx = i
				break
			}
		}
	}

	// 2. Otherwise pick by role (hub -> start/finish gate; spoke -> next unlabelled sector gate).
	if targetIdx < 0 {
		if role == "hub" {
			for i := range e.gates {
				if e.gates[i].Role == domain.GateRoleStartFinish || e.gates[i].TrackOrder == 0 {
					aid := e.gates[i].AssignedTimerID
					if aid == 0 || (e.detected[aid] != nil && e.detected[aid].IsHub) {
						targetIdx = i
						break
					}
				}
			}
			if targetIdx < 0 && len(e.gates) > 0 && e.gates[0].AssignedTimerID == 0 {
				targetIdx = 0
			}
		} else {
			ordered := e.orderedGatesLocked()
			for _, og := range ordered {
				canClaim := og.Role == domain.GateRoleSectorGate || (e.hubIsCollector && og.AssignedTimerID == 0)
				if canClaim && strings.TrimSpace(og.TimerLabel) == "" {
					targetIdx = indexOfGate(e.gates, og.GateID)
					break
				}
			}
		}
	}

	// 3. If all existing sector gates already have a flashed TimerLabel, add a new track gate (up to 6).
	if targetIdx < 0 {
		var maxID uint8
		for _, g := range e.gates {
			if g.GateID > maxID {
				maxID = g.GateID
			}
		}
		for id := range e.detected {
			if id > maxID {
				maxID = id
			}
		}
		nextID := maxID + 1
		if nextID < 1 {
			nextID = 1
		}
		if e.hubIsCollector && nextID < 2 {
			nextID = 2 // Timer ID 1 is reserved for the collector Hub, which never holds a gate
		}
		if nextID > maxTimers {
			e.mu.Unlock()
			return 0, ErrInvalidTimerID
		}
		e.gates = append(e.gates, domain.TrackGate{
			GateID:          nextID,
			AssignedTimerID: nextID,
			TimerLabel:      timerLabel,
			Color:           domain.DefaultGateColors[len(e.gates)%len(domain.DefaultGateColors)],
			Role:            domain.GateRoleSectorGate,
			TrackOrder:      len(e.gates),
			BatteryMv:       4100,
			BatteryPct:      domain.ComputeBatteryPct(4100),
			NoiseFloorDbm:   -92,
			Online:          true,
			LastSeenAt:      time.Now(),
		})
		e.ensureStartGateLocked()
		e.initDetectorsLocked()
		targetIdx = len(e.gates) - 1
	} else {
		if e.gates[targetIdx].AssignedTimerID == 0 {
			e.gates[targetIdx].AssignedTimerID = e.gates[targetIdx].GateID
		}
		if timerLabel != "" {
			e.gates[targetIdx].TimerLabel = timerLabel
		}
	}

	assignedID := e.gates[targetIdx].AssignedTimerID
	if assignedID == 0 {
		assignedID = e.gates[targetIdx].GateID
	}
	now := time.Now()
	d, ok := e.detected[assignedID]
	if !ok {
		d = &domain.DetectedTimer{
			TimerID:       assignedID,
			Color:         domain.DefaultTimerColor(assignedID),
			IsHub:         role == "hub" || assignedID == 1,
			BatteryMv:     4100,
			BatteryPct:    domain.ComputeBatteryPct(4100),
			NoiseFloorDbm: -92.0,
		}
		e.detected[assignedID] = d
	} else if d.Color == "" {
		d.Color = domain.DefaultTimerColor(assignedID)
	}
	e.gates[targetIdx].Color = d.Color
	e.gates[targetIdx].FirmwareVersion = ver
	d.FirmwareVersion = ver
	d.FirmwareProfile = profile
	if fingerprint != "" {
		d.Fingerprint = fingerprint
	} else if d.Fingerprint == "" {
		d.Fingerprint = newFingerprintHex()
	}
	if timerLabel != "" {
		d.TimerLabel = timerLabel
	}
	if role == "hub" {
		d.IsHub = true
	}
	d.Online = true
	d.LastSeenAt = now

	pilots := append([]domain.PilotSlot(nil), e.pilots...)
	gates := append([]domain.TrackGate(nil), e.gates...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilots, gates)
	}
	return assignedID, nil
}

// provisionCollectorHubLocked registers the real-hardware Hub (a USB collector dongle) as a timer
// with no gate: it shows up on the Network page with its status and firmware, but never times
// laps. It keeps timer ID 1 (or its existing ID if this board is already known).
func (e *Engine) provisionCollectorHubLocked(fingerprint, label, profile, ver string) uint8 {
	var id uint8
	for tid, d := range e.detected {
		if fingerprint != "" && d.Fingerprint == fingerprint {
			id = tid
			break
		}
	}
	if id == 0 {
		for tid, d := range e.detected {
			if d.IsHub {
				id = tid
				break
			}
		}
	}
	if id == 0 {
		id = 1
	}
	// Invariant: the collector Hub is never tied to a gate.
	for i := range e.gates {
		if e.gates[i].AssignedTimerID == id {
			e.gates[i].AssignedTimerID = 0
			e.gates[i].TimerLabel = ""
		}
	}
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
	d.FirmwareProfile = profile
	if fingerprint != "" {
		d.Fingerprint = fingerprint
	} else if d.Fingerprint == "" {
		d.Fingerprint = newFingerprintHex()
	}
	if label != "" {
		d.TimerLabel = label
	}
	d.Online = true
	d.LastSeenAt = time.Now()
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
	pilots := append([]domain.PilotSlot(nil), e.pilots...)
	gates := append([]domain.TrackGate(nil), e.gates...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilots, gates)
	}
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

	pilots := append([]domain.PilotSlot(nil), e.pilots...)
	gates := append([]domain.TrackGate(nil), e.gates...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilots, gates)
	}
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
			IsHub:         timerID == 1,
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
	pilots := append([]domain.PilotSlot(nil), e.pilots...)
	gates := append([]domain.TrackGate(nil), e.gates...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilots, gates)
	}
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

	pilots := append([]domain.PilotSlot(nil), e.pilots...)
	gates := append([]domain.TrackGate(nil), e.gates...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilots, gates)
	}
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

// gateLabelLocked is how a gate is named in messages: its display-name override (`Name`),
// or its flashed timer ID/name (`TimerLabel`), or "Gate N" by position on the course when
// neither is set. Mirrors gateLabel() in web/src/state/selectors.ts.
func (e *Engine) gateLabelLocked(gateID uint8) string {
	ordered := e.orderedGatesLocked()
	at := indexOfGate(ordered, gateID)
	if at < 0 {
		return fmt.Sprintf("Gate %d", gateID)
	}
	if name := strings.TrimSpace(ordered[at].Name); name != "" {
		return name
	}
	if label := strings.TrimSpace(ordered[at].TimerLabel); label != "" {
		return label
	}
	return fmt.Sprintf("Gate %d", at+1)
}

// sectionLabelLocked names the stretch of track between two gates, e.g. "Gate 2 → Split-S".
func (e *Engine) sectionLabelLocked(fromGateID, toGateID uint8) string {
	return e.gateLabelLocked(fromGateID) + " → " + e.gateLabelLocked(toGateID)
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

// DeleteDetectedTimer removes a timer from `e.detected` and unassigns it from any gate on the track.
func (e *Engine) DeleteDetectedTimer(timerID uint8) error {
	if timerID == 0 || timerID > maxTimers {
		return ErrInvalidTimerID
	}
	e.mu.Lock()
	delete(e.detected, timerID)
	for i := range e.gates {
		if e.gates[i].AssignedTimerID == timerID {
			e.gates[i].AssignedTimerID = 0
			e.gates[i].TimerLabel = ""
			e.gates[i].FirmwareVersion = ""
			e.gates[i].Color = ""
			e.gates[i].Online = false
			e.gates[i].LastSeenAt = time.Time{}
			e.gates[i].BatteryMv = 0
			e.gates[i].BatteryPct = 0
		}
	}
	e.progress = make(map[int]*pilotProgress)
	pilots := append([]domain.PilotSlot(nil), e.pilots...)
	gates := append([]domain.TrackGate(nil), e.gates...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilots, gates)
	}
	return nil
}

// AddSimulatedTimer creates a new simulated XIAO timer (1..6) in `e.detected` running the given
// firmware profile, and adds a gate on the track for it if fewer than 6 gates exist.
func (e *Engine) AddSimulatedTimer(role string, label string, profile string) (uint8, error) {
	label = strings.TrimSpace(label)
	if utf8.RuneCountInString(label) > domain.MaxGateNameLen {
		return 0, ErrGateNameTooLong
	}
	if strings.TrimSpace(profile) == "" {
		profile = domain.DefaultFirmwareProfile
	}
	fwVersion := domain.LatestFirmwareVersion

	e.mu.Lock()
	var nextID uint8
	for id := uint8(1); id <= maxTimers; id++ {
		if _, exists := e.detected[id]; !exists {
			nextID = id
			break
		}
	}
	if nextID == 0 {
		e.mu.Unlock()
		return 0, ErrInvalidTimerID
	}

	now := time.Now()
	d := &domain.DetectedTimer{
		TimerID:         nextID,
		TimerLabel:      label,
		Color:           domain.DefaultTimerColor(nextID),
		IsHub:           role == "hub" || nextID == 1,
		FirmwareVersion: fwVersion,
		FirmwareProfile: profile,
		Fingerprint:     newFingerprintHex(),
		BatteryMv:       4120,
		BatteryPct:      domain.ComputeBatteryPct(4120),
		NoiseFloorDbm:   -92.0,
		Online:          true,
		LastSeenAt:      now,
	}
	e.detected[nextID] = d

	// If there is an existing gate without a timer assigned, bind this timer to it;
	// otherwise if fewer than maxTimers gates exist, append a new gate for it.
	bound := false
	for i := range e.gates {
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

	pilots := append([]domain.PilotSlot(nil), e.pilots...)
	gates := append([]domain.TrackGate(nil), e.gates...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilots, gates)
	}
	return nextID, nil
}
