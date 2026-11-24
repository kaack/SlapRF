package domain

import "fmt"

// PracticeSessionPilot represents a pilot assigned to a PracticeSession (referenced by SlotIndex
// from the global Pilots directory, with a per-session 5.8 GHz channel assignment).
type PracticeSessionPilot struct {
	SlotIndex    int    `json:"slotIndex"`
	Callsign     string `json:"callsign"`
	PhoneticName string `json:"phoneticName,omitempty"`
	Color        string `json:"color"`
	Band         Band   `json:"band"`
	Channel      uint8  `json:"channel"`
	FrequencyMHz uint16 `json:"frequencyMhz"`
}

// ChannelLabel returns a human-readable channel code matching PilotSlot.ChannelLabel().
func (p PracticeSessionPilot) ChannelLabel() string {
	if p.Channel == 0 {
		return "Unassigned"
	}
	return fmt.Sprintf("%s%d (%d MHz)", BandPrefix(p.Band), p.Channel, p.FrequencyMHz)
}

// ManualDeletedCrossing records a crossing timestamp that a human explicitly deleted (`×`)
// on the Signals chart so on-device ML training treats that window as a verified hard negative.
type ManualDeletedCrossing struct {
	GateID      uint8   `json:"gateId"`
	SlotIndex   int     `json:"slotIndex"`
	TimestampUs uint64  `json:"timestampUs"`
	PeakRSSIDbm float32 `json:"peakRssiDbm,omitempty"`
}

// PracticeSession captures one named, taggable Practice Session along with its assigned pilot
// lineup (up to 8 active RF slots) and all laps/crossings recorded during the session.
// Removing a pilot from `Pilots` intentionally retains their recorded `Laps`/`Crossings` in the
// session so re-adding them restores their lap history and sector splits immediately.
type PracticeSession struct {
	SessionID              string                  `json:"sessionId"`
	Name                   string                  `json:"name"`
	Tags                   []string                `json:"tags,omitempty"`
	Active                 bool                    `json:"active"`
	Paused                 bool                    `json:"paused,omitempty"`
	CreatedAt              string                  `json:"createdAt"`
	UpdatedAt              string                  `json:"updatedAt,omitempty"`
	Pilots                 []PracticeSessionPilot  `json:"pilots"`
	TrackInitialized       bool                    `json:"trackInitialized,omitempty"`
	TrackSnapshot          []TrackGate             `json:"trackSnapshot,omitempty"`
	Rules                  *TimingRules            `json:"rules,omitempty"`
	Laps                   []LapRecord             `json:"laps"`
	Crossings              []GateCrossingEvent     `json:"crossings"`
	Filtered               []FilteredDetection     `json:"filtered"`
	Summaries              []PilotTrackSummary     `json:"summaries"`
	TrainingVerified       bool                    `json:"trainingVerified,omitempty"`
	ManualDeletedCrossings []ManualDeletedCrossing `json:"manualDeletedCrossings,omitempty"`
	TraceSampleCount       int                     `json:"traceSampleCount,omitempty"`
	TraceDurationSec       float64                 `json:"traceDurationSec,omitempty"`
}

// PracticeManagerState holds the full list of Practice Sessions, which session (at most one) is
// currently live on the RF hardware, and which session is currently selected in the UI.
type PracticeManagerState struct {
	Initialized          bool              `json:"initialized,omitempty"`
	ActiveSessionID      string            `json:"activeSessionId"`
	SelectedSessionID    string            `json:"selectedSessionId"`
	PackLoopEnabled      bool              `json:"packLoopEnabled,omitempty"`
	PackLoopQuietSec     int               `json:"packLoopQuietSec,omitempty"`
	PackLoopQuietElapsed float64           `json:"packLoopQuietElapsed,omitempty"`
	PackLoopState        string            `json:"packLoopState,omitempty"`
	LastSealedSessionID  string            `json:"lastSealedSessionId,omitempty"`
	LastSealedLapCount   int               `json:"lastSealedLapCount,omitempty"`
	Sessions             []PracticeSession `json:"sessions"`
}
