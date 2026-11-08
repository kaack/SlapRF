package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"fpv-gate-timer/internal/api"
	"fpv-gate-timer/internal/ingest"
	"fpv-gate-timer/internal/laprf"
	"fpv-gate-timer/internal/tracker"
	webassets "fpv-gate-timer/web"
)

func main() {
	httpAddr := flag.String("http", ":8090", "HTTP address for the TypeScript Sector & Telemetry SPA")
	laprfAddr := flag.String("laprf", ":5403", "TCP address for MultiGP LiveTime (ImmersionRC LapRF 8-Way protocol)")
	webDir := flag.String("web", "./web", "Path to the web SPA directory")
	flag.Parse()

	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	log.Println("=== FPV XIAO ESP32-C5 Multi-Gate Sector Timer & LiveTime Bridge ===")

	// 1. Initialize core multi-gate timing engine
	engine := tracker.NewEngine()

	// 2. Start MultiGP LiveTime (LapRF TCP :5403) server
	laprfSrv := laprf.NewServer(*laprfAddr, engine)
	if err := laprfSrv.Start(); err != nil {
		log.Fatalf("Failed to start LapRF LiveTime TCP server on %s: %v", *laprfAddr, err)
	}
	defer laprfSrv.Stop()

	// 3. Start 8-pilot multi-gate 5.8 GHz track simulator (can be toggled off from UI when USB dongle is active)
	sim := ingest.NewTrackSimulator(engine)
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
		Addr:    *httpAddr,
		Handler: httpSrv.Handler(),
	}

	go func() {
		log.Printf("[Web SPA] Dashboard running at http://localhost%s", *httpAddr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("HTTP server error: %v", err)
		}
	}()

	// Wait for termination signal
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	<-sigCh
	log.Println("Shutting down servers...")
}
