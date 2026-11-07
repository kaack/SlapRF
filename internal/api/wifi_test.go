package api

import "testing"

func TestParseNetshWifi(t *testing.T) {
	iface := `
    Name                   : Wi-Fi
    State                  : connected
    SSID                   : PilotHotspot
`
	profiles := `
User profiles
-------------
    All User Profile     : HomeWiFi
    All User Profile     : PilotHotspot
`
	networks := `
SSID 1 : NeighborNet
    Signal             : 92%

SSID 2 : 
    Signal             : 80%

SSID 3 : HomeWiFi
    Signal             : 64%

SSID 4 : PilotHotspot
    Signal             : 88%
`

	got := parseNetshWifi(iface, networks, profiles)
	if len(got) != 3 {
		t.Fatalf("expected 3 networks, got %d: %+v", len(got), got)
	}
	if got[0].SSID != "PilotHotspot" || !got[0].Connected || got[0].SignalPct != 88 {
		t.Fatalf("expected PilotHotspot first (connected, 88%%), got %+v", got[0])
	}
	if got[1].SSID != "HomeWiFi" || !got[1].Saved || got[1].SignalPct != 64 {
		t.Fatalf("expected HomeWiFi second (saved, 64%%), got %+v", got[1])
	}
	if got[2].SSID != "NeighborNet" || got[2].SignalPct != 92 {
		t.Fatalf("expected NeighborNet third (92%%), got %+v", got[2])
	}
}
