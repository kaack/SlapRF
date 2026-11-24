package slaprf

import (
	"path/filepath"
	"testing"

	"slaprf/internal/storage"
)

func TestKnownTimerRegistryUpsertSkipsBoltWriteWhenOnlyLastSeenChanges(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "slaprf.db")
	store, err := storage.OpenBoltStore(dbPath)
	if err != nil {
		t.Fatalf("open bolt store: %v", err)
	}
	defer store.Close()

	reg := NewKnownTimerRegistry(store)
	reg.Upsert(KnownHardwareTimer{
		FP:         "EFE44224",
		Role:       "hub",
		Label:      "H1",
		FW:         "0.0.12",
		Slot:       1,
		Channel:    6,
		PairedBLE:  true,
		LastSeenMs: 1_000,
	})

	readPersisted := func() KnownHardwareTimer {
		t.Helper()
		var list []KnownHardwareTimer
		ok, err := store.GetJSON(kvKnownTimersKey, &list)
		if err != nil || !ok || len(list) != 1 {
			t.Fatalf("expected 1 persisted timer, ok=%v err=%v len=%d", ok, err, len(list))
		}
		return list[0]
	}

	if got := readPersisted(); got.LastSeenMs != 1_000 {
		t.Fatalf("expected initial persisted LastSeenMs=1000, got %d", got.LastSeenMs)
	}

	// Steady-state 1 Hz STATUS? heartbeat where only LastSeenMs advances must update RAM
	// without triggering synchronous bbolt fdatasync writes on the reader goroutine.
	reg.Upsert(KnownHardwareTimer{
		FP:         "EFE44224",
		Role:       "hub",
		Label:      "H1",
		FW:         "0.0.12",
		Slot:       1,
		Channel:    6,
		PairedBLE:  true,
		LastSeenMs: 2_000,
	})

	inMem, ok := reg.Get("EFE44224")
	if !ok || inMem.LastSeenMs != 2_000 {
		t.Fatalf("expected in-memory LastSeenMs=2000, ok=%v got=%+v", ok, inMem)
	}
	if got := readPersisted(); got.LastSeenMs != 1_000 {
		t.Fatalf("expected BoltStore not to be rewritten when only LastSeenMs changed, got LastSeenMs=%d", got.LastSeenMs)
	}

	// Changing structural metadata (e.g. Channel) must persist immediately.
	reg.Upsert(KnownHardwareTimer{
		FP:         "EFE44224",
		Role:       "hub",
		Label:      "H1",
		FW:         "0.0.12",
		Slot:       1,
		Channel:    8,
		PairedBLE:  true,
		LastSeenMs: 3_000,
	})
	if got := readPersisted(); got.Channel != 8 || got.LastSeenMs != 3_000 {
		t.Fatalf("expected structural metadata update to persist Channel=8 LastSeenMs=3000, got %+v", got)
	}
}
