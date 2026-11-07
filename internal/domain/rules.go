package domain

import "math"

// TimingRules are the guardrails applied to every RF detection before it becomes a gate
// crossing. Video-RSSI timing sees real-world noise: a quad that crashes beside a gate, a
// pilot who turns back through a gate, a neighbouring gate catching the signal as the quad
// leaves. These rules decide which detections count.
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
}

// DefaultTimingRules suit a typical 5" practice track with 10–40 s laps.
func DefaultTimingRules() TimingRules {
	return TimingRules{
		MinLapSec:       5,
		MaxLapSec:       120,
		GateCooldownSec: 2,
		MinSectionSec:   0.5,
		EchoWindowSec:   3,
	}
}

// Normalized clamps every rule into a sane range.
func (r TimingRules) Normalized() TimingRules {
	r.MinLapSec = clampRule(r.MinLapSec, 1, 120)
	r.MaxLapSec = clampRule(r.MaxLapSec, r.MinLapSec+5, 900)
	r.GateCooldownSec = clampRule(r.GateCooldownSec, 0.2, 15)
	r.MinSectionSec = clampRule(r.MinSectionSec, 0.1, 15)
	r.EchoWindowSec = clampRule(r.EchoWindowSec, 0, 15)
	return r
}

func clampRule(v, lo, hi float64) float64 { return math.Max(lo, math.Min(hi, v)) }

// GateRuleOverrides lets one gate use different values from the global rules — e.g. a gate
// right after a tight turn-around needs a longer echo window, a gate beside the start
// line a longer cool-down. nil fields use the global value. MaxLapSec isn't here: it's
// about the whole lap, not where a gate sits.
type GateRuleOverrides struct {
	MinLapSec       *float64 `json:"minLapSec,omitempty"`
	GateCooldownSec *float64 `json:"gateCooldownSec,omitempty"`
	MinSectionSec   *float64 `json:"minSectionSec,omitempty"`
	EchoWindowSec   *float64 `json:"echoWindowSec,omitempty"`
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
	return GateRuleOverrides{
		MinLapSec:       clampPtr(o.MinLapSec, 1, 120),
		GateCooldownSec: clampPtr(o.GateCooldownSec, 0.2, 15),
		MinSectionSec:   clampPtr(o.MinSectionSec, 0.1, 15),
		EchoWindowSec:   clampPtr(o.EchoWindowSec, 0, 15),
	}
}

// ForGate returns the rules a gate actually applies: the global rules with that gate's
// overrides on top.
func (r TimingRules) ForGate(o GateRuleOverrides) TimingRules {
	if o.MinLapSec != nil {
		r.MinLapSec = *o.MinLapSec
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
	return r
}

// FilterReason explains why a detection didn't become a crossing (or a lap didn't count).
type FilterReason string

const (
	FilterCooldown   FilterReason = "COOLDOWN"     // Same gate, same pilot, inside the cool-down
	FilterTooSoon    FilterReason = "TOO_SOON"     // Faster than physically possible from the last gate
	FilterEcho       FilterReason = "ECHO"         // Previous gate re-detected, or flying backwards
	FilterMinLap     FilterReason = "MIN_LAP"      // Same gate again before the minimum lap time
	FilterLapTooLong FilterReason = "LAP_TOO_LONG" // Crossing accepted, but the lap was too long to count
)

// FilteredDetection is a detection the timing rules set aside, kept for the race director.
type FilteredDetection struct {
	TimestampUs uint64       `json:"timestampUs"`
	PuckID      uint8        `json:"puckId"`
	SlotIndex   int          `json:"slotIndex"`
	Callsign    string       `json:"callsign"`
	Reason      FilterReason `json:"reason"`
	Detail      string       `json:"detail"`
	PeakRSSIDbm float32      `json:"peakRssiDbm"`
}
