//go:build !js && !android

package gatecam

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/evanw/esbuild/pkg/api"
)

// BundleWebSPA compiles `tools/gatecam/web/src/main.ts` into JavaScript via pure-Go esbuild.
func BundleWebSPA(webRoot string, minify bool) ([]byte, error) {
	entry := filepath.Join(webRoot, "src", "main.ts")
	res := api.Build(api.BuildOptions{
		EntryPoints:       []string{entry},
		Bundle:            true,
		Write:             false,
		Format:            api.FormatIIFE,
		Target:            api.ES2020,
		MinifyWhitespace:  minify,
		MinifyIdentifiers: minify,
		MinifySyntax:      minify,
	})
	if len(res.Errors) > 0 {
		var msgs []string
		for _, e := range res.Errors {
			msgs = append(msgs, fmt.Sprintf("%s:%d:%d: %s", e.Location.File, e.Location.Line, e.Location.Column, e.Text))
		}
		return nil, fmt.Errorf("esbuild failed:\n%s", strings.Join(msgs, "\n"))
	}
	if len(res.OutputFiles) == 0 {
		return nil, fmt.Errorf("esbuild produced no output for %s", entry)
	}
	return res.OutputFiles[0].Contents, nil
}

// BuildStaticSite stages `index.html`, `styles.css`, and bundled `dist/app.js` into `outDir`.
func BuildStaticSite(webRoot string, outDir string) error {
	js, err := BundleWebSPA(webRoot, true)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(outDir, "dist"), 0o755); err != nil {
		return err
	}
	for _, name := range []string{"index.html", "styles.css"} {
		raw, rErr := os.ReadFile(filepath.Join(webRoot, name))
		if rErr != nil {
			return rErr
		}
		if wErr := os.WriteFile(filepath.Join(outDir, name), raw, 0o644); wErr != nil {
			return wErr
		}
	}
	return os.WriteFile(filepath.Join(outDir, "dist", "app.js"), js, 0o644)
}
