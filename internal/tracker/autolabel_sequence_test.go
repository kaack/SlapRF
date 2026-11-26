package tracker

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
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

func readGzipTestdata(t *testing.T, relPath string) []byte {
	t.Helper()
	f, err := os.Open(filepath.Join("testdata", relPath))
	if err != nil {
		t.Fatalf("open testdata/%s: %v", relPath, err)
	}
	defer f.Close()
	gr, err := gzip.NewReader(f)
	if err != nil {
		t.Fatalf("gzip reader %s: %v", relPath, err)
	}
	defer gr.Close()
	raw, err := io.ReadAll(gr)
	if err != nil {
		t.Fatalf("read gzip %s: %v", relPath, err)
	}
	return raw
}

// cachedSampleStore serves pre-decoded `.rfbin` samples from memory so 20+ lap-by-lap engine runs
// in unit tests never re-decode multi-megabyte binary streams.
type cachedSampleStore struct {
	tracestore.Store
	samples map[string][]tracestore.Sample
}

func (c *cachedSampleStore) ReadSession(sessionID string) ([]tracestore.Sample, error) {
	if s, ok := c.samples[sessionID]; ok {
		return s, nil
	}
	return c.Store.ReadSession(sessionID)
}

// TestAutoLabelRecordedSessionsRegression runs both Full-Session Blank-Slate Auto-Label and
// Polluted Lap-by-Lap Auto-Label against the real hardware `.rfbin` waveforms of Session 2
// (`23` laps across 3 battery packs with BLE packet gaps on L20/L22/L23) and Session 3
// (`21` hand-labeled laps across 3 stints) using the untuned `ai-base-v0` base model.
func TestAutoLabelRecordedSessionsRegression(t *testing.T) {
	cases := []struct {
		name            string
		prefix          string
		minCompleteLaps int
		minLapMatch     float64
		minFullRec      float64
		minFullF1       float64
		matchTolMs      float64
	}{
		{
			name:            "Session 2 (23 laps, BLE gaps on L20/L22/L23)",
			prefix:          "autolabel_session2",
			minCompleteLaps: 23,
			minLapMatch:     99.5,
			minFullRec:      97.0,
			minFullF1:       89.0,
			matchTolMs:      450.0,
		},
		{
			name:            "Session 3 (21 hand-labeled laps)",
			prefix:          "autolabel_session3",
			minCompleteLaps: 21,
			minLapMatch:     99.5,
			minFullRec:      98.0,
			minFullF1:       95.5,
			matchTolMs:      400.0,
		},
		{
			name:            "25mW #1 Front yard (35 laps across 3 packs with slow passes)",
			prefix:          "autolabel_frontyard",
			minCompleteLaps: 34,
			minLapMatch:     97.0,
			minFullRec:      97.0,
			minFullF1:       94.5,
			matchTolMs:      450.0,
		},
		{
			name:            "25mW Verification (37 laps across 3 packs with straight-in approaches)",
			prefix:          "autolabel_verification",
			minCompleteLaps: 37,
			minLapMatch:     99.0,
			minFullRec:      98.0,
			minFullF1:       98.0,
			matchTolMs:      450.0,
		},
		{
			name:            "25mW V2 (32 laps across 3 packs with post-crest packet gaps)",
			prefix:          "autolabel_v2",
			minCompleteLaps: 32,
			minLapMatch:     99.5,
			minFullRec:      98.0,
			minFullF1:       97.0,
			matchTolMs:      450.0,
		},
		{
			name:            "25mW V3 (33 laps across 3 packs with stop-short power-off and wrong-battery plug-in)",
			prefix:          "autolabel_v3",
			minCompleteLaps: 33,
			minLapMatch:     99.5,
			minFullRec:      98.0,
			minFullF1:       98.0,
			matchTolMs:      450.0,
		},
	}

	tm := ml.NewTeacherManager(t.TempDir(), nil)

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			sessBytes := readGzipTestdata(t, tc.prefix+".json.gz")
			var gt domain.PracticeSession
			if err := json.Unmarshal(sessBytes, &gt); err != nil {
				t.Fatalf("unmarshal %s: %v", tc.prefix, err)
			}

			rfBytes := readGzipTestdata(t, tc.prefix+".rfbin.gz")
			mem := tracestore.NewMemoryStore()
			if _, err := mem.WriteRawBytes(gt.SessionID, rfBytes); err != nil {
				t.Fatalf("WriteRawBytes %s: %v", tc.prefix, err)
			}
			decoded, err := mem.ReadSession(gt.SessionID)
			if err != nil || len(decoded) == 0 {
				t.Fatalf("ReadSession %s: %v (n=%d)", tc.prefix, err, len(decoded))
			}
			ts := &cachedSampleStore{
				Store:   mem,
				samples: map[string][]tracestore.Sample{gt.SessionID: decoded},
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

			newTestEngine := func() *Engine {
				rawCopy, _ := json.Marshal(gt)
				var sessCopy domain.PracticeSession
				_ = json.Unmarshal(rawCopy, &sessCopy)

				var pil []domain.PilotSlot
				for _, sp := range sessCopy.Pilots {
					pil = append(pil, domain.PilotSlot{
						SlotIndex:    sp.SlotIndex,
						Callsign:     sp.Callsign,
						Band:         sp.Band,
						Channel:      sp.Channel,
						FrequencyMHz: sp.FrequencyMHz,
					})
				}
				rules := domain.DefaultTimingRules()
				if sessCopy.Rules != nil {
					rules = sessCopy.Rules.Normalized()
				}
				e := NewRealEngine()
				e.RestoreState(PersistedEngineState{
					TimingHardwareMode: domain.HardwareModeSlapRFBLE,
					Rules:              rules,
					Pilots:             pil,
					Gates:              append([]domain.TrackGate(nil), sessCopy.TrackSnapshot...),
					PracticeState: &domain.PracticeManagerState{
						SelectedSessionID: sessCopy.SessionID,
						Sessions:          []domain.PracticeSession{sessCopy},
					},
				}, false)
				e.SetTraceStore(ts)
				e.SetTeacherManager(tm)
				aiMode := "ai"
				baseID := "ai-base-v0"
				_, _ = e.UpdateMLConfig(MLConfigPayload{DetectorMode: &aiMode, ActiveModelID: &baseID})
				return e
			}

			// A. Polluted Lap-by-Lap Blank-Slate Auto-Label across all laps
			totalExp, totalMatch, complete5Laps := 0, 0, 0
			for _, lap := range gtLaps {
				lapStartUs := uint64(math.Round(float64(lap.CompletedAtUs) - lap.LapTimeSec*1e6))
				lapEndUs := lap.CompletedAtUs
				winLo := lapStartUs - 350_000
				winHi := lapEndUs + 350_000

				var exp []domain.GateCrossingEvent
				for _, c := range gtValid {
					if c.TimestampUs+30_000 >= lapStartUs && c.TimestampUs <= lapEndUs+30_000 {
						exp = append(exp, c)
					}
				}

				eLap := newTestEngine()
				for _, s := range eLap.PracticeSnapshot().Sessions {
					if s.SessionID == gt.SessionID {
						for _, c := range s.Crossings {
							if c.SlotIndex == 1 && c.TimestampUs > lapStartUs+50_000 && c.TimestampUs+50_000 < lapEndUs {
								_, _ = eLap.DeletePracticeSessionCrossing(gt.SessionID, c.EventID)
							}
						}
					}
				}
				bogus := float32(-64.0)
				_, _, _ = eLap.AddPracticeSessionCrossing(gt.SessionID, 4, 1, lapStartUs+450_000, &bogus)

				res, err := eLap.LabelPracticeSession(context.Background(), gt.SessionID, MLSessionLabelRequest{
					DryRun:    false,
					SlotIndex: 1,
					StartUs:   winLo,
					EndUs:     winHi,
				})
				if err != nil {
					t.Fatalf("L%d LabelPracticeSession: %v", lap.LapNumber, err)
				}

				var got []domain.GateCrossingEvent
				for _, s := range res.Practice.Sessions {
					if s.SessionID == gt.SessionID {
						for _, c := range s.Crossings {
							if c.SlotIndex == 1 && c.TimestampUs >= winLo && c.TimestampUs <= winHi {
								if c.InvalidReason != "" {
									t.Fatalf("L%d unexpected invalid crossing after Auto-Label: %+v", lap.LapNumber, c)
								}
								got = append(got, c)
							}
						}
					}
				}
				if len(got) >= len(exp) || (lap.LapTimeSec > 21.0 && len(got) >= 5) {
					complete5Laps++
				} else {
					t.Logf("[%s] L%d dur=%.2fs got=%d exp=%d", tc.prefix, lap.LapNumber, lap.LapTimeSec, len(got), len(exp))
				}
				used := make([]bool, len(got))
				for _, ex := range exp {
					for gi, g := range got {
						if !used[gi] && g.GateID == ex.GateID && absMs(g.TimestampUs, ex.TimestampUs) <= tc.matchTolMs {
							used[gi] = true
							totalMatch++
							break
						}
					}
				}
				totalExp += len(exp)
			}

			lapPct := 100.0 * float64(totalMatch) / float64(totalExp)
			t.Logf("[%s] Lap-by-lap polluted blank-slate: %d/%d crossings matched (%.1f%%), 5-crossing laps=%d/%d",
				tc.prefix, totalMatch, totalExp, lapPct, complete5Laps, len(gtLaps))
			if complete5Laps < tc.minCompleteLaps {
				t.Fatalf("[%s] expected >= %d complete laps, got %d/%d",
					tc.prefix, tc.minCompleteLaps, complete5Laps, len(gtLaps))
			}
			if lapPct < tc.minLapMatch {
				t.Fatalf("[%s] lap-by-lap match %.1f%% below minimum %.1f%%", tc.prefix, lapPct, tc.minLapMatch)
			}

			// B. Full-Session Blank-Slate Auto-Label (all crossings & laps wiped)
			eFull := newTestEngine()
			if _, err := eFull.PracticeAction(PracticeActionPayload{
				Action:    "clear_pilot_laps",
				SessionID: gt.SessionID,
				SlotIndex: 1,
			}); err != nil {
				t.Fatalf("clear_pilot_laps: %v", err)
			}
			fullRes, err := eFull.LabelPracticeSession(context.Background(), gt.SessionID, MLSessionLabelRequest{
				DryRun:    false,
				SlotIndex: 1,
			})
			if err != nil {
				t.Fatalf("full-session LabelPracticeSession: %v", err)
			}

			var fullGot []domain.GateCrossingEvent
			var fullLaps int
			for _, s := range fullRes.Practice.Sessions {
				if s.SessionID == gt.SessionID {
					fullLaps = len(s.Laps)
					for _, c := range s.Crossings {
						if c.SlotIndex == 1 {
							if c.InvalidReason != "" {
								t.Fatalf("[%s] unexpected invalid crossing in full-session Auto-Label: %+v", tc.prefix, c)
							}
							fullGot = append(fullGot, c)
						}
					}
				}
			}

			usedF := make([]bool, len(fullGot))
			matchedF := 0
			for _, ex := range gtValid {
				bestI := -1
				bestD := 1e9
				for gi, g := range fullGot {
					if usedF[gi] || g.GateID != ex.GateID {
						continue
					}
					d := absMs(g.TimestampUs, ex.TimestampUs)
					if d <= tc.matchTolMs && d < bestD {
						bestD = d
						bestI = gi
					}
				}
				if bestI >= 0 {
					usedF[bestI] = true
					matchedF++
				}
			}
			rec := 100.0 * float64(matchedF) / float64(len(gtValid))
			prec := 0.0
			if len(fullGot) > 0 {
				prec = 100.0 * float64(matchedF) / float64(len(fullGot))
			}
			f1 := 0.0
			if prec+rec > 0 {
				f1 = 2.0 * prec * rec / (prec + rec)
			}
			t.Logf("[%s] Full-session blank-slate: matched=%d/%d (got=%d, recall=%.1f%%, precision=%.1f%%, F1=%.1f%%), laps=%d/%d",
				tc.prefix, matchedF, len(gtValid), len(fullGot), rec, prec, f1, fullLaps, len(gtLaps))
			if matchedF == 0 && len(fullGot) > 0 {
				t.Logf("  sample fullGot[0]=%+v vs gtValid[0]=%+v", fullGot[0], gtValid[0])
			}

			if rec < tc.minFullRec {
				t.Fatalf("[%s] full-session recall %.1f%% below minimum %.1f%%", tc.prefix, rec, tc.minFullRec)
			}
			if f1 < tc.minFullF1 {
				t.Fatalf("[%s] full-session F1 %.1f%% below minimum %.1f%%", tc.prefix, f1, tc.minFullF1)
			}
		})
	}
}
