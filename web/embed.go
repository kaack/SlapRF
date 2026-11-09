package webassets

import (
	"embed"
	"io/fs"
	"os"
	"path/filepath"
)

// Assets embeds the entire web SPA (HTML, CSS, TypeScript sources, WASM simulation engine, and the
// compiled per-profile firmware images in firmware/, filled by CI) directly into the compiled Go
// binary so downloaded release executables run as a single file.
//
//go:embed index.html styles src wasm firmware
var Assets embed.FS

// EnsureWebDir returns webDir if index.html exists on disk (local development),
// or extracts the embedded web assets to a temporary directory for standalone release binaries.
func EnsureWebDir(webDir string) (string, func(), error) {
	if info, err := os.Stat(filepath.Join(webDir, "index.html")); err == nil && !info.IsDir() {
		return webDir, func() {}, nil
	}

	tmpDir, err := os.MkdirTemp("", "slaprf-web-*")
	if err != nil {
		return "", func() {}, err
	}
	if realTmp, err := filepath.EvalSymlinks(tmpDir); err == nil {
		tmpDir = realTmp
	}
	cleanup := func() {
		_ = os.RemoveAll(tmpDir)
	}

	err = fs.WalkDir(Assets, ".", func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		target := filepath.Join(tmpDir, filepath.FromSlash(path))
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		data, err := Assets.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, 0o644)
	})
	if err != nil {
		cleanup()
		return "", func() {}, err
	}

	return tmpDir, cleanup, nil
}
