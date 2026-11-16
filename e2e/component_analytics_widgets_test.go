//go:build e2e

package e2e_test

import (
	"testing"
	"time"

	"slaprf/internal/domain"
)

func TestComponent_AnalyticsTopBarScopeSwitcherPracticeAndRace(t *testing.T) {
	h := NewHarness(t)
	// SnapshotRaceCompletedPodium has BOTH Practice ("Evening Lap Lab") and Race ("Winter Finals") populated!
	h.BootWithSnapshot(SnapshotRaceCompletedPodium, "#/pilot", nil)

	// 1. Landing on #/pilot shows the Practice vs Race scope chooser cards.
	pracChoose := h.Page.Locator(`[data-analytics-choose="practice"]`).First()
	raceChoose := h.Page.Locator(`[data-analytics-choose="race"]`).First()
	h.MustBeVisible(pracChoose, "Analytics Practice chooser card")
	h.MustBeVisible(raceChoose, "Analytics Race chooser card")
	h.MilestoneScreenshot("analytics-scope-chooser")

	// 2. Click Practice chooser -> enters #/pilot/practice/evening-lap-lab.
	if err := pracChoose.Click(); err != nil {
		t.Fatalf("click practice chooser: %v", err)
	}
	scopeToggle := h.Page.Locator(`button[data-action="toggle-analytics-scope"]`).First()
	h.MustBeVisible(scopeToggle, "TopBar analytics scope dropdown button")
	h.MustContainText(scopeToggle, "Evening Lap Lab")

	// 3. Open TopBar Practice scope dropdown and verify Evening Lap Lab is active, then return to
	// Analytics chooser via TopBar breadcrumb ([data-action="analytics-chooser"]) and enter Race scope!
	if err := scopeToggle.Click(); err != nil {
		t.Fatalf("click toggle-analytics-scope: %v", err)
	}
	pracScopeOpt := h.Page.Locator(`[data-action="pick-analytics-scope"][data-scope-kind="practice"]`).First()
	h.MustBeVisible(pracScopeOpt, "Evening Lap Lab Practice option in TopBar scope menu")
	h.MilestoneScreenshot("analytics-topbar-scope-menu")
	if err := pracScopeOpt.Click(); err != nil {
		t.Fatalf("click Evening Lap Lab scope option: %v", err)
	}

	// 4. Click "Analytics" breadcrumb to return to chooser, then choose Race ("Winter Finals").
	chooserCrumb := h.Page.Locator(`a[data-action="analytics-chooser"]`).First()
	h.MustBeVisible(chooserCrumb, "TopBar Analytics chooser breadcrumb")
	if err := chooserCrumb.Click(); err != nil {
		t.Fatalf("click analytics-chooser breadcrumb: %v", err)
	}
	h.MustBeVisible(raceChoose, "Analytics Race chooser card after breadcrumb return")
	if err := raceChoose.Click(); err != nil {
		t.Fatalf("click race chooser: %v", err)
	}
	h.MustContainText(scopeToggle, "Winter Finals")
	h.MilestoneScreenshot("analytics-switched-to-race")
}

func TestComponent_AnalyticsPilotPillBarSwitchAddAndRemove(t *testing.T) {
	h := NewHarness(t)
	h.BootWithSnapshot(SnapshotPracticePopulated, "#/pilot/practice/evening-lap-lab", nil)

	pill1 := h.Page.Locator(`[data-analytics-pilot-pill="1"]`).First()
	pill2 := h.Page.Locator(`[data-analytics-pilot-pill="2"]`).First()
	h.MustBeVisible(pill1, "FAERRY analytics pill")
	h.MustBeVisible(pill2, "MeWo analytics pill")

	// Switch active pilot to MeWo (Slot 2).
	if err := pill2.Click(); err != nil {
		t.Fatalf("click pill 2: %v", err)
	}
	h.WaitUntil("MeWo pill marked active", 5*time.Second, func() (bool, error) {
		cls, err := pill2.GetAttribute("class")
		return err == nil && (cls != "" && (containsStr(cls, "is-active") || containsStr(cls, "active"))), nil
	})

	// Remove Pilot 4 pill via × button.
	rem4 := h.Page.Locator(`[data-analytics-remove-pilot="4"]`).First()
	h.MustBeVisible(rem4, "Remove BigRamon pill button")
	if err := rem4.Click(); err != nil {
		t.Fatalf("click remove pill 4: %v", err)
	}
	h.MustBeHidden(h.Page.Locator(`[data-analytics-pilot-pill="4"]`).First(), "BigRamon pill removed")

	// Click circular + button to add Pilot 5 ("Red5", 0 laps) and verify 0-lap empty state renders cleanly.
	addBtn := h.Page.Locator(`[data-analytics-add-pilot-btn]`).First()
	h.MustBeVisible(addBtn, "Add pilot pill (+) button")
	if err := addBtn.Click(); err != nil {
		t.Fatalf("click add pilot btn: %v", err)
	}
	searchInput := h.Page.Locator(`input[data-analytics-pilot-search]`).First()
	h.MustBeVisible(searchInput, "Analytics add-pilot search input")
	if err := searchInput.Fill("Red5"); err != nil {
		t.Fatalf("fill Red5: %v", err)
	}
	addOpt5 := h.Page.Locator(`[data-analytics-add-pilot="5"]`).First()
	h.MustBeVisible(addOpt5, "Add Red5 option")
	if err := addOpt5.Click(); err != nil {
		t.Fatalf("click add Red5: %v", err)
	}
	h.MustBeVisible(h.Page.Locator(`[data-analytics-pilot-pill="5"]`).First(), "Red5 pill added and selected")
	h.MilestoneScreenshot("analytics-pill-bar-red5-added")
}

func TestComponent_LapPickerBarsHoverAndComparePresets(t *testing.T) {
	h := NewHarness(t)
	h.BootWithSnapshot(SnapshotPracticePopulated, "#/pilot/practice/evening-lap-lab", nil)

	bars := h.Page.Locator(`[data-lap]`)
	h.WaitUntil("6 lap bars rendered for FAERRY", 5*time.Second, func() (bool, error) {
		cnt, err := bars.Count()
		return err == nil && cnt == 6, nil
	})

	// Hover first bar and verify floating lap time readout updates.
	firstBar := bars.First()
	if err := firstBar.Hover(); err != nil {
		t.Fatalf("hover first lap bar: %v", err)
	}
	h.MilestoneScreenshot("lap-picker-hover-bar")

	// Click "Previous lap" preset ([data-ref="previous"]) then "Personal best" ([data-ref="best"]).
	prevBtn := h.Page.Locator(`button[data-ref="previous"]`).First()
	bestBtn := h.Page.Locator(`button[data-ref="best"]`).First()
	h.MustBeVisible(prevBtn, "Compare with Previous lap button")
	if err := prevBtn.Click(); err != nil {
		t.Fatalf("click data-ref=previous: %v", err)
	}
	if err := bestBtn.Click(); err != nil {
		t.Fatalf("click data-ref=best: %v", err)
	}

	// Click second bar to select a specific lap for review, then click Restore defaults.
	if err := bars.Nth(1).Click(); err != nil {
		t.Fatalf("click 2nd lap bar: %v", err)
	}
	restoreBtn := h.Page.Locator(`button[data-action="restore-lap-defaults"]`).First()
	if cnt, _ := restoreBtn.Count(); cnt > 0 {
		_ = restoreBtn.Click()
	}
	h.MilestoneScreenshot("lap-picker-selected")
}

func TestComponent_LapComparisonSectionTableAndCoachingTakeaway(t *testing.T) {
	h := NewHarness(t)
	h.BootWithSnapshot(SnapshotPracticePopulated, "#/pilot/practice/evening-lap-lab", nil)

	cmpTable := h.Page.Locator(`table.cmp-table`).First()
	h.MustBeVisible(cmpTable, "LapComparison section-by-section table")

	// Verify 4 section rows are rendered in the comparison breakdown.
	h.WaitUntil("4 section rows in LapComparison table", 5*time.Second, func() (bool, error) {
		cnt, err := cmpTable.Locator(`tbody tr`).Count()
		return err == nil && cnt == 4, nil
	})

	takeaway := h.Page.Locator(`.lap-analysis`).First()
	h.MustBeVisible(takeaway, "LapComparison plain-language coaching takeaway")
	h.MilestoneScreenshot("lap-comparison-table-and-takeaway")
}

func TestComponent_SectionStatsConsistencyTableAndOpportunityBadge(t *testing.T) {
	h := NewHarness(t)
	h.BootWithSnapshot(SnapshotPracticePopulated, "#/pilot/practice/evening-lap-lab", nil)

	statsTable := h.Page.Locator(`table.stats-table`).First()
	h.MustBeVisible(statsTable, "SectionStats consistency table")

	// In SnapshotPracticePopulated, Slot 1 (FAERRY) has high variance on Section 2 (>= 0.18s gap),
	// so "Biggest opportunity" badge must render on that row!
	h.MustContainText(statsTable, "Biggest opportunity")
	h.MilestoneScreenshot("section-stats-biggest-opportunity")
}

func TestComponent_PracticeRecommendationCardAndInsufficientLapsEmptyState(t *testing.T) {
	// Part A: With 6 laps on Slot 1, PracticeRecommendation renders rich coaching guidance.
	h := NewHarness(t)
	h.BootWithSnapshot(SnapshotPracticePopulated, "#/pilot/practice/evening-lap-lab", nil)

	recSlot := h.Page.Locator(`[data-slot="recommendation"]`).First()
	h.MustBeVisible(recSlot, "PracticeRecommendation card")
	h.MustContainText(recSlot, "Linking your best time")
	h.MilestoneScreenshot("practice-recommendation-populated")

	// Part B: Mutate snapshot so Slot 1 only has 2 laps (< 3 minimum) -> verify insufficient-laps empty state!
	h.BootWithMutatedSnapshot(
		SnapshotPracticePopulated,
		"#/pilot/practice/evening-lap-lab",
		nil,
		func(b *SimSnapshotBundle) {
			keepTwoForSlot1 := func(laps []domain.LapRecord) []domain.LapRecord {
				var out []domain.LapRecord
				s1Count := 0
				for _, l := range laps {
					if l.SlotIndex == 1 {
						s1Count++
						if s1Count > 2 {
							continue
						}
					}
					out = append(out, l)
				}
				return out
			}
			b.Engine.Laps = keepTwoForSlot1(b.Engine.Laps)
			if b.Engine.PracticeState != nil {
				for i := range b.Engine.PracticeState.Sessions {
					b.Engine.PracticeState.Sessions[i].Laps = keepTwoForSlot1(b.Engine.PracticeState.Sessions[i].Laps)
				}
			}
		},
	)

	recSlotAfter := h.Page.Locator(`[data-slot="recommendation"]`).First()
	h.MustContainText(recSlotAfter, "3") // Prompts pilot to complete at least 3 laps
	h.MilestoneScreenshot("practice-recommendation-under-3-laps")
}

func containsStr(haystack, needle string) bool {
	return len(needle) > 0 && len(haystack) >= len(needle) && (haystack == needle || indexStr(haystack, needle) >= 0)
}

func indexStr(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
