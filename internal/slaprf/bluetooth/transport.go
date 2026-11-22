package bluetooth

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"slaprf/internal/firmware"
	"slaprf/internal/serialport"
	"slaprf/internal/slaprf"
)

// Config configures the SlapRF Bluetooth LE Hub transport.
type Config struct {
	OpenPort  firmware.SerialOpener
	ListPorts serialport.Lister
}

// Transport implements `slaprf.Transport` over Bluetooth LE GATT (`5d1a0001-...`).
type Transport struct {
	openPort     firmware.SerialOpener
	customOpener bool
	listFn       serialport.Lister
}

// NewTransport constructs a SlapRF Bluetooth LE Hub transport.
func NewTransport(cfg Config) *Transport {
	customOpener := cfg.OpenPort != nil
	opener := cfg.OpenPort
	if opener == nil {
		opener = bleOpenPort
	}
	lister := cfg.ListPorts
	if lister == nil {
		lister = bleListPorts
	}
	return &Transport{
		openPort:     opener,
		customOpener: customOpener,
		listFn:       lister,
	}
}

func (t *Transport) Name() string { return "ble" }

func (t *Transport) Traits() slaprf.Traits {
	return slaprf.Traits{
		PersistTargetsKey:          "hw.ble_targets",
		DisplayName:                "Bluetooth Hub",
		InitialConnectStatus:       "Waiting for Bluetooth LE connection…",
		ProbeStatus:                "Reading Hub status…",
		DisconnectedError:          "Bluetooth Hub disconnected",
		LostAfterRetriesError:      "Lost Bluetooth Hub connection after 5 reconnect attempts.",
		DefaultAuthMismatchMessage: "Hub is paired to another device. Hold BOOT for 3 s on the Hub to pair with this device.",
		ProbeTimeout:               2400 * time.Millisecond,
		ProbeReplyTimeout:          1200 * time.Millisecond,
		SupportsROMBootloaderReset: false,
		SynthesizeLiveFromBinary:   true,
		MarksBLEPaired:             true,
		UnpairCommand:              "BLEPAIR CLEAR",
		DefaultSweepHz:             50,
		DefaultSweepUs:             5400,
		DefaultSweepUsMax:          5900,
		DefaultSweepBudgetUs:       6000,
		HandshakePrefix: func(hostAuthKey string) string {
			return fmt.Sprintf("AUTH %s\nBLESYNC 1\n", hostAuthKey)
		},
		SynthesizedStatusExtras: func(prev map[string]any) map[string]any {
			out := map[string]any{
				"image":     "ble",
				"transport": "ble",
			}
			if prev != nil {
				if prevBle, ok := prev["ble"].(map[string]any); ok && prevBle != nil {
					out["ble"] = prevBle
				}
			}
			if _, hasBle := out["ble"]; !hasBle {
				out["ble"] = map[string]any{
					"connected":   true,
					"paired":      true,
					"pairingMode": false,
					"intervalUs":  15000,
					"mtu":         247,
					"phy":         2,
					"rssi":        0,
					"txNotifies":  0,
					"txBytes":     0,
					"txDrops":     0,
					"rxWrites":    0,
					"nocp":        0,
					"connects":    1,
					"sync":        true,
					"syncLocked":  false,
					"phaseUs":     -1,
				}
			}
			return out
		},
	}
}

// ValidateTarget normalizes `ble:<8-hex-FP>` (or bare `<8-hex-FP>`) and rejects USB serial ports.
func (t *Transport) ValidateTarget(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", errors.New("missing Bluetooth device identifier")
	}
	if fp, ok := ParseBLEPortName(s); ok {
		return BLEPortPrefix + fp, nil
	}
	if fp, ok := ParseBLEPortName(BLEPortPrefix + s); ok {
		return BLEPortPrefix + fp, nil
	}
	return "", errors.New("Bluetooth connections require a ble:<FP> device identifier; use /v1/usb/connections for USB serial ports")
}

func (t *Transport) TargetFingerprint(target string) (string, bool) {
	return ParseBLEPortName(target)
}

func (t *Transport) CanonicalTarget(fp string) string {
	parsed, ok := ParseBLEPortName(BLEPortPrefix + strings.TrimSpace(fp))
	if !ok {
		return ""
	}
	return BLEPortPrefix + parsed
}

func (t *Transport) Discover(_ context.Context, _ bool) ([]slaprf.PortInfo, error) {
	ports, err := t.listFn()
	if err != nil {
		return nil, err
	}
	out := make([]slaprf.PortInfo, 0, len(ports))
	for _, p := range ports {
		if IsBLEPortName(p.Name) {
			if p.Transport == "" {
				p.Transport = BLETransportName
			}
			out = append(out, p)
		}
	}
	serialport.SortPorts(out)
	return out, nil
}

func (t *Transport) Open(ctx context.Context, target string, onProgress func(string)) (firmware.SerialPort, error) {
	norm, err := t.ValidateTarget(target)
	if err != nil {
		return nil, err
	}
	if !t.customOpener {
		return bleOpenPortContext(ctx, norm, 115200, onProgress)
	}
	if onProgress != nil {
		onProgress("Waiting for Bluetooth LE connection…")
	}
	p, err := serialport.OpenContext(ctx, t.openPort, norm, 115200)
	if errors.Is(err, serialport.ErrOpenCancelled) {
		return nil, slaprf.ErrConnectCancelled
	}
	return p, err
}
