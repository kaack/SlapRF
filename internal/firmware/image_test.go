package firmware

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
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
		TimerLabel:   "H1",
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
	if parsed.Role != RoleHubTimer || parsed.TimerLabel != "H1" || parsed.Profile != "indoor" {
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
		raw, err := os.ReadFile(filepath.Join("..", "..", "firmware", p.ID, "main", "main.c"))
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

// A real ESP-IDF build is a merged flash image (bootloader + partitions + app at 0x10000) whose
// app has several segments and an appended SHA-256. Patching must keep it bootable.
func TestPatchMergedImageRepairsChecksumAndSHA(t *testing.T) {
	const appOff = 0x10000
	app := []byte{espImageMagic, 2, 0x02, 0x10}
	app = append(app, make([]byte, 20)...) // rest of the 24-byte header
	app[23] = 1                            // hash appended
	seg := func(data []byte) []byte {
		h := make([]byte, 8)
		binary.LittleEndian.PutUint32(h[4:8], uint32(len(data)))
		return append(h, data...)
	}
	rodata := make([]byte, 400)
	copy(rodata[100:], []byte(ConfigMagic))
	app = append(app, seg(make([]byte, 64))...)
	app = append(app, seg(rodata)...)
	pad := 15 - (len(app) % 16)
	app = append(app, make([]byte, pad+1+32)...)
	merged := append(bytes.Repeat([]byte{0xFF}, appOff), app...)

	built, err := PatchImage(merged, TimerConfig{Role: RoleSpokeTimer, Profile: "indoor", Fingerprint: 0x1234ABCD, TimerLabel: "S2"})
	if err != nil {
		t.Fatalf("PatchImage: %v", err)
	}
	out := built.Bytes
	parsed, err := InspectConfig(out)
	if err != nil || parsed.Fingerprint != 0x1234ABCD || parsed.Profile != "indoor" || parsed.TimerLabel != "S2" {
		t.Fatalf("unexpected parsed config %+v (%v)", parsed, err)
	}

	// Independently verify checksum + SHA-256 like the ESP-IDF bootloader does.
	pos := appOff + 24
	chk := byte(0xEF)
	for s := 0; s < 2; s++ {
		n := int(binary.LittleEndian.Uint32(out[pos+4 : pos+8]))
		for _, b := range out[pos+8 : pos+8+n] {
			chk ^= b
		}
		pos += 8 + n
	}
	pos += 15 - ((pos - appOff) % 16)
	if out[pos] != chk {
		t.Fatalf("checksum mismatch: got %02x want %02x", out[pos], chk)
	}
	want := sha256.Sum256(out[appOff : pos+1])
	if !bytes.Equal(out[pos+1:pos+33], want[:]) {
		t.Fatal("appended SHA-256 not updated")
	}
}
