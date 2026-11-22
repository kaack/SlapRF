//go:build e2e

package e2e_test

import (
	"strings"
	"testing"
	"time"

	"github.com/playwright-community/playwright-go"
)

func TestSlapRFHubConnectAndTrackGateTelemetry(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/practice/open-practice/track")

	// 1. Connect simulated USB Hub H1 and verify all 4 gates come online with live telemetry.
	h.ConnectSimHubH1()
	h.MilestoneScreenshot("track-hub-h1-connected")

	// 2. Navigate to Simulator page and verify H1 (USB Hub) + T1..T4 (Spokes) are listed and powered on.
	h.NavigateSidebar("sim")
	boardsTitle := h.Page.Locator(`[data-slot="boards-title"]`).First()
	h.MustBeVisible(boardsTitle, "Simulated boards heading")
	if txt, _ := boardsTitle.InnerText(); strings.TrimSpace(txt) != "Simulated boards" {
		t.Fatalf("boards title = %q, want 'Simulated boards'", txt)
	}

	timersTable := h.Page.Locator(`[data-slot="timers-table"]`).First()
	for _, code := range []string{"H1", "T1", "T2", "T3", "T4"} {
		h.MustBeVisible(
			timersTable.Locator(`strong.mono`, playwright.LocatorLocatorOptions{HasText: code}).First(),
			"simulated board "+code,
		)
	}
	h.MustBeVisible(timersTable.Locator(`.badge`, playwright.LocatorLocatorOptions{HasText: "USB"}).First(), "H1 USB connected badge")

	// 3. Toggle power off and back on for a Spoke board (timerId=3 -> T2) and verify UI + engine reflect it.
	powerBtn := timersTable.Locator(`button[data-action="timer-power"][data-timer-id="3"]`).First()
	if err := powerBtn.Click(); err != nil {
		t.Fatalf("click Turn off on timer 3: %v", err)
	}
	h.WaitUntil("timer 3 shows Turn on button while powered off", 5*time.Second, func() (bool, error) {
		txt, err := powerBtn.InnerText()
		return err == nil && strings.TrimSpace(txt) == "Turn on", nil
	})
	h.MilestoneScreenshot("sim-spoke-t2-powered-off")

	if err := powerBtn.Click(); err != nil {
		t.Fatalf("click Turn on on timer 3: %v", err)
	}
	h.WaitUntil("timer 3 shows Turn off button once powered back on", 5*time.Second, func() (bool, error) {
		txt, err := powerBtn.InnerText()
		return err == nil && strings.TrimSpace(txt) == "Turn off", nil
	})
}

func TestLapRFSimulatedTimersLabelsAndControls(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/network")

	// 1. Switch timing system inline on #/network to LapRF 8-Way (Network).
	h.SelectCustomOption(`select[data-field="network-hardware-mode"]`, "LapRF 8-Way (Network)")

	// 2. Open Simulation page and verify compact L1, L2 labels (never "LapRF #1") and neutral voltage display.
	h.NavigateSidebar("sim")
	boardsTitle := h.Page.Locator(`[data-slot="boards-title"]`).First()
	h.WaitUntil("boards section switches to Simulated LapRF timers", 5*time.Second, func() (bool, error) {
		txt, err := boardsTitle.InnerText()
		return err == nil && strings.TrimSpace(txt) == "Simulated LapRF timers", nil
	})

	timersTable := h.Page.Locator(`[data-slot="timers-table"]`).First()
	h.MustBeVisible(timersTable.Locator(`strong.mono`, playwright.LocatorLocatorOptions{HasText: "L1"}).First(), "LapRF timer L1")
	h.MustBeVisible(timersTable.Locator(`strong.mono`, playwright.LocatorLocatorOptions{HasText: "L2"}).First(), "LapRF timer L2")

	tableText, _ := timersTable.InnerText()
	if strings.Contains(tableText, "LapRF #") {
		t.Fatalf("expected compact L1/L2 timer labels, but found legacy 'LapRF #' in:\n%s", tableText)
	}
	if strings.Contains(tableText, "%") {
		t.Fatalf("expected LapRF voltage display without battery percentage, got:\n%s", tableText)
	}

	voltsInput := timersTable.Locator(`input[data-field="laprf-volts"]`).First()
	h.MustBeVisible(voltsInput, "LapRF supply voltage input")
	if v, _ := voltsInput.InputValue(); strings.TrimSpace(v) == "" {
		t.Fatalf("expected non-empty LapRF voltage value")
	}

	// 3. Add a third simulated LapRF unit and verify it is named L3 automatically.
	addBtn := h.Page.Locator(`button[data-action="timer-add"]`).First()
	if err := addBtn.Click(); err != nil {
		t.Fatalf("click + Add LapRF timer: %v", err)
	}
	h.MustBeVisible(timersTable.Locator(`strong.mono`, playwright.LocatorLocatorOptions{HasText: "L3"}).First(), "newly added LapRF timer L3")
	h.MilestoneScreenshot("laprf-timers-l1-l2-l3")

	// 4. Toggle L2 connection state cleanly and restore defaults.
	connBtn := timersTable.Locator(`button[data-action="laprf-connect"]`).Nth(1)
	beforeTxt, _ := connBtn.InnerText()
	if err := connBtn.Click(); err != nil {
		t.Fatalf("click LapRF connect/disconnect toggle: %v", err)
	}
	h.WaitUntil("LapRF link button toggles text", 5*time.Second, func() (bool, error) {
		afterTxt, err := connBtn.InnerText()
		return err == nil && strings.TrimSpace(afterTxt) != strings.TrimSpace(beforeTxt), nil
	})

	resetBtn := h.Page.Locator(`button[data-action="timer-reset-defaults"]`).First()
	if err := resetBtn.Click(); err != nil {
		t.Fatalf("click Restore defaults on LapRF timers: %v", err)
	}
	h.MustBeHidden(timersTable.Locator(`strong.mono`, playwright.LocatorLocatorOptions{HasText: "L3"}), "L3 removed after Restore defaults")
}
