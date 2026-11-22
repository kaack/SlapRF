//go:build e2e

package e2e_test

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/playwright-community/playwright-go"
)

func TestBootCleanStateAndSidebarNavigation(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/practice")

	// 1. Verify Portable /v1/capabilities endpoint responds 200 OK with expected bridges enabled.
	resp, err := http.Get(h.BaseURL + "/v1/capabilities")
	if err != nil {
		t.Fatalf("GET /v1/capabilities failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("GET /v1/capabilities status = %d, want 200; body=%s", resp.StatusCode, string(body))
	}
	var caps struct {
		Portable      bool `json:"portable"`
		LaprfEmulator bool `json:"laprfEmulator"`
		LaprfClient   bool `json:"laprfClient"`
		MultigpProxy  bool `json:"multigpProxy"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&caps); err != nil {
		t.Fatalf("decode /v1/capabilities: %v", err)
	}
	if !caps.Portable || !caps.LaprfEmulator || !caps.LaprfClient || !caps.MultigpProxy {
		t.Fatalf("unexpected capabilities payload: %+v", caps)
	}

	// 2. Clean boot defaults to Simulation on with Practice directory visible.
	simTopBtn := h.Page.Locator(`button[data-action="sim"]`).First()
	h.MustBeVisible(simTopBtn, "TopBar simulation button")
	if txt, _ := simTopBtn.InnerText(); !strings.Contains(txt, "Simulation on") {
		t.Fatalf("expected clean boot TopBar to show 'Simulation on', got %q", txt)
	}
	h.MilestoneScreenshot("boot-practice-directory")

	// 3. Navigate across every primary sidebar route and verify clean render + active nav state.
	routes := []struct {
		id       string
		mustHave string
	}{
		{id: "races", mustHave: `[data-race-act="create-race-inline"]`},
		{id: "pilots", mustHave: `[data-pilot-dir-search]`},
		{id: "track", mustHave: `[data-slot="track"]`},
		{id: "sim", mustHave: `[data-slot="course"]`},
		{id: "network", mustHave: `main`},
		{id: "setup", mustHave: `[data-section-anchor="datasource"]`},
		{id: "about", mustHave: `main`},
		{id: "practice", mustHave: `[data-practice-act="create-session-inline"]`},
	}

	for _, rt := range routes {
		h.NavigateSidebar(rt.id)
		h.MustBeVisible(h.Page.Locator(rt.mustHave).First(), "primary content for route "+rt.id)
	}
	h.MilestoneScreenshot("navigation-complete")
}

func TestSettingsSectionsHardwareSwitchAndMultiGPKeyMasking(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/setup")

	// 1. Verify Settings sections ("Datasource" and "MultiGP") and confirm "Timing devices" moved to #/network.
	dsSec := h.Page.Locator(`[data-section-anchor="datasource"]`).First()
	mgpSec := h.Page.Locator(`[data-section-anchor="multigp"]`).First()
	h.MustBeVisible(dsSec, "Datasource section")
	h.MustBeVisible(mgpSec, "MultiGP section")
	if n, _ := h.Page.Locator(`[data-section-anchor="timing-devices"]`).Count(); n != 0 {
		t.Fatalf("expected timing-devices section removed from #/setup, got count %d", n)
	}

	dsHeading, _ := dsSec.Locator("h2").First().InnerText()
	if strings.TrimSpace(dsHeading) != "Datasource" {
		t.Fatalf("Datasource heading = %q, want %q", dsHeading, "Datasource")
	}

	// 2. Verify MultiGP API key is masked as a password field by default, pre-filled with sim key,
	//    reveals/hides via the eye icon, verifies chapter, and restores sim key on Restore defaults.
	keyInput := mgpSec.Locator(`input[name="mgp-api-key"]`).First()
	h.MustBeVisible(keyInput, "MultiGP Chapter API key input")

	inType, _ := keyInput.GetAttribute("type")
	if inType != "password" {
		t.Fatalf("expected MultiGP API key input type='password' by default, got %q", inType)
	}
	defaultSimKey, _ := keyInput.InputValue()
	if strings.TrimSpace(defaultSimKey) == "" {
		t.Fatalf("expected MultiGP API key input to be pre-filled with simulated key in sim mode")
	}

	eyeBtn := mgpSec.Locator(`button[data-action="toggle-reveal"]`).First()
	if err := eyeBtn.Click(); err != nil {
		t.Fatalf("click eye reveal toggle: %v", err)
	}
	if revealedType, _ := keyInput.GetAttribute("type"); revealedType != "text" {
		t.Fatalf("expected MultiGP API key input type='text' after reveal click, got %q", revealedType)
	}
	if err := eyeBtn.Click(); err != nil {
		t.Fatalf("click eye hide toggle: %v", err)
	}
	if hiddenAgain, _ := keyInput.GetAttribute("type"); hiddenAgain != "password" {
		t.Fatalf("expected MultiGP API key input type='password' after second eye click, got %q", hiddenAgain)
	}

	// Click Verify and confirm simulated chapter connects cleanly.
	verifyBtn := mgpSec.Locator(`button[data-action="verify-mgp"]`).First()
	if err := verifyBtn.Click(); err != nil {
		t.Fatalf("click Verify MultiGP key: %v", err)
	}
	h.MustBeVisible(mgpSec.Locator(`text=Connected to`).First(), "Connected chapter badge")

	// Overwrite key with custom string, then Restore defaults -> must restore defaultSimKey.
	if err := keyInput.Fill("CUSTOM-OVERRIDDEN-KEY-999"); err != nil {
		t.Fatalf("fill custom MultiGP key: %v", err)
	}
	restoreBtn := mgpSec.Locator(`button[data-action="restore-mgp-defaults"]`).First()
	if err := restoreBtn.Click(); err != nil {
		t.Fatalf("click Restore defaults on MultiGP card: %v", err)
	}
	restoredVal, _ := keyInput.InputValue()
	if restoredVal != defaultSimKey {
		t.Fatalf("Restore defaults MultiGP key = %q, want %q", restoredVal, defaultSimKey)
	}
	h.MilestoneScreenshot("settings-multigp-masked-verified")

	// 3. Open #/network and verify inline Timing system custom dropdown labels ("SlapRF (USB)"),
	//    switching to "LapRF 8-Way (Network)" (starts disconnected so dropdown stays unlocked),
	//    connecting Ethernet (which locks the dropdown), disconnecting, and switching back.
	h.NavigateSidebar("network")
	modeSlot := h.Page.Locator(`[data-slot="network-mode-selector"]`).First()
	hwSelect := modeSlot.Locator(`select[data-field="network-hardware-mode"]`).First()
	slapOptText, _ := hwSelect.Locator(`option[value="slaprf"]`).InnerText()
	if strings.TrimSpace(slapOptText) != "SlapRF (USB)" {
		t.Fatalf("SlapRF option label = %q, want exact %q", slapOptText, "SlapRF (USB)")
	}

	h.SelectCustomOption(`select[data-field="network-hardware-mode"]`, "LapRF 8-Way (Network)")
	h.MustBeVisible(h.Page.Locator(`[data-slot="laprf-connection"]`).First(), "LapRF Ethernet connection card")

	// In LapRF mode, Flasher sidebar link is hidden.
	flasherNav := h.Page.Locator(`aside a[data-route="flasher"]`).First()
	h.MustBeHidden(flasherNav, "Flasher sidebar link while LapRF 8-Way is selected")
	h.MilestoneScreenshot("settings-laprf-selected")

	// Connect simulated L1 on #/network (which locks the dropdown), then disconnect L1 on its device card so the inline dropdown unlocks, and switch back to SlapRF (USB).
	connEthBtn := h.Page.Locator(`button[data-action="laprf-connect-eth"]`).First()
	if err := connEthBtn.Click(); err != nil {
		t.Fatalf("click Connect Ethernet on #/network: %v", err)
	}
	discBtn := h.Page.Locator(`button[data-action="laprf-disconnect"]`).First()
	h.MustBeVisible(discBtn, "Disconnect button on connected LapRF device card")
	if err := discBtn.Click(); err != nil {
		t.Fatalf("click device card Disconnect on #/network: %v", err)
	}
	h.SelectCustomOption(`select[data-field="network-hardware-mode"]`, "SlapRF (USB)")
	h.MustBeVisible(
		modeSlot.Locator(`.custom-select-trigger-label`, playwright.LocatorLocatorOptions{HasText: "SlapRF (USB)"}).First(),
		"SlapRF trigger label",
	)
	h.MustBeVisible(flasherNav, "Flasher sidebar link restored in SlapRF mode")
}
