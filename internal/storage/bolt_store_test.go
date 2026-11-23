package storage

import (
	"path/filepath"
	"testing"

	"slaprf/internal/domain"
	"slaprf/internal/ingest"
	"slaprf/internal/tracker"
)

func TestBoltStoreRoundTripAndPersistenceWorker(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "slaprf.db")
	store, err := OpenBoltStore(dbPath)
	if err != nil {
		t.Fatalf("OpenBoltStore failed: %v", err)
	}

	simEng := tracker.NewEngine()
	realEng := tracker.NewRealEngine()
	sim := ingest.NewTrackSimulator(simEng)

	// Customize a real pilot callsign & hardware mode
	pilots, _, _, _, _ := realEng.StateSnapshot()
	p0 := pilots[0]
	p0.Callsign = "MAVERICK"
	if err := realEng.UpdatePilotSlot(p0); err != nil {
		t.Fatalf("UpdatePilotSlot: %v", err)
	}
	realEng.SetTimingHardwareMode(domain.HardwareModeRotorHazard, false)
	sim.SetRunning(false)
	sim.SetSpeedMultiplier(20)

	worker := NewPersistenceWorker(store, simEng, realEng, sim, nil)
	worker.SaveMode(false)

	// Append a real lap and crossing directly via store batching
	if err := store.AppendEvents(false, EventBatch{
		Laps: []domain.LapRecord{
			{LapID: 1, SlotIndex: 1, Callsign: "MAVERICK", LapNumber: 1, LapTimeSec: 12.34, CompletedAtUs: 25_000_000},
		},
		Crossings: []domain.GateCrossingEvent{
			{EventID: 1, GateID: 1, SlotIndex: 1, Callsign: "MAVERICK", TimestampUs: 25_000_000, PeakRSSIDbm: -54},
		},
	}); err != nil {
		t.Fatalf("AppendEvents: %v", err)
	}
	if err := store.SaveConfigSnapshot(false, realEng.ExportState(), nil); err != nil {
		t.Fatalf("SaveConfigSnapshot: %v", err)
	}
	opts := sim.ExportOptions()
	if err := store.SaveConfigSnapshot(true, simEng.ExportState(), &opts); err != nil {
		t.Fatalf("SaveConfigSnapshot sim: %v", err)
	}

	st := store.Status()
	if st.Backend != "bbolt" || st.SizeBytes <= 0 || st.RealLapsCount != 1 {
		t.Fatalf("unexpected status: %+v", st)
	}

	// Close without full reconcile first to verify incremental AppendEvents + SaveConfigSnapshot reload cleanly!
	_ = store.Close()

	// Reopen and hydrate fresh engines
	store2, err := OpenBoltStore(dbPath)
	if err != nil {
		t.Fatalf("reopen OpenBoltStore failed: %v", err)
	}
	defer store2.Close()

	simEng2 := tracker.NewEngine()
	realEng2 := tracker.NewRealEngine()
	sim2 := ingest.NewTrackSimulator(simEng2)
	worker2 := NewPersistenceWorker(store2, simEng2, realEng2, sim2, nil)
	simRunning := worker2.Hydrate()
	if simRunning {
		t.Fatalf("expected hydrated simRunning = false")
	}
	if realEng2.TimingHardwareMode() != domain.HardwareModeRotorHazard {
		t.Fatalf("TimingHardwareMode = %q, want rotorhazard", realEng2.TimingHardwareMode())
	}
	pilots2, _, laps2, crossings2, _ := realEng2.StateSnapshot()
	if pilots2[0].Callsign != "MAVERICK" {
		t.Fatalf("pilot[0].Callsign = %q, want MAVERICK", pilots2[0].Callsign)
	}
	if len(laps2) != 1 || laps2[0].LapTimeSec != 12.34 {
		t.Fatalf("restored laps = %+v, want 1 lap of 12.34s", laps2)
	}
	if len(crossings2) != 1 {
		t.Fatalf("restored crossings = %d, want 1", len(crossings2))
	}
	if sim2.Snapshot().SpeedMultiplier != 20 {
		t.Fatalf("restored sim SpeedMultiplier = %d, want 20", sim2.Snapshot().SpeedMultiplier)
	}

	// Test Wipe preserves BLE host pairing key while clearing laps
	const wantHostKey = "0123456789ABCDEF0123456789ABCDEF"
	if err := store2.PutJSON(KeyBLEHostKey, wantHostKey); err != nil {
		t.Fatalf("PutJSON KeyBLEHostKey: %v", err)
	}
	if err := store2.Wipe(true); err != nil {
		t.Fatalf("Wipe failed: %v", err)
	}
	if store2.Status().RealLapsCount != 0 {
		t.Fatalf("expected 0 real laps after Wipe")
	}
	var gotHostKey string
	if ok, err := store2.GetJSON(KeyBLEHostKey, &gotHostKey); err != nil || !ok || gotHostKey != wantHostKey {
		t.Fatalf("expected Wipe to preserve KeyBLEHostKey=%q, got ok=%v key=%q err=%v", wantHostKey, ok, gotHostKey, err)
	}
}
