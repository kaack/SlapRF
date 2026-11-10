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
	if parsed.Role != RoleHubTimer || parsed.TimerLabel != "H1" {
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
}

// The block's reserved byte (12) is always written as 0, so every board carries an identical
// config layout regardless of what an older image had there.
func TestReservedByteIsZero(t *testing.T) {
	base := SyntheticBase()
	base[configOff+offReserved] = 7 // stale value from an older image
	built, err := PatchImage(base, TimerConfig{Role: RoleSpokeTimer, Fingerprint: 0x01020304})
	if err != nil {
		t.Fatalf("PatchImage: %v", err)
	}
	if got := built.Bytes[built.ConfigOff+offReserved]; got != 0 {
		t.Fatalf("reserved byte = %d, want 0", got)
	}
	if built.Filename != "slaprf-xiao-c5-spoke-"+domain.LatestFirmwareVersion+".bin" {
		t.Fatalf("unexpected filename %q", built.Filename)
	}
}

// firmware/slaprf/main/main.c must agree with the Go side: same sweep rate, same firmware
// version, a window the laptop ingest accepts, and the SLAPRF02 block layout with the reserved
// byte in place of the old design code.
func TestFirmwareSourceMatchesGo(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "firmware", "slaprf", "main", "main.c"))
	if err != nil {
		t.Fatal(err)
	}
	src := string(raw)
	define := func(name string) int {
		m := regexp.MustCompile(`(?m)^#define\s+` + name + `\s+(\d+)`).FindStringSubmatch(src)
		if m == nil {
			t.Fatalf("main.c: #define %s not found", name)
		}
		n, _ := strconv.Atoi(m[1])
		return n
	}
	if got := define("SWEEP_HZ"); got != SweepHz {
		t.Errorf("main.c SWEEP_HZ=%d, firmware.SweepHz=%d", got, SweepHz)
	}
	if w := define("WINDOW_SAMPLES"); w < 1 || w > MaxWindowSamples {
		t.Errorf("WINDOW_SAMPLES=%d outside 1..%d", w, MaxWindowSamples)
	}
	if !strings.Contains(src, `'S', 'L', 'A', 'P', 'R', 'F', '0', '2'`) {
		t.Error("main.c does not use the SLAPRF02 config block")
	}
	m := regexp.MustCompile(`\.version\s*=\s*\{(\d+),\s*(\d+),\s*(\d+)\}`).FindStringSubmatch(src)
	if m == nil {
		t.Fatal("main.c: .version initializer not found")
	}
	if v := "v" + m[1] + "." + m[2] + "." + m[3]; v != domain.LatestFirmwareVersion {
		t.Errorf("main.c version %s, domain.LatestFirmwareVersion %s", v, domain.LatestFirmwareVersion)
	}
	cfg := regexp.MustCompile(`(?s)uint8_t\s+role;.*?uint8_t\s+reserved0;.*?uint8_t\s+wifi_mode;`)
	if !cfg.MatchString(src) {
		t.Error("main.c config block: expected role, reserved0, wifi_mode at bytes 11..13")
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

	built, err := PatchImage(merged, TimerConfig{Role: RoleSpokeTimer, Fingerprint: 0x1234ABCD, TimerLabel: "S2"})
	if err != nil {
		t.Fatalf("PatchImage: %v", err)
	}
	out := built.Bytes
	parsed, err := InspectConfig(out)
	if err != nil || parsed.Fingerprint != 0x1234ABCD || parsed.TimerLabel != "S2" {
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
