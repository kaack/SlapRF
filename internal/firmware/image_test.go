package firmware

import (
	"testing"

	"slaprf/internal/domain"
)

func TestBuildHubTimerWithWiFi(t *testing.T) {
	freqs := [domain.MaxPilotSlots]uint16{5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917}

	built, err := BuildXIAOC5Image(TimerConfig{
		PuckID:       1,
		PuckLabel:    "Hub-1",
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
	if parsed.Role != RoleHubTimer || parsed.PuckID != 1 || parsed.PuckLabel != "Hub-1" {
		t.Fatalf("expected RoleHubTimer/Hub-1 for Timer 1, got %+v", parsed)
	}
	if parsed.WifiSSID != "PilotHotspot" || parsed.WifiPass != "raceband58" {
		t.Fatalf("unexpected Wi-Fi credentials: %q / %q", parsed.WifiSSID, parsed.WifiPass)
	}
	if parsed.SlotFreqsMHz != freqs {
		t.Fatalf("expected freqs %v, got %v", freqs, parsed.SlotFreqsMHz)
	}
}

func TestBuildSpokeTimerUsesESPNOWRole(t *testing.T) {
	built, err := BuildXIAOC5Image(TimerConfig{
		PuckID:   3,
		WifiSSID: "IgnoredOnSpokeTimer",
	})
	if err != nil {
		t.Fatalf("BuildXIAOC5Image failed: %v", err)
	}
	parsed, err := InspectConfig(built.Bytes)
	if err != nil {
		t.Fatalf("InspectConfig failed: %v", err)
	}
	if parsed.Role != RoleSpokeTimer || parsed.PuckID != 3 {
		t.Fatalf("expected RoleSpokeTimer with timerId=3, got %+v", parsed)
	}
	if parsed.WifiSSID != "" {
		t.Fatalf("expected empty Wi-Fi SSID on ESP-NOW spoke timer, got %q", parsed.WifiSSID)
	}
}

func TestBuildRejectsInvalidTimerID(t *testing.T) {
	if _, err := BuildXIAOC5Image(TimerConfig{PuckID: 0}); err == nil {
		t.Fatal("expected error for timerId=0")
	}
	if _, err := BuildXIAOC5Image(TimerConfig{PuckID: 7}); err == nil {
		t.Fatal("expected error for timerId=7")
	}
}
