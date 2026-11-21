//go:build e2e

package e2e_test

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/playwright-community/playwright-go"
)

func TestTournamentSetupBracketGraphAndStageJumpLink(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/races")

	// Create a new race inline in the Races directory.
	createRaceBtn := h.Page.Locator(`button[data-race-act="create-race-inline"]`).First()
	h.MustBeVisible(createRaceBtn, "+ Race inline button")
	if err := createRaceBtn.Click(); err != nil {
		t.Fatalf("click + Race inline: %v", err)
	}

	openFmtBtn := h.Page.Locator(`button[data-race-act="open-race-format"]`).First()
	h.MustBeVisible(openFmtBtn, "Configure race button in directory")
	if err := openFmtBtn.Click(); err != nil {
		t.Fatalf("click Configure race button: %v", err)
	}

	// Open Templates modal if not automatically opened on unconfigured race entry.
	tplOption := h.Page.Locator(`.slaprf-modal-backdrop button[data-modal-pick-tpl="double_elimination"]`).First()
	if waitErr := tplOption.WaitFor(playwright.LocatorWaitForOptions{
		State:   playwright.WaitForSelectorStateVisible,
		Timeout: playwright.Float(1500),
	}); waitErr != nil {
		expandCtrl := h.Page.Locator(`button[data-rc-ui="toggle-controls-expand"]`).First()
		h.MustBeVisible(expandCtrl, "Expand board controls button")
		_ = expandCtrl.Click()
		openTplBtn := h.Page.Locator(`button[data-rc-ui="open-templates"]`).First()
		h.MustBeVisible(openTplBtn, "Open templates button")
		if err := openTplBtn.Click(); err != nil {
			t.Fatalf("click open-templates to open template picker: %v", err)
		}
	}

	h.MustBeVisible(tplOption, "Double Elimination template card")
	if err := tplOption.Click(); err != nil {
		t.Fatalf("select Double Elimination template: %v", err)
	}

	confirmTplBtn := h.Page.Locator(`.slaprf-modal-backdrop button[data-tpl-confirm]`).First()
	h.MustBeVisible(confirmTplBtn, "Template modal Continue button")
	if err := confirmTplBtn.Click(); err != nil {
		t.Fatalf("confirm Double Elimination template: %v", err)
	}
	h.MustBeHidden(h.Page.Locator(`.slaprf-modal-backdrop`), "Template modal closed")

	// Verify unified Configure graph renders round nodes + SVG connector wires directly without any Stage 1 sub-tab!
	h.WaitUntil("Double Elimination round nodes and SVG wires rendered on unified graph", 10*time.Second, func() (bool, error) {
		nodeCnt, _ := h.Page.Locator(`[data-round-node]`).Count()
		wireCnt, _ := h.Page.Locator(`svg.bkt-wires path`).Count()
		return nodeCnt >= 4 && wireCnt >= 3, nil
	})
	h.MilestoneScreenshot("double-elim-stage-graph")

	// Switch through the Desktop workspace pill tabs (Marshal, Schedule, Standings, Signals)
	// and verify each tab shows its dedicated panel cleanly!
	marshalTabBtn := h.Page.Locator(`button[data-mobile-ctrl-nav="live"]`).First()
	h.MustBeVisible(marshalTabBtn, "Marshal workspace tab")
	if err := marshalTabBtn.Click(); err != nil {
		t.Fatalf("click Marshal tab: %v", err)
	}
	for _, panelID := range []string{"cockpit", "heatline"} {
		h.MustBeVisible(h.Page.Locator(fmt.Sprintf(`[data-canvas-panel=%q]`, panelID)).First(), "Marshal panel "+panelID)
	}
	h.MustBeHidden(h.Page.Locator(`[data-canvas-panel="schedule"]`).First(), "Schedule hidden on Marshal tab")

	if err := h.Page.Locator(`button[data-mobile-ctrl-nav="schedule"]`).First().Click(); err != nil {
		t.Fatalf("click Schedule tab: %v", err)
	}
	h.MustBeVisible(h.Page.Locator(`[data-canvas-panel="schedule"]`).First(), "Heats Schedule panel")

	if err := h.Page.Locator(`button[data-mobile-ctrl-nav="standings"]`).First().Click(); err != nil {
		t.Fatalf("click Standings tab: %v", err)
	}
	h.MustBeVisible(h.Page.Locator(`[data-canvas-panel="standings"]`).First(), "Overall Standings panel")

	if err := h.Page.Locator(`button[data-mobile-ctrl-nav="signals"]`).First().Click(); err != nil {
		t.Fatalf("click Signals tab: %v", err)
	}
	h.MustBeVisible(h.Page.Locator(`[data-canvas-panel="signals"]`).First(), "Signals panel")
	signalsHeaderText, err := h.Page.Locator(`[data-canvas-panel="signals"]`).First().InnerText()
	if err != nil {
		t.Fatalf("read signals panel text: %v", err)
	}
	if !strings.Contains(signalsHeaderText, "Signal at each timer") {
		t.Fatalf("expected signals panel to display 'Signal at each timer', got: %q", signalsHeaderText)
	}

	if err := marshalTabBtn.Click(); err != nil {
		t.Fatalf("return to Marshal tab: %v", err)
	}

	// Verify stage graph nodes are hidden on the Control canvas by default.
	graphHiddenOnControl, err := h.Page.Evaluate(`() => {
		const nodesLayer = document.querySelector(".rc-world .rc-nodes");
		if (!nodesLayer) return true;
		const style = window.getComputedStyle(nodesLayer);
		return nodesLayer.hasAttribute("hidden") || style.display === "none" || style.visibility === "hidden";
	}`)
	if err != nil {
		t.Fatalf("evaluate graph visibility on control: %v", err)
	}
	if ok, _ := graphHiddenOnControl.(bool); !ok {
		t.Fatalf("expected bracket stage graph nodes to be hidden by default on Control canvas")
	}
	h.MilestoneScreenshot("control-canvas-clean-4row-layout")

	// Click the Jump-to-Stage-Graph icon link on a heat in Control and verify it switches to Stage 1
	// graph view AND brings that exact heat card inside the viewport bounds.
	jumpBtn := h.Page.Locator(`[data-canvas-panel="cockpit"] button[data-race-act="focus-heat-graph"]`).First()
	h.MustBeVisible(jumpBtn, "Heat Jump-to-Stage-Graph icon button in cockpit")
	targetHeatID, err := jumpBtn.GetAttribute("data-heat-id")
	if err != nil || strings.TrimSpace(targetHeatID) == "" {
		t.Fatalf("expected non-empty data-heat-id on focus-heat-graph button, got %q (err=%v)", targetHeatID, err)
	}
	if err := jumpBtn.Click(); err != nil {
		t.Fatalf("click focus-heat-graph icon button: %v", err)
	}

	h.MustBeVisible(h.Page.Locator(`button[data-race-tab="edit"].is-active`).First(), "Configure tab active after graph jump")

	h.WaitUntil("target heat card panned inside [data-rc-viewport] bounds", 8*time.Second, func() (bool, error) {
		inView, evalErr := h.Page.Evaluate(`(heatId) => {
			const vp = document.querySelector("[data-rc-viewport]");
			const card = document.querySelector('[data-heat-card="' + CSS.escape(heatId) + '"]');
			if (!vp || !card) return false;
			const vr = vp.getBoundingClientRect();
			const cr = card.getBoundingClientRect();
			if (cr.width <= 0 || cr.height <= 0) return false;
			const cx = cr.left + cr.width / 2;
			const cy = cr.top + cr.height / 2;
			return cx >= vr.left + 40 && cx <= vr.right - 40 && cy >= vr.top + 40 && cy <= vr.bottom - 40;
		}`, targetHeatID)
		if evalErr != nil {
			return false, nil
		}
		ok, _ := inView.(bool)
		return ok, nil
	})
	h.MilestoneScreenshot("jumped-from-control-to-heat-on-stage-graph")
}

func TestFullRaceControlExecutionAndChampion(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/races")
	h.ConnectSimHubH1()

	// Create a new race inline and configure a crisp 4-pilot, 1-heat, 2-lap Single Elimination Finals.
	createRaceBtn := h.Page.Locator(`button[data-race-act="create-race-inline"]`).First()
	h.MustBeVisible(createRaceBtn, "+ Race inline button")
	if err := createRaceBtn.Click(); err != nil {
		t.Fatalf("click + Race inline: %v", err)
	}

	openFmtBtn := h.Page.Locator(`button[data-race-act="open-race-format"]`).First()
	h.MustBeVisible(openFmtBtn, "Configure race button")
	if err := openFmtBtn.Click(); err != nil {
		t.Fatalf("click Configure race: %v", err)
	}

	// Close initial template modal if opened so we can set exact 4-pilot check-in first, then apply template.
	modalBackdrop := h.Page.Locator(`.slaprf-modal-backdrop`).First()
	if waitErr := modalBackdrop.WaitFor(playwright.LocatorWaitForOptions{
		State:   playwright.WaitForSelectorStateVisible,
		Timeout: playwright.Float(1500),
	}); waitErr == nil {
		cancelBtn := modalBackdrop.Locator(`button[data-tpl-cancel], button[data-modal="cancel"], button[data-modal-cancel]`).First()
		if cnt, _ := cancelBtn.Count(); cnt > 0 {
			_ = cancelBtn.Click()
		} else {
			_ = h.Page.Keyboard().Press("Escape")
		}
		h.MustBeHidden(modalBackdrop, "initial template modal closed")
	}

	// Keep 4 pilots checked in so Single Elimination (4 pilots/heat) produces a single Finals heat.
	var stBefore struct {
		RaceState struct {
			RaceID string `json:"raceId"`
			Roster []struct {
				SlotIndex int  `json:"slotIndex"`
				CheckedIn bool `json:"checkedIn"`
			} `json:"roster"`
		} `json:"raceState"`
	}
	if err := h.WasmGetJSON("/v1/state", &stBefore); err != nil {
		t.Fatalf("get initial raceState: %v", err)
	}
	for idx, rp := range stBefore.RaceState.Roster {
		wantChecked := idx < 4
		if rp.CheckedIn != wantChecked {
			if err := h.WasmMethodJSON("PATCH", fmt.Sprintf("/v1/race/sessions/%s/pilots/%d", stBefore.RaceState.RaceID, rp.SlotIndex), map[string]any{
				"checkedIn":  wantChecked,
				"attendance": map[bool]string{true: "active", false: "absent"}[wantChecked],
			}, nil); err != nil {
				t.Fatalf("update_attendance slot %d: %v", rp.SlotIndex, err)
			}
		}
	}

	// Set short 1s countdown, 2 target laps, and single_final so 1 Finals heat crowns the Champion.
	if err := h.WasmMethodJSON("PUT", fmt.Sprintf("/v1/race/sessions/%s/config", stBefore.RaceState.RaceID), map[string]any{
		"config": map[string]any{
			"eventName":     "Championship Sprint",
			"pilotsPerHeat": 4,
			"targetLaps":    2,
			"timeLimitSec":  90,
			"countdownSec":  1,
			"finalsFormat":  "single_final",
		},
		"generate":        false,
		"applyToExisting": true,
	}, nil); err != nil {
		t.Fatalf("PUT /v1/race/sessions/{id}/config: %v", err)
	}
	bracketEditPath := fmt.Sprintf("/v1/race/sessions/%s/bracket:edit", stBefore.RaceState.RaceID)
	if err := h.WasmPostJSON(bracketEditPath, map[string]any{
		"action":        "apply_template",
		"templateId":    "single_elimination",
		"pilotsPerHeat": 4,
		"targetLaps":    2,
		"timeLimitSec":  90,
		"finalsFormat":  "single_final",
	}, nil); err != nil {
		t.Fatalf("apply single_elimination template: %v", err)
	}
	// Ensure the Single Finals round uses single_final (GF-1) rather than multi-heat Chase the Ace.
	var roundCheck struct {
		RaceState struct {
			Rounds []struct {
				ID          string `json:"id"`
				BracketLane string `json:"bracketLane"`
			} `json:"rounds"`
		} `json:"raceState"`
	}
	if err := h.WasmGetJSON("/v1/state", &roundCheck); err == nil {
		for _, rnd := range roundCheck.RaceState.Rounds {
			if rnd.BracketLane == "finals" {
				_ = h.WasmPostJSON(bracketEditPath, map[string]any{
					"action":       "update_round",
					"roundId":      rnd.ID,
					"finalsFormat": "single_final",
					"targetLaps":   2,
					"timeLimitSec": 90,
				}, nil)
			}
		}
	}

	// Enter Marshal tab and accelerate simulation to 20x speed.
	controlTabBtn := h.Page.Locator(`button[data-mobile-ctrl-nav="live"]`).First()
	h.MustBeVisible(controlTabBtn, "Marshal tab button")
	if err := controlTabBtn.Click(); err != nil {
		t.Fatalf("click Marshal tab: %v", err)
	}
	if err := h.WasmMethodJSON("PATCH", "/v1/sim", map[string]any{"speedMultiplier": 20}, nil); err != nil {
		t.Fatalf("PATCH /v1/sim 20x: %v", err)
	}

	// Start the Finals heat (confirming Pause Active Session if Open Practice was running on boot).
	h.StartActiveHeat()
	h.MilestoneScreenshot("heat-started-at-20x")

	// Wait until all 4 pilots finish their 2 target laps (or heat transitions to "finished").
	var penalizedSlot int
	h.WaitUntil("all 4 pilots complete 2 laps or heat finishes at 20x speed", 20*time.Second, func() (bool, error) {
		var st struct {
			RaceState struct {
				Heats []struct {
					ID    string `json:"id"`
					State string `json:"state"`
					Seats []struct {
						PilotSlotIndex int    `json:"pilotSlotIndex"`
						LapsCompleted  int    `json:"lapsCompleted"`
						Status         string `json:"status"`
					} `json:"seats"`
				} `json:"heats"`
			} `json:"raceState"`
		}
		if err := h.WasmGetJSON("/v1/state", &st); err != nil {
			return false, nil
		}
		if len(st.RaceState.Heats) == 0 {
			return false, nil
		}
		ht := st.RaceState.Heats[0]
		for _, s := range ht.Seats {
			if s.PilotSlotIndex > 0 && penalizedSlot == 0 {
				penalizedSlot = s.PilotSlotIndex
			}
		}
		if ht.State == "finished" {
			return true, nil
		}
		finishedSeats := 0
		activeSeats := 0
		for _, s := range ht.Seats {
			if s.PilotSlotIndex > 0 {
				activeSeats++
				if s.LapsCompleted >= 2 || s.Status == "finished" {
					finishedSeats++
				}
			}
		}
		return activeSeats >= 4 && finishedSeats == activeSeats, nil
	})

	// If heat is still in "running" state waiting for director stop, click "Finish Heat".
	stopBtn := h.Page.Locator(`button[data-ctrl="stop"]`).First()
	if vis, _ := stopBtn.IsVisible(); vis {
		if err := stopBtn.Click(); err != nil {
			t.Fatalf("click Finish Heat: %v", err)
		}
	}

	// Verify Confirm Results button is visible now that heat is finished.
	confirmBtn := h.Page.Locator(`button[data-ctrl="confirm"]`).First()
	h.MustBeVisible(confirmBtn, "Confirm Results & Advance Bracket button")

	// Exercise Flight Line penalty hammer button: apply a +5s time penalty to a seat and verify chip renders.
	penBtn := h.Page.Locator(fmt.Sprintf(`[data-canvas-panel="heatline"] button[data-marshal="cycle_penalty"][data-slot-index="%d"]`, penalizedSlot)).First()
	h.MustBeVisible(penBtn, "Pilot +5s penalty hammer button")
	if err := penBtn.Click(); err != nil {
		t.Fatalf("click +5s Penalty hammer: %v", err)
	}

	h.MustBeVisible(h.Page.Locator(`[data-canvas-panel="heatline"] .race-pen-chip`).First(), "+5s penalty badge in Flight Line")
	h.MilestoneScreenshot("heat-finished-with-marshal-penalty")

	// Confirm Heat Results & Crown Champion!
	if err := confirmBtn.Click(); err != nil {
		t.Fatalf("click Confirm Results & Advance Bracket: %v", err)
	}

	var champion string
	h.WaitUntil("tournament marked complete and champion crowned", 10*time.Second, func() (bool, error) {
		var st struct {
			RaceState struct {
				IsComplete       bool   `json:"isComplete"`
				Lifecycle        string `json:"lifecycle"`
				ChampionCallsign string `json:"championCallsign"`
			} `json:"raceState"`
		}
		if err := h.WasmGetJSON("/v1/state", &st); err != nil {
			return false, nil
		}
		if st.RaceState.IsComplete && st.RaceState.ChampionCallsign != "" {
			champion = st.RaceState.ChampionCallsign
			return true, nil
		}
		return false, nil
	})

	// Verify UI controller strip announces completion and #1 Champion callsign.
	stripLoc := h.Page.Locator(`[data-race-controller-strip]`).First()
	h.MustBeVisible(stripLoc, "Race controller info strip")
	h.WaitUntil("controller strip displays finalized champion callsign", 6*time.Second, func() (bool, error) {
		txt, err := stripLoc.InnerText()
		if err != nil {
			return false, nil
		}
		return strings.Contains(txt, "All heats finalized") && strings.Contains(txt, champion), nil
	})
	h.MilestoneScreenshot("tournament-complete-champion-crowned")
}
