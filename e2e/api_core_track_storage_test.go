//go:build e2e

package e2e_test

import (
	"encoding/json"
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

	// 1. Verify GET /api/version and curl shorthand syntax ("GET /api/version").
	verRes := h.CurlSpec("GET /api/version", nil)
	wantTarget := "host"
	if h.StaticDemo {
		wantTarget = "wasm"
	}
	if !verRes.OK || verRes.Status != 200 || verRes.Target != wantTarget {
		t.Fatalf("expected 200 OK from %s /api/version, got %+v", wantTarget, verRes)
	}
	var ver api.VersionInfo
	if err := json.Unmarshal([]byte(verRes.Body), &ver); err != nil || ver.ReleaseTag == "" {
		t.Fatalf("invalid /api/version payload: %v (%+v)", err, ver)
	}
	if ct := verRes.Headers["content-type"]; !strings.Contains(ct, "application/json") {
		t.Fatalf("expected WASM response header content-type application/json, got %q", ct)
	}

	// 2. Verify Portable Host GET /api/capabilities and /api/laprf-discover via auto-routed slaprfCurl.
	var caps portable.CapabilitiesResponse
	capRes := h.APIGet("/api/capabilities", &caps)
	if capRes.Target != "host" || !caps.Portable || !caps.LaprfEmulator || !caps.MultigpProxy {
		t.Fatalf("unexpected /api/capabilities response (%s): %+v", capRes.Target, caps)
	}

	// 3. Verify WASM GET /api/state and GET /api/status baseline parity.
	full := h.APIState()
	status := h.APIStatus()
	if !full.SimulatorRun || !status.SimulatorRun {
		t.Fatalf("expected SimulatorRun=true on fresh boot")
	}
	if len(full.Pilots) != 10 || len(full.Gates) != 4 || len(status.Gates) != 4 {
		t.Fatalf("expected 10 default pilots and 4 gates, got pilots=%d gates=%d/%d", len(full.Pilots), len(full.Gates), len(status.Gates))
	}

	// 4. Verify HTTP 405 Method Not Allowed & HTTP 400 Bad Request across WASM and Host routes.
	h.APIExpectStatus("POST", "/api/version", map[string]any{}, 405)
	h.APIExpectStatus("GET", "/api/pilots/add", nil, 405)
	h.APIExpectStatus("GET", "/api/timing/toggle-arm", nil, 405)
	h.APIExpectStatus("DELETE", "/api/rules", nil, 405)
	h.APIExpectStatus("POST", "/api/capabilities", map[string]any{}, 405)
	h.APIExpectStatus("GET", "/api/mgp/race/view", nil, 405)

	// Malformed JSON bodies must return 400 Bad Request cleanly without crashing WASM.
	h.APIExpectStatus("POST", "/api/rules", "{broken-json", 400)
	h.APIExpectStatus("POST", "/api/pilots/update", "{broken-json", 400)
	h.APIExpectStatus("POST", "/api/track/update", "{broken-json", 400)
	h.APIExpectStatus("POST", "/api/race/control", "{broken-json", 400)

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

	// 1. Add 2 custom pilots via curl shorthand and structured POST.
	var st api.FullStateResponse
	res := h.CurlSpec("POST /api/pilots/add", map[string]any{
		"callsign":     "ViperFPV",
		"phoneticName": "Viper F P V",
	})
	if !res.OK {
		t.Fatalf("POST /api/pilots/add failed: %s", res.Body)
	}
	_ = json.Unmarshal([]byte(res.Body), &st)
	if len(st.Pilots) != 11 || st.Pilots[10].Callsign != "ViperFPV" || st.Pilots[10].PhoneticName != "Viper F P V" {
		t.Fatalf("unexpected added pilot 11: %+v", st.Pilots)
	}
	viperSlot := st.Pilots[10].SlotIndex

	// Duplicate callsign must return 400 Bad Request.
	h.APIExpectStatus("POST", "/api/pilots/add", map[string]any{"callsign": "ViperFPV"}, 400)

	// 2. Update pilot slot: verify Raceband R7 -> 5880 MHz auto-fill AND hysteresis gap clamping
	// when exitThreshold (-59 dBm) is too close to enterThreshold (-60 dBm)!
	updSlot := st.Pilots[0]
	updSlot.Band = domain.BandRaceband
	updSlot.Channel = 7
	updSlot.FrequencyMHz = 0
	updSlot.EnterThreshold = -60
	updSlot.ExitThreshold = -59 // closer than MinHysteresisGapDb -> clamped down!
	h.APIPost("/api/pilots/update", updSlot, &st)

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
	h.APIPost("/api/pilots/update", updSlot, &st)
	if st.Pilots[0].FrequencyMHz != 0 {
		t.Fatalf("expected Channel=0 to zero FrequencyMHz, got %d", st.Pilots[0].FrequencyMHz)
	}
	h.MilestoneScreenshot("api-pilots-crud-and-hysteresis")

	// 3. Remove ViperFPV and verify invalid slot removal returns 400.
	h.APIExpectStatus("POST", "/api/pilots/remove", map[string]any{"slotIndex": 999}, 400)
	h.APIPost("/api/pilots/remove", map[string]any{"slotIndex": viperSlot}, &st)
	if len(st.Pilots) != 10 {
		t.Fatalf("expected 10 pilots after removing ViperFPV, got %d", len(st.Pilots))
	}

	// 4. Reset pilots to factory defaults -> 10 default directory pilots restored (FAERRY at Slot 1, -58/-68 dBm).
	h.APIPost("/api/pilots/reset", map[string]any{}, &st)
	if len(st.Pilots) != 10 || st.Pilots[0].Callsign != "FAERRY" || st.Pilots[0].EnterThreshold != -58 || st.Pilots[0].ExitThreshold != -68 {
		t.Fatalf("expected Slot 1 reset to FAERRY (-58/-68 dBm), got %+v", st.Pilots[0])
	}
}

func TestAPI_TrackGatesThresholdsPerGateRulesAndLegacyAliases(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/track")

	// 1. Add a new timer board ("T5") in simulator and verify Timers + Gates reflect it.
	var st api.FullStateResponse
	h.APIPost("/api/sim/timer-action", map[string]any{
		"action": "add",
		"role":   "spoke",
		"label":  "T5",
	}, &st)
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

	// 2. Add an unassigned gate at trackOrder=2 via POST /api/track/add, then update name & role via legacy alias /api/gates/update.
	orderIdx := 2
	h.APIPost("/api/track/add", map[string]any{
		"name":            "Corkscrew Dive",
		"assignedTimerId": 0,
		"trackOrder":      orderIdx,
	}, &st)
	if len(st.Gates) != gatesBeforeAdd+1 {
		t.Fatalf("expected %d gates after /api/track/add, got %d", gatesBeforeAdd+1, len(st.Gates))
	}
	addedGateID := st.Gates[2].GateID
	if st.Gates[2].Name != "Corkscrew Dive" {
		t.Fatalf("expected gate at order 2 named Corkscrew Dive, got %q", st.Gates[2].Name)
	}

	h.APIPost("/api/gates/update", map[string]any{
		"gateId": addedGateID,
		"name":   "Split-S Tower",
		"color":  "#38bdf8",
		"role":   "START_FINISH",
	}, &st)
	for _, g := range st.Gates {
		if g.GateID == addedGateID {
			if g.Name != "Split-S Tower" || string(g.Role) != "START_FINISH" {
				t.Fatalf("expected updated gate Split-S Tower as START_FINISH, got %+v", g)
			}
		}
	}

	// 3. Per-gate pilot threshold calibration via POST /api/thresholds (and reset back with 0).
	h.APIPost("/api/thresholds", []domain.GateThresholdUpdate{
		{GateID: addedGateID, SlotIndex: 1, EnterDbm: -52},
		{GateID: addedGateID, SlotIndex: 2, EnterDbm: -54},
	}, &st)
	for _, g := range st.Gates {
		if g.GateID == addedGateID && g.EnterThresholds[0] != -52 {
			t.Fatalf("expected gate %d slot 1 threshold override -52, got %+v", addedGateID, g.EnterThresholds)
		}
	}

	// 4. Per-gate timing rule overrides via POST /api/track/rules and clearing with empty overrides.
	minLap := 7.5
	minCross := 0.28
	h.APIPost("/api/track/rules", map[string]any{
		"gateId": addedGateID,
		"overrides": domain.GateRuleOverrides{
			MinLapSec:      &minLap,
			MinCrossingSec: &minCross,
		},
	}, &st)
	for _, g := range st.Gates {
		if g.GateID == addedGateID {
			if g.RuleOverrides.MinCrossingSec == nil || *g.RuleOverrides.MinCrossingSec != 0.28 {
				t.Fatalf("expected MinCrossingSec=0.28 on gate %d, got %+v", addedGateID, g.RuleOverrides)
			}
		}
	}
	h.MilestoneScreenshot("api-track-5-gates-and-overrides")

	// Clear overrides, remove added gate, and reset track to default 4-gate layout.
	h.APIPost("/api/gates/rules", map[string]any{
		"gateId":    addedGateID,
		"overrides": map[string]any{},
	}, &st)
	h.APIPost("/api/track/remove", map[string]any{"gateId": addedGateID}, &st)
	if len(st.Gates) != gatesBeforeAdd {
		t.Fatalf("expected %d gates after /api/track/remove, got %d", gatesBeforeAdd, len(st.Gates))
	}
	h.APIPost("/api/track/reset", map[string]any{}, &st)
	if len(st.Gates) != 4 || string(st.Gates[0].Role) != "START_FINISH" {
		t.Fatalf("expected default 4 gates with Gate 1 START_FINISH after reset, got %+v", st.Gates)
	}
}

func TestAPI_TimingRulesClampingAndArmToggle(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/setup/timing-rules")

	// 1. Default rules check.
	def := h.APIRules()
	if def.MinLapSec != 5 || def.MaxLapSec != 120 || def.MinCrossingSec != 0.12 {
		t.Fatalf("unexpected default timing rules: %+v", def)
	}

	// 2. Post out-of-range values and verify server-side guardrail clamping in Normalized().
	var clamped domain.TimingRules
	h.APIPost("/api/rules", domain.TimingRules{
		MinLapSec:      0.05, // clamps to 1.0
		MaxLapSec:      2.0,  // clamps to MinLapSec + 5 = 6.0
		MinCrossingSec: 9.0,  // clamps to 1.5
	}, &clamped)
	if clamped.MinLapSec != 1.0 || clamped.MaxLapSec != 6.0 || clamped.MinCrossingSec != 1.5 {
		t.Fatalf("expected server-side clamped TimingRules, got %+v", clamped)
	}

	// 3. Toggle timing arm off and back on via POST /api/timing/toggle-arm.
	initialArmed := h.APIStatus().RaceArmed
	var toggled api.StatusResponse
	h.APIPost("/api/timing/toggle-arm", map[string]any{}, &toggled)
	if toggled.RaceArmed == initialArmed {
		t.Fatalf("expected RaceArmed to flip from %v, stayed %v", initialArmed, toggled.RaceArmed)
	}
	h.APIPost("/api/timing/toggle-arm", map[string]any{}, &toggled)
	if toggled.RaceArmed != initialArmed {
		t.Fatalf("expected RaceArmed to flip back to %v, got %v", initialArmed, toggled.RaceArmed)
	}
	h.MilestoneScreenshot("api-timing-rules-clamped")
}

func TestAPI_TimersProvisionColorDeleteAndSimTimerActions(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/setup/timers")

	// 1. Add a simulated spoke timer ("T5"), flash custom firmware metadata, recolor it, toggle power, erase, and delete.
	var st api.FullStateResponse
	h.APIPost("/api/sim/timer-action", map[string]any{
		"action": "add",
		"role":   "spoke",
		"label":  "T5",
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

	h.APIPost("/api/sim/timer-action", map[string]any{
		"action":          "flash",
		"timerId":         t5ID,
		"role":            "spoke",
		"label":           "T5",
		"fingerprint":     "A1B2C3D4E5F60718",
		"firmwareVersion": "v2.4.0-test",
	}, &st)

	h.APIPost("/api/timers/color", map[string]any{
		"timerId": t5ID,
		"color":   "#22c55e",
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

	h.APIPost("/api/sim/timer-action", map[string]any{"action": "toggle-power", "timerId": t5ID}, &st)
	h.APIPost("/api/sim/timer-action", map[string]any{"action": "erase", "timerId": t5ID}, &st)
	h.APIPost("/api/timers/delete", map[string]any{"timerId": t5ID}, &st)
	for _, tm := range st.Timers {
		if tm.TimerID == t5ID {
			t.Fatalf("expected T5 deleted via /api/timers/delete")
		}
	}

	// Unknown action & invalid timer delete return 400.
	h.APIExpectStatus("POST", "/api/sim/timer-action", map[string]any{"action": "nonexistent"}, 400)
	h.APIExpectStatus("POST", "/api/timers/delete", map[string]any{"timerId": 250}, 400)
}

func TestAPI_SimRealEngineIsolationAndStorageExportImportReset(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/pilots")

	// 1. Add a Sim-only pilot ("SimGhost") while SimulatorRun == true.
	var simSt api.FullStateResponse
	h.APIPost("/api/pilots/add", map[string]any{"callsign": "SimGhost"}, &simSt)
	if !simSt.SimulatorRun || len(simSt.Pilots) != 11 {
		t.Fatalf("expected Sim engine to have 11 pilots, got sim=%v len=%d", simSt.SimulatorRun, len(simSt.Pilots))
	}

	// 2. Toggle to Real-world hardware engine via POST /api/sim/toggle!
	// Verify SimGhost does NOT leak into the isolated Real-world engine.
	var realSt api.FullStateResponse
	h.APIPost("/api/sim/toggle", map[string]any{}, &realSt)
	if realSt.SimulatorRun {
		t.Fatalf("expected SimulatorRun=false after /api/sim/toggle")
	}
	for _, p := range realSt.Pilots {
		if p.Callsign == "SimGhost" {
			t.Fatalf("SimGhost leaked from simEngine into realEngine!")
		}
	}

	// 3. Customize Real-world engine: add pilot "RealAce" and provision physical Hub + Spoke timers.
	h.APIPost("/api/pilots/add", map[string]any{
		"callsign":     "RealAce",
		"phoneticName": "Real Ace",
	}, &realSt)
	h.APIPost("/api/timers/provision", map[string]any{
		"role":        "hub",
		"timerLabel":  "H1",
		"fingerprint": "CAFEBABE11223344",
	}, &realSt)
	h.MilestoneScreenshot("api-real-engine-customized")

	// 4. Export Real-world storage snapshot via GET /api/storage/export.
	var backup api.RealBackendState
	h.APIGet("/api/storage/export", &backup)

	// 5. Factory-wipe both engines via POST /api/storage/reset and verify RealAce is gone.
	h.APIPost("/api/storage/reset", map[string]any{}, &realSt)
	for _, p := range realSt.Pilots {
		if p.Callsign == "RealAce" {
			t.Fatalf("expected RealAce cleared after /api/storage/reset")
		}
	}

	// 6. Restore Real-world engine from backup via POST /api/storage/import and verify RealAce returns!
	h.APIPost("/api/storage/import", backup, &realSt)
	foundRealAce := false
	for _, p := range realSt.Pilots {
		if p.Callsign == "RealAce" && p.PhoneticName == "Real Ace" {
			foundRealAce = true
		}
	}
	if !foundRealAce {
		t.Fatalf("expected RealAce restored via /api/storage/import, got %+v", realSt.Pilots)
	}
	h.MilestoneScreenshot("api-real-engine-restored")
}

func TestAPI_HardwareModeSwitchAndSimLapRFDiscoveryAndActions(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/setup/timers")

	// 1. Switch timing hardware mode from SlapRF to ImmersionRC LapRF 8-way via POST /api/hardware/mode.
	var st api.FullStateResponse
	h.APIPost("/api/hardware/mode", map[string]any{"mode": "laprf"}, &st)
	if string(st.TimingHardwareMode) != "laprf" {
		t.Fatalf("expected TimingHardwareMode=laprf, got %s", st.TimingHardwareMode)
	}

	// 2. Discover simulated LapRF pucks on virtual LAN via GET /api/sim/laprf-discover (L1, L2).
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
	h.APIGet("/api/sim/laprf-discover", &disc)
	if len(disc.Devices) < 2 || disc.Devices[0].Label != "L1" || disc.Devices[1].Label != "L2" {
		t.Fatalf("expected simulated LapRF units L1 and L2, got %+v", disc.Devices)
	}
	baseUnits := len(disc.Devices)

	// 3. Add a new simulated LapRF puck ("L3"), update voltage, and delete it.
	h.APIPost("/api/sim/laprf-action", map[string]any{
		"action": "add",
		"label":  "L3",
	}, &st)
	if st.SimState == nil || len(st.SimState.LapRFUnits) != baseUnits+1 {
		t.Fatalf("expected %d simulated LapRF units after add, got %+v", baseUnits+1, st.SimState)
	}
	addedPuckID := st.SimState.LapRFUnits[len(st.SimState.LapRFUnits)-1].TimerID

	h.APIPost("/api/sim/laprf-action", map[string]any{
		"action":    "update",
		"timerId":   addedPuckID,
		"label":     "L3",
		"voltageMv": 14800,
	}, &st)
	h.MilestoneScreenshot("api-laprf-mode-and-l3-puck")

	h.APIPost("/api/sim/laprf-action", map[string]any{
		"action":  "delete",
		"timerId": addedPuckID,
	}, &st)
	if len(st.SimState.LapRFUnits) != baseUnits {
		t.Fatalf("expected %d LapRF units after deleting added puck, got %d", baseUnits, len(st.SimState.LapRFUnits))
	}
}
