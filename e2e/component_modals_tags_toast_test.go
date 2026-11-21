//go:build e2e

package e2e_test

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/playwright-community/playwright-go"
)

func TestComponent_TagPillEditorAddSelectNavigateRemoveCommitAndCancel(t *testing.T) {
	h := NewHarness(t)
	h.BootWithSnapshot(SnapshotPracticePopulated, "#/practice", nil)

	editBtn := h.Page.Locator(`button[data-practice-act="edit-session-tags"][data-session-id="session-1"]`).First()
	h.MustBeVisible(editBtn, "Edit session tags button on Evening Lap Lab")
	if err := editBtn.Click(); err != nil {
		t.Fatalf("click edit-session-tags: %v", err)
	}

	tagBox := h.Page.Locator(`[data-tag-box]`).First()
	h.MustBeVisible(tagBox, "TagPillEditor container")
	input := tagBox.Locator(`input[data-tag-box-input]`).First()
	h.MustBeVisible(input, "TagPillEditor text input")

	// 1. Add a tag via comma delimiter ("NightOps,") -> should have 3 pills ("5-inch", "Outdoor", "NightOps").
	if err := input.Type("NightOps,"); err != nil {
		t.Fatalf("type NightOps,: %v", err)
	}
	h.WaitUntil("3 tag pills rendered after comma commit", 5*time.Second, func() (bool, error) {
		cnt, err := tagBox.Locator(`.slaprf-tag-pill[data-tag-pill-idx]`).Count()
		return err == nil && cnt == 3, nil
	})
	h.MilestoneScreenshot("tag-pill-editor-added")

	// 2. Press ArrowLeft on empty input -> selects last pill; press Backspace -> deletes it back to 2 pills.
	if err := input.Press("ArrowLeft"); err != nil {
		t.Fatalf("press ArrowLeft (select): %v", err)
	}
	h.MustBeVisible(tagBox.Locator(`.slaprf-tag-pill.is-selected`).First(), "Selected tag pill on ArrowLeft")

	if err := input.Press("Backspace"); err != nil {
		t.Fatalf("press Backspace (delete): %v", err)
	}
	h.WaitUntil("pill count back to 2 after Backspace delete", 5*time.Second, func() (bool, error) {
		cnt, err := tagBox.Locator(`.slaprf-tag-pill[data-tag-pill-idx]`).Count()
		return err == nil && cnt == 2, nil
	})

	// 3. Type "League" + Enter (flushes into pill) + second Enter (commits and closes editor).
	if err := input.Type("League"); err != nil {
		t.Fatalf("type League: %v", err)
	}
	if err := input.Press("Enter"); err != nil {
		t.Fatalf("press Enter to flush pending tag: %v", err)
	}
	if err := input.Press("Enter"); err != nil {
		t.Fatalf("press Enter to commit tags: %v", err)
	}
	h.MustBeHidden(tagBox, "TagPillEditor closed after Enter commit")
	h.MustContainText(h.Page.Locator(`tr[data-session-row="session-1"]`).First(), "League")
	stTags := h.APIState()
	foundLeagueTag := false
	for _, s := range stTags.PracticeState.Sessions {
		if s.SessionID == "session-1" {
			for _, tg := range s.Tags {
				if tg == "League" {
					foundLeagueTag = true
				}
			}
		}
	}
	if !foundLeagueTag {
		t.Fatalf("expected /v1/state session-1 tags to contain League after TagPillEditor commit")
	}
	h.MilestoneScreenshot("tag-pill-editor-committed")

	// 4. Reopen, type unsaved text, press Escape to cancel without saving.
	if err := editBtn.Click(); err != nil {
		t.Fatalf("reopen edit-session-tags: %v", err)
	}
	h.MustBeVisible(input, "TagPillEditor reopened")
	if err := input.Type("UnsavedTag,"); err != nil {
		t.Fatalf("type UnsavedTag,: %v", err)
	}
	if err := input.Press("Escape"); err != nil {
		t.Fatalf("press Escape to cancel: %v", err)
	}
	h.MustBeHidden(tagBox, "TagPillEditor closed on Escape")
	cntUnsaved, _ := h.Page.Locator(`tr[data-session-row="session-1"] .race-tag-pill`, playwright.PageLocatorOptions{HasText: "UnsavedTag"}).Count()
	if cntUnsaved != 0 {
		t.Fatalf("expected UnsavedTag not to be saved on Escape, got count %d", cntUnsaved)
	}
}

func TestComponent_ConfirmModalCancelEscapeBackdropAndDangerConfirm(t *testing.T) {
	h := NewHarness(t)
	h.BootWithSnapshot(SnapshotPracticePopulated, "#/practice", nil)

	menuBtn := h.Page.Locator(`button[data-practice-act="toggle-dir-session-menu"][data-session-id="session-2"]`).First()
	h.MustBeVisible(menuBtn, "Warmup Pack actions menu button")
	delBtn := h.Page.Locator(`button[data-practice-act="delete-session"][data-session-id="session-2"]`).First()

	backdrop := h.Page.Locator(`.slaprf-modal-backdrop`).First()

	// 1. Open and cancel via Cancel button; verify lap loss warning is shown.
	if err := menuBtn.Click(); err != nil {
		t.Fatalf("open session-2 actions menu (1): %v", err)
	}
	h.MustBeVisible(delBtn, "Delete Warmup Pack button")
	if err := delBtn.Click(); err != nil {
		t.Fatalf("click delete-session (1): %v", err)
	}
	h.MustBeVisible(backdrop, "ConfirmModal backdrop")
	h.MustContainText(backdrop, "Warmup Pack")
	h.MustContainText(backdrop, "2 recorded laps")
	h.MilestoneScreenshot("confirm-modal-open")

	if err := backdrop.Locator(`button[data-modal-cancel]`).Last().Click(); err != nil {
		t.Fatalf("click [data-modal-cancel]: %v", err)
	}
	h.MustBeHidden(backdrop, "ConfirmModal closed after Cancel button")

	// 2. Open and cancel via Escape key.
	if err := menuBtn.Click(); err != nil {
		t.Fatalf("open session-2 actions menu (2): %v", err)
	}
	if err := delBtn.Click(); err != nil {
		t.Fatalf("click delete-session (2): %v", err)
	}
	h.MustBeVisible(backdrop, "ConfirmModal reopened")
	if err := h.Page.Keyboard().Press("Escape"); err != nil {
		t.Fatalf("press Escape: %v", err)
	}
	h.MustBeHidden(backdrop, "ConfirmModal closed after Escape")

	// 3. Open and confirm permanent deletion.
	if err := menuBtn.Click(); err != nil {
		t.Fatalf("open session-2 actions menu (3): %v", err)
	}
	if err := delBtn.Click(); err != nil {
		t.Fatalf("click delete-session (3): %v", err)
	}
	h.MustBeVisible(backdrop, "ConfirmModal reopened for confirm")
	if err := backdrop.Locator(`[data-modal-confirm]`).Click(); err != nil {
		t.Fatalf("click [data-modal-confirm]: %v", err)
	}
	h.MustBeHidden(backdrop, "ConfirmModal closed after Confirm")
	h.MustBeHidden(h.Page.Locator(`tr[data-session-row="session-2"]`).First(), "Warmup Pack row deleted")
	h.MilestoneScreenshot("confirm-modal-deleted-row")
}

func TestComponent_ConfirmPreemptModalCancelAndConfirm(t *testing.T) {
	h := NewHarness(t)
	h.BootWithSnapshot(SnapshotPracticePopulated, "#/live/warmup-pack", nil)

	// session-1 ("Evening Lap Lab") is currently live; starting session-2 ("Warmup Pack") prompts preemption.
	startWarmupBtn := h.Page.Locator(`[data-practice-act="start-session"], [data-practice-act="resume-session"]`).First()
	h.MustBeVisible(startWarmupBtn, "Start/Resume button on stopped Warmup Pack workspace")

	backdrop := h.Page.Locator(`.slaprf-modal-backdrop`).First()

	// 1. Open and cancel -> Evening Lap Lab stays active, and body displays Evening Lap Lab (not undefined!).
	if err := startWarmupBtn.Click(); err != nil {
		t.Fatalf("click start Warmup Pack (1): %v", err)
	}
	h.MustBeVisible(backdrop, "ConfirmPreemptModal backdrop")
	h.MustContainText(backdrop, "Evening Lap Lab")
	h.MilestoneScreenshot("confirm-preempt-modal-open")

	if err := backdrop.Locator(`button[data-preempt-cancel]`).Last().Click(); err != nil {
		t.Fatalf("click [data-preempt-cancel]: %v", err)
	}
	h.MustBeHidden(backdrop, "ConfirmPreemptModal closed on Cancel")
	h.MustBeVisible(startWarmupBtn, "Warmup Pack remains stopped after Cancel")

	// 2. Open and confirm -> Warmup Pack becomes active (armed pause button) and Evening Lap Lab pauses.
	if err := startWarmupBtn.Click(); err != nil {
		t.Fatalf("click start Warmup Pack (2): %v", err)
	}
	h.MustBeVisible(backdrop, "ConfirmPreemptModal reopened")
	if err := backdrop.Locator(`[data-preempt-ok]`).Click(); err != nil {
		t.Fatalf("click [data-preempt-ok]: %v", err)
	}
	h.MustBeHidden(backdrop, "ConfirmPreemptModal closed after OK")
	h.MustBeVisible(
		h.Page.Locator(`[data-practice-act="pause-session"]`).First(),
		"Warmup Pack now active with Pause button",
	)
	h.MilestoneScreenshot("confirm-preempt-switched-session")
}

func TestComponent_ToastErrorDeduplicationAndManualDismiss(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/pilots")

	// Trigger duplicate callsign validation twice rapidly on Slot 2 ("MeWo" -> "FAERRY")
	pilot2Input := h.Page.Locator(`form[data-pilot="2"] input[name="callsign"]`).First()
	h.MustBeVisible(pilot2Input, "Pilot 2 callsign input")

	for attempt := 0; attempt < 2; attempt++ {
		if err := pilot2Input.Fill("FAERRY"); err != nil {
			t.Fatalf("fill duplicate callsign: %v", err)
		}
		if err := pilot2Input.Press("Enter"); err != nil {
			t.Fatalf("press Enter on duplicate callsign: %v", err)
		}
	}

	toast := h.Page.Locator(`.slaprf-toaster .slaprf-toast`).First()
	h.MustBeVisible(toast, "Duplicate callsign warning toast")
	h.MustContainText(toast, "already exists")

	// Deduplication check: identical rapid toasts collapse into a single visible toast card.
	cnt, err := h.Page.Locator(`.slaprf-toaster .slaprf-toast`).Count()
	if err != nil || cnt != 1 {
		t.Fatalf("expected 1 deduplicated toast, got %d (err=%v)", cnt, err)
	}
	h.MilestoneScreenshot("toast-deduplicated")

	closeBtn := toast.Locator(`.slaprf-toast-close`).First()
	if err := closeBtn.Click(); err != nil {
		t.Fatalf("click toast close button: %v", err)
	}
	h.MustBeHidden(toast, "Toast dismissed immediately after clicking ×")
}

func TestComponent_CanvasSelectPopoverSearchAndSelection(t *testing.T) {
	h := NewHarness(t)
	// Sunday Qualifier in SnapshotRaceActiveControl has 14 checked-in pilots (> 10 options),
	// so every seat CanvasSelect on #/races/sunday-qualifier/stage-1 renders [data-cselect-search]!
	h.BootWithSnapshot(SnapshotRaceActiveControl, "#/races/sunday-qualifier/stage-1", nil)

	seatSelect := h.Page.Locator(`[data-cselect-trigger][data-bkt-seat-heat][data-cselect-options*="Harvard"]`).First()
	h.MustBeVisible(seatSelect, "Unstarted empty seat CanvasSelect trigger (>10 options)")
	heatID, err := seatSelect.GetAttribute("data-bkt-seat-heat")
	if err != nil || heatID == "" {
		t.Fatalf("read data-bkt-seat-heat: %v (%q)", err, heatID)
	}
	seatIdx, err := seatSelect.GetAttribute("data-bkt-seat-idx")
	if err != nil || seatIdx == "" {
		t.Fatalf("read data-bkt-seat-idx: %v (%q)", err, seatIdx)
	}
	if err := seatSelect.Click(); err != nil {
		t.Fatalf("click CanvasSelect trigger: %v", err)
	}

	popover := h.Page.Locator(`[data-cselect-popover]`).First()
	h.MustBeVisible(popover, "CanvasSelect floating popover")

	searchInput := popover.Locator(`input[data-cselect-search]`).First()
	h.MustBeVisible(searchInput, "CanvasSelect search input (>10 options)")
	h.MilestoneScreenshot("canvas-select-search-open")

	if err := searchInput.Fill("Harvard"); err != nil {
		t.Fatalf("fill Harvard in CanvasSelect search: %v", err)
	}

	harvardOpt := popover.Locator(`[data-cselect-option]`, playwright.LocatorLocatorOptions{
		HasText: "Harvard",
	}).First()
	h.MustBeVisible(harvardOpt, "Filtered Harvard pilot option")

	if err := harvardOpt.Click(); err != nil {
		t.Fatalf("click Harvard option: %v", err)
	}
	h.MustBeHidden(popover, "CanvasSelect popover closed after selection")
	assignedSeat := h.Page.Locator(fmt.Sprintf(`[data-drop-heat=%q][data-drop-seat=%q]`, heatID, seatIdx)).First()
	h.MustContainText(assignedSeat, "Harvard")
	stSeat := h.APIState()
	foundHarvardInAPI := false
	for _, rc := range stSeat.EventState.Races {
		for _, ht := range rc.Heats {
			if ht.ID == heatID {
				for _, s := range ht.Seats {
					if fmt.Sprintf("%d", s.SeatIndex) == seatIdx && s.Callsign == "Harvard" {
						foundHarvardInAPI = true
					}
				}
			}
		}
	}
	if !foundHarvardInAPI {
		t.Fatalf("expected /v1/state EventState heat %s seat %s to have Callsign=Harvard", heatID, seatIdx)
	}
	h.MilestoneScreenshot("canvas-select-harvard-assigned")
}

func TestComponent_UsbPortPickerDialogSelectAndCancel(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/practice")

	usbBtn := h.Page.Locator(`button[data-action="usb-toggle"]`).First()
	h.MustBeVisible(usbBtn, "TopBar USB Connect button")

	// 1. Open simulated USB port picker and cancel with Escape.
	if err := usbBtn.Click(); err != nil {
		t.Fatalf("click USB Connect (1): %v", err)
	}
	dialog := h.Page.Locator(`.sim-usb-dialog`).First()
	h.MustBeVisible(dialog, "Simulated USB port picker dialog")
	h.MustContainText(dialog, "H1")
	h.MilestoneScreenshot("usb-port-picker-open")

	if err := h.Page.Keyboard().Press("Escape"); err != nil {
		t.Fatalf("press Escape on USB picker: %v", err)
	}
	h.MustBeHidden(dialog, "USB port picker closed on Escape")

	// 2. Open again, connect H1, verify Connected · H1, then click again to disconnect.
	h.ConnectSimHubH1()
	h.MustContainText(usbBtn, "Connected")
	h.MilestoneScreenshot("usb-port-connected-h1")

	if err := usbBtn.Click(); err != nil {
		t.Fatalf("click USB Disconnect: %v", err)
	}
	h.WaitUntil("TopBar USB button returns to Connect state", 5*time.Second, func() (bool, error) {
		txt, err := usbBtn.InnerText()
		return err == nil && !strings.Contains(txt, "Connected"), nil
	})
}
