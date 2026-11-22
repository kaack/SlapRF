// Command flash_stress drives repeated physical XIAO ESP32-C5 USB firmware flashes through
// the live SlapRF #/flasher web UI over Chrome DevTools Protocol (CDP), verifying that every
// run completes esptool write, 95% app reboot, 97% post-flash identity readback, and 100%
// completion without stalling.
//
// Usage:
//
//	go run ./firmware/tools/flash_stress -runs 10
//	go run ./firmware/tools/flash_stress -runs 5 -port ttyACM0 -role hub -link usb
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

type cdpTarget struct {
	ID                   string `json:"id"`
	Type                 string `json:"type"`
	Title                string `json:"title"`
	URL                  string `json:"url"`
	WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
}

type cdpClient struct {
	ws     *websocket.Conn
	nextID atomic.Int64
}

type cdpResponse struct {
	ID     int64           `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func findChromeBinary() (string, error) {
	candidates := []string{
		os.Getenv("CHROME_BIN"),
	}
	switch runtime.GOOS {
	case "linux":
		candidates = append(candidates,
			"/opt/google/chrome/chrome",
			"google-chrome",
			"google-chrome-stable",
			"chromium",
			"chromium-browser",
		)
	case "darwin":
		candidates = append(candidates,
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
		)
	case "windows":
		candidates = append(candidates,
			filepath.Join(os.Getenv("ProgramFiles"), `Google\Chrome\Application\chrome.exe`),
			filepath.Join(os.Getenv("ProgramFiles(x86)"), `Google\Chrome\Application\chrome.exe`),
			filepath.Join(os.Getenv("LOCALAPPDATA"), `Google\Chrome\Application\chrome.exe`),
		)
	}
	for _, c := range candidates {
		if c == "" {
			continue
		}
		if p, err := exec.LookPath(c); err == nil {
			return p, nil
		}
		if info, err := os.Stat(c); err == nil && !info.IsDir() {
			return c, nil
		}
	}
	if home, err := os.UserHomeDir(); err == nil {
		matches, _ := filepath.Glob(filepath.Join(home, ".cache", "ms-playwright", "chromium-*", "chrome-*", "chrome*"))
		for _, m := range matches {
			if info, err := os.Stat(m); err == nil && !info.IsDir() {
				return m, nil
			}
		}
	}
	return "", fmt.Errorf("could not locate Chrome or Chromium binary (set CHROME_BIN)")
}

func ensureChromeCDP(cdpBase, appURL string, headless bool) (cleanup func(), err error) {
	noop := func() {}
	if resp, err := http.Get(cdpBase + "/json/version"); err == nil {
		resp.Body.Close()
		return noop, nil
	}

	u, err := url.Parse(cdpBase)
	if err != nil {
		return noop, fmt.Errorf("parse -cdp URL %q: %w", cdpBase, err)
	}
	port := u.Port()
	if port == "" {
		port = "9222"
	}

	chromeBin, err := findChromeBinary()
	if err != nil {
		return noop, err
	}
	tmpProfile, err := os.MkdirTemp("", "slaprf-cdp-flash-stress-*")
	if err != nil {
		return noop, fmt.Errorf("create temp Chrome profile: %w", err)
	}

	flasherURL := strings.TrimRight(appURL, "/") + "/#/flasher"
	args := []string{
		"--user-data-dir=" + tmpProfile,
		"--remote-debugging-port=" + port,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-background-timer-throttling",
		"--disable-renderer-backgrounding",
	}
	if headless {
		args = append(args, "--headless=new")
	}
	args = append(args, flasherURL)

	log.Printf("[cdp] Launching %s on :%s -> %s", filepath.Base(chromeBin), port, flasherURL)
	cmd := exec.Command(chromeBin, args...)
	if err := cmd.Start(); err != nil {
		_ = os.RemoveAll(tmpProfile)
		return noop, fmt.Errorf("launch Chrome: %w", err)
	}

	cleanup = func() {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
			_, _ = cmd.Process.Wait()
		}
		_ = os.RemoveAll(tmpProfile)
	}

	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if resp, err := http.Get(cdpBase + "/json/list"); err == nil {
			resp.Body.Close()
			return cleanup, nil
		}
		time.Sleep(150 * time.Millisecond)
	}
	cleanup()
	return noop, fmt.Errorf("Chrome CDP did not become ready on %s within 10s", cdpBase)
}

func dialCDPPage(cdpBase, appURL string) (*cdpClient, error) {
	u, _ := url.Parse(appURL)
	hostMatch := "127.0.0.1:8090"
	if u != nil && u.Host != "" {
		hostMatch = u.Host
	}

	var chosen *cdpTarget
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get(cdpBase + "/json/list")
		if err != nil {
			time.Sleep(150 * time.Millisecond)
			continue
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()

		var targets []cdpTarget
		if err := json.Unmarshal(body, &targets); err == nil {
			for i := range targets {
				t := &targets[i]
				if t.Type == "page" && strings.Contains(t.URL, hostMatch) {
					chosen = t
					break
				}
			}
			if chosen == nil {
				for i := range targets {
					if targets[i].Type == "page" {
						chosen = &targets[i]
						break
					}
				}
			}
		}
		if chosen != nil && chosen.WebSocketDebuggerURL != "" {
			break
		}
		time.Sleep(150 * time.Millisecond)
	}
	if chosen == nil || chosen.WebSocketDebuggerURL == "" {
		return nil, fmt.Errorf("no page target found on %s", cdpBase)
	}

	ws, _, err := websocket.Dial(context.Background(), chosen.WebSocketDebuggerURL, nil)
	if err != nil {
		return nil, fmt.Errorf("dial %s: %w", chosen.WebSocketDebuggerURL, err)
	}
	ws.SetReadLimit(16 << 20)
	log.Printf("[cdp] Attached to Chrome tab %q (%s)", chosen.Title, chosen.URL)
	return &cdpClient{ws: ws}, nil
}

func (c *cdpClient) call(method string, params map[string]any) (json.RawMessage, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	id := c.nextID.Add(1)
	req := map[string]any{
		"id":     id,
		"method": method,
	}
	if params != nil {
		req["params"] = params
	}
	if err := wsjson.Write(ctx, c.ws, req); err != nil {
		return nil, err
	}
	for {
		_, raw, err := c.ws.Read(ctx)
		if err != nil {
			return nil, err
		}
		var msg cdpResponse
		if err := json.Unmarshal(raw, &msg); err != nil {
			continue
		}
		if msg.ID != id {
			continue
		}
		if msg.Error != nil {
			return nil, fmt.Errorf("cdp %s error %d: %s", method, msg.Error.Code, msg.Error.Message)
		}
		return msg.Result, nil
	}
}

func (c *cdpClient) evalJSON(expr string, out any) error {
	res, err := c.call("Runtime.evaluate", map[string]any{
		"expression":    expr,
		"awaitPromise":  true,
		"returnByValue": true,
	})
	if err != nil {
		return err
	}
	var wrap struct {
		Result struct {
			Type  string          `json:"type"`
			Value json.RawMessage `json:"value"`
		} `json:"result"`
		ExceptionDetails any `json:"exceptionDetails"`
	}
	if err := json.Unmarshal(res, &wrap); err != nil {
		return err
	}
	if wrap.ExceptionDetails != nil {
		b, _ := json.Marshal(wrap.ExceptionDetails)
		return fmt.Errorf("js exception: %s", string(b))
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(wrap.Result.Value, out)
}

type uiSnapshot struct {
	Hash       string `json:"hash"`
	HasFlasher bool   `json:"hasFlasher"`
	Step       string `json:"step"`
	Busy       bool   `json:"busy"`
	Done       bool   `json:"done"`
	PctText    string `json:"pctText"`
	StatusText string `json:"statusText"`
	ErrorText  string `json:"errorText"`
	ModalOpen  bool   `json:"modalOpen"`
	ConnectOk  bool   `json:"connectOk"`
	PortRow    string `json:"portRow"`
}

const snapshotJS = `(() => {
  const root = document.querySelector('[data-slot="flasher"]');
  const curStep = root?.querySelector('.flasher-step-pill.is-current')?.getAttribute('data-goto-step') || '';
  const busy = Boolean(root?.querySelector('[data-cancel-flash]'));
  const done = Boolean(root?.querySelector('[data-finish-wizard]'));
  const pctText = root?.querySelector('.flasher-progress-pct')?.textContent?.trim() || '';
  const statusText = root?.querySelector('.flasher-progress-status')?.textContent?.trim() || '';
  const errEl = root?.querySelector('.flasher-error, .alert-error, [data-flasher-error]');
  const errorText = errEl?.textContent?.trim() || '';
  const modal = document.querySelector('.sim-usb-dialog');
  const connectBtn = modal?.querySelector('button[data-modal="connect"]');
  const selectedRow = modal?.querySelector('.sim-usb-port-row.is-selected .sim-usb-port-label');
  return {
    hash: location.hash,
    hasFlasher: Boolean(root),
    step: curStep,
    busy,
    done,
    pctText,
    statusText,
    errorText,
    modalOpen: Boolean(modal),
    connectOk: Boolean(connectBtn && !connectBtn.hasAttribute('disabled') && !connectBtn.disabled),
    portRow: selectedRow?.textContent?.trim() || '',
  };
})()`

func main() {
	appURL := flag.String("app", "http://127.0.0.1:8090", "SlapRF Server base URL")
	cdpURL := flag.String("cdp", "http://127.0.0.1:9222", "Chrome DevTools HTTP base URL (auto-launches Chrome if not listening)")
	runs := flag.Int("runs", 10, "Number of consecutive physical flash iterations")
	role := flag.String("role", "hub", "Timer role to flash (hub or spoke)")
	link := flag.String("link", "usb", "Hub connection type (usb or ble)")
	portMatch := flag.String("port", "", "Optional port substring to select (e.g. ttyACM0, COM3, usbmodem)")
	timeoutSec := flag.Int("timeout", 45, "Timeout per flash iteration in seconds")
	headless := flag.Bool("headless", false, "Launch Chrome in headless mode when auto-starting Chrome")
	flag.Parse()

	if resp, err := http.Get(strings.TrimRight(*appURL, "/") + "/v1/status"); err != nil {
		log.Fatalf("SlapRF Server is not reachable at %s (%v) — start ./dist/slaprf-linux-amd64 or go run ./cmd/devserver first", *appURL, err)
	} else {
		resp.Body.Close()
	}

	cleanupChrome, err := ensureChromeCDP(*cdpURL, *appURL, *headless)
	if err != nil {
		log.Fatalf("Chrome CDP setup failed: %v", err)
	}
	defer cleanupChrome()

	client, err := dialCDPPage(*cdpURL, *appURL)
	if err != nil {
		log.Fatalf("attach CDP: %v", err)
	}
	defer client.ws.CloseNow()

	flasherTargetURL := strings.TrimRight(*appURL, "/") + "/#/flasher"
	if !strings.HasPrefix(client.ws.Subprotocol(), "") {
		// Navigate if tab wasn't opened directly on appURL.
	}
	_, _ = client.call("Page.navigate", map[string]any{"url": flasherTargetURL})
	time.Sleep(600 * time.Millisecond)

	// Clear any Service Worker & CacheStorage, ensure real hardware mode (sim off), and hard-reload #/flasher.
	var prepMsg string
	err = client.evalJSON(fmt.Sprintf(`(async () => {
	  window.localStorage.setItem("slaprf.ui.sim_mode.v1", "false");
	  window.localStorage.setItem("slaprf.flasher.hubLink", %q);
	  if (navigator.serviceWorker) {
	    for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
	  }
	  if (window.caches) {
	    for (const k of await caches.keys()) await caches.delete(k);
	  }
	  if (location.hash !== "#/flasher") location.hash = "#/flasher";
	  return "cleared";
	})()`, *link), &prepMsg)
	if err != nil {
		log.Fatalf("clear sw/cache: %v", err)
	}
	if _, err := client.call("Page.reload", map[string]any{"ignoreCache": true}); err != nil {
		log.Fatalf("Page.reload: %v", err)
	}
	time.Sleep(1500 * time.Millisecond)

	var snap uiSnapshot
	for attempt := 0; attempt < 30; attempt++ {
		if err := client.evalJSON(snapshotJS, &snap); err == nil && snap.HasFlasher {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if !snap.HasFlasher {
		log.Fatalf("FlasherView did not mount (hash=%q)", snap.Hash)
	}
	log.Printf("[cdp] FlasherView ready (hash=%s, role=%s, link=%s, runs=%d)", snap.Hash, *role, *link, *runs)

	type iterResult struct {
		Iter        int
		TotalMs     int64
		Reboot95Ms  int64
		Verify97Ms  int64
		VerifiedOK  bool
		StatusFinal string
	}
	results := make([]iterResult, 0, *runs)

	for i := 1; i <= *runs; i++ {
		log.Printf("=== [ITER %d/%d] Starting physical USB flash ===", i, *runs)

		var navStatus string
		err := client.evalJSON(fmt.Sprintf(`(async () => {
		  const root = document.querySelector('[data-slot="flasher"]');
		  if (!root) throw new Error("missing flasher root");
		  const finishBtn = root.querySelector('[data-finish-wizard]');
		  if (finishBtn) {
		    finishBtn.click();
		    await new Promise(r => setTimeout(r, 120));
		  }
		  const roleCard = root.querySelector('[data-pick-role=%q]');
		  if (roleCard) roleCard.click();
		  await new Promise(r => setTimeout(r, 80));
		  const next1 = root.querySelector('[data-wizard-next]');
		  if (next1) next1.click();
		  await new Promise(r => setTimeout(r, 80));
		  const linkBtn = root.querySelector('[data-hub-link=%q]');
		  if (linkBtn && !linkBtn.disabled) linkBtn.click();
		  await new Promise(r => setTimeout(r, 80));
		  const gotoFlash = root.querySelector('[data-goto-step="flash"]');
		  if (gotoFlash) gotoFlash.click();
		  await new Promise(r => setTimeout(r, 120));
		  const flashBtn = root.querySelector('[data-flash-usb]');
		  if (!flashBtn || flashBtn.disabled) {
		    throw new Error("flash button missing or disabled");
		  }
		  flashBtn.click();
		  return "clicked-flash";
		})()`, *role, *link), &navStatus)
		if err != nil {
			log.Fatalf("[ITER %d] wizard navigation failed: %v", i, err)
		}

		modalDeadline := time.Now().Add(10 * time.Second)
		pickedPort := ""
		for time.Now().Before(modalDeadline) {
			if err := client.evalJSON(snapshotJS, &snap); err != nil {
				log.Fatalf("[ITER %d] snapshot error waiting for modal: %v", i, err)
			}
			if snap.ModalOpen && snap.ConnectOk {
				var clickRes string
				if err := client.evalJSON(fmt.Sprintf(`(() => {
				  const modal = document.querySelector('.sim-usb-dialog');
				  const match = %q;
				  if (match) {
				    const row = Array.from(modal?.querySelectorAll('.sim-usb-port-row') || [])
				      .find(el => (el.getAttribute('data-pick-port-id') || '').includes(match) || (el.textContent || '').includes(match));
				    if (row) row.click();
				  }
				  const sel = modal?.querySelector('.sim-usb-port-row.is-selected .sim-usb-port-label')?.textContent?.trim() || '';
				  const btn = modal?.querySelector('button[data-modal="connect"]');
				  if (!btn || btn.disabled) return "";
				  btn.click();
				  return sel || "connected";
				})()`, *portMatch), &clickRes); err != nil {
					log.Fatalf("[ITER %d] click connect failed: %v", i, err)
				}
				if clickRes != "" {
					pickedPort = clickRes
					break
				}
			}
			time.Sleep(100 * time.Millisecond)
		}
		if pickedPort == "" {
			log.Fatalf("[ITER %d] timed out waiting for USB timer port in picker modal (last snap=%+v)", i, snap)
		}
		log.Printf("[ITER %d] Selected port: %s", i, pickedPort)

		startTime := time.Now()
		flashDeadline := startTime.Add(time.Duration(*timeoutSec) * time.Second)
		lastPct := ""
		var enter95At, leave95At time.Time
		var enter97At, leave97At time.Time
		sawBusy := false
		completed := false

		for time.Now().Before(flashDeadline) {
			if err := client.evalJSON(snapshotJS, &snap); err != nil {
				log.Fatalf("[ITER %d] poll eval failed: %v", i, err)
			}
			if snap.Busy {
				sawBusy = true
			}
			if snap.PctText != lastPct && snap.PctText != "" {
				now := time.Now()
				if lastPct == "95%" && enter95At != (time.Time{}) && leave95At == (time.Time{}) {
					leave95At = now
				}
				if lastPct == "97%" && enter97At != (time.Time{}) && leave97At == (time.Time{}) {
					leave97At = now
				}
				if snap.PctText == "95%" && enter95At == (time.Time{}) {
					enter95At = now
				}
				if snap.PctText == "97%" && enter97At == (time.Time{}) {
					enter97At = now
				}
				log.Printf("[ITER %d] +%5dms | %4s | %s", i, now.Sub(startTime).Milliseconds(), snap.PctText, snap.StatusText)
				lastPct = snap.PctText
			}

			if !snap.Busy && snap.Done && sawBusy {
				now := time.Now()
				if enter97At != (time.Time{}) && leave97At == (time.Time{}) {
					leave97At = now
				}
				totalMs := now.Sub(startTime).Milliseconds()
				var d95, d97 int64
				if enter95At != (time.Time{}) && leave95At != (time.Time{}) {
					d95 = leave95At.Sub(enter95At).Milliseconds()
				}
				if enter97At != (time.Time{}) && leave97At != (time.Time{}) {
					d97 = leave97At.Sub(enter97At).Milliseconds()
				}
				verifiedOK := strings.Contains(snap.StatusText, "Read back OK:")
				log.Printf("[ITER %d] DONE in %dms (95%%=%dms, 97%%=%dms, verified=%v) | %s",
					i, totalMs, d95, d97, verifiedOK, snap.StatusText)
				if !verifiedOK {
					log.Fatalf("[ITER %d] Flash reached 100%% WITHOUT post-flash readback verification: %s", i, snap.StatusText)
				}
				results = append(results, iterResult{
					Iter:        i,
					TotalMs:     totalMs,
					Reboot95Ms:  d95,
					Verify97Ms:  d97,
					VerifiedOK:  verifiedOK,
					StatusFinal: snap.StatusText,
				})
				completed = true
				break
			}

			if !snap.Busy && sawBusy && !snap.Done {
				log.Fatalf("[ITER %d] Flash aborted/errored before Done! pct=%s status=%q err=%q",
					i, snap.PctText, snap.StatusText, snap.ErrorText)
			}

			time.Sleep(100 * time.Millisecond)
		}

		if !completed {
			log.Fatalf("[ITER %d] STALLED / TIMED OUT after %ds at pct=%s status=%q!",
				i, *timeoutSec, snap.PctText, snap.StatusText)
		}

		time.Sleep(600 * time.Millisecond)
	}

	fmt.Println("\n================ STRESS TEST SUMMARY ================")
	var sumTotal, sum97, max97 int64
	for _, r := range results {
		sumTotal += r.TotalMs
		sum97 += r.Verify97Ms
		if r.Verify97Ms > max97 {
			max97 = r.Verify97Ms
		}
		fmt.Printf("Run %2d: total=%5dms | 95%%(reboot)=%4dms | 97%%(verify)=%4dms | verified=%v | %s\n",
			r.Iter, r.TotalMs, r.Reboot95Ms, r.Verify97Ms, r.VerifiedOK, r.StatusFinal)
	}
	n := int64(len(results))
	fmt.Printf("-----------------------------------------------------\n")
	fmt.Printf("Passed: %d/%d | Avg Total: %dms | Avg 97%% Verify: %dms | Max 97%% Verify: %dms\n",
		len(results), *runs, sumTotal/n, sum97/n, max97)
}
