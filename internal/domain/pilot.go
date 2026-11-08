package domain

import (
	"fmt"
	"math/rand"
	"time"
)

// MaxPilotSlots matches the 8-pilot standard of MultiGP LiveTime and ImmersionRC LapRF 8-Way.
const MaxPilotSlots = 8

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

// DefaultPilotColors provides distinct UI colors for up to 8 pilots.
var DefaultPilotColors = [MaxPilotSlots]string{
	"#ef4444", // Slot 1: Red
	"#3b82f6", // Slot 2: Blue
	"#10b981", // Slot 3: Emerald
	"#f59e0b", // Slot 4: Amber
	"#a855f7", // Slot 5: Purple
	"#06b6d4", // Slot 6: Cyan
	"#ec4899", // Slot 7: Pink
	"#84cc16", // Slot 8: Lime
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

// ChannelLabel returns a human-readable channel code such as "R1 (5658 MHz)".
func (p PilotSlot) ChannelLabel() string {
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

// DefaultPilotSlots returns a default 4-active-pilot (8-slot) Raceband configuration for simulation,
// picking 4 random pilots from the Bay Area pool to be enabled by default each time a session starts.
func DefaultPilotSlots() []PilotSlot {
	pool := []string{
		"Faerry", "MeWo", "Red5", "BigRamon",
		"Morbid", "Kyosanym", "OneEye", "FreeLove",
		"SwampDog", "Din",
	}
	rng := rand.New(rand.NewSource(time.Now().UnixNano()))
	rng.Shuffle(len(pool), func(i, j int) {
		pool[i], pool[j] = pool[j], pool[i]
	})

	// Standard MultiGP 4-pilot spacing uses R1, R3, R5, R8 (or IMD6) to minimize IMD
	defaultChannels := [MaxPilotSlots]uint8{1, 3, 5, 8, 2, 4, 6, 7}

	slots := make([]PilotSlot, MaxPilotSlots)
	for i := 0; i < MaxPilotSlots; i++ {
		ch := defaultChannels[i]
		freq := RacebandFrequenciesMHz[ch-1]
		slots[i] = PilotSlot{
			SlotIndex:       i + 1,
			Callsign:        pool[i],
			Enabled:         i < 4, // Enable first 4 pilots by default; all 8 available
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

// DefaultRealPilotSlots returns clean real-world pilot slots ("Pilot 1".."Pilot 8")
// completely separate from the simulated pro callsigns.
func DefaultRealPilotSlots() []PilotSlot {
	defaultChannels := [MaxPilotSlots]uint8{1, 3, 5, 8, 2, 4, 6, 7}

	slots := make([]PilotSlot, MaxPilotSlots)
	for i := 0; i < MaxPilotSlots; i++ {
		ch := defaultChannels[i]
		freq := RacebandFrequenciesMHz[ch-1]
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
