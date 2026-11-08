package domain

import "fmt"

// MaxPilotSlots matches the 8-pilot active heat limit of MultiGP LiveTime and ImmersionRC LapRF 8-Way.
const MaxPilotSlots = 8

// MaxPilotPoolSize is the maximum number of pilot rows supported in the roster (at most MaxPilotSlots enabled at once).
const MaxPilotPoolSize = 16

// Band represents a 5.8 GHz FPV video frequency band.
type Band uint8

const (
	BandRaceband Band = 1 // R1 - R8 (Standard MultiGP Raceband)
	BandFatshark Band = 2 // F1 - F8
	BandBoscamE  Band = 3 // E1 - E8
	BandBoscamA  Band = 4 // A1 - A8
	BandIMD6     Band = 5 // IMD6C
)

// RacebandFrequenciesMHz defines the standard 8 Raceband center frequencies in MHz.
var RacebandFrequenciesMHz = [MaxPilotSlots]uint16{
	5658, // R1
	5695, // R2
	5732, // R3
	5769, // R4
	5806, // R5
	5843, // R6
	5880, // R7
	5917, // R8
}

// DefaultPilotColors provides distinct UI colors for pilots in the roster.
var DefaultPilotColors = [MaxPilotPoolSize]string{
	"#ef4444", // Slot 1: Red
	"#3b82f6", // Slot 2: Blue
	"#10b981", // Slot 3: Emerald
	"#f59e0b", // Slot 4: Amber
	"#a855f7", // Slot 5: Purple
	"#06b6d4", // Slot 6: Cyan
	"#ec4899", // Slot 7: Pink
	"#84cc16", // Slot 8: Lime
	"#f97316", // Slot 9: Orange
	"#14b8a6", // Slot 10: Teal
	"#6366f1", // Slot 11: Indigo
	"#eab308", // Slot 12: Yellow
	"#fb7185", // Slot 13: Rose
	"#38bdf8", // Slot 14: Sky
	"#c084fc", // Slot 15: Violet
	"#4ade80", // Slot 16: Green
}

// PilotSlot represents one of the 8 active timing slots synchronized with LiveTime.
type PilotSlot struct {
	SlotIndex       int     `json:"slotIndex"`       // 1-based slot index (1..8) matching LapRF protocol
	Callsign        string  `json:"callsign"`        // Pilot name / callsign
	Enabled         bool    `json:"enabled"`         // Whether this slot is active in the current heat
	Band            Band    `json:"band"`            // Frequency band
	Channel         uint8   `json:"channel"`         // Channel number (1..8)
	FrequencyMHz    uint16  `json:"frequencyMhz"`    // Center frequency in MHz (e.g., 5658..5917)
	EnterThreshold  float32 `json:"enterThreshold"`  // RSSI threshold (dBm or LapRF scale) to enter gate window
	ExitThreshold   float32 `json:"exitThreshold"`   // RSSI threshold to confirm gate exit
	AttenuationGain uint16  `json:"attenuationGain"` // Digital LNA/VGA gain setting (synced from LiveTime RFSETUP)
	Color           string  `json:"color"`           // Hex color for waveform and map rendering
}

// ChannelLabel returns a human-readable channel code such as "R1 (5658 MHz)" or "Unassigned" when Channel == 0.
func (p PilotSlot) ChannelLabel() string {
	if p.Channel == 0 {
		return "Unassigned"
	}
	prefix := "R"
	switch p.Band {
	case BandFatshark:
		prefix = "F"
	case BandBoscamE:
		prefix = "E"
	case BandBoscamA:
		prefix = "A"
	case BandIMD6:
		prefix = "I"
	}
	return fmt.Sprintf("%s%d (%d MHz)", prefix, p.Channel, p.FrequencyMHz)
}

// DefaultPilotSlots returns the simulated Bay Area pilot roster with 4 active pilots by default
// (FAERRY, MeWo, Din, BigRamon) and additional Bay Area pilots ready to toggle on (up to 8 enabled at once).
func DefaultPilotSlots() []PilotSlot {
	callsigns := []string{
		"FAERRY", "MeWo", "Din", "BigRamon",
		"Red5", "SwampDog", "Morbid", "Kyosanym",
		"OneEye", "FreeLove",
	}

	// Standard MultiGP 4-pilot spacing uses R1, R3, R5, R8 for the 4 active pilots;
	// standby pilots start with Channel = 0 (unassigned) so the race organizer assigns a channel manually.
	defaultChannels := []uint8{1, 3, 5, 8}

	slots := make([]PilotSlot, len(callsigns))
	for i := 0; i < len(callsigns); i++ {
		var ch uint8
		var freq uint16
		if i < len(defaultChannels) {
			ch = defaultChannels[i]
			freq = RacebandFrequenciesMHz[ch-1]
		}
		slots[i] = PilotSlot{
			SlotIndex:       i + 1,
			Callsign:        callsigns[i],
			Enabled:         i < 4, // Enable first 4 pilots by default (max 8 enabled at a time)
			Band:            BandRaceband,
			Channel:         ch,
			FrequencyMHz:    freq,
			EnterThreshold:  -58.0,
			ExitThreshold:   -68.0,
			AttenuationGain: 52,
			Color:           DefaultPilotColors[i%len(DefaultPilotColors)],
		}
	}
	return slots
}

// DefaultRealPilotSlots returns clean real-world pilot slots ("Pilot 1".."Pilot 8")
// completely separate from the simulated pro callsigns.
func DefaultRealPilotSlots() []PilotSlot {
	defaultChannels := [4]uint8{1, 3, 5, 8}

	slots := make([]PilotSlot, MaxPilotSlots)
	for i := 0; i < MaxPilotSlots; i++ {
		var ch uint8
		var freq uint16
		if i < len(defaultChannels) {
			ch = defaultChannels[i]
			freq = RacebandFrequenciesMHz[ch-1]
		}
		slots[i] = PilotSlot{
			SlotIndex:       i + 1,
			Callsign:        fmt.Sprintf("Pilot %d", i+1),
			Enabled:         i < 4,
			Band:            BandRaceband,
			Channel:         ch,
			FrequencyMHz:    freq,
			EnterThreshold:  -58.0,
			ExitThreshold:   -68.0,
			AttenuationGain: 52,
			Color:           DefaultPilotColors[i],
		}
	}
	return slots
}
