// Command build-tutorials generates natural, 1080p 60 FPS MP4 tutorial walkthroughs
// directly from the declarative manifest in `web/src/data/tutorials.json`.
//
// On Linux with Xvfb + headed Chrome + ffmpeg x11grab, it launches an isolated
// 1920x1080 virtual X11 display, drives the real OS cursor along 120 Hz minimum-jerk
// human curves via libXtst (preserving native arrow/hand/text cursor shapes and hover
// states), records constant-60-FPS video via x11grab, and aligns phrase-level ("beat")
// edge-tts narration to the exact cursor movements.
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"math"
	"net"
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
	Beats     []BeatSpec   `json:"beats,omitempty"`
	Actions   []ActionSpec `json:"actions,omitempty"`
}

type BeatSpec struct {
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
	GlideMS       int     `json:"glideMs,omitempty"`
	TypeDelayMS   int     `json:"typeDelayMs,omitempty"`
	MinElapsedMS  int     `json:"minElapsedMs,omitempty"`
	Confirm       bool    `json:"confirm,omitempty"`
	PauseBeforeMS int     `json:"pauseBeforeMs,omitempty"`
	PauseAfterMS  int     `json:"pauseAfterMs,omitempty"`
}

type beatClip struct {
	stepIdx   int
	beatIdx   int
	mp3Path   string
	durSec    float64
	startedAt time.Time
	offsetMs  int64
}

const xtestDriverPy = `
import ctypes, json, math, sys, time

disp_name = sys.argv[1].encode()
x11 = ctypes.cdll.LoadLibrary("libX11.so.6")
xtst = ctypes.cdll.LoadLibrary("libXtst.so.6")
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XFlush.argtypes = [ctypes.c_void_p]
x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
xtst.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
xtst.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]

dpy = x11.XOpenDisplay(disp_name)
if not dpy:
    sys.stderr.write("failed to open X display\n")
    sys.exit(1)

cur_x, cur_y = 960.0, 540.0
xtst.XTestFakeMotionEvent(dpy, -1, int(cur_x), int(cur_y), 0)
x11.XFlush(dpy)
sys.stdout.write("ready\n")
sys.stdout.flush()

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    cmd = json.loads(line)
    op = cmd.get("op")
    if op == "quit":
        break
    elif op == "warp":
        cur_x = float(cmd["x"])
        cur_y = float(cmd["y"])
        xtst.XTestFakeMotionEvent(dpy, -1, int(round(cur_x)), int(round(cur_y)), 0)
        x11.XFlush(dpy)
    elif op == "glide":
        tx = float(cmd["x"])
        ty = float(cmd["y"])
        dur_ms = float(cmd.get("durMs", 0))
        dx = tx - cur_x
        dy = ty - cur_y
        dist = math.hypot(dx, dy)
        if dist >= 1.5:
            if dur_ms <= 0:
                dur_ms = max(340.0, min(820.0, 290.0 + dist * 0.44))
            arc = min(38.0, max(8.0, dist * 0.07))
            if tx < cur_x:
                arc = -arc
            nx = -dy / dist
            ny = dx / dist
            mx = (cur_x + tx) * 0.5 + nx * arc
            my = (cur_y + ty) * 0.5 + ny * arc
            steps = max(12, int(round(dur_ms / 8.333)))
            t0 = time.perf_counter()
            dur_s = dur_ms / 1000.0
            fx, fy = cur_x, cur_y
            for s in range(1, steps + 1):
                raw = s / steps
                # Minimum-jerk human hand trajectory: 10u^3 - 15u^4 + 6u^5
                u = raw * raw * raw * (10.0 - 15.0 * raw + 6.0 * raw * raw)
                inv = 1.0 - u
                px = inv * inv * fx + 2.0 * inv * u * mx + u * u * tx
                py = inv * inv * fy + 2.0 * inv * u * my + u * u * ty
                xtst.XTestFakeMotionEvent(dpy, -1, int(round(px)), int(round(py)), 0)
                x11.XFlush(dpy)
                target = t0 + (dur_s * s / steps)
                rem = target - time.perf_counter()
                if rem > 0:
                    time.sleep(rem)
        cur_x, cur_y = tx, ty
        xtst.XTestFakeMotionEvent(dpy, -1, int(round(cur_x)), int(round(cur_y)), 0)
        x11.XFlush(dpy)
    elif op == "down":
        btn = int(cmd.get("button", 1))
        xtst.XTestFakeButtonEvent(dpy, btn, 1, 0)
        x11.XFlush(dpy)
    elif op == "up":
        btn = int(cmd.get("button", 1))
        xtst.XTestFakeButtonEvent(dpy, btn, 0, 0)
        x11.XFlush(dpy)
    elif op == "click":
        btn = int(cmd.get("button", 1))
        xtst.XTestFakeButtonEvent(dpy, btn, 1, 0)
        x11.XFlush(dpy)
        time.sleep(0.065)
        xtst.XTestFakeButtonEvent(dpy, btn, 0, 0)
        x11.XFlush(dpy)
    sys.stdout.write("ok\n")
    sys.stdout.flush()

x11.XCloseDisplay(dpy)
`

type xtestClient struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	reader *bufio.Reader
	offX   float64
	offY   float64
}

func startXTestClient(display string) *xtestClient {
	cmd := exec.Command("python3", "-u", "-c", xtestDriverPy, display)
	cmd.Stderr = os.Stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		log.Fatalf("[build-tutorials] xtest stdin: %v", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		log.Fatalf("[build-tutorials] xtest stdout: %v", err)
	}
	if err := cmd.Start(); err != nil {
		log.Fatalf("[build-tutorials] start xtest helper: %v", err)
	}
	r := bufio.NewReader(stdout)
	line, err := r.ReadString('\n')
	if err != nil || strings.TrimSpace(line) != "ready" {
		log.Fatalf("[build-tutorials] xtest helper did not report ready: %q (%v)", line, err)
	}
	return &xtestClient{cmd: cmd, stdin: stdin, reader: r}
}

func (x *xtestClient) send(payload map[string]any) {
	b, _ := json.Marshal(payload)
	b = append(b, '\n')
	if _, err := x.stdin.Write(b); err != nil {
		log.Fatalf("[build-tutorials] write xtest: %v", err)
	}
	if _, err := x.reader.ReadString('\n'); err != nil {
		log.Fatalf("[build-tutorials] read xtest ack: %v", err)
	}
}

func (x *xtestClient) glide(tx, ty float64, durMs int) {
	x.send(map[string]any{"op": "glide", "x": tx + x.offX, "y": ty + x.offY, "durMs": durMs})
}

func (x *xtestClient) click() {
	x.send(map[string]any{"op": "click", "button": 1})
}

func (x *xtestClient) down() {
	x.send(map[string]any{"op": "down", "button": 1})
}

func (x *xtestClient) up() {
	x.send(map[string]any{"op": "up", "button": 1})
}

func (x *xtestClient) close() {
	_, _ = x.stdin.Write([]byte(`{"op":"quit"}` + "\n"))
	_ = x.stdin.Close()
	_ = x.cmd.Wait()
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
	chromeBin := resolveChromeBin()
	log.Printf("[build-tutorials] TTS: %s %s | Chrome: %s", ttsBin, strings.Join(ttsBaseArgs, " "), chromeBin)

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
		durSec, stepStarts := renderTutorialVideoXvfb(pw, chromeBin, tmpSite, ttsBin, ttsBaseArgs, *v, finalMP4)

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

func effectiveBeats(st StepSpec) []BeatSpec {
	if len(st.Beats) > 0 {
		return st.Beats
	}
	return []BeatSpec{{
		Narration: st.Narration,
		Actions:   st.Actions,
	}}
}

func renderTutorialVideoXvfb(
	pw *playwright.Playwright,
	chromeBin string,
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
	_ = os.MkdirAll(audioDir, 0o755)

	voice := v.Voice
	if voice == "" {
		voice = "en-US-AndrewNeural"
	}
	rate := v.VoiceRate
	if rate == "" {
		rate = "+2%"
	}

	var clips []beatClip
	for si, st := range v.Steps {
		beats := effectiveBeats(st)
		for bi, bt := range beats {
			mp3Path := filepath.Join(audioDir, fmt.Sprintf("step_%02d_beat_%02d.mp3", si, bi))
			args := append([]string{}, ttsBaseArgs...)
			args = append(args,
				"--voice", voice,
				"--rate", rate,
				"--text", bt.Narration,
				"--write-media", mp3Path,
			)
			cmd := exec.Command(ttsBin, args...)
			if out, err := cmd.CombinedOutput(); err != nil {
				log.Fatalf("[build-tutorials] edge-tts step %d beat %d (%s) failed: %v\n%s", si+1, bi+1, st.ID, err, string(out))
			}
			dur := probeDurationSec(mp3Path)
			clips = append(clips, beatClip{
				stepIdx: si,
				beatIdx: bi,
				mp3Path: mp3Path,
				durSec:  dur,
			})
			log.Printf("[build-tutorials] [%s] synthesized step %d.%d (%s): %.2fs", v.ID, si+1, bi+1, st.ID, dur)
		}
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

	// 1. Start isolated 1920x1080 virtual X11 display (Xvfb)
	dispNum := pickFreeXDisplay()
	disp := fmt.Sprintf(":%d", dispNum)
	xvfbCmd := exec.Command("Xvfb", disp, "-screen", "0", "1920x1080x24", "-ac", "-nolisten", "tcp")
	if err := xvfbCmd.Start(); err != nil {
		log.Fatalf("[build-tutorials] start Xvfb %s: %v", disp, err)
	}
	defer func() {
		_ = xvfbCmd.Process.Kill()
		_ = xvfbCmd.Wait()
	}()
	time.Sleep(400 * time.Millisecond)

	xEnv := cleanX11Env(disp)

	// 2. Launch real headed Chrome in 1920x1080 kiosk mode on Xvfb with CDP port
	cdpPort := pickFreeTCPPort()
	chromeProfile := filepath.Join(workDir, "chrome-profile")
	chromeCmd := exec.Command(
		chromeBin,
		"--ozone-platform=x11",
		"--enable-gpu-rasterization",
		"--ignore-gpu-blocklist",
		"--force-color-profile=srgb",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-infobars",
		"--disable-notifications",
		"--disable-translate",
		"--password-store=basic",
		"--force-dark-mode",
		"--enable-features=WebUIDarkMode",
		"--user-data-dir="+chromeProfile,
		fmt.Sprintf("--remote-debugging-port=%d", cdpPort),
		"--window-position=0,0",
		"--window-size=1920,1080",
		"--kiosk",
		"about:blank",
	)
	chromeCmd.Env = xEnv
	if err := chromeCmd.Start(); err != nil {
		log.Fatalf("[build-tutorials] start Chrome: %v", err)
	}
	defer func() {
		_ = chromeCmd.Process.Kill()
		_ = chromeCmd.Wait()
	}()

	browser := connectCDPRetry(pw, cdpPort, 10*time.Second)
	defer browser.Close()

	var page playwright.Page
	for attempt := 0; attempt < 30; attempt++ {
		ctxs := browser.Contexts()
		if len(ctxs) > 0 && len(ctxs[0].Pages()) > 0 {
			page = ctxs[0].Pages()[0]
			break
		}
		time.Sleep(150 * time.Millisecond)
	}
	if page == nil {
		log.Fatalf("[build-tutorials] failed to attach to kiosk Chrome page")
	}

	speedMult := v.SimSpeedMultiplier
	if speedMult <= 0 {
		speedMult = 8
	}
	if _, err := page.Goto(httpSrv.URL + "/#/races"); err != nil {
		log.Fatalf("[build-tutorials] initial goto /#/races: %v", err)
	}
	_ = page.Locator(`[data-race-dir-search]`).First().WaitFor(playwright.LocatorWaitForOptions{
		State:   playwright.WaitForSelectorStateVisible,
		Timeout: playwright.Float(10000),
	})
	seedServerViaPage(page, httpSrv.URL, speedMult)
	if _, err := page.Reload(); err != nil {
		log.Fatalf("[build-tutorials] reload /#/races: %v", err)
	}
	_ = page.Locator(`[data-race-dir-search]`).First().WaitFor(playwright.LocatorWaitForOptions{
		State:   playwright.WaitForSelectorStateVisible,
		Timeout: playwright.Float(10000),
	})
	_, _ = page.Evaluate(`() => document.fonts.ready`)
	time.Sleep(800 * time.Millisecond)

	// 3. Connect real OS mouse driver (libXtst), calibrate X11->viewport offset, and position pointer near center
	mouse := startXTestClient(disp)
	defer mouse.close()
	_, _ = page.Evaluate(`() => {
		window.__lastMouseProbe = null;
		window.addEventListener("mousemove", (e) => {
			window.__lastMouseProbe = { x: e.clientX, y: e.clientY };
		}, { once: true });
	}`)
	mouse.send(map[string]any{"op": "warp", "x": 600, "y": 400})
	mouse.click() // ensure X11 window has active input focus
	mouse.send(map[string]any{"op": "warp", "x": 640, "y": 420})
	time.Sleep(120 * time.Millisecond)
	if probeRaw, pErr := page.Evaluate(`() => window.__lastMouseProbe`); pErr == nil && probeRaw != nil {
		if pm, ok := probeRaw.(map[string]any); ok {
			px, _ := pm["x"].(float64)
			py, _ := pm["y"].(float64)
			if px > 0 && py > 0 {
				mouse.offX = 640.0 - px
				mouse.offY = 420.0 - py
				log.Printf("[build-tutorials] [%s] calibrated X11 viewport offset: dx=%.1f dy=%.1f", v.ID, mouse.offX, mouse.offY)
			}
		}
	}
	mouse.send(map[string]any{"op": "warp", "x": 960 + mouse.offX, "y": 520 + mouse.offY})
	time.Sleep(350 * time.Millisecond)

	// 4. Start constant-60-FPS ffmpeg x11grab into a live-playable .mkv inside outDir so user can watch live!
	rawVideoMKV := filepath.Join(filepath.Dir(finalMP4), v.ID+"-recording-live.mkv")
	defer os.Remove(rawVideoMKV)
	ffStdin, ffDone, ffStartWall := startFFmpegX11Grab(disp, xEnv, rawVideoMKV)

	time.Sleep(350 * time.Millisecond)

	clipIdx := 0
	stepFirstTime := make([]time.Time, len(v.Steps))

	for si, st := range v.Steps {
		beats := effectiveBeats(st)
		for bi, bt := range beats {
			clip := &clips[clipIdx]
			clip.startedAt = time.Now()
			if bi == 0 {
				stepFirstTime[si] = clip.startedAt
			}

			// Brief 110ms vocal lead-in as hand begins moving toward the target control
			time.Sleep(110 * time.Millisecond)
			for _, act := range bt.Actions {
				runStepAction(page, mouse, httpSrv.URL, act)
			}

			minBeatDur := time.Duration((clip.durSec + 0.28) * float64(time.Second))
			if elapsed := time.Since(clip.startedAt); elapsed < minBeatDur {
				time.Sleep(minBeatDur - elapsed)
			}
			clipIdx++
		}
	}

	time.Sleep(600 * time.Millisecond)
	_, _ = ffStdin.Write([]byte("q\n"))
	_ = ffStdin.Close()
	<-ffDone

	rawDurSec := probeDurationSec(rawVideoMKV)
	log.Printf("[build-tutorials] [%s] captured 60 FPS X11 video: %.2fs", v.ID, rawDurSec)

	var prevAudioEndMs int64 = 0
	for i := range clips {
		off := clips[i].startedAt.Sub(ffStartWall).Milliseconds()
		if off < 80 {
			off = 80
		}
		if i > 0 && off < prevAudioEndMs+140 {
			off = prevAudioEndMs + 140
		}
		clips[i].offsetMs = off
		prevAudioEndMs = off + int64(math.Round(clips[i].durSec*1000.0))
	}

	stepStarts := make([]int, len(v.Steps))
	for si := range v.Steps {
		off := stepFirstTime[si].Sub(ffStartWall).Milliseconds()
		if off < 0 || si == 0 {
			off = 0
		}
		stepStarts[si] = int(math.Floor(float64(off) / 1000.0))
	}

	muxNarratedMP4(rawVideoMKV, clips, finalMP4)
	return probeDurationSec(finalMP4), stepStarts
}

func startFFmpegX11Grab(disp string, env []string, outMP4 string) (io.WriteCloser, <-chan struct{}, time.Time) {
	cmd := exec.Command(
		"ffmpeg",
		"-y",
		"-f", "x11grab",
		"-framerate", "60",
		"-draw_mouse", "1",
		"-video_size", "1920x1080",
		"-i", disp+".0",
		"-c:v", "libx264",
		"-preset", "ultrafast",
		"-crf", "10",
		"-pix_fmt", "yuv420p",
		outMP4,
	)
	cmd.Env = env
	stdin, err := cmd.StdinPipe()
	if err != nil {
		log.Fatalf("[build-tutorials] ffmpeg stdin: %v", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		log.Fatalf("[build-tutorials] ffmpeg stderr: %v", err)
	}
	if err := cmd.Start(); err != nil {
		log.Fatalf("[build-tutorials] start ffmpeg x11grab: %v", err)
	}

	startedCh := make(chan time.Time, 1)
	doneCh := make(chan struct{})

	go func() {
		sc := bufio.NewScanner(stderr)
		sc.Split(splitCRLF)
		reported := false
		for sc.Scan() {
			txt := sc.Text()
			if !reported && (strings.Contains(txt, "Press [q]") || strings.Contains(txt, "frame=")) {
				reported = true
				startedCh <- time.Now()
			}
		}
		if !reported {
			startedCh <- time.Now()
		}
		_ = cmd.Wait()
		close(doneCh)
	}()

	startWall := <-startedCh
	return stdin, doneCh, startWall
}

func splitCRLF(data []byte, atEOF bool) (advance int, token []byte, err error) {
	if atEOF && len(data) == 0 {
		return 0, nil, nil
	}
	for i, b := range data {
		if b == '\n' || b == '\r' {
			return i + 1, data[0:i], nil
		}
	}
	if atEOF {
		return len(data), data, nil
	}
	return 0, nil, nil
}

func seedServerViaPage(page playwright.Page, baseURL string, speedMult float64) {
	_, err := page.Evaluate(`async (speed) => {
		window.sessionStorage.setItem("slaprf.boot_seen", "1");
		window.localStorage.setItem("slaprf.races.setup_view.v1", "graph");
		window.localStorage.removeItem("slaprf.rc.setupViewIntroSeen.v1");

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

func glideAndClickOS(mouse *xtestClient, loc playwright.Locator, glideMs int, pauseBefore, pauseAfter time.Duration) error {
	if err := loc.WaitFor(playwright.LocatorWaitForOptions{
		State:   playwright.WaitForSelectorStateVisible,
		Timeout: playwright.Float(10000),
	}); err != nil {
		return err
	}
	_ = loc.ScrollIntoViewIfNeeded()
	box, err := loc.BoundingBox()
	if err != nil || box == nil {
		return fmt.Errorf("BoundingBox nil: %v", err)
	}
	cx := box.X + box.Width*0.5
	cy := box.Y + box.Height*0.5
	mouse.glide(cx, cy, glideMs)

	hoverWait := pauseBefore
	if hoverWait < 160*time.Millisecond {
		hoverWait = 160 * time.Millisecond
	}
	time.Sleep(hoverWait)
	mouse.click()

	if pauseAfter > 0 {
		time.Sleep(pauseAfter)
	}
	return nil
}

func runStepAction(page playwright.Page, mouse *xtestClient, baseURL string, act ActionSpec) {
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
		time.Sleep(250 * time.Millisecond)

	case "hover":
		loc := page.Locator(act.Selector).First()
		if err := loc.WaitFor(playwright.LocatorWaitForOptions{
			State:   playwright.WaitForSelectorStateVisible,
			Timeout: playwright.Float(8000),
		}); err != nil {
			log.Fatalf("[build-tutorials] hover wait %s: %v", act.Selector, err)
		}
		if box, err := loc.BoundingBox(); err == nil && box != nil {
			mouse.glide(box.X+box.Width*0.5, box.Y+box.Height*0.5, act.GlideMS)
		}
		if after > 0 {
			time.Sleep(after)
		}

	case "fill":
		loc := page.Locator(act.Selector).First()
		if err := glideAndClickOS(mouse, loc, act.GlideMS, 140*time.Millisecond, 100*time.Millisecond); err != nil {
			log.Fatalf("[build-tutorials] fill focus %s: %v", act.Selector, err)
		}
		_ = loc.Fill("")
		delayMs := act.TypeDelayMS
		if delayMs <= 0 {
			delayMs = 46
		}
		if err := page.Keyboard().Type(act.Value, playwright.KeyboardTypeOptions{
			Delay: playwright.Float(float64(delayMs)),
		}); err != nil {
			log.Fatalf("[build-tutorials] type %s: %v", act.Selector, err)
		}
		if after > 0 {
			time.Sleep(after)
		} else {
			time.Sleep(180 * time.Millisecond)
		}

	case "click":
		loc := page.Locator(act.Selector).First()
		if err := glideAndClickOS(mouse, loc, act.GlideMS, before, after); err != nil {
			log.Fatalf("[build-tutorials] click %s: %v", act.Selector, err)
		}

	case "clickIfVisible":
		loc := page.Locator(act.Selector).First()
		if err := loc.WaitFor(playwright.LocatorWaitForOptions{
			State:   playwright.WaitForSelectorStateVisible,
			Timeout: playwright.Float(1500),
		}); err == nil {
			_ = glideAndClickOS(mouse, loc, act.GlideMS, before, after)
		}

	case "openTemplates":
		modalOpt := page.Locator(`.slaprf-modal-backdrop button[data-modal-pick-tpl]`).First()
		if vis, _ := modalOpt.IsVisible(); !vis {
			openBtn := page.Locator(`button[data-rc-ui="open-templates"], button[data-dte-open-templates]`).First()
			if oVis, _ := openBtn.IsVisible(); !oVis {
				expandBtn := page.Locator(`button[data-rc-ui="toggle-controls-expand"]`).First()
				if err := glideAndClickOS(mouse, expandBtn, 460, 160*time.Millisecond, 260*time.Millisecond); err != nil {
					log.Fatalf("[build-tutorials] openTemplates expand controls: %v", err)
				}
			}
			openBtn = page.Locator(`button[data-rc-ui="open-templates"], button[data-dte-open-templates]`).First()
			if err := glideAndClickOS(mouse, openBtn, 360, 160*time.Millisecond, 320*time.Millisecond); err != nil {
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
		sx := box.X + box.Width*0.5
		sy := box.Y + box.Height*0.5
		dx := act.DX
		dy := act.DY
		if dx == 0 && dy == 0 {
			dx = 140
			dy = -170
		}
		ex := sx + dx
		ey := sy + dy

		mouse.glide(sx, sy, 520)
		time.Sleep(220 * time.Millisecond)
		mouse.down()
		time.Sleep(90 * time.Millisecond)
		mouse.glide(sx+26, sy, 140)
		mouse.glide(ex, ey, 720)
		time.Sleep(260 * time.Millisecond)
		mouse.up()
		time.Sleep(320 * time.Millisecond)

		optSel := fmt.Sprintf(`[data-wire-drop-menu] button[data-wire-drop-opt=%q]:not([disabled])`, act.OptionID)
		optLoc := page.Locator(optSel).First()
		if err := glideAndClickOS(mouse, optLoc, 400, 180*time.Millisecond, 450*time.Millisecond); err != nil {
			log.Fatalf("[build-tutorials] wireDrop option %s: %v", optSel, err)
		}

	case "runHeatFast":
		_, _ = page.Evaluate(`async () => {
			const res = await fetch("/v1/state");
			const st = await res.json();
			const r = st.raceState;
			if (!r || !r.raceId) return;
			const rid = encodeURIComponent(r.raceId);
			if (r.config && r.config.countdownSec > 1) {
				await fetch("/v1/race/sessions/" + rid + "/config", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						config: { ...r.config, countdownSec: 1, targetLaps: Math.min(r.config.targetLaps || 2, 2) },
						generate: false,
						applyToExisting: true
					})
				}).catch(() => {});
			}
			for (const rnd of (r.rounds || [])) {
				if ((rnd.countdownSec && rnd.countdownSec > 1) || (rnd.targetLaps && rnd.targetLaps > 2)) {
					await fetch("/v1/race/sessions/" + rid + "/bracket:edit", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							action: "update_round",
							roundId: rnd.id,
							countdownSec: 1,
							targetLaps: rnd.stageFormat === "open_qualifier" ? (rnd.targetLaps || 0) : 2
						})
					}).catch(() => {});
				}
			}
		}`)

		startBtn := page.Locator(`button[data-ctrl="start"]:not([disabled])`).First()
		if err := glideAndClickOS(mouse, startBtn, 480, 180*time.Millisecond, 260*time.Millisecond); err != nil {
			log.Fatalf("[build-tutorials] runHeatFast start: %v", err)
		}
		preemptBtn := page.Locator(`.slaprf-modal-backdrop button[data-preempt-ok]`).First()
		if err := preemptBtn.WaitFor(playwright.LocatorWaitForOptions{
			State:   playwright.WaitForSelectorStateVisible,
			Timeout: playwright.Float(450),
		}); err == nil {
			_ = glideAndClickOS(mouse, preemptBtn, 320, 120*time.Millisecond, 200*time.Millisecond)
		}

		waitMs := act.MinElapsedMS
		if waitMs <= 0 {
			waitMs = 2800
		}
		time.Sleep(time.Duration(waitMs) * time.Millisecond)

		// Wait until countdown has transitioned into running (stop visible) or finished (confirm visible)
		readyDeadline := time.Now().Add(7 * time.Second)
		for time.Now().Before(readyDeadline) {
			cVis, _ := page.Locator(`button[data-ctrl="confirm"]:not([disabled])`).First().IsVisible()
			sVis, _ := page.Locator(`button[data-ctrl="stop"]:not([disabled])`).First().IsVisible()
			if cVis || sVis {
				break
			}
			time.Sleep(150 * time.Millisecond)
		}
		// Give running lap-based heats up to 2.5s more to cross finish naturally before clicking stop
		finDeadline := time.Now().Add(2500 * time.Millisecond)
		for time.Now().Before(finDeadline) {
			if vis, _ := page.Locator(`button[data-ctrl="confirm"]:not([disabled])`).First().IsVisible(); vis {
				break
			}
			time.Sleep(180 * time.Millisecond)
		}
		stopLoc := page.Locator(`button[data-ctrl="stop"]:not([disabled])`).First()
		if vis, _ := stopLoc.IsVisible(); vis {
			_ = glideAndClickOS(mouse, stopLoc, 380, 140*time.Millisecond, 380*time.Millisecond)
		}
		if act.Confirm {
			confirmLoc := page.Locator(`button[data-ctrl="confirm"]:not([disabled])`).First()
			if err := glideAndClickOS(mouse, confirmLoc, 420, 180*time.Millisecond, 420*time.Millisecond); err != nil {
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

func muxNarratedMP4(rawVideoMP4 string, clips []beatClip, finalMP4 string) {
	args := []string{"-y", "-i", rawVideoMP4}
	for _, c := range clips {
		args = append(args, "-i", c.mp3Path)
	}

	var filterParts []string
	var mixInputs []string
	for i, c := range clips {
		inIdx := i + 1
		lbl := fmt.Sprintf("a%d", i)
		filterParts = append(filterParts, fmt.Sprintf("[%d:a]adelay=%d|%d[%s]", inIdx, c.offsetMs, c.offsetMs, lbl))
		mixInputs = append(mixInputs, fmt.Sprintf("[%s]", lbl))
	}
	filterParts = append(filterParts, fmt.Sprintf("%samix=inputs=%d:normalize=0:dropout_transition=0[aout]", strings.Join(mixInputs, ""), len(clips)))

	var vFilter string
	filterParts = append(filterParts, "[0:v]gradfun=strength=1.35:radius=16,noise=c0s=1:allf=t[vout]")
	vFilter = strings.Join(filterParts, ";")

	args = append(args,
		"-filter_complex", vFilter,
		"-map", "[vout]",
		"-map", "[aout]",
		"-c:v", "libx264",
		"-preset", "fast",
		"-crf", "17",
		"-x264-params", "aq-mode=3:aq-strength=1.2:deblock=-1,-1",
		"-pix_fmt", "yuv420p",
		"-r", "60",
		"-c:a", "aac",
		"-b:a", "192k",
		"-movflags", "+faststart",
		finalMP4,
	)

	cmd := exec.Command("ffmpeg", args...)
	if out, err := cmd.CombinedOutput(); err != nil {
		log.Fatalf("[build-tutorials] ffmpeg mux failed: %v\n%s", err, string(out))
	}
}

func connectCDPRetry(pw *playwright.Playwright, port int, timeout time.Duration) playwright.Browser {
	endpoint := fmt.Sprintf("http://127.0.0.1:%d", port)
	deadline := time.Now().Add(timeout)
	var lastErr error
	for time.Now().Before(deadline) {
		br, err := pw.Chromium.ConnectOverCDP(endpoint)
		if err == nil {
			return br
		}
		lastErr = err
		time.Sleep(180 * time.Millisecond)
	}
	log.Fatalf("[build-tutorials] ConnectOverCDP %s failed: %v", endpoint, lastErr)
	return nil
}

func cleanX11Env(disp string) []string {
	var out []string
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, "WAYLAND_DISPLAY=") || strings.HasPrefix(kv, "DISPLAY=") {
			continue
		}
		out = append(out, kv)
	}
	out = append(out,
		"DISPLAY="+disp,
		"XCURSOR_THEME=DMZ-White",
		"XCURSOR_SIZE=36",
	)
	return out
}

func pickFreeXDisplay() int {
	for d := 92; d < 140; d++ {
		lockFile := fmt.Sprintf("/tmp/.X%d-lock", d)
		sockFile := fmt.Sprintf("/tmp/.X11-unix/X%d", d)
		if _, err1 := os.Stat(lockFile); os.IsNotExist(err1) {
			if _, err2 := os.Stat(sockFile); os.IsNotExist(err2) {
				return d
			}
		}
	}
	return 99
}

func pickFreeTCPPort() int {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatalf("[build-tutorials] listen free port: %v", err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

func resolveChromeBin() string {
	for _, cand := range []string{"google-chrome", "google-chrome-stable", "chromium", "chromium-browser"} {
		if p, err := exec.LookPath(cand); err == nil {
			return p
		}
	}
	log.Fatalf("[build-tutorials] google-chrome or chromium not found in PATH")
	return ""
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
