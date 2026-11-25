package tracker

import (
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"time"
)

// newModelID returns a globally unique, immutable internal model identifier (`mdl-<16 hex>`)
// decoupled from the user-editable display name so renaming, deleting, or importing models
// never collides or breaks active references.
func newModelID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err == nil {
		if v := binary.LittleEndian.Uint64(b[:]); v != 0 {
			return fmt.Sprintf("mdl-%016x", v)
		}
	}
	return fmt.Sprintf("mdl-%016x", uint64(time.Now().UnixNano()))
}

// newFingerprintHex returns a random, non-zero 8-hex-digit board fingerprint (used for
// simulated timers and for boards provisioned without one).
func newFingerprintHex() string {
	var b [4]byte
	for {
		if _, err := rand.Read(b[:]); err != nil {
			return "51A9F00D"
		}
		if fp := binary.LittleEndian.Uint32(b[:]); fp != 0 {
			return fmt.Sprintf("%08X", fp)
		}
	}
}

// RegisterTimerHello maps a timer announced by the Hub (fingerprint + name) to its
// stable app-side timer ID, creating the timer the first time a fingerprint is seen.
// The Hub's own short TDMA slot number is translated to this ID by the ingest layer.
func (e *Engine) RegisterTimerHello(fingerprint string, isHub bool, label string) (uint8, error) {
	role := "spoke"
	if isHub {
		role = "hub"
	}
	return e.ProvisionGate(ProvisionRequest{
		Role:         role,
		Label:        label,
		Fingerprint:  fingerprint,
		FromHubHello: true,
	})
}
