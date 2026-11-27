package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

var (
	previewStyleHrefRe = regexp.MustCompile(`href="\./styles/([A-Za-z0-9_-]+)\.css(?:\?[^"]*)?"`)
	previewAppSrcRe    = regexp.MustCompile(`<script src="\./dist/app\.js(?:\?[^"]*)?"></script>`)
)

// finalizePreviewBundle renames CSS, JS, WASM, and manifest assets inside outDir to `.preview.*`
// filenames and stamps a content-derived revision into index.html / 404.html.
//
// Why `.preview.*` filenames:
// An older root Service Worker (`https://slaprf.app/sw.js` with `scope: "/"`) matches precached
// assets by path suffix (`keyBySuffix`), so `/preview/dist/app.js` would otherwise hit the root
// worker's cached `/dist/app.js`. Giving `/preview/` distinct `.preview.*` asset filenames ensures
// zero suffix overlap with any deployed root service worker while busting CDN caches on redeploy.
func finalizePreviewBundle(outDir string) (string, error) {
	h := sha256.New()

	// 1. Hash and rename styles/*.css -> styles/*.preview.css
	stylesDir := filepath.Join(outDir, "styles")
	styleEntries, err := os.ReadDir(stylesDir)
	if err != nil {
		return "", fmt.Errorf("read styles dir: %w", err)
	}
	var styleNames []string
	for _, e := range styleEntries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".css") && !strings.HasSuffix(e.Name(), ".preview.css") {
			styleNames = append(styleNames, e.Name())
		}
	}
	sort.Strings(styleNames)
	for _, name := range styleNames {
		oldPath := filepath.Join(stylesDir, name)
		b, err := os.ReadFile(oldPath)
		if err != nil {
			return "", err
		}
		_, _ = h.Write([]byte("style:" + name + "\x00"))
		_, _ = h.Write(b)
		newName := strings.TrimSuffix(name, ".css") + ".preview.css"
		if err := os.Rename(oldPath, filepath.Join(stylesDir, newName)); err != nil {
			return "", err
		}
	}

	// 2. Hash and rename dist/app.js -> dist/app.preview.js
	appOld := filepath.Join(outDir, "dist", "app.js")
	appBytes, err := os.ReadFile(appOld)
	if err != nil {
		return "", fmt.Errorf("read dist/app.js: %w", err)
	}
	_, _ = h.Write([]byte("dist:app.js\x00"))
	_, _ = h.Write(appBytes)
	if err := os.Rename(appOld, filepath.Join(outDir, "dist", "app.preview.js")); err != nil {
		return "", err
	}

	// 3. Hash and rename wasm/wasm_exec.js & wasm/slaprf.wasm when present
	for _, pair := range [][2]string{
		{"wasm_exec.js", "wasm_exec.preview.js"},
		{"slaprf.wasm", "slaprf.preview.wasm"},
	} {
		oldWasm := filepath.Join(outDir, "wasm", pair[0])
		if b, err := os.ReadFile(oldWasm); err == nil {
			_, _ = h.Write([]byte("wasm:" + pair[0] + "\x00"))
			_, _ = h.Write(b)
			if err := os.Rename(oldWasm, filepath.Join(outDir, "wasm", pair[1])); err != nil {
				return "", err
			}
		}
	}

	// 4. Rename manifest.webmanifest -> manifest.preview.webmanifest
	manifestOld := filepath.Join(outDir, "manifest.webmanifest")
	if _, err := os.Stat(manifestOld); err == nil {
		if err := os.Rename(manifestOld, filepath.Join(outDir, "manifest.preview.webmanifest")); err != nil {
			return "", err
		}
	}

	rev := hex.EncodeToString(h.Sum(nil))[:12]

	// 5. Rewrite index.html and 404.html to reference `.preview.*` assets with ?v=<rev>
	indexPath := filepath.Join(outDir, "index.html")
	rawHTML, err := os.ReadFile(indexPath)
	if err != nil {
		return "", err
	}
	rewritten, err := rewritePreviewIndexHTML(string(rawHTML), rev)
	if err != nil {
		return "", err
	}
	for _, target := range []string{"index.html", "404.html"} {
		if err := os.WriteFile(filepath.Join(outDir, target), []byte(rewritten), 0o644); err != nil {
			return "", err
		}
	}
	return rev, nil
}

func rewritePreviewIndexHTML(html string, rev string) (string, error) {
	if !previewAppSrcRe.MatchString(html) {
		return "", fmt.Errorf("index.html is missing ./dist/app.js script tag")
	}
	out := strings.Replace(html, "<title>SlapRF</title>", "<title>SlapRF (Preview)</title>", 1)
	out = strings.Replace(
		out,
		`<div class="slaprf-boot-title">SlapRF</div>`,
		`<div class="slaprf-boot-title">SlapRF · Preview</div>`,
		1,
	)
	out = strings.Replace(
		out,
		`href="./manifest.webmanifest"`,
		fmt.Sprintf(`href="./manifest.preview.webmanifest?v=%s"`, rev),
		1,
	)
	out = previewStyleHrefRe.ReplaceAllString(out, fmt.Sprintf(`href="./styles/$1.preview.css?v=%s"`, rev))
	out = previewAppSrcRe.ReplaceAllString(
		out,
		fmt.Sprintf(`<script>window.__SLAPRF_PREVIEW_REV__=%q;</script><script src="./dist/app.preview.js?v=%s"></script>`, rev, rev),
	)
	return out, nil
}
