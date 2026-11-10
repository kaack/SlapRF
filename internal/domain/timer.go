package domain

import (
	"fmt"
	"time"
)

// GateRole defines whether a XIAO ESP32-C5 gate timer is the official MultiGP Start/Finish gate
// (which emits detections to LiveTime) or an intermediate sector checkpoint.
type GateRole string

const (
	GateRoleStartFinish GateRole = "START_FINISH"
	GateRoleSectorGate  GateRole = "SECTOR_GATE"
)

// LatestFirmwareVersion is the current XIAO ESP32-C5 SDR timer firmware build (firmware/slaprf).
const LatestFirmwareVersion = "v0.1.4"

// DetectedTimer represents a physical Seeed Studio XIAO ESP32-C5 board discovered over
// the USB Hub (ESP-NOW) or flashed over USB, whether or not it is currently assigned to a gate.
type DetectedTimer struct {
	TimerID         uint8                     `json:"timerId"`
	TimerLabel      string                    `json:"timerLabel"`
	Fingerprint     string                    `json:"fingerprint,omitempty"` // Stable 8-hex-digit board identity stamped at flash time
	Color           string                    `json:"color"`
	IsHub           bool                      `json:"isHub"`
	FirmwareVersion string                    `json:"firmwareVersion,omitempty"`
	BatteryMv       uint16                    `json:"batteryMv"`
	BatteryPct      uint8                     `json:"batteryPct"`
	NoiseFloorDbm   float32                   `json:"noiseFloorDbm"`
	LastRSSI        [MaxPilotPoolSize]float32 `json:"lastRssi"`
	FramesRxCount   uint64                    `json:"framesRxCount"`
	Online          bool                      `json:"online"`
	LastSeenAt      time.Time                 `json:"lastSeenAt"`
}

// DefaultGateColors is the canonical palette assigned to physical timers.
var DefaultGateColors = []string{
	"#d4ff3a",
	"#38bdf8",
	"#f472b6",
	"#fb923c",
	"#a78bfa",
	"#2dd4bf",
	"#facc15",
	"#f87171",
}

// DefaultTimerColor returns the default color for a physical timer ID (1-based).
func DefaultTimerColor(timerID uint8) string {
	if timerID == 0 || len(DefaultGateColors) == 0 {
		return "#d4ff3a"
	}
	return DefaultGateColors[int(timerID-1)%len(DefaultGateColors)]
}

// TrackGate represents a gate on the track and the optional physical XIAO timer assigned to it.
type TrackGate struct {
	GateID          uint8                     `json:"gateId"`                    // Unique gate ID on the course (1..16)
	AssignedTimerID uint8                     `json:"assignedTimerId"`           // Bound hardware timer ID (0 = no timer assigned)
	TimerLabel      string                    `json:"timerLabel"`                // Flashed timer ID / hardware name of the assigned timer
	FirmwareVersion string                    `json:"firmwareVersion,omitempty"` // Running firmware version on the assigned timer (e.g. "v0.1.4")
	Name            string                    `json:"name"`                      // Gate name from Setup; empty means "Gate N" by track position
	Color           string                    `json:"color"`                     // Hex color originating from the Gates section in System
	Role            GateRole                  `json:"role"`                      // START_FINISH or SECTOR_GATE
	TrackOrder      int                       `json:"trackOrder"`                // 0-based sequence index around the track
	MapX            float64                   `json:"mapX"`                      // Normalized 0..1 X coordinate for the 2D track topology view
	MapY            float64                   `json:"mapY"`                      // Normalized 0..1 Y coordinate for the 2D track topology view
	BatteryMv       uint16                    `json:"batteryMv"`                 // 1S LiPo voltage in millivolts (3300..4200 mV)
	BatteryPct      uint8                     `json:"batteryPct"`                // Calculated battery percentage (0..100%)
	NoiseFloorDbm   float32                   `json:"noiseFloorDbm"`             // Ambient 5.8 GHz noise floor in dBm
	LastRSSI        [MaxPilotPoolSize]float32 `json:"lastRssi"`                  // Latest 5.8 GHz RSSI values (dBm)
	// EnterThresholds calibrates this gate per pilot slot (same order as LastRSSI). Each timer
	// sees a different signal level (distance, antenna, obstacles), so a pilot's single
	// threshold rarely suits every gate. 0 means "use the pilot's own threshold".
	EnterThresholds [MaxPilotPoolSize]float32 `json:"enterThresholds"`
	// RuleOverrides are this gate's own timing-rule values; unset fields use the global rules.
	RuleOverrides GateRuleOverrides `json:"ruleOverrides"`
	Online        bool              `json:"online"`        // True if frames arrived within the last 2 seconds
	LastSeenAt    time.Time         `json:"lastSeenAt"`    // Host timestamp of last frame
	FramesRxCount uint64            `json:"framesRxCount"` // Total telemetry frames received from this timer
}

// ComputeBatteryPct converts a 1S LiPo voltage in millivolts (3300..4200 mV) to 0..100%.
func ComputeBatteryPct(mv uint16) uint8 {
	if mv >= 4200 {
		return 100
	}
	if mv <= 3300 {
		return 0
	}
	return uint8(float64(mv-3300) / 900.0 * 100.0)
}

// SimHubTimerID is the timer ID of the simulated Hub. Like the real Hub it is a USB collector
// dongle that holds no gate by default; the user may drag it onto a gate to make it sweep too.
const SimHubTimerID uint8 = 1

// DefaultSimHubLabel is the flashed name of the simulated Hub.
const DefaultSimHubLabel = "H1"

// DefaultTimerLabel returns the default short label for a physical timer:
// "H1" for the Hub, or "T1".."T6" for Spokes (timer IDs 2..7).
func DefaultTimerLabel(timerID uint8, isHub bool) string {
	if isHub || timerID == SimHubTimerID {
		return DefaultSimHubLabel
	}
	idx := int(timerID) - 1
	if idx < 1 {
		idx = 1
	}
	return fmt.Sprintf("T%d", idx)
}

// DefaultTrackGates returns the 4-timer default simulator track layout. Every track slot is a
// simulated Spoke (timers 2..5, T1..T4); the first Spoke is the MultiGP Start/Finish
// timer. The simulated Hub (SimHubTimerID) is registered separately off-track.
func DefaultTrackGates() []TrackGate {
	now := time.Now()
	var defaultRssi [MaxPilotPoolSize]float32
	for i := range defaultRssi {
		defaultRssi[i] = -92
	}

	return []TrackGate{
		{
			GateID:          1,
			AssignedTimerID: 2,
			FirmwareVersion: LatestFirmwareVersion,
			Color:           DefaultGateColors[0],
			Role:            GateRoleStartFinish,
			TrackOrder:      0,
			MapX:            0.22,
			MapY:            0.78,
			BatteryMv:       4120,
			BatteryPct:      ComputeBatteryPct(4120),
			NoiseFloorDbm:   -92.0,
			LastRSSI:        defaultRssi,
			Online:          true,
			LastSeenAt:      now,
		},
		{
			GateID:          2,
			AssignedTimerID: 3,
			FirmwareVersion: LatestFirmwareVersion,
			Color:           DefaultGateColors[1],
			Role:            GateRoleSectorGate,
			TrackOrder:      1,
			MapX:            0.24,
			MapY:            0.22,
			BatteryMv:       4080,
			BatteryPct:      ComputeBatteryPct(4080),
			NoiseFloorDbm:   -92.5,
			LastRSSI:        defaultRssi,
			Online:          true,
			LastSeenAt:      now,
		},
		{
			GateID:          3,
			AssignedTimerID: 4,
			FirmwareVersion: LatestFirmwareVersion,
			Color:           DefaultGateColors[2],
			Role:            GateRoleSectorGate,
			TrackOrder:      2,
			MapX:            0.78,
			MapY:            0.24,
			BatteryMv:       3990,
			BatteryPct:      ComputeBatteryPct(3990),
			NoiseFloorDbm:   -91.8,
			LastRSSI:        defaultRssi,
			Online:          true,
			LastSeenAt:      now,
		},
		{
			GateID:          4,
			AssignedTimerID: 5,
			FirmwareVersion: LatestFirmwareVersion,
			Color:           DefaultGateColors[3],
			Role:            GateRoleSectorGate,
			TrackOrder:      3,
			MapX:            0.76,
			MapY:            0.76,
			BatteryMv:       4050,
			BatteryPct:      ComputeBatteryPct(4050),
			NoiseFloorDbm:   -92.2,
			LastRSSI:        defaultRssi,
			Online:          true,
			LastSeenAt:      now,
		},
	}
}
