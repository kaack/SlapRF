package domain

import "time"

// PuckRole defines whether a XIAO ESP32-C5 gate puck is the official MultiGP Start/Finish gate
// (which emits detections to LiveTime) or an intermediate sector checkpoint.
type PuckRole string

const (
	PuckRoleStartFinish PuckRole = "START_FINISH"
	PuckRoleSectorGate  PuckRole = "SECTOR_GATE"
)

// DetectedPuck represents a physical Seeed Studio XIAO ESP32-C5 board discovered over
// Wi-Fi / ESP-NOW or flashed over USB, whether or not it is currently assigned to a gate.
type DetectedPuck struct {
	PuckID        uint8     `json:"puckId"`
	PuckLabel     string    `json:"puckLabel"`
	Color         string    `json:"color"`
	IsHub         bool      `json:"isHub"`
	BatteryMv     uint16    `json:"batteryMv"`
	BatteryPct    uint8     `json:"batteryPct"`
	NoiseFloorDbm float32   `json:"noiseFloorDbm"`
	Online        bool      `json:"online"`
	LastSeenAt    time.Time `json:"lastSeenAt"`
}

// DefaultGateColors is the canonical palette assigned to physical pucks.
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

// DefaultPuckColor returns the default color for a physical puck ID (1-based).
func DefaultPuckColor(puckID uint8) string {
	if puckID == 0 || len(DefaultGateColors) == 0 {
		return "#d4ff3a"
	}
	return DefaultGateColors[int(puckID-1)%len(DefaultGateColors)]
}

// GatePuck represents a gate on the track and the optional physical XIAO puck assigned to it.
type GatePuck struct {
	PuckID         uint8                  `json:"puckId"`         // Unique gate ID on the course (1..16)
	AssignedPuckID uint8                  `json:"assignedPuckId"` // Bound hardware puck ID (0 = no puck assigned)
	PuckLabel      string                 `json:"puckLabel"`      // Flashed puck ID / hardware name of the assigned puck
	Name           string                 `json:"name"`           // Gate name from Setup; empty means "Gate N" by track position
	Color          string                 `json:"color"`          // Hex color originating from the Gates section in System
	Role           PuckRole               `json:"role"`           // START_FINISH or SECTOR_GATE
	TrackOrder    int                    `json:"trackOrder"`    // 0-based sequence index around the track
	MapX          float64                `json:"mapX"`          // Normalized 0..1 X coordinate for the 2D track topology view
	MapY          float64                `json:"mapY"`          // Normalized 0..1 Y coordinate for the 2D track topology view
	BatteryMv     uint16                 `json:"batteryMv"`     // 1S LiPo voltage in millivolts (3300..4200 mV)
	BatteryPct    uint8                  `json:"batteryPct"`    // Calculated battery percentage (0..100%)
	NoiseFloorDbm float32                    `json:"noiseFloorDbm"` // Ambient 5.8 GHz noise floor in dBm
	LastRSSI      [MaxPilotPoolSize]float32  `json:"lastRssi"`      // Latest 5.8 GHz RSSI values (dBm)
	// EnterThresholds calibrates this gate per pilot slot (same order as LastRSSI). Each puck
	// sees a different signal level (distance, antenna, obstacles), so a pilot's single
	// threshold rarely suits every gate. 0 means "use the pilot's own threshold".
	EnterThresholds [MaxPilotPoolSize]float32 `json:"enterThresholds"`
	// RuleOverrides are this gate's own timing-rule values; unset fields use the global rules.
	RuleOverrides GateRuleOverrides `json:"ruleOverrides"`
	Online        bool              `json:"online"`        // True if frames arrived within the last 2 seconds
	LastSeenAt    time.Time         `json:"lastSeenAt"`    // Host timestamp of last frame
	FramesRxCount uint64            `json:"framesRxCount"` // Total telemetry frames received from this puck
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

// DefaultTrackPucks returns a 4-gate default track layout with Puck #1 as the MultiGP Start/Finish gate.
func DefaultTrackPucks() []GatePuck {
	now := time.Now()
	var defaultRssi [MaxPilotPoolSize]float32
	for i := range defaultRssi {
		defaultRssi[i] = -92
	}

	return []GatePuck{
		{
			PuckID:         1,
			AssignedPuckID: 1,
			Color:          DefaultGateColors[0],
			Role:           PuckRoleStartFinish,
			TrackOrder:     0,
			MapX:           0.22,
			MapY:           0.78,
			BatteryMv:      4120,
			BatteryPct:     ComputeBatteryPct(4120),
			NoiseFloorDbm:  -92.0,
			LastRSSI:       defaultRssi,
			Online:         true,
			LastSeenAt:     now,
		},
		{
			PuckID:         2,
			AssignedPuckID: 2,
			Color:          DefaultGateColors[1],
			Role:           PuckRoleSectorGate,
			TrackOrder:     1,
			MapX:           0.24,
			MapY:           0.22,
			BatteryMv:      4080,
			BatteryPct:     ComputeBatteryPct(4080),
			NoiseFloorDbm:  -92.5,
			LastRSSI:       defaultRssi,
			Online:         true,
			LastSeenAt:     now,
		},
		{
			PuckID:         3,
			AssignedPuckID: 3,
			Color:          DefaultGateColors[2],
			Role:           PuckRoleSectorGate,
			TrackOrder:     2,
			MapX:           0.78,
			MapY:           0.24,
			BatteryMv:      3990,
			BatteryPct:     ComputeBatteryPct(3990),
			NoiseFloorDbm:  -91.8,
			LastRSSI:       defaultRssi,
			Online:         true,
			LastSeenAt:     now,
		},
		{
			PuckID:         4,
			AssignedPuckID: 4,
			Color:          DefaultGateColors[3],
			Role:           PuckRoleSectorGate,
			TrackOrder:     3,
			MapX:           0.76,
			MapY:           0.76,
			BatteryMv:      4050,
			BatteryPct:     ComputeBatteryPct(4050),
			NoiseFloorDbm:  -92.2,
			LastRSSI:       defaultRssi,
			Online:         true,
			LastSeenAt:     now,
		},
	}
}
