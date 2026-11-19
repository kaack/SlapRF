package rotorhazard

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
	"sync"

	"slaprf/internal/domain"
)

// RaceStatus values from upstream RotorHazard RHRace.py (`class RaceStatus`).
const (
	RHRaceStatusReady   = 0
	RHRaceStatusRacing  = 1
	RHRaceStatusDone    = 2
	RHRaceStatusStaging = 3
)

// NodeConfig represents the desired RF frequency and dual hysteresis thresholds for one RotorHazard node (0..7).
type NodeConfig struct {
	Enabled      bool
	Band         domain.Band
	Channel      uint8
	FrequencyMHz uint16
	EnterAtLevel uint8
	ExitAtLevel  uint8
}

// ClientHeartbeatEvent delivers a parsed RotorHazard `heartbeat` (~10 Hz) in native 0..255 RX5808 units.
type ClientHeartbeatEvent struct {
	NodeCount    int
	SlotRSSI     [domain.MaxPilotSlots]float32
	CrossingFlag [domain.MaxPilotSlots]bool
	FrequencyMHz [domain.MaxPilotSlots]uint16
}

// ClientPassEvent delivers an accepted RotorHazard `pass_record` mapped into SlapRF's monotonic clock.
type ClientPassEvent struct {
	SlotIndex     int // 1-based node slot (node + 1)
	FrequencyMHz  uint16
	HostTimeUs    uint64
	PeakRSSI      float32 // 0..255 RX5808 peak RSSI from node_data (or fallback)
	NadirRSSI     float32
	PassingNumber uint32
}

// ClientHooks connects a RotorHazard protocol Client to an Engine and wire transport (WS/polling or in-memory SimServer).
type ClientHooks struct {
	NowUs       func() uint64
	SendSIO     func(sioFrame string) // Emits a `42[...]` frame onto the active Socket.IO transport
	OnHeartbeat func(ev ClientHeartbeatEvent)
	OnPass      func(ev ClientPassEvent)
	OnMeta      func(st ClientStatusSnapshot)
}

// ClientStatusSnapshot exposes live RotorHazard device diagnostics to `#/network` and `#/sim`.
type ClientStatusSnapshot struct {
	Connected       bool                          `json:"connected"`
	AuthOK          bool                          `json:"authOk"`
	AuthKnown       bool                          `json:"authKnown"`
	ServerVersion   string                        `json:"serverVersion"`
	ServerHostname  string                        `json:"serverHostname"`
	APILevel        int                           `json:"apiLevel,omitempty"`
	BaudRate        int                           `json:"baudRate,omitempty"`
	NodeCount       int                           `json:"nodeCount"`
	RaceStatus      int                           `json:"raceStatus"`
	GateArmed       bool                          `json:"gateArmed"`
	ClockSynced     bool                          `json:"clockSynced"`
	ClockOffsetMs   float64                       `json:"clockOffsetMs"`
	HeartbeatsRx    uint64                        `json:"heartbeatsRx"`
	PassesRx        uint64                        `json:"passesRx"`
	SlotRSSI        [domain.MaxPilotSlots]float32 `json:"slotRssi"`
	CrossingFlag    [domain.MaxPilotSlots]bool    `json:"crossingFlag"`
	NodeEnterLevels [domain.MaxPilotSlots]uint8   `json:"nodeEnterLevels"`
	NodeExitLevels  [domain.MaxPilotSlots]uint8   `json:"nodeExitLevels"`
	NodeFreqsMHz    [domain.MaxPilotSlots]uint16  `json:"nodeFreqsMhz"`
	CpuTempC        float32                       `json:"cpuTempC,omitempty"`
	EnvSummary      string                        `json:"envSummary,omitempty"`
	ScanLive        bool                          `json:"scanLive,omitempty"`
	LastScan        *domain.RHScanPass            `json:"lastScan,omitempty"`
}

type clockSample struct {
	rttUs    uint64
	offsetUs int64 // engineUs - rhEpochUs
}

// Client implements RotorHazard's native external/split-timer Socket.IO v4 protocol
// (`join_cluster_ex(split)`, `check_secondary_query`, `set_frequency`, `set_enter_at_level`,
// `set_exit_at_level`, `stage_race`, `stop_race`, `discard_laps`, `heartbeat`, `node_data`,
// `pass_record`, and `cluster_message_ack`).
type Client struct {
	mu    sync.Mutex
	hooks ClientHooks

	connected      bool
	joinedSplit    bool
	authKnown      bool
	authOK         bool
	serverVersion  string
	serverHostname string
	nodeCount      int
	raceStatus     int
	desiredArmed   bool

	// Clock sync (`check_secondary_query` <-> `check_secondary_response`)
	pendingQuerySentUs uint64
	clockSynced        bool
	clockOffsetUs      int64 // engineUs = int64(rhEpochMs*1000) + clockOffsetUs
	clockSamples       []clockSample

	// Desired vs reported node configuration (diff-pushed to avoid unnecessary EEPROM/serial writes on Pi)
	desiredNodes   [domain.MaxPilotSlots]NodeConfig
	appliedFreqs   [domain.MaxPilotSlots]int // -1 = unknown
	appliedEnter   [domain.MaxPilotSlots]int // -1 = unknown
	appliedExit    [domain.MaxPilotSlots]int // -1 = unknown
	reportedEnter  [domain.MaxPilotSlots]uint8
	reportedExit   [domain.MaxPilotSlots]uint8
	reportedFreqs  [domain.MaxPilotSlots]uint16
	lastPassPeak   [domain.MaxPilotSlots]float32
	lastPassNadir  [domain.MaxPilotSlots]float32
	slotRSSI       [domain.MaxPilotSlots]float32
	crossingFlags  [domain.MaxPilotSlots]bool
	heartbeatsRx   uint64
	passesRx       uint64
	passingCounter uint32
	cpuTempC       float32
	envSummary     string
}

// NewClient constructs a stateful RotorHazard protocol client.
func NewClient(hooks ClientHooks) *Client {
	c := &Client{
		hooks:     hooks,
		nodeCount: domain.MaxPilotSlots,
	}
	c.resetAppliedLocked()
	return c
}

func (c *Client) resetAppliedLocked() {
	for i := 0; i < domain.MaxPilotSlots; i++ {
		c.appliedFreqs[i] = -1
		c.appliedEnter[i] = -1
		c.appliedExit[i] = -1
	}
}

func (c *Client) nowUsLocked() uint64 {
	if c.hooks.NowUs != nil {
		return c.hooks.NowUs()
	}
	return 0
}

func rhBandCode(b domain.Band) string {
	switch b {
	case domain.BandFatshark:
		return "F"
	case domain.BandBoscamE:
		return "E"
	case domain.BandBoscamA:
		return "A"
	case domain.BandIMD6:
		return "I"
	default:
		return "R"
	}
}

// OnConnected must be called once the Socket.IO v4 namespace connect (`40`) succeeds.
// It immediately registers SlapRF as a headless split/crossing decoder (`join_cluster_ex`),
// requests initial node/calibration/race state, initiates RTT clock sync, and pushes active RF slots.
func (c *Client) OnConnected() {
	c.mu.Lock()
	c.connected = true
	c.joinedSplit = false
	c.authKnown = false
	c.authOK = false
	c.resetAppliedLocked()
	nowUs := c.nowUsLocked()
	c.pendingQuerySentUs = nowUs
	var outFrames []string
	if f, err := EncodeSIOEvent("join_cluster_ex", map[string]any{"mode": "split"}, true); err == nil {
		outFrames = append(outFrames, f)
	}
	if f, err := EncodeSIOEvent("load_data", map[string]any{
		"load_types": []string{"frequency_data", "node_data", "enter_and_exit_at_levels", "race_status", "environmental_data"},
	}, true); err == nil {
		outFrames = append(outFrames, f)
	}
	if f, err := EncodeSIOEvent("check_secondary_query", map[string]any{
		"timestamp": nowUs / 1000,
	}, true); err == nil {
		outFrames = append(outFrames, f)
	}
	c.mu.Unlock()

	c.emitFrames(outFrames)
}

// OnDisconnected marks the client disconnected so reconnect re-pushes full node state cleanly.
func (c *Client) OnDisconnected() {
	c.mu.Lock()
	c.connected = false
	c.joinedSplit = false
	c.resetAppliedLocked()
	snap := c.snapshotLocked()
	metaCb := c.hooks.OnMeta
	c.mu.Unlock()
	if metaCb != nil {
		metaCb(snap)
	}
}

// RequestClockSync sends a `check_secondary_query` probe to track RTT-compensated epoch offset.
func (c *Client) RequestClockSync() {
	c.mu.Lock()
	if !c.connected {
		c.mu.Unlock()
		return
	}
	nowUs := c.nowUsLocked()
	c.pendingQuerySentUs = nowUs
	f, err := EncodeSIOEvent("check_secondary_query", map[string]any{"timestamp": nowUs / 1000}, true)
	c.mu.Unlock()
	if err == nil {
		c.emitFrames([]string{f})
	}
}

// SyncNodesAndArm updates the desired 8-node RF & dual hysteresis configuration and desired gate
// arming state (`stage_race` vs `stop_race` + `discard_laps`), emitting only changed commands.
func (c *Client) SyncNodesAndArm(nodes [domain.MaxPilotSlots]NodeConfig, armed bool) {
	c.mu.Lock()
	c.desiredNodes = nodes
	c.desiredArmed = armed
	frames := c.buildSyncFramesLocked()
	c.mu.Unlock()
	c.emitFrames(frames)
}

func (c *Client) buildSyncFramesLocked() []string {
	if !c.connected || !c.joinedSplit {
		return nil
	}
	if c.authKnown && !c.authOK {
		return nil
	}
	limit := c.nodeCount
	if limit <= 0 || limit > domain.MaxPilotSlots {
		limit = domain.MaxPilotSlots
	}
	var out []string
	for idx := 0; idx < limit; idx++ {
		want := c.desiredNodes[idx]
		freq := int(want.FrequencyMHz)
		if !want.Enabled {
			freq = 0
		}
		if c.appliedFreqs[idx] != freq {
			payload := map[string]any{
				"node":      idx,
				"frequency": freq,
			}
			if freq > 0 && want.Channel > 0 {
				payload["band"] = rhBandCode(want.Band)
				payload["channel"] = int(want.Channel)
			}
			if f, err := EncodeSIOEvent("set_frequency", payload, true); err == nil {
				out = append(out, f)
				c.appliedFreqs[idx] = freq
			}
		}
		if want.EnterAtLevel > 0 && c.appliedEnter[idx] != int(want.EnterAtLevel) {
			if f, err := EncodeSIOEvent("set_enter_at_level", map[string]any{
				"node":           idx,
				"enter_at_level": int(want.EnterAtLevel),
			}, true); err == nil {
				out = append(out, f)
				c.appliedEnter[idx] = int(want.EnterAtLevel)
			}
		}
		if want.ExitAtLevel > 0 && c.appliedExit[idx] != int(want.ExitAtLevel) {
			if f, err := EncodeSIOEvent("set_exit_at_level", map[string]any{
				"node":          idx,
				"exit_at_level": int(want.ExitAtLevel),
			}, true); err == nil {
				out = append(out, f)
				c.appliedExit[idx] = int(want.ExitAtLevel)
			}
		}
	}

	if c.desiredArmed {
		if c.raceStatus != RHRaceStatusRacing && c.raceStatus != RHRaceStatusStaging {
			if c.raceStatus == RHRaceStatusDone {
				if f, err := EncodeSIOEvent("discard_laps", nil, false); err == nil {
					out = append(out, f)
				}
			}
			if f, err := EncodeSIOEvent("stage_race", map[string]any{"secondary_format": true}, true); err == nil {
				out = append(out, f)
				c.raceStatus = RHRaceStatusStaging
			}
		}
	} else {
		if c.raceStatus == RHRaceStatusRacing || c.raceStatus == RHRaceStatusStaging {
			if f, err := EncodeSIOEvent("stop_race", nil, false); err == nil {
				out = append(out, f)
			}
			if f, err := EncodeSIOEvent("discard_laps", nil, false); err == nil {
				out = append(out, f)
			}
			c.raceStatus = RHRaceStatusReady
		} else if c.raceStatus == RHRaceStatusDone {
			if f, err := EncodeSIOEvent("discard_laps", nil, false); err == nil {
				out = append(out, f)
			}
			c.raceStatus = RHRaceStatusReady
		}
	}
	return out
}

// FeedSIOFrame processes one inbound Socket.IO event frame (`42[...]`).
func (c *Client) FeedSIOFrame(frame string) {
	ev, err := DecodeSIOEvent(frame)
	if err != nil {
		return
	}

	var hbOut *ClientHeartbeatEvent
	var passOut *ClientPassEvent
	var metaOut *ClientStatusSnapshot
	var outFrames []string

	c.mu.Lock()
	nowUs := c.nowUsLocked()

	switch ev.Name {
	case "join_cluster_response":
		var body struct {
			ServerInfo string `json:"server_info"`
			AuthOK     *bool  `json:"auth_ok"`
		}
		if ev.HasArg && json.Unmarshal(ev.RawArg, &body) == nil {
			c.joinedSplit = true
			if body.AuthOK != nil {
				c.authKnown = true
				c.authOK = *body.AuthOK
			} else {
				c.authKnown = true
				c.authOK = true
			}
			if body.ServerInfo != "" {
				var info struct {
					ReleaseVersion string `json:"release_version"`
					Hostname       string `json:"hostname"`
					NodeCount      int    `json:"node_count"`
				}
				if json.Unmarshal([]byte(body.ServerInfo), &info) == nil {
					if info.ReleaseVersion != "" {
						c.serverVersion = info.ReleaseVersion
					}
					if info.Hostname != "" {
						c.serverHostname = info.Hostname
					}
					if info.NodeCount >= 1 && info.NodeCount <= domain.MaxPilotSlots {
						c.nodeCount = info.NodeCount
					}
				}
			}
			outFrames = append(outFrames, c.buildSyncFramesLocked()...)
			snap := c.snapshotLocked()
			metaOut = &snap
		}

	case "check_secondary_response":
		var body struct {
			Timestamp float64 `json:"timestamp"` // RH server epoch milliseconds
		}
		if ev.HasArg && json.Unmarshal(ev.RawArg, &body) == nil && body.Timestamp > 0 {
			rhEpochUs := int64(math.Round(body.Timestamp * 1000.0))
			midEngineUs := int64(nowUs)
			var rttUs uint64 = 5_000
			if c.pendingQuerySentUs > 0 && nowUs >= c.pendingQuerySentUs {
				rttUs = nowUs - c.pendingQuerySentUs
				midEngineUs = int64(c.pendingQuerySentUs + rttUs/2)
			}
			offsetUs := midEngineUs - rhEpochUs
			c.clockSamples = append(c.clockSamples, clockSample{rttUs: rttUs, offsetUs: offsetUs})
			if len(c.clockSamples) > 7 {
				c.clockSamples = c.clockSamples[len(c.clockSamples)-7:]
			}
			sorted := make([]clockSample, len(c.clockSamples))
			copy(sorted, c.clockSamples)
			sort.Slice(sorted, func(i, j int) bool { return sorted[i].rttUs < sorted[j].rttUs })
			// Use lowest-RTT half median so Wi-Fi jitter spikes never skew gate splits
			bestCount := (len(sorted) + 1) / 2
			offsets := make([]int64, bestCount)
			for i := 0; i < bestCount; i++ {
				offsets[i] = sorted[i].offsetUs
			}
			sort.Slice(offsets, func(i, j int) bool { return offsets[i] < offsets[j] })
			c.clockOffsetUs = offsets[len(offsets)/2]
			c.clockSynced = true
			snap := c.snapshotLocked()
			metaOut = &snap
		}

	case "heartbeat":
		var body struct {
			CurrentRSSI  []float32 `json:"current_rssi"`
			Frequency    []uint16  `json:"frequency"`
			CrossingFlag []bool    `json:"crossing_flag"`
		}
		if ev.HasArg && json.Unmarshal(ev.RawArg, &body) == nil && len(body.CurrentRSSI) > 0 {
			c.heartbeatsRx++
			n := len(body.CurrentRSSI)
			if n > domain.MaxPilotSlots {
				n = domain.MaxPilotSlots
			}
			c.nodeCount = n
			var hb ClientHeartbeatEvent
			hb.NodeCount = n
			for i := 0; i < n; i++ {
				v := body.CurrentRSSI[i]
				if v < 0 {
					v = 0
				} else if v > 255 {
					v = 255
				}
				c.slotRSSI[i] = v
				hb.SlotRSSI[i] = v
				if i < len(body.CrossingFlag) {
					c.crossingFlags[i] = body.CrossingFlag[i]
					hb.CrossingFlag[i] = body.CrossingFlag[i]
				}
				if i < len(body.Frequency) {
					c.reportedFreqs[i] = body.Frequency[i]
					hb.FrequencyMHz[i] = body.Frequency[i]
				}
			}
			hbOut = &hb
		}

	case "node_data":
		var body struct {
			NodePeakRSSI  []float32 `json:"node_peak_rssi"`
			NodeNadirRSSI []float32 `json:"node_nadir_rssi"`
			PassPeakRSSI  []float32 `json:"pass_peak_rssi"`
			PassNadirRSSI []float32 `json:"pass_nadir_rssi"`
		}
		if ev.HasArg && json.Unmarshal(ev.RawArg, &body) == nil {
			for i := 0; i < len(body.PassPeakRSSI) && i < domain.MaxPilotSlots; i++ {
				if body.PassPeakRSSI[i] > 0 {
					c.lastPassPeak[i] = body.PassPeakRSSI[i]
				}
			}
			for i := 0; i < len(body.PassNadirRSSI) && i < domain.MaxPilotSlots; i++ {
				if body.PassNadirRSSI[i] > 0 {
					c.lastPassNadir[i] = body.PassNadirRSSI[i]
				}
			}
		}

	case "enter_and_exit_at_levels":
		var body struct {
			EnterAtLevels []int `json:"enter_at_levels"`
			ExitAtLevels  []int `json:"exit_at_levels"`
		}
		if ev.HasArg && json.Unmarshal(ev.RawArg, &body) == nil {
			for i := 0; i < len(body.EnterAtLevels) && i < domain.MaxPilotSlots; i++ {
				if body.EnterAtLevels[i] >= 0 && body.EnterAtLevels[i] <= 255 {
					c.reportedEnter[i] = uint8(body.EnterAtLevels[i])
				}
			}
			for i := 0; i < len(body.ExitAtLevels) && i < domain.MaxPilotSlots; i++ {
				if body.ExitAtLevels[i] >= 0 && body.ExitAtLevels[i] <= 255 {
					c.reportedExit[i] = uint8(body.ExitAtLevels[i])
				}
			}
			snap := c.snapshotLocked()
			metaOut = &snap
		}

	case "node_enter_at_level":
		var body struct {
			Node  int `json:"node"`
			Level int `json:"level"`
		}
		if ev.HasArg && json.Unmarshal(ev.RawArg, &body) == nil && body.Node >= 0 && body.Node < domain.MaxPilotSlots {
			if body.Level >= 0 && body.Level <= 255 {
				c.reportedEnter[body.Node] = uint8(body.Level)
			}
		}

	case "node_exit_at_level":
		var body struct {
			Node  int `json:"node"`
			Level int `json:"level"`
		}
		if ev.HasArg && json.Unmarshal(ev.RawArg, &body) == nil && body.Node >= 0 && body.Node < domain.MaxPilotSlots {
			if body.Level >= 0 && body.Level <= 255 {
				c.reportedExit[body.Node] = uint8(body.Level)
			}
		}

	case "frequency_data":
		var body struct {
			Fdata []struct {
				Freq int `json:"freq"`
			} `json:"fdata"`
		}
		if ev.HasArg && json.Unmarshal(ev.RawArg, &body) == nil && len(body.Fdata) > 0 {
			n := len(body.Fdata)
			if n > domain.MaxPilotSlots {
				n = domain.MaxPilotSlots
			}
			c.nodeCount = n
			for i := 0; i < n; i++ {
				if body.Fdata[i].Freq >= 0 && body.Fdata[i].Freq <= 65535 {
					c.reportedFreqs[i] = uint16(body.Fdata[i].Freq)
				}
			}
		}

	case "race_status":
		var body struct {
			RaceStatus int `json:"race_status"`
		}
		if ev.HasArg && json.Unmarshal(ev.RawArg, &body) == nil {
			c.raceStatus = body.RaceStatus
			// Re-reconcile if RH finished/stopped while SlapRF still wants pass streaming armed (or vice versa)
			if c.joinedSplit {
				outFrames = append(outFrames, c.buildSyncFramesLocked()...)
			}
			snap := c.snapshotLocked()
			metaOut = &snap
		}

	case "environmental_data":
		if ev.HasArg {
			c.parseEnvironmentalDataLocked(ev.RawArg)
		}

	case "pass_record":
		var body struct {
			Node      int     `json:"node"`
			Frequency int     `json:"frequency"`
			Timestamp float64 `json:"timestamp"` // RH server epoch_ms
		}
		if ev.HasArg && json.Unmarshal(ev.RawArg, &body) == nil && body.Node >= 0 && body.Node < domain.MaxPilotSlots {
			c.passesRx++
			c.passingCounter++
			var hostTimeUs uint64
			if c.clockSynced && body.Timestamp > 0 {
				mapped := int64(math.Round(body.Timestamp*1000.0)) + c.clockOffsetUs
				if mapped > 0 {
					hostTimeUs = uint64(mapped)
				}
			}
			if hostTimeUs == 0 {
				hostTimeUs = nowUs
			}
			peak := c.lastPassPeak[body.Node]
			if peak <= 0 {
				peak = c.slotRSSI[body.Node]
			}
			if peak < float32(c.desiredNodes[body.Node].EnterAtLevel) {
				peak = float32(math.Max(float64(peak), float64(c.desiredNodes[body.Node].EnterAtLevel)+18))
			}
			passOut = &ClientPassEvent{
				SlotIndex:     body.Node + 1,
				FrequencyMHz:  uint16(maxInt(0, body.Frequency)),
				HostTimeUs:    hostTimeUs,
				PeakRSSI:      peak,
				NadirRSSI:     c.lastPassNadir[body.Node],
				PassingNumber: c.passingCounter,
			}
			// Acknowledge reliable delivery to RotorHazard's SendAckQueue (`ClusterNodeSet.py`)
			var rawPayload any
			_ = json.Unmarshal(ev.RawArg, &rawPayload)
			if ackFrame, ackErr := EncodeSIOEvent("cluster_message_ack", map[string]any{
				"messageType":    "pass_record",
				"messagePayload": rawPayload,
			}, true); ackErr == nil {
				outFrames = append(outFrames, ackFrame)
			}
		}
	}
	c.mu.Unlock()

	c.emitFrames(outFrames)
	if hbOut != nil && c.hooks.OnHeartbeat != nil {
		c.hooks.OnHeartbeat(*hbOut)
	}
	if passOut != nil && c.hooks.OnPass != nil {
		c.hooks.OnPass(*passOut)
	}
	if metaOut != nil && c.hooks.OnMeta != nil {
		c.hooks.OnMeta(*metaOut)
	}
}

// Snapshot returns a thread-safe copy of the RotorHazard device's connection, auth, clock, and node telemetry state.
func (c *Client) Snapshot() ClientStatusSnapshot {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.snapshotLocked()
}

func (c *Client) snapshotLocked() ClientStatusSnapshot {
	var bestRttMs float64
	if len(c.clockSamples) > 0 {
		minRttUs := c.clockSamples[0].rttUs
		for _, s := range c.clockSamples[1:] {
			if s.rttUs < minRttUs {
				minRttUs = s.rttUs
			}
		}
		bestRttMs = math.Round(float64(minRttUs)/100.0) / 10.0
	}
	return ClientStatusSnapshot{
		Connected:       c.connected,
		AuthOK:          c.authOK,
		AuthKnown:       c.authKnown,
		ServerVersion:   c.serverVersion,
		ServerHostname:  c.serverHostname,
		NodeCount:       c.nodeCount,
		RaceStatus:      c.raceStatus,
		GateArmed:       c.raceStatus == RHRaceStatusRacing || c.raceStatus == RHRaceStatusStaging,
		ClockSynced:     c.clockSynced,
		ClockOffsetMs:   bestRttMs,
		HeartbeatsRx:    c.heartbeatsRx,
		PassesRx:        c.passesRx,
		SlotRSSI:        c.slotRSSI,
		CrossingFlag:    c.crossingFlags,
		NodeEnterLevels: c.reportedEnter,
		NodeExitLevels:  c.reportedExit,
		NodeFreqsMHz:    c.reportedFreqs,
		CpuTempC:        c.cpuTempC,
		EnvSummary:      c.envSummary,
	}
}

func (c *Client) parseEnvironmentalDataLocked(raw json.RawMessage) {
	type sensorEntry struct {
		Name        string   `json:"name"`
		Temperature *float64 `json:"temperature"`
		Humidity    *float64 `json:"humidity"`
		Voltage     *float64 `json:"voltage"`
	}
	var list []sensorEntry
	if json.Unmarshal(raw, &list) != nil {
		var single sensorEntry
		if json.Unmarshal(raw, &single) == nil && (single.Name != "" || single.Temperature != nil || single.Voltage != nil) {
			list = []sensorEntry{single}
		}
	}
	if len(list) == 0 {
		return
	}
	var parts []string
	for _, item := range list {
		var vals []string
		if item.Temperature != nil {
			c.cpuTempC = float32(math.Round(*item.Temperature*10.0) / 10.0)
			vals = append(vals, fmt.Sprintf("%.1f °C", *item.Temperature))
		}
		if item.Voltage != nil {
			vals = append(vals, fmt.Sprintf("%.2f V", *item.Voltage))
		}
		if item.Humidity != nil {
			vals = append(vals, fmt.Sprintf("%.0f%% RH", *item.Humidity))
		}
		if len(vals) > 0 {
			lbl := strings.TrimSpace(item.Name)
			if lbl != "" {
				parts = append(parts, fmt.Sprintf("%s: %s", lbl, strings.Join(vals, " · ")))
			} else {
				parts = append(parts, strings.Join(vals, " · "))
			}
		}
	}
	if len(parts) > 0 {
		c.envSummary = strings.Join(parts, " | ")
	}
}

func (c *Client) emitFrames(frames []string) {
	if len(frames) == 0 || c.hooks.SendSIO == nil {
		return
	}
	for _, f := range frames {
		if strings.TrimSpace(f) != "" {
			c.hooks.SendSIO(f)
		}
	}
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
