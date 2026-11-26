package firmware

import (
	"testing"

	"slaprf/internal/domain"
)

func TestImageNameFor(t *testing.T) {
	cases := []struct {
		role uint8
		link HubLink
		want string
	}{
		{RoleHubTimer, HubLinkUSB, ImageName},
		{RoleHubTimer, HubLinkBLE, BLEImageName},
		{RoleSpokeTimer, HubLinkUSB, ImageName},
		{RoleSpokeTimer, HubLinkBLE, ImageName}, // Spokes never get the BLE image
	}
	for _, c := range cases {
		if got := ImageNameFor(c.role, c.link); got != c.want {
			t.Errorf("ImageNameFor(%d, %q) = %q, want %q", c.role, c.link, got, c.want)
		}
	}
	if BLEImageName != "slaprf-xiao-c5-ble.bin" || ImageName != "slaprf-xiao-c5.bin" || PoEBridgeImageName != "slaprf-p4-poe-bridge.bin" {
		t.Fatalf("unexpected image names %q / %q / %q", ImageName, BLEImageName, PoEBridgeImageName)
	}
	names := ImageNames()
	if len(names) != 3 || names[0] != ImageName || names[1] != BLEImageName || names[2] != PoEBridgeImageName {
		t.Fatalf("ImageNames() = %v", names)
	}
}

func TestParseHubLink(t *testing.T) {
	for in, want := range map[string]HubLink{
		"ble": HubLinkBLE, "BLE": HubLinkBLE, " bluetooth ": HubLinkBLE,
		"usb": HubLinkUSB, "": HubLinkUSB, "wifi": HubLinkUSB,
	} {
		if got := ParseHubLink(in); got != want {
			t.Errorf("ParseHubLink(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestPatchImageForLinkForcesHubOnBLE(t *testing.T) {
	cfg := TimerConfig{Role: RoleSpokeTimer, Fingerprint: 0x01020304, TimerLabel: "T3"}
	built, err := PatchImageForLink(SyntheticBase(), cfg, HubLinkBLE)
	if err != nil {
		t.Fatalf("PatchImageForLink BLE: %v", err)
	}
	parsed, err := InspectConfig(built.Bytes)
	if err != nil {
		t.Fatalf("InspectConfig: %v", err)
	}
	if parsed.Role != RoleHubTimer {
		t.Fatalf("BLE image role = %d, want Hub", parsed.Role)
	}
	if parsed.Fingerprint != 0x01020304 {
		t.Fatalf("fingerprint = %08X", parsed.Fingerprint)
	}
	if want := "slaprf-xiao-c5-ble-hub-" + domain.LatestFirmwareVersion + ".bin"; built.Filename != want {
		t.Fatalf("filename = %q, want %q", built.Filename, want)
	}

	usb, err := PatchImageForLink(SyntheticBase(), cfg, HubLinkUSB)
	if err != nil {
		t.Fatalf("PatchImageForLink USB: %v", err)
	}
	if p, _ := InspectConfig(usb.Bytes); p.Role != RoleSpokeTimer {
		t.Fatalf("USB spoke image role = %d, want Spoke", p.Role)
	}
	if want := "slaprf-xiao-c5-spoke-" + domain.LatestFirmwareVersion + ".bin"; usb.Filename != want {
		t.Fatalf("USB filename = %q, want %q", usb.Filename, want)
	}
}
