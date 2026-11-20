package domain

import "math"

// TimingRules are the guardrails applied to every RF detection before it becomes a gate
// crossing. Video-RSSI timing sees real-world noise: a quad that crashes beside a gate, a
// pilot who turns back through a gate, a neighbouring gate catching the signal as the quad
// leaves, or short 5 GHz Wi-Fi / RF spikes on unused channels. These rules decide which detections count.
type TimingRules struct {
	// MinLapSec: nobody laps faster than this, so a gate never times the same pilot twice
	// within it. Every gate applies it as if it were the start gate; at the start / finish
	// gate it's the minimum lap time (re-detection, hovering at the line, a crash beside it).
	MinLapSec float64 `json:"minLapSec"`
	// MaxLapSec: a lap longer than this is not counted (crash, landing, battery swap) and a
	// fresh lap starts at that crossing. Also the gap after which progress is forgotten.
	MaxLapSec float64 `json:"maxLapSec"`
	// GateCooldownSec: once a gate accepts a pilot, it ignores that pilot for this long
	// (signal bouncing while the quad lingers or wobbles through the gate).
	GateCooldownSec float64 `json:"gateCooldownSec"`
	// MinSectionSec: the fastest possible time between two different gates; anything
	// quicker is a stray detection from a gate the quad isn't actually passing.
	MinSectionSec float64 `json:"minSectionSec"`
	// EchoWindowSec: a detection at the gate the pilot just came from, within this window,
	// is treated as an echo (or the pilot flying backwards) and ignored. 0 disables.
	EchoWindowSec float64 `json:"echoWindowSec"`
	// MinPassHoldSec: minimum gate pass hold duration (and proportional dB*s curve area)
	// required for an RF excursion to count as a real drone fly-by rather than a sharp noise spike.
	MinPassHoldSec float64 `json:"minPassHoldSec"`
	// BeepOnCross: play an immediate synthetic WebAudio tone when a crossing is accepted
	// (useful for sector-gate debugging and eyes-free confirmation in Practice and Races).
	BeepOnCross bool `json:"beepOnCross"`
}

// DefaultTimingRules suit a typical FPV practice or race track.
func DefaultTimingRules() TimingRules {
	return TimingRules{
		MinLapSec:       5,
		MaxLapSec:       120,
		GateCooldownSec: 2,
		MinSectionSec:   0.5,
		EchoWindowSec:   3,
		MinPassHoldSec:  0.12,
	}
}

// Normalized clamps every rule into a sane range (defaulting unset MinPassHoldSec to 0.12 s).
func (r TimingRules) Normalized() TimingRules {
	r.MinLapSec = clampRule(r.MinLapSec, 1, 120)
	r.MaxLapSec = clampRule(r.MaxLapSec, r.MinLapSec+5, 900)
	r.GateCooldownSec = clampRule(r.GateCooldownSec, 0.2, 15)
	r.MinSectionSec = clampRule(r.MinSectionSec, 0.1, 15)
	r.EchoWindowSec = clampRule(r.EchoWindowSec, 0, 15)
	if r.MinPassHoldSec <= 0 {
		r.MinPassHoldSec = 0.12
	}
	r.MinPassHoldSec = clampRule(r.MinPassHoldSec, 0.04, 1.5)
	return r
}

func clampRule(v, lo, hi float64) float64 { return math.Max(lo, math.Min(hi, v)) }

// GateRuleOverrides lets one gate (or one pilot at one gate) use different values from the
// global rules, such as a gate right after a tight turn-around needing a longer echo window or a
// slower pilot needing a longer minimum/maximum lap time. nil fields inherit from the parent tier.
type GateRuleOverrides struct {
	MinLapSec       *float64 `json:"minLapSec,omitempty"`
	MaxLapSec       *float64 `json:"maxLapSec,omitempty"`
	GateCooldownSec *float64 `json:"gateCooldownSec,omitempty"`
	MinSectionSec   *float64 `json:"minSectionSec,omitempty"`
	EchoWindowSec   *float64 `json:"echoWindowSec,omitempty"`
	MinPassHoldSec  *float64 `json:"minPassHoldSec,omitempty"`
	BeepOnCross     *bool    `json:"beepOnCross,omitempty"`
}

// IsEmpty reports whether every override field is nil.
func (o GateRuleOverrides) IsEmpty() bool {
	return o.MinLapSec == nil &&
		o.MaxLapSec == nil &&
		o.GateCooldownSec == nil &&
		o.MinSectionSec == nil &&
		o.EchoWindowSec == nil &&
		o.MinPassHoldSec == nil &&
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
		MinLapSec:       clampPtr(o.MinLapSec, 1, 120),
		MaxLapSec:       clampPtr(o.MaxLapSec, 6, 900),
		GateCooldownSec: clampPtr(o.GateCooldownSec, 0.2, 15),
		MinSectionSec:   clampPtr(o.MinSectionSec, 0.1, 15),
		EchoWindowSec:   clampPtr(o.EchoWindowSec, 0, 15),
		MinPassHoldSec:  clampPtr(o.MinPassHoldSec, 0.04, 1.5),
		BeepOnCross:     beepPtr,
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
	if r.MinPassHoldSec <= 0 {
		r.MinPassHoldSec = 0.12
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
	if o.GateCooldownSec != nil {
		r.GateCooldownSec = *o.GateCooldownSec
	}
	if o.MinSectionSec != nil {
		r.MinSectionSec = *o.MinSectionSec
	}
	if o.EchoWindowSec != nil {
		r.EchoWindowSec = *o.EchoWindowSec
	}
	if o.MinPassHoldSec != nil {
		r.MinPassHoldSec = *o.MinPassHoldSec
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

// FilterReason explains why a detection didn't become a crossing (or a lap didn't count).
type FilterReason string

const (
	FilterSpike      FilterReason = "SPIKE"        // Short RF / Wi-Fi spike lacking pass hold time or curve area
	FilterCooldown   FilterReason = "COOLDOWN"     // Same gate, same pilot, inside the cool-down
	FilterTooSoon    FilterReason = "TOO_SOON"     // Faster than physically possible from the last gate
	FilterEcho       FilterReason = "ECHO"         // Previous gate re-detected, or flying backwards
	FilterMinLap     FilterReason = "MIN_LAP"      // Same gate again before the minimum lap time
	FilterLapTooLong FilterReason = "LAP_TOO_LONG" // Crossing accepted, but the lap was too long to count
)

// FilteredDetection is a detection the timing rules set aside, kept for the race director.
type FilteredDetection struct {
	TimestampUs uint64       `json:"timestampUs"`
	GateID      uint8        `json:"gateId"`
	SlotIndex   int          `json:"slotIndex"`
	Callsign    string       `json:"callsign"`
	Reason      FilterReason `json:"reason"`
	Detail      string       `json:"detail"`
	PeakRSSIDbm float32      `json:"peakRssiDbm"`
}
