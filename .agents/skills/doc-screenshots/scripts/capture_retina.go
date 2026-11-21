//go:build ignore

// Command capture_retina generates crisp 2x Retina (DeviceScaleFactor: 2.0) dark and light mode
// screenshots of SlapRF against a seeded local Portable demo server.
//
// Usage:
//
//	# Regenerate all 6 matched dark/light README showcase screenshots into ./docs/
//	go run .agents/skills/doc-screenshots/scripts/capture_retina.go
//
//	# Capture a custom route pair (<out>-dark.png and <out>-light.png)
//	go run .agents/skills/doc-screenshots/scripts/capture_retina.go -route "#/network" -out docs-site/static/images/network-2x -selector ".card, .panel"
package main

import (
	"flag"
	"fmt"
	"log"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/playwright-community/playwright-go"

	"slaprf/internal/portable"
)

func main() {
	siteDirFlag := flag.String("site", "", "Prebuilt WASM-free static site directory (builds into temp dir if omitted)")
	routeFlag := flag.String("route", "", "Optional single hash route to capture (e.g. '#/practice/open-track-practice'); captures default README suite when empty")
	outPrefixFlag := flag.String("out", "", "Output path prefix without -dark.png / -light.png when -route is set")
	selectorFlag := flag.String("selector", ".card, .panel, table", "CSS selector used to measure content bottom for tight clipping")
	widthFlag := flag.Int("width", 1440, "CSS viewport width in px (output PNG width is 2x)")
	heightFlag := flag.Int("height", 920, "CSS viewport height in px (output PNG max height is 2x)")
	minHeightFlag := flag.Float64("min-height", 620, "Minimum CSS clip height in px")
	padBottomFlag := flag.Float64("pad-bottom", 28, "Padding in CSS px below measured content bottom")
	flag.Parse()

	log.SetFlags(log.LstdFlags)

	tmpDir, err := os.MkdirTemp("", "slaprf-retina-shots-*")
	if err != nil {
		log.Fatalf("MkdirTemp: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	siteDir := strings.TrimSpace(*siteDirFlag)
	if siteDir == "" {
		siteDir = filepath.Join(tmpDir, "site")
		log.Printf("[capture-retina] Building static UI into %s...", siteDir)
		cmd := exec.Command("go", "run", "./cmd/build-web", "-web", "./web", "-out", siteDir, "-skip-wasm", "-skip-docs")
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if err := cmd.Run(); err != nil {
			log.Fatalf("build-web failed: %v", err)
		}
		_ = exec.Command("git", "checkout", "--", "internal/api/generated/version.json").Run()
	}

	pSrv := portable.NewServer(portable.Config{
		Version:         "showcase",
		StaticFS:        os.DirFS(siteDir),
		DBPath:          filepath.Join(tmpDir, "showcase.db"),
		AllowLANOrigins: true,
	})
	defer pSrv.Close()

	httpSrv := httptest.NewServer(pSrv.Handler())
	defer httpSrv.Close()

	pw, err := playwright.Run()
	if err != nil {
		log.Fatalf("playwright.Run (run 'go run github.com/playwright-community/playwright-go/cmd/playwright install chromium' if missing): %v", err)
	}
	defer pw.Stop()

	browser, err := pw.Chromium.Launch(playwright.BrowserTypeLaunchOptions{
		Headless: playwright.Bool(true),
	})
	if err != nil {
		log.Fatalf("Chromium.Launch: %v", err)
	}
	defer browser.Close()

	ctx, err := browser.NewContext(playwright.BrowserNewContextOptions{
		BaseURL:           playwright.String(httpSrv.URL),
		Viewport:          &playwright.Size{Width: *widthFlag, Height: *heightFlag},
		DeviceScaleFactor: playwright.Float(2.0),
		ColorScheme:       playwright.ColorSchemeDark,
	})
	if err != nil {
		log.Fatalf("NewContext: %v", err)
	}
	defer ctx.Close()

	_ = ctx.AddInitScript(playwright.Script{
		Content: playwright.String(`window.sessionStorage.setItem("slaprf.boot_seen", "1");`),
	})

	page, err := ctx.NewPage()
	if err != nil {
		log.Fatalf("NewPage: %v", err)
	}

	if _, err := page.Goto(httpSrv.URL + "/#/practice"); err != nil {
		log.Fatalf("goto practice: %v", err)
	}
	_, err = page.Evaluate(`async () => {
		await fetch("/v1/storage:restoreDemo", { method: "POST" });
		await fetch("/v1/sim/hub-usb", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ connected: true }) });
		await fetch("/v1/sim", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ running: true, speedMultiplier: 1 }) });
	}`)
	if err != nil {
		log.Fatalf("seed demo: %v", err)
	}

	setTheme := func(mode string) {
		_, evalErr := page.Evaluate(`(mode) => {
			const btn = document.querySelector('button[data-set-theme="' + mode + '"]');
			if (btn) btn.click();
			if (document.activeElement && typeof document.activeElement.blur === "function") {
				document.activeElement.blur();
			}
		}`, mode)
		if evalErr != nil {
			log.Fatalf("setTheme(%s): %v", mode, evalErr)
		}
		_ = page.Mouse().Move(5, 5)
		time.Sleep(350 * time.Millisecond)
	}

	measureClipHeight := func(bottomSelector string, padPx float64, minH float64) float64 {
		_ = page.Mouse().Move(5, 5)
		time.Sleep(250 * time.Millisecond)
		rawBottom, evalErr := page.Evaluate(fmt.Sprintf(`() => {
			if (document.activeElement && typeof document.activeElement.blur === "function") {
				document.activeElement.blur();
			}
			const els = Array.from(document.querySelectorAll(%q));
			let maxB = 0;
			for (const el of els) {
				const r = el.getBoundingClientRect();
				if (r.height > 0 && r.bottom > maxB) maxB = r.bottom;
			}
			return maxB;
		}`, bottomSelector))
		if evalErr != nil {
			log.Fatalf("measure bottom (%s): %v", bottomSelector, evalErr)
		}
		maxH := float64(*heightFlag)
		if vp := page.ViewportSize(); vp != nil && vp.Height > 0 {
			maxH = float64(vp.Height)
		}
		clipH := 700.0
		if f, ok := rawBottom.(float64); ok && f > 100 {
			clipH = f + padPx
		}
		if clipH < minH {
			clipH = minH
		}
		if clipH > maxH {
			clipH = maxH
		}
		return clipH
	}

	saveShot := func(outPath string, clipW float64, clipH float64) {
		if err := os.MkdirAll(filepath.Dir(outPath), 0o755); err != nil {
			log.Fatalf("mkdir %s: %v", filepath.Dir(outPath), err)
		}
		_ = page.Mouse().Move(5, 5)
		_, shotErr := page.Screenshot(playwright.PageScreenshotOptions{
			Path: playwright.String(outPath),
			Type: playwright.ScreenshotTypePng,
			Clip: &playwright.Rect{
				X:      0,
				Y:      0,
				Width:  clipW,
				Height: clipH,
			},
		})
		if shotErr != nil {
			log.Fatalf("screenshot %s: %v", outPath, shotErr)
		}
		log.Printf("[capture-retina] Saved %s (clip %.0fx%.0f -> %.0fx%.0f px)", outPath, clipW, clipH, clipW*2, clipH*2)
	}

	capturePair := func(prefixPath string, bottomSelector string, padPx float64, minH float64) {
		w := float64(*widthFlag)
		if vp := page.ViewportSize(); vp != nil && vp.Width > 0 {
			w = float64(vp.Width)
		}
		setTheme("dark")
		// Measure once and share the exact clip height across dark & light so paired images never shift layout
		clipH := measureClipHeight(bottomSelector, padPx, minH)
		saveShot(prefixPath+"-dark.png", w, clipH)
		setTheme("light")
		saveShot(prefixPath+"-light.png", w, clipH)
		setTheme("dark")
	}

	if *routeFlag != "" {
		if *outPrefixFlag == "" {
			log.Fatalf("-out <prefix> is required when -route is set")
		}
		target := *routeFlag
		if !strings.HasPrefix(target, "/") {
			target = "/" + target
		}
		if _, err := page.Goto(httpSrv.URL + target); err != nil {
			log.Fatalf("goto %s: %v", target, err)
		}
		_, _ = page.Evaluate(`() => document.fonts ? document.fonts.ready : Promise.resolve()`)
		time.Sleep(1500 * time.Millisecond)
		capturePair(*outPrefixFlag, *selectorFlag, *padBottomFlag, *minHeightFlag)
		return
	}

	// Default suite: regenerate all 6 README 2x Retina screenshots into ./docs/
	if _, err := page.Goto(httpSrv.URL + "/#/practice/open-track-practice"); err != nil {
		log.Fatalf("goto open-track-practice: %v", err)
	}
	_, _ = page.Evaluate(`() => document.fonts ? document.fonts.ready : Promise.resolve()`)
	time.Sleep(1800 * time.Millisecond)
	capturePair(filepath.Join("docs", "slaprf-practice-2x"), ".card, .panel, table", 26, 620)

	// Bracket & Cockpit share an exact 1440x834 CSS frame (2880x1668 px Retina) for side-by-side table alignment
	if err := page.SetViewportSize(1440, 834); err != nil {
		log.Fatalf("SetViewportSize 834: %v", err)
	}
	if _, err := page.Goto(httpSrv.URL + "/#/races/bay-area-championship/format/stage-1"); err != nil {
		log.Fatalf("goto bracket: %v", err)
	}
	time.Sleep(900 * time.Millisecond)
	_, _ = page.Evaluate(`() => {
		const fitBtn = document.querySelector('[data-rc-zoom-fit], [data-bkt-fit], [title*="Fit" i], [aria-label*="Fit" i]');
		if (fitBtn) fitBtn.click();
	}`)
	time.Sleep(450 * time.Millisecond)
	capturePair(filepath.Join("docs", "slaprf-bracket-2x"), ".bkt-round-node", 32, 834)

	if _, err := page.Goto(httpSrv.URL + "/#/races/bay-area-championship/control"); err != nil {
		log.Fatalf("goto control: %v", err)
	}
	time.Sleep(900 * time.Millisecond)
	_, _ = page.Evaluate(`() => {
		const scrollLeftBtn = document.querySelector('button[aria-label*="Scroll workspace tabs left" i]');
		if (scrollLeftBtn) scrollLeftBtn.click();
	}`)
	time.Sleep(250 * time.Millisecond)
	capturePair(filepath.Join("docs", "slaprf-cockpit-2x"), "[data-canvas-panel], .rc-panel", 28, 834)
}
