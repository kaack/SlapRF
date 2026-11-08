package tracker

import "slaprf/internal/domain"

// SetGateRules replaces one gate's timing-rule overrides (values are clamped; unset fields
// fall back to the global rules) and returns what was applied.
func (e *Engine) SetGateRules(puckID uint8, overrides domain.GateRuleOverrides) (domain.GateRuleOverrides, error) {
	overrides = overrides.Normalized()
	e.mu.Lock()
	idx := -1
	for i := range e.pucks {
		if e.pucks[i].PuckID == puckID {
			idx = i
			break
		}
	}
	if idx < 0 {
		e.mu.Unlock()
		return domain.GateRuleOverrides{}, ErrUnknownGate
	}
	e.pucks[idx].RuleOverrides = overrides
	pilots := append([]domain.PilotSlot(nil), e.pilots...)
	pucks := append([]domain.GatePuck(nil), e.pucks...)
	subs := append([]EventSubscriber(nil), e.subscribers...)
	e.mu.Unlock()

	for _, s := range subs {
		s.OnConfigUpdated(pilots, pucks)
	}
	return overrides, nil
}
