package tracker

import (
	"bytes"
	"testing"
	"time"

	"slaprf/internal/domain"
	"slaprf/internal/tracestore"
)

func TestHandsFreePackLoopTraceReplayAndOnDeviceMLTraining(t *testing.T) {
	eng := NewRealEngine()
	eng.SetTimingHardwareMode(domain.HardwareModeSlapRFBLE, false)
	dir := t.TempDir()
	fs, err := tracestore.NewFileStore(dir)
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	defer fs.Close()
	eng.SetTraceStore(fs)

	// Provision Hub H1 (Start/Finish) + Spoke T1 (Sector)
	if _, err := eng.ProvisionGate(ProvisionRequest{Role: "hub", Label: "H1", Fingerprint: "EFE44224", FromHubHello: true}); err != nil {
		t.Fatalf("ProvisionGate H1: %v", err)
	}
	t1TimerID, err := eng.ProvisionGate(ProvisionRequest{Role: "spoke", Label: "T1", Fingerprint: "D3FEDE5D"})
	if err != nil {
		t.Fatalf("ProvisionGate T1: %v", err)
	}
	if _, err := eng.AddGate("T1", t1TimerID); err != nil {
		t.Fatalf("AddGate T1: %v", err)
	}

	// Enable Hands-Free Pack Loop with a 12-second quiet timeout
	enable := true
	quietSec := 12
	ps, err := eng.PracticeAction(PracticeActionPayload{
		Action:           "set_pack_loop",
		PackLoopEnabled:  &enable,
		PackLoopQuietSec: &quietSec,
	})
	if err != nil {
		t.Fatalf("set_pack_loop: %v", err)
	}
	if !ps.PackLoopEnabled || ps.ActiveSessionID == "" {
		t.Fatalf("expected active Pack 1 session, got %+v", ps)
	}
	pack1ID := ps.ActiveSessionID

	ts := uint64(2_000_000)
	feedBoth := func(h1Dbm, t1Dbm float32, steps int) {
		for i := 0; i < steps; i++ {
			var rH1, rT1 [domain.MaxPilotPoolSize]float32
			for k := range rH1 {
				rH1[k] = -127
				rT1[k] = -127
			}
			rH1[0] = h1Dbm
			rT1[0] = t1Dbm
			eng.IngestTelemetryFrame(domain.TimerTelemetryFrame{
				TimerID:       1,
				SeqNum:        uint32(i),
				TimestampUs:   ts,
				RSSI:          rH1,
				BatteryMv:     4100,
				NoiseFloorDbm: -91,
			})
			eng.IngestTelemetryFrame(domain.TimerTelemetryFrame{
				TimerID:       t1TimerID,
				SeqNum:        uint32(i),
				TimestampUs:   ts + 5_000,
				RSSI:          rT1,
				BatteryMv:     4100,
				NoiseFloorDbm: -91,
			})
			ts += 20_000
		}
	}

	flyPass := func(isH1 bool) {
		for s := 0; s < 35; s++ {
			dt := (float64(s) - 17.0) * 0.02
			v := float32(-82.0 + 34.0/(1.0+(dt/0.18)*(dt/0.18)))
			if isH1 {
				feedBoth(v, -83.0, 1)
			} else {
				feedBoth(-83.0, v, 1)
			}
		}
	}

	// Settle floor, then fly 2 complete laps: H1 (start) -> T1 -> H1 (lap 1) -> T1 -> H1 (lap 2)
	feedBoth(-91.0, -91.0, 20)
	feedBoth(-81.0, -83.0, 25) // VTX powered on
	flyPass(true)
	feedBoth(-82.0, -82.0, 150) // 3.0s cruise
	flyPass(false)
	feedBoth(-82.0, -82.0, 150) // 3.0s cruise
	flyPass(true)               // Lap 1 complete (~7.4s)
	feedBoth(-82.0, -82.0, 150)
	flyPass(false)
	feedBoth(-82.0, -82.0, 150)
	flyPass(true) // Lap 2 complete

	snapMid := eng.PracticeSnapshot()
	if snapMid.ActiveSessionID != pack1ID {
		t.Fatalf("expected Pack 1 still active while VTX on, got %q", snapMid.ActiveSessionID)
	}

	// Unplug VTX (-91 dBm on all timers) for 13 seconds (> 12s quietSec) -> auto-seals Pack 1 & creates Pack 2!
	feedBoth(-91.0, -91.0, 660)

	snapAfter := eng.PracticeSnapshot()
	if snapAfter.ActiveSessionID == "" || snapAfter.ActiveSessionID == pack1ID {
		t.Fatalf("expected Hands-Free Pack Loop to seal %q and arm Pack 2, got active=%q", pack1ID, snapAfter.ActiveSessionID)
	}
	if snapAfter.LastSealedSessionID != pack1ID || snapAfter.LastSealedLapCount < 1 {
		t.Fatalf("expected LastSealedSessionID=%q with >=1 lap, got id=%q laps=%d", pack1ID, snapAfter.LastSealedSessionID, snapAfter.LastSealedLapCount)
	}
	pack2ID := snapAfter.ActiveSessionID

	// Verify `.rfbin` trace replay works for sealed Pack 1
	replayFrames, err := eng.SessionTraceFrames(pack1ID)
	if err != nil || len(replayFrames) < 500 {
		t.Fatalf("expected replayable .rfbin frames for Pack 1, len=%d err=%v", len(replayFrames), err)
	}

	// Pause Pack 2 so idle base training is permitted, mark Pack 1 verified, and train AI Base v1
	if _, err := eng.PracticeAction(PracticeActionPayload{Action: "pause_session", SessionID: pack2ID}); err != nil {
		t.Fatalf("pause_session: %v", err)
	}
	verified := true
	if _, err := eng.PracticeAction(PracticeActionPayload{
		Action:           "set_training_verified",
		SessionID:        pack1ID,
		TrainingVerified: &verified,
	}); err != nil {
		t.Fatalf("set_training_verified: %v", err)
	}

	if _, err := eng.StartMLTraining(MLTrainRequest{Epochs: 8}); err != nil {
		t.Fatalf("StartMLTraining: %v", err)
	}
	deadline := time.Now().Add(15 * time.Second)
	var trainedID string
	for time.Now().Before(deadline) {
		st := eng.MLStatus()
		if !st.Training.Running && st.Training.CompletedModelID != "" {
			trainedID = st.Training.CompletedModelID
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if trainedID == "" {
		t.Fatalf("timed out waiting for background ML training: %+v", eng.MLStatus().Training)
	}

	// Continue fine-tuning the draft model (+4 epochs) and mark it Ready!
	if _, err := eng.StartMLTraining(MLTrainRequest{
		Epochs:          4,
		SessionIDs:      []string{pack1ID},
		ContinueModelID: trainedID,
		ModelName:       "Backyard 2-Gate Ready",
	}); err != nil {
		t.Fatalf("StartMLTraining continue: %v", err)
	}
	for time.Now().Before(deadline) {
		st := eng.MLStatus()
		if !st.Training.Running && st.Training.CompletedModelID == trainedID {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	readyTrue := true
	stReady, err := eng.UpdateMLModel(trainedID, MLModelUpdatePayload{Ready: &readyTrue})
	if err != nil {
		t.Fatalf("UpdateMLModel ready: %v", err)
	}
	if !stReady.Models[0].Ready || stReady.Models[0].Name != "Backyard 2-Gate Ready" {
		t.Fatalf("expected model marked Ready with updated name, got %+v", stReady.Models[0])
	}

	// Activate trained AI Base v1 + Live 2-Lap Tune and fly 2 laps in Pack 2!
	aiMode := "ai"
	liveTune := true
	if _, err := eng.UpdateMLConfig(MLConfigPayload{
		DetectorMode:    &aiMode,
		ActiveModelID:   &trainedID,
		LiveTuneEnabled: &liveTune,
	}); err != nil {
		t.Fatalf("UpdateMLConfig: %v", err)
	}
	if _, err := eng.PracticeAction(PracticeActionPayload{Action: "resume_session", SessionID: pack2ID}); err != nil {
		t.Fatalf("resume_session: %v", err)
	}

	feedBoth(-91.0, -91.0, 20)
	flyPass(true)
	feedBoth(-82.0, -82.0, 150)
	flyPass(false)
	feedBoth(-82.0, -82.0, 150)
	flyPass(true) // Lap 1
	feedBoth(-82.0, -82.0, 150)
	flyPass(false)
	feedBoth(-82.0, -82.0, 150)
	flyPass(true) // Lap 2
	feedBoth(-91.0, -91.0, 25) // flush 280 ms lookahead

	pack2Snap := eng.PracticeSnapshot()
	var pack2 *domain.PracticeSession
	for i := range pack2Snap.Sessions {
		if pack2Snap.Sessions[i].SessionID == pack2ID {
			pack2 = &pack2Snap.Sessions[i]
			break
		}
	}
	if pack2 == nil || len(pack2.Laps) < 2 {
		t.Fatalf("expected AI Detector to record >= 2 laps in Pack 2, got %+v", pack2)
	}
	mlSt := eng.MLStatus()
	if len(mlSt.LiveTunes) == 0 {
		t.Fatalf("expected Live 2-Lap Adapter to populate LiveTunes after 2 laps in Pack 2")
	}

	// Test portable .tar.gz dataset + model export/import into a fresh engine
	var bundle bytes.Buffer
	if err := eng.ExportMLDatasetTarGz(&bundle); err != nil {
		t.Fatalf("ExportMLDatasetTarGz: %v", err)
	}
	eng2 := NewRealEngine()
	impSess, impMod, err := eng2.ImportMLDatasetTarGz(&bundle)
	if err != nil {
		t.Fatalf("ImportMLDatasetTarGz: %v", err)
	}
	if impSess < 1 || impMod < 1 {
		t.Fatalf("expected >=1 imported session and >=1 model, got sess=%d mod=%d", impSess, impMod)
	}
	frames2, err := eng2.SessionTraceFrames(pack1ID)
	if err != nil || len(frames2) != len(replayFrames) {
		t.Fatalf("expected imported trace frames (%d) to match exported (%d), err=%v", len(frames2), len(replayFrames), err)
	}
}
