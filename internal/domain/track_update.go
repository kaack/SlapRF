package domain

// MaxGateNameLen bounds gate names so they fit in tables and cards.
const MaxGateNameLen = 40

// GateUpdate is an edit to one gate's identity, color, order, or assigned physical puck on the track.
type GateUpdate struct {
	PuckID uint8    `json:"puckId"`
	Name   string   `json:"name"`            // empty clears the custom name ("Gate N" by position)
	Color  string   `json:"color,omitempty"` // optional hex color override for this gate
	Role   PuckRole `json:"role"`
	// TrackOrder is the 0-based position to move the gate to. Omit it to leave the gate
	// where it is, so a rename can never undo a reorder made from another browser.
	TrackOrder *int `json:"trackOrder,omitempty"`
	// AssignedPuckID binds a physical detected puck (1..16) to this gate, or 0 to unassign.
	// Omit it to keep the gate's current puck assignment.
	AssignedPuckID *uint8 `json:"assignedPuckId,omitempty"`
}
