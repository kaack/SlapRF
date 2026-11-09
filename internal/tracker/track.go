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
	ErrInvalidPuckID   = errors.New("timer ID must be between 1 and 6")
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
//   - Otherwise a puck with the same label is updated (a replacement board takes over its gate).
//   - Otherwise a "hub" claims the start/finish gate and a "spoke" the next unlabelled sector
//     gate, creating a new gate (up to the timer limit) if every gate is already labelled.
func (e *Engine) ProvisionGate(req ProvisionRequest) (uint8, error) {
	role := req.Role
	puckLabel := strings.TrimSpace(req.Label)
	if utf8.RuneCountInString(puckLabel) > domain.MaxGateNameLen {
		return 0, ErrGateNameTooLong
	}
	profile := strings.TrimSpace(req.Profile)
	if profile == "" {
		profile = domain.DefaultFirmwareProfile
	}
	fingerprint := strings.ToUpper(strings.TrimSpace(req.Fingerprint))
	ver := domain.LatestFirmwareVersion

	e.mu.Lock()
	var targetIdx = -1

	// 0. Same physical board re-flashed (fingerprint kept): update it in place.
	if fingerprint != "" {
		for id, d := range e.detected {
			if d.Fingerprint == fingerprint {
				if puckLabel != "" {
					d.PuckLabel = puckLabel
				}
				d.FirmwareVersion = ver
				d.FirmwareProfile = profile
				d.IsHub = role == "hub"
				d.Online = true
				d.LastSeenAt = time.Now()
				for i := range e.pucks {
					if e.pucks[i].AssignedPuckID == id {
						if puckLabel != "" {
							e.pucks[i].PuckLabel = puckLabel
						}
						e.pucks[i].FirmwareVersion = ver
					}
				}
				pilots := append([]domain.PilotSlot(nil), e.pilots...)
				pucks := append([]domain.GatePuck(nil), e.pucks...)
				subs := append([]EventSubscriber(nil), e.subscribers...)
				e.mu.Unlock()
				for _, s := range subs {
					s.OnConfigUpdated(pilots, pucks)
				}
				return id, nil
			}
		}
	}

	// 1. If a puck already has this exact PuckLabel, update that one.
	if puckLabel != "" {
		for i := range e.pucks {
			if strings.EqualFold(strings.TrimSpace(e.pucks[i].PuckLabel), puckLabel) {
				targetIdx = i
				break
			}
		}
	}

	// 2. Otherwise pick by role (hub -> start/finish gate; spoke -> next unlabelled sector gate).
	if targetIdx < 0 {
		if role == "hub" {
			for i := range e.pucks {
				if e.pucks[i].Role == domain.PuckRoleStartFinish || e.pucks[i].TrackOrder == 0 {
					aid := e.pucks[i].AssignedPuckID
					if aid == 0 || (e.detected[aid] != nil && e.detected[aid].IsHub) {
						targetIdx = i
						break
					}
				}
			}
			if targetIdx < 0 && len(e.pucks) > 0 && e.pucks[0].AssignedPuckID == 0 {
				targetIdx = 0
			}
		} else {
			ordered := e.orderedPucksLocked()
			for _, op := range ordered {
				if op.Role == domain.PuckRoleSectorGate && strings.TrimSpace(op.PuckLabel) == "" {
					targetIdx = indexOfPuck(e.pucks, op.PuckID)
					break
				}
			}
		}
	}

	// 3. If all existing sector gates already have a flashed PuckLabel, add a new gate puck (up to 16).
	if targetIdx < 0 {
		var maxID uint8
		for _, p := range e.pucks {
			if p.PuckID > maxID {
				maxID = p.PuckID
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
		if nextID > maxTimers {
			e.mu.Unlock()
			return 0, ErrInvalidPuckID
		}
		e.pucks = append(e.pucks, domain.GatePuck{
			PuckID:         nextID,
			AssignedPuckID: nextID,
			PuckLabel:      puckLabel,
			Color:          domain.DefaultGateColors[len(e.pucks)%len(domain.DefaultGateColors)],
			Role:           domain.PuckRoleSectorGate,
			TrackOrder:     len(e.pucks),
			BatteryMv:      4100,
			BatteryPct:     domain.ComputeBatteryPct(4100),
			NoiseFloorDbm:  -92,
			Online:         true,
			LastSeenAt:     time.Now(),
		})
		e.ensureStartGateLocked()
		e.initDetectorsLocked()
		targetIdx = len(e.pucks) - 1
	} else {
		if e.pucks[targetIdx].AssignedPuckID == 0 {
			e.pucks[targetIdx].AssignedPuckID = e.pucks[targetIdx].PuckID
		}
		if puckLabel != "" {
			e.pucks[targetIdx].PuckLabel = puckLabel
		}
	}

	assignedID := e.pucks[targetIdx].AssignedPuckID
	if assignedID == 0 {
		assignedID = e.pucks[targetIdx].PuckID
	}
	now := time.Now()
	d, ok := e.detected[assignedID]
	if !ok {
		d = &domain.DetectedPuck{
			PuckID:        assignedID,
			Color:         domain.DefaultPuckColor(assignedID),
			IsHub:         role == "hub" || assignedID == 1,
			BatteryMv:     4100,
			BatteryPct:    domain.ComputeBatteryPct(4100),
			NoiseFloorDbm: -92.0,
		}
		e.detected[assignedID] = d
	} else if d.Color == "" {
		d.Color = domain.DefaultPuckColor(assignedID)
	}
	e.pucks[targetIdx].Color = d.Color
	e.pucks[targetIdx].FirmwareVersion = ver
	d.FirmwareVersion = ver
	d.FirmwareProfile = profile
	if fingerprint != "" {
		d.Fingerprint = fingerprint
	} else if d.Fingerprint == "" {
		d.Fingerprint = newFingerprintHex()
	}
	if puckLabel != "" {
		d.PuckLabel = puckLabel
	}
	if role == "hub" {
		d.IsHub = true
	}
	d.Online = true
	d.LastSeenAt = now

	pilots := append([]domain.PilotSlot(nil), e.pilots...)
	pucks := append([]domain.GatePuck(nil), e.pucks...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilots, pucks)
	}
	return assignedID, nil
}

// AddGate appends or inserts a new logical gate onto the course.
func (e *Engine) AddGate(name string, assignedPuckID uint8, trackOrder ...int) (domain.GatePuck, error) {
	name = strings.TrimSpace(name)
	if utf8.RuneCountInString(name) > domain.MaxGateNameLen {
		return domain.GatePuck{}, ErrGateNameTooLong
	}
	if assignedPuckID > maxTimers {
		return domain.GatePuck{}, ErrInvalidPuckID
	}

	e.mu.Lock()
	var maxID uint8
	for _, p := range e.pucks {
		if p.PuckID > maxID {
			maxID = p.PuckID
		}
	}
	nextID := maxID + 1
	if nextID < 1 {
		nextID = 1
	}
	if nextID > maxTimers {
		// Find first unused gate ID in 1..6
		used := make(map[uint8]bool, len(e.pucks))
		for _, p := range e.pucks {
			used[p.PuckID] = true
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
			return domain.GatePuck{}, ErrInvalidPuckID
		}
	}

	if assignedPuckID > 0 {
		for i := range e.pucks {
			if e.pucks[i].AssignedPuckID == assignedPuckID {
				e.pucks[i].AssignedPuckID = 0
				e.pucks[i].PuckLabel = ""
				e.pucks[i].Color = ""
				e.pucks[i].Online = false
				e.pucks[i].BatteryMv = 0
				e.pucks[i].BatteryPct = 0
			}
		}
	}

	newGate := domain.GatePuck{
		PuckID:         nextID,
		AssignedPuckID: assignedPuckID,
		Name:           name,
		Role:           domain.PuckRoleSectorGate,
		TrackOrder:     len(e.pucks),
		MapX:           0.5,
		MapY:           0.5,
		NoiseFloorDbm:  -92.0,
	}
	if assignedPuckID > 0 {
		if d, ok := e.detected[assignedPuckID]; ok {
			newGate.PuckLabel = d.PuckLabel
			newGate.Color = d.Color
			newGate.BatteryMv = d.BatteryMv
			newGate.BatteryPct = d.BatteryPct
			newGate.NoiseFloorDbm = d.NoiseFloorDbm
			newGate.LastSeenAt = d.LastSeenAt
			newGate.Online = !d.LastSeenAt.IsZero() && time.Since(d.LastSeenAt) < puckOfflineAfter
		}
		if newGate.Color == "" {
			newGate.Color = domain.DefaultPuckColor(assignedPuckID)
		}
	}

	e.pucks = append(e.pucks, newGate)
	if len(trackOrder) > 0 {
		e.moveGateLocked(nextID, trackOrder[0])
	}
	e.ensureStartGateLocked()
	e.initDetectorsLocked()
	e.progress = make(map[int]*pilotProgress)

	createdIdx := indexOfPuck(e.pucks, nextID)
	created := e.pucks[createdIdx]
	pilots := append([]domain.PilotSlot(nil), e.pilots...)
	pucks := append([]domain.GatePuck(nil), e.pucks...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilots, pucks)
	}
	return created, nil
}

// RemoveGate deletes a gate from the course (any physical puck tied to it remains in
// `e.detected` and becomes unassigned).
func (e *Engine) RemoveGate(puckID uint8) error {
	e.mu.Lock()
	idx := indexOfPuck(e.pucks, puckID)
	if idx < 0 {
		e.mu.Unlock()
		return ErrUnknownGate
	}
	e.pucks = append(e.pucks[:idx], e.pucks[idx+1:]...)
	ordered := e.orderedPucksLocked()
	e.applyOrderLocked(ordered)
	e.ensureStartGateLocked()
	e.progress = make(map[int]*pilotProgress)

	pilots := append([]domain.PilotSlot(nil), e.pilots...)
	pucks := append([]domain.GatePuck(nil), e.pucks...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilots, pucks)
	}
	return nil
}

// SetPuckColor updates the physical color of a discovered XIAO ESP32-C5 puck and propagates
// it to any gate currently tied to that puck.
func (e *Engine) SetPuckColor(puckID uint8, color string) error {
	color = strings.TrimSpace(color)
	if puckID == 0 || puckID > maxTimers || color == "" {
		return ErrInvalidPuckID
	}

	e.mu.Lock()
	d, ok := e.detected[puckID]
	if !ok {
		d = &domain.DetectedPuck{
			PuckID:        puckID,
			Color:         color,
			IsHub:         puckID == 1,
			BatteryMv:     4080,
			BatteryPct:    domain.ComputeBatteryPct(4080),
			NoiseFloorDbm: -92.0,
		}
		e.detected[puckID] = d
	} else {
		d.Color = color
	}
	for i := range e.pucks {
		if e.pucks[i].AssignedPuckID == puckID {
			e.pucks[i].Color = color
		}
	}
	pilots := append([]domain.PilotSlot(nil), e.pilots...)
	pucks := append([]domain.GatePuck(nil), e.pucks...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilots, pucks)
	}
	return nil
}

// UpdateGate renames a gate, moves it around the track, or assigns/unassigns a physical puck.
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
	if u.Role != domain.PuckRoleStartFinish && u.Role != domain.PuckRoleSectorGate {
		return ErrInvalidGateRole
	}
	if u.AssignedPuckID != nil && *u.AssignedPuckID > maxTimers {
		return ErrInvalidPuckID
	}

	e.mu.Lock()
	idx := -1
	for i := range e.pucks {
		if e.pucks[i].PuckID == u.PuckID {
			idx = i
			break
		}
	}
	if idx < 0 {
		e.mu.Unlock()
		return ErrUnknownGate
	}
	e.pucks[idx].Name = name
	if c := strings.TrimSpace(u.Color); c != "" {
		e.pucks[idx].Color = c
		if pid := e.pucks[idx].AssignedPuckID; pid > 0 {
			if d, ok := e.detected[pid]; ok {
				d.Color = c
			}
		}
	}

	if u.AssignedPuckID != nil {
		wantPuck := *u.AssignedPuckID
		e.pucks[idx].AssignedPuckID = wantPuck
		if wantPuck == 0 {
			e.pucks[idx].PuckLabel = ""
			e.pucks[idx].Color = ""
			e.pucks[idx].Online = false
			e.pucks[idx].BatteryMv = 0
			e.pucks[idx].BatteryPct = 0
		} else {
			// Unassign any other gate that was tied to this physical puck.
			for j := range e.pucks {
				if j != idx && e.pucks[j].AssignedPuckID == wantPuck {
					e.pucks[j].AssignedPuckID = 0
					e.pucks[j].PuckLabel = ""
					e.pucks[j].Color = ""
					e.pucks[j].Online = false
					e.pucks[j].BatteryMv = 0
					e.pucks[j].BatteryPct = 0
				}
			}
			if d, ok := e.detected[wantPuck]; ok {
				e.pucks[idx].PuckLabel = d.PuckLabel
				if d.Color != "" {
					e.pucks[idx].Color = d.Color
				} else {
					e.pucks[idx].Color = domain.DefaultPuckColor(wantPuck)
				}
				e.pucks[idx].BatteryMv = d.BatteryMv
				e.pucks[idx].BatteryPct = d.BatteryPct
				e.pucks[idx].NoiseFloorDbm = d.NoiseFloorDbm
				e.pucks[idx].LastSeenAt = d.LastSeenAt
				e.pucks[idx].Online = !d.LastSeenAt.IsZero() && time.Since(d.LastSeenAt) < puckOfflineAfter
			} else {
				e.pucks[idx].Color = domain.DefaultPuckColor(wantPuck)
			}
		}
	}

	var layoutChanged bool
	if u.Role == domain.PuckRoleStartFinish && e.pucks[idx].Role != domain.PuckRoleStartFinish {
		for j := range e.pucks {
			if j == idx {
				e.pucks[j].Role = domain.PuckRoleStartFinish
			} else {
				e.pucks[j].Role = domain.PuckRoleSectorGate
			}
		}
		layoutChanged = true
	}
	if u.TrackOrder != nil {
		if e.moveGateLocked(u.PuckID, *u.TrackOrder) {
			layoutChanged = true
		}
	}
	e.ensureStartGateLocked()
	if layoutChanged {
		// In-progress laps were measured against the old layout.
		e.progress = make(map[int]*pilotProgress)
	}

	pilots := append([]domain.PilotSlot(nil), e.pilots...)
	pucks := append([]domain.GatePuck(nil), e.pucks...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilots, pucks)
	}
	return nil
}

// moveGateLocked places a gate at `position` in track order. Reports whether the order changed.
func (e *Engine) moveGateLocked(puckID uint8, position int) bool {
	ordered := e.orderedPucksLocked()
	from := indexOfPuck(ordered, puckID)
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
	ordered = append(ordered[:position], append([]domain.GatePuck{moved}, ordered[position:]...)...)
	return e.applyOrderLocked(ordered)
}

// rotateToFrontLocked rotates the loop so `puckID` is first, keeping the cyclic order.
func (e *Engine) rotateToFrontLocked(puckID uint8) bool {
	ordered := e.orderedPucksLocked()
	at := indexOfPuck(ordered, puckID)
	if at <= 0 {
		return false
	}
	rotated := append(append([]domain.GatePuck(nil), ordered[at:]...), ordered[:at]...)
	return e.applyOrderLocked(rotated)
}

// applyOrderLocked renumbers every gate 0..n-1 following `ordered`. Reports whether it changed.
func (e *Engine) applyOrderLocked(ordered []domain.GatePuck) bool {
	newOrder := make(map[uint8]int, len(ordered))
	for i, p := range ordered {
		newOrder[p.PuckID] = i
	}
	changed := false
	for i := range e.pucks {
		if e.pucks[i].TrackOrder != newOrder[e.pucks[i].PuckID] {
			changed = true
		}
		e.pucks[i].TrackOrder = newOrder[e.pucks[i].PuckID]
	}
	sort.SliceStable(e.pucks, func(i, j int) bool { return e.pucks[i].TrackOrder < e.pucks[j].TrackOrder })
	return changed
}

// ensureStartGateLocked ensures exactly one gate has Role == START_FINISH without tying it to TrackOrder == 0.
func (e *Engine) ensureStartGateLocked() {
	if len(e.pucks) == 0 {
		return
	}
	found := false
	for i := range e.pucks {
		if e.pucks[i].Role == domain.PuckRoleStartFinish {
			if !found {
				found = true
			} else {
				e.pucks[i].Role = domain.PuckRoleSectorGate
			}
		} else {
			e.pucks[i].Role = domain.PuckRoleSectorGate
		}
	}
	if !found {
		e.pucks[0].Role = domain.PuckRoleStartFinish
	}
}

func indexOfPuck(pucks []domain.GatePuck, id uint8) int {
	for i, p := range pucks {
		if p.PuckID == id {
			return i
		}
	}
	return -1
}

// gateLabelLocked is how a gate is named in messages: its display-name override (`Name`),
// or its flashed puck ID/name (`PuckLabel`), or "Gate N" by position on the course when
// neither is set. Mirrors gateLabel() in web/src/state/selectors.ts.
func (e *Engine) gateLabelLocked(puckID uint8) string {
	ordered := e.orderedPucksLocked()
	at := indexOfPuck(ordered, puckID)
	if at < 0 {
		return fmt.Sprintf("puck %d", puckID)
	}
	if name := strings.TrimSpace(ordered[at].Name); name != "" {
		return name
	}
	if label := strings.TrimSpace(ordered[at].PuckLabel); label != "" {
		return label
	}
	return fmt.Sprintf("Gate %d", at+1)
}

// sectionLabelLocked names the stretch of track between two gates, e.g. "Gate 2 → Split-S".
func (e *Engine) sectionLabelLocked(fromPuckID, toPuckID uint8) string {
	return e.gateLabelLocked(fromPuckID) + " → " + e.gateLabelLocked(toPuckID)
}

// ClearPilotProgress resets in-progress lap/sector tracking for a single pilot (e.g. when a
// simulated pilot lands in the pits for a battery swap or is recovered after a crash) so their
// next pass through the Start/Finish gate cleanly starts a fresh lap.
func (e *Engine) ClearPilotProgress(slotIndex int) {
	e.mu.Lock()
	delete(e.progress, slotIndex)
	e.mu.Unlock()
}

// HasDetectedPuck reports whether a physical/provisioned timer with `puckID` exists in `e.detected`.
func (e *Engine) HasDetectedPuck(puckID uint8) bool {
	e.mu.RLock()
	defer e.mu.RUnlock()
	_, ok := e.detected[puckID]
	return ok
}

// SetDetectedPuckOnline immediately marks a physical/simulated timer online or offline.
func (e *Engine) SetDetectedPuckOnline(puckID uint8, online bool) {
	e.mu.Lock()
	now := time.Now()
	if d, ok := e.detected[puckID]; ok {
		d.Online = online
		if online {
			d.LastSeenAt = now
		} else {
			d.LastSeenAt = time.Time{}
		}
	}
	for i := range e.pucks {
		if e.pucks[i].AssignedPuckID == puckID {
			e.pucks[i].Online = online
			if online {
				e.pucks[i].LastSeenAt = now
			} else {
				e.pucks[i].LastSeenAt = time.Time{}
			}
		}
	}
	pilots := append([]domain.PilotSlot(nil), e.pilots...)
	pucks := append([]domain.GatePuck(nil), e.pucks...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilots, pucks)
	}
}

// DeleteDetectedPuck removes a timer from `e.detected` and unassigns it from any gate on the track.
func (e *Engine) DeleteDetectedPuck(puckID uint8) error {
	if puckID == 0 || puckID > maxTimers {
		return ErrInvalidPuckID
	}
	e.mu.Lock()
	delete(e.detected, puckID)
	for i := range e.pucks {
		if e.pucks[i].AssignedPuckID == puckID {
			e.pucks[i].AssignedPuckID = 0
			e.pucks[i].PuckLabel = ""
			e.pucks[i].FirmwareVersion = ""
			e.pucks[i].Color = ""
			e.pucks[i].Online = false
			e.pucks[i].LastSeenAt = time.Time{}
			e.pucks[i].BatteryMv = 0
			e.pucks[i].BatteryPct = 0
		}
	}
	e.progress = make(map[int]*pilotProgress)
	pilots := append([]domain.PilotSlot(nil), e.pilots...)
	pucks := append([]domain.GatePuck(nil), e.pucks...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilots, pucks)
	}
	return nil
}

// AddSimulatedPuck creates a new simulated XIAO timer (1..6) in `e.detected` running the given
// firmware profile, and adds a gate on the track for it if fewer than 6 gates exist.
func (e *Engine) AddSimulatedPuck(role string, label string, profile string) (uint8, error) {
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
		return 0, ErrInvalidPuckID
	}

	now := time.Now()
	d := &domain.DetectedPuck{
		PuckID:          nextID,
		PuckLabel:       label,
		Color:           domain.DefaultPuckColor(nextID),
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
	for i := range e.pucks {
		if e.pucks[i].AssignedPuckID == 0 {
			e.pucks[i].AssignedPuckID = nextID
			e.pucks[i].PuckLabel = label
			e.pucks[i].FirmwareVersion = fwVersion
			e.pucks[i].Color = d.Color
			e.pucks[i].BatteryMv = d.BatteryMv
			e.pucks[i].BatteryPct = d.BatteryPct
			e.pucks[i].NoiseFloorDbm = d.NoiseFloorDbm
			e.pucks[i].Online = true
			e.pucks[i].LastSeenAt = now
			bound = true
			break
		}
	}
	if !bound && len(e.pucks) < maxTimers {
		var gateID uint8
		usedGate := make(map[uint8]bool, len(e.pucks))
		for _, p := range e.pucks {
			usedGate[p.PuckID] = true
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
			e.pucks = append(e.pucks, domain.GatePuck{
				PuckID:          gateID,
				AssignedPuckID:  nextID,
				PuckLabel:       label,
				FirmwareVersion: fwVersion,
				Color:           d.Color,
				Role:            domain.PuckRoleSectorGate,
				TrackOrder:      len(e.pucks),
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
	pucks := append([]domain.GatePuck(nil), e.pucks...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilots, pucks)
	}
	return nextID, nil
}
