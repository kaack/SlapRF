package ingest

import (
	"encoding/binary"
	"testing"

	"slaprf/internal/domain"
	"slaprf/internal/tracker"
)

func lastChannelTable(t *testing.T, sent [][]byte) [8]uint16 {
	t.Helper()
	if len(sent) == 0 {
		t.Fatal("no channel table sent to the Hub")
	}
	pkt := sent[len(sent)-1]
	var out [8]uint16
	for i := 0; i < 8; i++ {
		out[i] = binary.LittleEndian.Uint16(pkt[2+i*2 : 4+i*2])
	}
	return out
}

func TestBandSurveySweepsRacebandThenRestoresPilotChannels(t *testing.T) {
	eng := tracker.NewRealEngine()
	r := NewHubFrameDecoder(eng)
	var sent [][]byte
	r.SetOutboundSender(func(b []byte) { sent = append(sent, append([]byte(nil), b...)) })

	if err := r.SetSurvey(true); err != nil {
		t.Fatalf("SetSurvey(true): %v", err)
	}
	if !r.SurveyActive() {
		t.Fatal("survey should be active")
	}
	if got := lastChannelTable(t, sent); got != RacebandMHz {
		t.Fatalf("survey table = %v, want Raceband %v", got, RacebandMHz)
	}

	// Pilot edits during a survey must not replace the Raceband table.
	n := len(sent)
	r.OnConfigUpdated(nil, nil)
	if len(sent) != n {
		t.Fatal("pilot config change during a survey sent a new channel table")
	}

	if err := r.SetSurvey(false); err != nil {
		t.Fatalf("SetSurvey(false): %v", err)
	}
	want, _ := eng.ActivePilotChannels()
	if got := lastChannelTable(t, sent); got != want {
		t.Fatalf("restored table = %v, want pilot channels %v", got, want)
	}
}

func TestSilenceRSSIGivesTheEngineNoSignal(t *testing.T) {
	var rssi [domain.MaxPilotPoolSize]float32
	for i := range rssi {
		rssi[i] = -40
	}
	silenceRSSI(&rssi)
	for i, v := range rssi {
		if v != -127 {
			t.Fatalf("rssi[%d] = %v, want -127", i, v)
		}
	}
}
