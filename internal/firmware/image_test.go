package firmware

import (
	"testing"

	"slaprf/internal/domain"
)

func TestBuildHubTimerWithWiFi(t *testing.T) {
	freqs := [domain.MaxPilotSlots]uint16{5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917}

	built, err := BuildXIAOC5Image(TimerConfig{
		Role:         RoleHubTimer,
		Profile:      "indoor",
		Fingerprint:  0xA1B2C3D4,
		PuckLabel:    "H1",
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
	if parsed.Role != RoleHubTimer || parsed.PuckLabel != "H1" || parsed.Profile != "indoor" {
		t.Fatalf("unexpected hub config: %+v", parsed)
	}
	if parsed.Fingerprint != 0xA1B2C3D4 {
		t.Fatalf("expected preserved fingerprint, got %08X", parsed.Fingerprint)
	}
	if parsed.FirmwareVersion != domain.LatestFirmwareVersion {
		t.Fatalf("expected version %s, got %s", domain.LatestFirmwareVersion, parsed.FirmwareVersion)
	}
	if parsed.WifiSSID != "PilotHotspot" || parsed.WifiPass != "raceband58" {
		t.Fatalf("unexpected Wi-Fi credentials: %q / %q", parsed.WifiSSID, parsed.WifiPass)
	}
	if parsed.SlotFreqsMHz != freqs {
		t.Fatalf("expected freqs %v, got %v", freqs, parsed.SlotFreqsMHz)
	}
}

func TestBuildSpokeGeneratesFingerprintAndDropsWiFi(t *testing.T) {
	a, err := BuildXIAOC5Image(TimerConfig{Role: RoleSpokeTimer, WifiSSID: "Ignored"})
	if err != nil {
		t.Fatalf("BuildXIAOC5Image failed: %v", err)
	}
	b, _ := BuildXIAOC5Image(TimerConfig{Role: RoleSpokeTimer})
	pa, _ := InspectConfig(a.Bytes)
	pb, _ := InspectConfig(b.Bytes)
	if pa.Role != RoleSpokeTimer || pa.WifiSSID != "" {
		t.Fatalf("unexpected spoke config: %+v", pa)
	}
	if pa.Fingerprint == 0 || pa.Fingerprint == pb.Fingerprint {
		t.Fatalf("expected distinct non-zero fingerprints, got %08X and %08X", pa.Fingerprint, pb.Fingerprint)
	}
	if pa.Profile != DefaultProfileID {
		t.Fatalf("expected default profile, got %s", pa.Profile)
	}
}

func TestEveryProfileRoundTrips(t *testing.T) {
	for _, p := range Profiles {
		built, err := BuildXIAOC5Image(TimerConfig{Role: RoleSpokeTimer, Profile: p.ID})
		if err != nil {
			t.Fatalf("%s: %v", p.ID, err)
		}
		parsed, err := InspectConfig(built.Bytes)
		if err != nil || parsed.Profile != p.ID {
			t.Fatalf("%s: round trip failed (%v, %+v)", p.ID, err, parsed)
		}
		if p.WindowSamples == 0 || p.WindowSamples > MaxWindowSamples || p.TxEverySweeps == 0 {
			t.Fatalf("%s: invalid window settings", p.ID)
		}
	}
}

func TestBuildRejectsInvalidRole(t *testing.T) {
	if _, err := BuildXIAOC5Image(TimerConfig{}); err == nil {
		t.Fatal("expected error for missing role")
	}
}
