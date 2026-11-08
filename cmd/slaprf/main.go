package main

import (
	"flag"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"

	"slaprf/internal/api"
	"slaprf/internal/ingest"
	"slaprf/internal/laprf"
	"slaprf/internal/tracker"
	webassets "slaprf/web"
)

func main() {
	httpAddr := flag.String("http", ":8090", "HTTP address for the TypeScript Sector & Telemetry SPA")
	laprfAddr := flag.String("laprf", ":5403", "TCP address for MultiGP LiveTime (ImmersionRC LapRF 8-Way protocol)")
	webDir := flag.String("web", "./web", "Path to the web SPA directory")
	openBrowser := flag.Bool("open", true, "Automatically open the web UI in the default browser on startup")
	flag.Parse()

	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	log.Println("=== SlapRF Multi-Gate Sector Timer & LiveTime Bridge ===")

	uiURL := browserURL(*httpAddr)

	// Bind the HTTP port first so double-clicking a second time just opens the browser tab.
	httpLn, err := net.Listen("tcp", *httpAddr)
	if err != nil {
		log.Printf("Port %s is already in use (another SlapRF instance is running).", *httpAddr)
		if *openBrowser {
			log.Printf("Opening %s in browser...", uiURL)
			launchBrowser(uiURL)
		}
		waitForEnterOnWindows()
		return
	}

	// 1. Initialize core multi-gate timing engine
	engine := tracker.NewEngine()

	// 2. Start MultiGP LiveTime (LapRF TCP :5403) server
	laprfSrv := laprf.NewServer(*laprfAddr, engine)
	if err := laprfSrv.Start(); err != nil {
		log.Printf("Warning: LapRF LiveTime TCP server on %s could not start: %v", *laprfAddr, err)
	} else {
		defer laprfSrv.Stop()
	}

	// 3. Start 8-pilot multi-gate 5.8 GHz track simulator (can be toggled off from UI)
	sim := ingest.NewTrackSimulator(engine)
	sim.Prewarm(45 * time.Second)
	sim.Start()
	defer sim.Stop()

	// 4. Start HTTP + SSE + pure-Go TypeScript compiler server
	resolvedWebDir, cleanupWeb, err := webassets.EnsureWebDir(*webDir)
	if err != nil {
		log.Fatalf("Failed to prepare web assets: %v", err)
	}
	defer cleanupWeb()

	httpSrv := api.NewServer(engine, sim, laprfSrv, resolvedWebDir)
	srv := &http.Server{
		Handler: httpSrv.Handler(),
	}

	go func() {
		log.Printf("[Web SPA] Dashboard running at %s (keep this window open while timing)", uiURL)
		if err := srv.Serve(httpLn); err != nil && err != http.ErrServerClosed {
			log.Fatalf("HTTP server error: %v", err)
		}
	}()

	if *openBrowser {
		launchBrowser(uiURL)
	}

	// Wait for termination signal
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	<-sigCh
	log.Println("Shutting down servers...")
}

func browserURL(addr string) string {
	if strings.HasPrefix(addr, ":") {
		return "http://localhost" + addr
	}
	if strings.HasPrefix(addr, "0.0.0.0:") {
		return "http://localhost:" + strings.TrimPrefix(addr, "0.0.0.0:")
	}
	return "http://" + addr
}

func launchBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	_ = cmd.Start()
}

func waitForEnterOnWindows() {
	if runtime.GOOS != "windows" {
		return
	}
	log.Println("Press Enter to close this window...")
	var b [1]byte
	_, _ = os.Stdin.Read(b[:])
}
