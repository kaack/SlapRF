package domain

// TimerTelemetryFrame is the continuous 50 Hz / 100 Hz telemetry frame emitted by each XIAO ESP32-C5 gate timer.
type TimerTelemetryFrame struct {
	TimerID       uint8                     `json:"timerId"`       // Hardware Timer ID (or bound Gate ID after engine ingestion)
	SeqNum        uint32                    `json:"seqNum"`        // Monotonic frame counter
	TimestampUs   uint64                    `json:"timestampUs"`   // Synchronized microsecond RTC timestamp
	RSSI          [MaxPilotPoolSize]float32 `json:"rssi"`          // Smoothed/raw 5.8 GHz RSSI (dBm) for pilot slots
	BatteryMv     uint16                    `json:"batteryMv"`     // 1S LiPo voltage in mV
	NoiseFloorDbm float32                   `json:"noiseFloorDbm"` // Ambient 5.8 GHz noise floor
}

// GateCrossingEvent is emitted by the DSP PeakDetector when a pilot's 5.8 GHz RSSI curve
// peaks through a Gate Timer and drops below the exit nadir threshold.
type GateCrossingEvent struct {
	EventID           uint64  `json:"eventId"`              // Unique monotonic crossing ID
	GateID            uint8   `json:"gateId"`               // Track Gate where crossing occurred
	GateName          string  `json:"gateName"`             // Human-readable gate name
	IsStartFinish     bool    `json:"isStartFinish"`        // True if this gate triggers LapRF emulator passing records
	StartedLap        bool    `json:"startedLap,omitempty"` // True when this Start/Finish pass starts a lap without completing a prior lap
	SlotIndex         int     `json:"slotIndex"`            // 1-based Pilot Slot (1..8)
	Callsign          string  `json:"callsign"`             // Pilot Callsign
	FrequencyMHz      uint16  `json:"frequencyMhz"`         // Pilot VTX frequency
	TimestampUs       uint64  `json:"timestampUs"`          // Parabolic-interpolated peak timestamp in microseconds
	PeakRSSIDbm       float32 `json:"peakRssiDbm"`          // Peak RSSI in dBm (-20..-65 dBm)
	LapRFPeakHeight   float32 `json:"laprfPeakHeight"`      // Normalized LapRF peak height (600..3500 scale)
	BeamwidthMs       float64 `json:"beamwidthMs"`             // Time spent within -6 dB of peak (inversely proportional to gate speed)
	EstimatedSpeedMph float64 `json:"estimatedSpeedMph"`       // Estimated gate crossing speed derived from inverse-square RF curve width
	HoldMs              float64 `json:"holdMs,omitempty"`              // Total gate pass hold time (enter to exit) in milliseconds
	AboveEnterMs        float64 `json:"aboveEnterMs,omitempty"`        // Duration signal remained at or above enterThreshold in milliseconds
	AboveEnterAreaDbSec float64 `json:"aboveEnterAreaDbSec,omitempty"` // Integrated area under the pass curve above enterThreshold (dB*s)
	PassAreaDbSec       float64 `json:"passAreaDbSec,omitempty"`       // Integrated area under the pass curve above exitThreshold (dB*s)
	IsStepBurst         bool         `json:"isStepBurst,omitempty"`   // True when burst rose/fell instantaneously out of thermal noise (Wi-Fi packet TXOP)
	PassingNumber       uint32       `json:"passingNumber"`           // Per-gate or global passing sequence number
	Manual              bool         `json:"manual,omitempty"`        // True when added or adjusted manually on the Signals chart
	InvalidReason       FilterReason `json:"invalidReason,omitempty"` // Set when timing/order rules invalidate this crossing (MIN_LAP, OUT_OF_ORDER)
	InvalidDetail       string       `json:"invalidDetail,omitempty"` // Human-readable explanation when InvalidReason is non-empty
}
