package firmware

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
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
	if len(Profiles) == 0 {
		t.Fatal("no firmware profiles found under firmware/")
	}
	seen := map[uint8]string{}
	for _, p := range Profiles {
		if other, dup := seen[p.Code]; dup {
			t.Fatalf("profiles %s and %s share code %d", p.ID, other, p.Code)
		}
		seen[p.Code] = p.ID
		built, err := BuildXIAOC5Image(TimerConfig{Role: RoleSpokeTimer, Profile: p.ID})
		if err != nil {
			t.Fatalf("%s: %v", p.ID, err)
		}
		parsed, err := InspectConfig(built.Bytes)
		if err != nil || parsed.Profile != p.ID {
			t.Fatalf("%s: round trip failed (%v, %+v)", p.ID, err, parsed)
		}
	}
	if ProfileByID("").ID != DefaultProfileID {
		t.Fatalf("default profile %s missing", DefaultProfileID)
	}
}

// Each firmware/<profile>/main.c must declare the same code and sweep rate as its manifest,
// and keep its window within what the laptop ingest accepts.
func TestProfileSourcesMatchManifests(t *testing.T) {
	define := func(src, name string) int {
		m := regexp.MustCompile(`(?m)^#define\s+` + name + `\s+(\d+)`).FindStringSubmatch(src)
		if m == nil {
			return -1
		}
		n, _ := strconv.Atoi(m[1])
		return n
	}
	for _, p := range Profiles {
		raw, err := os.ReadFile(filepath.Join("..", "..", "firmware", p.ID, "main.c"))
		if err != nil {
			t.Fatalf("%s: %v", p.ID, err)
		}
		src := string(raw)
		if got := define(src, "SLAPRF_PROFILE_CODE"); got != int(p.Code) {
			t.Errorf("%s: main.c SLAPRF_PROFILE_CODE=%d, manifest code=%d", p.ID, got, p.Code)
		}
		if got := define(src, "SWEEP_HZ"); got != int(p.SweepHz) {
			t.Errorf("%s: main.c SWEEP_HZ=%d, manifest sweepHz=%d", p.ID, got, p.SweepHz)
		}
		if w := define(src, "WINDOW_SAMPLES"); w < 1 || w > MaxWindowSamples {
			t.Errorf("%s: WINDOW_SAMPLES=%d outside 1..%d", p.ID, w, MaxWindowSamples)
		}
		if !strings.Contains(src, `"SLAPRF02"`) && !strings.Contains(src, `'S', 'L', 'A', 'P', 'R', 'F', '0', '2'`) {
			t.Errorf("%s: main.c does not use the SLAPRF02 config block", p.ID)
		}
	}
}

func TestBuildRejectsInvalidRole(t *testing.T) {
	if _, err := BuildXIAOC5Image(TimerConfig{}); err == nil {
		t.Fatal("expected error for missing role")
	}
}
