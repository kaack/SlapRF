//go:build e2e

package e2e_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"slaprf/internal/api"
	"slaprf/internal/domain"
	"slaprf/internal/ingest"
	"slaprf/internal/laprf"
	"slaprf/internal/multigp"
	"slaprf/internal/tracker"
)

// SimSnapshotBundle matches cmd/slaprf-wasm/main.go's persistedSimBundle stored at
// IndexedDB ("slaprf" v1 -> "kv" -> "sim.state") so component tests can pre-seed
// SlapRF's full engine + simulator state from JSON fixtures in e2e/testdata/*.json.
type SimSnapshotBundle struct {
	Engine  tracker.PersistedEngineState `json:"engine"`
	Options ingest.SimPersistedOptions   `json:"options"`
}

const (
	SnapshotPracticePopulated   = "practice_populated.json"
	SnapshotRaceActiveControl   = "race_active_control.json"
	SnapshotRaceCompletedPodium = "race_completed_podium.json"
	SnapshotMultiGPSeeded       = "multigp_seeded.json"
	SnapshotLapRFModeSeeded     = "laprf_mode_seeded.json"
)

type snapshotSpec struct {
	FileName string
	Build    func() (SimSnapshotBundle, error)
}

func snapshotSpecs() []snapshotSpec {
	return []snapshotSpec{
		{FileName: SnapshotPracticePopulated, Build: buildSnapshotPracticePopulated},
		{FileName: SnapshotRaceActiveControl, Build: buildSnapshotRaceActiveControl},
		{FileName: SnapshotRaceCompletedPodium, Build: buildSnapshotRaceCompletedPodium},
		{FileName: SnapshotMultiGPSeeded, Build: buildSnapshotMultiGPSeeded},
		{FileName: SnapshotLapRFModeSeeded, Build: buildSnapshotLapRFModeSeeded},
	}
}

// ensureSnapshotFixtures guarantees that every deterministic JSON snapshot fixture in
// e2e/testdata/*.json exists and matches the current simulator model version.
func ensureSnapshotFixtures(testdataDir string) error {
	if err := os.MkdirAll(testdataDir, 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", testdataDir, err)
	}
	forceRegen := os.Getenv("SLAPRF_E2E_REGEN_SNAPSHOTS") == "1"

	for _, spec := range snapshotSpecs() {
		fullPath := filepath.Join(testdataDir, spec.FileName)
		if !forceRegen && snapshotFileValid(fullPath) {
			continue
		}
		bundle, err := spec.Build()
		if err != nil {
			return fmt.Errorf("build snapshot %s: %w", spec.FileName, err)
		}
		encoded, err := json.MarshalIndent(bundle, "", "  ")
		if err != nil {
			return fmt.Errorf("marshal snapshot %s: %w", spec.FileName, err)
		}
		encoded = append(encoded, '\n')
		if err := os.WriteFile(fullPath, encoded, 0o644); err != nil {
			return fmt.Errorf("write snapshot %s: %w", fullPath, err)
		}
	}
	return nil
}

func snapshotFileValid(fullPath string) bool {
	raw, err := os.ReadFile(fullPath)
	if err != nil || len(raw) == 0 {
		return false
	}
	var b SimSnapshotBundle
	if err := json.Unmarshal(raw, &b); err != nil {
		return false
	}
	if !ingest.SimStateCompatible(b.Options) {
		return false
	}
	return len(b.Engine.Pilots) > 0 && len(b.Engine.Gates) > 0
}

func loadSnapshotFixtureJSON(t *testing.T, name string) string {
	t.Helper()
	clean := strings.TrimSpace(name)
	if !strings.HasSuffix(clean, ".json") {
		clean += ".json"
	}
	fullPath := filepath.Join(suiteRepoRoot, "e2e", "testdata", clean)
	raw, err := os.ReadFile(fullPath)
	if err != nil {
		t.Fatalf("read snapshot fixture %s: %v", fullPath, err)
	}
	return string(raw)
}

func newBuilderEnv() (*tracker.Engine, *ingest.TrackSimulator, http.Handler) {
	simEngine := tracker.NewEngine()
	realEngine := tracker.NewRealEngine()
	sim := ingest.NewTrackSimulator(simEngine)
	laprfSrv := laprf.NewServer(simEngine)
	srv := api.NewServer(simEngine, sim, laprfSrv, realEngine)
	return simEngine, sim, srv.Handler()
}

// canonicalizeBundle round-trips a constructed snapshot through a fresh tracker.Engine +
// TrackSimulator so all summaries, sector records, standings, and timestamps match WASM boot.
func canonicalizeBundle(state tracker.PersistedEngineState, opts ingest.SimPersistedOptions) SimSnapshotBundle {
	state.SavedAtUnixUs = 0 // Avoid shifting monotonic offsets arbitrarily across days
	verifyEngine := tracker.NewEngine()
	verifySim := ingest.NewTrackSimulator(verifyEngine)
	verifyEngine.RestoreState(state, true)
	verifySim.RestoreOptions(opts)
	outEngine := verifyEngine.ExportState()
	outEngine.SavedAtUnixUs = 0
	outOpts := verifySim.ExportOptions()
	return SimSnapshotBundle{
		Engine:  outEngine,
		Options: outOpts,
	}
}

// buildSyntheticPracticeDataset creates rich multi-sector laps, crossings, and filtered detections
// across the 4 default course gates (G1 Start/Finish -> G2 -> G3 -> G4 -> G1):
//   - Slot 1 (Maverick): 6 laps, best 13.420s, overall purple on S1 (2.950s) & S3 (3.180s),
//     deliberate high variance on S2 (best 3.400s vs 3.92s..4.38s) so SectionStats highlights S2
//     with "Biggest opportunity" and PracticeRecommendation renders full coaching advice.
//   - Slot 2 (Iceman):   6 laps, best 13.680s, overall purple on S2 (3.120s).
//   - Slot 3 (Viper):    6 laps, best 13.910s, overall purple on S4 (3.210s).
//   - Slot 4 (Phoenix):  6 laps, best 14.350s.
func buildSyntheticPracticeDataset(pilots []domain.PilotSlot) ([]domain.LapRecord, []domain.GateCrossingEvent, []domain.FilteredDetection) {
	type pilotPlan struct {
		slot   int
		splits [6][4]float64
	}
	plans := []pilotPlan{
		{
			slot: 1,
			splits: [6][4]float64{
				{3.120, 4.180, 3.290, 3.450}, // 14.040
				{3.040, 3.950, 3.240, 3.390}, // 13.620
				{2.950, 3.400, 3.180, 3.890}, // 13.420 (best lap; S1 & S3 overall purple; S4 slightly off)
				{3.080, 4.380, 3.260, 3.360}, // 14.080 (S2 blowup)
				{3.010, 4.090, 3.220, 3.350}, // 13.670
				{2.990, 3.920, 3.210, 3.340}, // 13.460
			},
		},
		{
			slot: 2,
			splits: [6][4]float64{
				{3.210, 3.280, 3.490, 3.920}, // 13.900
				{3.160, 3.120, 3.440, 3.960}, // 13.680 (best lap; S2 overall purple)
				{3.190, 3.240, 3.470, 3.950}, // 13.850
				{3.250, 3.310, 3.520, 4.020}, // 14.100
				{3.180, 3.190, 3.460, 3.910}, // 13.740
				{3.220, 3.260, 3.480, 3.940}, // 13.900
			},
		},
		{
			slot: 3,
			splits: [6][4]float64{
				{3.320, 3.580, 3.690, 3.420}, // 14.010
				{3.290, 3.540, 3.660, 3.520}, // 14.010
				{3.270, 3.510, 3.920, 3.210}, // 13.910 (best lap; S4 overall purple)
				{3.350, 3.620, 3.740, 3.390}, // 14.100
				{3.310, 3.550, 3.680, 3.410}, // 13.950
				{3.300, 3.530, 3.670, 3.440}, // 13.940
			},
		},
		{
			slot: 4,
			splits: [6][4]float64{
				{3.450, 3.690, 3.720, 3.680}, // 14.540
				{3.410, 3.640, 3.680, 3.620}, // 14.350 (best lap)
				{3.480, 3.740, 3.790, 3.710}, // 14.720
				{3.440, 3.680, 3.710, 3.660}, // 14.490
				{3.520, 3.810, 3.840, 3.750}, // 14.920
				{3.430, 3.660, 3.700, 3.640}, // 14.430
			},
		},
	}

	sectionDefs := [4]struct {
		idx   int
		from  uint8
		to    uint8
		label string
	}{
		{1, 1, 2, "S1 (Start / Finish → Gate 2)"},
		{2, 2, 3, "S2 (Gate 2 → Gate 3)"},
		{3, 3, 4, "S3 (Gate 3 → Gate 4)"},
		{4, 4, 1, "S4 (Gate 4 → Start / Finish)"},
	}

	pilotBySlot := make(map[int]domain.PilotSlot, len(pilots))
	for _, p := range pilots {
		pilotBySlot[p.SlotIndex] = p
	}

	// Precompute overall best per section and personal best per pilot/section + lap
	var overallBestSec [4]float64
	pilotBestSec := make(map[int][4]float64)
	pilotBestLap := make(map[int]float64)

	for _, pl := range plans {
		var pSec [4]float64
		bestLap := 0.0
		for li := 0; li < 6; li++ {
			sum := 0.0
			for si := 0; si < 4; si++ {
				v := pl.splits[li][si]
				sum += v
				if pSec[si] == 0 || v < pSec[si] {
					pSec[si] = v
				}
				if overallBestSec[si] == 0 || v < overallBestSec[si] {
					overallBestSec[si] = v
				}
			}
			sum = math.Round(sum*1000) / 1000
			if bestLap == 0 || sum < bestLap {
				bestLap = sum
			}
		}
		pilotBestSec[pl.slot] = pSec
		pilotBestLap[pl.slot] = bestLap
	}

	var laps []domain.LapRecord
	var crossings []domain.GateCrossingEvent
	var lapID uint64 = 1
	var eventID uint64 = 1
	passingByGate := map[uint8]uint32{}

	gateNames := map[uint8]string{
		1: "Start / Finish",
		2: "Gate 2",
		3: "Gate 3",
		4: "Gate 4",
	}

	// Interleave laps by lap index (1..6) so feed & timestamps look natural
	baseUs := uint64(10_000_000) // 10.0s after boot
	pilotClockUs := map[int]uint64{
		1: baseUs,
		2: baseUs + 1_200_000,
		3: baseUs + 2_400_000,
		4: baseUs + 3_600_000,
	}

	// Emit initial holeshot crossing on Gate 1 for each pilot
	for _, pl := range plans {
		p := pilotBySlot[pl.slot]
		passingByGate[1]++
		crossings = append(crossings, domain.GateCrossingEvent{
			EventID:           eventID,
			GateID:            1,
			GateName:          gateNames[1],
			IsStartFinish:     true,
			StartedLap:        true,
			SlotIndex:         pl.slot,
			Callsign:          p.Callsign,
			FrequencyMHz:      p.FrequencyMHz,
			TimestampUs:       pilotClockUs[pl.slot],
			PeakRSSIDbm:       -41.5,
			LapRFPeakHeight:   2150,
			BeamwidthMs:       88.0,
			EstimatedSpeedMph: 44.5,
			PassingNumber:     passingByGate[1],
		})
		eventID++
	}

	for li := 0; li < 6; li++ {
		for _, pl := range plans {
			p := pilotBySlot[pl.slot]
			pBestSec := pilotBestSec[pl.slot]
			pBestLap := pilotBestLap[pl.slot]

			sectors := make([]domain.SectorSplit, 4)
			lapTotal := 0.0
			curUs := pilotClockUs[pl.slot]

			for si := 0; si < 4; si++ {
				secDur := pl.splits[li][si]
				lapTotal += secDur
				curUs += uint64(math.Round(secDur * 1_000_000))

				deltaSec := math.Round((secDur-pBestSec[si])*1000) / 1000
				badge := domain.BadgeNormal
				if math.Abs(secDur-overallBestSec[si]) < 1e-6 {
					badge = domain.BadgeOverallBest
				} else if math.Abs(secDur-pBestSec[si]) < 1e-6 {
					badge = domain.BadgePersonalBest
				} else if secDur > pBestSec[si]*1.10 {
					badge = domain.BadgeOffPace
				}

				speedMph := math.Round((150.0/secDur)*10) / 10
				sectors[si] = domain.SectorSplit{
					SectorIndex:    sectionDefs[si].idx,
					FromGateID:     sectionDefs[si].from,
					ToGateID:       sectionDefs[si].to,
					Label:          sectionDefs[si].label,
					SplitSeconds:   secDur,
					DeltaToBestSec: deltaSec,
					ExitSpeedMph:   speedMph,
					Badge:          badge,
				}

				toGate := sectionDefs[si].to
				passingByGate[toGate]++
				crossings = append(crossings, domain.GateCrossingEvent{
					EventID:           eventID,
					GateID:            toGate,
					GateName:          gateNames[toGate],
					IsStartFinish:     toGate == 1,
					SlotIndex:         pl.slot,
					Callsign:          p.Callsign,
					FrequencyMHz:      p.FrequencyMHz,
					TimestampUs:       curUs,
					PeakRSSIDbm:       -40.0 - float32(si)*1.2,
					LapRFPeakHeight:   2200 - float32(si)*60,
					BeamwidthMs:       84.0 + float64(si)*3.5,
					EstimatedSpeedMph: speedMph,
					PassingNumber:     passingByGate[toGate],
				})
				eventID++
			}

			lapTotal = math.Round(lapTotal*1000) / 1000
			pilotClockUs[pl.slot] = curUs
			isBest := math.Abs(lapTotal-pBestLap) < 1e-6

			laps = append(laps, domain.LapRecord{
				LapID:         lapID,
				SlotIndex:     pl.slot,
				Callsign:      p.Callsign,
				LapNumber:     li + 1,
				LapTimeSec:    lapTotal,
				DeltaToBest:   math.Round((lapTotal-pBestLap)*1000) / 1000,
				Sectors:       sectors,
				CompletedAtUs: curUs,
				IsBestLap:     isBest,
			})
			lapID++
		}
	}

	filtered := []domain.FilteredDetection{
		{
			TimestampUs: baseUs + 4_500_000,
			GateID:      1,
			SlotIndex:   1,
			Callsign:    pilotBySlot[1].Callsign,
			Reason:      domain.FilterMinLap,
			Detail:      "3.12s since last pass at Start / Finish (min lap 5.0s)",
			PeakRSSIDbm: -47.2,
		},
		{
			TimestampUs: baseUs + 9_200_000,
			GateID:      2,
			SlotIndex:   2,
			Callsign:    pilotBySlot[2].Callsign,
			Reason:      domain.FilterCooldown,
			Detail:      "1.15s since last pass at Gate 2 (cooldown 2.0s)",
			PeakRSSIDbm: -49.0,
		},
		{
			TimestampUs: baseUs + 15_800_000,
			GateID:      3,
			SlotIndex:   3,
			Callsign:    pilotBySlot[3].Callsign,
			Reason:      domain.FilterEcho,
			Detail:      "Re-detected previous Gate 2 within 1.80s echo window",
			PeakRSSIDbm: -51.4,
		},
		{
			TimestampUs: baseUs + 22_400_000,
			GateID:      4,
			SlotIndex:   1,
			Callsign:    pilotBySlot[1].Callsign,
			Reason:      domain.FilterMinLap,
			Detail:      "3.85s since last pass at Gate 4 (min lap 5.0s)",
			PeakRSSIDbm: -48.1,
		},
		{
			TimestampUs: baseUs + 28_900_000,
			GateID:      2,
			SlotIndex:   4,
			Callsign:    pilotBySlot[4].Callsign,
			Reason:      domain.FilterTooSoon,
			Detail:      "0.24s from Start / Finish (min section 0.5s)",
			PeakRSSIDbm: -52.8,
		},
	}

	return laps, crossings, filtered
}

// buildSyntheticRssiTrace synthesizes a 10 Hz Start/Finish gate RSSI waveform (-92 dBm floor with
// smooth peaks around each crossing offset) so HeatLapEditorModal renders realistic curves.
func buildSyntheticRssiTrace(crossingOffsetsMs []int64, durationMs int32) []domain.HeatRssiSample {
	if durationMs < 48000 {
		durationMs = 48000
	}
	var trace []domain.HeatRssiSample
	for t := int32(-2500); t <= durationMs; t += 100 {
		rssi := -92.0 + 1.5*math.Sin(float64(t)/700.0)
		for idx, pkMs := range crossingOffsetsMs {
			dist := math.Abs(float64(t) - float64(pkMs))
			if dist < 2400 {
				peakTop := -39.0 - float64(idx%3)*1.8
				sigma := 420.0
				bump := (peakTop - (-92.0)) * math.Exp(-(dist*dist)/(2*sigma*sigma))
				if -92.0+bump > rssi {
					rssi = -92.0 + bump
				}
			}
		}
		trace = append(trace, domain.HeatRssiSample{
			OffsetMs: t,
			Dbm:      int16(math.Round(rssi)),
		})
	}
	return trace
}

// populateAndConfirmHeat drives real engine heat start -> stop -> manual crossings -> optional
// penalty -> confirm, then attaches multi-sector splits and a 10 Hz RSSI waveform to every seat.
func populateAndConfirmHeat(
	engine *tracker.Engine,
	raceID string,
	heatID string,
	penaltySeatIdx int,
	penaltySec float64,
) error {
	if _, err := engine.RaceControlActionWithOptions(raceID, "start", heatID, true); err != nil {
		return fmt.Errorf("start heat %s: %w", heatID, err)
	}
	// Skip countdown into running if needed, or stop directly from countdown/running
	_, _ = engine.RaceControlActionWithOptions(raceID, "skip_countdown", heatID, true)
	if _, err := engine.RaceControlActionWithOptions(raceID, "stop", heatID, true); err != nil {
		return fmt.Errorf("stop heat %s: %w", heatID, err)
	}

	rs := engine.RaceSnapshot()
	var targetHeat *domain.RaceHeat
	for i := range rs.Heats {
		if rs.Heats[i].ID == heatID {
			targetHeat = &rs.Heats[i]
			break
		}
	}
	if targetHeat == nil {
		return fmt.Errorf("heat %s not found in snapshot", heatID)
	}

	seatOffsets := make(map[int][]int64)
	for sIdx, seat := range targetHeat.Seats {
		if seat.PilotSlotIndex <= 0 {
			continue
		}
		holeshotMs := int64(1450 + sIdx*190)
		lap1Ms := holeshotMs + int64(13400+sIdx*380)
		lap2Ms := lap1Ms + int64(13250+sIdx*410)
		lap3Ms := lap2Ms + int64(13520+sIdx*360)
		offsets := []int64{holeshotMs, lap1Ms, lap2Ms, lap3Ms}
		seatOffsets[seat.PilotSlotIndex] = offsets

		for _, off := range offsets {
			ms := off
			if _, err := engine.MarshalPilotAction(tracker.RaceMarshalPayload{
				RaceID:         raceID,
				HeatID:         heatID,
				PilotSlotIndex: seat.PilotSlotIndex,
				Action:         "add_crossing",
				OffsetMs:       &ms,
			}); err != nil {
				return fmt.Errorf("add_crossing seat %d (%d ms): %w", seat.PilotSlotIndex, ms, err)
			}
		}

		if penaltySeatIdx > 0 && seat.SeatIndex == penaltySeatIdx && penaltySec > 0 {
			if _, err := engine.MarshalPilotAction(tracker.RaceMarshalPayload{
				RaceID:         raceID,
				HeatID:         heatID,
				PilotSlotIndex: seat.PilotSlotIndex,
				Action:         "set_penalty",
				PenaltySec:     penaltySec,
			}); err != nil {
				return fmt.Errorf("set_penalty seat %d: %w", seat.PilotSlotIndex, err)
			}
		}
	}

	if _, err := engine.RaceControlActionWithOptions(raceID, "confirm", heatID, true); err != nil {
		return fmt.Errorf("confirm heat %s: %w", heatID, err)
	}

	// Enrich exported state with 10 Hz RssiTrace + 4-sector splits on the confirmed heat's laps
	st := engine.ExportState()
	enrichHeatInRace := func(r *domain.RaceTournamentState) {
		if r == nil || (raceID != "" && r.RaceID != raceID) {
			return
		}
		for hi := range r.Heats {
			h := &r.Heats[hi]
			if h.ID != heatID {
				continue
			}
			h.ElapsedSec = 44.8
			for si := range h.Seats {
				seat := &h.Seats[si]
				offs := seatOffsets[seat.PilotSlotIndex]
				if len(offs) == 0 {
					continue
				}
				seat.RssiTrace = buildSyntheticRssiTrace(offs, int32(offs[len(offs)-1]+3500))
				for li := range seat.Laps {
					lap := &seat.Laps[li]
					if lap.LapNumber <= 0 || lap.SplitTimeSec <= 0 {
						continue
					}
					q1 := math.Round(lap.SplitTimeSec*0.23*1000) / 1000
					q2 := math.Round(lap.SplitTimeSec*0.26*1000) / 1000
					q3 := math.Round(lap.SplitTimeSec*0.25*1000) / 1000
					q4 := math.Round((lap.SplitTimeSec-q1-q2-q3)*1000) / 1000
					lap.Sectors = []domain.SectorSplit{
						{SectorIndex: 1, FromGateID: 1, ToGateID: 2, Label: "S1 (Start / Finish → Gate 2)", SplitSeconds: q1, ExitSpeedMph: 46.2, Badge: domain.BadgeNormal},
						{SectorIndex: 2, FromGateID: 2, ToGateID: 3, Label: "S2 (Gate 2 → Gate 3)", SplitSeconds: q2, ExitSpeedMph: 43.8, Badge: domain.BadgeNormal},
						{SectorIndex: 3, FromGateID: 3, ToGateID: 4, Label: "S3 (Gate 3 → Gate 4)", SplitSeconds: q3, ExitSpeedMph: 45.1, Badge: domain.BadgeNormal},
						{SectorIndex: 4, FromGateID: 4, ToGateID: 1, Label: "S4 (Gate 4 → Start / Finish)", SplitSeconds: q4, ExitSpeedMph: 47.0, Badge: domain.BadgeNormal},
					}
				}
				for ci := range seat.Crossings {
					if ci > 0 && ci < len(seat.Laps) && len(seat.Laps[ci].Sectors) > 0 {
						seat.Crossings[ci].Sectors = append([]domain.SectorSplit(nil), seat.Laps[ci].Sectors...)
					}
					seat.Crossings[ci].PeakRSSIDbm = -40.5
				}
			}
		}
	}
	enrichHeatInRace(st.RaceState)
	if st.EventState != nil {
		for ri := range st.EventState.Races {
			enrichHeatInRace(&st.EventState.Races[ri])
		}
	}
	engine.RestoreState(st, true)
	return nil
}

// 1. practice_populated.json
func buildSnapshotPracticePopulated() (SimSnapshotBundle, error) {
	simEngine, sim, _ := newBuilderEnv()

	// Create 3 named practice sessions:
	// - Session 1 ("Evening Lap Lab"): active, tags ["5-inch", "Outdoor"], 4 pilots, 24 multi-sector laps
	// - Session 2 ("Warmup Pack"): stopped, tags ["Whoop", "Indoor"], 2 pilots, 2 laps
	// - Session 3 ("Hover Check"): stopped, untagged, 1 pilot, 0 laps
	st := simEngine.ExportState()
	laps, crossings, filtered := buildSyntheticPracticeDataset(st.Pilots)

	makeSessionPilot := func(slot int, ch uint8) domain.PracticeSessionPilot {
		p := st.Pilots[slot-1]
		return domain.PracticeSessionPilot{
			SlotIndex:    p.SlotIndex,
			Callsign:     p.Callsign,
			PhoneticName: p.PhoneticName,
			Color:        p.Color,
			Band:         domain.BandRaceband,
			Channel:      ch,
			FrequencyMHz: domain.FrequencyForBandChannel(domain.BandRaceband, ch),
		}
	}

	warmupLaps := []domain.LapRecord{
		laps[0],
		laps[1],
	}
	warmupLaps[0].LapID = 101
	warmupLaps[1].LapID = 102

	st.ElapsedUs = 125_000_000
	st.RaceArmed = true
	st.Laps = laps
	st.Crossings = crossings
	st.Filtered = filtered
	st.PracticeState = &domain.PracticeManagerState{
		Initialized:       true,
		ActiveSessionID:   "session-1",
		SelectedSessionID: "session-1",
		Sessions: []domain.PracticeSession{
			{
				SessionID: "session-1",
				Name:      "Evening Lap Lab",
				Tags:      []string{"5-inch", "Outdoor"},
				Active:    true,
				Paused:    false,
				CreatedAt: "2026-11-13T18:00:00Z",
				UpdatedAt: "2026-11-13T18:15:00Z",
				Pilots: []domain.PracticeSessionPilot{
					makeSessionPilot(1, 1),
					makeSessionPilot(2, 3),
					makeSessionPilot(3, 5),
					makeSessionPilot(4, 8),
				},
				TrackSnapshot: append([]domain.TrackGate(nil), st.Gates...),
				Laps:          laps,
				Crossings:     crossings,
				Filtered:      filtered,
			},
			{
				SessionID: "session-2",
				Name:      "Warmup Pack",
				Tags:      []string{"Whoop", "Indoor"},
				Active:    false,
				Paused:    false,
				CreatedAt: "2026-11-13T17:10:00Z",
				UpdatedAt: "2026-11-13T17:25:00Z",
				Pilots: []domain.PracticeSessionPilot{
					makeSessionPilot(1, 1),
					makeSessionPilot(2, 3),
				},
				TrackSnapshot: append([]domain.TrackGate(nil), st.Gates...),
				Laps:          warmupLaps,
			},
			{
				SessionID: "session-3",
				Name:      "Hover Check",
				Active:    false,
				Paused:    false,
				CreatedAt: "2026-11-13T16:45:00Z",
				UpdatedAt: "2026-11-13T16:50:00Z",
				Pilots: []domain.PracticeSessionPilot{
					makeSessionPilot(1, 1),
				},
				TrackSnapshot: append([]domain.TrackGate(nil), st.Gates...),
			},
		},
	}

	return canonicalizeBundle(st, sim.ExportOptions()), nil
}

// 2. race_active_control.json
func buildSnapshotRaceActiveControl() (SimSnapshotBundle, error) {
	simEngine, sim, _ := newBuilderEnv()

	// Add 4 extra pilots (12 total > 10 so CanvasSelect renders its live search input!)
	extraPilots := [][2]string{
		{"Halo", "hay-low"},
		{"Coyote", "kai-oh-tee"},
		{"Harvard", "har-vard"},
		{"Yale", "yayl"},
	}
	for _, ep := range extraPilots {
		if err := simEngine.AddPilot(ep[0], ep[1]); err != nil {
			return SimSnapshotBundle{}, fmt.Errorf("add extra pilot %s: %w", ep[0], err)
		}
	}

	// Create a saved Practice session ("Open Warmup") so Practice directory also has history
	if _, err := simEngine.PracticeAction(tracker.PracticeActionPayload{
		Action: "create_session",
		Name:   "Open Warmup",
		Tags:   []string{"Warmup"},
	}); err != nil {
		return SimSnapshotBundle{}, err
	}
	_, _ = simEngine.PracticeAction(tracker.PracticeActionPayload{
		Action:    "stop_session",
		SessionID: "session-1",
	})

	// Race 1 (created first so it stays draft): "Sunday Qualifier" (2-stage Qualifying -> Double Elim, 14 checked-in pilots)
	rs2, err := simEngine.EventAction(tracker.EventActionPayload{
		Action: "create_race",
		Name:   "Sunday Qualifier",
		Tags:   []string{"Qualifier", "2-Stage"},
	})
	if err != nil {
		return SimSnapshotBundle{}, fmt.Errorf("create Sunday Qualifier: %w", err)
	}
	for slot := 1; slot <= simEngine.PilotCount(); slot++ {
		checked := true
		_, _ = simEngine.EventAction(tracker.EventActionPayload{
			Action:    "update_attendance",
			RaceID:    rs2.RaceID,
			SlotIndex: slot,
			CheckedIn: &checked,
		})
	}
	if _, err := simEngine.BracketEditAction(tracker.BracketEditPayload{
		Action:     "apply_template",
		RaceID:     rs2.RaceID,
		TemplateID: "qual_double_elim",
	}); err != nil {
		return SimSnapshotBundle{}, fmt.Errorf("apply qual_double_elim on Sunday Qualifier: %w", err)
	}

	// Race 2 (created & started second so it is the active selected race):
	// "Friday Night Brawl" (Double Elimination, 8 checked-in pilots, W1-1 confirmed with RSSI + penalty)
	rs1, err := simEngine.EventAction(tracker.EventActionPayload{
		Action: "create_race",
		Name:   "Friday Night Brawl",
		Tags:   []string{"League", "Season-4"},
	})
	if err != nil {
		return SimSnapshotBundle{}, fmt.Errorf("create Friday Night Brawl: %w", err)
	}
	race1ID := rs1.RaceID

	// Check in first 8 pilots only (keep 9..N unchecked reserves in global directory)
	for slot := 1; slot <= simEngine.PilotCount(); slot++ {
		checked := slot <= 8
		if _, err := simEngine.EventAction(tracker.EventActionPayload{
			Action:    "update_attendance",
			RaceID:    race1ID,
			SlotIndex: slot,
			CheckedIn: &checked,
		}); err != nil {
			return SimSnapshotBundle{}, err
		}
	}

	if _, err := simEngine.BracketEditAction(tracker.BracketEditPayload{
		Action:     "apply_template",
		RaceID:     race1ID,
		TemplateID: "double_elimination",
	}); err != nil {
		return SimSnapshotBundle{}, fmt.Errorf("apply double_elimination: %w", err)
	}

	if _, err := simEngine.EventAction(tracker.EventActionPayload{
		Action:          "race_lifecycle",
		RaceID:          race1ID,
		LifecycleAction: "start_race",
		PreemptOngoing:  true,
	}); err != nil {
		return SimSnapshotBundle{}, fmt.Errorf("start_race Friday Night Brawl: %w", err)
	}

	// Confirm W1-1 with realistic RSSI waveform, 4 crossings per pilot, and a +5s penalty on Seat 3
	if err := populateAndConfirmHeat(simEngine, race1ID, "W1-1", 3, 5.0); err != nil {
		return SimSnapshotBundle{}, err
	}

	simEngine.SetOperatingMode(domain.ModeRace)

	return canonicalizeBundle(simEngine.ExportState(), sim.ExportOptions()), nil
}

// 3. race_completed_podium.json
func buildSnapshotRaceCompletedPodium() (SimSnapshotBundle, error) {
	simEngine, sim, _ := newBuilderEnv()

	// Create a completed Single Elimination tournament ("Winter Finals", 4 pilots -> 1 Final heat)
	rs, err := simEngine.EventAction(tracker.EventActionPayload{
		Action: "create_race",
		Name:   "Winter Finals",
		Tags:   []string{"Finals", "Championship"},
	})
	if err != nil {
		return SimSnapshotBundle{}, err
	}
	raceID := rs.RaceID

	for slot := 1; slot <= simEngine.PilotCount(); slot++ {
		checked := slot <= 4
		if _, err := simEngine.EventAction(tracker.EventActionPayload{
			Action:    "update_attendance",
			RaceID:    raceID,
			SlotIndex: slot,
			CheckedIn: &checked,
		}); err != nil {
			return SimSnapshotBundle{}, err
		}
	}

	cfg := domain.DefaultRaceSetupConfig()
	cfg.EventName = "Winter Finals"
	cfg.Structure = domain.StructureSingleStage
	cfg.MainFormat = domain.FormatSingleElimination
	cfg.FinalsFormat = domain.FinalsSingle
	cfg.PilotsPerHeat = 4
	cfg.TargetLaps = 3
	simEngine.ConfigureAndGenerateRaceForID(raceID, cfg, true, true)

	if _, err := simEngine.EventAction(tracker.EventActionPayload{
		Action:          "race_lifecycle",
		RaceID:          raceID,
		LifecycleAction: "start_race",
		PreemptOngoing:  true,
	}); err != nil {
		return SimSnapshotBundle{}, err
	}

	snap := simEngine.RaceSnapshot()
	if len(snap.Heats) == 0 {
		return SimSnapshotBundle{}, fmt.Errorf("expected generated final heat in Winter Finals")
	}
	firstHeatID := snap.Heats[0].ID
	if err := populateAndConfirmHeat(simEngine, raceID, firstHeatID, 0, 0); err != nil {
		return SimSnapshotBundle{}, err
	}

	// Ensure race is marked completed if not already crowned automatically
	_, _ = simEngine.EventAction(tracker.EventActionPayload{
		Action:          "race_lifecycle",
		RaceID:          raceID,
		LifecycleAction: "complete_race",
	})

	// Also attach populated Practice session ("Evening Lap Lab") so #/pilot Analytics can switch
	// between Practice ("Evening Lap Lab") and Race ("Winter Finals") seamlessly!
	st := simEngine.ExportState()
	laps, crossings, filtered := buildSyntheticPracticeDataset(st.Pilots)
	makeSessionPilot := func(slot int, ch uint8) domain.PracticeSessionPilot {
		p := st.Pilots[slot-1]
		return domain.PracticeSessionPilot{
			SlotIndex:    p.SlotIndex,
			Callsign:     p.Callsign,
			PhoneticName: p.PhoneticName,
			Color:        p.Color,
			Band:         domain.BandRaceband,
			Channel:      ch,
			FrequencyMHz: domain.FrequencyForBandChannel(domain.BandRaceband, ch),
		}
	}
	attachPracticeToCompletedRace(&st, laps, crossings, filtered, []domain.PracticeSessionPilot{
		makeSessionPilot(1, 1),
		makeSessionPilot(2, 3),
		makeSessionPilot(3, 5),
		makeSessionPilot(4, 8),
	})

	return canonicalizeBundle(st, sim.ExportOptions()), nil
}

func attachPracticeToCompletedRace(
	st *tracker.PersistedEngineState,
	laps []domain.LapRecord,
	crossings []domain.GateCrossingEvent,
	filtered []domain.FilteredDetection,
	pilots []domain.PracticeSessionPilot,
) {
	st.Laps = laps
	st.Crossings = crossings
	st.Filtered = filtered
	if st.RaceState != nil {
		st.RaceState.Mode = domain.ModePractice
	}
	st.PracticeState = &domain.PracticeManagerState{
		Initialized:       true,
		ActiveSessionID:   "session-1",
		SelectedSessionID: "session-1",
		Sessions: []domain.PracticeSession{
			{
				SessionID:     "session-1",
				Name:          "Evening Lap Lab",
				Tags:          []string{"5-inch", "Outdoor"},
				Active:        true,
				CreatedAt:     "2026-11-13T18:00:00Z",
				UpdatedAt:     "2026-11-13T18:15:00Z",
				Pilots:        pilots,
				TrackSnapshot: append([]domain.TrackGate(nil), st.Gates...),
				Laps:          laps,
				Crossings:     crossings,
				Filtered:      filtered,
			},
		},
	}
}

// 4. multigp_seeded.json
func buildSnapshotMultiGPSeeded() (SimSnapshotBundle, error) {
	simEngine, sim, handler := newBuilderEnv()

	// Fetch default simulated MultiGP race #501 via handler
	recView := httptest.NewRecorder()
	handler.ServeHTTP(recView, httptest.NewRequest(
		http.MethodPost,
		"/api/sim/mgp/race/view?id=501",
		bytes.NewBufferString(fmt.Sprintf(`{"apiKey":%q}`, multigp.DefaultSimAPIKey)),
	))
	if recView.Code != http.StatusOK {
		return SimSnapshotBundle{}, fmt.Errorf("sim mgp race/view 501 failed: %d %s", recView.Code, recView.Body.String())
	}
	var viewEnv struct {
		Status bool                 `json:"status"`
		Data   multigp.RaceViewData `json:"data"`
	}
	if err := json.Unmarshal(recView.Body.Bytes(), &viewEnv); err != nil || !viewEnv.Status {
		return SimSnapshotBundle{}, fmt.Errorf("decode mgp race/view 501: %v", err)
	}

	impPayload, _ := json.Marshal(map[string]any{
		"race":       viewEnv.Data,
		"importMode": "schedule",
	})
	recImp := httptest.NewRecorder()
	handler.ServeHTTP(recImp, httptest.NewRequest(http.MethodPost, "/api/mgp-sync/import", bytes.NewReader(impPayload)))
	if recImp.Code != http.StatusOK {
		return SimSnapshotBundle{}, fmt.Errorf("mgp-sync/import failed: %d %s", recImp.Code, recImp.Body.String())
	}

	var impResp struct {
		CreatedRace domain.RaceTournamentState `json:"createdRace"`
	}
	if err := json.Unmarshal(recImp.Body.Bytes(), &impResp); err != nil {
		return SimSnapshotBundle{}, fmt.Errorf("decode mgp import resp: %v", err)
	}
	raceID := impResp.CreatedRace.RaceID
	if len(impResp.CreatedRace.Heats) == 0 {
		return SimSnapshotBundle{}, fmt.Errorf("imported MultiGP race has 0 heats")
	}
	firstHeatID := impResp.CreatedRace.Heats[0].ID

	// Start race and confirm first heat so MultiGPSyncModal has pending unsynced results ready
	_, _ = simEngine.EventAction(tracker.EventActionPayload{
		Action:          "race_lifecycle",
		RaceID:          raceID,
		LifecycleAction: "start_race",
		PreemptOngoing:  true,
	})
	if err := populateAndConfirmHeat(simEngine, raceID, firstHeatID, 0, 0); err != nil {
		return SimSnapshotBundle{}, err
	}
	simEngine.SetOperatingMode(domain.ModeRace)

	return canonicalizeBundle(simEngine.ExportState(), sim.ExportOptions()), nil
}

// 5. laprf_mode_seeded.json
func buildSnapshotLapRFModeSeeded() (SimSnapshotBundle, error) {
	simEngine, sim, handler := newBuilderEnv()

	recMode := httptest.NewRecorder()
	handler.ServeHTTP(recMode, httptest.NewRequest(
		http.MethodPost,
		"/api/hardware/mode",
		bytes.NewBufferString(`{"mode":"laprf"}`),
	))
	if recMode.Code != http.StatusOK {
		return SimSnapshotBundle{}, fmt.Errorf("switch hardware mode laprf failed: %d %s", recMode.Code, recMode.Body.String())
	}

	st := simEngine.ExportState()
	for i := range st.Pilots {
		st.Pilots[i].AttenuationGain = uint16(52 + (i % 6))
		st.Pilots[i].LapRFThreshold = float32(780 + i*25)
	}

	return canonicalizeBundle(st, sim.ExportOptions()), nil
}
