//go:build !js

package api

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	"github.com/evanw/esbuild/pkg/api"
)

var (
	wasmCacheMu   sync.Mutex
	wasmExecCache []byte
	wasmBinCache  []byte
)

// BundleTypeScript compiles `src/main.ts` inside `webRootDir` into a single IIFE JS bundle.
func BundleTypeScript(webRootDir string) ([]byte, error) {
	absRoot, err := filepath.Abs(webRootDir)
	if err != nil {
		absRoot = webRootDir
	}
	if realRoot, err := filepath.EvalSymlinks(absRoot); err == nil {
		absRoot = realRoot
	}
	entryPoint := filepath.Join(absRoot, "src", "main.ts")
	result := api.Build(api.BuildOptions{
		AbsWorkingDir: absRoot,
		EntryPoints:   []string{entryPoint},
		Bundle:        true,
		Write:         false,
		Target:            api.ES2022,
		Format:            api.FormatIIFE,
		MinifyWhitespace:  true,
		MinifyIdentifiers: false,
		MinifySyntax:      true,
	})
	if len(result.Errors) > 0 {
		return nil, fmt.Errorf("%s", result.Errors[0].Text)
	}
	if len(result.OutputFiles) == 0 {
		return nil, fmt.Errorf("esbuild produced no output files")
	}
	return result.OutputFiles[0].Contents, nil
}

// handleTypeScriptBundle compiles `web/src/main.ts` and all imported TypeScript modules
// in memory using esbuild's native Go library (zero Node.js required).
func (s *Server) handleTypeScriptBundle(w http.ResponseWriter, _ *http.Request) {
	js, err := BundleTypeScript(s.webRootDir)
	if err != nil {
		log.Printf("[TS Bundler] Compilation error: %v", err)
		w.Header().Set("Content-Type", "application/javascript")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = fmt.Fprintf(w, "console.error(%q);", err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(js)
}

// handleWasmExecJS serves `wasm_exec.js` from `webRootDir/wasm/wasm_exec.js` if present
// (e.g. embedded in a release binary), or directly from the local Go toolchain's GOROOT.
func (s *Server) handleWasmExecJS(w http.ResponseWriter, _ *http.Request) {
	diskPath := filepath.Join(s.webRootDir, "wasm", "wasm_exec.js")
	if b, err := os.ReadFile(diskPath); err == nil && len(b) > 0 {
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(b)
		return
	}

	wasmCacheMu.Lock()
	cached := wasmExecCache
	wasmCacheMu.Unlock()

	if len(cached) == 0 {
		out, err := exec.Command("go", "env", "GOROOT").Output()
		if err != nil {
			http.Error(w, fmt.Sprintf("failed to locate GOROOT: %v", err), http.StatusInternalServerError)
			return
		}
		goroot := strings.TrimSpace(string(out))
		p := filepath.Join(goroot, "lib", "wasm", "wasm_exec.js")
		b, err := os.ReadFile(p)
		if err != nil {
			b, err = os.ReadFile(filepath.Join(goroot, "misc", "wasm", "wasm_exec.js"))
		}
		if err != nil {
			http.Error(w, fmt.Sprintf("failed to read wasm_exec.js: %v", err), http.StatusInternalServerError)
			return
		}
		wasmCacheMu.Lock()
		wasmExecCache = b
		cached = b
		wasmCacheMu.Unlock()
	}

	w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(cached)
}

// handleSlaprfWasm serves `slaprf.wasm` from `webRootDir/wasm/slaprf.wasm` if present
// on disk, or compiles `./cmd/slaprf-wasm` on the fly during `go run` development.
func (s *Server) handleSlaprfWasm(w http.ResponseWriter, _ *http.Request) {
	diskPath := filepath.Join(s.webRootDir, "wasm", "slaprf.wasm")
	if b, err := os.ReadFile(diskPath); err == nil && len(b) > 0 {
		w.Header().Set("Content-Type", "application/wasm")
		w.Header().Set("Content-Length", fmt.Sprintf("%d", len(b)))
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(b)
		return
	}

	wasmCacheMu.Lock()
	cached := wasmBinCache
	wasmCacheMu.Unlock()

	if len(cached) == 0 {
		tmpFile, err := os.CreateTemp("", "slaprf-*.wasm")
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		tmpPath := tmpFile.Name()
		_ = tmpFile.Close()
		defer os.Remove(tmpPath)

		repoRoot := filepath.Dir(s.webRootDir)
		cmd := exec.Command("go", "build", "-ldflags=-s -w", "-o", tmpPath, "./cmd/slaprf-wasm")
		cmd.Dir = repoRoot
		cmd.Env = append(os.Environ(), "GOOS=js", "GOARCH=wasm", "CGO_ENABLED=0")
		if out, err := cmd.CombinedOutput(); err != nil {
			log.Printf("[WASM Builder] Build error: %v (%s)", err, string(out))
			http.Error(w, fmt.Sprintf("wasm build failed: %v", err), http.StatusInternalServerError)
			return
		}
		b, err := os.ReadFile(tmpPath)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		wasmCacheMu.Lock()
		wasmBinCache = b
		cached = b
		wasmCacheMu.Unlock()
	}

	w.Header().Set("Content-Type", "application/wasm")
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(cached)))
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(cached)
}
