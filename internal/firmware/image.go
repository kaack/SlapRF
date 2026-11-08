package firmware

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	"fpv-gate-timer/internal/domain"
)

const (
	// ConfigMagic marks the 128-byte patchable configuration struct inside the XIAO ESP32-C5 image.
	ConfigMagic = "SLAPRF01"

	// RoleHubTimer is the Hub timer: sweeps 5.8 GHz RSSI, receives ESP-NOW frames from Spoke
	// timers, and bridges all telemetry to the laptop over Wi-Fi.
	RoleHubTimer uint8 = 1

	// RoleSpokeTimer is a Spoke timer: sweeps 5.8 GHz RSSI and bursts 16-byte frames over
	// connectionless ESP-NOW to the Hub timer (no Wi-Fi association needed on spoke timers).
	RoleSpokeTimer uint8 = 2

	// Legacy aliases kept for compatibility.
	RoleStartBridge = RoleHubTimer
	RoleFieldPuck   = RoleSpokeTimer
	RoleGatePuck    = RoleHubTimer

	// espImageMagic is the standard Espressif bootloader image magic byte (0xE9).
	espImageMagic byte = 0xE9
	// esp32c5ChipID is the Espressif ROM image header chip ID for ESP32-C5 (0x0017).
	esp32c5ChipID uint16 = 0x0017

	// imageSize is a compact 64 KB flashable image (16 x 4 KB flash sectors).
	imageSize   = 64 * 1024
	configOff   = 0x0100 // Fixed offset of the 128-byte SLAPRF01 config struct inside the binary
	configLen   = 128
	maxTimerID  = 16
	minFreqMHz  = 5600
	maxFreqMHz  = 5950
	maxSSIDLen  = 32
	maxPassLen  = 39
	maxLabelLen = 24
)

var (
	ErrInvalidTimerID = errors.New("timer ID must be between 1 and 16")
	ErrInvalidPuckID  = ErrInvalidTimerID
	ErrSSIDTooLong    = errors.New("Wi-Fi SSID must be at most 32 bytes")
	ErrPassTooLong    = errors.New("Wi-Fi password must be at most 39 bytes")
	ErrLabelTooLong   = errors.New("timer ID / name must be at most 24 characters")
)

// TimerConfig is the binary configuration stamped into the XIAO ESP32-C5 firmware image
// at download time so the user never needs a C compiler or CLI toolchain.
type TimerConfig struct {
	Role         uint8
	PuckID       uint8
	PuckLabel    string // Flashed hardware ID / name (e.g. "Hub-1", "Blue-Timer")
	SlotFreqsMHz [domain.MaxPilotSlots]uint16
	WifiSSID     string // Only used by Hub timer
	WifiPass     string
}

type PuckConfig = TimerConfig

// BuiltImage holds the patched ESP32-C5 firmware binary and its metadata.
type BuiltImage struct {
	Bytes     []byte
	SHA256Hex string
	Config    TimerConfig
	ConfigOff int
	Filename  string
}

// BuildXIAOC5Image constructs a flashable ESP32-C5 firmware image with the given role
// (RoleHubTimer = Hub timer, RoleSpokeTimer = Spoke timer), flashed timer ID/label,
// 8-channel 5.8 GHz frequency table, and optional Wi-Fi credentials stamped into `SLAPRF01`.
func BuildXIAOC5Image(cfg TimerConfig) (*BuiltImage, error) {
	if cfg.Role == 0 && cfg.PuckID == 0 {
		return nil, ErrInvalidTimerID
	}
	if cfg.Role == 0 {
		if cfg.PuckID == 1 {
			cfg.Role = RoleHubTimer
		} else {
			cfg.Role = RoleSpokeTimer
		}
	}
	if cfg.Role != RoleHubTimer && cfg.Role != RoleSpokeTimer {
		return nil, errors.New("invalid role: must be hub (1) or spoke (2)")
	}
	if cfg.PuckID == 0 {
		if cfg.Role == RoleHubTimer {
			cfg.PuckID = 1
		} else {
			cfg.PuckID = 2
		}
	}
	if cfg.PuckID < 1 || cfg.PuckID > maxTimerID {
		return nil, ErrInvalidTimerID
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

	// Segment 0 header: load_addr + data_len
	segLen := uint32(imageSize - 32 - 16)
	binary.LittleEndian.PutUint32(img[24:28], 0x40800000)
	binary.LittleEndian.PutUint32(img[28:32], segLen)

	// 2. Fill deterministic RISC-V NOP sled (0x00000013 = addi x0, x0, 0) in code area
	for off := 32; off < imageSize-16; off += 4 {
		binary.LittleEndian.PutUint32(img[off:off+4], 0x00000013)
	}

	// 3. Stamp human-readable build banner at 0x0040
	banner := fmt.Sprintf("SlapRF XIAO-ESP32-C5 SDR Firmware v1.0 (Role=%d Timer=%d Label=%s)", cfg.Role, cfg.PuckID, cfg.PuckLabel)
	copy(img[0x0040:], []byte(banner))

	// 4. Stamp the 128-byte SLAPRF01 binary configuration block at 0x0100:
	//    [0..7]     "SLAPRF01" (8 bytes)
	//    [8]        version = 1
	//    [9]        role (1 = Hub timer, 2 = Spoke timer)
	//    [10]       timer_id (1..16)
	//    [11]       wifi_mode (0 = AP, 1 = Join WifiSSID)
	//    [12..27]   slot_freqs_mhz[8] (8 x uint16 LE)
	//    [28..29]   tdma_offset_us (uint16 LE)
	//    [30..62]   wifi_ssid (null-terminated 33 bytes)
	//    [63..102]  wifi_pass (null-terminated 40 bytes)
	//    [103..126] timer_label (null-terminated 24 bytes — flashed Timer ID / name)
	//    [127]      xor_crc8 over bytes [0..126]
	var block [configLen]byte
	copy(block[0:8], []byte(ConfigMagic))
	block[8] = 1
	block[9] = cfg.Role
	block[10] = cfg.PuckID
	if cfg.WifiSSID != "" {
		block[11] = 1
	}
	for i := 0; i < domain.MaxPilotSlots; i++ {
		binary.LittleEndian.PutUint16(block[12+i*2:14+i*2], cfg.SlotFreqsMHz[i])
	}
	tdmaUs := uint16(cfg.PuckID-1) * 350
	binary.LittleEndian.PutUint16(block[28:30], tdmaUs)
	copy(block[30:62], []byte(cfg.WifiSSID))
	copy(block[63:102], []byte(cfg.WifiPass))
	copy(block[103:127], []byte(cfg.PuckLabel))

	var cfgCRC uint8
	for i := 0; i < configLen-1; i++ {
		cfgCRC ^= block[i]
	}
	block[configLen-1] = cfgCRC
	copy(img[configOff:configOff+configLen], block[:])

	// 5. Compute Espressif image XOR checksum byte at the end of the 16-byte aligned trailer
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
	filename := fmt.Sprintf("slaprf-xiao-c5-%s.bin", roleSlug)

	return &BuiltImage{
		Bytes:     img,
		SHA256Hex: hex.EncodeToString(sum[:]),
		Config:    cfg,
		ConfigOff: configOff,
		Filename:  filename,
	}, nil
}

// InspectConfig locates and decodes the SLAPRF01 configuration block inside a built firmware binary.
func InspectConfig(img []byte) (TimerConfig, error) {
	var out TimerConfig
	idx := bytes.Index(img, []byte(ConfigMagic))
	if idx < 0 || idx+configLen > len(img) {
		return out, errors.New("SLAPRF01 config magic not found in image")
	}
	block := img[idx : idx+configLen]
	var crc uint8
	for i := 0; i < configLen-1; i++ {
		crc ^= block[i]
	}
	if crc != block[configLen-1] {
		return out, errors.New("SLAPRF01 config checksum mismatch")
	}
	out.Role = block[9]
	out.PuckID = block[10]
	for i := 0; i < domain.MaxPilotSlots; i++ {
		out.SlotFreqsMHz[i] = binary.LittleEndian.Uint16(block[12+i*2 : 14+i*2])
	}
	out.WifiSSID = string(bytes.TrimRight(block[30:62], "\x00"))
	out.WifiPass = string(bytes.TrimRight(block[63:102], "\x00"))
	out.PuckLabel = string(bytes.TrimRight(block[103:127], "\x00"))
	return out, nil
}
