// Command devserver is a DEV-ONLY local web server for working on the SlapRF browser app.
// It is never shipped: the product is the static site at https://slaprf.app (built by
// cmd/build-web), where all timing logic runs in the browser (WASM engine + WebSerial Hub).
//
// It serves ./web with no caching and builds the generated assets on the fly:
//
//	/dist/app.js        TypeScript bundle of web/src (pure-Go esbuild, rebuilt on every request)
//	/wasm/wasm_exec.js  Go's JS runtime shim from the local toolchain
//	/wasm/slaprf.wasm   ./cmd/slaprf-wasm, rebuilt when Go sources change
//
// Usage: go run ./cmd/devserver [-addr 127.0.0.1:8090] [-web ./web] [-open]
package main

import (
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"slaprf/internal/devbundle"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:8090", "listen address")
	webDir := flag.String("web", "./web", "path to the web/ directory")
	openBrowser := flag.Bool("open", false, "open the app in the default browser")
	flag.Parse()

	absWeb, err := filepath.Abs(*webDir)
	if err != nil {
		log.Fatalf("bad -web: %v", err)
	}
	repoRoot := filepath.Dir(absWeb)

	mux := http.NewServeMux()
	mux.HandleFunc("/dist/app.js", func(w http.ResponseWriter, _ *http.Request) {
		js, err := devbundle.BundleTypeScript(absWeb)
		if err != nil {
			log.Printf("[devserver] TypeScript bundle error: %v", err)
			w.Header().Set("Content-Type", "application/javascript")
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = fmt.Fprintf(w, "console.error(%q);", err.Error())
			return
		}
		serveBytes(w, "application/javascript; charset=utf-8", js)
	})
	mux.HandleFunc("/wasm/wasm_exec.js", func(w http.ResponseWriter, _ *http.Request) {
		b, err := devbundle.WasmExecJS()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		serveBytes(w, "application/javascript; charset=utf-8", b)
	})
	mux.HandleFunc("/wasm/slaprf.wasm", func(w http.ResponseWriter, _ *http.Request) {
		b, err := devbundle.SlaprfWasm(repoRoot)
		if err != nil {
			log.Printf("[devserver] %v", err)
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		serveBytes(w, "application/wasm", b)
	})
	mux.HandleFunc("/__dev/events", func(w http.ResponseWriter, r *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming unsupported", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Connection", "keep-alive")

		lastCSS, lastTS := scanWebStamps(absWeb)
		_, _ = fmt.Fprintf(w, "data: {\"css\":%d,\"ts\":%d}\n\n", lastCSS, lastTS)
		flusher.Flush()

		ticker := time.NewTicker(250 * time.Millisecond)
		defer ticker.Stop()

		var lastErrTS int64
		for {
			select {
			case <-r.Context().Done():
				return
			case <-ticker.C:
				css, ts := scanWebStamps(absWeb)
				if css == lastCSS && ts == lastTS {
					continue
				}
				if ts != lastTS {
					if ts == lastErrTS {
						// Still on the same broken TS edit; wait for the next save.
						if css != lastCSS {
							lastCSS = css
							_, _ = fmt.Fprintf(w, "data: {\"css\":%d,\"ts\":%d}\n\n", lastCSS, lastTS)
							flusher.Flush()
						}
						continue
					}
					if _, err := devbundle.BundleTypeScript(absWeb); err != nil {
						lastErrTS = ts
						log.Printf("[devserver] HMR skipped (TypeScript error): %v", err)
						continue
					}
					lastTS = ts
				}
				lastCSS = css
				_, _ = fmt.Fprintf(w, "data: {\"css\":%d,\"ts\":%d}\n\n", lastCSS, lastTS)
				flusher.Flush()
			}
		}
	})
	files := http.FileServer(http.Dir(absWeb))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		files.ServeHTTP(w, r)
	})

	url := "http://" + *addr
	if strings.HasPrefix(*addr, ":") || strings.HasPrefix(*addr, "0.0.0.0:") {
		url = "http://localhost:" + (*addr)[strings.LastIndex(*addr, ":")+1:]
	}
	log.Printf("[devserver] DEV ONLY - serving %s at %s", absWeb, url)
	if *openBrowser {
		launchBrowser(url)
	}
	log.Fatal(http.ListenAndServe(*addr, mux))
}

func serveBytes(w http.ResponseWriter, contentType string, b []byte) {
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(b)))
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(b)
}

func scanWebStamps(absWeb string) (cssStamp int64, tsStamp int64) {
	_ = filepath.WalkDir(filepath.Join(absWeb, "styles"), func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if strings.HasSuffix(path, ".css") {
			if info, err := d.Info(); err == nil {
				if t := info.ModTime().UnixNano(); t > cssStamp {
					cssStamp = t
				}
			}
		}
		return nil
	})
	_ = filepath.WalkDir(filepath.Join(absWeb, "src"), func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if strings.HasSuffix(path, ".ts") {
			if info, err := d.Info(); err == nil {
				if t := info.ModTime().UnixNano(); t > tsStamp {
					tsStamp = t
				}
			}
		}
		return nil
	})
	return cssStamp, tsStamp
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
