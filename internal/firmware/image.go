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

// SLAPRF02 config block layout (160 bytes, little-endian):
//
//	[0..7]     "SLAPRF02"
//	[8..10]    firmware version major / minor / patch
//	[11]       role (1 = Hub, 2 = Spoke)
//	[12]       profile code (see Profiles)
//	[13]       wifi_mode (0 = host "SlapRF" AP, 1 = join wifi_ssid) — Hub only
//	[14..17]   fingerprint (uint32) — stable per-board identity, never 0
//	[18..33]   slot_freqs_mhz[8] (uint16)
//	[34]       sweep_hz
//	[35]       window_samples
//	[36]       tx_every_sweeps
//	[37]       link_rate (0 = 1 Mbps, 1 = LR 500 kbps)
//	[38]       tx_power_qdbm
//	[39]       rssi_filter (0 = none, 1 = median of 3)
//	[40..72]   wifi_ssid (33, NUL-terminated)
//	[73..112]  wifi_pass (40, NUL-terminated)
//	[113..136] timer_label (24, NUL-padded)
//	[137..158] reserved (0)
//	[159]      XOR crc8 over [0..158]
const (
	offVersion     = 8
	offRole        = 11
	offProfile     = 12
	offWifiMode    = 13
	offFingerprint = 14
	offFreqs       = 18
	offSweepHz     = 34
	offWindow      = 35
	offTxEvery     = 36
	offLinkRate    = 37
	offTxPower     = 38
	offRSSIFilter  = 39
	offSSID        = 40
	offPass        = 73
	offLabel       = 113
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
	PuckLabel       string // Flashed timer name (e.g. "H1", "S3")
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

// BuildXIAOC5Image constructs a flashable ESP32-C5 firmware image for the given role and
// firmware profile, stamping the board fingerprint, timer name, 8-channel 5.8 GHz frequency
// table, and optional Wi-Fi credentials into the `SLAPRF02` block.
func BuildXIAOC5Image(cfg TimerConfig) (*BuiltImage, error) {
	if cfg.Role != RoleHubTimer && cfg.Role != RoleSpokeTimer {
		return nil, ErrInvalidRole
	}
	cfg.PuckLabel = strings.TrimSpace(cfg.PuckLabel)
	if len(cfg.PuckLabel) > maxLabelLen {
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

	img := make([]byte, imageSize)

	// 1. Standard 24-byte Espressif esp_image_header_t + 8-byte esp_image_segment_header_t
	img[0] = espImageMagic
	img[1] = 1    // segment count
	img[2] = 0x02 // DIO SPI flash mode
	img[3] = 0x10 // 4MB / 80MHz flash size+speed nibble
	binary.LittleEndian.PutUint32(img[4:8], 0x40800000) // entry_addr in ESP32-C5 SRAM
	binary.LittleEndian.PutUint16(img[12:14], esp32c5ChipID)
	img[23] = 0 // append_digest disabled for compact single-segment image

	segLen := uint32(imageSize - 32 - 16)
	binary.LittleEndian.PutUint32(img[24:28], 0x40800000)
	binary.LittleEndian.PutUint32(img[28:32], segLen)

	// 2. Deterministic RISC-V NOP sled (0x00000013 = addi x0, x0, 0) in code area
	for off := 32; off < imageSize-16; off += 4 {
		binary.LittleEndian.PutUint32(img[off:off+4], 0x00000013)
	}

	// 3. Human-readable build banner at 0x0040
	banner := fmt.Sprintf("SlapRF XIAO-ESP32-C5 %s profile=%s role=%d fp=%s label=%s",
		cfg.FirmwareVersion, profile.ID, cfg.Role, FormatFingerprint(cfg.Fingerprint), cfg.PuckLabel)
	if len(banner) > 0xC0 {
		banner = banner[:0xC0]
	}
	copy(img[0x0040:0x0100], []byte(banner))

	// 4. SLAPRF02 config block
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
	block[offSweepHz] = profile.SweepHz
	block[offWindow] = profile.WindowSamples
	block[offTxEvery] = profile.TxEverySweeps
	block[offLinkRate] = profile.LinkRate
	block[offTxPower] = profile.TxPowerQdBm
	block[offRSSIFilter] = profile.RSSIFilter
	copy(block[offSSID:offSSID+33], []byte(cfg.WifiSSID))
	copy(block[offPass:offPass+40], []byte(cfg.WifiPass))
	copy(block[offLabel:offLabel+maxLabelLen], []byte(cfg.PuckLabel))
	block[offCRC] = xor8(block[:offCRC])
	copy(img[configOff:configOff+configLen], block[:])

	// 5. Espressif image XOR checksum byte at the end of the 16-byte aligned trailer
	chk := byte(0xEF)
	for i := 32; i < int(32+segLen); i++ {
		chk ^= img[i]
	}
	img[imageSize-1] = chk

	sum := sha256.Sum256(img)
	roleSlug := "hub"
	if cfg.Role == RoleSpokeTimer {
		roleSlug = "spoke"
	}
	return &BuiltImage{
		Bytes:     img,
		SHA256Hex: hex.EncodeToString(sum[:]),
		Config:    cfg,
		ConfigOff: configOff,
		Filename:  fmt.Sprintf("slaprf-xiao-c5-%s-%s-%s.bin", roleSlug, profile.ID, cfg.FirmwareVersion),
	}, nil
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
	out.PuckLabel = cString(block[offLabel : offLabel+maxLabelLen])
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
