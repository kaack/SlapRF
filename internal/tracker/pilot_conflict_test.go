package tracker

import (
	"testing"
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
