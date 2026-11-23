package domain

import (
	"encoding/json"
	"math"
)

// TimingRules are the guardrails applied to every RF detection before it becomes a gate
// crossing. Each timer evaluates crossings independently using minimum lap time, maximum lap
// time, minimum crossing time (RF spike hold/area filter), and optional crossing beep feedback.
type TimingRules struct {
	// MinLapSec: shortest valid time before the same timer can count the same pilot again.
	// Every gate applies this independently; at Start/Finish it is the minimum lap time.
	MinLapSec float64 `json:"minLapSec"`
	// MaxLapSec: a lap longer than this is discarded (crash, landing, battery swap) and a
	// fresh lap starts at that crossing. Also the gap after which stale progress is reset.
	MaxLapSec float64 `json:"maxLapSec"`
	// MinCrossingSec: minimum gate beam hold duration (and proportional dB*s curve area)
	// required for an RF excursion to count as a genuine drone pass rather than a sharp spike.
	MinCrossingSec float64 `json:"minCrossingSec"`
	// BeepOnCross: play an immediate synthetic WebAudio tone when a crossing is accepted
	// (useful for sector-gate debugging and eyes-free confirmation in Practice and Races).
	BeepOnCross bool `json:"beepOnCross"`
}

// UnmarshalJSON decodes TimingRules while migrating legacy `minPassHoldSec` values when present.
func (r *TimingRules) UnmarshalJSON(data []byte) error {
	type rawTimingRules struct {
		MinLapSec      float64  `json:"minLapSec"`
		MaxLapSec      float64  `json:"maxLapSec"`
		MinCrossingSec *float64 `json:"minCrossingSec"`
		LegacyHoldSec  *float64 `json:"minPassHoldSec"`
		BeepOnCross    bool     `json:"beepOnCross"`
	}
	var raw rawTimingRules
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	r.MinLapSec = raw.MinLapSec
	r.MaxLapSec = raw.MaxLapSec
	if raw.MinCrossingSec != nil {
		r.MinCrossingSec = *raw.MinCrossingSec
	} else if raw.LegacyHoldSec != nil {
		r.MinCrossingSec = *raw.LegacyHoldSec
	}
	r.BeepOnCross = raw.BeepOnCross
	return nil
}

// DefaultTimingRules suit a typical FPV practice or race track.
func DefaultTimingRules() TimingRules {
	return TimingRules{
		MinLapSec:      5,
		MaxLapSec:      120,
		MinCrossingSec: 0.12,
	}
}

// Normalized clamps every rule into a sane range (defaulting unset MinCrossingSec to 0.12 s).
func (r TimingRules) Normalized() TimingRules {
	r.MinLapSec = clampRule(r.MinLapSec, 1, 120)
	r.MaxLapSec = clampRule(r.MaxLapSec, r.MinLapSec+5, 900)
	if r.MinCrossingSec <= 0 {
		r.MinCrossingSec = 0.12
	}
	r.MinCrossingSec = clampRule(r.MinCrossingSec, 0.04, 1.5)
	return r
}

func clampRule(v, lo, hi float64) float64 { return math.Max(lo, math.Min(hi, v)) }

// GateRuleOverrides lets one gate (or one pilot at one gate) use different values from the
// parent tier. nil fields inherit from the parent tier.
type GateRuleOverrides struct {
	MinLapSec      *float64 `json:"minLapSec,omitempty"`
	MaxLapSec      *float64 `json:"maxLapSec,omitempty"`
	MinCrossingSec *float64 `json:"minCrossingSec,omitempty"`
	BeepOnCross    *bool    `json:"beepOnCross,omitempty"`
}

// UnmarshalJSON decodes GateRuleOverrides while migrating legacy `minPassHoldSec` overrides.
func (o *GateRuleOverrides) UnmarshalJSON(data []byte) error {
	type rawOverrides struct {
		MinLapSec      *float64 `json:"minLapSec,omitempty"`
		MaxLapSec      *float64 `json:"maxLapSec,omitempty"`
		MinCrossingSec *float64 `json:"minCrossingSec,omitempty"`
		LegacyHoldSec  *float64 `json:"minPassHoldSec,omitempty"`
		BeepOnCross    *bool    `json:"beepOnCross,omitempty"`
	}
	var raw rawOverrides
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	minCross := raw.MinCrossingSec
	if minCross == nil {
		minCross = raw.LegacyHoldSec
	}
	*o = GateRuleOverrides{
		MinLapSec:      raw.MinLapSec,
		MaxLapSec:      raw.MaxLapSec,
		MinCrossingSec: minCross,
		BeepOnCross:    raw.BeepOnCross,
	}
	return nil
}

// IsEmpty reports whether every override field is nil.
func (o GateRuleOverrides) IsEmpty() bool {
	return o.MinLapSec == nil &&
		o.MaxLapSec == nil &&
		o.MinCrossingSec == nil &&
		o.BeepOnCross == nil
}

// Normalized clamps each set override into the same range as the global rule.
func (o GateRuleOverrides) Normalized() GateRuleOverrides {
	clampPtr := func(p *float64, lo, hi float64) *float64 {
		if p == nil {
			return nil
		}
		v := clampRule(*p, lo, hi)
		return &v
	}
	var beepPtr *bool
	if o.BeepOnCross != nil {
		b := *o.BeepOnCross
		beepPtr = &b
	}
	out := GateRuleOverrides{
		MinLapSec:      clampPtr(o.MinLapSec, 1, 120),
		MaxLapSec:      clampPtr(o.MaxLapSec, 6, 900),
		MinCrossingSec: clampPtr(o.MinCrossingSec, 0.04, 1.5),
		BeepOnCross:    beepPtr,
	}
	if out.MinLapSec != nil && out.MaxLapSec != nil && *out.MaxLapSec < *out.MinLapSec+5 {
		v := clampRule(*out.MinLapSec+5, 6, 900)
		out.MaxLapSec = &v
	}
	return out
}

// ForGate returns the rules a gate actually applies: the global rules with that gate's
// overrides on top.
func (r TimingRules) ForGate(o GateRuleOverrides) TimingRules {
	if r.MinCrossingSec <= 0 {
		r.MinCrossingSec = 0.12
	}
	if o.MinLapSec != nil {
		r.MinLapSec = *o.MinLapSec
	}
	if o.MaxLapSec != nil {
		r.MaxLapSec = *o.MaxLapSec
	}
	if r.MaxLapSec < r.MinLapSec+5 {
		r.MaxLapSec = clampRule(r.MinLapSec+5, 6, 900)
	}
	if o.MinCrossingSec != nil {
		r.MinCrossingSec = *o.MinCrossingSec
	}
	if o.BeepOnCross != nil {
		r.BeepOnCross = *o.BeepOnCross
	}
	return r
}

// ForPilotGate resolves the 3-tier timing rules hierarchy:
// Global TimingRules -> Gate overrides (all pilots at this gate) -> Pilot-at-Gate overrides.
func (r TimingRules) ForPilotGate(gateOverrides GateRuleOverrides, pilotOverrides *GateRuleOverrides) TimingRules {
	eff := r.ForGate(gateOverrides)
	if pilotOverrides != nil {
		eff = eff.ForGate(*pilotOverrides)
	}
	return eff
}

// PrunedAgainst clears any override field whose value already agrees with `parent`, so a child
// tier is only marked overridden when its effective setting diverges from its parent tier.
func (o GateRuleOverrides) PrunedAgainst(parent TimingRules) GateRuleOverrides {
	parent = parent.Normalized()
	out := o.Normalized()
	if out.MinLapSec != nil && math.Abs(*out.MinLapSec-parent.MinLapSec) < 1e-6 {
		out.MinLapSec = nil
	}
	effMinLap := parent.MinLapSec
	if out.MinLapSec != nil {
		effMinLap = *out.MinLapSec
	}
	effParentMax := math.Max(parent.MaxLapSec, effMinLap+5)
	if out.MaxLapSec != nil && math.Abs(*out.MaxLapSec-effParentMax) < 1e-6 {
		out.MaxLapSec = nil
	}
	if out.MinCrossingSec != nil && math.Abs(*out.MinCrossingSec-parent.MinCrossingSec) < 1e-6 {
		out.MinCrossingSec = nil
	}
	if out.BeepOnCross != nil && *out.BeepOnCross == parent.BeepOnCross {
		out.BeepOnCross = nil
	}
	return out
}

// PruneTrackGateRuleOverrides collapses any gate-level or per-pilot override fields across `gates`
// that match their parent tier under `globalRules`.
func PruneTrackGateRuleOverrides(gates []TrackGate, globalRules TimingRules) {
	base := globalRules.Normalized()
	for i := range gates {
		gates[i].RuleOverrides = gates[i].RuleOverrides.PrunedAgainst(base)
		if len(gates[i].PilotRuleOverrides) == 0 {
			continue
		}
		gateEff := base.ForGate(gates[i].RuleOverrides)
		next := make(map[int]GateRuleOverrides, len(gates[i].PilotRuleOverrides))
		for slot, po := range gates[i].PilotRuleOverrides {
			pruned := po.PrunedAgainst(gateEff)
			if !pruned.IsEmpty() {
				next[slot] = pruned
			}
		}
		if len(next) == 0 {
			gates[i].PilotRuleOverrides = nil
		} else {
			gates[i].PilotRuleOverrides = next
		}
	}
}

// FilterReason explains why a detection did not become a crossing (or a lap did not count).
type FilterReason string

const (
	FilterSpike      FilterReason = "SPIKE"        // Short RF / Wi-Fi spike lacking minimum crossing time or curve area
	FilterMinLap     FilterReason = "MIN_LAP"      // Same gate again before the minimum lap time
	FilterLapTooLong FilterReason = "LAP_TOO_LONG" // Crossing accepted, but the lap exceeded maximum lap time
)

// IsValid reports whether `r` is one of the supported FilterReason values.
func (r FilterReason) IsValid() bool {
	return r == FilterSpike || r == FilterMinLap || r == FilterLapTooLong
}

// FilteredDetection is a detection the timing rules set aside, kept for inspection on the chart.
type FilteredDetection struct {
	TimestampUs uint64       `json:"timestampUs"`
	GateID      uint8        `json:"gateId"`
	SlotIndex   int          `json:"slotIndex"`
	Callsign    string       `json:"callsign"`
	Reason      FilterReason `json:"reason"`
	Detail      string       `json:"detail"`
	PeakRSSIDbm float32      `json:"peakRssiDbm"`
}
