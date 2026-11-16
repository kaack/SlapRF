//go:build e2e

package e2e_test

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/playwright-community/playwright-go"

	"slaprf/internal/portable"
)

func TestClientServer_NativeBackendZeroWasmBboltMultiTabAndServerRestart(t *testing.T) {
	h := NewHarness(t)

	// Track all network requests to prove zero .wasm files are requested in Native Go Backend Mode.
	var wasmRequests []string
	h.Page.OnRequest(func(req playwright.Request) {
		if strings.Contains(strings.ToLower(req.URL()), ".wasm") {
			wasmRequests = append(wasmRequests, req.URL())
		}
	})

	h.BootClean("#/setup")

	// 1. Verify window.slaprfWasm is completely absent and zero .wasm files were loaded.
	wasmUndefined, err := h.Page.Evaluate(`() => typeof window.slaprfWasm === "undefined"`)
	if err != nil {
		t.Fatalf("evaluate window.slaprfWasm: %v", err)
	}
	if ok, _ := wasmUndefined.(bool); !ok {
		t.Fatalf("expected window.slaprfWasm to be undefined in Native Go Backend Mode")
	}
	if len(wasmRequests) > 0 {
		t.Fatalf("expected zero .wasm network requests in Native Go Backend Mode, got %v", wasmRequests)
	}

	// 2. Verify #/setup Persistence section displays bbolt (slaprf.db) and slaprf.db exists on disk.
	storageStatus := h.Page.Locator(`[data-storage-status]`).First()
	h.MustBeVisible(storageStatus, "Persistence storage status line")
	h.MustContainText(storageStatus, "bbolt (slaprf.db)", "bbolt storage backend label")

	info, statErr := os.Stat(h.DBPath)
	if statErr != nil || info.Size() == 0 {
		t.Fatalf("expected non-empty bbolt database file at %s, statErr=%v", h.DBPath, statErr)
	}
	h.MilestoneScreenshot("native-backend-setup-bbolt")

	// 3. Open a second browser tab simultaneously in the same BrowserContext:
	//    verify ZERO multi-tab conflict screen and live real-time WebSocket sync across both tabs!
	h.NavigateSidebar("pilots")
	page2, err := h.Ctx.NewPage()
	if err != nil {
		t.Fatalf("NewPage (tab 2): %v", err)
	}
	h.AttachErrorGuards(page2)
	if _, err := page2.Goto(h.BaseURL+"/#/pilots", playwright.PageGotoOptions{
		WaitUntil: playwright.WaitUntilStateDomcontentloaded,
	}); err != nil {
		t.Fatalf("tab 2 Goto: %v", err)
	}

	h.WaitUntil("Tab 2 boots cleanly without single-tab conflict screen", 12*time.Second, func() (bool, error) {
		r2, evalErr := page2.Evaluate(`() => {
			const loader = document.getElementById("slaprf-boot-loader");
			const app = document.getElementById("app");
			return Boolean(
				typeof window.slaprfWasm === "undefined" &&
				loader && loader.classList.contains("is-ready") && !loader.classList.contains("is-conflict") &&
				app && !app.hidden && app.childElementCount > 0
			);
		}`)
		if evalErr != nil {
			return false, nil
		}
		ok, _ := r2.(bool)
		return ok, nil
	})

	// Add a new pilot ("NovaServerFPV") in Tab 1 and verify Tab 2 receives the update live over /api/ws/stream!
	searchInput1 := h.Page.Locator(`input[data-pilot-dir-search]`).First()
	h.MustBeVisible(searchInput1, "Tab 1 pilot search/add input")
	if err := searchInput1.Fill("NovaServerFPV"); err != nil {
		t.Fatalf("fill NovaServerFPV in Tab 1: %v", err)
	}
	if err := h.Page.Locator(`button[data-action="add-pilot"]:not([disabled])`).First().Click(); err != nil {
		t.Fatalf("click Add pilot in Tab 1: %v", err)
	}

	pageSummary2 := page2.Locator(`.pilot-dir-page-summary`).First()
	h.WaitUntil("Tab 2 updates live to 11 pilots via /api/ws/stream", 8*time.Second, func() (bool, error) {
		txt, txtErr := pageSummary2.InnerText()
		if txtErr != nil {
			return false, nil
		}
		return strings.Contains(txt, "of 11"), nil
	})
	h.MilestoneScreenshot("multi-tab-live-ws-sync")
	_ = page2.Close()

	// 4. Switch to Real Mode (Simulation OFF), add a real-hardware pilot ("TracksideReal"),
	//    then restart a brand-new portable.Server on the same slaprf.db file to prove server-side persistence!
	simBtn1 := h.Page.Locator(`button[data-action="sim"]`).First()
	if err := simBtn1.Click(); err != nil {
		t.Fatalf("toggle Simulation OFF in Tab 1: %v", err)
	}
	h.WaitUntil("TopBar switches to Simulation off", 6*time.Second, func() (bool, error) {
		txt, txtErr := simBtn1.InnerText()
		return txtErr == nil && strings.Contains(txt, "Simulation off"), nil
	})

	if err := searchInput1.Fill("TracksideReal"); err != nil {
		t.Fatalf("fill TracksideReal in Real Mode: %v", err)
	}
	if err := h.Page.Locator(`button[data-action="add-pilot"]:not([disabled])`).First().Click(); err != nil {
		t.Fatalf("click Add TracksideReal: %v", err)
	}
	h.WaitUntil("Real engine records TracksideReal", 6*time.Second, func() (bool, error) {
		st := h.APIState()
		for _, p := range st.Pilots {
			if p.Callsign == "TracksideReal" {
				return true, nil
			}
		}
		return false, nil
	})

	// Close the original Go server (flushing bbolt cleanly) and spin up a fresh portable.Server on a copy of slaprf.db.
	dbCopy := filepath.Join(h.TestDir, "restarted-slaprf.db")
	h.Server.Close()
	rawDB, readErr := os.ReadFile(h.DBPath)
	if readErr != nil || len(rawDB) == 0 {
		t.Fatalf("read flushed slaprf.db: %v", readErr)
	}
	if writeErr := os.WriteFile(dbCopy, rawDB, 0o644); writeErr != nil {
		t.Fatalf("copy slaprf.db: %v", writeErr)
	}

	restartedSrv := portable.NewServer(portable.Config{
		Version:         "e2e-restarted",
		StaticFS:        os.DirFS(suitePortableSiteDir),
		DBPath:          dbCopy,
		AllowLANOrigins: true,
	})
	defer restartedSrv.Close()
	restartedHTTP := httptest.NewServer(restartedSrv.Handler())
	defer restartedHTTP.Close()

	pageRestarted, err := h.Ctx.NewPage()
	if err != nil {
		t.Fatalf("NewPage for restarted server: %v", err)
	}
	h.AttachErrorGuards(pageRestarted)
	if _, err := pageRestarted.Goto(restartedHTTP.URL+"/#/pilots", playwright.PageGotoOptions{
		WaitUntil: playwright.WaitUntilStateDomcontentloaded,
	}); err != nil {
		t.Fatalf("Goto restarted server: %v", err)
	}

	h.WaitUntil("Restarted Go server restores Real Mode + TracksideReal from slaprf.db", 12*time.Second, func() (bool, error) {
		res, evalErr := pageRestarted.Evaluate(`async () => {
			const simBtn = document.querySelector('button[data-action="sim"]');
			const simOff = Boolean(simBtn && (simBtn.textContent || "").includes("Simulation off"));
			const r = await fetch("/api/state");
			if (!r.ok) return false;
			const st = await r.json();
			const hasPilot = Array.isArray(st.pilots) && st.pilots.some((p) => p.callsign === "TracksideReal");
			return simOff && hasPilot;
		}`)
		if evalErr != nil {
			return false, nil
		}
		ok, _ := res.(bool)
		return ok, nil
	})
	_ = pageRestarted.Close()
}

func TestClientServer_StandaloneDemoModeAndCrossOriginBackendConnect(t *testing.T) {
	h := NewHarnessWithOptions(t, HarnessOptions{StaticDemoMode: true})
	h.AllowConsoleErrorSubstring("Failed to load resource")
	h.AllowConsoleErrorSubstring("ERR_CONNECTION")

	h.BootClean("#/")

	// 1. Verify Standalone Browser Demo Mode boots slim slaprf.wasm, keeps Simulation ON,
	//    and shows the sidebar Browser Demo disclaimer that navigates to Settings -> Datasource (never a modal).
	wasmDefined, err := h.Page.Evaluate(`() => typeof window.slaprfWasm === "object" && window.slaprfWasm !== null`)
	if err != nil {
		t.Fatalf("evaluate window.slaprfWasm in Demo Mode: %v", err)
	}
	if ok, _ := wasmDefined.(bool); !ok {
		t.Fatalf("expected window.slaprfWasm to be loaded in Standalone Browser Demo Mode")
	}

	// 1b. Verify unseeded first boot in Standalone Browser Demo Mode automatically loads the showcase
	//     demo dataset (Connected · H1, 4 SlapRF timers = Hub + 3 Spokes on 3 gates, 3 practices, 4 races)
	//     and renders the TopBar PWA install icon button ONLY on mobile viewports.
	pwaBtn := h.Page.Locator(`.topbar-actions button[data-action="install-pwa"]`).First()
	h.MustBeHidden(pwaBtn, "TopBar PWA install icon button hidden on desktop")
	if err := h.Page.SetViewportSize(390, 844); err != nil {
		t.Fatalf("resize to mobile viewport: %v", err)
	}
	h.MustBeVisible(pwaBtn, "TopBar PWA install icon button visible on mobile")
	if err := pwaBtn.Click(); err != nil {
		t.Fatalf("click TopBar PWA install button: %v", err)
	}
	h.MustBeVisible(h.Page.Locator(`[data-pwa-install-popover]`).First(), "PWA install guide popover")
	if err := h.Page.Locator(`button[data-action="close-pwa-popover"]`).First().Click(); err != nil {
		t.Fatalf("close PWA install popover: %v", err)
	}
	menuBtn := h.Page.Locator(`.topbar-menu-btn[data-action="menu"]`).First()
	h.MustBeVisible(menuBtn, "Mobile hamburger menu button")
	if err := menuBtn.Click(); err != nil {
		t.Fatalf("open mobile hamburger menu: %v", err)
	}
	h.MustBeVisible(h.Page.Locator(`.topbar-nav-popover`).First(), "Mobile nav popover opened")
	if err := menuBtn.Click(); err != nil {
		t.Fatalf("close mobile hamburger menu: %v", err)
	}
	h.MustBeHidden(h.Page.Locator(`.topbar-nav-popover`).First(), "Mobile nav popover closed")
	if err := h.Page.SetViewportSize(1440, 900); err != nil {
		t.Fatalf("restore desktop viewport: %v", err)
	}

	h.WaitUntil("Showcase demo dataset hydrated with Connected · H1, Practice All Pilots, and Announcer ON", 8*time.Second, func() (bool, error) {
		res, evalErr := h.Page.Evaluate(`() => {
			const usbBtn = document.querySelector('[data-action="usb-toggle"]')?.textContent || "";
			const annBtn = document.querySelector('[data-action="announcer"]');
			const raw = window.slaprfWasm?.request("GET", "/api/state", "")?.body || "{}";
			const st = JSON.parse(raw);
			const timers = Array.isArray(st.timers) ? st.timers : [];
			const gates = Array.isArray(st.gates) ? st.gates : [];
			const sessions = Array.isArray(st.practiceState?.sessions) ? st.practiceState.sessions : [];
			const races = Array.isArray(st.eventState?.races) ? st.eventState.races : [];
			const allOnline = timers.length === 4 && timers.every((t) => Boolean(t.online));
			const onPractice = window.location.hash.startsWith("#/live");
			const annOn = Boolean(annBtn && annBtn.classList.contains("btn-armed"));
			return (
				onPractice &&
				annOn &&
				usbBtn.includes("H1") &&
				st.timingHardwareMode === "slaprf" &&
				allOnline &&
				gates.length === 3 &&
				sessions.length === 3 &&
				races.length === 4
			);
		}`)
		if evalErr != nil {
			return false, nil
		}
		ok, _ := res.(bool)
		return ok, nil
	})

	demoDisclaimer := h.Page.Locator(`button[data-demo-disclaimer="1"], button.sidebar-demo-disclaimer`).First()
	h.MustBeVisible(demoDisclaimer, "Sidebar Demo disclaimer")
	h.MustContainText(demoDisclaimer, "Browser Demo", "Sidebar Demo disclaimer title")
	if err := demoDisclaimer.Click(); err != nil {
		t.Fatalf("click Sidebar Demo disclaimer: %v", err)
	}

	dsSec := h.Page.Locator(`[data-section-anchor="datasource"]`).First()
	h.MustBeVisible(dsSec, "Settings Datasource section opened from Demo badge")
	h.WaitUntil("URL navigated to #/setup/datasource with zero modal", 5*time.Second, func() (bool, error) {
		res, evalErr := h.Page.Evaluate(`() => ({
			hash: window.location.hash,
			modal: Boolean(document.querySelector('[data-backend-connect-modal]')),
			demoActive: Boolean(document.querySelector('[data-backend-mode="demo"].is-active'))
		})`)
		if evalErr != nil {
			return false, nil
		}
		m, _ := res.(map[string]any)
		hash, _ := m["hash"].(string)
		hasModal, _ := m["modal"].(bool)
		demoActive, _ := m["demoActive"].(bool)
		return (hash == "#/setup/datasource" || hash == "#/setup") && !hasModal && demoActive, nil
	})

	// 2. Verify Wipe Application Data + Restore Demo Data navigates to active Practice session
	//    with All Pilots viewed and Announcer turned ON.
	if err := h.Page.Locator(`button[data-action="wipe-data"]`).First().Click(); err != nil {
		t.Fatalf("click Wipe Data button: %v", err)
	}
	if err := h.Page.Locator(`button[data-modal-confirm]`).First().Click(); err != nil {
		t.Fatalf("confirm Wipe Data modal: %v", err)
	}
	h.WaitUntil("App wiped to 0 pilots", 5*time.Second, func() (bool, error) {
		raw, _ := h.Page.Evaluate(`() => window.slaprfWasm?.request("GET", "/api/state", "")?.body || "{}"`)
		s, _ := raw.(string)
		return strings.Contains(s, `"pilots":[]`), nil
	})
	if err := h.Page.Locator(`button[data-action="restore-demo-data"]`).First().Click(); err != nil {
		t.Fatalf("click Restore Demo Data button: %v", err)
	}
	if err := h.Page.Locator(`button[data-modal-confirm]`).First().Click(); err != nil {
		t.Fatalf("confirm Restore Demo Data modal: %v", err)
	}
	h.WaitUntil("Restore Demo Data navigates to Practice session with Announcer ON", 8*time.Second, func() (bool, error) {
		res, evalErr := h.Page.Evaluate(`() => {
			const annBtn = document.querySelector('[data-action="announcer"]');
			const usbBtn = document.querySelector('[data-action="usb-toggle"]')?.textContent || "";
			return (
				window.location.hash.startsWith("#/live/open-track-practice") &&
				Boolean(annBtn && annBtn.classList.contains("btn-armed")) &&
				usbBtn.includes("H1")
			);
		}`)
		if evalErr != nil {
			return false, nil
		}
		ok, _ := res.(bool)
		return ok, nil
	})
	// Return to Settings -> Datasource for hardware & server checks
	if err := demoDisclaimer.Click(); err != nil {
		t.Fatalf("return to Settings Datasource after Restore Demo Data: %v", err)
	}
	h.MustBeVisible(dsSec, "Settings Datasource section re-opened")

	// 2b. Verify all 3 timing systems (SlapRF, LapRF 8-Way, RotorHazard) work in Simulator Demo Mode!
	h.SelectCustomOption(`select[name="timing-hardware-mode"]`, "LapRF 8-Way")
	h.MustContainText(h.Page.Locator(`[data-section-anchor="timing-devices"]`).First(), "Simulating LapRF 8-Way timers")
	h.SelectCustomOption(`select[name="timing-hardware-mode"]`, "RotorHazard (Network)")
	h.MustContainText(h.Page.Locator(`[data-section-anchor="timing-devices"]`).First(), "Simulating RotorHazard network timing devices")
	h.SelectCustomOption(`select[name="timing-hardware-mode"]`, "SlapRF")

	// 3. Clicking "Server" in the Datasource Backend toggle opens the inline server connection panel (no modal!).
	serverModeBtn := dsSec.Locator(`button[data-backend-mode="server"]`).First()
	if err := serverModeBtn.Click(); err != nil {
		t.Fatalf("click Server backend mode button in Demo Mode: %v", err)
	}
	autoDiscSec := dsSec.Locator(`[data-datasource-subsection="auto-discovery"]`).First()
	h.MustBeVisible(autoDiscSec, "Auto Discovery subsection above Manual Connection")
	discoverBtn := autoDiscSec.Locator(`button[data-action="discover-local-app"]`).First()
	h.MustBeVisible(discoverBtn, "On-demand Discover Local Server button in Auto Discovery")
	h.MustContainText(discoverBtn, "Discover Local Server", "Discover Local Server button text")

	serverForm := dsSec.Locator(`[data-datasource-subsection="manual-connection"]`).First()
	h.MustBeVisible(serverForm, "Inline Manual Connection subsection without modal")
	h.MilestoneScreenshot("demo-mode-inline-datasource-server")

	// 4. Spin up a live cross-origin Native Go SlapRF Server (`AllowLANOrigins: true`),
	//    enter its URL into the inline Datasource Server input, click Connect, and verify the static site reloads
	//    into Native Go Backend Mode (zero WASM loaded, no Demo badge on TopBar, Server active in Datasource)!
	remoteDB := filepath.Join(h.TestDir, "remote-pi-slaprf.db")
	remoteSrv := portable.NewServer(portable.Config{
		Version:         "v2.5.0-lan",
		DBPath:          remoteDB,
		AllowLANOrigins: true,
	})
	defer remoteSrv.Close()
	remoteHTTP := httptest.NewServer(remoteSrv.Handler())
	defer remoteHTTP.Close()

	urlInput := dsSec.Locator(`input[data-field="backend-url"]`).First()
	if err := urlInput.Fill(remoteHTTP.URL); err != nil {
		t.Fatalf("fill remote server URL: %v", err)
	}
	if err := dsSec.Locator(`button[data-action="backend-connect-submit"]`).First().Click(); err != nil {
		t.Fatalf("click Connect in Datasource Server form: %v", err)
	}

	h.WaitUntil("Static site reloads connected cross-origin to Native Go Server with zero WASM", 15*time.Second, func() (bool, error) {
		res, evalErr := h.Page.Evaluate(`() => {
			const loader = document.getElementById("slaprf-boot-loader");
			const app = document.getElementById("app");
			const demoBrand = document.querySelector('.brand.is-demo');
			const demoDisclaimer = document.querySelector('button[data-demo-disclaimer="1"]:not([hidden])');
			const serverActive = document.querySelector('[data-backend-mode="server"].is-active');
			return Boolean(
				typeof window.slaprfWasm === "undefined" &&
				loader && loader.classList.contains("is-ready") &&
				app && !app.hidden &&
				!demoBrand &&
				!demoDisclaimer &&
				serverActive
			);
		}`)
		if evalErr != nil {
			return false, nil
		}
		ok, _ := res.(bool)
		return ok, nil
	})

	// Verify #/setup now reports bbolt (slaprf.db) from the remote Go server!
	h.MustContainText(h.Page.Locator(`[data-storage-status]`).First(), "bbolt (slaprf.db)")
	h.MilestoneScreenshot("static-site-connected-to-remote-go-server")
}
