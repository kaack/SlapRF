package tracker

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"testing"

	"slaprf/internal/domain"
	"slaprf/internal/ml"
	"slaprf/internal/tracestore"
)

func absMs(a, b uint64) float64 {
	if a >= b {
		return float64(a-b) / 1000.0
	}
	return float64(b-a) / 1000.0
}

// TestAutoLabelTrackOrderBlankSlateRegression guards against auto-labeler regressions on compact
// multi-gate tracks (H1 -> T1 -> T2 -> T3 -> H1) with:
//  1. Nearby-lane proximity flybys on out-of-order gates (e.g. T1 picking up a 29 dB bump during T3 -> H1).
//  2. Pre-pass approach shoulders 1.1s before T2/T3 that would trap greedy left-to-right lockout.
//  3. Per-gate receiver gain differences (T2 peaking at +24 dB while H1 bleeds at +25 dB simultaneously).
//  4. Polluted lap windows containing prior manual OUT_OF_ORDER crossings, TOO_SHORT Filtered hints,
//     and ManualDeletedCrossings — verifying blank-slate lap-by-lap and full-session recovery without Qwen3 GGUF.
func TestAutoLabelTrackOrderBlankSlateRegression(t *testing.T) {
	eng := NewRealEngine()
	eng.SetTimingHardwareMode(domain.HardwareModeSlapRFBLE, false)

	traceDir := t.TempDir()
	fs, err := tracestore.NewFileStore(traceDir)
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	defer fs.Close()
	eng.SetTraceStore(fs)

	// Empty TeacherManager (no 1.1 GB Qwen3 GGUF installed)
	tm := ml.NewTeacherManager(t.TempDir(), nil)
	eng.SetTeacherManager(tm)

	if _, err := eng.ProvisionGate(ProvisionRequest{Role: "hub", Label: "H1", Fingerprint: "AA000001", FromHubHello: true}); err != nil {
		t.Fatalf("ProvisionGate H1: %v", err)
	}
	t1ID, err := eng.ProvisionGate(ProvisionRequest{Role: "spoke", Label: "T1", Fingerprint: "AA000002"})
	if err != nil {
		t.Fatalf("ProvisionGate T1: %v", err)
	}
	t2ID, err := eng.ProvisionGate(ProvisionRequest{Role: "spoke", Label: "T2", Fingerprint: "AA000003"})
	if err != nil {
		t.Fatalf("ProvisionGate T2: %v", err)
	}
	t3ID, err := eng.ProvisionGate(ProvisionRequest{Role: "spoke", Label: "T3", Fingerprint: "AA000004"})
	if err != nil {
		t.Fatalf("ProvisionGate T3: %v", err)
	}
	if _, err := eng.AddGate("T1", t1ID); err != nil {
		t.Fatalf("AddGate T1: %v", err)
	}
	if _, err := eng.AddGate("T2", t2ID); err != nil {
		t.Fatalf("AddGate T2: %v", err)
	}
	if _, err := eng.AddGate("T3", t3ID); err != nil {
		t.Fatalf("AddGate T3: %v", err)
	}

	eng.mu.RLock()
	gatesSnap := eng.orderedGatesLocked()
	eng.mu.RUnlock()
	if len(gatesSnap) != 4 {
		t.Fatalf("expected 4 ordered gates, got %d", len(gatesSnap))
	}

	enable := true
	quietSec := 300
	ps, err := eng.PracticeAction(PracticeActionPayload{
		Action:           "set_pack_loop",
		PackLoopEnabled:  &enable,
		PackLoopQuietSec: &quietSec,
	})
	if err != nil {
		t.Fatalf("set_pack_loop: %v", err)
	}
	sessID := ps.ActiveSessionID

	// Synthesize 2 flight stints (3 laps + 42s crash pause + 3 laps = 6 laps, 26 ground-truth crossings)
	type gtCross struct {
		gateIdx int // 0=H1, 1=T1, 2=T2, 3=T3
		gateID  uint8
		tsUs    uint64
	}
	var expected []gtCross
	type bellEvent struct {
		timerIdx int
		centerS  float64
		ampDb    float64
		widthS   float64
	}
	var events []bellEvent
	timerIDs := [4]uint8{1, t1ID, t2ID, t3ID}

	addTruePass := func(gIdx int, tSec float64) {
		gid := gatesSnap[gIdx].GateID
		expected = append(expected, gtCross{
			gateIdx: gIdx,
			gateID:  gid,
			tsUs:    uint64(math.Round(tSec * 1e6)),
		})
		switch gIdx {
		case 0: // H1: +42 dB main pass + +18 dB bleed on T1
			events = append(events,
				bellEvent{0, tSec, 42.0, 0.16},
				bellEvent{1, tSec + 0.03, 18.0, 0.22},
			)
		case 1: // T1: +34 dB main pass + +16 dB bleed on T2
			events = append(events,
				bellEvent{1, tSec, 34.0, 0.17},
				bellEvent{2, tSec + 0.04, 16.0, 0.22},
			)
		case 2: // T2: angled gate peaking at +24.5 dB, preceded 1.15s earlier by +17.5 dB approach shoulder, AND +25.0 dB simultaneous bleed on sensitive H1!
			events = append(events,
				bellEvent{2, tSec - 1.15, 17.5, 0.20},
				bellEvent{2, tSec, 24.5, 0.18},
				bellEvent{0, tSec + 0.02, 25.0, 0.24},
			)
		case 3: // T3: +33 dB main pass, followed 1.35s later (on return lane T3 -> H1) by a strong +28.5 dB out-of-order proximity flyby on T1!
			events = append(events,
				bellEvent{3, tSec - 1.05, 16.8, 0.19},
				bellEvent{3, tSec, 33.0, 0.17},
				bellEvent{1, tSec + 1.35, 28.5, 0.21},
			)
		}
	}

	curSec := 5.0
	for stint := 0; stint < 2; stint++ {
		addTruePass(0, curSec)
		for lap := 0; lap < 3; lap++ {
			addTruePass(1, curSec+3.2)
			addTruePass(2, curSec+6.8)
			addTruePass(3, curSec+10.1)
			curSec += 13.8
			addTruePass(0, curSec)
		}
		if stint == 0 {
			curSec += 42.0 // Crash / pit recovery pause between stints
		}
	}
	totalDurationSec := curSec + 5.0
	totalSteps := int(totalDurationSec / 0.02)

	// Record two realistic BLE spoke packet dropouts matching Session 2 Laps 20 & 22:
	//  - Stint 1 Lap 2 T3: 2.2s BLE silence ending right AT the gate crest (`idx == 0` segment start peak!)
	//  - Stint 2 Lap 1 T1: 1.35s BLE gap immediately after the gate crest (linear interpolation plateau!)
	bleGapT3CrestSec := float64(expected[7].tsUs) / 1e6 // Lap 2 T3
	bleGapT1CrestSec := float64(expected[14].tsUs) / 1e6 // Stint 2 Lap 1 T1

	var seq uint32
	for step := 0; step < totalSteps; step++ {
		tSec := float64(step) * 0.02
		tsUs := uint64(1_000_000) + uint64(step)*20_000
		seq++
		for ti := 0; ti < 4; ti++ {
			if ti == 3 && tSec >= bleGapT3CrestSec-2.20 && tSec < bleGapT3CrestSec-0.01 {
				continue // BLE spoke silent until right at the T3 crest!
			}
			if ti == 1 && tSec > bleGapT1CrestSec+0.04 && tSec <= bleGapT1CrestSec+1.38 {
				continue // 1.34s BLE gap right after T1 crest!
			}
			rssi := -90.0
			for _, ev := range events {
				if ev.timerIdx != ti {
					continue
				}
				dt := tSec - ev.centerS
				if math.Abs(dt) > 1.6 {
					continue
				}
				u := dt / ev.widthS
				v := -90.0 + ev.ampDb/(1.0+u*u)
				if v > rssi {
					rssi = v
				}
			}
			var arr [domain.MaxPilotPoolSize]float32
			for k := range arr {
				arr[k] = -127
			}
			arr[0] = float32(rssi)
			eng.IngestTelemetryFrame(domain.TimerTelemetryFrame{
				TimerID:       timerIDs[ti],
				SeqNum:        seq,
				TimestampUs:   tsUs + uint64(ti)*2_000,
				BatteryMv:     4100,
				NoiseFloorDbm: -90,
				RSSI:          arr,
			})
		}
	}

	if _, err := eng.PracticeAction(PracticeActionPayload{Action: "stop_session"}); err != nil {
		t.Fatalf("stop_session: %v", err)
	}

	// 1. Full-session blank-slate Auto-Label (without Qwen3 GGUF installed!)
	if _, err := eng.PracticeAction(PracticeActionPayload{
		Action:    "clear_pilot_laps",
		SessionID: sessID,
		SlotIndex: 1,
	}); err != nil {
		t.Fatalf("clear_pilot_laps: %v", err)
	}

	fullRes, err := eng.LabelPracticeSession(context.Background(), sessID, MLSessionLabelRequest{
		DryRun:    false,
		SlotIndex: 1,
	})
	if err != nil {
		t.Fatalf("LabelPracticeSession full-session: %v", err)
	}

	var gotFull []domain.GateCrossingEvent
	var gotLaps []domain.LapRecord
	for _, s := range fullRes.Practice.Sessions {
		if s.SessionID == sessID {
			for _, c := range s.Crossings {
				if c.SlotIndex == 1 {
					if c.InvalidReason != "" {
						t.Fatalf("unexpected invalid crossing in auto-labeled session: %+v", c)
					}
					gotFull = append(gotFull, c)
				}
			}
			for _, l := range s.Laps {
				if l.SlotIndex == 1 && !l.Invalidated {
					gotLaps = append(gotLaps, l)
				}
			}
		}
	}
	if len(gotLaps) != 6 {
		t.Fatalf("expected 6 recovered laps across 2 stints (auto-break across 42s gap), got %d: %+v", len(gotLaps), gotLaps)
	}
	if len(gotFull) != len(expected) {
		t.Fatalf("expected %d valid crossings, got %d", len(expected), len(gotFull))
	}
	for i, exp := range expected {
		expTs := uint64(1_000_000) + exp.tsUs
		if gotFull[i].GateID != exp.gateID || absMs(gotFull[i].TimestampUs, expTs) > 120.0 {
			t.Fatalf("crossing %d mismatch: got gate=%d ts=%d, want gate=%d ts=%d (dt=%.1fms)",
				i, gotFull[i].GateID, gotFull[i].TimestampUs, exp.gateID, expTs, absMs(gotFull[i].TimestampUs, expTs))
		}
	}

	// 2. Polluted single-lap blank-slate Auto-Label on every lap (with OUT_OF_ORDER manual crossing + deletions + red Filtered hints)
	for li, lap := range gotLaps {
		lapStartUs := uint64(math.Round(float64(lap.CompletedAtUs) - lap.LapTimeSec*1e6))
		lapEndUs := lap.CompletedAtUs
		winStartUs := lapStartUs - 350_000
		winEndUs := lapEndUs + 350_000

		// Delete interior crossings (generating ManualDeletedCrossings) and inject bogus manual OUT_OF_ORDER crossing
		snapBefore := eng.PracticeSnapshot()
		for _, s := range snapBefore.Sessions {
			if s.SessionID != sessID {
				continue
			}
			for _, c := range s.Crossings {
				if c.SlotIndex == 1 && c.TimestampUs > lapStartUs+60_000 && c.TimestampUs+60_000 < lapEndUs {
					if _, dErr := eng.DeletePracticeSessionCrossing(sessID, c.EventID); dErr != nil {
						t.Fatalf("DeletePracticeSessionCrossing lap %d: %v", li+1, dErr)
					}
				}
			}
		}
		bogusDbm := float32(-62.0)
		if _, _, aErr := eng.AddPracticeSessionCrossing(sessID, gatesSnap[3].GateID, 1, lapStartUs+450_000, &bogusDbm); aErr != nil {
			t.Fatalf("AddPracticeSessionCrossing bogus lap %d: %v", li+1, aErr)
		}

		// Inject a stale red Filtered hint inside the lap window and verify Auto-Label scrubs it clean
		eng.mu.Lock()
		if live := eng.findPracticeSessionLocked(sessID); live != nil {
			live.Filtered = append(live.Filtered, domain.FilteredDetection{
				GateID:      gatesSnap[2].GateID,
				SlotIndex:   1,
				TimestampUs: lapStartUs + 2_000_000,
				Reason:      domain.FilterSpike,
			})
		}
		eng.mu.Unlock()

		if _, lErr := eng.LabelPracticeSession(context.Background(), sessID, MLSessionLabelRequest{
			DryRun:    false,
			SlotIndex: 1,
			StartUs:   winStartUs,
			EndUs:     winEndUs,
		}); lErr != nil {
			t.Fatalf("LabelPracticeSession single-lap %d: %v", li+1, lErr)
		}

		snapAfter := eng.PracticeSnapshot()
		for _, s := range snapAfter.Sessions {
			if s.SessionID != sessID {
				continue
			}
			for _, f := range s.Filtered {
				if f.SlotIndex == 1 && f.TimestampUs >= winStartUs && f.TimestampUs <= winEndUs {
					t.Fatalf("expected stale Filtered hint inside re-labeled lap %d to be cleared, got %+v", li+1, f)
				}
			}
			var lapCross []domain.GateCrossingEvent
			for _, c := range s.Crossings {
				if c.SlotIndex == 1 && c.TimestampUs >= winStartUs && c.TimestampUs <= winEndUs {
					if c.InvalidReason != "" {
						t.Fatalf("unexpected leftover invalid crossing in lap %d: %+v", li+1, c)
					}
					lapCross = append(lapCross, c)
				}
			}
			if len(lapCross) != 5 {
				t.Fatalf("lap %d: expected 5 valid crossings [H1,T1,T2,T3,H1], got %d: %+v", li+1, len(lapCross), lapCross)
			}
			wantOrder := []uint8{gatesSnap[0].GateID, gatesSnap[1].GateID, gatesSnap[2].GateID, gatesSnap[3].GateID, gatesSnap[0].GateID}
			for k, wantGID := range wantOrder {
				if lapCross[k].GateID != wantGID {
					t.Fatalf("lap %d step %d: got gate %d, want %d", li+1, k, lapCross[k].GateID, wantGID)
				}
			}
		}
	}
}

// TestAutoLabelRealSessionBenchmark evaluates lap-by-lap and full-session Auto-Label accuracy against
// a copy of any real `PersistedEngineState` JSON/Bolt snapshot when `SLAPRF_AUTOLABEL_TRACES` and
// `SLAPRF_AUTOLABEL_STATE_JSON` are provided (used for local hardware trace benchmarking).
func TestAutoLabelRealSessionBenchmark(t *testing.T) {
	stateJSONPath := os.Getenv("SLAPRF_AUTOLABEL_STATE_JSON")
	tracesDir := os.Getenv("SLAPRF_AUTOLABEL_TRACES")
	sessionID := os.Getenv("SLAPRF_AUTOLABEL_SESSION")
	if stateJSONPath == "" || tracesDir == "" {
		t.Skip("set SLAPRF_AUTOLABEL_STATE_JSON and SLAPRF_AUTOLABEL_TRACES to benchmark against a recorded hardware session")
	}
	if sessionID == "" {
		sessionID = "session-173025-9"
	}
	rawJSON, err := os.ReadFile(filepath.Clean(stateJSONPath))
	if err != nil {
		t.Fatalf("ReadFile state JSON: %v", err)
	}
	var persisted PersistedEngineState
	if err := json.Unmarshal(rawJSON, &persisted); err != nil {
		t.Fatalf("Unmarshal state JSON: %v", err)
	}
	ts, err := tracestore.NewFileStore(tracesDir)
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	defer ts.Close()
	tm := ml.NewTeacherManager(t.TempDir(), nil)

	newEng := func() *Engine {
		m := NewRealEngine()
		m.RestoreState(persisted, false)
		cp := m.ExportState()
		e := NewRealEngine()
		e.RestoreState(cp, false)
		e.SetTraceStore(ts)
		e.SetTeacherManager(tm)
		aiMode := "ai"
		baseID := "ai-base-v0"
		_, _ = e.UpdateMLConfig(MLConfigPayload{DetectorMode: &aiMode, ActiveModelID: &baseID})
		return e
	}

	gtEng := newEng()
	var gt *domain.PracticeSession
	for _, s := range gtEng.PracticeSnapshot().Sessions {
		if s.SessionID == sessionID {
			cp := s
			gt = &cp
			break
		}
	}
	if gt == nil {
		t.Fatalf("session %q not found", sessionID)
	}
	var gtValid []domain.GateCrossingEvent
	for _, c := range gt.Crossings {
		if c.SlotIndex == 1 && c.InvalidReason == "" {
			gtValid = append(gtValid, c)
		}
	}
	sort.Slice(gtValid, func(i, j int) bool { return gtValid[i].TimestampUs < gtValid[j].TimestampUs })
	var gtLaps []domain.LapRecord
	for _, l := range gt.Laps {
		if l.SlotIndex == 1 && !l.Invalidated {
			gtLaps = append(gtLaps, l)
		}
	}
	sort.Slice(gtLaps, func(i, j int) bool { return gtLaps[i].CompletedAtUs < gtLaps[j].CompletedAtUs })

	totalExp, totalMatch := 0, 0
	for _, lap := range gtLaps {
		lapStartUs := uint64(math.Round(float64(lap.CompletedAtUs) - lap.LapTimeSec*1e6))
		lapEndUs := lap.CompletedAtUs
		winStartUs := lapStartUs - 350_000
		winEndUs := lapEndUs + 350_000
		var exp []domain.GateCrossingEvent
		for _, c := range gtValid {
			if c.TimestampUs+30_000 >= lapStartUs && c.TimestampUs <= lapEndUs+30_000 {
				exp = append(exp, c)
			}
		}
		eLap := newEng()
		for _, s := range eLap.PracticeSnapshot().Sessions {
			if s.SessionID == sessionID {
				for _, c := range s.Crossings {
					if c.SlotIndex == 1 && c.TimestampUs > lapStartUs+50_000 && c.TimestampUs+50_000 < lapEndUs {
						_, _ = eLap.DeletePracticeSessionCrossing(sessionID, c.EventID)
					}
				}
			}
		}
		bogus := float32(-64.0)
		_, _, _ = eLap.AddPracticeSessionCrossing(sessionID, 4, 1, lapStartUs+450_000, &bogus)
		if _, err := eLap.LabelPracticeSession(context.Background(), sessionID, MLSessionLabelRequest{
			DryRun: false, SlotIndex: 1, StartUs: winStartUs, EndUs: winEndUs,
		}); err != nil {
			t.Fatalf("lap %d LabelPracticeSession: %v", lap.LapNumber, err)
		}
		var got []domain.GateCrossingEvent
		for _, s := range eLap.PracticeSnapshot().Sessions {
			if s.SessionID == sessionID {
				for _, c := range s.Crossings {
					if c.SlotIndex == 1 && c.InvalidReason == "" && c.TimestampUs >= winStartUs && c.TimestampUs <= winEndUs {
						got = append(got, c)
					}
				}
			}
		}
		used := make([]bool, len(got))
		for _, ex := range exp {
			for gi, g := range got {
				if !used[gi] && g.GateID == ex.GateID && absMs(g.TimestampUs, ex.TimestampUs) <= 350.0 {
					used[gi] = true
					totalMatch++
					break
				}
			}
		}
		totalExp += len(exp)
	}
	pct := 100.0 * float64(totalMatch) / float64(totalExp)
	t.Logf("Real session %s polluted lap-by-lap match: %d/%d (%.1f%%)", sessionID, totalMatch, totalExp, pct)
	if pct < 95.0 {
		t.Fatalf("expected >= 95.0%% match on %s, got %.1f%% (%d/%d)", sessionID, pct, totalMatch, totalExp)
	}
	_ = fmt.Sprint(pct)
}
