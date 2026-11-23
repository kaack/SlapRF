package tracker

import "slaprf/internal/domain"

// SetGateRules replaces one gate's timing-rule overrides for all pilots (Tier 2: unset fields fall
// back to the global rules) and returns what was applied.
func (e *Engine) SetGateRules(gateID uint8, overrides domain.GateRuleOverrides) (domain.GateRuleOverrides, error) {
	overrides = overrides.Normalized()
	e.mu.Lock()
	idx := -1
	for i := range e.gates {
		if e.gates[i].GateID == gateID {
			idx = i
			break
		}
	}
	if idx < 0 {
		e.mu.Unlock()
		return domain.GateRuleOverrides{}, ErrUnknownGate
	}
	e.gates[idx].RuleOverrides = overrides
	domain.PruneTrackGateRuleOverrides(e.gates[idx:idx+1], e.rules)
	overrides = e.gates[idx].RuleOverrides
	if !e.isLiveRaceHeatActiveLocked() && e.practiceState.ActiveSessionID != "" {
		if sess := e.findPracticeSessionLocked(e.practiceState.ActiveSessionID); sess != nil {
			sess.TrackSnapshot = e.snapshotOrderedGatesLocked()
		}
	}
	pilots := append([]domain.PilotSlot(nil), e.pilots...)
	gates := append([]domain.TrackGate(nil), e.gates...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilots, gates)
	}
	return overrides, nil
}

// SetPilotGateRules replaces one pilot's timing-rule overrides at one gate (Tier 3: overrides both
// the gate-wide overrides and global rules; empty overrides clear the pilot-specific tier), using
// copy-on-write on `PilotRuleOverrides`.
func (e *Engine) SetPilotGateRules(gateID uint8, slotIndex int, overrides domain.GateRuleOverrides) (domain.GateRuleOverrides, error) {
	overrides = overrides.Normalized()
	e.mu.Lock()
	idx := -1
	for i := range e.gates {
		if e.gates[i].GateID == gateID {
			idx = i
			break
		}
	}
	if idx < 0 {
		e.mu.Unlock()
		return domain.GateRuleOverrides{}, ErrUnknownGate
	}
	if e.slotPositionLocked(slotIndex) < 0 {
		e.mu.Unlock()
		return domain.GateRuleOverrides{}, ErrUnknownPilot
	}

	prev := e.gates[idx].PilotRuleOverrides
	next := make(map[int]domain.GateRuleOverrides, len(prev)+1)
	for k, v := range prev {
		if k == slotIndex {
			continue
		}
		next[k] = v
	}
	if !overrides.IsEmpty() {
		next[slotIndex] = overrides
	}
	if len(next) == 0 {
		e.gates[idx].PilotRuleOverrides = nil
	} else {
		e.gates[idx].PilotRuleOverrides = next
	}
	domain.PruneTrackGateRuleOverrides(e.gates[idx:idx+1], e.rules)
	overrides = e.gates[idx].PilotRuleOverrides[slotIndex]

	if !e.isLiveRaceHeatActiveLocked() && e.practiceState.ActiveSessionID != "" {
		if sess := e.findPracticeSessionLocked(e.practiceState.ActiveSessionID); sess != nil {
			sess.TrackSnapshot = e.snapshotOrderedGatesLocked()
		}
	}
	pilots := append([]domain.PilotSlot(nil), e.pilots...)
	gates := append([]domain.TrackGate(nil), e.gates...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilots, gates)
	}
	return overrides, nil
}
