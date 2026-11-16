package domain

import "fmt"

// MaxPilotSlots matches the 8-pilot active heat limit of MultiGP LiveTime and ImmersionRC LapRF 8-Way.
const MaxPilotSlots = 8

// MaxPilotPoolSize sizes fixed per-gate telemetry/calibration arrays (the global pilot roster itself has no upper limit).
const MaxPilotPoolSize = 128

// Band represents a 5.8 GHz FPV video frequency band.
type Band uint8

const (
	BandRaceband Band = 1 // R1 - R8 (Standard MultiGP Raceband)
	BandFatshark Band = 2 // F1 - F8 (Fatshark / ImmersionRC)
	BandBoscamE  Band = 3 // E1 - E8 (Boscam E)
	BandBoscamA  Band = 4 // A1 - A8 (Boscam A)
	BandIMD6     Band = 5 // I1 - I6 (IMD6c 6-pilot low-IMD spacing)
	BandBoscamB  Band = 6 // B1 - B8 (Boscam B)
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

// FatsharkFrequenciesMHz defines the standard 8 Fatshark / ImmersionRC (F1-F8) center frequencies in MHz.
var FatsharkFrequenciesMHz = [MaxPilotSlots]uint16{
	5740, // F1
	5760, // F2
	5780, // F3
	5800, // F4
	5820, // F5
	5840, // F6
	5860, // F7
	5880, // F8
}

// BoscamEFrequenciesMHz defines the standard 8 Boscam E (E1-E8) center frequencies in MHz.
var BoscamEFrequenciesMHz = [MaxPilotSlots]uint16{
	5705, // E1
	5685, // E2
	5665, // E3
	5645, // E4
	5885, // E5
	5905, // E6
	5925, // E7
	5945, // E8
}

// BoscamAFrequenciesMHz defines the standard 8 Boscam A (A1-A8) center frequencies in MHz.
var BoscamAFrequenciesMHz = [MaxPilotSlots]uint16{
	5865, // A1
	5845, // A2
	5825, // A3
	5805, // A4
	5785, // A5
	5765, // A6
	5745, // A7
	5725, // A8
}

// BoscamBFrequenciesMHz defines the standard 8 Boscam B (B1-B8) center frequencies in MHz.
var BoscamBFrequenciesMHz = [MaxPilotSlots]uint16{
	5733, // B1
	5752, // B2
	5771, // B3
	5790, // B4
	5809, // B5
	5828, // B6
	5847, // B7
	5866, // B8
}

// IMD6FrequenciesMHz defines the standard 6 IMD6c (I1-I6) center frequencies in MHz.
var IMD6FrequenciesMHz = [6]uint16{
	5658, // I1 (R1)
	5695, // I2 (R2)
	5760, // I3 (F2)
	5800, // I4 (F4)
	5880, // I5 (R7 / F8)
	5917, // I6 (R8)
}

// BandPrefix returns the single-letter prefix ("R", "F", "E", "A", "I", "B") for a Band.
func BandPrefix(band Band) string {
	switch band {
	case BandFatshark:
		return "F"
	case BandBoscamE:
		return "E"
	case BandBoscamA:
		return "A"
	case BandIMD6:
		return "I"
	case BandBoscamB:
		return "B"
	default:
		return "R"
	}
}

// BandShortCode returns e.g. "R1", "F4", "A1", "B3", or "" when channel == 0.
func BandShortCode(band Band, channel uint8) string {
	if channel == 0 {
		return ""
	}
	return fmt.Sprintf("%s%d", BandPrefix(band), channel)
}

// EncodeBandChannel packs a (Band, Channel) pair into a single uint8 seat/channel code.
// Raceband channels 1..8 remain 1..8 for 100% backward compatibility with stored JSON/tests;
// non-Raceband channels encode as `uint8(band)*10 + channel` (e.g. F4 = 24, E2 = 32, A1 = 41, I3 = 53, B2 = 62).
func EncodeBandChannel(band Band, channel uint8) uint8 {
	if channel == 0 {
		return 0
	}
	if band == 0 {
		band = BandRaceband
	}
	if FrequencyForBandChannel(band, channel) == 0 {
		return 0
	}
	if band == BandRaceband {
		return channel
	}
	return uint8(band)*10 + channel
}

// DecodeBandChannel unpacks an encoded uint8 seat/channel code back into (Band, Channel, FrequencyMHz, valid).
func DecodeBandChannel(code uint8) (Band, uint8, uint16, bool) {
	if code >= 1 && code <= MaxPilotSlots {
		return BandRaceband, code, RacebandFrequenciesMHz[code-1], true
	}
	if code >= 11 {
		b := Band(code / 10)
		ch := code % 10
		if freq := FrequencyForBandChannel(b, ch); freq > 0 {
			return b, ch, freq, true
		}
	}
	return 0, 0, 0, false
}

// LookupBandChannelByFreqMHz resolves a 5.8 GHz center frequency in MHz to its standard Band and 1-based Channel (1..8).
func LookupBandChannelByFreqMHz(freq uint16) (Band, uint8, bool) {
	for idx, f := range RacebandFrequenciesMHz {
		if f == freq {
			return BandRaceband, uint8(idx + 1), true
		}
	}
	for idx, f := range FatsharkFrequenciesMHz {
		if f == freq {
			return BandFatshark, uint8(idx + 1), true
		}
	}
	for idx, f := range BoscamAFrequenciesMHz {
		if f == freq {
			return BandBoscamA, uint8(idx + 1), true
		}
	}
	for idx, f := range BoscamBFrequenciesMHz {
		if f == freq {
			return BandBoscamB, uint8(idx + 1), true
		}
	}
	for idx, f := range BoscamEFrequenciesMHz {
		if f == freq {
			return BandBoscamE, uint8(idx + 1), true
		}
	}
	return 0, 0, false
}

// FrequencyForBandChannel returns the center frequency in MHz for a given Band and 1-based Channel, or 0 if unknown.
func FrequencyForBandChannel(band Band, channel uint8) uint16 {
	if channel < 1 || channel > MaxPilotSlots {
		return 0
	}
	switch band {
	case 0, BandRaceband:
		return RacebandFrequenciesMHz[channel-1]
	case BandFatshark:
		return FatsharkFrequenciesMHz[channel-1]
	case BandBoscamE:
		return BoscamEFrequenciesMHz[channel-1]
	case BandBoscamA:
		return BoscamAFrequenciesMHz[channel-1]
	case BandBoscamB:
		return BoscamBFrequenciesMHz[channel-1]
	case BandIMD6:
		if int(channel) <= len(IMD6FrequenciesMHz) {
			return IMD6FrequenciesMHz[channel-1]
		}
		return 0
	default:
		return 0
	}
}

var basePilotPalette = [32]string{
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
	"#f43f5e", // Slot 17: Crimson
	"#2563eb", // Slot 18: Royal Blue
	"#059669", // Slot 19: Jade
	"#d97706", // Slot 20: Ochre
	"#9333ea", // Slot 21: Amethyst
	"#0891b2", // Slot 22: Cerulean
	"#db2777", // Slot 23: Magenta
	"#65a30d", // Slot 24: Chartreuse
	"#ea580c", // Slot 25: Tangerine
	"#0d9488", // Slot 26: Seafoam
	"#4f46e5", // Slot 27: Cobalt
	"#ca8a04", // Slot 28: Gold
	"#e11d48", // Slot 29: Ruby
	"#0284c7", // Slot 30: Azure
	"#7c3aed", // Slot 31: Iris
	"#16a34a", // Slot 32: Kelly Green
}

// DefaultPilotColors provides distinct UI colors for pilots in the roster up to MaxPilotPoolSize.
var DefaultPilotColors = func() [MaxPilotPoolSize]string {
	var out [MaxPilotPoolSize]string
	for i := 0; i < MaxPilotPoolSize; i++ {
		out[i] = basePilotPalette[i%len(basePilotPalette)]
	}
	return out
}()

// PilotColorForSlot returns the deterministic UI hex color for any 1-based pilot slot index.
func PilotColorForSlot(slotIndex int) string {
	if slotIndex < 1 {
		slotIndex = 1
	}
	return basePilotPalette[(slotIndex-1)%len(basePilotPalette)]
}

// PilotCSVImportSummary reports how many pilots were added vs updated during a non-destructive CSV merge.
type PilotCSVImportSummary struct {
	Added   int `json:"added"`
	Updated int `json:"updated"`
	Total   int `json:"total"`
}

// PilotSlot represents one of the pilot entries in the roster (with up to 8 active RF slots at once).
type PilotSlot struct {
	SlotIndex       int     `json:"slotIndex"`                 // 1-based pilot slot ID
	Callsign        string  `json:"callsign"`                  // Pilot name / callsign
	PhoneticName    string  `json:"phoneticName"`              // Optional phonetic pronunciation for the voice announcer
	Enabled         bool    `json:"enabled"`                   // Whether this slot is active in the current heat
	Band            Band    `json:"band"`                      // Frequency band
	Channel         uint8   `json:"channel"`                   // Channel number (1..8)
	FrequencyMHz    uint16  `json:"frequencyMhz"`              // Center frequency in MHz (e.g., 5658..5917)
	EnterThreshold   float32 `json:"enterThreshold"`            // SlapRF RSSI threshold (dBm) to enter gate window
	ExitThreshold    float32 `json:"exitThreshold"`             // SlapRF RSSI threshold (dBm) to confirm gate exit
	LapRFThreshold   float32 `json:"laprfThreshold,omitempty"`  // LapRF 8-Way threshold (300..3500, default 800)
	RHEnterThreshold float32 `json:"rhEnterThreshold,omitempty"` // RotorHazard EnterAt RSSI (0..255, default 95)
	RHExitThreshold  float32 `json:"rhExitThreshold,omitempty"`  // RotorHazard ExitAt RSSI (0..255, default 70)
	AttenuationGain  uint16  `json:"attenuationGain"`           // Digital LNA/VGA gain setting (0..63, default 59 on LapRF)
	Color           string  `json:"color"`                     // Hex color for waveform and map rendering
	MultiGPPilotID  int     `json:"mgpPilotId,omitempty"`      // Linked MultiGP global pilotId (when imported/matched)
	MultiGPUserName string  `json:"mgpUserName,omitempty"`     // Linked MultiGP userName handle
}

// ChannelLabel returns a human-readable channel code such as "R1 (5658 MHz)" or "Unassigned" when Channel == 0.
func (p PilotSlot) ChannelLabel() string {
	if p.Channel == 0 {
		return "Unassigned"
	}
	return fmt.Sprintf("%s%d (%d MHz)", BandPrefix(p.Band), p.Channel, p.FrequencyMHz)
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
			EnterThreshold:   -58.0,
			ExitThreshold:    -68.0,
			LapRFThreshold:   800.0,
			RHEnterThreshold: 95.0,
			RHExitThreshold:  70.0,
			AttenuationGain:  59,
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
			EnterThreshold:   -58.0,
			ExitThreshold:    -68.0,
			LapRFThreshold:   800.0,
			RHEnterThreshold: 95.0,
			RHExitThreshold:  70.0,
			AttenuationGain:  59,
			Color:           DefaultPilotColors[i],
		}
	}
	return slots
}
