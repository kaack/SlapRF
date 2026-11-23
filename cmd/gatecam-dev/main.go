// Command gatecam-dev runs the SlapRF GateCam web UI + Go verification backend locally on
// desktop (`127.0.0.1:18095`) using `SimCameraProvider`, compiling TypeScript on the fly.
package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"

	"slaprf/internal/applog"
	"slaprf/internal/gatecam"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:18095", "HTTP listen address")
	slaprfURL := flag.String("slaprf", "http://127.0.0.1:8090", "Target SlapRF server URL")
	webDir := flag.String("web", "./tools/gatecam/web", "Path to GateCam web directory")
	flag.Parse()

	absWeb, err := filepath.Abs(*webDir)
	if err != nil {
		log.Fatalf("invalid -web: %v", err)
	}

	appLogger := applog.New(applog.Options{Console: os.Stdout, Level: applog.LevelInfo, HasLevel: true})
	srv := gatecam.NewServer(gatecam.Config{
		Version:     "dev",
		DefaultLink: *slaprfURL,
		Camera:      gatecam.NewSimCameraProvider(),
		AppLog:      appLogger,
	})
	defer srv.Close()

	mux := http.NewServeMux()
	srv.RegisterAPIRoutes(mux)
	mux.HandleFunc("/dist/app.js", func(w http.ResponseWriter, _ *http.Request) {
		js, bErr := gatecam.BundleWebSPA(absWeb, false)
		if bErr != nil {
			http.Error(w, bErr.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(js)
	})
	mux.HandleFunc("/styles.css", func(w http.ResponseWriter, _ *http.Request) {
		b, _ := os.ReadFile(filepath.Join(absWeb, "styles.css"))
		w.Header().Set("Content-Type", "text/css; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(b)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		b, _ := os.ReadFile(filepath.Join(absWeb, "index.html"))
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(b)
	})

	fmt.Printf("SlapRF GateCam Dev Server listening on http://%s (SlapRF target: %s)\n", *addr, *slaprfURL)
	log.Fatal(http.ListenAndServe(*addr, mux))
}
