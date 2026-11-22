//go:build e2e

package e2e_test

import (
	"encoding/json"
	"fmt"
	"html"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/playwright-community/playwright-go"

	"slaprf/internal/api"
	"slaprf/internal/domain"
	"slaprf/internal/portable"
)

var (
	suiteRepoRoot        string
	suiteSiteDir         string
	suitePortableSiteDir string
	suiteRunID           string
	suiteRunDir          string
	suiteResultsDir      string
	suiteBrowser         playwright.Browser

	suiteRecordsMu sync.Mutex
	suiteRecords   []testRunRecord
)

type testRunRecord struct {
	Name          string
	Category      string // "component" | "workflow"
	DirName       string
	Passed        bool
	Duration      time.Duration
	VideoRel      string
	TraceRel      string
	ScreenshotRel string
	Milestones    []string
	ConsoleErrors []string
	PageErrors    []string
}

// HarnessOptions customizes browser context setup for specialized component UI tests
// (e.g. narrow responsive viewports, full radar boot splash animation, or standalone WASM Demo Mode).
// Video, trace, and screenshot recording are always active for every UI test.
type HarnessOptions struct {
	Viewport          *playwright.Size
	FullBootAnimation bool
	StaticDemoMode    bool // Serves static _site (with slaprf.wasm + IndexedDB, no /v1/* Go backend)
}

func TestMain(m *testing.M) {
	code := runSuite(m)
	os.Exit(code)
}

func runSuite(m *testing.M) int {
	wd, err := os.Getwd()
	if err != nil {
		log.Printf("[e2e] failed to resolve working directory: %v", err)
		return 1
	}
	suiteRepoRoot = filepath.Clean(filepath.Join(wd, ".."))
	suiteSiteDir = filepath.Join(suiteRepoRoot, "_site")
	suitePortableSiteDir = filepath.Join(suiteRepoRoot, "cmd", "slaprf", "site")

	// 0. Ensure deterministic JSON snapshot fixtures in e2e/testdata/*.json exist and match schema.
	if err := ensureSnapshotFixtures(filepath.Join(wd, "testdata")); err != nil {
		log.Printf("[e2e] failed to prepare JSON snapshot fixtures: %v", err)
		return 1
	}

	// 1. Build fresh _site (Demo + slim WASM) AND cmd/slaprf/site (WASM-free Native Backend UI) unless skipped.
	if os.Getenv("SLAPRF_E2E_SKIP_BUILD") != "1" {
		log.Printf("[e2e] Building fresh _site bundle (TypeScript + slim WASM)...")
		buildCmd := exec.Command("go", "run", "./cmd/build-web")
		buildCmd.Dir = suiteRepoRoot
		buildCmd.Stdout = os.Stdout
		buildCmd.Stderr = os.Stderr
		if err := buildCmd.Run(); err != nil {
			log.Printf("[e2e] build-web (_site) failed: %v", err)
			return 1
		}

		log.Printf("[e2e] Building WASM-free portable UI bundle (cmd/slaprf/site)...")
		portableCmd := exec.Command("go", "run", "./cmd/build-web", "-web", "./web", "-out", suitePortableSiteDir, "-skip-wasm")
		portableCmd.Dir = suiteRepoRoot
		portableCmd.Stdout = os.Stdout
		portableCmd.Stderr = os.Stderr
		if err := portableCmd.Run(); err != nil {
			log.Printf("[e2e] build-web (portable) failed: %v", err)
			return 1
		}
		_ = os.RemoveAll(filepath.Join(suitePortableSiteDir, "wasm"))
		_ = os.WriteFile(filepath.Join(suitePortableSiteDir, ".keep"), []byte{}, 0o644)
	} else {
		if _, statErr := os.Stat(filepath.Join(suiteSiteDir, "index.html")); statErr != nil {
			log.Printf("[e2e] SLAPRF_E2E_SKIP_BUILD=1 set, but %s is missing: %v", suiteSiteDir, statErr)
			return 1
		}
		if _, statErr := os.Stat(filepath.Join(suitePortableSiteDir, "index.html")); statErr != nil {
			log.Printf("[e2e] SLAPRF_E2E_SKIP_BUILD=1 set, but %s is missing: %v", suitePortableSiteDir, statErr)
			return 1
		}
	}

	// 2. Prepare timestamped artifact directory under test-results/.
	suiteResultsDir = filepath.Join(suiteRepoRoot, "test-results")
	suiteRunID = time.Now().Format("20060102-150405")
	suiteRunDir = filepath.Join(suiteResultsDir, suiteRunID)
	if err := os.MkdirAll(suiteRunDir, 0o755); err != nil {
		log.Printf("[e2e] failed to create artifact dir %s: %v", suiteRunDir, err)
		return 1
	}

	// 4. Launch Playwright + Chromium, auto-installing Chromium on first run if not yet cached.
	pw, err := playwright.Run()
	if err != nil {
		log.Printf("[e2e] Installing Playwright driver + Chromium runtime...")
		if instErr := playwright.Install(&playwright.RunOptions{
			Browsers: []string{"chromium"},
		}); instErr != nil {
			log.Printf("[e2e] playwright.Install failed: %v", instErr)
			return 1
		}
		pw, err = playwright.Run()
		if err != nil {
			log.Printf("[e2e] playwright.Run failed after install: %v", err)
			return 1
		}
	}
	defer func() {
		_ = pw.Stop()
	}()

	headless := os.Getenv("SLAPRF_E2E_HEADED") != "1"
	launchOpts := playwright.BrowserTypeLaunchOptions{
		Headless: playwright.Bool(headless),
	}
	if rawSlow := strings.TrimSpace(os.Getenv("SLAPRF_E2E_SLOWMO")); rawSlow != "" {
		if ms, parseErr := strconv.ParseFloat(rawSlow, 64); parseErr == nil && ms > 0 {
			launchOpts.SlowMo = playwright.Float(ms)
		}
	}

	browser, err := pw.Chromium.Launch(launchOpts)
	if err != nil {
		log.Printf("[e2e] Chromium binary missing (%v) — installing Chromium...", err)
		if instErr := playwright.Install(&playwright.RunOptions{
			Browsers: []string{"chromium"},
		}); instErr != nil {
			log.Printf("[e2e] playwright.Install failed: %v", instErr)
			return 1
		}
		browser, err = pw.Chromium.Launch(launchOpts)
		if err != nil {
			log.Printf("[e2e] Chromium launch failed: %v", err)
			return 1
		}
	}
	suiteBrowser = browser
	defer func() {
		_ = browser.Close()
	}()

	suiteStart := time.Now()
	exitCode := m.Run()
	suiteElapsed := time.Since(suiteStart)

	if err := writeSuiteHTMLReports(suiteElapsed); err != nil {
		log.Printf("[e2e] warning: failed to write HTML report: %v", err)
	} else {
		log.Printf("[e2e] Artifacts & recordings saved to: %s", filepath.Join(suiteRunDir, "index.html"))
		log.Printf("[e2e] Latest report shortcut:          %s", filepath.Join(suiteResultsDir, "latest.html"))
	}

	return exitCode
}

var nonSafePathChars = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)

func sanitizeTestName(name string) string {
	clean := strings.ReplaceAll(name, "/", "__")
	clean = nonSafePathChars.ReplaceAllString(clean, "_")
	clean = strings.Trim(clean, "._-")
	if clean == "" {
		return "test"
	}
	return clean
}

func classifyTestCategory(name string) string {
	if strings.HasPrefix(name, "TestAPI_") || strings.Contains(name, "/API_") {
		return "api"
	}
	if strings.HasPrefix(name, "TestComponent_") || strings.Contains(name, "/Component_") {
		return "component"
	}
	return "workflow"
}

// Harness provides an isolated browser context, pre-seeded JSON snapshot support, automatic
// video + trace + screenshot recording, console/pageerror guards, and deterministic UI helpers.
type Harness struct {
	T          *testing.T
	Ctx        playwright.BrowserContext
	Page       playwright.Page
	BaseURL    string
	Server     *portable.Server
	DBPath     string
	StaticDemo bool
	TestDir    string
	DirName    string
	StartedAt  time.Time
	stepSnapN  int
	milestones []string

	errMu         sync.Mutex
	consoleErrors []string
	pageErrors    []string
	allowConsole  []string
}

// NewHarness launches a brand-new isolated BrowserContext (1440x900, fast-boot enabled,
// WebM video + Playwright trace recording active) backed by an isolated Native Go Server + bbolt DB.
func NewHarness(t *testing.T) *Harness {
	t.Helper()
	return NewHarnessWithOptions(t, HarnessOptions{})
}

const seedBlankHTML = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"color-scheme\" content=\"dark\"><title>SlapRF</title><style>html,body{margin:0;padding:0;background:#0b0c0f;color:#f3f5f8;}</style></head><body></body></html>"

// NewHarnessWithOptions launches an isolated BrowserContext with custom viewport, boot, or demo options.
func NewHarnessWithOptions(t *testing.T, opts HarnessOptions) *Harness {
	t.Helper()

	dirName := sanitizeTestName(t.Name())
	testDir := filepath.Join(suiteRunDir, dirName)
	if err := os.MkdirAll(testDir, 0o755); err != nil {
		t.Fatalf("mkdir test artifact dir %s: %v", testDir, err)
	}

	var pSrv *portable.Server
	var dbPath string
	var appHandler http.Handler
	if opts.StaticDemoMode {
		appHandler = http.FileServer(http.Dir(suiteSiteDir))
	} else {
		dbPath = filepath.Join(testDir, "slaprf.db")
		pSrv = portable.NewServer(portable.Config{
			Version:         "e2e-test",
			StaticFS:        os.DirFS(suitePortableSiteDir),
			DBPath:          dbPath,
			AllowLANOrigins: true,
		})
		appHandler = pSrv.Handler()
	}

	httpSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/__e2e_seed" {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			_, _ = w.Write([]byte(seedBlankHTML))
			return
		}
		appHandler.ServeHTTP(w, r)
	}))
	baseURL := httpSrv.URL

	viewport := opts.Viewport
	if viewport == nil {
		viewport = &playwright.Size{Width: 1440, Height: 900}
	}

	rawVidDir := filepath.Join(testDir, "_raw_video")
	if err := os.MkdirAll(rawVidDir, 0o755); err != nil {
		httpSrv.Close()
		if pSrv != nil {
			pSrv.Close()
		}
		t.Fatalf("mkdir raw video dir %s: %v", rawVidDir, err)
	}
	videoOpt := &playwright.RecordVideo{
		Dir:  rawVidDir,
		Size: viewport,
	}

	ctx, err := suiteBrowser.NewContext(playwright.BrowserNewContextOptions{
		BaseURL:     playwright.String(baseURL),
		Viewport:    viewport,
		ColorScheme: playwright.ColorSchemeDark,
		RecordVideo: videoOpt,
		Permissions: []string{"clipboard-read", "clipboard-write"},
	})
	if err != nil {
		httpSrv.Close()
		if pSrv != nil {
			pSrv.Close()
		}
		t.Fatalf("NewContext failed: %v", err)
	}
	ctx.SetDefaultTimeout(20000)

	if !opts.FullBootAnimation && os.Getenv("SLAPRF_E2E_FULL_BOOT_ANIM") != "1" {
		if initErr := ctx.AddInitScript(playwright.Script{
			Content: playwright.String(`window.__SLAPRF_E2E_FAST_BOOT__ = true;`),
		}); initErr != nil {
			_ = ctx.Close()
			httpSrv.Close()
			if pSrv != nil {
				pSrv.Close()
			}
			t.Fatalf("AddInitScript fast-boot failed: %v", initErr)
		}
	}

	if err := ctx.Tracing().Start(playwright.TracingStartOptions{
		Screenshots: playwright.Bool(true),
		Snapshots:   playwright.Bool(true),
		Sources:     playwright.Bool(true),
		Title:       playwright.String(t.Name()),
	}); err != nil {
		_ = ctx.Close()
		httpSrv.Close()
		if pSrv != nil {
			pSrv.Close()
		}
		t.Fatalf("Tracing.Start failed: %v", err)
	}

	page, err := ctx.NewPage()
	if err != nil {
		_ = ctx.Close()
		httpSrv.Close()
		if pSrv != nil {
			pSrv.Close()
		}
		t.Fatalf("NewPage failed: %v", err)
	}
	applyDarkDefaultBackground(page)

	h := &Harness{
		T:          t,
		Ctx:        ctx,
		Page:       page,
		BaseURL:    baseURL,
		Server:     pSrv,
		DBPath:     dbPath,
		StaticDemo: opts.StaticDemoMode,
		TestDir:    testDir,
		DirName:    dirName,
		StartedAt:  time.Now(),
	}

	h.AttachErrorGuards(page)
	if opts.StaticDemoMode {
		h.AllowConsoleErrorSubstring("Failed to load resource")
		h.AllowConsoleErrorSubstring("ERR_CONNECTION")
	}

	t.Cleanup(func() {
		// Allow Chromium's 25fps screencast encoder to flush the final UI state frame
		// before closing fast (~1s) pre-seeded component tests.
		time.Sleep(120 * time.Millisecond)
		elapsed := time.Since(h.StartedAt)
		activePage := h.Page

		// 1. Capture final screenshot before closing the page.
		finalPng := filepath.Join(testDir, "final.png")
		var screenshotRel string
		if activePage != nil {
			if _, scErr := activePage.Screenshot(playwright.PageScreenshotOptions{
				Path:     playwright.String(finalPng),
				FullPage: playwright.Bool(false),
			}); scErr == nil {
				screenshotRel = "final.png"
			}
		}

		// 2. Stop Playwright trace into trace.zip.
		traceZip := filepath.Join(testDir, "trace.zip")
		var traceRel string
		if trErr := ctx.Tracing().Stop(traceZip); trErr == nil {
			traceRel = "trace.zip"
		}

		// 3. Flush and save the WebM video cleanly as video.webm (mandatory for every test).
		var vid playwright.Video
		if activePage != nil {
			vid = activePage.Video()
			_ = activePage.Close()
		}
		_ = ctx.Close()
		httpSrv.Close()
		if pSrv != nil {
			pSrv.Close()
		}

		var videoRel string
		if vid != nil {
			destWebm := filepath.Join(testDir, "video.webm")
			if saveErr := vid.SaveAs(destWebm); saveErr == nil {
				videoRel = "video.webm"
			} else {
				t.Errorf("failed to save test video.webm: %v", saveErr)
			}
		} else {
			t.Errorf("playwright page.Video() was nil; video recording is required for all E2E tests")
		}
		_ = os.RemoveAll(rawVidDir)

		// 4. Enforce zero unexpected JS / console errors.
		h.errMu.Lock()
		cErrs := append([]string(nil), h.consoleErrors...)
		pErrs := append([]string(nil), h.pageErrors...)
		h.errMu.Unlock()

		if len(pErrs) > 0 {
			t.Errorf("uncaught pageerror(s) during test (%d):\n  - %s", len(pErrs), strings.Join(pErrs, "\n  - "))
		}
		if len(cErrs) > 0 {
			t.Errorf("console.error(s) during test (%d):\n  - %s", len(cErrs), strings.Join(cErrs, "\n  - "))
		}

		passed := !t.Failed()
		if !passed && os.Getenv("GITHUB_ACTIONS") == "true" {
			detail := fmt.Sprintf("E2E test %s failed after %s (see slaprf-e2e-report artifact for video.webm, final.png & trace.zip)", t.Name(), elapsed.Round(10*time.Millisecond))
			if len(pErrs) > 0 {
				detail += " | pageerror: " + pErrs[0]
			} else if len(cErrs) > 0 {
				detail += " | console.error: " + cErrs[0]
			}
			cleanDetail := strings.NewReplacer("\r", " ", "\n", " ").Replace(detail)
			fmt.Printf("::error title=%s::%s\n", t.Name(), cleanDetail)
		}

		suiteRecordsMu.Lock()
		suiteRecords = append(suiteRecords, testRunRecord{
			Name:          t.Name(),
			Category:      classifyTestCategory(t.Name()),
			DirName:       dirName,
			Passed:        passed,
			Duration:      elapsed,
			VideoRel:      videoRel,
			TraceRel:      traceRel,
			ScreenshotRel: screenshotRel,
			Milestones:    append([]string(nil), h.milestones...),
			ConsoleErrors: cErrs,
			PageErrors:    pErrs,
		})
		suiteRecordsMu.Unlock()
	})

	return h
}

// AttachErrorGuards wires uncaught pageerror and console.error listeners onto `p`
// (used automatically for `h.Page` and available when a test opens a second tab).
func (h *Harness) AttachErrorGuards(p playwright.Page) {
	p.OnPageError(func(err error) {
		if err == nil {
			return
		}
		h.errMu.Lock()
		h.pageErrors = append(h.pageErrors, err.Error())
		h.errMu.Unlock()
	})

	p.OnConsole(func(msg playwright.ConsoleMessage) {
		if msg == nil || msg.Type() != "error" {
			return
		}
		txt := strings.TrimSpace(msg.Text())
		if txt == "" || strings.Contains(txt, "favicon.ico") {
			return
		}
		h.errMu.Lock()
		defer h.errMu.Unlock()
		for _, allowed := range h.allowConsole {
			if allowed != "" && strings.Contains(txt, allowed) {
				return
			}
		}
		h.consoleErrors = append(h.consoleErrors, txt)
	})
}

// AllowConsoleErrorSubstring permits a specific expected console error substring during negative tests.
func (h *Harness) AllowConsoleErrorSubstring(substr string) {
	h.errMu.Lock()
	h.allowConsole = append(h.allowConsole, substr)
	h.errMu.Unlock()
}

// MilestoneScreenshot saves a numbered step screenshot inside the test's artifact directory.
func (h *Harness) MilestoneScreenshot(slug string) {
	h.T.Helper()
	h.stepSnapN++
	safe := nonSafePathChars.ReplaceAllString(strings.ToLower(strings.TrimSpace(slug)), "-")
	safe = strings.Trim(safe, "-")
	if safe == "" {
		safe = "milestone"
	}
	filename := fmt.Sprintf("step-%02d-%s.png", h.stepSnapN, safe)
	fullPath := filepath.Join(h.TestDir, filename)
	if _, err := h.Page.Screenshot(playwright.PageScreenshotOptions{
		Path:     playwright.String(fullPath),
		FullPage: playwright.Bool(false),
	}); err == nil {
		h.milestones = append(h.milestones, filename)
	}
}

func (h *Harness) clearTransientLoopbackErrors() {
	h.errMu.Lock()
	defer h.errMu.Unlock()
	kept := h.consoleErrors[:0]
	for _, msg := range h.consoleErrors {
		if !strings.Contains(msg, "ERR_CONNECTION") {
			kept = append(kept, msg)
		}
	}
	h.consoleErrors = kept
}

func (h *Harness) gotoWithLoopbackRetry(target string) {
	h.T.Helper()
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if _, err := h.Page.Goto(target, playwright.PageGotoOptions{
			WaitUntil: playwright.WaitUntilStateDomcontentloaded,
		}); err == nil {
			return
		} else {
			lastErr = err
			h.clearTransientLoopbackErrors()
			time.Sleep(150 * time.Millisecond)
		}
	}
	h.T.Fatalf("Page.Goto(%s) failed after retries: %v", target, lastErr)
}

// BootClean navigates to the given hash route (e.g. "#/practice", "#/sim", "#/races") in a known
// clean state and waits until both the timing transport (`window.slaprfCurl`) and the boot screen
// (`#slaprf-boot-loader.is-ready`) have finished hydrating.
func (h *Harness) BootClean(hash string) {
	h.T.Helper()
	target := h.BaseURL + "/"
	if strings.TrimSpace(hash) != "" {
		if !strings.HasPrefix(hash, "#") {
			hash = "#" + hash
		}
		target += hash
	}

	isHydrated := func() bool {
		res, err := h.Page.Evaluate(`(staticDemo) => {
			const loader = document.getElementById("slaprf-boot-loader");
			const app = document.getElementById("app");
			const curlReady = typeof window.slaprfCurl === "function";
			const wasmReady = !staticDemo || (typeof window.slaprfWasm === "object" && window.slaprfWasm !== null && typeof window.slaprfWasm.request === "function");
			const loaderReady = Boolean(loader && loader.classList.contains("is-ready") && !loader.classList.contains("is-conflict"));
			const appVisible = Boolean(app && !app.hidden && app.childElementCount > 0);
			return curlReady && wasmReady && loaderReady && appVisible;
		}`, h.StaticDemo)
		if err != nil {
			return false
		}
		ok, _ := res.(bool)
		return ok
	}

	h.gotoWithLoopbackRetry(target)

	earlyDeadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(earlyDeadline) {
		if isHydrated() {
			return
		}
		time.Sleep(60 * time.Millisecond)
	}

	// Retry navigation once if a transient Windows loopback socket hiccup blocked subresource fetch.
	h.clearTransientLoopbackErrors()
	h.gotoWithLoopbackRetry(target)

	h.WaitUntil("SlapRF engine and UI boot loader ready", 25*time.Second, func() (bool, error) {
		return isHydrated(), nil
	})
}

// applyDarkDefaultBackground sets Blink's default canvas clear color to SlapRF's #0b0c0f dark
// background via CDP so screencast frames never flash #ffffff before CSS paints.
func applyDarkDefaultBackground(p playwright.Page) {
	if p == nil {
		return
	}
	cdp, err := p.Context().NewCDPSession(p)
	if err != nil || cdp == nil {
		return
	}
	defer func() {
		_ = cdp.Detach()
	}()
	_, _ = cdp.Send("Emulation.setDefaultBackgroundColorOverride", map[string]any{
		"color": map[string]any{"r": 11, "g": 12, "b": 15, "a": 1},
	})
}

// SeedSimStateAndStorage pre-populates SlapRF's simulator state (into bbolt via `PUT /v1/storage/sim`
// in Native Go Backend Mode, or IndexedDB in StaticDemoMode) and optional `localStorage` keys BEFORE
// `index.html` runs.
func (h *Harness) SeedSimStateAndStorage(rawSimStateJSON string, localStorageKV map[string]string) {
	h.T.Helper()

	if !h.StaticDemo {
		if strings.TrimSpace(rawSimStateJSON) != "" {
			req, reqErr := http.NewRequest(http.MethodPut, h.BaseURL+"/v1/storage/sim", strings.NewReader(rawSimStateJSON))
			if reqErr != nil {
				h.T.Fatalf("build PUT /v1/storage/sim failed: %v", reqErr)
			}
			req.Header.Set("Content-Type", "application/json")
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				h.T.Fatalf("PUT /v1/storage/sim failed: %v", err)
			}
			body, _ := io.ReadAll(resp.Body)
			_ = resp.Body.Close()
			if resp.StatusCode < 200 || resp.StatusCode >= 300 {
				h.T.Fatalf("PUT /v1/storage/sim HTTP %d: %s", resp.StatusCode, string(body))
			}
		}
		if localStorageKV != nil && localStorageKV["slaprf.ui.sim_mode.v1"] == "false" {
			req, reqErr := http.NewRequest(http.MethodPatch, h.BaseURL+"/v1/sim", strings.NewReader(`{"running":false}`))
			if reqErr != nil {
				h.T.Fatalf("build PATCH /v1/sim failed: %v", reqErr)
			}
			req.Header.Set("Content-Type", "application/json")
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				h.T.Fatalf("PATCH /v1/sim failed: %v", err)
			}
			_ = resp.Body.Close()
		}
	}

	seedURL := h.BaseURL + "/__e2e_seed"

	wasBlank := h.Page != nil && h.Page.URL() == "about:blank"
	h.gotoWithLoopbackRetry(seedURL)

	lsMap := map[string]any{}
	for k, v := range localStorageKV {
		lsMap[k] = v
	}

	simForIDB := ""
	if h.StaticDemo {
		simForIDB = rawSimStateJSON
	}

	_, err := h.Page.Evaluate(`async ([simJson, lsEntries]) => {
		if (lsEntries && typeof lsEntries === "object") {
			for (const [k, v] of Object.entries(lsEntries)) {
				window.localStorage.setItem(k, String(v));
			}
		}
		if (!simJson) {
			return true;
		}
		await new Promise((resolve, reject) => {
			const req = indexedDB.open("slaprf", 1);
			req.onupgradeneeded = (ev) => {
				const db = req.result;
				if (ev.oldVersion < 1) {
					db.createObjectStore("kv", { keyPath: "key" });
					const laps = db.createObjectStore("laps", { keyPath: "lapId" });
					laps.createIndex("completedAtUs", "completedAtUs");
					const crossings = db.createObjectStore("crossings", { keyPath: "eventId" });
					crossings.createIndex("timestampUs", "timestampUs");
					const filtered = db.createObjectStore("filtered", {
						keyPath: ["timestampUs", "gateId", "slotIndex", "reason"],
					});
					filtered.createIndex("timestampUs", "timestampUs");
				}
			};
			req.onerror = () => reject(req.error || new Error("indexedDB.open failed"));
			req.onsuccess = () => {
				const db = req.result;
				const tx = db.transaction(["kv"], "readwrite");
				const kv = tx.objectStore("kv");
				kv.put({ key: "sim.state", json: String(simJson) });
				kv.put({ key: "meta", schema: 1, savedAt: Date.now() });
				tx.oncomplete = () => {
					db.close();
					resolve(true);
				};
				tx.onerror = () => {
					const txErr = tx.error || new Error("tx failed");
					db.close();
					reject(txErr);
				};
				tx.onabort = () => {
					const abortErr = tx.error || new Error("tx aborted");
					db.close();
					reject(abortErr);
				};
			};
		});
		return true;
	}`, []any{simForIDB, lsMap})
	if err != nil {
		h.T.Fatalf("SeedSimStateAndStorage failed: %v", err)
	}

	if wasBlank {
		oldPage := h.Page
		freshPage, npErr := h.Ctx.NewPage()
		if npErr != nil {
			h.T.Fatalf("SeedSimStateAndStorage fresh NewPage failed: %v", npErr)
		}
		applyDarkDefaultBackground(freshPage)
		h.AttachErrorGuards(freshPage)
		h.Page = freshPage
		_ = oldPage.Close()
	}
}

// BootWithSnapshot pre-seeds state from `e2e/testdata/<snapshotName>` (and optional localStorage
// preferences) and navigates directly to `hash` so a single UI component can be tested immediately.
func (h *Harness) BootWithSnapshot(snapshotName string, hash string, localStorageKV map[string]string) {
	h.T.Helper()
	raw := loadSnapshotFixtureJSON(h.T, snapshotName)
	h.SeedSimStateAndStorage(raw, localStorageKV)
	h.BootClean(hash)
}

// BootWithMutatedSnapshot loads `e2e/testdata/<snapshotName>`, applies `mutate` in Go to customize
// the state for an edge-case component test, seeds state, and navigates directly to `hash`.
func (h *Harness) BootWithMutatedSnapshot(
	snapshotName string,
	hash string,
	localStorageKV map[string]string,
	mutate func(b *SimSnapshotBundle),
) {
	h.T.Helper()
	raw := loadSnapshotFixtureJSON(h.T, snapshotName)
	var bundle SimSnapshotBundle
	if err := json.Unmarshal([]byte(raw), &bundle); err != nil {
		h.T.Fatalf("unmarshal snapshot %q: %v", snapshotName, err)
	}
	if mutate != nil {
		mutate(&bundle)
	}
	encoded, err := json.Marshal(bundle)
	if err != nil {
		h.T.Fatalf("marshal mutated snapshot %q: %v", snapshotName, err)
	}
	h.SeedSimStateAndStorage(string(encoded), localStorageKV)
	h.BootClean(hash)
}

// ReloadAndWait reloads the current page and waits for engine + UI hydration to complete.
func (h *Harness) ReloadAndWait() {
	h.T.Helper()
	if _, err := h.Page.Reload(playwright.PageReloadOptions{
		WaitUntil: playwright.WaitUntilStateDomcontentloaded,
	}); err != nil {
		h.T.Fatalf("Page.Reload failed: %v", err)
	}
	h.WaitUntil("SlapRF engine and UI boot loader ready after reload", 25*time.Second, func() (bool, error) {
		res, err := h.Page.Evaluate(`(staticDemo) => {
			const loader = document.getElementById("slaprf-boot-loader");
			const app = document.getElementById("app");
			const curlReady = typeof window.slaprfCurl === "function";
			const wasmReady = !staticDemo || (typeof window.slaprfWasm === "object" && window.slaprfWasm !== null);
			const loaderReady = Boolean(loader && loader.classList.contains("is-ready") && !loader.classList.contains("is-conflict"));
			const appVisible = Boolean(app && !app.hidden && app.childElementCount > 0);
			return curlReady && wasmReady && loaderReady && appVisible;
		}`, h.StaticDemo)
		if err != nil {
			return false, nil
		}
		ok, _ := res.(bool)
		return ok, nil
	})
}

// NavigateSidebar clicks a left-sidebar navigation item (`live`, `races`, `pilot`, `pilots`,
// `track`, `sim`, `network`, `setup`, `flasher`, `debug`, `about`) and waits for it to activate.
func (h *Harness) NavigateSidebar(routeID string) {
	h.T.Helper()
	sel := fmt.Sprintf(`aside a[data-route=%q], nav a[data-route=%q]`, routeID, routeID)
	loc := h.Page.Locator(sel).First()
	h.MustBeVisible(loc, "sidebar link "+routeID)
	if err := loc.Click(); err != nil {
		h.T.Fatalf("click sidebar %q: %v", routeID, err)
	}
	activeSel := fmt.Sprintf(`a[data-route=%q].is-active`, routeID)
	h.MustBeVisible(h.Page.Locator(activeSel).First(), "active sidebar state "+routeID)
}

// ConnectSimHubH1 connects the simulated SlapRF Hub (`H1`) via the TopBar USB picker dialog
// and waits until `Connected · H1` appears and all 4 simulated gate timers report online.
func (h *Harness) ConnectSimHubH1() {
	h.T.Helper()
	usbBtn := h.Page.Locator(`button[data-action="usb-toggle"]`).First()
	h.MustBeVisible(usbBtn, "TopBar USB Connect button")

	txt, _ := usbBtn.InnerText()
	if strings.Contains(txt, "Connected") {
		return
	}

	if err := usbBtn.Click(); err != nil {
		h.T.Fatalf("click TopBar USB Connect button: %v", err)
	}

	modal := h.Page.Locator(`.sim-usb-dialog [data-pick-port-id]`).First()
	h.MustBeVisible(modal, "Simulated USB port picker rows")

	// Pick H1 explicitly if listed, otherwise first available simulated port.
	h1Row := h.Page.Locator(`.sim-usb-dialog [data-pick-port-id]`, playwright.PageLocatorOptions{
		HasText: "H1",
	}).First()
	if cnt, _ := h1Row.Count(); cnt > 0 {
		if err := h1Row.Click(); err != nil {
			h.T.Fatalf("select H1 row in USB port picker: %v", err)
		}
	}

	connectConfirm := h.Page.Locator(`.sim-usb-dialog button[data-modal="connect"]`).First()
	h.MustBeVisible(connectConfirm, "USB picker Connect button")
	if err := connectConfirm.Click(); err != nil {
		h.T.Fatalf("click USB picker Connect confirm: %v", err)
	}

	h.WaitUntil("TopBar shows Connected · H1 and gate timers come online", 12*time.Second, func() (bool, error) {
		label, err := usbBtn.InnerText()
		if err != nil || !strings.Contains(label, "Connected") {
			return false, nil
		}
		var st struct {
			Gates []struct {
				GateID uint8 `json:"gateId"`
				Online bool  `json:"online"`
			} `json:"gates"`
		}
		if err := h.WasmGetJSON("/v1/state", &st); err != nil {
			return false, nil
		}
		onlineCount := 0
		for _, g := range st.Gates {
			if g.Online {
				onlineCount++
			}
		}
		return onlineCount >= 4, nil
	})
}

// StartActiveHeat clicks the active "Start Heat" button in Race Control and automatically confirms
// the "Pause Active Session?" preemption modal if an Open Practice session was active on boot.
func (h *Harness) StartActiveHeat() {
	h.T.Helper()
	startBtn := h.Page.Locator(`button[data-ctrl="start"]:not([disabled])`).First()
	if vis, _ := startBtn.IsVisible(); !vis {
		liveTabBtn := h.Page.Locator(`button[data-mobile-ctrl-nav="live"]`).First()
		if lVis, _ := liveTabBtn.IsVisible(); lVis {
			_ = liveTabBtn.Click()
		}
	}
	h.MustBeVisible(startBtn, "Start Heat button")
	if err := startBtn.Click(); err != nil {
		h.T.Fatalf("click Start Heat: %v", err)
	}

	preemptOk := h.Page.Locator(`.slaprf-modal-backdrop button[data-preempt-ok]`).First()
	if err := preemptOk.WaitFor(playwright.LocatorWaitForOptions{
		State:   playwright.WaitForSelectorStateVisible,
		Timeout: playwright.Float(1200),
	}); err == nil {
		if clickErr := preemptOk.Click(); clickErr != nil {
			h.T.Fatalf("click OK on Pause Active Session modal: %v", clickErr)
		}
		h.MustBeHidden(h.Page.Locator(`.slaprf-modal-backdrop`), "Pause Active Session modal closed")
	}
}

// SelectCustomOption opens SlapRF's upgraded `.custom-select-trigger` adjacent to `selectSelector`,
// verifies the `.custom-select-popover[role="listbox"]` stays open cleanly, clicks the option whose
// text contains `optionLabelSubstr`, and verifies the popover closes cleanly.
func (h *Harness) SelectCustomOption(selectSelector string, optionLabelSubstr string) {
	h.T.Helper()
	selLoc := h.Page.Locator(selectSelector).First()
	if cnt, err := selLoc.Count(); err != nil || cnt == 0 {
		h.T.Fatalf("SelectCustomOption: <select> %q not found in DOM", selectSelector)
	}

	trigger := selLoc.Locator(`xpath=..//button[contains(@class,"custom-select-trigger")]`).First()
	h.MustBeVisible(trigger, "custom select trigger for "+selectSelector)
	if err := trigger.Click(); err != nil {
		h.T.Fatalf("click custom select trigger for %q: %v", selectSelector, err)
	}

	popover := h.Page.Locator(`.custom-select-popover[role="listbox"]`).First()
	h.MustBeVisible(popover, "custom select listbox popover for "+selectSelector)

	optBtn := popover.Locator(`.custom-select-option`, playwright.LocatorLocatorOptions{
		HasText: optionLabelSubstr,
	}).First()
	h.MustBeVisible(optBtn, fmt.Sprintf("custom select option %q", optionLabelSubstr))
	if err := optBtn.Click(); err != nil {
		h.T.Fatalf("click custom select option %q: %v", optionLabelSubstr, err)
	}

	if err := popover.WaitFor(playwright.LocatorWaitForOptions{
		State:   playwright.WaitForSelectorStateHidden,
		Timeout: playwright.Float(5000),
	}); err != nil {
		h.T.Fatalf("custom select popover did not close after selecting %q: %v", optionLabelSubstr, err)
	}
}

// MustBeVisible waits for a Locator to be visible and fails the test with context on timeout.
func (h *Harness) MustBeVisible(loc playwright.Locator, desc string) {
	h.T.Helper()
	if err := loc.WaitFor(playwright.LocatorWaitForOptions{
		State:   playwright.WaitForSelectorStateVisible,
		Timeout: playwright.Float(15000),
	}); err != nil {
		h.T.Fatalf("expected %s to become visible: %v", desc, err)
	}
}

// MustBeHidden waits for a Locator to become hidden or detached.
func (h *Harness) MustBeHidden(loc playwright.Locator, desc string) {
	h.T.Helper()
	if err := loc.WaitFor(playwright.LocatorWaitForOptions{
		State:   playwright.WaitForSelectorStateHidden,
		Timeout: playwright.Float(15000),
	}); err != nil {
		h.T.Fatalf("expected %s to become hidden: %v", desc, err)
	}
}

// MustContainText waits up to 10s for `loc`'s text content to contain `substr`.
func (h *Harness) MustContainText(loc playwright.Locator, substr string, desc ...string) {
	h.T.Helper()
	label := fmt.Sprintf("locator containing %q", substr)
	if len(desc) > 0 && strings.TrimSpace(desc[0]) != "" {
		label = fmt.Sprintf("%s containing %q", desc[0], substr)
	}
	var lastTxt string
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		txt, err := loc.TextContent()
		if err == nil {
			lastTxt = txt
			if strings.Contains(txt, substr) {
				return
			}
		}
		time.Sleep(60 * time.Millisecond)
	}
	h.T.Fatalf("timed out waiting for %s (last text: %q)", label, lastTxt)
}

// WaitUntil polls `cond` every 60ms up to `timeout`, failing `h.T` if `cond` returns a non-nil error
// or fails to return `true` before the deadline.
func (h *Harness) WaitUntil(desc string, timeout time.Duration, cond func() (bool, error)) {
	h.T.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		ok, err := cond()
		if err != nil {
			h.T.Fatalf("%s failed with error: %v", desc, err)
		}
		if ok {
			return
		}
		time.Sleep(60 * time.Millisecond)
	}
	h.T.Fatalf("timed out after %s waiting for: %s", timeout, desc)
}

// CurlRequest describes an HTTP / curl call routed via `window.slaprfCurl` inside the live
// Chromium page (against `slaprf.wasm` in-process or Portable host HTTP endpoints).
type CurlRequest struct {
	Method  string            `json:"method,omitempty"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    any               `json:"body,omitempty"`
	Target  string            `json:"target,omitempty"` // "auto" | "wasm" | "host"
	SyncUI  *bool             `json:"syncUi,omitempty"`
}

// CurlResponse captures the full HTTP response returned by `window.slaprfCurl` in the browser.
type CurlResponse struct {
	OK         bool              `json:"ok"`
	Status     int               `json:"status"`
	Headers    map[string]string `json:"headers"`
	Body       string            `json:"body"`
	DurationMs float64           `json:"durationMs"`
	Target     string            `json:"target"`
}

// Curl executes `window.slaprfCurl(req)` inside the live browser page (via Playwright / CDP)
// against the running WASM timing engine (`slaprf.wasm`) or Portable host routes.
func (h *Harness) Curl(req CurlRequest) CurlResponse {
	h.T.Helper()
	reqBytes, err := json.Marshal(req)
	if err != nil {
		h.T.Fatalf("Curl json.Marshal(%s %s): %v", req.Method, req.URL, err)
	}
	rawOut, evalErr := h.Page.Evaluate(`async (rawReq) => {
		for (let i = 0; i < 200 && typeof window.slaprfCurl !== "function"; i++) {
			await new Promise((r) => setTimeout(r, 25));
		}
		if (typeof window.slaprfCurl !== "function") {
			throw new Error("window.slaprfCurl bridge not installed");
		}
		const res = await window.slaprfCurl(JSON.parse(rawReq));
		return JSON.stringify(res);
	}`, string(reqBytes))
	if evalErr != nil {
		h.T.Fatalf("Curl(%s %s) evaluate failed: %v", req.Method, req.URL, evalErr)
	}
	outStr, ok := rawOut.(string)
	if !ok {
		h.T.Fatalf("Curl(%s %s) unexpected return type %T", req.Method, req.URL, rawOut)
	}
	var resp CurlResponse
	if err := json.Unmarshal([]byte(outStr), &resp); err != nil {
		h.T.Fatalf("Curl(%s %s) unmarshal response: %v (raw: %s)", req.Method, req.URL, err, outStr)
	}
	return resp
}

// CurlSpec tests the string shorthand overload `window.slaprfCurl("POST /v1/...", body)` in JS.
func (h *Harness) CurlSpec(spec string, body any) CurlResponse {
	h.T.Helper()
	payloadBytes, err := json.Marshal(map[string]any{
		"spec":    spec,
		"hasBody": body != nil,
		"body":    body,
	})
	if err != nil {
		h.T.Fatalf("CurlSpec marshal (%s): %v", spec, err)
	}
	rawOut, evalErr := h.Page.Evaluate(`async (raw) => {
		const p = JSON.parse(raw);
		const res = p.hasBody
			? await window.slaprfCurl(p.spec, p.body)
			: await window.slaprfCurl(p.spec);
		return JSON.stringify(res);
	}`, string(payloadBytes))
	if evalErr != nil {
		h.T.Fatalf("CurlSpec(%s) evaluate failed: %v", spec, evalErr)
	}
	var resp CurlResponse
	if err := json.Unmarshal([]byte(rawOut.(string)), &resp); err != nil {
		h.T.Fatalf("CurlSpec(%s) unmarshal: %v", spec, err)
	}
	return resp
}

// APIGet performs a `GET` via `window.slaprfCurl` in the browser, asserts HTTP 200, and decodes JSON into `dst`.
func (h *Harness) APIGet(url string, dst any) CurlResponse {
	h.T.Helper()
	res := h.Curl(CurlRequest{Method: "GET", URL: url})
	if res.Status < 200 || res.Status >= 300 {
		h.T.Fatalf("APIGet %s failed with HTTP %d: %s", url, res.Status, res.Body)
	}
	if dst != nil && strings.TrimSpace(res.Body) != "" {
		if err := json.Unmarshal([]byte(res.Body), dst); err != nil {
			h.T.Fatalf("APIGet %s json.Unmarshal failed: %v (body: %s)", url, err, res.Body)
		}
	}
	return res
}

// APIPost performs a `POST` via `window.slaprfCurl` in the browser, asserts HTTP 200, and decodes JSON into `dst`.
func (h *Harness) APIPost(url string, body any, dst any) CurlResponse {
	h.T.Helper()
	res := h.Curl(CurlRequest{Method: "POST", URL: url, Body: body})
	if res.Status < 200 || res.Status >= 300 {
		h.T.Fatalf("APIPost %s failed with HTTP %d: %s", url, res.Status, res.Body)
	}
	if dst != nil && strings.TrimSpace(res.Body) != "" {
		if err := json.Unmarshal([]byte(res.Body), dst); err != nil {
			h.T.Fatalf("APIPost %s json.Unmarshal failed: %v (body: %s)", url, err, res.Body)
		}
	}
	return res
}

// APIMethod performs an HTTP request (`method`) via `window.slaprfCurl`, asserts 2xx, and decodes JSON into `dst`.
func (h *Harness) APIMethod(method, url string, body any, dst any) CurlResponse {
	h.T.Helper()
	res := h.Curl(CurlRequest{Method: method, URL: url, Body: body})
	if res.Status < 200 || res.Status >= 300 {
		h.T.Fatalf("%s %s failed with HTTP %d: %s", method, url, res.Status, res.Body)
	}
	if dst != nil && strings.TrimSpace(res.Body) != "" {
		if err := json.Unmarshal([]byte(res.Body), dst); err != nil {
			h.T.Fatalf("%s %s json.Unmarshal failed: %v (body: %s)", method, url, err, res.Body)
		}
	}
	return res
}

// APIPut performs a `PUT` via `window.slaprfCurl`, asserts 2xx, and decodes JSON into `dst`.
func (h *Harness) APIPut(url string, body any, dst any) CurlResponse {
	h.T.Helper()
	return h.APIMethod("PUT", url, body, dst)
}

// APIPatch performs a `PATCH` via `window.slaprfCurl`, asserts 2xx, and decodes JSON into `dst`.
func (h *Harness) APIPatch(url string, body any, dst any) CurlResponse {
	h.T.Helper()
	return h.APIMethod("PATCH", url, body, dst)
}

// APIDelete performs a `DELETE` via `window.slaprfCurl`, asserts 2xx, and decodes JSON into `dst`.
func (h *Harness) APIDelete(url string, dst any) CurlResponse {
	h.T.Helper()
	return h.APIMethod("DELETE", url, nil, dst)
}

// APIExpectStatus invokes `window.slaprfCurl` and asserts that the HTTP status matches `wantStatus`.
func (h *Harness) APIExpectStatus(method, url string, body any, wantStatus int) CurlResponse {
	h.T.Helper()
	if wantStatus >= 400 {
		h.AllowConsoleErrorSubstring(fmt.Sprintf("status of %d", wantStatus))
	}
	res := h.Curl(CurlRequest{Method: method, URL: url, Body: body})
	if res.Status != wantStatus {
		h.T.Fatalf("%s %s: expected HTTP %d, got %d (body: %s)", method, url, wantStatus, res.Status, res.Body)
	}
	return res
}

// APIState fetches the authoritative `FullStateResponse` (`GET /v1/state`) directly from the live
// timing engine via `window.slaprfCurl`.
func (h *Harness) APIState() api.FullStateResponse {
	h.T.Helper()
	var st api.FullStateResponse
	h.APIGet("/v1/state", &st)
	return st
}

// APIStatus fetches `StatusResponse` (`GET /v1/status`) directly from the live timing engine.
func (h *Harness) APIStatus() api.StatusResponse {
	h.T.Helper()
	var st api.StatusResponse
	h.APIGet("/v1/status", &st)
	return st
}

// APIRules fetches `TimingRules` (`GET /v1/practice/sessions/current/track/rules`) from the active practice session.
func (h *Harness) APIRules() domain.TimingRules {
	h.T.Helper()
	var rules domain.TimingRules
	h.APIGet("/v1/practice/sessions/current/track/rules", &rules)
	return rules
}

// WasmRequest invokes `window.slaprfCurl` (routing natively to Go HTTP in Backend Mode or `window.slaprfWasm`
// in StaticDemoMode) inside the browser page.
func (h *Harness) WasmRequest(method, path, body string) (int, string, error) {
	res, err := h.Page.Evaluate(`async ([m, p, b]) => {
		if (typeof window.slaprfCurl === "function") {
			const r = await window.slaprfCurl({ method: m, url: p, body: b || undefined });
			return { status: Number(r.status || 0), body: String(r.body || "") };
		}
		if (!window.slaprfWasm || typeof window.slaprfWasm.request !== "function") {
			throw new Error("slaprfCurl / slaprfWasm not initialized");
		}
		const r = window.slaprfWasm.request(m, p, b || "");
		return { status: Number(r.status || 0), body: String(r.body || "") };
	}`, []any{method, path, body})
	if err != nil {
		return 0, "", err
	}
	m, ok := res.(map[string]any)
	if !ok {
		return 0, "", fmt.Errorf("unexpected WasmRequest return %T", res)
	}
	statusFloat, _ := m["status"].(float64)
	statusInt, _ := m["status"].(int)
	status := int(statusFloat)
	if status == 0 && statusInt != 0 {
		status = statusInt
	}
	bodyStr, _ := m["body"].(string)
	return status, bodyStr, nil
}

// WasmGetJSON queries a GET endpoint on the in-browser Go WASM engine and decodes JSON into `dst`.
func (h *Harness) WasmGetJSON(path string, dst any) error {
	status, raw, err := h.WasmRequest("GET", path, "")
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return fmt.Errorf("GET %s returned %d: %s", path, status, raw)
	}
	if dst == nil {
		return nil
	}
	return json.Unmarshal([]byte(raw), dst)
}

// WasmMethodJSON sends an HTTP request (`method`) to the live timing engine and optionally decodes JSON.
func (h *Harness) WasmMethodJSON(method, path string, payload any, dst any) error {
	var bodyStr string
	if payload != nil {
		b, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		bodyStr = string(b)
	}
	status, raw, err := h.WasmRequest(method, path, bodyStr)
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return fmt.Errorf("%s %s returned %d: %s", method, path, status, raw)
	}
	if dst != nil && strings.TrimSpace(raw) != "" {
		return json.Unmarshal([]byte(raw), dst)
	}
	return nil
}

// WasmPostJSON posts JSON to the live timing engine and optionally decodes the response.
func (h *Harness) WasmPostJSON(path string, payload any, dst any) error {
	return h.WasmMethodJSON("POST", path, payload, dst)
}

func writeSuiteHTMLReports(totalDuration time.Duration) error {
	suiteRecordsMu.Lock()
	records := append([]testRunRecord(nil), suiteRecords...)
	suiteRecordsMu.Unlock()

	sort.Slice(records, func(i, j int) bool {
		if records[i].Category != records[j].Category {
			return records[i].Category < records[j].Category
		}
		return records[i].Name < records[j].Name
	})

	runReportPath := filepath.Join(suiteRunDir, "index.html")
	if err := os.WriteFile(runReportPath, []byte(renderSuiteHTML(records, totalDuration, "")), 0o644); err != nil {
		return err
	}

	latestPath := filepath.Join(suiteResultsDir, "latest.html")
	if err := os.WriteFile(latestPath, []byte(renderSuiteHTML(records, totalDuration, suiteRunID+"/")), 0o644); err != nil {
		return err
	}

	mdSummary := renderGitHubStepSummary(records, totalDuration)
	_ = os.WriteFile(filepath.Join(suiteResultsDir, "summary.md"), []byte(mdSummary), 0o644)

	if rawJSON, jErr := renderSuiteJSONSummary(records, totalDuration); jErr == nil {
		_ = os.WriteFile(filepath.Join(suiteResultsDir, "report.json"), rawJSON, 0o644)
	}

	if summaryPath := strings.TrimSpace(os.Getenv("GITHUB_STEP_SUMMARY")); summaryPath != "" {
		if f, err := os.OpenFile(summaryPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
			_, _ = f.WriteString(mdSummary)
			_ = f.Close()
		}
	}

	return nil
}

func renderSuiteJSONSummary(records []testRunRecord, totalDuration time.Duration) ([]byte, error) {
	passCount, failCount, compCount, wfCount, apiCount := 0, 0, 0, 0, 0
	var failedNames []string
	for _, r := range records {
		if r.Passed {
			passCount++
		} else {
			failCount++
			failedNames = append(failedNames, r.Name)
		}
		switch r.Category {
		case "component":
			compCount++
		case "api":
			apiCount++
		default:
			wfCount++
		}
	}
	payload := map[string]any{
		"runId":          suiteRunID,
		"passed":         failCount == 0 && len(records) > 0,
		"total":          len(records),
		"passCount":      passCount,
		"failCount":      failCount,
		"apiCount":       apiCount,
		"componentCount": compCount,
		"workflowCount":  wfCount,
		"wallTime":       totalDuration.Round(10 * time.Millisecond).String(),
		"failedTests":    failedNames,
	}
	return json.MarshalIndent(payload, "", "  ")
}

func renderGitHubStepSummary(records []testRunRecord, totalDuration time.Duration) string {
	passCount, failCount, compCount, wfCount, apiCount := 0, 0, 0, 0, 0
	for _, r := range records {
		if r.Passed {
			passCount++
		} else {
			failCount++
		}
		switch r.Category {
		case "component":
			compCount++
		case "api":
			apiCount++
		default:
			wfCount++
		}
	}

	statusHeadline := "✅ PASSED"
	if failCount > 0 {
		statusHeadline = "❌ FAILED"
	}

	var b strings.Builder
	fmt.Fprintf(&b, "## SlapRF E2E Verification Suite — %s\n\n", statusHeadline)
	fmt.Fprintf(&b, "| Suite Layer | Tests |\n| :--- | ---: |\n")
	fmt.Fprintf(&b, "| **WASM API Tests (`TestAPI_*`)** | %d |\n", apiCount)
	fmt.Fprintf(&b, "| **Component UI Tests (`TestComponent_*`)** | %d |\n", compCount)
	fmt.Fprintf(&b, "| **Workflow E2E Tests** | %d |\n", wfCount)
	fmt.Fprintf(&b, "| **Total Passed / Total** | **%d / %d** |\n", passCount, len(records))
	fmt.Fprintf(&b, "| **Failed** | %d |\n", failCount)
	fmt.Fprintf(&b, "| **Wall Time** | `%s` |\n\n", totalDuration.Round(10*time.Millisecond).String())

	if failCount > 0 {
		b.WriteString("### ❌ Failing Tests\n\n")
		for _, r := range records {
			if r.Passed {
				continue
			}
			fmt.Fprintf(&b, "- **`%s`** (`%s`, `%s`)\n", r.Name, r.Category, r.Duration.Round(10*time.Millisecond).String())
			for _, pe := range r.PageErrors {
				fmt.Fprintf(&b, "  - `[pageerror]` `%s`\n", pe)
			}
			for _, ce := range r.ConsoleErrors {
				fmt.Fprintf(&b, "  - `[console.error]` `%s`\n", ce)
			}
		}
		b.WriteString("\n")
	}

	if len(records) > 0 {
		fmt.Fprintf(&b, "<details>\n<summary><strong>All %d E2E &amp; WASM API Test Cases</strong> (click to expand)</summary>\n\n", len(records))
		b.WriteString("| Status | Layer | Test Case | Duration |\n| :---: | :--- | :--- | ---: |\n")
		for _, r := range records {
			icon := "✅"
			if !r.Passed {
				icon = "❌"
			}
			catLabel := "Workflow"
			switch r.Category {
			case "api":
				catLabel = "WASM API"
			case "component":
				catLabel = "Component"
			}
			fmt.Fprintf(&b, "| %s | %s | `%s` | `%s` |\n", icon, catLabel, r.Name, r.Duration.Round(10*time.Millisecond).String())
		}
		b.WriteString("\n</details>\n\n")
	}
	return b.String()
}

func renderSuiteHTML(records []testRunRecord, totalDuration time.Duration, relPrefix string) string {
	passCount := 0
	failCount := 0
	compCount := 0
	wfCount := 0
	apiCount := 0
	for _, r := range records {
		if r.Passed {
			passCount++
		} else {
			failCount++
		}
		switch r.Category {
		case "component":
			compCount++
		case "api":
			apiCount++
		default:
			wfCount++
		}
	}

	var cards strings.Builder
	for _, r := range records {
		statusBadge := `<span class="badge pass">PASS</span>`
		statusAttr := "pass"
		if !r.Passed {
			statusBadge = `<span class="badge fail">FAIL</span>`
			statusAttr = "fail"
		}
		catLabel := "WORKFLOW"
		switch r.Category {
		case "component":
			catLabel = "COMPONENT"
		case "api":
			catLabel = "WASM API"
		}
		catBadge := fmt.Sprintf(`<span class="badge cat">%s</span>`, catLabel)

		baseDir := relPrefix + r.DirName + "/"
		vidHref := baseDir + r.VideoRel
		imgHref := baseDir + r.ScreenshotRel
		traceHref := baseDir + r.TraceRel
		traceAbs := filepath.Join(suiteRunDir, r.DirName, "trace.zip")
		traceCmd := fmt.Sprintf("go run github.com/playwright-community/playwright-go/cmd/playwright@v0.5700.1 show-trace %q", traceAbs)

		var errHtml strings.Builder
		if len(r.PageErrors) > 0 || len(r.ConsoleErrors) > 0 {
			errHtml.WriteString(`<div class="err-box"><strong>Runtime Errors</strong><ul>`)
			for _, e := range r.PageErrors {
				errHtml.WriteString(`<li><code>[pageerror] ` + html.EscapeString(e) + `</code></li>`)
			}
			for _, e := range r.ConsoleErrors {
				errHtml.WriteString(`<li><code>[console.error] ` + html.EscapeString(e) + `</code></li>`)
			}
			errHtml.WriteString(`</ul></div>`)
		}

		var milestonesHtml strings.Builder
		if len(r.Milestones) > 0 {
			milestonesHtml.WriteString(`<div class="milestones">`)
			for _, m := range r.Milestones {
				mHref := baseDir + m
				milestonesHtml.WriteString(fmt.Sprintf(
					`<a href="%s" target="_blank" class="thumb-link"><img src="%s" alt="%s" loading="lazy" /><span>%s</span></a>`,
					html.EscapeString(mHref),
					html.EscapeString(mHref),
					html.EscapeString(m),
					html.EscapeString(strings.TrimSuffix(m, ".png")),
				))
			}
			milestonesHtml.WriteString(`</div>`)
		}

		var videoBtn, videoPane string
		if r.VideoRel != "" {
			videoBtn = fmt.Sprintf(`<a class="btn" href="%s" target="_blank">Video (.webm)</a>`, html.EscapeString(vidHref))
			videoPane = fmt.Sprintf(`
          <div class="media-pane">
            <div class="pane-label">Recorded Browser &amp; Engine Execution</div>
            <video controls preload="metadata" src="%s"></video>
          </div>`, html.EscapeString(vidHref))
		}

		cards.WriteString(fmt.Sprintf(`
      <section class="card" data-test-card data-cat="%s" data-status="%s" data-name="%s">
        <header class="card-head">
          <div class="card-title">
            %s
            %s
            <h2>%s</h2>
          </div>
          <div class="card-meta">
            <span class="mono">%s</span>
            %s
            <a class="btn" href="%s" target="_blank">Final (.png)</a>
            <a class="btn" href="%s" download>Trace (.zip)</a>
          </div>
        </header>
        %s
        <div class="media-grid %s">
          %s
          <div class="media-pane">
            <div class="pane-label">Final State Screenshot</div>
            <a href="%s" target="_blank"><img src="%s" alt="Final screenshot for %s" loading="lazy" /></a>
          </div>
        </div>
        %s
        <div class="trace-foot">
          <span class="muted">Inspect full DOM snapshots, network &amp; timeline: drag <code>trace.zip</code> onto <a href="https://trace.playwright.dev" target="_blank" rel="noopener" style="color:#7ee787">trace.playwright.dev</a> or run:</span>
          <code>%s</code>
        </div>
      </section>`,
			html.EscapeString(r.Category),
			html.EscapeString(statusAttr),
			html.EscapeString(strings.ToLower(r.Name)),
			statusBadge,
			catBadge,
			html.EscapeString(r.Name),
			html.EscapeString(r.Duration.Round(10*time.Millisecond).String()),
			videoBtn,
			html.EscapeString(imgHref),
			html.EscapeString(traceHref),
			errHtml.String(),
			map[bool]string{true: "", false: "single-col"}[r.VideoRel != ""],
			videoPane,
			html.EscapeString(imgHref),
			html.EscapeString(imgHref),
			html.EscapeString(r.Name),
			milestonesHtml.String(),
			html.EscapeString(traceCmd),
		))
	}

	return fmt.Sprintf(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>SlapRF E2E Verification Suite · %s</title>
  <style>
    :root {
      --bg: #0f1012;
      --surface: #17191c;
      --surface-2: #1f2226;
      --border: #2b2f36;
      --text: #e6e8ec;
      --muted: #9298a3;
      --good: #2ea043;
      --bad: #da3633;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 28px 32px 64px;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      line-height: 1.45;
    }
    .wrap { max-width: 1360px; margin: 0 auto; }
    header.top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding-bottom: 18px;
      margin-bottom: 18px;
      border-bottom: 1px solid var(--border);
      flex-wrap: wrap;
    }
    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 20px;
      flex-wrap: wrap;
    }
    .filter-btns { display: flex; gap: 8px; flex-wrap: wrap; }
    .filter-btn {
      padding: 6px 12px;
      border-radius: 6px;
      background: var(--surface);
      border: 1px solid var(--border);
      color: var(--muted);
      cursor: pointer;
      font-size: 12.5px;
    }
    .filter-btn.is-active {
      background: #272b31;
      border-color: #484f58;
      color: var(--text);
      font-weight: 600;
    }
    .search-input {
      padding: 6px 12px;
      border-radius: 6px;
      background: var(--surface);
      border: 1px solid var(--border);
      color: var(--text);
      font-size: 13px;
      min-width: 260px;
    }
    h1 { margin: 0; font-size: 20px; font-weight: 600; }
    h2 { margin: 0; font-size: 15px; font-weight: 600; }
    .summary-pills { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .pill {
      padding: 5px 11px;
      border-radius: 6px;
      background: var(--surface);
      border: 1px solid var(--border);
      font-size: 13px;
    }
    .mono, code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .muted { color: var(--muted); font-size: 12.5px; }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 16px 18px;
      margin-bottom: 18px;
    }
    .card[hidden] { display: none; }
    .card-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 14px;
      flex-wrap: wrap;
    }
    .card-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .card-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12.5px; }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 5px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.03em;
    }
    .badge.pass { background: rgba(46, 160, 67, 0.18); color: #7ee787; border: 1px solid rgba(46, 160, 67, 0.4); }
    .badge.fail { background: rgba(218, 54, 51, 0.18); color: #ff7b72; border: 1px solid rgba(218, 54, 51, 0.4); }
    .badge.cat { background: var(--surface-2); color: var(--muted); border: 1px solid var(--border); }
    .btn {
      padding: 5px 10px;
      border-radius: 6px;
      background: var(--surface-2);
      border: 1px solid var(--border);
      color: var(--text);
      text-decoration: none;
      font-size: 12px;
    }
    .btn:hover { background: #262a30; }
    .media-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
    }
    .media-grid.single-col { grid-template-columns: 1fr; }
    @media (max-width: 960px) { .media-grid { grid-template-columns: 1fr; } }
    .media-pane {
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px;
    }
    .pane-label { font-size: 12px; color: var(--muted); margin-bottom: 8px; }
    video, .media-pane img {
      width: 100%%;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: #090a0b;
      display: block;
    }
    .milestones {
      display: flex;
      gap: 10px;
      overflow-x: auto;
      padding-top: 12px;
    }
    .thumb-link {
      flex: 0 0 210px;
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 6px;
      color: var(--muted);
      text-decoration: none;
      font-size: 11px;
    }
    .thumb-link img { width: 100%%; border-radius: 4px; display: block; margin-bottom: 4px; }
    .trace-foot {
      margin-top: 12px;
      padding-top: 10px;
      border-top: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .trace-foot code {
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 6px 10px;
      font-size: 11.5px;
      color: var(--text);
      overflow-x: auto;
    }
    .err-box {
      background: rgba(218, 54, 51, 0.12);
      border: 1px solid rgba(218, 54, 51, 0.4);
      border-radius: 6px;
      padding: 10px 12px;
      margin-bottom: 12px;
      font-size: 12.5px;
    }
    .err-box ul { margin: 6px 0 0; padding-left: 20px; }
  </style>
</head>
<body>
  <div class="wrap">
    <header class="top">
      <div>
        <h1>SlapRF E2E Verification Report</h1>
        <div class="muted mono">Run %s · Total wall time %s</div>
      </div>
      <div class="summary-pills">
        <span class="pill">Total: <strong>%d</strong></span>
        <span class="pill">Component: <strong>%d</strong></span>
        <span class="pill">Workflow: <strong>%d</strong></span>
        <span class="pill">WASM API: <strong>%d</strong></span>
        <span class="pill">Passed: <strong>%d</strong></span>
        <span class="pill">Failed: <strong>%d</strong></span>
      </div>
    </header>
    <div class="toolbar">
      <div class="filter-btns" id="filter-btns">
        <button type="button" class="filter-btn is-active" data-filter="all">All (%d)</button>
        <button type="button" class="filter-btn" data-filter="component">Component Tests (%d)</button>
        <button type="button" class="filter-btn" data-filter="workflow">Workflow Tests (%d)</button>
        <button type="button" class="filter-btn" data-filter="api">WASM API Tests (%d)</button>
        <button type="button" class="filter-btn" data-filter="fail">Failed (%d)</button>
      </div>
      <input type="search" class="search-input" id="search-box" placeholder="Filter tests by name…" autocomplete="off" />
    </div>
    %s
  </div>
  <script>
    (() => {
      let activeFilter = "all";
      const searchBox = document.getElementById("search-box");
      const cards = Array.from(document.querySelectorAll("[data-test-card]"));
      const apply = () => {
        const q = (searchBox.value || "").trim().toLowerCase();
        for (const c of cards) {
          const catOk = activeFilter === "all" || (activeFilter === "fail" ? c.dataset.status === "fail" : c.dataset.cat === activeFilter);
          const qOk = !q || (c.dataset.name || "").includes(q);
          c.hidden = !(catOk && qOk);
        }
      };
      document.getElementById("filter-btns").addEventListener("click", (e) => {
        const btn = e.target.closest("[data-filter]");
        if (!btn) return;
        activeFilter = btn.dataset.filter;
        document.querySelectorAll("[data-filter]").forEach((b) => b.classList.toggle("is-active", b === btn));
        apply();
      });
      searchBox.addEventListener("input", apply);
    })();
  </script>
</body>
</html>`,
		html.EscapeString(suiteRunID),
		html.EscapeString(suiteRunID),
		html.EscapeString(totalDuration.Round(10*time.Millisecond).String()),
		len(records),
		compCount,
		wfCount,
		apiCount,
		passCount,
		failCount,
		len(records),
		compCount,
		wfCount,
		apiCount,
		failCount,
		cards.String(),
	)
}
