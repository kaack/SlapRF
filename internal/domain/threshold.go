package domain

// Enter thresholds outside this range can't be right for a 5.8 GHz video signal.
const (
	MinThresholdDbm float32 = -95
	MaxThresholdDbm float32 = -20
)

// GateThresholdUpdate calibrates one gate for one pilot. EnterDbm 0 clears the override so
// the gate goes back to the pilot's own threshold.
type GateThresholdUpdate struct {
	GateID    uint8   `json:"gateId"`
	SlotIndex int     `json:"slotIndex"`
	EnterDbm  float32 `json:"enterDbm"`
}
