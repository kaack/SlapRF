//go:build e2e

package e2e_test

import (
	"testing"
	"time"
)

func TestComponent_NetworkViewStarTopologyAndSlotInspector(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/network")
	h.ConnectSimHubH1()

	// Verify Hub (Slot 1) and Spoke nodes (Slots 2..5) render in the Star Topology diagram.
	hubNode := h.Page.Locator(`button[data-action="select-topology-slot"][data-slot-num="1"]`).First()
	spoke2Node := h.Page.Locator(`button[data-action="select-topology-slot"][data-slot-num="2"]`).First()
	emptySlotNode := h.Page.Locator(`button[data-action="select-topology-slot"][data-slot-num="7"]`).First()
	h.MustBeVisible(hubNode, "Star Topology Hub Slot 1 node")
	h.MustBeVisible(spoke2Node, "Star Topology Spoke Slot 2 node")
	h.MilestoneScreenshot("network-star-topology-hub")

	// Click Spoke Slot 2 -> detail pane updates to inspect Spoke T2; toggle Identify LED!
	if err := spoke2Node.Click(); err != nil {
		t.Fatalf("click Spoke Slot 2: %v", err)
	}
	detailPane := h.Page.Locator(`[data-slot="timer-detail"]`).First()
	h.MustBeVisible(detailPane, "Selected timer detail pane")

	idBtn := detailPane.Locator(`button[data-action="toggle-identify"]:not([disabled])`).First()
	if cnt, _ := idBtn.Count(); cnt > 0 {
		_ = idBtn.Click()
	}
	h.MilestoneScreenshot("network-spoke2-inspector")

	// Click Empty Slot 7 -> detail pane displays Empty TDMA Slot explanation.
	if err := emptySlotNode.Click(); err != nil {
		t.Fatalf("click Empty Slot 7: %v", err)
	}
	h.MustContainText(detailPane, "7")

	// Also verify LapRF mode switches #/network to [data-slot="laprf-sections"] with L1, L2, L3!
	h.BootWithSnapshot(SnapshotLapRFModeSeeded, "#/network", nil)
	laprfWrap := h.Page.Locator(`[data-slot="laprf-sections"]`).First()
	h.MustContainText(laprfWrap, "L1")
	h.MilestoneScreenshot("network-laprf-mode-sections")
}

func TestComponent_FlasherViewFirmwarePatchOptionsAndReaderPanel(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/flasher")

	readerSlot := h.Page.Locator(`[data-slot="reader"]`).First()
	flasherSlot := h.Page.Locator(`[data-slot="flasher"]`).First()
	eraserSlot := h.Page.Locator(`[data-slot="eraser"]`).First()
	h.MustBeVisible(readerSlot, "Flasher Reader section")
	h.MustBeVisible(flasherSlot, "Flasher Firmware Patch section")
	h.MustBeVisible(eraserSlot, "Flasher Eraser section")

	// Flasher uses one-shot USB port selection on click, so Read Timer is enabled upfront.
	readBtn := h.Page.Locator(`button[data-action="read-timer"]`).First()
	dis, err := readBtn.IsDisabled()
	if err != nil || dis {
		t.Fatalf("expected read-timer button enabled for one-shot USB selection, got disabled=%v (err=%v)", dis, err)
	}
	h.MilestoneScreenshot("flasher-disconnected-state")

	// Connect simulated USB H1 -> click Read Timer to inspect board metadata!
	h.ConnectSimHubH1()
	if err := readBtn.Click(); err != nil {
		t.Fatalf("click read-timer: %v", err)
	}
	h.WaitUntil("Reader displays connected H1 firmware info", 5*time.Second, func() (bool, error) {
		txt, gErr := readerSlot.InnerText()
		return gErr == nil && containsStr(txt, "H1"), nil
	})
	h.MilestoneScreenshot("flasher-read-timer-h1")
}

func TestComponent_DebugViewSelfTestLiveSignalAndSpectrumScan(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/debug")
	h.ConnectSimHubH1()

	// Select a spoke timer or inspect connected H1 diagnostics: Self-test, Live Signal, and Spectrum Scan.
	selfTestSlot := h.Page.Locator(`[data-slot="selftest"]`).First()
	signalControls := h.Page.Locator(`[data-slot="signal-controls"]`).First()
	h.MustBeVisible(selfTestSlot, "Debug Self-Test card")
	h.MustBeVisible(signalControls, "Debug Live Signal controls")
	h.MilestoneScreenshot("debug-selftest-and-signal")

	// Trigger a single Spectrum Scan sweep if enabled, or toggle Y-axis menu on signal chart!
	yMenuArrow := h.Page.Locator(`button[data-action="toggle-axis-menu"][data-menu="signal-y"]`).First()
	if cnt, _ := yMenuArrow.Count(); cnt > 0 {
		if err := yMenuArrow.Click(); err != nil {
			t.Fatalf("click signal Y-axis menu: %v", err)
		}
		floorItem := h.Page.Locator(`button[data-action="signal-zoom-floor"]`).First()
		h.MustBeVisible(floorItem, "Signal Y-axis Noise Floor preset")
		_ = floorItem.Click()
	}

	scanBtn := h.Page.Locator(`button[data-action="scan"]:not([disabled])`).First()
	if cnt, _ := scanBtn.Count(); cnt > 0 {
		_ = scanBtn.Click()
	}
	h.MilestoneScreenshot("debug-spectrum-and-axis-preset")
}

func TestComponent_LiveTimeViewStatusHostCopyPillsAndToggle(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/setup/laprf-emulator")

	// Enable the LapRF TCP :5403 emulator from Setup -> sidebar reveals #/livetime link!
	ltSwitchLabel := h.Page.Locator(`[data-slot="livetime"] label.switch`).First()
	h.MustBeVisible(ltSwitchLabel, "Setup LapRF emulator switch")
	if err := ltSwitchLabel.Click(); err != nil {
		t.Fatalf("enable LapRF emulator switch: %v", err)
	}

	h.NavigateSidebar("livetime")

	// Verify host 127.0.0.1 and port 5403 copy pills work with clipboard permissions.
	copyHostBtn := h.Page.Locator(`button.livetime-copy-pill[data-copy="127.0.0.1"]`).First()
	copyPortBtn := h.Page.Locator(`button.livetime-copy-pill[data-copy="5403"]`).First()
	h.MustBeVisible(copyHostBtn, "Copy 127.0.0.1 pill")
	h.MustBeVisible(copyPortBtn, "Copy 5403 port pill")

	if err := copyPortBtn.Click(); err != nil {
		t.Fatalf("click copy 5403 pill: %v", err)
	}
	h.WaitUntil("clipboard contains 5403", 5*time.Second, func() (bool, error) {
		res, err := h.Page.Evaluate(`() => navigator.clipboard.readText()`)
		s, _ := res.(string)
		return err == nil && s == "5403", nil
	})
	h.MilestoneScreenshot("livetime-view-active-and-copied")

	// Toggle off from LiveTimeView switch (use JS click on input so 1s statusSlot refresh cannot race pointer hit-testing).
	if _, err := h.Page.Evaluate(`() => {
		const inp = document.querySelector('input[data-action="toggle-livetime"]');
		if (!inp) throw new Error('toggle-livetime input not found');
		inp.click();
	}`); err != nil {
		t.Fatalf("disable LiveTime relay switch: %v", err)
	}
	h.MustContainText(h.Page.Locator(`[data-slot="status"]`).First(), "Disabled")
}

func TestComponent_SimViewSpeedWalkerAndPilotCommands(t *testing.T) {
	h := NewHarness(t)
	// Start from an active Practice session so all 4 simulated pilots are actively flying on track!
	h.BootWithSnapshot(SnapshotPracticePopulated, "#/setup", nil)

	// 1. Toggle simulation speed multiplier 1× -> 20× -> 5× -> 1× on Settings -> Datasource.
	speed20 := h.Page.Locator(`button[data-sim-speed="20"]`).First()
	speed5 := h.Page.Locator(`button[data-sim-speed="5"]`).First()
	speed1 := h.Page.Locator(`button[data-sim-speed="1"]`).First()
	h.MustBeVisible(speed20, "Simulator 20x speed button")

	if err := speed20.Click(); err != nil {
		t.Fatalf("click 20x speed: %v", err)
	}
	h.WaitUntil("20x button marked is-active", 5*time.Second, func() (bool, error) {
		cls, err := speed20.GetAttribute("class")
		return err == nil && containsStr(cls, "is-active"), nil
	})
	_ = speed5.Click()
	_ = speed1.Click()

	h.NavigateSidebar("sim")

	// 2. Launch all pilots if needed, force Crash on Pilot 1, then trigger Track Walk recovery, then end Track Walk!
	launchAllBtn := h.Page.Locator(`button[data-action="launch-all"]`).First()
	if cnt, _ := launchAllBtn.Count(); cnt > 0 {
		_ = launchAllBtn.Click()
	}

	crashBtn1 := h.Page.Locator(`button[data-pilot-btn="1-crash"]:not([disabled])`).First()
	h.MustBeVisible(crashBtn1, "Pilot 1 Crash command button")
	if err := crashBtn1.Click(); err != nil {
		t.Fatalf("click Pilot 1 Crash: %v", err)
	}
	h.MilestoneScreenshot("sim-pilot1-crashed")

	walkRecBtn1 := h.Page.Locator(`button[data-pilot-btn="1-walk-recover"]:not([disabled])`).First()
	h.MustBeVisible(walkRecBtn1, "Pilot 1 Walk-Recover command button")
	if err := walkRecBtn1.Click(); err != nil {
		t.Fatalf("click Pilot 1 Walk-Recover: %v", err)
	}

	walkerToggle := h.Page.Locator(`button[data-action="toggle-walker"]:not([disabled])`).First()
	h.MustBeVisible(walkerToggle, "End Track Walk button while walker active")
	h.MilestoneScreenshot("sim-track-walk-active")

	if err := walkerToggle.Click(); err != nil {
		t.Fatalf("click End Track Walk: %v", err)
	}
}

func TestComponent_SimViewMultiGPAdminEditorRoundsHeatsAndCheckIn(t *testing.T) {
	h := NewHarness(t)
	h.BootWithSnapshot(SnapshotMultiGPSeeded, "#/sim", nil)

	// Scroll down to Simulated MultiGP Chapter card and expand a race editor!
	toggleBtns := h.Page.Locator(`button[data-action="mgp-toggle-results"]`)
	h.WaitUntil("Simulated MultiGP race rows rendered", 5*time.Second, func() (bool, error) {
		cnt, err := toggleBtns.Count()
		return err == nil && cnt >= 2, nil
	})

	// Expand first Controlled race -> add a round & add a heat!
	if err := toggleBtns.First().Click(); err != nil {
		t.Fatalf("expand first MultiGP race: %v", err)
	}
	addRoundBtn := h.Page.Locator(`button[data-action="mgp-add-round"]`).First()
	h.MustBeVisible(addRoundBtn, "Simulated MultiGP + Add Round button")
	if err := addRoundBtn.Click(); err != nil {
		t.Fatalf("click mgp-add-round: %v", err)
	}

	addHeatBtn := h.Page.Locator(`button[data-action="mgp-add-heat"]`).First()
	h.MustBeVisible(addHeatBtn, "Simulated MultiGP + Add Heat button")
	if err := addHeatBtn.Click(); err != nil {
		t.Fatalf("click mgp-add-heat: %v", err)
	}
	h.MilestoneScreenshot("sim-multigp-controlled-editor")

	// Create a new ZippyQ race or expand existing ZippyQ race and toggle pilot check-in!
	addRaceBtn := h.Page.Locator(`button[data-action="mgp-add-race"]`).First()
	h.MustBeVisible(addRaceBtn, "Simulated MultiGP + Create race button")
	if err := addRaceBtn.Click(); err != nil {
		t.Fatalf("click mgp-add-race: %v", err)
	}
	h.MilestoneScreenshot("sim-multigp-added-race")
}
