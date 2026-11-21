//go:build e2e

package e2e_test

import (
	"strings"
	"testing"
	"time"
)

func TestComponent_PracticeDirectorySearchStatusAndTagFilters(t *testing.T) {
	h := NewHarness(t)
	h.BootWithSnapshot(SnapshotPracticePopulated, "#/practice", nil)

	// Baseline: 3 sessions ("Evening Lap Lab", "Warmup Pack", "Hover Check")
	h.WaitUntil("3 practice session rows rendered", 5*time.Second, func() (bool, error) {
		cnt, err := h.Page.Locator(`tr[data-session-row]`).Count()
		return err == nil && cnt == 3, nil
	})

	// 1. Status filter: "live" -> 1 row ("Evening Lap Lab")
	if err := h.Page.Locator(`button[data-session-dir-status="live"]`).Click(); err != nil {
		t.Fatalf("click status=live: %v", err)
	}
	h.WaitUntil("1 live session row", 5*time.Second, func() (bool, error) {
		cnt, err := h.Page.Locator(`tr[data-session-row]`).Count()
		return err == nil && cnt == 1, nil
	})
	h.MustBeVisible(h.Page.Locator(`tr[data-session-row="session-1"]`).First(), "Evening Lap Lab row")

	// 2. Status filter: "laps" -> 2 rows ("Evening Lap Lab" + "Warmup Pack"; excludes 0-lap "Hover Check")
	if err := h.Page.Locator(`button[data-session-dir-status="laps"]`).Click(); err != nil {
		t.Fatalf("click status=laps: %v", err)
	}
	h.WaitUntil("2 sessions with laps", 5*time.Second, func() (bool, error) {
		cnt, err := h.Page.Locator(`tr[data-session-row]`).Count()
		return err == nil && cnt == 2, nil
	})

	// 3. Reset status to "all", then filter by tag "#Whoop" via search input -> 1 row ("Warmup Pack")
	if err := h.Page.Locator(`button[data-session-dir-status="all"]`).Click(); err != nil {
		t.Fatalf("click status=all: %v", err)
	}
	searchInput := h.Page.Locator(`input[data-session-dir-search]`).First()
	if err := searchInput.Fill("#Whoop"); err != nil {
		t.Fatalf("search #Whoop tag: %v", err)
	}
	h.WaitUntil("1 session matching tag #Whoop", 5*time.Second, func() (bool, error) {
		cnt, err := h.Page.Locator(`tr[data-session-row]`).Count()
		return err == nil && cnt == 1, nil
	})
	h.MustBeVisible(h.Page.Locator(`tr[data-session-row="session-2"]`).First(), "Warmup Pack row")
	h.MilestoneScreenshot("practice-dir-tag-filtered")

	// 4. Search query with zero matches -> empty state with "Show all (3)" reset button
	if err := searchInput.Fill("NonExistentSessionXYZ"); err != nil {
		t.Fatalf("fill search: %v", err)
	}
	resetBtn := h.Page.Locator(`button[data-tag-filter="__reset_all__"]`).First()
	h.MustBeVisible(resetBtn, "Show all / Clear filters button")
	if err := resetBtn.Click(); err != nil {
		t.Fatalf("click reset filters: %v", err)
	}
	h.WaitUntil("all 3 sessions restored after reset", 5*time.Second, func() (bool, error) {
		cnt, err := h.Page.Locator(`tr[data-session-row]`).Count()
		return err == nil && cnt == 3, nil
	})

	// 6. Verify "+ Add" sits immediately to the right of "Search or add practice..." with matching 32px height,
	// and pressing Enter creates a practice session with the typed name.
	barOK, err := h.Page.Evaluate(`() => {
		const inp = document.querySelector("input[data-session-dir-search]");
		const btn = document.querySelector('button[data-practice-act="create-session-inline"]');
		if (!inp || !btn) return false;
		const ir = inp.getBoundingClientRect();
		const br = btn.getBoundingClientRect();
		return inp.getAttribute("placeholder") === "Search or add practice..." &&
			Math.abs(ir.height - 32) <= 2 &&
			Math.abs(br.height - 32) <= 2 &&
			br.left >= ir.right &&
			(br.left - ir.right) <= 16;
	}`)
	if err != nil || barOK != true {
		t.Fatalf("expected Practice search input and + Add button side-by-side at 32px height: err=%v barOK=%v", err, barOK)
	}
	if err := searchInput.Fill("Morning Gate Drill"); err != nil {
		t.Fatalf("fill Morning Gate Drill: %v", err)
	}
	if err := searchInput.Press("Enter"); err != nil {
		t.Fatalf("press Enter to add practice session: %v", err)
	}
	h.WaitUntil("4 practice sessions including Morning Gate Drill", 5*time.Second, func() (bool, error) {
		cnt, err := h.Page.Locator(`tr[data-session-row]`).Count()
		return err == nil && cnt == 4, nil
	})
	h.MustContainText(h.Page.Locator(`[data-session-dir-results]`).First(), "Morning Gate Drill")
}

func TestComponent_PracticeDirectoryInlineRename(t *testing.T) {
	h := NewHarness(t)
	h.BootWithSnapshot(SnapshotPracticePopulated, "#/practice", nil)

	renameBtn := h.Page.Locator(`button[data-practice-act="edit-session-name"][data-session-id="session-2"]`).First()
	h.MustBeVisible(renameBtn, "Edit session name button for Warmup Pack")

	// 1. Open inline rename, type draft, press Escape -> reverts cleanly.
	if err := renameBtn.Click(); err != nil {
		t.Fatalf("click edit-session-name (1): %v", err)
	}
	nameInput := h.Page.Locator(`input[data-session-name-input]`).First()
	h.MustBeVisible(nameInput, "Inline session name input")
	if err := nameInput.Fill("Aborted Rename"); err != nil {
		t.Fatalf("fill aborted name: %v", err)
	}
	if err := nameInput.Press("Escape"); err != nil {
		t.Fatalf("press Escape: %v", err)
	}
	h.MustContainText(h.Page.Locator(`tr[data-session-row="session-2"]`).First(), "Warmup Pack")

	// 2. Open inline rename, fill "Morning Tuning", press Enter -> commits and updates row.
	if err := renameBtn.Click(); err != nil {
		t.Fatalf("click edit-session-name (2): %v", err)
	}
	h.MustBeVisible(nameInput, "Inline session name input reopened")
	if err := nameInput.Fill("Morning Tuning"); err != nil {
		t.Fatalf("fill Morning Tuning: %v", err)
	}
	if err := nameInput.Press("Enter"); err != nil {
		t.Fatalf("press Enter: %v", err)
	}
	h.MustContainText(h.Page.Locator(`tr[data-session-row="session-2"]`).First(), "Morning Tuning")
	stRenamed := h.APIState()
	foundSession2 := false
	for _, s := range stRenamed.PracticeState.Sessions {
		if s.SessionID == "session-2" && s.Name == "Morning Tuning" {
			foundSession2 = true
		}
	}
	if !foundSession2 {
		t.Fatalf("expected /v1/state PracticeState session-2 renamed to Morning Tuning")
	}
	h.MilestoneScreenshot("practice-dir-inline-renamed")
}

func TestComponent_PilotPickerChipsAllTabAndSelection(t *testing.T) {
	h := NewHarness(t)
	h.BootWithSnapshot(SnapshotPracticePopulated, "#/practice/evening-lap-lab", nil)

	// Switch to Trends tab on the unified Practice ribbon (shows All + Pilot chips, LapTimesCard, and SectionRecords).
	trendsTab := h.Page.Locator(`button[data-practice-mobile-tab="trends"]`).First()
	h.MustBeVisible(trendsTab, "Practice Trends ribbon tab")
	if err := trendsTab.Click(); err != nil {
		t.Fatalf("click Trends tab: %v", err)
	}

	picker := h.Page.Locator(`.pilot-picker`).First()
	h.MustBeVisible(picker, "PilotPicker bar in Practice Trends tab")

	allChip := picker.Locator(`button[data-pilot="all"]`).First()
	pilot1Chip := picker.Locator(`button[data-pilot="1"]`).First()
	pilot2Chip := picker.Locator(`button[data-pilot="2"]`).First()

	h.MustBeVisible(allChip, "All pilots chip")
	h.MustBeVisible(pilot1Chip, "Pilot 1 (FAERRY) chip")
	h.MustContainText(pilot1Chip, "FAERRY")
	h.MustContainText(pilot1Chip, "6 laps")

	// Click Pilot 2 chip -> switches workspace from AllPilotsPanel to single-pilot PilotPanel while keeping SectionRecords visible on Trends.
	if err := pilot2Chip.Click(); err != nil {
		t.Fatalf("click Pilot 2 chip: %v", err)
	}
	h.WaitUntil("Pilot 2 chip marked aria-selected=true", 5*time.Second, func() (bool, error) {
		val, err := pilot2Chip.GetAttribute("aria-selected")
		return err == nil && val == "true", nil
	})
	h.MustBeVisible(h.Page.Locator(`.practice-desktop-sections-card`).First(), "SectionRecords card remains visible on Trends for single pilot")
	h.MilestoneScreenshot("pilot-picker-selected-slot2")

	// Click All chip -> returns to AllPilotsPanel; switch back to Overview to see LiveStandings table.
	if err := allChip.Click(); err != nil {
		t.Fatalf("click All chip: %v", err)
	}
	if err := h.Page.Locator(`button[data-practice-mobile-tab="overview"]`).First().Click(); err != nil {
		t.Fatalf("click Overview tab: %v", err)
	}
	h.MustBeVisible(h.Page.Locator(`table.table-standings`).First(), "LiveStandings table on Overview tab")
}

func TestComponent_PracticePilotAssignmentPopover(t *testing.T) {
	h := NewHarness(t)
	h.BootWithSnapshot(SnapshotPracticePopulated, "#/practice/evening-lap-lab", nil)

	pilotsTab := h.Page.Locator(`button[data-practice-mobile-tab="pilots"]`).First()
	h.MustBeVisible(pilotsTab, "Practice Pilots ribbon tab")
	if err := pilotsTab.Click(); err != nil {
		t.Fatalf("click Pilots tab: %v", err)
	}

	pilotsCard := h.Page.Locator(`.practice-mobile-pilots-card`).First()
	h.MustBeVisible(pilotsCard, "Centered Practice Pilots card on Desktop")
	h.MustContainText(pilotsCard, "4 in session")
	time.Sleep(220 * time.Millisecond)
	h.MilestoneScreenshot("practice-pilot-popover-open")

	// Search and toggle global Pilot 5 ("Red5") ON in this session.
	searchInput := pilotsCard.Locator(`input[data-new-session-pilot-input]`).First()
	if err := searchInput.Fill("Red5"); err != nil {
		t.Fatalf("fill Red5: %v", err)
	}
	togglePilot5Btn := pilotsCard.Locator(`button[data-practice-act="toggle-session-pilot"][data-slot-index="5"]`).First()
	h.MustBeVisible(togglePilot5Btn, "Toggle Red5 into session switch")
	if err := togglePilot5Btn.Click(); err != nil {
		t.Fatalf("click toggle Red5: %v", err)
	}

	h.MustContainText(pilotsCard, "5 in session")

	// Remove Pilot 4 ("BigRamon") from session -> recorded laps stay preserved!
	if err := searchInput.Fill(""); err != nil {
		t.Fatalf("clear pilots search: %v", err)
	}
	togglePilot4Btn := pilotsCard.Locator(`button[data-practice-act="toggle-session-pilot"][data-slot-index="4"]`).First()
	h.MustBeVisible(togglePilot4Btn, "Toggle BigRamon out of session switch")
	if err := togglePilot4Btn.Click(); err != nil {
		t.Fatalf("click toggle BigRamon: %v", err)
	}
	h.MustContainText(pilotsCard, "4 in session")
	stPop := h.APIState()
	for _, s := range stPop.PracticeState.Sessions {
		if s.SessionID == "session-1" {
			hasRed5 := false
			hasBigRamon := false
			for _, sp := range s.Pilots {
				if sp.SlotIndex == 5 {
					hasRed5 = true
				}
				if sp.SlotIndex == 4 {
					hasBigRamon = true
				}
			}
			if !hasRed5 || hasBigRamon {
				t.Fatalf("expected /v1/state session-1 pilots to include Red5 (5) and exclude BigRamon (4), got %+v", s.Pilots)
			}
		}
	}
	// Switch to Laps tab and verify Red5 chip is in PilotPicker while All chip is hidden on Laps!
	if err := h.Page.Locator(`button[data-practice-mobile-tab="laps"]`).First().Click(); err != nil {
		t.Fatalf("click Laps tab: %v", err)
	}
	h.MustBeVisible(h.Page.Locator(`.pilot-picker button[data-pilot="5"]`).First(), "Red5 chip added to PilotPicker on Laps tab")
	h.MustBeHidden(h.Page.Locator(`.pilot-picker button[data-pilot="all"]`).First(), "All chip hidden on Laps tab")
	h.MilestoneScreenshot("practice-pilot-popover-updated")
}

func TestComponent_LiveStandingsRankingGapsSparklinesAndRowClick(t *testing.T) {
	h := NewHarness(t)
	h.BootWithSnapshot(SnapshotPracticePopulated, "#/practice/evening-lap-lab", nil)

	table := h.Page.Locator(`table.table-standings`).First()
	h.MustBeVisible(table, "LiveStandings leaderboard table")

	// Verify 4 ranked pilot rows ordered fastest best lap first:
	// 1st: Slot 1 (FAERRY, 13.42s), 2nd: Slot 2 (MeWo, +0.26s), 3rd: Slot 3 (Din, +0.49s), 4th: Slot 4 (BigRamon, +0.93s).
	firstRow := table.Locator(`tbody tr[data-pilot]`).First()
	pAttr, err := firstRow.GetAttribute("data-pilot")
	if err != nil || pAttr != "1" {
		t.Fatalf("expected P1 row to be data-pilot=1 (FAERRY), got %q (err=%v)", pAttr, err)
	}
	h.MustContainText(firstRow, "FAERRY")
	h.MustContainText(firstRow, "13.42")

	secondRow := table.Locator(`tbody tr[data-pilot="2"]`).First()
	h.MustContainText(secondRow, "MeWo")
	h.MustContainText(secondRow, "+0.26")

	// Verify inline SVG pace sparkline rendered inside rows.
	sparkCnt, _ := table.Locator(`svg`).Count()
	if sparkCnt == 0 {
		t.Fatalf("expected inline pace sparkline SVGs in LiveStandings rows")
	}
	h.MilestoneScreenshot("live-standings-leaderboard")

	// Clicking MeWo's row drills down to Laps tab focused on Pilot 2 in PilotPicker!
	if err := secondRow.Click(); err != nil {
		t.Fatalf("click P2 standings row: %v", err)
	}
	h.WaitUntil("Laps tab activates and PilotPicker selects slot 2 on standings row click", 5*time.Second, func() (bool, error) {
		sel, err := h.Page.Locator(`.pilot-picker button[data-pilot="2"]`).First().GetAttribute("aria-selected")
		if err != nil || sel != "true" {
			return false, nil
		}
		view, err := h.Page.Locator(`.practice-workspace-page`).First().GetAttribute("data-mobile-practice-view")
		return err == nil && view == "laps", nil
	})
	h.MustBeVisible(h.Page.Locator(`.practice-desktop-laps-card`).First(), "Pilot Laps card visible on Desktop Laps tab")
	h.MustContainText(h.Page.Locator(`[data-slot="stats"]`).First(), "13.680")

	// Verify Desktop Practice Laps table has the Time column and check-mark toggle buttons.
	lapsCard := h.Page.Locator(`.practice-desktop-laps-card`).First()
	h.MustBeVisible(lapsCard.Locator(`th.col-lap-clock`).First(), "Desktop Laps table Time column header")

	// Cross out MeWo's fastest lap (13.680s, Lap 2 / lapId 6) by clicking its check toggle.
	toggleLap6 := lapsCard.Locator(`button[data-practice-toggle-lap="6"]`).First()
	h.MustBeVisible(toggleLap6, "Lap 6 valid check toggle button")
	if err := toggleLap6.Click(); err != nil {
		t.Fatalf("click toggle lap 6 off: %v", err)
	}
	h.WaitUntil("Lap 6 row crossed out and Best lap KPI updates to next-best 13.740", 5*time.Second, func() (bool, error) {
		checked, err := lapsCard.Locator(`button[data-practice-toggle-lap="6"]`).First().GetAttribute("aria-checked")
		if err != nil || checked != "false" {
			return false, nil
		}
		txt, err := h.Page.Locator(`[data-slot="stats"]`).First().TextContent()
		return err == nil && strings.Contains(txt, "13.740"), nil
	})

	// Click the toggle again to restore Lap 6 and verify Best lap KPI returns to 13.680.
	if err := lapsCard.Locator(`button[data-practice-toggle-lap="6"]`).First().Click(); err != nil {
		t.Fatalf("click toggle lap 6 back on: %v", err)
	}
	h.WaitUntil("Lap 6 restored and Best lap KPI returns to 13.680", 5*time.Second, func() (bool, error) {
		checked, err := lapsCard.Locator(`button[data-practice-toggle-lap="6"]`).First().GetAttribute("aria-checked")
		if err != nil || checked != "true" {
			return false, nil
		}
		txt, err := h.Page.Locator(`[data-slot="stats"]`).First().TextContent()
		return err == nil && strings.Contains(txt, "13.680"), nil
	})
	time.Sleep(220 * time.Millisecond)
	h.MilestoneScreenshot("live-standings-drilled-into-mewo-laps")
}

func TestComponent_SectionRecordsMatrixPurpleRecordAndDeltas(t *testing.T) {
	h := NewHarness(t)
	h.BootWithSnapshot(SnapshotPracticePopulated, "#/practice/evening-lap-lab", nil)

	if err := h.Page.Locator(`button[data-practice-mobile-tab="trends"]`).First().Click(); err != nil {
		t.Fatalf("click Trends tab: %v", err)
	}

	// SectionRecords renders overall purple cells (.split-purple) for each section's record holder:
	// S1 -> FAERRY (2.95), S2 -> MeWo (3.12), S3 -> FAERRY (3.18), S4 -> Din (3.21).
	purpleCells := h.Page.Locator(`.split-purple`)
	h.WaitUntil("4 overall purple section record badges rendered", 5*time.Second, func() (bool, error) {
		cnt, err := purpleCells.Count()
		return err == nil && cnt >= 4, nil
	})

	allPurpleText, err := h.Page.Evaluate(`() => Array.from(document.querySelectorAll(".split-purple")).map(el => el.textContent || "").join(" | ")`)
	if err != nil {
		t.Fatalf("read .split-purple texts: %v", err)
	}
	joined, _ := allPurpleText.(string)
	for _, expected := range []string{"2.95", "3.12", "3.18", "3.21"} {
		if !strings.Contains(joined, expected) {
			t.Fatalf("expected section record %s in .split-purple cells, got %q", expected, joined)
		}
	}
	h.MilestoneScreenshot("section-records-matrix-purple")
}

func TestComponent_LapTimesCardSectionTabsLegendFilterAndRestore(t *testing.T) {
	h := NewHarness(t)
	h.BootWithSnapshot(SnapshotPracticePopulated, "#/practice/evening-lap-lab", nil)

	if err := h.Page.Locator(`button[data-practice-mobile-tab="trends"]`).First().Click(); err != nil {
		t.Fatalf("click Trends tab: %v", err)
	}
	if err := h.Page.Locator(`.pilot-picker button[data-pilot="all"]`).First().Click(); err != nil {
		t.Fatalf("click All chip on Trends tab: %v", err)
	}

	viewsBar := h.Page.Locator(`[data-slot="views"]`).First()
	h.MustBeVisible(viewsBar, "LapTimesCard section/whole-lap tablist")

	secBtn := viewsBar.Locator(`button[data-view="section"]`).First()
	h.MustBeVisible(secBtn, "First section view tab in LapTimesCard")
	if err := secBtn.Click(); err != nil {
		t.Fatalf("click section tab: %v", err)
	}

	// Toggle pilot 1 legend visibility off.
	legendSlot1 := h.Page.Locator(`[data-legend-slot="1"]`).First()
	h.MustBeVisible(legendSlot1, "Pilot 1 chart legend toggle")
	if err := legendSlot1.Click(); err != nil {
		t.Fatalf("click legend slot 1: %v", err)
	}
	h.MilestoneScreenshot("lap-times-card-section-and-filtered")

	// Verify localStorage saved custom section view + hiddenSlots, then switch back to Whole lap and re-enable Pilot 1.
	h.WaitUntil("LapTimesCard prefs saved section view and hidden slot 1", 5*time.Second, func() (bool, error) {
		res, err := h.Page.Evaluate(`() => {
			const raw = localStorage.getItem("slaprf.ui.laptimes_all.v1");
			if (!raw) return false;
			const parsed = JSON.parse(raw);
			return parsed?.view?.kind === "section" && Array.isArray(parsed?.hiddenSlots) && parsed.hiddenSlots.includes(1);
		}`)
		if err != nil {
			return false, nil
		}
		ok, _ := res.(bool)
		return ok, nil
	})
	wholeLapBtn := viewsBar.Locator(`button[data-view="lap"]`).First()
	if err := wholeLapBtn.Click(); err != nil {
		t.Fatalf("click Whole lap tab: %v", err)
	}
	if err := legendSlot1.Click(); err != nil {
		t.Fatalf("re-enable legend slot 1: %v", err)
	}

	h.WaitUntil("LapTimesCard prefs reset to whole-lap with 0 hidden slots", 5*time.Second, func() (bool, error) {
		res, err := h.Page.Evaluate(`() => {
			const raw = localStorage.getItem("slaprf.ui.laptimes_all.v1");
			if (!raw) return true;
			const parsed = JSON.parse(raw);
			return parsed?.view?.kind === "lap" && Array.isArray(parsed?.hiddenSlots) && parsed.hiddenSlots.length === 0;
		}`)
		if err != nil {
			return false, nil
		}
		ok, _ := res.(bool)
		return ok, nil
	})
}
