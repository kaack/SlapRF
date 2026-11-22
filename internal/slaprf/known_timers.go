package slaprf

import (
	"crypto/rand"
	"fmt"
	"sort"
	"strings"
	"sync"

	"slaprf/internal/storage"
)

const (
	kvKnownTimersKey = "hw.known_timers"
	kvHostAuthKey    = "hw.ble_host_key"
)

// KnownHardwareTimer mirrors `KnownHardwareTimer` in the frontend (`#/network` inventory).
type KnownHardwareTimer struct {
	FP          string `json:"fp"`
	Role        string `json:"role"` // "hub" | "spoke"
	Label       string `json:"label"`
	FW          string `json:"fw,omitempty"`
	MAC         string `json:"mac,omitempty"`
	Slot        int    `json:"slot,omitempty"`
	Channel     int    `json:"channel,omitempty"`
	ParentHubFP string `json:"parentHubFp,omitempty"`
	PairedBLE   bool   `json:"pairedBle,omitempty"`
	LastSeenMs  int64  `json:"lastSeenMs"`
}

// KnownTimerRegistry shares the persistent SlapRF timer inventory (`hw.known_timers`) and host
// authentication key across SlapRF transport managers (USB, Bluetooth, and future network links).
type KnownTimerRegistry struct {
	store   *storage.BoltStore
	hostKey string

	mu       sync.RWMutex
	timers   map[string]KnownHardwareTimer
	onChange []func()
	onForget []func(fp string)
}

func isValidHostKey(s string) bool {
	if len(s) != 32 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !((c >= '0' && c <= '9') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

func generateHostKey() string {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "534C41505246424C45484F53544B4559"
	}
	return fmt.Sprintf("%032X", buf[:])
}

// NewKnownTimerRegistry loads persisted SlapRF timers and the host authentication key from `store`.
func NewKnownTimerRegistry(store *storage.BoltStore) *KnownTimerRegistry {
	var hostKey string
	if store != nil {
		var rawKey string
		if ok, err := store.GetJSON(kvHostAuthKey, &rawKey); err == nil && ok {
			hostKey = strings.ToUpper(strings.TrimSpace(rawKey))
		}
	}
	if !isValidHostKey(hostKey) {
		hostKey = generateHostKey()
		if store != nil {
			_ = store.PutJSON(kvHostAuthKey, hostKey)
		}
	}

	r := &KnownTimerRegistry{
		store:   store,
		hostKey: hostKey,
		timers:  make(map[string]KnownHardwareTimer),
	}
	if store != nil {
		var list []KnownHardwareTimer
		if ok, err := store.GetJSON(kvKnownTimersKey, &list); err == nil && ok {
			for _, kt := range list {
				fp := strings.ToUpper(strings.TrimSpace(kt.FP))
				if fp != "" {
					kt.FP = fp
					r.timers[fp] = kt
				}
			}
		}
	}
	return r
}

// HostAuthKey returns this host's persistent 32-hex-character authentication key.
func (r *KnownTimerRegistry) HostAuthKey() string {
	return r.hostKey
}

// OnChange registers a listener notified when the timer inventory changes.
func (r *KnownTimerRegistry) OnChange(fn func()) {
	r.mu.Lock()
	r.onChange = append(r.onChange, fn)
	r.mu.Unlock()
}

// OnForget registers a listener notified when a timer fingerprint is forgotten.
func (r *KnownTimerRegistry) OnForget(fn func(fp string)) {
	r.mu.Lock()
	r.onForget = append(r.onForget, fn)
	r.mu.Unlock()
}

// Get returns the known timer entry for `fp`, if present.
func (r *KnownTimerRegistry) Get(fp string) (KnownHardwareTimer, bool) {
	clean := strings.ToUpper(strings.TrimSpace(fp))
	r.mu.RLock()
	kt, ok := r.timers[clean]
	r.mu.RUnlock()
	return kt, ok
}

// SnapshotFor returns sorted `KnownHardwareTimer` entries relevant to `transportName`.
func (r *KnownTimerRegistry) SnapshotFor(marksBLEPaired bool) []KnownHardwareTimer {
	r.mu.RLock()
	all := make([]KnownHardwareTimer, 0, len(r.timers))
	bleHubFPs := make(map[string]bool)
	for _, kt := range r.timers {
		all = append(all, kt)
		if kt.Role == "hub" && kt.PairedBLE {
			bleHubFPs[strings.ToUpper(kt.FP)] = true
		}
	}
	r.mu.RUnlock()

	out := make([]KnownHardwareTimer, 0, len(all))
	for _, kt := range all {
		if marksBLEPaired {
			if kt.Role == "hub" {
				if kt.PairedBLE {
					out = append(out, kt)
				}
			} else if kt.ParentHubFP == "" || bleHubFPs[strings.ToUpper(kt.ParentHubFP)] {
				out = append(out, kt)
			}
		} else {
			out = append(out, kt)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Role != out[j].Role {
			return out[i].Role == "hub"
		}
		if out[i].Slot != out[j].Slot {
			return out[i].Slot < out[j].Slot
		}
		return out[i].FP < out[j].FP
	})
	return out
}

// Upsert merges and persists a discovered or updated SlapRF hardware timer.
func (r *KnownTimerRegistry) Upsert(entry KnownHardwareTimer) {
	fp := strings.ToUpper(strings.TrimSpace(entry.FP))
	if fp == "" || fp == "00000001" || strings.HasPrefix(fp, "SIM000") || strings.HasPrefix(fp, "53504B") {
		return
	}
	r.mu.Lock()
	prev, hadPrev := r.timers[fp]
	role := entry.Role
	if role == "" {
		if hadPrev && prev.Role != "" {
			role = prev.Role
		} else {
			role = "hub"
		}
	}
	label := entry.Label
	if label == "" {
		if hadPrev && prev.Label != "" {
			label = prev.Label
		} else if role == "hub" {
			label = "H1"
		} else {
			label = "T1"
		}
	}
	fw := entry.FW
	if fw == "" && hadPrev {
		fw = prev.FW
	}
	mac := entry.MAC
	if mac == "" && hadPrev {
		mac = prev.MAC
	}
	slot := entry.Slot
	if slot == 0 && hadPrev {
		slot = prev.Slot
	}
	if slot == 0 && role == "hub" {
		slot = 1
	}
	channel := entry.Channel
	if channel <= 0 {
		if hadPrev && prev.Channel > 0 {
			channel = prev.Channel
		} else {
			channel = 1
		}
	}
	parentHub := strings.ToUpper(strings.TrimSpace(entry.ParentHubFP))
	if parentHub == "" && hadPrev {
		parentHub = prev.ParentHubFP
	}
	if role == "spoke" && slot >= 2 && parentHub == "" {
		var newestHub KnownHardwareTimer
		for _, kt := range r.timers {
			if kt.Role == "hub" && kt.LastSeenMs >= newestHub.LastSeenMs {
				newestHub = kt
			}
		}
		parentHub = newestHub.FP
	}
	if role == "spoke" && slot >= 2 {
		for k, other := range r.timers {
			if k != fp && other.Role == "spoke" && other.Slot == slot && (parentHub == "" || other.ParentHubFP == parentHub) {
				other.Slot = 0
				r.timers[k] = other
			}
		}
	}
	pairedBLE := false
	if role == "hub" {
		parentHub = ""
		pairedBLE = entry.PairedBLE || (hadPrev && prev.PairedBLE)
	}
	merged := KnownHardwareTimer{
		FP:          fp,
		Role:        role,
		Label:       label,
		FW:          fw,
		MAC:         mac,
		Slot:        slot,
		Channel:     channel,
		ParentHubFP: parentHub,
		PairedBLE:   pairedBLE,
		LastSeenMs:  entry.LastSeenMs,
	}
	r.timers[fp] = merged

	list := make([]KnownHardwareTimer, 0, len(r.timers))
	for _, kt := range r.timers {
		list = append(list, kt)
	}
	r.mu.Unlock()

	if r.store != nil {
		_ = r.store.PutJSON(kvKnownTimersKey, list)
	}
}

// ClearBLEPairing clears `PairedBLE` on `fp` when a Hub rejects authentication (re-paired elsewhere).
func (r *KnownTimerRegistry) ClearBLEPairing(fp string) {
	clean := strings.ToUpper(strings.TrimSpace(fp))
	if clean == "" {
		return
	}
	r.mu.Lock()
	kt, ok := r.timers[clean]
	if !ok || !kt.PairedBLE {
		r.mu.Unlock()
		return
	}
	kt.PairedBLE = false
	r.timers[clean] = kt
	list := make([]KnownHardwareTimer, 0, len(r.timers))
	for _, item := range r.timers {
		list = append(list, item)
	}
	cbs := append([]func(){}, r.onChange...)
	r.mu.Unlock()

	if r.store != nil {
		_ = r.store.PutJSON(kvKnownTimersKey, list)
	}
	for _, fn := range cbs {
		fn()
	}
}

// Forget removes `fp` from `BoltStore` and notifies all registered transport managers.
func (r *KnownTimerRegistry) Forget(fp string) {
	clean := strings.ToUpper(strings.TrimSpace(fp))
	if clean == "" {
		return
	}
	r.mu.Lock()
	delete(r.timers, clean)
	list := make([]KnownHardwareTimer, 0, len(r.timers))
	for _, kt := range r.timers {
		list = append(list, kt)
	}
	forgetCbs := append([]func(string){}, r.onForget...)
	changeCbs := append([]func(){}, r.onChange...)
	r.mu.Unlock()

	if r.store != nil {
		_ = r.store.PutJSON(kvKnownTimersKey, list)
	}
	for _, fn := range forgetCbs {
		fn(clean)
	}
	for _, fn := range changeCbs {
		fn()
	}
}
