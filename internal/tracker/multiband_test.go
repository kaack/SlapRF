package tracker

import (
	"strings"
	"testing"

	"slaprf/internal/domain"
)

func TestMultiBandEncodingAndLookup(t *testing.T) {
	cases := []struct {
		band  domain.Band
		ch    uint8
		code  uint8
		freq  uint16
		short string
	}{
		{domain.BandRaceband, 1, 1, 5658, "R1"},
		{domain.BandRaceband, 8, 8, 5917, "R8"},
		{domain.BandFatshark, 4, 24, 5800, "F4"},
		{domain.BandFatshark, 8, 28, 5880, "F8"},
		{domain.BandBoscamE, 1, 31, 5705, "E1"},
		{domain.BandBoscamE, 7, 37, 5925, "E7"},
		{domain.BandBoscamA, 1, 41, 5865, "A1"},
		{domain.BandBoscamA, 8, 48, 5725, "A8"},
		{domain.BandIMD6, 3, 53, 5760, "I3"},
		{domain.BandIMD6, 6, 56, 5917, "I6"},
		{domain.BandBoscamB, 2, 62, 5752, "B2"},
		{domain.BandBoscamB, 8, 68, 5866, "B8"},
	}

	for _, tc := range cases {
		gotCode := domain.EncodeBandChannel(tc.band, tc.ch)
		if gotCode != tc.code {
			t.Fatalf("%s: expected code %d, got %d", tc.short, tc.code, gotCode)
		}
		gotBand, gotCh, gotFreq, ok := domain.DecodeBandChannel(gotCode)
		if !ok || gotBand != tc.band || gotCh != tc.ch || gotFreq != tc.freq {
			t.Fatalf("%s: DecodeBandChannel(%d) = (%d, %d, %d, %v), want (%d, %d, %d, true)",
				tc.short, gotCode, gotBand, gotCh, gotFreq, ok, tc.band, tc.ch, tc.freq)
		}
		if gotShort := domain.BandShortCode(tc.band, tc.ch); gotShort != tc.short {
			t.Fatalf("BandShortCode(%d, %d) = %q, want %q", tc.band, tc.ch, gotShort, tc.short)
		}
	}

	// LookupBandChannelByFreqMHz resolves distinct non-Raceband frequencies accurately
	if b, ch, ok := domain.LookupBandChannelByFreqMHz(5800); !ok || b != domain.BandFatshark || ch != 4 {
		t.Fatalf("expected 5800 MHz -> F4, got (%d, %d, %v)", b, ch, ok)
	}
	if b, ch, ok := domain.LookupBandChannelByFreqMHz(5865); !ok || b != domain.BandBoscamA || ch != 1 {
		t.Fatalf("expected 5865 MHz -> A1, got (%d, %d, %v)", b, ch, ok)
	}
	if b, ch, ok := domain.LookupBandChannelByFreqMHz(5752); !ok || b != domain.BandBoscamB || ch != 2 {
		t.Fatalf("expected 5752 MHz -> B2, got (%d, %d, %v)", b, ch, ok)
	}
	if b, ch, ok := domain.LookupBandChannelByFreqMHz(5925); !ok || b != domain.BandBoscamE || ch != 7 {
		t.Fatalf("expected 5925 MHz -> E7, got (%d, %d, %v)", b, ch, ok)
	}
}

func TestMultiBandPilotCSVAndCrossBandConflict(t *testing.T) {
	eng := NewEngine()
	pilots, _, _, _, _ := eng.StateSnapshot()
	if len(pilots) < 4 {
		t.Fatalf("expected default pilots, got %d", len(pilots))
	}

	// Assign Pilot 1 -> F4 (5800), Pilot 2 -> A1 (5865), Pilot 3 -> B2 (5752), Pilot 4 -> E7 (5925)
	p1 := pilots[0]
	p1.Band = domain.BandFatshark
	p1.Channel = 4
	p1.FrequencyMHz = 0
	if err := eng.UpdatePilotSlot(p1); err != nil {
		t.Fatalf("UpdatePilotSlot F4 failed: %v", err)
	}

	p2 := pilots[1]
	p2.Band = domain.BandBoscamA
	p2.Channel = 1
	p2.FrequencyMHz = 0
	if err := eng.UpdatePilotSlot(p2); err != nil {
		t.Fatalf("UpdatePilotSlot A1 failed: %v", err)
	}

	p3 := pilots[2]
	p3.Band = domain.BandBoscamB
	p3.Channel = 2
	p3.FrequencyMHz = 0
	if err := eng.UpdatePilotSlot(p3); err != nil {
		t.Fatalf("UpdatePilotSlot B2 failed: %v", err)
	}

	p4 := pilots[3]
	p4.Band = domain.BandBoscamE
	p4.Channel = 7
	p4.FrequencyMHz = 0
	if err := eng.UpdatePilotSlot(p4); err != nil {
		t.Fatalf("UpdatePilotSlot E7 failed: %v", err)
	}

	updated, _, _, _, _ := eng.StateSnapshot()
	if updated[0].FrequencyMHz != 5800 || updated[0].ChannelLabel() != "F4 (5800 MHz)" {
		t.Fatalf("unexpected Pilot 1: freq=%d label=%q", updated[0].FrequencyMHz, updated[0].ChannelLabel())
	}
	if updated[1].FrequencyMHz != 5865 || updated[1].ChannelLabel() != "A1 (5865 MHz)" {
		t.Fatalf("unexpected Pilot 2: freq=%d label=%q", updated[1].FrequencyMHz, updated[1].ChannelLabel())
	}
	if updated[2].FrequencyMHz != 5752 || updated[2].ChannelLabel() != "B2 (5752 MHz)" {
		t.Fatalf("unexpected Pilot 3: freq=%d label=%q", updated[2].FrequencyMHz, updated[2].ChannelLabel())
	}
	if updated[3].FrequencyMHz != 5925 || updated[3].ChannelLabel() != "E7 (5925 MHz)" {
		t.Fatalf("unexpected Pilot 4: freq=%d label=%q", updated[3].FrequencyMHz, updated[3].ChannelLabel())
	}

	// CSV export & re-import into a fresh engine preserves all bands & frequencies
	csvStr := eng.ExportPilotsCSV()
	if !strings.Contains(csvStr, ",F4,") || !strings.Contains(csvStr, ",A1,") || !strings.Contains(csvStr, ",B2,") || !strings.Contains(csvStr, ",E7,") {
		t.Fatalf("expected CSV to contain F4, A1, B2, E7 codes; got:\n%s", csvStr)
	}

	eng2 := NewEngine()
	if _, err := eng2.ImportPilotsCSV(csvStr); err != nil {
		t.Fatalf("ImportPilotsCSV failed: %v", err)
	}
	imp, _, _, _, _ := eng2.StateSnapshot()
	if imp[0].Band != domain.BandFatshark || imp[0].Channel != 4 || imp[0].FrequencyMHz != 5800 {
		t.Fatalf("CSV import F4 mismatch: %+v", imp[0])
	}
	if imp[1].Band != domain.BandBoscamA || imp[1].Channel != 1 || imp[1].FrequencyMHz != 5865 {
		t.Fatalf("CSV import A1 mismatch: %+v", imp[1])
	}
	if imp[2].Band != domain.BandBoscamB || imp[2].Channel != 2 || imp[2].FrequencyMHz != 5752 {
		t.Fatalf("CSV import B2 mismatch: %+v", imp[2])
	}
	if imp[3].Band != domain.BandBoscamE || imp[3].Channel != 7 || imp[3].FrequencyMHz != 5925 {
		t.Fatalf("CSV import E7 mismatch: %+v", imp[3])
	}
}

func TestMultiBandPracticeAndRaceSeats(t *testing.T) {
	eng := NewEngine()
	pm := eng.PracticeSnapshot()
	if len(pm.Sessions) == 0 {
		t.Fatalf("expected default practice session")
	}
	sessID := pm.Sessions[0].SessionID
	p1Slot := pm.Sessions[0].Pilots[0].SlotIndex
	p2Slot := pm.Sessions[0].Pilots[1].SlotIndex

	// Assign Pilot 1 in Practice to R7 (5880 MHz)
	if _, err := eng.PracticeAction(PracticeActionPayload{
		Action:    "set_session_pilot_channel",
		SessionID: sessID,
		SlotIndex: p1Slot,
		Band:      domain.BandRaceband,
		Channel:   7,
	}); err != nil {
		t.Fatalf("set R7 failed: %v", err)
	}

	// Assign Pilot 2 in Practice to F8 (also 5880 MHz!) -> must blank out Pilot 1's colliding 5880 MHz!
	stAfter, err := eng.PracticeAction(PracticeActionPayload{
		Action:    "set_session_pilot_channel",
		SessionID: sessID,
		SlotIndex: p2Slot,
		Band:      domain.BandFatshark,
		Channel:   8,
	})
	if err != nil {
		t.Fatalf("set F8 failed: %v", err)
	}
	sess := stAfter.Sessions[0]
	for _, sp := range sess.Pilots {
		if sp.SlotIndex == p1Slot && sp.Channel != 0 {
			t.Fatalf("expected colliding R7 (5880) pilot to be cleared when F8 (5880) was assigned, got ch=%d", sp.Channel)
		}
		if sp.SlotIndex == p2Slot {
			if sp.Band != domain.BandFatshark || sp.Channel != 8 || sp.FrequencyMHz != 5880 {
				t.Fatalf("expected Pilot 2 on F8 (5880), got %+v", sp)
			}
		}
	}

	// Create a Race and configure multi-band SeatChannels [F4 (24), A1 (41), B2 (62), E1 (31)]
	rsCreated, err := eng.EventAction(EventActionPayload{
		Action: "create_race",
		Name:   "MultiBand Championship",
	})
	if err != nil {
		t.Fatalf("create_race failed: %v", err)
	}
	raceID := rsCreated.RaceID
	cfg := rsCreated.Config
	cfg.PilotsPerHeat = 4
	cfg.SeatChannels = domain.SeatChannelList{24, 41, 62, 31}
	rs := eng.ConfigureAndGenerateRace(cfg, true)
	if len(rs.Heats) == 0 {
		t.Fatalf("expected heats in race")
	}
	h0 := rs.Heats[0]
	if h0.Seats[0].Band != domain.BandFatshark || h0.Seats[0].Channel != 4 || h0.Seats[0].FrequencyMHz != 5800 {
		t.Fatalf("expected Seat 1 on F4 (5800), got %+v", h0.Seats[0])
	}
	if h0.Seats[1].Band != domain.BandBoscamA || h0.Seats[1].Channel != 1 || h0.Seats[1].FrequencyMHz != 5865 {
		t.Fatalf("expected Seat 2 on A1 (5865), got %+v", h0.Seats[1])
	}
	if h0.Seats[2].Band != domain.BandBoscamB || h0.Seats[2].Channel != 2 || h0.Seats[2].FrequencyMHz != 5752 {
		t.Fatalf("expected Seat 3 on B2 (5752), got %+v", h0.Seats[2])
	}
	if h0.Seats[3].Band != domain.BandBoscamE || h0.Seats[3].Channel != 1 || h0.Seats[3].FrequencyMHz != 5705 {
		t.Fatalf("expected Seat 4 on E1 (5705), got %+v", h0.Seats[3])
	}

	// Override Seat 1 to I3 (IMD6 ch 3 = 5760 MHz) via set_seat_channel
	rs2, err := eng.BracketEditAction(BracketEditPayload{
		Action:    "set_seat_channel",
		RaceID:    raceID,
		HeatID:    h0.ID,
		SeatIndex: 1,
		Band:      domain.BandIMD6,
		Channel:   3,
	})
	if err != nil {
		t.Fatalf("set_seat_channel I3 failed: %v", err)
	}
	if rs2.Heats[0].Seats[0].Band != domain.BandIMD6 || rs2.Heats[0].Seats[0].Channel != 3 || rs2.Heats[0].Seats[0].FrequencyMHz != 5760 {
		t.Fatalf("expected Seat 1 on I3 (5760), got %+v", rs2.Heats[0].Seats[0])
	}
}

func TestWipeApplicationDataAndRestoreDemoData(t *testing.T) {
	eng := NewEngine()
	// Verify initial engine has demo data
	pilots, gates, _, _, _ := eng.StateSnapshot()
	if len(pilots) == 0 || len(gates) == 0 {
		t.Fatalf("expected initial demo pilots and gates, got pilots=%d gates=%d", len(pilots), len(gates))
	}

	// Wipe application data: pilots, gates, timers, practices, and races must all be empty,
	// while rules/settings remain at clean defaults.
	eng.ResetToFactoryDefaults(true)
	pilots, gates, laps, crossings, _ := eng.StateSnapshot()
	timers := eng.DetectedTimersSnapshot()
	pm := eng.PracticeSnapshot()
	ev := eng.EventSnapshot()
	if len(pilots) != 0 || len(gates) != 0 || len(laps) != 0 || len(crossings) != 0 || len(timers) != 0 {
		t.Fatalf("expected wiped engine to have 0 pilots/gates/laps/crossings/timers, got %d/%d/%d/%d/%d",
			len(pilots), len(gates), len(laps), len(crossings), len(timers))
	}
	if len(pm.Sessions) != 0 || len(ev.Races) != 0 {
		t.Fatalf("expected 0 practice sessions and 0 races after wipe, got sessions=%d races=%d",
			len(pm.Sessions), len(ev.Races))
	}
	if eng.Rules().MinLapSec != domain.DefaultTimingRules().MinLapSec {
		t.Fatalf("expected default timing rules after wipe, got %+v", eng.Rules())
	}

	// RestoreDemoData repopulates Bay Area demo pilots, 4-gate track, timers, and Open Practice
	eng.RestoreDemoData()
	pilots, gates, _, _, _ = eng.StateSnapshot()
	timers = eng.DetectedTimersSnapshot()
	pm = eng.PracticeSnapshot()
	if len(pilots) == 0 || len(gates) == 0 || len(timers) == 0 || len(pm.Sessions) == 0 {
		t.Fatalf("expected demo data restored, got pilots=%d gates=%d timers=%d sessions=%d",
			len(pilots), len(gates), len(timers), len(pm.Sessions))
	}
}
