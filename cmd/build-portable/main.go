// Command build-portable builds the WASM-free static web UI into cmd/slaprf/site and
// compiles the single-file native Go SlapRF Server executable (./cmd/slaprf).
package main

import (
	"flag"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

func main() {
	defaultOut := "slaprf"
	if runtime.GOOS == "windows" {
		defaultOut = "slaprf.exe"
	}

	outBin := flag.String("out", defaultOut, "Output path for compiled SlapRF Portable binary")
	ver := flag.String("version", "dev", "Version string embedded into the binary")
	goos := flag.String("goos", runtime.GOOS, "Target GOOS for binary compilation")
	goarch := flag.String("goarch", runtime.GOARCH, "Target GOARCH for binary compilation")
	skipWeb := flag.Bool("skip-web", false, "Skip rebuilding cmd/slaprf/site if already built")
	skipWasm := flag.Bool("skip-wasm", false, "Omit wasm/slaprf.wasm (disables -browser pure-browser test mode)")
	flag.Parse()

	log.SetFlags(log.LstdFlags)

	siteDir := filepath.Join("cmd", "slaprf", "site")
	keepPath := filepath.Join(siteDir, ".keep")

	if !*skipWeb {
		keepBytes, _ := os.ReadFile(keepPath)
		if len(keepBytes) == 0 {
			keepBytes = []byte("# Placeholder so //go:embed all:site in cmd/slaprf compiles on a clean checkout before cmd/build-portable runs.\n")
		}

		webArgs := []string{"run", "./cmd/build-web", "-web", "./web", "-out", siteDir}
		if *skipWasm {
			webArgs = append(webArgs, "-skip-wasm")
		}
		webCmd := exec.Command("go", webArgs...)
		webCmd.Stdout = os.Stdout
		webCmd.Stderr = os.Stderr
		if err := webCmd.Run(); err != nil {
			log.Fatalf("[build-portable] build-web failed: %v", err)
		}
		if *skipWasm {
			_ = os.RemoveAll(filepath.Join(siteDir, "wasm"))
		}
		// Restore tracked .keep so git status stays clean
		_ = os.WriteFile(keepPath, keepBytes, 0o644)
	}

	if dir := filepath.Dir(*outBin); dir != "." && dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			log.Fatalf("[build-portable] mkdir %s: %v", dir, err)
		}
	}

	log.Printf("[build-portable] Compiling %s (%s/%s, version=%s)...", *outBin, *goos, *goarch, *ver)
	ldflags := "-s -w -X main.version=" + *ver
	buildCmd := exec.Command("go", "build", "-trimpath", "-ldflags", ldflags, "-o", *outBin, "./cmd/slaprf")
	buildCmd.Env = append(os.Environ(), "CGO_ENABLED=0", "GOOS="+*goos, "GOARCH="+*goarch)
	buildCmd.Stdout = os.Stdout
	buildCmd.Stderr = os.Stderr
	if err := buildCmd.Run(); err != nil {
		log.Fatalf("[build-portable] go build ./cmd/slaprf failed: %v", err)
	}

	if info, err := os.Stat(*outBin); err == nil {
		log.Printf("[build-portable] Built %s (%.2f MB)", *outBin, float64(info.Size())/(1024*1024))
	}
}
