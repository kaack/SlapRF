//go:build e2e

package e2e_test

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/playwright-community/playwright-go"
)

func TestMultiGPControlledRaceCreateImportFlyAndUpload(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/sim")
	h.ConnectSimHubH1()

	// Enable 20x simulation speed so heats complete in ~2 seconds.
	h.APIPost("/api/sim/speed", map[string]any{"speedMultiplier": 20}, nil)

	// Create a new simulated MultiGP Controlled race ("Wednesday Short Shootout") in the MultiGP Chapter pane.
	const raceTitle = "Wednesday Short Shootout"
	mgpNameInput := h.Page.Locator(`input[data-field="mgp-new-name"]`).First()
	h.MustBeVisible(mgpNameInput, "Simulated MultiGP new race name input")
	if err := mgpNameInput.Fill(raceTitle); err != nil {
		t.Fatalf("fill mgp-new-name: %v", err)
	}

	createMgpBtn := h.Page.Locator(`button[data-action="mgp-add-race"]`).First()
	h.MustBeVisible(createMgpBtn, "+ Create race button in MultiGP simulator")
	if err := createMgpBtn.Click(); err != nil {
		t.Fatalf("click + Create race: %v", err)
	}

	// Locate the newly created MultiGP race ID from simulated MultiGP state.
	var mgpRaceID int
	h.WaitUntil("newly created MultiGP race appears in simMultiGP", 10*time.Second, func() (bool, error) {
		var mgpSt struct {
			Races []struct {
				ID   int    `json:"id"`
				Name string `json:"name"`
			} `json:"races"`
		}
		if err := h.WasmGetJSON("/api/sim/mgp-admin", &mgpSt); err != nil {
			return false, nil
		}
		for _, r := range mgpSt.Races {
			if r.Name == raceTitle {
				mgpRaceID = r.ID
				return true, nil
			}
		}
		return false, nil
	})

	// Click "Edit" on the new MultiGP race row and trim it to 1 round / 1 heat via the UI editor!
	editBtn := h.Page.Locator(fmt.Sprintf(`button[data-action="mgp-toggle-results"][data-race-id="%d"]`, mgpRaceID)).First()
	h.MustBeVisible(editBtn, "Edit button on new MultiGP race")
	if err := editBtn.Click(); err != nil {
		t.Fatalf("click Edit on MultiGP race %d: %v", mgpRaceID, err)
	}

	editorPane := h.Page.Locator(fmt.Sprintf(`[data-testid="sim-mgp-editor-%d"]`, mgpRaceID)).First()
	h.MustBeVisible(editorPane, "Expanded MultiGP race inspector pane")

	// Trim rounds down to 1 round using the UI delete-round buttons if >1 round was generated.
	for attempt := 0; attempt < 6; attempt++ {
		delRoundBtns := editorPane.Locator(`button[data-action="mgp-delete-round"]:not([disabled])`)
		cnt, _ := delRoundBtns.Count()
		if cnt <= 1 {
			break
		}
		_ = delRoundBtns.Last().Click()
		time.Sleep(150 * time.Millisecond)
	}

	// Trim heats in Round 1 down to 1 heat using the UI delete-heat buttons so our E2E race is 1 short heat.
	for attempt := 0; attempt < 6; attempt++ {
		delHeatBtns := editorPane.Locator(`button[data-action="mgp-delete-heat"]:not([disabled])`)
		cnt, _ := delHeatBtns.Count()
		if cnt <= 1 {
			break
		}
		_ = delHeatBtns.Last().Click()
		time.Sleep(150 * time.Millisecond)
	}
	h.MilestoneScreenshot("sim-mgp-race-created-and-trimmed")

	// Navigate to Races (#/races) and import "Wednesday Short Shootout" from MultiGP.
	h.NavigateSidebar("races")

	importMgpBtn := h.Page.Locator(`button[data-race-act="import-multigp"]`).First()
	h.MustBeVisible(importMgpBtn, "Import MultiGP button in Races directory")
	if err := importMgpBtn.Click(); err != nil {
		t.Fatalf("click Import MultiGP: %v", err)
	}

	racePickRow := h.Page.Locator(fmt.Sprintf(`.slaprf-modal-backdrop [data-mgp-select-race="%d"]`, mgpRaceID)).First()
	h.MustBeVisible(racePickRow, "Wednesday Short Shootout row in Import from MultiGP modal")
	if err := racePickRow.Click(); err != nil {
		t.Fatalf("select MultiGP race %d in modal: %v", mgpRaceID, err)
	}

	doImportBtn := h.Page.Locator(`.slaprf-modal-backdrop button[data-mgp-do-import]:not([disabled])`).First()
	h.MustBeVisible(doImportBtn, "enabled Import race confirm button")
	if err := doImportBtn.Click(); err != nil {
		t.Fatalf("click Import race confirm: %v", err)
	}
	h.MustBeHidden(h.Page.Locator(`.slaprf-modal-backdrop`), "Import MultiGP modal closed")

	// Regression guard: verify imported race name is clean ("Wednesday Short Shootout") with NO "(2) (2)" suffix!
	var importedName string
	h.WaitUntil("imported MultiGP race active in raceState", 10*time.Second, func() (bool, error) {
		var st struct {
			RaceState struct {
				Config struct {
					EventName string `json:"eventName"`
				} `json:"config"`
				MGPLink *struct {
					RaceID int `json:"raceId"`
				} `json:"mgpLink"`
			} `json:"raceState"`
		}
		if err := h.WasmGetJSON("/api/state", &st); err != nil {
			return false, nil
		}
		if st.RaceState.MGPLink != nil && st.RaceState.MGPLink.RaceID == mgpRaceID {
			importedName = st.RaceState.Config.EventName
			return true, nil
		}
		return false, nil
	})
	if importedName != raceTitle || strings.Contains(importedName, "(2)") {
		t.Fatalf("expected clean imported MultiGP eventName %q without (2) suffix, got %q", raceTitle, importedName)
	}

	// Switch to Control tab, start the heat at 20x speed, finish & confirm results!
	controlTabBtn := h.Page.Locator(`button[data-race-tab="control"]`).First()
	if vis, _ := controlTabBtn.IsVisible(); vis {
		if err := controlTabBtn.Click(); err != nil {
			t.Fatalf("click Control tab: %v", err)
		}
	}

	h.StartActiveHeat()

	h.WaitUntil("MultiGP heat pilots complete target laps or heat finishes at 20x", 25*time.Second, func() (bool, error) {
		var st struct {
			RaceState struct {
				Heats []struct {
					State      string `json:"state"`
					TargetLaps int    `json:"targetLaps"`
					Seats      []struct {
						PilotSlotIndex int    `json:"pilotSlotIndex"`
						LapsCompleted  int    `json:"lapsCompleted"`
						Status         string `json:"status"`
					} `json:"seats"`
				} `json:"heats"`
			} `json:"raceState"`
		}
		if err := h.WasmGetJSON("/api/state", &st); err != nil {
			return false, nil
		}
		if len(st.RaceState.Heats) == 0 {
			return false, nil
		}
		ht := st.RaceState.Heats[0]
		if ht.State == "finished" {
			return true, nil
		}
		target := ht.TargetLaps
		if target <= 0 {
			target = 3
		}
		active := 0
		done := 0
		for _, s := range ht.Seats {
			if s.PilotSlotIndex > 0 {
				active++
				if s.LapsCompleted >= target || s.Status == "finished" {
					done++
				}
			}
		}
		return active > 0 && done == active, nil
	})

	stopBtn := h.Page.Locator(`button[data-ctrl="stop"]`).First()
	if vis, _ := stopBtn.IsVisible(); vis {
		_ = stopBtn.Click()
	}

	confirmBtn := h.Page.Locator(`button[data-ctrl="confirm"]`).First()
	h.MustBeVisible(confirmBtn, "Confirm Results button")
	if err := confirmBtn.Click(); err != nil {
		t.Fatalf("click Confirm Results: %v", err)
	}
	h.MilestoneScreenshot("mgp-controlled-heat-confirmed")

	// Switch to Review tab and upload completed heats + overall standings back to MultiGP!
	reviewTabBtn := h.Page.Locator(`button[data-race-tab="review"]`).First()
	h.MustBeVisible(reviewTabBtn, "Review tab button")
	if err := reviewTabBtn.Click(); err != nil {
		t.Fatalf("click Review tab: %v", err)
	}

	uploadHeatsBtn := h.Page.Locator(`button[data-race-act="mgp-upload-heats"]`).First()
	h.MustBeVisible(uploadHeatsBtn, "Upload completed heats to MultiGP button")
	if err := uploadHeatsBtn.Click(); err != nil {
		t.Fatalf("click mgp-upload-heats: %v", err)
	}

	doSyncBtn := h.Page.Locator(`.slaprf-modal-backdrop button[data-mgp-do-sync]:not([disabled])`).First()
	h.MustBeVisible(doSyncBtn, "enabled Upload heats to MultiGP button")
	if err := doSyncBtn.Click(); err != nil {
		t.Fatalf("click Upload heats to MultiGP: %v", err)
	}
	h.MustBeHidden(h.Page.Locator(`.slaprf-modal-backdrop`), "Upload heats modal auto-closed on success")

	uploadOverallBtn := h.Page.Locator(`button[data-race-act="mgp-upload-overall"]`).First()
	h.MustBeVisible(uploadOverallBtn, "Upload overall standings to MultiGP button")
	if err := uploadOverallBtn.Click(); err != nil {
		t.Fatalf("click mgp-upload-overall: %v", err)
	}

	doSyncOverallBtn := h.Page.Locator(`.slaprf-modal-backdrop button[data-mgp-do-sync]:not([disabled])`).First()
	h.MustBeVisible(doSyncOverallBtn, "enabled Upload overall to MultiGP button")
	if err := doSyncOverallBtn.Click(); err != nil {
		t.Fatalf("click Upload overall to MultiGP: %v", err)
	}
	h.MustBeHidden(h.Page.Locator(`.slaprf-modal-backdrop`), "Upload overall modal auto-closed on success")

	// Return to #/sim and verify the MultiGP chapter race row shows the green Uploaded LED,
	// synced heat lap times, and Uploaded overall podium!
	h.NavigateSidebar("sim")

	raceRow := h.Page.Locator(`.sim-mgp-race-row`, playwright.PageLocatorOptions{
		HasText: raceTitle,
	}).First()
	h.MustBeVisible(raceRow, "Wednesday Short Shootout row in Sim MultiGP table")
	h.MustBeVisible(raceRow.Locator(`.sim-mgp-race-sync-dot.status-dot.is-up`).First(), "green Uploaded LED on synced MultiGP race")

	if vis, _ := editorPane.IsVisible(); !vis {
		_ = editBtn.Click()
		h.MustBeVisible(editorPane, "Re-expanded MultiGP race inspector after upload")
	}

	h.WaitUntil("MultiGP inspector shows Uploaded standings and podium badges", 10*time.Second, func() (bool, error) {
		txt, err := editorPane.InnerText()
		if err != nil {
			return false, nil
		}
		podiumCnt, _ := editorPane.Locator(`.sim-mgp-podium-list .badge`).Count()
		return strings.Contains(txt, "Uploaded") && podiumCnt >= 1, nil
	})
	h.MilestoneScreenshot("sim-mgp-verified-uploaded-led-and-podium")
}

func TestMultiGPZippyQCheckInPullAndRun(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/sim")
	h.ConnectSimHubH1()

	// Set 20x simulation speed.
	h.APIPost("/api/sim/speed", map[string]any{"speedMultiplier": 20}, nil)

	// Locate the built-in ZippyQ chapter race dynamically from /api/sim/mgp-admin and expand it.
	var zippyRaceID int
	h.WaitUntil("built-in ZippyQ race present in simMultiGP", 10*time.Second, func() (bool, error) {
		var mgpSt struct {
			Races []struct {
				ID                        int    `json:"id"`
				Name                      string `json:"name"`
				DisableSlotAutoPopulation int    `json:"disableSlotAutoPopulation"`
			} `json:"races"`
		}
		if err := h.WasmGetJSON("/api/sim/mgp-admin", &mgpSt); err != nil {
			return false, nil
		}
		for _, r := range mgpSt.Races {
			if r.DisableSlotAutoPopulation == 1 || strings.Contains(strings.ToLower(r.Name), "zippyq") {
				zippyRaceID = r.ID
				return true, nil
			}
		}
		return false, nil
	})

	editZippyBtn := h.Page.Locator(fmt.Sprintf(`button[data-action="mgp-toggle-results"][data-race-id="%d"]`, zippyRaceID)).First()
	h.MustBeVisible(editZippyBtn, "Edit button on ZippyQ race")
	if err := editZippyBtn.Click(); err != nil {
		t.Fatalf("click Edit on ZippyQ race: %v", err)
	}

	zippyEditor := h.Page.Locator(fmt.Sprintf(`[data-testid="sim-mgp-editor-%d"]`, zippyRaceID)).First()
	h.MustBeVisible(zippyEditor, "ZippyQ race inspector")

	checkInBtn := zippyEditor.Locator(fmt.Sprintf(`button[data-action="mgp-zippyq-checkin"][data-race-id="%d"]`, zippyRaceID)).First()
	lineUpBtn := zippyEditor.Locator(fmt.Sprintf(`button[data-action="mgp-zippyq-lineup"][data-race-id="%d"]`, zippyRaceID)).First()
	h.MustBeVisible(checkInBtn, "+ Check in pilot button in ZippyQ simulator")
	h.MustBeVisible(lineUpBtn, "+ Line up pilot button in ZippyQ simulator")

	if disabled, _ := checkInBtn.IsDisabled(); !disabled {
		if err := checkInBtn.Click(); err != nil {
			t.Fatalf("click + Check in pilot: %v", err)
		}
	}
	if disabled, _ := lineUpBtn.IsDisabled(); !disabled {
		if err := lineUpBtn.Click(); err != nil {
			t.Fatalf("click + Line up pilot: %v", err)
		}
	}
	h.MilestoneScreenshot("zippyq-sim-checkin-and-lineup")

	// Import ZippyQ race into #/races in ZippyQ mode.
	h.NavigateSidebar("races")

	importMgpBtn := h.Page.Locator(`button[data-race-act="import-multigp"]`).First()
	h.MustBeVisible(importMgpBtn, "Import MultiGP button")
	if err := importMgpBtn.Click(); err != nil {
		t.Fatalf("click Import MultiGP: %v", err)
	}

	zippyRow := h.Page.Locator(fmt.Sprintf(`.slaprf-modal-backdrop [data-mgp-select-race="%d"]`, zippyRaceID)).First()
	h.MustBeVisible(zippyRow, "ZippyQ row in Import MultiGP modal")
	if err := zippyRow.Click(); err != nil {
		t.Fatalf("select ZippyQ race: %v", err)
	}

	// Ensure ZippyQ mode is selected if mode switcher is rendered.
	zippyModeBtn := h.Page.Locator(`.slaprf-modal-backdrop [data-mgp-import-mode="zippyq"]`).First()
	if cnt, _ := zippyModeBtn.Count(); cnt > 0 {
		_ = zippyModeBtn.Click()
	}

	doImportBtn := h.Page.Locator(`.slaprf-modal-backdrop button[data-mgp-do-import]:not([disabled])`).First()
	h.MustBeVisible(doImportBtn, "Import race confirm button for ZippyQ")
	if err := doImportBtn.Click(); err != nil {
		t.Fatalf("click Import race for ZippyQ: %v", err)
	}
	h.MustBeHidden(h.Page.Locator(`.slaprf-modal-backdrop`), "Import MultiGP modal closed")

	// Switch to Control view and verify the Pull ZippyQ button is present in the top bar.
	controlTabBtn := h.Page.Locator(`button[data-race-tab="control"]`).First()
	if vis, _ := controlTabBtn.IsVisible(); vis {
		_ = controlTabBtn.Click()
	}

	pullZippyBtn := h.Page.Locator(`button[data-race-act="mgp-pull-zippyq"]`).First()
	h.MustBeVisible(pullZippyBtn, "Pull ZippyQ button in Race Control top bar")

	var beforePull struct {
		RaceState struct {
			Heats []struct {
				ID string `json:"id"`
			} `json:"heats"`
		} `json:"raceState"`
	}
	if err := h.WasmGetJSON("/api/state", &beforePull); err != nil {
		t.Fatalf("get state before Pull ZippyQ: %v", err)
	}
	initialHeatCount := len(beforePull.RaceState.Heats)

	// Queue an additional ZippyQ round on simulated MultiGP and pull it live via "Pull ZippyQ"!
	if err := h.WasmPostJSON("/api/sim/mgp-admin", map[string]any{
		"action": "queue-zippyq",
		"raceId": zippyRaceID,
	}, nil); err != nil {
		t.Fatalf("queue-zippyq via /api/sim/mgp-admin: %v", err)
	}

	if err := pullZippyBtn.Click(); err != nil {
		t.Fatalf("click Pull ZippyQ: %v", err)
	}

	h.WaitUntil("Pull ZippyQ appends newly queued ZippyQ heats into active race", 10*time.Second, func() (bool, error) {
		var afterPull struct {
			RaceState struct {
				Heats []struct {
					ID string `json:"id"`
				} `json:"heats"`
			} `json:"raceState"`
		}
		if err := h.WasmGetJSON("/api/state", &afterPull); err != nil {
			return false, nil
		}
		return len(afterPull.RaceState.Heats) > initialHeatCount, nil
	})
	h.MilestoneScreenshot("zippyq-pulled-live-heats")

	// Run and confirm the first ZippyQ heat at 20x speed!
	h.StartActiveHeat()

	h.WaitUntil("ZippyQ heat pilots complete target laps or heat finishes at 20x", 25*time.Second, func() (bool, error) {
		var st struct {
			RaceState struct {
				Heats []struct {
					State      string `json:"state"`
					TargetLaps int    `json:"targetLaps"`
					Seats      []struct {
						PilotSlotIndex int    `json:"pilotSlotIndex"`
						LapsCompleted  int    `json:"lapsCompleted"`
						Status         string `json:"status"`
					} `json:"seats"`
				} `json:"heats"`
			} `json:"raceState"`
		}
		if err := h.WasmGetJSON("/api/state", &st); err != nil {
			return false, nil
		}
		if len(st.RaceState.Heats) == 0 {
			return false, nil
		}
		ht := st.RaceState.Heats[0]
		if ht.State == "finished" {
			return true, nil
		}
		target := ht.TargetLaps
		if target <= 0 {
			target = 3
		}
		active := 0
		done := 0
		for _, s := range ht.Seats {
			if s.PilotSlotIndex > 0 {
				active++
				if s.LapsCompleted >= target || s.Status == "finished" {
					done++
				}
			}
		}
		return active > 0 && done == active, nil
	})

	stopBtn := h.Page.Locator(`button[data-ctrl="stop"]`).First()
	if vis, _ := stopBtn.IsVisible(); vis {
		_ = stopBtn.Click()
	}

	confirmBtn := h.Page.Locator(`button[data-ctrl="confirm"]`).First()
	h.MustBeVisible(confirmBtn, "Confirm Results on ZippyQ heat")
	if err := confirmBtn.Click(); err != nil {
		t.Fatalf("click Confirm Results on ZippyQ heat: %v", err)
	}
	h.MilestoneScreenshot("zippyq-heat-confirmed")
}
