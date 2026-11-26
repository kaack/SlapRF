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
	FP            string `json:"fp,omitempty"`
	Label         string `json:"label,omitempty"`
	FW            string `json:"fw,omitempty"`
	BridgeFW      string `json:"bridgeFw,omitempty"`
	USBConnected  bool   `json:"usbConnected"`
	USBVID        string `json:"usbVid,omitempty"`
	USBPID        string `json:"usbPid,omitempty"`
	Baud          int    `json:"baud,omitempty"`
	MAC           string `json:"mac,omitempty"`
	LinkSpeedMbps int    `json:"linkSpeedMbps,omitempty"`
	FullDuplex    bool   `json:"fullDuplex,omitempty"`
	Verified      bool   `json:"verified"`
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
	FP            string `json:"fp"`
	Label         string `json:"label"`
	FW            string `json:"fw"`
	BridgeFW      string `json:"bridgeFw"`
	USBConnected  bool   `json:"usbConnected"`
	USBVID        string `json:"usbVid"`
	USBPID        string `json:"usbPid"`
	Baud          int    `json:"baud"`
	Port          int    `json:"port"`
	IP            string `json:"ip"`
	MAC           string `json:"mac"`
	LinkSpeedMbps int    `json:"linkSpeedMbps"`
	FullDuplex    bool   `json:"fullDuplex"`
}

// DiscoverDevices broadcasts and sweeps `SLAPRF_DISCOVER?` over UDP `:5480` across active IPv4 LAN
// and Link-Local AutoIP (`169.254.0.0/16`) interfaces, returning verified SlapRF PoE Bridges.
func (t *Transport) DiscoverDevices(ctx context.Context) ([]DiscoveredDevice, string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	conn, err := net.ListenPacket("udp4", ":0")
	if err != nil {
		return nil, "", err
	}
	defer conn.Close()

	targets, subnetLabel := t.collectDiscoveryTargets()
	payload := []byte(discoverProbePayload)
	for _, dstStr := range targets {
		udpAddr, rErr := net.ResolveUDPAddr("udp4", dstStr)
		if rErr != nil {
			continue
		}
		_, _ = conn.WriteTo(payload, udpAddr)
	}

	deadline := time.Now().Add(t.discWindow)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	_ = conn.SetReadDeadline(deadline)

	byEndpoint := make(map[string]DiscoveredDevice)
	buf := make([]byte, 2048)
	for {
		if ctx.Err() != nil {
			break
		}
		n, srcAddr, rErr := conn.ReadFrom(buf)
		if rErr != nil {
			break
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
			// Prefer the actual routable source IP observed on the socket.
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
		byEndpoint[ep] = DiscoveredDevice{
			Host:          host,
			Port:          port,
			Endpoint:      ep,
			FP:            strings.ToUpper(strings.TrimSpace(rep.FP)),
			Label:         label,
			FW:            strings.TrimSpace(rep.FW),
			BridgeFW:      strings.TrimSpace(rep.BridgeFW),
			USBConnected:  rep.USBConnected,
			USBVID:        strings.ToUpper(strings.TrimSpace(rep.USBVID)),
			USBPID:        strings.ToUpper(strings.TrimSpace(rep.USBPID)),
			Baud:          rep.Baud,
			MAC:           strings.ToUpper(strings.TrimSpace(rep.MAC)),
			LinkSpeedMbps: rep.LinkSpeedMbps,
			FullDuplex:    rep.FullDuplex,
			Verified:      true,
		}
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

func (t *Transport) collectDiscoveryTargets() ([]string, string) {
	seen := make(map[string]bool)
	var out []string
	add := func(host string, port int) {
		ep := net.JoinHostPort(host, strconv.Itoa(port))
		if !seen[ep] {
			seen[ep] = true
			out = append(out, ep)
		}
	}

	for _, explicit := range t.probeTargets {
		if norm, err := t.ValidateTarget(explicit); err == nil {
			if !seen[norm] {
				seen[norm] = true
				out = append(out, norm)
			}
		}
	}
	if len(t.probeTargets) > 0 {
		return out, "127.0.0.1/32"
	}

	add("255.255.255.255", t.discPort)
	var primarySubnet string

	ifaces, err := net.Interfaces()
	if err != nil {
		return out, ""
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
			add(net.IP(bcastIP[:]).String(), t.discPort)

			var netIP [4]byte
			binary.BigEndian.PutUint32(netIP[:], netNum)
			subnetStr := fmt.Sprintf("%s/%d", net.IP(netIP[:]).String(), ones)
			if primarySubnet == "" {
				primarySubnet = subnetStr
			}

			// Also send unicast UDP datagrams across up to two private /24 subnets so switches/APs
			// with broadcast filtering still discover PoE Bridges reliably.
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
					add(net.IP(dst[:]).String(), t.discPort)
				}
			}
		}
	}
	return out, primarySubnet
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
	if err != nil {
		var netErr net.Error
		if errors.As(err, &netErr) && netErr.Timeout() {
			return n, nil
		}
	}
	return n, err
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
