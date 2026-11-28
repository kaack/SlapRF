// Command build-tutorials generates narrated < 5-minute MP4 tutorial walkthroughs
// directly from the declarative manifest in `web/src/data/tutorials.json`.
//
// Each video runs against an isolated SlapRF Portable server in Playwright (1440x900 dark mode),
// synthesizes per-step neural voiceover clips with `edge-tts`, aligns step narration to exact
// UI action timestamps with `ffmpeg`, and verifies that every output MP4 stays strictly under
// `maxDurationSec` (300s / 5 minutes).
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"math"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/playwright-community/playwright-go"

	"slaprf/internal/portable"
)

type Manifest struct {
	Channel    ChannelInfo    `json:"channel"`
	Categories []CategoryItem `json:"categories"`
	Videos     []VideoSpec    `json:"videos"`
}

type ChannelInfo struct {
	Name    string `json:"name"`
	Handle  string `json:"handle"`
	URL     string `json:"url"`
	Tagline string `json:"tagline"`
}

type CategoryItem struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

type VideoSpec struct {
	ID                 string     `json:"id"`
	Title              string     `json:"title"`
	Category           string     `json:"category"`
	CategoryLabel      string     `json:"categoryLabel"`
	TryHash            string     `json:"tryHash,omitempty"`
	TryLabel           string     `json:"tryLabel,omitempty"`
	Summary            string     `json:"summary"`
	YouTubeVideoID     string     `json:"youtubeVideoId"`
	OutputFile         string     `json:"outputFile"`
	DurationSec        int        `json:"durationSec"`
	DurationLabel      string     `json:"durationLabel"`
	MaxDurationSec     int        `json:"maxDurationSec"`
	Voice              string     `json:"voice"`
	VoiceRate          string     `json:"voiceRate"`
	SimSpeedMultiplier float64    `json:"simSpeedMultiplier"`
	Steps              []StepSpec `json:"steps"`
}

type StepSpec struct {
	ID        string       `json:"id"`
	StartSec  int          `json:"startSec"`
	Badge     string       `json:"badge"`
	Caption   string       `json:"caption"`
	Narration string       `json:"narration"`
	Actions   []ActionSpec `json:"actions"`
}

type ActionSpec struct {
	Type          string  `json:"type"`
	URL           string  `json:"url,omitempty"`
	Selector      string  `json:"selector,omitempty"`
	Value         string  `json:"value,omitempty"`
	FromSelector  string  `json:"fromSelector,omitempty"`
	OptionID      string  `json:"optionId,omitempty"`
	DX            float64 `json:"dx,omitempty"`
	DY            float64 `json:"dy,omitempty"`
	MS            int     `json:"ms,omitempty"`
	MinElapsedMS  int     `json:"minElapsedMs,omitempty"`
	Confirm       bool    `json:"confirm,omitempty"`
	PauseBeforeMS int     `json:"pauseBeforeMs,omitempty"`
	PauseAfterMS  int     `json:"pauseAfterMs,omitempty"`
}

type stepTiming struct {
	offsetMs int64
	mp3Path  string
	durSec   float64
}

func main() {
	manifestPath := flag.String("manifest", "./web/src/data/tutorials.json", "Path to canonical tutorials.json manifest")
	docsManifestPath := flag.String("docs-manifest", "./docs-site/data/tutorials.json", "Optional Hugo data mirror to keep in sync")
	webDir := flag.String("web", "./web", "Source web directory")
	outDir := flag.String("out", "./_tutorials", "Output directory for rendered .mp4 tutorial videos")
	onlyID := flag.String("id", "", "Optional single tutorial video ID to render (renders all when empty)")
	updateTimestamps := flag.Bool("update-timestamps", false, "Write measured durationSec, durationLabel, and step startSec back to manifest")
	flag.Parse()

	log.SetFlags(log.LstdFlags)

	raw, err := os.ReadFile(*manifestPath)
	if err != nil {
		log.Fatalf("[build-tutorials] read manifest %s: %v", *manifestPath, err)
	}
	var manifest Manifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		log.Fatalf("[build-tutorials] parse manifest %s: %v", *manifestPath, err)
	}

	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		log.Fatalf("[build-tutorials] mkdir %s: %v", *outDir, err)
	}

	ttsBin, ttsBaseArgs := resolveEdgeTTS()
	log.Printf("[build-tutorials] Using TTS runner: %s %s", ttsBin, strings.Join(ttsBaseArgs, " "))

	tmpSite, err := os.MkdirTemp("", "slaprf-tutorials-site-*")
	if err != nil {
		log.Fatalf("[build-tutorials] MkdirTemp site: %v", err)
	}
	defer os.RemoveAll(tmpSite)

	buildCmd := exec.Command("go", "run", "./cmd/build-web", "-web", *webDir, "-out", tmpSite, "-skip-wasm", "-skip-docs")
	buildCmd.Stdout = os.Stdout
	buildCmd.Stderr = os.Stderr
	if err := buildCmd.Run(); err != nil {
		log.Fatalf("[build-tutorials] build-web failed: %v", err)
	}
	_ = exec.Command("git", "checkout", "--", "internal/api/generated/version.json").Run()

	pw, err := playwright.Run()
	if err != nil {
		log.Fatalf("[build-tutorials] playwright.Run: %v", err)
	}
	defer pw.Stop()

	browser, err := pw.Chromium.Launch(playwright.BrowserTypeLaunchOptions{
		Headless: playwright.Bool(true),
	})
	if err != nil {
		log.Fatalf("[build-tutorials] Chromium.Launch: %v", err)
	}
	defer browser.Close()

	renderedCount := 0
	for vi := range manifest.Videos {
		v := &manifest.Videos[vi]
		if *onlyID != "" && v.ID != *onlyID {
			continue
		}
		outFile := v.OutputFile
		if outFile == "" {
			outFile = v.ID + ".mp4"
		}
		finalMP4 := filepath.Join(*outDir, outFile)
		durSec, stepStarts := renderTutorialVideo(browser, tmpSite, ttsBin, ttsBaseArgs, *v, finalMP4)

		maxSec := v.MaxDurationSec
		if maxSec <= 0 {
			maxSec = 300
		}
		if durSec >= float64(maxSec) {
			log.Fatalf("[build-tutorials] video %q exceeded maxDurationSec (%ds): got %.2fs", v.ID, maxSec, durSec)
		}

		roundedDur := int(math.Round(durSec))
		if roundedDur < 1 {
			roundedDur = 1
		}
		v.DurationSec = roundedDur
		v.DurationLabel = formatMMSS(roundedDur)
		for si := range v.Steps {
			if si < len(stepStarts) {
				v.Steps[si].StartSec = stepStarts[si]
			}
		}
		log.Printf("[build-tutorials] Rendered %s -> %s (%s / %.2fs)", v.ID, finalMP4, v.DurationLabel, durSec)
		renderedCount++
	}

	if renderedCount == 0 {
		log.Fatalf("[build-tutorials] no videos matched -id=%q", *onlyID)
	}

	if *updateTimestamps {
		updatedBytes, err := json.MarshalIndent(manifest, "", "  ")
		if err != nil {
			log.Fatalf("[build-tutorials] marshal updated manifest: %v", err)
		}
		updatedBytes = append(updatedBytes, '\n')
		if err := os.WriteFile(*manifestPath, updatedBytes, 0o644); err != nil {
			log.Fatalf("[build-tutorials] write %s: %v", *manifestPath, err)
		}
		if *docsManifestPath != "" {
			if err := os.MkdirAll(filepath.Dir(*docsManifestPath), 0o755); err == nil {
				_ = copyFile(*manifestPath, *docsManifestPath)
			}
		}
		log.Printf("[build-tutorials] Updated measured timestamps in %s", *manifestPath)
	}
}

func renderTutorialVideo(
	browser playwright.Browser,
	siteDir string,
	ttsBin string,
	ttsBaseArgs []string,
	v VideoSpec,
	finalMP4 string,
) (float64, []int) {
	workDir, err := os.MkdirTemp("", "slaprf-tut-"+v.ID+"-*")
	if err != nil {
		log.Fatalf("[build-tutorials] MkdirTemp workDir: %v", err)
	}
	defer os.RemoveAll(workDir)

	audioDir := filepath.Join(workDir, "audio")
	rawVidDir := filepath.Join(workDir, "rawvideo")
	_ = os.MkdirAll(audioDir, 0o755)
	_ = os.MkdirAll(rawVidDir, 0o755)

	voice := v.Voice
	if voice == "" {
		voice = "en-US-AndrewNeural"
	}
	rate := v.VoiceRate
	if rate == "" {
		rate = "+4%"
	}

	timings := make([]stepTiming, len(v.Steps))
	for i, st := range v.Steps {
		mp3Path := filepath.Join(audioDir, fmt.Sprintf("step_%02d.mp3", i))
		args := append([]string{}, ttsBaseArgs...)
		args = append(args,
			"--voice", voice,
			"--rate", rate,
			"--text", st.Narration,
			"--write-media", mp3Path,
		)
		cmd := exec.Command(ttsBin, args...)
		if out, err := cmd.CombinedOutput(); err != nil {
			log.Fatalf("[build-tutorials] edge-tts step %d (%s) failed: %v\n%s", i+1, st.ID, err, string(out))
		}
		dur := probeDurationSec(mp3Path)
		timings[i] = stepTiming{
			mp3Path: mp3Path,
			durSec:  dur,
		}
		log.Printf("[build-tutorials] [%s] synthesized step %d/%d (%s): %.2fs", v.ID, i+1, len(v.Steps), st.ID, dur)
	}

	pSrv := portable.NewServer(portable.Config{
		Version:         "preview",
		StaticFS:        os.DirFS(siteDir),
		DBPath:          filepath.Join(workDir, "tutorial.db"),
		AllowLANOrigins: true,
	})
	defer pSrv.Close()

	httpSrv := httptest.NewServer(pSrv.Handler())
	defer httpSrv.Close()

	speedMult := v.SimSpeedMultiplier
	if speedMult <= 0 {
		speedMult = 18
	}
	seedServerForTutorial(browser, httpSrv.URL, speedMult)

	ctx, err := browser.NewContext(playwright.BrowserNewContextOptions{
		BaseURL:     playwright.String(httpSrv.URL),
		Viewport:    &playwright.Size{Width: 1440, Height: 900},
		ColorScheme: playwright.ColorSchemeDark,
		RecordVideo: &playwright.RecordVideo{
			Dir:  rawVidDir,
			Size: &playwright.Size{Width: 1440, Height: 900},
		},
	})
	if err != nil {
		log.Fatalf("[build-tutorials] NewContext: %v", err)
	}

	_ = ctx.AddInitScript(playwright.Script{
		Content: playwright.String(`
			window.sessionStorage.setItem("slaprf.boot_seen", "1");
			window.localStorage.setItem("slaprf.races.setup_view.v1", "graph");
		`),
	})

	videoEpoch := time.Now()
	page, err := ctx.NewPage()
	if err != nil {
		log.Fatalf("[build-tutorials] NewPage: %v", err)
	}

	if _, err := page.Goto(httpSrv.URL + "/#/races"); err != nil {
		log.Fatalf("[build-tutorials] initial Goto: %v", err)
	}
	_, _ = page.Evaluate(`() => document.fonts.ready`)
	time.Sleep(450 * time.Millisecond)

	stepStarts := make([]int, len(v.Steps))
	for i, st := range v.Steps {
		stepWallStart := time.Now()
		offsetMs := stepWallStart.Sub(videoEpoch).Milliseconds()
		if offsetMs < 0 {
			offsetMs = 0
		}
		timings[i].offsetMs = offsetMs
		stepStarts[i] = int(math.Floor(float64(offsetMs) / 1000.0))

		setOverlayCaption(page, st.Badge, st.Caption)
		for _, act := range st.Actions {
			runStepAction(page, httpSrv.URL, act)
		}

		minStepDur := time.Duration((timings[i].durSec + 0.45) * float64(time.Second))
		if elapsed := time.Since(stepWallStart); elapsed < minStepDur {
			time.Sleep(minStepDur - elapsed)
		}
	}

	time.Sleep(550 * time.Millisecond)
	vid := page.Video()
	if err := page.Close(); err != nil {
		log.Fatalf("[build-tutorials] page.Close: %v", err)
	}
	if err := ctx.Close(); err != nil {
		log.Fatalf("[build-tutorials] ctx.Close: %v", err)
	}
	rawWebM, err := vid.Path()
	if err != nil {
		log.Fatalf("[build-tutorials] vid.Path: %v", err)
	}

	muxNarratedMP4(rawWebM, timings, finalMP4)
	return probeDurationSec(finalMP4), stepStarts
}

func seedServerForTutorial(browser playwright.Browser, baseURL string, speedMult float64) {
	seedCtx, err := browser.NewContext(playwright.BrowserNewContextOptions{
		BaseURL: playwright.String(baseURL),
	})
	if err != nil {
		log.Fatalf("[build-tutorials] seed NewContext: %v", err)
	}
	defer seedCtx.Close()

	seedPage, err := seedCtx.NewPage()
	if err != nil {
		log.Fatalf("[build-tutorials] seed NewPage: %v", err)
	}
	if _, err := seedPage.Goto(baseURL + "/#/races"); err != nil {
		log.Fatalf("[build-tutorials] seed Goto: %v", err)
	}

	_, err = seedPage.Evaluate(`async (speed) => {
		await fetch("/v1/practice:control", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "stop" })
		}).catch(() => {});

		await fetch("/v1/sim/slaprf/hub-usb", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ connected: true })
		});
		for (const tid of [2, 3, 4]) {
			await fetch("/v1/sim/slaprf/timers/" + tid, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ poweredOn: false })
			}).catch(() => {});
		}
		// Keep a Single Timer (Start / Finish on Hub H1) global default so newly created races start with 1 timer cleanly
		const stRes = await fetch("/v1/state");
		const st = await stRes.json();
		const gates = Array.isArray(st.gates) ? [...st.gates].sort((a, b) => a.trackOrder - b.trackOrder) : [];
		if (gates.length > 1) {
			const keep = gates.find((g) => g.role === "START_FINISH") || gates[0];
			for (const g of gates) {
				if (g.gateId !== keep.gateId) {
					await fetch("/v1/track/nodes/" + encodeURIComponent(g.gateId), { method: "DELETE" }).catch(() => {});
				}
			}
			await fetch("/v1/track/nodes/" + encodeURIComponent(keep.gateId), {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					gateId: keep.gateId,
					name: keep.name || "Start / Finish",
					color: keep.color || "#22c55e",
					role: "START_FINISH",
					assignedTimerId: 1
				})
			}).catch(() => {});
		}
		await fetch("/v1/sim", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ running: true, speedMultiplier: speed })
		});
	}`, speedMult)
	if err != nil {
		log.Fatalf("[build-tutorials] seed evaluate: %v", err)
	}
}

func setOverlayCaption(page playwright.Page, badge, caption string) {
	_, _ = page.Evaluate(`([badge, caption]) => {
		let el = document.getElementById("slaprf-walkthrough-caption");
		if (!el) {
			el = document.createElement("div");
			el.id = "slaprf-walkthrough-caption";
			el.style.cssText = [
				"position:fixed",
				"left:50%",
				"bottom:22px",
				"transform:translateX(-50%)",
				"z-index:99999",
				"display:flex",
				"align-items:center",
				"gap:10px",
				"padding:10px 18px",
				"border-radius:999px",
				"background:rgba(15,23,42,0.94)",
				"border:1px solid rgba(56,189,248,0.55)",
				"box-shadow:0 12px 32px rgba(0,0,0,0.55)",
				"color:#f8fafc",
				"font-family:system-ui,-apple-system,sans-serif",
				"font-size:14px",
				"pointer-events:none",
				"max-width:92vw",
				"white-space:nowrap"
			].join(";");
			document.body.appendChild(el);
		}
		el.innerHTML = "";
		const pill = document.createElement("span");
		pill.style.cssText = "background:#0284c7;color:#fff;font-weight:700;font-size:12px;padding:3px 9px;border-radius:999px;letter-spacing:0.03em";
		pill.textContent = badge;
		const text = document.createElement("span");
		text.style.cssText = "font-weight:500";
		text.textContent = caption;
		el.appendChild(pill);
		el.appendChild(text);
	}`, []string{badge, caption})
}

func moveCursorRingAndClick(page playwright.Page, loc playwright.Locator, pauseBefore, pauseAfter time.Duration) error {
	if err := loc.WaitFor(playwright.LocatorWaitForOptions{
		State:   playwright.WaitForSelectorStateVisible,
		Timeout: playwright.Float(10000),
	}); err != nil {
		return err
	}
	if box, err := loc.BoundingBox(); err == nil && box != nil {
		cx := box.X + box.Width/2
		cy := box.Y + box.Height/2
		_ = page.Mouse().Move(cx, cy, playwright.MouseMoveOptions{Steps: playwright.Int(8)})
		_, _ = page.Evaluate(`([x, y]) => {
			let ring = document.getElementById("slaprf-walkthrough-ring");
			if (!ring) {
				ring = document.createElement("div");
				ring.id = "slaprf-walkthrough-ring";
				ring.style.cssText = "position:fixed;width:26px;height:26px;border-radius:50%;border:2.5px solid #38bdf8;background:rgba(56,189,248,0.2);pointer-events:none;z-index:99998;transform:translate(-50%,-50%);transition:left 0.1s ease,top 0.1s ease;";
				document.body.appendChild(ring);
			}
			ring.style.left = x + "px";
			ring.style.top = y + "px";
		}`, []float64{cx, cy})
	}
	if pauseBefore > 0 {
		time.Sleep(pauseBefore)
	}
	if err := loc.Click(); err != nil {
		return err
	}
	if pauseAfter > 0 {
		time.Sleep(pauseAfter)
	}
	return nil
}

func runStepAction(page playwright.Page, baseURL string, act ActionSpec) {
	before := time.Duration(act.PauseBeforeMS) * time.Millisecond
	after := time.Duration(act.PauseAfterMS) * time.Millisecond

	switch act.Type {
	case "goto":
		dest := act.URL
		if strings.HasPrefix(dest, "/") {
			dest = baseURL + dest
		}
		if _, err := page.Goto(dest); err != nil {
			log.Fatalf("[build-tutorials] goto %s: %v", dest, err)
		}
		time.Sleep(350 * time.Millisecond)

	case "fill":
		loc := page.Locator(act.Selector).First()
		if err := loc.WaitFor(playwright.LocatorWaitForOptions{
			State:   playwright.WaitForSelectorStateVisible,
			Timeout: playwright.Float(8000),
		}); err != nil {
			log.Fatalf("[build-tutorials] fill wait %s: %v", act.Selector, err)
		}
		if err := loc.Fill(act.Value); err != nil {
			log.Fatalf("[build-tutorials] fill %s: %v", act.Selector, err)
		}
		time.Sleep(350 * time.Millisecond)

	case "click":
		loc := page.Locator(act.Selector).First()
		if err := moveCursorRingAndClick(page, loc, before, after); err != nil {
			log.Fatalf("[build-tutorials] click %s: %v", act.Selector, err)
		}

	case "clickIfVisible":
		loc := page.Locator(act.Selector).First()
		if err := loc.WaitFor(playwright.LocatorWaitForOptions{
			State:   playwright.WaitForSelectorStateVisible,
			Timeout: playwright.Float(900),
		}); err == nil {
			_ = moveCursorRingAndClick(page, loc, before, after)
		}

	case "openTemplates":
		modalOpt := page.Locator(`.slaprf-modal-backdrop button[data-modal-pick-tpl]`).First()
		if vis, _ := modalOpt.IsVisible(); !vis {
			openBtn := page.Locator(`button[data-rc-ui="open-templates"], button[data-dte-open-templates]`).First()
			if oVis, _ := openBtn.IsVisible(); !oVis {
				expandBtn := page.Locator(`button[data-rc-ui="toggle-controls-expand"]`).First()
				if err := moveCursorRingAndClick(page, expandBtn, 200*time.Millisecond, 300*time.Millisecond); err != nil {
					log.Fatalf("[build-tutorials] openTemplates expand controls: %v", err)
				}
			}
			openBtn = page.Locator(`button[data-rc-ui="open-templates"], button[data-dte-open-templates]`).First()
			if err := moveCursorRingAndClick(page, openBtn, 200*time.Millisecond, 400*time.Millisecond); err != nil {
				log.Fatalf("[build-tutorials] openTemplates click button: %v", err)
			}
		}

	case "wireDrop":
		portLoc := page.Locator(act.FromSelector).First()
		if err := portLoc.WaitFor(playwright.LocatorWaitForOptions{
			State:   playwright.WaitForSelectorStateVisible,
			Timeout: playwright.Float(8000),
		}); err != nil {
			log.Fatalf("[build-tutorials] wireDrop wait port %s: %v", act.FromSelector, err)
		}
		box, err := portLoc.BoundingBox()
		if err != nil || box == nil {
			log.Fatalf("[build-tutorials] wireDrop BoundingBox %s: %v", act.FromSelector, err)
		}
		sx := box.X + box.Width/2
		sy := box.Y + box.Height/2
		dx := act.DX
		dy := act.DY
		if dx == 0 && dy == 0 {
			dx = 36
			dy = -180
		}
		ex := sx + dx
		ey := sy + dy
		_ = page.Mouse().Move(sx, sy, playwright.MouseMoveOptions{Steps: playwright.Int(6)})
		time.Sleep(250 * time.Millisecond)
		_ = page.Mouse().Down()
		_ = page.Mouse().Move(sx+22, sy, playwright.MouseMoveOptions{Steps: playwright.Int(5)})
		_ = page.Mouse().Move(ex, ey, playwright.MouseMoveOptions{Steps: playwright.Int(12)})
		time.Sleep(200 * time.Millisecond)
		_ = page.Mouse().Up()
		time.Sleep(350 * time.Millisecond)

		optSel := fmt.Sprintf(`[data-wire-drop-menu] button[data-wire-drop-opt=%q]:not([disabled])`, act.OptionID)
		optLoc := page.Locator(optSel).First()
		if err := moveCursorRingAndClick(page, optLoc, 250*time.Millisecond, 550*time.Millisecond); err != nil {
			log.Fatalf("[build-tutorials] wireDrop option %s: %v", optSel, err)
		}

	case "runHeatFast":
		// Ensure short 1s countdown & 2 target laps on active race so simulated pilots finish briskly
		_, _ = page.Evaluate(`async () => {
			const res = await fetch("/v1/state");
			const st = await res.json();
			const r = st.raceState;
			if (r && r.raceId && r.config && r.config.countdownSec > 1) {
				await fetch("/v1/race/sessions/" + encodeURIComponent(r.raceId) + "/config", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						config: { ...r.config, countdownSec: 1, targetLaps: Math.min(r.config.targetLaps || 2, 2) },
						generate: false,
						applyToExisting: true
					})
				}).catch(() => {});
			}
		}`)

		startBtn := page.Locator(`button[data-ctrl="start"]:not([disabled])`).First()
		if err := moveCursorRingAndClick(page, startBtn, 250*time.Millisecond, 350*time.Millisecond); err != nil {
			log.Fatalf("[build-tutorials] runHeatFast start: %v", err)
		}
		preemptBtn := page.Locator(`.slaprf-modal-backdrop button[data-preempt-ok]`).First()
		if err := preemptBtn.WaitFor(playwright.LocatorWaitForOptions{
			State:   playwright.WaitForSelectorStateVisible,
			Timeout: playwright.Float(700),
		}); err == nil {
			_ = preemptBtn.Click()
		}

		waitMs := act.MinElapsedMS
		if waitMs <= 0 {
			waitMs = 2200
		}
		// Poll until heat reaches finished state or waitMs + 2500ms elapses
		deadline := time.Now().Add(time.Duration(waitMs+2500) * time.Millisecond)
		time.Sleep(time.Duration(waitMs) * time.Millisecond)
		for time.Now().Before(deadline) {
			confirmLoc := page.Locator(`button[data-ctrl="confirm"]:not([disabled])`).First()
			if vis, _ := confirmLoc.IsVisible(); vis {
				break
			}
			time.Sleep(200 * time.Millisecond)
		}
		stopLoc := page.Locator(`button[data-ctrl="stop"]:not([disabled])`).First()
		if vis, _ := stopLoc.IsVisible(); vis {
			_ = moveCursorRingAndClick(page, stopLoc, 150*time.Millisecond, 400*time.Millisecond)
		}
		if act.Confirm {
			confirmLoc := page.Locator(`button[data-ctrl="confirm"]:not([disabled])`).First()
			if err := moveCursorRingAndClick(page, confirmLoc, 250*time.Millisecond, 500*time.Millisecond); err != nil {
				log.Fatalf("[build-tutorials] runHeatFast confirm: %v", err)
			}
		}

	case "wait":
		if act.MS > 0 {
			time.Sleep(time.Duration(act.MS) * time.Millisecond)
		}

	default:
		log.Fatalf("[build-tutorials] unknown action type %q", act.Type)
	}
}

func muxNarratedMP4(rawWebM string, timings []stepTiming, finalMP4 string) {
	args := []string{"-y", "-i", rawWebM}
	for _, t := range timings {
		args = append(args, "-i", t.mp3Path)
	}

	var filterParts []string
	var mixInputs []string
	for i, t := range timings {
		inIdx := i + 1
		lbl := fmt.Sprintf("a%d", i)
		filterParts = append(filterParts, fmt.Sprintf("[%d:a]adelay=%d|%d[%s]", inIdx, t.offsetMs, t.offsetMs, lbl))
		mixInputs = append(mixInputs, fmt.Sprintf("[%s]", lbl))
	}
	filterParts = append(filterParts, fmt.Sprintf("%samix=inputs=%d:normalize=0:dropout_transition=0[aout]", strings.Join(mixInputs, ""), len(timings)))

	args = append(args,
		"-filter_complex", strings.Join(filterParts, ";"),
		"-map", "0:v:0",
		"-map", "[aout]",
		"-c:v", "libx264",
		"-preset", "fast",
		"-crf", "20",
		"-pix_fmt", "yuv420p",
		"-c:a", "aac",
		"-b:a", "160k",
		"-movflags", "+faststart",
		finalMP4,
	)

	cmd := exec.Command("ffmpeg", args...)
	if out, err := cmd.CombinedOutput(); err != nil {
		log.Fatalf("[build-tutorials] ffmpeg mux failed: %v\n%s", err, string(out))
	}
}

func probeDurationSec(mediaPath string) float64 {
	cmd := exec.Command(
		"ffprobe",
		"-v", "error",
		"-show_entries", "format=duration",
		"-of", "default=noprint_wrappers=1:nokey=1",
		mediaPath,
	)
	out, err := cmd.Output()
	if err != nil {
		log.Fatalf("[build-tutorials] ffprobe %s: %v", mediaPath, err)
	}
	val, err := strconv.ParseFloat(strings.TrimSpace(string(out)), 64)
	if err != nil {
		log.Fatalf("[build-tutorials] parse duration %q for %s: %v", string(out), mediaPath, err)
	}
	return val
}

func resolveEdgeTTS() (string, []string) {
	if p, err := exec.LookPath("edge-tts"); err == nil {
		return p, nil
	}
	home, _ := os.UserHomeDir()
	if home != "" {
		cand := filepath.Join(home, ".local", "bin", "edge-tts")
		if _, err := os.Stat(cand); err == nil {
			return cand, nil
		}
		uvxCand := filepath.Join(home, ".local", "bin", "uvx")
		if _, err := os.Stat(uvxCand); err == nil {
			return uvxCand, []string{"edge-tts"}
		}
	}
	if p, err := exec.LookPath("uvx"); err == nil {
		return p, []string{"edge-tts"}
	}
	log.Fatalf("[build-tutorials] neither edge-tts nor uvx found; install uv or edge-tts")
	return "", nil
}

func formatMMSS(sec int) string {
	if sec < 0 {
		sec = 0
	}
	return fmt.Sprintf("%d:%02d", sec/60, sec%60)
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}
