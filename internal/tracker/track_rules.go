package tracker

import "slaprf/internal/domain"

// SetGateRules replaces one gate's timing-rule overrides (values are clamped; unset fields
// fall back to the global rules) and returns what was applied.
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
	pilots := append([]domain.PilotSlot(nil), e.pilots...)
	gates := append([]domain.TrackGate(nil), e.gates...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilots, gates)
	}
	return overrides, nil
}
