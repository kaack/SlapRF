package network

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"slaprf/internal/firmware"
	"slaprf/internal/slaprf"
)

const (
	// DefaultPort is the raw TCP serial stream and out-of-band UDP discovery/control port on the PoE Bridge.
	DefaultPort = 5480

	discoverProbePayload = "DISCOVER?\n"
)

// DiscoveredDevice describes a USB-Serial <-> Ethernet PoE Bridge responding to UDP discovery on the LAN.
type DiscoveredDevice struct {
	Host          string `json:"host"`
	Port          int    `json:"port"`
	Endpoint      string `json:"endpoint"`
	Board         string `json:"board,omitempty"`
	FP            string `json:"fp,omitempty"`
	Label         string `json:"label,omitempty"`
	FW            string `json:"fw,omitempty"`
	BridgeFW      string `json:"bridgeFw,omitempty"`
	UpMs          uint64 `json:"upMs,omitempty"`
	USBConnected  bool   `json:"usbConnected"`
	USBVID        string `json:"usbVid,omitempty"`
	USBPID        string `json:"usbPid,omitempty"`
	Baud          int    `json:"baud,omitempty"`
	DTR           bool   `json:"dtr"`
	RTS           bool   `json:"rts"`
	IP            string `json:"ip,omitempty"`
	Netmask       string `json:"netmask,omitempty"`
	Gateway       string `json:"gateway,omitempty"`
	StaticIP      string `json:"staticIp,omitempty"`
	StaticNetmask string `json:"staticNetmask,omitempty"`
	StaticGateway string `json:"staticGateway,omitempty"`
	MAC           string `json:"mac,omitempty"`
	LinkUp        bool   `json:"linkUp"`
	LinkSpeedMbps int    `json:"linkSpeedMbps,omitempty"`
	FullDuplex    bool   `json:"fullDuplex,omitempty"`
	DHCP          bool   `json:"dhcp"`
	TCPConnected  bool   `json:"tcpConnected"`
	TCPClients    int    `json:"tcpClients"`
	MaxClients    int    `json:"maxClients"`
	TCPPeer       string `json:"tcpPeer,omitempty"`
	RXBytes       uint64 `json:"rxBytes"`
	TXBytes       uint64 `json:"txBytes"`
	Connected     bool   `json:"connected"`
	Verified      bool   `json:"verified"`
}

// BridgeStatus describes the full out-of-band status snapshot reported by a PoE Bridge over UDP `:5480`.
type BridgeStatus struct {
	Host          string `json:"host"`
	Port          int    `json:"port"`
	Endpoint      string `json:"endpoint"`
	Board         string `json:"board"`
	BridgeFW      string `json:"bridgeFw"`
	UpMs          uint64 `json:"upMs"`
	USBConnected  bool   `json:"usbConnected"`
	USBVID        string `json:"usbVid"`
	USBPID        string `json:"usbPid"`
	Baud          int    `json:"baud"`
	DTR           bool   `json:"dtr"`
	RTS           bool   `json:"rts"`
	IP            string `json:"ip"`
	Netmask       string `json:"netmask"`
	Gateway       string `json:"gateway"`
	StaticIP      string `json:"staticIp,omitempty"`
	StaticNetmask string `json:"staticNetmask,omitempty"`
	StaticGateway string `json:"staticGateway,omitempty"`
	MAC           string `json:"mac"`
	LinkUp        bool   `json:"linkUp"`
	LinkSpeedMbps int    `json:"linkSpeedMbps"`
	FullDuplex    bool   `json:"fullDuplex"`
	DHCP          bool   `json:"dhcp"`
	TCPConnected  bool   `json:"tcpConnected"`
	TCPClients    int    `json:"tcpClients"`
	MaxClients    int    `json:"maxClients"`
	TCPPeer       string `json:"tcpPeer,omitempty"`
	RXBytes       uint64 `json:"rxBytes"`
	TXBytes       uint64 `json:"txBytes"`
}

// BridgeActionRequest specifies an out-of-band management action sent to a PoE Bridge over UDP `:5480`.
type BridgeActionRequest struct {
	Target  string `json:"target,omitempty"`
	Action  string `json:"action"`
	Baud    int    `json:"baud,omitempty"`
	DHCP    *bool  `json:"dhcp,omitempty"`
	IP      string `json:"ip,omitempty"`
	Netmask string `json:"netmask,omitempty"`
	Gateway string `json:"gateway,omitempty"`
	DTR     *bool  `json:"dtr,omitempty"`
	RTS     *bool  `json:"rts,omitempty"`
}

// BridgeActionResult reports the outcome of a PoE Bridge management action.
type BridgeActionResult struct {
	OK      bool          `json:"ok"`
	Action  string        `json:"action"`
	Target  string        `json:"target"`
	Message string        `json:"message,omitempty"`
	Bridge  *BridgeStatus `json:"bridge,omitempty"`
}

// Config configures the physical SlapRF LAN / PoE Ethernet transport.
type Config struct {
	DiscoveryPort   int
	DiscoveryWindow time.Duration
	DialTimeout     time.Duration
	ProbeTargets    []string // Optional explicit UDP probe endpoints ("host:port") for deterministic tests
}

// Transport implements `slaprf.Transport` over TCP/UDP `:5480` to a SlapRF PoE Ethernet Bridge.
type Transport struct {
	discPort     int
	discWindow   time.Duration
	dialTimeout  time.Duration
	probeTargets []string
}

// NewTransport constructs a SlapRF PoE Ethernet / LAN transport.
func NewTransport(cfg Config) *Transport {
	port := cfg.DiscoveryPort
	if port <= 0 || port > 65535 {
		port = DefaultPort
	}
	win := cfg.DiscoveryWindow
	if win <= 0 {
		win = 350 * time.Millisecond
	}
	dialTmo := cfg.DialTimeout
	if dialTmo <= 0 {
		dialTmo = 2500 * time.Millisecond
	}
	return &Transport{
		discPort:     port,
		discWindow:   win,
		dialTimeout:  dialTmo,
		probeTargets: append([]string(nil), cfg.ProbeTargets...),
	}
}

func (t *Transport) Name() string { return "net" }

func (t *Transport) Traits() slaprf.Traits {
	return slaprf.Traits{
		PersistTargetsKey:          "hw.net_targets",
		DisplayName:                "PoE serial bridge",
		InitialConnectStatus:       "Connecting to PoE serial bridge…",
		ProbeStatus:                "Reading timer status over Ethernet…",
		DisconnectedError:          "Ethernet connection lost",
		LostAfterRetriesError:      "Lost PoE bridge connection after 5 reconnect attempts.",
		ProbeTimeout:               1800 * time.Millisecond,
		ProbeReplyTimeout:          650 * time.Millisecond,
		SupportsROMBootloaderReset: true,
		DefaultSweepHz:             100,
		DefaultSweepUs:             6100,
		DefaultSweepUsMax:          6650,
		DefaultSweepBudgetUs:       7000,
		SynthesizedStatusExtras: func(prev map[string]any) map[string]any {
			out := map[string]any{"transport": "eth"}
			if prev != nil {
				if eth, ok := prev["eth"]; ok {
					out["eth"] = eth
				}
			}
			return out
		},
	}
}

// ValidateTarget normalizes `"192.168.1.110"`, `"192.168.1.110:5480"`, or `"slaprf-h1.local"` into `"host:port"`.
func (t *Transport) ValidateTarget(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", errors.New("missing PoE Hub IP address or hostname")
	}
	lower := strings.ToLower(s)
	if strings.HasPrefix(lower, "ble:") {
		return "", errors.New("Bluetooth devices must use /v1/slaprf/bluetooth/connections")
	}
	if strings.HasPrefix(s, "/dev/") || (len(lower) >= 4 && strings.HasPrefix(lower, "com") && lower[3] >= '0' && lower[3] <= '9') {
		return "", errors.New("USB serial ports must use /v1/slaprf/usb/connections")
	}
	for _, prefix := range []string{"tcp://", "http://", "ws://"} {
		if strings.HasPrefix(lower, prefix) {
			s = strings.TrimSpace(s[len(prefix):])
			break
		}
	}
	if slash := strings.IndexByte(s, '/'); slash >= 0 {
		s = strings.TrimSpace(s[:slash])
	}
	if s == "" {
		return "", errors.New("missing PoE Hub IP address or hostname")
	}

	host, portStr, splitErr := net.SplitHostPort(s)
	if splitErr != nil {
		if strings.Contains(s, ":") && !strings.HasPrefix(s, "[") {
			// Bare IPv6 literal without port
			if ip := net.ParseIP(s); ip != nil {
				return net.JoinHostPort(ip.String(), strconv.Itoa(DefaultPort)), nil
			}
			return "", fmt.Errorf("invalid PoE Hub endpoint %q", raw)
		}
		host = strings.Trim(s, "[]")
		if host == "" || strings.ContainsAny(host, " \t\r\n") {
			return "", fmt.Errorf("invalid PoE Hub host %q", raw)
		}
		return net.JoinHostPort(host, strconv.Itoa(DefaultPort)), nil
	}

	host = strings.TrimSpace(host)
	if host == "" || strings.ContainsAny(host, " \t\r\n") {
		return "", fmt.Errorf("invalid PoE Hub host %q", raw)
	}
	port, err := strconv.Atoi(strings.TrimSpace(portStr))
	if err != nil || port < 1 || port > 65535 {
		return "", fmt.Errorf("invalid PoE Hub TCP port %q", portStr)
	}
	return net.JoinHostPort(host, strconv.Itoa(port)), nil
}

func (t *Transport) TargetFingerprint(string) (string, bool) { return "", false }

func (t *Transport) CanonicalTarget(string) string { return "" }

// Discover implements `slaprf.Transport.Discover` by probing UDP `:5480` on the local network.
func (t *Transport) Discover(ctx context.Context, _ bool) ([]slaprf.PortInfo, error) {
	devs, _, err := t.DiscoverDevices(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]slaprf.PortInfo, 0, len(devs))
	for _, d := range devs {
		prod := "PoE USB-Serial Bridge"
		if d.USBVID == "303A" {
			prod = "PoE Bridge · ESP32-C5 USB"
		} else if d.Label != "" {
			prod = fmt.Sprintf("PoE Bridge · %s", d.Label)
		}
		if !d.USBConnected {
			prod = "PoE Bridge (No USB device attached)"
		}
		out = append(out, slaprf.PortInfo{
			Name:         d.Endpoint,
			IsUSB:        false,
			VID:          d.USBVID,
			PID:          d.USBPID,
			IsEspressif:  true,
			SerialNumber: d.FP,
			Product:      prod,
			Transport:    "eth",
		})
	}
	return out, nil
}

type udpDiscoveryReply struct {
	Proto         string `json:"proto"`
	Ver           int    `json:"ver"`
	Board         string `json:"board"`
	FP            string `json:"fp"`
	Label         string `json:"label"`
	FW            string `json:"fw"`
	BridgeFW      string `json:"bridgeFw"`
	UpMs          uint64 `json:"upMs"`
	USBConnected  bool   `json:"usbConnected"`
	USBVID        string `json:"usbVid"`
	USBPID        string `json:"usbPid"`
	Baud          int    `json:"baud"`
	DTR           *bool  `json:"dtr"`
	RTS           *bool  `json:"rts"`
	Port          int    `json:"port"`
	IP            string `json:"ip"`
	Netmask       string `json:"netmask"`
	Gateway       string `json:"gateway"`
	StaticIP      string `json:"staticIp"`
	StaticNetmask string `json:"staticNetmask"`
	StaticGateway string `json:"staticGateway"`
	MAC           string `json:"mac"`
	LinkUp        *bool  `json:"linkUp"`
	LinkSpeedMbps int    `json:"linkSpeedMbps"`
	FullDuplex    bool   `json:"fullDuplex"`
	DHCP          *bool  `json:"dhcp"`
	TCPConnected  bool   `json:"tcpConnected"`
	TCPClients    int    `json:"tcpClients"`
	MaxClients    int    `json:"maxClients"`
	TCPPeer       string `json:"tcpPeer"`
	RXBytes       uint64 `json:"rxBytes"`
	TXBytes       uint64 `json:"txBytes"`
}

// DiscoverDevices broadcasts `DISCOVER?` over UDP `:5480` across active IPv4 LAN and Link-Local AutoIP
// interfaces in a fast broadcast wave (~220 ms), falling back to a non-blocking /24 unicast sweep only
// when broadcast packets are filtered by the local Wi-Fi AP or switch.
func (t *Transport) DiscoverDevices(ctx context.Context) ([]DiscoveredDevice, string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	conn, err := net.ListenPacket("udp4", ":0")
	if err != nil {
		return nil, "", err
	}
	defer conn.Close()

	fastTargets, sweepTargets, subnetLabel := t.collectDiscoveryTargets()
	payload := []byte(discoverProbePayload)

	sendList := func(targets []string) {
		for _, dstStr := range targets {
			if ctx.Err() != nil {
				return
			}
			udpAddr, rErr := net.ResolveUDPAddr("udp4", dstStr)
			if rErr != nil {
				continue
			}
			_, _ = conn.WriteTo(payload, udpAddr)
		}
	}

	byEndpoint := make(map[string]DiscoveredDevice)
	buf := make([]byte, 2048)

	readUntil := func(deadline time.Time) {
		if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
			deadline = d
		}
		_ = conn.SetReadDeadline(deadline)
		for {
			if ctx.Err() != nil {
				return
			}
			n, srcAddr, rErr := conn.ReadFrom(buf)
			if rErr != nil {
				return
			}
			raw := strings.TrimSpace(string(buf[:n]))
			raw = strings.TrimPrefix(raw, "@")
			var rep udpDiscoveryReply
			if err := json.Unmarshal([]byte(raw), &rep); err != nil {
				continue
			}
			if rep.Proto != "usb-serial-eth" && rep.Proto != "slaprf-eth" {
				continue
			}
			host := strings.TrimSpace(rep.IP)
			if udpSrc, ok := srcAddr.(*net.UDPAddr); ok && udpSrc.IP != nil {
				host = udpSrc.IP.String()
			}
			if host == "" {
				continue
			}
			port := rep.Port
			if port <= 0 || port > 65535 {
				port = t.discPort
			}
			ep := net.JoinHostPort(host, strconv.Itoa(port))
			label := strings.TrimSpace(rep.Label)
			dtr := true
			if rep.DTR != nil {
				dtr = *rep.DTR
			}
			rts := false
			if rep.RTS != nil {
				rts = *rep.RTS
			}
			linkUp := true
			if rep.LinkUp != nil {
				linkUp = *rep.LinkUp
			}
			dhcp := true
			if rep.DHCP != nil {
				dhcp = *rep.DHCP
			}
			board := strings.TrimSpace(rep.Board)
			if board == "" || board == "ESP32-P4-POE-ETH" {
				board = "ESP32-P4-WIFI6-POE-ETH"
			}
			tcpClients := rep.TCPClients
			if tcpClients == 0 && rep.TCPConnected {
				tcpClients = 1
			}
			maxClients := rep.MaxClients
			if maxClients <= 0 {
				maxClients = 1
			}
			byEndpoint[ep] = DiscoveredDevice{
				Host:          host,
				Port:          port,
				Endpoint:      ep,
				Board:         board,
				FP:            strings.ToUpper(strings.TrimSpace(rep.FP)),
				Label:         label,
				FW:            strings.TrimSpace(rep.FW),
				BridgeFW:      strings.TrimSpace(rep.BridgeFW),
				UpMs:          rep.UpMs,
				USBConnected:  rep.USBConnected,
				USBVID:        strings.ToUpper(strings.TrimSpace(rep.USBVID)),
				USBPID:        strings.ToUpper(strings.TrimSpace(rep.USBPID)),
				Baud:          rep.Baud,
				DTR:           dtr,
				RTS:           rts,
				IP:            strings.TrimSpace(rep.IP),
				Netmask:       strings.TrimSpace(rep.Netmask),
				Gateway:       strings.TrimSpace(rep.Gateway),
				StaticIP:      strings.TrimSpace(rep.StaticIP),
				StaticNetmask: strings.TrimSpace(rep.StaticNetmask),
				StaticGateway: strings.TrimSpace(rep.StaticGateway),
				MAC:           strings.ToUpper(strings.TrimSpace(rep.MAC)),
				LinkUp:        linkUp,
				LinkSpeedMbps: rep.LinkSpeedMbps,
				FullDuplex:    rep.FullDuplex,
				DHCP:          dhcp,
				TCPConnected:  rep.TCPConnected || tcpClients > 0,
				TCPClients:    tcpClients,
				MaxClients:    maxClients,
				TCPPeer:       strings.TrimSpace(rep.TCPPeer),
				RXBytes:       rep.RXBytes,
				TXBytes:       rep.TXBytes,
				Verified:      true,
			}
		}
	}

	// Wave 1: fast broadcast probe (2 bursts 45 ms apart for Wi-Fi DTIM reliability, ~220 ms total).
	fastWin := t.discWindow
	if len(sweepTargets) > 0 && fastWin > 220*time.Millisecond {
		fastWin = 220 * time.Millisecond
	}
	sendList(fastTargets)
	if fastWin > 90*time.Millisecond {
		readUntil(time.Now().Add(45 * time.Millisecond))
		if len(byEndpoint) == 0 {
			sendList(fastTargets)
		}
		readUntil(time.Now().Add(fastWin - 45*time.Millisecond))
	} else {
		readUntil(time.Now().Add(fastWin))
	}

	// Wave 2: only if broadcast returned 0 bridges, sweep /24 in a background goroutine so Linux ARP
	// resolution queues on unused IPs never block `ReadFrom` or stall discovery for multiple seconds.
	if len(byEndpoint) == 0 && len(sweepTargets) > 0 && ctx.Err() == nil {
		go sendList(sweepTargets)
		sweepWin := t.discWindow
		if sweepWin < 450*time.Millisecond {
			sweepWin = 450 * time.Millisecond
		}
		readUntil(time.Now().Add(sweepWin))
	}

	out := make([]DiscoveredDevice, 0, len(byEndpoint))
	for _, d := range byEndpoint {
		out = append(out, d)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].USBConnected != out[j].USBConnected {
			return out[i].USBConnected
		}
		return out[i].Endpoint < out[j].Endpoint
	})
	return out, subnetLabel, nil
}

func (t *Transport) collectDiscoveryTargets() (fast []string, sweep []string, primarySubnet string) {
	seenFast := make(map[string]bool)
	seenSweep := make(map[string]bool)
	addFast := func(host string, port int) {
		ep := net.JoinHostPort(host, strconv.Itoa(port))
		if !seenFast[ep] {
			seenFast[ep] = true
			fast = append(fast, ep)
		}
	}
	addSweep := func(host string, port int) {
		ep := net.JoinHostPort(host, strconv.Itoa(port))
		if !seenFast[ep] && !seenSweep[ep] {
			seenSweep[ep] = true
			sweep = append(sweep, ep)
		}
	}

	for _, explicit := range t.probeTargets {
		if norm, err := t.ValidateTarget(explicit); err == nil {
			if !seenFast[norm] {
				seenFast[norm] = true
				fast = append(fast, norm)
			}
		}
	}
	if len(t.probeTargets) > 0 {
		return fast, nil, "127.0.0.1/32"
	}

	addFast("255.255.255.255", t.discPort)

	ifaces, err := net.Interfaces()
	if err != nil {
		return fast, nil, ""
	}
	unicastSubnets := 0
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, aErr := iface.Addrs()
		if aErr != nil {
			continue
		}
		for _, a := range addrs {
			ipNet, ok := a.(*net.IPNet)
			if !ok || ipNet.IP == nil {
				continue
			}
			ip4 := ipNet.IP.To4()
			if ip4 == nil || ip4.IsLoopback() {
				continue
			}
			mask := ipNet.Mask
			if len(mask) == net.IPv6len {
				mask = mask[12:]
			}
			if len(mask) != net.IPv4len {
				continue
			}
			ones, _ := net.IPMask(mask).Size()
			ipNum := binary.BigEndian.Uint32(ip4)
			maskNum := binary.BigEndian.Uint32(mask)
			netNum := ipNum & maskNum
			bcastNum := netNum | ^maskNum

			var bcastIP [4]byte
			binary.BigEndian.PutUint32(bcastIP[:], bcastNum)
			addFast(net.IP(bcastIP[:]).String(), t.discPort)

			var netIP [4]byte
			binary.BigEndian.PutUint32(netIP[:], netNum)
			subnetStr := fmt.Sprintf("%s/%d", net.IP(netIP[:]).String(), ones)
			if primarySubnet == "" {
				primarySubnet = subnetStr
			}

			if ones >= 24 && ip4.IsPrivate() && unicastSubnets < 2 {
				unicastSubnets++
				base24 := ipNum & 0xFFFFFF00
				for hostByte := uint32(1); hostByte <= 254; hostByte++ {
					cand := base24 | hostByte
					if cand == ipNum {
						continue
					}
					var dst [4]byte
					binary.BigEndian.PutUint32(dst[:], cand)
					addSweep(net.IP(dst[:]).String(), t.discPort)
				}
			}
		}
	}
	return fast, sweep, primarySubnet
}

func (t *Transport) Open(ctx context.Context, target string, onProgress func(string)) (firmware.SerialPort, error) {
	norm, err := t.ValidateTarget(target)
	if err != nil {
		return nil, err
	}
	if onProgress != nil {
		onProgress(fmt.Sprintf("Connecting to %s…", norm))
	}
	dialer := net.Dialer{
		Timeout:   t.dialTimeout,
		KeepAlive: 2 * time.Second,
	}
	conn, err := dialer.DialContext(ctx, "tcp", norm)
	if err != nil {
		if ctx.Err() != nil {
			return nil, slaprf.ErrConnectCancelled
		}
		return nil, err
	}
	if tcpConn, ok := conn.(*net.TCPConn); ok {
		_ = tcpConn.SetNoDelay(true)
		_ = tcpConn.SetKeepAlive(true)
		_ = tcpConn.SetKeepAlivePeriod(2 * time.Second)
	}
	return &tcpSerialPort{
		conn:        conn,
		ctrlAddr:    norm,
		readTimeout: 120 * time.Millisecond,
		dtr:         true,
		rts:         false,
	}, nil
}

// OpenTCPSerialPort opens a raw TCP serial stream (`host:port` or `tcp://host:port`) with `TCP_NODELAY`
// and out-of-band UDP DTR/RTS control, usable by any serial consumer (`slaprf`, `laprf/usb`, `rotorhazard/usb`).
func OpenTCPSerialPort(ctx context.Context, rawTarget string, baud int) (firmware.SerialPort, error) {
	tr := NewTransport(Config{})
	norm, err := tr.ValidateTarget(rawTarget)
	if err != nil {
		return nil, err
	}
	p, err := tr.Open(ctx, norm, nil)
	if err != nil {
		return nil, err
	}
	if tcpPort, ok := p.(*tcpSerialPort); ok && baud > 0 {
		tcpPort.sendCtrlPacket(fmt.Sprintf("CTRL baud=%d dtr=1 rts=0\n", baud))
	}
	return p, nil
}

type tcpSerialPort struct {
	conn        net.Conn
	ctrlAddr    string
	mu          sync.Mutex
	readTimeout time.Duration
	dtr         bool
	rts         bool
}

func (p *tcpSerialPort) sendCtrlPacket(msg string) {
	if p.ctrlAddr == "" {
		return
	}
	udpAddr, err := net.ResolveUDPAddr("udp", p.ctrlAddr)
	if err != nil {
		return
	}
	c, err := net.DialUDP("udp", nil, udpAddr)
	if err != nil {
		return
	}
	defer c.Close()
	_ = c.SetWriteDeadline(time.Now().Add(80 * time.Millisecond))
	_, _ = c.Write([]byte(msg))
}

func (p *tcpSerialPort) SetDTR(v bool) error {
	p.mu.Lock()
	p.dtr = v
	d, r := boolBit(p.dtr), boolBit(p.rts)
	p.mu.Unlock()
	p.sendCtrlPacket(fmt.Sprintf("CTRL dtr=%d rts=%d\n", d, r))
	return nil
}

func (p *tcpSerialPort) SetRTS(v bool) error {
	p.mu.Lock()
	p.rts = v
	d, r := boolBit(p.dtr), boolBit(p.rts)
	p.mu.Unlock()
	p.sendCtrlPacket(fmt.Sprintf("CTRL dtr=%d rts=%d\n", d, r))
	return nil
}

func (p *tcpSerialPort) SetDTRRTS(dtr, rts bool) error {
	p.mu.Lock()
	p.dtr = dtr
	p.rts = rts
	p.mu.Unlock()
	p.sendCtrlPacket(fmt.Sprintf("CTRL dtr=%d rts=%d\n", boolBit(dtr), boolBit(rts)))
	return nil
}

func boolBit(v bool) int {
	if v {
		return 1
	}
	return 0
}

func (p *tcpSerialPort) Read(b []byte) (int, error) {
	p.mu.Lock()
	tmo := p.readTimeout
	p.mu.Unlock()
	if tmo > 0 {
		_ = p.conn.SetReadDeadline(time.Now().Add(tmo))
	} else {
		_ = p.conn.SetReadDeadline(time.Time{})
	}
	n, err := p.conn.Read(b)
	if n > 0 && bytesHasBusyError(b[:n]) {
		peer := extractBusyPeer(b[:n])
		_ = p.conn.Close()
		if peer != "" {
			return 0, fmt.Errorf("PoE Bridge %s is already in use by %s", p.ctrlAddr, peer)
		}
		return 0, fmt.Errorf("PoE Bridge %s is already in use by another client", p.ctrlAddr)
	}
	if err != nil {
		var netErr net.Error
		if errors.As(err, &netErr) && netErr.Timeout() {
			return n, nil
		}
	}
	return n, err
}

func bytesHasBusyError(b []byte) bool {
	s := string(b)
	return strings.Contains(s, `"code":"BUSY"`) && strings.Contains(s, `"t":"err"`)
}

func extractBusyPeer(b []byte) string {
	raw := strings.TrimSpace(string(b))
	raw = strings.TrimPrefix(raw, "@")
	if nl := strings.IndexByte(raw, '\n'); nl >= 0 {
		raw = strings.TrimSpace(raw[:nl])
	}
	var msg struct {
		Peer string `json:"peer"`
	}
	if err := json.Unmarshal([]byte(raw), &msg); err == nil {
		return strings.TrimSpace(msg.Peer)
	}
	return ""
}

func (p *tcpSerialPort) Write(b []byte) (int, error) {
	_ = p.conn.SetWriteDeadline(time.Now().Add(3 * time.Second))
	return p.conn.Write(b)
}

func (p *tcpSerialPort) SetReadTimeout(d time.Duration) error {
	p.mu.Lock()
	p.readTimeout = d
	p.mu.Unlock()
	return nil
}

func (p *tcpSerialPort) ResetInputBuffer() error { return nil }

func (p *tcpSerialPort) Close() error { return p.conn.Close() }

func (t *Transport) udpRoundTrip(ctx context.Context, normEndpoint string, cmd string, timeout time.Duration) ([]byte, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	udpAddr, err := net.ResolveUDPAddr("udp4", normEndpoint)
	if err != nil {
		return nil, err
	}
	conn, err := net.DialUDP("udp4", nil, udpAddr)
	if err != nil {
		return nil, err
	}
	defer conn.Close()

	if timeout <= 0 {
		timeout = 700 * time.Millisecond
	}
	deadline := time.Now().Add(timeout)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	_ = conn.SetDeadline(deadline)

	if !strings.HasSuffix(cmd, "\n") {
		cmd += "\n"
	}
	if _, err := conn.Write([]byte(cmd)); err != nil {
		return nil, err
	}
	buf := make([]byte, 2048)
	n, err := conn.Read(buf)
	if err != nil {
		return nil, err
	}
	raw := strings.TrimSpace(string(buf[:n]))
	raw = strings.TrimPrefix(raw, "@")
	return []byte(raw), nil
}

// QueryBridgeStatus queries a specific PoE Bridge (`host:port`) over UDP `:5480` using `STATUS?`.
func (t *Transport) QueryBridgeStatus(ctx context.Context, rawTarget string) (*BridgeStatus, error) {
	norm, err := t.ValidateTarget(rawTarget)
	if err != nil {
		return nil, err
	}
	host, portStr, _ := net.SplitHostPort(norm)
	port, _ := strconv.Atoi(portStr)
	if port <= 0 {
		port = t.discPort
	}

	// Send `DISCOVER?` because both v0.1.0 and v0.2.0+ firmware answer `DISCOVER?` with `format_bridge_json`.
	raw, err := t.udpRoundTrip(ctx, norm, "DISCOVER?", 750*time.Millisecond)
	if err != nil {
		return nil, fmt.Errorf("PoE Bridge at %s did not respond: %w", norm, err)
	}
	var rep udpDiscoveryReply
	if err := json.Unmarshal(raw, &rep); err != nil {
		return nil, fmt.Errorf("invalid PoE Bridge status payload from %s: %w", norm, err)
	}
	board := strings.TrimSpace(rep.Board)
	if board == "" || board == "ESP32-P4-POE-ETH" {
		board = "ESP32-P4-WIFI6-POE-ETH"
	}
	dtr := true
	if rep.DTR != nil {
		dtr = *rep.DTR
	}
	rts := false
	if rep.RTS != nil {
		rts = *rep.RTS
	}
	linkUp := true
	if rep.LinkUp != nil {
		linkUp = *rep.LinkUp
	}
	dhcp := true
	if rep.DHCP != nil {
		dhcp = *rep.DHCP
	}
	ip := strings.TrimSpace(rep.IP)
	if ip == "" {
		ip = host
	}
	baud := rep.Baud
	if baud <= 0 {
		baud = 115200
	}
	tcpClients := rep.TCPClients
	if tcpClients == 0 && rep.TCPConnected {
		tcpClients = 1
	}
	maxClients := rep.MaxClients
	if maxClients <= 0 {
		maxClients = 1
	}
	return &BridgeStatus{
		Host:          host,
		Port:          port,
		Endpoint:      norm,
		Board:         board,
		BridgeFW:      strings.TrimSpace(rep.BridgeFW),
		UpMs:          rep.UpMs,
		USBConnected:  rep.USBConnected,
		USBVID:        strings.ToUpper(strings.TrimSpace(rep.USBVID)),
		USBPID:        strings.ToUpper(strings.TrimSpace(rep.USBPID)),
		Baud:          baud,
		DTR:           dtr,
		RTS:           rts,
		IP:            ip,
		Netmask:       strings.TrimSpace(rep.Netmask),
		Gateway:       strings.TrimSpace(rep.Gateway),
		StaticIP:      strings.TrimSpace(rep.StaticIP),
		StaticNetmask: strings.TrimSpace(rep.StaticNetmask),
		StaticGateway: strings.TrimSpace(rep.StaticGateway),
		MAC:           strings.ToUpper(strings.TrimSpace(rep.MAC)),
		LinkUp:        linkUp,
		LinkSpeedMbps: rep.LinkSpeedMbps,
		FullDuplex:    rep.FullDuplex,
		DHCP:          dhcp,
		TCPConnected:  rep.TCPConnected || tcpClients > 0,
		TCPClients:    tcpClients,
		MaxClients:    maxClients,
		TCPPeer:       strings.TrimSpace(rep.TCPPeer),
		RXBytes:       rep.RXBytes,
		TXBytes:       rep.TXBytes,
	}, nil
}

// SendBridgeAction executes an out-of-band management command against a PoE Bridge over UDP `:5480`.
func (t *Transport) SendBridgeAction(ctx context.Context, rawTarget string, req BridgeActionRequest) (*BridgeActionResult, error) {
	norm, err := t.ValidateTarget(rawTarget)
	if err != nil {
		return nil, err
	}
	action := strings.ToLower(strings.TrimSpace(req.Action))
	switch action {
	case "baud":
		if req.Baud < 1200 || req.Baud > 4000000 {
			return nil, errors.New("baud rate must be between 1200 and 4000000")
		}
		// `CTRL baud=<n>` works on both v0.1.0 and v0.2.0+ firmware!
		if _, err := t.udpRoundTrip(ctx, norm, fmt.Sprintf("CTRL baud=%d", req.Baud), 800*time.Millisecond); err != nil {
			return nil, fmt.Errorf("failed to update PoE Bridge baud rate: %w", err)
		}
		st, _ := t.QueryBridgeStatus(ctx, norm)
		return &BridgeActionResult{
			OK:      true,
			Action:  action,
			Target:  norm,
			Message: fmt.Sprintf("USB-A baud rate set to %d.", req.Baud),
			Bridge:  st,
		}, nil

	case "lines":
		var parts []string
		if req.DTR != nil {
			parts = append(parts, fmt.Sprintf("dtr=%d", boolBit(*req.DTR)))
		}
		if req.RTS != nil {
			parts = append(parts, fmt.Sprintf("rts=%d", boolBit(*req.RTS)))
		}
		if len(parts) == 0 {
			return nil, errors.New("specify dtr or rts")
		}
		if _, err := t.udpRoundTrip(ctx, norm, "CTRL "+strings.Join(parts, " "), 800*time.Millisecond); err != nil {
			return nil, fmt.Errorf("failed to update USB-A control lines: %w", err)
		}
		st, _ := t.QueryBridgeStatus(ctx, norm)
		return &BridgeActionResult{
			OK:      true,
			Action:  action,
			Target:  norm,
			Message: "USB-A serial control lines updated.",
			Bridge:  st,
		}, nil

	case "reset-usb":
		// Prefer firmware v0.2.3+ atomic `RESET_USB` command; fall back to the exact 5-step
		// USB-Serial-JTAG SPI-flash boot sequence `(0,0)->(1,1)->(0,1)->(0,0)->(1,0)` (never `(1,0)->(0,1)`
		// directly, which latches ESP32-C5 into ROM download mode!).
		if rawAck, err := t.udpRoundTrip(ctx, norm, "RESET_USB", 1500*time.Millisecond); err == nil && len(rawAck) > 0 {
			time.Sleep(650 * time.Millisecond)
			st, _ := t.QueryBridgeStatus(ctx, norm)
			return &BridgeActionResult{
				OK:      true,
				Action:  action,
				Target:  norm,
				Message: "USB-A device restarted.",
				Bridge:  st,
			}, nil
		}
		steps := []struct {
			cmd  string
			wait time.Duration
		}{
			{"CTRL dtr=0 rts=0", 55 * time.Millisecond},
			{"CTRL dtr=1 rts=1", 65 * time.Millisecond},
			{"CTRL dtr=0 rts=1", 120 * time.Millisecond},
			{"CTRL dtr=0 rts=0", 150 * time.Millisecond},
			{"CTRL dtr=1 rts=0", 650 * time.Millisecond},
		}
		for _, s := range steps {
			if _, err := t.udpRoundTrip(ctx, norm, s.cmd, 600*time.Millisecond); err != nil {
				return nil, fmt.Errorf("failed to restart USB-A device: %w", err)
			}
			time.Sleep(s.wait)
		}
		st, _ := t.QueryBridgeStatus(ctx, norm)
		return &BridgeActionResult{
			OK:      true,
			Action:  action,
			Target:  norm,
			Message: "USB-A device restarted.",
			Bridge:  st,
		}, nil

	case "reset-counters":
		rawAck, err := t.udpRoundTrip(ctx, norm, "RESET_COUNTERS", 800*time.Millisecond)
		if err != nil {
			return nil, fmt.Errorf("failed to reset traffic counters (ensure PoE Bridge firmware is v0.2.0+): %w", err)
		}
		var ack struct {
			OK bool `json:"ok"`
		}
		_ = json.Unmarshal(rawAck, &ack)
		st, _ := t.QueryBridgeStatus(ctx, norm)
		return &BridgeActionResult{
			OK:      ack.OK,
			Action:  action,
			Target:  norm,
			Message: "USB-A serial traffic counters cleared.",
			Bridge:  st,
		}, nil

	case "netcfg":
		useDHCP := true
		if req.DHCP != nil {
			useDHCP = *req.DHCP
		}
		if useDHCP {
			rawAck, err := t.udpRoundTrip(ctx, norm, "NETCFG DHCP", 900*time.Millisecond)
			if err != nil {
				return nil, fmt.Errorf("failed to enable DHCP on PoE Bridge (ensure firmware is v0.2.0+): %w", err)
			}
			var ack struct {
				OK bool `json:"ok"`
			}
			if err := json.Unmarshal(rawAck, &ack); err == nil && !ack.OK {
				return nil, errors.New("PoE Bridge rejected DHCP configuration")
			}
			time.Sleep(250 * time.Millisecond)
			st, _ := t.QueryBridgeStatus(ctx, norm)
			return &BridgeActionResult{
				OK:      true,
				Action:  action,
				Target:  norm,
				Message: "Network mode set to automatic DHCP + Link-Local.",
				Bridge:  st,
			}, nil
		}

		ip := strings.TrimSpace(req.IP)
		mask := strings.TrimSpace(req.Netmask)
		gw := strings.TrimSpace(req.Gateway)
		if mask == "" {
			mask = "255.255.255.0"
		}
		if gw == "" {
			gw = "0.0.0.0"
		}
		if net.ParseIP(ip) == nil || net.ParseIP(ip).To4() == nil {
			return nil, errors.New("enter a valid IPv4 address (for example 192.168.1.110)")
		}
		if net.ParseIP(mask) == nil || net.ParseIP(mask).To4() == nil {
			return nil, errors.New("enter a valid IPv4 subnet mask (for example 255.255.255.0)")
		}
		if net.ParseIP(gw) == nil || net.ParseIP(gw).To4() == nil {
			return nil, errors.New("enter a valid IPv4 gateway (or 0.0.0.0)")
		}

		cmd := fmt.Sprintf("NETCFG STATIC %s %s %s", ip, mask, gw)
		rawAck, err := t.udpRoundTrip(ctx, norm, cmd, 900*time.Millisecond)
		if err != nil {
			return nil, fmt.Errorf("failed to apply static IP on PoE Bridge (ensure firmware is v0.2.0+): %w", err)
		}
		var ack struct {
			OK bool `json:"ok"`
		}
		if err := json.Unmarshal(rawAck, &ack); err == nil && !ack.OK {
			return nil, errors.New("PoE Bridge rejected static IPv4 settings")
		}
		_, portStr, _ := net.SplitHostPort(norm)
		nextTarget := net.JoinHostPort(ip, portStr)
		time.Sleep(220 * time.Millisecond)
		st, _ := t.QueryBridgeStatus(ctx, nextTarget)
		return &BridgeActionResult{
			OK:      true,
			Action:  action,
			Target:  nextTarget,
			Message: fmt.Sprintf("Static IPv4 %s (%s) saved and applied.", ip, mask),
			Bridge:  st,
		}, nil

	case "reboot":
		_, err := t.udpRoundTrip(ctx, norm, "REBOOT", 800*time.Millisecond)
		if err != nil {
			return nil, fmt.Errorf("failed to send reboot command (ensure PoE Bridge firmware is v0.2.0+): %w", err)
		}
		return &BridgeActionResult{
			OK:      true,
			Action:  action,
			Target:  norm,
			Message: "Rebooting PoE Bridge… Ethernet link will return in ~3 seconds.",
		}, nil

	default:
		return nil, fmt.Errorf("unsupported PoE Bridge action %q", req.Action)
	}
}
