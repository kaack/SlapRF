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
	IsStartFinish     bool    `json:"isStartFinish"`        // True if this gate triggers LiveTime LapRF passing records
	StartedLap        bool    `json:"startedLap,omitempty"` // True when this Start/Finish pass starts a lap without completing a prior lap
	SlotIndex         int     `json:"slotIndex"`            // 1-based Pilot Slot (1..8)
	Callsign          string  `json:"callsign"`             // Pilot Callsign
	FrequencyMHz      uint16  `json:"frequencyMhz"`         // Pilot VTX frequency
	TimestampUs       uint64  `json:"timestampUs"`          // Parabolic-interpolated peak timestamp in microseconds
	PeakRSSIDbm       float32 `json:"peakRssiDbm"`          // Peak RSSI in dBm (-20..-65 dBm)
	LapRFPeakHeight   float32 `json:"laprfPeakHeight"`      // Normalized LapRF peak height (600..3500 scale expected by LiveTime)
	BeamwidthMs       float64 `json:"beamwidthMs"`          // Time spent within -6 dB of peak (inversely proportional to gate speed)
	EstimatedSpeedMph float64 `json:"estimatedSpeedMph"`    // Estimated gate crossing speed derived from inverse-square RF curve width
	PassingNumber     uint32  `json:"passingNumber"`        // Per-gate or global passing sequence number
}
