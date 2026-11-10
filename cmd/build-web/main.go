package main

import (
	"flag"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"slaprf/internal/devbundle"
	"slaprf/internal/firmware"
)

func main() {
	webDir := flag.String("web", "./web", "Source web directory")
	outDir := flag.String("out", "./_site", "Output static site directory for GitHub Pages")
	flag.Parse()

	log.SetFlags(log.LstdFlags)
	log.Printf("[build-web] Building static SPA + WASM simulator into %s...", *outDir)

	if err := os.RemoveAll(*outDir); err != nil {
		log.Fatalf("failed to clean %s: %v", *outDir, err)
	}
	for _, sub := range []string{"styles", "dist", "wasm", "firmware"} {
		if err := os.MkdirAll(filepath.Join(*outDir, sub), 0o755); err != nil {
			log.Fatalf("failed to create %s/%s: %v", *outDir, sub, err)
		}
	}

	// 0. The firmware image, so the browser WebSerial flasher can fetch & patch it without a
	// backend. Prefer the compiled ESP-IDF image (web/firmware/, built by CI or
	// firmware/tools/build_local.ps1 from firmware/slaprf); fall back to the placeholder image
	// when it hasn't been built.
	fwSrc := filepath.Join(*webDir, "firmware", firmware.ImageName)
	fwDst := filepath.Join(*outDir, "firmware", firmware.ImageName)
	if _, err := os.Stat(fwSrc); err == nil {
		mustCopyFile(fwSrc, fwDst)
		log.Printf("[build-web] Firmware: compiled %s", firmware.ImageName)
	} else {
		if err := os.WriteFile(fwDst, firmware.SyntheticBase(), 0o644); err != nil {
			log.Fatalf("failed to write %s: %v", fwDst, err)
		}
		log.Printf("[build-web] Firmware: %s not built, using the placeholder image", firmware.ImageName)
	}
	// 1. Copy index.html (and 404.html for GitHub Pages SPA fallback) and styles/*.css
	mustCopyFile(filepath.Join(*webDir, "index.html"), filepath.Join(*outDir, "index.html"))
	mustCopyFile(filepath.Join(*webDir, "index.html"), filepath.Join(*outDir, "404.html"))
	entries, err := os.ReadDir(filepath.Join(*webDir, "styles"))
	if err != nil {
		log.Fatalf("failed to read styles dir: %v", err)
	}
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".css") {
			mustCopyFile(filepath.Join(*webDir, "styles", e.Name()), filepath.Join(*outDir, "styles", e.Name()))
		}
	}

	// 2. Bundle TypeScript -> dist/app.js using pure-Go esbuild
	jsBytes, err := devbundle.BundleTypeScript(*webDir)
	if err != nil {
		log.Fatalf("TypeScript bundle failed: %v", err)
	}
	if err := os.WriteFile(filepath.Join(*outDir, "dist", "app.js"), jsBytes, 0o644); err != nil {
		log.Fatalf("failed to write dist/app.js: %v", err)
	}
	log.Printf("[build-web] Bundled dist/app.js (%d bytes)", len(jsBytes))

	// 3. Copy Go's wasm_exec.js -> wasm/wasm_exec.js
	gorootBytes, err := exec.Command("go", "env", "GOROOT").Output()
	if err != nil {
		log.Fatalf("failed to query GOROOT: %v", err)
	}
	goroot := strings.TrimSpace(string(gorootBytes))
	wasmExecSrc := filepath.Join(goroot, "lib", "wasm", "wasm_exec.js")
	if _, err := os.Stat(wasmExecSrc); err != nil {
		wasmExecSrc = filepath.Join(goroot, "misc", "wasm", "wasm_exec.js")
	}
	mustCopyFile(wasmExecSrc, filepath.Join(*outDir, "wasm", "wasm_exec.js"))

	// 4. Compile ./cmd/slaprf-wasm -> wasm/slaprf.wasm
	wasmOut := filepath.Join(*outDir, "wasm", "slaprf.wasm")
	cmd := exec.Command("go", "build", "-ldflags=-s -w", "-o", wasmOut, "./cmd/slaprf-wasm")
	cmd.Env = append(os.Environ(), "GOOS=js", "GOARCH=wasm", "CGO_ENABLED=0")
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		log.Fatalf("WASM build failed: %v", err)
	}
	info, _ := os.Stat(wasmOut)
	log.Printf("[build-web] Built wasm/slaprf.wasm (%d bytes)", info.Size())

	// 5. Also sync wasm/wasm_exec.js and wasm/slaprf.wasm into <webDir>/wasm/ so the web/ tree
	// has the latest compiled WASM engine on disk.
	webWasmDir := filepath.Join(*webDir, "wasm")
	if err := os.MkdirAll(webWasmDir, 0o755); err == nil {
		if filepath.Clean(webWasmDir) != filepath.Clean(filepath.Join(*outDir, "wasm")) {
			mustCopyFile(filepath.Join(*outDir, "wasm", "wasm_exec.js"), filepath.Join(webWasmDir, "wasm_exec.js"))
			mustCopyFile(wasmOut, filepath.Join(webWasmDir, "slaprf.wasm"))
		}
	}

	// 6. Write .nojekyll so GitHub Pages serves all files unaltered
	_ = os.WriteFile(filepath.Join(*outDir, ".nojekyll"), []byte{}, 0o644)
	_ = os.WriteFile(filepath.Join(*outDir, "CNAME"), []byte("slaprf.app\n"), 0o644)
	// 7. PWA: web app manifest + icons, then the service worker (last, so its content-hashed
	// precache manifest covers every file written above).
	mustCopyFile(filepath.Join(*webDir, "manifest.webmanifest"), filepath.Join(*outDir, "manifest.webmanifest"))
	if err := os.MkdirAll(filepath.Join(*outDir, "icons"), 0o755); err != nil {
		log.Fatalf("failed to create %s/icons: %v", *outDir, err)
	}
	iconEntries, err := os.ReadDir(filepath.Join(*webDir, "icons"))
	if err != nil {
		log.Fatalf("failed to read icons dir: %v", err)
	}
	for _, e := range iconEntries {
		if !e.IsDir() {
			mustCopyFile(filepath.Join(*webDir, "icons", e.Name()), filepath.Join(*outDir, "icons", e.Name()))
		}
	}
	swVersion, swCount, err := writeServiceWorker(*webDir, *outDir)
	if err != nil {
		log.Fatalf("service worker generation failed: %v", err)
	}
	log.Printf("[build-web] Generated sw.js (cache version %s, %d precached files)", swVersion, swCount)

	log.Printf("[build-web] Static site ready in %s", *outDir)
}

func mustCopyFile(src, dst string) {
	in, err := os.Open(src)
	if err != nil {
		log.Fatalf("open %s: %v", src, err)
	}
	defer in.Close()

	out, err := os.Create(dst)
	if err != nil {
		log.Fatalf("create %s: %v", dst, err)
	}
	defer out.Close()

	if _, err := io.Copy(out, in); err != nil {
		log.Fatalf("copy %s -> %s: %v", src, dst, err)
	}
}
