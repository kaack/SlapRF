package firmware

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"slaprf/internal/domain"
)

const (
	// ConfigMagic marks the patchable configuration struct inside the XIAO ESP32-C5 image.
	ConfigMagic = "SLAPRF02"

	// RoleHubTimer is the Hub timer: sweeps 5.8 GHz RSSI, receives ESP-NOW frames from Spoke
	// timers, assigns their TDMA slots, and bridges all telemetry to the laptop over Wi-Fi.
	RoleHubTimer uint8 = 1

	// RoleSpokeTimer is a Spoke timer: sweeps 5.8 GHz RSSI and bursts sliding-window frames over
	// connectionless ESP-NOW to the Hub timer (no Wi-Fi association needed on spoke timers).
	RoleSpokeTimer uint8 = 2

	// espImageMagic is the standard Espressif bootloader image magic byte (0xE9).
	espImageMagic byte = 0xE9
	// esp32c5ChipID is the Espressif ROM image header chip ID for ESP32-C5 (0x0017).
	esp32c5ChipID uint16 = 0x0017

	// imageSize is a compact 64 KB flashable image (16 x 4 KB flash sectors).
	imageSize   = 64 * 1024
	configOff   = 0x0100 // Fixed offset of the SLAPRF02 config struct inside the binary
	configLen   = 160
	minFreqMHz  = 5600
	maxFreqMHz  = 5950
	maxSSIDLen  = 32
	maxPassLen  = 39
	maxLabelLen = 24
)

// SLAPRF02 config block layout (160 bytes, little-endian). The radio / sweep tuning is compiled
// into each profile's own firmware (firmware/<profile>/main.c); the block only carries what is
// per-board or per-event:
//
//	[0..7]     "SLAPRF02"
//	[8..10]    firmware version major / minor / patch
//	[11]       role (1 = Hub, 2 = Spoke)
//	[12]       profile code (see firmware/<profile>/profile.json)
//	[13]       wifi_mode (0 = host "SlapRF" AP, 1 = join wifi_ssid) — Hub only
//	[14..17]   fingerprint (uint32) — stable per-board identity, never 0
//	[18..33]   slot_freqs_mhz[8] (uint16)
//	[34..66]   wifi_ssid (33, NUL-terminated)
//	[67..106]  wifi_pass (40, NUL-terminated)
//	[107..130] timer_label (24, NUL-padded)
//	[131..158] reserved (0)
//	[159]      XOR crc8 over [0..158]
const (
	offVersion     = 8
	offRole        = 11
	offProfile     = 12
	offWifiMode    = 13
	offFingerprint = 14
	offFreqs       = 18
	offSSID        = 34
	offPass        = 67
	offLabel       = 107
	offCRC         = configLen - 1
)

var (
	ErrInvalidRole  = errors.New("invalid role: must be hub (1) or spoke (2)")
	ErrSSIDTooLong  = errors.New("Wi-Fi SSID must be at most 32 bytes")
	ErrPassTooLong  = errors.New("Wi-Fi password must be at most 39 bytes")
	ErrLabelTooLong = errors.New("timer ID / name must be at most 24 characters")
)

// TimerConfig is the binary configuration stamped into the XIAO ESP32-C5 firmware image
// at download time so the user never needs a C compiler or CLI toolchain.
type TimerConfig struct {
	Role            uint8
	Profile         string // Firmware design ID (see Profiles); empty = DefaultProfileID
	Fingerprint     uint32 // Stable per-board identity; 0 = generate a new random one
	TimerLabel      string // Flashed timer name (e.g. "H1", "S3")
	FirmwareVersion string // Filled in from the current build; read back by InspectConfig
	SlotFreqsMHz    [domain.MaxPilotSlots]uint16
	WifiSSID        string // Only used by Hub timer
	WifiPass        string
}

// BuiltImage holds the patched ESP32-C5 firmware binary and its metadata.
type BuiltImage struct {
	Bytes     []byte
	SHA256Hex string
	Config    TimerConfig
	ConfigOff int
	Filename  string
}

// NewFingerprint returns a random, non-zero 32-bit board fingerprint.
func NewFingerprint() uint32 {
	var b [4]byte
	for {
		if _, err := rand.Read(b[:]); err != nil {
			return 0x51A9F00D
		}
		if fp := binary.LittleEndian.Uint32(b[:]); fp != 0 {
			return fp
		}
	}
}

// FormatFingerprint renders a fingerprint as 8 upper-case hex digits.
func FormatFingerprint(fp uint32) string {
	return fmt.Sprintf("%08X", fp)
}

// ParseFingerprint parses an 8-hex-digit fingerprint (0 on failure).
func ParseFingerprint(s string) uint32 {
	v, err := strconv.ParseUint(strings.TrimSpace(s), 16, 32)
	if err != nil {
		return 0
	}
	return uint32(v)
}

// BuildXIAOC5Image builds a flashable image for the given role and profile from the built-in
// placeholder base (used when no compiled firmware for the profile is available).
func BuildXIAOC5Image(cfg TimerConfig) (*BuiltImage, error) {
	return PatchImage(SyntheticBase(), cfg)
}

// SyntheticBase returns a 64 KB placeholder ESP32-C5 app image (valid header, RISC-V NOP sled,
// empty SLAPRF02 block at 0x100). It flashes, but does nothing: real images come from the
// ESP-IDF builds of firmware/<profile>/ (see firmware/README.md).
func SyntheticBase() []byte {
	img := make([]byte, imageSize)
	img[0] = espImageMagic
	img[1] = 1                                          // segment count
	img[2] = 0x02                                       // DIO SPI flash mode
	img[3] = 0x10                                       // 4MB / 80MHz flash size+speed nibble
	binary.LittleEndian.PutUint32(img[4:8], 0x40800000) // entry_addr in ESP32-C5 SRAM
	binary.LittleEndian.PutUint16(img[12:14], esp32c5ChipID)
	img[23] = 0 // no appended SHA-256
	segLen := uint32(imageSize - 32 - 16)
	binary.LittleEndian.PutUint32(img[24:28], 0x40800000)
	binary.LittleEndian.PutUint32(img[28:32], segLen)
	for off := 32; off < imageSize-16; off += 4 {
		binary.LittleEndian.PutUint32(img[off:off+4], 0x00000013)
	}
	copy(img[0x0040:], []byte("SlapRF XIAO-ESP32-C5 placeholder image (no compiled firmware)"))
	copy(img[configOff:], []byte(ConfigMagic))
	return img
}

// PatchImage stamps cfg into the SLAPRF02 block of `base` (a copy is returned) and repairs the
// ESP-IDF app image integrity data (segment XOR checksum and, if present, the appended SHA-256)
// so the bootloader accepts it. `base` may be a bare app image or a merged flash image
// (bootloader + partition table + app at 0x10000) as produced by `esptool merge_bin`.
func PatchImage(base []byte, cfg TimerConfig) (*BuiltImage, error) {
	if cfg.Role != RoleHubTimer && cfg.Role != RoleSpokeTimer {
		return nil, ErrInvalidRole
	}
	cfg.TimerLabel = strings.TrimSpace(cfg.TimerLabel)
	if len(cfg.TimerLabel) > maxLabelLen {
		return nil, ErrLabelTooLong
	}
	if len(cfg.WifiSSID) > maxSSIDLen {
		return nil, ErrSSIDTooLong
	}
	if len(cfg.WifiPass) > maxPassLen {
		return nil, ErrPassTooLong
	}
	if cfg.Role == RoleSpokeTimer {
		cfg.WifiSSID = ""
		cfg.WifiPass = ""
	}
	profile := ProfileByID(cfg.Profile)
	cfg.Profile = profile.ID
	if cfg.Fingerprint == 0 {
		cfg.Fingerprint = NewFingerprint()
	}
	cfg.FirmwareVersion = domain.LatestFirmwareVersion
	for i, f := range cfg.SlotFreqsMHz {
		if f < minFreqMHz || f > maxFreqMHz {
			cfg.SlotFreqsMHz[i] = domain.RacebandFrequenciesMHz[i]
		}
	}

	img := append([]byte(nil), base...)
	off := bytes.Index(img, []byte(ConfigMagic))
	if off < 0 || off+configLen > len(img) {
		return nil, errors.New("firmware image has no SLAPRF02 config block")
	}

	var block [configLen]byte
	copy(block[0:8], []byte(ConfigMagic))
	maj, min, pat := parseVersion(cfg.FirmwareVersion)
	block[offVersion], block[offVersion+1], block[offVersion+2] = maj, min, pat
	block[offRole] = cfg.Role
	block[offProfile] = profile.Code
	if cfg.WifiSSID != "" {
		block[offWifiMode] = 1
	}
	binary.LittleEndian.PutUint32(block[offFingerprint:offFingerprint+4], cfg.Fingerprint)
	for i := 0; i < domain.MaxPilotSlots; i++ {
		binary.LittleEndian.PutUint16(block[offFreqs+i*2:offFreqs+i*2+2], cfg.SlotFreqsMHz[i])
	}
	copy(block[offSSID:offSSID+33], []byte(cfg.WifiSSID))
	copy(block[offPass:offPass+40], []byte(cfg.WifiPass))
	copy(block[offLabel:offLabel+maxLabelLen], []byte(cfg.TimerLabel))
	block[offCRC] = xor8(block[:offCRC])
	copy(img[off:off+configLen], block[:])

	if err := RepairAppImage(img, off); err != nil {
		return nil, err
	}

	sum := sha256.Sum256(img)
	roleSlug := "hub"
	if cfg.Role == RoleSpokeTimer {
		roleSlug = "spoke"
	}
	return &BuiltImage{
		Bytes:     img,
		SHA256Hex: hex.EncodeToString(sum[:]),
		Config:    cfg,
		ConfigOff: off,
		Filename:  fmt.Sprintf("slaprf-xiao-c5-%s-%s-%s.bin", roleSlug, profile.ID, cfg.FirmwareVersion),
	}, nil
}

// appImageOffsets are where an ESP-IDF app image can start: a bare app (0x0) or the factory
// app partition inside a merged flash image (0x10000).
var appImageOffsets = []int{0x10000, 0x0}

// RepairAppImage recomputes the ESP-IDF app image checksum (and appended SHA-256 if enabled)
// for the app image that contains byte offset `patchedAt`.
func RepairAppImage(img []byte, patchedAt int) error {
	start := -1
	for _, o := range appImageOffsets {
		if o <= patchedAt && o+24 <= len(img) && img[o] == espImageMagic {
			start = o
			break
		}
	}
	if start < 0 {
		return errors.New("no ESP app image header found before the config block")
	}
	segCount := int(img[start+1])
	hashAppended := img[start+23] == 1
	pos := start + 24
	chk := byte(0xEF)
	for s := 0; s < segCount; s++ {
		if pos+8 > len(img) {
			return errors.New("truncated ESP app image segment header")
		}
		segLen := int(binary.LittleEndian.Uint32(img[pos+4 : pos+8]))
		pos += 8
		if pos+segLen > len(img) {
			return errors.New("truncated ESP app image segment")
		}
		for _, b := range img[pos : pos+segLen] {
			chk ^= b
		}
		pos += segLen
	}
	// Pad so the checksum byte is the last byte of a 16-byte block (relative to the image start).
	pos += 15 - ((pos - start) % 16)
	if pos >= len(img) {
		return errors.New("truncated ESP app image checksum")
	}
	img[pos] = chk
	if hashAppended {
		if pos+1+32 > len(img) {
			return errors.New("truncated ESP app image SHA-256")
		}
		digest := sha256.Sum256(img[start : pos+1])
		copy(img[pos+1:pos+33], digest[:])
	}
	return nil
}

// InspectConfig locates and decodes the SLAPRF02 configuration block inside a firmware binary.
func InspectConfig(img []byte) (TimerConfig, error) {
	var out TimerConfig
	idx := bytes.Index(img, []byte(ConfigMagic))
	if idx < 0 || idx+configLen > len(img) {
		return out, errors.New("SLAPRF02 config magic not found in image")
	}
	block := img[idx : idx+configLen]
	if xor8(block[:offCRC]) != block[offCRC] {
		return out, errors.New("SLAPRF02 config checksum mismatch")
	}
	out.FirmwareVersion = fmt.Sprintf("v%d.%d.%d", block[offVersion], block[offVersion+1], block[offVersion+2])
	out.Role = block[offRole]
	out.Profile = ProfileByCode(block[offProfile]).ID
	out.Fingerprint = binary.LittleEndian.Uint32(block[offFingerprint : offFingerprint+4])
	for i := 0; i < domain.MaxPilotSlots; i++ {
		out.SlotFreqsMHz[i] = binary.LittleEndian.Uint16(block[offFreqs+i*2 : offFreqs+i*2+2])
	}
	out.WifiSSID = cString(block[offSSID : offSSID+33])
	out.WifiPass = cString(block[offPass : offPass+40])
	out.TimerLabel = cString(block[offLabel : offLabel+maxLabelLen])
	return out, nil
}

func parseVersion(v string) (uint8, uint8, uint8) {
	parts := strings.Split(strings.TrimPrefix(strings.TrimSpace(v), "v"), ".")
	var out [3]uint8
	for i := 0; i < 3 && i < len(parts); i++ {
		n, _ := strconv.Atoi(parts[i])
		out[i] = uint8(n)
	}
	return out[0], out[1], out[2]
}

func xor8(b []byte) byte {
	var c byte
	for _, x := range b {
		c ^= x
	}
	return c
}

func cString(b []byte) string {
	if i := bytes.IndexByte(b, 0); i >= 0 {
		b = b[:i]
	}
	return string(b)
}
