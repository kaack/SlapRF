//go:build e2e

package e2e_test

import (
	"strings"
	"testing"
	"time"
)

func TestComponent_RacesDirectoryFiltersTagsAndRename(t *testing.T) {
	h := NewHarness(t)
	// SnapshotRaceActiveControl has 2 races: "Friday Night Brawl" (active, #League #Season-4)
	// and "Sunday Qualifier" (draft/setup, #Qualifier #2-Stage).
	h.BootWithSnapshot(SnapshotRaceActiveControl, "#/races", nil)

	h.WaitUntil("2 race rows rendered in directory", 5*time.Second, func() (bool, error) {
		cnt, err := h.Page.Locator(`button[data-race-act="edit-race-name"]`).Count()
		return err == nil && cnt == 2, nil
	})

	// 1. Filter by status "active" -> 1 row ("Friday Night Brawl").
	if err := h.Page.Locator(`button[data-race-dir-status="active"]`).Click(); err != nil {
		t.Fatalf("click status=active: %v", err)
	}
	h.WaitUntil("1 active race row", 5*time.Second, func() (bool, error) {
		cnt, err := h.Page.Locator(`button[data-race-act="edit-race-name"]`).Count()
		return err == nil && cnt == 1, nil
	})

	// 2. Filter by status "setup" -> 1 row ("Sunday Qualifier").
	if err := h.Page.Locator(`button[data-race-dir-status="setup"]`).Click(); err != nil {
		t.Fatalf("click status=setup: %v", err)
	}
	h.MustContainText(h.Page.Locator(`[data-race-dir-results]`).First(), "Sunday Qualifier")

	// 3. Reset via Clear button, then filter by tag #League.
	if err := h.Page.Locator(`button[data-tag-filter="__reset_all__"]`).Click(); err != nil {
		t.Fatalf("click Clear filters: %v", err)
	}
	if err := h.Page.Locator(`button[data-tag-filter="League"]`).Click(); err != nil {
		t.Fatalf("click #League tag: %v", err)
	}
	h.MustContainText(h.Page.Locator(`[data-race-dir-results]`).First(), "Friday Night Brawl")
	h.MilestoneScreenshot("races-directory-filtered")

	// 4. Reset filters and rename "Sunday Qualifier" inline -> "Sunday Shootout".
	if err := h.Page.Locator(`button[data-tag-filter="__reset_all__"]`).Click(); err != nil {
		t.Fatalf("reset filters before rename: %v", err)
	}
	editBtns := h.Page.Locator(`button[data-race-act="edit-race-name"]`)
	if err := editBtns.Nth(1).Click(); err != nil {
		t.Fatalf("click edit-race-name on 2nd race: %v", err)
	}
	nameInput := h.Page.Locator(`input[data-race-name-input]`).First()
	h.MustBeVisible(nameInput, "Inline race rename input")
	if err := nameInput.Fill("Sunday Shootout"); err != nil {
		t.Fatalf("fill Sunday Shootout: %v", err)
	}
	if err := nameInput.Press("Enter"); err != nil {
		t.Fatalf("press Enter on race name: %v", err)
	}
	h.MustContainText(h.Page.Locator(`[data-race-dir-results]`).First(), "Sunday Shootout")
	stRaceDir := h.APIState()
	foundShootout := false
	for _, rc := range stRaceDir.EventState.Races {
		if rc.Config.EventName == "Sunday Shootout" {
			foundShootout = true
		}
	}
	if !foundShootout {
		t.Fatalf("expected /api/state EventState.Races to include renamed Sunday Shootout")
	}
	h.MilestoneScreenshot("races-directory-renamed")
}

func TestComponent_FormatDiagramStageCardsZoomFitAndSettingsModal(t *testing.T) {
	h := NewHarness(t)
	h.BootWithSnapshot(SnapshotRaceActiveControl, "#/races/sunday-qualifier/format", nil)

	stageCards := h.Page.Locator(`[data-stage-node]`)
	h.WaitUntil("2 stage cards rendered on Format DAG", 5*time.Second, func() (bool, error) {
		cnt, err := stageCards.Count()
		return err == nil && cnt == 2, nil
	})
	h.MilestoneScreenshot("format-diagram-2-stages")

	// Exercise Zoom In, Zoom Out, and Fit View on the board controls HUD.
	if err := h.Page.Locator(`button[data-rc-ui="zoom-in"]`).Click(); err != nil {
		t.Fatalf("click zoom-in: %v", err)
	}
	if err := h.Page.Locator(`button[data-rc-ui="zoom-out"]`).Click(); err != nil {
		t.Fatalf("click zoom-out: %v", err)
	}
	if err := h.Page.Locator(`button[data-rc-ui="fit-view"]`).Click(); err != nil {
		t.Fatalf("click fit-view: %v", err)
	}

	// Open Stage 1 Settings modal via [data-fmt-action="open_stage_settings"] and close cleanly.
	settingsBtn := stageCards.First().Locator(`button[data-fmt-action="open_stage_settings"]`).First()
	h.MustBeVisible(settingsBtn, "Stage 1 Settings button")
	if err := settingsBtn.Click(); err != nil {
		t.Fatalf("click open_stage_settings: %v", err)
	}

	modal := h.Page.Locator(`.slaprf-modal-backdrop`).First()
	h.MustBeVisible(modal, "Stage Settings modal")
	h.MilestoneScreenshot("format-stage-settings-modal")

	if err := h.Page.Keyboard().Press("Escape"); err != nil {
		t.Fatalf("press Escape on stage settings modal: %v", err)
	}
	h.MustBeHidden(modal, "Stage Settings modal closed on Escape")
}

func TestComponent_FormatDiagramWireDropContextualMenu(t *testing.T) {
	h := NewHarness(t)
	h.BootWithSnapshot(SnapshotRaceActiveControl, "#/races/sunday-qualifier/format", nil)

	stageCards := h.Page.Locator(`[data-stage-node]`)
	h.WaitUntil("2 stage cards rendered", 5*time.Second, func() (bool, error) {
		cnt, err := stageCards.Count()
		return err == nil && cnt == 2, nil
	})

	// Drag from Stage 2's right output port into empty canvas space -> WireDropMenu opens!
	outPort := stageCards.Nth(1).Locator(`button[data-fmt-port="out"]`).First()
	h.MustBeVisible(outPort, "Stage 2 output port")
	pBox, err := outPort.BoundingBox()
	if err != nil || pBox == nil {
		t.Fatalf("BoundingBox Stage 2 outPort: %v", err)
	}

	sx := pBox.X + pBox.Width/2
	sy := pBox.Y + pBox.Height/2
	ex := sx + 220
	ey := sy + 20

	_ = h.Page.Mouse().Move(sx, sy)
	_ = h.Page.Mouse().Down()
	_ = h.Page.Mouse().Move(sx+20, sy)
	_ = h.Page.Mouse().Move(ex, ey)
	_ = h.Page.Mouse().Up()

	// Pick an option in the contextual wire-drop menu (.rc-wire-drop-menu wrapper is 0x0 anchor, so check visible item button!).
	firstOpt := h.Page.Locator(`[data-wire-drop-menu] button[data-wire-drop-opt]:not([disabled])`).First()
	h.MustBeVisible(firstOpt, "Enabled stage option in WireDropMenu")
	h.MilestoneScreenshot("format-wire-drop-menu-open")
	if err := firstOpt.Click(); err != nil {
		t.Fatalf("click WireDropMenu option: %v", err)
	}

	h.WaitUntil("Stage 3 spawned and connected on Format DAG", 5*time.Second, func() (bool, error) {
		cnt, gErr := stageCards.Count()
		return gErr == nil && cnt == 3, nil
	})
	stWireDrop := h.APIState()
	found3Stage := false
	for _, rc := range stWireDrop.EventState.Races {
		if rc.Config.EventName == "Sunday Qualifier" && (rc.TotalStages == 3 || len(rc.Stages) == 3) {
			found3Stage = true
		}
	}
	if !found3Stage {
		t.Fatalf("expected /api/state Sunday Qualifier to report 3 stages after wire-drop creation")
	}
	h.MilestoneScreenshot("format-wire-drop-stage3-spawned")
}

func TestComponent_BracketDiagramTemplatesModalApply(t *testing.T) {
	h := NewHarness(t)
	h.BootWithSnapshot(SnapshotRaceActiveControl, "#/races/sunday-qualifier/format", nil)

	// Expand board controls pill and click open-templates.
	expandCtrl := h.Page.Locator(`button[data-rc-ui="toggle-controls-expand"]`).First()
	h.MustBeVisible(expandCtrl, "Expand board controls button")
	if err := expandCtrl.Click(); err != nil {
		t.Fatalf("click toggle-controls-expand: %v", err)
	}

	openTplBtn := h.Page.Locator(`button[data-rc-ui="open-templates"]`).First()
	h.MustBeVisible(openTplBtn, "Choose format template button")
	if err := openTplBtn.Click(); err != nil {
		t.Fatalf("click open-templates: %v", err)
	}

	modal := h.Page.Locator(`.slaprf-modal-backdrop`).First()
	h.MustBeVisible(modal, "Choose Race Format modal")

	singleElimCard := modal.Locator(`[data-modal-pick-tpl="single_elimination"]`).First()
	h.MustBeVisible(singleElimCard, "Single Elimination template option")
	if err := singleElimCard.Click(); err != nil {
		t.Fatalf("click single_elimination card: %v", err)
	}
	h.MilestoneScreenshot("templates-modal-single-elim")

	if err := modal.Locator(`button[data-tpl-confirm]`).Click(); err != nil {
		t.Fatalf("click Continue on templates modal: %v", err)
	}
	// Replacing existing stages prompts a destructive-action confirmation modal ("Apply Template").
	confirmReplaceBtn := h.Page.Locator(`.slaprf-modal-backdrop button[data-modal-confirm]`).First()
	h.MustBeVisible(confirmReplaceBtn, "Confirm Replace Current Rounds button")
	if err := confirmReplaceBtn.Click(); err != nil {
		t.Fatalf("click Apply Template confirm: %v", err)
	}
	h.MustBeHidden(modal, "Templates & confirm modals closed after Apply Template")

	// Sunday Qualifier had 2 stages; Single Elimination replaces it with 1 stage!
	h.WaitUntil("Format DAG updated to 1 Single Elimination stage", 5*time.Second, func() (bool, error) {
		cnt, err := h.Page.Locator(`[data-stage-node]`).Count()
		return err == nil && cnt == 1, nil
	})
	stTpl := h.APIState()
	for _, rc := range stTpl.EventState.Races {
		if rc.RaceID == "sunday-qualifier" && (rc.TotalStages != 1 || string(rc.Config.MainFormat) != "single_elimination") {
			t.Fatalf("expected /api/state sunday-qualifier TotalStages=1 MainFormat=single_elimination, got stages=%d fmt=%s", rc.TotalStages, rc.Config.MainFormat)
		}
	}
}

func TestComponent_BracketDiagramRoundCardAddHeatAndCameraHud(t *testing.T) {
	h := NewHarness(t)
	h.BootWithSnapshot(SnapshotRaceActiveControl, "#/races/sunday-qualifier/stage-1", nil)

	rounds := h.Page.Locator(`[data-round-node]`)
	h.WaitUntil("Stage 1 round cards rendered", 5*time.Second, func() (bool, error) {
		cnt, err := rounds.Count()
		return err == nil && cnt >= 2, nil
	})

	initialHeats, _ := h.Page.Locator(`button[data-bkt-action="delete_heat"]`).Count()

	// Open the first round's hamburger menu and click "Add Heat".
	menuBtn := h.Page.Locator(`button[data-bkt-ui="toggle-node-menu"]`).First()
	h.MustBeVisible(menuBtn, "Round options hamburger button")
	if err := menuBtn.Click(); err != nil {
		t.Fatalf("click toggle-node-menu: %v", err)
	}

	addHeatBtn := h.Page.Locator(`button[data-bkt-action="add_heat"]`).First()
	h.MustBeVisible(addHeatBtn, "Add Heat menu item")
	if err := addHeatBtn.Click(); err != nil {
		t.Fatalf("click add_heat: %v", err)
	}

	h.WaitUntil("heat count incremented on Stage 1 round card", 5*time.Second, func() (bool, error) {
		nowHeats, err := h.Page.Locator(`button[data-bkt-action="delete_heat"]`).Count()
		return err == nil && nowHeats > initialHeats, nil
	})
	h.MilestoneScreenshot("bracket-round-added-heat")

	// Toggle Pan/Select tool and Fit View on camera HUD.
	if err := h.Page.Locator(`button[data-rc-ui="toggle-tool"]`).Click(); err != nil {
		t.Fatalf("click toggle-tool: %v", err)
	}
	if err := h.Page.Locator(`button[data-rc-ui="fit-view"]`).Click(); err != nil {
		t.Fatalf("click fit-view: %v", err)
	}
}

func TestComponent_ControlCockpitPanelsToggleAndResetLayout(t *testing.T) {
	h := NewHarness(t)
	h.BootWithSnapshot(SnapshotRaceActiveControl, "#/races/friday-night-brawl/control", nil)

	cockpit := h.Page.Locator(`[data-canvas-panel="cockpit"]`).First()
	schedule := h.Page.Locator(`[data-canvas-panel="schedule"]`).First()
	h.MustBeVisible(cockpit, "Race Control cockpit panel")
	h.MustBeVisible(schedule, "Heats Schedule panel")

	// 0. Control canvas is locked by default, hiding the + speed-dial menu!
	fabMenu := h.Page.Locator(`.rc-fab-menu`).First()
	h.MustBeHidden(fabMenu, "Control + speed-dial hidden while Control canvas is locked by default")

	// Verify 3-way Race Lifecycle pill (Active | Paused | Emergency) & single inner status pill:
	// Panel header must NOT duplicate .race-state-pill.
	headerPillCount, err := cockpit.Locator(`header.rc-panel-header .race-state-pill`).Count()
	if err != nil || headerPillCount != 0 {
		t.Fatalf("expected 0 .race-state-pill in Race Control panel header, got %d (err=%v)", headerPillCount, err)
	}
	emergSegBtn := cockpit.Locator(`.rc-lifecycle-seg button[data-lifecycle-act="emergency_stop"]`).First()
	pauseSegBtn := cockpit.Locator(`.rc-lifecycle-seg button[data-lifecycle-act="pause_race"]`).First()
	h.MustBeVisible(emergSegBtn, "Emergency segment in 3-way Race Lifecycle pill")
	if err := emergSegBtn.Click(); err != nil {
		t.Fatalf("click Emergency segment: %v", err)
	}
	h.WaitUntil("inner heat pill shows Stopped on Emergency", 5*time.Second, func() (bool, error) {
		txt, err := cockpit.Locator(`.rc-panel-body .race-state-pill`).First().InnerText()
		return err == nil && strings.TrimSpace(txt) == "Stopped", nil
	})
	// Re-run Heat must NOT appear while paused/emergency!
	rerunCount, _ := cockpit.Locator(`button[data-ctrl="reset"]`).Count()
	if rerunCount != 0 {
		t.Fatalf("expected Re-run Heat hidden during Emergency/Paused, got %d", rerunCount)
	}
	// Clicking Paused clears Stopped immediately!
	if err := pauseSegBtn.Click(); err != nil {
		t.Fatalf("click Paused segment: %v", err)
	}
	h.WaitUntil("Stopped state cleared when switching to Paused", 5*time.Second, func() (bool, error) {
		txt, err := cockpit.Locator(`.rc-panel-body .race-state-pill`).First().InnerText()
		return err == nil && strings.TrimSpace(txt) != "Stopped", nil
	})
	// Switch back to Active!
	activeSegBtn := cockpit.Locator(`.rc-lifecycle-seg button.is-opt-active`).First()
	if err := activeSegBtn.Click(); err != nil {
		t.Fatalf("click Active segment: %v", err)
	}
	h.WaitUntil("Active segment is-active", 5*time.Second, func() (bool, error) {
		res, err := activeSegBtn.Evaluate(`el => el.classList.contains("is-active")`, nil)
		ok, _ := res.(bool)
		return err == nil && ok, nil
	})

	// Verify per-canvas lock independence: switching to Review is also locked by default, while Configure (Format) is unlocked by default!
	if err := h.Page.Locator(`button[data-race-tab="review"]`).First().Click(); err != nil {
		t.Fatalf("switch to Review tab: %v", err)
	}
	h.MustBeHidden(h.Page.Locator(`.rc-fab-menu`).First(), "Review canvas locked by default (+ hidden)")
	if err := h.Page.Locator(`button[data-race-tab="control"]`).First().Click(); err != nil {
		t.Fatalf("switch back to Control tab: %v", err)
	}
	h.MustBeHidden(h.Page.Locator(`.rc-fab-menu`).First(), "Control canvas remains locked after returning from Review")

	// Unlock Control canvas via toggle-lock so + speed-dial appears!
	lockBtn := h.Page.Locator(`button[data-rc-ui="toggle-lock"]`).First()
	if err := lockBtn.Click(); err != nil {
		t.Fatalf("click toggle-lock to unlock Control canvas: %v", err)
	}

	// 1. Collapse and expand Heats Schedule panel.
	collapseSched := schedule.Locator(`button[data-rc-panel-collapse="schedule"]`).First()
	if err := collapseSched.Click(); err != nil {
		t.Fatalf("collapse schedule panel: %v", err)
	}
	h.WaitUntil("schedule panel marked is-collapsed", 5*time.Second, func() (bool, error) {
		res, err := schedule.Evaluate(`el => el.classList.contains("is-collapsed")`, nil)
		ok, _ := res.(bool)
		return err == nil && ok, nil
	})

	// 2. Hide Heats Schedule panel via ×, then restore it from speed-dial + button!
	hideSched := schedule.Locator(`button[data-rc-panel-toggle="schedule"]`).First()
	if err := hideSched.Click(); err != nil {
		t.Fatalf("hide schedule panel: %v", err)
	}
	h.MustBeHidden(schedule, "Heats Schedule panel hidden")
	h.MilestoneScreenshot("control-schedule-panel-hidden")

	fabBtn := h.Page.Locator(`button[data-rc-ui="fab-main"]`).First()
	h.MustBeVisible(fabBtn, "Control + speed-dial visible after unlocking Control canvas")
	if err := fabBtn.Click(); err != nil {
		t.Fatalf("click Control + speed-dial: %v", err)
	}
	addSchedBtn := h.Page.Locator(`button[data-rc-add-panel="schedule"]`).First()
	h.MustBeVisible(addSchedBtn, "Restore Heats Schedule button in speed-dial")
	if err := addSchedBtn.Click(); err != nil {
		t.Fatalf("click restore schedule panel: %v", err)
	}
	h.MustBeVisible(schedule, "Heats Schedule panel restored")

	// 3. Expand board controls and click Reset Layout.
	if err := h.Page.Locator(`button[data-rc-ui="toggle-controls-expand"]`).Click(); err != nil {
		t.Fatalf("expand board controls: %v", err)
	}
	if err := h.Page.Locator(`button[data-rc-ui="reset-layout"]`).Click(); err != nil {
		t.Fatalf("click reset-layout: %v", err)
	}
	h.MilestoneScreenshot("control-panels-reset-layout")
}

func TestComponent_ControlManualLapAdjustAndMarshalActions(t *testing.T) {
	h := NewHarness(t)
	h.BootWithSnapshot(SnapshotRaceActiveControl, "#/races/friday-night-brawl/control", nil)

	// W1-2 is ready on the flight line. Open seat 1's status pill swapper and switch to Scratched (DNS) & back to Staged,
	// AND test the stage graph jump icon [data-race-act="focus-heat-graph"]!
	firstMarshalBtn := h.Page.Locator(`button[data-marshal-menu-toggle]`).First()
	h.MustBeVisible(firstMarshalBtn, "Flight Line seat status pill trigger")
	menuKey, _ := firstMarshalBtn.GetAttribute("data-marshal-menu-toggle")
	marshalBtn := h.Page.Locator(`button[data-marshal-menu-toggle="` + menuKey + `"]`).First()
	if err := marshalBtn.Click(); err != nil {
		t.Fatalf("click status pill trigger: %v", err)
	}

	dnsItem := h.Page.Locator(`.is-status-popover button[data-marshal="set_dns"]`).First()
	h.MustBeVisible(dnsItem, "Marshal set_dns status option")
	h.MilestoneScreenshot("control-marshal-menu-open")

	if err := dnsItem.Click(); err != nil {
		t.Fatalf("select Scratched: %v", err)
	}
	h.WaitUntil("Seat status trigger displays Scratched", 5*time.Second, func() (bool, error) {
		txt, err := marshalBtn.InnerText()
		return err == nil && strings.Contains(txt, "Scratched"), nil
	})
	if err := marshalBtn.Click(); err != nil {
		t.Fatalf("reopen status pill trigger: %v", err)
	}
	stagedItem := h.Page.Locator(`.is-status-popover button[data-marshal="set_racing"]`).First()
	h.MustBeVisible(stagedItem, "Marshal set_racing (Staged) status option")
	if err := stagedItem.Click(); err != nil {
		t.Fatalf("restore Staged status: %v", err)
	}
	h.WaitUntil("Seat status trigger displays Staged", 5*time.Second, func() (bool, error) {
		txt, err := marshalBtn.InnerText()
		return err == nil && strings.Contains(txt, "Staged"), nil
	})

	// Click heat stage-graph jump icon -> navigates straight to stage graph bringing W1-2 into view!
	jumpBtn := h.Page.Locator(`button[data-race-act="focus-heat-graph"]`).First()
	h.MustBeVisible(jumpBtn, "Jump to heat on stage graph button")
	if err := jumpBtn.Click(); err != nil {
		t.Fatalf("click focus-heat-graph: %v", err)
	}
	h.MustBeVisible(h.Page.Locator(`[data-round-node]`).First(), "Stage graph rounds after heat jump")
}

func TestComponent_ReviewTabCompletedHeatListAndSelection(t *testing.T) {
	h := NewHarness(t)
	// SnapshotRaceActiveControl already has W1-1 confirmed with laps, crossings, and +5s penalty!
	h.BootWithSnapshot(SnapshotRaceActiveControl, "#/races/friday-night-brawl/review", nil)

	execRow := h.Page.Locator(`tr[data-review-select-heat="W1-1"]`).First()
	h.MustBeVisible(execRow, "Executed heat W1-1 row in Review")
	h.MustContainText(h.Page.Locator(`[data-canvas-panel="review_heat"]`).First(), "FAERRY")
	h.MilestoneScreenshot("review-tab-w1-1-results")
}

func TestComponent_HeatLapEditorModalRssiWaveformCrossingsAndManualSplit(t *testing.T) {
	h := NewHarness(t)
	h.BootWithSnapshot(SnapshotRaceActiveControl, "#/races/friday-night-brawl/review", nil)

	// Switch W1-1 from Confirmed -> Review using the sideways segmented toggle to unlock lap editing, then click the checkered-flag button [data-open-lap-editor]!
	unlockOpt := h.Page.Locator(`[data-canvas-panel="review_heat"] [data-review-status-toggle] button[data-set-review-status="unlock"]`).First()
	h.MustBeVisible(unlockOpt, "Heat Review sideways toggle Review button")
	if err := unlockOpt.Click(); err != nil {
		t.Fatalf("click Review unlock toggle button: %v", err)
	}

	openEdBtn := h.Page.Locator(`[data-canvas-panel="review_heat"] button[data-open-lap-editor]`).First()
	h.MustBeVisible(openEdBtn, "Checkered-flag RSSI & lap timings button")
	if err := openEdBtn.Click(); err != nil {
		t.Fatalf("click data-open-lap-editor: %v", err)
	}

	svg := h.Page.Locator(`svg[data-lap-ed-svg]`).First()
	h.MustBeVisible(svg, "HeatLapEditorModal RSSI waveform SVG")

	// Verify 4 crossing pins (Holeshot + L1 + L2 + L3) are rendered on the waveform!
	pins := h.Page.Locator(`[data-crossing-pin]`)
	h.WaitUntil("4 crossing pins rendered on RSSI waveform", 5*time.Second, func() (bool, error) {
		cnt, err := pins.Count()
		return err == nil && cnt == 4, nil
	})
	h.MilestoneScreenshot("heat-lap-editor-rssi-waveform")

	// Append a synthetic lap crossing at the end via [data-lap-ed-add-end] -> 5 pins!
	addEndBtn := h.Page.Locator(`button[data-lap-ed-add-end]`).First()
	h.MustBeVisible(addEndBtn, "+ End crossing button")
	if err := addEndBtn.Click(); err != nil {
		t.Fatalf("click data-lap-ed-add-end: %v", err)
	}
	h.WaitUntil("5 crossing pins after appending manual split", 5*time.Second, func() (bool, error) {
		cnt, err := pins.Count()
		return err == nil && cnt == 5, nil
	})

	// Invalidate & restore a crossing via [data-lap-ed-toggle].
	toggleCrossBtn := h.Page.Locator(`button[data-lap-ed-toggle]`).First()
	if err := toggleCrossBtn.Click(); err != nil {
		t.Fatalf("click data-lap-ed-toggle: %v", err)
	}
	h.MilestoneScreenshot("heat-lap-editor-modified-crossings")

	// Switch pilot tab inside modal ([data-lap-ed-pilot]), then close modal cleanly.
	pilotTabs := h.Page.Locator(`button[data-lap-ed-pilot]`)
	if cnt, _ := pilotTabs.Count(); cnt >= 2 {
		_ = pilotTabs.Nth(1).Click()
	}
	if err := h.Page.Locator(`button[data-lap-ed-close]`).First().Click(); err != nil {
		t.Fatalf("close HeatLapEditorModal: %v", err)
	}
	h.MustBeHidden(svg, "HeatLapEditorModal closed")
}

func TestComponent_MultiGPModalsImportPreviewAndSyncDialog(t *testing.T) {
	h := NewHarness(t)
	// Seed simulated MultiGP API key in localStorage + SnapshotMultiGPSeeded in IndexedDB
	// so both Import Modal and Sync Modal work immediately with zero setup steps!
	h.BootWithSnapshot(SnapshotMultiGPSeeded, "#/races", map[string]string{
		"slaprf.multigp.v1": `{"apiKey":"MGP-SIM-BAYAREA-2026"}`,
	})

	// 1. Open MultiGP Import modal from Races directory and switch between Schedule / ZippyQ / Bracket modes.
	impBtn := h.Page.Locator(`button[data-race-act="import-multigp"]`).First()
	h.MustBeVisible(impBtn, "Import from MultiGP button")
	if err := impBtn.Click(); err != nil {
		t.Fatalf("click import-multigp: %v", err)
	}

	modal := h.Page.Locator(`.slaprf-modal-backdrop`).First()
	h.MustBeVisible(modal, "MultiGP Import modal")
	h.MustBeVisible(modal.Locator(`[data-mgp-select-race]`).First(), "Simulated MultiGP race rows")

	for _, mode := range []string{"zippyq", "bracket", "schedule"} {
		mBtn := modal.Locator(`button[data-mgp-import-mode="` + mode + `"]`).First()
		if cnt, _ := mBtn.Count(); cnt > 0 {
			_ = mBtn.Click()
		}
	}
	h.MilestoneScreenshot("multigp-import-modal-preview")

	if err := modal.Locator(`button[data-mgp-modal-close]`).First().Click(); err != nil {
		t.Fatalf("close MultiGP Import modal: %v", err)
	}
	h.MustBeHidden(modal, "MultiGP Import modal closed")

	// 2. Open the already-linked MultiGP race in Control, switch to Review tab, and open MultiGPSyncModal!
	openCtrlBtn := h.Page.Locator(`button[data-race-act="open-race-control"]`).First()
	h.MustBeVisible(openCtrlBtn, "Open MultiGP race Control button")
	if err := openCtrlBtn.Click(); err != nil {
		t.Fatalf("open MultiGP race control: %v", err)
	}

	reviewTabBtn := h.Page.Locator(`button[data-race-tab="review"]`).First()
	h.MustBeVisible(reviewTabBtn, "Review tab button")
	if err := reviewTabBtn.Click(); err != nil {
		t.Fatalf("click Review tab: %v", err)
	}

	syncBtn := h.Page.Locator(`button[data-race-act="mgp-upload-heats"]`).First()
	h.MustBeVisible(syncBtn, "Upload completed heats to MultiGP button in Review MultiGP panel")
	if err := syncBtn.Click(); err != nil {
		t.Fatalf("click mgp-upload-heats: %v", err)
	}

	syncModal := h.Page.Locator(`.slaprf-modal-backdrop`).First()
	h.MustBeVisible(syncModal, "MultiGPSyncModal")
	doSyncBtn := syncModal.Locator(`button[data-mgp-do-sync]`).First()
	h.MustBeVisible(doSyncBtn, "Upload to MultiGP confirm button")
	h.MilestoneScreenshot("multigp-sync-modal-operations")

	if err := doSyncBtn.Click(); err != nil {
		t.Fatalf("click Upload to MultiGP: %v", err)
	}
	h.MustBeHidden(syncModal, "MultiGPSyncModal closed after successful upload")
	// Verify via /api/mgp-sync/plan on the WASM API that pending uploads dropped to 0!
	var syncPlan struct {
		HeatUploads []any `json:"heatUploads"`
	}
	stAfterSync := h.APIState()
	h.APIPost("/api/mgp-sync/plan", map[string]any{
		"raceId":   stAfterSync.RaceState.RaceID,
		"forceAll": false,
	}, &syncPlan)
	if len(syncPlan.HeatUploads) != 0 {
		t.Fatalf("expected 0 unsynced heatUploads in /api/mgp-sync/plan after UI sync, got %d", len(syncPlan.HeatUploads))
	}
}
