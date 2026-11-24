//go:build e2e

package e2e_test

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/playwright-community/playwright-go"

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

	// 4. Open Stats Report and verify KPIs & Histogram render
	if err := page.Locator("[data-nav='#/stats']").Click(); err != nil {
		t.Fatalf("navigate to #/stats: %v", err)
	}
	txt, err := page.Locator(".stats-scroll").InnerText()
	if err != nil || !strings.Contains(txt, "GateCam Verification Report") {
		t.Fatalf("unexpected stats view text (err=%v): %s", err, txt)
	}

	// 5. Verify Passes & Settings main navigation routes in mobile portrait viewport
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
	shotDir := strings.TrimSpace(os.Getenv("SLAPRF_GATECAM_SCREENSHOT_DIR"))
	if shotDir != "" {
		_, _ = mobPage.Screenshot(playwright.PageScreenshotOptions{Path: playwright.String(filepath.Join(shotDir, "ui_mobile_live.png"))})
	}
	if err := mobPage.Locator(".sidebar [data-nav='#/passes']").Click(); err != nil {
		t.Fatalf("mobile click Passes tab: %v", err)
	}
	if err := mobPage.Locator("[data-pass-filter='valid']").WaitFor(); err != nil {
		t.Fatalf("mobile Passes filter bar missing: %v", err)
	}
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
	if err := mobPage.Locator(".sidebar [data-nav='#/stats']").Click(); err != nil {
		t.Fatalf("mobile click Accuracy tab: %v", err)
	}
	if shotDir != "" {
		_, _ = mobPage.Screenshot(playwright.PageScreenshotOptions{Path: playwright.String(filepath.Join(shotDir, "ui_mobile_stats.png"))})
	}
	if err := mobPage.Locator(".sidebar [data-nav='#/settings']").Click(); err != nil {
		t.Fatalf("mobile click Settings tab: %v", err)
	}
	if err := mobPage.Locator("#cfg-url").WaitFor(); err != nil {
		t.Fatalf("mobile Settings #cfg-url missing: %v", err)
	}
	if shotDir != "" {
		_, _ = mobPage.Screenshot(playwright.PageScreenshotOptions{Path: playwright.String(filepath.Join(shotDir, "ui_mobile_settings.png"))})
	}

	if len(pageErrs) > 0 {
		t.Fatalf("unexpected browser page errors: %v", pageErrs)
	}
}
