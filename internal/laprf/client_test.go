package laprf_test

import (
	"math"
	"net"
	"sync"
	"testing"
	"time"

	"slaprf/internal/domain"
	"slaprf/internal/laprf"
	"slaprf/internal/tracker"
)

func TestClientAgainstServerOverPipe(t *testing.T) {
	puckEngine := tracker.NewEngine()
	puckServer := laprf.NewServer(puckEngine)

	srvConn, cliConn := net.Pipe()
	defer srvConn.Close()
	defer cliConn.Close()

	go puckServer.ServeConn(srvConn)

	var mu sync.Mutex
	var gotStatuses []laprf.ClientStatusEvent
	var gotPassings []laprf.ClientPassingEvent

	boot := time.Now().Add(-5 * time.Second)
	hostNowUs := func() uint64 {
		return uint64(time.Since(boot).Microseconds())
	}

	client := laprf.NewClient(laprf.ClientHooks{
		NowUs: hostNowUs,
		OnStatus: func(ev laprf.ClientStatusEvent) {
			mu.Lock()
			gotStatuses = append(gotStatuses, ev)
			mu.Unlock()
		},
		OnPassing: func(ev laprf.ClientPassingEvent) {
			mu.Lock()
			gotPassings = append(gotPassings, ev)
			mu.Unlock()
		},
	})
	go client.RunConn(cliConn)

	// Push 8-slot RF setup and arm the puck
	var slots [domain.MaxPilotSlots]laprf.SlotRFConfig
	slots[0] = laprf.SlotRFConfig{
		Enabled:      true,
		Band:         domain.BandRaceband,
		Channel:      1,
		FrequencyMHz: 5658,
		Threshold:    950,
		Gain:         59,
	}
	slots[1] = laprf.SlotRFConfig{
		Enabled:      true,
		Band:         domain.BandRaceband,
		Channel:      3,
		FrequencyMHz: 5732,
		Threshold:    820,
		Gain:         58,
	}
	client.SyncRFSetup(slots)
	client.SyncSettings(4000, 100)
	client.SetArmed(true)

	// Wait for dual-sample RTC sync + at least one 10 Hz STATUS heartbeat
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		st, _, _ := client.Snapshot()
		mu.Lock()
		nStatus := len(gotStatuses)
		mu.Unlock()
		if st.RTCSynced && nStatus > 0 {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}

	st, _, _ := client.Snapshot()
	if !st.RTCSynced {
		t.Fatalf("expected client RTC clock to synchronize with laprf.Server")
	}
	if st.VoltageMv < 11500 {
		t.Fatalf("expected valid voltageMv from laprf.Server, got %d", st.VoltageMv)
	}
	if !st.GateArmed {
		t.Fatalf("expected GateArmed=true in status")
	}

	// Verify RF setup reached puckEngine
	pilots, _, _, _, _ := puckEngine.StateSnapshot()
	if len(pilots) < 2 || !pilots[0].Enabled || pilots[0].FrequencyMHz != 5658 || !pilots[1].Enabled || pilots[1].FrequencyMHz != 5732 {
		t.Fatalf("RF setup did not apply to puckEngine: %+v", pilots[:2])
	}

	// Emit a Start/Finish crossing from puckServer and verify client receives mapped HostTimeUs
	beforeHostUs := hostNowUs()
	puckNowUs := puckEngine.NowUs()
	puckServer.OnGateCrossing(domain.GateCrossingEvent{
		IsStartFinish:   true,
		SlotIndex:       2,
		TimestampUs:     puckNowUs,
		PassingNumber:   7,
		LapRFPeakHeight: 1840,
	})

	deadline = time.Now().Add(1 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		nPass := len(gotPassings)
		mu.Unlock()
		if nPass > 0 {
			break
		}
		time.Sleep(15 * time.Millisecond)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(gotPassings) != 1 {
		t.Fatalf("expected 1 passing event, got %d", len(gotPassings))
	}
	p := gotPassings[0]
	if p.SlotIndex != 2 || p.PassingNumber != 7 || p.PeakHeight != 1840 {
		t.Fatalf("unexpected passing event fields: %+v", p)
	}
	diffMs := math.Abs(float64(int64(p.HostTimeUs)-int64(beforeHostUs))) / 1000.0
	if diffMs > 50.0 {
		t.Fatalf("mapped HostTimeUs drifted by %.2f ms (got %d vs host %d)", diffMs, p.HostTimeUs, beforeHostUs)
	}
}
