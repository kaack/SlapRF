package tracker

import (
	"testing"

	"slaprf/internal/domain"
)

func TestUpdatePilotSlotChannelConflictBlanksChannel(t *testing.T) {
	eng := NewEngine()
	pilots, _, _, _, _ := eng.StateSnapshot()

	// Slot 1 (FAERRY) starts enabled on R1 (Channel 1)
	if !pilots[0].Enabled || pilots[0].Channel != 1 {
		t.Fatalf("expected slot 1 enabled on channel 1, got enabled=%v ch=%d", pilots[0].Enabled, pilots[0].Channel)
	}

	// Case 1: Enable a standby pilot (Slot 5, Red5) with Channel 1 (already taken by FAERRY).
	// Red5 should be enabled, and Red5's channel should be blanked out to 0 (never auto-assigned or swapped).
	red5 := pilots[4]
	red5.Enabled = true
	red5.Channel = 1
	red5.FrequencyMHz = 5658
	eng.UpdatePilotSlot(red5)

	pilots, _, _, _, _ = eng.StateSnapshot()
	if !pilots[4].Enabled || pilots[4].Channel != 0 || pilots[4].FrequencyMHz != 0 {
		t.Fatalf("expected newly enabled conflicting pilot to have channel blanked to 0, got enabled=%v ch=%d freq=%d",
			pilots[4].Enabled, pilots[4].Channel, pilots[4].FrequencyMHz)
	}
	if pilots[0].Channel != 1 {
		t.Fatalf("expected existing holder (FAERRY) to remain on channel 1, got ch=%d", pilots[0].Channel)
	}

	// Case 2: Race organizer manually assigns already-enabled Red5 to Channel 1 (which FAERRY holds).
	// Red5 gets Channel 1, and FAERRY's channel is blanked out to 0 (no channel swap).
	red5 = pilots[4]
	red5.Channel = 1
	red5.FrequencyMHz = 5658
	eng.UpdatePilotSlot(red5)

	pilots, _, _, _, _ = eng.StateSnapshot()
	if pilots[4].Channel != 1 || pilots[4].FrequencyMHz != 5658 {
		t.Fatalf("expected Red5 to be assigned channel 1 (5658 MHz), got ch=%d freq=%d", pilots[4].Channel, pilots[4].FrequencyMHz)
	}
	if pilots[0].Channel != 0 || pilots[0].FrequencyMHz != 0 {
		t.Fatalf("expected previous holder FAERRY to have channel blanked out to 0, got ch=%d freq=%d", pilots[0].Channel, pilots[0].FrequencyMHz)
	}
}

func TestPilotPhoneticNamePersistenceAndLapRFSync(t *testing.T) {
	eng := NewEngine()
	pilots, _, _, _, _ := eng.StateSnapshot()
	if pilots[0].PhoneticName != "" {
		t.Fatalf("expected default PhoneticName to be empty, got %q", pilots[0].PhoneticName)
	}

	// Set phonetic name via UpdatePilotSlot (trimmed)
	p0 := pilots[0]
	p0.PhoneticName = "  Fairy  "
	eng.UpdatePilotSlot(p0)

	pilots, _, _, _, _ = eng.StateSnapshot()
	if pilots[0].PhoneticName != "Fairy" {
		t.Fatalf("expected PhoneticName %q, got %q", "Fairy", pilots[0].PhoneticName)
	}

	// External LapRF setup sync (without PhoneticName) preserves existing PhoneticName
	eng.ApplyLapRFSetup(map[int]domain.PilotSlot{
		1: {
			SlotIndex:    1,
			Enabled:      true,
			Band:         domain.BandRaceband,
			Channel:      2,
			FrequencyMHz: 5695,
		},
	})
	pilots, _, _, _, _ = eng.StateSnapshot()
	if pilots[0].PhoneticName != "Fairy" || pilots[0].Channel != 2 {
		t.Fatalf("expected PhoneticName preserved across ApplyLapRFSetup, got phonetic=%q ch=%d", pilots[0].PhoneticName, pilots[0].Channel)
	}

	// Clearing PhoneticName via UpdatePilotSlot sets it back to ""
	p0 = pilots[0]
	p0.PhoneticName = "   "
	if err := eng.UpdatePilotSlot(p0); err != nil {
		t.Fatalf("unexpected UpdatePilotSlot error: %v", err)
	}
	pilots, _, _, _, _ = eng.StateSnapshot()
	if pilots[0].PhoneticName != "" {
		t.Fatalf("expected cleared PhoneticName to be empty, got %q", pilots[0].PhoneticName)
	}
}

func TestPilotCallsignUniqueness(t *testing.T) {
	eng := NewEngine()

	// 1. AddPilot rejects duplicate callsign case-insensitively
	if err := eng.AddPilot("  faerry  ", ""); err == nil {
		t.Fatalf("expected AddPilot to reject duplicate callsign 'faerry'")
	}

	// 2. AddPilot("") skips colliding "Pilot N" default names
	pilots, _, _, _, _ := eng.StateSnapshot()
	p1 := pilots[1]
	p1.Callsign = "Pilot 11"
	if err := eng.UpdatePilotSlot(p1); err != nil {
		t.Fatalf("unexpected rename error: %v", err)
	}
	if err := eng.AddPilot("", ""); err != nil {
		t.Fatalf("expected blank AddPilot to auto-pick next free Pilot N, got: %v", err)
	}
	pilots, _, _, _, _ = eng.StateSnapshot()
	added := pilots[len(pilots)-1]
	if added.Callsign != "Pilot 12" {
		t.Fatalf("expected auto-picked callsign 'Pilot 12', got %q", added.Callsign)
	}

	// 3. UpdatePilotSlot rejects renaming onto another pilot's callsign, allows keeping own callsign with different casing
	p0 := pilots[0]
	p0.Callsign = "pilot 11"
	if err := eng.UpdatePilotSlot(p0); err == nil {
		t.Fatalf("expected UpdatePilotSlot to reject duplicate callsign 'pilot 11'")
	}
	p0.Callsign = "Faerry"
	if err := eng.UpdatePilotSlot(p0); err != nil {
		t.Fatalf("expected UpdatePilotSlot to allow casing change on same slot, got: %v", err)
	}

	// 4. EventAction("add_race_pilot") rejects duplicate callsign
	if _, err := eng.EventAction(EventActionPayload{Action: "create_race", Name: "Walkup Test"}); err != nil {
		t.Fatalf("create_race failed: %v", err)
	}
	if _, err := eng.EventAction(EventActionPayload{Action: "add_race_pilot", Callsign: "faerry"}); err == nil {
		t.Fatalf("expected add_race_pilot to reject duplicate callsign 'faerry'")
	}
	if _, err := eng.EventAction(EventActionPayload{Action: "add_race_pilot", Callsign: "SkyRipper"}); err != nil {
		t.Fatalf("expected unique walk-up pilot 'SkyRipper' to succeed, got: %v", err)
	}

	// 5. PracticeAction("add_session_pilot") rejects creating duplicate callsign
	ps := eng.PracticeSnapshot()
	if len(ps.Sessions) > 0 {
		if _, err := eng.PracticeAction(PracticeActionPayload{
			Action:    "add_session_pilot",
			SessionID: ps.Sessions[0].SessionID,
			Callsign:  "skyripper",
		}); err == nil {
			t.Fatalf("expected add_session_pilot to reject duplicate callsign 'skyripper'")
		}
	}
}


