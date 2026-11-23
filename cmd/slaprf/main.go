// Command slaprf is the zero-install native Go SlapRF Server & Portable Desktop application.
//
// It runs the complete timing engine, physics simulator, single-file bbolt database (slaprf.db),
// native USB serial for SlapRF timers, LapRF 8-Way, RotorHazard, LapRF 8-Way :5403 emulator, and
// MultiGP cloud sync natively in Go, serving the embedded WASM-free UI and accepting connections
// from local or LAN browsers (including https://slaprf.app).
package main

import (
	"context"
	"embed"
	"errors"
	"flag"
	"fmt"
	"io/fs"
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

	"slaprf/internal/applog"
	"slaprf/internal/portable"
	"slaprf/internal/storage"
)

//go:embed all:site
var embeddedSite embed.FS

var version = "dev"

func main() {
	const defaultAddr = "127.0.0.1:8090"

	var pureBrowser bool
	addrFlag := flag.String("addr", defaultAddr, "HTTP listen address (e.g. 127.0.0.1:8090 or 0.0.0.0:8090)")
	lanFlag := flag.Bool("lan", false, "Listen on 0.0.0.0:8090 for LAN / Raspberry Pi trackside access (implies -no-browser)")
	flag.BoolVar(&pureBrowser, "browser", false, "Start in Pure Browser Mode (static SPA + WASM + IndexedDB only, like https://slaprf.app)")
	flag.BoolVar(&pureBrowser, "pure-browser", false, "Alias for -browser")
	flag.BoolVar(&pureBrowser, "browser-only", false, "Alias for -browser")
	dbFlag := flag.String("db", "", "Path to single-file bbolt database (default: slaprf.db next to executable)")
	logFlag := flag.String("log", "", "Path to rolling diagnostic log file (default: slaprf.log next to slaprf.db)")
	logLevelFlag := flag.String("log-level", "", "Diagnostic log level: trace, debug, info, warn, error (default: info)")
	allowOriginFlag := flag.String("allow-origin", "", "Comma-separated extra CORS origins allowed to connect")
	noBrowser := flag.Bool("no-browser", false, "Do not automatically open the browser on startup")
	noAuth := flag.Bool("no-auth", false, "Disable Basic authentication on startup (recovery mode if locked out)")
	mgpBase := flag.String("mgp-url", portable.DefaultMultiGPBaseURL, "Upstream MultiGP WebService base URL")
	showVersion := flag.Bool("version", false, "Print version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println("slaprf " + version)
		return
	}

	logger := log.New(os.Stdout, "", log.Ltime)

	siteFS, err := fs.Sub(embeddedSite, "site")
	if err != nil {
		logger.Fatalf("failed to load embedded site: %v", err)
	}

	addrExplicit := false
	lanExplicit := false
	noBrowserExplicit := false
	flag.Visit(func(f *flag.Flag) {
		switch f.Name {
		case "addr":
			addrExplicit = true
		case "lan":
			lanExplicit = true
		case "no-browser":
			noBrowserExplicit = true
		}
	})

	autoHeadlessLAN := !addrExplicit && !lanExplicit && isHeadlessLinux()
	useLAN := *lanFlag || autoHeadlessLAN

	listenAddr := *addrFlag
	if useLAN && !addrExplicit {
		listenAddr = "0.0.0.0:8090"
	}
	openBrowser := !*noBrowser
	if useLAN && !noBrowserExplicit {
		openBrowser = false
	}

	ln, err := net.Listen("tcp", listenAddr)
	if err != nil && !addrExplicit && !*lanFlag {
		if listenAddr == defaultAddr {
			// Fall back to 8091 (convenient when running Native Server + Pure Browser side-by-side), then any free port.
			ln, err = net.Listen("tcp", "127.0.0.1:8091")
			if err != nil {
				ln, err = net.Listen("tcp", "127.0.0.1:0")
			}
		} else if autoHeadlessLAN && listenAddr == "0.0.0.0:8090" {
			ln, err = net.Listen("tcp", "0.0.0.0:8091")
			if err != nil {
				ln, err = net.Listen("tcp", "0.0.0.0:0")
			}
		}
	}
	if err != nil {
		logger.Fatalf("cannot bind HTTP server on %s: %v", listenAddr, err)
	}

	boundAddr := ln.Addr().String()
	appURL := browserURLForAddr(boundAddr)

	var pSrv *portable.Server
	var handler http.Handler

	if pureBrowser {
		handler = portable.NewStaticBrowserHandler(siteFS)
		fmt.Printf("SlapRF Pure Browser Mode (%s) — Static Web Host (like https://slaprf.app)\n", version)
		fmt.Printf("  Web UI:      %s\n", appURL)
		fmt.Printf("  Engine:      In-browser WASM Demo Simulator (slaprf.wasm)\n")
		fmt.Printf("  Storage:     Browser IndexedDB (no slaprf.db opened)\n")
		fmt.Printf("  Backend:     Disabled (static files only — use \"Connect Server\" in UI to link a Go server)\n")
		fmt.Printf("  Press Ctrl+C to quit.\n\n")
		if _, wasmErr := fs.Stat(siteFS, "wasm/slaprf.wasm"); wasmErr != nil {
			logger.Printf("WARNING: embedded site/wasm/slaprf.wasm missing — rebuild with `go run ./cmd/build-portable`")
		}
	} else {
		dbPath := strings.TrimSpace(*dbFlag)
		if dbPath == "" {
			dbPath = storage.ResolveDefaultDBPath()
		}

		var extraOrigins []string
		if strings.TrimSpace(*allowOriginFlag) != "" {
			for _, part := range strings.Split(*allowOriginFlag, ",") {
				if clean := strings.TrimSpace(part); clean != "" {
					extraOrigins = append(extraOrigins, clean)
				}
			}
		}

		allowLAN := useLAN || strings.HasPrefix(boundAddr, "0.0.0.0:") || strings.HasPrefix(boundAddr, "[::]:")
		logPath := applog.ResolveDefaultLogPath(dbPath, *logFlag)
		appLogger := applog.New(applog.Options{
			FilePath: logPath,
			Console:  os.Stdout,
		})
		defer appLogger.Close()
		logger = appLogger.StdLogger()

		pSrv = portable.NewServer(portable.Config{
			Version:         version,
			StaticFS:        siteFS,
			DBPath:          dbPath,
			LogPath:         logPath,
			LogLevel:        *logLevelFlag,
			AppLog:          appLogger,
			AllowedOrigins:  extraOrigins,
			AllowLANOrigins: allowLAN,
			MultiGPBaseURL:  *mgpBase,
			DisableAuth:     *noAuth,
			Log:             logger,
		})
		handler = pSrv.Handler()

		fmt.Printf("SlapRF Server (%s) — Native Go Engine\n", version)
		fmt.Printf("  Web UI:      %s\n", appURL)
		if ips := portable.LanIPs(); len(ips) > 0 || allowLAN {
			if allowLAN {
				_, portStr, _ := net.SplitHostPort(boundAddr)
				lanURLs := formatLANURLs(localMDNSHostname(), ips, portStr)
				if len(lanURLs) > 0 {
					fmt.Printf("  LAN URLs:    %s\n", strings.Join(lanURLs, ", "))
				}
			} else {
				fmt.Printf("  LAN IPs:     %s (pass -lan to accept LAN browsers)\n", strings.Join(ips, ", "))
			}
		}
		fmt.Printf("  Database:    %s (bbolt)\n", pSrv.DBPath())
		if pSrv.LogPath() != "" {
			fmt.Printf("  Log file:    %s (level: %s; -log-level debug for detailed diagnostics)\n", pSrv.LogPath(), pSrv.AppLog().Level().String())
		}
		fmt.Printf("  Hardware:    Native Go USB (SlapRF timers), LapRF 8-Way, RotorHazard, LapRF Emulator :5403, MultiGP\n")
		if *noAuth {
			fmt.Printf("  Auth:        Disabled via -no-auth\n")
		}
		fmt.Printf("  Press Ctrl+C to quit.\n\n")
	}

	httpSrv := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	if _, statErr := fs.Stat(siteFS, "index.html"); statErr != nil {
		logger.Printf("WARNING: embedded site/index.html missing — build with `go run ./cmd/build-portable`")
	} else if openBrowser {
		launchBrowser(appURL)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	serveErr := make(chan error, 1)
	go func() {
		serveErr <- httpSrv.Serve(ln)
	}()

	select {
	case <-ctx.Done():
		logger.Printf("Shutting down SlapRF...")
		if pSrv != nil {
			pSrv.Close()
		}
		shutCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shutCtx)
	case sErr := <-serveErr:
		if pSrv != nil {
			pSrv.Close()
		}
		if sErr != nil && !errors.Is(sErr, http.ErrServerClosed) {
			logger.Fatalf("HTTP server stopped: %v", sErr)
		}
	}
}

func browserURLForAddr(bound string) string {
	host, port, err := net.SplitHostPort(bound)
	if err != nil {
		return "http://" + bound
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, port)
}

func isHeadlessLinux() bool {
	return isHeadlessLinuxEnv(runtime.GOOS, os.Getenv("DISPLAY"), os.Getenv("WAYLAND_DISPLAY"))
}

func isHeadlessLinuxEnv(goos, display, waylandDisplay string) bool {
	if goos != "linux" {
		return false
	}
	return strings.TrimSpace(display) == "" && strings.TrimSpace(waylandDisplay) == ""
}

func localMDNSHostname() string {
	h, err := os.Hostname()
	if err != nil {
		return ""
	}
	h = strings.TrimSpace(strings.TrimSuffix(h, ".local"))
	if h == "" || strings.EqualFold(h, "localhost") || strings.ContainsAny(h, ". \t") {
		return ""
	}
	return h + ".local"
}

func formatLANURLs(mdnsHost string, ips []string, portStr string) []string {
	var urls []string
	if mdnsHost != "" && portStr != "" {
		urls = append(urls, "http://"+net.JoinHostPort(mdnsHost, portStr))
	}
	for _, ip := range ips {
		urls = append(urls, "http://"+net.JoinHostPort(ip, portStr))
	}
	return urls
}

func launchBrowser(targetURL string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", targetURL)
	case "darwin":
		cmd = exec.Command("open", targetURL)
	default:
		cmd = exec.Command("xdg-open", targetURL)
	}
	_ = cmd.Start()
}
