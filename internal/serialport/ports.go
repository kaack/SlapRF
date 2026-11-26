package serialport

import (
	"context"
	"errors"
	"fmt"
	"net"
	"sort"
	"strings"
	"sync"
	"time"

	"slaprf/internal/firmware"
)

const EspressifVID = "303A"

// ErrOpenCancelled indicates an in-flight port open was cancelled via context.
var ErrOpenCancelled = errors.New("serial port open cancelled")

// PortInfo describes an enumerated physical or virtual timing device port.
type PortInfo struct {
	Name         string `json:"name"`
	IsUSB        bool   `json:"isUsb"`
	VID          string `json:"vid,omitempty"`
	PID          string `json:"pid,omitempty"`
	SerialNumber string `json:"serialNumber,omitempty"`
	Product      string `json:"product,omitempty"`
	IsEspressif  bool   `json:"isEspressif"`
	Transport    string `json:"transport,omitempty"`
}

// Lister enumerates available serial ports on the host OS.
type Lister func() ([]PortInfo, error)

// SortPorts orders Espressif USB ports first, then generic USB serial adapters, then by name.
func SortPorts(ports []PortInfo) {
	sort.Slice(ports, func(i, j int) bool {
		if ports[i].IsEspressif != ports[j].IsEspressif {
			return ports[i].IsEspressif
		}
		if ports[i].IsUSB != ports[j].IsUSB {
			return ports[i].IsUSB
		}
		return ports[i].Name < ports[j].Name
	})
}

// FilterUSBPorts filters OS serial ports to Espressif USB boards (`showAll == false`) or all USB
// serial ports (`showAll == true`, falling back to all OS ports if none report `IsUSB`).
func FilterUSBPorts(ports []PortInfo, showAll bool) []PortInfo {
	out := make([]PortInfo, 0, len(ports))
	if showAll {
		for _, p := range ports {
			if p.Transport == "" && (p.IsEspressif || p.IsUSB) {
				out = append(out, p)
			}
		}
		if len(out) == 0 {
			for _, p := range ports {
				if p.Transport == "" {
					out = append(out, p)
				}
			}
		}
		SortPorts(out)
		return out
	}
	for _, p := range ports {
		if p.Transport == "" && p.IsEspressif {
			out = append(out, p)
		}
	}
	SortPorts(out)
	return out
}

// OpenContext wraps `opener(portName, baud)` so callers can abort a blocking open immediately when
// `ctx` is cancelled (closing any late-arriving handle in the background).
func OpenContext(ctx context.Context, opener firmware.SerialOpener, portName string, baud int) (firmware.SerialPort, error) {
	if err := ctx.Err(); err != nil {
		return nil, ErrOpenCancelled
	}
	portName = strings.TrimSpace(portName)
	if strings.HasPrefix(strings.ToLower(portName), "tcp://") {
		return openTCPBridgePort(ctx, portName[len("tcp://"):], baud)
	}
	if opener == nil {
		opener = DefaultOpener
	}
	type res struct {
		p   firmware.SerialPort
		err error
	}
	ch := make(chan res, 1)
	go func() {
		p, err := opener(portName, baud)
		ch <- res{p: p, err: err}
	}()
	select {
	case <-ctx.Done():
		go func() {
			if r := <-ch; r.p != nil {
				_ = r.p.Close()
			}
		}()
		return nil, ErrOpenCancelled
	case r := <-ch:
		if ctx.Err() != nil {
			if r.p != nil {
				_ = r.p.Close()
			}
			return nil, ErrOpenCancelled
		}
		return r.p, r.err
	}
}

type tcpBridgeSerialPort struct {
	conn        net.Conn
	ctrlAddr    string
	mu          sync.Mutex
	readTimeout time.Duration
	dtr         bool
	rts         bool
}

func openTCPBridgePort(ctx context.Context, addr string, baud int) (firmware.SerialPort, error) {
	addr = strings.TrimSpace(addr)
	if addr == "" {
		return nil, errors.New("missing tcp:// host:port address")
	}
	if _, _, err := net.SplitHostPort(addr); err != nil {
		addr = net.JoinHostPort(addr, "5480")
	}
	dialer := net.Dialer{Timeout: 2500 * time.Millisecond, KeepAlive: 2 * time.Second}
	conn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ErrOpenCancelled
		}
		return nil, err
	}
	if tcpConn, ok := conn.(*net.TCPConn); ok {
		_ = tcpConn.SetNoDelay(true)
		_ = tcpConn.SetKeepAlive(true)
		_ = tcpConn.SetKeepAlivePeriod(2 * time.Second)
	}
	p := &tcpBridgeSerialPort{
		conn:        conn,
		ctrlAddr:    addr,
		readTimeout: 120 * time.Millisecond,
		dtr:         true,
		rts:         false,
	}
	if baud > 0 {
		p.sendCtrl(fmt.Sprintf("CTRL baud=%d dtr=1 rts=0\n", baud))
	}
	return p, nil
}

func (p *tcpBridgeSerialPort) sendCtrl(msg string) {
	if udpAddr, err := net.ResolveUDPAddr("udp", p.ctrlAddr); err == nil {
		if c, dErr := net.DialUDP("udp", nil, udpAddr); dErr == nil {
			_ = c.SetWriteDeadline(time.Now().Add(80 * time.Millisecond))
			_, _ = c.Write([]byte(msg))
			_ = c.Close()
		}
	}
}

func (p *tcpBridgeSerialPort) Read(b []byte) (int, error) {
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

func (p *tcpBridgeSerialPort) Write(b []byte) (int, error) {
	_ = p.conn.SetWriteDeadline(time.Now().Add(3 * time.Second))
	return p.conn.Write(b)
}

func (p *tcpBridgeSerialPort) SetReadTimeout(d time.Duration) error {
	p.mu.Lock()
	p.readTimeout = d
	p.mu.Unlock()
	return nil
}

func (p *tcpBridgeSerialPort) SetDTR(v bool) error {
	p.mu.Lock()
	p.dtr = v
	d, r := 0, 0
	if p.dtr {
		d = 1
	}
	if p.rts {
		r = 1
	}
	p.mu.Unlock()
	p.sendCtrl(fmt.Sprintf("CTRL dtr=%d rts=%d\n", d, r))
	return nil
}

func (p *tcpBridgeSerialPort) SetRTS(v bool) error {
	p.mu.Lock()
	p.rts = v
	d, r := 0, 0
	if p.dtr {
		d = 1
	}
	if p.rts {
		r = 1
	}
	p.mu.Unlock()
	p.sendCtrl(fmt.Sprintf("CTRL dtr=%d rts=%d\n", d, r))
	return nil
}

func (p *tcpBridgeSerialPort) ResetInputBuffer() error { return nil }
func (p *tcpBridgeSerialPort) Close() error            { return p.conn.Close() }
