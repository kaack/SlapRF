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
	h.BootClean("#/live")

	// 1. Verify Portable /api/capabilities endpoint responds 200 OK with expected bridges enabled.
	resp, err := http.Get(h.BaseURL + "/api/capabilities")
	if err != nil {
		t.Fatalf("GET /api/capabilities failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("GET /api/capabilities status = %d, want 200; body=%s", resp.StatusCode, string(body))
	}
	var caps struct {
		Portable      bool `json:"portable"`
		LaprfEmulator bool `json:"laprfEmulator"`
		LaprfClient   bool `json:"laprfClient"`
		MultigpProxy  bool `json:"multigpProxy"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&caps); err != nil {
		t.Fatalf("decode /api/capabilities: %v", err)
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
		{id: "live", mustHave: `[data-practice-act="create-session-inline"]`},
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

	// 1. Verify separated Settings sections: "Datasource", "Timing devices", and "MultiGP".
	dsSec := h.Page.Locator(`[data-section-anchor="datasource"]`).First()
	tdSec := h.Page.Locator(`[data-section-anchor="timing-devices"]`).First()
	mgpSec := h.Page.Locator(`[data-section-anchor="multigp"]`).First()
	h.MustBeVisible(dsSec, "Datasource section")
	h.MustBeVisible(tdSec, "Timing devices section")
	h.MustBeVisible(mgpSec, "MultiGP section")

	dsHeading, _ := dsSec.Locator("h2").First().InnerText()
	if strings.TrimSpace(dsHeading) != "Datasource" {
		t.Fatalf("Datasource heading = %q, want %q", dsHeading, "Datasource")
	}
	tdHeading, _ := tdSec.Locator("h2").First().InnerText()
	if strings.TrimSpace(tdHeading) != "Timing devices" {
		t.Fatalf("Timing devices heading = %q, want %q", tdHeading, "Timing devices")
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

	// 3. Verify Timing system custom dropdown labels ("SlapRF (USB)", never "SlapRF ESP32-C5") and
	//    smooth custom-select switching to "LapRF 8-Way" and back.
	hwSelect := tdSec.Locator(`select[name="timing-hardware-mode"]`).First()
	slapOptText, _ := hwSelect.Locator(`option[value="slaprf"]`).InnerText()
	if strings.TrimSpace(slapOptText) != "SlapRF (USB)" {
		t.Fatalf("SlapRF option label = %q, want exact %q", slapOptText, "SlapRF (USB)")
	}

	h.SelectCustomOption(`select[name="timing-hardware-mode"]`, "LapRF 8-Way")
	h.MustBeVisible(tdSec.Locator(`text=Simulating LapRF 8-Way timers`).First(), "LapRF active description")

	// In LapRF mode, Flasher sidebar link is hidden.
	flasherNav := h.Page.Locator(`aside a[data-route="flasher"]`).First()
	h.MustBeHidden(flasherNav, "Flasher sidebar link while LapRF 8-Way is selected")
	h.MilestoneScreenshot("settings-laprf-selected")

	// Switch back to SlapRF and confirm Flasher link returns.
	h.SelectCustomOption(`select[name="timing-hardware-mode"]`, "SlapRF")
	h.MustBeVisible(
		tdSec.Locator(`.custom-select-trigger-label`, playwright.LocatorLocatorOptions{HasText: "SlapRF"}).First(),
		"SlapRF trigger label",
	)
	h.MustBeVisible(flasherNav, "Flasher sidebar link restored in SlapRF mode")
}
