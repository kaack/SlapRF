//go:build e2e

package e2e_test

import (
	"net"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/playwright-community/playwright-go"

	"slaprf/internal/domain"
	"slaprf/internal/rotorhazard"
)

func TestRotorHazardSimulatedMultiDeviceAndBrowserRealWebSocketHandshake(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/setup")

	// 1. Switch Timing system to RotorHazard on #/setup and verify Flasher nav is hidden.
	h.SelectCustomOption(`select[name="timing-hardware-mode"]`, "RotorHazard (Network)")
	tdSec := h.Page.Locator(`[data-section-anchor="timing-devices"]`).First()
	h.MustBeVisible(tdSec.Locator(`text=Simulating RotorHazard network timing devices`).First(), "RotorHazard sim description")

	flasherNav := h.Page.Locator(`aside a[data-route="flasher"]`).First()
	h.MustBeHidden(flasherNav, "Flasher sidebar link while RotorHazard is selected")

	// 2. Open Simulation page (#/sim) and verify RH1 (Linked) + RH2 (LAN) in Simulated RotorHazard devices.
	h.NavigateSidebar("sim")
	boardsTitle := h.Page.Locator(`[data-slot="boards-title"]`).First()
	h.WaitUntil("boards section switches to Simulated RotorHazard devices", 5*time.Second, func() (bool, error) {
		txt, err := boardsTitle.InnerText()
		return err == nil && strings.TrimSpace(txt) == "Simulated RotorHazard devices", nil
	})

	timersTable := h.Page.Locator(`[data-slot="timers-table"]`).First()
	h.MustBeVisible(timersTable.Locator(`strong.mono`, playwright.LocatorLocatorOptions{HasText: "R1"}).First(), "RotorHazard device R1")
	h.MustBeVisible(timersTable.Locator(`strong.mono`, playwright.LocatorLocatorOptions{HasText: "R2"}).First(), "RotorHazard device R2")

	// Connect R2 on #/sim so both R1 and R2 are linked.
	connBtn2 := timersTable.Locator(`button[data-action="rh-connect"]`).Nth(1)
	if err := connBtn2.Click(); err != nil {
		t.Fatalf("click Plug in on R2: %v", err)
	}
	h.WaitUntil("R2 button switches to Unplug", 5*time.Second, func() (bool, error) {
		txt, err := connBtn2.InnerText()
		return err == nil && strings.TrimSpace(txt) == "Unplug", nil
	})

	// 3. Open Network page (#/network) and verify both R1 and R2 show Auth OK, 8 nodes, and 0–255 RSSI bars.
	h.NavigateSidebar("network")
	rhSec := h.Page.Locator(`[data-slot="rh-sections"]`).First()
	h.MustBeVisible(rhSec, "RotorHazard Network section")
	h.WaitUntil("NetworkView shows both R1 and R2 with Auth OK", 5*time.Second, func() (bool, error) {
		txt, err := rhSec.InnerText()
		if err != nil {
			return false, nil
		}
		return strings.Contains(txt, "R1") && strings.Contains(txt, "R2") && strings.Contains(txt, "Auth OK"), nil
	})
	h.MilestoneScreenshot("rotorhazard-sim-network-rh1-rh2")

	// 4. Spin up a real Engine.IO v4 / Socket.IO v4 RotorHazard HTTP+WebSocket server on 127.0.0.1,
	//    toggle Simulation OFF, and verify the browser connects directly via HTTP-polling Basic Auth -> WebSocket upgrade!
	rhSrv := rotorhazard.NewSimServer(rotorhazard.SimServerConfig{
		Hostname:      "rh-gate-real",
		ReleaseVer:    "4.5.0-test",
		NodeCount:     8,
		AdminUsername: "admin",
		AdminPassword: "secret-rh-pass",
	})
	httpSrv := httptest.NewServer(rhSrv.HTTPHandler())
	defer httpSrv.Close()

	parsedURL, err := url.Parse(httpSrv.URL)
	if err != nil {
		t.Fatalf("parse httpSrv.URL: %v", err)
	}
	host, port, err := net.SplitHostPort(parsedURL.Host)
	if err != nil {
		t.Fatalf("split host:port: %v", err)
	}

	// Toggle Simulation OFF via TopBar button, select RotorHazard in the real dataset on #/setup, then open #/network!
	simTopBtn := h.Page.Locator(`button[data-action="sim"]`).First()
	if err := simTopBtn.Click(); err != nil {
		t.Fatalf("toggle Simulation OFF: %v", err)
	}
	h.WaitUntil("TopBar shows Simulation off", 5*time.Second, func() (bool, error) {
		txt, err := simTopBtn.InnerText()
		return err == nil && strings.Contains(txt, "Simulation off"), nil
	})
	h.NavigateSidebar("setup")
	h.SelectCustomOption(`select[name="timing-hardware-mode"]`, "RotorHazard (Network)")
	h.NavigateSidebar("network")
	h.MustBeVisible(rhSec, "RotorHazard Network section in real hardware mode")

	// Fill real RotorHazard server host and port in NetworkView, open per-device credentials prompt, and sign in!
	if err := rhSec.Locator(`input[data-field="rh-host"]`).Fill(host); err != nil {
		t.Fatalf("fill rh-host: %v", err)
	}
	if err := rhSec.Locator(`input[data-field="rh-port"]`).Fill(port); err != nil {
		t.Fatalf("fill rh-port: %v", err)
	}
	if err := rhSec.Locator(`button[data-action="rh-open-manual-creds"]`).Click(); err != nil {
		t.Fatalf("click Connect… to open per-device credentials prompt: %v", err)
	}
	h.MustBeVisible(rhSec.Locator(`[data-rh-creds-prompt="1"]`).First(), "Per-device RotorHazard credentials prompt")
	if err := rhSec.Locator(`input[data-field="rh-cred-user"]`).Fill("admin"); err != nil {
		t.Fatalf("fill rh-cred-user: %v", err)
	}
	if err := rhSec.Locator(`input[data-field="rh-cred-pass"]`).Fill("secret-rh-pass"); err != nil {
		t.Fatalf("fill rh-cred-pass: %v", err)
	}
	if err := rhSec.Locator(`button[data-action="rh-cred-submit"]`).Click(); err != nil {
		t.Fatalf("click Sign in & Connect to real RotorHazard server: %v", err)
	}

	// Verify browser completes Engine.IO v4 HTTP-polling Basic Auth -> WebSocket upgrade, reports Auth OK & v4.5.0-test,
	// and syncs Pilot RF frequencies & Enter/Exit thresholds into the RotorHazard server!
	h.WaitUntil("browser connects over WebSocket to real RotorHazard server with Auth OK", 8*time.Second, func() (bool, error) {
		txt, err := rhSec.InnerText()
		if err != nil {
			return false, nil
		}
		return strings.Contains(txt, "Auth OK") && strings.Contains(txt, "v4.5.0-test") && strings.Contains(txt, "8 nodes"), nil
	})

	// Wait for SlapRF WASM engine to arm the RotorHazard server (`stage_ready` -> RaceStatus == 1) and sync Node 0's frequency!
	h.WaitUntil("SlapRF syncs Pilot 1 frequency and arms RotorHazard server", 5*time.Second, func() (bool, error) {
		nodes, _ := rhSrv.NodeSnapshot()
		return rhSrv.RaceStatus() == rotorhazard.RHRaceStatusRacing && len(nodes) > 0 && nodes[0].FrequencyMHz > 0, nil
	})

	// Drive a physical RSSI spike across Node 0 on the RotorHazard server: Clear (30) -> Crossing (178) -> Clear (28)!
	nowMs := float64(time.Now().UnixMilli())
	var rssiLow, rssiPeak [domain.MaxPilotSlots]float32
	rssiLow[0] = 30
	rssiPeak[0] = 178
	rhSrv.StepRSSI(nowMs, rssiLow, true)
	rhSrv.StepRSSI(nowMs+60, rssiPeak, true)

	h.WaitUntil("NetworkView displays live 178 · CROSSING on Node 1 over WebSocket", 5*time.Second, func() (bool, error) {
		valTxt, err1 := rhSec.Locator(`[data-rh-bar-val="0"]`).First().InnerText()
		crossTxt, err2 := rhSec.Locator(`[data-rh-bar-cross="0"]`).First().InnerText()
		return err1 == nil && err2 == nil && strings.Contains(valTxt, "178") && strings.Contains(crossTxt, "CROSSING"), nil
	})

	rhSrv.StepRSSI(nowMs+150, rssiLow, true)
	h.WaitUntil("SlapRF WASM engine receives pass_record_msg and returns Socket.IO ack", 5*time.Second, func() (bool, error) {
		return rhSrv.AckedPasses() >= 1, nil
	})
	h.MilestoneScreenshot("rotorhazard-real-websocket-connected")
}
