package network_test

import (
	"bufio"
	"context"
	"encoding/binary"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"

	"slaprf/internal/domain"
	"slaprf/internal/ingest"
	"slaprf/internal/slaprf"
	slaprfnet "slaprf/internal/slaprf/network"
	"slaprf/internal/tracker"
)

func wrapRecord0x1E(frame []byte) []byte {
	out := make([]byte, 2+len(frame))
	out[0] = 0x1E
	out[1] = byte(len(frame))
	copy(out[2:], frame)
	return out
}

func buildHelloFrame(tdmaSlot uint8, role uint8, fp uint32, label string) []byte {
	pkt := make([]byte, 36)
	pkt[0] = 0xC5
	pkt[1] = 0x5A
	pkt[2] = tdmaSlot
	pkt[3] = role
	binary.LittleEndian.PutUint32(pkt[4:8], fp)
	pkt[9] = 100
	copy(pkt[10:34], label)
	var crc byte
	for i := 0; i < 35; i++ {
		crc ^= pkt[i]
	}
	pkt[35] = crc
	return pkt
}

func buildWindowFrame(tdmaSlot uint8, seq uint8, rssiDbm float32) []byte {
	// 7 header + 9*1 sample + 1 crc = 17 bytes
	pkt := make([]byte, 17)
	pkt[0] = 0xC5
	pkt[1] = ingest.FrameMagicWindow
	pkt[2] = tdmaSlot
	pkt[3] = 1 // sample_count = 1
	binary.LittleEndian.PutUint16(pkt[4:6], 5020)
	floor := int8(-91)
	pkt[6] = byte(floor)
	pkt[7] = seq
	code := byte(int((rssiDbm+128.0)*2.0 + 0.5))
	for ch := 0; ch < 8; ch++ {
		pkt[8+ch] = code
	}
	var crc byte
	for i := 0; i < 16; i++ {
		crc ^= pkt[i]
	}
	pkt[16] = crc
	return pkt
}

func TestPoENetworkDiscoveryConnectAnd100HzTelemetry(t *testing.T) {
	// 1. Start mock ESP32-P4 PoE Bridge UDP discovery + TCP stream listeners on 127.0.0.1
	udpConn, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ListenPacket: %v", err)
	}
	defer udpConn.Close()
	udpPort := udpConn.LocalAddr().(*net.UDPAddr).Port

	tcpLn, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen tcp4: %v", err)
	}
	defer tcpLn.Close()
	tcpPort := tcpLn.Addr().(*net.TCPAddr).Port

	go func() {
		buf := make([]byte, 256)
		for {
			n, addr, rErr := udpConn.ReadFrom(buf)
			if rErr != nil {
				return
			}
			txt := string(buf[:n])
			if strings.HasPrefix(txt, "DISCOVER?") || strings.HasPrefix(txt, "SLAPRF_DISCOVER?") {
				reply := fmt.Sprintf(
					`{"t":"bridge","proto":"usb-serial-eth","ver":1,"bridgeFw":"0.1.0","usbConnected":true,"usbVid":"303A","usbPid":"1001","baud":115200,"port":%d,"ip":"127.0.0.1","mac":"AA:BB:CC:11:22:33","linkSpeedMbps":100,"fullDuplex":true}`,
					tcpPort,
				)
				_, _ = udpConn.WriteTo([]byte(reply), addr)
			}
		}
	}()

	go func() {
		conn, aErr := tcpLn.Accept()
		if aErr != nil {
			return
		}
		defer conn.Close()

		// Pure transparent USB-Serial <-> TCP stream: only raw XIAO ESP32-C5 bytes travel on TCP!
		statusLine := "@{\"t\":\"status\",\"fw\":\"0.4.0\",\"role\":1,\"fp\":\"A1B2C3D4\",\"label\":\"H1\",\"sweepHz\":100,\"slot\":1,\"rf\":{\"ok\":true,\"enabled\":true,\"floorDb\":-91},\"spokes\":[{\"slot\":2,\"fp\":\"B2C3D4E5\",\"label\":\"T1\",\"fw\":\"0.4.0\",\"online\":true,\"msAgo\":10,\"frames\":5}]}\n"

		_, _ = conn.Write(wrapRecord0x1E(buildHelloFrame(1, 1, 0xA1B2C3D4, "H1")))
		_, _ = conn.Write(wrapRecord0x1E(buildHelloFrame(2, 2, 0xB2C3D4E5, "T1")))
		for seq := uint8(1); seq <= 8; seq++ {
			_, _ = conn.Write(wrapRecord0x1E(buildWindowFrame(1, seq, -54.0)))
			_, _ = conn.Write(wrapRecord0x1E(buildWindowFrame(2, seq, -61.0)))
		}

		sc := bufio.NewScanner(conn)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if strings.EqualFold(line, "STATUS?") {
				_, _ = conn.Write([]byte(statusLine))
			}
		}
	}()

	tr := slaprfnet.NewTransport(slaprfnet.Config{
		DiscoveryPort:   udpPort,
		DiscoveryWindow: 120 * time.Millisecond,
		ProbeTargets:    []string{fmt.Sprintf("127.0.0.1:%d", udpPort)},
	})

	// 2. Verify ValidateTarget normalizes bare hosts and explicit ports while rejecting serial/BLE handles
	if got, vErr := tr.ValidateTarget("192.168.1.110"); vErr != nil || got != "192.168.1.110:5480" {
		t.Fatalf("ValidateTarget bare IP = %q, %v", got, vErr)
	}
	if _, vErr := tr.ValidateTarget("ble:A1B2C3D4"); vErr == nil {
		t.Fatalf("expected ble: target rejection")
	}
	if _, vErr := tr.ValidateTarget("/dev/ttyACM0"); vErr == nil {
		t.Fatalf("expected /dev/ttyACM0 serial rejection")
	}

	// 3. Verify UDP discovery parses PoE Bridge metadata and endpoint
	devs, _, err := tr.DiscoverDevices(context.Background())
	if err != nil {
		t.Fatalf("DiscoverDevices: %v", err)
	}
	if len(devs) != 1 || devs[0].USBVID != "303A" || devs[0].USBPID != "1001" || devs[0].Port != tcpPort || !devs[0].USBConnected || devs[0].LinkSpeedMbps != 100 {
		t.Fatalf("unexpected discovered devices: %+v", devs)
	}

	// 4. Connect through slaprf.Manager + HubFrameDecoder + RealEngine in HardwareModeSlapRFNet
	eng := tracker.NewRealEngine()
	eng.SetTimingHardwareMode(domain.HardwareModeSlapRFNet, false)
	hubRx := ingest.NewHubFrameDecoder(eng)
	mgr := slaprf.NewManager(slaprf.Config{
		Transport: tr,
		Timers:    slaprf.NewKnownTimerRegistry(nil),
		Engine:    eng,
		HubRx:     hubRx,
	})
	defer mgr.Close()

	snap, err := mgr.Connect(0, devs[0].Endpoint)
	if err != nil {
		t.Fatalf("mgr.Connect(%s): %v", devs[0].Endpoint, err)
	}
	if !snap.Connected || snap.LastStatus == nil {
		t.Fatalf("expected connected slot with status, got %+v", snap)
	}
	if snap.LastStatus["transport"] != "eth" {
		t.Fatalf("expected status.transport == 'eth', got %+v", snap.LastStatus["transport"])
	}

	// Wait briefly for Hub + Spoke binary telemetry frames to register in the timing engine
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		timers := eng.DetectedTimersSnapshot()
		if len(timers) >= 2 && timers[0].FramesRxCount > 0 && timers[1].FramesRxCount > 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	timers := eng.DetectedTimersSnapshot()
	if len(timers) != 2 {
		t.Fatalf("expected Hub H1 + Spoke T1 registered in engine, got %+v", timers)
	}
	_, gates, _, _, _ := eng.StateSnapshot()
	if len(gates) == 0 || gates[0].AssignedTimerID != 1 || gates[0].Role != domain.GateRoleStartFinish {
		t.Fatalf("expected PoE Hub H1 auto-assigned to Start/Finish Gate 1 in slaprf_net mode, got %+v", gates)
	}
}
