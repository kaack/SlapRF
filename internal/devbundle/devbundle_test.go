package devbundle

import (
	"path/filepath"
	"strings"
	"testing"
)

// The pure-Go esbuild bundle of web/src must compile and include the app's main components.
func TestBundleTypeScript(t *testing.T) {
	js, err := BundleTypeScript(filepath.Join("..", "..", "web"))
	if err != nil {
		t.Fatalf("BundleTypeScript: %v", err)
	}
	body := string(js)
	for _, name := range []string{"AppShell", "LiveView", "AllPilotsPanel", "PilotPanel", "LapTimesCard", "PilotView", "LapPicker", "LapComparison", "PilotRssiChart", "PilotLaps", "SetupView", "TrackEditor", "TimersList", "TimerFlasher", "Announcer", "TimingRulesEditor"} {
		if !strings.Contains(body, name) {
			t.Fatalf("compiled TypeScript bundle missing %s", name)
		}
	}
}
