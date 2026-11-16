package tracker

import (
	"fmt"
	"strings"
	"testing"

	"slaprf/internal/domain"
)

func TestUnlimitedPilotRosterAndNonDestructiveCSVMerge(t *testing.T) {
	e := NewEngine()
	initPilots, _, _, _, _ := e.StateSnapshot()
	initialCount := len(initPilots)
	if initialCount == 0 {
		t.Fatalf("expected default pilots")
	}

	// 1. Verify adding well past 128 pilots succeeds and assigns colors cleanly without panicking.
	for i := initialCount + 1; i <= 150; i++ {
		if err := e.AddPilot(fmt.Sprintf("Racer_%03d", i), fmt.Sprintf("Racer %d", i)); err != nil {
			t.Fatalf("AddPilot %d failed (should have no 128 cap): %v", i, err)
		}
	}
	snap150, _, _, _, _ := e.StateSnapshot()
	if len(snap150) != 150 {
		t.Fatalf("expected 150 pilots, got %d", len(snap150))
	}
	if snap150[149].Color == "" {
		t.Fatalf("expected color assigned for slot 150")
	}
	// Verify SetGateThresholds on slot > 128 does not panic.
	if err := e.SetGateThresholds([]domain.GateThresholdUpdate{
		{GateID: 1, SlotIndex: snap150[149].SlotIndex, EnterDbm: -55, ExitDbm: -66},
	}); err != nil {
		t.Fatalf("SetGateThresholds for pilot > 128 failed: %v", err)
	}

	// 2. Export CSV and verify header + pilot rows.
	exported := e.ExportPilotsCSV()
	if !strings.HasPrefix(exported, "callsign,phonetic_name,channel,enter_threshold_dbm,exit_threshold_dbm,laprf_gain,laprf_threshold,rh_enter_threshold,rh_exit_threshold\n") {
		t.Fatalf("unexpected CSV header: %q", exported[:min(len(exported), 120)])
	}
	if !strings.Contains(exported, "FAERRY,") || !strings.Contains(exported, "Racer_150,Racer 150,") {
		t.Fatalf("exported CSV missing expected pilots")
	}

	// 3. Non-destructive merge import: update existing pilot FAERRY (case-insensitively) + add 2 brand-new pilots,
	// while keeping all 150 existing pilots intact!
	externalCSV := "\uFEFFpilot_name,phonetic,channel,enter_threshold_dbm\n" +
		"faerry,Fairy Pro,R4,-52\n" +
		"ExternalOne,Ex One,R6,-54\n" +
		"ExternalTwo,Ex Two,5880,\n"

	summary, err := e.ImportPilotsCSV(externalCSV)
	if err != nil {
		t.Fatalf("ImportPilotsCSV failed: %v", err)
	}
	if summary.Added != 2 || summary.Updated != 1 || summary.Total != 152 {
		t.Fatalf("unexpected import summary: %+v", summary)
	}

	merged, _, _, _, _ := e.StateSnapshot()
	if len(merged) != 152 {
		t.Fatalf("expected 152 pilots after non-destructive merge, got %d", len(merged))
	}
	if merged[0].SlotIndex != 1 || merged[0].Callsign != "faerry" || merged[0].PhoneticName != "Fairy Pro" || merged[0].Channel != 4 || merged[0].EnterThreshold != -52 {
		t.Fatalf("expected FAERRY slot 1 updated in place, got %+v", merged[0])
	}
	ext2 := merged[len(merged)-1]
	if ext2.Callsign != "ExternalTwo" || ext2.Channel != 7 || ext2.FrequencyMHz != 5880 {
		t.Fatalf("expected ExternalTwo resolved to R7 (5880 MHz), got %+v", ext2)
	}
}
