package laprf

import (
	"encoding/binary"
	"io"
	"math"
	"net"
	"sync"
	"time"

	"slaprf/internal/domain"
)

// SlotRFConfig describes one of the 8 RF receiver slots pushed to a physical or simulated LapRF 8-Way timer.
type SlotRFConfig struct {
	Enabled      bool
	Band         domain.Band
	Channel      uint8
	FrequencyMHz uint16
	Threshold    float32 // 300..3500 (default 800)
	Gain         uint16  // 0..63 (default 59)
}

// ClientStatusEvent is emitted whenever a 0xDA0A STATUS heartbeat arrives from a LapRF timer.
type ClientStatusEvent struct {
	VoltageMv      uint16                        `json:"voltageMv"`
	GateArmed      bool                          `json:"gateArmed"`
	DetectionCount uint32                        `json:"detectionCount"`
	SlotRSSI       [domain.MaxPilotSlots]float32 `json:"slotRssi"`
	RTCSynced      bool                          `json:"rtcSynced"`
	RTCOffsetUs    int64                         `json:"rtcOffsetUs"`
}

// ClientPassingEvent is emitted whenever a 0xDA09 PASSING detection arrives from a LapRF timer.
type ClientPassingEvent struct {
	SlotIndex     int     `json:"slotIndex"` // 1..8
	PassingNumber uint32  `json:"passingNumber"`
	PeakHeight    float32 `json:"peakHeight"`
	DeviceRTCUs   uint64  `json:"deviceRtcUs"`
	HostTimeUs    uint64  `json:"hostTimeUs"`
}

// ClientHooks configures callbacks and monotonic clock access for a LapRF client instance.
type ClientHooks struct {
	NowUs     func() uint64
	Send      func(wire []byte)
	OnStatus  func(ev ClientStatusEvent)
	OnPassing func(ev ClientPassingEvent)
}

// Client speaks the ImmersionRC LapRF binary protocol as a host controller (Ethernet TCP :5403,
// USB CDC 115200 baud, or in-memory simulated LapRF pipe).
type Client struct {
	mu      sync.Mutex
	hooks   ClientHooks
	inFrame bool
	frame   []byte

	// Clock sync state
	pendingPingSentUs uint64
	hasFirstSample    bool
	firstDevRaw       uint64
	firstHostUs       uint64
	clockIsMillis     bool
	rtcSynced         bool
	rtcOffsetUs       int64

	// Latest status snapshot
	lastStatus ClientStatusEvent
	framesRx   uint64
	passingsRx uint64
}

// NewClient constructs a LapRF host protocol client.
func NewClient(hooks ClientHooks) *Client {
	if hooks.NowUs == nil {
		boot := time.Now()
		hooks.NowUs = func() uint64 {
			return uint64(time.Since(boot).Microseconds())
		}
	}
	return &Client{
		hooks: hooks,
		frame: make([]byte, 0, 256),
	}
}

// SetSend installs or replaces the outbound byte writer.
func (c *Client) SetSend(send func(wire []byte)) {
	c.mu.Lock()
	c.hooks.Send = send
	c.mu.Unlock()
}

// Snapshot returns the most recent status & counters received from the LapRF unit.
func (c *Client) Snapshot() (status ClientStatusEvent, framesRx, passingsRx uint64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	st := c.lastStatus
	st.RTCSynced = c.rtcSynced
	st.RTCOffsetUs = c.rtcOffsetUs
	return st, c.framesRx, c.passingsRx
}

func (c *Client) emitWire(wire []byte) {
	c.mu.Lock()
	send := c.hooks.Send
	c.mu.Unlock()
	if send != nil && len(wire) > 0 {
		send(wire)
	}
}

// RequestTimeSync sends a RecordTime (0xDA0C) probe to measure the timer's internal RTC offset.
func (c *Client) RequestTimeSync() {
	c.mu.Lock()
	nowUs := c.hooks.NowUs()
	c.pendingPingSentUs = nowUs
	c.mu.Unlock()

	pkt := &Packet{Type: RecordTime}
	c.emitWire(pkt.Encode())
}

// SyncRFSetup pushes an 8-slot pilot RF configuration (0xDA02) to the LapRF timer.
func (c *Client) SyncRFSetup(slots [domain.MaxPilotSlots]SlotRFConfig) {
	pkt := &Packet{Type: RecordRFSetup}
	for i := 0; i < domain.MaxPilotSlots; i++ {
		cfg := slots[i]
		slotIdx := uint8(i + 1)
		pkt.AppendUint8(0x01, slotIdx)
		var en uint16
		if cfg.Enabled && cfg.FrequencyMHz >= 5000 {
			en = 1
		}
		thr := cfg.Threshold
		if thr <= 0 {
			thr = domain.DefaultLapRFThreshold
		} else if thr < domain.MinLapRFThreshold {
			thr = domain.MinLapRFThreshold
		} else if thr > domain.MaxLapRFThreshold {
			thr = domain.MaxLapRFThreshold
		}
		gain := cfg.Gain
		if gain == 0 && cfg.Enabled {
			gain = domain.DefaultLapRFGain
		} else if gain > 63 {
			gain = 63
		}
		freq := cfg.FrequencyMHz
		if en == 0 {
			freq = 0
		}
		pkt.AppendUint16(0x20, en)
		pkt.AppendUint16(0x21, uint16(cfg.Channel))
		pkt.AppendUint16(0x22, uint16(cfg.Band))
		pkt.AppendFloat32(0x23, thr)
		pkt.AppendUint16(0x24, gain)
		pkt.AppendUint16(0x25, freq)
	}
	c.emitWire(pkt.Encode())
}

// SyncSettings configures the LapRF timer's minimum lap time and status heartbeat period (0xDA07).
func (c *Client) SyncSettings(minLapMs uint32, statusIntervalMs uint16) {
	pkt := &Packet{Type: RecordSettings}
	if statusIntervalMs > 0 {
		pkt.AppendUint16(0x22, statusIntervalMs)
	}
	if minLapMs > 0 {
		pkt.AppendUint32(0x26, minLapMs)
	}
	if len(pkt.Fields) > 0 {
		c.emitWire(pkt.Encode())
	}
}

// SetArmed starts or stops gate detection streaming on the LapRF timer (0xDA04).
func (c *Client) SetArmed(armed bool) {
	pkt := &Packet{Type: RecordStateCtrl}
	var flag uint8
	if armed {
		flag = 1
	}
	pkt.AppendUint8(0x20, flag)
	c.emitWire(pkt.Encode())
}

// Feed ingests raw bytes received from TCP, WebSerial, or a simulated pipe, decoding complete
// 0x5A..0x5B frames as they arrive.
func (c *Client) Feed(chunk []byte) {
	for i := 0; i < len(chunk); i++ {
		b := chunk[i]
		c.mu.Lock()
		if b == ByteSOR {
			c.inFrame = true
			c.frame = append(c.frame[:0], ByteSOR)
			c.mu.Unlock()
			continue
		}
		if !c.inFrame {
			c.mu.Unlock()
			continue
		}
		c.frame = append(c.frame, b)
		if len(c.frame) > 4096 {
			// Guard against malformed noise without EOR
			c.inFrame = false
			c.frame = c.frame[:0]
			c.mu.Unlock()
			continue
		}
		if b != ByteEOR {
			c.mu.Unlock()
			continue
		}
		rawCopy := append([]byte(nil), c.frame...)
		c.inFrame = false
		c.frame = c.frame[:0]
		c.mu.Unlock()

		if pkt, err := DecodeFrame(rawCopy); err == nil {
			c.handlePacket(pkt)
		}
	}
}

// RunConn attaches the client to a full-duplex net.Conn, runs an initial dual-probe RTC sync,
// and blocks reading frames until conn closes.
func (c *Client) RunConn(conn net.Conn) {
	var writeMu sync.Mutex
	c.SetSend(func(wire []byte) {
		writeMu.Lock()
		defer writeMu.Unlock()
		_ = conn.SetWriteDeadline(time.Now().Add(writeTimeout))
		_, _ = conn.Write(wire)
	})
	go func() {
		c.RequestTimeSync()
		time.Sleep(100 * time.Millisecond)
		c.RequestTimeSync()
	}()
	buf := make([]byte, 4096)
	for {
		n, err := conn.Read(buf)
		if n > 0 {
			c.Feed(buf[:n])
		}
		if err != nil {
			if err != io.EOF && err != io.ErrClosedPipe {
				_ = conn.Close()
			}
			return
		}
	}
}

func (c *Client) handlePacket(pkt *Packet) {
	switch pkt.Type {
	case RecordTime:
		var devRaw uint64
		hasRTC := false
		for _, f := range pkt.Fields {
			if f.Signature == 0x02 && len(f.Data) >= 8 {
				devRaw = binary.LittleEndian.Uint64(f.Data)
				hasRTC = true
			}
		}
		if !hasRTC {
			return
		}
		c.mu.Lock()
		recvUs := c.hooks.NowUs()
		sentUs := c.pendingPingSentUs
		hostMidUs := recvUs
		if sentUs > 0 && recvUs >= sentUs && (recvUs-sentUs) < 2_000_000 {
			hostMidUs = sentUs + (recvUs-sentUs)/2
		}
		if !c.hasFirstSample {
			c.hasFirstSample = true
			c.firstDevRaw = devRaw
			c.firstHostUs = hostMidUs
		} else if devRaw > c.firstDevRaw && hostMidUs > c.firstHostUs {
			dHost := hostMidUs - c.firstHostUs
			dDev := devRaw - c.firstDevRaw
			if dHost >= 40_000 && dDev > 0 {
				// Distinguish millisecond vs microsecond RTC implementations
				ratio := float64(dHost) / float64(dDev)
				if ratio > 400.0 && ratio < 2500.0 {
					c.clockIsMillis = true
				} else if ratio > 0.4 && ratio < 2.5 {
					c.clockIsMillis = false
				}
			}
		}
		devUs := devRaw
		if c.clockIsMillis {
			devUs = devRaw * 1000
		}
		c.rtcOffsetUs = int64(hostMidUs) - int64(devUs)
		c.rtcSynced = true
		c.framesRx++
		c.mu.Unlock()

	case RecordStatus:
		var onStatus func(ClientStatusEvent)
		c.mu.Lock()
		c.framesRx++
		ev := c.lastStatus
		curSlot := 0
		for _, f := range pkt.Fields {
			switch f.Signature {
			case 0x01:
				if len(f.Data) >= 1 {
					curSlot = int(f.Data[0])
				}
			case 0x21:
				if len(f.Data) >= 2 {
					ev.VoltageMv = binary.LittleEndian.Uint16(f.Data)
				}
			case 0x22:
				if curSlot >= 1 && curSlot <= domain.MaxPilotSlots {
					if len(f.Data) >= 4 {
						ev.SlotRSSI[curSlot-1] = math.Float32frombits(binary.LittleEndian.Uint32(f.Data))
					} else if len(f.Data) == 2 {
						ev.SlotRSSI[curSlot-1] = float32(binary.LittleEndian.Uint16(f.Data))
					}
				}
			case 0x23:
				if len(f.Data) >= 1 {
					ev.GateArmed = f.Data[0] != 0
				}
			case 0x24:
				if len(f.Data) >= 4 {
					ev.DetectionCount = binary.LittleEndian.Uint32(f.Data)
				}
			}
		}
		ev.RTCSynced = c.rtcSynced
		ev.RTCOffsetUs = c.rtcOffsetUs
		c.lastStatus = ev
		onStatus = c.hooks.OnStatus
		c.mu.Unlock()
		if onStatus != nil {
			onStatus(ev)
		}

	case RecordDetection:
		var slotIdx int
		var passNum uint32
		var peak float32
		var devRaw uint64
		var hasTime bool
		for _, f := range pkt.Fields {
			switch f.Signature {
			case 0x01:
				if len(f.Data) >= 1 {
					slotIdx = int(f.Data[0])
				}
			case 0x21:
				if len(f.Data) >= 4 {
					passNum = binary.LittleEndian.Uint32(f.Data)
				}
			case 0x22:
				if len(f.Data) >= 4 {
					peak = math.Float32frombits(binary.LittleEndian.Uint32(f.Data))
				} else if len(f.Data) >= 2 {
					peak = float32(binary.LittleEndian.Uint16(f.Data))
				}
			case 0x02:
				if len(f.Data) >= 8 {
					devRaw = binary.LittleEndian.Uint64(f.Data)
					hasTime = true
				}
			}
		}
		if slotIdx < 1 || slotIdx > domain.MaxPilotSlots || !hasTime {
			return
		}
		c.mu.Lock()
		c.framesRx++
		c.passingsRx++
		devUs := devRaw
		if c.clockIsMillis {
			devUs = devRaw * 1000
		}
		var hostUs uint64
		if c.rtcSynced {
			mapped := int64(devUs) + c.rtcOffsetUs
			if mapped > 0 {
				hostUs = uint64(mapped)
			} else {
				hostUs = c.hooks.NowUs()
			}
		} else {
			hostUs = c.hooks.NowUs()
		}
		onPassing := c.hooks.OnPassing
		c.mu.Unlock()

		if onPassing != nil {
			onPassing(ClientPassingEvent{
				SlotIndex:     slotIdx,
				PassingNumber: passNum,
				PeakHeight:    peak,
				DeviceRTCUs:   devUs,
				HostTimeUs:    hostUs,
			})
		}
	}
}
