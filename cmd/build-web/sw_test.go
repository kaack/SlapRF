package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeTree(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for rel, body := range files {
		p := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestBuildPrecacheExcludesAndVersionsByContent(t *testing.T) {
	dir := t.TempDir()
	writeTree(t, dir, map[string]string{
		"index.html":           `<link href="./styles/a.css?v=1"><script src="./dist/app.js?v=2"></script>`,
		"404.html":             "x",
		"CNAME":                "slaprf.app",
		".nojekyll":            "",
		"sw.js":                "old",
		"styles/a.css":         "a",
		"dist/app.js":          "js",
		"firmware/README.md":   "doc",
		"firmware/x.bin":       "bin",
		"manifest.webmanifest": "{}",
	})
	entries, v1, err := buildPrecache(dir)
	if err != nil {
		t.Fatal(err)
	}
	var urls []string
	for _, e := range entries {
		urls = append(urls, e.URL)
	}
	want := "dist/app.js,firmware/x.bin,index.html,manifest.webmanifest,styles/a.css"
	if got := strings.Join(urls, ","); got != want {
		t.Fatalf("precache urls = %s, want %s", got, want)
	}
	if err := checkIndexRefsPrecached([]byte(`<link href="./styles/a.css?v=1"><script src="./dist/app.js?v=2"></script>`), entries); err != nil {
		t.Fatal(err)
	}
	if err := checkIndexRefsPrecached([]byte(`<script src="./dist/missing.js"></script>`), entries); err == nil {
		t.Fatal("expected missing-asset error")
	}

	// Excluded files don't affect the version; content changes do.
	writeTree(t, dir, map[string]string{"sw.js": "changed", "CNAME": "other"})
	if _, v2, _ := buildPrecache(dir); v2 != v1 {
		t.Fatalf("version changed on excluded-file edit: %s -> %s", v1, v2)
	}
	writeTree(t, dir, map[string]string{"dist/app.js": "js2"})
	if _, v3, _ := buildPrecache(dir); v3 == v1 {
		t.Fatal("version did not change after app.js content change")
	}
}

func TestRenderServiceWorkerTemplate(t *testing.T) {
	tmpl, err := os.ReadFile(filepath.Join("..", "..", "web", "sw.js"))
	if err != nil {
		t.Fatal(err)
	}
	out, err := renderServiceWorker(tmpl, []precacheEntry{{URL: "index.html", Rev: "abc"}}, "v123")
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	if strings.Contains(s, swPrecachePlaceholder) || strings.Contains(s, swVersionPlaceholder) {
		t.Fatal("placeholders not substituted")
	}
	if !strings.Contains(s, `"url": "index.html"`) || !strings.Contains(s, `"v123"`) {
		t.Fatalf("rendered sw.js missing manifest/version:\n%s", s[:400])
	}
}
