package usb

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

// Config configures the physical SlapRF USB-C serial transport.
type Config struct {
	OpenPort  firmware.SerialOpener
	ListPorts serialport.Lister
}

// Transport implements `slaprf.Transport` over physical OS or Android JNI USB-C serial ports.
type Transport struct {
	openPort firmware.SerialOpener
	listFn   serialport.Lister
}

// NewTransport constructs a SlapRF USB-C serial transport.
func NewTransport(cfg Config) *Transport {
	opener := cfg.OpenPort
	if opener == nil {
		opener = serialport.DefaultOpener
	}
	lister := cfg.ListPorts
	if lister == nil {
		lister = serialport.DefaultListPorts
	}
	return &Transport{
		openPort: opener,
		listFn:   lister,
	}
}

func (t *Transport) Name() string { return "usb" }

func (t *Transport) Traits() slaprf.Traits {
	return slaprf.Traits{
		PersistTargetsKey:          "hw.usb_targets",
		DisplayName:                "USB timer",
		InitialConnectStatus:       "Opening USB serial port…",
		ProbeStatus:                "Reading timer status…",
		DisconnectedError:          "USB disconnected",
		LostAfterRetriesError:      "Lost USB connection after 5 reconnect attempts.",
		ProbeTimeout:               1200 * time.Millisecond,
		ProbeReplyTimeout:          450 * time.Millisecond,
		SupportsROMBootloaderReset: true,
		DefaultSweepHz:             100,
		DefaultSweepUs:             6100,
		DefaultSweepUsMax:          6650,
		DefaultSweepBudgetUs:       7000,
	}
}

func (t *Transport) ValidateTarget(raw string) (string, error) {
	p := strings.TrimSpace(raw)
	if p == "" {
		return "", errors.New("missing USB serial port name")
	}
	if strings.HasPrefix(strings.ToLower(p), "ble:") {
		return "", errors.New("Bluetooth devices must use /v1/slaprf/bluetooth/connections")
	}
	return p, nil
}

func (t *Transport) TargetFingerprint(string) (string, bool) { return "", false }

func (t *Transport) CanonicalTarget(string) string { return "" }

func (t *Transport) Discover(_ context.Context, showAll bool) ([]slaprf.PortInfo, error) {
	ports, err := t.listFn()
	if err != nil {
		return nil, err
	}
	return serialport.FilterUSBPorts(ports, showAll), nil
}

func (t *Transport) Open(ctx context.Context, target string, onProgress func(string)) (firmware.SerialPort, error) {
	norm, err := t.ValidateTarget(target)
	if err != nil {
		return nil, err
	}
	if onProgress != nil {
		onProgress("Opening USB serial port…")
	}
	p, err := serialport.OpenContext(ctx, t.openPort, norm, 115200)
	if errors.Is(err, serialport.ErrOpenCancelled) {
		return nil, slaprf.ErrConnectCancelled
	}
	return p, err
}

// OpenRawPort opens an exclusive raw byte-stream handle to `portName` for the ROM Bootloader
// Flasher (`/v1/ws/slaprf/usb-raw`), releasing any live `slaprf.Manager` slot holding that port first.
func (t *Transport) OpenRawPort(mgr *slaprf.Manager, portName string, baud int) (firmware.SerialPort, slaprf.PortInfo, error) {
	portName = strings.TrimSpace(portName)
	if portName == "" {
		return nil, slaprf.PortInfo{}, fmt.Errorf("missing USB port name")
	}
	if strings.HasPrefix(strings.ToLower(portName), "ble:") {
		return nil, slaprf.PortInfo{}, fmt.Errorf("Bluetooth devices cannot be flashed over /v1/ws/slaprf/usb-raw")
	}
	if baud <= 0 {
		baud = 115200
	}

	var resolvedInfo slaprf.PortInfo
	resolvedName := portName
	if ports, err := t.Discover(context.Background(), true); err == nil {
		var espPorts []slaprf.PortInfo
		foundExact := false
		for _, pi := range ports {
			if pi.IsEspressif {
				espPorts = append(espPorts, pi)
			}
			if strings.EqualFold(pi.Name, portName) {
				resolvedInfo = pi
				resolvedName = pi.Name
				foundExact = true
			}
		}
		if !foundExact && (strings.EqualFold(portName, "auto:espressif") || strings.HasPrefix(portName, "/dev/bus/usb/")) && len(espPorts) == 1 {
			resolvedInfo = espPorts[0]
			resolvedName = espPorts[0].Name
		}
	}
	if resolvedInfo.Name == "" {
		resolvedInfo.Name = resolvedName
	}

	if mgr != nil {
		mgr.ReleasePort(portName, resolvedName)
	}

	p, err := t.openPort(resolvedName, baud)
	if err != nil {
		return nil, resolvedInfo, err
	}
	return p, resolvedInfo, nil
}
