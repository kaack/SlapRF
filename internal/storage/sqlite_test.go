//go:build !js

package storage

import (
	"path/filepath"
	"testing"

	"slaprf/internal/domain"
	"slaprf/internal/tracker"
)

func TestSQLiteStoreRoundTripAndRealEngineRehydration(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "test-slaprf.db")
	store, err := NewSQLiteStore(dbPath)
	if err != nil {
		t.Fatalf("NewSQLiteStore failed: %v", err)
	}
	defer store.Close()

	// Empty DB returns found=false
	if _, found, err := store.Load(); err != nil || found {
		t.Fatalf("expected empty DB (found=false, err=nil), got found=%v err=%v", found, err)
	}

	realEng := tracker.NewRealEngine()
	_, _ = realEng.ProvisionGate(tracker.ProvisionRequest{
		Role:        "hub",
		Label:       "H1",
		Profile:     "open-ground",
		Fingerprint: "A0767469",
	})
	// The Hub is a gate-less USB collector, so the Spoke's gate is the course's only (start/finish) gate.
	spokeGateID, _ := realEng.ProvisionGate(tracker.ProvisionRequest{
		Role:        "spoke",
		Label:       "S1",
		Profile:     "open-ground",
		Fingerprint: "DA9B4CA7",
	})

	realEng.SetRules(domain.TimingRules{
		MinLapSec:       6.5,
		MaxLapSec:       95,
		GateCooldownSec: 2.5,
		MinSectionSec:   0.8,
		EchoWindowSec:   3.5,
	})
	realEng.UpdatePilotSlot(domain.PilotSlot{
		SlotIndex:       1,
		Callsign:        "KAPTAIN",
		Enabled:         true,
		Band:            domain.BandRaceband,
		Channel:         2,
		EnterThreshold:  -52,
		ExitThreshold:   -62,
		AttenuationGain: 60,
		Color:           "#ff0055",
	})
	_ = realEng.SetGateThresholds([]domain.GateThresholdUpdate{
		{GateID: spokeGateID, SlotIndex: 1, EnterDbm: -49},
	})

	snap := realEng.ExportState()
	snap.Laps = []domain.LapRecord{
		{
			LapID:         1,
			SlotIndex:     1,
			Callsign:      "KAPTAIN",
			LapNumber:     1,
			LapTimeSec:    14.25,
			CompletedAtUs: 25_000_000,
			IsBestLap:     true,
			Sectors: []domain.SectorSplit{
				{SectorIndex: 1, FromGateID: 1, ToGateID: 2, Label: "H1 -> S1", SplitSeconds: 7.10, ExitSpeedMph: 58.2},
				{SectorIndex: 2, FromGateID: 2, ToGateID: 1, Label: "S1 -> H1", SplitSeconds: 7.15, ExitSpeedMph: 60.4},
			},
		},
	}
	snap.Crossings = []domain.GateCrossingEvent{
		{
			EventID:       1,
			GateID:        1,
			GateName:      "H1",
			IsStartFinish: true,
			StartedLap:    true,
			PassingNumber: 1,
			SlotIndex:     1,
			Callsign:      "KAPTAIN",
			FrequencyMHz:  5695,
			TimestampUs:   10_750_000,
			PeakRSSIDbm:   -32.5,
		},
		{
			EventID:       2,
			GateID:        1,
			GateName:      "H1",
			IsStartFinish: true,
			StartedLap:    false,
			PassingNumber: 2,
			SlotIndex:     1,
			Callsign:      "KAPTAIN",
			FrequencyMHz:  5695,
			TimestampUs:   25_000_000,
			PeakRSSIDbm:   -31.0,
		},
	}

	origState := RealBackendState{
		Engine:          snap,
		LiveTimeEnabled: true,
	}

	if err := store.Save(origState); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	// Re-open SQLite file from disk to verify persistence across process restarts
	_ = store.Close()
	store2, err := NewSQLiteStore(dbPath)
	if err != nil {
		t.Fatalf("re-open NewSQLiteStore failed: %v", err)
	}
	defer store2.Close()

	loaded, found, err := store2.Load()
	if err != nil || !found || loaded == nil {
		t.Fatalf("Load failed: found=%v err=%v", found, err)
	}
	if !loaded.LiveTimeEnabled {
		t.Errorf("expected LiveTimeEnabled=true")
	}

	// Rehydrate fresh realEngine and verify state
	realEng2 := tracker.NewRealEngine()
	realEng2.RestoreState(loaded.Engine, false)

	pilots2, gates2, laps2, crossings2, summaries2 := realEng2.StateSnapshot()
	if pilots2[0].Callsign != "KAPTAIN" || pilots2[0].Channel != 2 {
		t.Errorf("pilot 1 not restored: %+v", pilots2[0])
	}
	if gates2[0].EnterThresholds[0] != -49 {
		t.Errorf("gate 1 threshold not restored: %v", gates2[0].EnterThresholds)
	}
	if len(laps2) != 1 || laps2[0].LapTimeSec != 14.25 {
		t.Errorf("laps not restored: %+v", laps2)
	}
	if len(crossings2) != 2 {
		t.Errorf("crossings count mismatch: got %d, want 2", len(crossings2))
	}
	if len(summaries2) == 0 || summaries2[0].BestLapSec != 14.25 {
		t.Errorf("expected restored summaries with BestLapSec=14.25, got %+v", summaries2)
	}

	realTimers := realEng2.DetectedTimersSnapshot()
	if len(realTimers) != 2 || realTimers[0].Fingerprint != "A0767469" || realTimers[1].Fingerprint != "DA9B4CA7" {
		t.Errorf("real timers not restored: %+v", realTimers)
	}
	if realTimers[0].Online || realTimers[1].Online {
		t.Errorf("expected restored real timers to start offline until live UDP packets arrive")
	}
}
