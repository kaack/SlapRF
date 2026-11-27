package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFinalizePreviewBundleIsolatesAssetNames(t *testing.T) {
	dir := t.TempDir()
	for _, sub := range []string{"styles", "dist", "wasm"} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	mustWrite := func(rel, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, rel), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	index := `<!DOCTYPE html><html><head><title>SlapRF</title><link rel="manifest" href="./manifest.webmanifest" /><link rel="stylesheet" href="./styles/views.css?v=513" /></head><body><div class="slaprf-boot-title">SlapRF</div><script src="./dist/app.js?v=562"></script></body></html>`
	mustWrite("index.html", index)
	mustWrite("404.html", index)
	mustWrite("manifest.webmanifest", `{}`)
	mustWrite("styles/views.css", `body { color: #fff; }`)
	mustWrite("dist/app.js", `console.log("preview");`)
	mustWrite("wasm/wasm_exec.js", `window.Go = function(){};`)
	mustWrite("wasm/slaprf.wasm", `wasmbytes`)

	rev, err := finalizePreviewBundle(dir)
	if err != nil {
		t.Fatalf("finalizePreviewBundle: %v", err)
	}
	if len(rev) != 12 {
		t.Fatalf("expected 12-char rev, got %q", rev)
	}

	for _, mustExist := range []string{
		"styles/views.preview.css",
		"dist/app.preview.js",
		"wasm/wasm_exec.preview.js",
		"wasm/slaprf.preview.wasm",
		"manifest.preview.webmanifest",
	} {
		if _, err := os.Stat(filepath.Join(dir, mustExist)); err != nil {
			t.Errorf("expected %s to exist: %v", mustExist, err)
		}
	}
	for _, mustNotExist := range []string{
		"styles/views.css",
		"dist/app.js",
		"wasm/wasm_exec.js",
		"wasm/slaprf.wasm",
		"manifest.webmanifest",
	} {
		if _, err := os.Stat(filepath.Join(dir, mustNotExist)); !os.IsNotExist(err) {
			t.Errorf("expected %s to be renamed away", mustNotExist)
		}
	}

	gotIndexBytes, err := os.ReadFile(filepath.Join(dir, "index.html"))
	if err != nil {
		t.Fatal(err)
	}
	gotIndex := string(gotIndexBytes)
	for _, want := range []string{
		"<title>SlapRF (Preview)</title>",
		"SlapRF · Preview",
		`href="./manifest.preview.webmanifest?v=` + rev + `"`,
		`href="./styles/views.preview.css?v=` + rev + `"`,
		`window.__SLAPRF_PREVIEW_REV__="` + rev + `"`,
		`src="./dist/app.preview.js?v=` + rev + `"`,
	} {
		if !strings.Contains(gotIndex, want) {
			t.Errorf("rewritten index.html missing %q:\n%s", want, gotIndex)
		}
	}
}
