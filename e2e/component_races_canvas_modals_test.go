//go:build e2e

package e2e_test

import (
	"math"
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

	// 3. Reset via Clear button, then filter by tag #League via search input.
	if err := h.Page.Locator(`button[data-tag-filter="__reset_all__"]`).Click(); err != nil {
		t.Fatalf("click Clear filters: %v", err)
	}
	searchInp := h.Page.Locator(`input[data-race-dir-search]`).First()
	if err := searchInp.Fill("#League"); err != nil {
		t.Fatalf("search #League tag: %v", err)
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

	// 5. Verify "+ Add" sits immediately to the right of "Search or add race..." at 32px height,
	// "Import from MultiGP" sits below .races-dir-card on the bottom-left,
	// and pressing Enter in [data-race-dir-search] creates a race with the typed name.
	raceDirLayoutOK, err := h.Page.Evaluate(`() => {
		const inp = document.querySelector("input[data-race-dir-search]");
		const addBtn = document.querySelector('button[data-race-act="create-race-inline"]');
		const card = document.querySelector(".races-dir-card");
		const mgpBtn = document.querySelector('[data-race-dir-bottom-actions] button[data-race-act="import-multigp"]');
		if (!inp || !addBtn || !card || !mgpBtn) return false;
		const ir = inp.getBoundingClientRect();
		const ar = addBtn.getBoundingClientRect();
		const cr = card.getBoundingClientRect();
		const mr = mgpBtn.getBoundingClientRect();
		return inp.getAttribute("placeholder") === "Search or add race..." &&
			Math.abs(ir.height - 32) <= 2 &&
			Math.abs(ar.height - 32) <= 2 &&
			ar.left >= ir.right &&
			(ar.left - ir.right) <= 16 &&
			(mgpBtn.textContent || "").trim() === "Import from MultiGP" &&
			mr.top >= cr.bottom - 1 &&
			Math.abs(mr.left - cr.left) <= 4;
	}`)
	if err != nil || raceDirLayoutOK != true {
		t.Fatalf("expected Races search/add bar and bottom-left Import from MultiGP layout: err=%v ok=%v", err, raceDirLayoutOK)
	}
	if err := searchInp.Fill("Thursday Night Spec"); err != nil {
		t.Fatalf("fill Thursday Night Spec: %v", err)
	}
	if err := searchInp.Press("Enter"); err != nil {
		t.Fatalf("press Enter to add race: %v", err)
	}
	h.WaitUntil("Thursday Night Spec created in Races directory", 5*time.Second, func() (bool, error) {
		for _, rc := range h.APIState().EventState.Races {
			if rc.Config.EventName == "Thursday Night Spec" {
				return true, nil
			}
		}
		return false, nil
	})
	h.MilestoneScreenshot("races-directory-renamed")
}

func TestComponent_FormatDiagramStageCardsZoomFitAndSettingsModal(t *testing.T) {
	h := NewHarness(t)
	h.BootWithSnapshot(SnapshotRaceActiveControl, "#/races/sunday-qualifier/format", nil)

	roundCards := h.Page.Locator(`[data-round-node]:not(.is-pilots-node)`)
	h.WaitUntil("unified single-graph round cards rendered on Configure canvas", 5*time.Second, func() (bool, error) {
		cnt, err := roundCards.Count()
		return err == nil && cnt >= 3, nil
	})
	h.MilestoneScreenshot("unified-single-graph-rounds")

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

	// Open Round Settings modal via node menu and close cleanly.
	menuBtn := roundCards.First().Locator(`button[data-bkt-ui="toggle-node-menu"]`).First()
	h.MustBeVisible(menuBtn, "Round options menu button")
	if err := menuBtn.Click(); err != nil {
		t.Fatalf("click toggle-node-menu: %v", err)
	}
	editRoundBtn := h.Page.Locator(`button[data-bkt-action="open_round_customize"]`).First()
	h.MustBeVisible(editRoundBtn, "Customize Round menu item")
	if err := editRoundBtn.Click(); err != nil {
		t.Fatalf("click open_round_customize: %v", err)
	}

	modal := h.Page.Locator(`.slaprf-modal-backdrop`).First()
	h.MustBeVisible(modal, "Round Settings modal")
	h.MilestoneScreenshot("unified-round-settings-modal")

	if err := h.Page.Keyboard().Press("Escape"); err != nil {
		t.Fatalf("press Escape on round settings modal: %v", err)
	}
	h.MustBeHidden(modal, "Round Settings modal closed on Escape")
}

func TestComponent_FormatDiagramWireDropContextualMenu(t *testing.T) {
	h := NewHarness(t)
	h.BootWithSnapshot(SnapshotRaceActiveControl, "#/races/sunday-qualifier/format", nil)

	roundCards := h.Page.Locator(`[data-round-node]:not(.is-pilots-node)`)
	h.WaitUntil("round cards rendered on unified Configure canvas", 5*time.Second, func() (bool, error) {
		cnt, err := roundCards.Count()
		return err == nil && cnt >= 3, nil
	})
	initialCnt, _ := roundCards.Count()

	// Drag from the first round's right output port into empty canvas space -> WireDropMenu opens!
	outPort := roundCards.First().Locator(`button.bkt-port.is-out[data-round-out]`).First()
	h.MustBeVisible(outPort, "Round output port")
	pBox, err := outPort.BoundingBox()
	if err != nil || pBox == nil {
		t.Fatalf("BoundingBox round outPort: %v", err)
	}

	sx := pBox.X + pBox.Width/2
	sy := pBox.Y + pBox.Height/2
	ex := sx + 24
	ey := sy - 220

	_ = h.Page.Mouse().Move(sx, sy)
	_ = h.Page.Mouse().Down()
	_ = h.Page.Mouse().Move(sx+20, sy)
	_ = h.Page.Mouse().Move(ex, ey)
	_ = h.Page.Mouse().Up()

	firstOpt := h.Page.Locator(`[data-wire-drop-menu] button[data-wire-drop-opt]:not([disabled])`).First()
	h.MustBeVisible(firstOpt, "Enabled construct option in WireDropMenu")
	h.MilestoneScreenshot("unified-wire-drop-menu-open")
	if err := firstOpt.Click(); err != nil {
		t.Fatalf("click WireDropMenu option: %v", err)
	}

	h.WaitUntil("new round spawned and connected on unified Configure canvas", 5*time.Second, func() (bool, error) {
		cnt, gErr := roundCards.Count()
		return gErr == nil && cnt == initialCnt+1, nil
	})
	h.MilestoneScreenshot("unified-wire-drop-round-spawned")
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
	confirmReplaceBtn := h.Page.Locator(`.slaprf-modal-backdrop button[data-modal-confirm]`).First()
	h.MustBeVisible(confirmReplaceBtn, "Confirm Replace Current Rounds button")
	if err := confirmReplaceBtn.Click(); err != nil {
		t.Fatalf("click Apply Template confirm: %v", err)
	}
	h.MustBeHidden(modal, "Templates & confirm modals closed after Apply Template")

	h.WaitUntil("Unified graph updated to Single Elimination rounds", 5*time.Second, func() (bool, error) {
		stNow := h.APIState()
		for _, rc := range stNow.EventState.Races {
			if rc.Config.EventName == "Sunday Qualifier" && rc.TotalStages == 1 && string(rc.Config.MainFormat) == "single_elimination" {
				return true, nil
			}
		}
		return false, nil
	})
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
	heatline := h.Page.Locator(`[data-canvas-panel="heatline"]`).First()
	schedule := h.Page.Locator(`[data-canvas-panel="schedule"]`).First()
	h.MustBeVisible(cockpit, "Marshal Race Control cockpit panel")
	h.MustBeVisible(heatline, "Marshal Flight Line panel")
	h.MustBeHidden(schedule, "Heats Schedule hidden while on Marshal tab")

	// 0. Control renders as a standard responsive page ([data-rc-page="control"]) without whiteboard controls or FAB!
	h.MustBeVisible(h.Page.Locator(`[data-rc-page="control"]`).First(), "Control standard page container")
	if cnt, _ := h.Page.Locator(`.races-canvas`).Count(); cnt != 0 {
		t.Fatalf("expected 0 .races-canvas on Control page, got %d", cnt)
	}
	if cnt, _ := h.Page.Locator(`.rc-fab-menu`).Count(); cnt != 0 {
		t.Fatalf("expected 0 .rc-fab-menu on Control page, got %d", cnt)
	}

	// Verify Desktop Flight Line status pills have vertically centered text (0px top/bottom padding).
	statusPillCentered, err := h.Page.Evaluate(`() => {
		const pill = document.querySelector('[data-canvas-panel="heatline"] .race-state-pill.is-table-status-pill');
		if (!pill) return false;
		const cs = getComputedStyle(pill);
		return cs.paddingTop === "0px" && cs.paddingBottom === "0px";
	}`)
	if err != nil || statusPillCentered != true {
		t.Fatalf("expected Desktop Flight Line status pill to have 0px top/bottom padding: err=%v centered=%v", err, statusPillCentered)
	}

	// Verify 3-way Race Lifecycle pill (Active | Paused | Emergency) & single inner status pill:
	// Panel header must NOT duplicate .race-state-pill.
	headerPillCount, err := cockpit.Locator(`header.rc-panel-header .race-state-pill`).Count()
	if err != nil || headerPillCount != 0 {
		t.Fatalf("expected 0 .race-state-pill in Race Control panel header, got %d (err=%v)", headerPillCount, err)
	}
	// Verify on-demand announcement (.race-controller-strip) sits below .race-cockpit-rules and above .race-transport-bar when no info notice is active,
	// and is hidden when an info notice (.race-cockpit-notice:not(.is-placeholder)) is active.
	announceSlotOK, err := h.Page.Evaluate(`() => {
		const rules = document.querySelector('[data-canvas-panel="cockpit"] .race-cockpit-rules');
		const strip = document.querySelector('[data-canvas-panel="cockpit"] [data-race-controller-strip]');
		const notice = document.querySelector('[data-canvas-panel="cockpit"] [data-race-cockpit-notice]');
		const transport = document.querySelector('[data-canvas-panel="cockpit"] .race-transport-bar');
		if (!rules || !strip || !notice || !transport) return false;
		const rRect = rules.getBoundingClientRect();
		const sRect = strip.getBoundingClientRect();
		const tRect = transport.getBoundingClientRect();
		return getComputedStyle(strip).display !== "none" &&
			getComputedStyle(notice).display === "none" &&
			sRect.top >= rRect.bottom - 1 &&
			tRect.top >= sRect.bottom - 1 &&
			Math.abs(sRect.left - rRect.left) <= 2;
	}`)
	if err != nil || announceSlotOK != true {
		t.Fatalf("expected Desktop on-demand announcement positioned below .race-cockpit-rules and above .race-transport-bar: err=%v ok=%v", err, announceSlotOK)
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
	noticeReplacesAnnounceOK, err := h.Page.Evaluate(`() => {
		const strip = document.querySelector('[data-canvas-panel="cockpit"] [data-race-controller-strip]');
		const notice = document.querySelector('[data-canvas-panel="cockpit"] [data-race-cockpit-notice]');
		if (!strip || !notice) return false;
		return getComputedStyle(strip).display === "none" && getComputedStyle(notice).display !== "none";
	}`)
	if err != nil || noticeReplacesAnnounceOK != true {
		t.Fatalf("expected on-demand announcement hidden when info notice is active: err=%v ok=%v", err, noticeReplacesAnnounceOK)
	}
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

	// 1. Switch to Schedule tab on Desktop and toggle Heats Schedule filter tabs (Upcoming / All).
	if err := h.Page.Locator(`.rc-topleft-bar button[data-mobile-ctrl-nav="schedule"]`).First().Click(); err != nil {
		t.Fatalf("click Schedule tab on Desktop: %v", err)
	}
	h.MustBeVisible(schedule, "Heats Schedule panel visible on Schedule tab")
	h.MustBeHidden(cockpit, "Cockpit hidden while on Schedule tab")
	upcomingFilter := schedule.Locator(`button[data-sched-filter="upcoming"]`).First()
	if err := upcomingFilter.Click(); err != nil {
		t.Fatalf("filter schedule upcoming: %v", err)
	}
	allFilter := schedule.Locator(`button[data-sched-filter="all"]`).First()
	if err := allFilter.Click(); err != nil {
		t.Fatalf("filter schedule all: %v", err)
	}

	// 2. Switch to Review and verify it also renders as a standard page ([data-rc-page="review"])
	// with the vertical neon selection strip (.rc-exec-sel-strip) before the Executed column!
	if err := h.Page.Locator(`button[data-race-tab="review"]`).First().Click(); err != nil {
		t.Fatalf("switch to Review tab: %v", err)
	}
	h.MustBeVisible(h.Page.Locator(`[data-rc-page="review"]`).First(), "Review standard page container")
	if cnt, _ := h.Page.Locator(`.races-canvas`).Count(); cnt != 0 {
		t.Fatalf("expected 0 .races-canvas on Review page, got %d", cnt)
	}
	revStripCheck, err := h.Page.Evaluate(`() => {
		const rows = Array.from(document.querySelectorAll(".rc-executed-heats-table tbody tr.rc-review-exec-row"));
		const strips = Array.from(document.querySelectorAll(".rc-executed-heats-table .rc-exec-sel-strip"));
		const selStrip = document.querySelector(".rc-executed-heats-table tr.is-selected-row .rc-exec-sel-strip");
		if (rows.length === 0 || strips.length !== rows.length || !selStrip) return { ok: false, rowCount: rows.length, stripCount: strips.length };
		const selBg = getComputedStyle(selStrip).backgroundColor;
		const r = selStrip.getBoundingClientRect();
		return {
			ok: r.width >= 3 && r.height >= 16 && selBg === "rgb(212, 255, 58)",
			selBg,
			w: r.width,
			h: r.height,
		};
	}`)
	if err != nil {
		t.Fatalf("evaluate Review vertical selection strip: %v", err)
	}
	if rsMap, _ := revStripCheck.(map[string]interface{}); rsMap["ok"] != true {
		t.Fatalf("expected neon green vertical selection strip before Executed column on selected Review row: %+v", rsMap)
	}
	h.MilestoneScreenshot("desktop-review-neon-selection-strip")

	// 3. Resize to mobile (390x844) and verify swipeable ribbon navigation across Marshal, Schedule, Pilots, and Configure!
	if err := h.Page.SetViewportSize(390, 844); err != nil {
		t.Fatalf("SetViewportSize(390, 844): %v", err)
	}
	h.MustBeVisible(h.Page.Locator(`[data-canvas-panel="review_heat"]`).First(), "Heat Review visible on mobile Review")

	if err := h.Page.Locator(`button[data-mobile-ctrl-nav="live"]`).First().Click(); err != nil {
		t.Fatalf("switch to Marshal tab on mobile: %v", err)
	}
	h.MustBeVisible(cockpit, "Cockpit stays visible at top of mobile Marshal")
	h.MustBeVisible(h.Page.Locator(`[data-canvas-panel="heatline"]`).First(), "Flight Line visible on mobile Marshal")
	h.MustBeHidden(schedule, "Schedule hidden while Marshal tab is active on mobile")
	if err := h.Page.Locator(`button[data-mobile-ctrl-nav="schedule"]`).First().Click(); err != nil {
		t.Fatalf("click mobile Schedule tab: %v", err)
	}
	h.MustBeVisible(schedule, "Schedule visible after clicking mobile Schedule tab")
	h.MilestoneScreenshot("control-mobile-responsive-page")
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

	// Verify Marshal header button says "End Race" (not "Close Stage").
	endRaceBtn := h.Page.Locator(`[data-canvas-panel="cockpit"] button[data-race-act="close-stage-modal"]`).First()
	h.MustBeVisible(endRaceBtn, "End Race button in Marshal header")
	h.MustContainText(endRaceBtn, "End Race")

	// Switch to Standings tab and verify "Export to MultiGP" and "Export as CSV" sit at bottom-left outside .rc-standings-card-box without icons.
	standingsTabBtn := h.Page.Locator(`.rc-topleft-bar button[data-mobile-ctrl-nav="standings"]`).First()
	if err := standingsTabBtn.Click(); err != nil {
		t.Fatalf("click Standings tab: %v", err)
	}
	standingsFooterOK, err := h.Page.Evaluate(`() => {
		const cardBox = document.querySelector('[data-canvas-panel="standings"] .rc-standings-card-box');
		const footer = document.querySelector('[data-canvas-panel="standings"] .rc-standings-footer');
		const mgpBtn = footer ? footer.querySelector('button[data-race-act="mgp-upload-overall"]') : null;
		const csvBtn = footer ? footer.querySelector('button[data-race-act="export-csv"]') : null;
		const headerExportBtns = document.querySelectorAll('[data-canvas-panel="standings"] .rc-panel-header button[data-race-act="mgp-upload-overall"], [data-canvas-panel="standings"] .rc-panel-header button[data-race-act="export-csv"]');
		if (!cardBox || !footer || !mgpBtn || !csvBtn || headerExportBtns.length !== 0) return false;
		const cRect = cardBox.getBoundingClientRect();
		const fRect = footer.getBoundingClientRect();
		return (mgpBtn.textContent || "").trim() === "Export to MultiGP" &&
			(csvBtn.textContent || "").trim() === "Export as CSV" &&
			mgpBtn.querySelectorAll("svg").length === 0 &&
			csvBtn.querySelectorAll("svg").length === 0 &&
			fRect.top >= cRect.bottom - 1 &&
			Math.abs(fRect.left - cRect.left) <= 4;
	}`)
	if err != nil || standingsFooterOK != true {
		t.Fatalf("expected Standings bottom-left Export to MultiGP and Export as CSV buttons outside table card without icons: err=%v ok=%v", err, standingsFooterOK)
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
	if forceAllCnt, _ := syncModal.Locator(`[data-mgp-force-all]`).Count(); forceAllCnt != 0 {
		t.Fatalf("expected 0 [data-mgp-force-all] checkboxes in MultiGPSyncModal, got %d", forceAllCnt)
	}
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

func TestComponent_MobileRibbonPilotsAndPagedRoundEditor(t *testing.T) {
	h := NewHarness(t)
	if err := h.Page.SetViewportSize(390, 844); err != nil {
		t.Fatalf("SetViewportSize(390, 844): %v", err)
	}
	h.BootClean("#/races")

	// 1. Create a new race on mobile and tap its mosaic card to open Configure (MobileRaceEditor).
	addBtn := h.Page.Locator(`button[data-race-act="create-race-inline"]`).First()
	h.MustBeVisible(addBtn, "Mobile Add Race button")
	if err := addBtn.Click(); err != nil {
		t.Fatalf("click Add Race: %v", err)
	}

	mobileCard := h.Page.Locator(`.dir-mobile-chip[data-race-act="open-race-format"]`).First()
	h.MustBeVisible(mobileCard, "Mobile race card in mosaic")
	// Verify top-left mobile brand logo + "SlapRF" is visible on top-level mobile pages!
	h.MustBeVisible(h.Page.Locator(`[data-topbar-mobile-brand]`).First(), "Mobile top-level SlapRF brand logo in topbar")
	h.MustContainText(h.Page.Locator(`[data-topbar-mobile-brand]`).First(), "SlapRF")
	if err := mobileCard.Click(); err != nil {
		t.Fatalf("click mobile race card: %v", err)
	}

	// Verify Mobile Configure page mounts MobileRaceEditor (zero desktop .races-canvas!).
	h.MustBeVisible(h.Page.Locator(`[data-rc-page="configure"] [data-mre-root]`).First(), "Mobile Paged Round Editor mounted")
	// Once inside a subpage, [data-topbar-mobile-brand] must NOT be present!
	if brandCnt, _ := h.Page.Locator(`[data-topbar-mobile-brand]`).Count(); brandCnt != 0 {
		t.Fatalf("expected 0 [data-topbar-mobile-brand] inside mobile subpage, got %d", brandCnt)
	}
	if cnt, _ := h.Page.Locator(`.races-canvas`).Count(); cnt != 0 {
		t.Fatalf("expected 0 .races-canvas on mobile Configure, got %d", cnt)
	}

	// 2. Tap Pilots tab in the swipeable ribbon and add a walk-up pilot.
	pilotsTabBtn := h.Page.Locator(`.rc-topleft-bar button[data-race-tab="pilots"]`).First()
	h.MustBeVisible(pilotsTabBtn, "Mobile ribbon Pilots tab")
	if err := pilotsTabBtn.Click(); err != nil {
		t.Fatalf("click Pilots tab: %v", err)
	}
	h.MustBeVisible(h.Page.Locator(`[data-rc-page="pilots"] [data-canvas-panel="pilots"]`).First(), "Mobile Pilots roster page")

	pilotInp := h.Page.Locator(`[data-rc-page="pilots"] input[data-race-field="pilots-search"]`).First()
	if err := pilotInp.Fill("Maverick"); err != nil {
		t.Fatalf("fill walk-up pilot: %v", err)
	}
	if err := h.Page.Locator(`[data-rc-page="pilots"] button[data-race-act="submit-panel-walkup"]`).First().Click(); err != nil {
		t.Fatalf("submit walk-up pilot: %v", err)
	}
	h.MustContainText(h.Page.Locator(`[data-rc-page="pilots"] [data-rc-pilots-results]`).First(), "Maverick")
	h.MilestoneScreenshot("mobile-pilots-tab-walkup")

	// 3. Switch back to Configure, apply Qualifying + Ladder Mains template, and step across round pages!
	cfgTabBtn := h.Page.Locator(`.rc-topleft-bar button[data-race-tab="edit"]`).First()
	if err := cfgTabBtn.Click(); err != nil {
		t.Fatalf("click Configure tab: %v", err)
	}
	openTplBtn := h.Page.Locator(`[data-mre-open-templates]`).First()
	h.MustBeVisible(openTplBtn, "Mobile Choose Race Template button")
	h.MustContainText(h.Page.Locator(`[data-mre-race-status]`).First(), "New")
	if err := openTplBtn.Click(); err != nil {
		t.Fatalf("click Choose Race Template: %v", err)
	}
	modal := h.Page.Locator(`.slaprf-modal-backdrop`).First()
	h.MustBeVisible(modal, "Choose Race Format modal on mobile")
	ladderOpt := modal.Locator(`button[data-modal-pick-tpl="qual_ladder_mains"]`).First()
	h.MustBeVisible(ladderOpt, "Qualifying + Ladder Mains template option")
	if err := ladderOpt.Click(); err != nil {
		t.Fatalf("click qual_ladder_mains: %v", err)
	}
	if err := modal.Locator(`button[data-tpl-confirm]`).Click(); err != nil {
		t.Fatalf("confirm qual_ladder_mains: %v", err)
	}
	h.MustBeHidden(modal, "Templates modal closed")

	h.WaitUntil("Multiple round pages rendered in MobileRaceEditor carousel", 5*time.Second, func() (bool, error) {
		cnt, err := h.Page.Locator(`[data-mre-carousel] [data-mre-round-page]`).Count()
		return err == nil && cnt >= 4, nil
	})
	h.MustContainText(h.Page.Locator(`[data-mre-race-status]`).First(), "Setup")

	// Verify touch-action: pan-x pan-y, left/right chevron scroll cues on round pills, and NO trailing + button while Finals (A-Main) exists!
	rightRoundCue := h.Page.Locator(`.mre-stepper-scroll-wrap > .sched-lineup-cue.is-right`).First()
	leftRoundCue := h.Page.Locator(`.mre-stepper-scroll-wrap > .sched-lineup-cue.is-left`).First()
	h.MustBeVisible(rightRoundCue, "Right chevron scroll indicator on round pills")
	h.MustBeHidden(leftRoundCue, "Left chevron scroll indicator hidden at scrollLeft=0")
	stepperInit, err := h.Page.Evaluate(`() => {
		const pills = document.querySelector(".mre-stepper-pills");
		const addBtn = document.querySelector(".mre-stepper-add-slot .is-add-pill");
		const row = document.querySelector(".mre-stepper-row");
		if (!pills || !row) return { ok: false };
		const ta = getComputedStyle(pills).touchAction;
		return { ok: ta.includes("pan-x") && addBtn === null, ta, hasAddBtn: addBtn !== null };
	}`)
	if err != nil {
		t.Fatalf("evaluate stepper init geometry: %v", err)
	}
	initMap, _ := stepperInit.(map[string]interface{})
	if initMap["ok"] != true {
		t.Fatalf("expected pan-x enabled on .mre-stepper-pills and no + button while Finals exists: %+v", initMap)
	}
	if err := rightRoundCue.Click(); err != nil {
		t.Fatalf("click right round scroll chevron: %v", err)
	}
	h.WaitUntil("Round pills scrolled right and left chevron shown", 3*time.Second, func() (bool, error) {
		res, err := h.Page.Evaluate(`() => {
			const pills = document.querySelector(".mre-stepper-pills");
			const leftCue = document.querySelector(".mre-stepper-scroll-wrap > .sched-lineup-cue.is-left");
			if (!pills || !leftCue) return false;
			return pills.scrollLeft > 40 && !leftCue.hidden;
		}`)
		if err != nil {
			return false, nil
		}
		ok, _ := res.(bool)
		return ok, nil
	})
	if _, err := h.Page.Evaluate(`document.querySelector(".mre-stepper-pills").scrollLeft = 0`); err != nil {
		t.Fatalf("reset round pills scrollLeft to 0: %v", err)
	}

	// Verify holding a partial swipe (scrollLeft = 110px while pointerdown is held for > 250ms)
	// keeps BOTH the current round AND the incoming round visible without disappearing!
	if _, err := h.Page.Evaluate(`() => {
		const c = document.querySelector("[data-mre-carousel]");
		if (c) {
			c.style.scrollSnapType = "none";
			c.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
			c.scrollLeft = 110;
		}
	}`); err != nil {
		t.Fatalf("simulate held partial swipe: %v", err)
	}
	time.Sleep(280 * time.Millisecond) // > old 150ms timer that previously collapsed incoming round!
	heldCheck, err := h.Page.Evaluate(`() => {
		const c = document.querySelector("[data-mre-carousel]");
		const pages = c ? Array.from(c.querySelectorAll("[data-mre-round-page]")) : [];
		const h0 = pages[0] ? pages[0].offsetHeight : 0;
		const h1 = pages[1] ? pages[1].offsetHeight : 0;
		const inView1 = pages[1] ? pages[1].classList.contains("is-in-view") : false;
		const swiping = c ? c.classList.contains("is-swiping") : false;
		if (c) {
			c.scrollLeft = 0;
			c.style.scrollSnapType = "";
			window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
		}
		return { ok: h0 > 200 && h1 > 200 && inView1 && swiping, h0, h1, inView1, swiping };
	}`)
	if err != nil {
		t.Fatalf("evaluate held partial swipe: %v", err)
	}
	if heldMap, _ := heldCheck.(map[string]interface{}); heldMap["ok"] != true {
		t.Fatalf("expected incoming round to stay visible throughout held partial swipe: %+v", heldMap)
	}
	time.Sleep(180 * time.Millisecond)

	// Verify two-mode vertical scrolling on Round 1 (Qualifying R1 with 3 heats):
	// Mode 1 -> scrolling down tucks the Pilots/Marshal ribbon (.races-page-topbar) behind .topbar,
	// Mode 2 -> continuing to scroll keeps the round switcher (.mre-top-strip) pinned right under .topbar
	// while IN/OUT and heats scroll behind it.
	if _, err := h.Page.Evaluate(`window.scrollTo(0, 260)`); err != nil {
		t.Fatalf("scroll window down on Setup: %v", err)
	}
	h.WaitUntil("Ribbon tucked away while round switcher stays sticky at top", 3*time.Second, func() (bool, error) {
		res, err := h.Page.Evaluate(`() => {
			const topbar = document.querySelector(".topbar");
			const ribbon = document.querySelector(".races-page-topbar");
			const slider = document.querySelector(".mre-top-strip");
			if (!topbar || !ribbon || !slider) return false;
			const topbarBottom = topbar.getBoundingClientRect().bottom;
			const ribbonBottom = ribbon.getBoundingClientRect().bottom;
			const sliderTop = slider.getBoundingClientRect().top;
			return (
				window.scrollY >= 200 &&
				ribbonBottom <= topbarBottom + 1 &&
				Math.abs(sliderTop - topbarBottom) <= 2 &&
				slider.classList.contains("is-stuck")
			);
		}`)
		if err != nil {
			return false, nil
		}
		ok, _ := res.(bool)
		return ok, nil
	})
	time.Sleep(180 * time.Millisecond)
	h.MilestoneScreenshot("mobile-setup-two-mode-sticky-round-strip")

	// Install a MutationObserver on .mre-top-strip while docked to guarantee .is-stuck NEVER flickers
	// off (even for 1 microtask) when switching between tall and 1-heat rounds!
	if _, err := h.Page.Evaluate(`() => {
		window.__mreUnstuckFlips = 0;
		const strip = document.querySelector(".mre-top-strip");
		if (strip) {
			window.__mreObs = new MutationObserver(() => {
				if (!strip.classList.contains("is-stuck")) {
					window.__mreUnstuckFlips++;
				}
			});
			window.__mreObs.observe(strip, { attributes: true, attributeFilter: ["class"] });
		}
	}`); err != nil {
		t.Fatalf("install MutationObserver on .mre-top-strip: %v", err)
	}

	// While scrolled past the ribbon, tap the last non-add round pill (1-heat A-Main) and verify:
	// 1. A-Main becomes active with Seed #1 and B-Main bump-up placeholders,
	// 2. Scroll does NOT jarringly reset to 0 (the Pilots/Marshal ribbon remains tucked away and the round switcher stays docked!).
	stepPills := h.Page.Locator(`[data-mre-stepper] button[data-mre-step]:not(.is-add-pill)`)
	pillCnt, _ := stepPills.Count()
	if pillCnt < 3 {
		t.Fatalf("expected >= 3 round pills for qual_ladder_mains, got %d", pillCnt)
	}
	if err := stepPills.Nth(pillCnt - 1).Click(); err != nil {
		t.Fatalf("click A-Main stepper pill while ribbon hidden: %v", err)
	}
	h.WaitUntil("A-Main page active while ribbon remains tucked away", 5*time.Second, func() (bool, error) {
		aMainPage := h.Page.Locator(`[data-mre-carousel] [data-mre-round-page]`).Nth(pillCnt - 1)
		txt, err := aMainPage.InnerText()
		if err != nil || !strings.Contains(txt, "Seed #1") || !strings.Contains(txt, "B-Main") {
			return false, nil
		}
		res, err := h.Page.Evaluate(`() => {
			const topbar = document.querySelector(".topbar");
			const ribbon = document.querySelector(".races-page-topbar");
			const slider = document.querySelector(".mre-top-strip");
			const carousel = document.querySelector("[data-mre-carousel]");
			if (!topbar || !ribbon || !slider || !carousel) return false;
			if (carousel.classList.contains("is-swiping")) return false;
			const topbarBottom = topbar.getBoundingClientRect().bottom;
			return (
				window.scrollY > 40 &&
				ribbon.getBoundingClientRect().bottom <= topbarBottom + 1 &&
				Math.abs(slider.getBoundingClientRect().top - topbarBottom) <= 2
			);
		}`)
		if err != nil {
			return false, nil
		}
		ok, _ := res.(bool)
		return ok, nil
	})
	flipsRes, err := h.Page.Evaluate(`() => {
		if (window.__mreObs) window.__mreObs.disconnect();
		return window.__mreUnstuckFlips || 0;
	}`)
	if err != nil {
		t.Fatalf("read __mreUnstuckFlips: %v", err)
	}
	if flips, _ := flipsRes.(float64); flips != 0 {
		t.Fatalf("expected 0 .is-stuck direction flips while switching rounds when docked, got %v", flips)
	}
	h.MilestoneScreenshot("mobile-setup-short-round-preserves-docked-scroll")

	// Scroll back up to 0 -> verify the Pilots/Marshal ribbon smoothly returns into view!
	if _, err := h.Page.Evaluate(`window.scrollTo(0, 0)`); err != nil {
		t.Fatalf("scroll window back to top: %v", err)
	}
	h.WaitUntil("Pilots/Marshal ribbon back in view at top", 3*time.Second, func() (bool, error) {
		res, err := h.Page.Evaluate(`() => {
			const topbar = document.querySelector(".topbar");
			const ribbon = document.querySelector(".races-page-topbar");
			const slider = document.querySelector(".mre-top-strip");
			if (!topbar || !ribbon || !slider) return false;
			return (
				window.scrollY === 0 &&
				ribbon.getBoundingClientRect().top >= topbar.getBoundingClientRect().bottom - 1 &&
				!slider.classList.contains("is-stuck")
			);
		}`)
		if err != nil {
			return false, nil
		}
		ok, _ := res.(bool)
		return ok, nil
	})
	time.Sleep(180 * time.Millisecond)
	h.MilestoneScreenshot("mobile-paged-round-editor-ladder-mains")

	// Test double-chevron cue ([data-mre-collapse-cue]) right above the round pills:
	// Tapping it smoothly docks the round switcher to the top; tapping again smoothly expands back to 0!
	collapseCue := h.Page.Locator(`[data-mre-collapse-cue]`).First()
	h.MustBeVisible(collapseCue, "Double-chevron collapse cue above round pills")
	if err := collapseCue.Click(); err != nil {
		t.Fatalf("click collapse cue to dock round bar: %v", err)
	}
	h.WaitUntil("Collapse cue docked round switcher to top", 3*time.Second, func() (bool, error) {
		res, err := h.Page.Evaluate(`() => {
			const slider = document.querySelector(".mre-top-strip");
			return Boolean(slider && slider.classList.contains("is-stuck") && window.scrollY > 40);
		}`)
		if err != nil {
			return false, nil
		}
		ok, _ := res.(bool)
		return ok, nil
	})
	if err := collapseCue.Click(); err != nil {
		t.Fatalf("click collapse cue to expand header back: %v", err)
	}
	h.WaitUntil("Collapse cue scrolled back to top", 3*time.Second, func() (bool, error) {
		res, err := h.Page.Evaluate(`() => {
			const slider = document.querySelector(".mre-top-strip");
			return Boolean(slider && !slider.classList.contains("is-stuck") && window.scrollY <= 2);
		}`)
		if err != nil {
			return false, nil
		}
		ok, _ := res.(bool)
		return ok, nil
	})

	// Test Mobile Race Settings bottom-sheet drawer ([data-mre-open-defaults]):
	// Must be a bottom sheet (NOT desktop modal), NO tag suggestions, fits without scrolling, Cancel + Save visible!
	if err := h.Page.Locator(`[data-mre-open-defaults]`).First().Click(); err != nil {
		t.Fatalf("click mobile Race Settings sliders button: %v", err)
	}
	raceSheet := h.Page.Locator(`.mre-sheet-overlay`).First()
	h.MustBeVisible(raceSheet, "Mobile Race Settings bottom-sheet drawer")
	if modalCnt, _ := h.Page.Locator(`.slaprf-modal-backdrop`).Count(); modalCnt != 0 {
		t.Fatalf("expected 0 desktop modals when opening mobile Race Settings, got %d", modalCnt)
	}
	if sugCnt, _ := raceSheet.Locator(`[data-modal-tags-suggestions], [data-modal-suggest-tag]`).Count(); sugCnt != 0 {
		t.Fatalf("expected 0 tag suggestions in mobile Race Settings drawer, got %d", sugCnt)
	}
	time.Sleep(240 * time.Millisecond) // allow slide-up animation to settle before measuring bounds
	h.MilestoneScreenshot("mobile-race-settings-compact-drawer")
	h.MustContainText(raceSheet.Locator(`[data-sheet-seat-grid]`), "R1")
	h.MustContainText(raceSheet.Locator(`[data-sheet-seat-grid]`), "R3")
	h.MustContainText(raceSheet.Locator(`[data-sheet-seat-grid]`), "R5")
	h.MustContainText(raceSheet.Locator(`[data-sheet-seat-grid]`), "R8")
	fitRace, err := h.Page.Evaluate(`() => {
		const sheet = document.querySelector(".mre-sheet-overlay .mre-bottom-sheet");
		const body = document.querySelector(".mre-sheet-overlay .mre-sheet-body");
		const saveBtn = document.querySelector(".mre-sheet-overlay [data-sheet-save-race]");
		const cancelBtn = document.querySelector(".mre-sheet-overlay .mre-sheet-foot [data-mre-sheet-close]");
		if (!sheet || !body || !saveBtn || !cancelBtn) return { ok: false, reason: "missing elements" };
		const sRect = saveBtn.getBoundingClientRect();
		const cRect = cancelBtn.getBoundingClientRect();
		const noScroll = body.scrollHeight <= body.clientHeight + 2;
		const visible = sRect.bottom <= window.innerHeight && cRect.bottom <= window.innerHeight && sRect.top >= 0;
		return { ok: noScroll && visible, scrollH: body.scrollHeight, clientH: body.clientHeight, saveBottom: sRect.bottom, vh: window.innerHeight };
	}`)
	if err != nil {
		t.Fatalf("evaluate Race Settings drawer fit: %v", err)
	}
	if fitMap, _ := fitRace.(map[string]interface{}); fitMap["ok"] != true {
		t.Fatalf("expected mobile Race Settings drawer to fit on screen without scrolling and show Save/Cancel: %+v", fitMap)
	}
	// Dismiss Race Settings and verify .is-closing smooth slide-down animation occurs before removal!
	if err := raceSheet.Locator(`.mre-sheet-foot [data-mre-sheet-close]`).Click(); err != nil {
		t.Fatalf("cancel mobile Race Settings drawer: %v", err)
	}
	h.WaitUntil("Race Settings drawer enters .is-closing slide-down state", 1*time.Second, func() (bool, error) {
		cnt, err := h.Page.Locator(`.mre-sheet-overlay.is-closing`).Count()
		return err == nil && cnt == 1, nil
	})
	h.MustBeHidden(raceSheet, "Mobile Race Settings drawer removed after slide-down")

	// Switch back to Round 1 (Qualifying R1), verify compact "Q1" title, test Mobile Edit Round drawer ([data-mre-round-settings]) AND Add Another Output slide-down!
	if err := stepPills.Nth(0).Click(); err != nil {
		t.Fatalf("click Round 1 pill: %v", err)
	}
	time.Sleep(300 * time.Millisecond)
	q1Title, err := h.Page.Locator(`[data-mre-round-page].is-active-page .mre-round-title`).First().InnerText()
	if err != nil || strings.TrimSpace(q1Title) != "Q1" {
		t.Fatalf("expected mobile round header title to be compact 'Q1', got %q (err=%v)", q1Title, err)
	}
	roundSettingsBtn := h.Page.Locator(`[data-mre-round-page].is-active-page [data-mre-round-settings]`).First()
	h.MustBeVisible(roundSettingsBtn, "Mobile Round Settings button")
	if err := roundSettingsBtn.Click(); err != nil {
		t.Fatalf("click mobile Round Settings button: %v", err)
	}
	roundSheet := h.Page.Locator(`.mre-sheet-overlay`).First()
	h.MustBeVisible(roundSheet, "Mobile Edit Round bottom-sheet drawer")
	if modalCnt, _ := h.Page.Locator(`.slaprf-modal-backdrop`).Count(); modalCnt != 0 {
		t.Fatalf("expected 0 desktop modals when opening mobile Edit Round, got %d", modalCnt)
	}
	sheetTitleVal, err := roundSheet.Locator(`[data-sheet-round-title]`).InputValue()
	if err != nil || strings.TrimSpace(sheetTitleVal) != "Q1" {
		t.Fatalf("expected Edit Round input to show compact 'Q1', got %q (err=%v)", sheetTitleVal, err)
	}
	time.Sleep(240 * time.Millisecond)
	h.MilestoneScreenshot("mobile-edit-round-compact-drawer")
	fitRound, err := h.Page.Evaluate(`() => {
		const body = document.querySelector(".mre-sheet-overlay .mre-sheet-body");
		const saveBtn = document.querySelector(".mre-sheet-overlay [data-sheet-save-round]");
		const cancelBtn = document.querySelector(".mre-sheet-overlay .mre-sheet-foot [data-mre-sheet-close]");
		if (!body || !saveBtn || !cancelBtn) return { ok: false, reason: "missing elements" };
		const sRect = saveBtn.getBoundingClientRect();
		const cRect = cancelBtn.getBoundingClientRect();
		const noScroll = body.scrollHeight <= body.clientHeight + 2;
		const visible = sRect.bottom <= window.innerHeight && cRect.bottom <= window.innerHeight && sRect.top >= 0;
		return { ok: noScroll && visible, scrollH: body.scrollHeight, clientH: body.clientHeight, saveBottom: sRect.bottom, vh: window.innerHeight };
	}`)
	if err != nil {
		t.Fatalf("evaluate Edit Round drawer fit: %v", err)
	}
	if fitMap, _ := fitRound.(map[string]interface{}); fitMap["ok"] != true {
		t.Fatalf("expected mobile Edit Round drawer to fit on screen without scrolling and show Save/Cancel: %+v", fitMap)
	}
	if err := roundSheet.Locator(`[data-sheet-save-round]`).Click(); err != nil {
		t.Fatalf("save mobile Edit Round drawer: %v", err)
	}
	h.MustBeHidden(roundSheet, "Mobile Edit Round drawer closed after Save")

	// Open Add Another Output ([data-mre-connect-out]) on Q1 -> connect to Existing: A-Main (Finals)
	// to trigger the Finals capacity warning pill (.mre-io-invalid-note), and also verify smooth slide-down dismiss!
	connectOutBtn := h.Page.Locator(`[data-mre-round-page].is-active-page [data-mre-connect-out]`).First()
	h.MustBeVisible(connectOutBtn, "Add Another Output button")
	if err := connectOutBtn.Click(); err != nil {
		t.Fatalf("click Add Another Output: %v", err)
	}
	outSheet := h.Page.Locator(`.mre-sheet-overlay`).First()
	h.MustBeVisible(outSheet, "Add Another Output bottom-sheet drawer")
	time.Sleep(220 * time.Millisecond)
	if _, err := h.Page.Evaluate(`() => {
		const sel = document.querySelector(".mre-sheet-overlay [data-sheet-target-round]");
		if (sel) {
			const finOpt = Array.from(sel.options).find((o) => /A-Main/i.test(o.textContent || ""));
			if (finOpt) {
				sel.value = finOpt.value;
				sel.dispatchEvent(new Event("change", { bubbles: true }));
			}
		}
	}`); err != nil {
		t.Fatalf("select A-Main in Add Another Output: %v", err)
	}
	if err := outSheet.Locator(`[data-sheet-connect-save]`).Click(); err != nil {
		t.Fatalf("save Add Another Output to A-Main: %v", err)
	}
	h.WaitUntil("Add Another Output drawer enters .is-closing slide-down state", 2*time.Second, func() (bool, error) {
		cnt, err := h.Page.Locator(`.mre-sheet-overlay.is-closing`).Count()
		return err == nil && cnt == 1, nil
	})
	h.MustBeHidden(outSheet, "Add Another Output drawer removed after smooth slide-down")

	invNote := h.Page.Locator(`[data-mre-round-page].is-active-page .mre-io-invalid-note`).First()
	h.MustBeVisible(invNote, "Subtle amber warning box without icon on invalid Q1 -> A-Main connection")
	invCheck, err := h.Page.Evaluate(`() => {
		const el = document.querySelector("[data-mre-round-page].is-active-page .mre-io-invalid-note");
		if (!el) return { ok: false };
		const cs = getComputedStyle(el);
		const bodyColor = getComputedStyle(document.body).color;
		const svgCount = el.querySelectorAll("svg").length;
		const hasAmberBorder = cs.borderColor.includes("245, 158, 11") || cs.borderColor.includes("217, 119, 6");
		const hasAmberBg = cs.backgroundColor.includes("245, 158, 11");
		return {
			ok: cs.display === "block" && svgCount === 0 && hasAmberBorder && hasAmberBg && cs.color === bodyColor,
			display: cs.display,
			svgCount,
			borderColor: cs.borderColor,
			backgroundColor: cs.backgroundColor,
			color: cs.color,
			bodyColor,
		};
	}`)
	if err != nil {
		t.Fatalf("evaluate .mre-io-invalid-note style: %v", err)
	}
	if invMap, _ := invCheck.(map[string]interface{}); invMap["ok"] != true {
		t.Fatalf("expected icon-free subtle amber warning box with readable standard text color, got %+v", invMap)
	}
	h.MilestoneScreenshot("mobile-invalid-finals-connection-pill")

	// Switch to Round 2 (Qualifying R2), assign Pilot #1 (FAERRY, R1 in Q1-1) into Q2-1 Seat 2 (R3)
	// so ChannelChanged triggers, and verify:
	// - Zero legacy ! R1 / .mre-ch-warn tags
	// - Left-right channelSwap icon (.custom-select-swap-ico) right after pilot name
	// - Uppercase readable provenance (.custom-select-sub) on Q1-1
	subCheck, err := h.Page.Evaluate(`() => {
		const sub = document.querySelector("[data-mre-round-page].is-active-page .mre-seat-pilot-select .custom-select-sub");
		if (!sub) return { ok: false };
		const cs = getComputedStyle(sub);
		return { ok: cs.textTransform === "uppercase", textTransform: cs.textTransform, fontSize: cs.fontSize };
	}`)
	if err != nil {
		t.Fatalf("evaluate .custom-select-sub style: %v", err)
	}
	if subMap, _ := subCheck.(map[string]interface{}); subMap["ok"] != true {
		t.Fatalf("expected uppercase .custom-select-sub on mobile pilot select, got %+v", subMap)
	}

	if err := stepPills.Nth(1).Click(); err != nil {
		t.Fatalf("click Round 2 (Q2) pill: %v", err)
	}
	time.Sleep(320 * time.Millisecond)

	// Tap an existing IN/OUT connection row ([data-mre-edit-conn]) and verify it opens a sliding bottom-sheet drawer (NOT a modal)!
	editConnBtn := h.Page.Locator(`[data-mre-round-page].is-active-page [data-mre-edit-conn]`).Last()
	h.MustBeVisible(editConnBtn, "Mobile Edit Connection button")
	if err := editConnBtn.Click(); err != nil {
		t.Fatalf("click mobile Edit Connection button: %v", err)
	}
	connSheet := h.Page.Locator(`.mre-sheet-overlay`).First()
	h.MustBeVisible(connSheet, "Mobile Edit Connection bottom-sheet drawer")
	if modalCnt, _ := h.Page.Locator(`.slaprf-modal-backdrop`).Count(); modalCnt != 0 {
		t.Fatalf("expected 0 desktop modals when clicking mobile IN/OUT connection, got %d", modalCnt)
	}
	time.Sleep(240 * time.Millisecond)
	h.MilestoneScreenshot("mobile-edit-connection-compact-drawer")
	fitConn, err := h.Page.Evaluate(`() => {
		const body = document.querySelector(".mre-sheet-overlay .mre-sheet-body");
		const saveBtn = document.querySelector(".mre-sheet-overlay [data-sheet-wconn-save]");
		const cancelBtn = document.querySelector(".mre-sheet-overlay .mre-sheet-foot [data-mre-sheet-close]");
		if (!body || !saveBtn || !cancelBtn) return { ok: false, reason: "missing elements" };
		const sRect = saveBtn.getBoundingClientRect();
		const cRect = cancelBtn.getBoundingClientRect();
		const noScroll = body.scrollHeight <= body.clientHeight + 2;
		const visible = sRect.bottom <= window.innerHeight && cRect.bottom <= window.innerHeight && sRect.top >= 0;
		return { ok: noScroll && visible, scrollH: body.scrollHeight, clientH: body.clientHeight, saveBottom: sRect.bottom, vh: window.innerHeight };
	}`)
	if err != nil {
		t.Fatalf("evaluate Edit Connection drawer fit: %v", err)
	}
	if fitMap, _ := fitConn.(map[string]interface{}); fitMap["ok"] != true {
		t.Fatalf("expected mobile Edit Connection drawer to fit without scrolling and show Save/Cancel: %+v", fitMap)
	}
	if err := connSheet.Locator(`.mre-sheet-foot [data-mre-sheet-close]`).Click(); err != nil {
		t.Fatalf("cancel mobile Edit Connection drawer: %v", err)
	}
	h.WaitUntil("Edit Connection drawer enters .is-closing slide-down state", 1*time.Second, func() (bool, error) {
		cnt, err := h.Page.Locator(`.mre-sheet-overlay.is-closing`).Count()
		return err == nil && cnt == 1, nil
	})
	h.MustBeHidden(connSheet, "Edit Connection drawer removed after smooth slide-down")
	if _, err := h.Page.Evaluate(`() => {
		const sel = document.querySelector('[data-mre-round-page].is-active-page select[data-mre-seat-pilot][data-seat-idx="2"]');
		if (sel) {
			sel.value = "1";
			sel.dispatchEvent(new Event("change", { bubbles: true }));
		}
	}`); err != nil {
		t.Fatalf("assign pilot #1 into Q2-1 seat 2 (R3): %v", err)
	}
	h.WaitUntil("Channel swap icon rendered inside Q2 pilot select trigger", 3*time.Second, func() (bool, error) {
		cnt, err := h.Page.Locator(`[data-mre-round-page].is-active-page .mre-seat-pilot-select .custom-select-swap-ico`).Count()
		return err == nil && cnt >= 1, nil
	})
	if warnCnt, _ := h.Page.Locator(`.mre-ch-warn`).Count(); warnCnt != 0 {
		t.Fatalf("expected 0 legacy .mre-ch-warn tags, got %d", warnCnt)
	}
	_, _ = h.Page.Evaluate(`document.querySelector("[data-mre-round-page].is-active-page .mre-heat-card")?.scrollIntoView({ block: "center" })`)
	time.Sleep(150 * time.Millisecond)
	h.MilestoneScreenshot("mobile-q2-swap-icon-and-uppercase-prov")

	// While A-Main (Finals) exists, there must be NO trailing + Add Round pill after Finals!
	if addPillCnt, _ := h.Page.Locator(`[data-mre-stepper] button[data-mre-step="__add__"]`).Count(); addPillCnt != 0 {
		t.Fatalf("expected 0 + Add Round pills while Finals (A-Main) exists, got %d", addPillCnt)
	}

	// Verify nearest-neighbor selection on round deletion:
	// 1. Delete round at END (A-Main) -> selects round to the left (B-Main) AND reveals the + Add Round pill!
	deleteActiveRoundAndConfirm := func() {
		delBtn := h.Page.Locator(`[data-mre-round-page].is-active-page [data-mre-delete-round]`).First()
		h.MustBeVisible(delBtn, "Delete Round button on active mobile page")
		if err := delBtn.Click(); err != nil {
			t.Fatalf("click Delete Round: %v", err)
		}
		confirmBtn := h.Page.Locator(`.slaprf-modal-backdrop [data-modal-confirm]`).First()
		time.Sleep(100 * time.Millisecond)
		if vis, _ := confirmBtn.IsVisible(); vis {
			if err := confirmBtn.Click(); err != nil {
				t.Fatalf("confirm Delete Round: %v", err)
			}
		}
	}

	if err := h.Page.Locator(`[data-mre-stepper] button[data-mre-step][title="A-Main"]`).Click(); err != nil {
		t.Fatalf("select A-Main (end of list): %v", err)
	}
	time.Sleep(250 * time.Millisecond)
	deleteActiveRoundAndConfirm()
	h.WaitUntil("Deleting end round (A-Main) selects left neighbor (B-Main)", 3*time.Second, func() (bool, error) {
		title, err := h.Page.Locator(`[data-mre-round-page].is-active-page .mre-round-title`).First().InnerText()
		return err == nil && strings.TrimSpace(title) == "B-Main", nil
	})

	// Now that Finals (A-Main) has been deleted, the + Add Round pill is visible! Tap it and verify the custom non-neon checkbox on the Add Round page!
	if err := h.Page.Locator(`[data-mre-stepper] button[data-mre-step="__add__"]`).Click(); err != nil {
		t.Fatalf("click + Add Round pill after Finals deleted: %v", err)
	}
	time.Sleep(350 * time.Millisecond)
	h.MilestoneScreenshot("mobile-add-round-page-custom-checkbox")

	// 2. Delete round in MIDDLE (D-Main) -> selects previous round before it (E-Main)
	if err := h.Page.Locator(`[data-mre-stepper] button[data-mre-step][title="D-Main"]`).Click(); err != nil {
		t.Fatalf("select D-Main (middle of list): %v", err)
	}
	time.Sleep(250 * time.Millisecond)
	deleteActiveRoundAndConfirm()
	h.WaitUntil("Deleting middle round (D-Main) selects previous round (E-Main)", 3*time.Second, func() (bool, error) {
		title, err := h.Page.Locator(`[data-mre-round-page].is-active-page .mre-round-title`).First().InnerText()
		return err == nil && strings.TrimSpace(title) == "E-Main", nil
	})

	// 3. Delete round at BEGINNING (Qualifying R1) -> selects closest round to the right (Qualifying R2 -> compact "Q2")
	if err := h.Page.Locator(`[data-mre-stepper] button[data-mre-step][title="Qualifying R1"]`).Click(); err != nil {
		t.Fatalf("select Qualifying R1 (beginning of list): %v", err)
	}
	time.Sleep(250 * time.Millisecond)
	deleteActiveRoundAndConfirm()
	h.WaitUntil("Deleting first round (Qualifying R1) selects right neighbor (Q2)", 3*time.Second, func() (bool, error) {
		title, err := h.Page.Locator(`[data-mre-round-page].is-active-page .mre-round-title`).First().InnerText()
		return err == nil && strings.TrimSpace(title) == "Q2", nil
	})

	// 4. Verify custom user-edited round name overrides compact auto-code cleanly!
	if err := h.Page.Locator(`[data-mre-round-page].is-active-page [data-mre-round-settings]`).First().Click(); err != nil {
		t.Fatalf("open Edit Round on Q2: %v", err)
	}
	renameSheet := h.Page.Locator(`.mre-sheet-overlay`).First()
	h.MustBeVisible(renameSheet, "Edit Round drawer on Q2")
	if err := renameSheet.Locator(`[data-sheet-round-title]`).Fill("Super Qual"); err != nil {
		t.Fatalf("fill custom Round Name 'Super Qual': %v", err)
	}
	if err := renameSheet.Locator(`[data-sheet-save-round]`).Click(); err != nil {
		t.Fatalf("save custom Round Name: %v", err)
	}
	h.WaitUntil("Custom user-edited round name 'Super Qual' displayed on mobile header", 3*time.Second, func() (bool, error) {
		title, err := h.Page.Locator(`[data-mre-round-page].is-active-page .mre-round-title`).First().InnerText()
		return err == nil && strings.TrimSpace(title) == "Super Qual", nil
	})

	// 5. Scroll to top and preview Confirmed / Review / Paused status pills for vertical alignment check!
	_, _ = h.Page.Evaluate(`() => {
		window.scrollTo(0, 0);
		const headLeft = document.querySelector("[data-mre-round-page].is-active-page .mre-heat-head-left");
		if (headLeft) {
			const rev = document.createElement("span");
			rev.className = "race-state-pill is-review";
			rev.textContent = "Review";
			const conf = document.createElement("span");
			conf.className = "race-state-pill is-done";
			conf.textContent = "Confirmed";
			headLeft.appendChild(rev);
			headLeft.appendChild(conf);
		}
		const raceStatus = document.querySelector("[data-mre-race-status]");
		if (raceStatus) {
			raceStatus.className = "race-state-pill is-paused";
			raceStatus.textContent = "Paused";
		}
	}`)
	time.Sleep(180 * time.Millisecond)
	h.MilestoneScreenshot("mobile-race-status-and-heat-pill-alignment")

	// 6. Apply Double Elimination (so Heat 1 has "Horn start · Top 2 advance"), open Marshal on mobile,
	// start the race, and verify countdown subtitle never says "Countdown ... Random horn" and "Top 2 advance" stays on 1 line!
	if err := h.Page.Locator(`[data-mre-open-templates]`).First().Click(); err != nil {
		t.Fatalf("open templates for double_elimination: %v", err)
	}
	deModal := h.Page.Locator(`.slaprf-modal-backdrop`).First()
	h.MustBeVisible(deModal, "Templates modal for double_elimination")
	if err := deModal.Locator(`button[data-modal-pick-tpl="double_elimination"]`).Click(); err != nil {
		t.Fatalf("pick double_elimination: %v", err)
	}
	if err := deModal.Locator(`button[data-tpl-confirm]`).Click(); err != nil {
		t.Fatalf("confirm double_elimination: %v", err)
	}
	time.Sleep(150 * time.Millisecond)
	if replaceBtn := h.Page.Locator(`.slaprf-modal-backdrop [data-modal-confirm]`).First(); true {
		if vis, _ := replaceBtn.IsVisible(); vis {
			if err := replaceBtn.Click(); err != nil {
				t.Fatalf("confirm replace rounds with double_elimination: %v", err)
			}
		}
	}
	h.MustBeHidden(deModal, "Templates modal closed after double_elimination")

	if err := h.Page.Locator(`.rc-topleft-bar button[data-mobile-ctrl-nav="live"]`).First().Click(); err != nil {
		t.Fatalf("switch to Marshal tab on mobile: %v", err)
	}
	startHeatBtn := h.Page.Locator(`[data-ctrl="start"]`).First()
	h.MustBeVisible(startHeatBtn, "Start Heat button on mobile Marshal")
	if err := startHeatBtn.Click(); err != nil {
		t.Fatalf("click Start Heat on mobile Marshal: %v", err)
	}
	time.Sleep(150 * time.Millisecond)
	if preemptBtn := h.Page.Locator(`.slaprf-modal-backdrop button.btn-armed`).First(); true {
		if vis, _ := preemptBtn.IsVisible(); vis {
			if err := preemptBtn.Click(); err != nil {
				t.Fatalf("confirm preempt practice on Start Heat: %v", err)
			}
		}
	}
	h.WaitUntil("Countdown transitions past Arming quads into active countdown with empty subtitle", 8*time.Second, func() (bool, error) {
		res, err := h.Page.Evaluate(`() => {
			const clock = document.querySelector("[data-race-clock]");
			const sub = document.querySelector("[data-race-clock-sub]");
			if (!clock || !sub) return false;
			const subTxt = (sub.textContent || "").trim();
			return clock.classList.contains("is-countdown") && subTxt === "";
		}`)
		if err != nil {
			return false, nil
		}
		ok, _ := res.(bool)
		return ok, nil
	})
	marshalWrapCheck, err := h.Page.Evaluate(`() => {
		const rules = document.querySelector(".race-cockpit-rules");
		const sub = document.querySelector("[data-race-clock-sub]");
		if (!rules || !sub) return { ok: false };
		const rect = rules.getBoundingClientRect();
		const txt = (rules.innerText || "").trim();
		const subTxt = (sub.textContent || "").trim();
		return {
			ok: rect.height <= 20 && txt.includes("Top 2 advance") && !subTxt.toLowerCase().includes("countdown"),
			rulesH: rect.height,
			txt,
			subTxt,
		};
	}`)
	if err != nil {
		t.Fatalf("evaluate mobile Marshal countdown layout: %v", err)
	}
	if mMap, _ := marshalWrapCheck.(map[string]interface{}); mMap["ok"] != true {
		t.Fatalf("expected 'Top 2 advance' to stay on 1 line during mobile countdown with empty subtitle: %+v", mMap)
	}
	h.MilestoneScreenshot("mobile-marshal-countdown-no-wrap")
}

func TestComponent_DesktopSetupGraphAndTableViewSwitcher(t *testing.T) {
	h := NewHarness(t)
	h.BootWithSnapshot(SnapshotRaceActiveControl, "#/races/sunday-qualifier/format", nil)
	if err := h.Page.SetViewportSize(1720, 920); err != nil {
		t.Fatalf("set desktop viewport 1720x920: %v", err)
	}

	// 1. Default on Desktop Setup is Graph view:
	// - Full-width ribbon (.races-page-topbar) runs left-to-right across the entire content section with mobile button styling (36px height, 13px font),
	// - Workspace menu items (Setup, Marshal, Schedule, Standings, Signals, Review) are horizontally centered in the content section,
	// - Full-width race sub-ribbon ([data-dte-race-summary]) sits 16px below .races-page-topbar with [Graph | Table] immediately left of [Sliders].
	switcher := h.Page.Locator(`[data-setup-view-switcher]`).First()
	h.MustBeVisible(switcher, "Desktop Setup Graph/Table view switcher")
	posCheck, err := h.Page.Evaluate(`() => {
		const ribbon = document.querySelector(".races-page-topbar");
		const sub = document.querySelector("[data-dte-race-summary]");
		const tabs = document.querySelector(".rc-topleft-scroll-wrap");
		const setupBtn = document.querySelector('.rc-topleft-bar button[data-race-tab="edit"]');
		const pilotsBtn = document.querySelector('.rc-topleft-bar button[data-race-tab="pilots"]');
		const sw = document.querySelector("[data-setup-view-switcher]");
		const defBtn = document.querySelector("[data-dte-open-defaults]");
		const vp = document.querySelector("[data-rc-viewport]");
		const graphBtn = document.querySelector('[data-setup-view="graph"]');
		if (!ribbon || !sub || !tabs || !setupBtn || !pilotsBtn || !sw || !defBtn || !vp || !graphBtn) return { ok: false };
		const rRect = ribbon.getBoundingClientRect();
		const subRect = sub.getBoundingClientRect();
		const tRect = tabs.getBoundingClientRect();
		const sRect = sw.getBoundingClientRect();
		const defRect = defBtn.getBoundingClientRect();
		const vpRect = vp.getBoundingClientRect();
		const btnRect = setupBtn.getBoundingClientRect();
		const btnCs = getComputedStyle(setupBtn);
		const pilotsCs = getComputedStyle(pilotsBtn);
		const centerDiff = Math.abs((tRect.left + tRect.right) / 2 - (vpRect.left + vpRect.right) / 2);
		return {
			ok:
				graphBtn.classList.contains("is-active") &&
				sw.dataset.activeView === "graph" &&
				sw.closest("[data-dte-race-summary]") === sub &&
				sw.querySelectorAll("svg").length === 0 &&
				graphBtn.textContent.trim() === "Graph" &&
				(sw.querySelector('button[data-setup-view="table"]')?.textContent?.trim() || "") === "Table" &&
				pilotsCs.display !== "none" &&
				Math.abs(btnRect.height - 36) <= 1.5 &&
				btnCs.fontSize === "13px" &&
				Math.abs(rRect.left - vpRect.left) <= 1.5 &&
				Math.abs(rRect.right - vpRect.right) <= 1.5 &&
				Math.abs(subRect.left - vpRect.left) <= 1.5 &&
				Math.abs(subRect.right - vpRect.right) <= 1.5 &&
				Math.abs(subRect.top - rRect.bottom - 16) <= 1.5 &&
				Math.abs(subRect.height - 46) <= 1 &&
				centerDiff <= 2.5 &&
				Math.abs((sRect.top + sRect.height / 2) - (subRect.top + subRect.height / 2)) <= 2 &&
				Math.abs(defRect.left - sRect.right - 6) <= 3,
			rLeft: rRect.left,
			rRight: rRect.right,
			subLeft: subRect.left,
			subRight: subRect.right,
			subTop: subRect.top,
			rBottom: rRect.bottom,
			vpLeft: vpRect.left,
			vpRight: vpRect.right,
			centerDiff,
			btnH: btnRect.height,
			btnFont: btnCs.fontSize,
			pilotsDisplay: pilotsCs.display,
			sTop: sRect.top,
			sRight: sRect.right,
			defLeft: defRect.left,
			svgCount: sw.querySelectorAll("svg").length,
		};
	}`)
	if err != nil {
		t.Fatalf("evaluate Graph/Table switcher placement: %v", err)
	}
	if pMap, _ := posCheck.(map[string]interface{}); pMap["ok"] != true {
		t.Fatalf("expected Graph/Table switcher inside full-width Setup sub-ribbon immediately left of Sliders with Graph active: %+v", pMap)
	}
	h.MilestoneScreenshot("desktop-setup-graph-view-with-switcher")

	// 2. Click Table view -> switches to static multi-column Table view (zero canvas) and persists in localStorage!
	if err := h.Page.Locator(`button[data-setup-view="table"]`).First().Click(); err != nil {
		t.Fatalf("click Table view button: %v", err)
	}
	dteRoot := h.Page.Locator(`[data-dte-root]`).First()
	h.MustBeVisible(dteRoot, "Desktop Race Table Editor root")
	if vpCnt, _ := h.Page.Locator(`[data-rc-viewport]`).Count(); vpCnt != 0 {
		t.Fatalf("expected 0 canvas viewports in Table view, got %d", vpCnt)
	}
	storedMode, err := h.Page.Evaluate(`() => window.localStorage.getItem("slaprf.rc.setupView.v1")`)
	if err != nil || storedMode != "table" {
		t.Fatalf("expected localStorage slaprf.rc.setupView.v1 == 'table', got %v (err=%v)", storedMode, err)
	}

	// 2b. On Qualifying R1 (advance == 0, can grow unboundedly like Open Qualifier), scroll horizontally first (e.g. 120px)
	// and add 4 extra heats (8 heats total) -> verify horizontal scrollLeft does NOT jump or animate away,
	// and verify the column stops cleanly at the bottom aesthetic buffer and scrolls internally!
	if _, err := h.Page.Evaluate(`() => {
		const sc = document.querySelector("[data-dte-scroll]");
		if (sc) sc.scrollLeft = 80;
		window.__dteScrollResetSawZero = false;
	}`); err != nil {
		t.Fatalf("set initial horizontal scroll on Qualifying board: %v", err)
	}
	qualFirstCol := h.Page.Locator(`[data-dte-round-col]`).First()
	for i := 0; i < 4; i++ {
		if err := qualFirstCol.Locator(`[data-dte-add-heat]`).Click(); err != nil {
			t.Fatalf("add heat %d to Qualifying R1 in Table view: %v", i+1, err)
		}
		time.Sleep(80 * time.Millisecond)
	}
	if _, err := h.Page.Evaluate(`() => {
		const sc = document.querySelector("[data-dte-scroll]");
		if (!sc || sc.scrollLeft === 0) window.__dteScrollResetSawZero = true;
		if (sc) sc.scrollLeft = 0;
	}`); err != nil {
		t.Fatalf("check horizontal scroll preservation after add_heat: %v", err)
	}
	sawZero, _ := h.Page.Evaluate(`() => Boolean(window.__dteScrollResetSawZero)`)
	if sawZero == true {
		t.Fatalf("expected horizontal .dte-board-scroll scrollLeft to stay preserved (not reset to 0) when adding heats")
	}
	h.WaitUntil("Qualifying R1 has >= 8 heats and scrolls internally inside viewport boundary", 5*time.Second, func() (bool, error) {
		res, err := h.Page.Evaluate(`() => {
			const tallCol = document.querySelector("[data-dte-round-col]");
			const heatsList = tallCol ? tallCol.querySelector("[data-dte-heats-list]") : null;
			if (!heatsList) return false;
			return Boolean(heatsList.querySelectorAll(".dte-heat-card").length >= 8 && heatsList.scrollHeight > heatsList.clientHeight + 250);
		}`)
		if err != nil {
			return false, nil
		}
		ok, _ := res.(bool)
		return ok, nil
	})
	qualBoundCheck, err := h.Page.Evaluate(`() => {
		const cols = Array.from(document.querySelectorAll("[data-dte-round-col]"));
		const tallCol = cols[0];
		const heatsList = tallCol.querySelector("[data-dte-heats-list]");
		const addHeatBtn = tallCol.querySelector("[data-dte-add-heat]");
		const tallRect = tallCol.getBoundingClientRect();
		const btnRect = addHeatBtn ? addHeatBtn.getBoundingClientRect() : null;
		heatsList.scrollTop = 260;
		const scrolledTop = heatsList.scrollTop;
		const pageNoVertOverflow = document.documentElement.scrollHeight <= window.innerHeight + 1;
		const allColsBounded = Array.from(document.querySelectorAll(".dte-col")).every(
			(c) => c.getBoundingClientRect().bottom <= window.innerHeight - 14
		);
		return {
			ok: Boolean(
				pageNoVertOverflow &&
				allColsBounded &&
				tallRect.bottom <= window.innerHeight - 14 &&
				scrolledTop > 180 &&
				btnRect &&
				btnRect.bottom <= tallRect.bottom + 1
			),
			innerHeight: window.innerHeight,
			docScrollHeight: document.documentElement.scrollHeight,
			tallBottom: Math.round(tallRect.bottom),
			scrolledTop: Math.round(scrolledTop),
		};
	}`)
	if err != nil {
		t.Fatalf("evaluate Qualifying 8-heat bounded scroll: %v", err)
	}
	if qMap, _ := qualBoundCheck.(map[string]interface{}); qMap["ok"] != true {
		t.Fatalf("expected Qualifying 8-heat column bounded above bottom buffer with internal scroll: %+v", qMap)
	}
	h.MilestoneScreenshot("desktop-setup-table-qualifying-8-heats-bounded-scroll")

	// Apply Double Elimination (7 rounds + Checked-In Pilots = 8 columns + Add Round) so >5 columns exist!
	if err := h.Page.Locator(`[data-dte-open-templates]`).First().Click(); err != nil {
		t.Fatalf("open Templates from Table view: %v", err)
	}
	tplModal := h.Page.Locator(`.slaprf-modal-backdrop`).First()
	h.MustBeVisible(tplModal, "Templates modal in Desktop Table view")
	if err := tplModal.Locator(`button[data-modal-pick-tpl="double_elimination"]`).Click(); err != nil {
		t.Fatalf("select double_elimination: %v", err)
	}
	if err := tplModal.Locator(`button[data-tpl-confirm]`).Click(); err != nil {
		t.Fatalf("confirm double_elimination: %v", err)
	}
	time.Sleep(150 * time.Millisecond)
	if confirmReplace := h.Page.Locator(`.slaprf-modal-backdrop [data-modal-confirm]`).First(); true {
		if vis, _ := confirmReplace.IsVisible(); vis {
			if err := confirmReplace.Click(); err != nil {
				t.Fatalf("confirm replace existing rounds: %v", err)
			}
		}
	}
	h.WaitUntil("7 round columns rendered in Desktop Table view", 5*time.Second, func() (bool, error) {
		cnt, err := h.Page.Locator(`[data-dte-round-col]`).Count()
		return err == nil && cnt >= 6, nil
	})
	time.Sleep(180 * time.Millisecond)
	h.MilestoneScreenshot("desktop-setup-table-view-four-columns")

	// 3. Verify Pilots column is omitted from Table view (dedicated Pilots tab owns roster) AND 4 round columns fit side-by-side on 1720px screen!
	colsCheck, err := h.Page.Evaluate(`() => {
		const scroller = document.querySelector("[data-dte-scroll]");
		const pilotsCol = document.querySelector("[data-dte-pilots-col]");
		const summary = document.querySelector("[data-dte-race-summary]");
		const ribbon = document.querySelector(".races-page-topbar");
		const tabs = document.querySelector(".rc-topleft-scroll-wrap");
		const cols = scroller ? Array.from(scroller.querySelectorAll(".dte-col")) : [];
		if (!scroller || pilotsCol !== null || !summary || !ribbon || !tabs || cols.length < 6) return { ok: false };
		const sRect = scroller.getBoundingClientRect();
		const sumRect = summary.getBoundingClientRect();
		const ribRect = ribbon.getBoundingClientRect();
		const tabRect = tabs.getBoundingClientRect();
		const fullyVisible = cols.filter((c) => {
			const r = c.getBoundingClientRect();
			return r.left >= sRect.left - 2 && r.right <= sRect.right + 4;
		}).length;
		const canScrollRight = scroller.scrollWidth > scroller.clientWidth + 80;
		return {
			ok:
				cols[0].hasAttribute("data-dte-round-col") &&
				fullyVisible === 4 &&
				canScrollRight &&
				Math.abs(sumRect.top - ribRect.bottom - 16) <= 1.5 &&
				Math.abs(sumRect.height - 46) <= 1 &&
				Math.abs(sumRect.left - ribRect.left) <= 1.5 &&
				Math.abs(sumRect.right - ribRect.right) <= 1.5 &&
				Math.abs((tabRect.left + tabRect.right) / 2 - (ribRect.left + ribRect.right) / 2) <= 2.5,
			fullyVisible,
			scrollW: scroller.scrollWidth,
			clientW: scroller.clientWidth,
			sumTop: sumRect.top,
			tabBottom: tabRect.bottom,
		};
	}`)
	if err != nil {
		t.Fatalf("evaluate Desktop Table view columns: %v", err)
	}
	if cMap, _ := colsCheck.(map[string]interface{}); cMap["ok"] != true {
		t.Fatalf("expected 4 round columns visible side-by-side (zero Pilots column) and Race Summary below tabs: %+v", cMap)
	}

	// 3b. Verify Race Summary right-hand actions: prominent icon-only sliders button (no "Race Settings" text) + garbage delete race button next to it!
	summaryActionsCheck, err := h.Page.Evaluate(`() => {
		const summary = document.querySelector("[data-dte-race-summary]");
		if (!summary) return { ok: false };
		const settingsBtn = summary.querySelector("[data-dte-open-defaults]");
		const deleteBtn = summary.querySelector('[data-race-act="delete-race"]');
		if (!settingsBtn || !deleteBtn) return { ok: false };
		const sTxt = (settingsBtn.textContent || "").trim();
		const dTxt = (deleteBtn.textContent || "").trim();
		const sSvgW = Number(settingsBtn.querySelector("svg")?.getAttribute("width") || 0);
		const dSvgW = Number(deleteBtn.querySelector("svg")?.getAttribute("width") || 0);
		const sRect = settingsBtn.getBoundingClientRect();
		const dRect = deleteBtn.getBoundingClientRect();
		return {
			ok: sTxt === "" && dTxt === "" && sSvgW >= 20 && dSvgW >= 18 && dRect.left > sRect.right - 2,
			sTxt,
			dTxt,
			sSvgW,
			dSvgW,
		};
	}`)
	if err != nil {
		t.Fatalf("evaluate Race Summary sliders + delete icon buttons: %v", err)
	}
	if aMap, _ := summaryActionsCheck.(map[string]interface{}); aMap["ok"] != true {
		t.Fatalf("expected icon-only sliders (>=20px) + delete trash icon button on right of Race Summary: %+v", aMap)
	}
	// Click the delete trash button to verify it opens the Delete Race confirmation modal, then dismiss with Escape.
	if err := h.Page.Locator(`[data-dte-race-summary] [data-race-act="delete-race"]`).First().Click(); err != nil {
		t.Fatalf("click Delete Race trash button in Setup Table view: %v", err)
	}
	delModal := h.Page.Locator(`.slaprf-modal-backdrop`).First()
	h.MustBeVisible(delModal, "Delete Race confirmation modal")
	if err := h.Page.Keyboard().Press("Escape"); err != nil {
		t.Fatalf("dismiss Delete Race confirmation modal: %v", err)
	}
	h.MustBeHidden(delModal, "Delete Race confirmation modal dismissed")

	// Also open Race Settings modal and verify there are NO tag suggestions (users type whatever tags they want).
	if err := h.Page.Locator(`[data-dte-race-summary] [data-dte-open-defaults]`).First().Click(); err != nil {
		t.Fatalf("click Race Settings sliders button in Setup Table view: %v", err)
	}
	raceSettingsModal := h.Page.Locator(`.slaprf-modal-backdrop`).First()
	h.MustBeVisible(raceSettingsModal, "Race Settings modal")
	if suggestCnt, _ := raceSettingsModal.Locator(`[data-modal-suggest-tag], [data-modal-tags-suggestions]`).Count(); suggestCnt != 0 {
		t.Fatalf("expected 0 tag suggestions in Race Settings modal, got %d", suggestCnt)
	}
	if err := h.Page.Keyboard().Press("Escape"); err != nil {
		t.Fatalf("dismiss Race Settings modal: %v", err)
	}
	h.MustBeHidden(raceSettingsModal, "Race Settings modal dismissed")

	// 4. Verify Round 1 IN "<" chevron jumps to the dedicated Desktop Pilots tab (centered 640px card),
	// then return to Setup Table view and verify board visual details!
	if err := h.Page.Locator(`button.dte-io-lead-jump[data-dte-jump-round="__pilots__"]`).First().Click(); err != nil {
		t.Fatalf("click Round 1 IN jump to Pilots tab: %v", err)
	}
	pilotsCard := h.Page.Locator(`.races-page.is-pilots-page .is-pilots-panel`).First()
	h.MustBeVisible(pilotsCard, "Dedicated Desktop Pilots card")
	h.MustContainText(pilotsCard, "14 racing")
	time.Sleep(220 * time.Millisecond)
	pilotsCardCheck, err := h.Page.Evaluate(`() => {
		const ribbon = document.querySelector(".races-page-topbar");
		const card = document.querySelector(".races-page.is-pilots-page .is-pilots-panel");
		if (!ribbon || !card) return { ok: false };
		const rRect = ribbon.getBoundingClientRect();
		const cRect = card.getBoundingClientRect();
		const centerDiff = Math.abs((cRect.left + cRect.right) / 2 - (rRect.left + rRect.right) / 2);
		return {
			ok: Math.abs(cRect.width - 640) <= 2 && centerDiff <= 2 && card.querySelectorAll("[data-rc-panel-collapse]").length === 0,
			cardW: Math.round(cRect.width),
			centerDiff,
		};
	}`)
	if err != nil {
		t.Fatalf("evaluate Desktop Pilots card layout: %v", err)
	}
	if pcMap, _ := pilotsCardCheck.(map[string]interface{}); pcMap["ok"] != true {
		t.Fatalf("expected centered 640px Desktop Pilots card without collapse button: %+v", pcMap)
	}
	// Verify toggling a pilot check-in switch off and back on never changes .rc-pilot-row height (stays 40px)!
	firstRowToggle := pilotsCard.Locator(`.rc-pilot-row [data-pilots-checkin-toggle]`).First()
	hBeforeCheck, err := h.Page.Evaluate(`() => {
		const row = document.querySelector(".races-page.is-pilots-page .rc-pilot-row");
		const h = row ? row.getBoundingClientRect().height : -1;
		return { ok: h === 40, h };
	}`)
	if err != nil {
		t.Fatalf("measure pilot row height before toggle: %v", err)
	}
	if bMap, _ := hBeforeCheck.(map[string]interface{}); bMap["ok"] != true {
		t.Fatalf("expected pilot row height before toggle to be 40px, got %+v", bMap)
	}
	if err := firstRowToggle.Click(); err != nil {
		t.Fatalf("toggle first pilot check-in off: %v", err)
	}
	h.WaitUntil("first pilot row shows Free label at identical 40px height", 3*time.Second, func() (bool, error) {
		res, err := h.Page.Evaluate(`() => {
			const row = document.querySelector(".races-page.is-pilots-page .rc-pilot-row");
			if (!row) return false;
			const freeLbl = row.querySelector(".bkt-pilot-unchecked-lbl");
			return Boolean(freeLbl) && row.getBoundingClientRect().height === 40;
		}`)
		if err != nil {
			return false, nil
		}
		ok, _ := res.(bool)
		return ok, nil
	})
	if err := pilotsCard.Locator(`.rc-pilot-row [data-pilots-checkin-toggle]`).First().Click(); err != nil {
		t.Fatalf("toggle first pilot check-in back on: %v", err)
	}
	h.MustContainText(pilotsCard, "14 racing")
	h.MilestoneScreenshot("desktop-race-pilots-tab-centered")

	// Also verify Desktop Signals tab (`Signal at each timer`):
	// - `.scope-transport` is centered horizontally above `.scope-canvas` with tight gap,
	// - `.scope-axis-controls` (`Auto X`, `Auto Y`) is below `.scope-canvas` on the bottom-left,
	// - `.scope-hint` sits on the bottom row immediately after `.scope-axis-controls`.
	if err := h.Page.Locator(`.rc-topleft-bar button[data-mobile-ctrl-nav="signals"]`).First().Click(); err != nil {
		t.Fatalf("switch to Signals tab: %v", err)
	}
	h.MustBeVisible(h.Page.Locator(`.scope-canvas`).First(), "Signals tab RSSI scope canvas")
	time.Sleep(200 * time.Millisecond)
	signalsLayoutCheck, err := h.Page.Evaluate(`() => {
		const inner = document.querySelector(".races-page-stack");
		const toolbar = document.querySelector(".scope-toolbar");
		const transport = document.querySelector(".scope-transport");
		const canvas = document.querySelector(".scope-canvas");
		const bottomBar = document.querySelector(".scope-bottom-bar");
		const axis = document.querySelector(".scope-axis-controls");
		const hint = document.querySelector(".scope-hint");
		if (!inner || !toolbar || !transport || !canvas || !bottomBar || !axis || !hint) return { ok: false };
		const iRect = inner.getBoundingClientRect();
		const iCs = getComputedStyle(inner);
		const tRect = transport.getBoundingClientRect();
		const cRect = canvas.getBoundingClientRect();
		const aRect = axis.getBoundingClientRect();
		const hRect = hint.getBoundingClientRect();
		const transportCenterDiff = Math.abs((tRect.left + tRect.right) / 2 - (cRect.left + cRect.right) / 2);
		const topGap = cRect.top - tRect.bottom;
		const axisBelowLeft = aRect.top >= cRect.bottom + 4 && Math.abs(aRect.left - cRect.left) <= 2;
		const hintAfterAxis =
			hRect.left >= aRect.right + 4 &&
			Math.abs((hRect.top + hRect.bottom) / 2 - (aRect.top + aRect.bottom) / 2) <= 4;
		return {
			ok:
				Math.round(iRect.width) === 960 &&
				inner.classList.contains("is-ws-tab-enter") &&
				iCs.animationName === "slaprf-ws-tab-fade" &&
				transportCenterDiff <= 2.5 &&
				topGap >= 2 &&
				topGap <= 10 &&
				axisBelowLeft &&
				hintAfterAxis,
			innerW: Math.round(iRect.width),
			animName: iCs.animationName,
			transportCenterDiff,
			topGap,
			axisBelowLeft,
			hintAfterAxis,
			aLeft: aRect.left,
			cLeft: cRect.left,
			hLeft: hRect.left,
			aRight: aRect.right,
		};
	}`)
	if err != nil {
		t.Fatalf("evaluate Signals tab chart controls layout: %v", err)
	}
	if sMap, _ := signalsLayoutCheck.(map[string]interface{}); sMap["ok"] != true {
		t.Fatalf("expected Signals chart transport centered above canvas and Auto X/Y + hint below on bottom-left: %+v", sMap)
	}
	h.MilestoneScreenshot("desktop-race-signals-tab-controls-layout")

	if err := h.Page.Locator(`.rc-topleft-bar button[data-race-tab="edit"]`).First().Click(); err != nil {
		t.Fatalf("switch back to Setup tab from Pilots tab: %v", err)
	}
	h.MustBeVisible(h.Page.Locator(`[data-dte-root]`).First(), "Setup Table view restored")
	time.Sleep(220 * time.Millisecond)
	railCheck, err := h.Page.Evaluate(`() => {
		const summary = document.querySelector("[data-dte-race-summary]");
		const navGap = document.querySelector("[data-dte-nav-gap]");
		const boardWrap = document.querySelector("[data-dte-board-wrap]");
		const scroller = document.querySelector("[data-dte-scroll]");
		const rightCue = boardWrap ? boardWrap.querySelector('.dte-scroll-cue.is-right') : null;
		const leftCue = boardWrap ? boardWrap.querySelector('.dte-scroll-cue.is-left') : null;
		const addOutBtn = document.querySelector("[data-dte-connect-out]");
		const heatsList = document.querySelector("[data-dte-heats-list]");
		if (!summary || !boardWrap || !scroller || !rightCue || !leftCue || !addOutBtn || !heatsList) return { ok: false };
		const sumR = summary.getBoundingClientRect();
		const titleEl = summary.querySelector(".dte-race-title");
		const trashSvg = summary.querySelector('[data-race-act="delete-race"] svg');
		const titleLeftGap = titleEl ? titleEl.getBoundingClientRect().left - sumR.left : -1;
		const trashRightGap = trashSvg ? sumR.right - trashSvg.getBoundingClientRect().right : -1;
		const summaryLeftRightBalanced = titleLeftGap >= 20 && Math.abs(titleLeftGap - trashRightGap) <= 1.5;
		const brdR = boardWrap.getBoundingClientRect();
		const cueR = rightCue.getBoundingClientRect();
		const cueCs = getComputedStyle(rightCue);
		const noExtraGap = navGap === null && Math.abs(brdR.top - sumR.bottom - 16) <= 2;
		const summaryCompactAndNoTags =
			sumR.height <= 54 &&
			summary.querySelectorAll(".mre-race-tag").length === 0 &&
			summaryLeftRightBalanced;
		const haloChevronOk =
			!rightCue.hidden &&
			leftCue.hidden &&
			Math.round(cueR.width) === 52 &&
			Math.round(cueR.height) === 52 &&
			cueCs.borderRadius === "50%" &&
			cueCs.position === "absolute";
		const addOutOk =
			(addOutBtn.textContent || "").trim() === "Add Output" &&
			Number(addOutBtn.querySelector("svg")?.getAttribute("width") || 0) === 15;
		const scrollerCs = getComputedStyle(scroller);
		const heatsScrollbarCustom = getComputedStyle(heatsList).scrollbarWidth !== "thin";
		const hollowDots = Array.from(document.querySelectorAll(".custom-select-trigger.is-heat-placeholder .dot.is-hollow"));
		const firstHollowCs = hollowDots[0] ? getComputedStyle(hollowDots[0]) : null;
		const hollowDotsOk =
			hollowDots.length >= 10 &&
			Boolean(firstHollowCs && firstHollowCs.backgroundColor === "rgba(0, 0, 0, 0)" && firstHollowCs.boxShadow.includes("inset"));
		const w1AddHeatBtn = document.querySelector("[data-dte-round-col] [data-dte-add-heat]");
		const w1Foot = w1AddHeatBtn ? w1AddHeatBtn.closest(".dte-col-foot") : null;
		const addHeatDisabledWithTooltip = Boolean(
			w1AddHeatBtn &&
				w1AddHeatBtn.disabled &&
				(w1AddHeatBtn.getAttribute("title") || "").includes("Cannot add another heat: advancing Top 2 per heat requires at least 3 pilots per heat") &&
				w1Foot &&
				(w1Foot.getAttribute("title") || "").includes("Cannot add another heat: advancing Top 2 per heat requires at least 3 pilots per heat")
		);
		const connRows = Array.from(document.querySelectorAll(".dte-io-row:not(.is-root-seed)"));
		const rootRows = Array.from(document.querySelectorAll(".dte-io-row.is-root-seed"));
		const ioChevronButtonsConsistent =
			connRows.length >= 6 &&
			rootRows.length >= 1 &&
			connRows.every((row) => {
				const leadBtn = row.querySelector("button.dte-io-lead-jump[data-dte-jump-round]");
				const trailBtn = row.querySelector(".dte-io-actions button[data-dte-jump-round]");
				const targetSvgs = row.querySelectorAll(".dte-io-target svg").length;
				return Boolean(leadBtn && trailBtn && targetSvgs === 0 && leadBtn.dataset.dteJumpRound === trailBtn.dataset.dteJumpRound);
			}) &&
			rootRows.every((row) => {
				const leadBtn = row.querySelector('button.dte-io-lead-jump[data-dte-jump-round="__pilots__"]');
				const trailBtn = row.querySelector('.dte-io-actions button[data-dte-jump-round="__pilots__"]');
				return Boolean(leadBtn && trailBtn);
			});
		const lanePill = document.querySelector(".is-setup-table-page .mre-lane-pill");
		const lanePillCs = lanePill ? getComputedStyle(lanePill) : null;
		const lanePillCentered = Boolean(lanePillCs && lanePillCs.paddingTop === "0px" && lanePillCs.paddingBottom === "1px");
		const noAddColAfterFinals = document.querySelectorAll(".dte-col.is-add-col").length === 0;
		const r1Col = document.querySelector(".dte-col.lane-losers");
		const finCol = document.querySelector(".dte-col.lane-finals");
		const heatHead = document.querySelector(".dte-heat-head");
		const chTrig = document.querySelector(".custom-select-wrap:has(> .dte-seat-ch-select) .custom-select-trigger");
		const filledTrig = document.querySelector(".custom-select-wrap:has(> .dte-seat-pilot-select:not(.is-heat-placeholder):not(.is-bye-placeholder)) .custom-select-trigger");
		const phTrig = document.querySelector(".custom-select-wrap:has(> .dte-seat-pilot-select.is-heat-placeholder) .custom-select-trigger");
		const byeTrig = document.querySelector(".custom-select-wrap:has(> .dte-seat-pilot-select.is-bye-placeholder) .custom-select-trigger");
		const chCs = chTrig ? getComputedStyle(chTrig) : null;
		const filledCs = filledTrig ? getComputedStyle(filledTrig) : null;
		const phCs = phTrig ? getComputedStyle(phTrig) : null;
		const byeCs = byeTrig ? getComputedStyle(byeTrig) : null;
		const heatHeadCs = heatHead ? getComputedStyle(heatHead) : null;
		const graphColorConsistencyOk = Boolean(
			r1Col &&
				finCol &&
				chCs &&
				filledCs &&
				phCs &&
				byeCs &&
				heatHeadCs &&
				chCs.backgroundColor === heatHeadCs.backgroundColor &&
				chCs.color === phCs.color &&
				filledCs.backgroundColor === phCs.backgroundColor &&
				phCs.backgroundColor === byeCs.backgroundColor &&
				phCs.color === byeCs.color &&
				byeCs.opacity === "1"
		);
		return {
			ok:
				noExtraGap &&
				summaryCompactAndNoTags &&
				haloChevronOk &&
				addOutOk &&
				heatsScrollbarCustom &&
				hollowDotsOk &&
				addHeatDisabledWithTooltip &&
				ioChevronButtonsConsistent &&
				lanePillCentered &&
				noAddColAfterFinals &&
				graphColorConsistencyOk &&
				scrollerCs.cursor === "grab" &&
				scrollerCs.scrollbarWidth === "none",
			noExtraGap,
			sumH: Math.round(sumR.height),
			summaryCompactAndNoTags,
			haloChevronOk,
			addOutOk,
			heatsScrollbarCustom,
			hollowDotsCount: hollowDots.length,
			hollowDotsOk,
			addHeatDisabledWithTooltip,
			ioChevronButtonsConsistent,
			noAddColAfterFinals,
			graphColorConsistencyOk,
			addHeatTitle: w1AddHeatBtn ? w1AddHeatBtn.getAttribute("title") : "",
			cursor: scrollerCs.cursor,
			scrollbarWidth: scrollerCs.scrollbarWidth,
		};
	}`)
	if err != nil {
		t.Fatalf("evaluate collapsed Pilots rail & halo scroll cues: %v", err)
	}
	if rMap, _ := railCheck.(map[string]interface{}); rMap["ok"] != true {
		t.Fatalf("expected animated in-place collapsed Pilots rail, floating 52px halo chevron cue, compact summary without tags, Add Output (15px +), hollow gray dots on feeder seats, custom scrollbar, and grab cursor: %+v", rMap)
	}
	h.MilestoneScreenshot("desktop-setup-table-view-pilots-collapsed")

	// Test inertial momentum drag-throw on .dte-board-scroll, and scroll right to Finals!
	momentumCheck, err := h.Page.Evaluate(`async () => {
		const scroller = document.querySelector("[data-dte-scroll]");
		const head = document.querySelector("[data-dte-round-col] .dte-round-head");
		if (!scroller || !head) return { ok: false };
		scroller.scrollLeft = 0;
		const r = head.getBoundingClientRect();
		const startX = Math.round(r.left + 40);
		const y = Math.round(r.top + 12);
		head.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse", clientX: startX, clientY: y }));
		for (let step = 1; step <= 5; step++) {
			await new Promise((res) => setTimeout(res, 12));
			window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, button: 0, pointerType: "mouse", clientX: startX - step * 28, clientY: y }));
		}
		const leftAtRelease = scroller.scrollLeft;
		window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerType: "mouse", clientX: startX - 140, clientY: y }));
		const coastingRightAfterRelease = scroller.classList.contains("is-coasting");
		await new Promise((res) => setTimeout(res, 180));
		const leftAfterCoast = scroller.scrollLeft;
		scroller.scrollLeft = 0;
		return {
			ok: coastingRightAfterRelease && leftAtRelease >= 120 && leftAfterCoast > leftAtRelease + 90,
			coastingRightAfterRelease,
			leftAtRelease: Math.round(leftAtRelease),
			leftAfterCoast: Math.round(leftAfterCoast),
		};
	}`)
	if err != nil {
		t.Fatalf("evaluate Desktop Table drag-throw momentum: %v", err)
	}
	if mMap, _ := momentumCheck.(map[string]interface{}); mMap["ok"] != true {
		t.Fatalf("expected Desktop Table drag-throw to continue coasting with inertial momentum after release: %+v", mMap)
	}
	if err := h.Page.Locator(`[data-dte-scroll-dir="1"]`).First().Click(); err != nil {
		t.Fatalf("click right scroll cue on Desktop Table view: %v", err)
	}
	h.WaitUntil("Board scrolled right to reveal later rounds", 3*time.Second, func() (bool, error) {
		res, err := h.Page.Evaluate(`() => Boolean((document.querySelector("[data-dte-scroll]")?.scrollLeft || 0) > 200)`)
		if err != nil {
			return false, nil
		}
		ok, _ := res.(bool)
		return ok, nil
	})
	time.Sleep(220 * time.Millisecond)
	h.MilestoneScreenshot("desktop-setup-table-view-scrolled-right")

	// 5. Modify a round directly in Table view (clear a seat via dropdown + open Round Settings Desktop modal), then switch back to Graph!
	firstRoundCol := h.Page.Locator(`[data-dte-round-col]`).First()
	if _, err := h.Page.Evaluate(`() => {
		const sc = document.querySelector("[data-dte-scroll]");
		if (sc) sc.scrollTo({ left: 0, behavior: "instant" });
	}`); err != nil {
		t.Fatalf("scroll back to left: %v", err)
	}
	if _, err := h.Page.Evaluate(`() => {
		const sel = document.querySelector('[data-dte-round-col] select[data-dte-seat-pilot][data-seat-idx="1"]');
		if (sel) {
			sel.value = "0";
			sel.dispatchEvent(new Event("change", { bubbles: true }));
		}
	}`); err != nil {
		t.Fatalf("clear seat 1 via Table view pilot select: %v", err)
	}
	h.WaitUntil("Seat 1 cleared to Open / BYE in Table view", 3*time.Second, func() (bool, error) {
		val, err := h.Page.Locator(`[data-dte-round-col] select[data-dte-seat-pilot][data-seat-idx="1"]`).First().InputValue()
		return err == nil && val == "0", nil
	})

	if err := firstRoundCol.Locator(`[data-dte-round-settings]`).Click(); err != nil {
		t.Fatalf("click Round Settings in Table view: %v", err)
	}
	roundModal := h.Page.Locator(`.slaprf-modal-backdrop`).First()
	h.MustBeVisible(roundModal, "Centered Desktop Round Settings modal from Table view")
	if err := h.Page.Keyboard().Press("Escape"); err != nil {
		t.Fatalf("close Round Settings modal: %v", err)
	}
	h.MustBeHidden(roundModal, "Round Settings modal closed")

	// 5b. Verify W1 (4 heats, taller than viewport) stops at the bottom aesthetic buffer & scrolls internally,
	// while shorter columns (R1, W2, R2 with 2 heats) only expand as far as their content!
	boundCheck, err := h.Page.Evaluate(`() => {
		const cols = Array.from(document.querySelectorAll("[data-dte-round-col]"));
		const tallCol = cols[0];
		const heatsList = tallCol.querySelector("[data-dte-heats-list]");
		const addHeatBtn = tallCol.querySelector("[data-dte-add-heat]");
		const tallRect = tallCol.getBoundingClientRect();
		const btnRect = addHeatBtn ? addHeatBtn.getBoundingClientRect() : null;
		const shortHeights = cols.slice(1).map((c) => c.getBoundingClientRect().height);
		const minShortH = Math.min(...shortHeights);
		heatsList.scrollTop = 140;
		const scrolledTop = heatsList.scrollTop;
		const pageNoVertOverflow = document.documentElement.scrollHeight <= window.innerHeight + 1;
		const allColsBounded = Array.from(document.querySelectorAll(".dte-col")).every(
			(c) => c.getBoundingClientRect().bottom <= window.innerHeight - 14
		);
		const toggle = document.querySelector("[data-setup-view-switcher]");
		return {
			ok: Boolean(
				pageNoVertOverflow &&
				allColsBounded &&
				tallRect.bottom <= window.innerHeight - 14 &&
				minShortH < tallRect.height - 60 &&
				scrolledTop > 80 &&
				btnRect &&
				btnRect.bottom <= tallRect.bottom + 1 &&
				toggle &&
				toggle.dataset.activeView === "table" &&
				toggle.querySelectorAll("svg").length === 0
			),
			innerHeight: window.innerHeight,
			docScrollHeight: document.documentElement.scrollHeight,
			tallBottom: Math.round(tallRect.bottom),
			tallHeight: Math.round(tallRect.height),
			minShortH: Math.round(minShortH),
			listScrollH: heatsList.scrollHeight,
			listClientH: heatsList.clientHeight,
			scrolledTop: Math.round(scrolledTop),
		};
	}`)
	if err != nil {
		t.Fatalf("evaluate bounded Table column height & internal scroll: %v", err)
	}
	if bMap, _ := boundCheck.(map[string]interface{}); bMap["ok"] != true {
		t.Fatalf("expected viewport-bounded column max-height + internal scroll + compact short columns: %+v", bMap)
	}
	h.MilestoneScreenshot("desktop-setup-table-bounded-internal-scroll")

	// 5c. Narrow viewport to 920px (just above 860px mobile breakpoint) and verify NO heat abbreviation (e.g. W1-1 / L1-1 / OQ-1) wraps onto 2 lines!
	if err := h.Page.SetViewportSize(920, 860); err != nil {
		t.Fatalf("set narrow desktop viewport 920x860: %v", err)
	}
	time.Sleep(120 * time.Millisecond)
	nowrapCheck, err := h.Page.Evaluate(`() => {
		const titles = Array.from(document.querySelectorAll(".dte-heat-title"));
		const heads = Array.from(document.querySelectorAll(".dte-heat-head"));
		const anyWrappedTitle = titles.some((el) => el.getClientRects().length > 1 || el.offsetHeight > 22);
		const anyTallHead = heads.some((el) => el.offsetHeight > 44);
		return {
			ok: titles.length > 0 && !anyWrappedTitle && !anyTallHead,
			titleCount: titles.length,
			anyWrappedTitle,
			anyTallHead,
		};
	}`)
	if err != nil {
		t.Fatalf("evaluate narrow desktop heat header nowrap: %v", err)
	}
	if nMap, _ := nowrapCheck.(map[string]interface{}); nMap["ok"] != true {
		t.Fatalf("expected zero hyphen/word wrapping on heat titles at narrow desktop width: %+v", nMap)
	}
	if err := h.Page.SetViewportSize(1720, 920); err != nil {
		t.Fatalf("restore desktop viewport 1720x920: %v", err)
	}
	time.Sleep(100 * time.Millisecond)

	// Switch back to Graph view and verify canvas returns cleanly!
	if err := h.Page.Locator(`button[data-setup-view="graph"]`).First().Click(); err != nil {
		t.Fatalf("switch back to Graph view: %v", err)
	}
	h.MustBeVisible(h.Page.Locator(`[data-rc-viewport]`).First(), "Canvas viewport restored in Graph view")

	// 6. Verify:
	// - [Setup | Control | Review] stays pixel-locked at the EXACT same (x, y) across Graph, Table, Control, and Review!
	// - [Graph | Table] stays pixel-locked at the EXACT same (right, top) between Graph and Table!
	// - Topmost panel Y (top edge) in Setup (Table) [dte-race-summary], Control [is-cockpit-panel], and Review [rc-page-card] is IDENTICAL!
	readMetrics := func(label string, panelSel string) map[string]float64 {
		res, err := h.Page.Evaluate(`(sel) => {
			const tabs = document.querySelector(".rc-topleft-scroll-wrap");
			const sw = document.querySelector("[data-setup-view-switcher]");
			const panel = sel ? document.querySelector(sel) : null;
			const hdr = panel
				? (panel.matches("[data-dte-race-summary], .rc-panel-header")
					? panel
					: panel.querySelector(".rc-panel-header"))
				: null;
			if (!tabs) return null;
			const tr = tabs.getBoundingClientRect();
			const sr = sw ? sw.getBoundingClientRect() : null;
			const pr = panel ? panel.getBoundingClientRect() : null;
			const hr = hdr ? hdr.getBoundingClientRect() : null;
			const rnd = (n) => Math.round(n * 10) / 10;
			return {
				tx: rnd(tr.left),
				ty: rnd(tr.top),
				sx: sr ? rnd(sr.left) : -1,
				sy: sr ? rnd(sr.top) : -1,
				py: pr ? rnd(pr.top) : -1,
				hh: hr ? rnd(hr.height) : -1,
			};
		}`, panelSel)
		if err != nil || res == nil {
			t.Fatalf("read metrics (%s): %v", label, err)
		}
		raw := res.(map[string]interface{})
		out := map[string]float64{}
		for k, v := range raw {
			switch n := v.(type) {
			case float64:
				out[k] = n
			case int:
				out[k] = float64(n)
			}
		}
		return out
	}

	gMet := readMetrics("Setup Graph", "[data-dte-race-summary]")
	if err := h.Page.Locator(`.rc-topleft-bar button[data-race-tab="pilots"]`).First().Click(); err != nil {
		t.Fatalf("click Pilots tab: %v", err)
	}
	pMet := readMetrics("Pilots", ".is-pilots-panel")
	if err := h.Page.Locator(`.rc-topleft-bar button[data-race-tab="edit"]`).First().Click(); err != nil {
		t.Fatalf("click Setup tab: %v", err)
	}
	if err := h.Page.Locator(`button[data-setup-view="table"]`).First().Click(); err != nil {
		t.Fatalf("click Setup Table: %v", err)
	}
	tMet := readMetrics("Setup Table", "[data-dte-race-summary]")
	if math.Abs(gMet["py"]-tMet["py"]) > 1 {
		t.Fatalf("expected Setup sub-ribbon Y pixel-locked between Graph (%v) and Table (%v)", gMet["py"], tMet["py"])
	}
	if err := h.Page.Locator(`.rc-topleft-bar button[data-mobile-ctrl-nav="live"]`).First().Click(); err != nil {
		t.Fatalf("click Marshal tab: %v", err)
	}
	cMet := readMetrics("Marshal", ".is-cockpit-panel")
	h.MustBeVisible(h.Page.Locator(`[data-canvas-panel="heatline"]`).First(), "Flight Line visible on Marshal tab")
	h.MustBeHidden(h.Page.Locator(`[data-canvas-panel="schedule"]`).First(), "Schedule hidden on Marshal tab")
	time.Sleep(300 * time.Millisecond)
	h.MilestoneScreenshot("desktop-marshal-tab-cockpit-and-flightline")

	if err := h.Page.Locator(`.rc-topleft-bar button[data-mobile-ctrl-nav="schedule"]`).First().Click(); err != nil {
		t.Fatalf("click Schedule tab: %v", err)
	}
	schMet := readMetrics("Schedule", `[data-canvas-panel="schedule"]`)
	time.Sleep(300 * time.Millisecond)
	h.MilestoneScreenshot("desktop-schedule-tab")

	if err := h.Page.Locator(`.rc-topleft-bar button[data-mobile-ctrl-nav="standings"]`).First().Click(); err != nil {
		t.Fatalf("click Standings tab: %v", err)
	}
	stdMet := readMetrics("Standings", `[data-canvas-panel="standings"]`)

	if err := h.Page.Locator(`.rc-topleft-bar button[data-mobile-ctrl-nav="signals"]`).First().Click(); err != nil {
		t.Fatalf("click Signals tab: %v", err)
	}
	sigMet := readMetrics("Signals", `[data-canvas-panel="signals"]`)
	time.Sleep(300 * time.Millisecond)
	h.MilestoneScreenshot("desktop-signals-tab")

	if err := h.Page.Locator(`.rc-topleft-bar button[data-race-tab="review"]`).First().Click(); err != nil {
		t.Fatalf("click Review tab: %v", err)
	}
	rMet := readMetrics("Review", ".races-page .rc-page-card")
	for _, m := range []map[string]float64{pMet, tMet, cMet, schMet, stdMet, sigMet, rMet} {
		if gMet["tx"] != m["tx"] || gMet["ty"] != m["ty"] {
			t.Fatalf("expected Desktop pill switcher pixel-locked across all tabs: Graph=%+v vs %+v", gMet, m)
		}
		if math.Abs(gMet["py"]-m["py"]) > 1 {
			t.Fatalf("expected topmost header Y aligned across all Desktop tabs (including Setup sub-ribbon): Graph=%v vs %v", gMet["py"], m["py"])
		}
		if math.Abs(schMet["hh"]-m["hh"]) > 1 || math.Abs(m["hh"]-46) > 1 {
			t.Fatalf("expected header height across all Desktop tabs to match Heats Schedule (46px): Schedule=%v vs %+v", schMet["hh"], m)
		}
	}
	if math.Abs(gMet["sx"]-tMet["sx"]) > 1 || math.Abs(gMet["sy"]-tMet["sy"]) > 1 {
		t.Fatalf("expected [Graph | Table] top-right switcher pixel-locked between Graph and Table: Graph=%+v Table=%+v", gMet, tMet)
	}

	// 7. Verify Analytics is removed from the left sidebar and added to the Race ribbon after Review:
	if navPilotCnt, _ := h.Page.Locator(`[data-sidebar-nav] [data-route="pilot"]`).Count(); navPilotCnt != 0 {
		t.Fatalf("expected 0 Analytics links in left sidebar, got %d", navPilotCnt)
	}
	analyticsTabBtn := h.Page.Locator(`.rc-topleft-bar button[data-race-tab="analytics"]`).First()
	h.MustBeVisible(analyticsTabBtn, "Race ribbon Analytics tab button")
	if err := analyticsTabBtn.Click(); err != nil {
		t.Fatalf("click Race ribbon Analytics tab: %v", err)
	}
	h.MustBeVisible(h.Page.Locator(`[data-race-analytics-host] .analytics-picker-row`).First(), "Embedded Race Analytics picker row")
	time.Sleep(300 * time.Millisecond)
	h.MilestoneScreenshot("desktop-race-analytics-tab")

	// 8. Verify Desktop Race breadcrumb (`Race › Sunday Qualifier`) is visible in the TopBar,
	// clicking parent "Race" link returns to the Races directory with pixel-locked "Race" text
	// position and size (15px, vertically centered with right-side buttons, no subtitle),
	// and the "..." button next to Open reveals Settings + Delete!
	raceCrumb := h.Page.Locator(`[data-race-breadcrumb]`).First()
	h.MustBeVisible(raceCrumb, "Desktop Race TopBar breadcrumb")
	h.MustContainText(raceCrumb, "Sunday Qualifier")
	raceBackLink := raceCrumb.Locator(`a.topbar-crumb-item[href="#/races"]`).First()
	h.MustBeVisible(raceBackLink, "Desktop Race parent breadcrumb link")

	// Measure "Race" span inside the breadcrumb and verify panel header contrast & elevation in Marshal/Schedule/Review:
	inRaceCheck, err := h.Page.Evaluate(`() => {
		const crumbSpan = document.querySelector('[data-race-breadcrumb] a.topbar-crumb-item[href="#/races"] span');
		const actions = document.querySelector('.topbar-actions');
		if (!crumbSpan || !actions) return { ok: false, reason: "missing crumbSpan or actions" };
		const cr = crumbSpan.getBoundingClientRect();
		const ar = actions.getBoundingClientRect();
		const cs = window.getComputedStyle(crumbSpan.parentElement);
		return {
			ok: cs.fontSize === "15px" && Math.abs((cr.top + cr.height / 2) - (ar.top + ar.height / 2)) <= 1.5,
			left: Math.round(cr.left * 10) / 10,
			top: Math.round(cr.top * 10) / 10,
			height: Math.round(cr.height * 10) / 10,
			centerY: Math.round((cr.top + cr.height / 2) * 10) / 10,
			actionsCenterY: Math.round((ar.top + ar.height / 2) * 10) / 10,
			fontSize: cs.fontSize,
		};
	}`)
	if err != nil {
		t.Fatalf("evaluate in-race breadcrumb metrics: %v", err)
	}
	inRaceMap, _ := inRaceCheck.(map[string]interface{})
	if inRaceMap["ok"] != true {
		t.Fatalf("expected 15px breadcrumb 'Race' vertically centered with topbar actions: %+v", inRaceMap)
	}

	if err := raceBackLink.Click(); err != nil {
		t.Fatalf("click Race parent breadcrumb link: %v", err)
	}
	h.MustBeVisible(h.Page.Locator(`input[data-race-dir-search]`).First(), "Races directory search after clicking Race breadcrumb")

	dirRaceCheck, err := h.Page.Evaluate(`(prev) => {
		const h1 = document.querySelector('.topbar-title.is-no-subtitle h1');
		const p = document.querySelector('.topbar-title p');
		const actions = document.querySelector('.topbar-actions');
		if (!h1 || !actions) return { ok: false, reason: "missing .topbar-title.is-no-subtitle h1" };
		const hr = h1.getBoundingClientRect();
		const ar = actions.getBoundingClientRect();
		const hs = window.getComputedStyle(h1);
		const leftDiff = Math.abs(hr.left - prev.left);
		const topDiff = Math.abs(hr.top - prev.top);
		const centerDiff = Math.abs((hr.top + hr.height / 2) - (ar.top + ar.height / 2));
		return {
			ok: p === null && hs.fontSize === "15px" && leftDiff <= 1 && topDiff <= 1 && centerDiff <= 1.5,
			hasSubtitle: p !== null,
			fontSize: hs.fontSize,
			h1Left: Math.round(hr.left * 10) / 10,
			crumbLeft: prev.left,
			h1Top: Math.round(hr.top * 10) / 10,
			crumbTop: prev.top,
			leftDiff,
			topDiff,
			centerDiff,
		};
	}`, inRaceMap)
	if err != nil {
		t.Fatalf("evaluate top-level Race title alignment: %v", err)
	}
	if dMap, _ := dirRaceCheck.(map[string]interface{}); dMap["ok"] != true {
		t.Fatalf("expected top-level 'Race' title pixel-locked with breadcrumb 'Race' (no subtitle, 15px, centered): %+v", dMap)
	}

	moreBtn := h.Page.Locator(`button[data-race-act="toggle-dir-race-menu"]`).First()
	h.MustBeVisible(moreBtn, "Desktop Race table row '...' options button")
	if err := moreBtn.Click(); err != nil {
		t.Fatalf("click Desktop Race table '...' button: %v", err)
	}
	moreMenu := h.Page.Locator(`.dir-row-more-menu`).First()
	h.MustBeVisible(moreMenu, "Desktop Race table '...' dropdown menu")
	h.MustBeVisible(moreMenu.Locator(`[data-race-act="dir-open-race-settings"]`), "Settings item in '...' menu")
	h.MustBeVisible(moreMenu.Locator(`[data-race-act="delete-race"]`), "Delete item in '...' menu")
	time.Sleep(300 * time.Millisecond)
	h.MilestoneScreenshot("desktop-races-table-row-more-menu")
	if err := moreMenu.Locator(`[data-race-act="dir-open-race-settings"]`).Click(); err != nil {
		t.Fatalf("click Settings in '...' menu: %v", err)
	}
	dirSettingsModal := h.Page.Locator(`.slaprf-modal-backdrop`).First()
	h.MustBeVisible(dirSettingsModal, "Race Settings modal opened from table '...' menu")
	if err := h.Page.Keyboard().Press("Escape"); err != nil {
		t.Fatalf("dismiss Race Settings modal: %v", err)
	}
	h.MustBeHidden(dirSettingsModal, "Race Settings modal closed")
}
