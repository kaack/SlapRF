package ingest

import (
	"math/rand"
	"testing"
	"time"

	"slaprf/internal/domain"
	"slaprf/internal/multigp"
	"slaprf/internal/tracker"
	_ "slaprf/web"
)

// TestSimulatedLapsVisitEveryGate runs 10 simulated minutes on a deterministic clock and
// checks that every lap passes through every gate. A skipped gate means the peak detector
// missed a real pass — which would corrupt sector analysis.
func TestSimulatedLapsVisitEveryGate(t *testing.T) {
	engine := tracker.NewEngine()
	sim := NewTrackSimulator(engine)
	sim.rng = rand.New(rand.NewSource(42))

	var nowUs uint64 = 1_000_000
	sim.clock = func() uint64 { return nowUs }

	const frames = 10 * 60 * 50
	for i := 0; i < frames; i++ {
		sim.step(0.020)
		nowUs += 20_000
	}

	_, gates, laps, _, _ := engine.StateSnapshot()
	if len(laps) < 60 {
		t.Fatalf("expected at least 60 laps in 10 minutes, got %d", len(laps))
	}
	incomplete := 0
	for _, lap := range laps {
		if len(lap.Sectors) != len(gates) {
			incomplete++
			t.Logf("%s lap %d: %d sectors %+v", lap.Callsign, lap.LapNumber, len(lap.Sectors), lap.Sectors)
		}
	}
	if incomplete > 0 {
		t.Fatalf("%d of %d laps skipped a gate", incomplete, len(laps))
	}
}

func TestSimulatorControlsAndTimerLifecycle(t *testing.T) {
	engine := tracker.NewEngine()
	sim := NewTrackSimulator(engine)

	// 1. Force crash on slot 1 (Faerry)
	sim.TriggerPilotAction(1, "crash")
	snap := sim.Snapshot()
	if len(snap.Pilots) == 0 || snap.Pilots[0].Status != "CRASHED_VTX_ON" || !snap.Pilots[0].VtxActive {
		t.Fatalf("expected slot 1 to be CRASHED_VTX_ON with VTX active, got %+v", snap.Pilots[0])
	}

	// 2. Trigger turtle recovery -> enters TURTLE_RECOVERY before resuming FLYING
	sim.TriggerPilotAction(1, "recover")
	snap = sim.Snapshot()
	if snap.Pilots[0].Status != "TURTLE_RECOVERY" || !snap.Pilots[0].VtxActive {
		t.Fatalf("expected slot 1 to enter TURTLE_RECOVERY with VTX active, got %+v", snap.Pilots[0])
	}

	// 3. Activate track walker -> flying pilots climb to AVOIDING or return to pit, crashed pilot enters WALKING_RECOVERY on field
	sim.SetTrackWalker(true)
	snap = sim.Snapshot()
	if !snap.TrackWalkerActive {
		t.Fatalf("expected TrackWalkerActive=true")
	}
	if snap.Pilots[0].Status != "WALKING_RECOVERY" || snap.Pilots[0].StateRemainingSec <= 0 {
		t.Fatalf("expected crashed pilot to enter WALKING_RECOVERY on field during track walk, got %+v", snap.Pilots[0])
	}
	if snap.Pilots[1].Status != "AVOIDING" && snap.Pilots[1].Status != "LANDING" && snap.Pilots[1].Status != "PIT_SWAP" && snap.Pilots[1].Status != "PILOT_BREAK" && snap.Pilots[1].Status != "CHARGING_WAIT" {
		t.Fatalf("expected flying pilot to react by climbing to AVOIDING or landing to pits, got %+v", snap.Pilots[1])
	}
	sim.SetTrackWalker(false)
	snap = sim.Snapshot()
	if snap.Pilots[0].Status != "PIT_SWAP" && snap.Pilots[0].Status != "PILOT_BREAK" && snap.Pilots[0].Status != "CHARGING_WAIT" {
		t.Fatalf("expected crashed pilot to move to pit state after recovery walk finishes, got %s", snap.Pilots[0].Status)
	}
	if len(snap.Pilots[0].Packs) != 3 {
		t.Fatalf("expected 3 LiPo packs per pilot, got %d", len(snap.Pilots[0].Packs))
	}

	// Slot 3 (Din) starts airborne with Pack #2 (78%) and Pack #3 (40%) charging;
	// pitting first enters the 5s LANDING stage, and once landed enters CHARGING_WAIT.
	sim.TriggerPilotAction(3, "pit")
	snap = sim.Snapshot()
	if snap.Pilots[2].Status != "LANDING" {
		t.Fatalf("expected slot 3 to enter LANDING stage first, got %s", snap.Pilots[2].Status)
	}
	sim.step(5.1)
	snap = sim.Snapshot()
	if snap.Pilots[2].Status != "CHARGING_WAIT" {
		t.Fatalf("expected slot 3 to enter CHARGING_WAIT after landing when all 3 packs are < 100%%, got %s", snap.Pilots[2].Status)
	}

	// 3. Toggle power off on T2, add T5, delete T5
	if poweredOn := sim.ToggleTimerPower(2); poweredOn {
		t.Fatalf("expected T2 to be powered off")
	}
	snap = sim.Snapshot()
	for _, tm := range snap.Timers {
		if tm.TimerID == 2 && (tm.PoweredOn || tm.Online) {
			t.Fatalf("expected T2 PoweredOn=false and Online=false, got %+v", tm)
		}
	}
	if poweredOn := sim.ToggleTimerPower(2); !poweredOn {
		t.Fatalf("expected T2 to be powered back on")
	}

	newID, err := sim.AddTimer("spoke", "T6 Split-S Exit")
	if err != nil || newID != 6 {
		t.Fatalf("expected AddTimer to create T6 (id=6; T1 hub + T2..T5 spokes exist), got id=%d err=%v", newID, err)
	}
	if err := sim.DeleteTimer(newID); err != nil {
		t.Fatalf("expected DeleteTimer(6) to succeed, got %v", err)
	}
}

// The simulated Hub is a gate-less collector: it produces no telemetry or crossings until it is
// dragged onto a gate, then times that gate like a Spoke, and stops again once dragged off.
func TestSimulatedHubSweepsOnlyWhileOnAGate(t *testing.T) {
	engine := tracker.NewEngine()
	sim := NewTrackSimulator(engine)
	sim.rng = rand.New(rand.NewSource(7))
	var nowUs uint64 = 1_000_000
	sim.clock = func() uint64 { return nowUs }
	run := func(seconds int) {
		for i := 0; i < seconds*50; i++ {
			sim.step(0.020)
			nowUs += 20_000
		}
	}
	hubID := domain.SimHubTimerID
	gateOf := func() (domain.TrackGate, bool) {
		_, gates, _, _, _ := engine.StateSnapshot()
		for _, g := range gates {
			if g.AssignedTimerID == hubID {
				return g, true
			}
		}
		return domain.TrackGate{}, false
	}
	crossingsAt := func(gateID uint8) int {
		_, _, _, crossings, _ := engine.StateSnapshot()
		n := 0
		for _, c := range crossings {
			if c.GateID == gateID {
				n++
			}
		}
		return n
	}

	run(30)
	if _, onGate := gateOf(); onGate {
		t.Fatal("simulated hub must not hold a gate by default")
	}
	hubOnline := false
	for _, d := range engine.DetectedTimersSnapshot() {
		if d.TimerID == hubID {
			hubOnline = d.IsHub && d.Online
		}
	}
	if !hubOnline {
		t.Fatal("gate-less simulated hub should still be registered and online")
	}

	// Drag the hub onto gate 3 (replacing its spoke): the gate keeps producing crossings, now
	// from the hub's own sweep.
	_, gates, _, _, _ := engine.StateSnapshot()
	target := gates[2]
	if err := engine.UpdateGate(domain.GateUpdate{GateID: target.GateID, Name: target.Name, Role: target.Role, AssignedTimerID: &hubID}); err != nil {
		t.Fatal(err)
	}
	before := crossingsAt(target.GateID)
	framesBefore := target.FramesRxCount
	run(30)
	g, onGate := gateOf()
	if !onGate || g.GateID != target.GateID {
		t.Fatal("hub should time the gate it was dragged onto")
	}
	if g.FramesRxCount <= framesBefore || crossingsAt(target.GateID) <= before {
		t.Fatalf("hub on gate %d produced no telemetry/crossings (frames %d->%d)", target.GateID, framesBefore, g.FramesRxCount)
	}

	// Drag it off (leave the gate empty): no more telemetry or crossings at that gate.
	none := uint8(0)
	if err := engine.UpdateGate(domain.GateUpdate{GateID: target.GateID, Name: target.Name, Role: target.Role, AssignedTimerID: &none}); err != nil {
		t.Fatal(err)
	}
	_, gates, _, _, _ = engine.StateSnapshot()
	framesOff := gates[2].FramesRxCount
	offCount := crossingsAt(target.GateID)
	run(30)
	_, gates, _, _, _ = engine.StateSnapshot()
	if gates[2].FramesRxCount != framesOff || crossingsAt(target.GateID) != offCount {
		t.Fatalf("empty gate %d kept receiving telemetry after the hub was dragged off", target.GateID)
	}
}

// TestSimulatedHubUsbWindowPipelineRequiresUsbConnection verifies that when a Hub USB sink is
// attached (matching the browser WASM + WebSerial pipeline), simulated timers record 4-sample
// sliding-window frames (0xC5 0x59) and emit 0x1E-prefixed Hub USB packets, so no laps or online
// timers appear while USB is disconnected, and full timing resumes as soon as H1 is connected.
func TestSimulatedHubUsbWindowPipelineRequiresUsbConnection(t *testing.T) {
	engine := tracker.NewEngine()
	sim := NewTrackSimulator(engine)
	sim.rng = rand.New(rand.NewSource(99))
	hubRx := NewHubFrameDecoder(engine)

	var nowUs uint64 = 1_000_000
	sim.clock = func() uint64 { return nowUs }

	usbConnected := false
	usbPacketsRx := 0
	feedRawUsbStream := func(raw []byte) {
		if !usbConnected || len(raw) == 0 {
			return
		}
		// Split [0x1E][len][frame] Hub records exactly like TimerConsole on the browser side.
		for i := 0; i < len(raw); {
			if raw[i] != 0x1E || i+2 > len(raw) {
				i++
				continue
			}
			pktLen := int(raw[i+1])
			if pktLen <= 0 || i+2+pktLen > len(raw) {
				i++
				continue
			}
			pkt := raw[i+2 : i+2+pktLen]
			hubRx.IngestPacket(pkt, nowUs)
			usbPacketsRx++
			i += 2 + pktLen
		}
	}

	sim.SetHubFrameSink(feedRawUsbStream)
	engine.SetAllTimersOffline()

	// Phase 1: Run 40 simulated seconds with USB disconnected -> 0 online timers, 0 laps, 0 crossings,
	// while simulated timers still sample live 5.8 GHz RSSI internally.
	for i := 0; i < 40*50; i++ {
		sim.step(0.020)
		nowUs += 20_000
	}
	_, gates, laps, crossings, _ := engine.StateSnapshot()
	if len(laps) != 0 || len(crossings) != 0 {
		t.Fatalf("expected 0 laps and 0 crossings while USB is disconnected, got %d laps and %d crossings", len(laps), len(crossings))
	}
	for _, g := range gates {
		if g.Online {
			t.Fatalf("expected gate %d to remain offline while USB is disconnected", g.GateID)
		}
	}
	snap := sim.Snapshot()
	if len(snap.Timers) == 0 || snap.Timers[0].LastRSSI[0] >= 0 {
		t.Fatalf("expected simulated timers to still sample internal 5.8 GHz RSSI while USB is disconnected")
	}

	// Phase 2: Connect H1 over USB -> flush initial HELLOs and run 60 simulated seconds.
	usbConnected = true
	feedRawUsbStream(sim.BuildHubHelloStream())
	for i := 0; i < 60*50; i++ {
		sim.step(0.020)
		nowUs += 20_000
	}
	if usbPacketsRx == 0 {
		t.Fatalf("expected Hub USB packets to be emitted once USB is connected")
	}
	_, gates, laps, crossings, _ = engine.StateSnapshot()
	for _, g := range gates {
		if !g.Online || g.FramesRxCount == 0 {
			t.Fatalf("expected gate %d to be online with frames after connecting H1 over USB (online=%v frames=%d)", g.GateID, g.Online, g.FramesRxCount)
		}
	}
	if len(crossings) == 0 || len(laps) == 0 {
		t.Fatalf("expected gate crossings and laps once H1 is connected over USB, got %d crossings and %d laps", len(crossings), len(laps))
	}

	// Phase 3: Power off Hub H1 -> no more USB packets emitted even though USB cable is plugged in.
	sim.ToggleTimerPower(domain.SimHubTimerID)
	pktsBefore := usbPacketsRx
	for i := 0; i < 5*50; i++ {
		sim.step(0.020)
		nowUs += 20_000
	}
	if usbPacketsRx != pktsBefore {
		t.Fatalf("expected powered-off Hub H1 to emit 0 USB packets, got %d new packets", usbPacketsRx-pktsBefore)
	}
}

func TestSimulatedBoardsBlankEraseAndFlash(t *testing.T) {
	engine := tracker.NewEngine()
	sim := NewTrackSimulator(engine)

	// 1. Add a factory-blank board -> occupies Board #6 as Unflashed, not in engine.detected.
	id, err := sim.AddTimer("unflashed", "")
	if err != nil {
		t.Fatalf("AddTimer(unflashed) failed: %v", err)
	}
	if id != 6 {
		t.Fatalf("expected blank board to get ID 6, got %d", id)
	}
	if engine.HasDetectedTimer(6) {
		t.Fatalf("expected unflashed board #6 not to be registered in engine.detected")
	}
	snap := sim.Snapshot()
	if len(snap.Timers) != 6 || !snap.Timers[5].Unflashed {
		t.Fatalf("expected 6 boards in snapshot with Board #6 marked Unflashed, got %+v", snap.Timers)
	}

	// 2. Erase Board #2 (Spoke T1 on Gate #1) -> Board #2 becomes Unflashed and Gate #1 becomes unassigned.
	if err := sim.EraseBoard(2); err != nil {
		t.Fatalf("EraseBoard(2) failed: %v", err)
	}
	if engine.HasDetectedTimer(2) {
		t.Fatalf("expected erased board #2 to be removed from engine.detected")
	}
	_, gates, _, _, _ := engine.StateSnapshot()
	if len(gates) != 4 || gates[0].AssignedTimerID != 0 {
		t.Fatalf("expected Gate #1 to remain on course but unassigned after erasing Board #2, got %+v", gates[0])
	}

	// 3. Flash Board #6 as Spoke T1 -> Board #6 becomes a flashed Spoke and binds to the empty Gate #1.
	if err := sim.FlashBoard(6, "spoke", "T1", "AABBCC06", "v0.1.4"); err != nil {
		t.Fatalf("FlashBoard(6) failed: %v", err)
	}
	if !engine.HasDetectedTimer(6) {
		t.Fatalf("expected flashed board #6 to be registered in engine.detected")
	}
	_, gates, _, _, _ = engine.StateSnapshot()
	if gates[0].AssignedTimerID != 6 || gates[0].TimerLabel != "T1" {
		t.Fatalf("expected flashed Spoke Board #6 to bind to empty Gate #1, got %+v", gates[0])
	}
	snap = sim.Snapshot()
	for _, b := range snap.Timers {
		if b.TimerID == 2 && !b.Unflashed {
			t.Fatalf("expected Board #2 to remain Unflashed")
		}
		if b.TimerID == 6 && (b.Unflashed || b.IsHub || b.TimerLabel != "T1") {
			t.Fatalf("expected Board #6 to be flashed as Spoke T1, got %+v", b)
		}
	}
}

func TestSimulatedLapRFTimerLabelsAndMigration(t *testing.T) {
	engine := tracker.NewEngine()
	engine.SetTimingHardwareMode(domain.HardwareModeLapRF, true)
	sim := NewTrackSimulator(engine)

	units := sim.Snapshot().LapRFUnits
	if len(units) != 2 || units[0].Label != "L1" || units[1].Label != "L2" {
		t.Fatalf("expected default simulated LapRF units L1 and L2, got %+v", units)
	}

	units, err := sim.ApplyLapRFAction(SimLapRFActionRequest{Action: "add"})
	if err != nil {
		t.Fatalf("ApplyLapRFAction(add) failed: %v", err)
	}
	if len(units) != 3 || units[2].Label != "L3" {
		t.Fatalf("expected newly added LapRF unit label L3, got %+v", units)
	}

	opts := sim.ExportOptions()
	opts.LapRFUnits[0].Label = "LapRF #1"
	opts.LapRFUnits[1].Label = "LapRF #2"
	sim.RestoreOptions(opts)

	migrated := sim.Snapshot().LapRFUnits
	if migrated[0].Label != "L1" || migrated[1].Label != "L2" {
		t.Fatalf("expected legacy LapRF #N labels to migrate to L1/L2, got %+v", migrated)
	}
}

func TestSimulatorSpeedMultiplierCompletesHeatFast(t *testing.T) {
	engine := tracker.NewEngine()
	sim := NewTrackSimulator(engine)
	sim.SetSpeedMultiplier(20)
	if sim.SpeedMultiplier() != 20 {
		t.Fatalf("expected SpeedMultiplier() == 20, got %d", sim.SpeedMultiplier())
	}

	view := multigp.RaceViewData{
		ID:            901,
		Name:          "Fast Sim Sprint",
		ChapterID:     77,
		ChapterName:   "Bay Area FPV",
		ScoringFormat: 0,
		MaxLaps:       3,
		RaceTimeSec:   120,
		Entries: []multigp.RaceEntry{
			{PilotID: 1001, UserName: "MIGUEL", Band: "R", Channel: "1", Frequency: 5658},
			{PilotID: 1002, UserName: "NOVA", Band: "R", Channel: "2", Frequency: 5695},
		},
		Schedule: multigp.RaceSchedule{
			Rounds: []multigp.ScheduleRound{
				{
					RoundNumber: 1,
					Name:        "Round 1",
					Heats: []multigp.ScheduleHeat{
						{
							HeatNumber: 1,
							Name:       "Heat 1",
							Entries: []multigp.HeatEntry{
								{Slot: 1, PilotID: 1001, UserName: "MIGUEL", Band: "R", Channel: "1", Frequency: 5658},
								{Slot: 2, PilotID: 1002, UserName: "NOVA", Band: "R", Channel: "2", Frequency: 5695},
							},
						},
					},
				},
			},
		},
	}

	created, err := engine.ImportMultiGPRace(view, "schedule", "")
	if err != nil {
		t.Fatalf("ImportMultiGPRace failed: %v", err)
	}
	if len(created.Heats) != 1 {
		t.Fatalf("expected 1 heat, got %d", len(created.Heats))
	}
	heatID := created.Heats[0].ID

	if _, err := engine.EventAction(tracker.EventActionPayload{
		Action:          "race_lifecycle",
		RaceID:          created.RaceID,
		LifecycleAction: "start_race",
	}); err != nil {
		t.Fatalf("start_race failed: %v", err)
	}
	if _, err := engine.RaceControlActionForRace(created.RaceID, "start", heatID); err != nil {
		t.Fatalf("start heat failed: %v", err)
	}

	sim.Start()
	defer sim.Stop()

	deadline := time.Now().Add(7 * time.Second)
	var finishedHeat *domain.RaceHeat
	for time.Now().Before(deadline) {
		rs := engine.RaceSnapshot()
		for i := range rs.Heats {
			if rs.Heats[i].ID == heatID {
				h := rs.Heats[i]
				allDone := len(h.Seats) > 0
				for _, s := range h.Seats {
					if s.PilotSlotIndex > 0 && s.LapsCompleted < 3 {
						allDone = false
					}
				}
				if h.State == domain.HeatFinished || allDone {
					cp := h
					finishedHeat = &cp
					break
				}
			}
		}
		if finishedHeat != nil {
			break
		}
		time.Sleep(40 * time.Millisecond)
	}
	if finishedHeat == nil {
		rs := engine.RaceSnapshot()
		t.Fatalf("expected 3-lap heat to complete within 7s at 20x speed; heat state=%+v", rs.Heats)
	}
	for _, seat := range finishedHeat.Seats {
		if seat.PilotSlotIndex <= 0 {
			continue
		}
		if seat.LapsCompleted < 3 {
			t.Fatalf("expected pilot %s to have >=3 laps, got %d", seat.Callsign, seat.LapsCompleted)
		}
		if seat.BestLapSec < 8.0 || seat.BestLapSec > 25.0 {
			t.Fatalf("expected realistic lap duration (~13-15s) at 20x speed, got %.2fs for %s", seat.BestLapSec, seat.Callsign)
		}
	}

	if finishedHeat.State != domain.HeatFinished {
		if _, err := engine.RaceControlActionForRace(created.RaceID, "stop", heatID); err != nil {
			t.Fatalf("stop heat failed: %v", err)
		}
	}
	if _, err := engine.RaceControlActionForRace(created.RaceID, "confirm", heatID); err != nil {
		t.Fatalf("confirm heat failed: %v", err)
	}

	plan, err := engine.BuildMultiGPSyncPlan(created.RaceID, false)
	if err != nil {
		t.Fatalf("BuildMultiGPSyncPlan failed: %v", err)
	}
	if len(plan.Operations) < 2 {
		t.Fatalf("expected >=2 MultiGP slot operations, got %d", len(plan.Operations))
	}
}

func TestStackedDuplicateRaceNamesSelfHeal(t *testing.T) {
	engine := tracker.NewEngine()
	r1, err := engine.EventAction(tracker.EventActionPayload{
		Action: "create_race",
		Name:   "Friday Night Spec Race (2) (2) (2) (2)",
	})
	if err != nil {
		t.Fatalf("create_race failed: %v", err)
	}
	ev := engine.EventSnapshot()
	if len(ev.Races) != 1 || ev.Races[0].Config.EventName != "Friday Night Spec Race" {
		t.Fatalf("expected stacked (2) suffixes to self-heal to 'Friday Night Spec Race', got %q (id=%s)", ev.Races[0].Config.EventName, r1.RaceID)
	}

	// Importing another race with a (2) suffix when 'Friday Night Spec Race' already exists should become 'Friday Night Spec Race (2)', never '(2) (2)'.
	imp, err := engine.ImportMultiGPRace(multigp.RaceViewData{
		ID:   501,
		Name: "Friday Night Spec Race (2)",
	}, "schedule", "")
	if err != nil {
		t.Fatalf("ImportMultiGPRace failed: %v", err)
	}
	if imp.Config.EventName != "Friday Night Spec Race (2)" {
		t.Fatalf("expected disambiguated name 'Friday Night Spec Race (2)', got %q", imp.Config.EventName)
	}
}

func TestPauseRaceThenStartPracticeUnpausesSimulatedPilots(t *testing.T) {
	engine := tracker.NewEngine()
	sim := NewTrackSimulator(engine)

	cfg := domain.DefaultRaceSetupConfig()
	cfg.CountdownSec = 0
	cfg.TargetLaps = 3
	created := engine.ConfigureAndGenerateRace(cfg, true)
	if len(created.Heats) == 0 {
		t.Fatalf("expected generated heats")
	}
	heatID := created.Heats[0].ID

	// 1. Start the race and start Heat 1; step simulator so race mode is active.
	if _, err := engine.EventAction(tracker.EventActionPayload{
		Action:          "race_lifecycle",
		RaceID:          created.RaceID,
		LifecycleAction: "start_race",
	}); err != nil {
		t.Fatalf("start_race failed: %v", err)
	}
	if _, err := engine.RaceControlActionForRace(created.RaceID, "start", heatID); err != nil {
		t.Fatalf("start heat failed: %v", err)
	}
	sim.step(0.020)

	// 2. Pause the race via lifecycle action (`pause_race`) and step simulator -> pilots pause.
	if _, err := engine.EventAction(tracker.EventActionPayload{
		Action:          "race_lifecycle",
		RaceID:          created.RaceID,
		LifecycleAction: "pause_race",
	}); err != nil {
		t.Fatalf("pause_race failed: %v", err)
	}

	// 3. Also test pausing heat via `RaceControlAction("pause")` and preempting with Practice.
	ps := engine.PracticeSnapshot()
	if len(ps.Sessions) == 0 {
		t.Fatalf("expected default practice session")
	}
	sessID := ps.Sessions[0].SessionID
	if _, err := engine.PracticeAction(tracker.PracticeActionPayload{
		Action:    "start_session",
		SessionID: sessID,
	}); err != nil {
		t.Fatalf("start_session failed: %v", err)
	}

	sim.step(0.020)
	snap := sim.Snapshot()
	enabledFlying := 0
	for _, p := range snap.Pilots {
		if !p.Enabled {
			continue
		}
		if p.Status == domain.SimStatusPaused {
			t.Fatalf("expected practice pilot %s (slot %d) to unpause and fly after starting practice, got status=%s speed=%.1f", p.Callsign, p.SlotIndex, p.Status, p.SpeedMph)
		}
		if p.Status == domain.SimStatusFlying && p.SpeedMph > 0 {
			enabledFlying++
		}
	}
	if enabledFlying == 0 {
		t.Fatalf("expected at least one enabled practice pilot flying with SpeedMph > 0, got %+v", snap.Pilots)
	}

	// 4. Now resume the race, start heat, pause the heat directly (`pause`), then preempt with Practice.
	if _, err := engine.EventAction(tracker.EventActionPayload{
		Action:          "race_lifecycle",
		RaceID:          created.RaceID,
		LifecycleAction: "resume_race",
		PreemptOngoing:  true,
	}); err != nil {
		t.Fatalf("resume_race failed: %v", err)
	}
	if _, err := engine.RaceControlActionForRace(created.RaceID, "resume", heatID); err != nil {
		t.Fatalf("resume heat failed: %v", err)
	}
	sim.step(0.020)
	if _, err := engine.RaceControlActionForRace(created.RaceID, "pause", heatID); err != nil {
		t.Fatalf("pause heat failed: %v", err)
	}
	sim.step(0.020)
	// Confirm pilots are paused while heat is paused in Race Mode.
	snapPaused := sim.Snapshot()
	for _, p := range snapPaused.Pilots {
		if p.Status != domain.SimStatusPaused {
			t.Fatalf("expected pilot %s to be SimStatusPaused while race heat is paused, got %s", p.Callsign, p.Status)
		}
	}

	// Start practice session with PreemptOngoing -> simulated pilots must immediately get back in the air!
	if _, err := engine.PracticeAction(tracker.PracticeActionPayload{
		Action:         "start_session",
		SessionID:      sessID,
		PreemptOngoing: true,
	}); err != nil {
		t.Fatalf("start_session with PreemptOngoing failed: %v", err)
	}
	sim.step(0.020)
	snapResumed := sim.Snapshot()
	for _, p := range snapResumed.Pilots {
		if !p.Enabled {
			continue
		}
		if p.Status != domain.SimStatusFlying || p.SpeedMph <= 0 {
			t.Fatalf("expected practice pilot %s to be FLYING with SpeedMph > 0 after pausing heat and starting practice, got status=%s speed=%.1f", p.Callsign, p.Status, p.SpeedMph)
		}
	}
}




