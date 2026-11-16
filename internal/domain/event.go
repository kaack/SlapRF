package domain

import "strings"

// RaceLifecycle tracks the overall tournament lifecycle of a single Race.
type RaceLifecycle string

const (
	LifecycleDraft     RaceLifecycle = "draft"     // Rules & bracket being set up; no heats started yet
	LifecycleActive    RaceLifecycle = "active"    // Race is underway
	LifecyclePaused    RaceLifecycle = "paused"    // Suspended (e.g. rain delay, day break, equipment fix)
	LifecycleCompleted RaceLifecycle = "completed" // Finished; preserved permanently for historical review
	LifecycleScrapped  RaceLifecycle = "scrapped"  // Aborted / cancelled; flown heats preserved
)

// PilotAttendance tracks real-world pilot availability and race-wide standing status during a Race.
type PilotAttendance string

const (
	AttendanceActive  PilotAttendance = "active"  // Present and ready to fly heats
	AttendanceAway    PilotAttendance = "away"    // Temporarily away / repairing quad (unstarted seats -> DNS; OQ unqueued)
	AttendanceDQ      PilotAttendance = "dq"      // Race-wide disqualification (reversible on appeal; started/completed -> DQ preserving laps, unstarted -> DNS)
	AttendanceDNC     PilotAttendance = "dnc"     // Did Not Complete remaining race (unstarted seats -> DNS; OQ unqueued)
	AttendanceForfeit PilotAttendance = "forfeit" // Legacy alias normalized to "dnc"
)

// NormalizeAttendance canonicalizes attendance values (including legacy "forfeit"/"left" -> "dnc").
func NormalizeAttendance(a PilotAttendance) PilotAttendance {
	switch a {
	case AttendanceAway:
		return AttendanceAway
	case AttendanceDQ:
		return AttendanceDQ
	case AttendanceDNC, AttendanceForfeit, "left":
		return AttendanceDNC
	default:
		return AttendanceActive
	}
}

// IsAbsent returns true when the pilot is Away, DQ, or DNC (unstarted heats scratch as DNS).
func (a PilotAttendance) IsAbsent() bool {
	n := NormalizeAttendance(a)
	return n == AttendanceAway || n == AttendanceDQ || n == AttendanceDNC
}

// EventPilot represents one pilot in a Race's check-in & attendance roster.
// Callsign, PhoneticName, and Color are snapshotted on the Race so completed historical races
// retain their exact pilot names even if the global Pilot Directory changes months later.
type EventPilot struct {
	SlotIndex      int             `json:"slotIndex"`
	Callsign       string          `json:"callsign"`
	PhoneticName   string          `json:"phoneticName,omitempty"`
	Color          string          `json:"color"`
	CheckedIn      bool            `json:"checkedIn"`
	Attendance     PilotAttendance `json:"attendance"`
	Note           string          `json:"note,omitempty"`
	MultiGPPilotID int             `json:"mgpPilotId,omitempty"`
}

// IsAvailableToRace returns true when the pilot is checked into the Race and actively racing.
func (ep EventPilot) IsAvailableToRace() bool {
	return ep.CheckedIn && (ep.Attendance == "" || ep.Attendance == AttendanceActive)
}

// NormalizeRaceTags trims, cleans, and case-insensitively deduplicates race tags while preserving casing.
func NormalizeRaceTags(tags []string) []string {
	if len(tags) == 0 {
		return nil
	}
	seen := make(map[string]bool, len(tags))
	out := make([]string, 0, len(tags))
	for _, raw := range tags {
		// Support comma-separated chunks if passed in a single string
		for _, part := range strings.Split(raw, ",") {
			t := strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(part), "#"))
			t = strings.Join(strings.Fields(t), " ")
			if t == "" {
				continue
			}
			if len([]rune(t)) > 32 {
				r := []rune(t)
				t = string(r[:32])
			}
			key := strings.ToLower(t)
			if seen[key] {
				continue
			}
			seen[key] = true
			out = append(out, t)
			if len(out) >= 16 {
				return out
			}
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func slugifyNavCore(raw string) string {
	s := strings.ToLower(strings.TrimSpace(raw))
	s = strings.ReplaceAll(s, "&", " and ")
	var b strings.Builder
	lastDash := false
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			lastDash = false
		} else if !lastDash && b.Len() > 0 {
			b.WriteByte('-')
			lastDash = true
		}
	}
	return strings.Trim(b.String(), "-")
}

func isReservedNavSlug(slug string) bool {
	switch slug {
	case "directory", "format", "control", "review", "edit", "stage", "session":
		return true
	}
	if strings.HasPrefix(slug, "stage-") && len(slug) > len("stage-") {
		rest := slug[len("stage-"):]
		allDigits := true
		for i := 0; i < len(rest); i++ {
			if rest[i] < '0' || rest[i] > '9' {
				allDigits = false
				break
			}
		}
		if allDigits {
			return true
		}
	}
	return false
}

// SlugifyRaceName converts a race display name into a clean, deterministic URL slug
// suitable for `#/races/<slug>/...` routing, appending `-race` when colliding with a reserved route token.
func SlugifyRaceName(name string) string {
	s := slugifyNavCore(name)
	if s == "" {
		s = "race"
	}
	if isReservedNavSlug(s) {
		return s + "-race"
	}
	return s
}

// SlugifyPracticeName converts a practice session display name into a clean, deterministic URL slug
// suitable for `#/live/<slug>` routing, appending `-practice` when colliding with a reserved route token.
func SlugifyPracticeName(name string) string {
	s := slugifyNavCore(name)
	if s == "" {
		s = "practice"
	}
	if isReservedNavSlug(s) {
		return s + "-practice"
	}
	return s
}

// EventManagerState holds all persisted Races and the currently active Race ID.
type EventManagerState struct {
	Initialized  bool                  `json:"initialized,omitempty"`
	ActiveRaceID string                `json:"activeRaceId"`
	Races        []RaceTournamentState `json:"races"`
}
