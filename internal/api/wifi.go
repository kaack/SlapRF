package api

import (
	"context"
	"net/http"
	"os/exec"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

// WifiNetwork describes a visible or saved Wi-Fi network on the host computer.
type WifiNetwork struct {
	SSID      string `json:"ssid"`
	SignalPct int    `json:"signalPct,omitempty"`
	Connected bool   `json:"connected,omitempty"`
	Saved     bool   `json:"saved,omitempty"`
}

func (s *Server) handleWifiNetworks(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()

	networks := scanHostWifiNetworks(ctx)
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"networks": networks,
	})
}

func scanHostWifiNetworks(ctx context.Context) []WifiNetwork {
	if runtime.GOOS != "windows" {
		return nil
	}
	var ifaceOut, netOut, profOut string
	if b, err := exec.CommandContext(ctx, "netsh", "wlan", "show", "interfaces").Output(); err == nil {
		ifaceOut = string(b)
	}
	if b, err := exec.CommandContext(ctx, "netsh", "wlan", "show", "networks", "mode=bssid").Output(); err == nil {
		netOut = string(b)
	}
	if b, err := exec.CommandContext(ctx, "netsh", "wlan", "show", "profiles").Output(); err == nil {
		profOut = string(b)
	}
	return parseNetshWifi(ifaceOut, netOut, profOut)
}

// parseNetshWifi merges `netsh wlan show interfaces`, `show networks mode=bssid`, and
// `show profiles` into a deduplicated list ordered by: Connected first, then Saved, then
// strongest SignalPct.
func parseNetshWifi(interfacesOut, networksOut, profilesOut string) []WifiNetwork {
	bySSID := make(map[string]*WifiNetwork)
	ensure := func(ssid string) *WifiNetwork {
		ssid = strings.TrimSpace(ssid)
		if ssid == "" {
			return nil
		}
		n, ok := bySSID[ssid]
		if !ok {
			n = &WifiNetwork{SSID: ssid}
			bySSID[ssid] = n
		}
		return n
	}

	// 1. Parse currently connected SSID from `netsh wlan show interfaces`
	var stateConnected bool
	var candidateSSID string
	for _, raw := range strings.Split(interfacesOut, "\n") {
		line := strings.TrimSpace(raw)
		if k, v, ok := splitColon(line); ok {
			switch strings.ToLower(k) {
			case "state":
				stateConnected = strings.EqualFold(v, "connected")
			case "ssid":
				candidateSSID = v
			}
		}
	}
	if stateConnected && candidateSSID != "" {
		if n := ensure(candidateSSID); n != nil {
			n.Connected = true
			n.Saved = true
		}
	}

	// 2. Parse saved user profiles from `netsh wlan show profiles`
	for _, raw := range strings.Split(profilesOut, "\n") {
		line := strings.TrimSpace(raw)
		if k, v, ok := splitColon(line); ok {
			if strings.Contains(strings.ToLower(k), "profile") && v != "<None>" {
				if n := ensure(v); n != nil {
					n.Saved = true
				}
			}
		}
	}

	// 3. Parse visible networks & signal strength from `netsh wlan show networks mode=bssid`
	var current *WifiNetwork
	for _, raw := range strings.Split(networksOut, "\n") {
		line := strings.TrimSpace(raw)
		if k, v, ok := splitColon(line); ok {
			kl := strings.ToLower(k)
			if strings.HasPrefix(kl, "ssid ") {
				current = ensure(v)
			} else if kl == "signal" && current != nil {
				pctStr := strings.TrimSuffix(v, "%")
				if pct, err := strconv.Atoi(strings.TrimSpace(pctStr)); err == nil && pct > current.SignalPct {
					current.SignalPct = pct
				}
			}
		}
	}

	out := make([]WifiNetwork, 0, len(bySSID))
	for _, n := range bySSID {
		out = append(out, *n)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Connected != out[j].Connected {
			return out[i].Connected
		}
		if out[i].Saved != out[j].Saved {
			return out[i].Saved
		}
		if out[i].SignalPct != out[j].SignalPct {
			return out[i].SignalPct > out[j].SignalPct
		}
		return strings.ToLower(out[i].SSID) < strings.ToLower(out[j].SSID)
	})
	return out
}

func splitColon(line string) (string, string, bool) {
	idx := strings.IndexByte(line, ':')
	if idx < 0 {
		return "", "", false
	}
	return strings.TrimSpace(line[:idx]), strings.TrimSpace(line[idx+1:]), true
}
