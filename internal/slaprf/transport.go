package slaprf

import (
	"context"
	"errors"
	"time"

	"slaprf/internal/firmware"
	"slaprf/internal/serialport"
)

const MaxConnections = 3

// ErrConnectCancelled indicates an in-flight connection attempt was cancelled by the user or mode switch.
var ErrConnectCancelled = errors.New("connection cancelled")

// PortInfo describes an enumerated SlapRF timing device endpoint (USB port, BLE Hub, or network node).
type PortInfo = serialport.PortInfo

// FingerprintObserver is an optional interface implemented by transport streams (such as Bluetooth LE)
// whose initial discovery address may resolve to a canonical 8-hex hardware fingerprint after STATUS?.
type FingerprintObserver interface {
	NoteConnectedFingerprint(fp string)
}

// Traits declares transport-specific link behavior so `Manager` speaks the identical SlapRF wire and
// console protocol across USB-C serial, Bluetooth LE, and future network transports without transport conditionals.
type Traits struct {
	PersistTargetsKey          string
	DisplayName                string
	InitialConnectStatus       string
	ProbeStatus                string
	DisconnectedError          string
	LostAfterRetriesError      string
	DefaultAuthMismatchMessage string
	ProbeTimeout               time.Duration
	ProbeReplyTimeout          time.Duration
	SupportsROMBootloaderReset bool
	SynthesizeLiveFromBinary   bool
	MarksBLEPaired             bool
	UnpairCommand              string
	DefaultSweepHz             int
	DefaultSweepUs             int
	DefaultSweepUsMax          int
	DefaultSweepBudgetUs       int
	HandshakePrefix            func(hostAuthKey string) string
	SynthesizedStatusExtras    func(prev map[string]any) map[string]any
}

// Transport abstracts a physical communication mechanism (USB serial, Bluetooth LE, TCP/UDP network)
// carrying SlapRF `0x1E`+`0xC5` binary telemetry frames, `SLAPRF02` config readouts, and `@JSON` console lines.
type Transport interface {
	Name() string
	Traits() Traits
	ValidateTarget(raw string) (normalized string, err error)
	TargetFingerprint(target string) (fp string, ok bool)
	CanonicalTarget(fp string) string
	Discover(ctx context.Context, showAll bool) ([]PortInfo, error)
	Open(ctx context.Context, target string, onProgress func(stage string)) (firmware.SerialPort, error)
}
