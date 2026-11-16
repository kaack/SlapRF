//go:build e2e

package e2e_test

import (
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/playwright-community/playwright-go"
)

func TestPilotsDirectoryAddEditAndPersist(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/pilots")

	h.WaitUntil("default 10 pilots loaded in directory", 10*time.Second, func() (bool, error) {
		cnt, err := h.Page.Locator(`form.slot-row[data-pilot]`).Count()
		return err == nil && cnt == 10, nil
	})
	pageSummary := h.Page.Locator(`.pilot-dir-page-summary`).First()

	// Add an 11th pilot via the search/add input + Add button.
	searchInput := h.Page.Locator(`input[data-pilot-dir-search]`).First()
	h.MustBeVisible(searchInput, "Pilot directory search/add input")
	if err := searchInput.Fill("BlazeFPV"); err != nil {
		t.Fatalf("fill pilot search/add input: %v", err)
	}

	addBtn := h.Page.Locator(`button[data-action="add-pilot"]:not([disabled])`).First()
	h.MustBeVisible(addBtn, "enabled Add pilot button")
	if err := addBtn.Click(); err != nil {
		t.Fatalf("click Add pilot button: %v", err)
	}

	var blazeSlot int
	h.WaitUntil("BlazeFPV added to pilot directory (11 total)", 10*time.Second, func() (bool, error) {
		var st struct {
			Pilots []struct {
				SlotIndex int    `json:"slotIndex"`
				Callsign  string `json:"callsign"`
			} `json:"pilots"`
		}
		if err := h.WasmGetJSON("/api/state", &st); err != nil {
			return false, nil
		}
		for _, p := range st.Pilots {
			if p.Callsign == "BlazeFPV" {
				blazeSlot = p.SlotIndex
				return true, nil
			}
		}
		return false, nil
	})

	// Adding a pilot auto-selects its Recent pill so its row is immediately visible; edit phonetic name and press Enter to persist.
	phoneticInput := h.Page.Locator(fmt.Sprintf(`form.slot-row[data-pilot="%d"] input[name="phoneticName"]`, blazeSlot)).First()
	h.MustBeVisible(phoneticInput, "BlazeFPV phonetic name input")
	if err := phoneticInput.Fill("Blaze F P V"); err != nil {
		t.Fatalf("fill phoneticName: %v", err)
	}
	if err := phoneticInput.Press("Enter"); err != nil {
		t.Fatalf("press Enter on phoneticName: %v", err)
	}

	// Wait until WASM engine records the updated phonetic name AND IndexedDB flushes the snapshot.
	h.WaitUntil("BlazeFPV phonetic name saved to WASM state and IndexedDB", 10*time.Second, func() (bool, error) {
		var st struct {
			Pilots []struct {
				SlotIndex    int    `json:"slotIndex"`
				Callsign     string `json:"callsign"`
				PhoneticName string `json:"phoneticName"`
			} `json:"pilots"`
		}
		if err := h.WasmGetJSON("/api/state", &st); err != nil {
			return false, nil
		}
		found := false
		for _, p := range st.Pilots {
			if p.SlotIndex == blazeSlot && p.Callsign == "BlazeFPV" && p.PhoneticName == "Blaze F P V" {
				found = true
				break
			}
		}
		if !found {
			return false, nil
		}
		if !h.StaticDemo {
			resp, err := http.Get(h.BaseURL + "/api/storage/sim-export")
			if err != nil {
				return false, nil
			}
			rawBytes, _ := io.ReadAll(resp.Body)
			_ = resp.Body.Close()
			raw := string(rawBytes)
			return resp.StatusCode == http.StatusOK && strings.Contains(raw, "BlazeFPV") && strings.Contains(raw, "Blaze F P V"), nil
		}
		// Ensure debounced IndexedDB persistence (~250ms) has flushed the updated sim.state document.
		persisted, err := h.Page.Evaluate(`async () => {
			return await new Promise((resolve) => {
				const req = indexedDB.open("slaprf");
				req.onerror = () => resolve(false);
				req.onsuccess = () => {
					const db = req.result;
					if (!db.objectStoreNames.contains("kv")) {
						db.close();
						resolve(false);
						return;
					}
					const tx = db.transaction("kv", "readonly");
					const getReq = tx.objectStore("kv").get("sim.state");
					getReq.onerror = () => { db.close(); resolve(false); };
					getReq.onsuccess = () => {
						const raw = typeof getReq.result === "string" ? getReq.result : JSON.stringify(getReq.result || "");
						db.close();
						resolve(raw.includes("BlazeFPV") && raw.includes("Blaze F P V"));
					};
				};
			});
		}`)
		if err != nil {
			return false, nil
		}
		ok, _ := persisted.(bool)
		return ok, nil
	})
	h.MilestoneScreenshot("pilots-added-blazefpv")

	// Reload the browser page and verify persistence restores BlazeFPV & phonetic name.
	h.ReloadAndWait()

	h.WaitUntil("BlazeFPV and phonetic name restored after page reload", 10*time.Second, func() (bool, error) {
		st := h.APIState()
		for _, p := range st.Pilots {
			if p.SlotIndex == blazeSlot && p.Callsign == "BlazeFPV" && p.PhoneticName == "Blaze F P V" {
				return true, nil
			}
		}
		return false, nil
	})
	_ = pageSummary
	h.MilestoneScreenshot("pilots-reloaded-persisted")
}

func TestPracticeSessionFastSimLapsAndSectors(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/sim")
	h.ConnectSimHubH1()

	// Set simulator speed to 20x and ensure pilots are airborne on the course.
	h.APIPost("/api/sim/speed", map[string]any{"speedMultiplier": 20}, nil)

	launchAllBtn := h.Page.Locator(`button[data-action="launch-all"]`).First()
	if cnt, _ := launchAllBtn.Count(); cnt > 0 {
		if disabled, _ := launchAllBtn.IsDisabled(); !disabled {
			_ = launchAllBtn.Click()
		}
	}

	// Switch to Practice (#/live) via Sidebar.
	h.NavigateSidebar("live")

	// Create a practice session if none exist, then open it if currently in directory view.
	createInlineBtn := h.Page.Locator(`button[data-practice-act="create-session-inline"]`).First()
	if cnt, _ := createInlineBtn.Count(); cnt > 0 {
		openBtns := h.Page.Locator(`button[data-practice-act="open-session"]`)
		if openCnt, _ := openBtns.Count(); openCnt == 0 {
			if err := createInlineBtn.Click(); err != nil {
				t.Fatalf("click + Session inline: %v", err)
			}
		}
		h.MustBeVisible(openBtns.First(), "Open practice session button")
		if err := openBtns.First().Click(); err != nil {
			t.Fatalf("click open-session: %v", err)
		}
	}

	// Ensure at least 2 pilots are assigned to the selected practice session.
	var checkSess struct {
		PracticeState struct {
			Sessions []struct {
				SessionID string `json:"sessionId"`
				Pilots    []struct {
					SlotIndex int `json:"slotIndex"`
				} `json:"pilots"`
			} `json:"sessions"`
		} `json:"practiceState"`
	}
	if err := h.WasmGetJSON("/api/state", &checkSess); err != nil {
		t.Fatalf("query practiceState: %v", err)
	}
	if len(checkSess.PracticeState.Sessions) > 0 && len(checkSess.PracticeState.Sessions[0].Pilots) == 0 {
		popBtn := h.Page.Locator(`button[data-practice-act="toggle-pilot-popover"]`).First()
		h.MustBeVisible(popBtn, "Practice + Pilot popover button")
		if err := popBtn.Click(); err != nil {
			t.Fatalf("open practice pilot popover: %v", err)
		}
		for i := 0; i < 3; i++ {
			addPilotBtn := h.Page.Locator(`button[data-practice-act="add-session-pilot"]`).First()
			if cnt, _ := addPilotBtn.Count(); cnt > 0 {
				_ = addPilotBtn.Click()
				time.Sleep(100 * time.Millisecond)
			}
		}
		closePop := h.Page.Locator(`button[data-practice-act="close-pilot-popover"]`).First()
		if cnt, _ := closePop.Count(); cnt > 0 {
			_ = closePop.Click()
		}
	}

	// Start practice session timing if not already active.
	startBtn := h.Page.Locator(`[data-slot="session-controls"] button[data-practice-act="start-session"], [data-slot="session-controls"] button[data-practice-act="resume-session"]`).First()
	if vis, _ := startBtn.IsVisible(); vis {
		if err := startBtn.Click(); err != nil {
			t.Fatalf("click Start practice timing: %v", err)
		}
	}

	// Confirm active LED indicator appears and pilots are flying.
	h.MustBeVisible(h.Page.Locator(`[data-practice-status="active"]`).First(), "Active practice timing status LED")
	_ = h.WasmPostJSON("/api/sim/pack-burst", map[string]any{}, nil)

	// At 20x simulation speed, full 4-gate laps with S1..S4 sector splits complete in ~1-3 seconds.
	h.WaitUntil("at least 3 full practice laps with 4 sector splits recorded", 15*time.Second, func() (bool, error) {
		var st struct {
			PracticeState struct {
				Sessions []struct {
					Active bool `json:"active"`
					Laps   []struct {
						LapNumber  int     `json:"lapNumber"`
						LapTimeSec float64 `json:"lapTimeSec"`
						Sectors    []struct {
							SplitSeconds float64 `json:"splitSeconds"`
						} `json:"sectors"`
					} `json:"laps"`
				} `json:"sessions"`
			} `json:"practiceState"`
		}
		if err := h.WasmGetJSON("/api/state", &st); err != nil {
			return false, nil
		}
		validFullLaps := 0
		for _, sess := range st.PracticeState.Sessions {
			for _, l := range sess.Laps {
				if l.LapNumber >= 1 && l.LapTimeSec > 0 && len(l.Sectors) >= 4 {
					validFullLaps++
				}
			}
		}
		return validFullLaps >= 3, nil
	})

	// Verify the Practice UI strip meta reflects recorded laps and sector headers/cells render.
	metaStrip := h.Page.Locator(`.practice-strip-meta`).First()
	h.MustBeVisible(metaStrip, "Practice strip meta summary")
	h.WaitUntil("Practice strip meta displays non-zero laps", 6*time.Second, func() (bool, error) {
		txt, err := metaStrip.InnerText()
		if err != nil {
			return false, nil
		}
		return !strings.Contains(txt, "· 0 laps"), nil
	})
	h.MilestoneScreenshot("practice-fast-sim-laps-recorded")

	// Pause practice session cleanly (scoped to visible workspace session-controls strip).
	pauseBtn := h.Page.Locator(`[data-slot="session-controls"] button[data-practice-act="pause-session"]`, playwright.PageLocatorOptions{}).First()
	h.MustBeVisible(pauseBtn, "Pause practice session button")
	if err := pauseBtn.Click(); err != nil {
		t.Fatalf("click Pause practice session: %v", err)
	}
	h.MustBeVisible(h.Page.Locator(`[data-slot="session-controls"] button[data-practice-act="resume-session"]`).First(), "Resume practice button after pausing")
	h.MilestoneScreenshot("practice-paused-cleanly")
}
