//go:build e2e

package e2e_test

import (
	"testing"
	"time"
)

func TestComponent_PilotSlotsEditorSearchDuplicateGuardAndRemove(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/pilots")

	searchInput := h.Page.Locator(`input[data-pilot-dir-search]`).First()
	addBtn := h.Page.Locator(`button[data-action="add-pilot"]`).First()
	h.MustBeVisible(searchInput, "Pilots directory search/add input")

	// Verify secondary import/export buttons sit at the bottom-left below .pilot-dir-box-shell on Desktop, matching Mobile.
	bottomFooter := h.Page.Locator(`[data-pilot-mobile-io-slot]`).First()
	h.MustBeVisible(bottomFooter, "Pilots bottom-left secondary action row on Desktop")
	h.MustContainText(bottomFooter, "Import from MultiGP")
	h.MustContainText(bottomFooter, "Import from CSV")
	h.MustContainText(bottomFooter, "Export as CSV")
	layoutOK, err := h.Page.Evaluate(`() => {
		const box = document.querySelector(".pilot-dir-box-shell")?.getBoundingClientRect();
		const foot = document.querySelector("[data-pilot-mobile-io-slot]")?.getBoundingClientRect();
		const topIo = document.querySelector("[data-pilot-io-slot]");
		return Boolean(box && foot && !topIo && foot.top >= box.bottom - 1 && Math.abs(foot.left - box.left) <= 4);
	}`)
	if err != nil || layoutOK != true {
		t.Fatalf("expected [data-pilot-mobile-io-slot] to render below .pilot-dir-box-shell on bottom-left without top-right io buttons: err=%v layoutOK=%v", err, layoutOK)
	}

	// 1. Typing an existing callsign ("FAERRY") filters down to 1 row AND disables Add button!
	if err := searchInput.Fill("FAERRY"); err != nil {
		t.Fatalf("fill FAERRY: %v", err)
	}
	h.WaitUntil("filtered to 1 pilot and Add button disabled", 5*time.Second, func() (bool, error) {
		cnt, err1 := h.Page.Locator(`form[data-pilot]`).Count()
		dis, err2 := addBtn.IsDisabled()
		return err1 == nil && err2 == nil && cnt == 1 && dis, nil
	})
	h.MilestoneScreenshot("pilot-slots-duplicate-guard")

	// 2. Typing a brand-new callsign ("NightHawk") enables Add button -> click Add -> 11 pilots total (NightHawk is on page 2).
	if err := searchInput.Fill("NightHawk"); err != nil {
		t.Fatalf("fill NightHawk: %v", err)
	}
	h.WaitUntil("Add button enabled for unique callsign", 5*time.Second, func() (bool, error) {
		dis, err := addBtn.IsDisabled()
		return err == nil && !dis, nil
	})
	if err := addBtn.Click(); err != nil {
		t.Fatalf("click Add pilot: %v", err)
	}
	h.WaitUntil("11 pilots after adding NightHawk", 5*time.Second, func() (bool, error) {
		st := h.APIState()
		return len(st.Pilots) == 11 && st.Pilots[10].Callsign == "NightHawk", nil
	})
	// Verify via live in-browser WASM API (`GET /api/state`) that NightHawk was persisted on slot 11.
	stAdded := h.APIState()
	if len(stAdded.Pilots) != 11 || stAdded.Pilots[10].Callsign != "NightHawk" {
		t.Fatalf("expected /api/state to report 11 pilots with NightHawk on slot 11, got len=%d", len(stAdded.Pilots))
	}

	// 3. Navigate to page 2 (or filter by NightHawk) and remove newly added pilot slot 11 via [data-remove-pilot="11"].
	nextPageBtn := h.Page.Locator(`button[data-page="next"]`).First()
	if cnt, _ := nextPageBtn.Count(); cnt > 0 {
		_ = nextPageBtn.Click()
	}
	remBtn := h.Page.Locator(`button[data-remove-pilot="11"]`).First()
	h.MustBeVisible(remBtn, "Remove NightHawk button")
	if err := remBtn.Click(); err != nil {
		t.Fatalf("click remove-pilot 11: %v", err)
	}
	h.WaitUntil("back to 10 pilots after removing slot 11", 5*time.Second, func() (bool, error) {
		return len(h.APIState().Pilots) == 10, nil
	})
	if got := len(h.APIState().Pilots); got != 10 {
		t.Fatalf("expected /api/state pilot count=10 after UI removal, got %d", got)
	}
	h.MilestoneScreenshot("pilot-slots-removed")
}

func TestComponent_PilotSlotsEditorHardwareModeColumns(t *testing.T) {
	// 1. Default SlapRF mode renders Pilot, Phonetic name, and Default channel columns (thresholds hidden).
	h := NewHarness(t)
	h.BootClean("#/pilots")

	headRow := h.Page.Locator(`.slot-head`).First()
	h.MustContainText(headRow, "Pilot")
	h.MustContainText(headRow, "Phonetic name")
	h.MustContainText(headRow, "Default channel")
	h.MilestoneScreenshot("pilot-slots-slaprf-columns")

	// 2. Pre-seeded LapRF mode renders the same clean directory columns without threshold inputs.
	h.BootWithSnapshot(SnapshotLapRFModeSeeded, "#/pilots", nil)
	headRowLapRF := h.Page.Locator(`.slot-head`).First()
	h.MustContainText(headRowLapRF, "Pilot")
	h.MustContainText(headRowLapRF, "Default channel")
	stLapRF := h.APIState()
	if string(stLapRF.TimingHardwareMode) != "laprf" {
		t.Fatalf("expected /api/state mode=laprf, got mode=%s", stLapRF.TimingHardwareMode)
	}
	h.MilestoneScreenshot("pilot-slots-laprf-columns")
}

func TestComponent_TrackEditorMakeStartFlagCycle(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/track")

	// Initially 4 gates on the course line; click [data-make-start] on the 2nd gate node.
	items := h.Page.Locator(`.gate-line-item[data-gate]`)
	h.WaitUntil("4 gate nodes on course line", 5*time.Second, func() (bool, error) {
		cnt, err := items.Count()
		return err == nil && cnt == 4, nil
	})

	secondGate := items.Nth(1)
	secondGateID, err := secondGate.GetAttribute("data-gate")
	if err != nil || secondGateID == "" {
		t.Fatalf("read 2nd gate data-gate: %v", err)
	}

	makeStartBtn := secondGate.Locator(`[data-make-start]`).First()
	h.MustBeVisible(makeStartBtn, "2nd gate checkered flag make-start button")
	if err := makeStartBtn.Click(); err != nil {
		t.Fatalf("click make-start on gate %s: %v", secondGateID, err)
	}

	// Clicking [data-make-start] sets role=START_FINISH on the clicked gate in place (.is-start moves to secondGate)!
	h.WaitUntil("clicked gate becomes the active start/finish timer on track line", 5*time.Second, func() (bool, error) {
		pressed, gErr := makeStartBtn.GetAttribute("aria-pressed")
		firstCls, fErr := items.First().GetAttribute("class")
		return gErr == nil && fErr == nil && pressed == "true" && !containsStr(firstCls, "is-start"), nil
	})
	stTrack := h.APIState()
	if len(stTrack.Gates) != 4 || string(stTrack.Gates[1].Role) != "START_FINISH" {
		t.Fatalf("expected /api/state Gates[1].Role=START_FINISH, got %+v", stTrack.Gates)
	}
	h.MilestoneScreenshot("track-editor-cycled-start-gate")
}

func TestComponent_TrackEditorDragGateOffToUnassignedAndBack(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/track")

	items := h.Page.Locator(`.gate-line-item[data-gate]`)
	h.WaitUntil("4 gate nodes on course line", 5*time.Second, func() (bool, error) {
		cnt, err := items.Count()
		return err == nil && cnt == 4, nil
	})

	// Drag the last gate circle down onto [data-unassigned-tray] to unassign it from the track.
	lastCircle := items.Nth(3).Locator(`.gate-node-circle`).First()
	tray := h.Page.Locator(`[data-unassigned-tray]`).First()
	h.MustBeVisible(lastCircle, "4th gate circle")
	h.MustBeVisible(tray, "Unassigned Timers tray")

	cBox, err := lastCircle.BoundingBox()
	if err != nil || cBox == nil {
		t.Fatalf("BoundingBox lastCircle: %v", err)
	}
	tBox, err := tray.BoundingBox()
	if err != nil || tBox == nil {
		t.Fatalf("BoundingBox tray: %v", err)
	}

	startX := cBox.X + cBox.Width/2
	startY := cBox.Y + cBox.Height/2
	endX := tBox.X + tBox.Width/2
	endY := tBox.Y + tBox.Height/2

	if err := h.Page.Mouse().Move(startX, startY); err != nil {
		t.Fatalf("mouse move start: %v", err)
	}
	if err := h.Page.Mouse().Down(); err != nil {
		t.Fatalf("mouse down: %v", err)
	}
	if err := h.Page.Mouse().Move(endX, endY); err != nil {
		t.Fatalf("mouse move tray: %v", err)
	}
	// Nudge once inside tray so >5px threshold & insideTray check fire deterministically.
	_ = h.Page.Mouse().Move(endX+8, endY+4)
	if err := h.Page.Mouse().Up(); err != nil {
		t.Fatalf("mouse up: %v", err)
	}

	h.WaitUntil("course reduced to 3 gate nodes after unassign drop", 5*time.Second, func() (bool, error) {
		cnt, gErr := items.Count()
		return gErr == nil && cnt == 3, nil
	})
	if got := len(h.APIState().Gates); got != 3 {
		t.Fatalf("expected /api/state to report 3 gates after unassign drop, got %d", got)
	}
	h.MilestoneScreenshot("track-editor-unassigned-gate")

	// Drag an unassigned spoke token back up onto the course line -> back to 4 gate nodes!
	spokeToken := tray.Locator(`.unassigned-timer-token[data-timer-id]:not([data-timer-id="1"])`).First()
	h.MustBeVisible(spokeToken, "Unassigned spoke timer token in tray")
	tokBox, err := spokeToken.BoundingBox()
	if err != nil || tokBox == nil {
		t.Fatalf("BoundingBox spokeToken: %v", err)
	}
	lineEl := h.Page.Locator(`.gate-track-line, .gate-line-item[data-gate]`).First()
	lBox, err := lineEl.BoundingBox()
	if err != nil || lBox == nil {
		t.Fatalf("BoundingBox track line: %v", err)
	}

	_ = h.Page.Mouse().Move(tokBox.X+tokBox.Width/2, tokBox.Y+tokBox.Height/2)
	_ = h.Page.Mouse().Down()
	_ = h.Page.Mouse().Move(lBox.X+lBox.Width/2, lBox.Y+24)
	_ = h.Page.Mouse().Move(lBox.X+lBox.Width/2+6, lBox.Y+24)
	_ = h.Page.Mouse().Up()

	h.WaitUntil("course restored to 4 gate nodes after dragging token onto line", 5*time.Second, func() (bool, error) {
		cnt, gErr := items.Count()
		return gErr == nil && cnt == 4, nil
	})
	h.MilestoneScreenshot("track-editor-reassigned-gate")
}

func TestComponent_TimingRulesEditorGlobalEditInlineResetAndPerGateOverride(t *testing.T) {
	h := NewHarness(t)
	// SnapshotPracticePopulated includes FilteredDetection records so filter counters render nonzero!
	h.BootWithSnapshot(SnapshotPracticePopulated, "#/setup/timing-rules", nil)

	minLapCount := h.Page.Locator(`[data-count="MIN_LAP"]`).First()
	h.MustContainText(minLapCount, "2")

	// 1. Global edit on minLapSec -> inline [data-reset-global="minLapSec"] appears -> click to reset.
	minLapInput := h.Page.Locator(`form.rules input[name="minLapSec"]`).First()
	h.MustBeVisible(minLapInput, "Global minLapSec input")
	if err := minLapInput.Fill("8.5"); err != nil {
		t.Fatalf("fill minLapSec=8.5: %v", err)
	}
	if err := minLapInput.Press("Enter"); err != nil {
		t.Fatalf("press Enter on minLapSec: %v", err)
	}

	resetGlobalBtn := h.Page.Locator(`button[data-reset-global="minLapSec"]`).First()
	h.MustBeVisible(resetGlobalBtn, "Inline reset button for modified global minLapSec")
	h.MilestoneScreenshot("timing-rules-global-modified")

	if err := resetGlobalBtn.Click(); err != nil {
		t.Fatalf("click data-reset-global=minLapSec: %v", err)
	}
	h.WaitUntil("minLapSec reset back to default 5", 5*time.Second, func() (bool, error) {
		val, err := minLapInput.InputValue()
		return err == nil && (val == "5" || val == "5.0"), nil
	})

	// 2. Switch scope to Gate 2 and toggle per-gate override on minCrossingSec.
	gate2ScopeBtn := h.Page.Locator(`button[data-scope="2"]`).First()
	h.MustBeVisible(gate2ScopeBtn, "Gate 2 scope tab in TimingRulesEditor")
	if err := gate2ScopeBtn.Click(); err != nil {
		t.Fatalf("click Gate 2 scope: %v", err)
	}

	overrideToggle := h.Page.Locator(`button[data-override-toggle="minCrossingSec"]`).First()
	h.MustBeVisible(overrideToggle, "Gate 2 minCrossingSec override toggle")
	if err := overrideToggle.Click(); err != nil {
		t.Fatalf("click minCrossingSec override toggle: %v", err)
	}

	crossInput := h.Page.Locator(`form.rules input[name="minCrossingSec"]`).First()
	h.WaitUntil("minCrossingSec input enabled for Gate 2 override", 5*time.Second, func() (bool, error) {
		dis, err := crossInput.IsDisabled()
		return err == nil && !dis, nil
	})
	if err := crossInput.Fill("0.25"); err != nil {
		t.Fatalf("fill minCrossingSec=0.25: %v", err)
	}
	if err := crossInput.Press("Enter"); err != nil {
		t.Fatalf("press Enter on minCrossingSec: %v", err)
	}
	h.WaitUntil("/api/state Gate 2 rule override minCrossingSec=0.25 saved", 5*time.Second, func() (bool, error) {
		for _, g := range h.APIState().Gates {
			if g.GateID == 2 && g.RuleOverrides.MinCrossingSec != nil && *g.RuleOverrides.MinCrossingSec == 0.25 {
				return true, nil
			}
		}
		return false, nil
	})
	if r := h.APIRules(); r.MinLapSec != 5.0 {
		t.Fatalf("expected global /api/rules MinLapSec=5.0 after reset, got %v", r.MinLapSec)
	}
	h.MilestoneScreenshot("timing-rules-gate2-override")
}

func TestComponent_AnnouncerSettingsControlsSlidersAndReset(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/setup/announcer")

	annHost := h.Page.Locator(`[data-slot="announcer"]`).First()
	h.MustBeVisible(annHost, "AnnouncerSettings card")

	lapCalloutsSwitch := annHost.Locator(`label.switch:has(input[name="raceLapCallouts"])`).First()
	lapCalloutsChk := annHost.Locator(`input[name="raceLapCallouts"]`).First()
	h.MustBeVisible(lapCalloutsSwitch, "Race lap callouts switch")
	wasChecked, _ := lapCalloutsChk.IsChecked()
	if err := lapCalloutsSwitch.Click(); err != nil {
		t.Fatalf("toggle raceLapCallouts: %v", err)
	}
	h.WaitUntil("raceLapCallouts toggled", 5*time.Second, func() (bool, error) {
		nowChecked, err := lapCalloutsChk.IsChecked()
		return err == nil && nowChecked != wasChecked, nil
	})

	// Customize TTS speed slider and sample testPhrase, then click Restore defaults in TTS card.
	if _, err := h.Page.Evaluate(`() => {
		const r = document.querySelector('[data-slot="announcer"] input[name="rate"]');
		if (r) {
			r.value = "1.35";
			r.dispatchEvent(new Event("input", { bubbles: true }));
			r.dispatchEvent(new Event("change", { bubbles: true }));
		}
	}`); err != nil {
		t.Fatalf("set rate=1.35: %v", err)
	}
	h.MustContainText(annHost.Locator(`[data-out="rate"]`).First(), "1.35")

	phraseInput := annHost.Locator(`input[name="testPhrase"]`).First()
	if err := phraseInput.Fill("Maverick lap one thirteen point four"); err != nil {
		t.Fatalf("fill testPhrase: %v", err)
	}
	if err := phraseInput.Press("Enter"); err != nil {
		t.Fatalf("press Enter on testPhrase: %v", err)
	}
	h.MilestoneScreenshot("announcer-settings-customized")

	// Restore voice defaults and verify speed (1.00×) and custom phrase reset cleanly.
	restoreBtn := annHost.Locator(`button[data-action="restore-defaults"]`).First()
	h.MustBeVisible(restoreBtn, "Announcer Restore defaults button")
	if err := restoreBtn.Click(); err != nil {
		t.Fatalf("click restore-defaults: %v", err)
	}
	h.MustContainText(annHost.Locator(`[data-out="rate"]`).First(), "1.00")
	h.WaitUntil("custom testPhrase inline reset button cleared", 5*time.Second, func() (bool, error) {
		cnt, err := annHost.Locator(`button[data-action="reset-phrase"]`).Count()
		return err == nil && cnt == 0, nil
	})
}

func TestComponent_DataSourceCardExportBackupAndWipeModal(t *testing.T) {
	h := NewHarness(t)
	h.BootWithSnapshot(SnapshotPracticePopulated, "#/setup/persistence", nil)

	exportBtn := h.Page.Locator(`button[data-action="export-data"]`).First()
	wipeBtn := h.Page.Locator(`button[data-action="wipe-data"]`).First()
	h.MustBeVisible(exportBtn, "Export backup button")
	h.MustBeVisible(wipeBtn, "Wipe application data button")

	// 1. Click Export backup and intercept the browser download!
	dl, err := h.Page.ExpectDownload(func() error {
		return exportBtn.Click()
	})
	if err != nil {
		t.Fatalf("ExpectDownload on Export backup failed: %v", err)
	}
	if dl.SuggestedFilename() == "" {
		t.Fatalf("expected non-empty backup download filename")
	}

	// 2. Click Wipe application data -> unified ConfirmModal opens -> Cancel first (keeps seeded laps),
	// then reopen and click Wipe Data (wipes back to 0 laps)!
	backdrop := h.Page.Locator(`.slaprf-modal-backdrop`).First()

	if err := wipeBtn.Click(); err != nil {
		t.Fatalf("click wipe-data (cancel): %v", err)
	}
	h.MustBeVisible(backdrop, "Wipe Application Data modal")
	h.MustContainText(backdrop, "Wipe Application Data?")
	h.MilestoneScreenshot("persistence-wipe-modal-open")

	if err := backdrop.Locator(`button[data-modal-cancel]`).Last().Click(); err != nil {
		t.Fatalf("click [data-modal-cancel] on wipe modal: %v", err)
	}
	h.MustBeHidden(backdrop, "Wipe modal closed after Cancel")
	if got := len(h.APIState().Laps); got == 0 {
		t.Fatalf("expected seeded laps to remain after cancelling wipe modal, got 0")
	}

	if err := wipeBtn.Click(); err != nil {
		t.Fatalf("click wipe-data (confirm): %v", err)
	}
	h.MustBeVisible(backdrop, "Wipe Application Data modal reopened")
	if err := backdrop.Locator(`button[data-modal-confirm]`).First().Click(); err != nil {
		t.Fatalf("click [data-modal-confirm] on wipe modal: %v", err)
	}
	h.MustBeHidden(backdrop, "Wipe modal closed after Confirm")
	h.WaitUntil("recorded laps wiped to 0 after confirming wipe", 5*time.Second, func() (bool, error) {
		return len(h.APIState().Laps) == 0, nil
	})
	h.MilestoneScreenshot("persistence-wiped-clean")
}

func TestComponent_AboutViewVersionInfoAndLicenseSwitcher(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/about")

	gplBtn := h.Page.Locator(`button[data-select-license="gpl"]`).First()
	fairBtn := h.Page.Locator(`button[data-select-license="fair-source"]`).First()
	h.MustBeVisible(gplBtn, "GPLv3 license tab")
	h.MustBeVisible(fairBtn, "Fair Source license tab")

	if err := fairBtn.Click(); err != nil {
		t.Fatalf("click Fair Source tab: %v", err)
	}
	h.MustContainText(h.Page.Locator(`main, #outlet, #app`).First(), "Fair Source")
	h.MilestoneScreenshot("about-fair-source-license")

	if err := gplBtn.Click(); err != nil {
		t.Fatalf("click GPLv3 tab: %v", err)
	}
	h.MustContainText(h.Page.Locator(`main, #outlet, #app`).First(), "GNU General Public License")
}
