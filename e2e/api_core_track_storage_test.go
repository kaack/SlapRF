//go:build e2e

package e2e_test

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"slaprf/internal/api"
	"slaprf/internal/domain"
	"slaprf/internal/portable"
)

func TestAPI_VersionCapabilitiesStatusAndMethodGuards(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/about")
	h.AllowConsoleErrorSubstring("Failed to load resource")

	// 1. Verify GET /v1/version and curl shorthand syntax ("GET /v1/version").
	verRes := h.CurlSpec("GET /v1/version", nil)
	wantTarget := "host"
	if h.StaticDemo {
		wantTarget = "wasm"
	}
	if !verRes.OK || verRes.Status != 200 || verRes.Target != wantTarget {
		t.Fatalf("expected 200 OK from %s /v1/version, got %+v", wantTarget, verRes)
	}
	var ver api.VersionInfo
	if err := json.Unmarshal([]byte(verRes.Body), &ver); err != nil || ver.ReleaseTag == "" {
		t.Fatalf("invalid /v1/version payload: %v (%+v)", err, ver)
	}
	if ct := verRes.Headers["content-type"]; !strings.Contains(ct, "application/json") {
		t.Fatalf("expected response header content-type application/json, got %q", ct)
	}

	// 2. Verify Portable Host GET /v1/capabilities via auto-routed slaprfCurl.
	var caps portable.CapabilitiesResponse
	capRes := h.APIGet("/v1/capabilities", &caps)
	if capRes.Target != "host" || !caps.Portable || !caps.LaprfEmulator || !caps.MultigpProxy {
		t.Fatalf("unexpected /v1/capabilities response (%s): %+v", capRes.Target, caps)
	}

	// 3. Verify GET /v1/state and GET /v1/status baseline parity.
	full := h.APIState()
	status := h.APIStatus()
	if !full.SimulatorRun || !status.SimulatorRun {
		t.Fatalf("expected SimulatorRun=true on fresh boot")
	}
	if len(full.Pilots) != 10 || len(full.Gates) != 4 || len(status.Gates) != 4 {
		t.Fatalf("expected 10 default pilots and 4 gates, got pilots=%d gates=%d/%d", len(full.Pilots), len(full.Gates), len(status.Gates))
	}

	// 4. Verify HTTP 405 Method Not Allowed (including singleton DELETE protection) & HTTP 404 on legacy /api/* and removed global /v1/track.
	h.APIExpectStatus("POST", "/v1/version", map[string]any{}, 405)
	h.APIExpectStatus("DELETE", "/v1/practice/sessions/current/track/rules", nil, 405)
	h.APIExpectStatus("DELETE", "/v1/timing/arm", nil, 405)
	h.APIExpectStatus("DELETE", "/v1/storage", nil, 405)
	h.APIExpectStatus("DELETE", "/v1/practice/sessions/current/track", nil, 405)
	h.APIExpectStatus("POST", "/v1/capabilities", map[string]any{}, 405)
	h.APIExpectStatus("GET", "/v1/race/multigp/proxy/race/view", nil, 405)
	h.APIExpectStatus("GET", "/api/state", nil, 404)
	h.APIExpectStatus("GET", "/v1/track", nil, 404)

	// Malformed JSON bodies must return 400 Bad Request cleanly.
	h.APIExpectStatus("PUT", "/v1/practice/sessions/current/track/rules", "{broken-json", 400)
	h.APIExpectStatus("PUT", "/v1/pilots/1", "{broken-json", 400)
	h.APIExpectStatus("PUT", "/v1/practice/sessions/current/track/gates/1", "{broken-json", 400)
	h.APIExpectStatus("POST", "/v1/race/sessions/current/heats/current:control", "{broken-json", 400)

	// Verify curl history ring buffer recorded our calls in window.slaprfCurlHistory.
	histLen, err := h.Page.Evaluate(`() => (window.slaprfCurlHistory || []).length`, nil)
	if err != nil {
		t.Fatalf("read slaprfCurlHistory: %v", err)
	}
	if n, _ := histLen.(int); n < 8 {
		if nf, ok := histLen.(float64); !ok || nf < 8 {
			t.Fatalf("expected slaprfCurlHistory >= 8 entries, got %v", histLen)
		}
	}
	h.MilestoneScreenshot("api-version-caps-and-guards")
}

func TestAPI_PilotsCRUDHysteresisClampingAndReset(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/pilots")

	// 1. Add custom pilot via POST /v1/pilots (returns 201 Created + Location header).
	var st api.FullStateResponse
	res := h.CurlSpec("POST /v1/pilots", map[string]any{
		"callsign":     "ViperFPV",
		"phoneticName": "Viper F P V",
	})
	if res.Status != 201 {
		t.Fatalf("POST /v1/pilots expected 201 Created, got %d: %s", res.Status, res.Body)
	}
	_ = json.Unmarshal([]byte(res.Body), &st)
	if len(st.Pilots) != 11 || st.Pilots[10].Callsign != "ViperFPV" || st.Pilots[10].PhoneticName != "Viper F P V" {
		t.Fatalf("unexpected added pilot 11: %+v", st.Pilots)
	}
	viperSlot := st.Pilots[10].SlotIndex
	if wantLoc := fmt.Sprintf("/v1/pilots/%d", viperSlot); res.Headers["location"] != wantLoc {
		t.Fatalf("expected Location header %q, got %q", wantLoc, res.Headers["location"])
	}

	// Duplicate callsign must return 409 Conflict.
	h.APIExpectStatus("POST", "/v1/pilots", map[string]any{"callsign": "ViperFPV"}, 409)

	// 2. Update pilot slot via PUT /v1/pilots/{slotIndex}: verify Raceband R7 -> 5880 MHz auto-fill AND hysteresis gap clamping.
	updSlot := st.Pilots[0]
	updSlot.Band = domain.BandRaceband
	updSlot.Channel = 7
	updSlot.FrequencyMHz = 0
	updSlot.EnterThreshold = -60
	updSlot.ExitThreshold = -59 // closer than MinHysteresisGapDb -> clamped down!
	h.APIPut(fmt.Sprintf("/v1/pilots/%d", updSlot.SlotIndex), updSlot, &st)

	p0 := st.Pilots[0]
	if p0.FrequencyMHz != 5880 {
		t.Fatalf("expected R7 auto frequency 5880 MHz, got %d", p0.FrequencyMHz)
	}
	if p0.ExitThreshold > p0.EnterThreshold-domain.MinHysteresisGapDb+0.01 {
		t.Fatalf("expected ExitThreshold clamped <= %v, got %v", p0.EnterThreshold-domain.MinHysteresisGapDb, p0.ExitThreshold)
	}

	// Setting Channel=0 zeroes FrequencyMHz.
	updSlot = p0
	updSlot.Channel = 0
	h.APIPut(fmt.Sprintf("/v1/pilots/%d", updSlot.SlotIndex), updSlot, &st)
	if st.Pilots[0].FrequencyMHz != 0 {
		t.Fatalf("expected Channel=0 to zero FrequencyMHz, got %d", st.Pilots[0].FrequencyMHz)
	}
	h.MilestoneScreenshot("api-pilots-crud-and-hysteresis")

	// 3. Remove ViperFPV via DELETE /v1/pilots/{slotIndex} and verify missing slot returns 404 Not Found.
	h.APIExpectStatus("DELETE", "/v1/pilots/999", nil, 404)
	h.APIDelete(fmt.Sprintf("/v1/pilots/%d", viperSlot), &st)
	if len(st.Pilots) != 10 {
		t.Fatalf("expected 10 pilots after removing ViperFPV, got %d", len(st.Pilots))
	}

	// 4. Reset pilots to factory defaults via POST /v1/pilots:reset -> 10 default directory pilots restored (FAERRY at Slot 1).
	h.APIPost("/v1/pilots:reset", map[string]any{}, &st)
	if len(st.Pilots) != 10 || st.Pilots[0].Callsign != "FAERRY" || st.Pilots[0].EnterThreshold != -58 || st.Pilots[0].ExitThreshold != -68 {
		t.Fatalf("expected Slot 1 reset to FAERRY (-58/-68 dBm), got %+v", st.Pilots[0])
	}
}

func TestAPI_TrackGatesThresholdsAndPerGateRules(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/practice/open-practice/track")

	// 1. Add a new timer board ("T5") in simulator via POST /v1/sim/slaprf/timers (201 Created) and verify Timers reflect it.
	var st api.FullStateResponse
	createTimerRes := h.APIPost("/v1/sim/slaprf/timers", map[string]any{
		"role":  "spoke",
		"label": "T5",
	}, &st)
	if createTimerRes.Status != 201 {
		t.Fatalf("expected 201 Created from POST /v1/sim/slaprf/timers, got %d", createTimerRes.Status)
	}
	var newTimerID uint8
	for _, tm := range st.Timers {
		if tm.TimerLabel == "T5" {
			newTimerID = tm.TimerID
		}
	}
	if newTimerID == 0 {
		t.Fatalf("expected newly added T5 simulated timer in Timers: %+v", st.Timers)
	}
	gatesBeforeAdd := len(st.Gates)

	// 2. Add an unassigned gate at trackOrder=2 via POST /v1/practice/sessions/current/track/gates (201 Created), then update via PUT .../gates/{gateId}.
	orderIdx := 2
	createGateRes := h.APIPost("/v1/practice/sessions/current/track/gates", map[string]any{
		"name":            "Corkscrew Dive",
		"assignedTimerId": 0,
		"trackOrder":      orderIdx,
	}, &st)
	if createGateRes.Status != 201 {
		t.Fatalf("expected 201 Created from POST /v1/practice/sessions/current/track/gates, got %d", createGateRes.Status)
	}
	if len(st.Gates) != gatesBeforeAdd+1 {
		t.Fatalf("expected %d gates after POST /v1/practice/sessions/current/track/gates, got %d", gatesBeforeAdd+1, len(st.Gates))
	}
	addedGateID := st.Gates[2].GateID
	if st.Gates[2].Name != "Corkscrew Dive" {
		t.Fatalf("expected gate at order 2 named Corkscrew Dive, got %q", st.Gates[2].Name)
	}

	h.APIPut(fmt.Sprintf("/v1/practice/sessions/current/track/gates/%d", addedGateID), map[string]any{
		"name":  "Split-S Tower",
		"color": "#38bdf8",
		"role":  "START_FINISH",
	}, &st)
	for _, g := range st.Gates {
		if g.GateID == addedGateID {
			if g.Name != "Split-S Tower" || string(g.Role) != "START_FINISH" {
				t.Fatalf("expected updated gate Split-S Tower as START_FINISH, got %+v", g)
			}
		}
	}

	// 3. Per-gate pilot threshold calibration via PUT /v1/practice/sessions/current/track/thresholds.
	h.APIPut("/v1/practice/sessions/current/track/thresholds", []domain.GateThresholdUpdate{
		{GateID: addedGateID, SlotIndex: 1, EnterDbm: -52},
		{GateID: addedGateID, SlotIndex: 2, EnterDbm: -54},
	}, &st)
	for _, g := range st.Gates {
		if g.GateID == addedGateID && g.EnterThresholds[0] != -52 {
			t.Fatalf("expected gate %d slot 1 threshold override -52, got %+v", addedGateID, g.EnterThresholds)
		}
	}

	// 4. Per-gate timing rule overrides via PUT /v1/practice/sessions/current/track/gates/{gateId}/rules and singleton reset via POST .../rules:reset.
	minLap := 7.5
	minCross := 0.28
	h.APIPut(fmt.Sprintf("/v1/practice/sessions/current/track/gates/%d/rules", addedGateID), domain.GateRuleOverrides{
		MinLapSec:      &minLap,
		MinCrossingSec: &minCross,
	}, &st)
	for _, g := range st.Gates {
		if g.GateID == addedGateID {
			if g.RuleOverrides.MinCrossingSec == nil || *g.RuleOverrides.MinCrossingSec != 0.28 {
				t.Fatalf("expected MinCrossingSec=0.28 on gate %d, got %+v", addedGateID, g.RuleOverrides)
			}
		}
	}
	h.MilestoneScreenshot("api-track-5-gates-and-overrides")

	// DELETE on singleton /rules must return 405; POST .../rules:reset clears overrides cleanly.
	h.APIExpectStatus("DELETE", fmt.Sprintf("/v1/practice/sessions/current/track/gates/%d/rules", addedGateID), nil, 405)
	h.APIPost(fmt.Sprintf("/v1/practice/sessions/current/track/gates/%d/rules:reset", addedGateID), map[string]any{}, &st)
	h.APIDelete(fmt.Sprintf("/v1/practice/sessions/current/track/gates/%d", addedGateID), &st)
	if len(st.Gates) != gatesBeforeAdd {
		t.Fatalf("expected %d gates after DELETE /v1/practice/sessions/current/track/gates/%d, got %d", gatesBeforeAdd, addedGateID, len(st.Gates))
	}
	h.APIPost("/v1/practice/sessions/current/track:reset", map[string]any{}, &st)
	if len(st.Gates) < 4 || string(st.Gates[0].Role) != "START_FINISH" {
		t.Fatalf("expected >=4 gates with Gate 1 START_FINISH after /v1/practice/sessions/current/track:reset, got %+v", st.Gates)
	}
}

func TestAPI_TimingRulesClampingAndArmPut(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/practice/open-practice/track")

	// 1. Default rules check.
	def := h.APIRules()
	if def.MinLapSec != 5 || def.MaxLapSec != 120 || def.MinCrossingSec != 0.12 {
		t.Fatalf("unexpected default timing rules: %+v", def)
	}

	// 2. PUT out-of-range values to /v1/practice/sessions/current/track/rules and verify server-side guardrail clamping.
	var st api.FullStateResponse
	h.APIPut("/v1/practice/sessions/current/track/rules", domain.TimingRules{
		MinLapSec:      0.05, // clamps to 1.0
		MaxLapSec:      2.0,  // clamps to MinLapSec + 5 = 6.0
		MinCrossingSec: 9.0,  // clamps to 1.5
	}, &st)
	clamped := h.APIRules()
	if clamped.MinLapSec != 1.0 || clamped.MaxLapSec != 6.0 || clamped.MinCrossingSec != 1.5 {
		t.Fatalf("expected server-side clamped TimingRules, got %+v", clamped)
	}

	// 3. Idempotently set timing arm off and back on via PUT /v1/timing/arm.
	initialArmed := h.APIStatus().RaceArmed
	var updated api.StatusResponse
	h.APIPut("/v1/timing/arm", map[string]any{"armed": !initialArmed}, &updated)
	if updated.RaceArmed == initialArmed {
		t.Fatalf("expected RaceArmed to flip from %v, stayed %v", initialArmed, updated.RaceArmed)
	}
	h.APIPut("/v1/timing/arm", map[string]any{"armed": initialArmed}, &updated)
	if updated.RaceArmed != initialArmed {
		t.Fatalf("expected RaceArmed to return to %v, got %v", initialArmed, updated.RaceArmed)
	}
	h.MilestoneScreenshot("api-timing-rules-clamped")
}

func TestAPI_TimersProvisionColorDeleteAndSimTimerActions(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/setup/timers")

	// 1. Add a simulated spoke timer ("T5") via POST /v1/sim/slaprf/timers, flash, recolor via PATCH /v1/timers/{id}, toggle power, erase, and delete.
	var st api.FullStateResponse
	h.APIPost("/v1/sim/slaprf/timers", map[string]any{
		"role":  "spoke",
		"label": "T5",
	}, &st)

	var t5ID uint8
	for _, tm := range st.Timers {
		if tm.TimerLabel == "T5" {
			t5ID = tm.TimerID
		}
	}
	if t5ID == 0 {
		t.Fatalf("expected T5 timer added")
	}

	h.APIPost(fmt.Sprintf("/v1/sim/slaprf/timers/%d:action", t5ID), map[string]any{
		"action":          "flash",
		"role":            "spoke",
		"label":           "T5",
		"fingerprint":     "A1B2C3D4E5F60718",
		"firmwareVersion": "v2.4.0-test",
	}, &st)

	h.APIPatch(fmt.Sprintf("/v1/timers/%d", t5ID), map[string]any{
		"color": "#22c55e",
	}, &st)

	foundColored := false
	for _, tm := range st.Timers {
		if tm.TimerID == t5ID && strings.EqualFold(tm.Color, "#22c55e") {
			foundColored = true
		}
	}
	if !foundColored {
		t.Fatalf("expected T5 color updated to #22c55e, got %+v", st.Timers)
	}
	h.MilestoneScreenshot("api-timers-flashed-and-colored")

	h.APIPost(fmt.Sprintf("/v1/sim/slaprf/timers/%d:action", t5ID), map[string]any{"action": "toggle-power"}, &st)
	h.APIPost(fmt.Sprintf("/v1/sim/slaprf/timers/%d:action", t5ID), map[string]any{"action": "erase"}, &st)
	h.APIDelete(fmt.Sprintf("/v1/timers/%d", t5ID), &st)
	for _, tm := range st.Timers {
		if tm.TimerID == t5ID {
			t.Fatalf("expected T5 deleted via DELETE /v1/timers/%d", t5ID)
		}
	}

	// Unknown action returns 400; deleting nonexistent timer returns 404 Not Found.
	h.APIExpectStatus("POST", "/v1/sim/slaprf/timers/1:action", map[string]any{"action": "nonexistent"}, 400)
	h.APIExpectStatus("DELETE", "/v1/timers/250", nil, 404)
}

func TestAPI_SimRealEngineIsolationAndStorageExportImportReset(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/pilots")

	// 1. Add a Sim-only pilot ("SimGhost") while SimulatorRun == true.
	var simSt api.FullStateResponse
	h.APIPost("/v1/pilots", map[string]any{"callsign": "SimGhost"}, &simSt)
	if !simSt.SimulatorRun || len(simSt.Pilots) != 11 {
		t.Fatalf("expected Sim engine to have 11 pilots, got sim=%v len=%d", simSt.SimulatorRun, len(simSt.Pilots))
	}

	// 2. Switch to Real-world hardware engine via PATCH /v1/sim {"running": false}!
	// Verify SimGhost does NOT leak into the isolated Real-world engine.
	var realSt api.FullStateResponse
	h.APIPatch("/v1/sim", map[string]any{"running": false}, &realSt)
	if realSt.SimulatorRun {
		t.Fatalf("expected SimulatorRun=false after PATCH /v1/sim")
	}
	for _, p := range realSt.Pilots {
		if p.Callsign == "SimGhost" {
			t.Fatalf("SimGhost leaked from simEngine into realEngine!")
		}
	}

	// 3. Customize Real-world engine: add pilot "RealAce" and provision physical Hub timer.
	h.APIPost("/v1/pilots", map[string]any{
		"callsign":     "RealAce",
		"phoneticName": "Real Ace",
	}, &realSt)
	h.APIPost("/v1/timers", map[string]any{
		"role":        "hub",
		"timerLabel":  "H1",
		"fingerprint": "CAFEBABE11223344",
	}, &realSt)
	h.MilestoneScreenshot("api-real-engine-customized")

	// 4. Export Real-world storage snapshot via GET /v1/storage.
	var backup api.RealBackendState
	h.APIGet("/v1/storage", &backup)

	// 5. Factory-wipe engines via POST /v1/storage:reset and verify RealAce is gone.
	h.APIPost("/v1/storage:reset", map[string]any{}, &realSt)
	for _, p := range realSt.Pilots {
		if p.Callsign == "RealAce" {
			t.Fatalf("expected RealAce cleared after POST /v1/storage:reset")
		}
	}

	// 6. Restore Real-world engine from backup via PUT /v1/storage and verify RealAce returns!
	h.APIPut("/v1/storage", backup, &realSt)
	foundRealAce := false
	for _, p := range realSt.Pilots {
		if p.Callsign == "RealAce" && p.PhoneticName == "Real Ace" {
			foundRealAce = true
		}
	}
	if !foundRealAce {
		t.Fatalf("expected RealAce restored via PUT /v1/storage, got %+v", realSt.Pilots)
	}
	h.MilestoneScreenshot("api-real-engine-restored")
}

func TestAPI_HardwareModeSwitchAndSimLapRFDiscoveryAndActions(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/setup/timers")

	// 1. Switch timing hardware mode from SlapRF to ImmersionRC LapRF 8-way via PUT /v1/hardware/mode.
	var st api.FullStateResponse
	h.APIPut("/v1/hardware/mode", map[string]any{"mode": "laprf"}, &st)
	if string(st.TimingHardwareMode) != "laprf" {
		t.Fatalf("expected TimingHardwareMode=laprf, got %s", st.TimingHardwareMode)
	}

	// 2. Discover simulated LapRF pucks on virtual LAN via GET /v1/sim/laprf/devices (L1, L2).
	var disc struct {
		Subnet  string `json:"subnet"`
		Devices []struct {
			TimerID   uint8  `json:"timerId"`
			Label     string `json:"label"`
			Host      string `json:"host"`
			Port      int    `json:"port"`
			Connected bool   `json:"connected"`
		} `json:"devices"`
	}
	h.APIGet("/v1/sim/laprf/devices", &disc)
	if len(disc.Devices) < 2 || disc.Devices[0].Label != "L1" || disc.Devices[1].Label != "L2" {
		t.Fatalf("expected simulated LapRF units L1 and L2, got %+v", disc.Devices)
	}
	baseUnits := len(disc.Devices)

	// 3. Add a new simulated LapRF puck ("L3") via POST /v1/sim/laprf/timers (201 Created), update voltage via PATCH, and DELETE it.
	createRes := h.APIPost("/v1/sim/laprf/timers", map[string]any{
		"action": "add",
		"label":  "L3",
	}, &st)
	if createRes.Status != 201 {
		t.Fatalf("expected 201 Created from POST /v1/sim/laprf/timers, got %d", createRes.Status)
	}
	if st.SimState == nil || len(st.SimState.LapRFUnits) != baseUnits+1 {
		t.Fatalf("expected %d simulated LapRF units after add, got %+v", baseUnits+1, st.SimState)
	}
	addedPuckID := st.SimState.LapRFUnits[len(st.SimState.LapRFUnits)-1].TimerID

	h.APIPatch(fmt.Sprintf("/v1/sim/laprf/timers/%d", addedPuckID), map[string]any{
		"label":     "L3",
		"voltageMv": 14800,
	}, &st)
	h.MilestoneScreenshot("api-laprf-mode-and-l3-puck")

	h.APIDelete(fmt.Sprintf("/v1/sim/laprf/timers/%d", addedPuckID), &st)
	if len(st.SimState.LapRFUnits) != baseUnits {
		t.Fatalf("expected %d LapRF units after deleting added puck, got %d", baseUnits, len(st.SimState.LapRFUnits))
	}
}
