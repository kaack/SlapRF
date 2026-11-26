//go:build demo_gen

// Command gen-demo-assets pre-generates SlapRF's embedded showcase demo dataset
// (`showcase_state.json.gz` + `session-{1,2,3}.rfbin.gz`) so runtime builds restore demo data
// via direct byte copy with zero runtime simulation or waveform synthesis overhead.
package main

import (
	"flag"
	"log"

	"slaprf/internal/tracker"
)

func main() {
	outDir := flag.String("out", "internal/tracker/demo_assets", "Output directory for pre-generated demo assets")
	flag.Parse()

	if err := tracker.GenerateShowcaseDemoAssets(*outDir); err != nil {
		log.Fatalf("[gen-demo-assets] failed: %v", err)
	}
	log.Printf("[gen-demo-assets] wrote pre-generated demo assets to %s", *outDir)
}
