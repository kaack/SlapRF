//go:build !js

// Package devbundle builds the browser app's generated assets on the host: the TypeScript
// bundle (`dist/app.js`, pure-Go esbuild, no Node.js), Go's `wasm_exec.js`, and the WASM
// timing engine (`slaprf.wasm`). It is used by `cmd/build-web` (static site for slaprf.app)
// and the dev-only `cmd/devserver`; it is never compiled into the shipped app.
package devbundle

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/evanw/esbuild/pkg/api"

	slaprfapi "slaprf/internal/api"
)

type aboutBuildPayload struct {
	FrontendVersion   string `json:"frontendVersion"`
	ReleaseTag        string `json:"releaseTag"`
	CommitHash        string `json:"commitHash"`
	BranchName        string `json:"branchName"`
	LicenseSummary    string `json:"licenseSummary"`
	LicenseFairSource string `json:"licenseFairSource"`
	LicenseGpl        string `json:"licenseGpl"`
}

func resolveGitOut(repoRoot string, args ...string) string {
	cmd := exec.Command("git", args...)
	cmd.Dir = repoRoot
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func buildAboutInfoJSON(webRootAbs string) string {
	repoRoot := filepath.Dir(webRootAbs)
	ver := slaprfapi.GetVersionInfo()

	if commit := resolveGitOut(repoRoot, "rev-parse", "HEAD"); len(commit) >= 7 {
		ver.CommitHash = commit
	}
	if branch := resolveGitOut(repoRoot, "rev-parse", "--abbrev-ref", "HEAD"); branch != "" && branch != "HEAD" {
		ver.BranchName = branch
	}
	if tag := resolveGitOut(repoRoot, "describe", "--tags", "--exact-match", "HEAD"); strings.HasPrefix(tag, "v") {
		ver.ReleaseTag = tag
	} else if ver.ReleaseTag == "" {
		ver.ReleaseTag = "(devel)"
	}

	// Keep internal/api/generated/version.json synced whenever bundling in a git workspace.
	genPath := filepath.Join(repoRoot, "internal", "api", "generated", "version.json")
	if b, err := json.MarshalIndent(ver, "", "  "); err == nil {
		_ = os.WriteFile(genPath, append(b, '\n'), 0o644)
	}

	readText := func(name string) string {
		b, err := os.ReadFile(filepath.Join(repoRoot, name))
		if err != nil {
			return ""
		}
		return strings.ReplaceAll(string(b), "\r\n", "\n")
	}

	payload := aboutBuildPayload{
		FrontendVersion:   "0.1.0",
		ReleaseTag:        ver.ReleaseTag,
		CommitHash:        ver.CommitHash,
		BranchName:        ver.BranchName,
		LicenseSummary:    strings.TrimSpace(readText("LICENSE")),
		LicenseFairSource: strings.TrimSpace(readText("LICENSE-FAIR-SOURCE")),
		LicenseGpl:        strings.TrimSpace(readText("LICENSE-GPL")),
	}
	b, err := json.Marshal(payload)
	if err != nil {
		return "{}"
	}
	return string(b)
}

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
		AbsWorkingDir:     absRoot,
		EntryPoints:       []string{entryPoint},
		Bundle:            true,
		Write:             false,
		Target:            api.ES2022,
		Format:            api.FormatIIFE,
		MinifyWhitespace:  true,
		MinifyIdentifiers: false,
		MinifySyntax:      true,
		Define: map[string]string{
			"__SLAPRF_ABOUT_INFO__": buildAboutInfoJSON(absRoot),
		},
	})
	if len(result.Errors) > 0 {
		return nil, fmt.Errorf("%s", result.Errors[0].Text)
	}
	if len(result.OutputFiles) == 0 {
		return nil, fmt.Errorf("esbuild produced no output files")
	}
	return result.OutputFiles[0].Contents, nil
}

var (
	wasmMu        sync.Mutex
	wasmExecCache []byte
	wasmBinCache  []byte
	wasmBinStamp  time.Time
)

// WasmExecJS returns `wasm_exec.js` from the local Go toolchain (GOROOT), so it always matches
// the compiler that builds `slaprf.wasm`.
func WasmExecJS() ([]byte, error) {
	wasmMu.Lock()
	defer wasmMu.Unlock()
	if len(wasmExecCache) > 0 {
		return wasmExecCache, nil
	}
	out, err := exec.Command("go", "env", "GOROOT").Output()
	if err != nil {
		return nil, fmt.Errorf("failed to locate GOROOT: %w", err)
	}
	goroot := strings.TrimSpace(string(out))
	b, err := os.ReadFile(filepath.Join(goroot, "lib", "wasm", "wasm_exec.js"))
	if err != nil {
		b, err = os.ReadFile(filepath.Join(goroot, "misc", "wasm", "wasm_exec.js"))
	}
	if err != nil {
		return nil, fmt.Errorf("failed to read wasm_exec.js: %w", err)
	}
	wasmExecCache = b
	return b, nil
}

// SlaprfWasm compiles `./cmd/slaprf-wasm` (GOOS=js GOARCH=wasm) from the module at repoRoot.
// The result is cached and rebuilt only when a Go source file under cmd/ or internal/ changes.
func SlaprfWasm(repoRoot string) ([]byte, error) {
	wasmMu.Lock()
	defer wasmMu.Unlock()

	stamp := newestGoSource(repoRoot)
	if len(wasmBinCache) > 0 && !stamp.After(wasmBinStamp) {
		return wasmBinCache, nil
	}

	tmpFile, err := os.CreateTemp("", "slaprf-*.wasm")
	if err != nil {
		return nil, err
	}
	tmpPath := tmpFile.Name()
	_ = tmpFile.Close()
	defer os.Remove(tmpPath)

	cmd := exec.Command("go", "build", "-ldflags=-s -w", "-o", tmpPath, "./cmd/slaprf-wasm")
	cmd.Dir = repoRoot
	cmd.Env = append(os.Environ(), "GOOS=js", "GOARCH=wasm", "CGO_ENABLED=0")
	if out, err := cmd.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("wasm build failed: %v\n%s", err, out)
	}
	b, err := os.ReadFile(tmpPath)
	if err != nil {
		return nil, err
	}
	wasmBinCache = b
	wasmBinStamp = stamp
	return b, nil
}

// newestGoSource returns the latest modification time of go.mod/go.sum and any .go file under
// cmd/ and internal/ (internal/api/generated/ is skipped: version.json is rewritten on every
// TypeScript bundle and must not force a WASM rebuild).
func newestGoSource(repoRoot string) time.Time {
	var newest time.Time
	consider := func(path string) {
		if info, err := os.Stat(path); err == nil && info.ModTime().After(newest) {
			newest = info.ModTime()
		}
	}
	consider(filepath.Join(repoRoot, "go.mod"))
	consider(filepath.Join(repoRoot, "go.sum"))
	skip := filepath.Join(repoRoot, "internal", "api", "generated")
	for _, dir := range []string{"cmd", "internal"} {
		_ = filepath.WalkDir(filepath.Join(repoRoot, dir), func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if d.IsDir() {
				if path == skip {
					return filepath.SkipDir
				}
				return nil
			}
			if strings.HasSuffix(path, ".go") {
				consider(path)
			}
			return nil
		})
	}
	return newest
}
