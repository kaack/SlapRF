package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Placeholders in web/sw.js replaced at build time. Left intact (un-built template), the worker is inert.
const (
	swPrecachePlaceholder = "/*__SLAPRF_PRECACHE__*/ null"
	swVersionPlaceholder  = "__SLAPRF_SW_VERSION__"
)

// precacheEntry is one file the service worker stores for offline use. URL is relative to the site
// root (the SW scope); Rev is a content hash so unchanged files are reused across deploys.
type precacheEntry struct {
	URL string `json:"url"`
	Rev string `json:"rev"`
}

// precacheExcluded lists site files the service worker must not precache: the SW itself, the
// GitHub Pages SPA fallback (identical to index.html, which navigations fall back to), and Pages
// metadata.
var precacheExcluded = map[string]bool{
	"sw.js":     true,
	"404.html":  true,
	"CNAME":     true,
	".nojekyll": true,
}

// buildPrecache hashes every deployable file under outDir (sorted, slash-separated paths) and
// returns the manifest plus a cache version derived only from those hashes, so a redeploy of
// identical content keeps the same version (no cache bust, no update prompt).
func buildPrecache(outDir string) ([]precacheEntry, string, error) {
	var entries []precacheEntry
	err := filepath.WalkDir(outDir, func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(outDir, p)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		base := path.Base(rel)
		if precacheExcluded[rel] || strings.HasPrefix(base, ".") || strings.HasSuffix(base, ".md") {
			return nil
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(data)
		entries = append(entries, precacheEntry{URL: rel, Rev: hex.EncodeToString(sum[:])[:16]})
		return nil
	})
	if err != nil {
		return nil, "", err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].URL < entries[j].URL })

	h := sha256.New()
	for _, e := range entries {
		fmt.Fprintf(h, "%s\x00%s\n", e.URL, e.Rev)
	}
	return entries, hex.EncodeToString(h.Sum(nil))[:16], nil
}

// localAssetRef matches same-origin asset references in index.html (href="./x" / src="./x").
var localAssetRef = regexp.MustCompile(`(?:href|src)="\./([^"?#]+)(?:[?#][^"]*)?"`)

// checkIndexRefsPrecached ensures every local asset index.html loads is in the precache, so the
// app shell can't silently lose offline support when someone adds a new stylesheet/script.
func checkIndexRefsPrecached(indexHTML []byte, entries []precacheEntry) error {
	have := make(map[string]bool, len(entries))
	for _, e := range entries {
		have[e.URL] = true
	}
	var missing []string
	for _, m := range localAssetRef.FindAllSubmatch(indexHTML, -1) {
		if ref := string(m[1]); !have[ref] {
			missing = append(missing, ref)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("index.html references assets missing from the site/precache: %s", strings.Join(missing, ", "))
	}
	return nil
}

// renderServiceWorker substitutes the precache manifest and version into the sw.js template.
func renderServiceWorker(tmpl []byte, entries []precacheEntry, version string) ([]byte, error) {
	src := string(tmpl)
	if !strings.Contains(src, swPrecachePlaceholder) || !strings.Contains(src, swVersionPlaceholder) {
		return nil, fmt.Errorf("sw.js template is missing %q or %q", swPrecachePlaceholder, swVersionPlaceholder)
	}
	list, err := json.MarshalIndent(entries, "", "  ")
	if err != nil {
		return nil, err
	}
	src = strings.Replace(src, swPrecachePlaceholder, string(list), 1)
	src = strings.ReplaceAll(src, swVersionPlaceholder, version)
	return []byte(src), nil
}

// writeServiceWorker generates <outDir>/sw.js from <webDir>/sw.js. Must run after every other
// asset has been written to outDir.
func writeServiceWorker(webDir, outDir string) (version string, count int, err error) {
	entries, version, err := buildPrecache(outDir)
	if err != nil {
		return "", 0, fmt.Errorf("hash site files: %w", err)
	}
	indexHTML, err := os.ReadFile(filepath.Join(outDir, "index.html"))
	if err != nil {
		return "", 0, err
	}
	if err := checkIndexRefsPrecached(indexHTML, entries); err != nil {
		return "", 0, err
	}
	tmpl, err := os.ReadFile(filepath.Join(webDir, "sw.js"))
	if err != nil {
		return "", 0, err
	}
	out, err := renderServiceWorker(tmpl, entries, version)
	if err != nil {
		return "", 0, err
	}
	if err := os.WriteFile(filepath.Join(outDir, "sw.js"), out, 0o644); err != nil {
		return "", 0, err
	}
	return version, len(entries), nil
}
