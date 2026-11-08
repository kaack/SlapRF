package main

import (
	"flag"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"slaprf/internal/api"
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
	for _, sub := range []string{"styles", "dist", "wasm"} {
		if err := os.MkdirAll(filepath.Join(*outDir, sub), 0o755); err != nil {
			log.Fatalf("failed to create %s/%s: %v", *outDir, sub, err)
		}
	}

	// 1. Copy index.html and styles/*.css
	mustCopyFile(filepath.Join(*webDir, "index.html"), filepath.Join(*outDir, "index.html"))
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
	jsBytes, err := api.BundleTypeScript(*webDir)
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

	// 5. Also sync wasm/wasm_exec.js and wasm/slaprf.wasm into <webDir>/wasm/ so `//go:embed wasm`
	// and local `go run ./cmd/slaprf` have the latest compiled WASM simulation engine on disk.
	webWasmDir := filepath.Join(*webDir, "wasm")
	if err := os.MkdirAll(webWasmDir, 0o755); err == nil {
		if filepath.Clean(webWasmDir) != filepath.Clean(filepath.Join(*outDir, "wasm")) {
			mustCopyFile(filepath.Join(*outDir, "wasm", "wasm_exec.js"), filepath.Join(webWasmDir, "wasm_exec.js"))
			mustCopyFile(wasmOut, filepath.Join(webWasmDir, "slaprf.wasm"))
		}
	}

	// 6. Write .nojekyll so GitHub Pages serves all files unaltered
	_ = os.WriteFile(filepath.Join(*outDir, ".nojekyll"), []byte{}, 0o644)
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
