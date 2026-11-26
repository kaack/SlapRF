package firmware

import (
	"fmt"
	"strings"
)

// SlapRF ships one firmware (firmware/slaprf) with one tuned configuration: every timer, Hub or
// Spoke, runs the same compiled image; only the SLAPRF02 config block differs per board.
//
// A Hub can alternatively run the Bluetooth Hub image (firmware/slaprf_ble), which carries the
// same Hub byte stream over BLE instead of the USB cable (see docs/ble-hub-protocol.md). It has
// the same flash layout and the same SLAPRF02 block, so it is patched by the same code.

const (
	// ImageName is the merged ESP-IDF flash image (bootloader + partition table + app) built from
	// firmware/slaprf and served to the browser flasher as web/firmware/<ImageName>.
	ImageName = "slaprf-xiao-c5.bin"

	// BLEImageName is the merged Bluetooth Hub flash image built from firmware/slaprf_ble and
	// served as web/firmware/<BLEImageName>. It is optional: when it has not been built the
	// flasher shows the Bluetooth option disabled.
	BLEImageName = "slaprf-xiao-c5-ble.bin"

	// PoEBridgeImageName is the merged ESP32-P4 PoE Ethernet <-> USB Host bridge image built
	// from firmware/slaprf_p4_poe_bridge and served as web/firmware/<PoEBridgeImageName>.
	PoEBridgeImageName = "slaprf-p4-poe-bridge.bin"

	// SweepHz is the 5.8 GHz sweep rate compiled into the firmware (SWEEP_HZ in main.c).
	SweepHz = 100

	// MaxWindowSamples bounds the sliding-window frame size the laptop ingest accepts.
	MaxWindowSamples = 6
)

// HubLink is how a Hub timer talks to the host: over the USB cable (default image) or over
// Bluetooth LE (dedicated BLE image). Spokes always use the USB image.
type HubLink string

const (
	HubLinkUSB HubLink = "usb"
	HubLinkBLE HubLink = "ble"
)

// ParseHubLink maps a user / API string to a HubLink. Anything unknown is USB.
func ParseHubLink(s string) HubLink {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "ble", "bluetooth":
		return HubLinkBLE
	default:
		return HubLinkUSB
	}
}

// ImageNames lists every firmware image file the web flasher may serve, USB image first.
func ImageNames() []string {
	return []string{ImageName, BLEImageName, PoEBridgeImageName}
}

// ImageNameFor returns the firmware image file for a timer role and Hub link. Spokes always get
// the USB image; only a Hub with HubLinkBLE gets the Bluetooth image.
func ImageNameFor(role uint8, link HubLink) string {
	if role == RoleHubTimer && link == HubLinkBLE {
		return BLEImageName
	}
	return ImageName
}

// PatchImageForLink is PatchImage for a specific Hub link. For HubLinkBLE the role is forced to
// Hub (the BLE image only runs as a Hub) and the download filename is tagged "-ble-".
func PatchImageForLink(base []byte, cfg TimerConfig, link HubLink) (*BuiltImage, error) {
	if link != HubLinkBLE {
		return PatchImage(base, cfg)
	}
	cfg.Role = RoleHubTimer
	built, err := PatchImage(base, cfg)
	if err != nil {
		return nil, err
	}
	built.Filename = fmt.Sprintf("slaprf-xiao-c5-ble-hub-%s.bin", built.Config.FirmwareVersion)
	return built, nil
}
