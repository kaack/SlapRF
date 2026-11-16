package tracker

import (
	"testing"

	"slaprf/internal/domain"
)

func TestRandomCountdownAndHeatRssiLapEditing(t *testing.T) {
	e := setupEightPilotRaceEngine(t, "RSSI Lap Editor Race")

	cfg := e.RaceSnapshot().Config
	cfg.CountdownSec = 5
	cfg.TargetLaps = 3
	e.ConfigureAndGenerateRaceWithOptions(cfg, true, false)

	// Start heat: verify nominal 5s countdown display & randomized horn within [1.75s, 5.0s]
	st, err := e.RaceControlAction("start", "")
	if err != nil {
		t.Fatalf("start heat failed: %v", err)
	}
	if len(st.Heats) == 0 {
		t.Fatalf("expected at least 1 heat")
	}
	h0 := st.Heats[0]
	if h0.State != domain.HeatCountdown {
		t.Fatalf("expected HeatCountdown, got %s", h0.State)
	}
	if h0.CountdownDurationSec != 5 || h0.CountdownRemainingSec != 5.0 {
		t.Fatalf("expected nominal 5.0s countdown display, got duration=%d remaining=%.2f", h0.CountdownDurationSec, h0.CountdownRemainingSec)
	}
	if h0.CountdownPromptUs == 0 || h0.CountdownStartUs <= h0.CountdownPromptUs {
		t.Fatalf("expected arming pause before countdown prompt and start, got prompt=%d start=%d", h0.CountdownPromptUs, h0.CountdownStartUs)
	}
	if h0.CountdownArmRemainingSec < 4.5 {
		t.Fatalf("expected ~4.8s arming lead before countdown starts, got %.2fs", h0.CountdownArmRemainingSec)
	}
	durUs := h0.CountdownEndUs - h0.CountdownStartUs
	if durUs < 1_750_000 || durUs > 5_000_000 {
		t.Fatalf("expected randomized countdown in [1.75s, 5.0s], got %d us", durUs)
	}
	// Tick at CountdownPromptUs ("In less than 5"): clock still holds at 5.0s until CountdownStartUs
	e.mu.Lock()
	_, promptAnn, _, _, _, _ := e.tickRaceClockLocked(h0.CountdownPromptUs)
	e.mu.Unlock()
	if promptAnn == nil || promptAnn.Kind != "countdown_prompt" || promptAnn.CountdownSec != 5 {
		t.Fatalf("expected countdown_prompt announcement after arming pause, got %+v", promptAnn)
	}
	if snapHold := e.RaceSnapshot().Heats[0]; snapHold.CountdownRemainingSec != 5.0 {
		t.Fatalf("expected clock to hold at 5.0s until CountdownStartUs, got %.2f", snapHold.CountdownRemainingSec)
	}

	seat0 := h0.Seats[0]
	slotIdx := seat0.PilotSlotIndex - 1
	_, gates, _, _, _ := e.StateSnapshot()
	sfTimerID := gates[0].AssignedTimerID

	// Ingest pre-horn telemetry samples during countdown
	sendRssi := func(tsUs uint64, rssiSeat float32) {
		var f domain.TimerTelemetryFrame
		f.TimerID = sfTimerID
		f.TimestampUs = tsUs
		for i := range f.RSSI {
			f.RSSI[i] = -95
		}
		if slotIdx >= 0 && slotIdx < len(f.RSSI) {
			f.RSSI[slotIdx] = rssiSeat
		}
		e.IngestTelemetryFrame(f)
	}
	sendRssi(h0.CountdownEndUs-500_000, -88)
	sendRssi(h0.CountdownEndUs-200_000, -86)

	// Advance clock past start horn via telemetry frame and ingest running RSSI samples
	hornUs := h0.CountdownEndUs
	sendRssi(hornUs+200_000, -85)
	sendRssi(hornUs+1_000_000, -42) // Peak inside bucket
	sendRssi(hornUs+1_030_000, -38) // Higher peak inside same 95ms bucket -> peak-preserving!
	sendRssi(hornUs+5_000_000, -86)
	sendRssi(hornUs+13_000_000, -40)
	sendRssi(hornUs+25_500_000, -68)

	st = e.RaceSnapshot()
	if !st.Heats[0].CountdownBeeped {
		t.Fatalf("expected CountdownBeeped to be recorded when start horn fires")
	}
	expectedBeepSec := float64(uint64(5_000_000)-durUs) / 1e6
	if diff := st.Heats[0].CountdownBeepAtSec - expectedBeepSec; diff < -0.02 || diff > 0.02 {
		t.Fatalf("expected CountdownBeepAtSec ~ %.2fs, got %.2fs", expectedBeepSec, st.Heats[0].CountdownBeepAtSec)
	}
	seat := st.Heats[0].Seats[0]
	if len(seat.RssiTrace) < 5 {
		t.Fatalf("expected recorded RssiTrace points, got %d", len(seat.RssiTrace))
	}
	if seat.RssiTrace[0].OffsetMs >= 0 {
		t.Fatalf("expected pre-horn sample to be shifted to negative OffsetMs, got %d", seat.RssiTrace[0].OffsetMs)
	}

	// Reset crossings so we test manual add_crossing / move_crossing / delete_crossing deterministically
	for len(seat.Crossings) > 0 {
		cid := seat.Crossings[0].CrossingID
		st, err = e.MarshalPilotAction(RaceMarshalPayload{
			HeatID:         st.Heats[0].ID,
			PilotSlotIndex: seat.PilotSlotIndex,
			Action:         "delete_crossing",
			CrossingID:     cid,
		})
		if err != nil {
			t.Fatalf("cleanup delete_crossing failed: %v", err)
		}
		seat = st.Heats[0].Seats[0]
	}

	// Add manual crossings at +1000ms (HS), +13000ms (L1), and +25500ms (L2)
	addAt := func(ms int64) domain.RaceTournamentState {
		res, err := e.MarshalPilotAction(RaceMarshalPayload{
			HeatID:         st.Heats[0].ID,
			PilotSlotIndex: seat.PilotSlotIndex,
			Action:         "add_crossing",
			OffsetMs:       &ms,
		})
		if err != nil {
			t.Fatalf("add_crossing(%d) failed: %v", ms, err)
		}
		return res
	}
	addAt(1000)
	addAt(13000)
	st = addAt(25500)

	seat = st.Heats[0].Seats[0]
	if seat.LapsCompleted != 2 {
		t.Fatalf("expected 2 completed laps (HS + L1 + L2), got %d", seat.LapsCompleted)
	}
	if seat.BestLapSec != 12.0 {
		t.Fatalf("expected BestLapSec 12.0s (13.0 - 1.0), got %.3f", seat.BestLapSec)
	}
	if len(seat.Crossings) != 3 || seat.Crossings[0].PeakRSSIDbm == 0 {
		t.Fatalf("expected 3 crossings with sampled PeakRSSIDbm, got %+v", seat.Crossings)
	}

	// Move L2 crossing from 25500ms -> 24250ms (split becomes 11.25s -> new BestLapSec!)
	newMs := int64(24250)
	l2Cid := seat.Crossings[2].CrossingID
	st, err = e.MarshalPilotAction(RaceMarshalPayload{
		HeatID:         st.Heats[0].ID,
		PilotSlotIndex: seat.PilotSlotIndex,
		Action:         "move_crossing",
		CrossingID:     l2Cid,
		OffsetMs:       &newMs,
	})
	if err != nil {
		t.Fatalf("move_crossing failed: %v", err)
	}
	seat = st.Heats[0].Seats[0]
	if seat.BestLapSec != 11.25 {
		t.Fatalf("expected updated BestLapSec 11.25s after move_crossing, got %.3f", seat.BestLapSec)
	}

	// Delete L2 crossing -> back to 1 lap completed
	st, err = e.MarshalPilotAction(RaceMarshalPayload{
		HeatID:         st.Heats[0].ID,
		PilotSlotIndex: seat.PilotSlotIndex,
		Action:         "delete_crossing",
		CrossingID:     l2Cid,
	})
	if err != nil {
		t.Fatalf("delete_crossing failed: %v", err)
	}
	seat = st.Heats[0].Seats[0]
	if seat.LapsCompleted != 1 || len(seat.Crossings) != 2 {
		t.Fatalf("expected 1 lap and 2 crossings after delete_crossing, got laps=%d crossings=%d", seat.LapsCompleted, len(seat.Crossings))
	}
}
