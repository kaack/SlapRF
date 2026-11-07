package firmware

import (
	"testing"

	"fpv-gate-timer/internal/domain"
)

func TestBuildStartBridgePuck1WithWiFi(t *testing.T) {
	freqs := [domain.MaxPilotSlots]uint16{5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917}

	built, err := BuildXIAOC5Image(PuckConfig{
		PuckID:       1,
		PuckLabel:    "Master-Start",
		SlotFreqsMHz: freqs,
		WifiSSID:     "PilotHotspot",
		WifiPass:     "raceband58",
	})
	if err != nil {
		t.Fatalf("BuildXIAOC5Image failed: %v", err)
	}
	if len(built.Bytes) != 64*1024 {
		t.Fatalf("expected 64KB image, got %d bytes", len(built.Bytes))
	}

	parsed, err := InspectConfig(built.Bytes)
	if err != nil {
		t.Fatalf("InspectConfig failed: %v", err)
	}
	if parsed.Role != RoleStartBridge || parsed.PuckID != 1 || parsed.PuckLabel != "Master-Start" {
		t.Fatalf("expected RoleStartBridge/Master-Start for Puck 1, got %+v", parsed)
	}
	if parsed.WifiSSID != "PilotHotspot" || parsed.WifiPass != "raceband58" {
		t.Fatalf("unexpected Wi-Fi credentials: %q / %q", parsed.WifiSSID, parsed.WifiPass)
	}
	if parsed.SlotFreqsMHz != freqs {
		t.Fatalf("expected freqs %v, got %v", freqs, parsed.SlotFreqsMHz)
	}
}

func TestBuildFieldPuckUsesESPNOWRole(t *testing.T) {
	built, err := BuildXIAOC5Image(PuckConfig{
		PuckID:   3,
		WifiSSID: "IgnoredOnFieldPuck",
	})
	if err != nil {
		t.Fatalf("BuildXIAOC5Image failed: %v", err)
	}
	parsed, err := InspectConfig(built.Bytes)
	if err != nil {
		t.Fatalf("InspectConfig failed: %v", err)
	}
	if parsed.Role != RoleFieldPuck || parsed.PuckID != 3 {
		t.Fatalf("expected RoleFieldPuck with puckId=3, got %+v", parsed)
	}
	if parsed.WifiSSID != "" {
		t.Fatalf("expected empty Wi-Fi SSID on ESP-NOW field puck, got %q", parsed.WifiSSID)
	}
}

func TestBuildRejectsInvalidPuckID(t *testing.T) {
	if _, err := BuildXIAOC5Image(PuckConfig{PuckID: 0}); err == nil {
		t.Fatal("expected error for puckId=0")
	}
	if _, err := BuildXIAOC5Image(PuckConfig{PuckID: 17}); err == nil {
		t.Fatal("expected error for puckId=17")
	}
}
