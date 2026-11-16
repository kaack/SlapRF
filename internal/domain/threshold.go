package domain

// Enter/exit thresholds outside this range can't be right for a 5.8 GHz video signal.
const (
	MinThresholdDbm         float32 = -95
	MaxThresholdDbm         float32 = -20
	MinHysteresisGapDb      float32 = 2
	MinLapRFThreshold       float32 = 300
	MaxLapRFThreshold       float32 = 3500
	DefaultLapRFThreshold   float32 = 800
	DefaultLapRFGain        uint16  = 59
	MinRHThreshold          float32 = 10
	MaxRHThreshold          float32 = 250
	MinRHHysteresisGap      float32 = 4
	DefaultRHEnterThreshold float32 = 95
	DefaultRHExitThreshold  float32 = 70
)

// GateThresholdUpdate calibrates one gate for one pilot. EnterDbm 0 (or ExitDbm 0 / LapRFThreshold 0 / RHEnterThreshold 0)
// clears that override so the gate falls back to the pilot's own threshold.
type GateThresholdUpdate struct {
	GateID           uint8   `json:"gateId"`
	SlotIndex        int     `json:"slotIndex"`
	EnterDbm         float32 `json:"enterDbm"`
	ExitDbm          float32 `json:"exitDbm,omitempty"`
	LapRFThreshold   float32 `json:"laprfThreshold,omitempty"`
	RHEnterThreshold float32 `json:"rhEnterThreshold,omitempty"`
	RHExitThreshold  float32 `json:"rhExitThreshold,omitempty"`
	// Auto marks updates computed by the UI's Auto-calibrate action so background 30 s
	// auto-calibration keeps adapting instead of treating the threshold as manually pinned.
	Auto bool `json:"auto,omitempty"`
}
