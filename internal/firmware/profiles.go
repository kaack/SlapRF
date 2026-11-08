package firmware

import "strings"

// Link rates for the Spoke → Hub 2.4 GHz ESP-NOW backhaul.
const (
	LinkRate1M     uint8 = 0 // Standard 802.11b 1 Mbps ESP-NOW (short airtime, short range)
	LinkRateLR500K uint8 = 1 // Espressif Long Range 500 kbps (+~8 dB link budget, ~2.1 ms frames)
)

// RSSI filters applied on the timer before samples are queued.
const (
	RSSIFilterNone    uint8 = 0
	RSSIFilterMedian3 uint8 = 1 // Median of the last 3 sweeps per channel — rejects single-sweep multipath nulls
)

// Profile is one firmware design, compiled from the same source tree but tuned for a
// track type and for where the timers sit on the gates. Every profile is rebuilt on each
// release, so the flasher only ever offers the current build of each design.
type Profile struct {
	ID      string `json:"id"`
	Code    uint8  `json:"code"`
	Name    string `json:"name"`
	Track   string `json:"track"`   // Track type this design suits
	Mount   string `json:"mount"`   // Where the timer sits on the gate
	Summary string `json:"summary"` // One-line explanation shown in the flasher

	SweepHz       uint8 `json:"sweepHz"`       // 5.8 GHz 8-channel sweep rate
	WindowSamples uint8 `json:"windowSamples"` // Sweeps carried in each sliding-window frame
	TxEverySweeps uint8 `json:"txEverySweeps"` // Send a window frame every N sweeps (window / N = overlap)
	LinkRate      uint8 `json:"linkRate"`      // LinkRate1M or LinkRateLR500K
	TxPowerQdBm   uint8 `json:"txPowerQdbm"`   // 2.4 GHz TX power in 0.25 dBm steps (80 = +20 dBm)
	RSSIFilter    uint8 `json:"rssiFilter"`    // RSSIFilterNone or RSSIFilterMedian3
}

// MaxWindowSamples bounds the sliding-window frame size across all profiles.
const MaxWindowSamples = 6

// Profiles lists every firmware design offered in the flasher, default first.
var Profiles = []Profile{
	{
		ID:            "open-ground",
		Code:          1,
		Name:          "Open field · Ground mount",
		Track:         "Open field",
		Mount:         "On the grass at the gate base",
		Summary:       "Long Range 500 kbps at +20 dBm with 2× overlapping 4-sweep windows to ride out wet-grass absorption and 2.4 GHz ELRS bursts.",
		SweepHz:       50,
		WindowSamples: 4,
		TxEverySweeps: 2,
		LinkRate:      LinkRateLR500K,
		TxPowerQdBm:   80,
		RSSIFilter:    RSSIFilterNone,
	},
	{
		ID:            "open-elevated",
		Code:          2,
		Name:          "Open field · Gate-top mount",
		Track:         "Open field",
		Mount:         "On top of the gate or a pole",
		Summary:       "Clear line of sight, so it trades link margin for speed: 100 Hz sweeps for finer split timing over a 1 Mbps link.",
		SweepHz:       100,
		WindowSamples: 2,
		TxEverySweeps: 1,
		LinkRate:      LinkRate1M,
		TxPowerQdBm:   56,
		RSSIFilter:    RSSIFilterNone,
	},
	{
		ID:            "indoor",
		Code:          3,
		Name:          "Indoor · Gym or warehouse",
		Track:         "Indoor",
		Mount:         "Any mount",
		Summary:       "Short range and reflective walls: low +8 dBm TX, 100 Hz sweeps, and a 3-sweep median filter to reject multipath fades.",
		SweepHz:       100,
		WindowSamples: 2,
		TxEverySweeps: 1,
		LinkRate:      LinkRate1M,
		TxPowerQdBm:   32,
		RSSIFilter:    RSSIFilterMedian3,
	},
	{
		ID:            "obstructed",
		Code:          4,
		Name:          "Technical · Trees & obstacles",
		Track:         "Woods, bando, or technical",
		Mount:         "Behind or under obstacles",
		Summary:       "Hub link is often blocked: Long Range +20 dBm with 3× overlapping 6-sweep windows so a 100 ms dropout loses nothing.",
		SweepHz:       50,
		WindowSamples: 6,
		TxEverySweeps: 2,
		LinkRate:      LinkRateLR500K,
		TxPowerQdBm:   80,
		RSSIFilter:    RSSIFilterNone,
	},
}

// DefaultProfileID is used when no profile is requested.
const DefaultProfileID = "open-ground"

// ProfileByID returns the profile with the given ID, or the default profile.
func ProfileByID(id string) Profile {
	id = strings.TrimSpace(strings.ToLower(id))
	for _, p := range Profiles {
		if p.ID == id {
			return p
		}
	}
	return Profiles[0]
}

// ProfileByCode returns the profile with the given config-block code, or the default profile.
func ProfileByCode(code uint8) Profile {
	for _, p := range Profiles {
		if p.Code == code {
			return p
		}
	}
	return Profiles[0]
}
