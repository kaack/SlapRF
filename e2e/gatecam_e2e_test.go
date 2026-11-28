//go:build e2e

package e2e_test

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mxschmitt/playwright-go"

	"slaprf/internal/gatecam"
	"slaprf/internal/portable"
)

func TestGateCamLiveAlignmentInspectorAndStatsE2E(t *testing.T) {
	tmp := t.TempDir()
	siteDir := filepath.Join(tmp, "site")
	if err := gatecam.BuildStaticSite(filepath.Join(suiteRepoRoot, "tools", "gatecam", "web"), siteDir); err != nil {
		t.Fatalf("BuildStaticSite: %v", err)
	}

	slapSrv := portable.NewServer(portable.Config{
		Version: "0.0.16-e2e",
		DBPath:  filepath.Join(tmp, "slaprf.db"),
		LogPath: filepath.Join(tmp, "slaprf.log"),
	})
	slapHTTP := httptest.NewServer(slapSrv.Handler())
	defer func() {
		slapHTTP.Close()
		slapSrv.Close()
	}()

	gcSrv := gatecam.NewServer(gatecam.Config{
		Version:     "0.1.0-e2e",
		DataDir:     filepath.Join(tmp, "gatecam"),
		StaticFS:    os.DirFS(siteDir),
		DefaultLink: slapHTTP.URL,
		Camera:      gatecam.NewSimCameraProvider(),
	})
	gcHTTP := httptest.NewServer(gcSrv.Handler())
	defer func() {
		gcHTTP.Close()
		gcSrv.Close()
	}()

	page, err := suiteBrowser.NewPage(playwright.BrowserNewPageOptions{
		Viewport: &playwright.Size{Width: 1280, Height: 720},
	})
	if err != nil {
		t.Fatalf("NewPage: %v", err)
	}
	defer page.Close()

	var pageErrs []string
	page.OnPageError(func(err error) {
		pageErrs = append(pageErrs, err.Error())
	})

	if _, err := page.Goto(gcHTTP.URL+"/#/", playwright.PageGotoOptions{
		WaitUntil: playwright.WaitUntilStateDomcontentloaded,
	}); err != nil {
		t.Fatalf("Goto GateCam: %v", err)
	}

	// 1. Verify Live Gate Alignment SVG overlay & + Sim Pass button render
	if err := page.Locator("#live-gate-svg [data-handle='p1']").WaitFor(); err != nil {
		t.Fatalf("missing P1 SVG handle: %v", err)
	}
	if err := page.Locator("[data-act='sim-pass']").Click(); err != nil {
		t.Fatalf("click + Sim Pass: %v", err)
	}

	// 2. Verify pass card #1 VORTEX appears and open Frame Inspector
	passCard := page.Locator("[data-open-pass='1']")
	if err := passCard.WaitFor(); err != nil {
		t.Fatalf("pass card #1 did not appear: %v", err)
	}
	if err := passCard.Click(); err != nil {
		t.Fatalf("click pass card #1: %v", err)
	}

	// 3. Step +1 frame, toggle MOG2 Mask, and Pin Frame as Manual Crossing
	if err := page.Locator("#insp-img").WaitFor(); err != nil {
		t.Fatalf("inspector image did not render: %v", err)
	}
	if err := page.Locator("[data-insp-step='1']").Click(); err != nil {
		t.Fatalf("step +1 frame: %v", err)
	}
	if err := page.Locator("[data-insp-toggle='mask']").Click(); err != nil {
		t.Fatalf("toggle MOG2 Mask: %v", err)
	}
	if err := page.Locator("[data-act='pin-frame']").Click(); err != nil {
		t.Fatalf("click Pin Frame: %v", err)
	}
	if err := page.Locator(".badge.manual").WaitFor(); err != nil {
		t.Fatalf("expected MANUAL badge after pinning frame: %v", err)
	}

	// 4. Open Accuracy (#/stats) and Speeds (#/speeds) reports and verify headers & inline ZIP/CSV
	if err := page.Locator(".sidebar [data-nav='#/stats']").Click(); err != nil {
		t.Fatalf("navigate to #/stats: %v", err)
	}
	txt, err := page.Locator(".stats-scroll").InnerText()
	if err != nil || !strings.Contains(txt, "Verification Report") || strings.Contains(txt, "GateCam Verification Report") {
		t.Fatalf("unexpected stats view text (err=%v): %s", err, txt)
	}
	if err := page.Locator(".sidebar [data-nav='#/speeds']").Click(); err != nil {
		t.Fatalf("navigate to #/speeds: %v", err)
	}
	speedsTxt, err := page.Locator(".speeds-view").InnerText()
	if err != nil || !strings.Contains(speedsTxt, "Bias by Drone Speed") || !strings.Contains(speedsTxt, "Start-to-Start Lap Summary") {
		t.Fatalf("unexpected speeds view text (err=%v): %s", err, speedsTxt)
	}

	// 5. Verify mobile portrait layout: zero vertical page scroll on Camera/Passes/Accuracy/Speeds,
	// constant "Line" lock label, 60fps shutter bar without zoom duplicate, and instant Settings
	mobCtx, err := suiteBrowser.NewContext(playwright.BrowserNewContextOptions{
		Viewport:          &playwright.Size{Width: 412, Height: 915},
		DeviceScaleFactor: playwright.Float(2.0),
	})
	if err != nil {
		t.Fatalf("NewContext mobile: %v", err)
	}
	defer mobCtx.Close()
	mobPage, err := mobCtx.NewPage()
	if err != nil {
		t.Fatalf("NewPage mobile: %v", err)
	}
	mobPage.OnPageError(func(err error) {
		pageErrs = append(pageErrs, err.Error())
	})
	if _, err := mobPage.Goto(gcHTTP.URL+"/#/", playwright.PageGotoOptions{
		WaitUntil: playwright.WaitUntilStateDomcontentloaded,
	}); err != nil {
		t.Fatalf("Goto mobile GateCam: %v", err)
	}
	if err := mobPage.Locator("[data-open-pass='1']").WaitFor(); err != nil {
		t.Fatalf("mobile pass card #1 missing: %v", err)
	}

	assertNoPageScroll := func(label string) {
		t.Helper()
		overflow, err := mobPage.Evaluate(`() => {
			const docEl = document.scrollingElement || document.documentElement;
			const fitEl = document.querySelector('.page-fit-inner');
			return {
				docOverflow: docEl.scrollHeight - docEl.clientHeight,
				fitOverflow: fitEl ? (fitEl.scrollHeight - fitEl.clientHeight) : 0,
			};
		}`)
		if err != nil {
			t.Fatalf("%s evaluate overflow: %v", label, err)
		}
		m := overflow.(map[string]interface{})
		if v, ok := m["docOverflow"].(int); ok && v > 1 {
			t.Fatalf("%s has unexpected vertical page scroll overflow: %d px", label, v)
		}
		if v, ok := m["docOverflow"].(float64); ok && v > 1 {
			t.Fatalf("%s has unexpected vertical page scroll overflow: %.1f px", label, v)
		}
		if v, ok := m["fitOverflow"].(int); ok && v > 1 {
			t.Fatalf("%s has unexpected .page-fit-inner vertical clip overflow: %d px", label, v)
		}
		if v, ok := m["fitOverflow"].(float64); ok && v > 1 {
			t.Fatalf("%s has unexpected .page-fit-inner vertical clip overflow: %.1f px", label, v)
		}
	}

	// Verify "Line" lock button keeps exact text "Line" when locked and unlocked
	lockBtn := mobPage.Locator("[data-act='toggle-lock']")
	lockTxtBefore, err := lockBtn.InnerText()
	if err != nil || strings.TrimSpace(lockTxtBefore) != "Line" {
		t.Fatalf("expected lock button text 'Line' before click, got %q (err=%v)", lockTxtBefore, err)
	}
	if err := lockBtn.Click(); err != nil {
		t.Fatalf("click toggle-lock: %v", err)
	}
	if err := mobPage.Locator("[data-act='toggle-lock'].is-locked").WaitFor(); err != nil {
		t.Fatalf("expected .is-locked class after clicking Line lock: %v", err)
	}
	lockTxtAfter, err := lockBtn.InnerText()
	if err != nil || strings.TrimSpace(lockTxtAfter) != "Line" {
		t.Fatalf("expected lock button text to remain 'Line' when locked, got %q (err=%v)", lockTxtAfter, err)
	}
	// Unlock again
	if err := lockBtn.Click(); err != nil {
		t.Fatalf("click toggle-lock to unlock: %v", err)
	}

	// Switch to 60 fps and verify Shutter bar has no zoom selector and fits on one line
	if err := mobPage.Locator("[data-fps='60']").Click(); err != nil {
		t.Fatalf("click 60 fps: %v", err)
	}
	if err := mobPage.Locator(".cam-toolbar [data-shutter-val='1000']").WaitFor(); err != nil {
		t.Fatalf("60 fps shutter toolbar did not appear: %v", err)
	}
	if zCnt, _ := mobPage.Locator(".cam-toolbar [data-zoom]").Count(); zCnt != 0 {
		t.Fatalf("expected zero zoom selectors in .cam-toolbar, found %d", zCnt)
	}
	toolbarOverflow, err := mobPage.Evaluate(`() => {
		const row = document.querySelector('.cam-toolbar-row');
		return row ? (row.scrollWidth - row.clientWidth) : 999;
	}`)
	if err != nil {
		t.Fatalf("evaluate .cam-toolbar-row overflow: %v", err)
	}
	switch v := toolbarOverflow.(type) {
	case int:
		if v > 1 {
			t.Fatalf("60 fps shutter row overflows horizontally by %d px", v)
		}
	case float64:
		if v > 1 {
			t.Fatalf("60 fps shutter row overflows horizontally by %.1f px", v)
		}
	}

	assertNoPageScroll("Camera (60 fps)")
	shotDir := strings.TrimSpace(os.Getenv("SLAPRF_GATECAM_SCREENSHOT_DIR"))
	if shotDir != "" {
		_, _ = mobPage.Screenshot(playwright.PageScreenshotOptions{Path: playwright.String(filepath.Join(shotDir, "ui_mobile_live.png"))})
	}

	// Passes tab
	if err := mobPage.Locator(".sidebar [data-nav='#/passes']").Click(); err != nil {
		t.Fatalf("mobile click Passes tab: %v", err)
	}
	if err := mobPage.Locator("[data-pass-filter='valid']").WaitFor(); err != nil {
		t.Fatalf("mobile Passes filter bar missing: %v", err)
	}
	assertNoPageScroll("Passes")
	if err := mobPage.Locator("[data-open-pass='1']").Click(); err != nil {
		t.Fatalf("mobile open pass #1: %v", err)
	}
	if err := mobPage.Locator("#insp-img").WaitFor(); err != nil {
		t.Fatalf("mobile inspector img missing: %v", err)
	}
	if shotDir != "" {
		_, _ = mobPage.Screenshot(playwright.PageScreenshotOptions{Path: playwright.String(filepath.Join(shotDir, "ui_mobile_inspector.png"))})
	}
	if err := mobPage.Locator(".topbar [data-nav]").First().Click(); err != nil {
		t.Fatalf("mobile click Back from inspector: %v", err)
	}

	// Accuracy (#/stats) tab: verify Verification Report + inline top-right ZIP & CSV + zero vertical scroll
	if err := mobPage.Locator(".sidebar [data-nav='#/stats']").Click(); err != nil {
		t.Fatalf("mobile click Accuracy tab: %v", err)
	}
	if err := mobPage.Locator(".stats-scroll .report-header h2").WaitFor(); err != nil {
		t.Fatalf("mobile Accuracy header missing: %v", err)
	}
	headerAligned, err := mobPage.Evaluate(`() => {
		const h2 = document.querySelector('.stats-scroll .report-header h2');
		const zip = document.querySelector('.stats-scroll .report-actions a[href="/v1/gatecam/export.zip"]');
		const csv = document.querySelector('.stats-scroll .report-actions a[href="/v1/gatecam/report.csv"]');
		if (!h2 || !zip || !csv) return { ok: false, reason: 'missing elements' };
		const hr = h2.getBoundingClientRect();
		const zr = zip.getBoundingClientRect();
		const cr = csv.getBoundingClientRect();
		return {
			ok: Math.abs(hr.top - zr.top) < 12 && Math.abs(zr.top - cr.top) < 4 && zr.left > hr.right - 2,
			h2Text: h2.textContent.trim(),
			zipText: zip.textContent.trim(),
			csvText: csv.textContent.trim(),
		};
	}`)
	if err != nil {
		t.Fatalf("evaluate Accuracy header alignment: %v", err)
	}
	hm := headerAligned.(map[string]interface{})
	if hm["ok"] != true || hm["h2Text"] != "Verification Report" || hm["zipText"] != "ZIP" || hm["csvText"] != "CSV" {
		t.Fatalf("unexpected Accuracy header layout/labels: %+v", hm)
	}
	assertNoPageScroll("Accuracy")
	if shotDir != "" {
		_, _ = mobPage.Screenshot(playwright.PageScreenshotOptions{Path: playwright.String(filepath.Join(shotDir, "ui_mobile_stats.png"))})
	}

	// Speeds (#/speeds) tab: verify zero vertical scroll
	if err := mobPage.Locator(".sidebar [data-nav='#/speeds']").Click(); err != nil {
		t.Fatalf("mobile click Speeds tab: %v", err)
	}
	if err := mobPage.Locator(".speeds-view").WaitFor(); err != nil {
		t.Fatalf("mobile Speeds view missing: %v", err)
	}
	assertNoPageScroll("Speeds")
	if shotDir != "" {
		_, _ = mobPage.Screenshot(playwright.PageScreenshotOptions{Path: playwright.String(filepath.Join(shotDir, "ui_mobile_speeds.png"))})
	}

	// Open More drawer -> Settings, verify no Save button and immediate settings persistence
	if err := mobPage.Locator("[data-act='toggle-more']").Click(); err != nil {
		t.Fatalf("open More drawer: %v", err)
	}
	if err := mobPage.Locator(".more-drawer-sheet .more-theme-bar").WaitFor(); err != nil {
		t.Fatalf("More drawer theme bar did not appear: %v", err)
	}
	if err := mobPage.Locator(".more-drawer-sheet [data-theme-set='light']").Click(); err != nil {
		t.Fatalf("click Light theme in More drawer: %v", err)
	}
	if err := mobPage.Locator(".more-drawer-sheet [data-theme-set='dark']").Click(); err != nil {
		t.Fatalf("click Dark theme in More drawer: %v", err)
	}
	_, _ = mobPage.Evaluate(`() => new Promise(r => setTimeout(r, 240))`)
	if shotDir != "" {
		_, _ = mobPage.Screenshot(playwright.PageScreenshotOptions{Path: playwright.String(filepath.Join(shotDir, "ui_mobile_more.png"))})
	}

	if err := mobPage.Locator(".more-drawer-sheet [data-nav='#/settings']").Click(); err != nil {
		t.Fatalf("click Settings tile in More drawer: %v", err)
	}
	if err := mobPage.Locator("#cfg-url").WaitFor(); err != nil {
		t.Fatalf("mobile Settings #cfg-url missing: %v", err)
	}
	if selCnt, _ := mobPage.Locator("select").Count(); selCnt != 0 {
		t.Fatalf("expected zero native <select> elements, found %d", selCnt)
	}
	if saveCnt, _ := mobPage.Locator("button:has-text('Save')").Count(); saveCnt != 0 {
		t.Fatalf("expected zero Save Settings buttons, found %d", saveCnt)
	}
	if err := mobPage.Locator("[data-cfg-lb='300']").Click(); err != nil {
		t.Fatalf("click 300ms lookback: %v", err)
	}
	if err := mobPage.Locator("[data-cfg-model='knn']").Click(); err != nil {
		t.Fatalf("click KNN motion model: %v", err)
	}
	persistedCfg, err := mobPage.Evaluate(`async () => {
		const r = await fetch('/v1/gatecam/state');
		const s = await r.json();
		return { lb: s.camera.lookbackHalfMs, model: s.camera.motionModel };
	}`)
	if err != nil {
		t.Fatalf("fetch /v1/gatecam/state after instant settings change: %v", err)
	}
	pm := persistedCfg.(map[string]interface{})
	if pm["model"] != "knn" {
		t.Fatalf("expected instant motionModel='knn', got %+v", pm)
	}

	if err := mobPage.Locator("[data-act='discover-link']").Click(); err != nil {
		t.Fatalf("click Discover button: %v", err)
	}
	if err := mobPage.Locator("[data-act='toggle-pilot-select']").Click(); err != nil {
		t.Fatalf("open custom pilot selector: %v", err)
	}
	if err := mobPage.Locator(".custom-select-menu").WaitFor(); err != nil {
		t.Fatalf("custom pilot selector menu did not open: %v", err)
	}
	if shotDir != "" {
		_, _ = mobPage.Screenshot(playwright.PageScreenshotOptions{Path: playwright.String(filepath.Join(shotDir, "ui_mobile_settings.png"))})
	}
	if err := mobPage.Locator("[data-pilot-opt='0']").Click(); err != nil {
		t.Fatalf("select All Active Pilots option: %v", err)
	}

	if len(pageErrs) > 0 {
		t.Fatalf("unexpected browser page errors: %v", pageErrs)
	}
}
