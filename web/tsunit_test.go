//go:build !js

package webassets_test

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/evanw/esbuild/pkg/api"
)

type tsTestCaseResult struct {
	Name       string  `json:"name"`
	Passed     bool    `json:"passed"`
	Skipped    bool    `json:"skipped"`
	DurationMs float64 `json:"durationMs"`
	Error      string  `json:"error"`
}

type tsSuiteReport struct {
	Name       string             `json:"name"`
	DurationMs float64            `json:"durationMs"`
	Tests      []tsTestCaseResult `json:"tests"`
}

type tsFullUnitReport struct {
	TotalSuites  int             `json:"totalSuites"`
	TotalTests   int             `json:"totalTests"`
	PassedTests  int             `json:"passedTests"`
	FailedTests  int             `json:"failedTests"`
	SkippedTests int             `json:"skippedTests"`
	DurationMs   float64         `json:"durationMs"`
	FatalError   string          `json:"fatalError"`
	Suites       []tsSuiteReport `json:"suites"`
}

func TestTypeScriptUnitSuite(t *testing.T) {
	webDir, err := filepath.Abs(".")
	if err != nil {
		t.Fatalf("resolve web dir: %v", err)
	}
	entryPoint := filepath.Join(webDir, "src", "__tests__", "suite.ts")
	if _, err := os.Stat(entryPoint); err != nil {
		t.Fatalf("missing TypeScript unit test entry point %s: %v", entryPoint, err)
	}

	bundleStart := time.Now()
	buildRes := api.Build(api.BuildOptions{
		EntryPoints: []string{entryPoint},
		Bundle:      true,
		Write:       false,
		Format:      api.FormatIIFE,
		Target:      api.ES2022,
		Sourcemap:   api.SourceMapInline,
		LogLevel:    api.LogLevelSilent,
		Define: map[string]string{
			"__SLAPRF_ABOUT_INFO__": `{"frontendVersion":"0.1.0","releaseTag":"(test)","commitHash":"deadbeef","branchName":"test","licenseSummary":"","licenseFairSource":"","licenseGpl":""}`,
		},
	})
	if len(buildRes.Errors) > 0 {
		var sb strings.Builder
		sb.WriteString("esbuild TypeScript unit bundle failed:\n")
		for _, e := range buildRes.Errors {
			if e.Location != nil {
				fmt.Fprintf(&sb, "  %s:%d:%d: %s\n", e.Location.File, e.Location.Line, e.Location.Column, e.Text)
			} else {
				fmt.Fprintf(&sb, "  %s\n", e.Text)
			}
		}
		t.Fatal(sb.String())
	}
	if len(buildRes.OutputFiles) == 0 {
		t.Fatal("esbuild produced zero output files")
	}
	bundleJS := buildRes.OutputFiles[0].Contents
	t.Logf("Bundled TypeScript unit suite (%d KB) in %s", len(bundleJS)/1024, time.Since(bundleStart).Round(time.Millisecond))

	chromeBin, err := findHeadlessBrowserBinary()
	if err != nil {
		t.Fatalf("headless Chromium/Chrome required to run TypeScript unit tests: %v", err)
	}

	reportCh := make(chan tsFullUnitReport, 1)
	silentWav := buildSilentWavBytes()
	stylesFS := http.StripPrefix("/styles/", http.FileServer(http.Dir(filepath.Join(webDir, "styles"))))

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.WriteString(w, `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>SlapRF TypeScript Unit Suite</title>
  <link rel="stylesheet" href="/styles/tokens.css" />
  <link rel="stylesheet" href="/styles/base.css" />
  <link rel="stylesheet" href="/styles/layout.css" />
  <link rel="stylesheet" href="/styles/components.css" />
  <link rel="stylesheet" href="/styles/views.css" />
</head>
<body>
  <div id="app"></div>
  <div id="test-root"></div>
  <script src="/bundle.js"></script>
</body>
</html>`)
	})
	mux.HandleFunc("/bundle.js", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		_, _ = w.Write(bundleJS)
	})
	mux.Handle("/styles/", stylesFS)
	mux.HandleFunc("/sounds/airhorn.wav", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "audio/wav")
		_, _ = w.Write(silentWav)
	})
	mux.HandleFunc("/api/capabilities", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"portable":false}`)
	})
	mux.HandleFunc("/__tsunit_report", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		defer r.Body.Close()
		var rep tsFullUnitReport
		if decErr := json.NewDecoder(r.Body).Decode(&rep); decErr != nil {
			http.Error(w, decErr.Error(), http.StatusBadRequest)
			return
		}
		select {
		case reportCh <- rep:
		default:
		}
		w.WriteHeader(http.StatusNoContent)
	})

	srv := httptest.NewServer(mux)
	defer srv.Close()

	targetURL := srv.URL + "/"
	if filter := strings.TrimSpace(os.Getenv("SLAPRF_TS_FILTER")); filter != "" {
		targetURL += "?filter=" + url.QueryEscape(filter)
	}

	userDataDir := t.TempDir()
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	args := []string{
		"--headless",
		"--no-sandbox",
		"--disable-gpu",
		"--disable-dev-shm-usage",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-extensions",
		"--disable-background-networking",
		"--mute-audio",
		"--window-size=1440,900",
		"--user-data-dir=" + userDataDir,
		targetURL,
	}

	cmd := exec.CommandContext(ctx, chromeBin, args...)
	var stderrBuf bytes.Buffer
	cmd.Stderr = &stderrBuf

	runStart := time.Now()
	if err := cmd.Start(); err != nil {
		t.Fatalf("failed to start headless browser (%s): %v", chromeBin, err)
	}

	procDone := make(chan error, 1)
	go func() {
		procDone <- cmd.Wait()
	}()

	var report tsFullUnitReport
	select {
	case report = <-reportCh:
		cancel()
		<-procDone
	case procErr := <-procDone:
		// Give any in-flight HTTP handler 50ms to flush before failing.
		select {
		case report = <-reportCh:
		case <-time.After(50 * time.Millisecond):
			t.Fatalf("headless browser (%s) exited before reporting results (err=%v):\n%s", chromeBin, procErr, stderrBuf.String())
		}
	case <-ctx.Done():
		<-procDone
		t.Fatalf("timed out waiting for TypeScript unit suite in %s:\n%s", chromeBin, stderrBuf.String())
	}

	if report.FatalError != "" {
		t.Fatalf("uncaught runtime error in TypeScript unit suite:\n%s", report.FatalError)
	}
	if report.TotalTests == 0 {
		t.Fatalf("TypeScript unit suite reported 0 executed tests (check suite imports or SLAPRF_TS_FILTER)")
	}

	t.Logf(
		"Executed %d TypeScript unit tests across %d suites in %.0fms (wall %s via %s)",
		report.TotalTests,
		report.TotalSuites,
		report.DurationMs,
		time.Since(runStart).Round(time.Millisecond),
		filepath.Base(chromeBin),
	)

	for _, suite := range report.Suites {
		suite := suite
		t.Run(suite.Name, func(t *testing.T) {
			for _, tc := range suite.Tests {
				tc := tc
				t.Run(tc.Name, func(t *testing.T) {
					if tc.Skipped {
						t.Skip("skipped in TypeScript suite")
					}
					if !tc.Passed {
						t.Fatalf("TypeScript assertion failed (%.1fms):\n%s", tc.DurationMs, tc.Error)
					}
				})
			}
		})
	}
}

func buildSilentWavBytes() []byte {
	const numSamples = 64
	const dataLen = numSamples * 2
	buf := bytes.NewBuffer(make([]byte, 0, 44+dataLen))
	buf.WriteString("RIFF")
	_ = binary.Write(buf, binary.LittleEndian, uint32(36+dataLen))
	buf.WriteString("WAVEfmt ")
	_ = binary.Write(buf, binary.LittleEndian, uint32(16))   // PCM chunk size
	_ = binary.Write(buf, binary.LittleEndian, uint16(1))    // AudioFormat = PCM
	_ = binary.Write(buf, binary.LittleEndian, uint16(1))    // NumChannels = 1
	_ = binary.Write(buf, binary.LittleEndian, uint32(8000)) // SampleRate
	_ = binary.Write(buf, binary.LittleEndian, uint32(16000))
	_ = binary.Write(buf, binary.LittleEndian, uint16(2))
	_ = binary.Write(buf, binary.LittleEndian, uint16(16))
	buf.WriteString("data")
	_ = binary.Write(buf, binary.LittleEndian, uint32(dataLen))
	buf.Write(make([]byte, dataLen))
	return buf.Bytes()
}

func findHeadlessBrowserBinary() (string, error) {
	if envBin := strings.TrimSpace(os.Getenv("SLAPRF_CHROME_BIN")); envBin != "" {
		if st, err := os.Stat(envBin); err == nil && !st.IsDir() {
			return envBin, nil
		}
		if p, err := exec.LookPath(envBin); err == nil {
			return p, nil
		}
	}

	// 1. Prefer Playwright's cached headless shell / Chromium when available (fast startup, deterministic).
	for _, root := range playwrightCacheRoots() {
		if bin := findPlaywrightChromiumInRoot(root); bin != "" {
			return bin, nil
		}
	}

	// 2. Check PATH for Chrome / Chromium / Edge (works out of the box on GitHub Actions ubuntu-latest).
	for _, cmdName := range []string{
		"google-chrome",
		"google-chrome-stable",
		"chromium",
		"chromium-browser",
		"chrome",
		"msedge",
	} {
		if p, err := exec.LookPath(cmdName); err == nil {
			return p, nil
		}
	}

	// 3. Standard OS installation paths.
	var candidates []string
	switch runtime.GOOS {
	case "windows":
		for _, env := range []string{"PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"} {
			base := os.Getenv(env)
			if base == "" {
				continue
			}
			candidates = append(candidates,
				filepath.Join(base, "Google", "Chrome", "Application", "chrome.exe"),
				filepath.Join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
				filepath.Join(base, "Chromium", "Application", "chrome.exe"),
			)
		}
	case "darwin":
		candidates = append(candidates,
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		)
	default:
		candidates = append(candidates,
			"/usr/bin/google-chrome",
			"/usr/bin/google-chrome-stable",
			"/usr/bin/chromium",
			"/usr/bin/chromium-browser",
		)
	}
	for _, c := range candidates {
		if st, err := os.Stat(c); err == nil && !st.IsDir() {
			return c, nil
		}
	}

	return "", fmt.Errorf("no Chromium/Chrome/Edge binary found (set SLAPRF_CHROME_BIN or install Playwright Chromium)")
}

func playwrightCacheRoots() []string {
	var roots []string
	if custom := strings.TrimSpace(os.Getenv("PLAYWRIGHT_BROWSERS_PATH")); custom != "" && custom != "0" {
		roots = append(roots, custom)
	}
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "windows":
		if local := os.Getenv("LOCALAPPDATA"); local != "" {
			roots = append(roots, filepath.Join(local, "ms-playwright"))
		}
		if home != "" {
			roots = append(roots, filepath.Join(home, "AppData", "Local", "ms-playwright"))
		}
	case "darwin":
		if home != "" {
			roots = append(roots, filepath.Join(home, "Library", "Caches", "ms-playwright"))
		}
	default:
		if home != "" {
			roots = append(roots, filepath.Join(home, ".cache", "ms-playwright"))
		}
	}
	return roots
}

func findPlaywrightChromiumInRoot(root string) string {
	entries, err := os.ReadDir(root)
	if err != nil {
		return ""
	}
	type dirBuild struct {
		name  string
		rev   int
		shell bool
	}
	var dirs []dirBuild
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		name := e.Name()
		if strings.HasPrefix(name, "chromium_headless_shell-") {
			rev, _ := strconv.Atoi(strings.TrimPrefix(name, "chromium_headless_shell-"))
			dirs = append(dirs, dirBuild{name: name, rev: rev, shell: true})
		} else if strings.HasPrefix(name, "chromium-") {
			rev, _ := strconv.Atoi(strings.TrimPrefix(name, "chromium-"))
			dirs = append(dirs, dirBuild{name: name, rev: rev, shell: false})
		}
	}
	// Prefer headless_shell first (fastest cold start), then newest revision.
	sort.Slice(dirs, func(i, j int) bool {
		if dirs[i].shell != dirs[j].shell {
			return dirs[i].shell
		}
		return dirs[i].rev > dirs[j].rev
	})

	var relPaths []string
	switch runtime.GOOS {
	case "windows":
		relPaths = []string{
			filepath.Join("chrome-headless-shell-win64", "chrome-headless-shell.exe"),
			filepath.Join("chrome-win64", "chrome-headless-shell.exe"),
			filepath.Join("chrome-win", "headless_shell.exe"),
			filepath.Join("chrome-win64", "chrome.exe"),
			filepath.Join("chrome-win", "chrome.exe"),
		}
	case "darwin":
		relPaths = []string{
			filepath.Join("chrome-headless-shell-mac-arm64", "chrome-headless-shell"),
			filepath.Join("chrome-headless-shell-mac-x64", "chrome-headless-shell"),
			filepath.Join("chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
			filepath.Join("chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
		}
	default:
		relPaths = []string{
			filepath.Join("chrome-headless-shell-linux64", "chrome-headless-shell"),
			filepath.Join("chrome-linux", "headless_shell"),
			filepath.Join("chrome-linux64", "chrome"),
			filepath.Join("chrome-linux", "chrome"),
		}
	}

	for _, d := range dirs {
		base := filepath.Join(root, d.name)
		for _, rel := range relPaths {
			full := filepath.Join(base, rel)
			if st, err := os.Stat(full); err == nil && !st.IsDir() {
				return full
			}
		}
	}
	return ""
}
