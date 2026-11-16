package rotorhazard

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"slaprf/internal/domain"
)

func TestSerialClientHandshakeBootChatterAndMultiSeatCrossings(t *testing.T) {
	var fakeClockUs atomic.Uint64
	fakeClockUs.Store(10_000_000) // 10.0s monotonic start

	simNode := NewSimSerialNode(SimSerialNodeConfig{
		SeatCount:  8,
		APILevel:   36,
		FwVersion:  "FPVGateC5 1.2",
		ProcType:   "ESP32-C5",
		BootBanner: []byte("ESP-ROM:esp32c5-2024\r\nFPVGate Scanner Ready...\r\n"),
		NowUs:      fakeClockUs.Load,
	})
	// Pre-seed seat 0 with a non-zero lap_id (42) to verify connect latching emits NO phantom crossing!
	simNode.SetSeatLapState(0, 42, 188, 5_000_000)

	var hostPortRef *MemSerialPort
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var mu sync.Mutex
	var passes []ClientPassEvent
	var heartbeats int

	client := NewSerialClient(SerialClientConfig{
		PortName:      "SIM-RH-USB1",
		BaudRate:      0, // Auto-negotiate (115200)
		PollInterval:  15 * time.Millisecond,
		BootTimeout:   800 * time.Millisecond,
		ReadTimeout:   80 * time.Millisecond,
		RxSettleDelay: 1 * time.Millisecond,
		OpenPort: func(portName string, baud int) (SerialPort, error) {
			if portName != "SIM-RH-USB1" {
				return nil, fmt.Errorf("unexpected port %s", portName)
			}
			hp, dp := NewInMemorySerialPair()
			hostPortRef = hp
			go func() {
				_ = simNode.Serve(dp)
			}()
			return hp, nil
		},
		Hooks: ClientHooks{
			NowUs: fakeClockUs.Load,
			OnHeartbeat: func(ev ClientHeartbeatEvent) {
				mu.Lock()
				heartbeats++
				mu.Unlock()
			},
			OnPass: func(ev ClientPassEvent) {
				mu.Lock()
				passes = append(passes, ev)
				mu.Unlock()
			},
		},
	})

	readyCh := make(chan error, 1)
	doneCh := make(chan error, 1)
	go func() {
		doneCh <- client.RunOnce(ctx, func(err error) {
			readyCh <- err
		})
	}()

	select {
	case err := <-readyCh:
		if err != nil {
			t.Fatalf("SerialClient handshake failed: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for SerialClient handshake")
	}

	dtr, rts := hostPortRef.DTRRTS()
	if dtr || rts {
		t.Fatalf("expected DTR=false and RTS=false on RotorHazard USB port, got DTR=%v RTS=%v", dtr, rts)
	}

	snap := client.Snapshot()
	if !snap.Connected || !snap.AuthOK || snap.APILevel != 36 || snap.NodeCount != 8 || snap.BaudRate != 115200 {
		t.Fatalf("unexpected SerialClient snapshot: %+v", snap)
	}

	// Program Seat 0 (R1 5658 MHz, 110/80) and Seat 1 (R2 5695 MHz, 105/75); seats 2..7 disabled (1111 MHz)
	var nodes [domain.MaxPilotSlots]NodeConfig
	nodes[0] = NodeConfig{Enabled: true, Band: domain.BandRaceband, Channel: 1, FrequencyMHz: 5658, EnterAtLevel: 110, ExitAtLevel: 80}
	nodes[1] = NodeConfig{Enabled: true, Band: domain.BandRaceband, Channel: 2, FrequencyMHz: 5695, EnterAtLevel: 105, ExitAtLevel: 75}
	client.SyncNodesAndArm(nodes, true)

	// Wait until SimSerialNode reflects programmed frequencies and at least 2 poll cycles run
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		f0, en0, ex0 := simNode.SeatConfig(0)
		f2, _, _ := simNode.SeatConfig(2)
		mu.Lock()
		hb := heartbeats
		mu.Unlock()
		if f0 == 5658 && en0 == 110 && ex0 == 80 && f2 == SeatDisabledFreqMHz && hb >= 2 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	f0, en0, ex0 := simNode.SeatConfig(0)
	f2, _, _ := simNode.SeatConfig(2)
	if f0 != 5658 || en0 != 110 || ex0 != 80 || f2 != SeatDisabledFreqMHz {
		t.Fatalf("unexpected programmed node state: seat0=(%d,%d,%d) seat2=%d", f0, en0, ex0, f2)
	}

	mu.Lock()
	if len(passes) != 0 {
		t.Fatalf("expected 0 passes after initial latch of lap_id=42, got %+v", passes)
	}
	mu.Unlock()
	if !simNode.IsRHModeActive() {
		t.Fatal("expected SimSerialNode RH mode active within 5s keepalive window")
	}

	// Simulate crossing #1 on Seat 0 with peak at t = 15,000,000 us, and poll 45 ms later (15,045,000 us)
	fakeClockUs.Store(14_950_000)
	simNode.FeedSeatRSSI(0, 125, 14_950_000) // Enter (>= 110)
	fakeClockUs.Store(15_000_000)
	simNode.FeedSeatRSSI(0, 212, 15_000_000) // Peak = 212 at 15.000s
	fakeClockUs.Store(15_020_000)
	simNode.FeedSeatRSSI(0, 68, 15_020_000) // Exit (<= 80) -> completes pass!
	fakeClockUs.Store(15_045_000)           // 45 ms after peak -> passAgeMs = 45

	deadline = time.Now().Add(1 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		n := len(passes)
		mu.Unlock()
		if n >= 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	mu.Lock()
	if len(passes) != 1 {
		mu.Unlock()
		t.Fatalf("expected 1 crossing pass on seat 0, got %d", len(passes))
	}
	p1 := passes[0]
	mu.Unlock()

	if p1.SlotIndex != 1 || p1.FrequencyMHz != 5658 || p1.PeakRSSI != 212 {
		t.Fatalf("unexpected pass #1 payload: %+v", p1)
	}
	// Timestamp should subtract passAgeMs (45,000 us) from 15,045,000 us -> ~15,000,000 us!
	diffUs := int64(p1.HostTimeUs) - 15_000_000
	if diffUs < -5_000 || diffUs > 5_000 {
		t.Fatalf("expected passAgeMs-compensated HostTimeUs ~15_000_000, got %d (diff %d us)", p1.HostTimeUs, diffUs)
	}

	// Test u8 wraparound (`255 -> 0`) on Seat 1!
	simNode.SetSeatLapState(1, 255, 180, 14_000_000)
	// Let one poll cycle latch 255 (or advance from 0 -> 255 -> 0): wait for pass to settle, then wrap 255 -> 0
	time.Sleep(45 * time.Millisecond)
	mu.Lock()
	passesBeforeWrap := len(passes)
	mu.Unlock()

	fakeClockUs.Store(20_000_000)
	simNode.FeedSeatRSSI(1, 130, 19_960_000)
	simNode.FeedSeatRSSI(1, 199, 20_000_000) // Peak at 20.000s
	simNode.FeedSeatRSSI(1, 60, 20_030_000)  // Exit -> wraps lapID 255 -> 0!
	fakeClockUs.Store(20_030_000)

	deadline = time.Now().Add(1 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		n := len(passes)
		mu.Unlock()
		if n > passesBeforeWrap {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	mu.Lock()
	lastPass := passes[len(passes)-1]
	mu.Unlock()
	if lastPass.SlotIndex != 2 || lastPass.PeakRSSI != 199 {
		t.Fatalf("expected wraparound pass (255->0) on Seat 2 with peak 199, got %+v", lastPass)
	}

	cancel()
	<-doneCh
}

func TestSerialClientBaudFallback921600AndLegacyAPI28(t *testing.T) {
	var clockUs atomic.Uint64
	clockUs.Store(5_000_000)

	// Emulate an STM32 BluePill node running at 921600 baud with legacy API 28 (`READ_LAP_STATS` 0x05)
	simNode := NewSimSerialNode(SimSerialNodeConfig{
		SeatCount: 4,
		APILevel:  28,
		NowUs:     clockUs.Load,
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var passCh = make(chan ClientPassEvent, 4)
	client := NewSerialClient(SerialClientConfig{
		PortName:      "COM-STM32",
		BaudRate:      0, // Auto: tries 115200 first (silent), then succeeds at 921600!
		PollInterval:  15 * time.Millisecond,
		BootTimeout:   120 * time.Millisecond,
		ReadTimeout:   40 * time.Millisecond,
		RxSettleDelay: 1 * time.Millisecond,
		OpenPort: func(portName string, baud int) (SerialPort, error) {
			hp, dp := NewInMemorySerialPair()
			if baud == 921600 {
				go func() { _ = simNode.Serve(dp) }()
			}
			// At 115200, dp never responds, simulating baud mismatch
			return hp, nil
		},
		Hooks: ClientHooks{
			NowUs:  clockUs.Load,
			OnPass: func(ev ClientPassEvent) { passCh <- ev },
		},
	})

	readyCh := make(chan error, 1)
	go func() {
		_ = client.RunOnce(ctx, func(err error) { readyCh <- err })
	}()

	select {
	case err := <-readyCh:
		if err != nil {
			t.Fatalf("expected fallback to 921600 baud to succeed, got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for 921600 fallback")
	}

	snap := client.Snapshot()
	if snap.BaudRate != 921600 || snap.APILevel != 28 || snap.NodeCount != 4 {
		t.Fatalf("expected 921600 baud / API 28 / 4 seats, got %+v", snap)
	}

	var nodes [domain.MaxPilotSlots]NodeConfig
	nodes[0] = NodeConfig{Enabled: true, Band: domain.BandRaceband, Channel: 8, FrequencyMHz: 5917, EnterAtLevel: 100, ExitAtLevel: 75}
	client.SyncNodesAndArm(nodes, true)
	time.Sleep(60 * time.Millisecond)

	clockUs.Store(8_000_000)
	simNode.FeedSeatRSSI(0, 140, 7_980_000)
	simNode.FeedSeatRSSI(0, 205, 8_000_000)
	simNode.FeedSeatRSSI(0, 65, 8_020_000)
	clockUs.Store(8_025_000)

	select {
	case ev := <-passCh:
		if ev.SlotIndex != 1 || ev.PeakRSSI != 205 {
			t.Fatalf("unexpected legacy API 28 pass: %+v", ev)
		}
	case <-time.After(1 * time.Second):
		t.Fatal("timed out waiting for legacy API 28 pass")
	}
}
